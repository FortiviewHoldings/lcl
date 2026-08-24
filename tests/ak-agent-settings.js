"use strict";
/* §5m — Ancient Knowledge as a per-session agent. The ground rules TAILOR the
 * audit as context/tone, never break its guardrails; the round ceiling is a
 * session knob; the auditor is session-scoped; ground rules mirror to a
 * workspace companion file the agent reads. Exercised against the real module. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const ak = require("../.lcl.engine/core/ancientKnowledge");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}

/* ---- ground rules: none is silent, some become a guardrailed block ---- */
check("no ground rules → the auditor system prompt is unchanged",
    ak.systemFor({}) === ak.SYSTEM);
check("no ground rules → groundRules() is empty",
    ak.groundRules({}) === "");

const withRules = { akGroundRules: "Weigh wire-protocol correctness above all; treat unproven as not done." };
const sys = ak.systemFor(withRules);
check("ground rules are appended as their own labelled block",
    sys.startsWith(ak.SYSTEM) && /GROUND RULES/.test(sys)
    && /wire-protocol correctness/.test(sys), sys.slice(-200));
check("...and the block carries the guardrail — evidence still decides, no laundering",
    /NEVER change whether a part is genuinely done/.test(sys)
    && /never launder a blank audit/i.test(sys)
    && /Evidence still decides every verdict/.test(sys));
check("the guardrail wording sits AFTER the operator's text, so it is the last word",
    sys.lastIndexOf("Evidence still decides") > sys.indexOf("wire-protocol correctness"));

/* ---- the round ceiling knob overrides the effort default, clamped ---- */
check("no knob → the ceiling follows reasoning effort (2 + level)",
    ak.effectiveMaxRounds({ effortLevel: 2 }) === 4
    && ak.effectiveMaxRounds({ effortLevel: 0 }) === 2);
check("a session round knob overrides the effort default",
    ak.effectiveMaxRounds({ effortLevel: 0, akRounds: 5 }) === 5);
check("the knob is clamped to 1..8 — a wild value cannot make the agent grind forever",
    ak.effectiveMaxRounds({ akRounds: 99 }) === 8
    && ak.effectiveMaxRounds({ akRounds: 0 }) === ak.maxRounds(undefined)
    && ak.effectiveMaxRounds({ akRounds: -3 }) === ak.maxRounds(undefined));

/* ---- the workspace companion file: written, read back, cleared ---- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ak-rules-"));
try {
    const s = { id: "sess-1", repoPath: dir, akGroundRules: "Prefer measured over reasoned." };
    const w = ak.writeGroundRules(s);
    check("ground rules mirror to a workspace companion file named …rules.md",
        w.ok && /\.rules\.md$/.test(w.file), w);
    const full = path.join(dir, ak.rulesFileName(s));
    const disk = fs.readFileSync(full, "utf8");
    check("...the file carries the session marker and the rules text",
        /lcl-session:sess-1/.test(disk) && /Prefer measured over reasoned/.test(disk), disk.slice(0, 120));

    // THE AGENT READS THE FILE: editing it directly takes effect
    fs.writeFileSync(full, "<!-- lcl-session:sess-1 -->\n# x\n\n<!-- lcl-ak-rules -->\nEdited directly on disk.\n", "utf8");
    check("groundRules() reads the file body, so a direct edit is what the agent sees",
        ak.groundRules(s) === "Edited directly on disk.", ak.groundRules(s));

    // F7: a hand-authored file with a real markdown '---' must NOT lose the text
    // above it — the split is on OUR sentinel, not on markdown horizontal rules
    fs.writeFileSync(full, "General guidance.\n\n---\n\nSpecific rules:\n- foo\n", "utf8");
    check("a direct file with a markdown '---' keeps ALL its content — no header-split loss",
        /General guidance/.test(ak.groundRules(s)) && /Specific rules/.test(ak.groundRules(s)),
        ak.groundRules(s));

    // the writer emits the sentinel the reader strips
    s.akGroundRules = "Rule A.";
    ak.writeGroundRules(s);
    check("the companion file carries the lcl-ak-rules sentinel the reader strips",
        /<!-- lcl-ak-rules -->/.test(fs.readFileSync(full, "utf8"))
        && ak.groundRules(s) === "Rule A.", fs.readFileSync(full, "utf8").slice(0, 200));

    // clearing removes the file
    s.akGroundRules = "";
    const c = ak.writeGroundRules(s);
    check("clearing the rules deletes the companion file", c.ok && c.cleared
        && !fs.existsSync(full), { c, exists: fs.existsSync(full) });
} finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
}

/* ---- the spin-guard knob is a session setting the loop reads ---- */
{
    const fs2 = require("fs");
    const path2 = require("path");
    const agentSrc = fs2.readFileSync(
        path2.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("the spin-guard thresholds derive from session.akSpin — strict trips " +
          "earlier, lenient later, and the spin DEFINITION never loosens",
        /session\.akSpin === "strict" \? -1/.test(agentSrc)
        && /session\.akSpin === "lenient" \? 2/.test(agentSrc)
        && /Math\.max\(1, 2 \+ spinSens\)/.test(agentSrc)
        && /Math\.max\(2, 3 \+ spinSens\)/.test(agentSrc));
}

/* ---- no workspace → the session field is authoritative, no throw ---- */
check("with no workspace linked, groundRules falls back to the session field",
    ak.groundRules({ akGroundRules: "in-memory only" }) === "in-memory only");

console.log(`\n${pass}/${pass + fail} ak-agent-settings checks passed`);
process.exit(fail ? 1 : 0);
