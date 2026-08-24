"use strict";
/**
 * THE REAL WINDOW OF A SPARK-NODE MODEL, FROM THE MODE TABLE.
 *
 * The bug, in the operator's words: "i switched to the gpt-oss model and the ui
 * said 256k -> 32k. its not 32k, its 131k."
 *
 * Why it happened: a spark node serves ONE model at a time, and the only place
 * the served window is stored is the mode-switch write. A model the operator
 * SELECTS but has not mode-switched into (gpt-oss, while Qwen is the loaded one)
 * has no stored window, so router.limits() falls to the 32k assumed floor. The
 * one thing that could heal it — measureNodeWindows, a probe of the node's
 * DIRECT address — is dark under a full-tunnel VPN, which is the operator's
 * normal state. So the assumption stuck and every window-derived surface (the
 * donut, the history budget, the output budget) read 32k.
 *
 * SPARK_MODES is the app's own source of truth for these windows, and it does
 * NOT depend on reaching the box, so it survives the VPN. Resolve the window
 * from it:
 *   - the LOADED mode's exact per-conversation ctx, for the model that mode
 *     serves (so a gpt-oss loaded in Balanced correctly reads 65k, not 131k)
 *   - otherwise the model's LARGEST known mode, which is what it opens at by
 *     default (gpt-oss => Vast/131k) — the honest answer to "the gpt-oss window"
 *     before it is loaded, and far better than a wrong 32k.
 *
 * Pure and table-driven, so a test can drive it: the caller passes the modes
 * table, the current mode key, and the model id.
 */
function sparkWindowFor(modes, currentMode, modelId) {
    if (!modes || !modelId) return 0;
    const cur = currentMode && modes[currentMode];
    if (cur && cur.model === modelId) return Number(cur.ctx) || 0;
    let best = 0;
    for (const k of Object.keys(modes)) {
        if (modes[k] && modes[k].model === modelId) {
            best = Math.max(best, Number(modes[k].ctx) || 0);
        }
    }
    return best;
}

module.exports = { sparkWindowFor };
