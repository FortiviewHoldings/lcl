/**
 * COVERAGE CONTRACTS — what "fully" means, written down BEFORE the build.
 *
 * The measured failure this exists for: asked to fully showcase a 26-page
 * chapter, .lcl built two widgets over three of its thirteen sections and
 * reported success. A frontier model built sixteen over all of them. The gap
 * was not tool quality or model size — it was that NOTHING in the run ever
 * stated what the whole job was, so nothing could notice most of it was
 * missing. The plan never encoded what "fully" meant.
 *
 * So: when the workspace holds extracted source material, its own inventory
 * becomes a CHECKLIST — handed to the planner so the plan decomposes by
 * TOPIC instead of by vibe, persisted with the run, and given to the
 * reviewers that can judge whether each topic was really built.
 *
 * There is deliberately NO deterministic coverage score. Three were built and
 * measured against the two real builds of this chapter; every one of them
 * misled, one of them ranking the WORSE build higher. The block above
 * `namedNowhere` records exactly what was tried and what each did, because
 * the next person to reach for a grep-based score deserves the measurements
 * rather than the temptation.
 *
 * Built from the REAL material, not an idea of it: the chapter that motivated
 * this has no PDF outline at all (it is a scan, OCR'd), so an outline-only
 * checklist would have been empty for exactly the document it was built for.
 * Headings are read from the extracted TEXT, where they actually are.
 */
const fs = require("fs");
const path = require("path");

const MAX_TEXT_BYTES = 400_000;   // the head of a big extraction is enough
const MAX_ITEMS = 40;             // a checklist longer than this is noise
const MIN_ITEMS = 3;              // fewer than this is not a contract
const MAX_BUILT_FILES = 24;
const MAX_BUILT_BYTES = 400_000;
const TEXT_EXT = new Set([".html", ".htm", ".js", ".mjs", ".css", ".md", ".txt",
                          ".json", ".py", ".csv", ".svg"]);

/* Section headings as they appear in real extracted text: "1-1 Introduction",
 * "1-10 Binary-Coded-Decimal System". The NUMBER is the identity — the same
 * heading repeats as a running header on every page of its section.
 *
 * NOT LINE-ANCHORED, and that is the whole difference. Measured on the very
 * chapter this feature exists for: a `^`-anchored pattern found 7 of its 13
 * sections, because OCR glues running headers onto the end of body lines —
 * "The ASCII Code" and "Applications of the Numbering Systems", two of the
 * topics the original build actually missed, were invisible to the checklist
 * meant to catch their absence. Scanning WITHIN the line finds all 13.
 *
 * The title must start with a CAPITAL, which is what separates a heading from
 * a numbered exercise ("1-4. An automobile speedometer…") or a prose
 * cross-reference ("Figure 1-4 compares numbers…"); BAD_PRE rejects the
 * reference forms outright. */
const HEAD_RE = /(^|[\s|])(\d{1,2}[-–]\d{1,2})\s+([A-Z][A-Za-z0-9'()&,\/ -]{3,60})/g;
const BAD_PRE = /(figure|fig\.|table|example|problem|prob\.|see|section|step)\s*$/i;

/** OCR litter at the end of a running header ("... System opm", "... Analog i <<"). */
function cleanTitle(raw) {
    let t = String(raw).replace(/\s+/g, " ").trim();
    t = t.replace(/[\s|<>_.…·—-]+$/g, "");
    const tokens = t.split(" ");
    while (tokens.length > 2) {
        const last = tokens[tokens.length - 1];
        if (/^[a-z]{1,3}$/.test(last) || /^[^A-Za-z0-9]+$/.test(last)) tokens.pop();
        else break;
    }
    return tokens.join(" ").trim();
}

/**
 * THE TERMS THAT PROVE A TOPIC IS NAMED — distinctive PHRASES, never lone
 * generic words.
 *
 * Measured on the motivating build: scoring by single words called all 13
 * topics covered, because one base converter's vocabulary ("binary",
 * "decimal", "system") satisfies every heading in a numbering-systems
 * chapter — the metric agreed with the model's own false claim of
 * completeness, which is precisely the failure it exists to catch. Adjacent
 * significant words ("octal conversions"), hyphenated compounds
 * ("binary-coded-decimal") and their initialisms (BCD) are what a build
 * actually says when it has built the thing.
 *
 * This errs STRICT on purpose. A false "not covered" costs a look; a false
 * "covered" hides a gap, and hiding gaps is the whole defect.
 */
function termsFor(title) {
    const STOP = new Set(["the", "and", "for", "with", "versus", "vs", "of", "to",
                          "a", "an", "in", "on", "its", "into", "from", "using",
                          "other", "more", "part", "base"]);
    const words = String(title).toLowerCase()
        .replace(/[^a-z0-9\- ]+/g, " ")
        .split(/\s+/).filter(Boolean)
        .filter(w => w.length >= 3 && !STOP.has(w));
    const out = new Set();
    for (const w of words) {
        // a hyphenated compound is already distinctive on its own, and so is
        // the initialism a page usually labels it with
        if (w.indexOf("-") > 0) {
            out.add(w);
            const parts = w.split("-").filter(p => p.length >= 3);
            if (parts.length >= 2) out.add(parts.map(p => p[0]).join(""));
        }
    }
    // adjacent pairs — the topic's own name as the material writes it
    for (let i = 0; i + 1 < words.length; i++) out.add(words[i] + " " + words[i + 1]);
    // a one-word topic has no pair to give; the word itself must carry it
    if (!out.size && words.length === 1) out.add(words[0]);
    return [...out].slice(0, 8);
}

/** every "<name>.extract" sidecar in the workspace, shallow and bounded */
function sidecarsIn(root, depth = 3) {
    const found = [];
    const walk = (dir, d) => {
        if (d > depth || found.length >= 8) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (e.name === "node_modules" || e.name === ".git") continue;
            const full = path.join(dir, e.name);
            if (e.name.endsWith(".extract")) { found.push(full); continue; }
            walk(full, d + 1);
        }
    };
    walk(root, 0);
    return found;
}

function readHead(file, cap) {
    const fd = fs.openSync(file, "r");
    try {
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(Math.min(cap, size));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, n).toString("utf8");
    } finally { fs.closeSync(fd); }
}

/**
 * THE CHECKLIST — the material's own table of contents, from whichever part
 * of the sidecar actually has one. Returns null when the workspace holds no
 * extracted material, or too little structure to be a contract.
 */
function checklistFor(root) {
    if (!root) return null;
    for (const dir of sidecarsIn(root)) {
        const items = [];
        let source = path.basename(dir);

        // 1. the PDF's own outline, when it has one
        try {
            const m = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
            const walkOutline = (list, d) => {
                for (const o of list || []) {
                    if (!o || !o.title || items.length >= MAX_ITEMS) continue;
                    const title = cleanTitle(o.title);
                    if (title.length >= 4) {
                        items.push({ id: String(items.length + 1), title,
                                     terms: termsFor(title) });
                    }
                    if (d < 1 && Array.isArray(o.items)) walkOutline(o.items, d + 1);
                }
            };
            if (Array.isArray(m.outline) && m.outline.length) walkOutline(m.outline, 0);
        } catch { /* no manifest, or no outline — the text still has headings */ }

        // 2. headings in the extracted TEXT — where a scanned document's
        //    structure actually lives (the motivating chapter has no outline)
        if (items.length < MIN_ITEMS) {
            items.length = 0;
            try {
                const body = readHead(path.join(dir, "text", "full.txt"), MAX_TEXT_BYTES);
                const seen = new Map();
                for (const line of body.split(/\r?\n/)) {
                    let hit;
                    HEAD_RE.lastIndex = 0;
                    while ((hit = HEAD_RE.exec(line))) {
                        const pre = line.slice(Math.max(0, hit.index - 14),
                                               hit.index + hit[1].length);
                        if (BAD_PRE.test(pre)) continue;     // a cross-reference
                        const id = hit[2].replace("–", "-");
                        const title = cleanTitle(hit[3]);
                        if (title.length < 4) continue;
                        // the LONGEST reading of a repeated running header wins
                        // — page edges clip them differently on different pages
                        const prev = seen.get(id);
                        if (!prev || title.length > prev.length) seen.set(id, title);
                    }
                }
                const sorted = [...seen.entries()].sort((a, b) => {
                    const na = a[0].split("-").map(Number), nb = b[0].split("-").map(Number);
                    return (na[0] - nb[0]) || (na[1] - nb[1]);
                });
                for (const [id, title] of sorted.slice(0, MAX_ITEMS)) {
                    items.push({ id, title, terms: termsFor(title) });
                }
            } catch { /* no text either — nothing to contract on */ }
        }
        if (items.length >= MIN_ITEMS) return { source, items: items.slice(0, MAX_ITEMS) };
    }
    return null;
}

/* =====================================================================
 * WHY THERE IS NO DETERMINISTIC COVERAGE SCORE HERE.
 *
 * Three were built and MEASURED against the two real builds of the same
 * chapter — .lcl's (2 widgets, ~3 topics) and a frontier model's (16 widgets,
 * ~all topics). Every one of them lied:
 *
 *   1. single distinctive words  -> 13/13 for the WEAK build. One base
 *      converter's vocabulary ("binary", "decimal", "system") satisfies every
 *      heading in a numbering-systems chapter; the metric agreed with the
 *      model's own false claim of completeness.
 *   2. distinctive PHRASES       -> weak build 5/13, strong build 3/13. It
 *      ranked the worse artifact HIGHER, because phrase matching rewards
 *      pasting the source's wording verbatim (which the weak build did) and
 *      punishes original prose (which the strong one wrote).
 *   3. per-topic body vocabulary -> noise ("person", "remainder0"). The OCR
 *      text has no reliable section boundaries — least of all in the very
 *      extraction the concurrent-run bug had scrambled.
 *
 * Telling "built a working ADC bench" from "said the word ADC" is semantic
 * judgement, which is the model-graded review's job (selfAudit's reviewers,
 * Ancient Knowledge) — not a grep's. A number that misranks is worse than no
 * number: it would have certified the exact build that started all of this.
 *
 * So the contract ships as a CONTRACT: the material's own topic list reaches
 * the planner (so the plan can decompose by topic instead of by vibe), is
 * persisted with the run, and is handed to the reviewers that can actually
 * judge it. Nothing here claims coverage it cannot prove.
 * ===================================================================== */

/**
 * Kept for the SUITE and for reviewers that want a cheap hint — the topics
 * whose names appear nowhere at all in what was built. One-directional and
 * never reported as a score: absence of the name is evidence of absence;
 * presence of the name is NOT evidence of coverage (see above).
 */
function namedNowhere(checklist, root, changes) {
    if (!checklist || !checklist.items.length) return null;
    let corpus = "";
    const seen = new Set();
    for (const c of changes || []) {
        if (!c || !c.path || c.kind === "deleted") continue;
        const rel = String(c.path).replace(/\\/g, "/");
        if (seen.has(rel) || seen.size >= MAX_BUILT_FILES) continue;
        seen.add(rel);
        if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
        try { corpus += " " + readHead(path.join(root, rel), MAX_BUILT_BYTES).toLowerCase(); }
        catch { /* unreadable file covers nothing */ }
    }
    const covered = [], missing = [];
    for (const it of checklist.items) {
        const hit = (it.terms || []).some(t => t && corpus.indexOf(t) >= 0);
        (hit ? covered : missing).push(it);
    }
    return {
        source: checklist.source,
        total: checklist.items.length,
        named: covered.length,
        absent: missing.map(i => i.id + " " + i.title).slice(0, 12),
        files: seen.size
    };
}

/**
 * THE CONTRACT, in one line, for the transcript and for the reviewers.
 * It states what the whole job was — never how much of it was done, which
 * this module cannot honestly measure (see the block above).
 */
function contractText(checklist) {
    if (!checklist) return "";
    return "This build was measured against " + checklist.source + " — "
        + checklist.items.length + " topics: "
        + checklist.items.map(i => i.id + " " + i.title).join("; ") + ".";
}

/** what the PLANNER is told, so the plan can decompose by topic */
function planBlock(checklist) {
    if (!checklist) return "";
    return "\n\nTHE MATERIAL'S OWN CONTENTS (" + checklist.source + ") — the build "
        + "is measured against this list, and every topic on it must be reachable "
        + "in what you build. Plan steps that cover them, not a sample:\n"
        + checklist.items.map(i => "- " + i.id + " " + i.title).join("\n");
}

module.exports = { checklistFor, planBlock, contractText,
                   // one-directional hint only — never a score (see above)
                   namedNowhere,
                   // exported so the suite exercises the REAL parsers
                   cleanTitle, termsFor, sidecarsIn, HEAD_RE };
