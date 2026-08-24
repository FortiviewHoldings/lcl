/**
 * LAUNCH BEHAVIOUR — what the app does, and says, on a remote-driven start.
 *
 * A defect once made every launch greet the user with
 *   "deepseek-r1-distill-qwen-7b needs more free memory right now"
 * while the conversation was in fact running on a remote model that does not
 * care what fits locally. Three separate defects produced it, and each is
 * pinned here because each was invisible in review.
 *
 *   A. boot called engine.start() without asking whether a remote model was
 *      driving — the one automatic load path that skipped the check every
 *      other one performs. It planned, refused, and then loaded a 1.5B
 *      nobody would use, spending ~1.5 GB on a machine with 3.8 GB free.
 *   B. the renderer's boot-state reconstruction of that notice had no remote
 *      guard, so it fired on every launch even after A was fixed.
 *   C. needBytes charged the GPU floor against a CPU candidate the gate had
 *      judged with the CPU floor, so the Machine panel demanded 0.8 GB more
 *      than the real threshold while the sentence beside it named the other
 *      figure.
 */
const fs = require("fs");
const path = require("path");
const planner = require("../.lcl.engine/core/loadPlanner");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 220) : ""); }
}

const ROOT = path.join(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const engineSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "engine.js"), "utf8");

// ---- A: boot must ask ----
check("boot does not start the local engine when a remote model is driving",
    /if \(!engine\.remoteDriving\(\)\) engine\.start\(\{ allowFallback: true \}\)/.test(mainSrc));
check("engine exports remoteDriving so boot can ask it",
    /^\s*remoteDriving,/m.test(engineSrc.slice(engineSrc.indexOf("module.exports"))));
check("the other automatic loads still ask too (guard recovery, crash restart)",
    (engineSrc.match(/remoteDriving\(\)/g) || []).length >= 3);

// ---- B: the boot-state notice must be gated the same way the live one is ----
{
    const block = (appSrc.match(
        /A boot-time FALLBACK happened[\s\S]{0,700}?fallbackActive/) || [""])[0];
    check("the boot-state fallback notice bails when a remote model drives",
        /if \(remoteActive\(\)\) return;/.test(block), block.slice(-160));
}
check("the notice is said once per substitution, not once per launch",
    /fallbackNoticed/.test(appSrc));
check("the notice carries the action instead of describing it",
    /label: `Try \$\{wanted\} now`/.test(appSrc));

// ---- C: needBytes and the gate must agree on the floor ----
// A model far too large for the given memory, forced onto the CPU rung.
const bigEntry = {
    sizeBytes: 4.68e9, layers: 28, kvBytesPerToken: 57344, contextMax: 32768
};
const tight = planner.plan({
    modelPath: null, entry: bigEntry, gpuUsable: false,
    mem: { availableBytes: 3.85e9 }, reclaimBytes: 0
});
check("a 4.7 GB model is correctly refused at 3.85 GB free", tight.fits === false, tight);
// usableBytes + shortfallBytes IS the peak the gate measured against, so the
// floor baked into needBytes is exactly their difference from it. That
// difference must be the CPU floor — with the old code it was the GPU floor,
// 0.8 GB heavier, and this check fails by precisely that amount.
{
    const impliedFloor = tight.needBytes - (tight.usableBytes + tight.shortfallBytes);
    check("needBytes carries the CPU floor for a CPU candidate — the floor the " +
          "gate used, and the one the message names",
        Math.abs(impliedFloor - planner.OS_FLOOR_CPU_BYTES) < 2e6,
        { impliedFloor, cpuFloor: planner.OS_FLOOR_CPU_BYTES,
          gpuFloor: planner.OS_FLOOR_GPU_BYTES });
    check("and it is NOT the GPU floor, which is the bug this replaced",
        Math.abs(impliedFloor - planner.OS_FLOOR_GPU_BYTES) > 5e8, { impliedFloor });
}
check("the refusal message quotes the CPU floor it actually applied",
    /1\.4 GB kept for Windows/.test(tight.message || ""), tight.message);

// the same model DOES fit when the machine really has room — proves the
// refusal is about memory, not about the model being unloadable
const roomy = planner.plan({
    modelPath: null, entry: bigEntry, gpuUsable: false,
    mem: { availableBytes: 12e9 }, reclaimBytes: 0
});
check("the same model loads when the memory is genuinely there",
    roomy.fits === true, roomy.message || roomy);

console.log(`\n${pass}/${pass + fail} launch-notice checks passed`);
process.exit(fail ? 1 : 0);
