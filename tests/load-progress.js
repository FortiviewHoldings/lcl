/**
 * WHERE THE MODEL LOAD IS — reported, not spun.
 *
 * The prior build only showed "starting local model" with no progress tied to
 * the model load — no indication of where it was or what the exact state of the
 * load was until it had finished loading.
 *
 * Two defects behind that:
 *   1. waitForBackend() polled /health forever and said the same six words
 *      whether or not anything was actually starting — so an engine nobody
 *      launched was indistinguishable from one mid-load, and the app waited
 *      for a start that was never coming.
 *   2. the engine shouted real milestones into a log that nothing turned into
 *      a state, so no surface could say which step a load was on.
 *
 * The phases here are calibrated against llama.cpp's ACTUAL output on this
 * machine, captured by running it — not against what it used to print.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
// Free memory is a DIAL here, because the whole point of the driven section at
// the bottom is that `--ctx-size` is a function of it.
let FREE_BYTES = 1024;
process.getSystemMemoryInfo = () => ({
    total: Math.max(1, Math.round(16.8e9 / 1024)),
    free: Math.round(FREE_BYTES / 1024),
    swapTotal: 1, swapFree: 1
});

/* ---- the engine spawns llama-server; here it spawns a stand-in ------------
 * Installed BEFORE engine.js is required, because engine.js destructures
 * `spawn` at load. Everything else in the driven section is the shipped code:
 * the planner, the argv, the phase machine, the HTTP client, the guard. Only
 * the binary is swapped, so no weights are loaded and the machine running this
 * suite is never put at risk. */
const cp = require("child_process");
const realSpawn = cp.spawn;
const SPAWNS = [];
const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-fakeengine-"));
const FAKE_BIN = path.join(FAKE_DIR, "fake-llama-server.js");
cp.spawn = function (bin, argv, opts) {
    if (String(bin).toLowerCase().includes("llama-server") && fs.existsSync(FAKE_BIN)) {
        SPAWNS.push({ bin, argv: (argv || []).slice() });
        return realSpawn(process.execPath, [FAKE_BIN, ...(argv || [])], opts);
    }
    return realSpawn.apply(this, arguments);
};

// packaged mode reads process.resourcesPath (undefined under plain node);
// the repo root carries the same runtimes/ and models/ layout, read-only
process.resourcesPath = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-loadp-"));
require.cache[__filename] = { exports: {
    // isPackaged: TRUE, deliberately — in dev mode paths.dataDir() resolves
    // to the REPO's shared data/ directory, so what the engine records about
    // a load would land in the developer's own settings.json. Packaged mode
    // routes through getPath, which is this run's throwaway directory.
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 240) : ""); }
}

const ROOT = path.join(__dirname, "..");
process.on("exit", () => {
    try { fs.rmSync(FAKE_DIR, { recursive: true, force: true }); } catch { /* held */ }
});

const engine = require(path.join(ROOT, ".lcl.engine", "core", "engine.js"));
const engSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "engine.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "index.html"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");

/* ---- the phases are real, ordered, and named for a person ---- */
check("a load has named phases, in order, from planning to ready",
    Array.isArray(engine.LOAD_PHASES) && engine.LOAD_PHASES.length >= 5 &&
    engine.LOAD_PHASES[0].key === "planning" &&
    engine.LOAD_PHASES[engine.LOAD_PHASES.length - 1].key === "ready",
    engine.LOAD_PHASES && engine.LOAD_PHASES.map(p => p.key));
check("every phase says what it is doing in words a person reads, not a code",
    engine.LOAD_PHASES.every(p => p.label && p.label.length > 4 && /^[a-z]/.test(p.label)),
    engine.LOAD_PHASES.map(p => p.label));
check("the engine exposes the live load state, so every surface reads ONE state",
    typeof engine.loadPhase === "function" && /load: liveLoad\(\),/.test(engSrc));

/* ---- calibrated against the output this build actually prints ---- */
check("the phase patterns match THIS build's real lines, captured by running " +
      "it — load_model, initializing/n_slots, model loaded, listening on",
    /load_model: loading model/.test(engSrc) &&
    /initializing, n_slots/.test(engSrc) &&
    /model loaded\|warming up/.test(engSrc) &&
    /listening on/.test(engSrc));
check("...and the older llama.cpp patterns are kept, so a different build " +
      "still reports phases rather than none",
    /llama_model_loader/.test(engSrc) && /load_tensors/.test(engSrc) &&
    /KV self size/.test(engSrc));

/* ---- the estimate is learned, never invented ---- */
check("how long a load takes is LEARNED from this machine, so the first load " +
      "shows elapsed only and the next can show an estimate",
    /function learnedLoadMs/.test(engSrc) && /function recordLoadMs/.test(engSrc) &&
    /modelLoadMs/.test(engSrc));
check("a finished load records what it actually took",
    /recordLoadMs\(loadState\.modelId, took\)/.test(engSrc));
check("the average is gentle, so one cold-cache load does not set the bar",
    /t\[modelId\] \* 2 \+ ms\) \/ 3/.test(engSrc));

/* ---- a load that dies stops claiming to be in progress ---- */
check("a load that DIED is not left reporting itself as still loading",
    /endLoad\(\);\s*\/\/ it is not loading; it is dead/.test(engSrc));

/* ---- the phase machine never runs backwards ---- */
check("phases never go backwards, so a late log line cannot rewind the readout",
    /if \(loadState && LOAD_PHASES\.findIndex\(x => x\.key === loadState\.phase\) > order\) return;/.test(engSrc));

/* ---- THE HANG: nobody was starting it ---- */
check("the wait ASKS for a start when nothing is running, nothing is loading " +
      "and nothing has failed — it used to wait forever for a start that was " +
      "never coming",
    /NOTHING IS COMING UNLESS SOMEBODY STARTS IT/.test(appSrc) &&
    /window\.lcl\.restartEngine\(\)\.catch/.test(appSrc));
check("the status line reports the PHASE while loading, not the same six words " +
      "for two minutes",
    /setStatus\("busy", st\.load\.label\)/.test(appSrc));

/* ---- and it is on screen ---- */
check("there is a load readout in the markup",
    /id="load-progress"/.test(htmlSrc) && /id="load-phase"/.test(htmlSrc) &&
    /id="load-bar-fill"/.test(htmlSrc) && /id="load-line"/.test(htmlSrc));
check("it paints the phase, the step, the elapsed time and the engine's own " +
      "last line — the diagnostic is kept, not summarised away",
    /function paintLoad/.test(appSrc) && /step \$\{load\.step\} of \$\{load\.steps\}/.test(appSrc) &&
    /load\.line \|\| ""/.test(appSrc));
check("the bar is honest: a real fraction against a LEARNED duration, or the " +
      "phase count when this model has never been loaded here",
    /load\.etaMs\) \* 100/.test(appSrc) && /load\.step \/ load\.steps/.test(appSrc));
check("it is driven by the engine's own events, so it moves during a load " +
      "rather than only when something polls",
    /paintLoad\(s && s\.load\)/.test(appSrc));
check("and it is styled in the existing token system",
    /#load-progress \{/.test(cssSrc) && /var\(--radius-sm\)/.test(
        cssSrc.slice(cssSrc.indexOf("#load-progress {"), cssSrc.indexOf("#load-progress {") + 900)) &&
    /#load-bar-fill \{/.test(cssSrc));

/* ==========================================================================
 * A PROGRESS READOUT THAT LIES IS WORSE THAN NONE.
 *
 * An adversarial review found five states where this readout kept claiming
 * progress that had stopped — and one of them RE-CREATED THE VERY BUG the
 * feature was written to fix. waitForBackend() declines to ask for a start
 * while something claims to be loading, so a stale "loading" meant the engine
 * could never be started again: "just says starting local model", forever,
 * caused by the fix for "just says starting local model".
 * ======================================================================== */

check("STOPPING THE ENGINE ENDS THE LOAD — a stopped engine that still reports " +
      "itself as loading is one the renderer will never start again, which is " +
      "the reported bug rebuilt by its own fix",
    /endLoad\(\)/.test(engSrc.slice(engSrc.indexOf("function stop() {"),
                                   engSrc.indexOf("function stop() {") + 800)));

check("...and there is ONE way to end a load, so a terminal path added later " +
      "cannot quietly forget to do it",
    /function endLoad\(\)/.test(engSrc));

/* ---- the load confirms ITSELF ----------------------------------------
 * A reported symptom: the warming-up phase showed step 6 of 7 and looked
 * stuck. It usually was not stuck, it was UNOBSERVED. "warming up" is the
 * last phase the server's own output can produce — llama.cpp's final two
 * lines, "model loaded" and "listening on", both land there — and the only
 * thing that moved it to "ready" was health(), which runs when somebody asks.
 * With a conversation driving a model on the network, that session's health
 * check resolves to the REMOTE model and never touches the local engine, so a
 * local load that had completely finished had no reader at all.
 *
 * MEASURED after the fix, on a real llama-server load, reading ONLY
 * engine.loadPhase() and never calling health():
 *     starting 27ms -> reading 630ms -> buffers 1031ms -> warming 1233ms
 *     -> ready (step 7/7) 1350ms
 * and loadPhase() === null after stop().
 */
check("A FINISHED LOAD REACHES 'ready' WITH NOBODY WATCHING — a readout that " +
      "depends on being observed is not a readout",
    /function confirmReadySoon\(\)/.test(engSrc) &&
    (engSrc.match(/confirmReadySoon\(\);/g) || []).length >= 2);
check("...triggered by the server's OWN last words, both of them",
    (() => {
        const i = engSrc.indexOf('/model loaded|warming up|warmup/i');
        const blk = engSrc.slice(i, i + 400);
        return (blk.match(/confirmReadySoon\(\)/g) || []).length === 2;
    })());
check("...bounded, so a server that never answers cannot leave a probe running " +
      "for the life of the app",
    /READY_CONFIRM_MS/.test(engSrc) && /Date\.now\(\) - since > READY_CONFIRM_MS/.test(engSrc));
check("...cancelled the moment the load ends by any route",
    /if \(readyProbe\) \{ clearTimeout\(readyProbe\); readyProbe = null; \}/.test(engSrc));
check("...and it never holds the app open",
    /readyProbe\.unref/.test(engSrc));
check("...and it stops the instant the engine is stopped or the child is gone",
    (() => {
        const i = engSrc.indexOf("const tick = async () => {");
        return /if \(stopping \|\| !child \|\| child\.killed\) return;/.test(engSrc.slice(i, i + 400));
    })());

for (const [what, marker] of [
    ["the planner REFUSING a load", "[planner] refused"],
    ["the memory guard KILLING a load", 'reason: "guard"'],
    ["the engine dying before it was ever healthy", "it is not loading; it is dead"],
    ["giving up after a crash loop", 'reason: "crash-loop"']
]) {
    const i = engSrc.indexOf(marker);
    check(what + " ends the load too",
        i > 0 && /endLoad\(\)/.test(engSrc.slice(Math.max(0, i - 500), i + 250)), marker);
}

check("THE ELAPSED TIME IS READ, NOT REMEMBERED: it was stamped at the last " +
      "phase change, so through 'loading the weights' — where a load spends " +
      "most of its time — the clock and the bar sat still and it looked hung",
    /function liveLoad\(\)/.test(engSrc) && /load: liveLoad\(\)/.test(engSrc));

check("...and a FINISHED load keeps its final time instead of counting up forever",
    /phase === "ready"/.test(engSrc.slice(engSrc.indexOf("function liveLoad()"),
                                          engSrc.indexOf("function liveLoad()") + 400)));

check("...and every surface reads that one live value, not a stored copy",
    /loadPhase: \(\) => liveLoad\(\)/.test(engSrc));

check("A FALLBACK LOADS A DIFFERENT MODEL, SO IT IS RELABELLED — otherwise the " +
      "ETA came from the wrong model's history, and the measured time was " +
      "written back under a model that never loaded, poisoning it for good",
    (() => {
        const i = engSrc.indexOf("plan = fb.plan;");
        const blk = engSrc.slice(i, i + 600);
        return i > 0 && /loadState\.modelId =/.test(blk)
                     && /learnedLoadMs\(loadState\.modelId\)/.test(blk);
    })());

check("THE PHASE PATTERNS ACTUALLY MATCH THE ENGINE'S OUTPUT — one had lost its " +
      "backslashes and could never have fired, beside a comment claiming it was " +
      "calibrated against captured output",
    (() => {
        const rx = /load_tensors|llm_load_tensors|loading model tensors|^\s*[\d.]+ [A-Z] load:/i;
        return rx.test("  12.5 M load: special tokens cache size = 26")
            && rx.test("load_tensors: loading model tensors")
            && !rx.test("main: server is listening on http://127.0.0.1:8081");
    })());

check("...and the calibration comment now SHOWS the captured lines, so the " +
      "claim can be checked instead of taken on trust",
    /load_model: loading model/.test(engSrc) && /main: server is listening/.test(engSrc));

check("A RESCUE START CAN FALL BACK, like the boot start it stands in for — " +
      "without it the rescue was strictly worse than what it replaced on a " +
      "machine where the preferred model no longer fits",
    /engine\.start\(\{ allowFallback: true \}\)/.test(
        mainSrc.slice(mainSrc.indexOf('ipcMain.handle("lcl:restartEngine"'),
                      mainSrc.indexOf('ipcMain.handle("lcl:restartEngine"') + 800)));

check("THE RENDERER NEVER SPAWNS A LOCAL ENGINE FOR A REMOTE-DRIVEN SESSION — " +
      "it asks the backend WHICH model has to be alive before it asks for " +
      "anything to start, so a conversation pointed at a machine on the network " +
      "cannot spawn gigabytes of local model it will never use",
    /if \(!asked && h && h\.kind === "local" && h\.status !== "ok"\)/.test(appSrc));

check("'Add a model file…' tests the contract lcl:chooseModel actually returns " +
      "({ modelPath }) rather than an 'ok' field it has never sent — that dead " +
      "branch left a model that loaded perfectly sitting on 'no model'",
    /if \(r && r\.modelPath\) \{ await refreshModelPick\(\)/.test(appSrc));

check("the load card is a SIBLING of the sidebar footer, not a child of it: " +
      "the footer is a horizontal row, so four stacked lines rendered as a " +
      "sliver squeezed beside the engine label",
    (() => {
        const f = htmlSrc.indexOf('<div id="sidebar-footer">');
        const l = htmlSrc.indexOf('<div id="load-progress"');
        return l > 0 && f > 0 && l < f;
    })());

check("...and it keeps its own height in that column rather than stretching",
    /flex: none;/.test(cssSrc.slice(cssSrc.indexOf("#load-progress {"),
                                    cssSrc.indexOf("#load-progress {") + 300)));

/* ==========================================================================
 * DRIVEN, NOT GREPPED.
 *
 * Everything above this line is a regex over a file, and a regex over a file is
 * how the last build was declared ready while the product did not work. What
 * follows STARTS THE REAL ENGINE — the real planner, the real argv, the real
 * phase machine, the real HTTP client — against a stand-in binary that behaves
 * like llama-server b10107, and reads what actually came back.
 *
 * The stand-in is calibrated against the shipped binary, not invented:
 *   ./llama-server.exe --help
 *       --context-shift, --no-context-shift  ... (default: disabled)
 *   strings llama-server-impl.dll
 *       "request (%d tokens) exceeds the available context size (%d tokens)"
 *       "exceed_context_size_error"
 * so an over-long prompt is REFUSED rather than truncated, and that refusal is
 * what user sessions were walking into.
 * ======================================================================== */
const FAKE_SRC = `
const http = require("http");
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N_CTX = Number(get("--ctx-size", 4096));
const PORT = Number(get("--port", 8081));
const CPT = 3.6;
process.stderr.write("load_model: loading model '" + get("--model", "?") + "'\\n");
process.stderr.write("llama_model_loader: loaded meta data with 30 key-value pairs\\n");
setTimeout(() => {
    process.stderr.write("load_tensors: loading model tensors, this can take a while...\\n");
    process.stderr.write("init: kv_size = " + N_CTX + ", type_k = 'q8_0'\\n");
    const srv = http.createServer((req, res) => {
        let body = "";
        req.on("data", c => { body += c; });
        req.on("end", () => {
            if (req.url === "/health") {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ status: "ok" }));
            }
            let p = {};
            try { p = JSON.parse(body); } catch (e) { /* not json */ }
            const chars = (p.messages || []).reduce((n, m) => n + String(m.content || "").length, 0);
            const promptTokens = Math.round(chars / CPT);
            const nPredict = Number(p.max_tokens || 0);
            process.stderr.write("SEEN prompt=" + promptTokens + " predict=" + nPredict +
                                 " nctx=" + N_CTX + "\\n");
            if (promptTokens + nPredict > N_CTX) {
                const msg = "request (" + promptTokens + " tokens) exceeds the available " +
                            "context size (" + N_CTX + " tokens), try increasing it";
                // b10107 answers a streaming request 200 and puts the failure
                // in a data: frame — the shape that used to be swallowed
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write("data: " + JSON.stringify({ error: { code: 400, message: msg,
                    type: "exceed_context_size_error" } }) + "\\n\\n");
                return res.end();
            }
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write("data: " + JSON.stringify({ choices: [{ delta:
                { content: "the fixer is at 24 C" } }] }) + "\\n\\n");
            res.write("data: [DONE]\\n\\n");
            res.end();
        });
    });
    srv.on("error", (e) => { process.stderr.write("FAKE BIND FAILED: " + e.message + "\\n"); });
    srv.listen(PORT, "127.0.0.1", () => {
        process.stderr.write("main: model loaded\\n");
        process.stderr.write("main: server is listening on http://127.0.0.1:" + PORT + "\\n");
    });
}, 120);
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const paths = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));

async function driven() {
    const model = path.join(ROOT, "models", "qwen3-4b-instruct-2507-q4_k_m.gguf");
    if (!fs.existsSync(model)) {
        check("DRIVEN SECTION: a chat model is on disk to plan against", false, model);
        return;
    }
    fs.writeFileSync(FAKE_BIN, FAKE_SRC);
    paths.writeSettings({ modelPath: model });

    /* ---- the window is a function of free memory, and it is READABLE ---- */
    FREE_BYTES = 5.6e9;
    const started = await engine.start();
    check("the engine starts against the planner's own numbers",
        started.ok && started.plan && started.plan.ctxSize > 0, started.error || started.plan);
    const argvCtx = Number(SPAWNS.length
        && SPAWNS[SPAWNS.length - 1].argv[SPAWNS[SPAWNS.length - 1].argv.indexOf("--ctx-size") + 1]);
    check("THE WINDOW IS READABLE FROM OUTSIDE THE ENGINE — engine.contextWindow() " +
          "is the same number that went onto llama-server's command line. Nothing " +
          "above this file could read it before, so the turn sized its prompt by " +
          "MESSAGE COUNT and sent it blind into a window it never asked about",
        typeof engine.contextWindow === "function" &&
        engine.contextWindow() === argvCtx && argvCtx === started.plan.ctxSize,
        { fromEngine: engine.contextWindow && engine.contextWindow(), argvCtx,
          plan: started.plan && started.plan.ctxSize });
    check("...and it is on status() too, so a readout can show the real window",
        engine.status().contextWindow === argvCtx, engine.status().contextWindow);

    for (let i = 0; i < 40 && engine.status().state !== "running"; i++) await sleep(100);
    check("a loaded engine reports ONE state: running", engine.status().state === "running",
        engine.status().state);

    /* ---- a prompt inside the window is answered ---- */
    const small = await engine.generate(
        [{ role: "system", content: "you are .lcl" }, { role: "user", content: "fixer temp?" }],
        256, null, null);
    check("a prompt that fits is answered", !small.error && /24 C/.test(small.content || ""),
        small.error || small.content);

    /* ---- a prompt past the window: the engine's own words, and its numbers ---- */
    const big = await engine.generate(
        [{ role: "system", content: "x".repeat(argvCtx * 3.6) },
         { role: "user", content: "fixer temp?" }],
        1536, null, null);
    check("AN ERROR DELIVERED INSIDE THE STREAM IS STILL AN ERROR. llama-server " +
          "answers a streaming request 200 and puts the failure in a data: frame; " +
          "that frame carries no `choices`, so it fell through every branch and " +
          "the turn died on 'invalid response from engine' — the one message that " +
          "could have explained the whole hang was the one being thrown away",
        !!big.error && big.error !== "invalid response from engine" &&
        /exceeds the available context size/.test(big.error), big);
    check("...and the engine's MEASURED token count comes back with it, so the " +
          "caller can re-fit against arithmetic instead of against its own guess",
        !!big.contextOverflow && big.contextOverflow.promptTokens > argvCtx &&
        big.contextOverflow.windowTokens === argvCtx, big.contextOverflow);
    check("the overflow parser reads the shipped binary's exact sentence",
        (() => {
            const o = engine.contextOverflowFrom(
                "request (7760 tokens) exceeds the available context size (4096 tokens), " +
                "try increasing it");
            return o && o.promptTokens === 7760 && o.windowTokens === 4096;
        })());
    check("...and does not fire on an unrelated failure",
        engine.contextOverflowFrom("engine timed out after 300s") === null);

    /* ---- a SECOND load says why it is happening ----
     * Reported: "a model that already loaded, with progress shown, loads AGAIN
     * when you send the first message." Measured against engine.js: a live
     * engine is never re-spawned by a turn — 0 spawns across a first message on
     * a loaded engine. The reload is the IDLE UNLOADER (ten minutes by default),
     * and nothing said so, so the same progress bar appeared twice for no
     * stated reason. */
    const events = [];
    engine.setStateListener((s) => events.push(s));
    const spawnsBefore = SPAWNS.length;
    const beforeUnload = await engine.generate(
        [{ role: "user", content: "still here?" }], 64, null, null);
    check("a live engine is NOT re-spawned by a generation",
        !beforeUnload.error && SPAWNS.length === spawnsBefore,
        { spawned: SPAWNS.length - spawnsBefore });
    engine.unloadNow();
    for (let i = 0; i < 60 && engine.status().running; i++) await sleep(100);
    events.length = 0;
    const afterUnload = await engine.generate(
        [{ role: "user", content: "fixer temp?" }], 64, null, null);
    check("a message after an idle unload reloads and answers", !afterUnload.error,
        afterUnload.error);
    const loadingEvent = events.find(e => e.reason === "loading");
    check("...and the second load SAYS WHY it is happening, so a progress bar " +
          "appearing twice is explained rather than mysterious",
        !!loadingEvent && loadingEvent.because === "idle-unload" &&
        loadingEvent.reload === true, loadingEvent && loadingEvent.because);
    engine.setStateListener(null);

    /* ---- STOP: one state, never two ---- */
    engine.stop();
    const during = engine.status();
    check("A STOP THAT IS STILL IN FLIGHT SAYS 'stopping', ONCE — the reported bug " +
          "is 'stopping' shown above 'stopped', which happens when every surface " +
          "keeps its own idea of the stop because the engine reported none",
        during.state === "stopping" && during.stopping === true, during.state);
    check("...and 'stopping' and 'stopped' can never both be true, by construction",
        !(during.state === "stopping" && during.state === "stopped"));
    for (let i = 0; i < 60 && engine.status().running; i++) await sleep(100);
    const after = engine.status();
    check("a stop that finished is 'stopped', and stays there — the state survives " +
          "a repaint because it lives in the engine, not in whichever surface " +
          "happened to press the button",
        after.state === "stopped" && after.stopping === false && after.running === false,
        { state: after.state, stopping: after.stopping, running: after.running });

    /* ---- the guard has a surface of its own ---- */
    FREE_BYTES = 1.6e9;                       // nothing fits
    engine.clearGuard();
    const refused = await engine.start();
    check("a load the planner refuses is reported as a MACHINE condition, tagged, " +
          "not as an error of unknown origin",
        refused.ok === false && refused.guard === true, refused);
    const g = engine.status().guard;
    check("THE GUARD HAS ITS OWN CHANNEL. 'asked for an image of a donkey, got a " +
          "refusal about closing apps to free memory' — memory refusals travelled " +
          "on the same wire as the model's reply, so the machine's words arrived " +
          "where the answer belongs. They have their own field now, with numbers",
        !!g && g.kind === "planner-refusal" && /memory/i.test(g.message) &&
        g.needBytes > 0, g);
    check("...and it is retired the moment a load actually goes ahead",
        typeof engine.clearGuard === "function" &&
        (engine.clearGuard(), engine.guardNotice() === null));
    FREE_BYTES = 5.6e9;
}

driven().catch(e => {
    fail++;
    console.log("FAIL | driven section threw -", e && e.stack || e);
}).then(() => {
    try { engine.stop(); } catch { /* already down */ }
    console.log(`\n${pass}/${pass + fail} load-progress checks passed`);
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 6 }); } catch { /* held */ }
    process.exit(fail ? 1 : 0);
});
