// router.generate, NOT engine.generate. Identical contract, and it is the one
// seam that knows whether this session is driven by a local model or a linked
// remote endpoint. Calling engine.generate here meant that with a remote model
// selected, the PLANNER and the CRITIC still ran on whatever local model
// happened to be resident — and on a machine with none loaded (the memory guard
// had stopped it, or the user only ever linked an API) they failed outright, so
// a multi-step goal died before the first step. The user pays for a frontier
// model precisely so it can do the planning.
const router = require("./router");
const agent = require("./agent");
const selfAudit = require("./selfAudit");
const { parseToolJson } = require("./toolParse");
const coverage = require("./coverage");
const intentLedger = require("./intentLedger");   // pure fs — safe at load

/**
 * The orchestrator — .lcl's "mitochondria".
 *
 * A small local model cannot hold a twenty-step task in its head and execute
 * it coherently; that is a real limit of the hardware, not a bug. What it CAN
 * do is one small, concrete step at a time. So the orchestrator turns a broad
 * goal ("turn this folder into a static site") into an ordered PLAN of small
 * steps, then runs each step as a focused agent turn that reuses every
 * existing safety layer (policy kernel, backups, the write_file format guard).
 *
 * CONCURRENCY IS A PROPERTY OF THE DRIVER, NOT OF THIS FILE.
 *
 * A LOCAL model is one llama-server holding one model resident: steps must run
 * one at a time, because that is physics and because a second resident model
 * is exactly what crashes a 15 GB laptop. An API endpoint and a node are the
 * opposite — they serve concurrent requests, and forcing them through a
 * one-at-a-time loop wastes hardware chosen specifically so this would not
 * happen. The requirement: the API and the GPU family of connected devices —
 * rented or owned — should all handle concurrency well, with local being the
 * RAM hog.
 *
 * So the planner declares which steps depend on which, the plan is cut into
 * WAVES of mutually independent steps, and each wave runs at the width the
 * driver supports: 1 for local, several for an API or a node. A plan whose
 * planner declares no dependencies degrades to the old strictly-ordered
 * behaviour, so this can never make an existing plan less correct.
 *
 * Parallel steps are safe against the transcript because runTurn in stepMode
 * READS session.messages and never writes it (agent.js) — each step gets the
 * same snapshot, and results are merged here in plan order.
 */

// THE STEP CAP SCALES TO THE DRIVER, not to the laptop.
//
// MAX_STEPS used to be a fixed 10 regardless of who was answering — so a 70B
// on a 128 GB DGX Spark (a machine sized to run agents) was
// capped like a 1.5B on a 15.6 GB laptop. The agent per-turn limits already
// scale (router.limits: local 4, node 64); the orchestrator's plan cap must
// scale the same way or a capable node is a one-shot that announces "ran 10
// steps" and stops. Local stays modest (the laptop is memory-constrained); a
// node gets a real plan budget (it is the user's own hardware with nothing
// to be cautious about); an API gets a middle budget (it bills per token).
const STEP_CAP_LOCAL = 10;
const STEP_CAP_API = 24;
const STEP_CAP_NODE = 40;

/** How many steps a plan may contain for this driver. Mirrors stepConcurrency:
 *  the budget belongs to the model that will actually answer this session. */
function stepCap(sel) {
    try {
        if (!router.usingRemote(sel)) return STEP_CAP_LOCAL;
        const lim = typeof router.limits === "function" ? router.limits(sel) : null;
        return lim && lim.node ? STEP_CAP_NODE : STEP_CAP_API;
    } catch { return STEP_CAP_LOCAL; }
}

const PLAN_TOKENS = 900;
const MAX_ATTEMPTS = 2;              // one execute + one repair on a failed step

// ONE AUDIT MECHANISM, TWO TIERS, ONE FILE. The per-step gate used to live
// here and the finished-work panel would have been a second, parallel notion
// of "is this any good" — so both live in selfAudit.js and this module calls
// them. critiqueStep and expectsFile are re-exported unchanged: the step gate's
// contract (and the suite that pins it) did not move, only its address.
const { critiqueStep, expectsFile, QUALITY_BRIEF } = selfAudit;

const BUILD_VERB = /\b(build|create|make|turn .* into|set ?up|scaffold|generate|put together|write|redo|rebuild|regenerate|design|develop|implement|code up|whip up|construct)\b/i;
const COMPOSITE = /\b(site|website|web ?app|app|project|dashboard|page(s)?|blog|portfolio|suite|report|docs?|documentation|structure|boilerplate|skeleton|landing|homepage|game|form|ui|interface|multiple|several|and then|, then|first.*then)\b/i;
// HARDWARE / DEVICE work — belongs in the normal agent loop (tool calls with
// approvals), never the file-building orchestrator. Specific on purpose: a
// COM port number, a named MCU, or "(the|this|my) board" — not bare "board"
// (which lives inside "dashboard") and not bare "program".
const HARDWARE = new RegExp("\\bCOM\\d+\\b" +"|\\b(?:esp32(?:-s\\d)?|esp8266|arduino|microcontroller|firmware" +"|serial\\s*port|com\\s*port|dev\\s*board|breakout\\s*board" +"|flash\\s+(?:it|the|this|my)|(?:the|this|my|a)\\s+board\\b" +"|device\\s+on\\s+com|program\\s+(?:the|this|a|my)\\s+(?:board|device|chip|esp))\\b", "i");

// The device tools. A session that has called any of these is a hardware dev
// session and never routes to the file orchestrator again.
const DEVICE_TOOLS = /^(?:board_identify|backup_firmware|serial_read|serial_write|inspect_devices|install_toolchain|flash_device)$/;

// A correction/continuation of something the assistant just tried to build.
const CORRECTION = /\b(try again|do it again|redo|again|that('?s| is) not|isn'?t (a|an|right|correct|real|proper|complete)|not (a |an )?(real|proper|complete|actual|working)|make it (a |an )?|do it (properly|right|for real)|actually (build|make|create)|instead|fix (it|this|that)|redo it|that did nothing|nothing happened|empty|blank)\b/i;

/**
 * Does this goal warrant a plan? True when it names a build of something
 * composite, OR when it is a CORRECTION of a build the conversation was just
 * attempting — "try again, that is not a static site" has no build verb of its
 * own but plainly continues the site build, and used to fall through to a
 * single turn that wrote one stub and lied about the rest.
 */
function looksMultiStep(goal, session) {
    const g = String(goal || "");
    /* HARDWARE IS NOT A FILE BUILD, AND THIS ENGINE ONLY BUILDS FILES.
     *
     * Measured from a real session: "There's a board on COM10. Figure out
     * what it is, find its documentation online, and get set up to program
     * it" hit "set up" (a build verb) + "documentation" (composite) and was
     * routed HERE. The model correctly called board_identify — the audit log
     * shows the tool-decision — but the orchestrator measures success by
     * FILES WRITTEN, cannot surface an EXECUTE tool confirmation, and so
     * swallowed the call and reported "wrote no files". A device task is a
     * conversation of tool calls (identify, read, install, flash), each with
     * its own approval — exactly what the normal agent loop does. Route it
     * there. The keyword net is deliberately specific so "dashboard" and the
     * like never trip it. */
    if (HARDWARE.test(g)) return false;
    /* AND ONCE A SESSION IS DOING HARDWARE, IT STAYS IN THE NORMAL LOOP.
     *
     * Measured from the real session: the keyword net caught "COM10" and "the
     * board" but not "this WAVESHARE board", so a big follow-up ("write a custom
     * interface... voice assistant...") slipped back to the file orchestrator and
     * dead-ended at "wrote no files" — after board_identify and install_toolchain
     * had already run in the same conversation. A per-message keyword check is
     * whack-a-mole; the session context is not. If a device tool has run here,
     * this is a hardware dev session and every turn belongs in the tool-calling
     * loop, whatever words the next message happens to use. */
    if (session && Array.isArray(session.messages)) {
        const used = session.messages.some(m =>
            m && DEVICE_TOOLS.test(String(m.name || m.tool || "")));
        if (used) return false;
    }
    if (BUILD_VERB.test(g) && COMPOSITE.test(g)) return true;

    // a correction that follows a recent build attempt in this session
    if (CORRECTION.test(g) && session && Array.isArray(session.messages)) {
        const recent = session.messages.slice(-8);
        const priorBuild = recent.some(m =>
            (m.role === "user" || m.role === "assistant") &&
            BUILD_VERB.test(String(m.content || "")) && COMPOSITE.test(String(m.content || "")));
        // also treat a bare "try again" after a build as a build continuation
        if (priorBuild) return true;
    }
    return false;
}

/** What the user is really asking to (re)build — the current goal, or the
 *  original build request it continues, so a plain "try again" gets a real
 *  goal to plan against instead of the word "again". */
function resolveGoal(goal, session) {
    const g = String(goal || "");
    if (BUILD_VERB.test(g) && COMPOSITE.test(g)) return g;
    if (CORRECTION.test(g) && session && Array.isArray(session.messages)) {
        // find the most recent user message that WAS a build request
        for (let i = session.messages.length - 1; i >= 0; i--) {
            const m = session.messages[i];
            if (m.role === "user" && BUILD_VERB.test(String(m.content || "")) && COMPOSITE.test(String(m.content || ""))) {
                // combine the original goal with the correction's added intent
                return `${m.content}\n(Follow-up correction: ${g})`;
            }
        }
    }
    return g;
}

const PLAN_SYSTEM =
    "You are the planner for a local AI agent that edits real files in a linked " +
    "folder. Given the user's GOAL, output a short ordered plan of concrete steps. " +
    "Each step is ONE file to create or ONE action, described so a junior agent " +
    "can do it without further questions. Do NOT write the file contents here — " +
    "just the plan.\n" +
    "Reply with ONLY a JSON object, no prose. Give each step an \"after\" array " +
    "listing the step numbers it genuinely depends on (1-based, [] if none) — " +
    "steps that share no dependency may be executed AT THE SAME TIME, so only " +
    "list a dependency when the step truly cannot start without that one's " +
    "output. Two steps that write DIFFERENT files usually have no dependency.\n" +
    "Example for a website goal:\n" +
    '{"steps": [' +
    '{"title": "Landing page", "action": "Write index.html: a complete responsive landing page with a hero, a features section, and a footer, linking styles.css and about.html", "after": []}, ' +
    '{"title": "Stylesheet", "action": "Write styles.css: modern responsive styles for the pages — layout, typography, colors, buttons", "after": []}, ' +
    '{"title": "About page", "action": "Write about.html: an about page matching index.html, linking styles.css", "after": []}' +
    "]}\n" +
    "Now plan the ACTUAL goal. Keep it to the fewest steps that truly accomplish " +
    "it (the plan is capped to what this driver can sustain), but a website always needs at least a page and a stylesheet.\n\n" +
    // THE PLAN IS WHERE THE BAR IS SET OR LOST. A plan of one step called
    // "make the site" produces one thin page no matter how good the executor
    // is, and no amount of reviewing afterwards can add the pages the plan
    // never asked for. The same brief governs the reviewers, so producing and
    // judging are held to one standard rather than two.
    QUALITY_BRIEF +
    "\nPlan for that standard: enough steps to actually deliver it, each naming " +
    "the real thing to build.";

// Real facts about .lcl, injected when the site is about advertising .lcl /
// "yourself". A weak model cannot write substantive copy about a product it
// does not know — giving it the actual value proposition is the difference
// between a thin skeleton and a real page.
const LCL_FACTS =
    ".lcl is a fully-local AI agent workbench that runs entirely offline on the " +
    "user's own machine — no cloud, no accounts, nothing leaves the device. It " +
    "runs local language models (Qwen, Phi) via llama.cpp, reads and edits real " +
    "files in a folder you link, generates images with Stable Diffusion, sees " +
    "images with a vision model, searches your files by meaning, and runs a " +
    "security-gated tool suite. Everything is private by default. Its selling " +
    "points: PRIVATE (your data and prompts never leave your computer), CAPABLE " +
    "(edits files, writes code, makes images, runs multi-step tasks), and YOURS " +
    "(one installable app, offline, no subscription).";

function siteDefaultPlan(goal) {
    if (!/\b(site|website|web ?page|landing page|web ?app|blog|portfolio)\b/i.test(goal)) return null;
    const aboutSelf = /\b(yourself|itself|\.?lcl|this (app|software|tool|agent))\b/i.test(goal);
    const subject = aboutSelf ? ".lcl (this local AI app)"
        : (goal.replace(/^.*\b(?:for|about|to advertise|of)\b\s*/i, "").trim() || "the project");
    const facts = aboutSelf ? ` Use these real facts as the content: ${LCL_FACTS}` : "";
    const style =
        "Write the CSS inline in a <style> tag AS WELL so the page looks good even " +
        "before styles.css loads. Use a modern dark theme, a centered max-width " +
        "container, generous spacing, and a clear visual hierarchy.";
    return [
        { n: 1, title: "Landing page",
          action: `Write index.html: a complete, responsive landing page advertising ${subject}. ` +
                  "Include: a <head> with title and meta viewport; a hero section with a bold " +
                  "headline, a one-line tagline, and a call-to-action button; a section of at least " +
                  "three feature cards each with a heading and a sentence; and a footer. " +
                  style + " Link styles.css and about.html." + facts },
        { n: 2, title: "Stylesheet",
          action: "Write styles.css: a complete modern responsive stylesheet — a dark theme with " +
                  "an accent color, system font stack, a centered container, styled hero, a " +
                  "responsive feature-card grid, buttons with hover states, and footer styling. " +
                  "Real rules, not a stub." },
        { n: 3, title: "About page",
          action: `Write about.html: a full about page for ${subject}, same header/footer and ` +
                  "style as index.html, with a couple of real paragraphs and a link back to " +
                  "index.html." + facts }
    ];
}

/**
 * NEVER DEAD-END — ASK.
 *
 * The standard: a broad ask should draw a request for clarification and more
 * context, and then agents are deployed properly.
 *
 * That is the standard, and .lcl was failing it: a broad goal that produced no
 * files got "Ran N steps but wrote no files — the model may need a clearer",
 * a wall that helps nobody. A capable engineer does not report failure and
 * stop; it says what it understood, asks the one or two questions that unblock
 * it, and names a concrete first step. This turns the dead-end into that.
 */
async function askForClarification(session, goal, cancelToken, sel) {
    const messages = [
        { role: "system", content:
            "A build was attempted for the user's goal but produced no concrete " +
            "files, which almost always means the goal is broad or underspecified. " +
            "Do NOT report failure or say you could not do it. Respond like a capable " +
            "engineer scoping real work: in 4-6 sentences, (1) say plainly what you " +
            "understood the goal to be, (2) ask 1-3 SPECIFIC questions whose answers " +
            "would let you build the first real piece, and (3) name one concrete first " +
            "step you will take once they answer. Be direct and brief; no preamble." },
        { role: "user", content: `GOAL: ${goal}` }
    ];
    try {
        const res = await router.generate(messages, 640, cancelToken, null, { selection: sel });
        const t = String((res && res.content) || "").trim();
        if (t) return t;
    } catch { /* fall through to the honest static ask */ }
    return "That goal is broad enough that I would build the wrong thing if I " +
        "guessed. Tell me the first concrete piece — one screen, one behavior, one " +
        "file — and I will build that, then we iterate from something real.";
}

/** Ask the model for a plan; fall back to a single step if it will not plan. */
async function makePlan(session, goal, cancelToken, sel, checklist) {
    // THE PLAN LEARNS WHAT "FULLY" MEANS. When the workspace holds extracted
    // source material, its own topic list rides with the goal — the measured
    // failure was a plan that decomposed a whole chapter into three vague
    // steps because nothing ever told it the chapter had thirteen sections.
    const contract = checklist ? coverage.planBlock(checklist) : "";
    const messages = [
        { role: "system", content: PLAN_SYSTEM },
        { role: "user", content: `GOAL: ${goal}\n\nThe folder ${session.repoPath} is linked.`
            + contract }
    ];
    // the PLANNER runs on this session's model too — planning on one model
    // and executing on another is two different minds on one job
    const res = await router.generate(messages, PLAN_TOKENS, cancelToken, null,
                                      { selection: sel });
    if (res.error) return { error: res.error };

    // pull the JSON object out of the reply, repairing small-model mistakes
    const m = /\{[\s\S]*\}/.exec(res.content || "");
    let plan = null;
    if (m) {
        const parsed = parseToolJson(m[0]);
        if (parsed && parsed.value && Array.isArray(parsed.value.steps)) plan = parsed.value;
    }
    const cap = sel ? stepCap(sel) : STEP_CAP_LOCAL;
    let steps = (plan && Array.isArray(plan.steps) ? plan.steps : [])
        .filter(s => s && (s.action || s.title))
        .slice(0, cap)
        .map((s, i) => ({
            n: i + 1,
            title: String(s.title || s.action).slice(0, 80),
            action: String(s.action || s.title),
            // Declared dependencies, sanitised: only EARLIER steps count, so a
            // model that emits a cycle or points forward cannot deadlock the
            // wave builder. Absent/!Array -> null, which means "unknown", and
            // unknown is treated as strictly-after-everything (the old order).
            after: Array.isArray(s.after)
                ? [...new Set(s.after.map(Number).filter(x => Number.isInteger(x) && x >= 1 && x <= i))]
                : null
        }));

    // Safety net: a weak model often returns one vague step for something that
    // is inherently several files (the known "static site" case). If the
    // goal names such an artifact and the plan under-delivers, use the known
    // structural default so the orchestrator still decomposes it.
    if (steps.length < 2) {
        const def = siteDefaultPlan(goal);
        if (def) steps = def;
    }
    if (!steps.length) {
        steps = [{ n: 1, title: "Complete the request", action: goal }];
    }
    return { steps };
}

/**
 * Run a goal to completion.
 *
 * onTask({id, n, total, title, status, detail}) streams the task panel.
 * onProgress(info) is the per-generation activity feed (same shape as runTurn).
 * Returns { ok, newMessages, changes } — the caller persists them like a turn.
 */
/**
 * How many steps may be in flight at once.
 *
 * LOCAL is 1 and must stay 1: one llama-server, one resident model, and a
 * second one is what takes the machine down. A node or an API serves
 * concurrent requests, so the width is the point of owning/paying for it.
 * Deliberately modest — the ceiling here is the node's memory and the
 * provider's rate limit, not ambition.
 */
// `sel` is THIS SESSION's resolved driver — undefined keeps the old global
// answer. The rule is unchanged and is the whole point of passing it: the
// width belongs to the model that will actually answer this session, so two
// sessions on the node run wide while two on the local model still queue.
function stepConcurrency(sel) {
    try {
        if (!router.usingRemote(sel)) return 1;
        const lim = typeof router.limits === "function" ? router.limits(sel) : null;
        return lim && lim.node ? 4 : 3;
    } catch { return 1; }
}

/**
 * Cut an ordered plan into waves of mutually independent steps.
 *
 * A step with `after: null` (the planner said nothing) depends on everything
 * before it — so an old-style plan produces one step per wave, which is
 * exactly the previous behaviour. Anything left unplaceable falls into a
 * final sequential tail rather than being dropped.
 */
function buildWaves(steps, width) {
    if (width <= 1) return steps.map(s => [s]);
    const waves = [];
    const doneNs = new Set();
    let pool = [...steps];
    while (pool.length) {
        const ready = pool.filter(s => {
            // `after` UNSET is the same as `after: null` — "no declared
            // dependencies", i.e. strictly after everything before it. The
            // built-in default plans carry no `after` at all, so a strict
            // `=== null` left deps undefined and threw the moment the width
            // was greater than one. Never reachable while the orchestrator was
            // local-only; reachable the moment a session can run on a node.
            const deps = (s.after === null || s.after === undefined)
                ? steps.filter(p => p.n < s.n).map(p => p.n) : s.after;
            return deps.every(d => doneNs.has(d));
        });
        if (!ready.length) {                 // cannot happen after sanitising; be safe
            for (const s of pool) waves.push([s]);
            return waves;
        }
        const wave = ready.slice(0, width);
        waves.push(wave);
        for (const s of wave) doneNs.add(s.n);
        pool = pool.filter(s => !wave.includes(s));
    }
    return waves;
}

/**
 * The audit pass, at the plan's width.
 *
 * A thin seam on purpose: the loop, the reviewers and the repair live in
 * selfAudit, and this hands them the one thing this file owns — how wide the
 * driver may be run. Never fails a build: a review that cannot run reports
 * that it did not run, and the work still reaches the operator with an honest
 * summary rather than being held hostage by its own checker.
 */
async function runAuditPass(session, opts) {
    try {
        // KNOWN GAP, ON PURPOSE: a fleetOffer born inside an audit or Ancient
        // Knowledge forced round is NOT lifted — those turns return into
        // runCycle, not the step loop that carries the offer. The discovery
        // still narrates through onNote, and the offer re-fires on the next
        // turn the tool runs, so nothing is lost but a strip's punctuality.
        return await selfAudit.auditAndRepair(session, opts);
    } catch (err) {
        return { ran: false, rounds: [], remaining: [], contested: [], repaired: [],
                 changes: [], repairChanges: [], pendingApprovals: [], stagedMessages: [],
                 spend: { usd: 0, tokens: 0, calls: 0, priced: false },
                 stopped: "error",
                 summary: `Review did not run: ${String((err && err.message) || err).slice(0, 120)}` };
    }
}

async function runGoal(session, goal, opts = {}) {
    const onTask = typeof opts.onTask === "function" ? opts.onTask : () => {};
    const onProgressOut = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
    // THE GOAL'S OWN STEP TRANSCRIPT. Every step turn, the audit pass and the
    // Ancient Knowledge cycle all narrate through this one funnel — and the
    // step turns' own transcripts are DISCARDED (only the summary message
    // persists), so without recording here an orchestrated build, the longest
    // work this app does, would show no steps at all after a re-render.
    // keepTools=true: unlike a chat turn there are no persisted work rows
    // behind this record, so tool / tool-done lines are kept (see the dedupe
    // choice stated on agent.recordStep).
    const goalSteps = [];
    const goalStartedAt = Date.now();
    const onProgress = (info) => {
        onProgressOut(info);
        agent.recordStep(goalSteps, info.phase, info.detail,
                         Date.now() - goalStartedAt, true);
    };
    const cancelToken = opts.cancelToken || { cancelled: false };
    // the transcript shows what the user actually typed; planning uses the
    // RESOLVED goal (a bare "try again" carries the original build request)
    const planningGoal = opts.planGoal || goal;
    // WHICH MODEL DRIVES THIS WHOLE GOAL — resolved once, before the planner,
    // so the plan, every step, the review and the repair all run on the model
    // this session chose rather than on whatever is globally selected.
    const driveSel = opts.selection !== undefined
        ? opts.selection : router.resolveSelection(session).sel;

    // the user goal is part of THIS turn's transcript — record it up front
    const userMsg = { role: "user", content: goal };
    session.messages.push(userMsg);

    const planId = "plan-" + Date.now();
    onTask({ id: planId, n: 0, total: 0, title: "Planning", status: "running",
             detail: "breaking the goal into steps" });

    // the material's own contents, read once, before anything is planned
    let checklist = null;
    try { checklist = coverage.checklistFor(session.repoPath); } catch { /* no material */ }
    if (checklist) {
        onProgress({ phase: "planning", detail: {
            note: `measuring against ${checklist.items.length} topics in ${checklist.source}` } });
    }
    const planned = await makePlan(session, planningGoal, cancelToken, driveSel, checklist);
    if (planned.error) return { ok: false, error: planned.error };
    if (cancelToken.cancelled) return { ok: false, error: "cancelled", cancelled: true };

    const steps = planned.steps;
    onTask({ id: planId, n: 0, total: steps.length, title: `Plan: ${steps.length} steps`,
             status: "done", detail: steps.map(s => s.title).join(" · ") });

    // TIER 2 — THE INTENT LEDGER. The user's goal (verbatim) and the criteria
    // this build is measured against (the material's own topics, and each plan
    // step) are recorded to a durable flat file the moment they exist — before
    // the model can drift. Per-step verify results land as status updates
    // below. This is what survives when the hot context is compacted; it never
    // sinks the run if it fails (a ledger write is not the work).
    // this goal's id — scopes every criterion to THIS goal, so a later goal in
    // the same session cannot inherit its "done" (the review's collision bug)
    const goalId = "g" + goalStartedAt;
    try {
        const ilDir = require("./paths").intentDir();
        const now = Date.now();
        intentLedger.recordIntent(ilDir, session.id, goalId, planningGoal, now);
        if (checklist) {
            for (const it of checklist.items) {
                intentLedger.recordCriterion(ilDir, session.id, goalId, "cov", it.id, it.title, now);
            }
        }
        for (const st of steps) {
            intentLedger.recordCriterion(ilDir, session.id, goalId, "step", st.n,
                                         st.title || st.action, now);
        }
    } catch { /* the ledger is Tier 2; a write failure never stops the build */ }

    const allChanges = [];
    // the build's tool messages across every step, handed to the Ancient
    // Knowledge cycle so its untested-logic gap sees what ran (and what did not)
    const allMessages = [];
    // a fleet a step's ask_fleet discovered — carried to the goal's return
    // the way a chat turn carries it. Never overwritten by a later step's
    // empty return: an offer made once is an offer kept.
    let fleetOffer = null;
    // Confirm-class actions staged by any step. Keyed by id so a retry that
    // stages the same card twice does not queue two prompts for one action.
    const stagedApprovals = new Map();
    // THE PROPOSAL-BEARING MESSAGES behind those approvals. The in-chat approval
    // CARD renders ONLY from a role:"tool" message carrying `.proposal`
    // (renderer). In stepMode runTurn does not persist its messages, so the
    // staged proposal message lives only in stepRes.newMessages — which this loop
    // used to discard, so the tray notification fired but no card ever appeared
    // and the turn "kept thinking". Carry the messages out too, keyed by
    // proposal id (deduped against retries).
    const stagedMessages = new Map();
    const results = [];
    let done = 0;

    // ONE STEP, END TO END. Extracted verbatim from the old sequential
    // loop so its execute -> critique -> repair semantics are unchanged;
    // it now returns its result instead of pushing it, which is what lets
    // several of them be in flight at once.
    const runOneStep = async (step, builtSnapshot) => {
        if (cancelToken.cancelled) return { cancelled: true, stepChanges: [] };
        const taskId = `${planId}-${step.n}`;
        onTask({ id: taskId, n: step.n, total: steps.length, title: step.title,
                 status: "running", detail: "" });

        // context the step needs: the overall goal, and what already exists so
        // it builds ON prior steps instead of repeating them
        const built = builtSnapshot;
        const baseInstruction =
            `Overall goal: ${planningGoal}\n` +
            (built.length ? `Files already created: ${built.join(", ")}.\n` : "") +
            `YOUR STEP (${step.n}/${steps.length}): ${step.action}\n` +
            "Do exactly this step now by calling the right tool with real, complete content.\n\n" +
            QUALITY_BRIEF;

        // EXECUTE → CRITIQUE → (repair) loop. A step is not "done" until the
        // critic accepts it; a rejected step retries once with the problem fed
        // back. Changes ACCUMULATE by path across attempts (a retry that
        // rewrites the same file overwrites its record; a retry that writes a
        // DIFFERENT path keeps both) so no file the agent actually created is
        // ever dropped from tracking / revert.
        const changeByPath = new Map();
        // the step's tool messages, accumulated across attempts, so the final
        // Ancient Knowledge cycle can tell whether code was written and whether
        // anything ran it (the untested-logic gap the chat path already applies)
        const stepMsgs = [];
        let critique = { pass: false, problem: "" };
        let stepRes = null;
        let stepStaged = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelToken.cancelled; attempt++) {
            const instruction = attempt === 1 ? baseInstruction
                : baseInstruction + `\n\nYour previous attempt was REJECTED: ${critique.problem}. ` +
                  "Fix exactly that and produce the complete, correct file this time.";
            onTask({ id: taskId, n: step.n, total: steps.length, title: step.title,
                     status: "running",
                     detail: attempt > 1 ? `retry ${attempt} — ${critique.problem}` : "" });
            try {
                stepRes = await agent.runTurn(session, instruction, {
                    stepMode: true, cancelToken,
                    // every step of the plan runs on the SAME model the
                    // session chose — resolved once for the whole goal
                    selection: driveSel,
                    preferredFallback: opts.preferredFallback,
                    // the fallback consent question rides through unchanged:
                    // a step turn rerouting to a paid endpoint is the same
                    // spend decision as a chat turn doing it, and without the
                    // hook the router (correctly) refuses to reroute at all
                    approveFallback: opts.approveFallback,
                    approveSecretEgress: opts.approveSecretEgress,
                    onProgress: (info) => onProgress({ ...info, step: step.n })
                });
            } catch (err) {
                stepRes = { ok: false, error: String(err.message || err) };
            }

            // merge this attempt's changes IMMEDIATELY — before any cancel
            // break — so a file written then interrupted is never orphaned
            // (on disk with a backup but no change record, hence no revert)
            for (const c of (stepRes && stepRes.changes) || []) {
                if (c && c.path) changeByPath.set(c.path, c);
            }
            if (stepRes && Array.isArray(stepRes.newMessages)) stepMsgs.push(...stepRes.newMessages);
            // A step may have STAGED a confirm-class action (a delete, a
            // script, a server). runTurn hands those back as pendingApprovals
            // and this loop used to read only `changes` — so the card was
            // built, dropped on the floor, and the plan carried on as though
            // the action had happened. Carry them out to the caller, which is
            // the only thing that can put them in front of a human.
            for (const p of (stepRes && stepRes.pendingApprovals) || []) {
                if (p && p.id) stagedApprovals.set(p.id, p);
            }
            // ...and the message that carries each proposal, so the renderer can
            // actually draw the approval card (stepMode never persisted it).
            for (const m of (stepRes && stepRes.newMessages) || []) {
                if (m && m.proposal && m.proposal.id) stagedMessages.set(m.proposal.id, m);
            }
            if (stepRes && stepRes.fleetOffer) fleetOffer = stepRes.fleetOffer;
            if (cancelToken.cancelled) break;
            // A STAGED APPROVAL ENDS THIS STEP. The action has not run, so there
            // is nothing to critique — and retrying would stage the SAME action
            // again under a fresh id, queuing a second card for one action. Stop
            // the attempt loop here; the plan pauses at the wave level below.
            if ((stepRes && stepRes.pendingApprovals || []).some(p => p && p.id)) {
                stepStaged = true; break;
            }

            onTask({ id: taskId, n: step.n, total: steps.length, title: step.title,
                     status: "running", detail: "verifying…" });
            critique = await critiqueStep(session, step, [...changeByPath.values()],
                                          cancelToken, driveSel);
            // the verdict becomes part of the durable record (meta.steps), so
            // a later read can tell "accepted" from "the critic never looked"
            onProgress({ phase: "verify", detail: {
                summary: step.title,
                failed: !critique.pass,
                reason: critique.pass
                    ? (critique.skipped ? `passed unexamined: ${critique.skipped}` : "passed")
                    : critique.problem } });
            // ...and the same verdict updates this step's criterion in Tier 2,
            // so the ledger's live front knows what is done vs still open
            try {
                const files = [...changeByPath.values()].map(c => c.path).filter(Boolean);
                const il = require("./intentLedger");
                il.recordStatus(require("./paths").intentDir(), session.id,
                    il.criterionId(goalId, "step", step.n),
                    critique.pass ? "done" : "failed", files.join(", "), Date.now());
            } catch { /* Tier 2 write, never fatal */ }
            if (critique.pass) break;
        }

        const stepChanges = [...changeByPath.values()];
        // flush BEFORE honoring a cancel so an interrupted step's real files
        // stay tracked and revertable
        // changes are returned and merged by the caller, in plan order

        if (cancelToken.cancelled) { onTask({ id: taskId, status: "cancelled" });
            return { cancelled: true, stepChanges }; }

        // A STEP THAT STAGED AN ACTION IS WAITING ON A HUMAN, NOT FAILED. It did
        // not run and did not fail — it asked. Say that on its chip (amber, not
        // red), and do not count it toward `done` or feed it back as a problem.
        if (stepStaged) {
            onTask({ id: taskId, n: step.n, total: steps.length, title: step.title,
                     status: "approval", detail: "waiting for your approval" });
            return { staged: true, ok: false, stepChanges,
                     result: { step: step.title, ok: false, staged: true,
                               files: stepChanges.map(c => c.path) } };
        }

        const madeFile = stepChanges.length > 0;
        // "done" now means the critic accepted it (or a terminal step with a
        // clean non-file answer); a step that never passed is honestly failed
        const ok = critique.pass && (madeFile || !expectsFile(step) || step.n === steps.length);

        onTask({ id: taskId, n: step.n, total: steps.length, title: step.title,
                 status: ok ? "done" : "failed",
                 detail: ok
                     ? (madeFile ? stepChanges.map(c => `${c.kind} ${c.path}`).join(", ") : "done")
                     : critique.problem || (stepRes && stepRes.error) || "did not pass verification" });
        return { ok, stepChanges, stepMessages: stepMsgs,
                 result: { step: step.title, ok, problem: ok ? undefined : critique.problem,
                           files: stepChanges.map(c => c.path) } };

    };

    // WAVES. Width 1 for a local model (one resident model: physics), wider
    // for an API or a node, which serve concurrent requests.
    const width = stepConcurrency(driveSel);
    const waves = buildWaves(steps, width);
    if (width > 1 && waves.length < steps.length) {
        onTask({ id: planId, n: 0, total: steps.length,
                 title: `Plan: ${steps.length} steps`, status: "done",
                 detail: `${steps.length} steps in ${waves.length} waves — ` +
                         `up to ${width} at once on ` +
                         `${router.limits(driveSel).node ? "your node" : "the API"}` });
    }

    for (const wave of waves) {
        if (cancelToken.cancelled) break;
        const builtSnapshot = allChanges.map(c => c.path).filter(Boolean);
        const settled = await Promise.all(
            wave.map(step => runOneStep(step, builtSnapshot)
                .catch(err => ({ ok: false, stepChanges: [],
                    result: { step: step.title, ok: false,
                              problem: String((err && err.message) || err), files: [] } }))));
        // merge in PLAN order, not completion order
        for (const r of settled) {
            if (!r) continue;
            if (r.stepChanges && r.stepChanges.length) allChanges.push(...r.stepChanges);
            if (r.stepMessages && r.stepMessages.length) allMessages.push(...r.stepMessages);
            if (r.result) { results.push(r.result); done += r.result.ok ? 1 : 0; }
        }
        if (settled.some(r => r && r.cancelled)) break;
        // A CONFIRM-CLASS ACTION IS STAGED — STOP THE PLAN and hand the human the
        // card, exactly as a single turn stops at a staged tool (agent.js). Left
        // running, the plan would build past an action that never happened and
        // the turn would "keep thinking" until the whole goal finished with the
        // card buried. Stopping here surfaces the approval immediately.
        if (stagedApprovals.size) break;
    }

    // THE AUDIT PASS — the work is attacked before the operator sees it.
    //
    // This runs on the FINISHED whole, which is the only thing the four
    // questions make sense about: a step gate can say "this file exists and is
    // not a stub", and cannot say "the thing you asked for is not here".
    // Reviewers run at the driver's width — the same rule the steps use, from
    // the same function, so there is one concurrency decision in this file.
    // THE REVIEW IS INVOKED, NOT ASSUMED — see sessionPerms.selfReviewOn. A
    // plan that ran on a small local model in a scratch folder should not pay
    // for four reviewers unless this conversation asked to be checked.
    const reviewOn = (() => {
        try {
            const sessionPerms = require("./sessionPerms");
            const paths = require("./paths");
            return sessionPerms.selfReviewOn(session,
                paths.readSettings().selfReview === true);
        } catch { return false; }
    })();
    // ...UNLESS THE PLAN PAUSED FOR AN APPROVAL. A staged confirm-class action
    // stops the plan before its later steps run, so the tree is deliberately
    // INCOMPLETE — auditing it would flag the not-yet-built files as gaps and
    // (on a node/API) spend real money running four reviewers against a partial
    // build. This mirrors the Ancient Knowledge gate below, which already
    // requires stagedApprovals.size === 0 for exactly this reason.
    // THE REVIEWERS ARE TOLD WHAT THE WHOLE JOB WAS. They judge completeness
    // against the REQUEST, so the material's own topic list belongs in it —
    // "did this cover the chapter" is a question only something that can read
    // the artifacts can answer, which is exactly what these reviewers are and
    // exactly what a grep is not (coverage.js records that measurement).
    const auditGoal = checklist
        ? planningGoal + "\n\n" + coverage.contractText(checklist)
        : planningGoal;
    const audit = (reviewOn && stagedApprovals.size === 0) ? await runAuditPass(session, {
        goal: auditGoal, changes: allChanges, width, cancelToken, selection: driveSel,
        onTask, onProgress, planId
    }) : { ran: false, rounds: [], remaining: [], contested: [], repaired: [],
           changes: [], repairChanges: [], pendingApprovals: [], stagedMessages: [],
           spend: { usd: 0, tokens: 0, calls: 0, priced: false },
           stopped: "not-asked-for", summary: "" };
    if (audit.changes && audit.changes.length) {
        const byPath = new Map(allChanges.map(c => [c.path, c]));
        for (const c of audit.changes) if (c && c.path) byPath.set(c.path, c);
        allChanges.length = 0;
        allChanges.push(...byPath.values());
    }
    // an action a repair staged reaches the human, exactly like one a step
    // staged — the approval AND the message that draws its card
    for (const p of audit.pendingApprovals || []) if (p && p.id) stagedApprovals.set(p.id, p);
    for (const m of audit.stagedMessages || []) {
        if (m && m.proposal && m.proposal.id) stagedMessages.set(m.proposal.id, m);
    }

    // one honest summary message for the transcript
    const built = allChanges.filter(c => c.path).map(c => c.path);
    // NO FILES IS NOT A FAILURE MESSAGE — IT IS A QUESTION. See askForClarification.
    const base = cancelToken.cancelled
        ? `Stopped after ${done} of ${steps.length} steps.`
        // A STAGED APPROVAL PAUSED THE PLAN. Say so plainly next to the card, so
        // "no files yet" reads as "waiting on you", not "I gave up / please
        // clarify". Be honest about what approval does: it runs THAT ONE action,
        // exactly like every other confirm-class tool — it does not auto-resume
        // the remaining steps. The operator sends their next message to carry on.
        : stagedApprovals.size
            ? `Paused — an action needs your approval${built.length
                ? ` (${built.length} file(s) so far: ${[...new Set(built)].join(", ")})` : ""}. `
              + `Approve it below to run it, then send your next message to continue the build.`
            : built.length
                ? `Done — ${done}/${steps.length} steps, ${built.length} file(s): ${[...new Set(built)].join(", ")}.`
                : await askForClarification(session, planningGoal, cancelToken, driveSel);
    const summary = base
        // what the review found rides on the SAME message as the claim of
        // completion, so "done" is never read without the caveat next to it
        + (audit.summary ? `\n\n${audit.summary}` : "")
        + (audit.remaining && audit.remaining.length
            ? `\n\nStill open after review:\n${selfAudit.findingsText(audit.remaining)}`
            : "");

    const summaryMsg = {
        role: "assistant",
        content: summary,
        meta: { model: "orchestrator", planSteps: steps.length, files: built.length,
                // THE CONTRACT THIS BUILD WAS MEASURED AGAINST, persisted with
                // the run: what the whole job was, in the material's own words.
                // No coverage NUMBER — see coverage.js on why every grep-scored
                // one misled, including one that ranked the worse build higher.
                coverage: checklist
                    ? { source: checklist.source,
                        topics: checklist.items.map(i => i.id + " " + i.title) }
                    : undefined,
                // THE PLAN ITSELF, PERSISTED. A 922-second build was forensically
                // unreadable because all that survived of its plan was the count
                // "6" — what the model decided to do had no durable home. Titles
                // and actions are capped so the pretty-printed session file
                // never balloons.
                plan: steps.map(st => ({ n: st.n, title: String(st.title).slice(0, 80),
                                         action: String(st.action).slice(0, 240) })),
                // the goal-level step transcript, attached BY REFERENCE — the
                // audit and AK phases recorded after this message is built
                // still land in the same array before anything serializes it.
                // (planSteps was `steps`; nothing read the count, and steps
                // now means the transcript wherever meta is concerned.)
                steps: goalSteps,
                audit: audit.ran ? {
                    rounds: audit.rounds.length, stopped: audit.stopped,
                    repaired: audit.repaired.length, open: (audit.remaining || []).length,
                    contested: (audit.contested || []).length,
                    usd: audit.spend && audit.spend.priced ? audit.spend.usd : 0
                } : undefined }
    };
    // the user goal was already pushed at the start; the staged proposal
    // messages go on the transcript FIRST (so a reload still draws the card),
    // then the summary that explains the pause sits below them.
    if (stagedMessages.size) session.messages.push(...stagedMessages.values());
    session.messages.push(summaryMsg);

    // ------------------------------------------- ANCIENT KNOWLEDGE RUNS HERE
    //
    // It did not, and that was the whole bug. This function drives every step
    // through agent.runTurn with stepMode:true, and runTurn's AK gate opens
    // with `!opts.stepMode` — so on an orchestrated goal the auditor was
    // evaluated zero times. Worse, the two systems' preconditions are the
    // same: AK cannot be switched on without a linked workspace, and
    // `orchestrate` requires one, so the sessions MOST likely to be
    // orchestrated were exactly the sessions that had asked to be audited.
    // The operator turned the brain on, watched a long plan run, and got
    // nothing AK-shaped — while `selfReview`, which the brain toggle quietly
    // co-enables, produced review-looking output that was never asked for.
    //
    // It audits the FINISHED WHOLE, not each step, and that is deliberate.
    // A step critic can say "this file exists and is not a stub"; only the
    // finished thing can be asked "is what the operator actually requested
    // here". A per-step auditor would also multiply the round ceiling by the
    // step count and interrogate work that later steps were always going to
    // complete.
    //
    // The loop itself lives in ancientKnowledge.runCycle — the same loop the
    // chat path runs, with the same verdict grammar, the same stop names and
    // the same ancient_knowledge.md. The only thing this caller supplies is
    // HOW to make the model answer: a fresh turn in stepMode, so runTurn does
    // the work and every gate, and this cycle stays the only auditor.
    let akCycle = null;
    if (session.ancientKnowledge === true && !cancelToken.cancelled
        && stagedApprovals.size === 0) {
        try {
            const ak = require("./ancientKnowledge");
            akCycle = await ak.runCycle(session, {
                userAsk: planningGoal,
                // afterthoughts typed mid-run are part of the ORIGINAL ask
                addenda: opts.addenda || [],
                response: summary,
                changes: allChanges,
                // the build's tool messages, so the untested-logic gap fires on an
                // orchestrated build too, not only on the chat path
                messages: allMessages,
                cancelToken,
                auditorSelection: opts.auditorSelection,
                driverSelection: driveSel,
                budgetUsd: typeof opts.akBudgetUsd === "number"
                    ? opts.akBudgetUsd : undefined,
                onProgress,
                // ONTO THE TRANSCRIPT AS THEY HAPPEN, not at the end. The
                // forced response below is a fresh turn built from session
                // history — so if round 1's audit and answer are not on the
                // transcript by the time round 2 runs, round 2 sees the same
                // history round 1 saw and re-attempts the same fix. That is a
                // model looping unguided, which is the thing being fixed here.
                onMessages: (ms) => session.messages.push(...ms),
                respond: (gaps, round, spin) => agent.runTurn(
                    session, ak.forceInstruction(gaps, round, spin), {
                        // stepMode: this cycle is the auditor, so the forced
                        // turn must not start a second one inside itself. It
                        // also keeps runTurn from persisting the instruction
                        // as a user message the operator never typed —
                        // onMessages above puts the ANSWER on the record.
                        stepMode: true, cancelToken, selection: driveSel,
                        // a FORCED round is Ancient Knowledge's spend, not the
                        // user's — without this tag the ledger booked it
                        // via:"user" and AK's true cost was understated
                        ledgerVia: "ancient-knowledge",
                        preferredFallback: opts.preferredFallback,
                        approveFallback: opts.approveFallback,
                        approveSecretEgress: opts.approveSecretEgress,
                        onProgress: (info) => onProgress({ ...info, akRound: round })
                    })
            });
            if (akCycle.changes && akCycle.changes.length) {
                const byPath = new Map(allChanges.map(c => [c.path, c]));
                for (const c of akCycle.changes) if (c && c.path) byPath.set(c.path, c);
                allChanges.length = 0;
                allChanges.push(...byPath.values());
            }
            for (const p of akCycle.pendingApprovals || []) {
                if (p && p.id) stagedApprovals.set(p.id, p);
            }
            // NOT pushed here — onMessages above already put every one of them
            // on the transcript, in order, as the cycle produced them.
        } catch { /* the audit must never take the work down with it */ }
    }

    // AK'S FORCED ROUND CAN STAGE AN ACTION AFTER THE SUMMARY WAS WRITTEN. The
    // summary is built before AK, and AK only runs when nothing was staged yet
    // (the gate above) — so a summary written then necessarily said "Done". If
    // AK went on to stage a confirm-class action, correct the record in place
    // (summaryMsg is the same object in the transcript and the returned delta),
    // so it does not claim completion above a card that is waiting on the
    // operator. The proposal message itself rides out in akCycle.messages.
    if (akCycle && stagedApprovals.size > 0) {
        summaryMsg.content =
            "Paused — an action from the review needs your approval before it runs. "
            + "Approve it below, then send your next message to continue.\n\n"
            + summaryMsg.content;
    }

    if (allChanges.length) {
        session.changes = [...(session.changes || []), ...allChanges].slice(-200);
    }

    // both bubbles go to the client — it renders from the returned delta.
    // pendingApprovals rides along so a confirm-class action staged inside a
    // planned build reaches a human instead of being discarded with the step.
    return { ok: true,
             newMessages: [userMsg, ...stagedMessages.values(), summaryMsg,
                           ...(akCycle ? akCycle.messages : [])],
             changes: allChanges,
             pendingApprovals: [...stagedApprovals.values()],
             plan: steps, results,
             fleetOffer: fleetOffer || undefined,
             ancientKnowledge: akCycle
                 ? { ran: akCycle.ran, rounds: akCycle.rounds,
                     stopped: akCycle.stopped, usd: akCycle.usd }
                 : undefined };
}

module.exports = { runGoal, makePlan, looksMultiStep, resolveGoal, critiqueStep,
                   expectsFile, stepConcurrency, stepCap, runAuditPass,
                   askForClarification };
