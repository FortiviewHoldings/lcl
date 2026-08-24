/**
 * FORKING: A NEW CONVERSATION THAT BEGINS WHERE THIS ONE WAS.
 *
 * The feature — "forking into N linked sessions" — with opencode's
 * Session.fork semantics (packages/opencode/src/session/session.ts): messages
 * copied up to a chosen point, "<title> (fork #N)" with the number counting up
 * on a fork of a fork, settings carried, the link recorded.
 *
 * The checks that matter most are the REFUSALS to copy, because a fork built
 * with a spread operator quietly corrupts things:
 *   - the parent's ancient_knowledge.md name must NOT come along, or two
 *     sessions write one audit file, interleaved;
 *   - change records past the fork point must NOT come along, or the fork can
 *     revert an edit from a conversation it does not contain;
 *   - the clone must be DEEP, or a message edited in one session appears in
 *     the other and nobody traces it for a week.
 */
const path = require("path");
const fs = require("fs");

const { fork, forkedTitle } = require(
    path.join(__dirname, "..", ".lcl.engine", "core", "sessionFork.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 280) : ""); }
}

function makeSession() {
    return {
        id: "parent-1", title: "darkroom app", createdAt: 1,
        repoPath: "C:/work/darkroom",
        perms: { secrets: false, selfReview: true },
        modelId: "qwen3-4b", effortLevel: 3, ancientKnowledge: true,
        akReviewFile: "ancient_knowledge.md",
        akReview: { objectives: [{ n: 1, ask: "old", status: "closed" }], akUsd: 0.12 },
        messages: [
            { role: "user", content: "build the page" },                             // 0
            { role: "assistant", content: "Building." },                             // 1
            { role: "tool", name: "write_file", content: "{}",
              change: { id: "c1", kind: "created", path: "index.html" } },           // 2
            { role: "user", content: "now add the footer" },                         // 3
            { role: "tool", name: "write_file", content: "{}",
              change: { id: "c2", kind: "edited", path: "index.html" } },            // 4
            { role: "assistant", content: "Footer added." }                          // 5
        ],
        changes: [
            { id: "c1", kind: "created", path: "index.html" },
            { id: "c2", kind: "edited", path: "index.html" }
        ]
    };
}

/* --------------------------------------------------------------- the title */
check('the title says what it is: "<title> (fork #1)"',
    forkedTitle("darkroom app") === "darkroom app (fork #1)", forkedTitle("darkroom app"));
check("forking a fork COUNTS UP instead of nesting parentheses — opencode's " +
      "getForkedTitle rule, kept exactly",
    forkedTitle("darkroom app (fork #1)") === "darkroom app (fork #2)"
    && forkedTitle("darkroom app (fork #9)") === "darkroom app (fork #10)", null);
check("an untitled session still forks with a name",
    /\(fork #1\)$/.test(forkedTitle("")), forkedTitle(""));

/* ----------------------------------------------------- the whole-session fork */
{
    const parent = makeSession();
    const f = fork(parent);
    check("the fork carries every message when no cut point is given",
        f.messages.length === 6, f.messages.length);
    check("...under a new id — two sessions with one id is one session",
        f.id && f.id !== parent.id, f.id);
    check("THE LINK IS RECORDED, NOT INFERRED FROM THE TITLE — 'linked " +
          "sessions' means the relationship is a fact on the record",
        f.forkedFrom && f.forkedFrom.id === "parent-1"
        && f.forkedFrom.messageIndex === 6, f.forkedFrom);
    check("the conversation's SETTINGS come along — workspace, permissions, " +
          "model, effort, the brain — they are what make it a continuation",
        f.repoPath === parent.repoPath && f.perms.selfReview === true
        && f.modelId === "qwen3-4b" && f.effortLevel === 3
        && f.ancientKnowledge === true, null);
    check("THE PARENT'S REVIEW FILE NAME DOES NOT — a fork sharing the " +
          "workspace would write into the parent's ancient_knowledge.md, two " +
          "sessions interleaved in one audit document",
        f.akReviewFile === undefined, f.akReviewFile);
    check("...and neither does its audit record: the fork's own auditing " +
          "starts at zero, the shared history is already in the messages",
        f.akReview === undefined, f.akReview);
    check("both change records come along, because both are in kept messages",
        f.changes.length === 2, f.changes);
}

/* --------------------------------------------------------- fork from a point */
{
    const parent = makeSession();
    const f = fork(parent, 3);   // everything BEFORE "now add the footer"
    check("FORK FROM A MESSAGE carries everything BEFORE it — re-ask that " +
          "question differently without losing the original thread",
        f.messages.length === 3
        && f.messages[2].role === "tool", f.messages.map(m => m.role));
    check("...and records the cut point on the link",
        f.forkedFrom.messageIndex === 3, f.forkedFrom);
    check("A CHANGE RECORD PAST THE CUT DOES NOT COME ALONG — a fork made at " +
          "message 3 must not be able to revert the edit message 4 made in a " +
          "conversation it does not contain",
        f.changes.length === 1 && f.changes[0].id === "c1", f.changes);
}

/* -------------------------------------------------------------- deep clone */
{
    const parent = makeSession();
    const f = fork(parent);
    f.messages[0].content = "EDITED IN THE FORK";
    f.changes[0].path = "EDITED.html";
    f.perms.selfReview = false;
    check("THE CLONE IS DEEP. A message edited in the fork appearing in the " +
          "parent is the class of defect nobody traces for a week",
        parent.messages[0].content === "build the page"
        && parent.changes[0].path === "index.html"
        && parent.perms.selfReview === true, null);
}

/* ------------------------------------------------------------- bad inputs */
{
    const parent = makeSession();
    check("an out-of-range cut clamps to the end rather than throwing",
        fork(parent, 999).messages.length === 6, null);
    check("a zero cut is a fork with settings and no history — legal, and " +
          "explicitly so", fork(parent, 0).messages.length === 0, null);
    let threw = false;
    try { fork(null); } catch { threw = true; }
    check("no session, no fork — loudly", threw, null);
}

/* ----------------------------------------------------- the wiring is real */
{
    const mainSrc = fs.readFileSync(
        path.join(__dirname, "..", "app", "main.js"), "utf8");
    check("the fork is reachable over IPC, persisted, and audited",
        /ipcMain\.handle\("lcl:forkSession"/.test(mainSrc)
        && /sessions\.save\(forked\)/.test(mainSrc)
        && /kind: "session-fork"/.test(mainSrc), null);
    const pre = fs.readFileSync(
        path.join(__dirname, "..", "app", "preload.js"), "utf8");
    check("...and exposed to the renderer",
        /forkSession: \(id, messageIndex\)/.test(pre), null);
    const app = fs.readFileSync(
        path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    check("the session menu offers Fork — and does NOT gate it on the row " +
          "being idle: the parent keeps working and the fork owns the " +
          "transcript as it stood",
        /\{ label: "Fork", run: \(\) => forkSessionRow\(s\.id\) \}/.test(app), null);
    check("...and the user's own messages carry 'fork from here', the cut " +
          "carrying everything BEFORE that message",
        /msg-fork/.test(app) && /forkSessionRow\(sid, at\)/.test(app), null);
    check("...which opens the fork and says what happened, naming the parent " +
          "as untouched",
        /switchSession\(res\.id\)/.test(app)
        && /original conversation is untouched/.test(app), null);
}

console.log(`\n${pass}/${pass + fail} session-fork checks passed`);
process.exit(fail ? 1 : 0);
