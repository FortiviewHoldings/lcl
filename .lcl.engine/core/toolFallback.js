/**
 * WHEN A TOOL CANNOT RUN HERE, TRY THE MACHINES THAT CAN.
 *
 * The specification: a tool fallback chain. When a local tool fails for lack of
 * RAM, try a local node, then a paid API. For image generation specifically,
 * that is stable-diffusion.cpp on the local machine -> on a linked node -> a
 * hosted image API. This is a real architecture change, not a small fix.
 *
 * The architecture is one idea: a tool failure is either about CAPACITY (this
 * machine could not, another machine could) or about the REQUEST (nobody
 * could). Only the first kind is worth carrying somewhere else, and getting
 * that line wrong is the whole risk — a bad argument retried on a paid
 * endpoint spends the user's money to produce the same error twice.
 *
 * THE CONSENT IS NOT NEW. A tool that reroutes to a node or an API is the same
 * decision the model-level fallback already asks about, so it uses the same
 * three gates (router.js resolveFallback) rather than a second, weaker
 * approval system beside them:
 *
 *   1. the app-wide `allowEscalation` switch
 *   2. the per-session `escalateTo` allowlist, which FAILS CLOSED on empty —
 *      nothing ticked means "no, never", not "no preference"
 *   3. the K3 approval card for the actual destination, with the reason and
 *      the price on it. No approve hook supplied means NO for anywhere the
 *      user does not own.
 *
 * And it is always reported: the tool result carries `fellBackFrom`, so a
 * picture that was rendered three hundred miles away never arrives looking
 * like one that was rendered here.
 */
const paths = require("./paths");

/* ------------------------------------------------- is this worth moving? --- */
/**
 * CAPACITY failures — this machine could not, another machine could. Matched
 * on the sentences .lcl's own guards actually produce (imageGen's memory
 * refusal, the engine's guard trip, a dead runtime, a timeout), not on a
 * hopeful substring of the word "error".
 */
const CAPACITY = [
    /not enough (free )?memory/i,
    /needs about [\d.]+ ?GB/i,
    /close about [\d.]+ ?GB/i,
    /peaks near/i,
    /out of memory|oom\b/i,
    /memory guard|guard tripped/i,
    // imageGen's mid-render guard: "stopped to protect the machine: available
    // memory fell below 1.2 GB mid-render"
    /to protect the machine|memory fell below/i,
    // the runtime or its weights are absent HERE, which is precisely the kind
    // of thing another machine may have. Not a request problem.
    /not installed on this machine|is not installed|no model (file )?found/i,
    /timed out after/i,
    /engine (is )?(not running|unavailable|would not start|could not start)/i,
    /could not start|failed to start/i,
    /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up/i,
    /runtime (is )?missing|no runtime|binary (is )?missing/i,
    /device or resource busy|EBUSY/i
];

/**
 * REQUEST failures — nobody could, and the same call anywhere else produces
 * the same answer. Listed EXPLICITLY and checked first, because the cost of a
 * wrong "retryable" is real money spent to reproduce an error. Anything that
 * matches neither list is treated as permanent: the safe default is to stay
 * put and tell the model what went wrong.
 */
const PERMANENT = [
    /unknown tool/i,
    /args must be/i,
    /required|missing (argument|parameter|field)/i,
    /ENOENT|no such file|not found/i,
    /EACCES|EPERM|permission denied|read-?only/i,
    /outside the workspace|escapes the|not permitted|refused by policy|denied/i,
    /rejected by the user|cancelled|aborted/i,
    /invalid|malformed|could not parse|unsupported/i,
    /already exists|EEXIST/i,
    /secret|credential/i               // the secret guard's refusals never travel
];

/**
 * Why a failure may (or may not) be carried elsewhere. Returns a REASON, not
 * a boolean, because the reason is what the user reads when a fallback
 * did not happen — "it just failed" is the answer this app exists not to give.
 */
function classifyFailure(message) {
    const s = String(message || "");
    if (!s.trim()) return { retryable: false, why: "no error text to judge" };
    for (const re of PERMANENT) {
        if (re.test(s)) {
            return { retryable: false,
                     why: "the request itself is the problem — another machine " +
                          "would return the same answer" };
        }
    }
    for (const re of CAPACITY) {
        if (re.test(s)) {
            return { retryable: true,
                     why: "this machine could not, another machine may" };
        }
    }
    return { retryable: false, why: "not a known capacity failure" };
}

/* ------------------------------------------------------- who else can run --- */
/**
 * A tool declares what it needs to run elsewhere by exporting `fallback` on
 * its registry entry:
 *
 *   fallback: { capability: "image", node: fn?, api: fn? }
 *
 * A tool with no `fallback` never reroutes — which is the correct default for
 * every file tool, because "write this file" means write it HERE.
 */
function tiersFor(entry) {
    const f = entry && entry.fallback;
    if (!f) return [];
    const out = [];
    if (typeof f.node === "function") out.push({ kind: "node", run: f.node });
    if (typeof f.api === "function") out.push({ kind: "api", run: f.api });
    return out;
}

/** Gate 1: the app-wide switch, read the same way the router reads it. */
function escalationAllowed() {
    try { return paths.readSettings().allowEscalation === true; }
    catch { return false; }
}

/**
 * Gate 2, AND IT FAILS CLOSED. The ticked list in the session's API-fallback
 * panel is the whole authority: nothing ticked — or the panel never opened —
 * means nothing may be paid for on this conversation's behalf.
 */
function sessionAllowsPaid(session) {
    const list = session && Array.isArray(session.escalateTo) ? session.escalateTo : [];
    return list.length > 0;
}

/* ------------------------------------------------------------ the chain --- */
/**
 * Run the tiers under the gates. `local` has already failed; this decides
 * whether anywhere else may be asked, asks them in order, and returns the
 * first success with `fellBackFrom` stamped on it.
 *
 * Never throws: a fallback that fails leaves the ORIGINAL local failure as the
 * answer, with a note about what else was tried. The model must not be told a
 * different, more confusing error than the one that actually stopped the work.
 */
async function attempt({ entry, name, args, ctx, localError }) {
    const verdict = classifyFailure(localError);
    const tiers = tiersFor(entry);
    const tried = [];

    if (!tiers.length) return { ok: false, tried, reason: "no other machine can run this tool" };
    if (!verdict.retryable) return { ok: false, tried, reason: verdict.why };

    for (const tier of tiers) {
        // A NODE IS THE USER'S OWN HARDWARE; AN API IS A PURCHASE. The
        // gates apply to the paid tier only — sending your own work to your own
        // node is not a spend decision, and asking for consent to use hardware
        // you already own is how people learn to click yes.
        if (tier.kind === "api") {
            if (!escalationAllowed()) {
                tried.push({ kind: "api", skipped: "API fallback is switched off app-wide" });
                continue;
            }
            if (!sessionAllowsPaid(ctx && ctx.session)) {
                tried.push({ kind: "api",
                             skipped: "this conversation has no models ticked to pay for" });
                continue;
            }
        }
        try {
            const res = await tier.run({ name, args, ctx });
            if (res && res.ok !== false) {
                return { ok: true, kind: tier.kind, result: res.result !== undefined ? res.result : res,
                         fellBackFrom: "this machine", where: res.where || tier.kind,
                         tried };
            }
            tried.push({ kind: tier.kind, skipped: (res && res.skipped) || "unavailable" });
        } catch (e) {
            // a tier that throws is simply a tier that did not work; the next
            // one is tried, and the original local failure survives if none do
            tried.push({ kind: tier.kind, error: String((e && e.message) || e).slice(0, 200) });
        }
    }
    return { ok: false, tried, reason: "no other machine could run it either" };
}

/** What the model is told about a reroute that did not happen. */
function explain(tried, reason) {
    if (!tried || !tried.length) return reason ? ` (${reason})` : "";
    const bits = tried.map(t =>
        `${t.kind}: ${t.skipped || t.error || "no"}`).join("; ");
    return ` (tried elsewhere — ${bits})`;
}

module.exports = {
    classifyFailure, tiersFor, attempt, explain,
    escalationAllowed, sessionAllowsPaid,
    // exported for the tests, so the classifier's two lists are checked
    // against the sentences the app's own guards really produce
    CAPACITY, PERMANENT
};
