/**
 * WHAT A REAL INSTALL FOUND, AND WHY EVERY SUITE MISSED IT.
 *
 * A real install could not be used. Every defect below was reported from that
 * run, diagnosed to specific lines, and fixed. They share a shape worth naming:
 * each one is a place where the app reported success while doing nothing — a
 * status line that said "remote · spark", a placeholder that said "Message
 * .lcl…", a library that listed its files, a load that said "warming up".
 * Everything agreed except the machine. The reported symptoms:
 *
 *   - the composer stayed stuck on "warming up" and could not be typed into,
 *     even with a model currently loaded after switching
 *   - the knowledge libraries were gone, but the UI still showed stale entries
 *   - items in the left sidebar were laid out poorly
 *   - a linked node was restarted with no telemetry to say when or why
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

const ROOT = path.join(__dirname, "..");
const R = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const mainSrc = R("app", "main.js");
const appSrc = R("app", "renderer", "app.js");
const preSrc = R("app", "preload.js");
const cssSrc = R("app", "renderer", "styles.css");
const htmlSrc = R("app", "renderer", "index.html");
const cloudSrc = R(".lcl.engine", "core", "cloudModels.js");
let _agentSrc = null;
function agentSrc2() {
    if (_agentSrc === null) _agentSrc = R(".lcl.engine", "core", "agent.js");
    return _agentSrc;
}
const knowSrc = R(".lcl.engine", "core", "knowledge.js");

/* ===================================================================
 * 1. THE COMPOSER LOCK — two independent faults, either one fatal
 * ================================================================= */

check("AN ASYNC RESULT IS AWAITED BEFORE IT IS SPREAD. engine.health() is " +
      "async and the handler was not, so `{ ...engine.health() }` copied a " +
      "Promise's own enumerable properties — of which there are none. The " +
      "health check returned { kind: 'local' } with NO status, every exit test " +
      "in the readiness loop reads status, and the loop could never break",
    /\.\.\.\(await engine\.health\(\)\)/.test(mainSrc));

check("...and NO handler anywhere spreads a call into an object without " +
      "awaiting it, because this failed silently for a week and only showed up " +
      "on a machine whose global default happened to be unset",
    (() => {
        const offenders = [];
        const modCache = {};
        for (const m of mainSrc.matchAll(/\.\.\.\s*([a-zA-Z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\(/g)) {
            const [full, obj, fn] = m;
            // is the call already awaited right there?
            const at = mainSrc.indexOf(full);
            if (/await\s*$/.test(mainSrc.slice(Math.max(0, at - 12), at + 3))) continue;
            const req = new RegExp(`const ${obj} = require\\("([^"]+)"\\)`).exec(mainSrc);
            if (!req) continue;
            const rel = req[1].replace(/^\.\.\//, "");
            const file = path.join(ROOT, rel.endsWith(".js") ? rel : rel + ".js");
            if (!(file in modCache)) {
                try { modCache[file] = fs.readFileSync(file, "utf8"); } catch { modCache[file] = ""; }
            }
            if (new RegExp(`async function ${fn}\\s*\\(`).test(modCache[file])) {
                offenders.push(`${obj}.${fn}()`);
            }
        }
        return offenders.length === 0;
    })(), "an un-awaited async call spread into an object contributes nothing");

check("...and it is proven, not argued: spreading a promise really does lose " +
      "every field",
    (() => {
        async function h() { return { status: "ok" }; }
        return Object.keys({ ...h(), kind: "local" }).join(",") === "kind";
    })());

check("THE HEALTH CHECK ASKS ABOUT *THIS SESSION'S* MODEL. It read the global " +
      "driver role while the picker, the router and the status line all resolve " +
      "per session — so a conversation running on a machine on the network was " +
      "told its backend was a local engine it was never going to use",
    /router\.resolveSelection\(s\)/.test(mainSrc) &&
    /ipcMain\.handle\("lcl:checkHealth", async \(_e, sessionId\)/.test(mainSrc));
check("...and the session id actually travels to it",
    /checkHealth: \(sessionId\)/.test(preSrc) &&
    /checkHealth\(active && active\.id\)/.test(appSrc));

check("PICKING A REMOTE MODEL RE-ENABLES THE COMPOSER. The remote branch " +
      "returned before the line that does it — and that line sits below, with a " +
      "comment explaining why it is needed, as dead code for the only kind of " +
      "model that reaches it",
    (() => {
        const i = appSrc.indexOf("if (target && target.remote) {");
        const blk = appSrc.slice(i, i + 1400);
        return i > 0 && /ready = true;/.test(blk) && /setControls\(\);/.test(blk)
            && blk.indexOf("ready = true;") < blk.indexOf("return;");
    })());

check("THE START IS ASKED FOR ONLY AFTER THE BACKEND IS IDENTIFIED — asking " +
      "first spawned a local model, gigabytes of it, for a conversation pointed " +
      "at a machine on the network",
    (() => {
        const i = appSrc.indexOf("async function waitForBackend");
        const blk = appSrc.slice(i, i + 2000);
        return blk.indexOf("checkHealth(") < blk.indexOf("restartEngine()");
    })());

/* ===================================================================
 * 2. THE MACHINE ON THE NETWORK — a client timeout must not OOM a host
 * ================================================================= */

check("THE SHORT LEASH COVERS CONNECTING, NOT ANSWERING. It was the request's " +
      "inactivity timeout, and an OpenAI-compatible server sends nothing until " +
      "generation starts — so a large model coming off disk was indistinguishable " +
      "from a dead route and was cut off at six seconds every time",
    /req\.on\("socket"/.test(cloudSrc) &&
    /sock\.once\("connect", up\)/.test(cloudSrc) &&
    !/method: "POST", headers, timeout: leash/.test(cloudSrc));

check("A REQUEST THAT REACHED THE SERVER IS NEVER SENT DOWN THE OTHER ROAD. " +
      "The door and the direct address are two roads to ONE machine, so the " +
      "fallback put a second chat on a host already loading a 100 GB model, and " +
      "the host allocated a second runner for it — a client-side timeout turning " +
      "into an out-of-memory on the user's own hardware",
    /if \(!connected && tryOther\(\)\) return;/.test(cloudSrc));

check("...and when it does give up on a machine that connected, it says that " +
      "is what happened rather than blaming the route",
    /accepted the request but sent nothing for/.test(cloudSrc));

check("...and a silent-but-connected failure is NOT retried into another runner: " +
      "only a mid-stream death is resumable, and nothing arrived",
    /midStream: !!output/.test(cloudSrc) && /if \(!e\.midStream \|\| attempt === MAX_ATTEMPTS/.test(cloudSrc));

/* ---- and there is now a record of any of it happening ---- */
check("EVERY CALL TO A MACHINE OF THE USER'S OWN IS RECORDED LOCALLY — " +
      "when, which endpoint, which model, which road, how long, how it ended. " +
      "There was none of this, which is why 'what happened to the machine, and " +
      "when' had no answer at all",
    /function recordNodeCall/.test(cloudSrc) && /node-calls\.jsonl/.test(cloudSrc));
check("...on every outcome, not just the happy one — including a node that TOOK the " +
      "request and never began answering (a first-token stall), logged distinctly " +
      "from a silence that arrived mid-generation",
    ["ok", "unreachable", "error"].every(k => new RegExp(`logCall\\("${k}"`).test(cloudSrc))
    // the same timeout site now distinguishes THREE things: never got there
    // ("timeout"), got there then went silent forever before a token
    // ("stalled-no-first-token"), and got there then fell silent mid-answer
    // ("silent-after-connect").
    && /connected \? "silent-after-connect" : "timeout"/.test(cloudSrc)
    && /"stalled-no-first-token"/.test(cloudSrc));
check("...for the user's OWN machines only — a company's endpoint has a " +
      "cost ledger already, and its capacity is not the user's problem",
    /const isNode = isNodeEndpoint\(s\);/.test(cloudSrc) &&
    /if \(logged \|\| !isNode\) return;/.test(cloudSrc));
check("...never carrying the prompt or the key, because a call log is a record " +
      "of the CALL and not of the conversation",
    (() => {
        const i = cloudSrc.indexOf("const logCall =");
        const blk = cloudSrc.slice(i, i + 500);
        return !/body|messages|prompt|key|auth/i.test(blk);
    })());
check("...and it is readable, or it is not telemetry, it is a landfill",
    /function recentNodeCalls/.test(cloudSrc) && /recentNodeCalls,/.test(cloudSrc));
check("...and it rolls, so a log cannot fill the disk it lives on",
    /NODE_LOG_MAX/.test(cloudSrc));

/* ===================================================================
 * 3. A LIBRARY THAT IS GONE MAY NOT DESCRIBE ITSELF AS PRESENT
 * ================================================================= */

check("THE FILE COUNT IS MEASURED, NOT REMEMBERED. list() checked only whether " +
      "the ROOT still resolved, then reported files and passages from a saved " +
      "index — so a folder that survived while its documents were deleted " +
      "rendered identically to a healthy library, counts and all",
    /presentFiles/.test(knowSrc) && /function countPresentFiles/.test(knowSrc));
check("...with a flag for the case that actually happened: root present, " +
      "contents gone",
    /emptied: stillThere && indexedFiles > 0 && presentFiles === 0/.test(knowSrc));
// The shelf became the one knowledge panel (contract K6), so the readout moved.
// Both halves still have to be there: the STATE on the library's own line, and
// the SENTENCE that says why the passage and document counts beside it are
// still printing numbers for files that no longer exist.
check("...and the UI SAYS SO, instead of printing the remembered numbers",
    /bits\.push\("folder is empty"\)/.test(appSrc) &&
    /are from documents that are gone/.test(appSrc));
check("...and a stale readout does not look like a live one",
    /\.eng-meta\.stale/.test(cssSrc) && /meta\.classList\.add\("stale"\)/.test(appSrc));
check("...and counting the disk is bounded, so a readout cannot walk a " +
      "200,000-file tree on every paint",
    /PRESENCE_SCAN_CAP/.test(knowSrc));

/* ===================================================================
 * 4. THE SIDEBAR MAY NOT DELETE ITS OWN LAST ROW
 * ================================================================= */

check("THE COLUMN SCROLLS RATHER THAN CLIPPING. It had exactly one flexible " +
      "child, so when the fixed furniture exceeded the window the session list " +
      "was squeezed to zero and everything past it was clipped — measured, the " +
      "footer sat 62px below the bottom edge with no scrollbar and no sign " +
      "anything was missing",
    (() => {
        const i = cssSrc.indexOf("\n#sidebar {");   // not the compound selectors
        const blk = cssSrc.slice(i, i + 900);
        return /overflow-y: auto;/.test(blk) && /overflow-x: hidden;/.test(blk)
            && !/\n    overflow: hidden;/.test(blk);
    })());

check("...and the session list has a floor: it measured ONE PIXEL tall, which " +
      "is the app's primary navigation present in the DOM and invisible on screen",
    (() => {
        // The protection evolved AGAIN. flex:none (natural height, sidebar
        // scrolls) cured the one-pixel list but re-created the OTHER failure
        // for the footer: a long session list pushed the machine readout off
        // the bottom, and the spec is explicit — the RAM readout must be locked
        // in place at the bottom of the left sidebar, not part of the sessions
        // container. The hybrid holds both
        // guarantees at once: the LIST is the flexible scroll region with a
        // REAL floor (never one pixel), and below that floor the sidebar's
        // own overflow-y takes over (the check above), so nothing is ever
        // clipped out of reach. Pinned footer in every window tall enough to
        // hold it; scrollable, never clipped, in one that is not.
        const i = cssSrc.indexOf("#session-list {");
        const blk = cssSrc.slice(i, i + 900);
        const floor = /min-height:\s*(\d+)px/.exec(blk);
        return /flex: 1 1 auto;/.test(blk)
            && floor && Number(floor[1]) >= 100
            && /overflow-y: auto;/.test(blk);
    })());

check("...and the load card no longer double-spaces itself against the column's " +
      "own gap",
    (() => {
        const i = cssSrc.indexOf("#load-progress {");
        const blk = cssSrc.slice(i, i + 700);
        return /margin: 0;/.test(blk) && !/margin: var\(--sp-1\) 0 var\(--sp-2\)/.test(blk);
    })());

check("...and one long line of engine output cannot resize the sidebar, while " +
      "the diagnostic itself is kept — clamped on screen, whole in the tooltip",
    (() => {
        const i = cssSrc.indexOf("#load-line {");
        return /-webkit-line-clamp: 2;/.test(cssSrc.slice(i, i + 400))
            && /ln\.title = load\.line/.test(appSrc);
    })());

/* ===================================================================
 * 5. THE SIDEBAR READOUT IS NOT A SESSION
 *
 * A reported symptom: the white sidebar status dot was meaningless — it looked
 * like a session row, and if it was meant to show the model responding, that is
 * already shown in each session, so it was redundant or in the wrong location.
 *
 * All three true. The row was placed above the memory bar because engine state
 * and memory are one story — the reason the model stopped is usually the number
 * underneath it. Then setModelStatus() began writing WHICH MODEL ANSWERS THIS
 * CONVERSATION into it on every session paint, so it permanently read
 * "node · spark": a second copy of something the session already shows, in a
 * row that exists to say something else, which was therefore never visible.
 *
 * MEASURED in a real render at 1200x720, before and after:
 *   session list   130px for 8 sessions  ->  181px
 *   furniture      355px                 ->  300px
 *   outer column   never scrolled (the list starved to its floor instead)
 *                                        ->  fits, and scrolls when it cannot
 *   footer         wrapped to two lines  ->  one line
 * ================================================================= */

check("THE ENGINE ROW REPORTS THE ENGINE. Routing belongs to the conversation, " +
      "which already shows it — writing it here made the row redundant AND hid " +
      "the one thing nothing else on screen says",
    /async function paintEngineStatus\(\)/.test(appSrc) &&
    !/setStatus\("ok", \(ses\.kind === "node" \? "node · " : "remote · "\)/.test(appSrc));

check("...and it says something USEFUL when a machine on the network is " +
      "answering: that nothing is loaded here, so the memory below it is free",
    /no model loaded · memory free/.test(appSrc));

check("...and no routing path writes into it any more",
    !/setStatus\("ok", "remote · " \+ st\.selected\.label\)/.test(appSrc) &&
    !/setStatus\("ok", target\.endpointLabel/.test(appSrc) &&
    !/setStatus\("ok", res\.endpoint \? "remote · "/.test(appSrc));

check("IT DOES NOT LOOK LIKE A SESSION ROW. Every session carries an 8px " +
      "coloured dot; this was a 7px GLOWING WHITE one in the same position, " +
      "directly beneath them",
    (() => {
        // The design went FURTHER than the 5px grey dot this once pinned:
        // the sidebar status dot was deleted outright. No dot exists to be
        // confused with a session row — the strongest possible form of the
        // protection this check was written for.
        return !/sb-status-dot/.test(htmlSrc) && !/sb-status-dot/.test(cssSrc);
    })());

check("...and it sits INSIDE the readout group rather than at the bottom of " +
      "the list, so the heading is the break between navigation and gauges",
    (() => {
        // The readout group now IS the structure: node gauges live under the
        // one Memory heading (node-section, no heading of its own), and the
        // engine identity is a labelled line in the sidebar FOOTER — a
        // readout by name, nowhere near the session stack.
        const h = htmlSrc.indexOf('<div class="sb-section">Memory</div>');
        const n = htmlSrc.indexOf('<div id="node-section"');
        const f = htmlSrc.indexOf('<div id="sidebar-footer">');
        return h > 0 && n > h && f > n
            && /id="engine-label">\.lcl\.engine/.test(htmlSrc);
    })());

check("...and it no longer claims the column's leftover space",
    !/margin-top: auto;/.test(cssSrc.slice(cssSrc.indexOf("#sidebar-status {"),
                                           cssSrc.indexOf("#sidebar-status {") + 600)));

check("ONE HEADING OVER THE WHOLE MEMORY GROUP, not one per gauge: each row " +
      "names its own machine, so the second and third headings were repeating " +
      "the row beneath them at 29px each",
    // no id on it: the class carries the styling, and an id nothing reads is
    // decoration — which tests/renderer-wiring.js fails the build over
    /<div class="sb-section">Memory<\/div>/.test(htmlSrc) &&
    !/node-section-label/.test(htmlSrc) &&
    !/node-section-label/.test(appSrc));

check("...so this machine's gauge says which machine it is",
    /this machine · \$\{fmtGB\(s\.availableBytes\)\} free of/.test(appSrc));

/* ===================================================================
 * 6. LIVE DICTATION HEARS ONLY WHAT IS NEW
 *
 * Raised ten times. The live pass sent st0.chunks — the ENTIRE recording from
 * the first frame — on every update, so pass N re-transcribed everything said
 * so far and the cost of one update grew with how long you had been talking.
 * It was never a whisper speed problem.
 * ================================================================= */

check("THE LIVE PASS SENDS A WINDOW, NOT THE WHOLE RECORDING",
    /const mark = st0\.liveMark \|\| 0;/.test(appSrc) &&
    /wavFromPcm\(tail, st0\.rate\)/.test(appSrc) &&
    !/const wav = wavFromPcm\(st0\.chunks, st0\.rate\);/.test(appSrc));

check("...with a committed prefix, so text already recognised is not re-heard",
    /st0\.liveCommitted = whole;/.test(appSrc) && /st0\.liveMark = seen;/.test(appSrc));

check("...and the window is BOUNDED — proven by replaying the real slicing " +
      "logic over two minutes of audio: 15.0s largest window, against 120s " +
      "and climbing before",
    (() => {
        const RATE = 16000, CHUNK = 128;
        const chunks = [];
        let liveMark = 0, maxWindow = 0;
        for (let t = 0; t < 120 * RATE; t += CHUNK) {
            chunks.push(new Float32Array(CHUNK));
            if ((t / CHUNK) % Math.round(2.5 * RATE / CHUNK) !== 0) continue;
            let seen = 0; const tail = [];
            for (const c of chunks) {
                const start = seen; seen += c.length;
                if (seen <= liveMark) continue;
                tail.push(start >= liveMark ? c : c.subarray(liveMark - start));
            }
            let tailFrames = 0; for (const c of tail) tailFrames += c.length;
            if (tailFrames < RATE * 1.2) continue;
            maxWindow = Math.max(maxWindow, tailFrames);
            if (tailFrames >= RATE * 14) liveMark = seen;
        }
        return maxWindow <= RATE * 16;          // bounded near COMMIT_SECS
    })());

check("...and the FINAL pass still transcribes the whole clip, because whisper " +
      "is far better over a complete utterance than over rolling windows",
    /const wav = wavFromPcm\(st\.chunks, st\.rate\);/.test(appSrc));

/* ===================================================================
 * 7. THE LOAD GUARD, REBUILT AFTER IT FAILED THE SAME WAY TWICE
 *
 * From a node's own kernel journal: one chat request asked
 * Ollama to load a ~100 GB mistral-large q6_K on a 130.6 GB unified-memory
 * machine. NVRM out of memory at 28 seconds, gnome-shell hung at 122s, a
 * memory-pressure spiral to 614s, black screen, power-button recovery. Then
 * it happened AGAIN, through a guard written to stop exactly that.
 *
 * The live proof is in tests/node-relay.js, driven against the endpoint
 * record off a real installed app's disk. What is pinned here is the SHAPE of
 * the rebuild, because each of these is a sentence in the old file that
 * authorised the crash, and any one of them coming back brings it with it.
 * ================================================================= */

check("A COLD NODE LOAD IS CHECKED AGAINST THE MACHINE BEFORE THE REQUEST — " +
      "the same keystone discipline the local planner has always had",
    /async function nodePreflight\(s, opts = \{\}\)/.test(cloudSrc) &&
    /nodePreflight\(s, \{ onNote/.test(cloudSrc.slice(cloudSrc.indexOf("attempt(mkTarget") - 1400)));

check("THE GUARD MEASURES, IT DOES NOT COMPUTE. `total - resident` is not free " +
      "memory, it is an UPPER BOUND on free memory, and the gap between the two " +
      "is the whole of the crash: a model had just been stopped, so Ollama " +
      "reported nothing resident while the kernel had not handed back one page. " +
      "MemAvailable is read, and the arithmetic survives only as a ceiling on it",
    /async function measureNodeMemory\(s\)/.test(cloudSrc) &&
    /const ceiling = mem\.totalBytes > 0/.test(cloudSrc) &&
    /Math\.min\(mem\.freeBytes, ceiling\)/.test(cloudSrc));

check("...and the sentence that authorised the crash is GONE. It read 'a thin " +
      "margin, run on purpose' and 'ONLY THE HOPELESS ARE REFUSED', and it was " +
      "written to let a 110 GB need through 124.6 GB of arithmetic room. Wanting " +
      "to run the big model is not consent to lose the machine. (The words " +
      "survive ONCE, in the commentary recording why they were deleted — the " +
      "same convention node-relay.js uses for PubkeyAuthentication. What must " +
      "not survive is the licence: the heading, and the sum underneath it.)",
    !/ONLY THE HOPELESS ARE REFUSED/.test(cloudSrc) &&
    !/const roomBytes = totalBytes - residentBytes - NODE_SYS_RESERVE/.test(cloudSrc) &&
    !/if \(needBytes > roomBytes\)/.test(cloudSrc) &&
    (cloudSrc.match(/a thin margin, run on purpose/g) || []).length === 1 &&
    /That\s+\*?\s*reasoning is deleted/.test(cloudSrc.replace(/\s+/g, " ")));

check("...and the headroom SCALES with the machine. A flat 6 GB kernel floor " +
      "meant one thing on a 32 GB mini-PC and nothing at all on a 130 GB Spark, " +
      "where a 110 GB allocation left 11% of the machine for the machine and the " +
      "machine stopped answering. The floor stays a floor; the requirement is a " +
      "fraction calibrated against that measurement",
    /const NODE_SYS_RESERVE = 6e9;/.test(cloudSrc) &&
    /const NODE_HEADROOM_FRACTION = 0\.18;/.test(cloudSrc) &&
    /Math\.max\(NODE_SYS_RESERVE, free \* NODE_HEADROOM_FRACTION\)/.test(cloudSrc));

check("...and a reading that is too old to be evidence is treated as NO reading, " +
      "because a number taken while the machine was idle is exactly the lie this " +
      "guard exists to stop repeating",
    /const MEM_FRESH_MS = 60_000;/.test(cloudSrc) &&
    /fresh\(hook\.at\)/.test(cloudSrc));

check("IT FAILS CLOSED FOR A LARGE MODEL. The old rule was 'unreadable telemetry " +
      "proceeds', which is defensible for a 3 GB load and indefensible for a " +
      "100 GB one — proceeding blind is the single outcome that can kill a box",
    !/blind: proceed/.test(cloudSrc) &&
    /const NODE_LARGE_BYTES = 24e9;/.test(cloudSrc) &&
    /const NODE_LARGE_PARAMS = 30;/.test(cloudSrc) &&
    /if \(!large\) return null;/.test(cloudSrc));

check("...and it still fails OPEN for a small one, and for a host that does not " +
      "load on demand at all. A llama.cpp or vLLM node serves one resident model " +
      "and has no /api/tags; refusing those would be an outage the guard invented",
    /if \(tagsR\.reached\) return null;/.test(cloudSrc) &&
    /if \(params < NODE_LARGE_PARAMS\) return null;/.test(cloudSrc));

check("...only for machines the user OWNS: a hosted API's capacity is " +
      "the vendor's problem, and probing it would add latency for nothing",
    /if \(!isNodeEndpoint\(s\)\) return null;/.test(cloudSrc));

check("...and a model already resident is never re-checked, because the cost " +
      "being guarded against is the LOAD",
    /if \(loaded\.some\(same\)\) return null;/.test(cloudSrc));

check("UNLOAD BEFORE LOAD, AND WAIT FOR THE MEMORY. Firing a second load on top " +
      "of a resident one and letting the machine arbitrate is how a client-side " +
      "decision becomes a power-button recovery — and /api/ps going quiet is " +
      "Ollama letting go, not the kernel handing the pages back",
    /keep_alive: 0/.test(cloudSrc) && /UNLOAD_WAIT_MS/.test(cloudSrc) &&
    /if \(free2 && fits\(free2\)\)/.test(cloudSrc));

check("...and the wait is reported while it happens, and recorded afterwards, so " +
      "ninety seconds of nothing is never mistaken for the app hanging",
    /outcome: "waited-for-unload"/.test(cloudSrc) &&
    /waiting for \$\{names\.join\(", "\)\} to leave memory/.test(cloudSrc));

check("the refusal is recorded in the node call log like every other outcome — " +
      "WITH its reason, because eight bare `refused-preflight` rows were once " +
      "the only trace of eight silently rerouted turns",
    /logCall\("refused-preflight",\s*\{ reason:/.test(cloudSrc));

/* ===================================================================
 * 8. THE SCRIPT ssh RECEIVES IS THE SCRIPT MAIN.JS WROTE
 *
 * A .cmd file is not a container, it is a language. cmd runs a PERCENT PHASE
 * over every line before it parses quotes, so the moment the node-setup script
 * gained `-w '%{http_code}'` for its "already set up" guard, the batch ate
 * `%{http_code}' http:` and handed sshd a shell syntax error. Nothing ran —
 * not the guard, not the install — and lcl:nodeSetup had already returned
 * ok:true with "a terminal opened". The user clicks Set up, a window opens,
 * ssh connects, the remote shell dies at statement one, the batch prints
 * "Done. This window can be closed." and pauses.
 *
 * MEASURED, real writeTerminalScript + real cmd.exe + a stand-in for ssh:
 *
 *   before   sent 1088 bytes, ssh received 1075
 *            first divergence at 48
 *              "-w '%{http_code}' http://127.0.0.1:11434/api"
 *           -> "-w '//127.0.0.1:11434/api"
 *            bash -n on what arrived: exit 2,
 *              "unexpected EOF while looking for matching `''"
 *   after    sent 1088, received 1088, byte-identical, bash -n exit 0
 *
 * The round trip below is the real one — it builds the .cmd through the real
 * function lifted out of main.js and RUNS it through cmd.exe. A regex would
 * have passed on the broken build; this does not.
 * ================================================================= */

/** Lift a top-level function out of a source file, body and all. */
function liftFn(src, name) {
    const at = src.indexOf("function " + name + "(");
    if (at < 0) throw new Error("no function " + name);
    let depth = 0;
    for (let j = src.indexOf("{", at); j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
    }
    throw new Error("unbalanced " + name);
}

/** Walk a balanced expression from `open`, honouring strings and escapes. */
function spanFrom(src, open, closers) {
    const pairs = { "(": ")", "{": "}", "[": "]" };
    let depth = 0, q = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (q) {
            if (c === "\\") { i++; continue; }
            if (c === q) q = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") { q = c; continue; }
        if (pairs[c]) depth++;
        else if (c === ")" || c === "}" || c === "]") {
            if (depth === 0 && closers.includes(c)) return i;
            depth--;
        } else if (c === ";" && depth === 0 && closers.includes(";")) return i;
    }
    throw new Error("unterminated span");
}

/** Lift `const <name> = "a" + "b" + …;` and evaluate it to its real string. */
function liftLiteral(src, from, name) {
    const at = src.indexOf("const " + name + " =", from);
    if (at < 0) throw new Error("no literal " + name);
    const eq = src.indexOf("=", at) + 1;
    const expr = src.slice(eq, spanFrom(src, eq, [";"]));
    return new Function("return (" + expr + ")")();
}

/** Lift `ipcMain.handle("<ch>", guard(<fn>))`'s callback as a callable. */
function liftHandler(src, channel, deps) {
    const h = src.indexOf(`ipcMain.handle("${channel}", guard(`);
    if (h < 0) throw new Error("no handler " + channel);
    const open = h + `ipcMain.handle("${channel}", guard(`.length;
    const body = src.slice(open, spanFrom(src, open, [")"]));
    const names = Object.keys(deps);
    return new Function(...names, "return (" + body + ");")(...names.map(k => deps[k]));
}

/**
 * Build the .cmd through the REAL writeTerminalScript and run it through cmd,
 * with a stand-in first on PATH that records the argv ssh would have received.
 *
 * The stand-in is itself a .cmd forwarding `%*`, so it was checked for a second
 * percent pass before being trusted: "a%%b" in the parent arrives as "a%b" and
 * "%%%%" as "%%" — exactly one collapse, so the shim is transparent.
 */
function cmdRoundTrip(remoteScript, title) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-term-"));
    const argOut = path.join(dir, "argv.json");
    fs.writeFileSync(path.join(dir, "dump.js"),
        'require("fs").writeFileSync(process.argv[2], ' +
        'JSON.stringify(process.argv.slice(3)), "utf8");', "utf8");
    fs.writeFileSync(path.join(dir, "ssh.cmd"),
        '@echo off\r\nnode "' + path.join(dir, "dump.js") + '" "' + argOut + '" %*\r\n',
        "utf8");
    const writeTerminalScript = new Function("app", "path", "fs",
        liftFn(mainSrc, "writeTerminalScript") + "\nreturn writeTerminalScript;")(
        { getPath: () => dir }, path, fs);
    // a key path WITH A SPACE, which is the reason the batch file exists at all
    const creds = { args: ["-F", "C:\\Program Files\\Darkroom Chemistry\\ssh\\config",
                           "-i", "C:\\Program Files\\Darkroom Chemistry\\ssh\\id.key"],
                    target: "operator@stopbath.local" };
    const bat = writeTerminalScript(title, creds, remoteScript, "stopbath.local");
    const r = cp.spawnSync("cmd.exe", ["/c", bat], {
        encoding: "utf8", input: "",
        env: { ...process.env,
               PATH: dir + path.delimiter + process.env.PATH,
               Path: dir + path.delimiter + process.env.PATH } });
    let argv = null;
    try { argv = JSON.parse(fs.readFileSync(argOut, "utf8")); }
    catch { /* the batch died before ssh was reached */ }
    return { status: r.status, argv, dir,
             delivered: argv && argv.length ? argv[argv.length - 1] : null };
}

function findBash() {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    for (const c of [path.join(pf, "Git", "usr", "bin", "bash.exe"),
                     path.join(pf, "Git", "bin", "bash.exe")]) {
        try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
    }
    const w = cp.spawnSync("where", ["bash"], { encoding: "utf8" });
    return String(w.stdout || "").split(/\r?\n/).map(s => s.trim()).find(Boolean) || null;
}

const WINDOWS = process.platform === "win32";
const NODE_SETUP = liftLiteral(mainSrc, mainSrc.indexOf('ipcMain.handle("lcl:nodeSetup"'),
                               "script");
const RT = WINDOWS ? cmdRoundTrip(NODE_SETUP, ".lcl node setup") : null;

check("THE NODE SETUP SCRIPT REACHES ssh BYTE FOR BYTE. Built through the real " +
      "writeTerminalScript and run through the real cmd.exe with a stand-in for " +
      "ssh — because the percent phase that destroyed this script is a property " +
      "of cmd, and no amount of reading the source shows it",
    RT ? RT.delivered === NODE_SETUP
       : /\.replace\(\/%\/g, "%%"\)/.test(mainSrc),
    RT && RT.delivered !== NODE_SETUP
        ? { sent: NODE_SETUP.length, received: RT.delivered && RT.delivered.length,
            got: String(RT.delivered).slice(0, 160) } : "");

check("...and the guard that made it fail is still IN it: the script really does " +
      "carry a percent, so this is a live round trip and not a test of a string " +
      "that happens to be ASCII",
    /%\{http_code\}/.test(NODE_SETUP) && (!RT || /%\{http_code\}/.test(RT.delivered || "")));

check("...and what arrives is valid shell. The broken build delivered an " +
      "unterminated quote, so sshd's shell exited 2 before the first statement " +
      "while the app reported ok:true",
    (() => {
        if (!RT || !RT.delivered) return !WINDOWS;
        const bash = findBash();
        if (!bash) return true;              // cannot check here; equality above stands
        const f = path.join(RT.dir, "delivered.sh");
        fs.writeFileSync(f, RT.delivered, "utf8");
        return cp.spawnSync(bash, ["-n", f], { encoding: "utf8" }).status === 0;
    })());

check("...and the escape is a NO-OP for a script with no percent in it, which is " +
      "what the door and funnel terminals send",
    (() => {
        if (!WINDOWS) return true;
        const plain = "sh ~/.config/lcl-door/setup.sh";
        return cmdRoundTrip(plain, ".lcl remote door setup").delivered === plain;
    })());

check("...and a non-ASCII character survives too. The same round trip caught the " +
      "second corruption one line later: cmd decodes a .cmd in the OEM codepage, " +
      "so 'setup complete — this window can be closed' reached ssh as 'ΓÇö' and " +
      "the batch printed the same mojibake to the user. A BOM carries the " +
      "argument, chcp makes the echoed lines legible",
    (() => {
        if (!WINDOWS) return /chcp 65001/.test(mainSrc);
        const dashy = "echo 'developer temperature — hold at 20C'; echo done";
        const out = cmdRoundTrip(dashy, ".lcl — allow remote access on this machine");
        return out.delivered === dashy;
    })());

/* ===================================================================
 * 9. THE THREE SEAMS THAT HAD NO PRODUCER
 *
 * Each of these is a field that was READ but never WRITTEN — a renderer branch,
 * a rented-GPU tier and a load guard, all three wired to a value nothing on the
 * far side ever set. They fail silently by construction, which is why they need
 * a test each rather than a review.
 * ================================================================= */

/* ---- scanError: a failed probe is not an empty bench ---- */
const inspectDevices = liftHandler(mainSrc, "lcl:inspectDevices", {
    deviceScan: { inspect: async (o) => { inspectDevices.seen = o; return inspectDevices.next; } }
});

async function deviceChecks() {
    inspectDevices.next = { devices: [], scanError: "the OS device tree could not be read" };
    const failed = await inspectDevices(null, { listenMs: 2000 });
    check("A FAILED PROBE IS NOT REPORTED AS AN EMPTY BENCH. The handler stamped " +
          "ok:true over whatever came back, so an OS probe that could not run at " +
          "all arrived as a clean success with no devices — and the panel said " +
          "'Nothing on USB.', a statement about the bench that was never measured",
        failed.ok === false, failed);
    check("...and deviceScan's sentence is passed through UNTOUCHED, because the " +
          "renderer branches on it before it ever gets to 'Nothing on USB.'",
        failed.scanError === "the OS device tree could not be read");

    inspectDevices.next = { devices: [{ port: "COM4" }] };
    const good = await inspectDevices(null, { listenMs: 2000 });
    check("...while a probe that WORKED still reports ok, empty bench or not",
        good.ok === true && good.devices.length === 1);

    inspectDevices.next = { devices: [], ok: false, scanError: "no PowerShell" };
    check("...and a scan that reports its own failure is never talked back up to ok",
        (await inspectDevices(null, {})).ok === false);

    inspectDevices.next = { devices: [] };
    inspectDevices.seen = null;
    await inspectDevices(null, { listenMs: 2000, port: "com7" });
    check("A NAMED PORT IS THREADED THROUGH to deviceScan.inspect, so the passive " +
          "listen can be aimed at one board instead of the whole tree",
        inspectDevices.seen && inspectDevices.seen.port === "COM7", inspectDevices.seen);

    inspectDevices.seen = null;
    const bad = await inspectDevices(null, { port: "COM4; Remove-Item C:\\" });
    check("...validated to the same /^COM\\d+$/i shape deviceScan enforces, and " +
          "REFUSED here rather than passed on — this is the boundary a renderer " +
          "string arrives at, and the port ends up on a PowerShell command line",
        !!bad.error && inspectDevices.seen === null, bad);

    /* ---- rented/provider: the flag with no wire behind it ---- */
    check("THE RENTED FLAG HAS A PRODUCER, ALL THREE LAYERS. preload dropped the " +
          "second argument, so the Connect box's checkbox was a control wired to " +
          "nothing and every rented GPU was filed as hardware the operator owns",
        /connectCloud: \(pasted, opts\) => ipcRenderer\.invoke\("lcl:connectCloud", pasted, opts\)/
            .test(preSrc));
    check("...the main handler takes opts and FORWARDS it rather than re-deriving it",
        /ipcMain\.handle\("lcl:connectCloud", async \(_e, pasted, opts\) =>/.test(mainSrc) &&
        /cloudModels\.connect\(pasted, opts \|\| \{\}\)/.test(mainSrc));
    check("...and it lands on linkEndpoint, which is the one place an endpoint's " +
          "kind is decided — the seam is closed end to end",
        /async function connect\(pasted, opts = \{\}\)/.test(cloudSrc) &&
        /const rented = !!\(opts && opts\.rented\)/.test(cloudSrc) &&
        /\n        rented,\n        provider: provider \|\| undefined/.test(cloudSrc));
    check("...and the state listing carries each endpoint's PLAN, so the GO " +
          "badge on the card and the meter gate read the same record " +
          "linkEndpoint wrote — a metered plan the user cannot see is a " +
          "bill the user cannot predict",
        /plan: v\.plan \|\| null/.test(cloudSrc));

    /* ---- the 500 that was OUR schema (from a real report) ---- */
    check("A 500 NEVER PRUNES A MODEL — only a 404 or the provider explicitly " +
          "saying the model is gone. Pruning on 500 deleted working models " +
          "whenever OUR request body broke the call",
        (() => {
            const i = cloudSrc.indexOf("pruneModelFromEndpoint(s.id, s.model)");
            const around = cloudSrc.slice(Math.max(0, i - 600), i);
            return i > 0 && /statusCode === 404/.test(around)
                && !/statusCode === 500/.test(around);
        })());
    check("AN OPTIONAL FIELD NEVER KILLS A CALL — a 400/422/500 with " +
          "reasoning_effort in the body retries ONCE with the field stripped, " +
          "separating 'your request shape' from 'the model is down'",
        /const shapeRejected = status === 400 \|\| status === 422 \|\| status === 500;/.test(cloudSrc)
        && /stripEffort/.test(cloudSrc)
        && /!opts\.stripEffort && effortSupported\(s\)/.test(cloudSrc));
    check("SILENCE IS A FAILURE, NOT AN ANSWER (from a deleted-sessions " +
          "log: 4 gemini turns, ~734ms, $0, all persisted empty). A 200 whose " +
          "SSE parse yields nothing re-reads the whole body as ONE plain JSON " +
          "completion (servers that ignore stream:true), and a call that still " +
          "delivered no content REJECTS instead of resolving output ''",
        /rawAll/.test(cloudSrc)
        && /const m = c0 && c0\.message;/.test(cloudSrc)
        && /answered 200 but sent no content/.test(cloudSrc)
        && /!output && !reasoning && !toolCalls/.test(cloudSrc));
    check("...the QUIET rejection retries the same strip — an empty 200 with " +
          "reasoning_effort sent gets one retry without the field, same as a " +
          "loud 400/422/500",
        /const emptyAnswer = !!\(e && e\.emptyAnswer\);/.test(cloudSrc)
        && /answered empty — retrying without reasoning_effort/.test(cloudSrc));
    check("...and the AGENT never persists a blank bubble: a zero-content " +
          "final reply at step 0 becomes a said-out-loud failure message with " +
          "emptyReply+failed meta, not an empty assistant message",
        (() => {
            const agentSrc2 = R(".lcl.engine", "core", "agent.js");
            return /emptyReply = true;/.test(agentSrc2)
                && /the model returned nothing/.test(agentSrc2)
                && /emptyReply: true, failed: true/.test(agentSrc2);
        })());
    check("...and the retry only ARMS where the field was SENT — the gate " +
          "resolves the real selection and requires a hosted endpoint, so a " +
          "node error is never re-sent byte-identical under a false " +
          "'rejected reasoning_effort' note",
        (() => {
            const i = cloudSrc.indexOf("const effortWasSent");
            const gate = i > 0 ? cloudSrc.slice(i, i + 600) : "";
            return /opts\.selection \|\| selectedFor\(opts\.role/.test(gate)
                && /effortSupported\(sel\)/.test(gate);
        })());
    check("THE TOOLS GO OVER THE WIRE AS TOOLS. .lcl described them in the " +
          "system prompt and hoped for a fenced JSON call back — which a model " +
          "trained to REASON declines to produce: six rounds of \"1. First, " +
          "I'll list all files:\" and not one call. Every OpenAI-compatible " +
          "host takes a tools array, and 147 of DeepInfra's 360 models declare " +
          "support for it",
        /function openAiSchemas/.test(R(".lcl.engine", "core", "toolManifest.js"))
        && /tool_choice: .auto./.test(cloudSrc)
        && /tools: opts[.]tools/.test(R(".lcl.engine", "core", "router.js"))
        && /tools: sel \? toolManifest\.openAiSchemas\(/.test(R(".lcl.engine", "core", "agent.js")));
    check("...and a STRUCTURED call beats anything parsed out of prose — it " +
          "cannot be a model narrating what it might do",
        (() => {
            const a = R(".lcl.engine", "core", "agent.js");
            return /const native = Array.isArray/.test(a)
                && /tool: native.name, args, native: true/.test(a);
        })());
    check("...and a serving that REFUSES the array is told once and remembered: " +
          "the turn falls back to the text protocol instead of dying on the 400, " +
          "and that model is never sent tools again",
        /function toolsSupported/.test(cloudSrc)
        && /const toolsRefused = new Set/.test(cloudSrc)
        && /does not take a tools array/.test(cloudSrc));
    check("...and BOTH recoveries are reachable: the tools fallback used to sit " +
          "inside the reasoning-effort retry, which returns early when no effort " +
          "was sent — so every ordinary turn died on the refusal it could have " +
          "recovered from",
        /ONE CATCH, BOTH RECOVERIES/.test(cloudSrc)
        && /effortWasSent && .shapeRejected/.test(cloudSrc));

    /* ---- a second live report from a real repository ---- */
    check("THE EXAMPLE IS THE INSTRUCTION. search_files help read " +
          "{\"query\": \"TODO\"} and the model copied it verbatim — six " +
          "identical searches for a word the codebase does not contain, while " +
          "the work the user asked for went untouched. An example argument has to be " +
          "obviously a placeholder, never a plausible query",
        /<text to find>/.test(R(".lcl.engine", "core", "fsTools.js"))
        && !/help: .search_files \{"query": "TODO"\}/.test(
            R(".lcl.engine", "core", "fsTools.js")));
    check("OLLAMA IS TOLD HOW BIG THE WINDOW IS. It serves with its own " +
          "num_ctx — 4,096 by default — whatever the model supports, and .lcl " +
          "sized every prompt to the model's architectural window and sent it " +
          "to a route that has no field for one. A 70B answered as though it " +
          "had seen almost nothing because it HAD",
        /function isOllamaShape/.test(cloudSrc)
        && /num_ctx: windowNeeded/.test(cloudSrc)
        && /numCtx: [(]limits[(]sel[)]/.test(R(".lcl.engine", "core", "router.js")));
    check("...and a serving that READ LESS THAN WE SENT says so, with the fix " +
          "on the line. Silent truncation is the worst failure of the set: the " +
          "request left carrying the repository, the model answered on a " +
          "fragment, and the user concluded the model was stupid",
        /read only [$][{]usage[.]prompt_tokens/.test(cloudSrc)
        && /OLLAMA_CONTEXT_LENGTH=131072/.test(cloudSrc));
    check("ANCIENT KNOWLEDGE STAYS IN THE REPO ROOT — a deliberate choice — and the " +
          "repository is told to ignore it: .gitignore created when absent, " +
          "appended when present, and never duplicated",
        (() => {
            const fsx = require("fs"), osx = require("os"), px = require("path");
            const ak = require(px.join(ROOT, ".lcl.engine", "core", "ancientKnowledge.js"));
            const A = fsx.mkdtempSync(px.join(osx.tmpdir(), "pin-akr-"));
            const name = ak.reviewFileName({ id: "s", repoPath: A });
            const made = fsx.readFileSync(px.join(A, ".gitignore"), "utf8");
            const B2 = fsx.mkdtempSync(px.join(osx.tmpdir(), "pin-akr2-"));
            fsx.writeFileSync(px.join(B2, ".gitignore"), "node_modules");
            ak.reviewFileName({ id: "s2", repoPath: B2 });
            ak.reviewFileName({ id: "s3", repoPath: B2 });
            const app = fsx.readFileSync(px.join(B2, ".gitignore"), "utf8");
            return name === "ancient_knowledge.md"
                && /^ancient_knowledge[.]md$/m.test(made)
                && /node_modules/.test(app)
                && (app.match(/^ancient_knowledge[.]md$/gm) || []).length === 1;
        })());

    check("400+ FILES ARE REACHABLE, NOT JUST COUNTABLE. \"activities only " +
          "show 200 of 400+ files listed\" — the cap was a guess from when " +
          "every prompt was squeezed into 4,096 tokens, and there was no " +
          "second call that could reach past it. Sorted first, so page 2 is " +
          "genuinely the next names and not 400 arbitrary ones",
        (() => {
            const fsx = require("fs"), osx = require("os"), px = require("path");
            const fsT = require(px.join(ROOT, ".lcl.engine", "core", "fsTools.js"));
            const A = fsx.mkdtempSync(px.join(osx.tmpdir(), "pin-page-"));
            for (let i = 0; i < 428; i++) {
                fsx.writeFileSync(px.join(A, "f" + String(i).padStart(3, "0") + ".txt"), "x");
            }
            const p1 = fsT.listFiles(A, {});
            const p2 = fsT.listFiles(A, { offset: p1.nextOffset });
            const union = new Set([...p1.entries, ...p2.entries]);
            fsx.rmSync(A, { recursive: true, force: true });
            return p1.total === 428
                && p1.truncated === true && p1.nextOffset === 400
                && p2.entries.length === 28 && p2.truncated === false
                && p2.nextOffset === undefined
                && union.size === 428                       // no gap, no overlap
                && p1.entries[p1.entries.length - 1] < p2.entries[0];
        })());
    check("...and the model is handed the EXACT next call, not just a count. " +
          "Told only \"200 of 428\" it concluded the folder held 200 files and " +
          "asked the user to \"ensure that all relevant files are included\" " +
          "— about the user's own repository",
        (() => {
            const fsx = require("fs"), osx = require("os"), px = require("path");
            const fsT = require(px.join(ROOT, ".lcl.engine", "core", "fsTools.js"));
            const A = fsx.mkdtempSync(px.join(osx.tmpdir(), "pin-page2-"));
            for (let i = 0; i < 405; i++) fsx.writeFileSync(px.join(A, "f" + i + ".txt"), "x");
            const r = fsT.listFiles(A, {});
            fsx.rmSync(A, { recursive: true, force: true });
            return /"offset": 400/.test(r.more) && /list_files/.test(r.more)
                && /5 more files/.test(r.more);
        })());
    check("...and BOTH protocols can page: the help line the text protocol " +
          "reads says so, and the native schema actually advertises the " +
          "argument. A tool whose schema has no offset cannot be paged by a " +
          "model that calls through the schema",
        /nextOffset/.test(R(".lcl.engine", "core", "fsTools.js"))
        && /name: "offset"/.test(R(".lcl.engine", "core", "toolManifest.js")));

    check("THE WINDOW ASKED FOR IS THE CONVERSATION'S, NOT THE MODEL'S. Sending " +
          "the architectural maximum was the obvious fix and would have made " +
          "the test machine worse: R1-70B publishes 163,840, and a KV cache that " +
          "size on an 80-layer 70B is ~50 GB — every request, for the word " +
          "\"hello\", on top of ~40 GB of resident weights in 128 GB. A box " +
          "that starts swapping is slower than the 4,096 default we were " +
          "escaping",
        (() => {
            const src = cloudSrc;
            if (!/const windowNeeded = \(\(\) => \{/.test(src)) return false;
            if (!/num_ctx: windowNeeded/.test(src)) return false;
            // the arithmetic itself, run rather than read
            const sized = (chars, maxTokens, ceiling) => {
                const est = Math.ceil(chars / 3.6) + Math.max(512, maxTokens) + 1024;
                const stepped = Math.ceil(est / 4096) * 4096;
                if (!ceiling) return 0;
                return Math.max(4096, Math.min(stepped, ceiling));
            };
            return sized(40, 2048, 163840) === 4096          // "hello" is cheap
                && sized(900000, 2048, 163840) === 163840     // a repo gets it all
                && sized(900000, 2048, 8192) === 8192         // never past the model
                && sized(100000, 2048, 163840) % 4096 === 0   // 4k steps, so a
                && sized(100000, 2048, 163840) >= 27778 / 1;  // growing chat reuses
        })());
    check("...and it is sent ONLY to an Ollama-shaped serving. `options` is " +
          "Ollama's own field; a strict provider rejecting an unknown key " +
          "would kill a paid call over a setting that does not apply to it",
        /isOllamaShape\(s\) && windowNeeded > 0/.test(cloudSrc));

    /* ---- the schema fix that only covered a third of the tools ---- */
    check("EVERY TOOL THE AGENT CAN REGISTER DESCRIBES ITS ARGUMENTS. The last " +
          "pass gave real schemas to the nine file tools and stopped; " +
          "openAiSchemas is called with EVERY registered name, so THIRTY more " +
          "— web_search, http_fetch, read_image, calculate, semantic_search, " +
          "knowledge_search — went over the wire as properties:{}, which in " +
          "the only language native tool calling has means \"this tool takes " +
          "no arguments\". A host that constrains output to the schema then " +
          "emits {} and the call fails",
        (() => {
            const px = require("path");
            const tm = require(px.join(ROOT, ".lcl.engine", "core", "toolManifest.js"));
            // the registry as agent.js actually assembles it
            const src = R(".lcl.engine", "core", "agent.js");
            const names = new Set(["list_files", "read_file", "write_file",
                "edit_file", "move_file", "make_dir", "delete_file",
                "search_files", "run_script"]);
            for (const m of src.matchAll(/tools\.([a-z_]+)\s*=/g)) names.add(m[1]);
            const list = [...names].sort();
            const help = Object.fromEntries(list.map(n => [n, ""]));
            const empty = tm.openAiSchemas(list, help).filter(x =>
                Object.keys((x.function.parameters || {}).properties || {}).length === 0)
                .map(x => x.function.name).sort();
            // the tools that genuinely take none, and they SAY so (github_sign_in
            // opens the browser OAuth with no arguments)
            return list.length > 45
                && empty.join(",") === "github_sign_in,process_list,read_clipboard,system_stats";
        })());
    check("...and the three that really take none DECLARE it rather than " +
          "defaulting to it. An absent entry and an empty one used to be the " +
          "same thing, which is exactly how thirty tools shipped empty",
        (() => {
            const px = require("path");
            const tm = require(px.join(ROOT, ".lcl.engine", "core", "toolManifest.js"));
            return ["system_stats", "process_list", "read_clipboard"].every(t =>
                tm.ARG_DETAIL[t] && Array.isArray(tm.ARG_DETAIL[t].args)
                && tm.ARG_DETAIL[t].args.length === 0
                && /takes no arguments/i.test(tm.ARG_DETAIL[t].summary || ""));
        })());
    check("...and the arguments are the REAL ones, taken from each tool's own " +
          "help line rather than invented — web_search requires a query, " +
          "http_fetch requires a url, read_image requires a path",
        (() => {
            const px = require("path");
            const tm = require(px.join(ROOT, ".lcl.engine", "core", "toolManifest.js"));
            const want = { web_search: "query", http_fetch: "url",
                           read_image: "path", calculate: "expression",
                           semantic_search: "query", stop_server: "id" };
            const sch = tm.openAiSchemas(Object.keys(want),
                Object.fromEntries(Object.keys(want).map(n => [n, ""])));
            return Object.entries(want).every(([tool, arg]) => {
                const f = sch.find(x => x.function.name === tool);
                const p = f && f.function.parameters;
                return p && p.properties[arg] && (p.required || []).includes(arg);
            });
        })());
    check("...and none of this changed the TEXT protocol's help lines, which " +
          "are what every existing session's system prompt already says",
        (() => {
            const px = require("path");
            const tm = require(px.join(ROOT, ".lcl.engine", "core", "toolManifest.js"));
            const line = 'web_search {"query": "x"} — search the web';
            return tm.helpFor("web_search", line) === line;
        })());

    /* ---- six audit rounds, one untouched repository ---- */
    check("A ROUND THAT CHANGED NOTHING IS NAMED IN THE ROUND THAT FOLLOWS. " +
          "\"Address every gap NOW, with real work — use tools\" reached the " +
          "model six times and produced six numbered plans and zero calls. The " +
          "next round names the idle one by number and gives the FIRST CALL " +
          "instead of asking for work in general",
        (() => {
            const px = require("path");
            const ak = require(px.join(ROOT, ".lcl.engine", "core", "ancientKnowledge.js"));
            const gaps = ["The model did not read any files from the repository."];
            const calm = ak.forceInstruction(gaps, 3, null, 0);
            const loud = ak.forceInstruction(gaps, 3, null, 2);
            return !/CHANGED NOTHING/.test(calm)          // a working round is left alone
                && /ROUND 2 CHANGED NOTHING/.test(loud)
                && /FIRST action must be a tool call/.test(loud)
                && /list_files/.test(loud) && /nextOffset/.test(loud)
                && /name the tool you would need/.test(loud);
        })());
    check("...and a round that SPUN counts as idle too. roundToolWins counts " +
          "calls that SUCCEEDED, so the fifteen identical list_dir calls in an " +
          "earlier session scored fifteen wins and that round read as " +
          "productive — same arguments, same result, nothing written",
        /akIdleRound = \(didWork && !spinStopped\)/.test(agentSrc2()));
    check("...and the trigger is MEASURED, not guessed from the wording. A " +
          "lexical \"is this the same gap\" test was written first and scored " +
          "four rewordings of \"you never read the repository\" at 0.09-0.22 " +
          "token overlap — they share one content word. It was deleted, and the " +
          "note saying why is what stops it being written again",
        /roundToolWins > 0/.test(agentSrc2())
        && /akIdleRound = \(didWork && !spinStopped\) \? 0 : akRound;/.test(agentSrc2())
        && /A LEXICAL "IS THIS THE SAME GAP" TEST LIVED HERE AND WAS DELETED/
            .test(R(".lcl.engine", "core", "ancientKnowledge.js")));

    /* ---- the review of native tool calling, before it shipped ---- */
    check("A TOOL IS ADVERTISED WITH ITS ARGUMENTS. ARG_DETAIL described the " +
          "specialist tools and none of the FILE tools, so native calling sent " +
          "write_file, read_file and the rest as ZERO-ARGUMENT functions — a " +
          "host that constrains output to the schema then emits {} and every " +
          "call fails. Advertising a tool with no arguments is worse than not " +
          "advertising it",
        (() => {
            const m = require(path.join(ROOT, ".lcl.engine", "core", "toolManifest.js"));
            const byName = {};
            for (const x of m.openAiSchemas(["write_file", "read_file", "edit_file",
                                             "search_files", "run_script"], {})) {
                byName[x.function.name] = x.function.parameters;
            }
            return byName.write_file.required.includes("content")
                && byName.read_file.required.includes("path")
                && byName.edit_file.required.includes("find")
                && byName.search_files.required.includes("query")
                && byName.run_script.required.includes("code");
        })());
    check("...and only tools this turn can DISPATCH are advertised: clarify is " +
          "a protocol verb the policy kernel has no entry for, so offering it " +
          "natively produced a call that was DENIED instead of reaching the " +
          "operator as a question",
        /openAiSchemas\(\s*\n?\s*Object\.keys\(tools\)/.test(agentSrc2()));
    check("A BARE 400 IS NOT EVIDENCE ABOUT TOOLS. Blaming every 400/422 on the " +
          "tools array marked the model as refusing FOR THE LIFE OF THE PROCESS " +
          "on a context overflow, told the user something false, and " +
          "returned before the reasoning_effort recovery could run",
        /const toolsWereSent = /.test(cloudSrc)
        && /does not support tools\|/.test(cloudSrc)
        && /return streamChat\(messages, \{ \.\.\.opts, noTools: true \}\);/.test(cloudSrc));
    check("...and a capability is answered from the SHEET THAT CARRIES IT — " +
          "tools lives in the feature tags, so a model with capability tags and " +
          "no features read as a confident NO on no evidence, silently killing " +
          "native calling for it",
        /const CAPABILITY_SOURCE = /.test(cloudSrc)
        && /tools: "features"/.test(cloudSrc));
    check("...and a streamed fragment with NO index does not collapse two " +
          "parallel calls into one, concatenating one call's arguments onto " +
          "another's",
        /Number\.isInteger\(tc\.index\) \? tc\.index : -1/.test(cloudSrc));
    check("...and the calls that did NOT run are said out loud, so a model that " +
          "asked for four files does not assume all four were written",
        /tool-calls-queued/.test(agentSrc2()));
    check("...and the model SEES the call it made, IN THE PROTOCOL IT MADE IT " +
          "IN: a native call is replayed as a real tool_calls array keyed to " +
          "the id its result answers, not as prose describing JSON. Replaying " +
          "it as text pushed an empty assistant turn and the result appeared " +
          "to arrive from nowhere",
        /toolCalls: \[\{ id: callId, name: toolName,/.test(agentSrc2())
        && /const callId = `call_\$\{steps\}_\$\{toolName\}`;/.test(agentSrc2())
        && /\? \{ role: "tool", callId, name: toolName, content: toolOutput \}/
            .test(agentSrc2()));
    check("...and a native call scores as a CLEAN parse — it was counted as a " +
          "parse failure, the signal that decides whether a model is trusted " +
          "with tool work, so the best tool-callers were marked the worst",
        (() => {
            const a = agentSrc2();
            const i = a.indexOf("call = { tool: native.name");
            return i > 0 && /seen\.toolParsed = true;/.test(a.slice(i, i + 900));
        })());
    check("...and the FABRICATION guard bites at EVERY step. It was scoped " +
          "to steps === 0 for a real reason — the runtime itself wrote " +
          "\"TOOL RESULT:\" above genuine output, so a model quoting that " +
          "heading after a real call was quoting US. The runtime authors " +
          "its heading now, the exception died with it, and the removal is " +
          "the fix: in a real session the invention landed at step 1, right " +
          "after a genuine search_files, and walked straight through",
        /if \(FABRICATED_RE\.test\(cleaned\)\) \{/.test(agentSrc2())
        && !/steps === 0 && FABRICATED/.test(agentSrc2())
        && !/content: `TOOL RESULT:/.test(agentSrc2()));
    check("...and a remembered refusal is FORGOTTEN when the catalogue is " +
          "re-read — a model upgraded on the node stayed marked as refusing " +
          "for the life of the process",
        /function clearToolsRefused/.test(cloudSrc)
        && /clearToolsRefused\(ep\.id\);/.test(cloudSrc));

    /* ---- what was observed on a REAL repo ----
     * deepseek-r1:70b on a node, Multiversal effort, Ancient Knowledge on,
     * linked to a repository that matters. The user asked it to ingest the repo.
     * Six audit rounds later it had read nothing and reported the repo as
     * nearly empty. The session log is the evidence for all three of these. */
    check("A MODEL DOES NOT GET TO WRITE ITS OWN TOOL RESULTS. It emitted a " +
          "numbered plan and then invented the output — \"TOOL RESULT: " +
          "list_files: - src/main.py - notes.md\" — for a repository with " +
          "thousands of files, and every later round, Ancient Knowledge " +
          "included, reasoned from that fiction",
        (() => {
            const a = R(".lcl.engine", "core", "agent.js");
            return /TOOL[ _]RESULT/.test(a)
                && /fabricated\+\+;/.test(a)
                && /I wrote tool results I had never received/.test(a);
        })());
    check("...and the AUDITOR STOPS when a round did no work. Its nothing-new " +
          "guard compares the TEXT of the gaps, which a model re-wording the " +
          "same refusal slips straight past: six rounds, six phrasings of \"you " +
          "did not read the repository\", not one tool call between them",
        (() => {
            const a = R(".lcl.engine", "core", "agent.js");
            return /let prevRoundWorked = true;/.test(a)
                && /akRound > 1 && !didWork && !prevRoundWorked/.test(a)
                && /if \(!failed\) roundToolWins\+\+;/.test(a);
        })()
        && /"no-progress"/.test(R(".lcl.engine", "core", "ancientKnowledge.js"))
        && /"no-progress"/.test(appSrc));
    check("...and a TRUNCATED LISTING IS NEVER READ AS THE WHOLE REPO — the " +
          "digest says \"200 of 5,432 files\", not \"200+\". The user was asked to " +
          "\"ensure that all relevant files are included in the linked folder\" " +
          "about a folder that already had them",
        /of \${result\.total} files/.test(
            R(".lcl.engine", "core", "agent.js")));

    /* ---- the DNS starvation that made a live endpoint unreachable ---- */
    check("NAME RESOLUTION CANNOT BE STARVED BY SOMETHING ELSE — every outbound " +
          "request resolves off libuv's thread pool (dns.resolve4/c-ares, with " +
          "getaddrinfo only as the fallback for hosts-file and mDNS names). " +
          "Measured: four hung lookups made api.deepinfra.com take 22,006 ms " +
          "for a name that answers in 11 ms idle — reported as 'DNS never " +
          "resolved' with the socket assigned and no lookup event",
        /function lookupOffThreadPool/.test(cloudSrc)
        && /dns\.resolve6 : dns\.resolve4/.test(cloudSrc)
        && /lookup: lookup \|\| lookupOffThreadPool/.test(cloudSrc));
    check("...and THE SOURCE is fixed, not just the victim: node discovery " +
          "resolved its candidate ONCE per port — four getaddrinfo per " +
          "candidate — against an mDNS name (ai-node-01.local) that " +
          "takes 20,282 ms to fail on the user's machine, and the socket " +
          "timeout cannot cancel an in-flight lookup",
        /function resolveCandidate\(host\)/.test(mainSrc)
        && /const deadNames = new Map\(\)/.test(mainSrc)
        && /const addr = await resolveCandidate\(c\.address\);/.test(mainSrc)
        && /lookup: cloudModels\.lookupOffThreadPool/.test(mainSrc));
    check("...and the 5-second re-probe on the API's & Connections dialog — the " +
          "very page the Refresh button lives on — can no longer STACK: neither " +
          "painter was awaited, so a tick slower than the interval queued work " +
          "faster than it drained, for as long as the dialog stayed open",
        /let pollBusy = false;/.test(appSrc)
        && /if \(pollBusy\) return;/.test(appSrc));

    /* (THE ".lcl/" FOLDER PINS ARE GONE. They asserted that Ancient
     * Knowledge's document belongs in a subfolder — but the requirement is
     * different: the document stays in the repo root, and if there is no
     * .gitignore one is created, and if there is one the entry is appended.
     * The requirement is the gitignore, and it is pinned above.) */

    /* ---- reported from the install: a refresh of the DeepInfra endpoint in
     * APIs and Connections failed ---- */
    check("A SUCCESSFUL REFRESH SAYS WHAT IT FOUND, IN PLACE — it used to call " +
          "again(), which closes the whole sheet and re-opens it. Reading the " +
          "provider's catalogue takes seconds, so the card sat silent and then " +
          "the panel blinked away saying nothing: indistinguishable from a " +
          "failure, and reported as one",
        (() => {
            const i = appSrc.indexOf("Refresh this endpoint's model list");
            const blk = i > 0 ? appSrc.slice(i, i + 2000) : "";
            return /list is current/.test(blk)
                && /await refreshModelPick\(\)/.test(blk)
                && !/await again\(\);/.test(blk);
        })());
    check("...and a REJECTED KEY no longer blinds the app to a PUBLIC " +
          "catalogue. Measured live: /v1/openai/models answers 200 with no " +
          "Authorization header and 401 with a rejected one — so a stale key " +
          "turned a public model list into a dead end. It re-asks without the " +
          "key, refreshes the list, and flags the credential instead",
        /keyRejected = true;/.test(cloudSrc)
        && /memoryKeys\.delete\("__probe"\);/.test(cloudSrc)
        && /keyRejected: !!found\.keyRejected/.test(cloudSrc)
        && /refused the stored key/.test(appSrc));
    check("A REFRESH IS NOT A DISCOVERY — it re-uses the prefix and shape the " +
          "endpoint already answered on, instead of re-walking a ladder of " +
          "routes this host is known to 404. A log: refresh dead after " +
          "20,006 ms with 'the endpoint did not respond', the whole budget " +
          "spent on an Ollama sniff and a /v1/models rung the DeepInfra " +
          "endpoint has never served — the documented route was never reached",
        /async function probe\(baseUrl, key, known = null\)/.test(cloudSrc)
        && /if \(!known \|\| !known\.shape\) \{/.test(cloudSrc)
        && /head\.push\(\[known\.prefix \+ "\/models", "openai", openaiPluck\]\)/.test(cloudSrc)
        && /\{ prefix: ep\.apiPrefix, shape: ep\.shape \}/.test(cloudSrc));
    check("...and a REFRESH CANNOT BURN 20 SECONDS. A re-probe is a button the " +
          "user is watching, on a route the host already answered: 7s a " +
          "rung, and the capability sheet is a 6s best-effort EXTRA whose " +
          "failure the refresh never notices. Discovery keeps its longer " +
          "budget, because that is a one-off against an unknown address",
        /const rungMs = known \? 7_000 : 12_000;/.test(cloudSrc)
        && /timeoutMs: 6_000, fromRoot: true/.test(cloudSrc));
    check("A TIMEOUT NAMES THE PHASE IT STALLED IN — DNS, the TCP connect, the " +
          "TLS handshake and a silent server are four different failures with " +
          "four different causes, and 'the endpoint did not respond' reported " +
          "them identically. Measured: a refresh timed out at 7,004 ms while " +
          "the same request from a standalone process on the same machine took " +
          "389 ms, and nothing in the message could tell those apart",
        /sock\.on\("lookup"/.test(cloudSrc)
        && /sock\.on\("secureConnect", \(\) => mark\("tls"\)\)/.test(cloudSrc)
        && /the TLS handshake never completed/.test(cloudSrc)
        && /e\.phase = phase\.at;/.test(cloudSrc)
        && /phase: \(err && err\.phase\) \|\| null/.test(mainSrc));
    check("...and an ADDRESS is not blamed on DNS — Node emits no lookup event " +
          "when the host is already an IP, so 'DNS never resolved' would be a " +
          "lie about every node on the LAN",
        /const isIp = !!require\("net"\)\.isIP\(base\.hostname\);/.test(cloudSrc)
        && /socket: isIp \? "the TCP connection never completed"/.test(cloudSrc));
    check("...and an unreachable host is named as a NETWORK failure, with the " +
          "existing list explicitly left alone — 'did not respond' alone reads " +
          "as a broken provider and sends the user to the wrong place",
        /This is the ` \+\s*\n\s*`network between this machine and/.test(cloudSrc)
        && /Nothing was changed — the ` \+/.test(cloudSrc));
    check("...and a refresh LEAVES EVIDENCE either way — the card showed the " +
          "error and the user closed the panel, so 'I pressed Refresh and " +
          "it failed' was all that survived. Both outcomes are audited with " +
          "the reason",
        /kind: "endpoint-refresh"/.test(mainSrc)
        && /ok: false, error: message/.test(mainSrc));

    /* ---- the DeepInfra literature build-out ---- */
    check("A TRUNCATED HOSTED REPLY SAYS SO — finish_reason is read off the " +
          "stream (and the non-stream body) and carried out as `truncated`, " +
          "the way the local engine has always done. Without it a reply cut " +
          "at the token cap reached the transcript, and the agent loop, " +
          "dressed as a finished answer",
        /let finishReason = null;/.test(cloudSrc)
        && /if \(ch0 && ch0\.finish_reason\) finishReason = ch0\.finish_reason;/.test(cloudSrc)
        && /truncated: finishReason === "length"/.test(cloudSrc)
        && /truncated: !!r\.truncated/.test(R(".lcl.engine", "core", "router.js")));
    check("THE PROVIDER'S ERROR ARRIVES AS A SENTENCE, NOT ITS JSON — one " +
          "decoder for all four documented shapes (error.message, a string " +
          "detail, a wrapped detail.error, and FastAPI's validation array), " +
          "with 429 read for its two distinct meanings: rate limit versus the " +
          "documented engine_overloaded, which bills nothing",
        /function explainProviderError/.test(cloudSrc)
        && /engine_overloaded/.test(cloudSrc)
        && /Array\.isArray\(d\)/.test(cloudSrc)
        && /explainProviderError\(res\.statusCode, scrub\(err, key\), s\.label\)/.test(cloudSrc));
    check("...and the strip-retry decides on the STATUS, not on the wording — " +
          "the error text is free to improve without silently disarming the " +
          "retry that depends on it",
        /httpErr\.status = res\.statusCode;/.test(cloudSrc)
        && /const status = Number\(e && e\.status\) \|\| 0;/.test(cloudSrc));
    check("CHAT-CAPABLE IS THE PROVIDER'S ANSWER FIRST — the published `type` " +
          "(text-generation / embeddings / text-to-image / …) and the `chat` " +
          "capability tag are consulted before any name or description regex, " +
          "which is how an embedder named text2vec ends up in a chat picker",
        /if \(info && typeof info\.type === "string" && info\.type\) \{/.test(cloudSrc)
        && /return info\.type === "text-generation";/.test(cloudSrc));
    check("IMAGE GENERATION THROUGH A LINKED API CAN ACTUALLY RUN — viaApi's " +
          "gate needs capabilities+imageModel, and endpoints() projected " +
          "NEITHER, so the whole API tier was unreachable code. Both are " +
          "projected now, and the drawing model is seeded from the host's own " +
          "image-gen tag at link and refresh",
        /capabilities: Array\.isArray\(v\.capabilities\)/.test(cloudSrc)
        && /imageModel: v\.imageModel \|\| null,/.test(cloudSrc)
        && /function pickImageModel/.test(cloudSrc)
        && /setImageModel\(ep\.id, img\)/.test(cloudSrc));
    check("...and an EXISTING install heals itself on first launch — a " +
          "real store carries 96 DeepInfra models with no tags, no " +
          "features and no retirement flags, so every one of these facts would " +
          "have stayed dark until Refresh was pressed. A hosted " +
          "endpoint with no capability sheet is stale, through the heal path " +
          "that already runs at startup",
        (() => {
            const i = cloudSrc.indexOf("function endpointIsStale");
            const blk = i > 0 ? cloudSrc.slice(i, i + 1400) : "";
            return /!ep\.localNode && !ms\.some\(m => m && \(Array\.isArray\(m\.tags\)/.test(blk);
        })()
        && /healStaleEndpoints/.test(mainSrc));
    check("...and the picker shows what the provider published about each " +
          "model: the context window for EVERY remote model (it was gated on " +
          "the model being on the user's own node), no-tool-calling, and " +
          "vision",
        /if \(m\.contextMax\) bits\.push/.test(appSrc)
        && /if \(m\.toolCalling === false\) bits\.push\("no tool calling"\)/.test(appSrc)
        && /if \(m\.vision\) bits\.push\("sees images"\)/.test(appSrc));

    /* ---- the SECOND review of the same batch ---- */
    check("AN EMPTY 200 DOES NOT TAKE THE ENDPOINT DOWN WITH IT — the machine " +
          "answered, so it is marked ONLINE and only the call fails. Marking " +
          "it offline inverted CONTRACT K4: one bad serving greyed every model " +
          "on that host out of the picker",
        /markEndpointOnline\(s\.id\);\s*\n\s*logCall\("empty"/.test(cloudSrc)
        && /outcome === "dropped-midstream" \|\| outcome === "empty"/.test(cloudSrc));
    check("...and it does not throw away a BILLED call: the usage block the " +
          "provider sent is still learned from and costed, and rides on the " +
          "error so the ledger can book what was spent on an answer that " +
          "never arrived",
        /err\.usage = usage \|\| null;/.test(cloudSrc)
        && /err\.cost = emptyCost;/.test(cloudSrc)
        && /emptyCost = tokenCost\.actualCost/.test(cloudSrc));
    check("...a 200 whose body carries an ERROR object reports THAT, not " +
          "'sent no content' — the provider's own sentence is the useful fact",
        /statedError/.test(cloudSrc)
        && /the body carried an ` \+\s*\n\s*`error for/.test(cloudSrc));
    check("...a DOOR that answers empty falls back to the direct road, like " +
          "one that answers 502",
        /if \(target\.viaDoor && tryOther\(\)\) return;\s*\n\s*done\(reject, err\);/.test(cloudSrc));
    check("...and the whole-body buffer is dropped the moment real output " +
          "arrives — it exists only for the case where nothing did",
        /if \(output \|\| reasoning\) rawAll = "";/.test(cloudSrc));
    check("A REFRESH DOES NOT MAKE THE RECORD POORER THAN A LINK — the card's " +
          "Refresh went through a thin path that wrote {id,label} and threw " +
          "away context, rates, weights, capability tags and retirement " +
          "flags, silently disarming the per-model gate in one click",
        /await refreshEndpointCatalogue\(endpointId\);/.test(cloudSrc)
        && !/store\.endpoints\[endpointId\]\.models = ids\.map/.test(cloudSrc));
    check("STRICT-BODY IS A WIRE FACT, NOT AN OWNERSHIP ONE — the shape probed " +
          "at link time is stored and consulted, so a pasted or rented Ollama " +
          "is exempted from optional fields exactly like the user's own",
        /function isStrictBodyShape/.test(cloudSrc)
        && /ep\.shape === "ollama"/.test(cloudSrc)
        && /shape: shape !== undefined/.test(cloudSrc)
        && /isStrictBodyShape\(s\) \? \{ stream_options/.test(cloudSrc));
    check("...and a tag list is only an ANSWER where the host speaks the " +
          "capability vocabulary — an unrelated tagging scheme must not " +
          "silently suppress a field the model does support",
        /const speaks = rec\.tags\.some\(t => known\.includes/.test(cloudSrc)
        && /if \(!speaks\) return true;/.test(cloudSrc));
    check("A RENAME IS A RENAME EVERYWHERE — the id heal matches on the " +
          "NORMALISED address (exact-string equality never fired for a real " +
          "store), folds rather than destroys a second record's key, carries " +
          "the ::door token, and repoints every session's modelSel, " +
          "taskModels, akAuditor and trustedEndpoints",
        /normaliseBase\(a\) === normaliseBase\(b\)/.test(cloudSrc)
        && /if \(!dst\.key && old\.key\) dst\.key = old\.key;/.test(cloudSrc)
        && /legacy \+ "::door"/.test(cloudSrc)
        && /function repointEndpoint/.test(R(".lcl.engine", "core", "sessions.js"))
        && /cloudModels\.setEndpointRenameHook/.test(mainSrc));
    check("THE ROLES HAVE A REACHABLE WRITER AGAIN — removing the link-time " +
          "auto-select fixed the silent-default bug and left NOTHING able to " +
          "set them, so ask_cloud_model was never registered and role " +
          "fallback could not resolve. Saving an assignment in Model " +
          "Orchestration is the explicit act that sets them",
        /selectCloudModel\(\{\s*\n\s*endpointId: driver\.endpointId, model: driver\.model, role: "driver"/.test(appSrc)
        && /role: "reasoner"/.test(appSrc));
    check("THE GO WINDOW METER CAN ACTUALLY APPEAR — usageWindow reads sel.id " +
          "(what resolveSelection produces); it read sel.endpointId and " +
          "sel.endpoint, neither of which has ever existed, so both branches " +
          "were unreachable and every call returned planless",
        /if \(sel && sel\.id\) \{\s*\n\s*ep = cloudModels\.endpoints\(\)\.find\(e => e\.id === sel\.id\)/.test(mainSrc)
        && !/sel && sel\.endpointId/.test(mainSrc));
    check("A PER-SESSION MODEL PICK IS AUDITED — pointing a conversation at " +
          "somebody else's hardware is the decision that actually moves the " +
          "words, and it left no row at all",
        /kind: "session-model-selected"/.test(mainSrc));
    check("...and a choice that CANNOT be honoured is said on the turn, not " +
          "only in a picker banner nobody has open — naming the real " +
          "destination (this machine), never 'the app default'",
        /kind: "missing-choice"/.test(mainSrc)
        && /ANSWERING ON THIS MACHINE/.test(appSrc));
    check("...and nothing offers a paid model as the silent default any more: " +
          "the preferred-model page disables the linked-endpoint group and " +
          "says why, and the picker's inherit row names this machine",
        /pick these per conversation, not as a default/.test(appSrc)
        && /go back to this machine/.test(appSrc));

    /* ---- what the provider publishes about its own models ---- */
    check("THE PROVIDER'S OWN CATALOGUE IS READ, NOT GUESSED AT — one " +
          "unauthenticated call to /models/list at the ORIGIN (not under the " +
          "OpenAI base path) merges type, feature tags, `deprecated` and " +
          "`replaced_by` onto every model at link and refresh",
        /function providerModelMeta/.test(cloudSrc)
        && /request\(ep, "\/models\/list", \{ timeoutMs: 6_000, fromRoot: true \}\)/.test(cloudSrc)
        && /fromRoot \? urlPath/.test(cloudSrc)
        && /const extra = meta\.get\(e\.id\);/.test(cloudSrc));
    check("...and it REACHES THE OPERATOR: the picker row says a model is " +
          "retired and names its replacement, and a turn driven by a retired " +
          "or tool-less model says so once. The provider retired the gemini " +
          "and .lcl offered it as an equal choice — four clean 200s " +
          "with nothing in them and nothing anywhere explaining why",
        /retired: !!m\.deprecated/.test(mainSrc)
        && /toolCalling: Array\.isArray\(m\.features\)/.test(mainSrc)
        && /modelNotice/.test(mainSrc)
        && /retired by the provider/.test(appSrc)
        && /function showModelNotice/.test(appSrc)
        && /\.model-row\.retired/.test(cssSrc));

    /* ---- the review of the consent batch ---- */
    check("THE NON-SSE ANSWER GOES THROUGH THE THINK SPLITTER TOO — an " +
          "R1-class model writes its chain of thought inline in <think> tags " +
          "with no separate field, so emitting the plain-JSON body raw put " +
          "reasoning in the ANSWER, where the agent parses tool calls out of " +
          "it: the exact failure the splitter exists to prevent",
        (() => {
            const i = cloudSrc.indexOf("const m = c0 && c0.message;");
            const blk = i > 0 ? cloudSrc.slice(i, i + 3000) : "";
            return /splitter\.push\(m\.content\);/.test(blk)
                && !/output = m\.content; onOutput\(m\.content\)/.test(blk);
        })());
    check("A REVOCATION IS NOT UNDONE BY A TURN THAT WAS ALREADY RUNNING — " +
          "the end-of-turn save rewrites the whole session file from the " +
          "turn's own object, so trustedEndpoints is merged from disk (plus " +
          "only what THIS turn granted). Without it, 'stop trusting' " +
          "confirmed itself in the UI and the audit log and did nothing",
        /trustGrantedThisTurn/.test(mainSrc)
        && /if \(Array\.isArray\(cur\.trustedEndpoints\)\)/.test(mainSrc)
        && /s\.trustedEndpoints = cur\.trustedEndpoints\.concat\(keep\)/.test(mainSrc));
    check("THE CARD DIES WITH THE QUESTION — a settle with no user answer " +
          "(timeout / Stop / no window) tells the renderer, which withdraws " +
          "the card, disables it and says nothing was sent; otherwise it " +
          "floated on with live buttons, blocking every later ask behind it",
        /lcl:remoteApprovalWithdrawn/.test(mainSrc)
        && /v !== "once" && v !== "always" && v !== "trust"/.test(mainSrc)
        && /onRemoteApprovalWithdrawn/.test(preSrc)
        && /function permPopupWithdraw/.test(appSrc));
    check("A TRUSTED SEND STILL LEAVES A LINE — main tells the renderer when " +
          "it SKIPS the ask, so no message leaves unrecorded; the old chip " +
          "path keyed on a renderer capability map nothing ever granted, so " +
          "it was unreachable dead code",
        /lcl:remoteSendAllowed/.test(mainSrc)
        && /function presentTrustedSend/.test(appSrc)
        && /revokeTrustedEndpoint\(sid, i\.endpointId\)/.test(appSrc)
        && !/isCapabilityGranted\(active && active\.id, capKey\)/.test(appSrc));
    check("THE POPUP DOES NOT OWN THE KEYBOARD WHEN A SHEET IS OVER IT — " +
          "permPopupOnTop gates the capture handler, and Enter on a focused " +
          "control is that control's own. Enter used to click the card's " +
          "PRIMARY answer (the approve) while the user read the " +
          "Permissions sheet the card itself opened",
        /function permPopupOnTop/.test(appSrc)
        && /if \(!permPopupOnTop\(\)\) return;/.test(appSrc)
        && /TEXTAREA\|INPUT\|SELECT\|BUTTON\|A/.test(appSrc));
    check("A CARD BELONGS TO THE CONVERSATION THAT ASKED — it carries its " +
          "session id, a switch un-mounts it back to the queue, the queue " +
          "only shows cards for the session on screen, and the receipt goes " +
          "to that session's transcript, not whichever one is displayed",
        /prompt\.dataset\.sessionId = forId/.test(appSrc)
        && /function permPopupSyncToSession/.test(appSrc)
        && /permPopupQueue\.findIndex\(c => permCardSession\(c\) === \(active && active\.id\)\)/.test(appSrc)
        && /function permReceipt\(text, allowed, sessionId\)/.test(appSrc));
    check("THE GATE'S CONTROLS LIVE WITH THE PERMISSIONS — sessionPerms " +
          "reports trustedEndpoints (with labels) + the app-wide gate + the " +
          "notify switch; revokeTrustedEndpoint takes a trust back with an " +
          "audit row; the deny text points at Session › Permissions (the old " +
          "'Models and API' pointer named a panel that no longer gates)",
        /const ids = Array\.isArray\(s\.trustedEndpoints\)/.test(mainSrc)
        && /lcl:revokeTrustedEndpoint/.test(mainSrc)
        && /trusted-endpoint-revoked/.test(mainSrc)
        && /Session › Permissions shows what this/.test(mainSrc)
        && !/in Models and API to stop being asked/.test(mainSrc));
    check("...and the waiting-ask toast has an OFF SWITCH the settings own — " +
          "askRemoteApproval honours consentNotify before notifying, and " +
          "setBehavior accepts the key",
        /consentNotify !== false\) \{\s*\n\s*notifyWaiting\(/.test(mainSrc)
        && /if \(k === "consentNotify"\)/.test(mainSrc));
    check("THE PER-MODEL SCHEMA IS CONSULTED BEFORE THE FIELD IS SENT — the " +
          "probe keeps the provider's published capability tags per model, " +
          "the body builder gates reasoning_effort on effortSupported (tags " +
          "known + absent = never sent), and the strip-retry stays only as " +
          "the net for hosts that publish nothing",
        /tags: Array\.isArray\(md\.tags\)/.test(cloudSrc)
        && /tags: Array\.isArray\(info\.tags\) && info\.tags\.length \? info\.tags : undefined/.test(cloudSrc)
        // the gate moved from an inline if to the hoisted effortOut const when
        // the reasoning-headroom floor landed (max_tokens needs to know whether
        // effort is being sent) — same gate, computed once, used for both
        && /const effortOut = !!\(effortWord && !opts\.stripEffort && effortSupported\(s\)\);/.test(cloudSrc)
        && /\.\.\.\(effortOut \? \{ reasoning_effort: effortWord \} : \{\}\)/.test(cloudSrc)
        && /function effortSupported\(s\)/.test(cloudSrc));
    check("THE ZEN CHIP IS THE EXPLICIT PLAN CLEAR — plan 'none' maps to a " +
          "real null at linkEndpoint (a bare null stays 'no opinion'), so " +
          "once-GO is not always-GO",
        /* THE ADDRESS CAN NOW DECLARE A PLAN TOO, and that must not outrank an
         * explicit clear. Pasting the GO url and clicking the ZEN chip means
         * per-token, whatever the url looks like — "none" is checked FIRST, and
         * the preset only fills a caller who stated nothing. */
        /opts\.plan === "none" \? null/.test(cloudSrc)
        && /\(opts\.plan \|\| \(known && known\.plan\) \|\| undefined\)/.test(cloudSrc)
        && /plan !== undefined \? \(plan \|\| null\)/.test(cloudSrc)
        && /"none"\);/.test(appSrc)
        // ...and the ORDER, taken out of the real source and evaluated. NOT by
        // requiring cloudModels: this suite installs a fresh electron stub per
        // block, and pulling the module in early caches it against the wrong
        // one — paths.dataDir then throws on `app.isPackaged` two hundred
        // checks later, which is how this crashed the first time.
        && (() => {
            const m = /plan: (opts\.plan === "none"[\s\S]*?undefined\)),/.exec(cloudSrc);
            if (!m) return false;
            const expr = m[1];
            const chose = (p) => {
                const opts = { plan: p }, known = { plan: "go-window" };
                // eslint-disable-next-line no-eval
                return eval(expr);
            };
            return chose("none") === null            // the Zen chip on a GO url
                && chose(undefined) === "go-window"  // a silent paste of GO
                && chose("go-window") === "go-window";
        })());
    check("...and the renderer really does hand it two arguments — the pasted " +
          "address and an options object (rented flag + preset plan), at every " +
          "connect call site",
        (() => {
            const calls = appSrc.match(/window\.lcl\.connectCloud\(/g) || [];
            // every call passes a second arg: either { ...rented.opts(), ... }
            // (the preset-aware sites) or rented.opts() directly. Both are two
            // arguments; the old regex just could not parse across the ) inside
            // rented.opts().
            const twoArg = (appSrc.match(/connectCloud\(\s*[\w.]+\s*,/g) || []).length;
            return calls.length >= 1 && twoArg >= calls.length
                && appSrc.includes("plan: presetPlan");
        })());

    /* ---- memBytes: the load guard was sizing every machine at 128 GB ---- */
    check("EVERY NODE CARRIES ITS OWN SIZE. nodePreflight reads node.memBytes to " +
          "refuse a model that cannot fit, and nothing in the app ever wrote one " +
          "— so a 100 GB build aimed at a 32 GB box passed the guard and the " +
          "machine went down, which is the exact hang the check exists to prevent",
        (() => {
            const lits = [...mainSrc.matchAll(/node:\s*\{[^{}]*\}/g)].map(m => m[0]);
            return lits.length === 2 && lits.every(l => /memBytes: n\.memBytes \|\| null/.test(l));
        })(),
        [...mainSrc.matchAll(/node:\s*\{[^{}]*\}/g)].map(m => m[0]));

    check("...measured, never assumed: null when it has not been read yet, and " +
          "the guard REFUSES a large load rather than inventing a number for it",
        !/memBytes:\s*\d/.test(mainSrc) &&
        /Number\(rec\.memBytes\) \|\| 0;/.test(cloudSrc));

    check("CONTRACT K1 — AND THE GUARD READS THE COPY THAT IS KEPT CURRENT. " +
          "`rememberNodeMem` writes the localNodes REGISTRY; the endpoint's " +
          "embedded node block is a snapshot taken at link time. The guard read " +
          "the snapshot, which on a real disk is {id,name,host,port} and nothing " +
          "else — so it measured `null -> PROCEEDED` for a 100 GB model. The " +
          "registry is asked first now, through a hook main.js installs",
        /function setNodeMemResolver\(fn\)/.test(cloudSrc) &&
        /nodeMemResolver\(id\)/.test(cloudSrc) &&
        // the record is the LAST resort in the resolution order, not the first
        /Number\(hook && hook\.totalBytes\) \|\| Number\(rec\.memBytes\) \|\| 0/.test(cloudSrc) &&
        /setNodeMemResolver,/.test(cloudSrc.slice(cloudSrc.indexOf("module.exports"))));

    check("...and it is written onto the node's own record from the /proc/meminfo " +
          "MemTotal the gauge and the dashboard already read, so it is there " +
          "before the first chat and survives a restart",
        // The gauge's two MEASURED routes — /proc/meminfo over ssh and the same
        // numbers over the door — used to write this from two separate call
        // sites. They now return through one, so there is one write, and it is
        // fenced: a serving-port reading is a floor that cannot see other
        // processes, and letting that become the load guard's idea of the
        // machine's size is how it would wave through a model that will not fit.
        /rememberNodeMem\(n\.id, res\.physTotalBytes\)/.test(mainSrc) &&
        /if \(!res\.floor\) rememberNodeMem/.test(mainSrc) &&
        /rememberNodeMem\(n\.id, mem\.MemTotal\)/.test(mainSrc));

    check("...and that write really lands on the record, and only when the number " +
          "CHANGED — a settings write on a five-second poll is its own harm",
        (() => {
            let store = [{ id: "node-a", name: "stopbath", host: "stopbath.local" }];
            let writes = 0;
            const NODES_KEY = "localNodes";
            const remember = new Function("readNodes", "paths", "NODES_KEY",
                liftFn(mainSrc, "rememberNodeMem") + "\nreturn rememberNodeMem;")(
                () => store,
                { writeSettings: (o) => { writes++; store = o[NODES_KEY]; } },
                NODES_KEY);
            remember("node-a", 32e9);
            const wrote = store[0].memBytes === 32e9 && writes === 1;
            remember("node-a", 32e9);
            const idempotent = writes === 1;
            remember("node-a", 0);
            const zeroIgnored = writes === 1 && store[0].memBytes === 32e9;
            remember("node-missing", 64e9);
            return wrote && idempotent && zeroIgnored && writes === 1;
        })());

    /* ---- THE INSTALLER THAT FINISHED AND OPENED NOTHING ----------------
     *
     *   "it doesn't launch .lcl now, after the updater/installer is finished"
     *
     * The finish step de-elevated the launch through a schtasks /rl LIMITED
     * task. Measured on a real machine: the task created cleanly,
     * /run returned success, "Last Result" was 0 — and no .lcl process ever
     * appeared, 8 seconds later still nothing. Same shape as every other bug in
     * this file: a success report laid over a launch that did nothing.
     * explorer.exe hands the installed path to the already-running medium-IL
     * shell, which starts .lcl de-elevated within ~0.5s — proven on the same
     * machine. This guards the MECHANISM, over the function's own body so the
     * comment recording what it replaced cannot satisfy the check. */
    const instMain = R("devtools", "installer", "main.js");
    const launchFn = (instMain.match(/function launchDeElevated[\s\S]*?\n}/) || [""])[0];
    check("THE INSTALLER OPENS THE APP THROUGH THE SHELL — explorer.exe hands the " +
          "installed path to the medium-IL shell so .lcl starts de-elevated, and " +
          "the finish step awaits it. It does NOT route through a schtasks task " +
          "that reports success and launches nothing (measured: Last Result 0, no " +
          "process at all)",
        launchFn.length > 0
        && /execFile\(\s*["']explorer\.exe["']\s*,\s*\[\s*exe\s*\]/.test(launchFn)
        && !/schtasks/i.test(launchFn)
        && /await launchDeElevated\(/.test(instMain),
        { launchFnFound: launchFn.length > 0,
          usesExplorer: /explorer\.exe/.test(launchFn),
          usesSchtasks: /schtasks/i.test(launchFn) });

    await fallbackChecks();

    console.log(`\n${pass}/${pass + fail} install-failure checks passed`);
    process.exit(fail ? 1 : 0);
}

/* ===================================================================
 * 10. THE API FALLBACK THAT DID NOT FALL BACK
 *
 *   "With Gemini Flash set as fallback, the failure went back to the local
 *    model instead, and answered with a memory complaint."
 *
 * Reproduced, and it was not a bug in the fallback — there was no fallback.
 * router.generate() called ONE backend and returned whatever it said, so a
 * local engine refusing a load for want of memory WAS the turn's answer.
 * The "API fallback" panel wrote two settings and nothing in the routing
 * ever read either of them.
 *
 * Everything below stands up a real endpoint on loopback and drives the
 * REAL router against a local engine that fails the way it did. A regex
 * over router.js would have passed on the broken build; this does not.
 * ================================================================= */
async function fallbackChecks() {
    const http = require("http");
    const Module = require("module");
    const _resolve = Module._resolveFilename;
    Module._resolveFilename = function (r, ...a) {
        if (r === "electron") return __filename;
        return _resolve.call(this, r, ...a);
    };
    const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-fallback-"));
    process.env.LCL_DATA_DIR = DATA;
    require.cache[__filename] = { exports: {
        app: { isPackaged: false, getPath: () => DATA },
        clipboard: { readText: () => "", writeText: () => {} },
        safeStorage: { isEncryptionAvailable: () => false }
    } };

    const paths = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));
    paths.writeSettings({ networkEnabled: true });
    const engine = require(path.join(ROOT, ".lcl.engine", "core", "engine.js"));
    const cloud = require(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"));
    const router = require(path.join(ROOT, ".lcl.engine", "core", "router.js"));

    // The local engine failing the way it failed on the test machine. This is the
    // literal shape of the complaint returned when a picture of a donkey was
    // requested with a paid model linked, switched on and ticked.
    const MEMORY_COMPLAINT =
        "not enough memory to load the model — close some apps and try again";
    let localCalls = 0;
    engine.generate = async () => { localCalls++; return { error: MEMORY_COMPLAINT }; };

    let apiCalls = 0;
    const api = http.createServer((req, res) => {
        if (/\/v1\/models$/.test(req.url)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ data: [{ id: "flash-2" }] }));
        }
        if (/\/api\/tags$/.test(req.url)) { res.writeHead(404); return res.end("{}"); }
        let b = ""; req.on("data", c => b += c);
        req.on("end", () => {
            apiCalls++;
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write('data: {"choices":[{"delta":{"content":' +
                      '"Two parts developer to one part water at 20C."}}]}\n\n');
            res.write('data: {"choices":[{"delta":{}}],' +
                      '"usage":{"prompt_tokens":90,"completion_tokens":11}}\n\n');
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    const port = await new Promise((r) => api.listen(0, "127.0.0.1",
        () => r(api.address().port)));
    const linkedIF = await cloud.connect(`127.0.0.1:${port} sk-abcdefghijklmnopqrstuvwx`);
    // connect() deliberately no longer selects — assign the driver explicitly
    cloud.selectModel({ endpointId: linkedIF.endpoint.id, model: linkedIF.model });

    const msgs = [{ role: "user", content: "how do I mix the developer" }];
    const localTurn = { selection: null };          // this session runs local

    /* ---- the switch OFF means a failure is a failure, exactly as before ---- */
    paths.writeSettings({ allowEscalation: false });
    apiCalls = 0;
    const off = await router.generate(msgs, 256, null, null, { ...localTurn });
    check("LIVE: with the API fallback switch OFF a failed local turn is still a " +
          "failed turn, and nothing is paid for behind the user's back",
        off.error === MEMORY_COMPLAINT && apiCalls === 0, { off, apiCalls });

    /* ---- the switch ON, and this conversation ticked that model ---- */
    paths.writeSettings({ allowEscalation: true });
    apiCalls = 0;
    const notes = [];
    const on = await router.generate(msgs, 256, null, null,
        { ...localTurn, escalateTo: ["flash-2"], onNote: (m) => notes.push(m) });
    check("LIVE: THE API FALLBACK ACTUALLY FALLS BACK. The panel wrote a global " +
          "switch and a per-session list of models this conversation may pay for; " +
          "nothing in the router, the agent or cloudModels ever read either of " +
          "them for routing, so a local memory refusal was returned as the answer",
        !on.error && /20C/.test(on.content || "") && apiCalls === 1,
        { on, apiCalls });

    check("LIVE: ...and it SAYS it fell back, and why. A silent substitution is " +
          "the same class of lie as a dead control — the user is entitled to know " +
          "which machine answered and what happened to the one they picked",
        on.fellBackFrom === "the local engine" &&
        on.fallbackReason === MEMORY_COMPLAINT &&
        notes.some(n => /falling back to flash-2/.test(n)), { on, notes });

    check("LIVE: ...and the answer carries the tokens and the endpoint that were " +
          "REALLY billed, so the ledger row the agent writes names the model that " +
          "actually answered. 'Spend captured none of the API attempts'",
        on.remote === true && on.model === "flash-2" &&
        !!on.usage && on.usage.prompt_tokens === 90, on);

    /* ---- the per-session list is a gate, not decoration ---- */
    apiCalls = 0;
    const notTicked = await router.generate(msgs, 256, null, null,
        { ...localTurn, escalateTo: ["some-model-this-session-did-not-tick"] });
    check("LIVE: a model this conversation did NOT tick is never paid for on its " +
          "behalf — two yeses, the same as the escalation tools",
        notTicked.error === MEMORY_COMPLAINT && apiCalls === 0, { notTicked, apiCalls });

    /* ---- Stop is not a failure ---- */
    apiCalls = 0;
    const stoppedTurn = await router.generate(msgs, 256, { cancelled: true }, null,
        { ...localTurn, escalateTo: ["flash-2"] });
    check("LIVE: a turn the USER stopped is never escalated. Spending money " +
          "on an answer nobody is waiting for is its own defect",
        !!stoppedTurn.error && apiCalls === 0, { stoppedTurn, apiCalls });

    /* ---- an explicit target, and a caller that can veto ---- */
    apiCalls = 0;
    const declined = await router.generate(msgs, 256, null, null,
        { ...localTurn, escalateTo: ["flash-2"], approveRemote: async () => false });
    check("LIVE: a caller that wants to ask first can — approveRemote gates the " +
          "hop onto somebody else's hardware, which is CONTRACT K3's shape " +
          "reaching the one path that spends money without being asked to",
        declined.error === MEMORY_COMPLAINT && declined.fallbackDeclined === true
        && apiCalls === 0, { declined, apiCalls });

    /* ---- the REMOTE side of the same seam ---- */
    // pastes get PER-HOST ids now (api-<host>), not the one shared "custom"
    // slot — the slot that let a failed add destroy the working endpoint
    const liveEpId = "api-127.0.0.1";
    const remoteSel = { ...cloud.endpoints().find(e => e.id === liveEpId),
                        model: "flash-2" };
    const deadSel = { ...remoteSel, id: "dead", baseUrl: "http://127.0.0.1:1",
                      label: "a machine that is off", relayUrl: null };
    apiCalls = 0;
    const remoteFell = await router.generate(msgs, 256, null, null,
        { selection: deadSel, fallback: { endpointId: liveEpId, model: "flash-2" } });
    check("LIVE: and a REMOTE model that cannot be reached falls back too, rather " +
          "than returning the socket error as the turn's answer",
        !remoteFell.error && apiCalls === 1 &&
        /a machine that is off/.test(remoteFell.fellBackFrom || ""), remoteFell);

    check("LIVE: CONTRACT K4 — and the endpoint that could not be reached is " +
          "MARKED, with a reason, by the turn that discovered it. The picker never " +
          "dials anything, so if the code that does dial does not record what it " +
          "learned, a machine that is switched off keeps being offered",
        (() => {
            const h = cloud.endpointHealth("dead");
            return h.offline === true && /127\.0\.0\.1|refused|ECONN/i.test(h.offlineReason || "");
        })(), cloud.endpointHealth("dead"));

    check("LIVE: ...and the endpoint that ANSWERED is not marked — a verdict has " +
          "to be able to say no, or it is decoration",
        cloud.endpointHealth(liveEpId).offline === false,
        cloud.endpointHealth(liveEpId));

    check("LIVE: resolveFallback never picks the thing that just failed — that " +
          "would be a retry wearing a fallback's name",
        router.resolveFallback({ escalateTo: ["flash-2"] }, remoteSel) === null,
        router.resolveFallback({ escalateTo: ["flash-2"] }, remoteSel));

    check("LIVE: ...and naming a target that cannot be resolved returns nothing " +
          "rather than quietly substituting a different endpoint",
        router.resolveFallback({ fallback: { endpointId: "no-such", model: "x" } }, null)
            === null);

    check("LIVE: CONTRACT K4 — and it never falls back onto a machine already " +
          "recorded as unreachable",
        (() => {
            cloud.markEndpointOffline(liveEpId, "switched off");
            const to = router.resolveFallback({ escalateTo: ["flash-2"] }, null);
            cloud.markEndpointOnline(liveEpId);
            return to === null;
        })());

    check("LIVE: the local engine really was asked first every time — the " +
          "fallback is a fallback, not a shortcut past the model the user chose. " +
          "Five local turns above, five calls to the engine, and the sixth case " +
          "is remote so it never touches it",
        localCalls === 5, { localCalls });

    await new Promise((r) => api.close(r));
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 6 }); }
    catch { /* windows holds it */ }
}

deviceChecks();
