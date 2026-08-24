/**
 * COMPACTION HAS TO ACTUALLY MAKE THE NEXT REQUEST SMALLER.
 *
 * The operator, on what it is for:
 *
 *   "the whole point of compacting is for reducing the context, and yes it is
 *    a manual command"
 *
 * The version this replaces did not reduce anything, in three separate ways,
 * and every one of them is visible in his own session file:
 *
 *   1. It sent the summarisation request through sendText — an ORDINARY CHAT
 *      TURN. So "Please summarize this conversation so far…" followed by the
 *      whole transcript was recorded as a message HE had typed. It is sitting
 *      at index 22 of session e57d6829. Compaction's first act was to make the
 *      conversation longer.
 *
 *   2. It then reassigned `active.messages` in the RENDERER. No IPC carries a
 *      message list to the main process, and lcl:chat reloads the session from
 *      disk at the start of every turn — so the full history went straight back
 *      to the model on the next message. The transcript looked compacted and
 *      the REQUEST never was.
 *
 *   3. It identified the summary by taking the last message 500 ms after the
 *      turn resolved. A turn that ended on a tool result compacted nothing, and
 *      said nothing about it.
 *
 * So these checks are about the measurable thing: fewer tokens go to the model
 * afterwards, the operator's transcript is not vandalised in the process, and a
 * summariser that fails does not eat the conversation on its way out.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
process.resourcesPath = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-compact-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

const CORE = path.join(__dirname, "..", ".lcl.engine", "core");
const compaction = require(path.join(CORE, "compaction.js"));
const agent = require(path.join(CORE, "agent.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

function makeSession(turns = 14) {
    const messages = [];
    for (let i = 1; i <= turns; i++) {
        messages.push({ role: "user", content: `question ${i}: ` + "q".repeat(400) });
        messages.push({ role: "assistant", content: `answer ${i}: ` + "a".repeat(400) });
    }
    return { id: "ses-compact", title: "t", messages, changes: [] };
}
const tokensOf = (s) => agent.promptTokensOf(
    agent.buildModelMessages("", s.messages, { historyWindow: 10_000 }));

const SUMMARY = "The operator asked for a darkroom logbook. Decisions: fibre paper, " +
    "two-bath fixer. Files: notes.md written. Still open: the temperature chart.";
const gen = async () => ({ content: SUMMARY });

(async () => {

/* ================= THE MEASURABLE THING: the request gets smaller ========= */
{
    const s = makeSession();
    const before = tokensOf(s);
    const res = await compaction.run(s, { generate: gen });
    const after = tokensOf(s);

    check("it compacts", res.ok === true, res.reason);
    check("THE NEXT REQUEST IS ACTUALLY SMALLER — the only thing compaction is " +
          "for, and the one thing the renderer-only version never did",
        after < before * 0.5, { before, after });
    check("...because the head really was replaced on the session the engine " +
          "reads, not on a copy in a window",
        // one summary + the kept tail (KEEP_TAIL_TURNS user turns, each a
        // question and an answer). Derived, not a literal, so tuning the
        // constant does not silently loosen this check.
        s.messages.length <= 1 + compaction.KEEP_TAIL_TURNS * 2 && res.replaced > 0,
        { left: s.messages.length, replaced: res.replaced,
          allowed: 1 + compaction.KEEP_TAIL_TURNS * 2 });
    check("the summary is the first thing left, and is marked as the seam",
        s.messages[0].meta && s.messages[0].meta.compaction === true
        && /darkroom logbook/.test(s.messages[0].content), s.messages[0].meta);
    check("...and it records how many messages it stands for",
        s.messages[0].meta.replaced === res.replaced, s.messages[0].meta);
}

/* ============ THE OPERATOR'S TRANSCRIPT IS NOT VANDALISED ================ */
{
    const s = makeSession();
    const usersBefore = s.messages.filter(m => m.role === "user").length;
    await compaction.run(s, { generate: gen });
    const planted = s.messages.filter(m =>
        m.role === "user" && /summariz|summaris|TRANSCRIPT:/i.test(String(m.content)));
    check("COMPACTION NEVER PUTS WORDS IN THE OPERATOR'S MOUTH. The old one " +
          "recorded its own prompt as a message he had typed — it is at index " +
          "22 of his real session file",
        planted.length === 0, planted.map(m => String(m.content).slice(0, 80)));
    check("...and every user message that remains is one he really sent",
        s.messages.filter(m => m.role === "user")
            .every(m => /^question \d+: /.test(String(m.content))),
        s.messages.filter(m => m.role === "user").map(m => String(m.content).slice(0, 20)));
    check("(sanity) there were real user messages to begin with", usersBefore > 4, usersBefore);
}

/* ================== THE RECENT TURNS SURVIVE VERBATIM ==================== */
{
    const s = makeSession();
    const lastUser = s.messages.filter(m => m.role === "user").pop().content;
    await compaction.run(s, { generate: gen });
    check("the most recent turns are kept word for word — they are what the " +
          "next message actually depends on",
        s.messages.some(m => m.content === lastUser), null);
    check("...and the tail is verbatim, not summarised",
        s.messages.slice(1).every(m => !(m.meta && m.meta.compaction)), null);
}

/* ============ A FAILED SUMMARISER DOES NOT EAT THE CONVERSATION ========== */
{
    for (const [label, g] of [
        ["a blank summariser", async () => ({ content: "" })],
        ["a one-word summariser", async () => ({ content: "ok" })],
        ["a summariser that throws", async () => { throw new Error("engine died"); }]
    ]) {
        const s = makeSession();
        const n = s.messages.length;
        const res = await compaction.run(s, { generate: g });
        check(`${label} REMOVES NOTHING — replacing the history with an empty ` +
              `message would delete the work and give nothing back`,
            res.ok === false && s.messages.length === n, { res: res.reason, left: s.messages.length });
        check(`...and says why, in words`,
            typeof res.reason === "string" && res.reason.length > 10, res.reason);
    }
}

/* ==================== CANCEL LEAVES IT EXACTLY AS FOUND ================== */
{
    const s = makeSession();
    const n = s.messages.length;
    const cancelToken = { cancelled: false };
    const res = await compaction.run(s, {
        generate: async () => { cancelToken.cancelled = true; return { content: SUMMARY }; },
        cancelToken });
    check("Stop during compaction removes nothing",
        res.ok === false && res.reason === "cancelled" && s.messages.length === n,
        { reason: res.reason, left: s.messages.length });
}

/* ============== TOO SHORT TO COMPACT IS SAID, NOT ATTEMPTED ============== */
{
    const s = makeSession(2);
    let called = false;
    const res = await compaction.run(s, {
        generate: async () => { called = true; return { content: SUMMARY }; } });
    check("a short conversation is not summarised, and no model is paid to " +
          "shorten nothing",
        res.ok === false && called === false, { reason: res.reason, called });
    check("...and the operator is told why rather than left wondering",
        /short enough|nothing old enough/i.test(res.reason || ""), res.reason);
}

/* ============ TIER ONE IS FREE: LONG TOOL RESULTS ARE PRUNED ============= */
{
    const s = makeSession(2);
    s.messages.splice(2, 0, { role: "tool", name: "read_file", content: "X".repeat(9000) });
    const before = tokensOf(s);
    const res = await compaction.run(s, { generate: gen });
    const after = tokensOf(s);
    check("a long tool result is pruned even when there is nothing to summarise " +
          "— the cheapest context there is, and it costs no model call",
        res.pruned === 1 && after < before * 0.5, { before, after, pruned: res.pruned });
    check("...and the pruned message says so where it was cut",
        /compacted — old tool result/.test(s.messages[2].content), s.messages[2].content.slice(-60));
    check("...and is not pruned twice on the next run",
        (await compaction.run(s, { generate: gen })).pruned === 0, null);
}

/* ======== THE AUDIT IS NOT SUMMARISED — IT IS ITS OWN CONTEXT ============ */
{
    // "ancient knowledge is its own context, not part of this context ... but
    // its the audit trail document." Summarising the auditor's commentary would
    // spend the operator's context twice on what ancient_knowledge.md already
    // holds, and would let a stale audit outlive the file that tracks it.
    const s = makeSession();
    s.messages.splice(4, 0, {
        role: "assistant", content: "**Ancient Knowledge Audit:** gaps found:\n- no file",
        meta: { model: "ancient-knowledge", audit: true } });
    let sent = "";
    await compaction.run(s, { generate: async (msgs) => {
        sent = String(msgs[1].content); return { content: SUMMARY }; } });
    check("the audit trail is left out of what the summariser reads — " +
          "ancient_knowledge.md is the record of what is open, and paying to " +
          "summarise it into the conversation would carry it twice",
        !/Ancient Knowledge Audit/.test(sent), sent.slice(0, 200));
    check("...while the real conversation IS what it reads",
        /question 1/.test(sent) && /answer 1/.test(sent), sent.slice(0, 120));
}

/* ================= FOCUS INSTRUCTIONS REACH THE SUMMARISER =============== */
{
    const s = makeSession();
    let sent = "";
    await compaction.run(s, {
        instructions: "the fixer temperatures",
        generate: async (msgs) => { sent = String(msgs[1].content); return { content: SUMMARY }; } });
    check("/compact <focus> reaches the summariser — the argument is not " +
          "decoration on the slash menu",
        /fixer temperatures/.test(sent), sent.slice(0, 160));
    const sys = compaction.SYSTEM;
    check("the summariser is told to keep the operator's OWN standing " +
          "requirements first — losing those is how a compacted session starts " +
          "drifting from what was asked",
        /ASKED FOR/.test(sys) && /own terms/i.test(sys), null);
}

/* ================== IT RUNS IN ITS OWN CONTEXT, NOT AS A TURN =========== */
{
    const s = makeSession();
    let sawSystem = null, msgCount = 0;
    await compaction.run(s, { generate: async (msgs) => {
        sawSystem = String(msgs[0].content); msgCount = msgs.length;
        return { content: SUMMARY }; } });
    check("the summariser gets its OWN system contract and exactly one user " +
          "message — it is not a chat turn wearing a hat",
        msgCount === 2 && /You compact a conversation/.test(sawSystem || ""),
        { msgCount, sys: (sawSystem || "").slice(0, 60) });

    const main = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
    check("and it is wired in the MAIN process, where the session file is — the " +
          "renderer cannot persist a message list, which is why the old one " +
          "reduced nothing",
        /ipcMain\.handle\("lcl:compact"/.test(main) && /sessions\.save\(s\)/.test(main), null);
    const rend = fs.readFileSync(
        path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    check("...and the renderer ASKS for it rather than faking it with a chat turn",
        /window\.lcl\.compact\(/.test(rend)
        && !/sendText\(compactionText/.test(rend), null);
}

console.log(`\n${pass}/${pass + fail} compaction checks passed`);
process.exit(fail ? 1 : 0);
})();
