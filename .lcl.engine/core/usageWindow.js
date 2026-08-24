/**
 * THE SUBSCRIPTION METER — spend, measured the way OpenCode GO meters it.
 *
 * From the plan's own literature (opencode.ai/docs/go): GO is a $10/month
 * subscription ($5 the first month) to 18 open coding models — GLM-5.2 among
 * them, a model this operator currently pays per-token for — and its limits
 * are DOLLAR-VALUED, IN THREE TIERS AT ONCE:
 *
 *     "$12 of usage"  per 5-hour window
 *     "$30 of usage"  weekly
 *     "$60 of usage"  monthly
 *     "Limits are defined in dollar value. This means your actual request
 *      count depends on the model you use."
 *
 * At a limit the free models keep working, and "Use balance" can fall back to
 * Zen balance instead of blocking. So the meter tracks all three tiers and
 * the one closest to its ceiling is the one that matters right now.
 *
 * The docs do NOT publish the windows' reset semantics. The model used here —
 * a window OPENS at the first billed use after the previous one closed, and
 * CLOSES its span later — is the standard session-window behaviour and is
 * stated here so nobody mistakes it for something the literature promised.
 *
 * Everything is computed from the COST LEDGER — the rows the app already
 * writes for every billed generation — so the meter can never disagree with
 * Spend. The tier budgets default to GO's published numbers and stay
 * editable, because plans change and the operator's console is the truth.
 *
 * Pure: rows in, facts out. No fs, no electron, testable in plain node.
 */

/** GO's published limits — the defaults, not a guess. */
const GO_TIERS = [
    { key: "h5", label: "5h", hours: 5, budgetUsd: 12 },
    { key: "week", label: "wk", hours: 7 * 24, budgetUsd: 30 },
    { key: "month", label: "mo", hours: 30 * 24, budgetUsd: 60 }
];

const HOURS = 5;
const HOUR_MS = 3_600_000;

/**
 * Billed activity is what a subscription meters — a $0 local row costs the
 * plan nothing and must not open or extend a window.
 *
 * THE TEST FOR THAT WAS `usd > 0`, AND IT WAS THE WRONG TEST.
 *
 * It is a PROXY for "somebody else's machine answered this", and the proxy
 * fails for exactly the plan this file exists to meter. A GO row is written
 * with usd: 0 — not because it was free, but because nobody knows the price:
 * tokenCost ships rates for four DeepSeek models, the catalogue scraper reads
 * DeepInfra's pricing shape which OpenCode does not publish, and the
 * self-healing path keys on a DeepInfra-only usage field. So rateFor returns
 * null, actualCost returns null, the caller coerces it to 0, and every single
 * GO row was filtered out here.
 *
 * The meter then reported, forever and with total confidence:
 *
 *     5h $0/$12 · wk $0/$30 · mo $0/$60 · no open window
 *
 * which is the operator's report word for word: "there is no 5 hour context
 * window and no rates."
 *
 * A window is opened by USE, not by a known price. The token counts on a GO
 * row are real even when its dollars are not, and a five-hour window that
 * knows it has been used but not yet how much is a true statement; one that
 * says "no open window" while the plan is being spent is not. So the filter
 * asks the fact — was this the user's own hardware — instead of the proxy.
 */
function billed(rows) {
    return (Array.isArray(rows) ? rows : [])
        .filter(r => {
            if (!r || !Number.isFinite(Number(r.at))) return false;
            // the user's own machine costs the plan nothing, whatever
            // else is true of the row
            if (r.localNode === true) return false;
            // ...and anything that reached somebody else counts: a priced row
            // by its price, an unpriced one by the fact that it happened
            return Number(r.usd) > 0
                || Number(r.inputTokens) > 0 || Number(r.outputTokens) > 0;
        })
        .sort((a, b) => a.at - b.at);
}

/**
 * Walk the ledger into consecutive windows. Each window is anchored at the
 * first billed row after the previous window closed — the way a session-style
 * plan actually behaves — never at a fixed clock boundary.
 */
function windows(rows, { hours = HOURS } = {}) {
    const out = [];
    let win = null;
    for (const r of billed(rows)) {
        if (!win || r.at >= win.end) {
            win = { start: r.at, end: r.at + hours * HOUR_MS,
                    usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
            out.push(win);
        }
        win.usd += Number(r.usd) || 0;
        win.inputTokens += Number(r.inputTokens) || 0;
        win.outputTokens += Number(r.outputTokens) || 0;
        win.calls++;
    }
    return out;
}

/**
 * The one readout the UI shows.
 *
 * @returns {{
 *   active: boolean,        // a window is open right now
 *   start, end,             // ms epochs of the current window (when active)
 *   resetsInMs,             // time until it closes (when active)
 *   usd, inputTokens, outputTokens, calls,   // consumed THIS window
 *   budgetUsd,              // the operator's ceiling, or null = not told yet
 *   pct                     // usd/budget as 0..100+, or null without a budget
 * }}
 */
function describe(rows, { hours = HOURS, budgetUsd = null, now = Date.now() } = {}) {
    const all = windows(rows, { hours });
    const cur = all.find(w => now >= w.start && now < w.end) || null;
    const budget = Number.isFinite(Number(budgetUsd)) && Number(budgetUsd) > 0
        ? Number(budgetUsd) : null;
    if (!cur) {
        // between windows: nothing is being consumed, and the next window
        // opens whenever the next billed call happens — that is a fact about
        // the plan, not a zero to hide
        return { active: false, start: null, end: null, resetsInMs: null,
                 usd: 0, inputTokens: 0, outputTokens: 0, calls: 0,
                 budgetUsd: budget, pct: budget ? 0 : null, hours };
    }
    return {
        active: true,
        start: cur.start, end: cur.end,
        resetsInMs: cur.end - now,
        usd: +cur.usd.toFixed(5),
        inputTokens: cur.inputTokens, outputTokens: cur.outputTokens,
        calls: cur.calls,
        budgetUsd: budget,
        pct: budget ? Math.round((cur.usd / budget) * 1000) / 10 : null,
        hours
    };
}

/** "resets in 3h 12m" — the words the strip prints. */
function resetsWords(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "resets now";
    const h = Math.floor(ms / HOUR_MS);
    const m = Math.ceil((ms - h * HOUR_MS) / 60_000);
    return "resets in " + (h > 0 ? `${h}h ${m}m` : `${m}m`);
}

/**
 * All tiers at once, plus which one is TIGHTEST — the highest share of its
 * ceiling, which is the number the operator is actually living against.
 */
function describeAll(rows, { tiers = GO_TIERS, now = Date.now() } = {}) {
    const out = tiers.map(t => ({
        key: t.key, label: t.label,
        ...describe(rows, { hours: t.hours, budgetUsd: t.budgetUsd, now })
    }));
    const gauged = out.filter(t => t.active && t.pct !== null);
    const tightest = gauged.length
        ? gauged.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
    return { tiers: out, tightest: tightest ? tightest.key : null };
}

/* THE FIVE-HOUR WORK RING, FILLED BY TOKENS — NOT THE CLOCK.
 *
 * "the 5 hour context, that is in the mode where there is no provider
 *  controlling it, [should be] much more conservative about the percentage on
 *  the gauge. it fills up too fast. it should be based on a million context
 *  window, not turns, and that should be input tokens. then it should also be
 *  based on a million output tokens, so we can average that into a percentage
 *  for the default mode for the 5 hour context, not to interfere where a
 *  provider actually uses it... i think it is too liberal right now."
 *
 * The old WORK ring filled with TIME ELAPSED, so it reached 100% just for
 * leaving the app open five hours. A five-hour session holds a great deal of
 * work, so the denominators are deliberately large: one million input tokens
 * and one million output tokens, each read as its own share of full, then
 * averaged. Normal work sits low on this — the conservative reading asked for.
 * This applies ONLY to the planless/WORK ring; a provider with a real ceiling
 * (GO's $12/5h) keeps its own gauge, untouched, so this never interferes where
 * a provider actually meters the window.
 */
const WORK_INPUT_BUDGET = 1_000_000;
const WORK_OUTPUT_BUDGET = 1_000_000;
function workWindowPct(work, { inputBudget = WORK_INPUT_BUDGET, outputBudget = WORK_OUTPUT_BUDGET } = {}) {
    const inTok = Math.max(0, Number(work && work.inputTokens) || 0);
    const outTok = Math.max(0, Number(work && work.outputTokens) || 0);
    // each ceiling read on its own, capped at full, then averaged — so blowing
    // through one does not hide behind an empty other, but neither dominates
    const inPct = Math.min(100, (inTok / inputBudget) * 100);
    const outPct = Math.min(100, (outTok / outputBudget) * 100);
    return { inPct, outPct, pct: (inPct + outPct) / 2, inputBudget, outputBudget };
}

module.exports = { HOURS, GO_TIERS, windows, describe, describeAll,
                   resetsWords, billed, workWindowPct, WORK_INPUT_BUDGET, WORK_OUTPUT_BUDGET };
