/**
 * THE LOOP, END TO END, THROUGH THE REAL MACHINERY.
 *
 * The unit suite (self-audit.js) pins the loop's properties in isolation. This
 * one proves the whole thing actually works when wired together: the real
 * orchestrator plans, the REAL agent tool loop writes files through the REAL
 * write guard and backup layer, the panel reviews what is genuinely on disk,
 * the repair is an ordinary agent turn, and the re-check reads the repaired
 * file rather than the promise of one.
 *
 * Only the MODEL is scripted — it produces a deliberately thin page first, and
 * a real one when told what was wrong. Everything between is the product.
 *
 * The measurement that matters: the bytes on disk before and after.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-e2e-"));
require.cache[__filename] = { exports: {
    // isPackaged: TRUE, deliberately — in dev mode paths.dataDir() resolves
    // to the REPO's shared data/ directory, so this suite's settings writes
    // and write-guard backups would land in the developer's own store.
    // Packaged mode routes through getPath, which is this run's throwaway
    // directory.
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}
setTimeout(() => {
    console.log(`\n${pass}/${pass + fail + 1} self-audit-e2e checks passed (TIMED OUT)`);
    process.exit(1);
}, 90000).unref();

const ROOT = path.join(__dirname, "..");
const router = require(path.join(ROOT, ".lcl.engine", "core", "router.js"));
const orch = require(path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"));
const agent = require(path.join(ROOT, ".lcl.engine", "core", "agent.js"));

// A thin page: real markup, real words, nothing a deterministic gate can
// object to — and plainly not what "build a website for a company" means.
const THIN = "<!doctype html><html><head><title>Walks</title></head><body>" +
    "<h1>Dog Walking</h1><p>We walk dogs.</p></body></html>";
// What the same request looks like answered properly.
const FULL = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>City Dog Walking</title><link rel=\"stylesheet\" href=\"styles.css\"></head>" +
    "<body><header><nav><a href=\"index.html\">Home</a> <a href=\"contact.html\">Contact</a>" +
    "</nav></header><main><h1>City Dog Walking</h1><p>Daily walks, trained handlers, " +
    "and a photo after every outing.</p><section><h2>Services</h2><p>Group walks, solo " +
    "walks, and puppy visits, booked by the week.</p></section></main>" +
    "<footer><p>Open seven days.</p></footer></body></html>";

const FINDING = {
    file: "index.html",
    issue: "the page has no navigation and no contact route at all",
    fix: "add a nav with a contact link and real service copy",
    severity: "high"
};

const tasks = [], phases = [];
let reviewerCalls = 0, repairTurns = 0;

router.generate = async (messages) => {
    const sys = String(messages[0].content || "");
    // the CONVERSATION only — the system prompt itself talks about tool
    // results at length, and matching against it made the stub answer "Done."
    // before it had written anything at all
    const convo = messages.filter(m => m.role !== "system");
    const all = convo.map(m => String(m.content || "")).join("\n");

    if (/You are the planner/.test(sys)) {
        return { content: JSON.stringify({ steps: [
            { title: "Landing page", action: "Write index.html: the landing page", after: [] }
        ] }) };
    }
    if (/You verify ONE step/.test(sys)) return { content: "PASS" };

    // the review panel — recognises its own fix, the way a real reviewer
    // reading the repaired file would
    if (/"findings"/.test(sys)) {
        reviewerCalls++;
        const artefactIsFixed = /<nav>/.test(all) && /contact\.html/.test(all);
        if (!artefactIsFixed && /recipient/i.test(sys)) {
            return { content: JSON.stringify({ findings: [FINDING] }) };
        }
        return { content: JSON.stringify({ findings: [] }) };
    }

    // The agent tool loop: a model writes ONCE per turn, then answers.
    // Tool results reach a serving with no tool role as USER turns under the
    // runtime's own heading, not as role "tool" — buildModelMessages rewrites
    // them because some chat templates have no tool role. A stub that watches
    // for role "tool" never sees its own write land and rewrites the file
    // until the step limit, which is how this test first read five repairs
    // where one had happened.
    //
    // IT READS THE RUNTIME'S CONSTANT, NOT A COPY OF IT. Spelling the
    // heading out here is what broke this suite when the heading changed:
    // the stub went blind and the five-repair storm came straight back.
    if (all.includes(agent.TOOL_RESULT_HEADING)) return { content: "Done." };
    const isRepair = /A review of the work you just produced found these problems/.test(all);
    if (isRepair) repairTurns++;
    return { content: "```tool\n" + JSON.stringify({ tool: "write_file",
        args: { path: "index.html" } }) + "\n```\n```content\n" +
        (isRepair ? FULL : THIN) + "\n```" };
};

(async () => {
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-e2e-ws-"));
    // THE REVIEW IS A MODE, SO THIS SESSION ASKS FOR IT. That is the whole
    // point of the change: a conversation opts in for work that earns it,
    // rather than every turn paying for four reviewers.
    const session = { id: "s1", title: "t", repoPath: WS, messages: [], changes: [],
                      perms: { selfReview: true } };

    const res = await orch.runGoal(session, "build a website for a dog walking company", {
        onTask: (t) => tasks.push(t),
        onProgress: (p) => { if (String(p.phase || "").startsWith("audit")) phases.push(p); }
    });

    check("the goal ran to completion", res && res.ok === true, res && res.error);

    /* ---- THE MEASUREMENT: what is actually on disk ---- */
    const finalHtml = fs.readFileSync(path.join(WS, "index.html"), "utf8");
    check("the first thing written WAS the thin page — the deficiency was real, " +
          "not staged after the fact",
        THIN.length === 114 && finalHtml.length > THIN.length,
        { thin: THIN.length, final: finalHtml.length });
    check("the file on disk was repaired by the audit: it now carries the " +
          "navigation and the contact route the review demanded",
        /<nav>/.test(finalHtml) && /contact\.html/.test(finalHtml),
        finalHtml.slice(0, 120));
    check("...and the repair went through the REAL write path — the guard that " +
          "rejects placeholders accepted this page",
        finalHtml.includes("<section>") && finalHtml.length > 400, finalHtml.length);
    check("exactly one repair turn ran — a bounded loop, not a rewrite storm",
        repairTurns === 1, { repairTurns });

    /* ---- the loop closed rather than being cut off ---- */
    const meta = (res.newMessages[res.newMessages.length - 1] || {}).meta || {};
    check("the audit reports on the transcript message itself", !!meta.audit, meta);
    check("it ran two rounds: find, fix, re-check",
        meta.audit.rounds === 2, meta.audit);
    check("the re-check came back CLEAN — the loop closed on the work being " +
          "fixed, not on a ceiling or a budget",
        meta.audit.stopped === "nothing-new" && meta.audit.open === 0, meta.audit);
    check("and it says what it fixed", meta.audit.repaired === 1, meta.audit);

    const summary = (res.newMessages[res.newMessages.length - 1] || {}).content || "";
    check("the operator is told, in the same message as 'done', that the work " +
          "was reviewed and what changed",
        /Reviewed by 4 independent reviewers/.test(summary) && /fixed 1 issue/.test(summary),
        summary);
    check("nothing is left claimed as open once it was actually fixed",
        !/Still open after review/.test(summary), summary);

    /* ---- every reviewer really ran, on the real artefacts ---- */
    check("all four mandates were asked in both rounds",
        reviewerCalls === 8, { reviewerCalls });

    /* ---- the operator could watch it happen ---- */
    const auditTasks = tasks.filter(t => /Review/.test(t.title || ""));
    check("the audit surfaced its own task rows, one per mandate",
        new Set(auditTasks.map(t => t.title)).size >= 5, [...new Set(auditTasks.map(t => t.title))]);
    check("the review phase reached the progress feed",
        phases.some(p => p.phase === "audit") && phases.some(p => p.phase === "audit-reviewer"),
        phases.length);
    check("the repair was announced as its own state, not hidden inside 'writing'",
        phases.some(p => p.detail && p.detail.status === "repairing"));

    /* ---- and the changed file is still tracked for revert ---- */
    check("the repaired file stays in the turn's change list, so revert still " +
          "covers everything the turn touched",
        (res.changes || []).some(c => c.path === "index.html"), res.changes);

    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} self-audit-e2e checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(1); });
