/**
 * COVERAGE CONTRACTS — what "fully" means, stated before the build.
 *
 * The operator, comparing .lcl's build of a chapter against a frontier
 * model's: "i need .lcl, to be closer to what you produced". The forensics
 * found the deepest cause last: the plan never encoded what "fully" meant, so
 * a 13-section chapter became three vague steps and nothing in the run could
 * notice that ten sections were missing.
 *
 * This suite pins the contract — and pins the ABSENCE of a deterministic
 * coverage score, because three of them were built, measured against the two
 * real builds, and every one misled (one ranked the WORSE build higher). The
 * measurements live in coverage.js; the refusal to ship a number is a feature
 * and must not be quietly "fixed" by a future pass.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const coverage = require(path.join(ROOT, ".lcl.engine", "core", "coverage.js"));
const orchSrc = fs.readFileSync(
    path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"), "utf8");
const covSrc = fs.readFileSync(
    path.join(ROOT, ".lcl.engine", "core", "coverage.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 220) : ""); }
}

/* ---- a sidecar shaped like a REAL extraction: running headers glued to body
   lines, OCR litter, numbered exercises and prose cross-references that must
   NOT be mistaken for headings ---- */
function makeSidecar(dir) {
    const ex = path.join(dir, "Chapter 1.extract");
    fs.mkdirSync(path.join(ex, "text"), { recursive: true });
    const lines = [
        "--- page 1 (OCR) ---",
        "1-1 Digital versus Analog i <<",
        "some body text about signals",
        "1-2 Digital Representations of Analog Quantities",
        "--- page 2 (OCR) ---",
        "more body text 1-3 Decimal Numbering System (Base 10)",
        "text continues 1-4 Binary Numbering System (Base 2)",
        "1-4. An automobile speedometer display is (digital, analog)?",
        "Figure 1-4 compares numbers written in the five number systems",
        "--- page 3 (OCR) ---",
        "1-10 Binary-Coded-Decimal System opm",
        "1-12 The ASCII Code",
        "1-13 Applications of the Numbering Systems"
    ];
    fs.writeFileSync(path.join(ex, "text", "full.txt"), lines.join("\n"));
    fs.writeFileSync(path.join(ex, "meta.json"), JSON.stringify(
        { file: "Chapter 1.pdf", pages: 3, outline: null, perPage: [] }));
    return ex;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-cov-"));
makeSidecar(dir);

/* ================= THE CHECKLIST ================= */
const cl = coverage.checklistFor(dir);
check("a workspace holding extracted material yields its own topic checklist",
    !!cl && cl.items.length >= 6, cl && cl.items.length);

check("HEADINGS ARE FOUND MID-LINE, not just at line start — OCR glues running " +
      "headers onto body lines, and a ^-anchored pattern found 7 of the real " +
      "chapter's 13 sections (ASCII and Applications, two topics the original " +
      "build actually missed, were invisible to the checklist meant to catch them)",
    !!cl && ["1-3", "1-4", "1-12", "1-13"].every(id => cl.items.some(i => i.id === id)),
    cl && cl.items.map(i => i.id));

check("...and a numbered EXERCISE or a prose CROSS-REFERENCE is never mistaken " +
      "for a heading ('1-4. An automobile…', 'Figure 1-4 compares…')",
    !!cl && cl.items.filter(i => i.id === "1-4").length === 1
    && !/automobile|compares/i.test(JSON.stringify(cl.items)), cl && cl.items);

check("OCR litter is trimmed off a heading ('… Analog i <<', '… System opm')",
    !!cl && cl.items.some(i => i.title === "Digital versus Analog")
    && cl.items.some(i => i.title === "Binary-Coded-Decimal System"),
    cl && cl.items.map(i => i.title));

check("the repeated running header collapses to ONE topic per section number",
    !!cl && new Set(cl.items.map(i => i.id)).size === cl.items.length);

check("a workspace with no extracted material has no contract (null, not empty)",
    coverage.checklistFor(fs.mkdtempSync(path.join(os.tmpdir(), "lcl-cov-bare-"))) === null);

/* ================= TERMS: PHRASES, NEVER LONE GENERIC WORDS ============ */
{
    const t = coverage.termsFor("Binary-Coded-Decimal System");
    check("a hyphenated compound keeps itself AND yields its initialism (BCD)",
        t.includes("binary-coded-decimal") && t.includes("bcd"), t);
    const t2 = coverage.termsFor("Octal Numbering System (Base 8)");
    check("...and a plain title yields adjacent PAIRS, never lone words — one " +
          "base converter's vocabulary would otherwise satisfy every heading " +
          "in a numbering-systems chapter (measured: 13/13 for the weak build)",
        t2.includes("octal numbering") && !t2.includes("octal") && !t2.includes("numbering"), t2);
}

/* ================= THE REFUSAL TO SCORE ================= */
check("THERE IS NO DETERMINISTIC COVERAGE SCORE, and the module says why — " +
      "three were measured against the two real builds and all three misled, " +
      "one ranking the WORSE build higher; the next person reaching for a " +
      "grep-scored number gets the measurements instead of the temptation",
    /WHY THERE IS NO DETERMINISTIC COVERAGE SCORE/.test(covSrc)
    && /ranked the worse artifact HIGHER|ranking the WORSE build higher/i.test(covSrc)
    && typeof coverage.score === "undefined"
    && typeof coverage.summarise === "undefined", {
        score: typeof coverage.score, summarise: typeof coverage.summarise });

check("...the one-directional hint that survives is named for what it proves " +
      "(namedNowhere) and reports 'named'/'absent', never 'covered'",
    typeof coverage.namedNowhere === "function"
    && (() => {
        const r = coverage.namedNowhere(cl, dir, []);
        return r && typeof r.named === "number" && Array.isArray(r.absent)
            && r.covered === undefined;
    })());

/* ================= THE WIRING ================= */
check("THE PLANNER IS TOLD THE WHOLE JOB — the material's topic list rides " +
      "with the goal, so a plan decomposes by topic instead of by vibe",
    orchSrc.includes("makePlan(session, goal, cancelToken, sel, checklist)")
    && orchSrc.includes("const contract = checklist ? coverage.planBlock(checklist)")
    && orchSrc.includes("makePlan(session, planningGoal, cancelToken, driveSel, checklist)"), null);

check("...the checklist is read ONCE, before planning, and announced",
    orchSrc.includes("coverage.checklistFor(session.repoPath)")
    && orchSrc.includes("measuring against ${checklist.items.length} topics"), null);

check("THE REVIEWERS THAT CAN JUDGE IT GET IT — the contract joins the REQUEST " +
      "the completeness reviewers read, because 'did this cover the chapter' " +
      "is a question only something that reads the artifacts can answer",
    orchSrc.includes("const auditGoal = checklist")
    && orchSrc.includes("coverage.contractText(checklist)")
    && orchSrc.includes("goal: auditGoal,"), null);

check("THE CONTRACT PERSISTS WITH THE RUN — source and topics in the summary " +
      "meta, and deliberately NO coverage number beside them",
    orchSrc.includes("coverage: checklist")
    && orchSrc.includes("topics: checklist.items.map(i => i.id + \" \" + i.title)")
    && /No coverage NUMBER/.test(orchSrc), null);

{
    const block = coverage.planBlock(cl);
    check("the plan block names every topic and says the build is measured against it",
        cl.items.every(i => block.includes(i.title)) && /measured against this list/.test(block));
    const line = coverage.contractText(cl);
    check("the contract line names every topic and claims no coverage",
        cl.items.every(i => line.includes(i.title)) && !/covered|coverage:/i.test(line));
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }

console.log(`\n${pass}/${pass + fail} coverage-contract checks passed`);
process.exit(fail ? 1 : 0);
