/**
 * The utility router turns a natural-language request into a synthetic tool
 * call when a small model would otherwise fabricate the answer. These tests
 * exist for ONE reason: prove it does not fire on innocent prose (the
 * false-positive class a prior review flagged on the change-backstop).
 */
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 15600000, free: 5000000, swapTotal: 33000000, swapFree: 12000000 });
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => require("os").tmpdir() },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const agent = require(__dirname + "/../.lcl.engine/core/agent.js");
const TOOLS = { calculate: {}, system_stats: {}, process_list: {} };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail) : ""); }
}
const route = (t) => agent.routeToUtilityTool(t, TOOLS);

// ---- SHOULD route ----
const calc = [
    "compute 1234 * 5678", "what is 1234 * 5678", "1234*5678",
    "whats (100-20)*3?", "2^16 please", "give me 144 / 12"
];
for (const t of calc) {
    const r = route(t);
    check(`routes calc: "${t}"`, r && r.tool === "calculate", r);
}
check("calc value is verified, not guessed", route("what is 6 * 7").expect === 42);

const stats = [
    "how much memory is available?", "how's my machine doing?",
    "what's my ram usage", "is my computer slow right now", "cpu load?"
];
for (const t of stats) {
    const r = route(t);
    check(`routes stats: "${t}"`, r && r.tool === "system_stats", r);
}
const procs = [
    "what's running right now?", "which apps are using the most memory",
    "what should I close", "show me the heaviest processes"
];
for (const t of procs) {
    const r = route(t);
    check(`routes procs: "${t}"`, r && r.tool === "process_list", r);
}

// ---- MUST NOT route (the whole point) ----
const innocent = [
    "remember this for later",                       // 'member' substring trap
    "the memory of that trip is precious",           // 'memory' but not machine state
    "I have 2 cats and 3 dogs",                      // numbers, no operator
    "the year is 2026",                              // a bare number
    "write a poem about the number 42",              // number, no arithmetic
    "explain how RAM works",                         // topic, not a state query
    "what is machine learning",                      // 'machine' but not the box
    "list the top priorities for the project",       // 'top' but not processes
    "run the app and see what happens",              // 'running' verb, not query
    "summarize this document",                       // nothing
    "version 3.2 of the spec"                        // decimal, no operator
];
for (const t of innocent) {
    const r = route(t);
    check(`does NOT route: "${t}"`, r === null, r);
}

console.log(`\n${pass}/${pass + fail} util-router checks passed`);
process.exit(fail ? 1 : 0);
