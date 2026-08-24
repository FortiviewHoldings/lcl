const paths = require("./paths");

/**
 * WHAT IS THIS GOING TO COST ME, BEFORE I SEND IT.
 *
 * The operator's point, and it is the right one: output cost cannot be known
 * until the model has answered, but INPUT cost can be known exactly as you type.
 * That is half the anxiety removed for free, and it removes the half that grows
 * without bound — a long conversation with a big workspace attached is where the
 * input side quietly becomes the expensive one.
 *
 * So three pieces:
 *
 *   1. A TOKEN ESTIMATOR fast enough to run on every keystroke. No network, no
 *      model, no tokeniser download. It has to be instant or it cannot live in
 *      the composer.
 *
 *   2. A RATE TABLE per model, with the shipped figures clearly marked as
 *      shipped — because a hardcoded price silently goes stale and a confidently
 *      wrong cost is worse than no cost at all — and a user override that wins.
 *
 *   3. SELF-CORRECTION. Every completed call comes back with the provider's own
 *      token counts. Comparing those against what was estimated gives the real
 *      characters-per-token ratio for that model, which is folded back in. The
 *      estimate starts as a heuristic and converges on the truth, the same way
 *      the ETA does.
 */

// Characters per token, before any model-specific learning. English prose runs
// near 4.0; source code, JSON and tables run nearer 2.8 because punctuation and
// identifiers fragment. 3.6 sits between them and is deliberately a little
// pessimistic — over-estimating a cost is the safe direction to be wrong in.
const BASE_CHARS_PER_TOKEN = 3.6;

// How fast the learned ratio moves toward a new observation.
const LEARN_ALPHA = 0.25;

const SETTINGS_RATES = "modelRates";        // user overrides, per model id
// Rates the ENDPOINT published about itself, learned at link time. Kept in a
// separate store from the user's overrides on purpose: relearning a catalogue
// must never quietly overwrite a number the user typed, and "where did this
// figure come from" has to stay answerable. Precedence in rateFor(): a local
// node's certain $0, then the user's number, then whatever the host says, then
// the shipped snapshot.
const SETTINGS_LEARNED_RATES = "endpointRates";
const SETTINGS_RATIOS = "modelTokenRatios"; // learned chars-per-token, per model

/**
 * Rates SHIPPED with the app, per million tokens, USD. Recorded from each
 * provider's public price list on 2026-07-29.
 *
 * These are a convenience, not a source of truth. Providers change prices and
 * this table cannot know that, so anything derived from it is labelled as an
 * estimate against a shipped rate, and the user can override any entry. Where a
 * provider publishes prices through its API (OpenRouter does), the live figure
 * wins over both.
 */
const SHIPPED_RATES = {
    "deepseek-chat":     { in: 0.27, out: 1.10, label: "DeepSeek V3" },
    "deepseek-reasoner": { in: 0.55, out: 2.19, label: "DeepSeek R1" },
    "deepseek-ai/DeepSeek-R1-Distill-Llama-70B": { in: 2.00, out: 2.00,
                                                   label: "R1 Distill 70B" },
    "deepseek-ai/DeepSeek-R1": { in: 3.00, out: 7.00, label: "DeepSeek R1 (Together)" }
};
const SHIPPED_RATES_AS_OF = "2026-07-29";

/* ------------------------------------------------------------- estimating */

/**
 * Estimate the token count of a string. Deliberately simple arithmetic — this
 * runs on every keystroke in the composer.
 *
 * Not a tokeniser. A tokeniser for the model you happen to have linked would
 * mean shipping and matching vocabularies for every provider, and would still be
 * wrong the moment you linked something new. A ratio that CORRECTS ITSELF from
 * the provider's own reported counts gets to the same place with none of that.
 *
 * @param text  what the user has typed (or the whole prompt being assembled)
 * @param modelId  so a model that has taught us its real ratio uses it
 */
function estimateTokens(text, modelId = null) {
    const s = String(text == null ? "" : text);
    if (!s) return 0;
    return Math.max(1, Math.round(s.length / charsPerToken(modelId)));
}

/** The ratio to use for a model: learned if we have it, base otherwise. */
function charsPerToken(modelId) {
    if (!modelId) return BASE_CHARS_PER_TOKEN;
    const learned = (paths.readSettings()[SETTINGS_RATIOS] || {})[modelId];
    return (learned && learned.ratio > 1.5 && learned.ratio < 8)
        ? learned.ratio : BASE_CHARS_PER_TOKEN;
}

/**
 * Fold a completed call's REAL token count back in, so the next estimate is
 * closer. Called with the characters that were actually sent and the provider's
 * own prompt_tokens.
 */
function learnRatio(modelId, chars, actualTokens) {
    if (!modelId || !(chars > 0) || !(actualTokens > 0)) return null;
    const observed = chars / actualTokens;
    // reject nonsense before it poisons the estimate — a ratio outside this
    // range means something other than tokenisation is going on
    if (observed < 1.5 || observed > 8) return null;
    const all = paths.readSettings()[SETTINGS_RATIOS] || {};
    const prev = all[modelId];
    const ratio = prev && prev.ratio
        ? prev.ratio * (1 - LEARN_ALPHA) + observed * LEARN_ALPHA
        : observed;
    all[modelId] = { ratio, samples: Math.min(((prev && prev.samples) || 0) + 1, 999) };
    paths.writeSettings({ [SETTINGS_RATIOS]: all });
    return { ratio, samples: all[modelId].samples };
}

/* ------------------------------------------------------------------ rates */

/**
 * A MODEL RUNNING ON HARDWARE YOU OWN COSTS NOTHING PER TOKEN.
 *
 * Not "no rate known" — that is the answer for a host whose price list we could
 * not read, and it reads as a gap in the app. This is a different fact and it is
 * a certainty: the tokens were produced by the user's own machine on the user's
 * own network, and no invoice exists anywhere for them.
 *
 * It outranks every other source deliberately, including the user's own
 * override. Node model ids collide with hosted ones — a Spark serving
 * `deepseek-r1:70b` or `deepseek-chat` would otherwise pick up a rate learned
 * from a paid catalogue and bill the user, on paper, for their own electricity.
 * A number invented that way is worse than no number.
 */
const FREE_RATE = { in: 0, out: 0, source: "local-node", label: "your own hardware" };

/**
 * The rate for a model, and WHERE IT CAME FROM. The source matters as much as
 * the number: a UI that cannot say "this is a shipped figure from July, not a
 * live quote" has no business showing a dollar sign.
 *
 * @param opts.localNode  the tokens come from a machine the user owns — $0, and
 *                        said as $0 rather than as an absence
 * @returns {{in:number, out:number,
 *            source:"local-node"|"user"|"endpoint"|"shipped", label?:string,
 *            asOf?:string} | null}
 */
function rateFor(modelId, endpointRates = null, opts = {}) {
    if (!modelId) return null;
    if (opts && opts.localNode) return { ...FREE_RATE };
    const user = (paths.readSettings()[SETTINGS_RATES] || {})[modelId];
    if (user && (user.in >= 0 || user.out >= 0)) {
        return { in: +user.in || 0, out: +user.out || 0, source: "user" };
    }
    if (endpointRates && (endpointRates.in >= 0 || endpointRates.out >= 0)) {
        return { in: +endpointRates.in || 0, out: +endpointRates.out || 0,
                 source: "endpoint" };
    }
    // what the host published about this model when it was linked
    const learned = (paths.readSettings()[SETTINGS_LEARNED_RATES] || {})[modelId];
    if (learned && (learned.in >= 0 || learned.out >= 0)) {
        return { in: +learned.in || 0, out: +learned.out || 0, source: "endpoint" };
    }
    const shipped = SHIPPED_RATES[modelId];
    if (shipped) {
        return { ...shipped, source: "shipped", asOf: SHIPPED_RATES_AS_OF };
    }
    return null;                 // unknown model: say nothing rather than guess
}

/** Set or clear a user override. Pass null to clear. */
function setRate(modelId, rate) {
    const all = paths.readSettings()[SETTINGS_RATES] || {};
    if (!rate) delete all[modelId];
    else all[modelId] = { in: Math.max(0, +rate.in || 0), out: Math.max(0, +rate.out || 0) };
    paths.writeSettings({ [SETTINGS_RATES]: all });
    return all[modelId] || null;
}

/**
 * Record what an endpoint says one of its models costs.
 *
 * Called once per model when an endpoint is linked. Returns true when it wrote
 * something, so the caller can report how much of a catalogue is now priced.
 *
 * It will NOT touch a model the user has priced by hand: their number is a
 * decision, and a relink is not a reason to discard it.
 */
/* The BULK form — one settings read and at most one write for a whole
 * catalogue. Linking OpenRouter ingests ~530 published prices at once; the
 * per-model form costs a read each and a write per new price, which is the
 * seedPresetRates stall measured before, times fifteen. */
function learnRates(pairs) {
    if (!Array.isArray(pairs) || !pairs.length) return 0;
    const settings = paths.readSettings();
    const user = settings[SETTINGS_RATES] || {};
    const all = { ...(settings[SETTINGS_LEARNED_RATES] || {}) };
    let changed = 0;
    for (const p of pairs) {
        if (!p || !p.id || user[p.id]) continue;          // the user's call wins
        const i = Number(p.in), o = Number(p.out);
        if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) continue;
        if (i > 10_000 || o > 10_000) continue;           // implausible = refused
        const prev = all[p.id];
        if (prev && Number(prev.in) === i && Number(prev.out) === o) continue;
        all[p.id] = { in: i, out: o };
        changed++;
    }
    if (changed) paths.writeSettings({ [SETTINGS_LEARNED_RATES]: all });
    return changed;
}

function learnRate(modelId, inRate, outRate) {
    if (!modelId) return false;
    const settings = paths.readSettings();
    if ((settings[SETTINGS_RATES] || {})[modelId]) return false;   // user's call wins
    const i = Number(inRate), o = Number(outRate);
    if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) return false;
    // A host quoting per-TOKEN rather than per-million would be off by a factor
    // of a million and produce a cost meter reading $2,600 for one message.
    // Refuse the implausible rather than display it.
    if (i > 10_000 || o > 10_000) return false;
    const all = { ...(settings[SETTINGS_LEARNED_RATES] || {}) };
    /* A WRITE THAT CHANGES NOTHING IS STILL A WRITE.
     *
     * This rewrote the whole settings file every time it was called, even when
     * the rate being stored was already there. Survivable while the only caller
     * was a catalogue refresh; a stall the moment a caller seeded a published
     * price table — thirty-five models, a read and a full JSON write each, on a
     * path the picker touches constantly. The app went unusable, and the entire
     * cost was re-stating facts it already knew.
     */
    const prev = all[modelId];
    if (prev && Number(prev.in) === i && Number(prev.out) === o) return false;
    all[modelId] = { in: i, out: o };
    paths.writeSettings({ [SETTINGS_LEARNED_RATES]: all });
    return true;
}

function allRates() {
    const settings = paths.readSettings();
    const user = settings[SETTINGS_RATES] || {};
    const learned = settings[SETTINGS_LEARNED_RATES] || {};
    const out = {};
    for (const [id, r] of Object.entries(SHIPPED_RATES)) {
        out[id] = { ...r, source: "shipped", asOf: SHIPPED_RATES_AS_OF };
    }
    // the host's own numbers outrank the snapshot shipped with the app
    for (const [id, r] of Object.entries(learned)) {
        out[id] = { in: r.in, out: r.out, source: "endpoint" };
    }
    for (const [id, r] of Object.entries(user)) {
        out[id] = { ...(out[id] || {}), in: r.in, out: r.out, source: "user" };
    }
    return out;
}

/* ------------------------------------------------------- what it will cost */

/**
 * The number that goes next to the composer while you type.
 *
 * INPUT cost is real: the tokens exist, the rate is known, so the figure is
 * arithmetic rather than a forecast. OUTPUT cost cannot be known — the model has
 * not answered — so it is given as a RANGE from the model's typical reply length,
 * clearly separated. Adding a made-up output figure to a real input figure and
 * presenting one total would destroy the only trustworthy half.
 *
 * @param text        what is being sent
 * @param modelId     which model
 * @param opts.contextTokens  tokens already in the conversation that will be resent
 * @param opts.endpointRates  live rates from the endpoint, if it publishes them
 * @param opts.localNode      the model runs on hardware the user owns
 */
function estimateCost(text, modelId, opts = {}) {
    const typed = estimateTokens(text, modelId);
    const context = Math.max(0, Math.round(opts.contextTokens || 0));
    const inputTokens = typed + context;
    const rate = rateFor(modelId, opts.endpointRates, { localNode: !!opts.localNode });

    const result = {
        typedTokens: typed,
        contextTokens: context,
        inputTokens,
        charsPerToken: charsPerToken(modelId),
        estimated: true,               // token count is an estimate, always
        rate,
        inputUsd: null,
        outputUsdPer1k: null,
        note: null
    };
    if (!rate) {
        result.note = "no rate known for this model — set one to see cost";
        return result;
    }
    result.inputUsd = (inputTokens / 1e6) * rate.in;
    // cost per thousand tokens of reply, so the user can scale it themselves
    // rather than being handed a fabricated total
    result.outputUsdPer1k = (1000 / 1e6) * rate.out;
    result.note = rate.source === "local-node"
        ? "your own hardware — no per-token cost, only the node's RAM"
        : rate.source === "shipped"
        ? `shipped rate as of ${rate.asOf} — override it if the provider has changed`
        : rate.source === "user" ? "your rate" : "rate from the endpoint";
    return result;
}

/**
 * Actual cost of a completed call, from the provider's own usage figures.
 *
 * TWO SOURCES OF TRUTH, IN ORDER:
 *   1. `usage.estimated_cost` — a real dollar figure some providers (DeepInfra
 *      confirmed) return for the exact call. When present, that IS the cost;
 *      the rate table is a forecast and may have drifted, so the provider's
 *      own number wins. This is the self-healing input: the rate table can
 *      be back-corrected from it (see learnRateFromActual).
 *   2. the rate table × the provider's token counts — the original path, and
 *      still the only path when the provider sends no dollar figure.
 *
 * @param opts.localNode  the model ran on hardware the user owns: the tokens are
 *                        real and go in the ledger, the dollars are a certain $0
 *                        (ownership beats any estimated_cost the node returns)
 */
function actualCost(modelId, usage = {}, endpointRates = null, opts = {}) {
    const rate = rateFor(modelId, endpointRates, { localNode: !!(opts && opts.localNode) });
    const inTok = usage.prompt_tokens || 0;
    const outTok = usage.completion_tokens || 0;

    // A NODE IS FREE BY OWNERSHIP, not by arithmetic. The user owns the
    // hardware; any estimated_cost a node returns is meaningless here.
    if (opts && opts.localNode) {
        return {
            inputTokens: inTok, outputTokens: outTok,
            inputUsd: 0, outputUsd: 0, usd: 0, rate
        };
    }

    // THE PROVIDER TOLD US THE REAL COST. Prefer it over the rate table —
    // the table is a forecast that drifts; this is the actual charge.
    const est = Number(usage && usage.estimated_cost);
    if (isFinite(est) && est > 0) {
        // split proportionally to the rate's in/out ratio, so the per-token
        // readouts still carry honest numbers rather than dumping the whole
        // figure into one bucket. If there's no rate at all, attribute to
        // input (the known quantity).
        const totalTok = inTok + outTok;
        let inUsd, outUsd;
        if (rate && totalTok > 0) {
            const inShare = (inTok / totalTok) * rate.in;
            const outShare = (outTok / totalTok) * rate.out;
            const denom = inShare + outShare || 1;
            inUsd = est * (inShare / denom);
            outUsd = est * (outShare / denom);
        } else {
            inUsd = est; outUsd = 0;
        }
        return {
            inputTokens: inTok, outputTokens: outTok,
            inputUsd: inUsd, outputUsd: outUsd, usd: est,
            rate: rate ? { ...rate, source: "provider" } : { source: "provider" },
            source: "provider", providerCost: true
        };
    }

    if (!rate) return { inputTokens: inTok, outputTokens: outTok, usd: null, rate: null };
    return {
        inputTokens: inTok, outputTokens: outTok,
        inputUsd: (inTok / 1e6) * rate.in,
        outputUsd: (outTok / 1e6) * rate.out,
        usd: (inTok / 1e6) * rate.in + (outTok / 1e6) * rate.out,
        rate
    };
}

/**
 * SELF-HEALING: back-derive the per-token rate from the provider's real cost.
 *
 * DeepInfra (confirmed) returns `estimated_cost` per call. Over time, that
 * figure lets the rate table correct itself: if the shipped rate says $0.75
 * in but the provider is really charging $0.80, the observed costs will
 * reveal it. This derives the implied in/out rates from one observation and
 * learns them as a "provider" rate — which sits below a user override and
 * above the shipped default, exactly like an endpoint-published rate.
 *
 * Conservative on purpose: a single observation is noisy, so it is weighted
 * lightly; the rate moves toward the observed price, it does not jump to it.
 */
/* WHERE A PROVIDER PUTS THE COST IT JUST CHARGED.
 *
 * `estimated_cost` is DeepInfra's name for it, and it was the only name this
 * looked for — so self-healing worked for exactly one vendor. "THE COST SHOULD
 * BE SELF HEALING, LIKE THE OTHER API FOR DEEP INFRA."
 *
 * These are the field names the OpenAI-compatible ecosystem actually uses for
 * the same fact. Anything not on this list is still unknown rather than
 * guessed — the point is to notice a number the provider volunteered, never to
 * invent one it did not.
 */
const COST_FIELDS = ["estimated_cost", "total_cost", "cost", "cost_usd",
                     "usd", "charge", "total_charge"];

/** The cost a provider reported for a turn, wherever it chose to put it. */
function reportedCost(usage) {
    if (!usage || typeof usage !== "object") return NaN;
    for (const k of COST_FIELDS) {
        const v = Number(usage[k]);
        if (isFinite(v) && v > 0) return v;
    }
    // ...and one level down, which is where several vendors nest it
    for (const nest of ["cost", "billing", "pricing"]) {
        const o = usage[nest];
        if (!o || typeof o !== "object") continue;
        for (const k of COST_FIELDS.concat(["total"])) {
            const v = Number(o[k]);
            if (isFinite(v) && v > 0) return v;
        }
    }
    return NaN;
}

function learnRateFromActual(modelId, usage = {}) {
    const inTok = usage.prompt_tokens || 0;
    const outTok = usage.completion_tokens || 0;
    const est = reportedCost(usage);
    if (!isFinite(est) || est <= 0 || (inTok + outTok) <= 0) return null;
    // implied dollars per million tokens, split by the token ratio
    const totalTok = inTok + outTok;
    const impliedIn = (est * (inTok / totalTok)) / (inTok / 1e6 || 1);
    const impliedOut = (est * (outTok / totalTok)) / (outTok / 1e6 || 1);
    if (!isFinite(impliedIn) || !isFinite(impliedOut)) return null;
    // sanity: a negative or absurdly large implied rate is noise, not a rate
    if (impliedIn < 0 || impliedOut < 0 || impliedIn > 1000 || impliedOut > 1000) return null;
    // learnRate stores under the learned bucket; rateFor reads it back as
    // source "endpoint", which is honest — it IS a rate observed from the
    // endpoint's actual charges, not the shipped snapshot.
    const ok = learnRate(modelId, impliedIn, impliedOut);
    return ok ? { in: impliedIn, out: impliedOut, source: "endpoint" } : null;
}

/**
 * A CALL TO HARDWARE THE OPERATOR OWNS, WHEN NOTHING COUNTED THE TOKENS.
 *
 * Ollama returns no `usage` block, so actualCost has nothing to weigh and the
 * caller used to record `null` — an UNKNOWN cost for a machine that is free by
 * definition. The distinction is the whole complaint: a null reads as "we do
 * not know what this cost you", which is how a $0 call ends up looking billed.
 * Token counts stay zero because they were genuinely not reported; the dollars
 * are zero because it is his own machine.
 */
function freeCost() {
    return {
        inputTokens: 0, outputTokens: 0,
        inputUsd: 0, outputUsd: 0, usd: 0,
        rate: { ...FREE_RATE },
        counted: false          // the $0 is from ownership, not from arithmetic
    };
}

/** "$0.0041", "$1.23", "under a tenth of a cent" — readable at any magnitude. */
function usd(n) {
    if (n === null || n === undefined || !isFinite(n)) return "";
    if (n === 0) return "$0";
    if (n < 0.001) return "<$0.001";
    if (n < 1) return "$" + n.toFixed(3);
    return "$" + n.toFixed(2);
}

module.exports = {
    reportedCost, COST_FIELDS,
    estimateTokens, charsPerToken, learnRatio,
    rateFor, setRate, learnRate, learnRates, learnRateFromActual, allRates,
    estimateCost, actualCost, freeCost, usd,
    SHIPPED_RATES, SHIPPED_RATES_AS_OF, BASE_CHARS_PER_TOKEN
};
