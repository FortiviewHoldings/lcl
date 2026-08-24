"use strict";
/*
 * THE INTENT GATEWAY. Given what the operator is asking for and every model
 * reachable right now (any of the four modes), name a better-suited one and
 * say why — an OFFER, never a switch. This is the layer API fallback and
 * escalation sit on: fallback is this same judgement made under duress (the
 * chosen model could not answer) instead of on preference. It runs in any
 * mode, both directions (local↔api), with or without Ancient Knowledge.
 *
 * It never routes. It returns a suggestion; the operator, the agent, or AK
 * decides. Capability numbers come from the shipped catalog (modelIntel),
 * live tool-reliability from modelStats, and the ranking blends the two.
 */

const intel = require("./modelIntel");
let modelStats = null;
try { modelStats = require("./modelStats"); } catch { modelStats = null; }

/* Which capability an ask leans on. Cheap keyword read, not a model call —
 * the offer must be free to compute on every turn. Returns the dominant axis
 * and a short reason, or null when nothing stands out (most chat). */
// drawing requires GENERATION intent, not a bare mention of an image — "fix
// the broken image upload handler" and "the docker image won't build" are code,
// not art, so the verb has to be there
const SIGNALS = [
    ["drawing", /\b(draw|paint|illustrate|sketch|generate an? (image|picture|logo|illustration|icon|banner|avatar)|create an? (image|logo|illustration|icon)|make an? (image|logo|illustration)|render an? (image|illustration|scene)|(image|picture|logo|artwork|illustration) of|midjourney|dall-?e|stable diffusion|text-to-image)\b/i],
    ["vision", /\b(this (image|photo|screenshot|picture)|what('| i)s in this (image|photo|picture|screenshot)|read this (screenshot|image)|\bocr\b|look at this (image|photo|screenshot)|describe this (image|photo|picture))\b/i],
    ["code", /\b(code|function|refactor|debug|stack ?trace|compile|unit test|regex|typescript|python|rust|api endpoint|npm|git |build error|handler|component)\b/i],
    ["reasoning", /\b(prove|derive|why does|explain the|reason through|step by step|analy[sz]e|trade-?offs?|architect|design a system|plan the)\b/i],
    ["agentic", /\b(automate|multi-?step|orchestrat|run the whole|end to end|do all of|pipeline|agent)\b/i]
];

// caps a text model genuinely CANNOT do — a null (unknown) current model is
// fairly treated as a 0 here. The soft caps (code/reasoning/agentic) an
// uncatalogued local model may well handle, so an unknown current model there
// is NOT assumed incompetent, or every local session would be nagged to escalate.
const HARD_CAPS = new Set(["drawing", "vision"]);

function intentOf(text) {
    const s = String(text || "");
    for (const [cap, re] of SIGNALS) {
        if (re.test(s)) return { cap, why: capReason(cap) };
    }
    return null;
}
function capReason(cap) {
    return ({
        drawing: "this is image work",
        vision: "this reads an image",
        code: "this is coding work",
        reasoning: "this needs real reasoning",
        agentic: "this is multi-step agent work"
    })[cap] || cap;
}

/*
 * candidates: [{ id, label?, mode }] — every model reachable now, where mode
 * is "local" | "node" | "api" | "gpu". current: the id in use. Returns null
 * (no better option worth interrupting for) or:
 *   { cap, current: {id,score}, suggested: {id,label,mode,score}, reason, gain }
 */
function offer(text, candidates, currentId, opts = {}) {
    const intent = opts.intent || intentOf(text);
    if (!intent || !Array.isArray(candidates) || !candidates.length) return null;
    const cap = intent.cap;

    const scoreOf = (id) => {
        const info = intel.intelFor(id);
        let base = info && info.caps && typeof info.caps[cap] === "number"
            ? info.caps[cap] : null;
        if (base === null) return null;
        // live evidence nudges the catalog: a model proven flaky at tool use
        // loses a little agentic/code standing, a proven-reliable one gains
        if (modelStats && (cap === "agentic" || cap === "code")) {
            const st = modelStats.statsFor(id);
            if (st && typeof st.toolReliability === "number") {
                base += (st.toolReliability - 0.5) * 2; // ±1 at the extremes
            }
        }
        return Math.max(0, Math.min(10, base));
    };

    const curScore = scoreOf(currentId);
    // OWNED BEATS RENTED AT EQUAL SKILL. The old pick was a bare argmax, and
    // the catalog's top API model (a frontier 10/10) won every single time —
    // "it is only saying Fable 5" — burying the user's own machines. Best
    // is now judged per tier: a PAID candidate (api/gpu) must beat the best
    // OWNED one (local/node) by a real extra margin to be worth money over
    // hardware the operator already runs for free.
    const PAID_EDGE = 2;
    let bestOwned = null, bestPaid = null;
    for (const c of candidates) {
        if (!c || c.id === currentId) continue;
        const s = scoreOf(c.id);
        if (s === null) continue;
        const owned = c.mode === "local" || c.mode === "node";
        if (owned) { if (!bestOwned || s > bestOwned.score) bestOwned = { ...c, score: s }; }
        else { if (!bestPaid || s > bestPaid.score) bestPaid = { ...c, score: s }; }
    }
    const best = bestOwned && bestPaid
        ? (bestPaid.score - bestOwned.score >= PAID_EDGE ? bestPaid : bestOwned)
        : (bestOwned || bestPaid);
    if (!best) return null;

    // an offer has to EARN the interruption: the alternative must clear the
    // current model by a real margin, and clear a usefulness bar outright.
    // A text-only model on an image ask scores 0 here, so the margin is huge
    // and the offer is obvious; two 9s never nag each other.
    const MIN_MARGIN = opts.minMargin || 2;
    const MIN_ABSOLUTE = opts.minAbsolute || 6;
    // an UNKNOWN current model: assumed incapable only of the hard caps
    // (drawing/vision). For a soft cap it is not assumed incompetent — but a
    // TOP-TIER alternative (9+) is still offered, because "asked a low-tier
    // model to do something and saw no suggestion" is the operator-reported
    // failure of the stricter rule. Mid-tier alternatives stay quiet: no nag
    // between an unknown and an 8.
    if (curScore === null && !HARD_CAPS.has(cap) && best.score < 9) return null;
    const cur = curScore === null ? 0 : curScore;
    if (best.score < MIN_ABSOLUTE || best.score - cur < MIN_MARGIN) return null;

    return {
        cap,
        current: { id: currentId, score: curScore },
        suggested: { id: best.id, label: best.label || best.id,
                     mode: best.mode || null, score: best.score,
                     // carried so "assign for this kind of work" can write a
                     // COMPLETE task-map entry the router can resolve
                     endpointId: best.endpointId || null,
                     endpointLabel: best.endpointLabel || null },
        reason: `${intent.why}; ${best.label || best.id} rates ` +
                `${best.score}/10 there` +
                (curScore !== null ? ` vs ${cur}/10 for the current model` : "") + ".",
        gain: best.score - cur
    };
}

/*
 * Every model reachable RIGHT NOW, across all four modes, as offer candidates.
 * Local registry models that are on disk, plus every model each linked
 * endpoint serves (node / api / rented GPU). Lazy requires so modelOffer stays
 * loadable in a bare test.
 */
function reachableModels() {
    const out = [];
    try {
        const paths = require("./paths");
        const reg = paths.modelRegistry && paths.modelRegistry();
        for (const m of (reg && reg.models) || []) {
            out.push({ id: m.id, label: (m.family + " " + m.params).trim(), mode: "local" });
        }
    } catch { /* no local registry in this context */ }
    try {
        const cloud = require("./cloudModels");
        for (const ep of cloud.endpoints()) {
            // an endpoint that cannot ANSWER is not reachable: a machine that
            // is off, or a keyless paid host, must never be offered. The key
            // judgement is cloudModels' own (a LAN server needs no key).
            if (ep.offline) continue;
            try { if (!cloud.usableSelection(ep)) continue; } catch { continue; }
            const mode = ep.localNode ? "node" : ep.rented ? "gpu" : "api";
            const models = (ep.models && ep.models.length ? ep.models
                : (ep.allModels || []).map(x => (typeof x === "string" ? { id: x } : x)));
            for (const mm of models) {
                out.push({ id: mm.id || mm, label: (mm.label || mm.id || mm) + " on " + ep.label,
                           mode, endpointId: ep.id, endpointLabel: ep.label });
            }
        }
    } catch { /* no endpoints in this context */ }
    return out;
}

/*
 * suggest_model — the tool form of the gateway. The agent (and Ancient
 * Knowledge, when it is on) calls it with the task it is about to do and the
 * model now in use; it returns a better-suited reachable model and why, or
 * says the current one is well suited. It NEVER switches anything.
 */
async function suggestModel(_root, { task, current } = {}, ctx = {}) {
    const text = String(task || "").trim();
    if (!text) {
        return { output: 'suggest_model needs {"task": "what you are about to do"}',
                 failed: true };
    }
    const curId = current
        || (ctx.session && ctx.session.modelSel
            && (ctx.session.modelSel.model || ctx.session.modelSel.local
                || ctx.session.modelSel))
        || null;
    // THE SESSION'S OWN ASSIGNMENT OUTRANKS ANY RIVAL. The system prompt tells
    // the driver to suggest_model when a task leans elsewhere — but if the
    // operator already assigned a model for this kind of work, the answer IS
    // that assignment, never a competitor to it.
    const intent = intentOf(text);
    const tm = ctx.session && ctx.session.taskModels;
    if (intent && tm && tm[intent.cap] && tm[intent.cap].model) {
        const a = tm[intent.cap];
        return { output: `Use ${a.endpointLabel || a.model} — the operator assigned it for ` +
                         `${intent.cap} work in this conversation. That assignment stands.` };
    }
    const o = offer(text, reachableModels(), curId);
    if (!o) {
        return { output: "The current model is well suited to this — no change worth making." };
    }
    return {
        output: `Consider ${o.suggested.label} (${o.suggested.mode}) for this: ${o.reason} ` +
                `This is an offer, not a switch — the operator decides.`,
        suggestion: o
    };
}

const SUGGEST_ENTRY = {
    run: suggestModel,
    help: 'suggest_model {"task": "..."} — name a better-suited reachable model ' +
          'for a task and say why. Advisory only; it never switches the model. ' +
          'Use when a task leans on something (drawing, vision, deep reasoning) ' +
          'the current model is weak at and a stronger one is reachable.'
};

module.exports = { intentOf, offer, reachableModels, suggestModel, SUGGEST_ENTRY };
