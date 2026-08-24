/**
 * ANCIENT KNOWLEDGE RUNS ON THE ORCHESTRATED PATH TOO — AND WHEN IT STOPS,
 * IT SAYS SO.
 *
 * The operator, describing what he actually watched happen:
 *
 *   "ancient knowledge appeared to run, and forced the model into a loop, but
 *    the model did not actually do what it said. you can see in the 20 rounds
 *    that ran, and the ancient knowledge did not continue to audit and
 *    respond, it just stopped, that is the issue. the model ran away
 *    unguided"
 *
 * Two defects, and this suite is the standing proof of both fixes.
 *
 * ONE — the auditor was never invoked. agent.runTurn gates the whole audit
 * behind `!opts.stepMode`, and orchestrator.runGoal runs every step of every
 * plan with stepMode:true. Since Ancient Knowledge cannot be enabled without
 * a linked workspace and `orchestrate` requires one, the sessions most likely
 * to be orchestrated were exactly the sessions that had asked to be audited.
 * Twenty rounds of plan steps ran with nobody checking them.
 *
 * TWO — the loop could go quiet. A round that forced a response and got a
 * failure back had no named exit, and a `closed` verdict printed nothing at
 * all, so "audited and passed", "auditor is dead" and "auditor never ran"
 * were indistinguishable from the outside.
 *
 * So the checks below are mostly refusals: the cycle must not continue
 * silently, must not stop silently, and must never launder an absent auditor
 * into a pass. The loop is exercised through the real runGoal and the real
 * runCycle with a scripted router — the loop that ships is the loop tested.
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
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ako-"));
require.cache[__filename] = { exports: {
    // isPackaged TRUE so paths.dataDir() lands in this run's throwaway
    // directory rather than the developer's real ledger — same reason as the
    // sibling suite.
    app: { isPackaged: true, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false,
                   encryptString: (s) => Buffer.from(String(s)),
                   decryptString: (b) => Buffer.from(b).toString() }
} };

/* The router is scripted. Injected before anything requires it, so the
 * orchestrator, the agent and Ancient Knowledge all wire to this one. */
const CORE = path.join(__dirname, "..", ".lcl.engine", "core");
const ROUTER_PATH = require.resolve(path.join(CORE, "router.js"));
/* Answers are keyed by WHO IS ASKING, not by call order. The step machine
 * retries a step its critic rejects, so a positional script silently shifts
 * the auditor's answers onto a driver call and the suite starts testing
 * nothing. Routing on the system prompt keeps this suite about the audit. */
const routerStub = {
    plan: "", audits: [], driver: "I did the thing.", calls: [],
    generate: async (messages, maxTokens, cancelToken, onToken, opts) => {
        routerStub.calls.push({ messages, maxTokens, opts });
        const sys = String((messages[0] && messages[0].content) || "");
        if (/Ancient Knowledge overseer/.test(sys)) {
            const next = routerStub.audits.shift();
            return { content: next === undefined ? "" : next };
        }
        if (/\bplanner\b/i.test(sys)) return { content: routerStub.plan };
        return typeof routerStub.driver === "function"
            ? routerStub.driver() : { content: routerStub.driver };
    },
    limits: () => ({ kind: "local", label: "stub", maxSteps: 4, maxTokens: 1536,
                     historyWindow: 12, toolResultCap: 6000 }),
    resolveSelection: () => ({ sel: null }),
    usingRemote: () => false,
    activeModel: () => "stub-model"
};
require.cache[ROUTER_PATH] = { id: ROUTER_PATH, filename: ROUTER_PATH,
    loaded: true, exports: routerStub };

const ak = require(path.join(CORE, "ancientKnowledge.js"));
const orchestrator = require(path.join(CORE, "orchestrator.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

function makeSession(extra = {}) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ako-repo-"));
    return { id: "ses-" + Math.random().toString(36).slice(2, 10),
             title: "ak orchestrated", messages: [], changes: [],
             ancientKnowledge: true, effortLevel: 0, repoPath: repo, ...extra };
}
const audits = (msgs) => (msgs || []).filter(
    m => m.meta && m.meta.model === "ancient-knowledge");
const reviewOf = (session) => {
    const f = path.join(session.repoPath,
                        session.akReviewFile || "ancient_knowledge.md");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
};

/* A plan whose steps write no files and are not expected to — so each step is
 * exactly one driver call and the step critic short-circuits without one. The
 * subject under test is the AUDIT, not the step machine, which has its own
 * suite. */
const PLAN = JSON.stringify({ steps: [
    { title: "Consider the request", action: "Consider what was asked and say so" },
    { title: "Report back", action: "Report what you considered" }
] });

/* ------------------------------------------------- every stop has a name */
{
    for (const k of ["closed", "user-test", "nothing-new", "rounds", "budget",
                     "review-unavailable", "cancelled", "round-failed",
                     "no-response", "awaiting-approval"]) {
        check(`the stop reason "${k}" has operator-facing words`,
            typeof ak.STOP_WORDS[k] === "string" && ak.STOP_WORDS[k].length > 4,
            ak.STOP_WORDS[k]);
    }
    check("A DEAD AUDITOR IS NEVER WORDED AS SUCCESS — the one sentence that " +
          "must never read as a pass",
        /NOT verified/i.test(ak.STOP_WORDS["review-unavailable"])
        && !/complete|closed|pass/i.test(ak.STOP_WORDS["review-unavailable"]),
        ak.STOP_WORDS["review-unavailable"]);
    check("a failed forced round says the gaps are still OPEN rather than " +
          "going quiet — this is the 'ran away unguided' case",
        /OPEN/i.test(ak.STOP_WORDS["round-failed"]), ak.STOP_WORDS["round-failed"]);
}

/* --------------------------------------- a passing audit is VISIBLE (unit) */
{
    const closed = ak.bubbleText({ status: "closed", gaps: [], raw: "" }, 1);
    check("a CLOSED verdict produces a visible bubble — silence is what made " +
          "'it audited and passed' look identical to 'it never ran'",
        /Ancient Knowledge/i.test(closed) && closed.length > 30, closed);
    const dead = ak.bubbleText({ status: "unavailable", gaps: [], raw: "" }, 2);
    check("...and a DEAD auditor says outright that completion is not verified",
        /NOT verified/i.test(dead), dead);
    check("...and does not congratulate anyone",
        !/complete|all gaps closed/i.test(dead), dead);
}

(async () => {

/* ============================ THE FIX: runGoal AUDITS ==================== */
{
    const s = makeSession({ effortLevel: 2 });          // maxRounds 4
    routerStub.plan = PLAN;
    routerStub.driver = "I did the step.";
    routerStub.audits = [
        "VERDICT: GAPS\nGAP: nothing was actually delivered",
        "VERDICT: CLOSED"
    ];
    routerStub.calls = [];
    const res = await orchestrator.runGoal(s, "build the docs site and the ui", {
        selection: null, cancelToken: { cancelled: false } });

    check("the orchestrated goal completes", res.ok === true, res && res.error);
    check("ANCIENT KNOWLEDGE RAN ON THE ORCHESTRATED PATH. Before this it was " +
          "structurally impossible: runGoal drives every step with " +
          "stepMode:true, and runTurn's audit gate opens with !opts.stepMode",
        res.ancientKnowledge && res.ancientKnowledge.ran === true,
        res.ancientKnowledge);
    check("...it interrogated, forced a response, and interrogated AGAIN — the " +
          "cycle, not a single pass",
        res.ancientKnowledge.rounds === 2, res.ancientKnowledge);
    check("...and stopped for a NAMED reason",
        res.ancientKnowledge.stopped === "closed", res.ancientKnowledge);
    check("the interrogation ran under the overseer prompt, not the step critic",
        routerStub.calls.some(c => /Ancient Knowledge overseer/.test(
            (c.messages[0] && c.messages[0].content) || "")), null);
    check("...and it interrogated the OPERATOR'S GOAL against the finished " +
          "whole, which is the only thing 'is what he asked for here' can be " +
          "asked about",
        routerStub.calls.some(c => /docs site and the ui/.test(
            (c.messages[1] && c.messages[1].content) || "")), null);

    const a = audits(res.newMessages);
    check("the audit reaches the transcript the operator actually reads",
        a.length === 2, a.map(m => m.meta.verdict));
    check("...naming the gap it found",
        /nothing was actually delivered/i.test(a[0].content), a[0].content);
    check("...and saying out loud that the second pass closed it",
        a[1].meta.verdict === "closed", a[1].meta);
    check("the forced instruction is NOT shown as something the user typed — " +
          "the audit bubble is the visible cause, the instruction is machinery",
        !(res.newMessages || []).some(
            m => m.role === "user" && /Ancient Knowledge/i.test(String(m.content))),
        (res.newMessages || []).filter(m => m.role === "user").map(m => m.content));
    check("the transcript the SESSION keeps matches the delta the UI is handed",
        audits(s.messages).length === 2, s.messages.length);
    check("...with no message stored twice",
        s.messages.length === res.newMessages.length,
        { stored: s.messages.length, handed: res.newMessages.length });
    check("EACH ROUND IS ON THE TRANSCRIPT BEFORE THE NEXT ONE RUNS — the " +
          "forced response is a fresh turn built from session history, so a " +
          "cycle that persisted only at the end would have every round start " +
          "from the same place and re-attempt the same fix",
        (() => {
            const i = s.messages.findIndex(m => m.meta
                && m.meta.model === "ancient-knowledge" && m.meta.round === 1);
            const j = s.messages.findIndex(m => m.meta
                && m.meta.model === "ancient-knowledge" && m.meta.round === 2);
            // the forced answer sits BETWEEN the two audits, in order
            return i > -1 && j > i + 1;
        })(), s.messages.map(m => (m.meta && m.meta.model) || m.role));

    const doc = reviewOf(s);
    check("ancient_knowledge.md was written into the linked workspace — the " +
          "operator's own file name, on the orchestrated path too",
        doc !== null && /Ancient Knowledge/i.test(doc), doc && doc.slice(0, 80));
    check("...and it records the goal it was auditing",
        doc && /docs site and the ui/i.test(doc), null);
}

/* ================= THE OTHER FIX: A FAILED ROUND STOPS OUT LOUD ========== */
{
    const s = makeSession({ effortLevel: 4 });          // maxRounds 6 — room to run
    routerStub.audits = ["VERDICT: GAPS\nGAP: it is not done"];
    let rounds = 0;
    const cycle = await ak.runCycle(s, {
        userAsk: "make the thing work",
        response: "I made the thing work.",
        auditorSelection: null,
        // the auditor keeps finding NEW gaps, so nothing else would stop this
        respond: async () => { rounds++; return { ok: false, error: "engine died" }; }
    });
    check("a forced round whose response FAILED stops the cycle",
        cycle.rounds === 1 && rounds === 1, { rounds: cycle.rounds, forced: rounds });
    check("...with a named reason, not silence. Going quiet here is precisely " +
          "the model 'running away unguided': the auditor stops and the work " +
          "carries on with nobody checking it",
        cycle.stopped === "round-failed", cycle.stopped);
}
{
    // and the same for a forced round that came back with nothing to audit
    const s = makeSession({ effortLevel: 4 });
    routerStub.audits = ["VERDICT: GAPS\nGAP: it is not done"];
    const cycle = await ak.runCycle(s, {
        userAsk: "make the thing work", response: "I made the thing work.",
        auditorSelection: null,
        respond: async () => ({ ok: true, newMessages: [], changes: [] })
    });
    check("a forced round that produced NO answer also stops with a name — " +
          "re-auditing the same text would just re-derive the same gaps and " +
          "burn the ceiling pretending to work",
        cycle.stopped === "round-failed", cycle.stopped);
}
{
    // a staged approval is the human's move, and the auditor does not talk over it
    const s = makeSession({ effortLevel: 4 });
    routerStub.audits = ["VERDICT: GAPS\nGAP: it is not done"];
    const surfaced = [];
    const cycle = await ak.runCycle(s, {
        userAsk: "delete the old build", response: "I will delete it.",
        auditorSelection: null,
        onMessages: (ms) => surfaced.push(...ms),
        // the forced round STAGES a confirm-class action: an assistant note AND
        // the role:"tool" message carrying the `.proposal` the card is drawn from
        respond: async () => ({ ok: true,
            newMessages: [
                { role: "assistant", content: "I will stage the delete." },
                { role: "tool", name: "delete_file",
                  content: "Shown for approval. It has NOT run.",
                  proposal: { id: "p1", kind: "tool", tool: "delete_file" } }
            ],
            pendingApprovals: [{ id: "p1", kind: "tool", tool: "delete_file" }] })
    });
    check("a confirm-class action staged mid-cycle hands the turn to the HUMAN " +
          "instead of being audited past",
        cycle.stopped === "awaiting-approval", cycle.stopped);
    check("...and the approval is carried out to the caller, not dropped with " +
          "the round",
        cycle.pendingApprovals.length === 1, cycle.pendingApprovals);
    // THE PROPOSAL MESSAGE MUST SURVIVE THE ROUND. runCycle used to filter
    // res.newMessages to role:"assistant", dropping the role:"tool" proposal
    // message — so the tray toast fired but no card ever rendered (the AK-path
    // copy of the orchestrator's dropped-proposal bug).
    check("the PROPOSAL MESSAGE rides out in cycle.messages — the card is drawn " +
          "only from a message carrying `.proposal`",
        cycle.messages.some(m => m && m.proposal && m.proposal.id === "p1"),
        cycle.messages.map(m => m.role + (m.proposal ? "+proposal" : "")));
    check("...and it reaches the transcript via onMessages too, so a reload still " +
          "draws it",
        surfaced.some(m => m && m.proposal && m.proposal.id === "p1"),
        surfaced.map(m => m.role + (m.proposal ? "+proposal" : "")));
}
{
    // a dead auditor on the orchestrated path is still never a pass
    const s = makeSession();
    routerStub.audits = [""];
    const cycle = await ak.runCycle(s, {
        userAsk: "build it", response: "Built.", auditorSelection: null,
        respond: async () => ({ ok: true, newMessages: [] })
    });
    check("A BLANK AUDITOR IS NOT A PASS, on this path either",
        cycle.stopped === "review-unavailable", cycle.stopped);
    check("...and it says so in the transcript rather than passing silently",
        cycle.messages.length === 1 && /NOT verified/i.test(cycle.messages[0].content),
        cycle.messages.map(m => m.content));
    check("...and the objective is not marked closed by an auditor that " +
          "never spoke",
        cycle.objective.status !== "closed", cycle.objective);
}
{
    // the ceiling still holds, and the operator's effort slider still sets it
    const s = makeSession({ effortLevel: 0 });          // maxRounds 2
    let forced = 0;
    routerStub.audits = ["VERDICT: GAPS\nGAP: first thing missing",
                         "VERDICT: GAPS\nGAP: second thing missing"];
    const cycle = await ak.runCycle(s, {
        userAsk: "build it", response: "Built.", auditorSelection: null,
        respond: async () => { forced++; return { ok: true, newMessages:
            [{ role: "assistant", content: "Fixed round " + forced }] }; }
    });
    check("the round ceiling comes from the effort slider and is enforced here " +
          "too — 2 rounds at Terrestrial",
        cycle.rounds === 2 && forced === 1, { rounds: cycle.rounds, forced });
    check("...and hitting the ceiling with gaps still open says so, rather " +
          "than reporting done",
        cycle.stopped === "rounds" && /OPEN/i.test(ak.STOP_WORDS[cycle.stopped]),
        cycle.stopped);
}
{
    // the spend ceiling has to see the whole cycle, not half of it
    const s = makeSession({ effortLevel: 4 });          // maxRounds 6
    routerStub.audits = ["VERDICT: GAPS\nGAP: the first thing",
                         "VERDICT: GAPS\nGAP: the second thing"];
    const cycle = await ak.runCycle(s, {
        userAsk: "build it", response: "Built.", auditorSelection: null,
        budgetUsd: 0.10,
        respond: async () => ({ ok: true, costUsd: 0.25,
            newMessages: [{ role: "assistant", content: "Round done." }] })
    });
    check("THE SPEND CEILING COUNTS THE FORCED RESPONSES, not only the " +
          "auditor's own calls — a free local auditor driving an expensive " +
          "model is exactly the case where the bill comes from the forcing",
        cycle.stopped === "budget" && cycle.usd >= 0.25,
        { stopped: cycle.stopped, usd: cycle.usd });
}
{
    // a re-surfaced gap is not progress
    const s = makeSession({ effortLevel: 4 });
    routerStub.audits = ["VERDICT: GAPS\nGAP: the config file is missing",
                         "VERDICT: GAPS\nGAP: The config file is MISSING!"];
    const cycle = await ak.runCycle(s, {
        userAsk: "build it", response: "Built.", auditorSelection: null,
        respond: async () => ({ ok: true,
            newMessages: [{ role: "assistant", content: "I fixed it, honest." }] })
    });
    check("the same gap coming back in different words is NOT progress — the " +
          "loop stops instead of grinding the ceiling down",
        cycle.stopped === "nothing-new", cycle.stopped);
}
{
    // nothing to audit
    const s = makeSession();
    const cycle = await ak.runCycle(s, { userAsk: "build it", response: "   " });
    check("an empty response is not interrogated, and does not silently count " +
          "as a clean audit",
        cycle.ran === false && cycle.stopped === "no-response", cycle);
}

/* ================== THE OPERATOR'S SWITCH IS STILL THE SWITCH ============ */
{
    const s = makeSession({ ancientKnowledge: false, effortLevel: 2 });
    routerStub.plan = PLAN; routerStub.driver = "I did the step.";
    routerStub.audits = [];
    routerStub.calls = [];
    const res = await orchestrator.runGoal(s, "build the docs site and the ui", {
        selection: null, cancelToken: { cancelled: false } });
    check("with the brain OFF, an orchestrated goal is not audited and not " +
          "billed for one",
        res.ok === true && !res.ancientKnowledge, res.ancientKnowledge);
    check("...and no overseer prompt was ever sent",
        !routerStub.calls.some(c => /Ancient Knowledge overseer/.test(
            (c.messages[0] && c.messages[0].content) || "")), null);
    check("...and no review file was written into the workspace",
        reviewOf(s) === null, null);
}

/* ================== THE AFTERTHOUGHTS ARE PART OF THE ASK =============== */
{
    const s = makeSession({ effortLevel: 2 });
    routerStub.plan = PLAN; routerStub.driver = "I did the step.";
    routerStub.audits = ["VERDICT: CLOSED"];
    routerStub.calls = [];
    await orchestrator.runGoal(s, "build the docs site", {
        selection: null, cancelToken: { cancelled: false },
        addenda: ["also put the changelog on it"] });
    const overseer = routerStub.calls.find(c =>
        /Ancient Knowledge overseer/.test((c.messages[0] && c.messages[0].content) || ""));
    check("AN AFTERTHOUGHT TYPED MID-RUN IS INTERROGATED AS PART OF THE " +
          "ORIGINAL REQUEST, not queued behind it — 'i do not want a queue, " +
          "with ancient knowledge'",
        overseer && /changelog/i.test(overseer.messages[1].content),
        overseer && overseer.messages[1].content.slice(0, 200));
}

/* ====================== THE CHOSEN AUDITOR IS HONOURED =================== */
{
    const s = makeSession({ effortLevel: 2 });
    const chosen = { kind: "endpoint", id: "some-node" };
    routerStub.plan = PLAN; routerStub.driver = "I did the step.";
    routerStub.audits = ["VERDICT: CLOSED"];
    routerStub.calls = [];
    await orchestrator.runGoal(s, "build the docs site", {
        selection: null, cancelToken: { cancelled: false },
        auditorSelection: chosen });
    const overseer = routerStub.calls.find(c =>
        /Ancient Knowledge overseer/.test((c.messages[0] && c.messages[0].content) || ""));
    check("the auditor model chosen in settings drives the interrogation on " +
          "this path too — 'the API answers, a local node audits' has to mean " +
          "the same thing in an orchestrated build",
        overseer && overseer.opts && overseer.opts.selection === chosen,
        overseer && overseer.opts);

    const s2 = makeSession({ effortLevel: 2 });
    routerStub.plan = PLAN; routerStub.driver = "I did the step.";
    routerStub.audits = ["VERDICT: CLOSED"];
    routerStub.calls = [];
    await orchestrator.runGoal(s2, "build the docs site", {
        selection: null, cancelToken: { cancelled: false },
        auditorSelection: "local" });
    const o2 = routerStub.calls.find(c =>
        /Ancient Knowledge overseer/.test((c.messages[0] && c.messages[0].content) || ""));
    check('...and the "local" sentinel resolves to the local engine, so a free ' +
          "auditor can interrogate a paid driver without billing for it",
        o2 && o2.opts && o2.opts.selection === null, o2 && o2.opts);
}

/* ============================ CANCEL IS RESPECTED ======================= */
{
    const s = makeSession({ effortLevel: 4 });
    const cancelToken = { cancelled: false };
    routerStub.audits = ["VERDICT: GAPS\nGAP: not done"];
    const cycle = await ak.runCycle(s, {
        userAsk: "build it", response: "Built.", auditorSelection: null,
        cancelToken,
        respond: async () => { cancelToken.cancelled = true;
                               return { ok: false, error: "cancelled" }; }
    });
    check("Stop during a forced round ends the cycle as CANCELLED, not as a " +
          "failure and not as done",
        cycle.stopped === "cancelled", cycle.stopped);
}

/* ============ THE LOOP IS ONE LOOP, NOT TWO COPIES OF ONE LOOP ========== */
{
    const src = fs.readFileSync(path.join(CORE, "orchestrator.js"), "utf8");
    check("the orchestrator DELEGATES to ancientKnowledge.runCycle rather than " +
          "carrying its own copy — two audit loops drift, and then a gap " +
          "closed on one path is open on the other",
        /ancientKnowledge/.test(src) && /runCycle\(/.test(src), null);
    check("...and it does not re-implement the verdict grammar",
        !/VERDICT:\s*(CLOSED|GAPS)/.test(src), null);
    const agentSrc = fs.readFileSync(path.join(CORE, "agent.js"), "utf8");
    check("the chat path still gates its own audit on stepMode, so an " +
          "orchestrated step never runs a SECOND auditor inside the first",
        /!opts\.stepMode/.test(agentSrc), null);
    // A forced round can STAGE an action AFTER the summary was written (the
    // summary runs before AK, and AK only runs when nothing was staged, so that
    // summary said "Done"). The record is corrected in place so it does not
    // claim completion above a card that is waiting on the operator.
    check("an AK-staged action after the summary CORRECTS the summary — no 'Done' " +
          "above a live approval card",
        /if \(akCycle && stagedApprovals\.size > 0\) \{[\s\S]{0,220}summaryMsg\.content =/.test(src),
        null);
}

/* ========== THE UI SAYS WHY IT STOPPED, AND SAYS THE SAME THING ========= */
{
    // The renderer cannot require an engine module, so app.js keeps its own
    // copy of the stop words. A copy that drifts is worse than no copy: the
    // feed would show a raw key, or nothing, for exactly the exits the
    // operator most needs named.
    const ui = fs.readFileSync(
        path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    const block = /const AK_STOP = \{([\s\S]*?)\n\};/.exec(ui);
    check("the renderer carries the stop words so the activity feed can name " +
          "the exit", !!block, null);
    const uiKeys = block
        ? [...block[1].matchAll(/"([a-z-]+)"\s*:/g)].map(m => m[1]) : [];
    const engineKeys = Object.keys(ak.STOP_WORDS);
    check("EVERY ENGINE STOP REASON HAS UI WORDS — a new exit that nobody " +
          "worded is an audit that ends in silence, which is the bug",
        engineKeys.every(k => uiKeys.includes(k)),
        engineKeys.filter(k => !uiKeys.includes(k)));
    check("...and the UI invents none the engine cannot produce",
        uiKeys.every(k => engineKeys.includes(k)),
        uiKeys.filter(k => !engineKeys.includes(k)));
    check("...and they say the SAME thing, word for word",
        engineKeys.every(k => new RegExp(
            `"${k}"\\s*:\\s*"${ak.STOP_WORDS[k].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`
        ).test(ui)),
        engineKeys.filter(k => !ui.includes(`"${k}": "${ak.STOP_WORDS[k]}"`)));
    check("the feed records the audit ENDING, not only its rounds — an exit " +
          "with nothing in the feed reads as 'it gave up'",
        /case "audit-done"/.test(ui) && /AK_STOP\[/.test(ui), null);
    check("...and records each interrogation while it runs, so a long " +
          "orchestrated audit is not a silent stretch",
        /ancient-knowledge/.test(ui) && /interrogating round/.test(ui), null);
}

console.log(`\n${pass}/${pass + fail} ancient-knowledge-orchestrated checks passed`);
process.exit(fail ? 1 : 0);
})();
