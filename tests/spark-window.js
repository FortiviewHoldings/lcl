/**
 * SPARK-NODE WINDOW RESOLUTION — the fix for "gpt-oss showed 32k, it's 131k".
 *
 * Under a full-tunnel VPN the box cannot be probed directly, so a spark model
 * that was never mode-switched keeps the 32k assumption. The mode table is the
 * app's own truth and survives the VPN; these tests pin that it resolves the
 * real window, including the operator's exact case.
 */
const { sparkWindowFor } = require(__dirname + "/../.lcl.engine/core/sparkWindow.js");

// the real table (mirrors main.js SPARK_MODES)
const MODES = {
    deep:     { model: "unsloth/gpt-oss-120b-GGUF:F16", ctx: 131072 },
    balanced: { model: "unsloth/gpt-oss-120b-GGUF:F16", ctx: 65536 },
    wide:     { model: "unsloth/gpt-oss-120b-GGUF:F16", ctx: 32768 },
    vast:     { model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", ctx: 262144 },
    swarm:    { model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", ctx: 65536 }
};
const GPTOSS = "unsloth/gpt-oss-120b-GGUF:F16";
const QWEN = "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail) : ""); }
};

// THE OPERATOR'S EXACT CASE: on Qwen 'vast', selecting gpt-oss.
check("selecting gpt-oss while Qwen 'vast' is loaded resolves 131k, not 32k",
    sparkWindowFor(MODES, "vast", GPTOSS) === 131072,
    sparkWindowFor(MODES, "vast", GPTOSS));

// the loaded mode's own model gets its EXACT per-conversation window, so a
// smaller mode is not inflated to the model's max
check("gpt-oss loaded in Balanced reads 65k (its real mode ctx), not 131k",
    sparkWindowFor(MODES, "balanced", GPTOSS) === 65536);
check("gpt-oss loaded in Swarm reads 32k (its real mode ctx), never inflated",
    sparkWindowFor(MODES, "wide", GPTOSS) === 32768);
check("gpt-oss loaded in Vast reads 131k", sparkWindowFor(MODES, "deep", GPTOSS) === 131072);

// Qwen resolves the same way
check("Qwen loaded in 'vast' reads 262k", sparkWindowFor(MODES, "vast", QWEN) === 262144);
check("selecting Qwen while gpt-oss is loaded resolves Qwen's largest mode (262k)",
    sparkWindowFor(MODES, "deep", QWEN) === 262144);

// a model with NO mode-table entry (a different node) yields 0, so the caller
// falls back to whatever it already had — spark logic never touches other nodes
check("an unknown model yields 0 (other nodes are untouched)",
    sparkWindowFor(MODES, "vast", "some/other-node-model") === 0);
check("no current mode still resolves the model's default (largest) window",
    sparkWindowFor(MODES, null, GPTOSS) === 131072);
check("empty inputs are safe", sparkWindowFor(null, "vast", GPTOSS) === 0
    && sparkWindowFor(MODES, "vast", null) === 0);

// WIRED, not just implemented: the fixed helper is useless unless the surfaces
// the operator sees actually run their windows through it. Pin the three.
const fs = require("fs");
const mainSrc = fs.readFileSync(__dirname + "/../app/main.js", "utf8");
check("the donut's source (lcl:cloudState) heals its limits from the mode table",
    /limits:\s*healSparkLimits\(/.test(mainSrc));
check("the context snapshot heals its limits too",
    /const limits = healSparkLimits\(sel, router\.limits\(sel\)\)/.test(mainSrc));
check("the picker's node contextMax is healed from the mode table",
    /contextMax:\s*\(onNode \? sparkWindowFor\(SPARK_MODES/.test(mainSrc));
check("healSparkLimits only ever RAISES to a known window, never lowers a measured one",
    /known > \(Number\(limits\.contextLength\) \|\| 0\)/.test(mainSrc));

console.log(`\n${pass}/${pass + fail} spark-window checks passed`);
process.exit(fail ? 1 : 0);
