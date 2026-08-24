/**
 * CONCURRENT SESSIONS + SESSION STATUS.
 *
 * The complaint, verbatim: "if one session is running the model, you can not
 * open another session and start a task, you can not create a new session, or
 * open an existing one." And: no visual indication of what any session is
 * doing.
 *
 * The engine is still ONE llama-server with ONE resident model — physics. So
 * the design is: sessions are independent everywhere EXCEPT token generation,
 * which queues. These tests pin the queue's behaviour and the wiring that
 * makes the rest of the app treat sessions independently.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
// ISOLATED per run: paths.js derives the data directory from this,
// so a shared os.tmpdir() made every suite inherit whatever settings
// an earlier suite had written — an order-dependent gate that failed
// builds at random.
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const engine = require(__dirname + "/../.lcl.engine/core/engine.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}

(async () => {
    /* ---- the generation QUEUE ---- */
    // Replace the real inference with a controllable fake. generate() must
    // serialise calls: second starts only after the first finishes.
    const order = [];
    let release1;
    const gate1 = new Promise(r => { release1 = r; });
    let call = 0;
    engine._setGenerateNowForTest && engine._setGenerateNowForTest(async () => {
        const n = ++call;
        order.push(`start${n}`);
        if (n === 1) await gate1;
        order.push(`end${n}`);
        return { content: `reply ${n}` };
    });

    if (!engine._setGenerateNowForTest) {
        console.log("     (no test seam — checking queue via source instead)");
        const src = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "engine.js"), "utf8");
        check("generate() chains onto a queue promise",
            /generateChain\s*=/.test(src) && /generateChain\.then/.test(src));
        check("a failed turn cannot wedge the queue",
            /generateChain\s*=\s*run\.catch/.test(src));
        check("a cancelled queued turn never runs",
            /cancelToken\.cancelled\)\s*return\s*\{\s*error:\s*"cancelled"/.test(src));
    } else {
        const p1 = engine.generate([], 10, { cancelled: false });
        const p2 = engine.generate([], 10, { cancelled: false });
        await new Promise(r => setTimeout(r, 30));
        check("the second generation waits for the first", !order.includes("start2"), order);
        release1();
        await Promise.all([p1, p2]);
        check("both generations completed in order",
            JSON.stringify(order) === JSON.stringify(["start1", "end1", "start2", "end2"]), order);
    }

    /* ---- main.js wiring: per-session turns, statuses, guards ---- */
    const mainSrc = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
    check("the global single-turn lock is gone",
        !/let activeTurn = null/.test(mainSrc));
    check("turns are tracked per session",
        /turnsBySession = new Map\(\)/.test(mainSrc) && /turnsBySession\.set\(id/.test(mainSrc));
    check("a busy session refuses ITS OWN second turn",
        /turnsBySession\.has\(id\)/.test(mainSrc));
    check("cancel targets a specific session's turn",
        /turnsBySession\.get\(sessionId\)/.test(mainSrc));
    check("deleting a mid-turn session is refused (its save would resurrect it)",
        /still working — stop it first/.test(mainSrc));

    // the FIVE states, driven by the process that knows. "approval" was split
    // out of "waiting": one purple dot used to mean a question you could
    // ignore, a send awaiting consent and a staged destructive call, so the
    // list could not tell a blocked turn from a chatty one.
    check("status is broadcast to the renderer",
        /lcl:sessionStatus/.test(mainSrc) && /setSessionStatus/.test(mainSrc));
    for (const state of ["working", "waiting", "approval", "failed", "idle"]) {
        check(`state "${state}" is set somewhere real`,
            new RegExp(`setSessionStatus\\([^)]*"${state}"`).test(mainSrc));
    }
    check("a clarify from the model flips the session to waiting",
        /clarify[\s\S]{0,120}waiting/.test(mainSrc));
    check("a staged approval flips the session to the APPROVAL state, which is " +
          "its own colour in the sidebar",
        /staged \? "approval" : askedUser \? "waiting" : "idle"/.test(mainSrc));

    /* ---- renderer wiring: the sidebar tells the truth ---- */
    const appSrc = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    const cssSrc = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "styles.css"), "utf8");

    check("pending is per-session in the renderer",
        /pendingSessions = new Set\(\)/.test(appSrc));
    check("switching sessions is allowed while another works",
        !/if \(pending \|\| \(active && active\.id === id\)\) return;/.test(appSrc));
    check("creating a session is never blocked by other sessions",
        /newSessionBtn\.disabled = false/.test(appSrc));
    // ONE LOCAL ENGINE — switching models mid-generation would pull it out from
    // under a running turn, so a LOCAL turn anywhere must lock the picker.
    // A REMOTE turn holds no local engine and must NOT lock it: blocking on
    // anyPending() meant a second session could not choose a model while the
    // first was thinking on a linked API, which is the whole point of having
    // independent sessions. The gate asks the precise question now.
    /* THIS PIN USED TO ASSERT THE BUG.
     *
     * It required `modelPickBtn.disabled = pending || switching ||
     * localElsewhere` — the over-broad lock itself — so the lock survived every
     * review by being the thing the test demanded. What it blocked was step two
     * of the user's own test: while session one generated locally, the
     * picker was dead, so sessions two and three could not be pointed at his
     * Spark or at an API.
     *
     * The invariant is narrower than the lock was: do not LOAD a different gguf
     * while a local turn is live. A remote choice does no engine work — the
     * remote branch of switchModel returns before any engine call. So the
     * refusal belongs at the point of consequence, and that is what is pinned. */
    check("A LOCAL turn elsewhere blocks LOADING A DIFFERENT LOCAL MODEL — and " +
          "nothing else. The button stays live so a node or an API can still be " +
          "chosen for another session while one generates",
        /const localTurnElsewhere = \(\) => \[\.\.\.pendingSessions\]\.some\(/.test(appSrc)
        && /!remotePending\.has\(id\)/.test(appSrc)
        && /modelPickBtn\.disabled = pending \|\| switching;/.test(appSrc)
        && !/modelPickBtn\.disabled = pending \|\| switching \|\| localElsewhere/.test(appSrc));
    check("...and the refusal sits AFTER the remote early-return, so only a " +
          "local model can ever hit it, and it names the session holding the " +
          "engine rather than going quiet",
        (() => {
            const i = appSrc.indexOf("if (target && target.remote) {");
            const j = appSrc.indexOf("if (localTurnElsewhere()) {");
            return i >= 0 && j > i
                && /is generating on this /.test(appSrc)
                && /there is only one, so loading a /.test(appSrc);
        })());
    check("a REMOTE turn is tracked so it does not block the picker",
        /const remotePending = new Set\(\)/.test(appSrc)
        && /if \(remoteActive\(\)\) remotePending\.add\(session\.id\)/.test(appSrc)
        && /remotePending\.delete\(session\.id\)/.test(appSrc));
    check("a reply landing for a non-viewed session does not touch the DOM",
        /const viewing = \(\) => active && active\.id === session\.id/.test(appSrc));
    check("cancel is sent for the ACTIVE session specifically",
        /cancelChat\(active && active\.id\)/.test(appSrc));

    // the status dot: leftmost, four states, correct colours
    check("each session row carries a status dot",
        /session-status/.test(appSrc) && /dot\.title = statusTitle/.test(appSrc));
    check("live status updates repaint one row, not the whole list",
        /paintSessionStatus/.test(appSrc) && /querySelector\(`\[data-session-id/.test(appSrc));
    // THE OPERATOR'S PALETTE, verbatim: "read mean bad, no good" — red is
    // error ONLY; yellow is the model prompting you; cyan is finished-UNREAD
    // (plain idle went quiet neutral so cyan means exactly one thing); read is
    // "just an outline and black dot".
    check("unread-done is cyan — and cyan means ONLY that (idle is neutral now)",
        /\.session-status\.done\s*\{[^}]*#22d3ee/.test(cssSrc)
        && !/\.session-status\s*\{[^}]*#22d3ee/.test(cssSrc));
    check("waiting/prompting is yellow", /\.session-status\.waiting\s*\{[^}]*#e8c14b/.test(cssSrc));
    check("read is a black dot with an outline",
        /\.session-status\.acked\s*\{[^}]*#0b0b0f/.test(cssSrc)
        && /\.session-status\.acked\s*\{[^}]*inset/.test(cssSrc));
    check("failed is red — and red means error, nothing else",
        /\.session-status\.failed\s*\{[^}]*#f0716c/.test(cssSrc));
    check("working pulses grey light-to-dark",
        /\.session-status\.working\s*\{[^}]*sessionPulse/.test(cssSrc)
        && /@keyframes sessionPulse/.test(cssSrc));
    check("only the working state animates",
        !/\.session-status\.(waiting|failed)\s*\{[^}]*animation/.test(cssSrc));

    // the WS badge became a chain link, right of the name
    check("the workspace mark is a chain-link icon, not a WS box",
        /session-link-mark/.test(appSrc) && !/innerText = "WS"/.test(appSrc));
    check("the link mark is ghost-styled (no border box)",
        (() => {
            // The mark later became a clickable BUTTON, which needs an explicit
            // `border: none` reset — that IS "no border box". The old regex
            // read any `border:` as a box and failed the reset it asked for.
            const i = cssSrc.indexOf(".session-link-mark {");
            if (i < 0) return false;
            const blk = cssSrc.slice(i, cssSrc.indexOf("}", i));
            // whitespace lives INSIDE the lookahead — `\s*` outside it can
            // match zero characters and sneak the negative past `border: none`
            return /color: var\(--text-faint\)/.test(blk)
                && !/border:(?!\s*none\b)/.test(blk);
        })());

    // preload carries the new channels
    const preSrc = fs.readFileSync(path.join(__dirname, "..", "app", "preload.js"), "utf8");
    check("preload exposes session statuses and the live event",
        /sessionStatuses:/.test(preSrc) && /onSessionStatus:/.test(preSrc));
    check("preload's cancelChat carries the session id",
        /cancelChat: \(sessionId\)/.test(preSrc));

    console.log(`\n${pass}/${pass + fail} concurrency checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
