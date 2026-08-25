/**
 * THE PERSISTENT STEP TRANSCRIPT — "pop the chat bubbles".
 *
 * The complaint: "when i go away from a session, and come back, all the
 * thoughts and steps that have been shown disappear. it is time to pop the
 * chat bubbles." The engine now records the durable narration phases onto the
 * turn's reply as meta.steps (agent.recordStep), the orchestrator aggregates
 * a goal-level record onto its summary message, and the renderer draws both
 * flat — through the SAME stepLine() wording the live bubble used — and
 * replays the in-flight turn's activity after a session switch.
 *
 * The recorder is behavioural (the real exported function); the wiring that
 * cannot run headless is pinned in source.
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
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const agent = require(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"));

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}

const ROOT = path.join(__dirname, "..");
const agentSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
const orchSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");

/* =====================================================================
 * 1. THE RECORDER — behavioural, against the real exported function.
 * ===================================================================== */
check("recordStep and STEP_KEEP are exported (the orchestrator and this suite " +
      "use the real keep-set, not copies that can drift)",
    typeof agent.recordStep === "function" && agent.STEP_KEEP instanceof Set);

check("the durable phases are kept",
    ["planning", "plan-confirm", "tool", "tool-done", "tool-progress",
     "correcting", "clarify", "grounding", "denied", "needs-approval",
     "script-proposed", "script-refused", "spin-warned", "spin-stopped",
     "step-limit", "fabricated-tool-result", "audit-done"]
        .every(p => agent.STEP_KEEP.has(p)),
    [...agent.STEP_KEEP]);

check("the transient ticks are NOT — a live counter is not a record",
    ["sent", "generating", "reasoning", "thinking", "thinking-again", "done"]
        .every(p => !agent.STEP_KEEP.has(p)));

{
    const list = [];
    agent.recordStep(list, "generating", { tokens: 40 }, 100);
    agent.recordStep(list, "sent", { model: "m" }, 120);
    agent.recordStep(list, "correcting", { reason: "refit" }, 140);
    check("recording a transient phase appends nothing; a durable one appends " +
          "a slim {t, phase, d} entry",
        list.length === 1 && list[0].phase === "correcting"
        && list[0].t === 140 && list[0].d.reason === "refit", list);
}

{
    const list = [];
    for (let i = 0; i < 250; i++) agent.recordStep(list, "correcting", { reason: "r" + i }, i);
    check("the persisted record is HARD-CAPPED at 200 entries, dropping oldest " +
          "(sessions.js pretty-prints — unbounded steps would bloat the file)",
        list.length === 200 && list[0].d.reason === "r50"
        && list[199].d.reason === "r249", list.length);
}

{
    const list = [];
    agent.recordStep(list, "denied", { tool: "run_script", reason: "x".repeat(500) }, 1);
    check("string details are truncated (~120 chars), so one noisy event " +
          "cannot write a paragraph into the session file",
        list.length === 1 && list[0].d.reason.length <= 120, list[0] && list[0].d.reason.length);
}

{
    const chat = [], goal = [];
    agent.recordStep(chat, "tool", { tool: "write_file", digest: "a.txt" }, 1);
    agent.recordStep(chat, "tool-done", { tool: "write_file" }, 2, false);
    agent.recordStep(goal, "tool", { tool: "write_file", digest: "a.txt" }, 1, true);
    agent.recordStep(goal, "tool-done", { tool: "write_file" }, 2, true);
    check("THE DEDUPE CHOICE: the chat path drops tool/tool-done (each call " +
          "already persists as its own work row on the same transcript) — the " +
          "orchestrator keeps them, because its step transcripts are discarded " +
          "and the aggregate is the only durable record",
        chat.length === 0 && goal.length === 2, { chat: chat.length, goal: goal.length });
}

{
    const list = [];
    agent.recordStep(list, "tool-progress", { tool: "flash_device", note: "compiling — 40%", pct: 40, etaMs: 9000 }, 1);
    agent.recordStep(list, "tool-progress", { tool: "flash_device", note: "still working", indeterminate: true }, 2);
    agent.recordStep(list, "tool-progress", { tool: "generate_image", note: "step 2/4" }, 3);
    agent.recordStep(list, "tool-progress", { tool: "flash_device", note: "compiled. uploading to COM5…" }, 4);
    check("bar frames (pct / indeterminate) and 'step N/M' counters are live " +
          "ticks, not records — milestones persist",
        list.length === 1 && /uploading/.test(list[0].d.note), list);
}

/* =====================================================================
 * 2. THE ATTACH POINT — source pins on agent.js.
 * ===================================================================== */
check("report() records as it forwards — one funnel feeds the live feed AND " +
      "the persisted record",
    /const turnSteps = \[\];/.test(agentSrc)
    && /recordStep\(turnSteps, phase, detail, Date\.now\(\) - startedAt\);/.test(agentSrc));

check("the attach host SKIPS guard notices and the Ancient Knowledge audit " +
      "bubble — their render branches never show steps, so an AK-audited turn " +
      "would persist steps onto a message that cannot display them",
    /m\.meta && \(m\.meta\.guard \|\| m\.meta\.model === "ancient-knowledge"\)/.test(agentSrc));

check("...falling back to the true last assistant message",
    /\[\.\.\.newMessages\]\.reverse\(\)\.find\(carries\)/.test(agentSrc)
    && /\[\.\.\.newMessages\]\.reverse\(\)\.find\(m => m && m\.role === "assistant"\)/.test(agentSrc));

check("the attach happens BEFORE the stepMode persist gate, so every exit " +
      "but the plan-confirm early return carries its record",
    (() => {
        const attach = agentSrc.indexOf('host.meta = { ...(host.meta || {}), steps: turnSteps }');
        const persist = agentSrc.indexOf("if (!opts.stepMode) {\n        session.messages.push(...newMessages);");
        return attach > 0 && persist > 0 && attach < persist;
    })());

/* =====================================================================
 * 3. THE ORCHESTRATED PATH — a goal is the longest work this app does,
 *    and it must not be the one path that still forgets.
 * ===================================================================== */
check("runGoal wraps its onProgress with the goal-level recorder — every step " +
      "turn, the audit pass and the AK cycle flow through that one funnel",
    /const goalSteps = \[\];/.test(orchSrc)
    && /agent\.recordStep\(goalSteps, info\.phase, info\.detail,\s*\n\s*Date\.now\(\) - goalStartedAt, true\);/.test(orchSrc));

check("...keeping tool lines (keepTools=true): step transcripts are discarded, " +
      "so the aggregate is the only durable record of them",
    /goalStartedAt, true\);/.test(orchSrc));

check("the summary message carries the aggregate as meta.steps (by reference, " +
      "so audit/AK phases recorded after it is built still land)",
    /steps: goalSteps,/.test(orchSrc)
    && /planSteps: steps\.length/.test(orchSrc));

/* =====================================================================
 * 4. THE RENDERER — one wording for every surface.
 * ===================================================================== */
const fnStart = appSrc.indexOf("function stepLine(");
const fnEnd = appSrc.indexOf("const PHASE_TEXT");
const stepLineSrc = fnStart >= 0 && fnEnd > fnStart ? appSrc.slice(fnStart, fnEnd) : "";

check("stepLine() exists, above PHASE_TEXT", stepLineSrc.length > 0);

check("EVERY persisted phase has a stepLine wording — the parity that keeps " +
      "the live view, the replay and the transcript from drifting apart",
    [...agent.STEP_KEEP].every(p => stepLineSrc.includes(`case "${p}":`)),
    [...agent.STEP_KEEP].filter(p => !stepLineSrc.includes(`case "${p}":`)));

check("the LIVE bubble draws its lines from stepLine (spot pins: tool, " +
      "tool-progress, script-refused and the grouped new phases)",
    /const l = stepLine\("tool", d\);/.test(appSrc)
    && /const l = stepLine\("tool-progress", d\);/.test(appSrc)
    && /const l = stepLine\("script-refused", d\);/.test(appSrc)
    && /const l = stepLine\(info\.phase, d\);/.test(appSrc));

check("the DURABLE feed records through stepLine too, so the mid-turn replay " +
      "shows the same strings the viewer watched",
    /const l = stepLine\("tool", d0\);/.test(appSrc)
    && /const l = stepLine\(info\.phase, d0\);/.test(appSrc));

check("the once-live-only phases are recorded durably for the replay " +
      "(correcting, script-*, spin-*, step-limit, fabricated-tool-result, " +
      "planning, plan-confirm)",
    (() => {
        const at = appSrc.indexOf("const l = stepLine(info.phase, d0);");
        if (at < 0) return false;
        const before = appSrc.slice(Math.max(0, at - 900), at);
        return ["correcting", "script-proposed", "script-refused", "spin-warned",
                "spin-stopped", "step-limit", "fabricated-tool-result",
                "planning", "plan-confirm"]
            .every(p => before.includes(`case "${p}":`));
    })());

check("PHASE_TEXT names the phases that used to render as raw keys",
    ["spin-warned", "spin-stopped", "step-limit", "fabricated-tool-result"]
        .every(p => new RegExp(`"${p}": "`).test(appSrc)));

check("addMessageRow renders meta.steps as a flat .msg-steps block, through " +
      "stepLine, before the reply body",
    /Array\.isArray\(meta\.steps\) && meta\.steps\.length/.test(appSrc)
    && /stepsEl\.className = "msg-steps";/.test(appSrc)
    && /div\.className = "msg-step " \+ line\.kind;/.test(appSrc)
    && appSrc.indexOf('stepsEl.className = "msg-steps"')
       < appSrc.indexOf('bubble.className = role === "user" ? "msg-user" : "msg-assistant"'));

check("...and the steps render sits BELOW the guard / ancient-knowledge early " +
      "returns, so those branches stay exactly as they were",
    appSrc.indexOf('"msg-guard"') < appSrc.indexOf('stepsEl.className = "msg-steps"')
    && appSrc.indexOf('"msg-ancient"') < appSrc.indexOf('stepsEl.className = "msg-steps"'));

check("switching to a working session REPLAYS the recorded steps into the " +
      "restored bubble instead of leaving it empty",
    /const since = q \? q\.at : 0;/.test(appSrc)
    && /for \(const e of \(sessionActivity\.get\(active\.id\) \|\| \[\]\)\)/.test(appSrc)
    && /pushActivity\(typing, e\.kind, e\.text\);/.test(appSrc));

check("the live log caps at 200 lines like the persisted record — the 10-line " +
      "ticker is gone",
    /log\.children\.length > 200/.test(appSrc)
    && !/log\.children\.length > 10\b/.test(appSrc));

/* =====================================================================
 * 5. THE LOOK — flat transcript, everything re-inked with it.
 * ===================================================================== */
check("the assistant bubble is POPPED: no light gradient, no border box — " +
      "flat on the chat ground",
    !/linear-gradient\(180deg, #e1e1e5, #ececef\)/.test(cssSrc)
    && /\.msg-assistant \{[^}]*background: none;/s.test(cssSrc)
    && /\.msg-assistant \{[^}]*color: var\(--text\);/s.test(cssSrc));

check("the live bubble went flat the same way, keeping its class name for " +
      "the harness cleanup",
    /\.msg-typing \{[^}]*background: none;/s.test(cssSrc));

/* "you keep the thinking... portion of the tool at the top. it doesnt move
 * down as it prints. as if it is keeping up with you as you read. so you have
 * no idea the thing is thinking until you scroll all the way up." Two causes,
 * two pins. */
check("the thinking bubble STAYS LAST as live tool rows land — the re-append " +
      "queries .msg-typing, the class that exists (\".typing\" matched nothing " +
      "for an era, so every work row stacked below the bubble and buried it)",
    /chat\.querySelector\("\.msg-typing"\)/.test(appSrc)
    && !/chat\.querySelector\("\.typing"\)/.test(appSrc));

check("...and the liveness head is STICKY with its own opaque ground — dots, " +
      "phase and timer pinned to the viewport edge while any of the bubble " +
      "is in view, so a wall of step log never hides that the app is alive",
    /\.typing-head \{[^}]*position: sticky;/s.test(cssSrc)
    && /\.typing-head \{[^}]*background: var\(--bg\);/s.test(cssSrc));

check("the recede rule is gone — a permanent record does not fade its own " +
      "history",
    !/\.typing-step:not\(:last-child\)/.test(cssSrc));

check("the persisted family exists with the same kinds as the live log",
    [".msg-steps {", ".msg-step {", ".msg-step.good", ".msg-step.bad",
     ".msg-step.warn", ".msg-step.ask", ".typing-step.ask"]
        .every(s => cssSrc.includes(s)));

check("inline code is re-inked: the white-alpha wash is the DEFAULT (the " +
      "black-alpha wash was tuned to the light bubble and vanished on dark)",
    (() => {
        const rule = /code\.inline-code \{[^}]*\}/s.exec(cssSrc);
        return rule && /rgba\(255, 255, 255, 0\.09\)/.test(rule[0])
            && !/rgba\(0, 0, 0, 0\.08\)/.test(rule[0]);
    })());

check("the dark-ink icon override for the light bubble is deleted",
    !/\.msg-row\.assistant \.icon-btn \{ color: #6a6a70; \}/.test(cssSrc));

check("the assistant row spans the transcript; the Ancient Knowledge card " +
      "keeps its own frame — on the USER'S side now, per the open list: " +
      "'it must read as though the user sent it'",
    /\.msg-row\.assistant \{ align-self: stretch; align-items: stretch; max-width: 100%; \}/.test(cssSrc)
    && /\.msg-row\.assistant\.ancient \{ align-self: flex-end;/.test(cssSrc));

console.log(`\n${pass}/${pass + fail} step-transcript checks passed`);
process.exit(fail ? 1 : 0);
