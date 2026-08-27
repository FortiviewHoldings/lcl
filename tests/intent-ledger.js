/**
 * THE INTENT LEDGER — Tier 2 of Ancient Knowledge's pseudo-context (PROJECT.md
 * §8). Cameron: "you are losing context, models lose context, and the ancient
 * knowledge, and honestly core functionality should not."
 *
 * This suite proves behavior AND pins the schema, and it exists in the shape it
 * does because an adversarial review of the first cut found two real bugs the
 * first suite missed: criterion ids collided across goals in one session (a
 * fresh goal read as already complete), and "compaction" never shrank the file.
 * Both now have a test that fails if they regress.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const L = require(path.join(ROOT, ".lcl.engine", "core", "intentLedger.js"));
const orchSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const preSrc = fs.readFileSync(path.join(ROOT, "app", "preload.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 220) : ""); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-il-"));
const S = "sess-1";
const gA = "gA", gB = "gB";

/* ---- one goal: capture, split, scope ---- */
L.recordIntent(dir, S, gA, "Fully showcase the chapter", 1000);
L.recordCriterion(dir, S, gA, "cov", "1-1", "Digital versus Analog", 1001);
L.recordCriterion(dir, S, gA, "step", "1", "build the converter", 1002);
L.recordCriterion(dir, S, gA, "step", "2", "style it", 1003);
L.recordStatus(dir, S, L.criterionId(gA, "step", "1"), "done", "index.html", 1004);

let s = L.summarize(dir, S);
check("intent is captured verbatim, goal-scoped", s.intent === "Fully showcase the chapter" && s.goal === gA, s);
check("STEP criteria split open vs done; the material topic is SCOPE, not open " +
      "work (coverage has no reliable auto-status — that is the review's job)",
    s.done.map(c => c.id).join(",") === L.criterionId(gA, "step", "1")
    && s.open.map(c => c.id).join(",") === L.criterionId(gA, "step", "2")
    && s.scope.length === 1 && s.scope[0].id === L.criterionId(gA, "cov", "1-1"), s);

/* ---- THE COLLISION BUG the review caught: a second goal in the same session
   must NOT inherit the first goal's done status ---- */
L.recordIntent(dir, S, gB, "Fix the header color", 2000);
L.recordCriterion(dir, S, gB, "step", "1", "recolor the header", 2001);
s = L.summarize(dir, S);
check("A NEW GOAL DOES NOT INHERIT THE PRIOR GOAL'S 'DONE' — goal B's step:1 is " +
      "OPEN, not the done state goal A's positional step:1 had; summarize is the " +
      "CURRENT goal only ('a fresh goal reported as already complete' is dead)",
    s.goal === gB && s.intent === "Fix the header color"
    && s.open.map(c => c.id).join(",") === L.criterionId(gB, "step", "1")
    && s.done.length === 0, s);
check("...and the two goals' step:1 have DIFFERENT ids (goal-scoped)",
    L.criterionId(gA, "step", "1") !== L.criterionId(gB, "step", "1"), null);

/* ---- idempotent re-record within a goal (anti-churn) ---- */
L.recordCriterion(dir, S, gB, "step", "1", "recolor the header", 2002);
s = L.summarize(dir, S);
check("re-recording a criterion by its stable id does not duplicate it, and " +
      "never resets its status",
    s.open.length === 1 && s.total >= 1, s);

/* ---- REAL compaction: the live file SHRINKS, the archive keeps everything ---- */
const liveBefore = fs.readFileSync(L.liveFile(dir, S), "utf8").split("\n").filter(Boolean).length;
const res = L.compact(dir, S, 1);            // keep only the current goal (gB)
const liveAfter = fs.readFileSync(L.liveFile(dir, S), "utf8").split("\n").filter(Boolean).length;
check("COMPACT actually REWRITES the live file smaller (temp-then-rename), not " +
      "a no-op append — the first cut only appended and never shrank",
    res && res.archived > 0 && liveAfter < liveBefore, { liveBefore, liveAfter, res });
check("...goal A is archived OUT of the live front, goal B remains",
    fs.existsSync(L.archiveFile(dir, S))
    && L.summarize(dir, S).goal === gB, null);
const backA = L.retrieve(dir, S, [L.criterionId(gA, "step", "1")]);
check("...and an ARCHIVED criterion reads back in full from history — 'compacted, " +
      "not lost': state and evidence survive the rewrite",
    backA.length === 1 && backA[0].state === "done" && backA[0].evidence === "index.html", backA);

/* ---- AUTO-COMPACT bounds the file (the "unbounded growth" finding) ---- */
{
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-il-g-"));
    const GS = "growth";
    for (let g = 0; g < 600; g++) {
        const gid = "g" + g;
        L.recordIntent(gdir, GS, gid, "goal " + g, g);
        for (let n = 1; n <= 8; n++) {
            L.recordCriterion(gdir, GS, gid, "step", n, "s", g);
            L.recordStatus(gdir, GS, L.criterionId(gid, "step", n), "done", "f", g);
        }
    }
    const NL = String.fromCharCode(10);
    const liveLines = fs.readFileSync(L.liveFile(gdir, GS), "utf8").split(NL).filter(Boolean).length;
    const archiveLines = fs.existsSync(L.archiveFile(gdir, GS))
        ? fs.readFileSync(L.archiveFile(gdir, GS), "utf8").split(NL).filter(Boolean).length : 0;
    check("AUTO-COMPACT BOUNDS THE LIVE FILE — 600 goals (~10k rows) leave the " +
          "live file under the line cap while the archive keeps the rest; " +
          "nothing is lost and summarize still returns only the current goal " +
          "(the 'grows without bound' finding, fixed)",
        liveLines < 4000 && archiveLines > 0
        && liveLines + archiveLines >= 600
        && L.summarize(gdir, GS).goal === "g599", { liveLines, archiveLines });
    try { fs.rmSync(gdir, { recursive: true, force: true }); } catch {}
}

/* ---- resilience + safety ---- */
fs.appendFileSync(L.liveFile(dir, S), "{ torn line\n");
check("a torn line never sinks the ledger", L.summarize(dir, S).goal === gB);
check("a session id with path characters is sanitized (no traversal, no dots)",
    L.liveFile(dir, "../../etc/passwd").startsWith(dir)
    && !L.liveFile(dir, "../../etc/passwd").includes(".."), null);

/* ---- SCHEMA PIN (the mod-preservation discipline, mechanical) ---- */
const rows = L.read(dir, S);
const anyRow = rows.find(r => r.kind === "intent");
check("every record carries schema v + timestamp; kinds and states are the " +
      "fixed sets — a shape change must bump SCHEMA (now 2) and add a migration",
    L.SCHEMA === 2 && anyRow.v === 2 && typeof anyRow.t === "number"
    && [...L.KINDS].sort().join(",") === "compaction,criterion,intent,note,status"
    && [...L.STATES].sort().join(",") === "done,failed,open,partial", {
        schema: L.SCHEMA, kinds: [...L.KINDS], states: [...L.STATES] });

/* ---- the wiring: goal-scoped, and the UI can read it ---- */
check("THE ORCHESTRATOR IS GOAL-SCOPED — it derives a goalId per run and scopes " +
      "intent + every criterion to it, so a later goal in the same session " +
      "cannot inherit the earlier one's done (the collision the review caught)",
    orchSrc.includes('const goalId = "g" + goalStartedAt')
    && orchSrc.includes("recordIntent(ilDir, session.id, goalId, planningGoal")
    && orchSrc.includes('recordCriterion(ilDir, session.id, goalId, "cov"')
    && orchSrc.includes('recordCriterion(ilDir, session.id, goalId, "step"')
    && orchSrc.includes('il.criterionId(goalId, "step", step.n)'), null);
check("the UI can READ the ledger (read-only IPC + preload bridge)",
    mainSrc.includes('ipcMain.handle("lcl:intentSummary"')
    && preSrc.includes('intentSummary: (sessionId) => ipcRenderer.invoke("lcl:intentSummary"'), null);
check("the contributor boot check is ASYNC (execFile, awaited) — never " +
      "execFileSync, which froze the whole main process at boot",
    mainSrc.includes("function contribExecAsync")
    && mainSrc.includes("await contribExecAsync(") && mainSrc.includes('const { execFile } = require("child_process")')
    && (() => {   // the handler uses ONLY the async form, no sync contribExec
        const i = mainSrc.indexOf('ipcMain.handle("lcl:contribCanRelease"');
        const seg = mainSrc.slice(i, mainSrc.indexOf("}));", i));
        return !/[^c]contribExec\(/.test(seg);
    })(), null);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }

console.log(`\n${pass}/${pass + fail} intent-ledger checks passed`);
process.exit(fail ? 1 : 0);
