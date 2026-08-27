/**
 * ANCIENT KNOWLEDGE — the auditor's brain, kept apart from the loop that
 * swings it.
 *
 * agent.js owns WHEN to interrogate and when to force another round; this
 * module owns WHAT the interrogation says, HOW a verdict is read, and the
 * living ancient_knowledge.md that carries the whole session's progress and
 * gaps. Splitting it this way keeps the 1,000-line runTurn from growing an
 * essay, and makes every piece testable in plain node with no engine.
 *
 * The specification for this module:
 *
 *   Ancient Knowledge captures all, interrogates the output against the
 *   input, and forces the model to read and respond with action. This cycle
 *   continues until the entire request has been fulfilled. Once all gaps are
 *   closed and the only intervention still possible is the user's own
 *   function test, then and only then does it become the user's turn.
 *
 * Design debts owed to selfAudit.js, which learned these the hard way:
 *   - a blank auditor is "review-unavailable", NEVER "clean" — silence is
 *     not a verdict, and laundering it into one reports success when the
 *     auditor simply died;
 *   - a re-surfaced gap is not progress — the loop stops on nothing-new,
 *     not only on a hard ceiling;
 *   - every stop has a NAME, and the name is written where the user
 *     reads it.
 */
const fs = require("fs");
const path = require("path");
const fsTools = require("./fsTools");

/* ------------------------------------------------------------- the rounds */
/**
 * How many interrogate->force cycles a turn may run. Scales with the
 * reasoning-effort slider (0..4, Terrestrial..Multiversal): the deeper the
 * user asked the model to work, the longer the auditor may hold it.
 * This is a ceiling, not a target — closed/user-test/nothing-new usually
 * end the cycle first.
 */
function maxRounds(effortLevel) {
    const lvl = typeof effortLevel === "number"
        ? Math.max(0, Math.min(4, effortLevel)) : 0;
    return 2 + lvl;                                   // 2..6
}

/**
 * The per-turn spend ceiling for the cycle on BILLED selections, in USD —
 * auditor calls plus every forced driver response. Local and node runs cost
 * $0 and are bounded by rounds alone. When this trips, the review document
 * says "stopped: budget" rather than pretending the gaps closed.
 */
const BUDGET_USD = 0.50;

/* -------------------------------------------------------------- the words */
const SYSTEM =
    "You are the Ancient Knowledge overseer. You audit whether work is " +
    "TRULY complete. Evidence over claims — a thing is done only if the " +
    "response or the changed files show it done. Never say complete when " +
    "it is not. Never invent gaps to seem thorough.";

/*
 * THE USER'S GROUND RULES — soft, guardrailed, session-scoped.
 *
 * The auditor is a per-session agent the user can tailor. Their ground rules
 * ride ALONGSIDE the functional logic, never through it: they set tone,
 * emphasis and standing context, and can never change a verdict, mark
 * something closed that is not, or invent gaps. Same wall the ANSWER LIKE /
 * voice blocks enforce on the responder — style and manner only, never truth —
 * applied to the overseer. Read from the session (the record is truth; the
 * workspace companion file is a human-editable view of the same text).
 */
function groundRules(session) {
    // THE AGENT READS THE FILE. The design calls for an additional setting in
    // the workspace for the agent to read. When the companion file exists,
    // its body (below the header) is authoritative, so editing it directly
    // takes effect; otherwise the session field stands. Either way the settings
    // UI and the file stay in step because saving writes the file.
    if (session && session.repoPath) {
        try {
            const full = fsTools.resolveInRoot(session.repoPath, rulesFileName(session));
            if (fs.existsSync(full)) {
                // read-cap like every other read in the app; a rules file has no
                // business being large
                const raw = fs.readFileSync(full, "utf8").slice(0, 64_000);
                // strip only OUR generated header (an explicit sentinel), never a
                // markdown "---" a hand-authored file might use for real content —
                // that was dropping everything above the operator's first rule
                const m = /<!-- lcl-ak-rules -->\s*\n/.exec(raw);
                const body = m ? raw.slice(m.index + m[0].length) : raw;
                return body.trim().slice(0, 8000);
            }
        } catch { /* fall through to the session field */ }
    }
    const s = session && typeof session.akGroundRules === "string"
        ? session.akGroundRules.trim() : "";
    return s.slice(0, 8000);
}
function systemFor(session) {
    const g = groundRules(session);
    if (!g) return SYSTEM;
    return SYSTEM + "\n\nGROUND RULES — the user's standing instructions for " +
        "this conversation's audit:\n" + g + "\n" +
        "These set your emphasis, tone and the context you already know. They " +
        "NEVER change whether a part is genuinely done, never let you mark a " +
        "gap closed without evidence, never launder a blank audit into 'closed', " +
        "and never invent gaps to satisfy a preference. Evidence still decides " +
        "every verdict.";
}

/* The round ceiling: a session knob (akRounds, 1..8) overrides the
 * effort-derived default, so the user can tune how hard the agent presses. */
function effectiveMaxRounds(session) {
    const k = session && Number(session.akRounds);
    if (Number.isFinite(k) && k >= 1) return Math.max(1, Math.min(8, Math.round(k)));
    return maxRounds(session && session.effortLevel);
}

/**
 * The interrogation. Output-against-input, part by part, with this turn's
 * file changes and the standing review items in view — so a gap claimed
 * closed last turn that is not actually closed gets caught here, which is
 * exactly the moment the design requires it to be caught.
 */
function auditPrompt({ userAsk, response, changes, reviewDigest, round }) {
    const changed = (changes || [])
        .map(c => (c && (c.path || c.file)) || "").filter(Boolean);
    return (
        `The user asked:\n\n"""${String(userAsk).slice(0, 2000)}"""\n\n` +
        `The model's latest response` +
        (round > 1 ? ` (after ${round - 1} audit round${round === 2 ? "" : "s"})` : ``) +
        `:\n\n"""${String(response).slice(0, 4000)}"""\n\n` +
        `Files changed this turn: ` +
        (changed.length ? changed.slice(0, 20).join(", ") : "none") + `\n` +
        (reviewDigest ? `\n${reviewDigest}\n` : ``) +
        `\nInterrogate the response against the request, part by part. ` +
        `Do not trust claims of completion — only evidence. Then reply in ` +
        `EXACTLY this format, nothing else:\n\n` +
        `VERDICT: CLOSED\n` +
        `    (only if every part of the request is genuinely done)\n` +
        `VERDICT: USER-TEST\n` +
        `GAP: <what the user must now test by hand>\n` +
        `    (everything a model can do is done; only the user's own ` +
        `function test remains)\n` +
        `VERDICT: GAPS\n` +
        `GAP: <one specific unmet item — what is missing or wrong, and where>\n` +
        `GAP: <another, if any>`
    );
}

/**
 * The forcing move — a user-role instruction the driver cannot read as
 * praise. It demands ACTION: the driver re-enters the step loop with a
 * fresh tool budget, so "fix it" means files change and tools run through
 * every normal gate, not a paragraph promising they will.
 */
function forceInstruction(gaps, round, spin, idleRound) {
    const list = (gaps || []).slice(0, 12).map(g => `- ${g}`).join("\n");
    // THE ROUND THAT FOLLOWS A SPIN IS TOLD ABOUT THE SPIN.
    //
    // Observed in practice: a model called `list_dir` fifteen times with
    // identical arguments while promising each time to create index.html, and
    // never called write_file once. Forcing another round with
    // the same generic "do it now" wording invites the same fifteen calls. The
    // instruction names the tool that was being ground, forbids it outright,
    // and demands the tool that does the work — the one thing the model was
    // avoiding.
    const spinLine = spin && spin.tool
        ? `\n\nYou got stuck last round: you called \`${spin.tool}\` ` +
          `${spin.repeats} times in a row with identical arguments and changed ` +
          `nothing. Do NOT call \`${spin.tool}\` again this round. Call the tool ` +
          `that performs the work — with complete, real arguments — on your ` +
          `FIRST step. If a gap genuinely cannot be closed with the tools you ` +
          `have, say which one and why, and close the rest.`
        : ``;
    /* SAYING IT AGAIN, LOUDER, IS NOT A PLAN.
     *
     * "Address every gap NOW, with real work — use tools" reached the
     * model six times and produced six numbered plans and zero
     * calls. A round that ran and changed NOTHING — no successful tool call,
     * no file touched — has already proved that wording does not move this
     * model, so the round after it stops asking for work in general and names
     * the first call to make. The trigger is measured, not guessed: the loop
     * counts tool wins and file changes per round and hands the count in. */
    const idleLine = idleRound
        ? `\n\nROUND ${idleRound} CHANGED NOTHING — no tool call succeeded and ` +
          `no file was touched. Answering this round the way you answered ` +
          `that one produces the same result, so do not.\n\n` +
          `Your FIRST action must be a tool call, not a sentence: no ` +
          `preamble, no numbered plan, no "I will". If you do not know what ` +
          `is in the folder, that call is \`list_files\` with {"path": "."} ` +
          `— its result carries "total", and "nextOffset" when the folder ` +
          `runs past one page, so you can read all of it. Then open real ` +
          `files with \`read_file\` before describing anything.\n\n` +
          `If a gap genuinely cannot be closed with the tools you have, name ` +
          `the tool you would need and why. That is an answer. Another plan ` +
          `is not.`
        : ``;
    return (
        `**Ancient Knowledge audit — round ${round}.** The audit found these ` +
        `gaps between what was asked and what was delivered:\n${list}\n\n` +
        `Address every gap NOW, with real work — use tools, change files, ` +
        `verify results. Do not restate the plan, do not promise: DO it. ` +
        `Then state plainly what changed for each gap.` + spinLine + idleLine
    );
}

/* ------------------------------------------- answering FOR the operator */
/**
 * THE ADVOCATE'S OTHER HALF.
 *
 * The specification for this half:
 *
 *   If the model is asking a question, Ancient Knowledge first reads and
 *   ensures it is not already answered in the context of the audit trail. If
 *   it is, Ancient Knowledge responds to the model so the model can continue
 *   until it has an actual question that has not been answered. Ancient
 *   Knowledge should act as the user's advocate — their best friend, lawyer
 *   and partner.
 *
 * So a question only reaches the user if it is genuinely unanswered. The
 * standard of proof is deliberately high and one-directional: AK may only
 * answer from words the user actually wrote, and must QUOTE them. Anything
 * it cannot ground that way is UNANSWERED and goes to the human — the failure
 * this guards against is an eager auditor inventing a preference and sending
 * the model off to build the wrong thing in the user's name.
 */
const CLARIFY_SYSTEM =
    "You are the Ancient Knowledge overseer, acting for the user while they " +
    "are away. A model has stopped to ask them a question. Decide whether the " +
    "user has ALREADY answered it — in their own words, earlier in this " +
    "conversation. Answer ONLY from what they actually said or plainly " +
    "implied. You are their advocate, not their substitute: if the answer is " +
    "not genuinely there, say UNANSWERED and let them speak for themselves. " +
    "Never invent a preference. Never guess to keep things moving.";

/**
 * The evidence pack — assembled with NO model call, so what the auditor is
 * allowed to reason from is a fact about this function rather than a hope.
 */
function clarifyEvidence(session, turnAsk, addenda) {
    const said = [];
    const msgs = Array.isArray(session.messages) ? session.messages : [];
    for (let i = msgs.length - 1; i >= 0 && said.length < 20; i--) {
        const m = msgs[i];
        if (!m || m.role !== "user") continue;
        const t = String(m.content || "").trim();
        if (t) said.push(t.slice(0, 400));
    }
    const parts = [];
    if (turnAsk) parts.push(`What the user asked THIS TURN:\n"""${
        String(turnAsk).slice(0, 1500)}"""`);
    if (addenda && addenda.length) {
        parts.push(`They then added, before the model finished:\n` +
            addenda.map(a => `- ${String(a).slice(0, 400)}`).join("\n"));
    }
    if (said.length) {
        parts.push(`Everything the user has said in this conversation, newest ` +
            `first:\n` + said.map(s => `- ${s}`).join("\n").slice(0, 4000));
    }
    const r = session.akReview;
    if (r && Array.isArray(r.objectives)) {
        const open = r.objectives.filter(o => o.status !== "closed").slice(-6);
        if (open.length) {
            parts.push(`Standing items in the session review:\n` + open.map(o =>
                `- ${o.ask}${o.gaps && o.gaps.length
                    ? ` (open: ${o.gaps.slice(0, 3).join("; ")})` : ""}`
            ).join("\n").slice(0, 1200));
        }
    }
    return parts.join("\n\n");
}

function clarifyAnswerPrompt({ question, choices, offer, evidence }) {
    return (
        `The model stopped and asked the user:\n\n"""${
            String(question).slice(0, 800)}"""\n` +
        (choices && choices.length
            ? `\nIt offered these options: ${choices.map(c => `"${c}"`).join(", ")}\n`
            : ``) +
        (offer ? `\nIts suggested default: "${String(offer).slice(0, 200)}"\n` : ``) +
        `\n${evidence}\n\n` +
        `Has the user ALREADY answered this? Reply in EXACTLY this format:\n\n` +
        `ANSWERED: <the answer, in the user's own terms>\n` +
        `SOURCE: <the exact words of theirs that authorise it>\n` +
        `    (only when their own words settle it` +
        (choices && choices.length ? `, and the answer is one of the options above` : ``) +
        `)\n` +
        `UNANSWERED: <what is genuinely missing and only they can decide>`
    );
}

/**
 * Read the answer. Same rule as every other verdict in this module: silence
 * is never taken as permission, and an answer with no source is not an answer.
 */
function parseClarifyAnswer(text, choices) {
    const raw = String(text || "").trim();
    if (!raw) return { status: "unavailable", raw: "" };
    // UNANSWERED wins wherever it appears — the safe reading of a muddled
    // reply is always the one that gives the question back to the user
    if (/^[ \t]*UNANSWERED:/im.test(raw)) {
        const m = /^[ \t]*UNANSWERED:[ \t]*(.+)$/im.exec(raw);
        return { status: "unanswered", why: (m && m[1].trim().slice(0, 300)) || "", raw };
    }
    const a = /^[ \t]*ANSWERED:[ \t]*(.+)$/im.exec(raw);
    if (!a) return { status: "unanswered", why: "no verdict", raw };
    const answer = a[1].trim().slice(0, 600);
    const s = /^[ \t]*SOURCE:[ \t]*(.+)$/im.exec(raw);
    const source = s ? s[1].trim().slice(0, 400) : "";
    // AN ANSWER WITHOUT ITS SOURCE IS A GUESS. The whole safety of speaking
    // for someone is that you can show where they said it.
    if (!source || /^<.*>$/.test(source) || /^[ \t]*$/.test(source)) {
        return { status: "unanswered", why: "no source quoted", raw };
    }
    if (answer && choices && choices.length) {
        // it may not invent an option the model never offered
        const ok = choices.some(c => normGap(c) === normGap(answer)
            || normGap(answer).includes(normGap(c)));
        if (!ok) return { status: "unanswered", why: "not one of the offered options", raw };
    }
    return { status: "answered", answer, source, raw };
}

/** What AK says back to the model, in the operator's voice and marked as such. */
function clarifyReply(answer, source) {
    return `Ancient Knowledge, answering for the user from what they already ` +
        `said: ${answer}\n\nTheir words: "${source}"\n\nContinue — do not ask ` +
        `this again.`;
}

/** Record it on the objective, so the review shows what was answered for them. */
function noteClarify(session, obj, entry) {
    ensureReview(session);
    if (!obj) return;
    if (!Array.isArray(obj.clarifies)) obj.clarifies = [];
    obj.clarifies.push({
        question: String(entry.question || "").slice(0, 300),
        answer: String(entry.answer || "").slice(0, 300),
        source: String(entry.source || "").slice(0, 300),
        at: new Date().toISOString()
    });
    if (obj.clarifies.length > 20) obj.clarifies = obj.clarifies.slice(-20);
}

/* ---------------------------------------------------------- reading verdicts */
/**
 * Parse what the auditor said. The strict protocol parses first; a
 * free-form auditor (a small local model that ignored the format) is still
 * heard — its text becomes one gap so the driver must answer it, and the
 * nothing-new guard stops any thrash. BLANK IS NOT A VERDICT: an empty or
 * dead reply is "unavailable", and the loop must stop on it without ever
 * claiming the gaps closed.
 */
/* LOGIC THAT NEVER RAN IS ASSUMED, NOT TESTED — and that is a fact the LOOP
 * knows mechanically. Ancient Knowledge audits whether the model has ensured
 * the logic is not merely assumed but has actually been tested; if not, it
 * prompts the user to enable the sandbox. Scans the turn: code written or edited,
 * and nothing executed it (no sandbox_test, no approved run_script, no flash
 * that would have compiled it). Returns the gap sentence, or null. */
const CODE_EXT_RE = /\.(js|mjs|ts|py|ino|ps1|sh|c|cc|cpp|h|hpp|rs|go|java)$/i;
function untestedLogicGap(messages) {
    let wrote = null, ran = false;
    for (const m of (messages || [])) {
        const tool = m.tool || m.name || "";
        if (m.failed) continue;
        if ((tool === "write_file" || tool === "edit_file")) {
            const mm = String(m.content || "").match(/"written"\s*:\s*"([^"]+)"/);
            if (mm && CODE_EXT_RE.test(mm[1])) wrote = mm[1];
        }
        if (tool === "sandbox_test" || tool === "run_script"
            || tool === "flash_device") ran = true;
    }
    if (!wrote || ran) return null;
    return `the code in ${wrote} was written but never executed — nothing here ` +
        `is evidence it runs. Test it in the sandbox (sandbox_test), or propose ` +
        `a run_script for the user to approve, before calling this done.`;
}

function parseVerdict(text) {
    const raw = String(text || "").trim();
    if (!raw) return { status: "unavailable", gaps: [], raw: "" };

    const gaps = [];
    const gapRe = /^[ \t]*GAP:[ \t]*(.+)$/gim;
    let g;
    while ((g = gapRe.exec(raw))) {
        const s = g[1].trim();
        // the prompt's own template line is not a gap the auditor found
        if (s && !/^<.*>$/.test(s)) gaps.push(s.slice(0, 400));
    }

    // THE LAST VERDICT WINS, NOT THE FIRST. The prompt hands the auditor a
    // menu whose first line is literally "VERDICT: CLOSED"; a small model in
    // completion mode often echoes the menu before answering. Taking the
    // first match read that echo as the verdict and closed the objective on
    // the strength of our own instructions.
    const all = [...raw.matchAll(/^[ \t]*VERDICT:[ \t]*(CLOSED|USER[- ]TEST|GAPS)\b/gim)];
    if (all.length) {
        const verdict = all[all.length - 1][1].toUpperCase().replace(/\s+/, "-");
        // CLOSED CANNOT OUTRANK EVIDENCE. A reply that names gaps and also
        // says CLOSED is contradicting itself, and the safe reading of a
        // contradiction is always the one that keeps working.
        if (verdict === "CLOSED" && gaps.length) {
            return { status: "gaps", gaps, raw, contradicted: true };
        }
        if (verdict === "CLOSED") return { status: "closed", gaps: [], raw };
        if (verdict === "USER-TEST") return { status: "user-test", gaps, raw };
        return { status: "gaps",
                 gaps: gaps.length ? gaps : [raw.slice(0, 400)], raw };
    }

    // THE LEGACY SENTINEL, NARROWED. This was `/audit complete/i.test(raw)` —
    // an unanchored substring, so "the audit completed and found three
    // problems" and even "this is NOT an audit complete state" both returned
    // closed with the collected GAP lines thrown away. It now needs a whole
    // word, no gaps in evidence, and no negation in front of it.
    const NEG = /\b(not|never|isn'?t|is not|cannot|can'?t|far from|hardly|no)\b[^.!?\n]{0,40}\baudit complete\b/i;
    if (!gaps.length && /\baudit complete\b/i.test(raw) && !NEG.test(raw)) {
        return { status: "closed", gaps: [], raw };
    }
    // free-form: the auditor said SOMETHING and it was not "complete"
    return { status: "gaps", gaps: gaps.length ? gaps : [raw.slice(0, 400)],
             raw, freeform: true };
}

/** A stable short digest, so distinct long gaps never collide on a prefix. */
function digest(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

/**
 * One gap's identity for the nothing-new guard — shape, not spelling.
 *
 * KEEPS EVERY SCRIPT. This stripped anything outside [a-z0-9 ], so a gap
 * written in Chinese, Cyrillic or Greek normalised to the EMPTY STRING —
 * and every such gap collided with every other, which the loop reads as "no
 * new gaps" and stops on, reporting `nothing-new` while real, distinct gaps
 * went unaddressed. Letters and digits of ANY script survive now, and a gap
 * that really is all punctuation falls back to a digest rather than "".
 */
function normGap(s) {
    const raw = String(s || "");
    const t = raw.toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/\s+/g, " ").trim();
    if (!t) return "raw:" + digest(raw);
    // long path-heavy gaps often share a prefix and differ only at the end;
    // the digest of the WHOLE string keeps them distinct
    return t.length > 160 ? t.slice(0, 160) + ":" + digest(t) : t;
}

/* (A LEXICAL "IS THIS THE SAME GAP" TEST LIVED HERE AND WAS DELETED.
 *
 * The idea was to catch the auditor restating one finding in new words. Run
 * against six real rounds from a live session — the four wordings
 * of "you never read the repository" — it scored them 0.09 to 0.22 on token
 * overlap and called every one of them fresh. They share exactly one content
 * word, "repository". Loosening the threshold far enough to catch them would
 * have collided genuinely different gaps.
 *
 * The signal was never in the wording. It is in whether the round the gap
 * triggered DID ANYTHING — which the loop already measures, exactly, as
 * roundToolWins and changes.length. That is what drives the escalation now.) */

/* --------------------------------------------------- the review document */
/**
 * The session's structured review state rides ON the session record
 * (persisted by the same sessions.save that persists everything else), and
 * ancient_knowledge.md is composed from it — the file is a VIEW, the record
 * is the truth, so a deleted file costs nothing and a stale one is
 * impossible.
 */
function ensureReview(session) {
    if (!session.akReview || !Array.isArray(session.akReview.objectives)) {
        session.akReview = { objectives: [], akUsd: 0 };
    }
    return session.akReview;
}

/** A new audited turn opens (or re-opens) one objective: the user's ask. */
function openObjective(session, ask) {
    const r = ensureReview(session);
    const obj = {
        n: r.objectives.length + 1,
        ask: String(ask || "").replace(/\s+/g, " ").trim().slice(0, 240),
        status: "open",                 // open | closed | user-test
        gaps: [], rounds: 0, stopped: null, usd: 0,
        at: new Date().toISOString(), updatedAt: null
    };
    r.objectives.push(obj);
    // an unbounded session must not grow an unbounded record
    if (r.objectives.length > 200) r.objectives = r.objectives.slice(-200);
    return obj;
}

/**
 * THE RUNNING TO-DO.
 *
 * The specification for what this document is:
 *
 *   Ancient Knowledge is one thing — a markdown file it creates, called
 *   ancient_knowledge.md, that keeps up with what is going on and tracks what
 *   still needs to be done.
 *
 * `obj.gaps` was only ever the LATEST verdict's list — overwritten every round.
 * So an item that got fixed simply disappeared, and the file could not answer
 * the two questions a to-do exists to answer: what is still outstanding, and
 * what has actually been dealt with. It showed a snapshot and called it a
 * record.
 *
 * `obj.todo` accumulates instead. An item is keyed by gap IDENTITY (normGap —
 * shape, not spelling) so the auditor rewording the same complaint updates the
 * existing line rather than adding a second one. Items are ticked, never
 * deleted, so the list is a history of the work as well as a plan for it.
 *
 * "Done" is inferred conservatively: an item is only ticked when the auditor
 * has been round again and STOPPED reporting it, or when it returns CLOSED for
 * the whole objective. An auditor that never spoke ticks nothing — the same
 * rule that stops a blank verdict being laundered into "all gaps closed".
 */
function mergeTodo(obj, verdict, round) {
    if (!Array.isArray(obj.todo)) obj.todo = [];
    if (!verdict || verdict.status === "unavailable") return;

    const byId = new Map(obj.todo.map(t => [t.id, t]));
    const reportedNow = new Set();
    const asTest = verdict.status === "user-test";

    for (const g of (verdict.gaps || [])) {
        const id = normGap(g);
        if (!id) continue;
        reportedNow.add(id);
        const existing = byId.get(id);
        if (existing) {
            existing.text = g;                    // the newest wording wins
            existing.status = asTest ? "user-test" : "open";
            existing.lastSeen = round;
        } else {
            const t = { id, text: g, status: asTest ? "user-test" : "open",
                        firstSeen: round, lastSeen: round };
            obj.todo.push(t);
            byId.set(id, t);
        }
    }

    // Stopped being reported, having been reported before -> dealt with.
    // Guarded on lastSeen < round so an item raised THIS round is never ticked
    // by the same round that raised it.
    for (const t of obj.todo) {
        if (t.status === "done") continue;
        if (!reportedNow.has(t.id) && t.lastSeen < round) {
            t.status = "done";
            t.doneAt = round;
        }
    }
    // CLOSED is the auditor saying the whole ask is accounted for
    if (verdict.status === "closed") {
        for (const t of obj.todo) {
            if (t.status === "open") { t.status = "done"; t.doneAt = round; }
        }
    }
    if (obj.todo.length > 200) obj.todo = obj.todo.slice(-200);
}

function updateObjective(session, obj, { verdict, round, stopped, usd }) {
    ensureReview(session);
    obj.rounds = round;
    obj.updatedAt = new Date().toISOString();
    mergeTodo(obj, verdict, round);
    if (typeof usd === "number" && usd > 0) obj.usd = +usd.toFixed(5);
    if (verdict) {
        if (verdict.status === "closed") { obj.status = "closed"; obj.gaps = []; }
        else if (verdict.status === "user-test") { obj.status = "user-test"; obj.gaps = verdict.gaps.slice(0, 12); }
        else if (verdict.status === "gaps") { obj.status = "open"; obj.gaps = verdict.gaps.slice(0, 12); }
        // "unavailable" leaves status as it stands — an absent auditor
        // changes nothing about what is actually done
    }
    obj.stopped = stopped || null;
    session.akReview.akUsd = +(session.akReview.objectives
        .reduce((s, o) => s + (o.usd || 0), 0)).toFixed(5);
}

/**
 * The standing items, compacted for the next interrogation's context — how
 * a gap that was claimed closed and is not gets caught on the very next
 * turn instead of never.
 */
function reviewDigest(session, currentObj) {
    // AK is AWARE OF THE ORCHESTRATION PLAN when one is set — the user
    // assigned models to kinds of work, and the audit must know a drawing task
    // was meant to go to the image model, not judge the coder for being bad at
    // it. One line, prepended to the standing items.
    let orch = "";
    try { orch = require("./agent").orchestrationDigest(session) || ""; } catch { orch = ""; }
    const orchLine = orch
        ? `The user set a model plan for this conversation (${orch}). ` +
          `Judge each part against the model that was meant to do it.\n`
        : "";

    const r = session.akReview;
    if (!r || !r.objectives) return orchLine;
    const standing = r.objectives.filter(o =>
        o !== currentObj && (o.status === "open" || o.status === "user-test"));
    if (!standing.length) return orchLine;
    const lines = standing.slice(-8).map(o =>
        `- #${o.n} ${o.status === "user-test" ? "AWAITING USER TEST" : "OPEN"}: ` +
        `${o.ask.slice(0, 120)}` +
        (o.gaps.length ? ` — gaps: ${o.gaps.slice(0, 3).join("; ").slice(0, 240)}` : ""));
    return orchLine + `Standing items from this session's review (verify these are ` +
           `still true — the user may be reporting one of them):\n` +
           lines.join("\n").slice(0, 1400);
}

/** What the transcript bubble says. The prefix is load-bearing: the
 *  renderer keys the brain-marked bubble off it. */
function bubbleText(verdict, round) {
    const head = `**Ancient Knowledge Audit:**`;
    const roundTag = round > 1 ? `Round ${round} — ` : ``;
    // A SILENT PASS IS INDISTINGUISHABLE FROM NOT RUNNING. For a long time
    // only "gaps" and "user-test" printed, so the normal good outcome —
    // everything closed — looked exactly like an auditor that never woke up,
    // and so did a dead one. Both now say so out loud — a silent pass that
    // ran for many minutes and surfaced nothing was partly this.
    if (verdict.status === "closed") {
        return `${head} ${roundTag}checked your request against what was ` +
            `delivered. Nothing left open.`;
    }
    if (verdict.status === "unavailable") {
        return `${head} ${roundTag}the auditor did not answer, so completion ` +
            `is **NOT verified**. Treat the work above as unchecked.`;
    }
    if (verdict.status === "user-test") {
        return `${head} ${roundTag}work complete — awaiting your function test:\n` +
            verdict.gaps.map(g => `- ${g}`).join("\n");
    }
    if (verdict.freeform) {
        return `${head} ${roundTag}${verdict.raw.slice(0, 1500)}`;
    }
    return `${head} ${roundTag}gaps found:\n` +
        verdict.gaps.map(g => `- ${g}`).join("\n");
}

/* ------------------------------------------------------------- the file */
const STOP_WORDS = {
    "closed": "all gaps closed",
    "user-test": "awaiting your function test",
    "nothing-new": "the audit stopped finding new gaps",
    // A ROUND THAT DID NO WORK. Re-asking a model that answered in prose and
    // called nothing produces the same refusal in different words — measured
    // at six rounds on a real repository, none of which read a file.
    "no-progress": "the model did no work that round — asking again will not change it; gaps remain OPEN",
    "rounds": "round ceiling reached — gaps remain OPEN",
    "budget": "spend ceiling reached — gaps remain OPEN",
    "review-unavailable": "the auditor did not answer — completion NOT verified",
    "cancelled": "cancelled by you",
    // the forced response itself failed (generation error, no driver, a
    // step that threw). The cycle stops, and it stops SAYING SO rather than
    // going quiet and leaving the model to run on unaudited.
    "round-failed": "the forced response failed — gaps remain OPEN",
    "no-response": "there was nothing to audit",
    // a confirm-class action is staged: the next move is the human's, and the
    // auditor does not get to talk over it
    "awaiting-approval": "waiting on your approval — gaps remain OPEN"
};

/*
 * .lcl'S OWN FILES DO NOT BELONG TO THE USER'S PROJECT.
 *
 * Ancient Knowledge's document was written to the workspace ROOT, which on a
 * real repository means it is staged, committed and pushed along with the
 * work — a controlling document for a tool, landing in someone else's project
 * history, which is not what anyone wants pushed to their online repository.
 *
 * So everything .lcl writes in order to OPERATE lives under one folder, and
 * that folder is added to the repository's .gitignore. The project's own logic
 * is still edited in place, exactly as before — this covers only the files the
 * tool keeps for itself. The document keeps its name; only where it sits
 * changes.
 */
const OP_DIR = ".lcl";
const IGNORE_NOTE = "# .lcl's own working files. Not part of this project.";
// Everything .lcl writes into the user's repository to OPERATE, as
// gitignore patterns. The document keeps its chosen name and place; the
// repository is simply told not to carry it.
const IGNORE_LINES = ["ancient_knowledge.md", "ancient_knowledge-*.md",
                      "ancient_knowledge.rules.md", "ancient_knowledge-*.rules.md"];

/** Add the operating folder to .gitignore, creating the file if there is none. */
function ensureIgnored(repoPath) {
    if (!repoPath) return "no-repo";
    try {
        const gi = path.join(repoPath, ".gitignore");
        let cur = null;
        try { cur = fs.readFileSync(gi, "utf8"); } catch { cur = null; }
        const present = new Set(
            String(cur || "").split(/\r?\n/).map(l => l.trim().replace(/^\/+/, "")));
        const missing = IGNORE_LINES.filter(l => !present.has(l));
        if (!missing.length) return cur === null ? "created" : "already";
        const body = IGNORE_NOTE + "\n" + missing.join("\n") + "\n";
        if (cur === null) { fs.writeFileSync(gi, body); return "created"; }
        const sep = cur.length && !cur.endsWith("\n") ? "\n" : "";
        fs.appendFileSync(gi, sep + "\n" + body);
        return "appended";
    } catch { return "failed"; }
}

/** The operating folder, made on demand and kept out of the repo's history. */
function ensureOpDir(repoPath) {
    try { fs.mkdirSync(path.join(repoPath, OP_DIR), { recursive: true }); } catch { }
    return ensureIgnored(repoPath);
}

/**
 * Which file. ancient_knowledge.md at the workspace root — the canonical
 * playbook shape. If another session already owns that name in a shared
 * folder (told by the marker comment), this session takes a suffixed one
 * instead of silently clobbering it.
 */
function reviewFileName(session) {
    // THE OLD NAME DOES NOT GET TO OUTLIVE THE RENAME.
    //
    // The chosen name is PERSISTED on the session, so every conversation that
    // ran before the rename carries `akReviewFile: "SESSION-REVIEW.md"` on
    // disk and would keep writing that file forever — an old session record
    // still says exactly that. The canonical name for this document is
    // ancient_knowledge.md.
    //
    // So the stale name is dropped here and re-derived below, and the old file
    // is renamed on the next write rather than left behind as a second,
    // divergent review sitting in the workspace.
    const legacyMatch = /^SESSION-REVIEW(?:-([\w-]+))?\.md$/i
        .exec(String(session.akReviewFile || ""));
    if (legacyMatch) {
        const legacy = session.akReviewFile;
        session.akReviewFile = null;
        // group 1 is the per-session suffix and is undefined for the plain
        // name — matching a bare /-(\w+)\.md$/ here would read the "REVIEW" in
        // "SESSION-REVIEW.md" as a suffix and produce ancient_knowledge-REVIEW.md
        const renamed = legacyMatch[1]
            ? `ancient_knowledge-${legacyMatch[1]}.md`
            : "ancient_knowledge.md";
        try {
            // the destination is inside the operating folder now, so it has to
            // exist before the rename — without this the move fails silently
            // and the old file is left sitting in the repo root
            ensureOpDir(session.repoPath);
            const from = fsTools.resolveInRoot(session.repoPath, legacy);
            const to = fsTools.resolveInRoot(session.repoPath, renamed);
            if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
            const rFrom = from.replace(/\.md$/i, ".rules.md");
            const rTo = to.replace(/\.md$/i, ".rules.md");
            if (fs.existsSync(rFrom) && !fs.existsSync(rTo)) fs.renameSync(rFrom, rTo);
        } catch { /* a failed rename just means the next write creates it fresh */ }
        session.akReviewFile = renamed;
        return renamed;
    }
    // A NAME STORED UNDER THE SHORT-LIVED ".lcl/" FOLDER comes back to the
    // root, and the file with it. The folder was the wrong answer to a real
    // problem: the design calls for the file where it has always been, and the
    // repository told to ignore it.
    if (session.akReviewFile && session.akReviewFile.includes("/")) {
        const base = session.akReviewFile.split("/").pop();
        try {
            const from = fsTools.resolveInRoot(session.repoPath, session.akReviewFile);
            const to = fsTools.resolveInRoot(session.repoPath, base);
            if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
            const rFrom = from.replace(/\.md$/i, ".rules.md");
            const rTo = to.replace(/\.md$/i, ".rules.md");
            if (fs.existsSync(rFrom) && !fs.existsSync(rTo)) fs.renameSync(rFrom, rTo);
        } catch { /* the next write creates it in the root anyway */ }
        session.akReviewFile = base;
        ensureIgnored(session.repoPath);
        return base;
    }
    if (session.akReviewFile) { ensureIgnored(session.repoPath); return session.akReviewFile; }
    ensureOpDir(session.repoPath);
    ensureIgnored(session.repoPath);
    const plain = "ancient_knowledge.md";
    try {
        const full = fsTools.resolveInRoot(session.repoPath, plain);
        if (fs.existsSync(full)) {
            const head = fs.readFileSync(full, "utf8").slice(0, 200);
            const m = /<!-- lcl-session:([\w-]+) -->/.exec(head);
            if (m && m[1] !== String(session.id)) {
                session.akReviewFile =
                    `ancient_knowledge-${String(session.id).slice(0, 8)}.md`;
                return session.akReviewFile;
            }
        }
    } catch { /* fall through to the plain name */ }
    session.akReviewFile = plain;
    return plain;
}

function composeReview(session) {
    const r = ensureReview(session);
    const open = r.objectives.filter(o => o.status === "open");
    const testing = r.objectives.filter(o => o.status === "user-test");
    const closed = r.objectives.filter(o => o.status === "closed");

    const line = (o) => {
        const mark = o.status === "closed" ? "CLOSED"
            : o.status === "user-test" ? "AWAITING YOUR TEST"
            : "OPEN";
        // h4: the audit trail is a section (h2) with Open/Testing/Closed
        // subsections (h3), so an objective sits a level below those. At h3 it
        // rendered as a sibling of the subsection that contained it.
        let s = `#### ${o.n}. ${o.ask || "(untitled request)"}\n` +
            `**${mark}** · ${o.rounds} audit round${o.rounds === 1 ? "" : "s"}` +
            (o.usd ? ` · $${o.usd.toFixed(4)}` : ``) +
            (o.stopped && o.stopped !== "closed"
                ? ` · stopped: ${STOP_WORDS[o.stopped] || o.stopped}` : ``) + `\n`;
        if (o.gaps.length) {
            s += o.gaps.map(g => o.status === "user-test"
                ? `- [ ] test: ${g}` : `- [ ] ${g}`).join("\n") + "\n";
        }
        // EVERY QUESTION ANSWERED ON THE OPERATOR'S BEHALF IS ON THE RECORD.
        // Speaking for someone is only defensible if they can see exactly what
        // was said and which of their own words it came from.
        if (Array.isArray(o.clarifies) && o.clarifies.length) {
            s += `\n*Answered for you, from what you had already said:*\n` +
                o.clarifies.map(c =>
                    `- **Q:** ${c.question}\n  **A:** ${c.answer}\n  ` +
                    `*your words:* "${c.source}"`).join("\n") + "\n";
        }
        return s;
    };

    // ===================================================== THE RUNNING TO-DO
    //
    // The document must keep track of what needs to be done.
    //
    // So the first thing in the file is the list of what is outstanding across
    // EVERY request in this session — not a per-objective snapshot the reader
    // has to assemble themselves. Each line carries the ask it came from, so a
    // long session's list still says why an item exists.
    //
    // Deduped by gap identity across objectives too: the same thing left undone
    // by two different requests is ONE job, and listing it twice is how a to-do
    // stops being trusted.
    const rows = [];
    const seen = new Set();
    for (const o of r.objectives) {
        for (const t of (o.todo || [])) {
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            rows.push({ ...t, from: o.ask, n: o.n });
        }
    }
    const todoOpen = rows.filter(t => t.status === "open");
    const todoTest = rows.filter(t => t.status === "user-test");
    const todoDone = rows.filter(t => t.status === "done");

    const item = (t, box) =>
        `- [${box}] ${t.text}` +
        (t.from ? `\n      <sub>from: ${String(t.from).slice(0, 90)}</sub>` : ``);

    const todoBlock =
        (todoOpen.length
            ? `### Still to do\n\n${todoOpen.map(t => item(t, " ")).join("\n")}\n\n`
            : ``) +
        (todoTest.length
            ? `### Needs you — nothing left but your own test\n\n` +
              `${todoTest.map(t => item(t, " ")).join("\n")}\n\n`
            : ``) +
        (todoDone.length
            ? `### Done\n\n${todoDone.slice(-40).map(t => item(t, "x")).join("\n")}\n\n`
            : ``);

    return `<!-- lcl-session:${session.id} -->\n` +
        `# Ancient Knowledge — ${session.title || ".lcl"}\n\n` +
        `*updated ${new Date().toISOString()} · ` +
        `${todoOpen.length} still to do · ${todoTest.length} awaiting your test · ` +
        `${todoDone.length} done · ` +
        `${r.objectives.length} request${r.objectives.length === 1 ? "" : "s"} audited*\n\n` +
        (rows.length
            ? `## What needs doing\n\n${todoBlock}`
            : `## What needs doing\n\nNothing outstanding.\n\n`) +
        `## The audit trail\n\n` +
        `*Every request this session, and what each interrogation found.*\n\n` +
        (open.length ? `### Open\n\n${open.map(line).join("\n")}\n` : ``) +
        (testing.length ? `### Awaiting your function test\n\n` +
            `${testing.map(line).join("\n")}\n` : ``) +
        (closed.length ? `### Closed\n\n${closed.slice(-30).map(line).join("\n")}\n` : ``) +
        (r.akUsd ? `## Spend\n\nAncient Knowledge this session: ` +
            `$${r.akUsd.toFixed(4)}\n` : ``);
}

/**
 * Write the view. Root-contained through the same resolveInRoot every
 * other write in this app goes through; a failed write NEVER breaks the
 * turn (the caller wraps it, and this returns rather than throws for the
 * expected cases).
 */
function writeReview(session) {
    if (!session || !session.repoPath) return { ok: false, reason: "no-workspace" };
    const name = reviewFileName(session);
    const full = fsTools.resolveInRoot(session.repoPath, name);
    const md = composeReview(session);
    // the in-panel viewer caps at 2,000,000 bytes; the composer keeps far
    // under it, but the guard is here so a runaway never lands
    fs.writeFileSync(full, md.length > 1_500_000 ? md.slice(0, 1_500_000) : md, "utf8");
    return { ok: true, file: name };
}

/* The GROUND-RULES companion: the audit doc is what the agent WRITES; this is
 * what it READS. Same directory, same per-session naming (…rules.md), so the
 * user can open and edit their standing instructions right beside the running
 * to-do. Removed when the rules are cleared. */
function rulesFileName(session) {
    return reviewFileName(session).replace(/\.md$/i, ".rules.md");
}
function writeGroundRules(session) {
    if (!session || !session.repoPath) return { ok: false, reason: "no-workspace" };
    const name = rulesFileName(session);
    const full = fsTools.resolveInRoot(session.repoPath, name);
    // the WRITER uses the session field it is persisting, NOT groundRules()
    // (which reads the file back — that would make "clear" re-write the stale
    // file it was told to delete)
    const g = session && typeof session.akGroundRules === "string"
        ? session.akGroundRules.trim() : "";
    if (!g) {
        try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch { }
        return { ok: true, file: name, cleared: true };
    }
    const md = `<!-- lcl-session:${session.id} -->\n` +
        `# Ancient Knowledge — ground rules\n\n` +
        `Your standing instructions for this session's audit agent. The agent ` +
        `reads these as tone and context; they never override its guardrails ` +
        `(evidence still decides every verdict). The model cannot write this ` +
        `file — only you.\n\n<!-- lcl-ak-rules -->\n` +
        g.slice(0, 8000) + "\n";
    fs.writeFileSync(full, md, "utf8");
    return { ok: true, file: name };
}

/* ------------------------------------------------------------- THE CYCLE */
/**
 * THE LOOP, LIFTED OUT OF THE TURN.
 *
 * The symptom that motivated this:
 *
 *   Ancient Knowledge appeared to run and forced the model into a loop, but
 *   the model did not actually do what it said. Across the 20 rounds that ran,
 *   Ancient Knowledge did not continue to audit and respond — it just stopped,
 *   and the model ran away unguided.
 *
 * Two different things were wrong, and the second is the one this function
 * exists for. Ancient Knowledge lived INSIDE agent.runTurn, guarded by
 * `!opts.stepMode` — and the orchestrator runs every step of every plan with
 * stepMode:true. So on a linked workspace with a build-shaped ask (which is
 * every AK session, since AK REQUIRES a workspace and so does the
 * orchestrator) the auditor was evaluated exactly zero times. The 20 rounds
 * that appeared were the orchestrator's own step plan; the loop that
 * looked like AK was `selfReview`, which the brain toggle silently co-enables.
 * The result was review-shaped output from a system that was not turned on, and
 * silence from the one that was.
 *
 * This is the ORCHESTRATED path's driver. The chat turn (agent.js) keeps its
 * own inline copy of the interrogate->force loop rather than calling this — an
 * honest statement of what the code does, because two copies of an audit loop
 * DO drift, and a gap closed on one path was open on the other (the akRounds
 * knob and the untested-logic gap were both live on the chat path and silently
 * absent here until this was fixed). The two are kept in lockstep deliberately:
 * both build the round ceiling with effectiveMaxRounds(session), both read the
 * SAME verdict grammar (parseVerdict), stop names, groundRules and
 * ancient_knowledge.md here, and both apply untestedLogicGap. When one copy
 * changes, the other must change with it — or, better, route the chat path
 * through this function too (its `respond` hook is the only genuine difference).
 *
 * The caller supplies `respond` — how to make the model answer. That is the
 * only thing that differs between a chat turn (push a user-role instruction
 * into the working context and run the step loop again) and an orchestrated
 * goal (run a fresh turn against the workspace). Everything the operator sees —
 * the interrogation, the verdicts, the bubbles, ancient_knowledge.md, the stop
 * reason — is meant to read identically on both paths.
 *
 * Never throws. An auditor that breaks must not take the work down with it;
 * it reports `stopped` and hands back what it has.
 *
 * @returns {{ran, rounds, stopped, objective, messages, changes,
 *             pendingApprovals, usd}}
 */
async function runCycle(session, opts = {}) {
    // REQUIRED LAZILY, ON PURPOSE. This module promises at the top of the file
    // that every piece of it is testable in plain node with no engine booted;
    // a top-level router import would break that promise for the 100-odd
    // checks that exercise the grammar with no models present.
    const router = require("./router");

    const {
        userAsk = "", addenda = [], clarifyLog = [],
        response = "", changes: changes0 = [],
        // the build's tool messages, so the untested-logic gap can see whether
        // code was written and whether anything ran it — the chat path passes its
        // own newMessages; the orchestrated path passes the accumulated steps
        messages: buildMessages = [],
        cancelToken = { cancelled: false },
        auditorSelection, driverSelection = null,
        budgetUsd = BUDGET_USD,
        respond = null,
        onProgress = () => {},
        // Called with each message AS IT IS PRODUCED, in order. The caller
        // uses this to persist the cycle onto the session transcript while it
        // is still running — which is not cosmetic: the forced response is a
        // fresh turn built from session history, so if round 1's exchange is
        // not on the transcript by the time round 2 runs, round 2 starts from
        // the same place and re-attempts the same fix, forever. The default
        // is a no-op for callers (like the chat path) that own their own
        // transcript.
        onMessages = () => {}
    } = opts;

    const out = { ran: false, rounds: 0, stopped: null, objective: null,
                  messages: [], changes: [...changes0],
                  pendingApprovals: [], usd: 0 };
    const report = (phase, detail) => {
        try { onProgress({ phase, detail }); } catch { /* never break on UI */ }
    };

    if (!String(response || "").trim()) { out.stopped = "no-response"; return out; }
    if (cancelToken.cancelled) { out.stopped = "cancelled"; return out; }

    try {
        // THE AFTERTHOUGHTS ARE PART OF THE ASK, NOT A LATER ONE — same rule
        // as the runTurn path, same words, because it is the same objective.
        const askLine = String(userAsk)
            + (addenda.length ? "\n\nAlso, while you were working: "
                                + addenda.join(" · ") : "");
        const obj = openObjective(session, askLine);
        out.objective = obj;
        out.ran = true;
        for (const c of clarifyLog) { try { noteClarify(session, obj, c); } catch { } }

        const maxR = effectiveMaxRounds(session);
        const askForAudit = String(userAsk)
            + (addenda.length ? "\n\nAnd, added while you were working:\n"
                                + addenda.map(a => `- ${a}`).join("\n") : "");
        const seen = new Set();
        let latest = String(response);
        let round = 0;
        let lastSpin = null;

        for (;;) {
            if (cancelToken.cancelled) { out.stopped = "cancelled"; break; }
            round++;
            out.rounds = round;
            report("audit", { phase: "ancient-knowledge", round, of: maxR });

            // WATCH THE AUDIT HAPPEN — same rolling preview the chat path streams,
            // so the orchestrated cycle's interrogation is visible live too (§8b).
            let lastAkStream = 0;
            const onAkStream = (t) => {
                const now = Date.now();
                if (now - lastAkStream < 250) return;
                lastAkStream = now;
                report("ak-generating", {
                    phase: "ancient-knowledge", round, of: maxR,
                    tokens: t.tokens,
                    tps: t.elapsedMs > 500
                        ? +(t.tokens / (t.elapsedMs / 1000)).toFixed(1) : null,
                    preview: t.text.slice(-240)
                });
            };

            let audit = null;
            try {
                audit = await router.generate(
                    [{ role: "system", content: systemFor(session) },
                     { role: "user", content: auditPrompt({
                         userAsk: askForAudit, response: latest,
                         changes: out.changes,
                         reviewDigest: reviewDigest(session, obj),
                         round }) }],
                    1024, cancelToken, onAkStream,
                    { selection: auditorSelection === undefined ? driverSelection
                        : auditorSelection === "local" ? null : auditorSelection,
                      session });
            } catch { audit = null; }

            // BILL THE AUDIT, exactly as the turn path does. An orchestrated
            // audit that spends real money and never reaches the ledger is how
            // Spend stops reconciling and the operator stops trusting it.
            if (audit && audit.remote && audit.usage) {
                out.usd += (audit.cost && audit.cost.usd) || 0;
                try {
                    require("./ledger").record({
                        sessionId: session.id, sessionTitle: session.title,
                        model: audit.model, endpoint: audit.endpoint,
                        inputTokens: audit.usage.prompt_tokens,
                        outputTokens: audit.usage.completion_tokens,
                        usd: (audit.cost && audit.cost.usd) || 0,
                        via: "ancient-knowledge", localNode: !!audit.localNode
                    });
                } catch { /* bookkeeping never breaks the cycle */ }
            }

            const verdict = cancelToken.cancelled
                ? { status: "unavailable", gaps: [], raw: "" }
                : parseVerdict(audit && audit.content);

            // THE LOOP'S OWN GAP, mirrored from the chat path: code written in
            // this build and never executed is assumed, not tested, and a CLOSED
            // verdict does not outrank that fact. Scans the build's tool messages
            // plus every forced round so far, so once a forced round actually runs
            // it (sandbox_test / run_script / flash_device) the gap clears. Without
            // this an orchestrated build that wrote code and ran nothing could
            // close CLOSED — the chat path caught it here and this one did not.
            if (verdict.status !== "unavailable") {
                const mech = untestedLogicGap([...buildMessages, ...out.messages]);
                if (mech) {
                    verdict.gaps = [...(verdict.gaps || []), mech];
                    if (verdict.status === "closed") verdict.status = "gaps";
                }
            }

            // THE SAME LADDER, IN THE SAME ORDER, AS THE TURN PATH. An absent
            // auditor is never laundered into "closed".
            let force = false, stopped = null;
            if (cancelToken.cancelled) stopped = "cancelled";
            else if (verdict.status === "unavailable") stopped = "review-unavailable";
            else if (verdict.status === "closed") stopped = "closed";
            else if (verdict.status === "user-test") stopped = "user-test";
            else {
                const fresh = verdict.gaps.filter(g => !seen.has(normGap(g)));
                verdict.gaps.forEach(g => seen.add(normGap(g)));
                if (!fresh.length && round > 1) stopped = "nothing-new";
                else if (round >= maxR) stopped = "rounds";
                else if (out.usd > 0 && out.usd >= budgetUsd) stopped = "budget";
                else if (typeof respond !== "function") stopped = "rounds";
                else force = true;
            }

            // EVERY ROUND, not at the end — a crash mid-cycle still leaves an
            // honest document behind.
            updateObjective(session, obj, {
                verdict, round, stopped: force ? null : stopped, usd: out.usd });
            if (session.repoPath) { try { writeReview(session); } catch { } }

            const bubble = {
                role: "assistant", content: bubbleText(verdict, round),
                meta: { model: "ancient-knowledge", audit: true, round,
                        verdict: verdict.status }
            };
            out.messages.push(bubble);
            try { onMessages([bubble]); } catch { /* never break on the caller */ }

            if (!force) { out.stopped = stopped; break; }

            // FORCE THE RESPONSE — with ACTION, through every normal gate.
            report("audit-done", { gaps: true, round, forcing: true });
            let res = null;
            // lastSpin: what the PREVIOUS round got stuck repeating, handed
            // forward so the caller can forbid it by name in the instruction.
            try { res = await respond(verdict.gaps, round, lastSpin); }
            catch { res = null; }
            lastSpin = (res && res.spin) || null;

            // A FAILED FORCED ROUND STOPS THE CYCLE OUT LOUD. Going quiet here
            // is precisely the "ran away unguided" failure mode: the
            // auditor falls silent and the model keeps working with nobody
            // checking it. There is no silent continue in this loop.
            if (!res || res.ok === false) {
                out.stopped = res && res.error === "cancelled"
                    ? "cancelled" : "round-failed";
                updateObjective(session, obj,
                    { verdict: null, round, stopped: out.stopped, usd: out.usd });
                if (session.repoPath) { try { writeReview(session); } catch { } }
                break;
            }
            if (res.changes && res.changes.length) {
                const byPath = new Map(out.changes.map(c => [c.path, c]));
                for (const c of res.changes) if (c && c.path) byPath.set(c.path, c);
                out.changes = [...byPath.values()];
            }
            for (const p of res.pendingApprovals || []) {
                if (p && p.id) out.pendingApprovals.push(p);
            }
            // THE FORCED ROUND'S SPEND COUNTS TOWARD THE CEILING TOO. runTurn
            // reports it as `costUsd`; reading only `usd` here would have
            // billed the operator for every forced response while the budget
            // stop watched the auditor's own calls and never tripped.
            const spent = typeof res.usd === "number" ? res.usd
                : typeof res.costUsd === "number" ? res.costUsd : 0;
            if (spent > 0) out.usd += spent;
            // The model's ANSWER is what the operator sees. The forced
            // instruction is not: it is a user-role message the user never
            // typed, and showing it would put words in their mouth. Same rule
            // the turn path states where it pushes the instruction into the
            // working context but keeps it out of newMessages.
            const said = (res.newMessages || []).filter(
                m => m && (m.role === "assistant"
                    // A CONFIRM-CLASS ACTION THE FORCED ROUND STAGED must reach
                    // the operator too. Its message is role:"tool" and carries
                    // the `.proposal` the renderer draws the approval card from —
                    // filtering to assistant-only dropped it, so the tray toast
                    // fired but no card ever rendered and the action could not be
                    // approved. This was the AK-path copy of the orchestrator's
                    // dropped-proposal bug; surface it on BOTH channels (the
                    // returned delta and, via onMessages, the transcript) exactly
                    // as the answer is.
                    || (m.proposal && m.proposal.id)));
            out.messages.push(...said);
            if (said.length) {
                try { onMessages(said); } catch { /* never break on the caller */ }
            }
            const answered = [...(res.newMessages || [])].reverse().find(
                m => m.role === "assistant" && !m.meta?.clarify
                     && m.meta?.model !== "ancient-knowledge");
            // NOTHING CAME BACK TO INTERROGATE. Auditing the previous answer
            // again would just re-derive the same gaps and burn the ceiling,
            // so stop and say the round produced nothing.
            if (!answered || !String(answered.content || "").trim()) {
                out.stopped = "round-failed";
                updateObjective(session, obj,
                    { verdict: null, round, stopped: out.stopped, usd: out.usd });
                if (session.repoPath) { try { writeReview(session); } catch { } }
                break;
            }
            latest = String(answered.content);
            // a staged approval is the HUMAN's move — the auditor does not get
            // to talk over it
            if (out.pendingApprovals.length) { out.stopped = "awaiting-approval"; break; }
        }

        report("audit-done", { stopped: out.stopped, rounds: out.rounds });
    } catch (err) {
        out.stopped = out.stopped || "round-failed";
        report("audit-done", { error: String((err && err.message) || err).slice(0, 100) });
    }
    return out;
}

module.exports = { untestedLogicGap,
    maxRounds, effectiveMaxRounds, groundRules, systemFor,
    BUDGET_USD, SYSTEM, STOP_WORDS, runCycle,
    auditPrompt, forceInstruction, parseVerdict, normGap, bubbleText,
    ensureReview, openObjective, updateObjective, reviewDigest,
    reviewFileName, composeReview, writeReview,
    rulesFileName, writeGroundRules, ensureOpDir, ensureIgnored, OP_DIR,
    // the advocate half: answering a model's question from what the user
    // already said, so only a genuinely new question reaches them
    CLARIFY_SYSTEM, clarifyEvidence, clarifyAnswerPrompt, parseClarifyAnswer,
    clarifyReply, noteClarify
};
