/**
 * The capability map is only worth publishing if it is TRUE.
 *
 * These checks bind the generated table to the real sources: every registry
 * model appears, every classified tool appears, and — the one that matters —
 * the memory arithmetic in the generator agrees with what the load planner
 * actually enforces. A published "RAM to run" figure that disagrees with the
 * planner's refusal is worse than no figure at all.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

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

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

const registry = JSON.parse(fs.readFileSync(
    path.join(ROOT, "models", "registry.json"), "utf8").replace(/^﻿/, ""));
const { TOOL_CLASS } = require(path.join(ROOT, ".lcl.engine", "policy", "classify.js"));

const md = execFileSync(process.execPath,
    [path.join(ROOT, "devtools", "capability-map.js")], { encoding: "utf8" });

// ---- completeness: nothing silently missing from the published map --------
const missingModels = registry.models.filter(m => !md.includes("`" + m.id + "`"));
check("every registry model appears in the map", missingModels.length === 0,
    missingModels.map(m => m.id));

const missingTools = Object.keys(TOOL_CLASS).filter(t => !md.includes("`" + t + "`"));
check("every classified tool appears in the map", missingTools.length === 0, missingTools);

check("the map states the offline guarantee", /never required/i.test(md));
// Check the warning is PRESENT and on-topic, not its exact wording — pinning
// prose makes every improvement to that prose look like a regression.
check("the map explains the integrated-graphics memory trap",
    /integrated/i.test(md) && /\b(RAM|memory)\b/i.test(md));
check("confirm-class tools are marked as asking first", /asks first/i.test(md));

// ---- the load-bearing claim: the numbers match the real planner ----------
const planner = require(path.join(ROOT, ".lcl.engine", "core", "loadPlanner.js"));
const json = JSON.parse(execFileSync(process.execPath,
    [path.join(ROOT, "devtools", "capability-map.js"), "--json"], { encoding: "utf8" }));

let agree = 0, disagree = [];
for (const entry of json.models) {
    if (!entry.needBytes8k) continue;               // not an LLM
    const model = registry.models.find(m => m.id === entry.id);
    // Give the planner exactly the memory the map claims is required, and it
    // must say yes. One byte less than a real requirement and it must say no.
    const at = (bytes) => planner.plan({
        modelPath: path.join(ROOT, "models", model.file),
        entry: model, mem: { availableBytes: bytes }, gpuUsable: 0
    });
    const ok = at(entry.needBytes8k);
    const tooLittle = at(entry.needBytes8k - 1.2e9);
    if (ok.fits && !tooLittle.fits) agree++;
    else disagree.push({ id: entry.id, claimed: entry.needBytes8k,
                         fitsAtClaimed: ok.fits, fitsWellBelow: tooLittle.fits });
}
check("published RAM figures agree with the load planner", disagree.length === 0, disagree);
check("at least the flagship and default were checked", agree >= 2, { agree });

// ---- the About box reports the same shape the renderer reads -------------
check("--json exposes a tool count", typeof json.toolCount === "number" && json.toolCount > 0);
check("--json exposes per-model context at 8GB",
    json.models.some(m => m.contextAt8GB === null || typeof m.contextAt8GB === "number"));

// ---- README stays in sync (the generator is the only writer) -------------
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
check("README contains the capability-map markers",
    readme.includes("<!-- CAPABILITY-MAP:START -->") && readme.includes("<!-- CAPABILITY-MAP:END -->"));
const block = (readme.match(/<!-- CAPABILITY-MAP:START -->([\s\S]*?)<!-- CAPABILITY-MAP:END -->/) || [])[1] || "";
check("README's map is current (re-run devtools/capability-map.js --write if this fails)",
    block.trim() === md.trim(), { readmeLen: block.trim().length, freshLen: md.trim().length });

console.log(`\n${pass}/${pass + fail} capability-map checks passed`);
process.exit(fail ? 1 : 0);
