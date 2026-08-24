/**
 * THE SELF-AUDIT LOOP — the properties that make it a check rather than a
 * rubber stamp, each one exercised against the real module with a scripted
 * model standing in for the reviewers.
 *
 * What is pinned here:
 *   - reviewers are BLIND: no reviewer's prompt ever carries another's finding
 *   - nothing is voted away, and a lone finding is surfaced FIRST as contested
 *   - the loop TERMINATES: nothing-new, ceiling, budget, cancel — no path loops
 *   - concurrency follows the driver: width 1 is strictly one at a time
 *   - cost accumulates, is reported, and stops the loop at the budget
 *   - a broken reviewer never blocks work, and never counts as approval
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
// packaged mode reads process.resourcesPath (undefined under plain node);
// the repo root carries the same tools/ and knowledge/ layout, read-only
process.resourcesPath = path.join(__dirname, "..");
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-audit-"));
require.cache[__filename] = { exports: {
    // isPackaged: TRUE, deliberately — in dev mode paths.dataDir() resolves
    // to the REPO's shared data/ directory, so the ledger row this suite
    // bills for the audit's spend would land in the developer's own cost
    // ledger. Packaged mode routes through getPath, which is this run's
    // throwaway directory.
    app: { isPackaged: true, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}
setTimeout(() => {
    console.log(`\n${pass}/${pass + fail + 1} self-audit checks passed (TIMED OUT)`);
    process.exit(1);
}, 60000).unref();

const ROOT = path.join(__dirname, "..");
const audit = require(path.join(ROOT, ".lcl.engine", "core", "selfAudit.js"));
const router = require(path.join(ROOT, ".lcl.engine", "core", "router.js"));
const orchSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");
const auditSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "selfAudit.js"), "utf8");

/* ---- a scripted model. Every call is recorded, so the prompts themselves
 *      are evidence — that is how blindness is proven rather than asserted. */
const calls = [];
let inFlight = 0, maxInFlight = 0;
let reply = () => '{"findings": []}';
router.generate = async (messages, maxTokens, cancelToken) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const call = { system: messages[0].content, user: messages[1].content,
                   maxTokens, at: calls.length };
    calls.push(call);
    // a real await, so concurrent calls genuinely overlap in time
    await new Promise(r => setTimeout(r, 12));
    inFlight--;
    const out = reply(call);
    return typeof out === "string" ? { content: out } : out;
};
const resetCalls = () => { calls.length = 0; inFlight = 0; maxInFlight = 0; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-audit-ws-"));
const session = { id: "s1", title: "test", repoPath: WS };
fs.writeFileSync(path.join(WS, "index.html"),
    "<!doctype html><html><head><title>Walks</title></head><body><h1>Dog walking</h1>" +
    "<p>Book a walk for your dog in the city, seven days a week.</p></body></html>");
fs.writeFileSync(path.join(WS, "styles.css"), "body{font-family:system-ui;margin:0}");
const CHANGES = [{ path: "index.html", kind: "created" },
                 { path: "styles.css", kind: "created" }];
const GOAL = "build a website for a dog walking company";

const findingsJson = (arr) => JSON.stringify({ findings: arr });
// a phrase unique to each mandate's system prompt, so a scripted reply can
// tell which reviewer is asking without the reviewers knowing about each other
const REV_HINT = { intent: "ACTUALLY asked", correctness: "CORRECTNESS",
                   completeness: "COMPLETENESS", satisfaction: "RECIPIENT" };
const ISSUE_A = { file: "index.html", issue: "there is no contact page or booking form anywhere",
                  fix: "add contact.html with a booking form", severity: "high" };
const ISSUE_B = { file: "styles.css", issue: "no responsive rules at all, the layout breaks on a phone",
                  fix: "add a mobile breakpoint", severity: "medium" };

(async () => {
    /* ---------------------------------------------- the panel is plural */
    check("there are at least four reviewers, with distinct mandates",
        audit.REVIEWERS.length >= 4 &&
        new Set(audit.REVIEWERS.map(r => r.key)).size === audit.REVIEWERS.length,
        audit.REVIEWERS.map(r => r.key));
    check("the four questions asked are the four that were required: does it do " +
          "what was asked, is it correct, is it complete, would a person be satisfied",
        ["intent", "correctness", "completeness", "satisfaction"]
            .every(k => audit.REVIEWERS.some(r => r.key === k)),
        audit.REVIEWERS.map(r => r.key));

    /* ------------------------------------------------------- BLINDNESS */
    resetCalls();
    reply = (c) => /satisfaction|recipient/i.test(c.system)
        ? findingsJson([ISSUE_A]) : findingsJson([]);
    let r = await audit.reviewOnce(session, {
        goal: GOAL, artifacts: audit.readArtifacts(session, CHANGES), width: 1 });
    check("every reviewer is asked, once", calls.length === audit.REVIEWERS.length, calls.length);
    check("REVIEWERS ARE BLIND: no reviewer's prompt contains another reviewer's " +
          "finding, or any mention that other reviewers exist",
        calls.every(c => !/contact page or booking form/i.test(c.user)) &&
        calls.every(c => !/other reviewer|another reviewer|previous finding/i.test(c.system + c.user)),
        calls.map(c => c.user.slice(0, 60)));
    check("every reviewer sees the SAME request and artefacts (one frame, four questions)",
        new Set(calls.map(c => c.user)).size === 1);
    check("the artefacts a reviewer sees are the real file contents",
        calls[0].user.includes("Dog walking") && calls[0].user.includes("FILE index.html"));

    /* -------------------------------------- disagreement is the signal */
    check("a finding raised by ONE reviewer survives — nothing is voted away",
        r.findings.length === 1 && r.findings[0].issue === ISSUE_A.issue, r.findings);
    check("...and is flagged CONTESTED, because others reviewed the same work " +
          "and did not raise it",
        r.findings[0].contested === true, r.findings[0]);
    check("the clean sweep is recorded, so agreement can be reported as the weak " +
          "evidence it is",
        r.cleanSweep.length === audit.REVIEWERS.length - 1, r.cleanSweep);

    resetCalls();
    reply = () => findingsJson([ISSUE_A]);          // everyone raises the same thing
    r = await audit.reviewOnce(session, {
        goal: GOAL, artifacts: audit.readArtifacts(session, CHANGES), width: 1 });
    check("the same complaint from four reviewers is ONE finding, not four",
        r.findings.length === 1, r.findings.length);
    check("unanimous agreement is NOT marked contested",
        r.findings[0].contested === false && r.findings[0].raisedBy.length === 4, r.findings[0]);

    // ordering: contested first, then severity
    const merged = audit.mergeFindings([
        { key: "intent", parsed: true, findings: [{ ...ISSUE_B, severity: "high" }] },
        { key: "correctness", parsed: true, findings: [{ ...ISSUE_B, severity: "high" }] },
        { key: "completeness", parsed: true, findings: [{ ...ISSUE_A, severity: "low" }] },
        { key: "satisfaction", parsed: true, findings: [] }
    ]);
    check("a contested LOW finding outranks an agreed HIGH one in what gets " +
          "surfaced — disagreement is the signal, agreement is not",
        merged.findings[0].contested === true && merged.findings[0].severity === "low",
        merged.findings.map(f => [f.severity, f.contested]));

    /* ------------------------------------------- a broken reviewer is safe */
    resetCalls();
    reply = () => ({ error: "engine down" });
    r = await audit.reviewOnce(session, {
        goal: GOAL, artifacts: audit.readArtifacts(session, CHANGES), width: 1 });
    check("a panel that could not answer produces no findings — a broken reviewer " +
          "never blocks the work",
        r.findings.length === 0);
    check("...and is NOT counted as approval: a failed reviewer is absent from the " +
          "clean sweep, so silence can never be reported as agreement",
        r.cleanSweep.length === 0, r.cleanSweep);

    resetCalls();
    reply = () => "I think the site looks pretty good overall!";     // unparseable
    r = await audit.reviewOnce(session, {
        goal: GOAL, artifacts: audit.readArtifacts(session, CHANGES), width: 1 });
    check("prose instead of JSON is treated as no answer, not as approval",
        r.findings.length === 0 && r.cleanSweep.length === 0);

    /* -------------------------------------------------- CONCURRENCY RULE */
    resetCalls();
    reply = () => findingsJson([]);
    await audit.reviewOnce(session, { goal: GOAL,
        artifacts: audit.readArtifacts(session, CHANGES), width: 1 });
    check("LOCAL (width 1) reviews strictly ONE AT A TIME — a second resident " +
          "model is what takes the machine down",
        maxInFlight === 1, { maxInFlight });

    resetCalls();
    await audit.reviewOnce(session, { goal: GOAL,
        artifacts: audit.readArtifacts(session, CHANGES), width: 4 });
    check("a node or an API runs the panel WIDE — that is what the hardware is for",
        maxInFlight > 1, { maxInFlight });
    check("width is a ceiling, not a target: never more in flight than the driver allows",
        maxInFlight <= 4, { maxInFlight });

    /* ----------------------------------------------------- TERMINATION */
    // 1. clean first pass
    resetCalls();
    reply = () => findingsJson([]);
    let res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        repair: async () => [{ path: "index.html", kind: "modified" }] });
    check("a clean first pass stops immediately, with the reason recorded",
        res.rounds.length === 1 && res.stopped === "clean", res.stopped);
    check("a clean sweep is reported as WEAK EVIDENCE, in those words, never as proof",
        /weak evidence/i.test(res.summary), res.summary);

    // 2. nothing-new: same finding forever, repairs happen, loop still ends
    resetCalls();
    let repairs = 0;
    reply = () => findingsJson([ISSUE_A]);
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        repair: async () => { repairs++; return [{ path: "index.html", kind: "modified" }]; } });
    check("a finding that survives its repair does NOT loop forever — the second " +
          "round sees nothing NEW and stops",
        res.stopped === "nothing-new" && res.rounds.length === 2, { stopped: res.stopped, rounds: res.rounds.length });
    check("...having actually attempted the repair once", repairs === 1, { repairs });

    // 3. ceiling: a genuinely different finding every round would never end
    resetCalls();
    let n = 0;
    // one genuinely distinct complaint per reviewer per round, enough of them
    // that the ceiling — not the seen-set — is what ends the loop
    const SUBJECTS = ["booking", "pricing", "navigation", "photographs",
        "footer", "testimonials", "scheduling", "insurance", "coverage",
        "questions", "sitemap", "typography", "spacing", "contrast",
        "breakpoints", "metadata"];
    reply = () => findingsJson([{ file: "index.html", severity: "medium",
        issue: `the ${SUBJECTS[n++ % SUBJECTS.length]} area is unfinished`,
        fix: "finish it" }]);
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        repair: async () => [{ path: "index.html", kind: "modified" }] });
    check("an endless supply of genuinely NEW findings stops at the hard ceiling — " +
          "the loop is bounded even when the reviewers never run out",
        res.stopped === "ceiling" && res.rounds.length === audit.MAX_ROUNDS,
        { stopped: res.stopped, rounds: res.rounds.length, max: audit.MAX_ROUNDS });

    // ...and the counterpart: near-duplicates are NOT new work. A reviewer
    // re-raising the same complaint with a different number attached is the
    // most likely way a bounded loop becomes an unbounded one.
    resetCalls();
    n = 0;
    reply = () => findingsJson([{ file: "index.html", severity: "medium",
        issue: `issue number ${++n} about the very same missing contact page`, fix: "fix it" }]);
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        repair: async () => [{ path: "index.html", kind: "modified" }] });
    check("the same complaint reworded with a different number is not counted as " +
          "new work — it stops instead of chasing its own tail",
        res.stopped === "nothing-new", { stopped: res.stopped, rounds: res.rounds.length });

    // 4. a repair that changes nothing ends it rather than spinning
    resetCalls();
    n = 0;
    reply = () => findingsJson([ISSUE_A]);
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        repair: async () => [] });
    check("a repair that writes nothing ends the loop instead of re-reviewing an " +
          "unchanged file",
        res.stopped === "repair-made-no-change", res.stopped);

    // 5. cancellation
    resetCalls();
    reply = () => findingsJson([ISSUE_A]);
    const cancelToken = { cancelled: false };
    const running = audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        cancelToken, repair: async () => { cancelToken.cancelled = true; return [{ path: "index.html", kind: "modified" }]; } });
    res = await running;
    check("cancelling stops the loop and says so", res.stopped === "cancelled", res.stopped);

    // 6. no repair function: review, report, stop
    resetCalls();
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4 });
    check("with nothing able to repair, it reviews once and stops rather than " +
          "re-asking the same question",
        res.stopped === "no-repair" && res.rounds.length === 1, res.stopped);
    check("the findings still reach the caller so they can be shown to the operator",
        res.remaining.length === 1 && /contact page/.test(res.remaining[0].issue));

    /* ------------------------------------------------------------- COST */
    resetCalls();
    reply = () => ({ content: findingsJson([]), remote: true,
                     usage: { prompt_tokens: 1000, completion_tokens: 100 },
                     cost: { usd: 0.01 }, model: "test-model", endpoint: "test" });
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4 });
    check("cost is accumulated from the provider's own numbers",
        res.spend.priced === true && Math.abs(res.spend.usd - 0.04) < 1e-9, res.spend);
    check("...and tokens with it", res.spend.tokens === 4400, res.spend);
    check("cost is VISIBLE — the summary the operator reads states it",
        /\$0\.0400/.test(res.summary), res.summary);

    // budget stops the loop before it spends past the cap
    resetCalls();
    n = 0;
    reply = () => ({ content: findingsJson([{ file: "index.html", severity: "high",
        issue: `distinct problem ${++n}`, fix: "fix" }]),
        remote: true, usage: { prompt_tokens: 1000, completion_tokens: 100 },
        cost: { usd: 0.02 }, model: "test-model", endpoint: "test" });
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        budgetUsd: 0.05, repair: async () => [{ path: "index.html", kind: "modified" }] });
    check("the review stops at its BUDGET rather than spending without a limit",
        res.stopped === "budget", { stopped: res.stopped, usd: res.spend.usd });
    check("...and says so in the summary, so a short review is never mistaken for " +
          "a clean one",
        /budget/i.test(res.summary), res.summary);
    check("a local model costs nothing and is never reported as priced",
        (await (async () => {
            reply = () => findingsJson([]);
            return audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 1 });
        })()).spend.priced === false);

    /* --------------------------------------------------- REPAIR CONTENT */
    resetCalls();
    reply = () => findingsJson([ISSUE_A]);
    let repairText = "";
    await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        repair: async (findings) => {
            repairText = audit.repairInstruction(GOAL, findings);
            return [{ path: "index.html", kind: "modified" }];
        } });
    check("the repair instruction carries the actual finding and its suggested fix",
        /contact page or booking form/.test(repairText) && /add contact\.html/.test(repairText),
        repairText.slice(0, 200));
    check("the repair instruction carries the quality bar, so a fix cannot be a stub",
        repairText.includes("QUALITY BAR"));

    /* ============================================================
     * THE VERDICT MUST NEVER BE A LIE.
     *
     * Every check below was a REAL defect in the first cut of this loop,
     * found by an adversarial review of it. Each one made the audit report
     * something that had not happened — which is worse than having no audit,
     * because the report is the only part the operator reads.
     * ========================================================== */

    // a panel where every reviewer FAILED is not a clean panel
    resetCalls();
    reply = () => ({ error: "llama-server not running" });
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        repair: async () => [{ path: "index.html", kind: "modified" }] });
    check("a panel NOBODY answered is never reported as clean — silence is not " +
          "agreement (the engine being unloaded is the common local failure)",
        res.stopped === "review-unavailable", res.stopped);
    check("...and the summary says the work was NOT checked, in plain words",
        /NOT reviewed/.test(res.summary) && !/no objections/.test(res.summary), res.summary);

    resetCalls();
    reply = () => "I think it looks pretty good overall!";     // unparseable prose
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4 });
    check("four reviewers answering with prose is also 'not reviewed', not 'clean'",
        res.stopped === "review-unavailable", res.stopped);

    // a partly-heard panel says how many answered
    resetCalls();
    reply = (c) => /recipient/i.test(c.system) ? findingsJson([]) : { error: "down" };
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4 });
    check("a partly-answered panel reports the REAL number of reviewers heard " +
          "from, instead of always claiming four",
        /Reviewed by 1 of 4 independent reviewers/.test(res.summary) &&
        /3 could not be reached/.test(res.summary), res.summary);

    // cancelling mid-review is not a clean bill of health
    resetCalls();
    {
        const ct = { cancelled: false };
        let asked = 0;
        reply = () => { if (++asked === 2) ct.cancelled = true; return findingsJson([]); };
        res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 1,
            cancelToken: ct, repair: async () => [{ path: "index.html", kind: "modified" }] });
        check("a cancel landing mid-panel reports CANCELLED, not clean — the " +
              "cancel check sits above the no-findings branch",
            res.stopped === "cancelled", res.stopped);
    }

    // "fixed N" only when something actually changed
    resetCalls();
    reply = () => findingsJson([ISSUE_A]);
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        repair: async () => [] });
    check("a repair that wrote nothing is NOT reported as having fixed anything",
        res.repaired.length === 0 && !/fixed/.test(res.summary),
        { repaired: res.repaired.length, summary: res.summary });

    // findings beyond the per-round cap are not quietly retired
    resetCalls();
    {
        // each mandate contributes five DISTINCT findings (a reviewer's reply is
        // capped at five), so one round genuinely overflows the repair cap
        // twenty genuinely different complaints — deliberately sharing almost
        // no vocabulary, so nothing merges and the overflow is real
        const ISSUES = {
            intent: [
                "walk durations are never stated anywhere",
                "the neighbourhoods served are not named",
                "prices appear nowhere on the site",
                "opening hours are absent",
                "no way to book is offered"],
            correctness: [
                "the stylesheet link points at a filename that was never created",
                "two headings both claim to be the top-level title",
                "an anchor jumps to an identifier that does not exist",
                "the character encoding declaration comes after visible text",
                "a closing tag is mismatched near the footer"],
            completeness: [
                "customer testimonials are promised in the navigation but absent",
                "photographs of the handlers were never added",
                "the cancellation policy is referenced yet unwritten",
                "a careers link leads nowhere",
                "frequently asked questions were skipped entirely"],
            satisfaction: [
                "body copy sits at nine pixels, too small to read comfortably",
                "grey lettering on a pale background fails contrast",
                "everything is crammed against the left edge with no breathing room",
                "stock imagery contradicts the friendly tone of the writing",
                "the wording reads like an internal memo rather than an invitation"]
        };
        reply = (c) => {
            const key = Object.keys(ISSUES).find(k =>
                c.system.includes(REV_HINT[k])) || "intent";
            return findingsJson(ISSUES[key].map(issue => ({
                file: "index.html", severity: "medium", issue, fix: "address it" })));
        };
        res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
            repair: async () => [{ path: "index.html", kind: "modified" }] });
        const fixedIssues = new Set(res.repaired.map(r => r.issue));
        check("findings past the per-round repair cap are carried into the NEXT " +
              "round instead of being marked seen and silently retired",
            res.rounds.length > 1 && fixedIssues.size > audit.MAX_REPAIRS_PER_ROUND,
            { rounds: res.rounds.length, fixed: fixedIssues.size,
              perRound: res.rounds.map(r => r.fresh) });
    }

    // the same complaint in different words is ONE finding, not two contested ones
    {
        const m = audit.mergeFindings([
            { key: "intent", parsed: true, findings: [{ file: "index.html",
                issue: "there is no contact page anywhere on the site", severity: "high" }] },
            { key: "completeness", parsed: true, findings: [{ file: "index.html",
                issue: "the site has no contact page for visitors", severity: "medium" }] },
            { key: "correctness", parsed: true, findings: [] },
            { key: "satisfaction", parsed: true, findings: [] }
        ]);
        check("two reviewers describing the same problem in DIFFERENT WORDS merge " +
              "into one agreed finding — otherwise 'contested' fires on everything " +
              "and the signal is worthless",
            m.findings.length === 1 && m.findings[0].raisedBy.length === 2 &&
            m.findings[0].contested === false, m.findings);
        const d = audit.mergeFindings([
            { key: "intent", parsed: true, findings: [{ file: "index.html",
                issue: "there is no contact page anywhere on the site", severity: "high" }] },
            { key: "correctness", parsed: true, findings: [{ file: "index.html",
                issue: "the stylesheet link points at a file that does not exist", severity: "high" }] },
            { key: "completeness", parsed: true, findings: [] },
            { key: "satisfaction", parsed: true, findings: [] }
        ]);
        check("...while genuinely different problems stay separate and contested",
            d.findings.length === 2 && d.findings.every(f => f.contested === true),
            d.findings.map(f => [f.issue.slice(0, 24), f.contested]));
    }

    // the repair's own cost counts
    resetCalls();
    reply = () => ({ content: findingsJson([ISSUE_A]), remote: true,
                     usage: { prompt_tokens: 100, completion_tokens: 10 },
                     cost: { usd: 0.001 }, model: "m", endpoint: "e" });
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        repair: async () => ({ changes: [{ path: "index.html", kind: "modified" }],
                               costUsd: 0.05 }) });
    check("the REPAIR's tokens are part of the review's cost — a total that " +
          "leaves them out is smaller than the truth",
        res.spend.usd >= 0.05, res.spend);

    // a binary flood cannot push the text out of the reviewers' prompt
    {
        const many = Array.from({ length: 20 }, (_, i) => ({ path: `img${i}.png`, kind: "created" }));
        const arts = audit.readArtifacts(session, [...many, ...CHANGES]);
        check("binaries count against the artefact cap, so a run that generated " +
              "twenty images cannot leave reviewers with no text to read",
            arts.length <= 8, arts.length);
    }

    /* ------------------------------- a staged action is never dropped */
    resetCalls();
    reply = () => findingsJson([ISSUE_A]);
    res = await audit.runAudit(session, { goal: GOAL, changes: CHANGES, width: 4,
        repair: async () => ({ changes: [{ path: "index.html", kind: "modified" }],
                               pendingApprovals: [{ id: "appr-1", kind: "tool",
                                                    tool: "delete_file" }],
                               newMessages: [{ role: "tool", name: "delete_file",
                                   content: "Shown for approval. It has NOT run.",
                                   proposal: { id: "appr-1", kind: "tool",
                                               tool: "delete_file" } }] }) });
    check("an action a REPAIR staged reaches the caller — a confirm-class card " +
          "built inside the audit must not be silently discarded",
        (res.pendingApprovals || []).length === 1 &&
        res.pendingApprovals[0].id === "appr-1", res.pendingApprovals);
    check("...and the PROPOSAL MESSAGE that draws the card rides out too — the " +
          "id alone fires the tray toast but never renders a card in chat",
        (res.stagedMessages || []).length === 1 &&
        res.stagedMessages[0].proposal && res.stagedMessages[0].proposal.id === "appr-1",
        res.stagedMessages);
    check("all three wiring paths carry staged approvals AND their messages onward",
        /for \(const p of audit\.pendingApprovals \|\| \[\]\) if \(p && p\.id\) stagedApprovals\.set/.test(orchSrc) &&
        /for \(const m of audit\.stagedMessages \|\| \[\]\)/.test(orchSrc) &&
        /result\.pendingApprovals = \[\.\.\.\(result\.pendingApprovals \|\| \[\]\),/.test(mainSrc));

    /* ------------------------------------------------------- ARTEFACTS */
    fs.writeFileSync(path.join(WS, "hero.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
    const arts = audit.readArtifacts(session, [...CHANGES, { path: "hero.png", kind: "created" }]);
    check("a binary is listed but never decoded as text for a reviewer",
        arts.some(a => a.path === "hero.png" && a.binary === true && a.text === ""), arts.map(a => a.path));
    check("a deleted file is not read back as an artefact",
        audit.readArtifacts(session, [{ path: "gone.html", kind: "deleted" }]).length === 0);

    /* -------------------------------------- one mechanism, not two */
    check("the per-step gate and the finished-work panel live in ONE module — " +
          "orchestrator re-exports the gate rather than keeping a second copy",
        typeof audit.critiqueStep === "function" && typeof audit.expectsFile === "function" &&
        /const \{ critiqueStep, expectsFile, QUALITY_BRIEF \} = selfAudit;/.test(orchSrc) &&
        !/^async function critiqueStep/m.test(orchSrc));
    check("the orchestrator runs the audit after its plan, at the SAME width its " +
          "steps used — one concurrency decision, not two — but SKIPS it when the " +
          "plan paused for an approval (an incomplete tree must not be audited)",
        /const audit = \(reviewOn && stagedApprovals\.size === 0\) \? await runAuditPass\(session, \{[\s\S]{0,200}width,/.test(orchSrc));
    check("THE AUDIT IS NOT LOCAL-ONLY: the ordinary agent turn (the path a node " +
          "or an API takes) runs the same pass",
        /orchestrator\.runAuditPass\(s, \{/.test(mainSrc) &&
        // ...on THIS session's model, and at the width that model allows — a
        // panel sized from the app default would fire four concurrent
        // generations at one resident local model
        /width: orchestrator\.stepConcurrency\(drive\.sel\)/.test(mainSrc) &&
        /selection: drive\.sel,/.test(mainSrc));
    check("a review that throws never takes the work down with it",
        /catch \(err\) \{[\s\S]{0,320}stopped: "error"/.test(orchSrc) &&
        /Review did not run/.test(orchSrc));

    /* --------------------------------------------- visible while it runs */
    check("the audit has its OWN progress phase, labelled for a person",
        /"audit": "reviewing its own work"/.test(appSrc) &&
        /phase: "audit"/.test(auditSrc));
    check("each reviewer gets its own task row, so the wait says which question " +
          "is being asked",
        /id: `\$\{auditId\}-\$\{r\.key\}`/.test(auditSrc) &&
        /title: `Review: \$\{r\.label\}`/.test(auditSrc));
    check("what the review found is kept in the durable activity feed, not only " +
          "in a live bubble that dies with the turn",
        /case "audit":/.test(appSrc) && /review round/.test(appSrc));
    check("the verdict rides on the transcript message itself",
        /audit: audit\.ran \?/.test(orchSrc) && /meta: \{ model: "self-audit"/.test(mainSrc));
    check("the audit chip is styled in the existing token system",
        /\.msg-audit \{/.test(cssSrc) && /var\(--fs-tiny\)/.test(
            cssSrc.slice(cssSrc.indexOf(".msg-audit {"), cssSrc.indexOf(".msg-audit {") + 400)) &&
        /\.msg-audit\.open \{/.test(cssSrc) && /\.act-row\.warn \.act-text/.test(cssSrc));

    /* ------------------------------------------------- the quality bar */
    check("the quality bar forbids the literal-minimum result by name",
        /lorem ipsum/i.test(audit.QUALITY_BRIEF) && /placeholder/i.test(audit.QUALITY_BRIEF));
    check("the SAME bar governs producing and judging — the planner, every step, " +
          "and the reviewer that asks whether a person would be satisfied",
        /QUALITY_BRIEF/.test(orchSrc) &&
        audit.REVIEWERS.find(r => r.key === "satisfaction").system.includes("QUALITY BAR"));
    /* ---- A MODE, NOT A HABIT ----
     * "i never said that i deliberately wanted agents. i want local to have the
     *  capacity to do so, and audit its own work. we can make this a function,
     *  or mode of operation that can be invoked when needed."
     */
    {
        const sp = require(path.join(ROOT, ".lcl.engine", "core", "sessionPerms.js"));
        check("self-review is OFF unless it is asked for — a plain conversation " +
              "does not pay for four reviewers",
            sp.selfReviewOn({}, false) === false &&
            sp.selfReviewOn({ perms: {} }, false) === false);
        check("a session can turn it on for itself",
            sp.selfReviewOn({ perms: { selfReview: true } }, false) === true);
        check("a session can turn it OFF even when the app default is on — " +
              "'off for this conversation' is a different answer from 'follow " +
              "the default'",
            sp.selfReviewOn({ perms: { selfReview: false } }, true) === false &&
            sp.selfReviewOn({ perms: {} }, true) === true);
        check("the switch is FOLDED INTO ANCIENT KNOWLEDGE — no separate catalog " +
              "item; enabling AK is enabling the review, and stored per-session " +
              "values still work underneath",
            !sp.CATALOG.some(c => c.key === "selfReview") &&
            sp.selfReviewOn({ ancientKnowledge: true }, false) === true);
        check("both drivers gate on it — the planned path and the ordinary turn",
            /const reviewOn = sessionPerms\.selfReviewOn\(/.test(mainSrc) &&
            /if \(reviewOn && result && result\.ok/.test(mainSrc) &&
            /const audit = \(reviewOn && stagedApprovals\.size === 0\) \? await runAuditPass\(session, \{/.test(orchSrc));
        // (the handler reads settings ONCE into `settingsNow` now — it also
        // repaints the composer's permission chip, so it runs on every header
        // repaint, not only when the sheet opens)
        check("and the panel says what it costs and what the app default is",
            /appSelfReview: settingsNow\.selfReview === true/.test(mainSrc) &&
            /item\.key === "selfReview"/.test(appSrc));
    }

    /* ---- the wiring the review found broken ---- */
    check("the agent path does NOT review a turn that asked a question or staged " +
          "an action — the operator's answer is what should happen next, and a " +
          "repair would act on a decision they have not made",
        /const asked = \(result && \(result\.newMessages \|\| \[\]\)/.test(mainSrc) &&
        /!asked && !stagedHere/.test(mainSrc));
    check("only the REPAIRS' changes are appended to the session — the turn's own " +
          "changes were already recorded, and appending the merged list put every " +
          "file in twice",
        /audit\.repairChanges/.test(mainSrc) &&
        !/\.\.\.\(audit\.changes \|\| \[\]\)\]\.slice\(-200\)/.test(mainSrc));
    check("a repair sub-turn's question never reaches the operator as a question " +
          "they must answer",
        /p === "clarify" \|\| p === "needs-approval"/.test(auditSrc));
    check("the audit's spend is attributable in the ledger AND readable in the " +
          "spend view — recorded and relabelled, not recorded and hidden",
        /ledgerVia: "self-audit"/.test(auditSrc) &&
        // \s* — the fallback chain sits on the line below opts.ledgerVia now;
        // the claim is the override exists, not how the line is wrapped
        /via: opts\.ledgerVia\s*\|\|/.test(
            fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8")) &&
        /r\.via === "self-audit" \? "self-review"/.test(appSrc));
    check("a task row never says 'Review complete' for a review that could not run",
        /title: failed \? "Review could not run"/.test(auditSrc));

    check("nothing in the audit's own text names anything outside this product",
        !(()=>{try{return require("./no-bleed.js").BLEED}catch{return[]}})().some(rx => rx.test(auditSrc)), "");

    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} self-audit checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(1); });
