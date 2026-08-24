/**
 * PLAN-CONFIRM GATE — a big creative build restates the plan and waits before
 * it spends.
 *
 * Measured, not theorised: the local 35B ignores prompt steering. Told to
 * delegate visual work it did not; asked to "make it high quality" it spiralled
 * 37k characters of reasoning and flashed ten bad sketches. So the pause is
 * enforced by the LOOP, from the request shape alone. This suite pins the two
 * false positives that would matter (a plain hardware op and a question must
 * NOT trip it), the one-shot guard (the reply that approves/adjusts must NOT
 * re-ask), and the persistence the adversarial review flagged: the plan bubble
 * has to be pushed to session.messages BEFORE the early return, or the guard
 * and the resume both silently break.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-pc-"));
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

const agent = require(path.join(ROOT, ".lcl.engine", "core", "agent.js"));
const { shouldPlanConfirm } = agent;

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 200) : ""); }
}
const fresh = (msgs) => ({ id: "s", title: "t", messages: msgs || [], taskModels: {} });

check("shouldPlanConfirm is exported", typeof shouldPlanConfirm === "function");

/* ---- FIRES on a real creative build (the user's own words) ---- */
check("fires on 'write a custom interface ... an orb that pulses ... a soundwave for a mouth'",
    shouldPlanConfirm(fresh(), "ok, can we write a custom interface that acts as a virtual voice assistant, an orb that pulses, with a soundwave for a mouth") === true);
check("fires on 'update the logic on the device to demo the new visual' (the request it mishandled)",
    shouldPlanConfirm(fresh(), "ok, can you please update the logic on the device to demo the new visual") === true);
check("fires on a 3D build",
    shouldPlanConfirm(fresh(), "build me a 3D model of a bracket and export it") === true);

/* ---- fires on ITERATIVE rebuild phrasing (the turns that slipped past) ---- */
check("fires on iterative rebuild phrasing ('give this another shot')",
    shouldPlanConfirm(fresh(), "give this another shot, the orb is not what i want") === true);
check("fires on 'try again on the orb visual'",
    shouldPlanConfirm(fresh(), "try again on the orb visual") === true);
check("fires on 'tweak/improve/fix the <visual>'",
    shouldPlanConfirm(fresh(), "tweak the orb glow and fix the soundwave") === true);

/* ---- does NOT fire on the WORKING hardware flow ---- */
check("does NOT fire on 'identify the board on COM10 and back up its firmware'",
    shouldPlanConfirm(fresh(), "identify the board on COM10 and back up its firmware") === false);
check("does NOT fire on 'flash the sketch to COM10'",
    shouldPlanConfirm(fresh(), "flash the sketch to COM10") === false);
check("does NOT fire on a plain setup request",
    shouldPlanConfirm(fresh(), "there's a board on COM10, figure out what it is and get set up") === false);

/* ---- does NOT fire on a QUESTION about a visual (no build verb) ---- */
check("does NOT fire on 'what does the orb look like right now' (a question, not a build)",
    shouldPlanConfirm(fresh(), "what does the orb look like right now") === false);

/* ---- one-shot: the reply that approves/adjusts must NOT re-ask ---- */
const planned = fresh([
    { role: "user", content: "build me an animated orb visual" },
    { role: "assistant", content: "Plan: ...", meta: { planConfirm: true } }
]);
check("does NOT re-fire once a plan was already shown (prior bubble is planConfirm) — even on an adjustment",
    shouldPlanConfirm(planned, "make the orb bigger and animate it faster") === false);
// and once the build ran (prior is a normal result), a NEW visual build re-arms it
const afterBuild = fresh([
    { role: "user", content: "build the orb" },
    { role: "assistant", content: "Done, flashed.", meta: {} }
]);
check("re-arms for a genuinely new build after the last one finished",
    shouldPlanConfirm(afterBuild, "now build me an animated settings screen") === true);

/* ---- orchestrated steps never pause ---- */
check("never fires in stepMode (the orchestrator owns its own steps)",
    shouldPlanConfirm(fresh(), "build me an animated visual", { stepMode: true }) === false);
check("never fires when the caller already confirmed",
    shouldPlanConfirm(fresh(), "build me an animated visual", { planConfirmed: true }) === false);

/* ---- operator opt-out ---- */
fs.writeFileSync(path.join(DATA, "settings.json"), JSON.stringify({ planConfirm: false }));
check("respects the opt-out: settings.planConfirm === false silences it",
    shouldPlanConfirm(fresh(), "build me an animated orb visual") === false);
fs.writeFileSync(path.join(DATA, "settings.json"), JSON.stringify({}));
check("...and it is back on when the opt-out is cleared",
    shouldPlanConfirm(fresh(), "build me an animated orb visual") === true);

/* ---- STRUCTURAL: the plan bubble is persisted BEFORE the early return ---- */
const SRC = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
const g0 = SRC.indexOf("PLAN-CONFIRM GATE");
const gEnd = SRC.indexOf("akLoop: for (;;) {");
const gate = SRC.slice(g0, gEnd);
check("the gate exists just above the step loop", g0 >= 0 && gEnd > g0);
const pushAt = gate.indexOf("session.messages.push(...newMessages)");
const retAt = gate.indexOf("return { ok: true, newMessages");
check("the plan bubble is PERSISTED before the gate returns (the dead-end the review flagged)",
    pushAt >= 0 && retAt >= 0 && pushAt < retAt, { pushAt, retAt });
check("the gate carries costUsd out, so a PAID plan is not shown as a $0 turn",
    /return \{ ok: true, newMessages, changes, pendingApprovals,\s*costUsd/.test(gate));
check("the plan bubble is stamped meta.planConfirm so the one-shot guard can see it next turn",
    gate.includes("meta: { model: modelName, planConfirm: true }"));

/* ---- THE CONFIRM IS A CLICK, NOT A TYPING TASK ----
 * "the model should offer a button to click to approve, or just do that step."
 * The pause stays; confirming is one button, and "go" rides the one-shot skip. */
const RSRC = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
check("a plan-confirm message renders a Go button (one click, no typing)",
    RSRC.includes("meta.planConfirm") && RSRC.includes("Go — build it"));
check("...and clicking Go sends \"go\", riding the same one-shot skip a typed go always did",
    /composer\.value = "go";\s*sendMessage\(\);/.test(RSRC));
check("...with an Adjust affordance so changing the plan is offered too",
    RSRC.includes("Adjust") && RSRC.includes("or type a change below"));
check("the plan states the STEPS it will take, not a restatement of the request",
    SRC.includes("STEPS YOU WILL TAKE") && SRC.includes("Do NOT restate the request"));
check("the plan wording points at the button, not a typed confirmation",
    SRC.includes("Click **Go** to build it"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
