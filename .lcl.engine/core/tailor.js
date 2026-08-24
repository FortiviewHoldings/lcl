const fs = require("fs");
const path = require("path");
const paths = require("./paths");

/**
 * WHAT THIS INSTALL HAS LEARNED ABOUT THE PERSON USING IT.
 *
 * The product goal: a genuinely agentic assistant that tailors itself to
 * whoever is using it — how they operate, what makes them tick — kept entirely
 * local to their own copy installed on their machine.
 *
 * The About-you screen is a QUESTIONNAIRE: it knows only what somebody typed
 * into it once. This is the other half — what the app notices from how the
 * work actually goes. How long their messages run. Whether being asked a
 * clarifying question helps or annoys them. Whether they want the reasoning or
 * just the answer. Which model they reach for. What they keep correcting.
 *
 * THREE RULES THIS MODULE IS BUILT AROUND:
 *
 * 1. IT NEVER CALLS A MODEL. Every fact here is arithmetic over the session
 *    files already on disk. Nothing in this module sends anything anywhere.
 *
 *    THAT IS NOT THE SAME AS SAYING IT CANNOT LEAVE, and this comment used to
 *    claim it was. What promptBlock() returns is added to the system prompt,
 *    and a system prompt goes wherever the turn goes: to a local model it stays
 *    on this machine, to a linked API it is in the request body like everything
 *    else. A review traced it end to end — agent.js -> buildModelMessages ->
 *    router.generate -> cloudModels.streamChat -> POST — and the claim was
 *    simply false for any session driven by a paid model.
 *
 *    So the claim is now enforced rather than asserted. agent.js omits this
 *    block entirely on a remote turn unless the session holds the "tailoring"
 *    permission (sessionPerms.js), which is off by default like every other
 *    permission. A profile of a person is not something a third party gets
 *    because a default was convenient.
 *
 * 2. IT IS WRITTEN WHERE A PERSON CAN READ IT. One fact per file, in markdown,
 *    with what was observed, why it matters and how it is applied — the same
 *    shape as hand-kept memory notes. Anything
 *    stored about somebody that they cannot open in a text editor is a thing
 *    done TO them.
 *
 * 3. IT NEEDS EVIDENCE. A fact appears only after it has been seen enough
 *    times to not be a coincidence, and it says how many times. A confident
 *    claim from two data points is how a product starts telling people who
 *    they are instead of noticing what they do.
 */

/** Observations needed before a signal becomes a stated fact. */
const MIN_OBSERVATIONS = 4;
/** Facts are kept small and few: this is a profile, not a dossier. */
const MAX_FACTS = 24;

function learnedDir() {
    const dir = path.join(paths.dataDir(), "learned");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function indexPath() { return path.join(learnedDir(), "LEARNED.md"); }

/* --------------------------------------------------------------- storage */

function factPath(name) {
    const safe = String(name).replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
    return path.join(learnedDir(), `${safe}.md`);
}

/**
 * One fact, as a file a person can read, edit or delete.
 *
 * The frontmatter is the machine's half; the body is the human's. Both are in
 * the same file on purpose — a store that needs a viewer to be legible is a
 * store nobody checks.
 */
function writeFact({ name, description, kind, observations, confidence, what, why, how }) {
    const body = [
        "---",
        `name: ${name}`,
        `description: ${String(description || "").replace(/\n/g, " ")}`,
        `kind: ${kind || "habit"}`,
        `observations: ${observations || 0}`,
        `confidence: ${confidence || "low"}`,
        `updated: ${new Date().toISOString()}`,
        "---",
        "",
        what,
        "",
        `**Why:** ${why}`,
        "",
        `**How to apply:** ${how}`,
        ""
    ].join("\n");
    // ONE UNWRITABLE FACT MUST NOT COST THE OTHERS. A read-only folder, a full
    // disk or a file held open by an editor threw out of writeFact, out of
    // learn(), and into main.js's catch — so the remaining facts were never
    // written, the prune never ran, the index was never rebuilt, and nothing
    // anywhere said so. Every other write in this module already returns
    // instead of throwing; this one now matches.
    try { fs.writeFileSync(factPath(name), body, "utf8"); }
    catch { return null; }
    return factPath(name);
}

function parseFact(file) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!m) return null;
    const meta = {};
    for (const line of m[1].split("\n")) {
        const kv = /^([a-z]+):\s*(.*)$/i.exec(line.trim());
        if (kv) meta[kv[1]] = kv[2];
    }
    const bodyText = m[2].trim();
    const whatLine = bodyText.split("\n\n")[0] || "";
    return {
        name: meta.name || path.basename(file, ".md"),
        description: meta.description || "",
        kind: meta.kind || "habit",
        observations: Number(meta.observations) || 0,
        confidence: meta.confidence || "low",
        updated: meta.updated || null,
        what: whatLine,
        body: bodyText,
        file
    };
}

/** Everything this install has learned. Empty on a new install — the common case. */
function facts() {
    let names = [];
    try {
        names = fs.readdirSync(learnedDir())
            .filter(f => f.endsWith(".md") && f !== "LEARNED.md");
    } catch { return []; }
    return names.map(n => parseFact(path.join(learnedDir(), n)))
                .filter(Boolean)
                .sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
}

/** The one-line index, kept alongside — the same shape as hand-kept notes. */
function writeIndex() {
    const rows = facts().map(f => `- [${f.name}](${path.basename(f.file)}) — ${f.description}`);
    const head = [
        "# What this copy of .lcl has noticed",
        "",
        "Everything here was worked out on this machine, from how sessions actually",
        "went, without ever calling a model.",
        "",
        "A local model is given this as part of its instructions, which never leaves",
        "this computer. A paid API model is given it only if you turn on \"Send what",
        "it has learned about you to a paid model\" for that conversation; it is off",
        "unless you do.",
        "",
        "Delete any file to forget that one thing; delete them all to start over.",
        ""
    ];
    try { fs.writeFileSync(indexPath(), head.concat(rows).join("\n") + "\n", "utf8"); }
    catch { /* the facts are the record; the index is a convenience */ }
}

function forget(name) {
    try { fs.unlinkSync(factPath(name)); writeIndex(); return { ok: true }; }
    catch { return { ok: false, error: "nothing by that name" }; }
}

/** ONE OBVIOUS ACTION. Everything learned, gone — files and index together. */
function forgetEverything() {
    let removed = 0;
    try {
        for (const f of fs.readdirSync(learnedDir())) {
            if (f.endsWith(".md")) { fs.unlinkSync(path.join(learnedDir(), f)); removed++; }
        }
    } catch { /* nothing to remove */ }
    writeIndex();
    return { ok: true, removed };
}

/* ------------------------------------------------------------- observing */

const CORRECTION_RE = /\b(no,|nope|that'?s not|thats not|not what i|wrong|try again|i said|actually,|instead|you (missed|forgot|ignored))\b/i;
const WANTS_ANSWER_RE = /\b(just (the )?(answer|do it|give)|skip the|no preamble|get to the point|stop explaining|too (long|much))\b/i;
const WANTS_DETAIL_RE = /\b(explain|why|walk me through|in detail|show your work|reasoning)\b/i;

/**
 * Read the sessions on disk and work out what is true about how this person
 * works. Pure arithmetic over files that already exist — no model, no network,
 * and nothing retained except the counts below.
 */
function observe(sessions) {
    const seen = {
        messages: 0, totalChars: 0, longMessages: 0,
        corrections: 0, wantsAnswer: 0, wantsDetail: 0,
        clarifyAsked: 0, clarifyAnswered: 0,
        models: {}, sessionsWithModel: 0
    };
    for (const s of sessions || []) {
        const msgs = Array.isArray(s.messages) ? s.messages : [];
        if (s.modelSel) {
            // TWO THINGS THIS KEY MUST NOT CARRY.
            //
            // The endpoint ID names one of the user's OWN endpoints, and
            // for a linked machine that is its hostname or address. Written
            // into a fact it reached the system prompt, so one vendor could be
            // told the private address of a node the user also runs, and
            // which competing vendor they prefer. Only the model name is ever
            // the point of this fact.
            //
            // And the model name is a string the ENDPOINT chose, not one this
            // app authored: it arrives from a models listing and ends up in a
            // prompt. A name carrying a newline and its own "How to apply"
            // line would have written the model an instruction. Reduced here to
            // the characters a model id legitimately uses.
            const rawKey = typeof s.modelSel === "string"
                ? s.modelSel
                : (s.modelSel.local || s.modelSel.model || "");
            const key = String(rawKey).replace(/[^\w.:/-]+/g, " ").trim().slice(0, 80);
            if (key) {
                seen.sessionsWithModel++;
                seen.models[key] = (seen.models[key] || 0) + 1;
            }
        }
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (!m || m.role !== "user") continue;
            const text = String(m.content || "");
            seen.messages++;
            seen.totalChars += text.length;
            if (text.length > 400) seen.longMessages++;
            if (CORRECTION_RE.test(text)) seen.corrections++;
            if (WANTS_ANSWER_RE.test(text)) seen.wantsAnswer++;
            if (WANTS_DETAIL_RE.test(text)) seen.wantsDetail++;
            // was the PREVIOUS assistant message a clarifying question, and did
            // this one answer it or push past it?
            const prev = msgs[i - 1];
            if (prev && prev.role === "assistant" && prev.meta && prev.meta.clarify) {
                seen.clarifyAsked++;
                if (!CORRECTION_RE.test(text) && text.length < 300) seen.clarifyAnswered++;
            }
        }
    }
    return seen;
}

/** Turn observations into facts — only the ones the evidence actually supports. */
function learn(sessions) {
    const seen = observe(sessions);
    const written = [];
    const avg = seen.messages ? Math.round(seen.totalChars / seen.messages) : 0;

    if (seen.messages >= MIN_OBSERVATIONS) {
        const long = seen.longMessages / seen.messages > 0.4;
        written.push(writeFact({
            name: "message-length",
            description: long
                ? "writes long, detailed messages — match that with substance, not brevity"
                : "writes short messages — answer without a preamble",
            kind: "habit",
            observations: seen.messages,
            confidence: seen.messages >= 20 ? "high" : "medium",
            what: long
                ? `Their messages average ${avg} characters, and ${Math.round(seen.longMessages / seen.messages * 100)}% run long.`
                : `Their messages average ${avg} characters and are usually short.`,
            why: long
                ? "Someone who writes at length has already given the context, and a reply " +
                  "that asks for it again wastes the effort they just made."
                : "Someone who writes tersely is not asking for an essay back.",
            how: long
                ? "Answer at the depth they wrote at. Do not ask for detail they already gave."
                : "Lead with the answer. Keep the supporting detail to what changes a decision."
        }));
    }

    if (seen.clarifyAsked >= MIN_OBSERVATIONS) {
        const helpful = seen.clarifyAnswered / seen.clarifyAsked > 0.6;
        written.push(writeFact({
            name: "clarifying-questions",
            description: helpful
                ? "answers clarifying questions — asking first is welcome"
                : "does not want to be asked — make a reasonable choice and say what you assumed",
            kind: "preference",
            observations: seen.clarifyAsked,
            confidence: seen.clarifyAsked >= 10 ? "high" : "medium",
            what: `Asked to clarify ${seen.clarifyAsked} times; they answered plainly ` +
                  `${seen.clarifyAnswered} of those.`,
            why: helpful
                ? "A question that gets answered saves a wrong attempt."
                : "A question that gets pushed past is a delay, not a courtesy — they would " +
                  "rather see an attempt they can correct.",
            how: helpful
                ? "Ask when the request is genuinely ambiguous."
                : "Choose the most reasonable reading, act on it, and state the assumption " +
                  "in one line so it is cheap to correct."
        }));
    }

    const depthSignals = seen.wantsAnswer + seen.wantsDetail;
    if (depthSignals >= MIN_OBSERVATIONS) {
        const wantsAnswer = seen.wantsAnswer > seen.wantsDetail;
        written.push(writeFact({
            name: "answer-depth",
            description: wantsAnswer
                ? "wants the answer, not the working"
                : "wants the reasoning, not just the conclusion",
            kind: "preference",
            observations: depthSignals,
            confidence: depthSignals >= 10 ? "high" : "medium",
            what: wantsAnswer
                ? `Asked for less explanation ${seen.wantsAnswer} times, more ${seen.wantsDetail}.`
                : `Asked for reasoning ${seen.wantsDetail} times, less explanation ${seen.wantsAnswer}.`,
            why: wantsAnswer
                ? "They have said so repeatedly. Continuing to explain is not thoroughness, " +
                  "it is not listening."
                : "They check the working, so a bare conclusion gives them nothing to check.",
            how: wantsAnswer
                ? "State the result first. Offer the reasoning only if asked."
                : "Show the steps that matter, then the conclusion."
        }));
    }

    if (seen.corrections >= MIN_OBSERVATIONS) {
        written.push(writeFact({
            name: "correction-rate",
            description: "corrects often — check the request against what was actually asked before answering",
            kind: "signal",
            observations: seen.corrections,
            confidence: seen.corrections >= 10 ? "high" : "medium",
            what: `${seen.corrections} of ${seen.messages} messages were corrections of a previous answer.`,
            why: "A high correction rate is not a personality trait; it is feedback that " +
                 "answers are landing next to the request rather than on it.",
            how: "Before answering, restate the request to yourself and check the answer " +
                 "against it. Prefer asking one sharp question over a confident near-miss."
        }));
    }

    const modelPicks = Object.entries(seen.models).sort((a, b) => b[1] - a[1]);
    if (modelPicks.length && modelPicks[0][1] >= MIN_OBSERVATIONS) {
        written.push(writeFact({
            name: "model-preference",
            description: `reaches for ${modelPicks[0][0]} most often`,
            kind: "habit",
            observations: modelPicks[0][1],
            confidence: "medium",
            what: `Of ${seen.sessionsWithModel} conversations that chose a model, ` +
                  `${modelPicks[0][1]} chose ${modelPicks[0][0]}.`,
            why: "The model they pick is a statement about what they are doing — and about " +
                 "what they are willing to spend on it.",
            how: "Offer that one first for similar work. Never switch a conversation to it " +
                 "on their behalf."
        }));
    }

    // A FACT THAT IS NO LONGER TRUE MUST STOP BEING STATED.
    //
    // learn() re-derives from every session each time, so a claim that no
    // longer holds simply is not re-written — but the file from the last run
    // stayed on disk and kept going into the prompt. Delete a session, or
    // change how you work, and the model was still being told the old thing,
    // for good. These five names are the ones learn() owns; anything it did not
    // write this pass is no longer supported by the evidence.
    const OWNED = ["message-length", "clarifying-questions", "answer-depth",
                   "correction-rate", "model-preference"];
    const wrote = new Set(written.filter(Boolean).map(p => path.basename(p, ".md")));
    for (const name of OWNED) {
        if (!wrote.has(name) && fs.existsSync(factPath(name))) forget(name);
    }

    // keep it a profile, not a dossier
    const all = facts();
    if (all.length > MAX_FACTS) {
        for (const f of all.slice(MAX_FACTS)) { try { fs.unlinkSync(f.file); } catch { /* gone */ } }
    }
    writeIndex();
    // written counts what REACHED DISK: writeFact returns null when a write
    // fails, and reporting an intent as an outcome is how a silent failure
    // becomes invisible.
    return { written: written.filter(Boolean).length, observed: seen };
}

/* ------------------------------------------------------------ applying it */

/**
 * What the model is told. Empty on a new install — nothing learned, nothing
 * claimed. Only facts with real evidence behind them are stated, and each is
 * given as an instruction rather than as a description of the person.
 */
function promptBlock() {
    const f = facts().filter(x => x.observations >= MIN_OBSERVATIONS);
    if (!f.length) return "";
    const lines = ["\nWHAT THIS INSTALL HAS NOTICED ABOUT HOW THEY WORK — worked out on " +
                   "this machine from how sessions actually went, not from a form they " +
                   "filled in. Apply it; never recite it back at them:"];
    for (const x of f) {
        // The LAST one, not the first. Part of a body is built from strings
        // this app did not author, so a body that smuggled in its own
        // "**How to apply:**" earlier would otherwise be the line that reached
        // the model. The real instruction is always written last.
        const parts = String(x.body || "").split("**How to apply:**");
        const how = parts.length > 1 ? parts[parts.length - 1] : null;
        lines.push(`- ${x.description}${how ? ` → ${how.trim().split("\n")[0]}` : ""}`);
    }
    return lines.join("\n") + "\n";
}

/** A short line for the UI, so someone can see whether it has learned anything. */
function summary() {
    const f = facts();
    if (!f.length) return "nothing learned yet — it starts from what you tell it";
    return `${f.length} thing${f.length === 1 ? "" : "s"} noticed on this machine`;
}

module.exports = {
    facts, learn, observe, promptBlock, summary,
    forget, forgetEverything, learnedDir, writeFact, writeIndex,
    MIN_OBSERVATIONS, MAX_FACTS
};
