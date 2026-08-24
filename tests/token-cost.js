/**
 * WHAT WILL THIS COST, BEFORE I SEND IT.
 *
 * The rationale: output cost is unknowable until the
 * model answers, but INPUT cost is arithmetic — the characters exist and the rate
 * is known. That is the half that grows without bound on a long conversation, so
 * pinning it removes most of the anxiety for free.
 *
 * Four things are tested:
 *   1. the estimator is fast enough to run on every keystroke
 *   2. it CORRECTS ITSELF from the provider's real token counts
 *   3. shipped rates are labelled as shipped, and a user override wins
 *   4. output cost is never fabricated into a total
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-cost-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const tc = require(__dirname + "/../.lcl.engine/core/tokenCost.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}

/* ---- 1. the estimator ------------------------------------------------- */
{
    check("empty text is zero tokens", tc.estimateTokens("") === 0);
    check("a short line is a handful of tokens",
        tc.estimateTokens("hello world") >= 2 && tc.estimateTokens("hello world") <= 6,
        tc.estimateTokens("hello world"));
    // 4,000 characters of prose should land in the 900-1,300 range at ~3.6 c/t
    const prose = "the quick brown fox jumps over the lazy dog. ".repeat(90);
    const t = tc.estimateTokens(prose);
    check("4k characters of prose estimates near a thousand tokens",
        t > 900 && t < 1300, { chars: prose.length, tokens: t });

    // it must be fast enough to live on a keystroke
    const big = "x".repeat(200_000);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) tc.estimateTokens(big);
    const us = Number(process.hrtime.bigint() - t0) / 1000 / 2000;
    console.log(`\n  ${us.toFixed(2)} microseconds per estimate on 200k characters\n`);
    check("an estimate costs under 20 microseconds", us < 20, us);
}

/* ---- 2. self-correction from the provider's real counts --------------- */
{
    const M = "test-model-a";
    check("an unseen model uses the base ratio",
        tc.charsPerToken(M) === tc.BASE_CHARS_PER_TOKEN);

    // this model really tokenises at 2.9 chars/token
    tc.learnRatio(M, 2900, 1000);
    check("one real observation moves the ratio",
        Math.abs(tc.charsPerToken(M) - 2.9) < 0.01, tc.charsPerToken(M));
    check("and the estimate now matches reality",
        tc.estimateTokens("y".repeat(2900), M) === 1000,
        tc.estimateTokens("y".repeat(2900), M));

    // nonsense must be rejected rather than averaged in
    const before = tc.charsPerToken(M);
    tc.learnRatio(M, 100, 5000);            // 0.02 chars/token — impossible
    check("an impossible ratio is rejected, not averaged in",
        tc.charsPerToken(M) === before, tc.charsPerToken(M));
    tc.learnRatio(M, 100_000, 1);           // 100,000 chars/token — impossible
    check("the other direction is rejected too", tc.charsPerToken(M) === before);
    tc.learnRatio(M, 0, 0);
    check("zeroes are ignored", tc.charsPerToken(M) === before);

    // a second model learns independently
    tc.learnRatio("test-model-b", 4400, 1000);
    check("models learn independently",
        Math.abs(tc.charsPerToken("test-model-b") - 4.4) < 0.01
        && Math.abs(tc.charsPerToken(M) - 2.9) < 0.01);
}

/* ---- 3. rates: shipped, labelled, overridable ------------------------- */
{
    const r = tc.rateFor("deepseek-reasoner");
    check("a shipped rate is found", !!r && r.in > 0 && r.out > 0, r);
    check("and it says it is SHIPPED, not a live quote", r.source === "shipped", r.source);
    check("with the date it was recorded", !!r.asOf, r.asOf);

    check("an unknown model returns no rate rather than a guess",
        tc.rateFor("some-model-nobody-has-heard-of") === null);

    // the user's figure wins
    tc.setRate("deepseek-reasoner", { in: 0.14, out: 0.28 });
    const u = tc.rateFor("deepseek-reasoner");
    check("a user override wins over the shipped rate",
        u.in === 0.14 && u.out === 0.28 && u.source === "user", u);
    tc.setRate("deepseek-reasoner", null);
    check("clearing the override falls back to shipped",
        tc.rateFor("deepseek-reasoner").source === "shipped");

    // a rate the endpoint itself publishes beats shipped, loses to the user
    const e = tc.rateFor("deepseek-reasoner", { in: 0.9, out: 1.9 });
    check("an endpoint-published rate beats the shipped one",
        e.in === 0.9 && e.source === "endpoint", e);
    tc.setRate("deepseek-reasoner", { in: 0.1, out: 0.2 });
    check("but the user still wins over the endpoint",
        tc.rateFor("deepseek-reasoner", { in: 0.9, out: 1.9 }).source === "user");
    tc.setRate("deepseek-reasoner", null);
}

/* ---- 4. the number shown beside the composer -------------------------- */
{
    const est = tc.estimateCost("write me a checksum validator", "deepseek-reasoner",
                                { contextTokens: 8000 });
    check("typed tokens are counted", est.typedTokens > 0, est.typedTokens);
    check("conversation context is added in",
        est.inputTokens === est.typedTokens + 8000, est);
    check("input cost is a real number", est.inputUsd > 0, est.inputUsd);

    // THE POINT: output cost must NOT be folded into a total. The model has not
    // answered, so any total would be part fact and part fiction, and mixing
    // them destroys the half that was trustworthy.
    check("there is no fabricated total", est.total === undefined && est.totalUsd === undefined,
        Object.keys(est));
    check("output is quoted per 1k of reply instead",
        est.outputUsdPer1k > 0, est.outputUsdPer1k);
    check("the token count is flagged as an estimate", est.estimated === true);
    check("and the rate's provenance travels with it",
        est.rate.source === "shipped" && /shipped rate as of/.test(est.note), est.note);

    // an unknown model says so rather than showing $0
    const none = tc.estimateCost("hello", "mystery-model-9000");
    check("an unknown model shows no cost, not zero", none.inputUsd === null, none);
    check("and explains why", /no rate known/.test(none.note), none.note);

    // actual cost, after the fact
    const act = tc.actualCost("deepseek-reasoner",
        { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    check("actual cost uses the provider's own token counts",
        Math.abs(act.usd - (0.55 + 2.19)) < 0.001, act);
    check("and separates input from output",
        Math.abs(act.inputUsd - 0.55) < 0.001 && Math.abs(act.outputUsd - 2.19) < 0.001, act);

    // formatting stays readable at every magnitude
    check("sub-tenth-of-a-cent reads as such", tc.usd(0.0004) === "<$0.001", tc.usd(0.0004));
    check("cents read to three places", tc.usd(0.0412) === "$0.041", tc.usd(0.0412));
    check("dollars read to two", tc.usd(12.345) === "$12.35", tc.usd(12.345));
    check("zero is zero", tc.usd(0) === "$0");
}

/* =====================================================================
 * A NODE CALL COSTS $0 EVEN WHEN NOTHING COUNTED THE TOKENS.
 *
 * Ollama sends no `usage` block. cloudModels recorded `cost: null` in that
 * case — an UNKNOWN cost for hardware the user owns — so the
 * "$0 · your own hardware" line could not render and the money surfaces fell
 * through to a path that shows a figure for a call nobody was billed for.
 * MEASURED against a live node before the fix:
 *     localNode: true   usage: null   cost: null
 * =================================================================== */
{
    const free = tc.freeCost();
    check("freeCost() is a real $0, not an absence",
        free && free.usd === 0 && free.inputUsd === 0 && free.outputUsd === 0, free);
    check("...and it says WHERE the zero comes from — ownership, not arithmetic",
        !!free.rate && free.rate.source === "local-node" &&
        /your own hardware/i.test(free.rate.label || ""), free.rate);
    check("...and it admits nothing was counted, so no readout can claim token " +
          "numbers the server never sent",
        free.counted === false && free.inputTokens === 0 && free.outputTokens === 0, free);
    check("a node's rate is $0 per million in BOTH directions",
        (() => {
            const r = tc.rateFor("gemma3:27b", null, { localNode: true });
            return !!r && r.in === 0 && r.out === 0;
        })());
    check("...and cloudModels reaches for that $0 when usage is missing, rather " +
          "than recording null",
        (() => {
            const src = fs.readFileSync(
                path.join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"), "utf8");
            return /isNode \? tokenCost\.freeCost\(\) : null/.test(src);
        })());
}

/* =====================================================================
 * 5. SELF-HEALING RATES — the provider tells us what it actually charged.
 *
 * DeepInfra's response (confirmed on their API page) includes
 * `usage.estimated_cost` — a real dollar figure for that exact call. The
 * ledger was ignoring it and computing dollars from rate × tokens, so a
 * shipped rate that drifted from the provider's current price was never
 * corrected, and the "actual cost" was never the actual cost. The fix:
 * prefer the provider's `estimated_cost` when present, and back-derive the
 * per-token rate from it so the rate table heals over time.
 * =================================================================== */
{
    const M = "deepseek-reasoner";   // has a shipped rate in the table

    // a usage block WITH the provider's real cost, as DeepInfra returns it
    const usage = {
        prompt_tokens: 1_000_000,
        completion_tokens: 500_000,
        estimated_cost: 2.595      // real dollars for this exact call
    };
    const act = tc.actualCost(M, usage);
    check("when the provider returns estimated_cost, that IS the cost — not a " +
          "rate-table computation that may have drifted",
        act.usd === 2.595, act);
    check("...and it is labelled as the provider's figure, not the rate table's",
        act.source === "provider" || act.rate && /provider|actual/.test(act.rate.source || ""),
        act);

    // WITHOUT estimated_cost, the rate table is still used (the old behaviour)
    const noCost = tc.actualCost(M,
        { prompt_tokens: 1_000_000, completion_tokens: 500_000 });
    check("without estimated_cost, the rate table is still the source of dollars",
        noCost.usd !== 2.595 && noCost.usd > 0, noCost);

    // a node call: estimated_cost is irrelevant, $0 because the user owns it
    const nodeAct = tc.actualCost("gemma3:27b",
        { prompt_tokens: 100, completion_tokens: 50, estimated_cost: 0.01 },
        null, { localNode: true });
    check("a NODE call is $0 regardless of estimated_cost — the user owns the " +
          "hardware, the provider's figure does not override ownership",
        nodeAct.usd === 0, nodeAct);

    // SELF-HEALING: the rate learns from the real cost over time
    tc.learnRateFromActual && tc.learnRateFromActual(M, usage);
    check("learnRateFromActual back-derives a rate from the real cost + tokens, " +
          "so the rate table heals as the provider's prices are observed",
        (() => {
            const r = tc.rateFor(M);
            // learned rates read as source "endpoint" in rateFor (the existing
            // convention for rates observed from the endpoint, vs "shipped")
            return r && r.source === "endpoint" && r.in > 0;
        })(),
        tc.rateFor(M));

    // clean up the learned rate so it doesn't leak across sections
    tc.setRate(M, null);
}

try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }); }
catch { /* windows */ }
console.log(`\n${pass}/${pass + fail} token-cost checks passed`);
process.exit(fail ? 1 : 0);
