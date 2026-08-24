/**
 * PER-SESSION MODEL ROUTING — proven by driving real turns, not by asserting
 * that a field was set.
 *
 * The defect this fixes: `lcl:setSessionModel` stored the choice on the session
 * and NOTHING read it. Routing went through one global driver, so the
 * per-session choice was written to disk and silently ignored — switching
 * sessions did not switch the model.
 *
 * So this suite stands up TWO fake OpenAI-compatible endpoints on loopback,
 * links both, and runs a real agent turn in each of three sessions. What is
 * asserted is which SERVER received the request — the only evidence that
 * cannot be faked by the app agreeing with itself.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-sessmodel-"));
require.cache[__filename] = { exports: {
    // isPackaged: TRUE, deliberately — in dev mode paths.dataDir() resolves
    // to the REPO's shared data/ directory, so the endpoints this suite links
    // and the driver it sets would land in the developer's own settings and
    // cloud-endpoints store. Packaged mode routes through getPath, which is
    // this run's throwaway directory.
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 240) : ""); }
}
setTimeout(() => {
    console.log(`\n${pass}/${pass + fail + 1} session-model checks passed (TIMED OUT)`);
    process.exit(1);
}, 60000).unref();

const ROOT = path.join(__dirname, "..");
// The endpoints this suite links land in this run's throwaway data dir (see
// the packaged-mode stub above), so there is nothing to snapshot or put back.

const cloud = require(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"));
const router = require(path.join(ROOT, ".lcl.engine", "core", "router.js"));
const engine = require(path.join(ROOT, ".lcl.engine", "core", "engine.js"));
const paths = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));

/* ---- two endpoints, each announcing which one it is ---- */
function fakeEndpoint(name, modelId, ctxLen) {
    const hits = [];
    const srv = http.createServer((req, res) => {
        let body = "";
        req.on("data", c => { body += c; });
        req.on("end", () => {
            if (req.url.includes("/models")) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ data: [
                    { id: modelId, context_length: ctxLen, max_tokens: 4096 }] }));
            }
            let asked = null;
            try { asked = JSON.parse(body).model; } catch { /* not json */ }
            hits.push({ model: asked, at: Date.now() });
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ choices: [{ delta:
                { content: `answered by ${name}` } }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    return { name, modelId, hits, srv,
             listen: () => new Promise(r => srv.listen(0, "127.0.0.1", r)),
             url: () => `http://127.0.0.1:${srv.address().port}` };
}

const A = fakeEndpoint("alpha", "model-alpha", 100000);
const B = fakeEndpoint("beta", "model-beta", 200000);

(async () => {
    await A.listen(); await B.listen();
    paths.writeSettings({ networkEnabled: true });

    // Linked with explicit ids, the way a node link does. (connect() derives
    // the id from the HOSTNAME, so two servers on 127.0.0.1 would collapse into
    // one record — real, pre-existing, and not what this suite is measuring.)
    cloud.linkEndpoint({ id: "alpha", label: "Alpha", baseUrl: A.url(),
        models: [{ id: A.modelId, contextLength: 100000, maxTokens: 4096 }] });
    cloud.linkEndpoint({ id: "beta", label: "Beta", baseUrl: B.url(),
        models: [{ id: B.modelId, contextLength: 200000, maxTokens: 4096 }] });

    const eps = cloud.endpoints();
    const epA = eps.find(e => e.id === "alpha"), epB = eps.find(e => e.id === "beta");
    check("two distinct endpoints exist", !!epA && !!epB && epA.id !== epB.id,
        eps.map(e => e.id));

    // the APP DEFAULT is Alpha
    cloud.selectModel({ endpointId: epA.id, model: A.modelId, enabled: true });
    check("the app default is Alpha", cloud.selected().id === epA.id);

    /* ------------------------------------------------------------------
     * 1. THE ACTUAL DEFECT: does a session's stored choice route the call?
     * ---------------------------------------------------------------- */
    const sesDefault = { id: "s-default", messages: [] };
    const sesBeta = { id: "s-beta", messages: [], modelSel: { endpointId: epB.id, model: B.modelId } };

    // NO CHOICE MEANS THIS MACHINE. The old contract routed a never-chose
    // session onto the global roles.driver — a paid remote model as the silent
    // default of every new conversation ("you still have Qwen3.7 Max loading
    // as the default model"). The default is the LOCAL engine now, always;
    // remote is a per-conversation choice or an explicit orchestration role.
    {
        const rDef = cloud.resolveSelection(sesDefault);
        check("a session that never chose resolves to the LOCAL engine even " +
              "while a global driver role points at a paid endpoint",
            rDef.sel === null && rDef.source === "default", rDef);
    }

    A.hits.length = 0; B.hits.length = 0;
    await router.generate([{ role: "user", content: "hi" }], 32, null, null,
        { selection: router.resolveSelection(sesBeta).sel });
    check("a session that CHOSE Beta is answered by BETA — the choice is read, " +
          "not merely stored (this is the defect: it was written and ignored)",
        B.hits.length === 1 && A.hits.length === 0, { alpha: A.hits.length, beta: B.hits.length });
    check("...and the model asked for is Beta's model, not Alpha's",
        B.hits[0] && B.hits[0].model === B.modelId, B.hits[0]);

    /* two sessions with their OWN choices, alternating, no restart and no
     * re-linking between them */
    const sesAlphaEarly = { id: "s-alpha-early", messages: [],
                            modelSel: { endpointId: epA.id, model: A.modelId } };
    A.hits.length = 0; B.hits.length = 0;
    for (const s of [sesAlphaEarly, sesBeta, sesAlphaEarly, sesBeta]) {
        await router.generate([{ role: "user", content: "hi" }], 32, null, null,
            { selection: router.resolveSelection(s).sel });
    }
    check("SWITCHING SESSIONS SWITCHES THE MODEL — four alternating turns land " +
          "two on each endpoint, with no restart and no re-linking",
        A.hits.length === 2 && B.hits.length === 2, { alpha: A.hits.length, beta: B.hits.length });

    /* ------------------------------------------------------------------
     * 2. INHERIT-UNLESS-SET: changing the default moves the sessions that
     *    never chose, and leaves the ones that did alone.
     * ---------------------------------------------------------------- */
    cloud.selectModel({ endpointId: epB.id, model: B.modelId, enabled: true });
    A.hits.length = 0; B.hits.length = 0;
    {
        const rDef2 = cloud.resolveSelection(sesDefault);
        check("changing the global role does NOT move a session that never " +
              "chose — it stays on the local engine; the roles serve " +
              "escalation and the reasoner, not silent defaults",
            rDef2.sel === null && rDef2.source === "default"
            && A.hits.length === 0 && B.hits.length === 0, rDef2);
    }

    const sesAlpha = { id: "s-alpha", messages: [], modelSel: { endpointId: epA.id, model: A.modelId } };
    A.hits.length = 0; B.hits.length = 0;
    await router.generate([{ role: "user", content: "hi" }], 32, null, null,
        { selection: router.resolveSelection(sesAlpha).sel });
    check("...and does NOT move a session that made its own choice",
        A.hits.length === 1 && B.hits.length === 0, { alpha: A.hits.length, beta: B.hits.length });
    cloud.selectModel({ endpointId: epA.id, model: A.modelId, enabled: true });   // back to Alpha

    /* ------------------------------------------------------------------
     * 3. A LOCAL session, while the default is remote.
     * ---------------------------------------------------------------- */
    let localCalls = 0;
    const realEngineGenerate = engine.generate;
    engine.generate = async () => { localCalls++; return { content: "local answer" }; };
    const sesLocal = { id: "s-local", messages: [], modelSel: { local: "some-local-model" } };
    A.hits.length = 0; B.hits.length = 0;
    await router.generate([{ role: "user", content: "hi" }], 32, null, null,
        { selection: router.resolveSelection(sesLocal).sel });
    check("a session pinned to LOCAL is answered by the local engine even while " +
          "the app default is a remote endpoint",
        localCalls === 1 && A.hits.length === 0 && B.hits.length === 0,
        { localCalls, alpha: A.hits.length });
    engine.generate = realEngineGenerate;

    /* ------------------------------------------------------------------
     * 4. THE CONCURRENCY RULE, PER SESSION.
     * ---------------------------------------------------------------- */
    const orch = require(path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"));
    check("a session on a LOCAL model still runs one step at a time — a second " +
          "resident model is what takes the machine down",
        orch.stepConcurrency(null) === 1, orch.stepConcurrency(null));
    check("a session on an API runs wide",
        orch.stepConcurrency(router.resolveSelection(sesBeta).sel) > 1,
        orch.stepConcurrency(router.resolveSelection(sesBeta).sel));
    check("...so two sessions on different drivers get different widths AT THE " +
          "SAME TIME — the rule is per session, not per app",
        orch.stepConcurrency(null) === 1 &&
        orch.stepConcurrency(router.resolveSelection(sesBeta).sel) > 1);

    /* limits follow the session's model too */
    const limLocal = router.limits(null);
    const limBeta = router.limits(router.resolveSelection(sesBeta).sel);
    check("limits are sized to the model that will answer THIS session",
        limLocal.kind === "local" && limLocal.maxSteps === 4 &&
        limBeta.kind === "remote" && limBeta.maxSteps > 4,
        { local: limLocal.maxSteps, beta: limBeta.maxSteps });
    check("a session's limits reflect ITS endpoint's published window, not the " +
          "default's (Beta publishes 200k, Alpha 100k)",
        router.limits(router.resolveSelection(sesBeta).sel).contextLength === 200000 &&
        router.limits(router.resolveSelection(sesAlpha).sel).contextLength === 100000);

    /* ------------------------------------------------------------------
     * 5. WHAT IS ANSWERING — one source, so surfaces cannot disagree.
     * ---------------------------------------------------------------- */
    const amBeta = router.activeModel(router.resolveSelection(sesBeta).sel);
    const amAlpha = router.activeModel(router.resolveSelection(sesAlpha).sel);
    check("activeModel names THIS session's model",
        amBeta.id === B.modelId && amAlpha.id === A.modelId, { amBeta, amAlpha });
    check("and usingRemote answers per session, not per app",
        router.usingRemote(router.resolveSelection(sesBeta).sel) === true &&
        router.usingRemote(router.resolveSelection(sesLocal).sel) === false);

    /* ------------------------------------------------------------------
     * 6. A CHOICE THAT CANNOT BE HONOURED falls back and SAYS SO.
     * ---------------------------------------------------------------- */
    const sesGone = { id: "s-gone", messages: [],
                      modelSel: { endpointId: "endpoint-that-was-unlinked", model: "x" } };
    const r = cloud.resolveSelection(sesGone);
    check("a session whose endpoint was unlinked falls back to the LOCAL " +
          "engine — never to a different remote machine the operator did " +
          "not pick",
        r.sel === null && r.source === "fallback", r);
    check("...and reports that its choice is missing, so the row can say so " +
          "instead of quietly answering from somewhere else",
        r.source === "fallback" && !!r.missing &&
        r.missing.endpointId === "endpoint-that-was-unlinked", r);

    /* legacy scalar choices, written before this existed, are still honoured */
    const legacyRemote = cloud.resolveSelection({ modelSel: `api:${epB.id}|${B.modelId}` });
    check("a choice stored in the OLD scalar format still routes — those were " +
          "real choices and are not discarded because the format moved on",
        !!legacyRemote.sel && legacyRemote.sel.id === epB.id, legacyRemote);
    const legacyLocal = cloud.resolveSelection({ modelSel: "qwen-something" });
    check("...including an old local pick", legacyLocal.sel === null &&
        legacyLocal.source === "session", legacyLocal);

    /* ------------------------------------------------------------------
     * 7. THE GLOBAL DEFAULT IS NOT REPLACED — requirement 7.
     * ---------------------------------------------------------------- */
    check("the global role selection still works exactly as before",
        cloud.selected() && cloud.selected().id === epA.id &&
        cloud.selectedFor("driver").model === A.modelId);
    check("and a no-argument router call still answers about the app default, " +
          "so every caller that never learned about sessions is untouched",
        router.usingRemote() === true && router.activeModel().id === A.modelId);

    /* ---- the wiring, pinned ---- */
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
    const agentSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
    const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");

    check("the turn resolves the session's model ONCE and threads it through — " +
          "one convention for `selection` at every hop, so no caller can hand " +
          "the next one a differently-shaped object",
        /const sel = opts\.selection !== undefined[\s\S]{0,80}router\.resolveSelection\(session\)\.sel;/.test(agentSrc) &&
        /const limits = LIMITS\(sel\)/.test(agentSrc) &&
        /selection: sel,/.test(agentSrc) &&
        /const driveSel = opts\.selection !== undefined/.test(
            fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"), "utf8")));
    check("the identity sentence names the model answering THIS session",
        /function systemPrompt\(workspacePath, tools = TOOLS, sel\)/.test(agentSrc) &&
        /router\.usingRemote\(sel\) \? router\.activeModel\(sel\)/.test(agentSrc));
    check("picking a model for one conversation does not change the app default",
        /if \(scope !== "session" && cloudModels\.config\(\)\.enabled\)/.test(mainSrc) &&
        /window\.lcl\.setModel\(id, active \? "session" : null\)/.test(appSrc));
    check("the session's chosen LOCAL model is made resident before its turn — " +
          "one machine, one llama-server, so the wrong model would otherwise answer",
        /async function loadLocalModel/.test(mainSrc) &&
        /if \(loaded !== want\)/.test(mainSrc));
    check("the picker, the status line and the cost meter all ask about the " +
          "SAME session, so they cannot disagree",
        /window\.lcl\.listModels\(active \? active\.id : null\)/.test(appSrc) &&
        /window\.lcl\.cloudState\(active \? active\.id : null\)/.test(appSrc) &&
        /window\.lcl\.estimateCost\(composer\.value, contextTokensGuess,\s*\n?\s*active \? active\.id : null\)/.test(appSrc));
    check("switching sessions repaints instead of re-applying a global model",
        !/switchModel\(active\.modelSel\)/.test(appSrc) &&
        /Switching sessions is a repaint now/.test(appSrc));
    check("a session can go BACK to the app default, and the control is styled " +
          "in the existing token system",
        /Follow the app default/.test(appSrc) && /\.model-inherit \{/.test(cssSrc) &&
        /var\(--sp-1\)/.test(cssSrc.slice(cssSrc.indexOf(".model-inherit {"),
                                          cssSrc.indexOf(".model-inherit {") + 200)));
    check("the ledger row is written per call from the endpoint that answered",
        /endpoint: result\.endpoint/.test(agentSrc) && /model: result\.model/.test(agentSrc));

    /* ==================================================================
     * EVERY HOP, NOT MOST OF THEM.
     *
     * Each check below is a leak an adversarial review found in the first cut:
     * a place that still asked the APP DEFAULT while the session's own model
     * was resolved and in scope. A conversation pinned to the local engine was
     * having its file contents sent to a paid endpoint once per plan step.
     * ================================================================ */
    const auditSrc = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "selfAudit.js"), "utf8");
    const orchSrc2 = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"), "utf8");
    const visionSrc = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "visionTool.js"), "utf8");

    check("the REVIEW PANEL runs on the session's model — the selection is " +
          "forwarded to the loop, not dropped between two hops",
        /selection: opts\.selection,[\s\S]{0,40}budgetUsd/.test(auditSrc));
    check("the PER-STEP CRITIC runs on the session's model — it took no " +
          "selection at all, so a local-pinned session paid a remote endpoint " +
          "once per step",
        /async function critiqueStep\(session, step, changes, cancelToken = \{\}, sel\)/.test(auditSrc) &&
        /CRITIQUE_TOKENS, cancelToken,[\s\S]{0,90}selection: sel/.test(auditSrc) &&
        /cancelToken, driveSel\);/.test(orchSrc2));
    check("the review BUDGET asks whether THIS session's endpoint is billed",
        /function willBeBilled\(sel\)/.test(auditSrc) &&
        /willBeBilled\(opts\.selection\)/.test(auditSrc));
    check("VISION asks this session's driver before deciding local-vs-node",
        /function visionDriver\(sessionSel\)/.test(visionSrc) &&
        /selection: ctx\.selection/.test(visionSrc));
    check("the ORCHESTRATE GATE asks this session's driver — a frontier session " +
          "must not be pushed into the small-model step machine because the " +
          "APP default happens to be local",
        // The gate grew two deliberate carve-outs: an owned NODE runs the step
        // machine (the Spark was bought for agents; the bare !usingRemote gate
        // was starving it), and an API driver runs it too UNLESS the operator
        // turned agent mode off (default-on now, §6d) — read through the
        // EFFECTIVE permission so an unset session inherits the default.
        /orchestrator\.looksMultiStep\(text, s\)[\s\S]{0,140}!router\.usingRemote\(drive\.sel\)\s*\|\|\s*driveIsNode\s*\|\|\s*apiAgentMode/.test(mainSrc)
        && /sessionPerms\.forSession\(s\)\.agentMode === true/.test(mainSrc));
    check("the direct-turn audit runs at the width of the model that will " +
          "answer it",
        /width: orchestrator\.stepConcurrency\(drive\.sel\)/.test(mainSrc));

    /* ---- residency: the queue orders generations, not which model is loaded ---- */
    check("a turn that named a local model HOLDS residency for its whole length " +
          "— otherwise another session's load lands between two tool calls and " +
          "answers the rest of the turn",
        /* THE GATE MOVED, AND THAT IS THE POINT.
         *
         * It lived in the main-process file, where the only thing that could
         * test it was a regex — and the regex below matched the exact line that
         * deadlocked. It is a module now, driven for real by tests/residency.js.
         * This pin covers the WIRING; that suite covers the behaviour. */
        /require\("\.\.\/\.lcl\.engine\/core\/residency"\)/.test(mainSrc) &&
        /releaseResidency = await holdLocalResidency\(want\)/.test(mainSrc) &&
        /if \(releaseResidency\) \{ try \{ releaseResidency\(\); \}/.test(mainSrc));
    check("turns wanting the SAME model share residency instead of queueing " +
          "behind each other for no reason",
        (() => {
            const px = require("path");
            const { createResidency } = require(
                px.join(__dirname, "..", ".lcl.engine", "core", "residency.js"));
            // driven, not grepped: the old pin matched the joining branch that
            // leaked, so it certified the deadlock
            const R = createResidency();
            let joined = false;
            return R.hold("m").then(a =>
                R.hold("m").then(b => {
                    joined = R.state().holders === 2;
                    a(); b();
                    return joined && R.state().holders === 0
                        && R.state().model === null;
                }));
        })());
    check("a model that could not be loaded is REPORTED, never quietly " +
          "substituted — the recovery keeps the machine usable, it does not " +
          "answer this conversation",
        /if \(r && r\.recovered\)/.test(mainSrc) &&
        /could not be loaded on this machine right/.test(mainSrc));
    check("a session's local pick does not become the MACHINE's default model " +
          "for every future session and every restart",
        /const priorModelPath = paths\.readSettings\(\)\.modelPath/.test(mainSrc) &&
        /paths\.writeSettings\(\{ modelPath: priorModelPath \}\)/.test(mainSrc));
    check("a legacy scalar choice is honoured by the residency check too, not " +
          "only by the router",
        /if \(typeof raw === "string"\) return raw\.startsWith\("api:"\) \? null : raw;/.test(mainSrc));

    /* ---- the surfaces ---- */
    check("the picker button and the sidebar label read the SESSION's model, " +
          "not the running one — a chosen local model that has not loaded yet " +
          "was being labelled with the resident model's name and plan",
        /sessionModelState = ses;/.test(appSrc) &&
        /modelPickBtn\.title = ses\.kind === "local"/.test(appSrc) &&
        /\$\("engine-label"\)\.innerText = ses/.test(appSrc));
    check("...and a remote pick is named, not labelled with the literal string " +
          "'api' — which a node is not",
        /shortName\(ses\.model\)/.test(appSrc));
    check("a NEW session repaints every model surface, so it never opens " +
          "showing the previous conversation's model",
        /refreshModelPick\(\);[\s\S]{0,90}setModelStatus\(\);[\s\S]{0,60}refreshCostMeter\(\);[\s\S]{0,40}await refreshSessions\(\)/.test(appSrc));
    check("a choice that can no longer be honoured is stated in the picker " +
          "instead of silently ticking a model nobody chose",
        /sessionModelState && sessionModelState\.missing/.test(appSrc) &&
        /\.model-group\.grp-missing \{/.test(cssSrc));
    check("a local pick that FAILED to load is undone, so the conversation is " +
          "not pinned to a model that cannot start",
        /active\.modelSel = null;[\s\S]{0,120}setSessionModel\(active\.id, null\)/.test(appSrc));

    /* ==================================================================
     * 8. THE CONTEXT A SESSION CARRIES HAS TO FIT THE WINDOW IT IS SENT INTO.
     *
     * The operator, after the install:
     *
     *   "so clearly the context of the other sessions, is what is killing the
     *    service.. so in a session with no context yet, or workspace it can
     *    work."
     *
     * MEASURED, driving this loop against the real engine argv before the fix:
     *
     *     fresh session, no folder linked      1,578 prompt tokens   answered
     *     fresh session, folder linked         4,463 prompt tokens   REFUSED
     *     folder + 20 turns of history         7,760 prompt tokens   REFUSED
     *
     * because buildModelMessages trims by MESSAGE COUNT (12 for a local model)
     * and nothing converted that to tokens or compared it with the window
     * llama-server was started with. That window is not a constant: the planner
     * picks it from free memory, 4096 / 8192 / 16384. llama.cpp b10107 ships
     * with context shift disabled (its own --help), so the over-long prompt is
     * refused outright rather than truncated.
     * ================================================================== */
    const agent = require(path.join(ROOT, ".lcl.engine", "core", "agent.js"));

    /* ---- the budget itself, exercised rather than asserted about ---- */
    const bigMsg = (n) => ({ role: "user", content: "x".repeat(n) });
    const built = [
        { role: "system", content: "S".repeat(3000) },   // ~1000 tokens at 3.0
        bigMsg(3000), bigMsg(3000), bigMsg(3000), bigMsg(3000),
        { role: "user", content: "the question just typed" }
    ];
    const fitted = agent.fitToWindow(built, { window: 4096, replyTokens: 1536 });
    check("the prompt is FITTED to the window: oldest turns leave, and the count " +
          "of what left is reported rather than dropped silently",
        fitted.fits && fitted.droppedMessages > 0 &&
        fitted.promptTokens + fitted.replyTokens <= 4096,
        { dropped: fitted.droppedMessages, prompt: fitted.promptTokens,
          reply: fitted.replyTokens, window: fitted.window });
    check("...the system contract is never a candidate — dropping it would take " +
          "every tool's help text with it and the model would lose the ability " +
          "to call tools halfway through a conversation",
        fitted.messages[0] === built[0]);
    check("...and neither is the message the user just typed",
        fitted.messages[fitted.messages.length - 1] === built[built.length - 1]);
    check("an unfitted prompt of the same shape would NOT have fitted — this is " +
          "the defect, in numbers",
        agent.promptTokensOf(built) + 1536 > 4096,
        { unfitted: agent.promptTokensOf(built) });
    const hopeless = agent.fitToWindow(
        [{ role: "system", content: "S".repeat(20000) }, { role: "user", content: "hi" }],
        { window: 4096, replyTokens: 1536 });
    check("a prompt that cannot fit even with NO history is refused HERE, with " +
          "the numbers, instead of being sent to be refused by the engine with " +
          "'invalid response from engine'",
        hopeless.fits === false, hopeless);
    const unknown = agent.fitToWindow(built, { window: null, replyTokens: 1536 });
    check("an unknown window never becomes a reason to refuse a turn that would " +
          "have worked — no window, no budget, send it as built",
        unknown.fits === true && unknown.messages.length === built.length);

    /* ---- and now through the REAL turn, with the REAL assembly ---- */
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ctx-ws-"));
    fs.writeFileSync(path.join(WS, "notes.md"), "# darkroom log\n".repeat(20));
    const heavy = [];
    for (let i = 0; i < 20; i++) {
        heavy.push({ role: "user", content: `step ${i}: log the fixer temperature` });
        heavy.push({ role: "assistant", content: "Reading it now." });
        heavy.push({ role: "tool", name: "read_file",
            content: JSON.stringify({ path: "notes.md", content: "x".repeat(3800) }) });
        heavy.push({ role: "assistant", content: "Logged. 24 C for the whole batch." });
    }

    const WINDOW = 8192;
    const realWindow = engine.contextWindow;
    const realGen = engine.generate;
    engine.contextWindow = () => WINDOW;
    let sentMsgs = null, sentMax = 0;
    engine.generate = async (msgs, maxTokens) => {
        sentMsgs = msgs; sentMax = maxTokens;
        return { content: "the fixer is at 24 C" };
    };

    const worked = { id: "s-heavy", repoPath: WS, messages: heavy };
    const turn = await agent.runTurn(worked, "what temperature is the fixer at?",
        { selection: null, onProgress: () => {} });
    const sentTokens = agent.promptTokensOf(sentMsgs || []);
    check("A SESSION CARRYING CONTEXT NOW FITS THE WINDOW IT IS SENT INTO. This " +
          "is the operator's hang: the same session used to arrive at the engine " +
          "over-length and be refused, and the app reported that as 'invalid " +
          "response from engine' or as a load that never finished",
        turn.ok === true && sentTokens + sentMax <= WINDOW,
        { promptTokens: sentTokens, maxTokens: sentMax, window: WINDOW });
    const unfittedTokens = agent.promptTokensOf(agent.buildModelMessages(
        agent.systemPrompt(WS, agent.effectiveTools({ workspace: true }), null),
        [...heavy, { role: "user", content: "what temperature is the fixer at?" }],
        { historyWindow: 12 }));
    check("...and the SAME assembly without the budget would have overrun it, " +
          "which is what shipped",
        unfittedTokens + 1536 > WINDOW,
        { unfitted: unfittedTokens, window: WINDOW });
    check("the reply still has real room — an answer squeezed to nothing is not " +
          "an answer, so history leaves before the reply budget does",
        sentMax >= agent.MIN_REPLY_TOKENS, sentMax);
    check("a session with NO history and NO folder is untouched by any of this — " +
          "it always worked and it still sends everything it has",
        (await (async () => {
            const fresh = { id: "s-fresh", repoPath: null, messages: [] };
            await agent.runTurn(fresh, "what temperature is the fixer at?",
                { selection: null, onProgress: () => {} });
            return sentMsgs.length === 2;      // system + the question
        })()), sentMsgs && sentMsgs.length);

    /* ---- the engine counts; this file estimates. The engine wins. ---- */
    let calls = 0;
    const seenSizes = [];
    engine.generate = async (msgs) => {
        calls++;
        seenSizes.push(agent.promptTokensOf(msgs));
        if (calls === 1) {
            // the engine's own count, higher than the estimate because tool
            // results are JSON and JSON tokenizes worse than prose
            return { error: "request (7000 tokens) exceeds the available context size " +
                            "(8192 tokens), try increasing it",
                     contextOverflow: { promptTokens: 7000, windowTokens: 8192 } };
        }
        return { content: "the fixer is at 24 C" };
    };
    const retried = await agent.runTurn(
        { id: "s-refit", repoPath: WS, messages: heavy },
        "what temperature is the fixer at?", { selection: null, onProgress: () => {} });
    check("WHEN THE ENGINE DISAGREES WITH THE ESTIMATE, THE ENGINE IS RIGHT. It " +
          "reports the real token count with its refusal, so the turn re-fits " +
          "against measured arithmetic and sends again instead of dying",
        retried.ok === true && calls === 2 && seenSizes[1] < seenSizes[0],
        { calls, seenSizes });

    /* ---- work that happened is not erased by a generation that failed ---- */
    let genCalls = 0;
    engine.generate = async () => {
        genCalls++;
        if (genCalls === 1) return { content: "let me work that out" };
        return { error: "Not enough free memory. Even running entirely on the CPU " +
                        "this model needs about 3.1 GB", guard: true };
    };
    const donkey = await agent.runTurn(
        { id: "s-donkey", repoPath: null, messages: [] },
        "what is 1234*5678", { selection: null, onProgress: () => {} });
    check("WORK THAT RAN IS NOT ERASED BY A GENERATION THAT FAILED AFTERWARDS. " +
          "'asked for an image of a donkey, got a refusal about closing apps to " +
          "free memory': generate_image unloads the model, renders, and then the " +
          "RECAP has to load it back — and when the planner refused that reload " +
          "the turn returned ok:false, so the finished PNG, the change record and " +
          "the tool result were all thrown away and a memory sentence was all the " +
          "operator saw",
        donkey.ok === true &&
        (donkey.newMessages || []).some(m => m.role === "tool" && !m.failed),
        { ok: donkey.ok, error: donkey.error,
          roles: (donkey.newMessages || []).map(m => m.role) });
    const notice = (donkey.newMessages || []).find(m => m.meta && m.meta.guard);
    check("...and what failed is said in the MACHINE's voice, marked so a surface " +
          "can render it as the machine rather than as the model's answer",
        !!notice && /this machine, not the model/i.test(notice.content) &&
        notice.meta.guardKind === "memory", notice && notice.content);
    check("a guard failure with NO work behind it still fails the turn, tagged, " +
          "so nothing has to read the sentence to know where it came from",
        await (async () => {
            engine.generate = async () => ({ error: "Not enough free memory.", guard: true });
            const r = await agent.runTurn({ id: "s-guard", repoPath: null, messages: [] },
                "hello there", { selection: null, onProgress: () => {} });
            return r.ok === false && r.guard === true && r.guardKind === "memory";
        })());

    engine.generate = realGen;
    engine.contextWindow = realWindow;
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* held */ }

    A.srv.close(); B.srv.close();
    console.log(`\n${pass}/${pass + fail} session-model checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error("HARNESS ERROR:", e && e.stack || e);
    try { A.srv.close(); B.srv.close(); } catch { /* already down */ }
    process.exit(1);
});
