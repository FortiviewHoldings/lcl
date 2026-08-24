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

const MAX_ITEM_CHARS = 240;
const MAX_BLOCK_CHARS = 2600;
const CACHE_TTL_MS = 60_000;

const trainingRoot = () => path.join(paths.dataDir(), "training");

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
            if (/^(feedback|user)[-_].+\.md$/i.test(f)) out.push(path.join(dir, f));
        }
    }
    // user_* first: who they are frames how the feedback reads
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
        for (let i = 1; i < Math.min(lines.length, 20); i++) {
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
    const body = desc || gist.join(" · ");
    const item = "- " + title + (body ? ": " + body : "");
    return item.length > MAX_ITEM_CHARS ? item.slice(0, MAX_ITEM_CHARS - 1) + "…" : item;
}

function build() {
    const files = prefFiles();
    if (!files.length) return { stamp: "0:0", block: "" };
    const items = [];
    let used = 0;
    let dropped = 0;
    for (const f of files) {
        const item = distill(f);
        if (!item) continue;
        if (used + item.length + 1 > MAX_BLOCK_CHARS) { dropped++; continue; }
        items.push(item);
        used += item.length + 1;
    }
    if (!items.length) return { stamp: stampOf(files), block: "" };
    const block =
        "\nOPERATOR PREFERENCES — imported from this operator's own working " +
        "notes. These are standing instructions about HOW they want things " +
        "done and presented; follow them in every answer:\n" +
        items.join("\n") + "\n" +
        (dropped ? `(${dropped} further note(s) omitted for space)\n` : "");
    return { stamp: stampOf(files), block };
}

/** The block, cached against the staged files' own mtimes. */
function promptBlock() {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) return cache.block;
    const fresh = build();
    if (cache && cache.stamp === fresh.stamp) { cache.at = now; return cache.block; }
    cache = { at: now, stamp: fresh.stamp, block: fresh.block };
    return cache.block;
}

function reset() { cache = null; }

module.exports = { promptBlock, build, distill, prefFiles, reset,
                   MAX_BLOCK_CHARS, MAX_ITEM_CHARS };
