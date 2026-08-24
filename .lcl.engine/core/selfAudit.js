const fs = require("fs");
const path = require("path");
const router = require("./router");
const { parseToolJson } = require("./toolParse");
const { resolveInRoot } = require("./fsTools");

/**
 * THE SELF-AUDIT LOOP — the app checks its own work before the operator does.
 *
 * The design requirement: local should notice dissatisfaction before it is
 * told, by using context and understanding intent — read an input, do the
 * work, then audit that output. Where there are discrepancies, run it again
 * and fix those issues. Not an infinite loop: the process reaches a conclusion.
 *
 * The missing mechanism was never model capability — it is SCHEDULING. One
 * critic asked "is this step ok?" and a single opinion, asked once, in the
 * same frame as the thing that produced the work, agrees with itself. So the
 * finished work is attacked by several reviewers with DIFFERENT MANDATES, each
 * blind to the others:
 *
 *   intent       — does it do what was actually asked, not a near neighbour
 *   correctness  — is what it produced actually right, on its own terms
 *   completeness — is anything the request implies missing or half-built
 *   satisfaction — would a person receiving this be satisfied, or ask again
 *
 * WHY BLIND. A reviewer shown what a peer found anchors on it: it agrees, adds
 * nothing, and four opinions collapse into one with extra steps. Each reviewer
 * therefore sees only the goal and the artefacts — and is never told the panel
 * exists at all, because "that is someone else's job" is how a real problem
 * gets left for a colleague who was never asked about it.
 *
 * WHY DISAGREEMENT IS THE SIGNAL. Agreement between reviewers who cannot see
 * each other is weak evidence — they share a model, a prompt style and a
 * training distribution, so they fail the same way at the same time. A finding
 * only one mandate raised, on a file the others looked at and cleared, is the
 * interesting one: it is the thing a single frame would have missed. Nothing
 * here votes a finding away. A lone finding is surfaced FIRST, flagged as
 * contested, and a clean sweep is reported as weak evidence rather than proof.
 *
 * CONCURRENCY IS THE DRIVER'S PROPERTY, exactly as it is for plan steps: the
 * width is passed in by the caller, which owns that decision (orchestrator's
 * stepConcurrency). Local is one resident model and reviews strictly one at a
 * time; an API or a linked node runs the panel wide, which is the
 * entire point of having one.
 *
 * TERMINATION — stated here so it is never a question:
 *   1. stop when a round surfaces NOTHING NEW (every finding already seen), or
 *   2. stop when no finding survived to be repaired, or
 *   3. stop at MAX_ROUNDS rounds, hard, or
 *   4. stop when the review spend reaches the budget, or the turn is cancelled.
 * There is no path that loops without one of those four ending it.
 */

/** Hard ceiling on produce -> attack -> fix -> re-check cycles. */
const MAX_ROUNDS = 3;
/** Findings repaired per round. A round that finds fifty things has a
 *  different problem than a repair loop can solve. */
const MAX_REPAIRS_PER_ROUND = 6;
/** Artefacts shown to a reviewer, and how much of each. */
const MAX_FILES = 8;
const FILE_CHARS = 4000;
const REVIEW_TOKENS = 700;
/** What a review pass may spend on a PAID endpoint before it stops and says
 *  so. A node and a local model cost nothing, so this never binds there. */
const DEFAULT_BUDGET_USD = 0.25;

// Text file extensions a reviewer will READ. A binary — a rendered PNG, an
// audio file — is never decoded as UTF-8 and handed to a model: that turned a
// valid image into a "FAIL" and re-ran a 20-second render.
const TEXT_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts",
    ".json", ".md", ".markdown", ".txt", ".svg", ".xml", ".yaml", ".yml",
    ".csv", ".toml", ".ini", ".py", ".c", ".cpp", ".h", ".hpp", ".sh", ".rs", ".go"]);
// Files that are legitimately tiny or empty by design — never "too short".
const TINY_BY_DESIGN = new Set([".nojekyll", ".gitkeep", ".gitignore",
    "py.typed", "__init__.py"]);

/**
 * THE BAR THE WORK IS BUILT AND JUDGED AGAINST.
 *
 * The standard: given an empty folder and a request like "build a website for
 * a dog walking company", the app should invoke the tools, models and anything
 * else it needs — and produce a fully functional, professional-grade website,
 * not the most literal basic static site.
 *
 * A plain sentence is a request for a finished thing, not for the smallest
 * artefact that technically matches the words. This brief is injected into
 * planning, into every step, and into what "satisfied" means to a reviewer, so
 * one standard governs producing and judging instead of two.
 */
const QUALITY_BRIEF =
    "QUALITY BAR — a plain request means a FINISHED, professional result, not " +
    "the smallest thing that technically matches the words:\n" +
    "- Real content written for this specific subject. Never lorem ipsum, " +
    "never 'TODO', never 'Your text here', never a section that only names " +
    "itself.\n" +
    "- Complete structure: every page or module the request implies, and every " +
    "link, import or reference resolving to something that exists.\n" +
    "- Presentation finished to a professional standard: consistent layout and " +
    "spacing, a deliberate type and colour scheme, and a responsive result " +
    "that holds up on a phone as well as a desktop.\n" +
    "- Accessible by default: meaningful titles and headings in order, labels " +
    "on inputs, alt text on images, and text that stays readable against its " +
    "background.\n" +
    "- Works when opened: no broken references, no placeholder assets, no " +
    "half-wired interaction that looks live and does nothing.";

/**
 * The panel. Each mandate is a genuinely different question — a reviewer that
 * duplicates another's angle adds cost and no information.
 *
 * Each prompt states its ONE job, demands specifics tied to a file, and is
 * told to return an empty list when the work is genuinely fine. Reviewers are
 * asked for what is WRONG, never for a score: a score is a number to argue
 * with, a finding is a thing to fix.
 */
const REVIEWERS = [
    {
        key: "intent",
        label: "Does it do what was asked",
        system:
            "You review finished work against the request that produced it. Your " +
            "ONE job: did this do what was ACTUALLY asked, or a near neighbour of " +
            "it? Look for the request's real subject, scope and constraints being " +
            "quietly substituted, dropped, or answered with something adjacent. " +
            "Style and polish are not your question here."
    },
    {
        key: "correctness",
        label: "Is it correct",
        system:
            "You review finished work for CORRECTNESS on its own terms. Your ONE " +
            "job: is what is here actually right? Broken or dead references, links " +
            "and imports pointing at things that do not exist, syntax that will not " +
            "parse or run, logic that contradicts itself, markup that will not " +
            "render as intended, statements of fact that are wrong. Whether " +
            "something is MISSING is not your question here — judge what is present."
    },
    {
        key: "completeness",
        label: "Is it complete",
        system:
            "You review finished work for COMPLETENESS. Your ONE job: what the " +
            "request implies but the work does not contain. Missing pages, sections " +
            "or files the result needs to make sense; stubs, empty shells and " +
            "placeholder text presented as finished; a piece that is referenced but " +
            "never built. Whether what IS here is correct is not your question " +
            "here — judge only what is absent."
    },
    {
        key: "satisfaction",
        label: "Would a person be satisfied",
        system:
            "You review finished work the way its RECIPIENT would. Your ONE job: " +
            "would the person who asked for this be satisfied, or would they " +
            "immediately ask for it again? Judge it against what a professional " +
            "would hand over for this request.\n" + QUALITY_BRIEF
    }
];

const REVIEW_FORMAT =
    "\n\nYou are given the REQUEST and the FILES that were produced.\n" +
    "Reply with ONLY a JSON object, no prose:\n" +
    '{"findings": [{"file": "<the file the problem is in, or \\"\\" if it is ' +
    'about the work as a whole>", "issue": "<what is wrong, specifically>", ' +
    '"fix": "<the concrete change that would resolve it>", "severity": ' +
    '"high|medium|low"}]}\n' +
    "Rules: report only real, concrete problems a person would agree with — no " +
    "speculation, no restating the request back, no nitpicking wording. If the " +
    "work genuinely satisfies your one job, reply {\"findings\": []}. Never " +
    "invent a problem to seem thorough: an empty list is a valid, expected " +
    "answer. At most 5 findings, most serious first.";

/* --------------------------------------------------- tier 1: the gate */

/**
 * ONE AUDIT MECHANISM, TWO TIERS — not two mechanisms.
 *
 * The per-STEP gate below is cheap and runs while a plan is still being built:
 * a deterministic check plus one small model call, asking only "did this step
 * produce its thing at all". The PANEL above runs once, on the finished whole,
 * and asks the four questions that only make sense about a finished thing.
 * They live in this file together so the relationship is visible and neither
 * can drift into doing the other's job. The orchestrator re-exports the gate
 * so its existing contract is unchanged.
 */

/** Does this step's action ask for a file to be written or CHANGED? */
function expectsFile(step) {
    const a = String(step.action || "");
    // include edit-oriented verbs: a "fix/update X.css" step that changes
    // nothing is a silent failure, not a success (review finding)
    return /\b(write|create|add|generate|make|build|scaffold|edit|update|modify|fix|revise|replace|rewrite|append)\b/i.test(a)
        && (/\.\w{1,6}\b/.test(a) || /\b(file|page|stylesheet|script|document|readme|config|component)\b/i.test(a));
}

const CRITIQUE_TOKENS = 80;
const CRITIC_SYSTEM =
    "You verify ONE step of a build. You are given the step's instruction and the " +
    "file it produced. Reply with EXACTLY \"PASS\" if the file genuinely satisfies " +
    "the step, or a line starting \"FAIL: <one short reason>\" if it clearly does " +
    "not — empty, a stub, obvious placeholder filler, the wrong thing, or missing " +
    "what the step explicitly asked for. When unsure, reply PASS. Do not nitpick " +
    "style, brevity, or wording — only fail clear, real problems.";

/** Only-tags-no-words HTML is an empty skeleton, not a page. */
function htmlHasNoContent(trimmed) {
    const visible = trimmed.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return visible.length < 15;
}

/**
 * Judge whether a step actually accomplished its goal.
 *
 * The deterministic gate is deliberately MINIMAL — only unambiguous failures:
 * a file that should exist does not, or an HTML file that is an empty skeleton.
 * Brevity and keyword "placeholder" heuristics were removed because they
 * false-rejected legitimate output (a 43-char CSS reset, an <input
 * placeholder="Your name here">, a page that says "Coming Soon"). The nuanced
 * "is this real content or filler" judgment belongs to the model critique,
 * which defaults to PASS so a weak critic never becomes an infinite-retry
 * bottleneck — and, now, to the panel that reviews the finished whole.
 * Binaries are never read as text.
 *
 * Returns { pass, problem }.
 */
async function critiqueStep(session, step, changes, cancelToken = {}, sel) {
    if (expectsFile(step) && !changes.length) {
        return { pass: false, problem: "no file was written — call write_file with the real content" };
    }
    let firstFile = null, firstContent = "";
    for (const c of changes) {
        if (!c.path || c.kind === "deleted") continue;
        const ext = path.extname(c.path).toLowerCase();
        if (!TEXT_EXT.has(ext)) continue;                 // binaries: existence is the signal
        if (TINY_BY_DESIGN.has(path.basename(c.path).toLowerCase())) continue;

        let content;
        try { content = fs.readFileSync(resolveInRoot(session.repoPath, c.path), "utf8"); }
        catch { continue; }
        const trimmed = content.trim();

        // the ONE deterministic content check: an HTML file with tags but no
        // words is a skeleton with nothing in it
        if ((ext === ".html" || ext === ".htm") && trimmed && htmlHasNoContent(trimmed)) {
            return { pass: false, problem: `${c.path} has no visible content — write a real page with headings and text` };
        }
        if (!firstFile && trimmed) { firstFile = c.path; firstContent = trimmed; }
    }
    if (!firstFile) return { pass: true };     // nothing text-shaped to critique

    // model critique — bounded, default PASS on any ambiguity or error
    try {
        const res = await router.generate([
            { role: "system", content: CRITIC_SYSTEM },
            { role: "user", content:
                `STEP: ${step.action}\n\nFILE ${firstFile}:\n${firstContent.slice(0, 1600)}` }
        // ON THIS SESSION'S MODEL, like every other call in the turn. Without
        // the selection this was the one hop that still asked the app default —
        // so a conversation pinned to the local engine had its file contents
        // sent to a paid endpoint, once per step, with no ledger row.
        ], CRITIQUE_TOKENS, cancelToken,
            null, sel !== undefined ? { selection: sel } : {});
        if (res.error || cancelToken.cancelled) return { pass: true };
        const verdict = String(res.content || "").trim();
        // a real FAIL starts the reply with the word FAIL (boundary-anchored so
        // "FAILURE: none" or "this does not FAIL" do not trip it). A bare
        // "FAIL" with no reason still counts as a fail, with a generic reason.
        if (/^fail\b/i.test(verdict)) {
            const reason = verdict.replace(/^fail\b[:\-\s]*/i, "").trim().replace(/\s+/g, " ");
            return { pass: false, problem: (reason || "did not satisfy the step").slice(0, 140) };
        }
        return { pass: true };
    } catch {
        return { pass: true };
    }
}

/* ------------------------------------------------------------ artefacts */

/** The files this work produced, as text a reviewer can actually read. */
function readArtifacts(session, changes) {
    const out = [];
    const seen = new Set();
    for (const c of changes || []) {
        if (!c || !c.path || c.kind === "deleted") continue;
        if (seen.has(c.path)) continue;
        seen.add(c.path);
        if (out.length >= MAX_FILES) break;     // the cap covers EVERY artefact
        const ext = path.extname(c.path).toLowerCase();
        // a binary is listed so a reviewer knows it exists, never decoded.
        // It counts against the cap like anything else: a run that generated
        // twenty images used to push every text file out of the prompt.
        if (!TEXT_EXT.has(ext)) { out.push({ path: c.path, binary: true, text: "" }); continue; }
        if (TINY_BY_DESIGN.has(path.basename(c.path).toLowerCase())) continue;
        let text = "";
        try { text = fs.readFileSync(resolveInRoot(session.repoPath, c.path), "utf8"); }
        catch { continue; }
        out.push({ path: c.path, binary: false, text: text.slice(0, FILE_CHARS),
                   truncated: text.length > FILE_CHARS, bytes: text.length });
    }
    return out;
}

function artifactBlock(artifacts) {
    if (!artifacts.length) return "(no files were produced)";
    return artifacts.map(a => a.binary
        ? `FILE ${a.path}: (binary file, ${a.path.split(".").pop()} — not shown)`
        : `FILE ${a.path}:\n${a.text}${a.truncated ? "\n…(truncated)" : ""}`
    ).join("\n\n");
}

/* ------------------------------------------------------------- findings */

/** A stable identity for a finding, so the same complaint raised twice — by
 *  two reviewers, or in two rounds — is recognised as the same thing. */
function fingerprint(f) {
    const file = String(f.file || "").toLowerCase().trim();
    const words = String(f.issue || "").toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 3)
        .sort()
        .slice(0, 8)
        .join(" ");
    return `${file}::${words}`;
}

// Words that carry no identity. Two groups, and the second is the one that
// matters: ordinary English glue, plus THE VOCABULARY EVERY REVIEW USES.
// "the booking area is unfinished" and "the pricing area is unfinished" share
// two thirds of their words and are different findings; what separates them is
// the subject, not the frame. Strip the frame and compare what is left.
const STOPWORDS = new Set([
    "this", "that", "there", "with", "from", "have", "does", "into", "which",
    "when", "what", "would", "should", "could", "thing", "anything",
    "something", "actually", "instead", "rather", "than", "then", "them",
    "they", "their", "been", "being", "only", "just", "also", "very", "much",
    "more", "most", "some", "here", "where", "while", "about", "because",
    // review vocabulary — true of half of all findings, so it identifies none
    "page", "file", "content", "area", "section", "part", "piece", "element",
    "missing", "unfinished", "incomplete", "broken", "wrong", "poor", "needs",
    "need", "attention", "problem", "issue", "fix", "fixed", "should",
    "correct", "incorrect", "empty", "stub", "placeholder", "real", "proper",
    "does", "doesn", "cannot", "never", "always", "still", "used", "uses"]);

function contentWords(text) {
    return new Set(String(text || "").toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 3 && !STOPWORDS.has(w)));
}

/**
 * ARE THESE TWO COMPLAINTS THE SAME COMPLAINT?
 *
 * Exact fingerprint equality was the first attempt, and it made agreement
 * nearly impossible to detect: two reviewers who both notice a missing contact
 * page write it in different words, so they fingerprinted differently, merged
 * as two findings, and BOTH were then flagged as raised-by-one — contested.
 * A signal that fires on almost everything is not a signal.
 *
 * Same file plus a real overlap of meaningful words is the honest test. It is
 * deliberately not clever: no embeddings, no model call to compare two
 * sentences, because that would put a third opinion in the middle of measuring
 * the first two.
 */
function sameFinding(a, b) {
    const fa = String(a.file || "").toLowerCase().trim();
    const fb = String(b.file || "").toLowerCase().trim();
    if (fa !== fb) return false;
    if (fingerprint(a) === fingerprint(b)) return true;
    const wa = contentWords(a.issue), wb = contentWords(b.issue);
    if (!wa.size || !wb.size) return false;
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared++;
    // TWO shared subject words, minimum. One is coincidence — "first problem
    // alpha" and "first problem bravo" share a word and are different
    // findings, and merging them would hide one of them. Hiding a finding is
    // the worse error here: a false split shows the operator two entries for
    // one problem, a false merge shows them nothing for the second.
    if (shared < 2) return false;
    // overlap against the SMALLER set: a terse finding and a wordy one
    // describing the same problem must still meet
    return shared / Math.min(wa.size, wb.size) >= 0.5;
}

/** Parse one reviewer's reply. Anything unparseable is NO findings — a
 *  reviewer that cannot answer must never become a bottleneck that blocks
 *  work, and must never be counted as having cleared it either. */
function parseFindings(text) {
    const raw = String(text || "");
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return { findings: [], parsed: false };
    const p = parseToolJson(m[0]);
    const val = p && p.value;
    if (!val || !Array.isArray(val.findings)) return { findings: [], parsed: false };
    const findings = val.findings
        .filter(f => f && (f.issue || f.problem))
        .slice(0, 5)
        .map(f => ({
            file: String(f.file || "").trim().slice(0, 200),
            issue: String(f.issue || f.problem).trim().replace(/\s+/g, " ").slice(0, 300),
            fix: String(f.fix || "").trim().replace(/\s+/g, " ").slice(0, 300),
            severity: /^(high|medium|low)$/i.test(String(f.severity))
                ? String(f.severity).toLowerCase() : "medium"
        }));
    return { findings, parsed: true };
}

/**
 * Merge the panel's findings.
 *
 * NOTHING IS VOTED AWAY. A finding raised by one mandate survives exactly as a
 * finding raised by four does — the whole reason the reviewers are blind is
 * that a lone voice is the one carrying new information. What the count
 * changes is ORDER: a contested finding (raised by one reviewer, on a file
 * other reviewers read and did not complain about) is surfaced first, because
 * that disagreement is the signal this design exists to produce.
 */
function mergeFindings(perReviewer) {
    const merged = [];
    const reviewedOk = new Set();      // mandates that returned a clean sheet
    for (const r of perReviewer) {
        if (!r || !r.parsed) continue;
        if (!r.findings.length) { reviewedOk.add(r.key); continue; }
        for (const f of r.findings) {
            // matched by MEANING, not by exact wording — see sameFinding
            const cur = merged.find(m => sameFinding(m, f));
            if (cur) {
                if (!cur.raisedBy.includes(r.key)) cur.raisedBy.push(r.key);
                // keep the most serious wording of the same complaint
                if (SEV[f.severity] > SEV[cur.severity]) {
                    cur.severity = f.severity; cur.issue = f.issue; cur.fix = f.fix || cur.fix;
                }
            } else {
                merged.push({ ...f, key: fingerprint(f), raisedBy: [r.key] });
            }
        }
    }
    const findings = merged.map(f => ({
        ...f,
        // one mandate raised it while at least one other reviewed the same
        // work and raised nothing: a real disagreement, not a consensus
        contested: f.raisedBy.length === 1 && reviewedOk.size > 0
    }));
    findings.sort((a, b) =>
        (b.contested - a.contested) || (SEV[b.severity] - SEV[a.severity]));
    return { findings, cleanSweep: [...reviewedOk] };
}

const SEV = { high: 3, medium: 2, low: 1 };

/* ------------------------------------------------------- the review pass */

/**
 * Run the panel once over the current artefacts.
 *
 * `width` is the driver's concurrency, decided by the caller and never here:
 * 1 on a local model (one resident model — physics), wider on an API or a
 * linked node, which serve concurrent requests.
 */
async function reviewOnce(session, opts) {
    const { goal, artifacts, width = 1, cancelToken = {}, onReviewer = () => {} } = opts;
    // what is left of the allowance. A wide panel launches several reviewers
    // at once, so the cap has to be consulted BETWEEN batches too — checking
    // only between rounds let one round overshoot it by three reviewers.
    const remainingUsd = typeof opts.remainingUsd === "number" ? opts.remainingUsd : Infinity;
    const userBlock =
        `REQUEST:\n${goal}\n\nFILES PRODUCED:\n${artifactBlock(artifacts)}`;

    const results = [];
    let cost = 0, tokens = 0, calls = 0, priced = false;

    const runOne = async (rev) => {
        onReviewer({ key: rev.key, label: rev.label, status: "running" });
        if (cancelToken.cancelled) return { key: rev.key, findings: [], parsed: false };
        let res;
        try {
            // the reviewers run on the SESSION's model — reviewing work on a
            // different model than produced it is a fair design, but not one
            // the operator chose, and it would bill an endpoint they did not
            // pick for this conversation
            res = await router.generate([
                { role: "system", content: rev.system + REVIEW_FORMAT },
                { role: "user", content: userBlock }
            ], REVIEW_TOKENS, cancelToken, null,
                opts.selection !== undefined ? { selection: opts.selection } : {});
        } catch (err) {
            res = { error: String((err && err.message) || err) };
        }
        calls++;
        if (res && res.usage) {
            tokens += Number(res.usage.total_tokens
                || ((res.usage.prompt_tokens || 0) + (res.usage.completion_tokens || 0))) || 0;
        }
        if (res && res.cost && typeof res.cost.usd === "number") {
            cost += res.cost.usd; priced = true;
        }
        // COST GOES WHERE COST ALREADY GOES. A review that spends money on a
        // paid endpoint appears in the Spend dashboard beside every other
        // call, attributed to the audit rather than to the user's message —
        // a second, private cost readout would be a second source of truth
        // about the same dollars.
        if (res && res.remote && res.usage) {
            try {
                require("./ledger").record({
                    sessionId: session.id, sessionTitle: session.title,
                    model: res.model, endpoint: res.endpoint,
                    inputTokens: res.usage.prompt_tokens,
                    outputTokens: res.usage.completion_tokens,
                    usd: (res.cost && res.cost.usd) || 0,
                    via: "self-audit", localNode: !!res.localNode
                });
            } catch { /* never fail a review over bookkeeping */ }
        }
        if (!res || res.error || cancelToken.cancelled) {
            // A reviewer that could not answer is NOT a reviewer that approved.
            // parsed:false keeps it out of the clean-sweep set, so a panel that
            // failed can never be reported as agreement.
            onReviewer({ key: rev.key, label: rev.label, status: "failed",
                         detail: (res && res.error) || "no answer" });
            return { key: rev.key, findings: [], parsed: false };
        }
        const out = parseFindings(res.content);
        onReviewer({ key: rev.key, label: rev.label,
                     status: out.parsed ? "done" : "failed",
                     count: out.findings.length,
                     detail: out.parsed
                         ? (out.findings.length
                             ? `${out.findings.length} finding${out.findings.length === 1 ? "" : "s"}`
                             : "no problems found")
                         : "unreadable answer" });
        return { key: rev.key, ...out };
    };

    // WIDTH IS A CEILING, NOT A TARGET. At width 1 this is a plain sequential
    // loop — the same shape the local driver has always had.
    const w = Math.max(1, Number(width) || 1);
    for (let i = 0; i < REVIEWERS.length; i += w) {
        if (cancelToken.cancelled) break;
        if (priced && cost >= remainingUsd) break;   // the cap binds inside a round too
        const batch = REVIEWERS.slice(i, i + w);
        const settled = await Promise.all(batch.map(r => runOne(r)
            .catch(() => ({ key: r.key, findings: [], parsed: false }))));
        results.push(...settled);
    }

    const merged = mergeFindings(results);
    return { ...merged, perReviewer: results,
             spend: { usd: priced ? cost : 0, tokens, calls, priced } };
}

/* ------------------------------------------------------------- the loop */

/** What the audit may spend before it stops. Settings win; the constant is
 *  the floor everyone gets without configuring anything. */
function budgetUsd(opts) {
    if (typeof opts.budgetUsd === "number" && opts.budgetUsd >= 0) return opts.budgetUsd;
    try {
        const paths = require("./paths");
        const v = Number(paths.readSettings().auditBudgetUsd);
        if (Number.isFinite(v) && v >= 0) return v;
    } catch { /* the constant below is the answer */ }
    return DEFAULT_BUDGET_USD;
}

/**
 * PRODUCE -> ATTACK -> FIX -> RE-CHECK, with a conclusion.
 *
 * `repair(findings, round)` is supplied by the caller — it is the thing that
 * can actually change files (a step-mode agent turn), and keeping it out of
 * here means this module never becomes a second way to run the agent.
 * It returns the changes it made, which become the artefacts of the next
 * round: the re-check reads what the repair actually wrote, not what it said.
 *
 * Returns everything the caller needs to TELL the operator what happened —
 * rounds run, findings surfaced, what was repaired, what remains, and the cost.
 */
async function runAudit(session, opts = {}) {
    const goal = String(opts.goal || "").trim();
    const cancelToken = opts.cancelToken || { cancelled: false };
    const onPhase = typeof opts.onPhase === "function" ? opts.onPhase : () => {};
    const onReviewer = typeof opts.onReviewer === "function" ? opts.onReviewer : () => {};
    const repair = typeof opts.repair === "function" ? opts.repair : null;
    const width = Math.max(1, Number(opts.width) || 1);
    const maxRounds = Math.max(1, Math.min(Number(opts.maxRounds) || MAX_ROUNDS, MAX_ROUNDS));
    const cap = budgetUsd(opts);

    let changes = [...(opts.changes || [])];
    const seen = [];                      // findings already surfaced (by shape)
    const rounds = [];
    const repaired = [];
    // only what the REPAIRS wrote, kept apart from the work's own changes so a
    // caller can append the delta instead of re-appending the whole turn
    const repairChanges = new Map();
    // A repair is an ordinary agent turn, so it can STAGE a confirm-class
    // action (a delete, a script, a server). Those are carried out to the
    // caller — the only thing that can put them in front of a human. Dropping
    // them here would build the card and throw it away, which is the exact
    // failure the orchestrator's own staged-approval path exists to prevent.
    const stagedApprovals = new Map();
    // ...and the proposal-bearing MESSAGE behind each, keyed by proposal id. The
    // approval CARD renders only from a role:"tool" message carrying `.proposal`;
    // carrying the id without the message fires the tray toast but draws no card.
    const stagedMessages = new Map();
    let spend = { usd: 0, tokens: 0, calls: 0, priced: false };
    let stopped = "complete";             // why the loop ended — always stated

    // A BUDGET OF NOTHING MEANS DO NOT SPEND. Checked before the first call,
    // not between rounds — "the cap binds from round two onwards" is not a cap.
    // A local model and a linked node cost nothing, so this only
    // ever stops a review that would actually be billed.
    if (cap <= 0 && willBeBilled(opts.selection)) {
        return { ran: false, rounds: [], remaining: [], contested: [], repaired: [],
                 changes: [], repairChanges: [], pendingApprovals: [], stagedMessages: [],
                 spend: { usd: 0, tokens: 0, calls: 0, priced: false },
                 stopped: "budget",
                 summary: "Not reviewed — the review budget is set to zero." };
    }

    for (let round = 1; round <= maxRounds; round++) {
        if (cancelToken.cancelled) { stopped = "cancelled"; break; }
        // BUDGET IS CHECKED BEFORE SPENDING, not after. A pass that would
        // start over the cap does not start — and reviewOnce is handed the
        // remaining allowance so a wide panel cannot blow past it mid-round.
        if (spend.priced && spend.usd >= cap) { stopped = "budget"; break; }

        const artifacts = readArtifacts(session, changes);
        onPhase({ phase: "audit", round, maxRounds, reviewers: REVIEWERS.length,
                  files: artifacts.length, status: "running" });

        const pass = await reviewOnce(session, {
            goal, artifacts, width, cancelToken, onReviewer,
            selection: opts.selection,
            remainingUsd: cap - spend.usd });

        spend = { usd: spend.usd + pass.spend.usd, tokens: spend.tokens + pass.spend.tokens,
                  calls: spend.calls + pass.spend.calls,
                  priced: spend.priced || pass.spend.priced };

        const answered = pass.perReviewer.filter(r => r.parsed).length;

        // NOTHING NEW ENDS IT. A finding already surfaced in an earlier round
        // is not evidence of progress stalling — it is the SAME finding, and a
        // loop that keeps re-fixing it is the infinite loop this must not be.
        const fresh = pass.findings.filter(f => !seen.some(s => sameFinding(s, f)));

        rounds.push({
            round,
            findings: pass.findings,
            fresh: fresh.length,
            cleanSweep: pass.cleanSweep,
            reviewersAnswered: answered,
            spend: pass.spend
        });
        onPhase({ phase: "audit", round, maxRounds, status: "reviewed",
                  answered, found: pass.findings.length, fresh: fresh.length,
                  contested: pass.findings.filter(f => f.contested).length });

        // A CANCEL IS NOT A CLEAN BILL OF HEALTH. This check has to sit ABOVE
        // the no-findings branch: a cancel lands mid-panel, leaves an empty
        // result, and would otherwise be laundered into "no objections".
        if (cancelToken.cancelled) { stopped = "cancelled"; break; }
        // NOR IS A PANEL NOBODY ANSWERED. Zero findings from four reviewers
        // that all failed is silence, not agreement — and reporting it as
        // "reviewed, no objections" is the exact rubber stamp this design
        // exists to prevent. The engine being unloaded by the memory guard
        // makes this the most likely failure on a local driver, not a rare one.
        if (!answered) { stopped = "review-unavailable"; break; }
        if (!fresh.length) { stopped = round === 1 ? "clean" : "nothing-new"; break; }
        if (!repair) { stopped = "no-repair"; break; }
        if (round === maxRounds) { stopped = "ceiling"; break; }

        // Only what is actually about to be repaired is marked seen. Marking
        // the overflow as seen too made the NEXT round read "nothing new" and
        // stop — quietly retiring findings that were never touched.
        const todo = fresh.slice(0, MAX_REPAIRS_PER_ROUND);
        seen.push(...todo);
        onPhase({ phase: "audit", round, maxRounds, status: "repairing", fixing: todo.length });
        let made = [];
        try {
            const out = await repair(todo, round) || [];
            // a repair may hand back either a plain change list or the fuller
            // { changes, pendingApprovals, costUsd } — all are accepted
            made = Array.isArray(out) ? out : (out.changes || []);
            if (!Array.isArray(out)) {
                for (const p of out.pendingApprovals || []) {
                    if (p && p.id) stagedApprovals.set(p.id, p);
                }
                for (const m of out.newMessages || []) {
                    if (m && m.proposal && m.proposal.id) stagedMessages.set(m.proposal.id, m);
                }
                // THE REPAIR'S OWN TOKENS ARE PART OF THE REVIEW'S COST. It is
                // a model call this loop chose to make; leaving it out of the
                // total made the reported figure smaller than the real one.
                if (out.costUsd > 0) {
                    spend = { ...spend, usd: spend.usd + out.costUsd, priced: true };
                }
            }
        } catch { made = []; }
        // the next round reads what the repair actually wrote
        const byPath = new Map(changes.map(c => [c.path, c]));
        for (const c of made) if (c && c.path) { byPath.set(c.path, c); repairChanges.set(c.path, c); }
        changes = [...byPath.values()];
        // CLAIMED FIXED ONLY IF SOMETHING CHANGED. This used to record the
        // attempt, so a repair that wrote nothing still reported "fixed 1
        // issue" beside work that was untouched.
        if (!made.length) { stopped = "repair-made-no-change"; break; }
        repaired.push(...todo.map(f => ({ round, file: f.file, issue: f.issue })));
    }

    const last = rounds[rounds.length - 1] || { findings: [], cleanSweep: [] };
    const remaining = last.findings || [];
    const answered = last.reviewersAnswered || 0;
    return {
        ran: rounds.length > 0,
        rounds, stopped,
        remaining,
        contested: remaining.filter(f => f.contested),
        repaired,
        changes,
        repairChanges: [...repairChanges.values()],
        pendingApprovals: [...stagedApprovals.values()],
        stagedMessages: [...stagedMessages.values()],
        spend,
        answered,
        reviewers: REVIEWERS.map(r => ({ key: r.key, label: r.label })),
        summary: summarise({ rounds, stopped, remaining, repaired, spend, answered })
    };
}

/** Would a review actually be billed? A local model and a linked node are
 *  free, so a zero budget must not silence a review that costs
 *  nothing. Unknown answers "no" — a cap must never block work on a guess. */
function willBeBilled(sel) {
    try {
        if (!router.usingRemote(sel)) return false;
        const cloudModels = require("./cloudModels");
        // the endpoint THIS session is on: a node is free, so a zero budget
        // must not silence a review that costs nothing — and a paid app
        // default must not silence one on a session that is not using it
        if (sel !== undefined) return !cloudModels.isNodeEndpoint(sel);
        return !cloudModels.selectedIsNode();
    } catch { return false; }
}

/**
 * One honest sentence for the transcript.
 *
 * A clean panel is reported as WEAK EVIDENCE, in those words. Four reviewers
 * that cannot see each other still share a model and a prompt style, so "none
 * of them objected" is not the same as "this is right", and saying it plainly
 * is the difference between a check and a rubber stamp.
 */
function summarise({ rounds, stopped, remaining, repaired, spend, answered }) {
    if (!rounds.length) return "";
    const n = rounds.length;
    const bits = [];
    // A REVIEW THAT DID NOT HAPPEN SAYS SO. This is the sentence the operator
    // reads next to the word "Done", so it must never claim a panel that was
    // never heard from — the whole loop is worth nothing if its report is the
    // one thing that cannot be trusted.
    if (stopped === "review-unavailable") {
        return "NOT reviewed — no reviewer could be reached, so this work has " +
               "not been checked. Nothing here is evidence that it is right.";
    }
    // ...and one that was only partly heard says how many answered, rather
    // than always claiming the full panel
    const heard = Number.isInteger(answered) ? answered : REVIEWERS.length;
    bits.push(heard >= REVIEWERS.length
        ? `Reviewed by ${REVIEWERS.length} independent reviewers` +
          (n > 1 ? ` over ${n} rounds` : "")
        : `Reviewed by ${heard} of ${REVIEWERS.length} independent reviewers ` +
          `(${REVIEWERS.length - heard} could not be reached)` +
          (n > 1 ? `, over ${n} rounds` : ""));
    if (repaired.length) bits.push(`fixed ${repaired.length} issue${repaired.length === 1 ? "" : "s"}`);
    if (remaining.length) {
        const contested = remaining.filter(f => f.contested).length;
        bits.push(`${remaining.length} open` + (contested ? ` (${contested} contested)` : ""));
    } else if (stopped === "clean" || stopped === "nothing-new") {
        bits.push("no objections — weak evidence, not proof");
    }
    if (stopped === "ceiling") bits.push("stopped at the round limit");
    if (stopped === "budget") bits.push("stopped at the review budget");
    if (stopped === "cancelled") bits.push("stopped");
    if (spend.priced && spend.usd > 0) bits.push(`review cost $${spend.usd.toFixed(4)}`);
    return bits.join(" · ") + ".";
}

/** The findings, written for a person rather than for a parser. */
function findingsText(findings) {
    return (findings || []).map(f => {
        const where = f.file ? `${f.file}: ` : "";
        const who = f.contested
            ? ` (raised by one reviewer only — the others did not flag it)` : "";
        return `- ${where}${f.issue}${who}`;
    }).join("\n");
}

/** One repair instruction: what is wrong, where, and what would fix it. */
function repairInstruction(goal, findings) {
    return `Overall goal: ${goal}\n\n` +
        "A review of the work you just produced found these problems:\n" +
        findings.map(f => `- ${f.file ? f.file + ": " : ""}${f.issue}` +
                          (f.fix ? `\n  Suggested fix: ${f.fix}` : "")).join("\n") +
        "\n\nFix exactly these, by rewriting the affected files completely with " +
        "the real, corrected content. Do not explain — make the changes.\n\n" +
        QUALITY_BRIEF;
}

/**
 * THE WHOLE PASS, WIRED — reviewers, repair, and the progress the operator
 * watches it through.
 *
 * Both drivers call THIS: the orchestrator after its plan, and the ordinary
 * agent turn after work that wrote files. One audit, one place, whether the
 * model driving is on this laptop, on an API, or on a linked node —
 * "where a model runs is an implementation detail" has to be true of the thing
 * that checks the work too, or the check is the one part that only some
 * drivers get.
 *
 * `agent` is required lazily so this module stays loadable by tests that never
 * touch the tool loop, and so no import cycle can form.
 */
async function auditAndRepair(session, opts = {}) {
    const onTask = typeof opts.onTask === "function" ? opts.onTask : () => {};
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
    const cancelToken = opts.cancelToken || { cancelled: false };
    const changes = (opts.changes || []).filter(c => c && c.path);
    const goal = String(opts.goal || "").trim();
    const auditId = (opts.planId || "turn-" + Date.now()) + "-audit";

    // Nothing produced, nothing to attack. Said plainly rather than run as an
    // empty ceremony that costs four model calls to conclude nothing.
    if (!goal || !changes.length || !session.repoPath) {
        return { ran: false, rounds: [], remaining: [], contested: [], repaired: [],
                 changes: [], repairChanges: [], pendingApprovals: [], stagedMessages: [],
                 spend: { usd: 0, tokens: 0, calls: 0, priced: false },
                 stopped: "nothing-to-review", summary: "" };
    }

    onTask({ id: auditId, n: 0, total: REVIEWERS.length, title: "Reviewing the work",
             status: "running", detail: `${REVIEWERS.length} reviewers, independently` });
    let answered = 0;

    const result = await runAudit(session, {
        goal, changes, width: opts.width, cancelToken,
        // THE PANEL RUNS ON THE SESSION'S MODEL. Dropped between these two
        // hops, the four reviewers silently ran on the app default while the
        // repair beside them ran on the session's — half the audit billed to
        // an endpoint this conversation never chose, and reading the work at
        // the wrong model's window.
        selection: opts.selection,
        budgetUsd: opts.budgetUsd,
        onPhase: (info) => {
            onProgress({ phase: "audit", detail: info });
            if (info.status === "repairing") {
                onTask({ id: auditId, n: answered, total: REVIEWERS.length,
                         title: "Fixing what the review found", status: "running",
                         detail: `round ${info.round}: ${info.fixing} to fix` });
            }
        },
        onReviewer: (r) => {
            // ONE ROW PER MANDATE. The wait is legible: which question is being
            // asked right now, and what it came back with — rather than a
            // single opaque "reviewing…" for the length of four model calls.
            if (r.status !== "running") answered++;
            onTask({ id: `${auditId}-${r.key}`, n: 0, total: 0,
                     title: `Review: ${r.label}`,
                     status: r.status === "running" ? "running"
                         : r.status === "failed" ? "failed" : "done",
                     detail: r.detail || "" });
            onProgress({ phase: "audit-reviewer", detail: r });
        },
        repair: async (findings, round) => {
            // The repair is an ordinary step-mode agent turn: same policy
            // kernel, same backups, same write guard. The audit never gets its
            // own privileged way to touch files.
            const agent = require("./agent");
            const res = await agent.runTurn(session,
                repairInstruction(goal, findings),
                { stepMode: true, cancelToken,
                  // the repair runs on the session's model, like the work it
                  // is repairing
                  selection: opts.selection,
                  // the repair's tokens belong to the AUDIT in the ledger, not
                  // to the user's message — otherwise the Spend view attributes
                  // work nobody asked for to the person who did not ask for it
                  ledgerVia: "self-audit",
                  // A REPAIR MUST NOT ASK A QUESTION. It is a sub-turn nobody
                  // is watching for, and forwarding its clarify/approval phases
                  // put the session into "waiting" and notified the operator
                  // about a question that exists in no transcript. Those phases
                  // are reported as audit progress instead.
                  onProgress: (info) => {
                      const p = String((info && info.phase) || "");
                      if (p === "clarify" || p === "needs-approval") {
                          return onPhase({ phase: "audit", round, status: "repairing",
                                           note: p === "clarify"
                                               ? "the repair asked a question; it was not shown"
                                               : "the repair staged an action for approval" });
                      }
                      onProgress({ ...info, auditRound: round });
                  } })
                .catch(err => ({ ok: false, error: String((err && err.message) || err) }));
            return { changes: (res && res.changes) || [],
                     pendingApprovals: (res && res.pendingApprovals) || [],
                     // the proposal MESSAGE too, or the card the repair staged is
                     // registered (tray fires) but never drawn (see runGoal)
                     newMessages: (res && res.newMessages) || [],
                     costUsd: (res && res.costUsd) || 0 };
        }
    });

    // THE ROW MUST NOT OUTRANK THE TRUTH. "Review complete / done" beside a
    // review that was cancelled or that no reviewer answered is the same lie
    // as a clean summary, just in a smaller font.
    const failed = result.stopped === "review-unavailable" || result.stopped === "error";
    const detail = result.summary ||
        (result.stopped === "cancelled" ? "stopped" : "reviewed");
    onTask({ id: auditId, n: result.answered || 0, total: REVIEWERS.length,
             title: failed ? "Review could not run"
                 : result.stopped === "cancelled" ? "Review stopped" : "Review complete",
             status: result.stopped === "cancelled" ? "cancelled" : failed ? "failed" : "done",
             detail });
    return result;
}

module.exports = {
    runAudit, auditAndRepair, reviewOnce, mergeFindings, parseFindings, fingerprint,
    readArtifacts, repairInstruction, findingsText, summarise,
    critiqueStep, expectsFile,
    REVIEWERS, QUALITY_BRIEF,
    MAX_ROUNDS, MAX_REPAIRS_PER_ROUND, DEFAULT_BUDGET_USD
};
