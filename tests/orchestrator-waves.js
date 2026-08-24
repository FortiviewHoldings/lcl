/**
 * ORCHESTRATION CONCURRENCY — the driver decides the width.
 *
 * The requirement: the API and the GPU family of connected devices — whether
 * rented or owned — should all be orchestrated and handle concurrency well,
 * with local being the RAM hog that cannot. The orchestrator ran every plan
 * strictly one step at a time regardless of driver, which throws away the one
 * thing a node or an API is for, and these checks pin the fix.
 *
 * LOCAL MUST STAY 1. One llama-server holds one model resident; a second
 * concurrent generation is exactly the thing that takes a 15 GB laptop down.
 * That is the check that matters most here.
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 220) : ""); }
}

const SRC = path.join(__dirname, "..", ".lcl.engine", "core", "orchestrator.js");
const src = fs.readFileSync(SRC, "utf8");

// ---- the two pure functions, lifted out so this needs no engine ----
const grab = (name) => {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) return null;
    let depth = 0, started = false;
    for (let j = i; j < src.length; j++) {
        if (src[j] === "{") { depth++; started = true; }
        else if (src[j] === "}") { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
    }
    return null;
};
const srcWidth = grab("stepConcurrency"), srcWaves = grab("buildWaves");
check("stepConcurrency and buildWaves exist", !!srcWidth && !!srcWaves);

const make = (usingRemote, limits) =>
    new Function("router", `${srcWidth}\n${srcWaves}\nreturn { stepConcurrency, buildWaves };`)(
        { usingRemote: () => usingRemote, limits: () => limits });

if (srcWidth && srcWaves) {
    // ---- width by driver ----
    const local = make(false, { kind: "local" });
    check("LOCAL runs one step at a time — a second resident model is what " +
          "crashes the machine",
        local.stepConcurrency() === 1, local.stepConcurrency());

    const api = make(true, { kind: "remote" });
    check("an API is orchestrated with several steps in flight",
        api.stepConcurrency() > 1, api.stepConcurrency());

    const node = make(true, { kind: "remote", node: true });
    check("a NODE gets at least the API's width — it is the user's own hardware",
        node.stepConcurrency() >= api.stepConcurrency(), node.stepConcurrency());

    // ---- wave construction ----
    const steps = [
        { n: 1, after: [] }, { n: 2, after: [] }, { n: 3, after: [] },
        { n: 4, after: [1, 2] }, { n: 5, after: [4] }
    ];

    const seq = local.buildWaves(steps, 1);
    check("at width 1 every step is its own wave (identical to the old order)",
        seq.length === steps.length && seq.every(w => w.length === 1), seq.map(w => w.length));

    const par = node.buildWaves(steps, 4);
    check("independent steps share a wave",
        par[0].map(s => s.n).join(",") === "1,2,3", par.map(w => w.map(s => s.n)));
    check("a dependent step waits for what it declared",
        par[1].map(s => s.n).join(",") === "4" && par[2].map(s => s.n).join(",") === "5",
        par.map(w => w.map(s => s.n)));
    check("every step appears exactly once across the waves",
        par.flat().length === steps.length &&
        new Set(par.flat().map(s => s.n)).size === steps.length);

    // ---- the safety property: unknown dependencies degrade to sequential ----
    const unknown = [{ n: 1, after: null }, { n: 2, after: null }, { n: 3, after: null }];
    const uw = make(true, { kind: "remote", node: true }).buildWaves(unknown, 4);
    check("a plan with NO declared dependencies runs strictly in order, so this " +
          "can never make an existing plan less correct",
        uw.length === 3 && uw.every(w => w.length === 1), uw.map(w => w.map(s => s.n)));

    // ---- width is a ceiling, not a target ----
    const many = Array.from({ length: 9 }, (_, i) => ({ n: i + 1, after: [] }));
    const capped = node.buildWaves(many, 4);
    check("no wave exceeds the driver's width",
        capped.every(w => w.length <= 4), capped.map(w => w.length));

    // ---- a cycle or a forward reference cannot deadlock ----
    const cyclic = [{ n: 1, after: [2] }, { n: 2, after: [1] }];
    const cw = node.buildWaves(cyclic, 4);
    check("an impossible dependency set still yields every step rather than hanging",
        cw.flat().length === 2, cw.map(w => w.map(s => s.n)));
}

// ---- the plan schema and the merge contract ----
check("the planner is asked to declare dependencies",
    /\\"after\\" array/.test(src) && /AT THE SAME TIME/.test(src));
check("declared dependencies are sanitised to EARLIER steps only, so a model " +
      "cannot emit a forward reference or a cycle",
    /x >= 1 && x <= i/.test(src));
check("results are merged in PLAN order, not completion order",
    /merge in PLAN order/.test(src) && /for \(const r of settled\)/.test(src));
check("a step that throws cannot take the whole plan down",
    /\.catch\(err => \(\{ ok: false/.test(src));
check("waves stop when the turn is cancelled",
    /if \(settled\.some\(r => r && r\.cancelled\)\) break;/.test(src));
check("the transcript is safe: stepMode turns are read-only against the session",
    /READS session\.messages and never writes it/.test(src));

// and prove that claim against agent.js rather than trusting the comment
const agentSrc = fs.readFileSync(
    path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
check("agent.runTurn really does skip the transcript write in stepMode",
    /if \(!opts\.stepMode\) \{[\s\S]{0,200}session\.messages\.push/.test(agentSrc));

console.log(`\n${pass}/${pass + fail} orchestrator-waves checks passed`);
process.exit(fail ? 1 : 0);
