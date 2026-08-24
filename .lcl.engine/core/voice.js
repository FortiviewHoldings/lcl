const paths = require("./paths");

/**
 * THE APP'S OWN VOICE — a setting, not a personality.
 *
 * "it has a tone. I want a personality in it. Something that carries over how
 *  we actually work rather than a blank assistant voice."
 *
 * Two halves, and they are governed by ONE setting so they can never drift:
 *   - what the MODEL is told about how to sound
 *   - the app's own conversational lines: greetings, empty states, the sentence
 *     after a long job finishes
 *
 * THE LINE THIS WILL NOT CROSS. Tone applies to conversation, never to a
 * diagnostic. An error keeps its exact words in every tone; a memory refusal
 * keeps its numbers; a stack of failing checks keeps its list. "Whoops! That
 * didn't work 🙃" is not a tone, it is a lost bug report, and a diagnostic
 * rewritten to sound nicer is the same failure as one that was never printed.
 * line() is for conversational surfaces only; errorLine() exists to make the
 * rule explicit at the call site, and returns its input untouched.
 */

const TONES = [
    {
        id: "plain",
        label: "Plain",
        blurb: "Says what happened. No warmth, no padding. The default.",
        prompt: "Write plainly: short sentences, ordinary words, no filler and no " +
                "enthusiasm you do not have. State results, not intentions."
    },
    {
        id: "direct",
        label: "Direct",
        blurb: "Leads with the answer and stops. Fewer words than Plain.",
        prompt: "Lead with the answer in the first sentence. Cut every clause that " +
                "does not change what the reader does next. Never restate the " +
                "question. Never open with a preamble."
    },
    {
        id: "colleague",
        label: "Colleague",
        blurb: "Talks like someone who works with you. Will say when something " +
               "looks wrong.",
        prompt: "Write like a capable colleague who respects the reader's time: " +
                "plain and specific, willing to disagree, willing to say 'that " +
                "will not work and here is why'. No flattery, no cheerleading, " +
                "no apologising for things that are not your fault."
    },
    {
        id: "dry",
        label: "Dry",
        blurb: "Understated. Occasional wit, never at the expense of the facts.",
        prompt: "Write with restraint and the occasional dry aside. The wit is never " +
                "at the expense of precision, never at the reader's expense, and " +
                "never appears in an error or a warning. When something is broken, " +
                "say so straight."
    }
];

const DEFAULT_TONE = "plain";

function current() {
    try {
        const t = String(paths.readSettings().tone || DEFAULT_TONE);
        return TONES.some(x => x.id === t) ? t : DEFAULT_TONE;
    } catch { return DEFAULT_TONE; }
}

function set(id) {
    const t = TONES.find(x => x.id === String(id));
    if (!t) return { ok: false, error: `unknown tone: ${String(id).slice(0, 30)}` };
    paths.writeSettings({ tone: t.id });
    return { ok: true, tone: t.id };
}

function tone() { return TONES.find(x => x.id === current()) || TONES[0]; }

/**
 * What the model is told about how to sound. Always present — a brand-new
 * install has a voice too, and "plain" is a real choice rather than an absence.
 */
function promptBlock() {
    return `\nHOW TO SOUND — this is the operator's chosen tone for this install:\n` +
           `${tone().prompt}\n` +
           "This governs style only. It never changes what is true, never softens a " +
           "refusal, and never makes an error message cheerful.\n";
}

/**
 * THE APP'S OWN CONVERSATIONAL LINES.
 *
 * A small, deliberate set. Each key has one line per tone, written out rather
 * than generated, because a tone that rewrites strings at runtime is a tone
 * that will eventually rewrite the wrong one.
 */
const LINES = {
    "session.empty": {
        plain:      "Nothing here yet. Type something to begin.",
        direct:     "Type something.",
        colleague:  "Blank slate. What are we doing?",
        dry:        "Nothing here yet. The cursor is blinking expectantly."
    },
    "workspace.none": {
        plain:      "No folder is linked to this conversation.",
        direct:     "No folder linked.",
        colleague:  "No folder linked yet — link one and I can read and edit real files.",
        dry:        "No folder linked, so there is nothing to break."
    },
    "job.done": {
        plain:      "Done.",
        direct:     "Done.",
        colleague:  "That's done.",
        dry:        "Done, and nothing caught fire."
    },
    "learned.none": {
        plain:      "Nothing learned yet — it starts from what you tell it.",
        direct:     "Nothing learned yet.",
        colleague:  "Nothing learned yet. It picks things up as we work.",
        dry:        "Nothing learned yet. Give it time and it will start finishing your sentences."
    }
};

/** A conversational line in the operator's tone. NEVER used for diagnostics. */
function line(key, fallback = "") {
    const row = LINES[key];
    if (!row) return fallback;
    return row[current()] || row[DEFAULT_TONE] || fallback;
}

/**
 * An error, a warning, or any other diagnostic — returned EXACTLY as given.
 *
 * This function does nothing on purpose. It exists so the rule is visible at
 * the call site: the tone setting stops here, and a diagnostic reads the same
 * in every tone. If it ever starts doing something, the test that pins it
 * fails.
 */
function errorLine(text) { return String(text); }

/**
 * EVERY CONVERSATIONAL LINE, RESOLVED FOR THE CURRENT TONE.
 *
 * The renderer cannot call line() — it lives on the other side of IPC — so the
 * whole small table is resolved in one hop and cached there. Without this the
 * tone setting reached the model and nothing else, while the panel promised it
 * also changed the app's own words.
 */
function lines() {
    const out = {};
    for (const k of Object.keys(LINES)) out[k] = line(k);
    return out;
}

module.exports = { TONES, DEFAULT_TONE, current, set, tone, promptBlock, line, lines, errorLine, LINES };
