/**
 * A CONFIRM-CLASS ACTION STAGED INSIDE AN ORCHESTRATED BUILD REACHES THE HUMAN.
 *
 * The operator, testing the React scaffold flow:
 *
 *   "it was thinking, said it needed my approval in the activity and the chat,
 *    but no prompt appeared ... it prompted in the system tray ... it ended up
 *    resolving with no action, and no prompt for me to read and approve or
 *    reject in the chat. so its there, it is just not fully functional yet."
 *
 * The scaffold runs through orchestrator.runGoal, which drives every step with
 * agent.runTurn(stepMode:true). In stepMode runTurn does NOT persist its own
 * messages — so the role:"tool" message carrying `.proposal` (the ONLY thing
 * the renderer draws an approval card from) lived only in stepRes.newMessages,
 * which runGoal discarded. It harvested pendingApprovals (so the tray toast
 * fired) but threw the message away (so no card), and it never paused (so the
 * turn "kept thinking" and the summary made it look done).
 *
 * This suite drives the REAL runGoal with a scripted router and a runTurn that
 * stages an approval, and pins all three halves of the fix: the proposal
 * message is carried out to the caller AND onto the transcript, the plan PAUSES
 * the moment an approval is staged, and the summary says so out loud.
 */
const os = require("os");
const path = require("path");
const fs = require("fs");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
process.resourcesPath = path.join(__dirname, "..");
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-stg-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false,
                   encryptString: (s) => Buffer.from(String(s)),
                   decryptString: (b) => Buffer.from(b).toString() }
} };

const CORE = path.join(__dirname, "..", ".lcl.engine", "core");

/* the router is scripted: it plans, and it never audits (review is off here) */
const ROUTER_PATH = require.resolve(path.join(CORE, "router.js"));
const routerStub = {
    plan: "",
    generate: async (messages) => {
        const sys = String((messages[0] && messages[0].content) || "");
        if (/\bplanner\b/i.test(sys)) return { content: routerStub.plan };
        return { content: "ok" };
    },
    limits: () => ({ kind: "local", label: "stub", maxSteps: 4, maxTokens: 1536,
                     historyWindow: 12, toolResultCap: 6000 }),
    resolveSelection: () => ({ sel: null }),
    usingRemote: () => false,
    activeModel: () => "stub-model"
};
require.cache[ROUTER_PATH] = { id: ROUTER_PATH, filename: ROUTER_PATH,
    loaded: true, exports: routerStub };

/* the critic's model half is made deterministic; the deterministic gate still
 * runs for real, so a step that produced a file would still be checked. */
const engine = require(path.join(CORE, "engine.js"));
engine.generate = async () => ({ content: "PASS" });

const agent = require(path.join(CORE, "agent.js"));
const orchestrator = require(path.join(CORE, "orchestrator.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

function makeSession(extra = {}) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-stg-repo-"));
    return { id: "ses-" + Math.random().toString(36).slice(2, 10),
             title: "staged approval", messages: [], changes: [],
             // brain OFF so the audit/AK phases stay out of this suite — the
             // subject is the STEP path carrying a staged proposal.
             ancientKnowledge: false, selfReview: false,
             effortLevel: 0, repoPath: repo, ...extra };
}

/* THE STAGED STEP DELIBERATELY EXPECTS A FILE. It stages instead of writing,
 * so the deterministic critic REJECTS it ("no file") — which is exactly the
 * path that used to retry the step and stage the SAME action a second time
 * under a fresh id. A no-file second step follows, to prove the plan pauses. */
const PLAN = JSON.stringify({ steps: [
    { title: "Scaffold the app", action: "Write index.html: the landing page" },
    { title: "Report back",      action: "Report what happened" }
] });

const PROPOSAL = {
    id: "p-scaffold-1", kind: "tool", tool: "scaffold_app",
    args: { name: "site" }, digest: "d1", sessionId: null, repoPath: null
};

(async () => {

/* ===================== THE STAGED STEP SURFACES A CARD =================== */
{
    const s = makeSession();
    PROPOSAL.sessionId = s.id; PROPOSAL.repoPath = s.repoPath;
    routerStub.plan = PLAN;

    // record every step instruction so we can prove the plan PAUSED
    const seen = [];
    const realRunTurn = agent.runTurn;
    agent.runTurn = async (session, instruction, opts) => {
        seen.push(instruction);
        // the FIRST step stages a confirm-class action, exactly as the real
        // agent loop does at the policy gate: a role:"tool" message carrying
        // `.proposal`, plus the same proposal in pendingApprovals. Nothing ran.
        if (seen.length === 1) {
            return { ok: true, changes: [], pendingApprovals: [ { ...PROPOSAL } ],
                newMessages: [ {
                    role: "tool", name: "scaffold_app", failed: false,
                    content: "Shown to the user for approval (execute action). It has NOT run.",
                    proposal: { ...PROPOSAL }
                } ] };
        }
        // any later step (must NOT happen) returns a bland completion
        return { ok: true, changes: [], pendingApprovals: [],
                 newMessages: [ { role: "assistant", content: "second step ran" } ] };
    };

    let res;
    try {
        res = await orchestrator.runGoal(s, "scaffold a react app and serve it", {
            selection: null, cancelToken: { cancelled: false } });
    } finally { agent.runTurn = realRunTurn; }

    check("the orchestrated goal returns cleanly", res && res.ok === true,
        res && res.error);

    // (1) the approval is carried out to the caller so main can register it
    check("the staged approval RIDES OUT in pendingApprovals — this is what the " +
          "tray toast fired on, and it must keep working",
        (res.pendingApprovals || []).some(p => p.id === PROPOSAL.id),
        res.pendingApprovals);

    // (2) THE FIX: the proposal-bearing MESSAGE rides out too — the card is
    // drawn only from a message carrying `.proposal`
    const carded = (res.newMessages || []).filter(m => m && m.proposal);
    check("the PROPOSAL MESSAGE reaches the returned delta — before this it was " +
          "dropped with stepRes.newMessages, so the card never rendered",
        carded.length === 1 && carded[0].proposal.id === PROPOSAL.id,
        (res.newMessages || []).map(m => m.role + (m.proposal ? "+proposal" : "")));

    // (3) it is ordered BEFORE the summary, so the card sits above the note
    const idxCard = (res.newMessages || []).findIndex(m => m && m.proposal);
    const idxSummary = (res.newMessages || []).findIndex(
        m => m.role === "assistant" && /Paused[\s\S]*needs your approval/i.test(m.content || ""));
    check("the card comes BEFORE the summary in the delta", idxCard > -1
        && idxSummary > idxCard, { idxCard, idxSummary });

    // (4) it is on the SESSION transcript too, so a reload still draws the card
    check("the proposal message is persisted to the session transcript — a " +
          "reload must not lose a live approval",
        s.messages.some(m => m && m.proposal && m.proposal.id === PROPOSAL.id),
        s.messages.map(m => m.role + (m.proposal ? "+proposal" : "")));

    // (5) THE PLAN PAUSED and the step did NOT retry-and-restage. runTurn was
    // called exactly once: not again for a retry (the staged step is not
    // re-attempted) and not again for step 2 (the plan paused). Either failure
    // would double a card or march past a pending action.
    check("runTurn ran exactly ONCE — the staged step is not retried (no second " +
          "card for one action) and the plan does not advance to the next step",
        seen.length === 1, seen);
    check("...so exactly one approval is queued, never a duplicate from a retry",
        (res.pendingApprovals || []).length === 1, res.pendingApprovals);

    // (6) the summary says it is waiting, not that it is done / not a clarify Q
    const summary = (res.newMessages || []).find(
        m => m.role === "assistant" && /Paused[\s\S]*needs your approval/i.test(m.content || ""));
    check("the summary tells the operator it is WAITING on them, in plain words",
        !!summary && /Paused[\s\S]*needs your approval/i.test(summary.content), summary);
    check("...and it is NOT worded as done",
        !(res.newMessages || []).some(m => m.role === "assistant"
            && /^Done —/.test(String(m.content || ""))), null);
}

/* ============ NO STAGED ACTION: THE PLAN STILL RUNS TO THE END ========== */
{
    const s = makeSession();
    // a no-file plan so each step is one runTurn and the critic short-circuits
    // without a model call — the subject here is "the pause fires ONLY on a
    // real staged approval", not the critic.
    routerStub.plan = JSON.stringify({ steps: [
        { title: "Think", action: "Consider what was asked and say so" },
        { title: "Report", action: "Report what you considered" }
    ] });
    const seen = [];
    const realRunTurn = agent.runTurn;
    agent.runTurn = async (session, instruction) => {
        seen.push(instruction);
        return { ok: true, changes: [], pendingApprovals: [],
                 newMessages: [ { role: "assistant", content: "did it" } ] };
    };
    let res;
    try {
        res = await orchestrator.runGoal(s, "do two harmless steps", {
            selection: null, cancelToken: { cancelled: false } });
    } finally { agent.runTurn = realRunTurn; }

    check("with NOTHING staged, every step runs — the pause is triggered only by " +
          "a real staged approval, never by an empty one",
        seen.length === 2, seen);
    check("...and no phantom proposal message is invented",
        !(res.newMessages || []).some(m => m && m.proposal), null);
    check("...and pendingApprovals is empty", (res.pendingApprovals || []).length === 0,
        res.pendingApprovals);
}

/* cleanup */
try { fs.rmSync(LCL_TEST_DATA, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 }); } catch {}

console.log(`\n${pass}/${pass + fail} orchestrator staged-approval checks passed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
