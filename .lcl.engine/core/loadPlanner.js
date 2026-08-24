const fs = require("fs");

/**
 * Decides whether a model can load on THIS machine right now, and with what
 * settings — before a single byte is allocated.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS WAS REWRITTEN (2026-07-29), measured, not reasoned:
 *
 * The first version planned against WORKING SET — weights x a peak factor, plus
 * KV, plus generous compute buffers — and refused anything it could not fit in
 * available physical RAM. On a 15.6 GB laptop with a browser open that math
 * refused every model except the 1.5B coder. Every session silently ran the
 * worst model in the box, and the answers were correspondingly bad. The planner
 * was not protecting the machine; it was quietly destroying the product.
 *
 * Measured, same prompt, qwen3-4b (2.5 GB of weights) on this laptop:
 *
 *     config            PRIVATE (committed)   working set   speed
 *     CPU      ngl=0           0.89 GB          2.54 GB      2.81 tok/s
 *     partial  ngl=18          1.87 GB          4.13 GB      4.22 tok/s
 *     full GPU ngl=99          2.90 GB          5.15 GB      7.93 tok/s
 *
 *     the OLD planner's verdict for all three: "needs 5.70 GB", REFUSED.
 *
 * WHAT WAS ACTUALLY WRONG — and what was not.
 *
 * The first attempt at this rewrite blamed mmap: llama.cpp maps the gguf, so
 * (the argument went) weight pages are evictable file cache and should not be
 * charged against free memory at all. That reasoning is wrong, and a live test
 * caught it before it shipped. Mapped pages that inference TOUCHES EVERY TOKEN
 * are active, not standby — Windows counts them in Available exactly like
 * anonymous memory. The plan that reasoning produced (ctx 16384, 27 of 36
 * layers) drove available memory under 900 MB on a real load and the watchdog
 * had to kill the server. Measure, then decide; the tidy explanation was a trap.
 *
 * The real defects were narrower:
 *   - COMPUTE BUFFERS were guessed 2-3x too high (0.45/0.70/1.10 GB against a
 *     measured ~0.29 GB), and that alone refused several models.
 *   - OFFLOAD WAS ALL-OR-NOTHING. A model 0.4 GB short of full GPU fell all the
 *     way to CPU, or was refused outright. There was no middle rung, and the
 *     middle is where this machine actually lives.
 *
 * The 1.9x GPU factor was right all along and is kept: an offloaded layer is
 * resident twice, once in the mapped file and once in the Vulkan allocation
 * that lives in the same physical RAM on an iGPU. That is the shape that
 * hard-froze this laptop with the 7B, and it stays unreachable.
 *
 * Two rules, unchanged in spirit:
 *   - Plan against AVAILABLE PHYSICAL memory, never commit (commit includes the
 *     page file, and a model paging against the page file IS the freeze).
 *   - Plan for the PEAK. The freeze happens during the load, not after.
 * ---------------------------------------------------------------------------
 */

// Windows needs this much AVAILABLE to keep the desktop responsive.
//
// This was a flat 2.2 GB and it made the app useless. Reported: a 4B refused
// with 5.2 GB free, short by 0.1 GB, leaving the 1.5B coder answering
// everything. The 2.2 GB was chosen after a FULL-GPU-OFFLOAD freeze of a 7B —
// weights copied into Vulkan allocations in shared RAM, roughly twice the
// weight size arriving at once. A CPU rung has no such spike: the file is
// mapped, pages arrive on demand, and the engine watchdog already kills below
// 1.15 GB. Charging a memory-mapped load for a GPU load's peak is what cost
// every good answer this app has given.
//
// Strict where the hazard is, honest where it is not.
const OS_FLOOR_GPU_BYTES = 2.2e9;   // the shape that froze this laptop
const OS_FLOOR_CPU_BYTES = 1.4e9;   // watchdog floor 1.15 GB + margin
const OS_FLOOR_BYTES = OS_FLOOR_GPU_BYTES;   // kept: callers import this name

// What one layer's weights cost in AVAILABLE memory, per byte of weight.
//
// The budget is AVAILABLE, and available tracks WORKING SET, not private bytes.
// A memory-mapped weight page that inference touches every token is resident and
// active — it is not sitting in evictable standby. So a first pass at this file
// that charged mmap'd layers nothing was wrong, and a live test caught it: the
// plan it produced (ctx 16384, 27 of 36 layers) drove available memory under
// 900 MB and the watchdog killed the server. Measured, not assumed:
//
//   ngl=0   ctx 8192   available dropped 2.66 GB   (weights 2.50)
//   ngl=18  ctx 4096   available dropped 4.13 GB
//   ngl=99  ctx 4096   available dropped 5.10 GB
//
// An offloaded layer is resident TWICE — once in the mapped file, once in the
// Vulkan allocation that lives in the same physical RAM on an iGPU. That is the
// 1.9, and it is the exact shape that hard-froze this laptop with the 7B. A
// CPU layer is resident once.
const GPU_RESIDENT_FACTOR = 1.9;
const CPU_RESIDENT_FACTOR = 1.0;

// Fallback when the registry does not know the model's KV geometry. Phi-3-mini's
// MEASURED figure (32 layers x 2 x 32 MHA heads x 96 dim x 2 bytes = 384 KB per
// token) — the worst real case in the registry. An unknown model must plan a
// smaller context, never a freeze.
const FALLBACK_KV_PER_TOKEN = 393216;

// Fallback layer count for partial offload when the registry is silent.
const FALLBACK_LAYERS = 32;

const MAX_CTX = 16384;
// Floor is 4096: the full tool prompt alone runs ~1,700 tokens, so a 2048
// window left a few hundred tokens for the entire conversation — a load that
// "succeeds" into uselessness. Better to refuse and say what to free.
const CTX_TIERS = [16384, 8192, 4096];

// The engine runs the KV cache at q8_0 (both halves, flash attention on —
// verified live on this build), so the fp16-derived kvBytesPerToken figures
// in the registry are halved here.
const KV_QUANT_FACTOR = 0.5;

// Fractions of the model's layers to try on the GPU, best first. The old
// planner offered only all-or-nothing, so a model 0.4 GB short of full offload
// fell all the way back to CPU — or, more often, was refused outright. Half the
// layers measured 1.5x CPU speed at two thirds of full-offload's memory.
const OFFLOAD_TIERS = [1.0, 0.75, 0.5, 0.25, 0];

/**
 * Scratch/compute buffers. Measured on this build rather than guessed: a 4B at
 * ctx 8192 on CPU held 0.89 GB private of which 0.60 GB was KV, leaving ~0.29 GB
 * of buffers. The previous figures (0.45 / 0.70 / 1.10 GB) were 2-3x high and
 * that alone refused several models.
 */
function computeBufferBytes(ctx) {
    if (ctx <= 4096) return 0.30e9;
    if (ctx <= 8192) return 0.40e9;
    return 0.60e9;
}

/**
 * What this configuration will actually cost in memory that CANNOT be evicted.
 *
 * @param offloadFraction 0..1 of the model's layers placed on the GPU
 */
function estimate(weightsBytes, kvPerToken, ctx, offloadFraction = 0) {
    const frac = Math.max(0, Math.min(1, offloadFraction));
    const kv = Math.round(kvPerToken * KV_QUANT_FACTOR) * ctx;
    const compute = computeBufferBytes(ctx);
    const onGpu = weightsBytes * frac * GPU_RESIDENT_FACTOR;
    const onCpu = weightsBytes * (1 - frac) * CPU_RESIDENT_FACTOR;
    const resident = Math.round(onGpu + onCpu + kv + compute);
    // Checked against every live measurement above:
    //   ngl=0  ctx 8192 -> predicts 3.50, measured 2.66  (conservative, safe)
    //   ngl=18 ctx 4096 -> predicts 4.23, measured 4.13  (within 2%)
    //   ngl=99 ctx 4096 -> predicts 5.35, measured 5.10  (within 5%)
    return {
        peakBytes: resident,
        residentBytes: resident,
        steadyBytes: resident,
        kvBytes: kv,
        computeBytes: compute,
        gpuWeightBytes: Math.round(onGpu),
        cpuWeightBytes: Math.round(onCpu)
    };
}

/**
 * Build a load plan.
 *
 * @param modelPath   path to the gguf (for a stat fallback on size)
 * @param entry       registry entry, may be null for user-picked files
 * @param mem         machine.memory() snapshot
 * @param gpuUsable   true when the selected build has a non-CPU accelerator
 * @param reclaimBytes memory the CURRENT engine will hand back when it stops
 *
 * Returns { fits: true, ctxSize, gpuLayers, accelerator, est, note }
 *      or { fits: false, message, needBytes, usableBytes, shortfallBytes }.
 */
function plan({ modelPath, entry, mem, gpuUsable, reclaimBytes = 0 }) {
    // Registry entries match by basename only, so a user-picked file that
    // happens to share a bundled model's name could carry the wrong size.
    // The disk is always consulted; the LARGER figure plans the load.
    let weights = (entry && entry.sizeBytes) || 0;
    if (modelPath) {
        try { weights = Math.max(weights, fs.statSync(modelPath).size); }
        catch { /* file gone; registry figure stands */ }
    }
    // a vision model's projector loads alongside the weights and costs the
    // same class of memory — plan for it or the gate lies by its size.
    if (weights && entry && entry.mmprojBytes) weights += entry.mmprojBytes + 0.3e9;
    if (!weights) {
        return { fits: false, message: "cannot size this model file", needBytes: 0,
                 usableBytes: 0, shortfallBytes: 0 };
    }

    const kvPerToken = (entry && entry.kvBytesPerToken) || FALLBACK_KV_PER_TOKEN;
    const nLayers = (entry && entry.layers) || FALLBACK_LAYERS;
    const ctxMax = Math.min((entry && entry.contextMax) || 4096, MAX_CTX);
    // The floor is charged per CANDIDATE, not once for the model, because a CPU
    // rung and a full-offload rung are different hazards.
    const usableFor = (frac) => mem.availableBytes + reclaimBytes
        - (frac > 0 ? OS_FLOOR_GPU_BYTES : OS_FLOOR_CPU_BYTES);
    const usable = usableFor(0);

    // Preference: LARGEST CONTEXT first, then the MOST layers on the GPU at
    // that context. Context outranks speed because the agent lives on it —
    // system prompt, tool results and file bodies — and a truncated window is
    // what used to eat writes. Within a context, more offload is strictly
    // better: measured 2.81 -> 4.22 -> 7.93 tok/s across the ladder.
    const candidates = [];
    let prevCtx = null;
    for (const tier of CTX_TIERS) {
        const ctx = Math.min(tier, ctxMax);
        if (ctx === prevCtx) continue;
        prevCtx = ctx;
        for (const frac of gpuUsable ? OFFLOAD_TIERS : [0]) {
            const layers = Math.round(nLayers * frac);
            // skip degenerate rungs: 0 layers is the CPU rung, already covered
            if (frac > 0 && layers === 0) continue;
            candidates.push({ ctx, frac, layers, est: estimate(weights, kvPerToken, ctx, frac) });
        }
    }

    for (const c of candidates) {
        if (c.est.peakBytes <= usableFor(c.frac)) {
            const full = c.frac >= 1;
            return {
                fits: true,
                ctxSize: c.ctx,
                // llama.cpp treats any number >= the layer count as "all"
                gpuLayers: full ? 99 : c.layers,
                accelerator: c.frac > 0 ? "gpu" : "cpu",
                offloadFraction: c.frac,
                layersOffloaded: full ? nLayers : c.layers,
                layersTotal: nLayers,
                est: c.est,
                weightsBytes: weights,
                note: c.frac === 0
                    ? "running on CPU: the lightest way to run, and the slowest"
                    : full
                        ? null
                        : `${c.layers} of ${nLayers} layers on the GPU — the rest run ` +
                          `from the memory-mapped file, which is why this fits`
            };
        }
    }

    // Nothing fits. Report against the CHEAPEST candidate so the shortfall is
    // the smallest amount of memory that would actually unblock the load.
    const cheapest = candidates.reduce((a, b) =>
        a.est.peakBytes <= b.est.peakBytes ? a : b);
    const shortfall = cheapest.est.peakBytes - usableFor(cheapest.frac);
    const gb = (n) => (n / 1e9).toFixed(1);
    // Name the term that actually dominates. The old message said "mostly the
    // 0.3 GB context cache" of a 3.1 GB total — a breakdown that contradicted
    // itself in the same sentence and destroyed trust in every number near it.
    const parts = [
        ["the model weights", cheapest.est.cpuWeightBytes + cheapest.est.gpuWeightBytes],
        ["the context cache", cheapest.est.kvBytes],
        ["compute buffers", cheapest.est.computeBytes]
    ].sort((a, b) => b[1] - a[1]);
    const biggest = parts[0];
    return {
        fits: false,
        // THE SAME FLOOR THE GATE USED. This charged the GPU floor (2.2 GB)
        // against a candidate the gate had judged with the CPU floor (1.4 GB),
        // so the Machine panel reported 7.30 GB needed while the real
        // threshold was 6.50 GB — and the message directly below it said
        // "1.4 GB kept for Windows". A number that contradicts its own
        // explanation is the exact failure the note above was written about.
        needBytes: cheapest.est.peakBytes
            + (cheapest.frac > 0 ? OS_FLOOR_GPU_BYTES : OS_FLOOR_CPU_BYTES),
        usableBytes: Math.max(0, usable),
        shortfallBytes: shortfall,
        message:
            `Not enough free memory. Even running entirely on the CPU this model ` +
            `needs about ${gb(cheapest.est.peakBytes)} GB — mostly ` +
            `${biggest[0]} at ${gb(biggest[1])} GB — plus ` +
            `${gb(OS_FLOOR_CPU_BYTES)} GB kept for Windows, and only ` +
            `${gb(mem.availableBytes + reclaimBytes)} GB is free. Close about ` +
            `${gb(shortfall)} GB of other apps and try again.`
    };
}

module.exports = {
    plan, estimate, OS_FLOOR_BYTES, OS_FLOOR_CPU_BYTES, OS_FLOOR_GPU_BYTES,
    // exported so tests can assert the ladder exists rather than restate it
    OFFLOAD_TIERS, CTX_TIERS, GPU_RESIDENT_FACTOR, CPU_RESIDENT_FACTOR
};
