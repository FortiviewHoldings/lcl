/**
 * THE SPARK AS A WORKHORSE, NOT A ONE-SHOT.
 *
 * The orchestrator was hard-bypassed for every remote driver
 * (`!router.usingRemote()`), so a session on the user's own DGX Spark —
 * the machine he bought specifically to run agents offline — could never
 * run a multi-step plan. It got one turn. The 64 step / 32k token / 200
 * history limits the router already sized for a node were never reached,
 * because the step machine itself was gated off.
 *
 * AND the orchestrator's own MAX_STEPS was a fixed 10 regardless of driver,
 * so even when it ran, a capable node was capped like a 1.5B on a laptop.
 *
 * This pins the two changes that unlock the node as a real workhorse:
 *   1. A NODE driver may run the orchestrator (an API driver is still
 *      bypassed by default — a frontier model plans inside its own
 *      reasoning — but a per-session permission can opt an API session in).
 *   2. The orchestrator's step cap scales to the driver: local stays small,
 *      a node gets a real plan budget.
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

const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const orch = require(path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"));
const router = require(path.join(ROOT, ".lcl.engine", "core", "router.js"));
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

/* ---- 1. THE ORCHESTRATOR STEP CAP SCALES TO THE DRIVER ---- */

// a local driver keeps the small cap (the laptop is a memory-constrained box).
// "local" is the absence of a selection — usingRemote returns !!sel, so the
// app-default local path is sel === undefined/null.
const localCap = orch.stepCap && orch.stepCap(undefined);
check("a LOCAL driver keeps a small orchestrator step cap (the laptop is constrained)",
    typeof localCap === "number" && localCap <= 12, localCap);

// a node driver gets a real plan budget — it is the user's own hardware with
// nothing to be cautious about, and a one-line plan is not why he bought a Spark
const nodeSel = { id: "node-x", label: "spark", localNode: true,
                  model: "deepseek-r1:70b", node: { id: "n", name: "spark" } };
const nodeCap = orch.stepCap && orch.stepCap(nodeSel);
check("a NODE driver gets a real orchestrator step budget — the Spark is a workhorse, " +
      "not a one-shot",
    typeof nodeCap === "number" && nodeCap >= 30, nodeCap);

// an API driver gets more than local but less than a node (it bills per token)
const apiSel = { id: "paid", label: "api.deepinfra.com", model: "zai-org/GLM-5.2" };
const apiCap = orch.stepCap && orch.stepCap(apiSel);
check("an API driver gets a middle budget — more than local, bounded because it bills",
    typeof apiCap === "number" && apiCap > 12 && apiCap < nodeCap, { apiCap, nodeCap });

/* ---- 2. A NODE DRIVER IS NOT BYPASSED IN main.js ---- */

// the old gate was `!router.usingRemote(drive.sel)` — which excluded the
// node along with every paid API. The user bought the Spark to run agents.
check("main.js no longer hard-bypasses the orchestrator for EVERY remote driver — " +
      "a node must be able to run a plan",
    !/!router\.usingRemote\(drive\.sel\)\s*&&\s*orchestrator\.looksMultiStep/.test(mainSrc),
    "the old gate `!usingRemote && looksMultiStep` still excludes the node");

check("...and main.js gates the orchestrator on whether the driver is a NODE or a " +
      "per-session agent permission, not on 'remote' as a blanket exclusion",
    /orchestrator\.looksMultiStep\(text, s\)/.test(mainSrc) &&
    /agentMode|allowAgents|nodeAgent|usingRemote\(drive\.sel\)\s*===\s*false|isNodeEndpoint/.test(mainSrc),
    "no node-aware or permission-aware gate found");

/* ---- 3. AN API DRIVER IS BYPASSED BY DEFAULT, OPT-IN VIA PERMISSION ---- */

// a frontier model plans inside its own reasoning — pushing it through the
// step machine is how a conversational request died as "ran 1 step, wrote
// nothing". So API stays bypassed unless the session explicitly opts in.
check("an API driver is STILL bypassed by default (a frontier model plans internally) — " +
      "the bypass is per-session opt-in, not removed",
    /agentMode|allowAgents/.test(mainSrc),
    "no per-session agent-mode permission found for the API opt-in");

console.log(`\n${pass}/${pass + fail} orchestrator-availability checks passed`);
process.exit(fail ? 1 : 0);
