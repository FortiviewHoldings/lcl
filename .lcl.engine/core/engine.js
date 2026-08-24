const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const paths = require("./paths");
const machine = require("./machine");
const loadPlanner = require("./loadPlanner");

/**
 * Supervises the local llama.cpp server and speaks its OpenAI-style API.
 * The engine binds to loopback only and is a child of this process, so it dies
 * with the app.
 *
 * MEMORY SAFETY — the hard rule after the 7B hard-froze the machine:
 * no load starts unless the planner says the PEAK fits in available physical
 * RAM, and a watchdog kills the engine the moment availability crosses the
 * floor. A failed load is recoverable; a paging death spiral is a power
 * button.
 */

const HOST = "127.0.0.1";
const PORT = 8081;
const GEN_TIMEOUT_MS = 300_000;

// Below this much AVAILABLE physical memory the desktop is seconds from
// unresponsive. The watchdog kills the engine rather than let it get there.
const GUARD_FLOOR_BYTES = 1.15e9;
const GUARD_INTERVAL_MS = 750;

let child = null;
let activeBuild = null;
let currentPlan = null;

/**
 * WHERE THE LOAD IS, RIGHT NOW.
 *
 * "you have no progress associated with the model loading. i want to know
 *  where it is, what the exact state is, for the load, until it is loaded."
 *
 * The engine already shouted milestones into a log nobody turned into a state,
 * so the UI could only say "starting local model" and hope. These are the real
 * phases a llama.cpp load goes through, recognised from the server's own
 * output — not invented, and not a spinner pretending to be information.
 *
 * The ETA is LEARNED, not guessed: the first load of a model reports elapsed
 * time only, and once one has finished the next says "about N seconds" from
 * what that model actually took on this machine.
 */
const LOAD_PHASES = [
    { key: "planning",  label: "checking it fits in memory" },
    { key: "starting",  label: "starting the engine" },
    { key: "reading",   label: "reading the model file" },
    { key: "tensors",   label: "loading the weights" },
    { key: "buffers",   label: "building the context and KV cache" },
    { key: "warming",   label: "warming up" },
    { key: "ready",     label: "ready" }
];
let loadState = null;      // { phase, label, at, startedAt, line, etaMs, modelId }

function labelFor(phase) {
    const e = LOAD_PHASES.find(x => x.key === phase);
    return e ? e.label : phase;
}

/** Move the load to a phase, and tell anyone watching. Never goes backwards. */
function setLoadPhase(phase, line) {
    const order = LOAD_PHASES.findIndex(x => x.key === phase);
    if (loadState && LOAD_PHASES.findIndex(x => x.key === loadState.phase) > order) return;
    const startedAtLoad = (loadState && loadState.startedAt) || Date.now();
    loadState = {
        phase,
        label: labelFor(phase),
        step: order + 1,
        steps: LOAD_PHASES.length,
        startedAt: startedAtLoad,
        elapsedMs: Date.now() - startedAtLoad,
        line: line ? String(line).slice(0, 160) : (loadState && loadState.line) || null,
        etaMs: (loadState && loadState.etaMs) || null,
        modelId: (loadState && loadState.modelId) || null
    };
    notify("load-phase", { load: loadState });
}

/**
 * END A LOAD — every terminal path goes through here.
 *
 * A load ends four ways: it succeeds, the planner refuses it, the memory guard
 * kills it, or the process dies. Only the last of those used to clear the
 * state, so the other three left the sidebar showing a load that would never
 * finish — and worse, left status().load non-null, which the renderer reads as
 * "something is already starting, do not ask for a start". Stopping the engine
 * once was therefore enough to make it unstartable: the reported bug, rebuilt
 * by the fix for the reported bug.
 */
function endLoad() {
    loadState = null;
    if (readyProbe) { clearTimeout(readyProbe); readyProbe = null; }
}

/**
 * THE ENGINE CONFIRMS ITS OWN READINESS.
 *
 * "warming up" was the last phase the server's own output could produce —
 * llama.cpp's final two lines, "model loaded" and "listening on", both land
 * there — and the ONLY thing that moved it to "ready" was health(), which only
 * runs when somebody asks. So a load that had completely finished sat at
 * "warming up · step 6 of 7" until a caller happened to poll.
 *
 *     "the warming up says step 6 of 7 and looks stuck"
 *
 * It usually was not stuck; it was unobserved. And the case where nobody asks
 * is not rare, it is the normal one for a conversation running on a machine on
 * the network: that session's health check resolves to the REMOTE model and
 * never touches the local engine, so the local load that had finished had no
 * reader at all.
 *
 * A readout that depends on being watched is not a readout. The engine now
 * probes itself the moment the server says it is listening, and the phase
 * reaches "ready" — and the card clears — whether or not anyone is looking.
 */
const READY_CONFIRM_MS = 180_000;
let readyProbe = null;
function confirmReadySoon() {
    if (readyProbe || !loadState || loadState.phase === "ready") return;
    const since = Date.now();
    let delay = 250;
    const tick = async () => {
        readyProbe = null;
        if (stopping || !child || child.killed) return;
        if (!loadState || loadState.phase === "ready") return;
        // health() is what records the measured load time and moves the phase;
        // this only makes sure it is CALLED
        try { if ((await health()).status === "ok") return; } catch { /* not up */ }
        if (stopping || !loadState || loadState.phase === "ready") return;
        if (Date.now() - since > READY_CONFIRM_MS) return;   // give up quietly
        delay = Math.min(2000, Math.round(delay * 1.6));
        readyProbe = setTimeout(tick, delay);
        if (readyProbe.unref) readyProbe.unref();
    };
    readyProbe = setTimeout(tick, delay);
    if (readyProbe.unref) readyProbe.unref();
}

/**
 * The load as it is RIGHT NOW, not as it was at the last milestone.
 *
 * elapsedMs was stamped when a phase changed, so between milestones — which is
 * where a load spends nearly all of its time, "loading the weights" can run for
 * a minute — the clock and the bar sat still and the load looked hung. The
 * phase is a milestone; the clock is not, so it is read at read time.
 */
function liveLoad() {
    if (!loadState) return null;
    if (loadState.phase === "ready") return loadState;      // finished; frozen is correct
    return { ...loadState, elapsedMs: Date.now() - loadState.startedAt };
}

/** What this model took to load LAST time on this machine, if it ever has. */
function learnedLoadMs(modelId) {
    if (!modelId) return null;
    try {
        const t = paths.readSettings().modelLoadMs || {};
        const v = Number(t[modelId]);
        return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
}

function recordLoadMs(modelId, ms) {
    if (!modelId || !(ms > 0)) return;
    try {
        const t = { ...(paths.readSettings().modelLoadMs || {}) };
        // a gentle average, so one cold cache does not set the expectation
        t[modelId] = t[modelId] ? Math.round((t[modelId] * 2 + ms) / 3) : Math.round(ms);
        paths.writeSettings({ modelLoadMs: t });
    } catch { /* an estimate is never worth failing a load over */ }
}
// the model actually SPAWNED — differs from the settings preference while a
// boot fallback is active (preferred model did not fit; a smaller one runs)
let activeModelPath = null;
// true when the running server was started WITH a vision projector — the
// registry flag alone is not proof the projector file was actually loaded
let mmprojLoaded = false;
let stopping = false;
let restartCount = 0;
let restartTimer = null;
let startedAt = 0;
let lastError = "";
let lastRefusal = null;
// Set once the child answers /health. An engine that dies BEFORE ever being
// healthy died loading — restarting it repeats the exact same death against a
// machine that just took the hit, so load-phase deaths are never retried.
let everHealthy = false;
let guardStopped = false;
/**
 * THE GUARD SURFACE.
 *
 * Memory refusals used to travel on exactly the same wire as the model's reply:
 * lastError -> the turn's error -> a line in the chat where the answer belongs.
 * So "create an image of a donkey" came back as advice to close some apps, and
 * from the outside that is the model refusing, which it never did.
 *
 * A guard notice is a fact about THIS COMPUTER. It is held separately, carries
 * its own numbers, and is tagged on every error it causes so no surface has to
 * guess whether it is reading the machine or the model.
 *
 *   { kind: "guard-stop" | "planner-refusal" | "recovery-failed",
 *     message, availableBytes, needBytes, at }
 */
let guardNotice = null;
function raiseGuard(kind, message, extra) {
    guardNotice = { kind, message: String(message || ""), at: Date.now(), ...(extra || {}) };
    record(`[guard] ${kind}: ${guardNotice.message}`);
    notify("guard-notice", { guard: guardNotice });
    return guardNotice;
}
function clearGuard() {
    if (!guardNotice) return;
    guardNotice = null;
    notify("guard-cleared");
}
let oomDetected = false;
let cpuFallbackTried = false;
let guardTimer = null;
let exitWaiters = [];
// Random per-launch key. llama-server's HTTP API and bundled web UI are
// otherwise reachable by any local process or web page (DNS-rebinding class),
// which is exactly the exposure we removed from our own API.
let apiKey = crypto.randomBytes(24).toString("hex");
const MAX_RESTARTS = 5;
const STABLE_MS = 30_000;

const OOM_RE = /out of memory|failed to allocate|unable to allocate|erroroutofdevicememory|vk_error|bad_alloc|cannot allocate/i;

/**
 * Idle unload. The resident model is the single biggest contributor to memory
 * pressure on a 16 GB laptop; holding it for a conversation the user walked
 * away from is the wrong default.
 */
const IDLE_CHECK_MS = 30_000;
let idleUnloadMs = 10 * 60_000;         // 0 disables
let lastUsedAt = Date.now();
let generating = 0;
let unloadedForIdle = false;
let idleTimer = null;
let onStateChange = null;               // set by main to notify the UI

const log = [];
const stderrTail = [];
function record(line) {
    log.push(line);
    if (log.length > 200) log.shift();
}

function status() {
    // the live load, so every surface reads ONE state instead of guessing from
    // a spinner and a log tail
    const running = !!child && !child.killed;
    // report what is actually loaded; the preference only speaks when nothing is
    const modelPath = (running && activeModelPath) || paths.findModel();
    const preferred = paths.findModel();
    return {
        running,
        // ONE LIFECYCLE, so two surfaces cannot show "stopping" above "stopped".
        //
        // Reported from the install: a stop left the state machine showing both
        // words at once, and leaving the session lost the state altogether.
        // Both come from the same cause — the engine reported `running` and
        // nothing else, so every surface had to keep its OWN idea of "I asked
        // it to stop", which no repaint could restore and no other surface
        // could see. This is that idea, held once, in the place that knows.
        //
        // It is terminal by construction: `stopping` can only be reported while
        // a process still exists, so the moment the child is gone the state is
        // "stopped" and stays there. There is no arrangement of these fields
        // that reads as two states at the same time.
        state: !running ? "stopped"
             : stopping ? "stopping"
             : (loadState && loadState.phase !== "ready") ? "loading"
             : "running",
        stopping: !!(stopping && running),
        load: liveLoad(),
        restarts: restartCount,
        lastError,
        lastRefusal,
        // WHAT THE MACHINE SAID, KEPT APART FROM WHAT THE MODEL SAID.
        //
        // "asked for an image of a donkey, got a refusal about closing apps to
        // free memory." A memory guard firing is a fact about this computer; it
        // is never an answer to a question, and it must never arrive on the
        // same channel as one. Every memory-class refusal lands here, tagged,
        // with the numbers, so a surface can show it as the machine speaking.
        guard: guardNotice,
        guardStopped,
        oomDetected,
        model: modelPath,
        modelInfo: paths.describeModel(modelPath),
        fallbackActive: !!(running && activeModelPath && preferred
            && path.resolve(activeModelPath) !== path.resolve(preferred)),
        visionReady: !!(running && mmprojLoaded),
        // who the user actually wanted, for the boot notice — the engine's
        // fallback event fires before the renderer is listening, so the
        // renderer reconstructs the message from status instead
        preferredInfo: paths.describeModel(preferred),
        build: activeBuild ? {
            id: activeBuild.id,
            accelerator: activeBuild.accelerator
        } : null,
        plan: currentPlan ? {
            accelerator: currentPlan.accelerator,
            ctxSize: currentPlan.ctxSize,
            gpuLayers: currentPlan.gpuLayers,
            estPeakBytes: currentPlan.est && currentPlan.est.peakBytes,
            estSteadyBytes: currentPlan.est && currentPlan.est.steadyBytes,
            note: currentPlan.note || null
        } : null,
        port: PORT,
        // the `--ctx-size` this engine is actually running with, so a surface
        // can show the real window instead of assuming one
        contextWindow: running && currentPlan ? currentPlan.ctxSize : null,
        idleSeconds: Math.round((Date.now() - lastUsedAt) / 1000),
        idleUnloadMs,
        unloadedForIdle,
        generating: generating > 0
    };
}

function setIdleUnloadMs(ms) {
    idleUnloadMs = Math.max(0, Number(ms) || 0);
    return idleUnloadMs;
}

function setStateListener(fn) {
    onStateChange = typeof fn === "function" ? fn : null;
}

function notify(reason, extra) {
    if (onStateChange) {
        try { onStateChange({ reason, ...(extra || {}), ...status() }); } catch { /* UI gone */ }
    }
}

function checkIdle() {
    if (!idleUnloadMs) return;
    if (!child || child.killed) return;
    if (generating > 0) return;                       // never unload mid-turn
    if (Date.now() - lastUsedAt < idleUnloadMs) return;

    record(`[.lcl] unloading idle model after ${Math.round(idleUnloadMs / 60000)} min`);
    unloadedForIdle = true;
    stop();
    notify("idle-unload");
}

function startIdleWatch() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(checkIdle, IDLE_CHECK_MS);
    if (idleTimer.unref) idleTimer.unref();
}

/**
 * The anti-freeze watchdog. While the engine lives, availability is sampled
 * continuously; crossing the floor kills the engine IMMEDIATELY. llama-server
 * releases gigabytes the instant it dies, which is what pulls the machine back
 * from the cliff. Runs during load — where the 7B freeze actually happened —
 * and during generation alike.
 */
function startGuard() {
    stopGuard();
    guardTimer = setInterval(() => {
        if (!child || child.killed) { stopGuard(); return; }
        const mem = machine.memory();
        if (mem.availableBytes < GUARD_FLOOR_BYTES) {
            const gb = (mem.availableBytes / 1e9).toFixed(1);
            guardStopped = true;
            lastError =
                `Model stopped to protect the machine: available memory fell to ` +
                `${gb} GB and the system was about to start paging hard. Nothing ` +
                `crashed — free some memory and load the model again.`;
            record(`[guard] ${lastError}`);
            // the machine's own channel, so this can be shown as the machine
            // speaking rather than as an answer to whatever was asked
            raiseGuard("guard-stop", lastError, { availableBytes: mem.availableBytes });
            stop();
            notify("guard-stop");

            // COME BACK. The guard killing the engine left the app with nothing
            // loaded and no way out: the composer said "no model loaded", the
            // picker still showed a tick against the model that had died, every
            // session was dead, and only closing and reopening the app fixed it.
            // Reported as "literally you have stalemated this shit", and that is
            // the right description — a protective stop that ends in an unusable
            // app has protected nothing.
            //
            // Killing llama-server releases its memory immediately, so by the
            // time this runs there is normally room for a smaller model. Wait for
            // the memory to actually come back, then load the best one that fits.
            setTimeout(() => {
                if (child) return;                  // something else already loaded
                if (remoteDriving()) {
                    record("[guard] remote model is driving — not reloading a local model");
                    return;
                }
                start({ allowFallback: true }).then((r) => {
                    if (r && r.ok) {
                        guardStopped = false;
                        lastError = null;
                        clearGuard();
                        record("[guard] recovered onto a model that fits");
                        notify("guard-recovered");
                    } else {
                        record("[guard] nothing fits yet — close some apps and pick a model");
                        // and it goes on the GUARD surface, not into the next
                        // reply. This exact sentence was read by the operator as
                        // the model's answer to "create an image of a donkey".
                        raiseGuard("recovery-failed",
                            "Nothing fits in memory yet. Close some apps, then pick a model.",
                            { availableBytes: machine.memory().availableBytes,
                              needBytes: (r && r.refusal && r.refusal.needBytes) || null });
                    }
                }).catch(() => { /* reported through lastError */ });
            }, 2500);
        }
    }, GUARD_INTERVAL_MS);
    if (guardTimer.unref) guardTimer.unref();
}


/**
 * Is a linked remote model currently the driver?
 *
 * Asked before every AUTOMATIC load — guard recovery, crash restart. While the
 * cloud answers, reloading a local model is not resilience, it is spending the
 * user's scarcest resource on a component nothing is using. The reported
 * failure chain: remote conversation -> memory dipped -> guard killed the
 * (unneeded) engine -> recovery tried to LOAD A MODEL BACK, refused for want
 * of 1.5 GB, and the refusal locked the UI on "model not loaded" — two scary
 * errors inside a chat that was working perfectly. Lazy require: cloudModels
 * does not import engine, but load order is not worth betting on.
 */
function remoteDriving() {
    try { return !!require("./cloudModels").selected(); }
    catch { return false; }
}

function stopGuard() {
    if (guardTimer) { clearInterval(guardTimer); guardTimer = null; }
}

/** Bring the engine back up and wait for the model to be ready. */
async function ensureLoaded(timeoutMs = 240_000) {
    if (child && !child.killed) {
        const h = await health();
        if (h.status === "ok") return { ok: true };
    }

    if (!child || child.killed) {
        // A SECOND LOAD THE USER DID NOT ASK FOR MUST SAY WHY IT IS HAPPENING.
        //
        // Reported: "a model that already loaded, with progress shown, loads
        // AGAIN when you send the first message." Measured against this file:
        // a live engine is never re-spawned by a turn (0 spawns across a first
        // message on a loaded engine). The reload the operator saw is this
        // branch, and the commonest way to reach it is the idle unloader — the
        // default is ten minutes, so loading a model and then reading the UI
        // for longer than that unloads it, and the first message pays for a
        // second load with nothing on screen explaining the repeat.
        //
        // The reason travels with the event now, so a surface can say "the
        // model was unloaded after ten minutes idle; loading it again" instead
        // of showing the same progress bar twice for no stated reason.
        const why = unloadedForIdle ? "idle-unload"
                  : guardStopped ? "guard-stop"
                  : "not-running";
        // a transparent reload (idle unload, first message) is an implicit
        // load — degrade to a fitting model rather than failing the message
        const started = await start({ allowFallback: true });
        if (!started.ok) return started;
        notify("loading", { because: why, reload: why !== "not-running" });
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const h = await health();
        if (h.status === "ok") {
            everHealthy = true;
            unloadedForIdle = false;
            notify("ready");
            return { ok: true };
        }
        if (h.status === "no_model") return { ok: false, error: "no model selected" };
        // the child died mid-load — report WHY instead of spinning out the clock
        if (!child) {
            return { ok: false, error: lastError || "the engine exited while loading",
                     // a watchdog kill is the machine talking, and the caller
                     // must be able to tell that without reading the sentence
                     guard: !!(guardStopped || guardNotice) };
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return { ok: false, error: "model did not finish loading in time" };
}

/**
 * Plan a load without performing it. `reclaimCurrent` credits the memory the
 * currently-loaded model would hand back — a switch budgets for the world
 * after the old model unloads.
 */
function preflight(modelPath, { reclaimCurrent = false, cpuOnly = false } = {}) {
    const target = modelPath || paths.findModel();
    if (!target) return { fits: false, message: "no model selected" };

    const build = paths.selectBuild("llama.cpp");
    const mem = machine.memory();

    // The credit is an ESTIMATE (the old plan's steady state), not a
    // measurement, so it can over-promise. That is acceptable because this
    // preview is never the last word: start() re-plans against freshly
    // measured memory after the old engine is actually gone. Worst case of an
    // over-credit is "old model unloaded, new one refused with numbers" —
    // safe and honest — never an overload.
    let reclaim = 0;
    if (reclaimCurrent && child && !child.killed && currentPlan && currentPlan.est) {
        reclaim = currentPlan.est.steadyBytes;
    }

    return loadPlanner.plan({
        modelPath: target,
        entry: paths.describeModel(target),
        mem,
        gpuUsable: !cpuOnly
            && !!(build && build.accelerator && build.accelerator !== "cpu"),
        reclaimBytes: reclaim
    });
}

/**
 * THE WINDOW THE ENGINE IS ACTUALLY RUNNING WITH.
 *
 * `--ctx-size` is not a constant. The planner picks it from free memory at load
 * time, so it is 4096 on a squeezed machine and 16384 on a clear one, and until
 * now NOTHING above this file could read the number. The turn assembled its
 * prompt by MESSAGE COUNT (12 messages) and sent it blind.
 *
 * llama.cpp b10107 ships with context shift DISABLED by default. Its own help
 * text, run on this machine:
 *
 *     --context-shift, --no-context-shift  whether to use context shift on
 *                                          infinite text generation (default:
 *                                          disabled)
 *
 * and its own refusal, pulled from llama-server-impl.dll:
 *
 *     request (%d tokens) exceeds the available context size (%d tokens)
 *     error type: exceed_context_size_error
 *
 * So a prompt that does not fit is not truncated, it is REFUSED. Measured by
 * driving the real turn loop against the real engine argv:
 *
 *     fresh session, no folder linked     1,578 prompt tokens   answered
 *     fresh session, folder linked        4,463 prompt tokens   refused (n_ctx 4096)
 *     folder + 20 turns of history        7,760 prompt tokens   refused (n_ctx 8192)
 *
 * which is the operator's report, word for word: "in a session with no context
 * yet, or workspace it can work."
 *
 * Returns the size in force while the engine is up; when it is down, the size a
 * load started right now would get, so a turn can budget BEFORE the first load.
 * Null only when nothing can be planned at all.
 */
function contextWindow() {
    if (child && !child.killed && currentPlan && currentPlan.ctxSize) {
        return currentPlan.ctxSize;
    }
    try {
        const p = preflight();
        return p && p.fits ? p.ctxSize : null;
    } catch { return null; }
}

/**
 * The best chat model that DOES fit right now, other than `excludePath`.
 * Largest-first, planner-checked, must be on disk. Boot and transparent
 * reloads use this so "your preferred model needs 0.6 GB more" degrades to
 * a smaller model answering — with a note — instead of no model at all.
 */
function pickFallbackModel(excludePath) {
    const registry = paths.modelRegistry();
    const dirs = [paths.bundledModelsDir(), paths.modelsDir()];
    // The preference ladder first, then remaining text models largest-first,
    // vision models last. Raw size ordering put the DeepSeek reasoning distill
    // and the 7B coder ahead of the 4B generalist — bigger, but wrong for a
    // silent substitution: the distill's tool-calling is weak by its own
    // registry note, and nobody asked for a coder. reasoningModel entries are
    // excluded outright — a model that emits a <think> block before every
    // answer is a deliberate choice, never an automatic stand-in. The vision
    // model stays last: its projector is 836 MB of weight the user did not
    // ask for right then, though it remains reachable when it is all that fits.
    const rank = new Map(paths.ladderEntries(registry).map((e, i) => [e.id, i]));
    const effective = (m) => (m.sizeBytes || 0) + (m.mmprojBytes || 0);
    const candidates = (registry.models || [])
        .filter(m => m.runtime === "llama.cpp" && !m.reasoningModel
            && !["embedding", "reranker", "image"].includes(m.role))
        .sort((a, b) => ((a.vision ? 1 : 0) - (b.vision ? 1 : 0))
            || ((rank.has(a.id) ? rank.get(a.id) : 99) - (rank.has(b.id) ? rank.get(b.id) : 99))
            || (effective(b) - effective(a)));

    for (const m of candidates) {
        for (const d of dirs) {
            const p = path.join(d, m.file);
            if (!fs.existsSync(p)) continue;
            if (excludePath && path.resolve(p) === path.resolve(excludePath)) continue;
            const plan = preflight(p);
            if (plan.fits) return { modelPath: p, entry: m, plan };
        }
    }
    return null;
}

async function start(opts = {}) {
    // A STRING HERE IS ALWAYS A MISTAKE, AND IT USED TO BE A SILENT ONE.
    //
    // The signature is an options object. Passing a model id — the obvious
    // guess — destructures to all-undefined, so the id is discarded and this
    // loads paths.findModel() instead: a DIFFERENT model, with no error. That
    // is exactly how tests/real-model-e2e.js spent its life timing whichever
    // model the operator had selected while asserting against the one it names,
    // and reporting the difference as a performance problem. Loading the wrong
    // model is never the helpful reading of this call.
    if (typeof opts === "string") {
        throw new TypeError(
            `engine.start() takes an options object, not a model id. ` +
            `Use { modelOverride: "<path to .gguf>" } — got "${opts}".`);
    }
    const { cpuOnly = false, modelOverride = null, allowFallback = false } = opts || {};
    // REENTRANCY GUARD. The review's verifier reproduced this empirically: two
    // unserialized start() calls (a crash-restart timer racing a user switch)
    // each passed the planner against the same memory snapshot and BOTH loaded
    // full weights — double residency past the gate, with the module-level
    // `child` orphaning the first process beyond the app's reach. One engine,
    // ever. A pending crash-restart is cancelled by any explicit start.
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child && !child.killed) {
        return { ok: true, alreadyRunning: true, plan: currentPlan };
    }

    let model = modelOverride || paths.findModel();
    if (!model) {
        lastError = "no model selected";
        return { ok: false, error: lastError };
    }

    // The manifest decides which build runs. It is ordered by preference, so a
    // Vulkan or Metal build wins over CPU purely by being present on disk.
    const build = paths.selectBuild("llama.cpp");
    const binary = build ? build.binary : paths.engineBinary();
    if (!fs.existsSync(binary)) {
        lastError = `engine binary missing: ${binary}`;
        return { ok: false, error: lastError };
    }

    // THE GATE. No spawn without a plan that fits in physical memory.
    const info0 = paths.describeModel(model);
    loadState = null;
    setLoadPhase("planning");
    loadState.modelId = (info0 && info0.id) || path.basename(model);
    loadState.etaMs = learnedLoadMs(loadState.modelId);
    let plan = preflight(model, { cpuOnly });
    let fallbackFrom = null;
    if (!plan.fits && allowFallback) {
        // Implicit loads (boot, idle reload) degrade instead of refusing:
        // the user's preference is untouched in settings, a smaller model
        // answers now, and the UI says exactly what happened. Explicit
        // switches never take this path — asking for a model deserves the
        // honest numbers, not a silent substitute.
        const fb = pickFallbackModel(model);
        if (fb) {
            fallbackFrom = { wanted: paths.describeModel(model), message: plan.message };
            record(`[fallback] preferred model does not fit (${plan.message}); ` +
                   `loading ${fb.entry.id} instead`);
            model = fb.modelPath;
            plan = fb.plan;
            // The load is now for a different model than the one it was
            // labelled with, so the ETA came from the wrong history and the
            // measured time would have been written back under a model that
            // never loaded, poisoning that model's estimate for good.
            if (loadState) {
                loadState.modelId = (fb.entry && fb.entry.id) || path.basename(model);
                loadState.etaMs = learnedLoadMs(loadState.modelId);
            }
            notify("fallback-load", {
                wantedId: fallbackFrom.wanted ? fallbackFrom.wanted.id : null,
                usingId: fb.entry.id,
                whyNot: fallbackFrom.message
            });
        }
    }
    if (!plan.fits) {
        lastRefusal = plan;
        lastError = plan.message;
        record(`[planner] refused: ${plan.message}`);
        endLoad();                     // refused before it began; not "checking it fits" forever
        // A refusal to LOAD is a memory fact, on the memory channel. `guard`
        // travels with the error so nothing downstream has to decide from the
        // wording whether this was the machine or the model.
        raiseGuard("planner-refusal", plan.message, {
            needBytes: plan.needBytes, usableBytes: plan.usableBytes,
            shortfallBytes: plan.shortfallBytes
        });
        notify("load-refused", { refusal: plan });
        return { ok: false, error: plan.message, refusal: plan, guard: true };
    }
    lastRefusal = null;
    clearGuard();                      // this load is going ahead; the machine is fine
    // A new attempt must also clear the PREVIOUS attempt's corpse. Stale
    // lastError survived here, and the renderer's is-this-terminal check reads
    // (!running && lastError) — so during a perfectly healthy 60-second load
    // it saw yesterday's failure, declared the engine dead, and bailed to
    // 'model not loaded' while the load went on to succeed. Machine said
    // loaded, the composer said dead, and both were reporting honestly from
    // different state. One attempt, one slate.
    lastError = null;
    oomDetected = false;
    currentPlan = plan;
    activeBuild = build || null;

    stopping = false;
    guardStopped = false;
    oomDetected = false;
    everHealthy = false;
    // a FRESH start re-arms the one-shot CPU fallback; the fallback's own
    // start (cpuOnly) must not, or a failing fallback would loop
    if (!cpuOnly) cpuFallbackTried = false;
    stderrTail.length = 0;
    startedAt = Date.now();

    const threads = Math.max(2, Math.min(8, os.cpus().length - 1));
    const args = [
        "--model", model,
        "--host", HOST,
        "--port", String(PORT),
        "--threads", String(threads),
        "--ctx-size", String(plan.ctxSize),
        "--gpu-layers", String(plan.gpuLayers),
        // KV cache at q8_0 (both halves) with flash attention: halves the
        // cache and shrinks attention buffers for near-zero quality cost.
        // Verified live on this build (server healthy, correct completions).
        // The planner's estimates assume this — see KV_QUANT_FACTOR.
        "--flash-attn", "on",
        "--cache-type-k", "q8_0",
        "--cache-type-v", "q8_0",
        "--api-key", apiKey
    ];

    const est = plan.est;
    record(`starting engine: ${build ? build.id : path.basename(binary)} ` +
           `(${path.basename(model)}, ${threads} threads, ctx ${plan.ctxSize}, ` +
           `ngl ${plan.gpuLayers}, planned peak ${(est.peakBytes / 1e9).toFixed(1)} GB)`);
    if (plan.note) record(`[planner] ${plan.note}`);

    // Vision models carry a projector beside the weights. When the registry
    // names one and it is on disk, the server loads it and this engine can
    // SEE — image parts in chat completions. The planner already counted the
    // projector's bytes (mmprojBytes) in this plan.
    mmprojLoaded = false;
    const entryInfo = paths.describeModel(model);
    if (entryInfo && entryInfo.mmproj) {
        for (const d of [paths.bundledModelsDir(), paths.modelsDir()]) {
            const mp = path.join(d, entryInfo.mmproj);
            if (fs.existsSync(mp)) {
                args.push("--mmproj", mp);
                mmprojLoaded = true;
                break;
            }
        }
        if (!mmprojLoaded) {
            record(`[vision] projector ${entryInfo.mmproj} not found — loading text-only`);
        }
    }

    activeModelPath = model;

    // Every handler below closes over ITS process and checks it still owns the
    // module state before touching it. Without this, a stale close event from
    // a killed predecessor nulled the LIVE child and shut its watchdog off.
    setLoadPhase("starting");
    const proc = spawn(binary, args, {
        cwd: path.dirname(binary),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
    });
    child = proc;

    proc.stdout.on("data", d => record(String(d).trimEnd()));
    proc.stderr.on("data", d => {
        const text = String(d).trimEnd();
        record(text);
        if (child !== proc) return;                  // a superseded engine's noise
        for (const line of text.split("\n")) {
            stderrTail.push(line);
            if (stderrTail.length > 40) stderrTail.shift();
            if (OOM_RE.test(line)) oomDetected = true;
            // THE SERVER'S OWN WORDS, TURNED INTO A STATE. These patterns are
            // llama.cpp's real load milestones; each one moves the phase, so
            // the UI can say where the load actually is instead of spinning.
            // CALIBRATED AGAINST THIS BUILD'S ACTUAL OUTPUT, captured by
            // running it. llama.cpp b10107 prints, in order:
            //     load_model: loading model '...gguf'
            //     llama_model_loader: loaded meta data with 30 key-value pairs
            //     load: special tokens cache size = 26
            //     init: kv_size = 4096, type_k = 'f16'
            //     main: model loaded
            //     main: server is listening on http://127.0.0.1:8081
            // The older llm_load_* patterns are kept so a build that prints the
            // previous format still reports phases rather than none.
            if (/load_model: loading model|llama_model_loader|loaded meta data/i.test(line)) setLoadPhase("reading", line);
            else if (/load_tensors|llm_load_tensors|loading model tensors|^\s*[\d.]+ [A-Z] load:/i.test(line)) setLoadPhase("tensors", line);
            else if (/initializing, n_slots|n_ctx_slot|KV self size|kv cache|compute buffer|llama_context/i.test(line)) setLoadPhase("buffers", line);
            // BOTH OF THESE ARE THE SERVER'S LAST WORD. There is no log line
            // for "ready" — the server just starts answering — so the phase
            // stops here unless something confirms it. That confirmation is
            // the engine's own job, not a watcher's.
            else if (/model loaded|warming up|warmup/i.test(line)) {
                setLoadPhase("warming", line); confirmReadySoon();
            } else if (/listening on/i.test(line)) {
                setLoadPhase("warming", line); confirmReadySoon();
            }
            if (/llm_load|llama_model_load|offload|KV self size|compute buffer|loading model/i.test(line)) {
                notify("loading-progress", { line: line.trim().slice(0, 160) });
            }
        }
    });

    proc.on("error", err => {
        if (child !== proc) return;
        lastError = String(err.message || err);
        record(`engine spawn error: ${lastError}`);
    });

    proc.on("close", code => {
        record(`engine exited with code ${code}`);
        if (child !== proc) return;                  // superseded; nothing to clean
        stopGuard();
        const wasStable = Date.now() - startedAt >= STABLE_MS;
        const diedLoading = !everHealthy;
        child = null;
        for (const w of exitWaiters.splice(0)) w();

        if (stopping) return;

        if (guardStopped) {
            // lastError already explains; never auto-restart into the same wall
            endLoad();                 // killed at "warming up" is not still warming up
            notify("load-failed", { reason: "guard" });
            return;
        }
        // The one configuration change we retry: KV quantization needs flash
        // attention, and the Vulkan+fa pairing could not be verified on this
        // machine (not enough free RAM to test a GPU load). If a GPU load
        // dies complaining about fa/cache support, fall back ONCE to CPU —
        // same context, same KV quant, strictly LESS memory than planned, so
        // this is not the OOM-slam loop the no-retry rule exists to prevent.
        const faIncompat = diedLoading && !oomDetected
            && currentPlan && currentPlan.accelerator === "gpu"
            && stderrTail.some(l => /flash.?attn|cache.type|V cache quantization|not supported/i.test(l));
        if (faIncompat && !cpuFallbackTried) {
            cpuFallbackTried = true;
            record("[fallback] GPU build rejected flash-attention/KV-quant config; retrying on CPU");
            notify("loading-progress", { line: "GPU rejected this configuration — retrying on CPU" });
            // retry the model that was ACTUALLY loading — after a memory
            // fallback that is not the settings preference
            start({ cpuOnly: true, modelOverride: activeModelPath });
            return;
        }

        if (oomDetected || diedLoading) {
            // A load-phase death means the machine could not take this
            // configuration. Retrying repeats the freeze we are here to
            // prevent. Tell the user what happened instead.
            const tail = stderrTail.filter(l => OOM_RE.test(l)).slice(-1)[0];
            lastError = oomDetected
                ? `The model ran out of memory while loading` +
                  (tail ? ` (${tail.trim().slice(0, 120)})` : "") +
                  `. Free some memory and try again, or pick a smaller model.`
                : `The engine exited (code ${code}) before the model finished loading.`;
            record(`[no-retry] ${lastError}`);
            endLoad();                     // it is not loading; it is dead
            notify("load-failed", { reason: oomDetected ? "oom" : "load-death" });
            return;
        }

        if (wasStable) restartCount = 0;
        if (restartCount < MAX_RESTARTS) {
            restartCount++;
            record(`restarting engine (${restartCount}/${MAX_RESTARTS})`);
            // held in restartTimer so an explicit stop() or start() cancels it —
            // otherwise it fires into a freshly switched engine and double-loads
            restartTimer = setTimeout(() => {
                restartTimer = null;
                // a crash recovery is an implicit load: come back with
                // whatever fits rather than refusing outright
                if (!stopping && !child && !remoteDriving()) start({ allowFallback: true });
            }, 2000);
        } else {
            lastError = "engine keeps exiting; giving up";
            endLoad();
            notify("load-failed", { reason: "crash-loop" });
        }
    });

    // a fresh start is real activity: without this the idle unloader could
    // fire on a model the user JUST switched to, using a stale lastUsedAt
    lastUsedAt = Date.now();
    unloadedForIdle = false;
    startGuard();
    return { ok: true, plan };
}

function kill(pid) {
    try {
        if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
        } else if (child && child.pid === pid) {
            child.kill();
        }
    } catch { /* already gone */ }
}

function stop() {
    stopping = true;
    stopGuard();
    // A deliberate stop ends the load too. Without this the state stayed frozen
    // at whatever phase it had reached, status().load stayed non-null, and
    // waitForBackend() saw "already loading" and declined to ask for a start —
    // forever. Every idle unload, model switch and explicit stop went through
    // here, so this was not an edge case.
    endLoad();
    // a queued crash-restart must die with the engine it was going to revive
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child && child.pid) {
        record("stopping engine");
        kill(child.pid);
    }
}

/**
 * Stop and WAIT for the process to actually exit, plus a short settle so the
 * OS reclaims its pages. The old switch path fired stop() and started the next
 * model 400 ms later — both models briefly resident is exactly the peak that
 * froze the machine.
 *
 * Resolves true when the process is confirmed gone, false on timeout. The
 * timeout path re-kills before giving up and still settles — callers are about
 * to allocate gigabytes on the strength of this answer.
 */
function stopAndWait(timeoutMs = 10_000, settleMs = 1_000) {
    // even with no child, cancel any queued crash-restart: the caller is about
    // to change the world (switch models) and a 2s-old timer must not fire
    // into it
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (!child) return Promise.resolve(true);
    return new Promise((resolve) => {
        const pid = child.pid;
        const t = setTimeout(() => {
            if (child && child.pid === pid) {
                record("[stop] engine ignored kill for 10s — re-killing");
                kill(pid);
            }
            setTimeout(() => resolve(!child), settleMs);
        }, timeoutMs);
        exitWaiters.push(() => { clearTimeout(t); setTimeout(() => resolve(true), settleMs); });
        stop();
    });
}

function request(method, urlPath, payload, timeoutMs, cancelToken, onChunk) {
    return new Promise((resolve) => {
        const body = payload ? JSON.stringify(payload) : null;
        const headers = {};
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        if (body) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(body);
        }

        const req = http.request(
            { host: HOST, port: PORT, path: urlPath, method, headers, timeout: timeoutMs },
            (res) => {
                let data = "";
                res.on("data", c => {
                    data += c;
                    if (onChunk) onChunk(String(c));
                });
                res.on("end", () => {
                    let parsed = null;
                    try { parsed = JSON.parse(data); } catch { /* not json / stream */ }
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ ok: true, data: parsed, raw: data });
                    } else {
                        const detail = (parsed && (parsed.error?.message || parsed.error)) || data.slice(0, 300);
                        resolve({ ok: false, error: `engine HTTP ${res.statusCode}: ${detail}` });
                    }
                });
            }
        );

        req.on("timeout", () => req.destroy(new Error(`engine timed out after ${timeoutMs / 1000}s`)));
        req.on("error", err => resolve({
            ok: false,
            error: cancelToken && cancelToken.cancelled ? "cancelled" : String(err.message || err)
        }));

        // let a caller abort a long generation
        if (cancelToken) {
            if (cancelToken.cancelled) {
                req.destroy(new Error("cancelled"));
            } else {
                cancelToken.abort = () => req.destroy(new Error("cancelled"));
            }
        }

        if (body) req.write(body);
        req.end();
    });
}

async function health() {
    if (!paths.findModel()) {
        return { status: "no_model" };
    }
    const res = await request("GET", "/health", null, 2500);
    if (res.ok) {
        // Loads driven by setModel/waitForBackend never pass through
        // ensureLoaded, and a healthy engine misclassified as "died loading"
        // would be denied its crash auto-restart later. Any OK answer is the
        // proof of health, wherever it was asked from.
        if (child && !child.killed) everHealthy = true;
        // THE LOAD IS OVER WHEN THE SERVER ANSWERS, and how long it took is
        // what makes the NEXT load able to show a real estimate.
        if (loadState && loadState.phase !== "ready") {
            const took = Date.now() - loadState.startedAt;
            recordLoadMs(loadState.modelId, took);
            setLoadPhase("ready");
            loadState.elapsedMs = took;
        }
        return { status: "ok" };
    }
    return { status: "engine_unavailable", detail: res.error };
}

/**
 * Generate, streaming. onToken({text, tokens, elapsedMs}) fires as tokens
 * arrive so the UI can show the model actually working — text forming and a
 * live tokens/s — instead of a blind spinner for up to five minutes.
 */
// Concurrent sessions SHARE one llama-server and one resident model — that is
// physics on this hardware, not a choice. So generations QUEUE: a second
// session's turn waits for the first to finish rather than interleaving on the
// server or failing. The wait respects cancellation, so a queued turn the user
// abandons never runs at all.
let generateChain = Promise.resolve();

/**
 * A CONVERSATION THAT OUTGREW THE WINDOW MUST STILL ANSWER.
 *
 * MEASURED with the real runtime and a real 140,000-character session:
 *   engine HTTP 400: request (43714 tokens) exceeds the available context
 *   size (16384 tokens), try increasing it
 * ...returned in 129 ms, for every message, forever. The overflow was DETECTED
 * (contextOverflowFrom, below) and handed back as an error that nothing outside
 * this file ever read. So a session answered happily until the day its history
 * crossed the window, and from then on it was dead — while a brand-new session
 * on the same model replied fine. That is exactly the shape the operator
 * reported: "the context of the other sessions is what is killing the service".
 *
 * The fix is the ordinary one every chat program needs: when the prompt does
 * not fit, DROP THE OLDEST TURNS AND TRY AGAIN. Two rules make it safe:
 *   - a leading system message is never dropped; it is the instructions.
 *   - the newest turn is never dropped; it is what was just asked.
 * The engine tells us how many tokens it actually got and how many it had room
 * for, so the amount to shed is computed from ITS arithmetic, not an estimate
 * on this side of the wire. What was dropped is reported back as `dropped` so
 * the interface can say so rather than quietly losing the beginning of a
 * conversation.
 */
/* The trimming itself lives in contextFit.js, because the REMOTE path needs the
 * identical rule and these two drifted once already: this side grew a detector
 * whose result nothing outside the file ever read, and the other side never got
 * one at all. One implementation, one test, no drift. */
const contextFit = require("./contextFit");

function generateFitting(messages, maxTokens, cancelToken, onToken, opts) {
    return contextFit.sendFitting(messages,
        (msgs) => generateNow(msgs, maxTokens, cancelToken, onToken, opts),
        { cancelToken, isOverflow: (r) => (r && r.contextOverflow) || null });
}

function generate(messages, maxTokens = 1536, cancelToken, onToken, opts) {
    // `opts` (e.g. temperature) is captured HERE, at call time, and rides the
    // closure to the queued run. The old path set a module-level variable and
    // read it at DEQUEUE time — so two concurrent sessions at different effort
    // levels clobbered each other's temperature while one waited in the chain.
    const run = generateChain.then(() => {
        if (cancelToken && cancelToken.cancelled) return { error: "cancelled" };
        return generateFitting(messages, maxTokens, cancelToken, onToken, opts);
    });
    // the chain must survive a failed turn, or one error would wedge the queue
    generateChain = run.catch(() => {});
    return run;
}

/**
 * THE ENGINE'S OWN REFUSAL, READ RATHER THAN GUESSED AT.
 *
 * llama.cpp says exactly how many tokens it was handed and exactly how many it
 * had room for. Both sentences it can use are matched here, and the numbers are
 * lifted out when they are present, because a MEASURED token count is worth
 * more than any estimate this side of the wire can produce: the caller re-fits
 * against the engine's own arithmetic instead of its own guess.
 *
 *   OAI endpoint: "the request exceeds the available context size. try
 *                  increasing the context size or enable context shift"
 *   slot:         "request (7760 tokens) exceeds the available context size
 *                  (4096 tokens), try increasing it"
 */
const CTX_OVERFLOW_RE =
    /exceeds? the available context size|larger than the max context size|exceed_context_size/i;
function contextOverflowFrom(text) {
    const s = String(text || "");
    if (!CTX_OVERFLOW_RE.test(s)) return null;
    const m = /\((\d+)\s*tokens?\)[^()]*\((\d+)\s*tokens?\)/.exec(s);
    return {
        promptTokens: m ? Number(m[1]) : null,
        windowTokens: m ? Number(m[2]) : contextWindow(),
        message: s.slice(0, 300)
    };
}

// REASONING EFFORT: lower effort = higher temperature (quick, creative);
// higher effort = lower temperature (focused, reasoning). The PREFERRED path
// is opts.temperature on generate() — captured per call, race-free. This
// module-level override remains only for any caller not yet passing opts;
// it is the racy legacy path and router.js no longer uses it.
// (the legacy module-level effort-temperature override is gone: every
// caller passes opts.temperature, and module state leaks across sessions)

async function generateNow(messages, maxTokens = 1536, cancelToken, onToken, opts = {}) {
    // transparently reload if the model was unloaded while idle
    const up = await ensureLoaded();
    if (!up.ok) return { error: up.error, guard: !!up.guard, refusal: up.refusal };

    lastUsedAt = Date.now();
    generating++;

    const t0 = Date.now();
    let text = "";
    let tokens = 0;
    let finishReason = null;
    let sseBuf = "";
    // AN ERROR DELIVERED INSIDE THE STREAM IS STILL AN ERROR.
    //
    // llama-server answers a `stream: true` request 200 and then puts the
    // failure in a `data:` frame. That frame carries no `choices`, so it fell
    // through every branch below and the turn ended on "invalid response from
    // engine" — measured, driving the real loop against a context refusal. The
    // one message that could have explained the whole hang was the one message
    // being thrown away.
    let streamError = null;
    // the engine's own prompt/completion counts, when it reports them
    let usage = null;

    const consume = (chunk) => {
        sseBuf += chunk;
        // SSE frames are separated by a blank line; keep the trailing partial
        const frames = sseBuf.split("\n\n");
        sseBuf = frames.pop();
        for (const frame of frames) {
            for (const line of frame.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") continue;
                try {
                    const j = JSON.parse(payload);
                    if (j && j.error) {
                        streamError = (j.error && (j.error.message || j.error.msg))
                            || String(j.error);
                        continue;
                    }
                    // THE LOCAL ENGINE'S OWN TOKEN COUNTS, WHICH IT WAS NEVER
                    // ASKED FOR. llama-server emits a final SSE frame carrying
                    // `usage` only when the request sets stream_options
                    // include_usage — it did not, so every local turn reported
                    // no usage at all. Downstream that meant the context ring
                    // had nothing to divide (it read 0% on every local session,
                    // the defect reported as "the donut never appears") and the
                    // message footer could not say what a reply had cost in
                    // tokens. The counts are the ENGINE'S, not an estimate on
                    // this side of the wire.
                    if (j && j.usage && typeof j.usage.prompt_tokens === "number") {
                        usage = {
                            prompt_tokens: j.usage.prompt_tokens,
                            completion_tokens: j.usage.completion_tokens || 0,
                            total_tokens: j.usage.total_tokens
                                || ((j.usage.prompt_tokens || 0) + (j.usage.completion_tokens || 0))
                        };
                    }
                    const choice = j.choices && j.choices[0];
                    const delta = choice && choice.delta && choice.delta.content;
                    if (typeof delta === "string" && delta) {
                        text += delta;
                        tokens++;
                        if (onToken) {
                            try { onToken({ text, tokens, elapsedMs: Date.now() - t0 }); }
                            catch { /* listener error must not kill the stream */ }
                        }
                    }
                    if (choice && choice.finish_reason) finishReason = choice.finish_reason;
                } catch { /* partial frame; ignore */ }
            }
        }
    };

    let res;
    try {
        res = await request("POST", "/v1/chat/completions", {
            model: "local-model",
            messages,
            max_tokens: maxTokens,
            // REASONING EFFORT: lower effort = higher temp (quick, creative),
            // higher effort = lower temp (focused, reasoning). The session's
            // effortLevel arrives as opts.temperature (per call, race-free);
            // the module override is legacy; default 0.3 when neither is set.
            temperature: opts.temperature !== undefined ? opts.temperature
                : 0.3,
            stream: true,
            // ASK FOR THE COUNTS. Without this llama-server streams the answer
            // and never says how many tokens went in or came out, so a local
            // turn had no usage to report and the context ring divided by
            // nothing. Harmless on builds that ignore it.
            stream_options: { include_usage: true }
        }, GEN_TIMEOUT_MS, cancelToken, consume);
    } finally {
        generating--;
        lastUsedAt = Date.now();
    }

    // The HTTP-status shape and the in-stream shape are the same failure and
    // are reported the same way, with the engine's own numbers attached when it
    // supplied them.
    if (!res.ok || streamError) {
        const msg = streamError || res.error;
        const overflow = contextOverflowFrom(msg);
        return overflow
            ? { error: msg, contextOverflow: overflow }
            : { error: msg };
    }

    // Non-stream fallback: some builds answer a plain JSON body regardless
    if (!text && res.data && res.data.choices) {
        const choice = res.data.choices[0];
        const content = choice?.message?.content;
        if (typeof content !== "string") return { error: "invalid response from engine" };
        return { content, truncated: choice?.finish_reason === "length" };
    }

    if (!text) return { error: "invalid response from engine" };
    const elapsedMs = Date.now() - t0;
    return {
        content: text,
        truncated: finishReason === "length",
        // the engine's own numbers when it gave them; the shape is the one
        // every remote path already returns, so nothing downstream has to
        // know whether the tokens came from llama.cpp or a vendor
        ...(usage ? { usage } : {}),
        stats: {
            tokens,
            elapsedMs,
            tps: elapsedMs > 400 ? +(tokens / (elapsedMs / 1000)).toFixed(1) : null
        }
    };
}

module.exports = {
    start, stop, stopAndWait, status, health, generate, preflight,
    // Boot needs to ask this too. Every other automatic load already does —
    // the guard recovery and the crash restart both check — and boot being
    // the one path that did not is why a remote-driven launch still planned,
    // refused, and warned about a local model nobody was going to use.
    remoteDriving,
    // The `--ctx-size` in force, so the turn can budget its prompt against the
    // window that actually exists instead of against a message count.
    contextWindow,
    // exported so the engine's own refusal can be parsed in a test rather than
    // restated there and agreed with
    contextOverflowFrom,
    // the machine's channel: what the memory guard said, and a way to retire it
    guardNotice: () => guardNotice,
    clearGuard,
    ensureLoaded, setIdleUnloadMs, setStateListener, startIdleWatch,
    LOAD_PHASES, loadPhase: () => liveLoad(),
    unloadNow: () => { unloadedForIdle = true; stop(); notify("manual-unload"); },
    recentLog: () => log.slice(-60),
    apiKey: () => apiKey,
    endpoint: () => `http://${HOST}:${PORT}`
};
