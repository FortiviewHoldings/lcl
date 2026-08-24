/**
 * A PER-CONVERSATION GRANT ACTUALLY REACHES THE KERNEL.
 *
 * The bug this pins, measured from a real session: the operator granted
 * flash_device "for this conversation", it was written to session.toolPolicy
 * as {"flash_device":"notify"} — and every flash STILL drew the full approval
 * card, because policyBridge.check built the kernel from GLOBAL settings and
 * never applied the SESSION's toolPolicy. The grant went into a drawer nobody
 * read.
 *
 * Why it slipped: the kernel's own unit test (tests/device-control.js) set
 * kernel.toolPolicy DIRECTLY, so it proved the kernel honours a grant while
 * skipping the exact layer — policyBridge — that was failing to hand it one.
 * This suite drives the REAL policyBridge.check path, session in, decision out.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-stp-"));
process.env.LCL_DATA_DIR = DATA;

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

const policy = require(path.join(ROOT, ".lcl.engine", "core", "policyBridge.js"));
const { DECISION } = require(path.join(ROOT, ".lcl.engine", "policy", "kernel.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail) : ""); }
}
const decide = (toolPolicy, id) => policy.check(
    { id: id || "s" + Math.round(pass * 7 + fail * 13), repoPath: null, toolPolicy },
    "flash_device", { port: "COM10", sketch: "x/x.ino" }, { turnId: "u" + (pass + fail) }).decision;

/* the whole point: a session grant of "notify" must produce NOTIFY here */
check("a per-conversation grant reaches the kernel: flash_device notify -> NOTIFY (runs with progress, no card)",
    decide({ flash_device: "notify" }) === DECISION.NOTIFY);

check("no grant -> CONFIRM: the first flash still asks",
    decide({}) === DECISION.CONFIRM);

check("a taken-back grant (confirm) -> CONFIRM: the card comes back",
    decide({ flash_device: "confirm" }) === DECISION.CONFIRM);

check("an unrelated tool grant does not leak onto flash_device",
    decide({ serial_read: "notify" }) === DECISION.CONFIRM);

/* the floor still holds through this path: a session cannot loosen run_script
 * (sys.execute, no sessionFloor) below confirm, even asking for allow */
const runScriptDec = policy.check(
    { id: "rs", repoPath: null, toolPolicy: { run_script: "allow" } },
    "run_script", { language: "bash", code: "echo hi" }, { turnId: "z" }).decision;
check("the floor is not bypassed: run_script granted 'allow' still CONFIRMs (welded shell)",
    runScriptDec === DECISION.CONFIRM);

/* a global grant (settings.toolPolicy) is the base, and a session override wins */
fs.writeFileSync(path.join(DATA, "settings.json"), JSON.stringify({ toolPolicy: { flash_device: "notify" } }));
check("a GLOBAL grant also reaches the decision (base layer honoured)",
    decide({}, "global-only") === DECISION.NOTIFY);
check("...and a session takeback overrides a global grant",
    decide({ flash_device: "confirm" }, "sess-wins") === DECISION.CONFIRM);
fs.writeFileSync(path.join(DATA, "settings.json"), JSON.stringify({}));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
