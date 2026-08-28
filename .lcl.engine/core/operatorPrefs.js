"use strict";
const fs = require("fs");
const path = require("path");
const paths = require("./paths");

/**
 * OPERATOR PREFERENCES — the imported memory, WIRED INTO ANSWERS.
 *
 * Importing working memory (Train > Import Training Data) is expected to make
 * the model apply the user's stated presentation preferences at inference.
 * Measured: the import staged files under data/training/ for a
 * FUTURE LoRA run, and nothing at inference read one word of them — the
 * driver answered every turn knowing none of it. The whole point of the
 * import was unwired.
 *
 * This module closes that wire. The staged memory's preference notes — the
 * files named feedback_* and user_* (how this person wants answers shaped,
 * what they corrected, who they are) — are distilled into one bounded prompt
 * block that rides EVERY turn, on every model, today, no training run
 * required. project_* and reference_* notes stay out: they are recall
 * material, not presentation rules, and belong to knowledge search.
 *
 * The LoRA path stays what it is; when an adapter exists this block simply
 * reinforces it. Distillation is dumb on purpose — the title line plus the
 * first rule lines of each note, hard-capped — because a summarising model
 * here would paraphrase the very preferences that say "don't paraphrase me".
 *
 * Privacy follows tailoring exactly: this is a profile of the OPERATOR, so it
 * reaches a remote model only under the same per-session permission that
 * governs the learned tailoring profile (agent.prefsBlockFor mirrors
 * tailoringBlockFor). Local turns always carry it.
 */

const MAX_ITEM_CHARS = 520;      // room for the rule PLUS one verbatim specific
const MAX_BLOCK_CHARS = 2600;    // the DEFAULT budget; the caller scales it to the window
const CACHE_TTL_MS = 60_000;

const trainingRoot = () => path.join(paths.dataDir(), "training");

/**
 * A note's declared kind, read from frontmatter — `type:` whether it sits at the
 * top level or under `metadata:`. This is the real signal for "is this a standing
 * rule or recall material", far better than the filename: the operator's own
 * rules arrive under names like `cameron-communication-style.md` that carry
 * `type: feedback` but match no `feedback_` prefix.
 */
function noteType(text) {
    const lines = String(text || "").split(/\r?\n/);
    if (!lines[0] || lines[0].trim() !== "---") return "";
    for (let i = 1; i < Math.min(lines.length, 30); i++) {
        const t = lines[i].trim();
        if (t === "---") break;
        const m = /^type:\s*([a-z]+)/i.exec(t);
        if (m) return m[1].toLowerCase();
    }
    return "";
}

/**
 * STANDING RULE, OR RECALL? Only standing rules — how this operator wants things
 * built and presented — ride every prompt. Project and reference notes are
 * recall material for knowledge search, not preferences, and must never flood
 * the context (that is the separate knowledge-search wiring). Decided by declared
 * type first; a note with no frontmatter falls back to the filename convention,
 * and a truly ambiguous note is kept OUT rather than crowding the prompt.
 */
function standingRule(name, type) {
    const t = (type || "").toLowerCase();
    if (t === "project" || t === "reference" || t === "knowledge") return false;
    if (t === "feedback" || t === "user" || t === "standard"
        || t === "rule" || t === "preference") return true;
    if (/^(feedback|user|standard|rule|pref)[-_]/i.test(name)) return true;
    return false;
}

let cache = null;   // { at, stamp, block }

/** Newest mtime + file count over the pref files — cheap staleness stamp. */
function stampOf(files) {
    let newest = 0;
    for (const f of files) {
        try { newest = Math.max(newest, fs.statSync(f).mtimeMs); } catch { /* gone */ }
    }
    return `${files.length}:${Math.round(newest)}`;
}

function prefFiles() {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(trainingRoot(), { withFileTypes: true }); }
    catch { return out; }
    for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dir = path.join(trainingRoot(), d.name);
        let files = [];
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            // EVERY note is a candidate — the filename no longer decides. The
            // note's declared TYPE does (rules ride, recall does not), so a rule
            // named cameron-* is no longer skipped for not being feedback_*.
            // MEMORY.md is the index of pointers, not a rule.
            if (!/\.md$/i.test(f) || /^MEMORY\.md$/i.test(f)) continue;
            const full = path.join(dir, f);
            let head = "";
            try { head = fs.readFileSync(full, "utf8").slice(0, 1200); } catch { continue; }
            if (standingRule(f, noteType(head))) out.push(full);
        }
    }
    // user/identity notes first: who they are frames how the rules read
    return out.sort((a, b) => {
        const ua = /[\\/]user[-_]/i.test(a) ? 0 : 1;
        const ub = /[\\/]user[-_]/i.test(b) ? 0 : 1;
        return ua - ub || a.localeCompare(b);
    });
}

/**
 * One note -> one line. The imported memory carries frontmatter whose
 * `description:` is a one-line distillation written for exactly this job —
 * use it first. Notes without frontmatter fall back to their `# ` title plus
 * the first rule bullets. (The first cut parsed only the fallback shape and
 * produced 27 bare filenames — a preferences block with no preferences in it.)
 */
function distill(file) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
    const lines = text.split(/\r?\n/);

    let title = "", desc = "";
    if (lines[0] && lines[0].trim() === "---") {
        for (let i = 1; i < Math.min(lines.length, 30); i++) {
            const t = lines[i].trim();
            if (t === "---") break;
            const m = /^(name|description):\s*(.*)$/.exec(t);
            if (!m) continue;
            const v = m[2].trim().replace(/^["']|["']$/g, "");
            if (m[1] === "name") title = v.replace(/[-_]+/g, " ");
            else desc = v;
        }
    }
    const gist = [];
    let sawHeading = !!title;
    for (const raw of lines) {
        const t = raw.trim();
        if (!title && t.startsWith("# ")) { title = t.slice(2).trim(); sawHeading = true; continue; }
        if (!sawHeading) continue;
        if (!desc && /^[-*] /.test(t) && gist.length < 2) {
            gist.push(t.slice(2).replace(/\*\*/g, "").replace(/\s+/g, " ").trim());
        }
    }
    if (!title) title = path.basename(file, ".md").replace(/[-_]+/g, " ");
    const headline = desc || gist.join(" · ");

    // #2 — DON'T GUT THE RULE TO ONE LINE. The one-liner is the rule stated; add
    // the single highest-signal actionable specific it drops, VERBATIM (never
    // paraphrased — the notes literally say "don't paraphrase me"): a
    // "How to apply" instruction, else the operator's own quoted words, else a
    // bold rule bullet. War-story prose is skipped; only the instruction rides.
    let extra = "";
    const apply = lines.find(l => /\*\*How to apply:\*\*/i.test(l));
    if (apply) extra = apply.replace(/^.*\*\*How to apply:\*\*/i, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (!extra) {
        const q = (text.match(/["“]([^"”]{24,240})["”]/) || [])[1];
        if (q) extra = "“" + q.replace(/\s+/g, " ").trim() + "”";
    }
    if (!extra) {
        const b = lines.find(l => /^\s*[-*]\s+\*\*/.test(l));
        if (b) extra = b.trim().replace(/^[-*]\s+/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    }
    // never echo the headline back as its own specific
    if (extra && headline &&
        extra.replace(/[“”"]/g, "").slice(0, 40).toLowerCase() === headline.slice(0, 40).toLowerCase()) {
        extra = "";
    }

    let item = "- " + title + (headline ? ": " + headline : "");
    if (extra) {
        const room = MAX_ITEM_CHARS - item.length - 6;
        if (room > 24) item += "\n    " + (extra.length > room ? extra.slice(0, room - 1) + "…" : extra);
    }
    return item.length > MAX_ITEM_CHARS ? item.slice(0, MAX_ITEM_CHARS - 1) + "…" : item;
}

function build(maxBlockChars = MAX_BLOCK_CHARS) {
    const files = prefFiles();
    if (!files.length) return { stamp: "0:0", block: "" };
    const items = [];
    let used = 0;
    let dropped = 0;
    for (const f of files) {
        const item = distill(f);
        if (!item) continue;
        if (used + item.length + 1 > maxBlockChars) { dropped++; continue; }
        items.push(item);
        used += item.length + 1;
    }
    if (!items.length) return { stamp: stampOf(files), block: "" };
    const block =
        "\nOPERATOR PREFERENCES — imported from this operator's own working " +
        "notes. These are standing instructions about HOW they want things " +
        "done, built, and presented; follow them in every answer:\n" +
        items.join("\n") + "\n" +
        (dropped ? `(${dropped} further note(s) omitted for space)\n` : "");
    return { stamp: stampOf(files), block };
}

/**
 * The block, cached against the staged files' own mtimes AND the budget it was
 * built for — the caller scales the budget to the model's window (a wide node
 * window carries the operator's full standards; the small local floor gets a
 * tight slice so the block never crowds the base prompt), so the same install
 * legitimately produces two sizes and the cache must not hand one back for the
 * other.
 */
function promptBlock(opts = {}) {
    const budget = Number(opts.maxBlockChars) > 0 ? Number(opts.maxBlockChars) : MAX_BLOCK_CHARS;
    const now = Date.now();
    if (cache && cache.budget === budget && now - cache.at < CACHE_TTL_MS) return cache.block;
    const fresh = build(budget);
    if (cache && cache.stamp === fresh.stamp && cache.budget === budget) { cache.at = now; return cache.block; }
    cache = { at: now, stamp: fresh.stamp, budget, block: fresh.block };
    return cache.block;
}

function reset() { cache = null; }

module.exports = { promptBlock, build, distill, prefFiles, reset,
                   MAX_BLOCK_CHARS, MAX_ITEM_CHARS };
