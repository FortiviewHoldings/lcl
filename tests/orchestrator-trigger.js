/**
 * Trigger + goal-resolution tests, anchored on the EXACT phrases from the
 * user's failing session: "turn this folder into a static site" (worked) and
 * "can you try again, that is not a static site" (fell through to a lying
 * single turn). Both must route to the orchestrator now.
 */
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => require("os").tmpdir() },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const orch = require(__dirname + "/../.lcl.engine/core/orchestrator.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail) : ""); }
}

// a session whose recent turns were a site build
const buildSession = { messages: [
    { role: "user", content: "can you turn this folder into a static site to advertise yourself" },
    { role: "assistant", content: "Sure, I'll create a static site with index.html." }
]};
const chatSession = { messages: [
    { role: "user", content: "what do you know about industrial instrumentation" },
    { role: "assistant", content: "Industrial instrumentation refers to devices that measure process values." }
]};

// ---- SHOULD trigger ----
check("primary: 'turn this folder into a static site'",
    orch.looksMultiStep("can you turn this folder into a static site to advertise yourself", chatSession) === true);
check("correction after a build: 'try again, that is not a static site'",
    orch.looksMultiStep("can you try again, that is not a static site", buildSession) === true);
check("bare 'try again' after a build",
    orch.looksMultiStep("try again", buildSession) === true);
check("'that did nothing' after a build",
    orch.looksMultiStep("that did nothing", buildSession) === true);
check("'build me a dashboard app'",
    orch.looksMultiStep("build me a dashboard app", chatSession) === true);
check("'make a landing page'",
    orch.looksMultiStep("make a landing page for my product", null) === true);

// ---- must NOT trigger ----
check("plain question does not trigger",
    orch.looksMultiStep("what do you know about industrial instrumentation", chatSession) === false);
check("'try again' with NO prior build does not trigger",
    orch.looksMultiStep("try again", chatSession) === false);
check("greeting does not trigger",
    orch.looksMultiStep("hello there", null) === false);
check("a domain troubleshooting question does not trigger",
    orch.looksMultiStep("my thermostat is not responding, what am i missing", chatSession) === false);

// ---- HARDWARE IS NOT A FILE BUILD (measured from two real failed sessions) ----
check("the exact failing message: a COM-port hardware task does NOT orchestrate",
    orch.looksMultiStep("There's a board on COM10. Figure out what it is, find its " +
        "documentation online, and get set up to program it.", chatSession) === false);
check("...nor \"program the board on com10\"",
    orch.looksMultiStep("program the board on com10", chatSession) === false);
check("...but a real file build with DASHBOARD in it still orchestrates",
    orch.looksMultiStep("build me a dashboard app with several pages", chatSession) === true);

// ONCE A SESSION HAS TOUCHED HARDWARE, IT STAYS CONVERSATIONAL (the hardware-session let-down)
const hwSession = { messages: [{ role: "tool", name: "board_identify" },
                                { role: "tool", name: "install_toolchain" }] };
check("a build-shaped request in a session that ALREADY ran a device tool does NOT " +
      "orchestrate — it is a hardware dev session, whatever the words",
    orch.looksMultiStep("write a custom interface that acts as a virtual voice " +
        "assistant with an orb and a soundwave mouth", hwSession) === false);
check("...the SAME words in a fresh session still orchestrate — earned by context",
    orch.looksMultiStep("write a custom interface with an orb and several panels " +
        "and a dashboard", chatSession) === true);

// ---- goal resolution: a bare correction carries the original build goal ----
const resolved = orch.resolveGoal("can you try again, that is not a static site", buildSession);
check("resolveGoal pulls the original build request into a correction",
    /static site/.test(resolved) && /Follow-up correction/.test(resolved), resolved);
check("resolveGoal leaves a primary request unchanged",
    orch.resolveGoal("build me a portfolio site", chatSession) === "build me a portfolio site");
check("resolveGoal returns the text when nothing to resolve",
    orch.resolveGoal("try again", chatSession) === "try again");

/* ================= NEVER DEAD-END: no files becomes a QUESTION ============ */
{
    const path = require("path");
    const fs = require("fs");
    const src = fs.readFileSync(
        path.join(__dirname, "..", ".lcl.engine", "core", "orchestrator.js"), "utf8");
    const active = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check("the wrote-no-files dead-end is gone from the live code path",
        !/Ran \$\{steps\.length\} steps but wrote no files/.test(active));
    check("...and the no-files branch calls askForClarification instead",
        /await askForClarification\(session, planningGoal/.test(active));
}

(async () => {
    const router = require(__dirname + "/../.lcl.engine/core/router.js");
    const realGen = router.generate;
    router.generate = async () => ({ content: "I understood you want X. Which Y? First I would do Z." });
    const scoped = await orch.askForClarification({ repoPath: "C:/ws" },
        "make a voice assistant", { cancelled: false }, null);
    check("askForClarification returns the model scoping reply when it answers",
        /Which Y\?/.test(scoped));
    router.generate = async () => { throw new Error("engine down"); };
    const fb = await orch.askForClarification({ repoPath: "C:/ws" },
        "make a voice assistant", { cancelled: false }, null);
    check("...and if the model is unreachable it STILL asks for the first concrete " +
          "piece, never a failure message",
        /first concrete piece/i.test(fb) && !/wrote no files/i.test(fb));
    router.generate = realGen;
    console.log(`\n${pass}/${pass + fail} trigger checks passed`);
    process.exit(fail ? 1 : 0);
})();
