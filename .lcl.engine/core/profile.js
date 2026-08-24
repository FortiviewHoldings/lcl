const paths = require("./paths");

/**
 * WHO IS THIS, AND HOW SHOULD IT TALK TO THEM.
 *
 * Reported: "THERE IS NO USER MENU, TO ADD A FIELD FOR ANY PERSONALIZATION,
 * LIKE A NICKNAME FOR ME FOR THE MOTHER FUCKER TO CALL ME."
 *
 * Correct, and it is a bigger gap than a name field. The model started every
 * session knowing nothing: not who it was talking to, not what they do, not how
 * they want to be answered, not a single thing carried over from the last
 * hundred conversations. That is most of what makes an assistant feel like it
 * "knows what is going on" — far more than raw model capability.
 *
 * Four fields, all optional, all injected into the system prompt:
 *
 *   name        what to call you
 *   about       who you are and what you work on — the single highest-value
 *               line, because it changes what the model assumes you already know
 *   style       how you want to be answered
 *   notes       standing facts worth remembering across every session
 *
 * Deliberately plain text the user writes, not a questionnaire and not something
 * the model may edit. It goes in the system prompt where instructions belong;
 * a preference the model could rewrite is not a preference.
 */

const KEY = "userProfile";
const CAPS = { name: 60, about: 600, style: 400, notes: 1500 };

function read() {
    const p = paths.readSettings()[KEY];
    if (!p || typeof p !== "object") return { name: "", about: "", style: "", notes: "" };
    return {
        name: String(p.name || "").slice(0, CAPS.name),
        about: String(p.about || "").slice(0, CAPS.about),
        style: String(p.style || "").slice(0, CAPS.style),
        notes: String(p.notes || "").slice(0, CAPS.notes)
    };
}

function write(next) {
    const cur = read();
    const merged = { ...cur };
    for (const k of Object.keys(CAPS)) {
        if (next && next[k] !== undefined) {
            merged[k] = String(next[k] || "").slice(0, CAPS[k]);
        }
    }
    paths.writeSettings({ [KEY]: merged });
    return merged;
}

function isEmpty(p = read()) {
    return !p.name && !p.about && !p.style && !p.notes;
}

/**
 * The block that goes into the system prompt. Empty string when nothing is set,
 * so an unconfigured install carries no dead weight.
 *
 * Phrased as facts and instructions rather than as a persona. Telling the model
 * what someone does for a living changes what it assumes they already know,
 * which is the whole point; "You are a helpful assistant to <name>" changes
 * nothing and wastes context.
 */
function promptBlock() {
    const p = read();
    if (isEmpty(p)) return "";
    const lines = ["\nABOUT THE PERSON YOU ARE TALKING TO — this is standing context, " +
                   "not something to repeat back at them:"];
    if (p.name) {
        lines.push(`Their name is ${p.name}. Use it naturally when it fits; do not ` +
                   "open every message with it.");
    }
    if (p.about) lines.push(`About them: ${p.about}`);
    if (p.style) lines.push(`How they want to be answered: ${p.style}`);
    if (p.notes) lines.push(`Standing notes they have asked you to remember:\n${p.notes}`);
    lines.push("Assume the expertise this implies. Do not explain things they " +
               "plainly already know, and do not flatter them about it.");
    return lines.join("\n") + "\n";
}

/** A short line for the UI, so the user can see it is actually in effect. */
function summary() {
    const p = read();
    if (isEmpty(p)) return "nothing set — the model starts every session knowing nothing about you";
    const bits = [];
    if (p.name) bits.push(`calls you ${p.name}`);
    if (p.about) bits.push("knows what you do");
    if (p.style) bits.push("follows your answer style");
    if (p.notes) bits.push("carries your standing notes");
    return bits.join(" · ");
}

module.exports = { read, write, promptBlock, summary, isEmpty, CAPS };
