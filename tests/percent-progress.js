/**
 * PERCENT-OF-TOTAL PROGRESS — "how much longer, what is the total we are out
 * of the whole."
 *
 * A bar is only drawn where a real number stands behind it: esptool's own
 * upload percent, elapsed-over-learned compile time (capped, never claiming
 * the finish), the reply-token cap actually in force for generation. A first
 * run with no history gets an honest indeterminate sweep — never a fake
 * percent. These checks pin the whole wire: producer (deviceControl), both
 * forwarding paths (agent loop ctx AND the approval dispatch), the live
 * budget in agent.js, and the renderer's bar behaviour.
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}

const ROOT = path.join(__dirname, "..");
const agentSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
const devSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "deviceControl.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");

/* =====================================================================
 * 1. THE PRODUCER — deviceControl emits real numbers (already shipped;
 *    pinned so the contract cannot quietly regress).
 * ===================================================================== */
check("the compile ticker reports pct against the LEARNED duration, capped at " +
      "95 — the process, not the clock, decides completion",
    /Math\.min\(95, Math\.round\(\(el \/ knownMs\) \* 100\)\)/.test(devSrc)
    && /\{ pct, etaMs: Math\.max\(0, knownMs - el\) \}/.test(devSrc));

check("a first build has NO estimate and says so: indeterminate, honest words, " +
      "never a fake percent",
    /first build on this board, no estimate yet; timing it/.test(devSrc)
    && /\{ indeterminate: true \}/.test(devSrc));

check("the upload forwards esptool's own percent, one note per whole percent",
    /say\(`uploading to \$\{p\} — \$\{pct\}%`, \{ pct \}\)/.test(devSrc));

/* =====================================================================
 * 2. THE WIRE — both dispatch paths carry the extra object.
 * ===================================================================== */
check("the agent-loop tool ctx forwards onNote's extra (pct/etaMs/indeterminate) " +
      "onto the tool-progress detail",
    /onNote: \(note, extra\) => report\("tool-progress",\s*\n\s*\{ tool: toolName, note, \.\.\.\(extra && typeof extra === "object" \? extra : \{\}\) \}/.test(agentSrc));

check("THE APPROVAL PATH TOO — a human-approved flash is the normal case for " +
      "an EXECUTE-class tool, and it used to drop the extra and show no bar",
    /onNote: \(note, extra\) => \{/.test(mainSrc)
    && /detail: \{ tool: p\.tool, note,\s*\n\s*\.\.\.\(extra && typeof extra === "object" \? extra : \{\}\) \}/.test(mainSrc));

/* =====================================================================
 * 3. THE GENERATION BUDGET — the denominator tracks the LIVE cap.
 * ===================================================================== */
check("the reported budget starts from the first fit",
    /let replyBudget = preFit\.replyTokens;/.test(agentSrc));

check("...rides every generating report",
    /budget: replyBudget \|\| null,/.test(agentSrc));

check("...is updated by refitFor BEFORE the fallback generates, so a substitute " +
      "model's cap is the one reported",
    (() => {
        const set = agentSrc.indexOf("replyBudget = lim2.maxTokens;");
        const ret = agentSrc.indexOf("return { messages: fit2.messages, replyTokens: lim2.maxTokens };");
        return set > 0 && ret > 0 && set < ret;
    })());

check("...and by the context-overflow refit BEFORE the retry generates",
    (() => {
        const set = agentSrc.indexOf("replyBudget = refit.replyTokens;");
        const ret = agentSrc.indexOf("result = await router.generate(\n                refit.messages, refit.replyTokens");
        return set > 0 && ret > 0 && set < ret;
    })());

/* =====================================================================
 * 4. THE RENDERER — one bar component in the activity log.
 * ===================================================================== */
check("pushActivity grew the bar parameter",
    /function pushActivity\(bubble, kind, text, replaceLast = false, bar = null\)/.test(appSrc));

check("bars replace only bars: a ticking bar on a non-live kind takes " +
      "effectiveKind 'bar' and can never swallow a milestone note",
    /if \(bar && !LIVE_KINDS\[kind\]\) effectiveKind = "bar";/.test(appSrc));

check("the replace branch refreshes the row CLASS too — a gen bar replacing " +
      "the 'sent — waiting Ns' line picks up its own color and has-bar layout",
    /row\.className = "typing-step " \+ kind \+ \(bar \? " has-bar" : ""\);\s*\n\s*row\.dataset\.kind = effectiveKind;/.test(appSrc));

check("the fill is clamped 0..100 and indeterminate is a class, not a number",
    /Math\.max\(0, Math\.min\(100, Math\.round\(bar\.pct \|\| 0\)\)\) \+ "%"/.test(appSrc)
    && /fill\.classList\.toggle\("indeterminate", !!bar\.indeterminate\);/.test(appSrc));

check("tool-progress builds the bar from d.pct / d.indeterminate and ticks " +
      "in place",
    /const bar = \(typeof d\.pct === "number" && isFinite\(d\.pct\)\) \? \{ pct: d\.pct \}/.test(appSrc)
    && /const ticking = !!bar \|\| \/step \\d\+\\\/\\d\+\/\.test\(String\(d\.note \|\| ""\)\);/.test(appSrc));

check("generation shows capacity-of-budget, labeled as exactly that, capped " +
      "at 99 — the model, not the count, decides when it is done",
    /% of reply budget/.test(appSrc)
    && /Math\.min\(99, Math\.round\(\(\(d\.tokens \|\| 0\) \/ budget\) \* 100\)\)/.test(appSrc));

check("...and no budget means no bar, not a guessed one",
    /const used = budget > 0\s*\n\s*\? Math\.min\(99,/.test(appSrc)
    && /used !== null \? \{ pct: used \} : null/.test(appSrc));

/* =====================================================================
 * 5. THE LOOK — the track exists, and the sweep animation with it.
 * ===================================================================== */
check("the bar track and fill are styled (.typing-step-bar, distinct from " +
      ".stack-step-bar and #load-bar-fill)",
    /\.typing-step-bar \{/.test(cssSrc) && /\.typing-step-bar > i \{/.test(cssSrc));

check("indeterminate is a sliding sweep, honest about having no total",
    /\.typing-step-bar > i\.indeterminate \{/.test(cssSrc)
    && /@keyframes step-bar-slide/.test(cssSrc));

console.log(`\n${pass}/${pass + fail} percent-progress checks passed`);
process.exit(fail ? 1 : 0);
