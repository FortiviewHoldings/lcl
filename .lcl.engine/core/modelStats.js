const paths = require("./paths");

/**
 * WHICH MODEL IS ACTUALLY GOOD AT WHAT, ON THIS MACHINE, FOR THIS PERSON'S WORK.
 *
 * Every claim about model capability is someone's opinion, mine included, and
 * mine is worse than most because it is frozen at training time and never sees
 * your workload. "V3 is the better tool-caller" is a reasonable prior. It is not
 * evidence.
 *
 * So the app measures instead. Every turn produces facts that need no judgement
 * to read:
 *
 *   - did the model emit a tool call that PARSED, or did it answer in prose when
 *     a tool was the obvious move
 *   - did the loop have to run its malformed-call rescue
 *   - did the turn need a correction pass
 *   - how long did it take, and what did it cost
 *   - did it finish, or did the user cancel it
 *
 * Those roll up per model into a success rate, and the pre-router consults them
 * instead of my prior. After a week of your work the app knows something I never
 * could — and if R1 turns out to drive your tasks perfectly well, the numbers say
 * so and the routing follows, without anyone having to argue with me about it.
 *
 * Deliberately NOT a model: no classifier, no embedding, no extra call. Counters
 * and a keyword table. The operator's own objection killed anything heavier —
 * an analysis pass between calls eats exactly the latency the remote model was
 * bought to save.
 */

const KEY = "modelStats";
const EWMA = 0.25;                  // how fast a new observation moves a rate
const MIN_SAMPLES = 5;              // below this, the prior still wins

let cache = null;

function load() {
    if (cache) return cache;
    const s = paths.readSettings()[KEY];
    cache = (s && typeof s === "object") ? s : {};
    return cache;
}

function flush() {
    try { paths.writeSettings({ [KEY]: cache }); } catch { /* never break a turn */ }
}

/**
 * Record what a completed turn actually did.
 *
 * @param modelId
 * @param o.calledTool      it emitted a tool call
 * @param o.toolParsed      that call parsed without rescue
 * @param o.neededRescue    the loop had to repair malformed output
 * @param o.neededCorrection a correction pass ran
 * @param o.cancelled       the user stopped it
 * @param o.ms              wall time
 * @param o.usd             what it cost, if remote
 */
function record(modelId, o = {}) {
    if (!modelId) return;
    const db = load();
    const m = db[modelId] = db[modelId] || {
        turns: 0, toolCalls: 0, rescues: 0, corrections: 0, cancels: 0,
        toolReliability: null, avgMs: null, totalUsd: 0
    };
    m.turns++;
    if (o.calledTool) m.toolCalls++;
    if (o.neededRescue) m.rescues++;
    if (o.neededCorrection) m.corrections++;
    if (o.cancelled) m.cancels++;
    if (o.usd > 0) m.totalUsd = +(m.totalUsd + o.usd).toFixed(4);
    if (o.ms > 0) {
        m.avgMs = m.avgMs === null ? o.ms : Math.round(m.avgMs * (1 - EWMA) + o.ms * EWMA);
    }
    // Tool reliability is the number that decides routing: OF THE TURNS THAT
    // EMITTED A CALL, how many parsed first time. A model that never calls tools
    // has no reliability score rather than a perfect one — the failure mode is
    // "answered in prose instead of acting", and scoring that as 1.0 would rank
    // the worst driver highest.
    if (o.calledTool) {
        const ok = o.toolParsed && !o.neededRescue ? 1 : 0;
        m.toolReliability = m.toolReliability === null
            ? ok : +(m.toolReliability * (1 - EWMA) + ok * EWMA).toFixed(3);
    }
    flush();
}

/** What we know about a model, or null if we have not seen enough of it. */
function statsFor(modelId) {
    const m = load()[modelId];
    if (!m || m.turns < MIN_SAMPLES) return null;
    return {
        turns: m.turns,
        toolReliability: m.toolReliability,
        rescueRate: m.turns ? +(m.rescues / m.turns).toFixed(3) : 0,
        correctionRate: m.turns ? +(m.corrections / m.turns).toFixed(3) : 0,
        avgMs: m.avgMs,
        totalUsd: m.totalUsd
    };
}

function all() {
    const db = load();
    return Object.entries(db).map(([id, m]) => ({ id, ...m }))
        .sort((a, b) => b.turns - a.turns);
}

function reset() { cache = {}; flush(); }

/* ------------------------------------------------------- the free pre-route */

// Shapes that genuinely need reasoning rather than execution. Matched against the
// request before a single token is generated, so it costs nothing and being
// wrong costs nothing either — the driver can escalate on its own regardless.
const HARD = [
    /\bwhy (is|does|would|won'?t|can'?t|did)\b/i,
    /\b(design|architect|trade[- ]?off|approach|strategy)\b/i,
    /\b(oscillat|unstable|instability|resonan|damping|tuning)\b/i,
    /\b(prove|derive|explain how|explain why|reason about)\b/i,
    /\b(root cause|diagnos|intermittent|race condition|deadlock)\b/i,
    /\b(should I|which is better|compare|versus|vs\.?)\b/i,
    /\b(subtle|tricky|confusing|does not make sense|doesn'?t make sense)\b/i
];

// Shapes that are plainly execution. Cheap driver, no escalation.
const EASY = [
    /\b(rename|typo|spelling|format|indent|lint)\b/i,
    /\b(add|remove|delete) (a |the )?(comment|import|line|file|field)\b/i,
    /\b(list|show|print|open|find|search|grep)\b/i,
    /\b(run|execute) (the )?(tests?|build|suite)\b/i
];

/**
 * Before the first token: is this likely to need the reasoner?
 *
 * Advisory only. It is a hint in the system prompt, never a gate — the driver
 * decides, and a wrong guess here changes nothing except whether the driver was
 * nudged. That is why a keyword table is enough and a classifier would be waste.
 */
function looksHard(text) {
    const s = String(text || "");
    if (!s.trim()) return { hard: false, why: null };
    for (const re of EASY) if (re.test(s)) return { hard: false, why: "routine edit or lookup" };
    for (const re of HARD) {
        const m = s.match(re);
        if (m) return { hard: true, why: `"${m[0]}"` };
    }
    // long, multi-clause requests tend to be design work
    if (s.length > 600 && (s.match(/[.?!]/g) || []).length >= 4) {
        return { hard: true, why: "long multi-part request" };
    }
    return { hard: false, why: null };
}

/**
 * A line for the system prompt telling the driver whether to consider escalating.
 * Empty when there is no reasoner to escalate to.
 */
function routingHint(text, hasReasoner) {
    if (!hasReasoner) return "";
    const v = looksHard(text);
    if (!v.hard) return "";
    return "\nThis request looks like it needs real reasoning (" + v.why + "). " +
           "If you find yourself unsure rather than merely busy, call ask_reasoner " +
           "with the specific question — once, well phrased — and continue from its " +
           "answer. Do not escalate things you can simply look up.\n";
}

/**
 * Of the models we have evidence for, which drives best? Returns null when
 * nothing has enough samples, so the caller falls back to the user's choice.
 */
function bestDriver(candidateIds = []) {
    const scored = candidateIds
        .map(id => ({ id, s: statsFor(id) }))
        .filter(x => x.s && x.s.toolReliability !== null)
        .sort((a, b) => b.s.toolReliability - a.s.toolReliability);
    return scored.length ? scored[0] : null;
}


/**
 * VISUAL / GENERATIVE work — graphics, animation, 3D, a whole UI or scene.
 *
 * Measured, not theorised. Driven live against the operator's 35B: asked to
 * "build a high-quality voice-assistant visual — an orb that pulses, a
 * soundwave mouth", it read the sketch and then generated 37,000 characters of
 * unbroken reasoning in four minutes without ever finishing, ever calling a
 * tool, or ever delegating — the same spiral that produced ten hand-written,
 * flickering, upside-down flashes in the real session. This is exactly the
 * work a single local model is worst at and a parallel fleet is best at:
 * several bounded candidate implementations at once, then pick and integrate.
 */
const VISUAL = [
    /\b(animation|animate|animated|motion|tween|easing|framerate|frame rate)\b/i,
    /\b(visual|graphic|graphics|render|rendering|shader|sprite|waveform|soundwave|orb|glow|particle)\b/i,
    /\b3d\b|\b(mesh|model it|cad|freecad|openscad|stl|step file|extrude|revolve|loft)\b/i,
    /\b(a |an |the |custom )(ui|interface|screen|display|scene|dashboard|hud|layout)\b/i,
    /\b(logo|icon|illustration|artwork|poster|wallpaper|texture)\b/i,
    /\b(design|build|make|create|generate) (me )?(a |an |the )?(high[- ]quality |beautiful |polished |slick )/i
];

/**
 * Before the first token: is this generative visual/3D work the fleet should
 * build in parallel rather than the driver reasoning out or hand-writing solo?
 */
function looksVisual(text) {
    const s = String(text || "");
    if (!s.trim()) return { visual: false, why: null };
    for (const re of VISUAL) {
        const m = s.match(re);
        if (m) return { visual: true, why: `"${m[0].trim()}"` };
    }
    return { visual: false, why: null };
}

/**
 * A line for the system prompt telling the driver to FAN visual/3D/animation
 * work out to the assigned fleet instead of grinding it alone. Empty when there
 * is no fleet to hand to, or the request is not that kind of work.
 */
function fleetHint(text, hasFleet) {
    if (!hasFleet) return "";
    const v = looksVisual(text);
    if (!v.visual) return "";
    return "\nThis is generative visual work (" + v.why + "). Do NOT hand-write it " +
           "in one pass or reason the whole design out yourself — that is the single " +
           "thing you are worst at, and it is exactly what the assigned fleet is for. " +
           "Break it into a few concrete, INDEPENDENT pieces — for a device visual " +
           "that is typically the render loop with double-buffering, each visual " +
           "element's draw routine, the frame timing, and the screen orientation — " +
           "and hand them to ask_fleet as parallel tasks in ONE call, each task " +
           "stating the exact target (chip, display driver, resolution, pins) so an " +
           "agent returns working code, not a sketch. Then read the returned pieces, " +
           "keep the best, and integrate. Only fall back to writing it yourself if " +
           "the fleet genuinely cannot.\n";
}

module.exports = { record, statsFor, all, reset, looksHard, routingHint, looksVisual, fleetHint, bestDriver,
                   MIN_SAMPLES };
