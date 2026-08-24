/**
 * THE LOOP'S TWO NEWEST RESCUES, PINNED AT THE SOURCE.
 *
 * Both were measured against the user's own sessions, and both exist
 * because the local 35B provably ignores prompt steering — the loop has to
 * refuse the failure shape itself.
 *
 * 1. CODE-AS-PROSE: the model pastes the deliverable into chat — a ```cpp
 *    dump, or an orphan ```content fence with no tool call — instead of
 *    calling write_file. Nothing lands on disk and the next flash ships the
 *    STALE file. The loop now refuses the dump (at most twice) and demands
 *    the write_file call.
 *
 * 2. THINK-IT-ALL-AWAY: a reasoning model spends a small reply budget wholly
 *    inside its chain of thought — content empty, reasoning full, stream
 *    truncated. That is how "the auditor did not answer" and "3 of 4
 *    reviewers could not be reached" happened while the server answered ok.
 *    router.generate now retries ONCE with a floored budget and remembers
 *    the model so the waste is paid once per process.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const AGENT = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
const ROUTER = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "router.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 200) : ""); }
}

/* ---------------- 1. the code-as-prose rescue ---------------- */
const g0 = AGENT.indexOf("A FILE PASTED INTO CHAT IS NOT A FILE ON DISK");
check("the code-dump rescue exists", g0 >= 0);
const gate = AGENT.slice(g0, g0 + 7000);
check("it is capped at two corrections a turn (then honesty wins)",
    gate.includes("codeDumps < 2") && AGENT.includes("let codeDumps = 0;"));
check("it needs a workspace and the write_file tool, and never fires in stepMode",
    gate.includes("root && tools.write_file && !opts.stepMode"));
check("an orphan ```content fence fires it — the file body with no call in front",
    /orphanContent/.test(gate) && /```\[ \\t\]\*content/.test(gate.replace(/\\/g, "\\")));
check("a plain code dump only fires when a BUILD is in flight (planConfirm bubble, " +
      "a change this turn, or a build verb) — a snippet the user asked to see never does",
    gate.includes("planConfirm") && gate.includes("changes.length > 0")
    && gate.includes("BUILD_INTENT.test(String(userText"));
check("the dominance bar is real: at least 400 fenced chars and 60% of the reply",
    gate.includes("fencedChars >= 400") && gate.includes(">= 0.6"));
check("a COMPLETE dump is handed back so the model copies its own bytes " +
      "(re-drafting is how an 815-byte fragment replaced a 5.8KB sketch)",
    gate.includes('if (!cut) working.push({ role: "assistant", content: raw })'));
check("...but a TRUNCATED dump is NOT handed back — a cut paste it must not copy is a trap",
    /const cut = !!result\.truncated \|\| fences % 2 === 1;/.test(gate));
check("the rescue continues the loop (a correction, not an exit)",
    /continue;\s*\}\s*\}/.test(gate));

/* ---- 1b. the HOMEWORK rescue — measured on the 120b's first turn ---- */
check("a reply that tells the OPERATOR to save-and-run by hand is refused like a code dump",
    AGENT.includes("HOMEWORK_RE") && AGENT.includes("homework = fences >= 2")
    && AGENT.includes("|| homework)"));
check("...with a correction that names the model's OWN tools as the fix",
    AGENT.includes("YOUR job: call write_file"));
check("...and the real offending phrasing trips the predicate",
    (() => {
        const m = AGENT.match(/const HOMEWORK_RE = (\/[^\n]+\/i);/);
        if (!m) return false;
        const re = eval(m[1]);
        return re.test("Save it as run_audio_feeder.ps1 in the root folder")
            && re.test("Open PowerShell, navigate to that folder")
            && !re.test("I saved the file and proposed the script for approval");
    })());
check("the script help states WHERE scripts run, overriding stale history",
    AGENT.includes("RUNS IN THE LINKED WORKSPACE"));

/* ---------------- 2. the think-it-all-away retry ---------------- */
const r0 = ROUTER.indexOf("const thoughtItAllAway");
check("the think-retry exists in router.generate", r0 >= 0);
const rgate = ROUTER.slice(Math.max(0, r0 - 1200), r0 + 1200);
check("it fires only on: no error, empty content, reasoning present, truncated stream",
    rgate.includes('!String(first.content || "").trim()')
    && rgate.includes("first.reasoning && first.truncated"));
check("...and NEVER when a tool call was assembled — a truncated call is not discarded",
    rgate.includes("!(first.toolCalls || []).length"));
check("the retry budget is floored at 4096 and capped at the endpoint's own roof",
    ROUTER.includes("const THINK_FLOOR = 4096;")
    && rgate.includes("Math.min(Math.max(ask * 4, THINK_FLOOR), roof)"));
check("the model is remembered so every later small ask is pre-floored (waste paid once)",
    ROUTER.includes("const thinkBurners = new Set();")
    && rgate.includes("thinkBurners.add(burnKey)"));
check("a stopped turn never retries", rgate.includes("&& !stopped()"));
check("it retries exactly once — the second result replaces the first only on success",
    rgate.includes("if (!second.error) first = second;"));

/* ---- 3. DRIVE TO COMPLETION — the always-on floor ---- */
check("the agentic contract is in the prompt: an agent, not an advisor, finishes the job",
    AGENT.includes("YOU ARE AN AGENT, NOT AN ADVISOR")
    && AGENT.includes("keep calling tools until the deliverable actually"));
check("the drive gate is bounded (DRIVE_MAX) like every other rescue",
    AGENT.includes("let driveNudges = 0;") && AGENT.includes("const DRIVE_MAX = 2;")
    && AGENT.includes("driveNudges < DRIVE_MAX"));
check("...it is independent of Ancient Knowledge (fires only when the brain is OFF)",
    AGENT.includes("session.ancientKnowledge !== true") && AGENT.includes("DRIVE TO COMPLETION"));
check("...a real question the request did not answer is a LEGITIMATE stop, never driven",
    AGENT.includes("asksUser") && /do you want\|let me know\|confirm/.test(AGENT));
check("...an empty or truncated reply is never driven (those are their own paths)",
    /!emptyReply && !result\.truncated/.test(AGENT));
check("...termination is structural: the drive branch sits ABOVE steps++, so a " +
      "talk-only nudge never advances the tool ceiling — only DRIVE_MAX ends it",
    AGENT.indexOf("DRIVE TO COMPLETION") < AGENT.lastIndexOf("steps++"));

/* ---- 4. WEB GROUNDING — the network permission is a fact-checking contract ---- */
check("with web tools on, the prompt commands verify-then-answer, cited",
    AGENT.includes("WEB GROUNDING") && AGENT.includes("VERIFIED, not remembered")
    && AGENT.includes("Feeling unsure IS"));
check("...the self-teaching loop is named: research_topic → knowledge library",
    AGENT.includes("teach yourself once, reuse it forever"));
check("...and the block is GATED on web_search being offered — an offline session's " +
      "prompt never promises a fact-checker it does not have",
    AGENT.includes("(tools.web_search"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
