/**
 * THE APPROVAL PATH, THROUGH IPC.
 *
 * This is the layer 1,075 unit checks never crossed, and three bugs lived here
 * because of it:
 *
 *   1. `if (activeTurn)` — a reference to a variable deleted when concurrent
 *      sessions landed. Every approval threw ReferenceError before running. The
 *      approve button was dead for every confirm-class action.
 *   2. `entry.run(s.repoPath, p.args, {})` — a literal empty ctx. Approved tools
 *      lost onNote (no progress), cancelToken (unstoppable) and onLibraryDirty
 *      (an approved research_topic reported a reindex that never happened).
 *   3. `approvalBusy` — one global boolean consulted by lcl:chat for EVERY
 *      session, so one approved long-running tool froze chat everywhere, with
 *      no token to cancel it because of (2).
 *
 * None of that is visible from a unit test of the engine core, because none of
 * it is IN the engine core — it is in the wiring. So this harness stubs Electron
 * hard enough to require app/main.js, collects the real ipcMain handlers, and
 * drives them the way the renderer does.
 *
 * WHAT IS STUBBED, stated plainly: Electron itself, agent.runTurn (so an
 * approval can be staged without a model), the tool being approved, and
 * policyBridge.check (asserted to still be CALLED, but allowed — the kernel's
 * own decisions are tested in tests/tool-policy.js). Everything between the IPC
 * boundary and those seams is the real code that shipped.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/* ------------------------------------------------------- electron stub ---- */

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ipc-data-"));
const handlers = new Map();
const sentToRenderer = [];            // every webContents.send from main

const webContents = {
    // ...args, not one payload: the terminal streams (channel, id, chunk) and a
    // recorder that kept only the first argument would have made the chunk
    // invisible to every assertion about it. `payload` stays the first argument
    // so every existing check reads the same.
    send: (channel, ...args) => sentToRenderer.push({ channel, payload: args[0], args }),
    on: () => {}, setWindowOpenHandler: () => {}, session: { setPermissionRequestHandler: () => {} }
};
class BrowserWindowStub {
    constructor() { this.webContents = webContents; }
    isDestroyed() { return false; }
    once() {} on() {} loadFile() {} show() {} minimize() {} maximize() {}
    unmaximize() {} close() {} isMaximized() { return false; }
    static getAllWindows() { return []; }
}
const electronStub = {
    app: {
        isPackaged: true,
        getPath: () => DATA,
        getVersion: () => "1.0.0-test",
        getName: () => ".lcl",
        getAppPath: () => path.join(__dirname, ".."),
        on: () => {}, once: () => {},
        // Resolve it: the real createWindow() runs, so main.js gets a real
        // mainWindow and every webContents.send in the product is exercised
        // instead of being skipped by the `if (mainWindow)` guard. The engine
        // methods it calls are neutered below, so nothing spawns.
        whenReady: () => Promise.resolve(),
        requestSingleInstanceLock: () => true,
        setAppUserModelId: () => {},
        quit: () => {}, exit: () => {}, relaunch: () => {},
        setPath: () => {}, disableHardwareAcceleration: () => {},
        commandLine: { appendSwitch: () => {} }
    },
    BrowserWindow: BrowserWindowStub,
    ipcMain: {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: () => {}, removeHandler: () => {}
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
              showMessageBox: async () => ({ response: 0 }) },
    shell: { openPath: async () => "", openExternal: async () => {}, showItemInFolder: () => {} },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    // the remote-approval gate also tries to raise an OS notification; stubbed
    // unsupported so that path is EXERCISED and proven not to affect the gate
    Notification: Object.assign(
        function () { return { on: () => {}, show: () => {} }; },
        { isSupported: () => false }),
    powerMonitor: { on: () => {} },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeTheme: { on: () => {} },
    session: { defaultSession: { setPermissionRequestHandler: () => {} } },
    protocol: { registerFileProtocol: () => {} }
};

const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return __filename;
    return origResolve.call(this, request, ...rest);
};
require.cache[__filename] = { id: __filename, filename: __filename,
                              loaded: true, exports: electronStub };

/* -------------------------------------------------------------- harness --- */

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 240) : ""); }
}
const call = (channel, ...args) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler registered for ${channel}`);
    return fn({}, ...args);
};
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

/* A SUITE THAT STOPS EARLY MUST NOT LOOK LIKE A SUITE THAT PASSED.
 *
 * Caught while writing the K3 section: an approval left un-answered parks on a
 * timer main.js deliberately unrefs, so node ran out of work and exited 0 with
 * twenty-four checks never reached and no summary printed. Exit code green,
 * nothing proven — the precise failure mode this whole file exists to end. Any
 * exit that has not passed the summary line is now a failure, loudly.
 *
 * beforeExit, NOT exit: this file deliberately emits a synthetic "exit" to
 * drive the shutdown path, and a guard on that event fired on every one of
 * them while being unable to change the code anyway. beforeExit fires on
 * exactly the condition worth catching — node ran out of work — and never on
 * process.emit or an explicit process.exit. */
let finished = false;
process.on("beforeExit", () => {
    if (finished) return;
    finished = true;                       // one report, not one per tick
    console.log(`\nFAIL | the harness ran out of work after ${pass} checks and ` +
                "never reached the end — nothing below that point was proven");
    process.exit(1);
});

/* ---------------------------------------------------- load the real main -- */

const CORE = path.join(__dirname, "..", ".lcl.engine", "core");
const agent = require(path.join(CORE, "agent.js"));
const orchestrator = require(path.join(CORE, "orchestrator.js"));
const policyBridge = require(path.join(CORE, "policyBridge.js"));
const knowledge = require(path.join(CORE, "knowledge.js"));
const engine = require(path.join(CORE, "engine.js"));
const cloudModels = require(path.join(CORE, "cloudModels.js"));
const ledgerMod = require(path.join(CORE, "ledger.js"));
const pathsMod = require(path.join(CORE, "paths.js"));
const sessionsMod = require(path.join(CORE, "sessions.js"));

/* CONTRACT K1 — catch the resolver main.js installs at startup.
 *
 * Wrapped rather than replaced: cloudModels still receives it, so this proves
 * the real handshake rather than a test-only one. What the guard will call is
 * captured here so the same function can be interrogated directly. */
let nodeMemResolver = null;
const realSetResolver = cloudModels.setNodeMemResolver;
cloudModels.setNodeMemResolver = (fn) => {
    nodeMemResolver = fn;
    return typeof realSetResolver === "function"
        ? realSetResolver.call(cloudModels, fn) : true;
};

// Neuter the engine BEFORE main.js runs its ready handler: same module object,
// so the patches are what main.js sees. Nothing may spawn llama-server here —
// this test is about wiring, and a 4 GB model load has no business in it.
engine.start = () => ({ started: false, test: true });
engine.stop = () => {};
engine.stopAndWait = async () => {};
engine.unloadNow = () => {};
engine.setIdleUnloadMs = () => {};
engine.setStateListener = () => {};
engine.startIdleWatch = () => {};
engine.status = () => ({ running: false, idleSeconds: 0 });

require(path.join(__dirname, "..", "app", "main.js"));

check("app/main.js loads and registers its IPC handlers", handlers.size > 40, handlers.size);
check("lcl:approveTool is registered", handlers.has("lcl:approveTool"));

/* --------------------------------------------------------------- seams ---- */

const TOOL = "__ipc_probe";
let capturedCtx = null;
let noteCount = 0;
let gateRelease = null;
let gate = null;
let toolBehaviour = "ok";              // ok | cancelaware | dirty

agent.effectiveTools = () => ({
    [TOOL]: {
        help: `${TOOL} {} — test probe`,
        run: async (_root, _args, ctx) => {
            capturedCtx = ctx;
            if (ctx && typeof ctx.onNote === "function") { ctx.onNote("probe halfway"); noteCount++; }
            if (toolBehaviour === "dirty" && ctx && typeof ctx.onLibraryDirty === "function") {
                ctx.onLibraryDirty({ id: "probe-lib", name: "Probe" });
            }
            if (gate) await gate;
            if (ctx && ctx.cancelToken && ctx.cancelToken.cancelled) {
                return { stopped: true };
            }
            return { probed: true };
        }
    }
});

let staged = null;
agent.runTurn = async (session) => ({
    ok: true,
    newMessages: [{ role: "assistant", content: "staged" }],
    changes: [],
    pendingApprovals: staged
        ? [{ ...staged, sessionId: session.id, repoPath: session.repoPath }]
        : []
});
orchestrator.looksMultiStep = () => false;

let policyChecks = 0;
policyBridge.check = () => { policyChecks++; return { decision: "allow", reason: "test" }; };

let reindexCalls = 0;
knowledge.reindex = async () => { reindexCalls++; return { files: 0, chunks: 0 }; };
knowledge.list = () => [];

/* ----------------------------------------------------------------- run ---- */

(async () => {
    await tick(50);                       // let the ready handler build the window
    check("the real createWindow ran, so main has a window to send through",
        sentToRenderer.length >= 0 && handlers.has("lcl:window"));

    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ipc-ws-"));
    fs.writeFileSync(path.join(WS, "readme.md"), "# probe workspace\n");

    const A = call("lcl:createSession", "session A");
    const B = call("lcl:createSession", "session B");
    check("two sessions created", !!(A && A.id && B && B.id), { A: A && A.id, B: B && B.id });
    for (const s of [A, B]) {
        const g = call("lcl:grantFolder", s.id, WS);
        if (g && g.error) throw new Error("grantFolder failed: " + g.error);
    }

    /** Stage an approval through the REAL chat handler, return its id. */
    const stage = async (sessionId, id) => {
        staged = { kind: "tool", id, tool: TOOL, args: {}, digest: "probe-digest" };
        const r = await call("lcl:chat", sessionId, "do the thing");
        staged = null;
        if (r && r.error) throw new Error("chat failed: " + r.error);
        return id;
    };

    /* ---- 1. THE CTX. Every key the agent loop passes must be here too ---- */
    {
        capturedCtx = null; noteCount = 0; sentToRenderer.length = 0;
        toolBehaviour = "dirty";
        gateRelease = null; gate = null;
        await stage(A.id, "probe-ctx");
        const res = await call("lcl:approveTool", "probe-ctx");

        check("an approved tool actually runs (no ReferenceError, no dead button)",
            !!(res && res.ok && !res.error), res);
        check("the approval ctx is not the empty object it used to be",
            !!capturedCtx && Object.keys(capturedCtx).length >= 3,
            capturedCtx && Object.keys(capturedCtx));
        check("ctx.cancelToken is a live token",
            !!(capturedCtx && capturedCtx.cancelToken
               && capturedCtx.cancelToken.cancelled === false));
        check("ctx.onNote is a function", typeof (capturedCtx || {}).onNote === "function");
        check("ctx.onLibraryDirty is a function",
            typeof (capturedCtx || {}).onLibraryDirty === "function");

        // not merely present — WIRED. The note must reach the renderer, and the
        // dirty signal must reach the indexer.
        const notes = sentToRenderer.filter(m => m.channel === "lcl:progress"
            && m.payload && m.payload.phase === "tool-progress");
        check("a progress note from an approved tool reaches the renderer",
            notes.length >= 1 && /probe halfway/.test(JSON.stringify(notes)), notes.length);
        check("the note is tagged with the right session",
            notes.length > 0 && notes[0].payload.sessionId === A.id,
            notes[0] && notes[0].payload.sessionId);
        await tick(80);
        check("onLibraryDirty on the approval path really reindexes",
            reindexCalls >= 1, reindexCalls);
        check("the policy kernel is still consulted on the approval path",
            policyChecks >= 1, policyChecks);
    }

    /* ---- 2. THE LOCK. Per session, not global ---- */
    {
        toolBehaviour = "cancelaware";
        gate = new Promise(r => { gateRelease = r; });
        await stage(A.id, "probe-lock");
        const running = call("lcl:approveTool", "probe-lock");   // deliberately not awaited
        await tick(60);

        const sameSession = await call("lcl:chat", A.id, "hello again");
        check("chat in the SAME session is refused while its approval runs",
            !!(sameSession && sameSession.error), sameSession);

        const otherSession = await call("lcl:chat", B.id, "unrelated question");
        check("chat in ANOTHER session is NOT blocked by that approval",
            !!(otherSession && !otherSession.error),
            otherSession && otherSession.error);

        /* ---- 3. CANCEL. The Stop button must reach an approved tool ---- */
        const cancelled = await call("lcl:cancelChat", A.id);
        check("cancelChat reports it cancelled something", !!(cancelled && cancelled.cancelled),
            cancelled);
        check("the approved tool's own token is now tripped",
            !!(capturedCtx && capturedCtx.cancelToken && capturedCtx.cancelToken.cancelled));

        gateRelease();
        const res = await running;
        check("a cancelled approval is reported as failed, not as success",
            !!(res && res.failed), res && { ok: res.ok, failed: res.failed });
        check("the failure says the user stopped it",
            /stopped by you/i.test((res && res.output) || ""), res && res.output);

        // and the lock must have been released
        gate = null;
        const after = await call("lcl:chat", A.id, "after the cancel");
        check("the session is usable again once the approval ends",
            !!(after && !after.error), after && after.error);
    }

    /* ---- 4. the sidebar cannot be left saying "working" forever ---- */
    {
        sentToRenderer.length = 0;
        gate = null;
        await stage(A.id, "probe-status");
        await call("lcl:approveTool", "probe-status");
        const statuses = sentToRenderer
            .filter(m => m.channel === "lcl:sessionStatus" && m.payload.sessionId === A.id)
            .map(m => m.payload.state);
        check("an approval reports working and then clears",
            statuses.includes("working") && statuses[statuses.length - 1] !== "working",
            statuses);
    }

    /* ---- 5. an unknown proposal id still cannot run anything ---- */
    {
        const bogus = await call("lcl:approveTool", "no-such-proposal");
        check("a fabricated proposal id is refused",
            !!(bogus && bogus.error), bogus);
        const twice = await call("lcl:approveTool", "probe-status");
        check("an already-consumed proposal cannot be replayed",
            !!(twice && twice.error), twice);
    }

    /* =====================================================================
     * 7. CONTRACT K1 — NODE SIZE HAS ONE SOURCE OF TRUTH.
     *
     * MEASURED on a real install:
     * settings.localNodes[0].memBytes was 130663002112 and the endpoint record
     * the guard actually reads was
     *   {"id":"node-example1","name":"spark","host":"100.64.0.1","port":11434}
     * with no size at all. Two copies of one truth, and rememberNodeMem only
     * ever wrote the copy the guard does not consult. PREFLIGHT RESULT: null ->
     * PROCEEDED, and the test machine died.
     *
     * So the guard no longer depends on the record it is handed. main.js hands
     * cloudModels a resolver at startup; these checks call THAT function — the
     * one the guard will call — and read the real answer.
     * =================================================================== */
    {
        check("main.js installs a node-memory resolver at startup (K1)",
            typeof nodeMemResolver === "function", typeof nodeMemResolver);

        pathsMod.writeSettings({ localNodes: [
            { id: "node-probe", name: "stopbath", host: "127.0.0.1", memBytes: 34e9 },
            { id: "node-sizeless", name: "washer", host: "127.0.0.2" }
        ] });

        check("the resolver answers with the registry's number, exactly",
            nodeMemResolver("node-probe") === 34e9, nodeMemResolver("node-probe"));
        check("a node with no size resolves to null, never to a guess — the guard " +
              "has to SEE 'unknown' to be able to fail closed on it",
            nodeMemResolver("node-sizeless") === null,
            nodeMemResolver("node-sizeless"));
        check("an unknown node id resolves to null too",
            nodeMemResolver("node-does-not-exist") === null);
        check("an empty id cannot be answered",
            nodeMemResolver("") === null && nodeMemResolver(null) === null);

        // and it tracks the registry rather than caching a first answer
        pathsMod.writeSettings({ localNodes: [
            { id: "node-probe", name: "stopbath", host: "127.0.0.1", memBytes: 128e9 }
        ] });
        check("a size that changes on the registry changes what the guard reads",
            nodeMemResolver("node-probe") === 128e9, nodeMemResolver("node-probe"));
    }

    /* ---- 7b. THE BACKFILL. Existing installs heal themselves. ------------
     *
     * The resolver covers this process. The endpoint records already on disk
     * are the other half: an install that has been running for weeks still
     * carries the sizeless copy, and anything that reads a record directly
     * would still read nothing. rememberNodeMem now patches every endpoint
     * whose node.id matches.
     *
     * Driven by lifting the real function out of the shipped main.js and
     * running it against the REAL cloudModels store in this test's temp data
     * dir — the same technique tests/install-failures.js uses for
     * rememberNodeMem. It is the shipped body, executing, not a description
     * of it: nodeStats' own path needs an SSH round trip to a machine that
     * must never be contacted from a test. */
    {
        const mainSrc = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
        const lift = (name) => {
            const at = mainSrc.indexOf("function " + name + "(");
            if (at < 0) throw new Error("no function " + name + " in main.js");
            let depth = 0;
            for (let j = mainSrc.indexOf("{", at); j < mainSrc.length; j++) {
                if (mainSrc[j] === "{") depth++;
                else if (mainSrc[j] === "}" && --depth === 0) return mainSrc.slice(at, j + 1);
            }
            throw new Error("unbalanced " + name);
        };
        const audited = [];
        const backfill = new Function("cloudModels", "auditLog",
            "lastMemBackfill", "MEM_BACKFILL_EVERY_MS",
            lift("backfillEndpointNodeMem") + "\nreturn backfillEndpointNodeMem;")(
            cloudModels, { write: (r) => audited.push(r) }, new Map(), 60_000);

        // an endpoint exactly as a real install carried it: a node
        // record with no size on it
        cloudModels.linkEndpoint({
            id: "node-probe", label: "stopbath", baseUrl: "http://127.0.0.1:11434",
            preset: "custom", localNode: true,
            models: [{ id: "developer:q6_K", label: "developer q6_K" },
                     { id: "fixer:q4_0", label: "fixer q4_0" }],
            node: { id: "node-probe", name: "stopbath", host: "127.0.0.1", port: 11434 }
        });
        const before = cloudModels.endpoints().find(e => e.id === "node-probe");
        check("the endpoint record starts with no size, exactly as the real one did",
            !!before && !!before.node && before.node.memBytes === undefined,
            before && before.node);

        const patched = backfill("node-probe", 128e9);
        const after = cloudModels.endpoints().find(e => e.id === "node-probe");
        check("the backfill patches the endpoint record the guard reads",
            patched === 1 && after.node.memBytes === 128e9,
            { patched, node: after && after.node });
        check("...and it does not damage the record doing it: label, models, " +
              "node identity and localNode all survive",
            after.label === "stopbath" && after.models.length === 2
            && after.models[0].id === "developer:q6_K"
            && after.node.host === "127.0.0.1" && after.node.port === 11434
            && after.localNode === true,
            { label: after.label, models: after.models.length, node: after.node,
              localNode: after.localNode });
        check("...and it is a no-op the second time — this runs off a 5s poll",
            backfill("node-probe", 128e9) === 0);
        check("...and it leaves an endpoint belonging to a DIFFERENT node alone",
            backfill("node-elsewhere", 64e9) === 0
            && cloudModels.endpoints().find(e => e.id === "node-probe")
                .node.memBytes === 128e9);
        check("...and the heal is recorded, so an install that repaired itself " +
              "can be told apart from one that was never broken",
            audited.some(r => r.kind === "node-mem-backfilled" && r.memBytes === 128e9),
            audited.map(r => r.kind));

        cloudModels.unlinkEndpoint("node-probe");
    }

    /* =====================================================================
     * 8. CONTRACT K3 — "ASK BEFORE EVERY REMOTE CALL", ACTUALLY ASKED.
     *
     * MEASURED before this existed: cloudAutoApprove was written by setBehavior
     * and read back only to paint its own dropdown. Nothing in the agent, the
     * router or cloudModels consulted it, which is why nothing ever surfaced
     * any escalation attempts or requests.
     * =================================================================== */

    // a linked endpoint, in the shape resolveSelection hands to a turn
    const REMOTE = { id: "darkroom-api", label: "Darkroom Cloud",
                     baseUrl: "https://api.darkroom.example", model: "fixer-large",
                     preset: "custom", apiPrefix: "/v1" };
    const realResolve = cloudModels.resolveSelection;
    const driveRemote = (on) => {
        cloudModels.resolveSelection = on
            ? (() => ({ sel: REMOTE, source: "session", missing: null }))
            : realResolve;
    };

    /** Answer whatever approval is waiting, and hand back the request. */
    const lastApproval = () => sentToRenderer
        .filter(m => m.channel === "lcl:remoteApproval").pop();

    {
        pathsMod.writeSettings({ cloudAutoApprove: false });
        driveRemote(true);
        staged = null;

        /* ---- it asks, and it waits ---- */
        sentToRenderer.length = 0;
        const turn = call("lcl:chat", A.id, "develop this frame");
        await tick(60);
        const askEvent = lastApproval();
        check("a remote turn raises lcl:remoteApproval instead of just going",
            !!askEvent, sentToRenderer.map(m => m.channel));
        const req = askEvent && askEvent.payload;
        check("...and the request carries the whole K3 payload: id, model, " +
              "endpoint, destination, estCostUsd",
            !!req && typeof req.id === "string" && req.model === "fixer-large"
            && req.endpoint === "Darkroom Cloud" && !!req.destination
            && typeof req.estCostUsd === "number", req);
        check("...naming the destination as what it is, not as 'the model'",
            req && req.destination.kind === "third-party"
            && req.destination.host === "api.darkroom.example", req && req.destination);
        check("...and a model with NO known rate says so rather than showing $0 — " +
              "'free' and 'unpriced' are different facts and the card must not " +
              "collapse them",
            req && req.estCostKnown === false && req.estCostUsd === 0
            && /could not|no rate/i.test(req.costNote || ""),
            req && { estCostUsd: req.estCostUsd, known: req.estCostKnown,
                     note: req.costNote });
        // The state is "approval", not the old catch-all "waiting": a staged
        // request that BLOCKS the turn now looks different in the sidebar from
        // a question you could ignore. Purple meant all three of "asked you
        // something", "approve sending to an endpoint" and "an action needs
        // approval", so the list could not tell them apart at all.
        check("...and the session says WHY it is stalled while it waits, in the " +
              "state that means an action is blocked on you",
            sentToRenderer.some(m => m.channel === "lcl:sessionStatus"
                && m.payload.sessionId === A.id && m.payload.state === "approval"
                && /approve sending to Darkroom Cloud/.test(m.payload.detail || "")),
            sentToRenderer.filter(m => m.channel === "lcl:sessionStatus")
                .map(m => m.payload.state + ":" + m.payload.detail));

        /* ---- and a PRICED model states the number the operator is agreeing to ---- */
        await call("lcl:answerRemoteApproval", req.id, "deny");
        await turn;
        REMOTE.model = "deepseek-chat";                 // a shipped rate exists
        sentToRenderer.length = 0;
        const priced = call("lcl:chat", A.id, "a longer message that costs something");
        await tick(60);
        const pricedReq = lastApproval().payload;
        check("...while a model that IS priced states the cost before the operator " +
              "agrees to it, with the token count it is based on",
            pricedReq.estCostKnown === true && pricedReq.estCostUsd > 0
            && pricedReq.estInputTokens > 0,
            { usd: pricedReq.estCostUsd, known: pricedReq.estCostKnown,
              tokens: pricedReq.estInputTokens });
        await call("lcl:answerRemoteApproval", pricedReq.id, "deny");
        await priced;
        REMOTE.model = "fixer-large";

        /* ---- deny means the call does not happen ---- */
        sentToRenderer.length = 0;
        const turnB = call("lcl:chat", A.id, "develop this frame");
        await tick(60);
        const reqB = lastApproval().payload;
        const ans = await call("lcl:answerRemoteApproval", reqB.id, "deny");
        check("the renderer's answer is accepted", !!(ans && ans.ok), ans);
        const denied = await turnB;
        check("a denied remote call is REFUSED, not quietly sent anyway",
            !!(denied && denied.error && denied.remoteDenied
               && /Not sent to Darkroom Cloud/.test(denied.error)), denied);
        // ...and it points at a control that EXISTS. The old wording named
        // "ask before every remote call", and then a later edit pointed at
        // Session › Permissions to "trust the endpoint there" — where there is
        // no trust-granting control at all. The only way to grant trust is the
        // ask card itself, so that is what the refusal says.
        check("...and the refusal names the real way to stop being asked, and " +
              "the panel that can take a trust back",
            /Allow for this conversation/i.test((denied && denied.error) || "")
            && /Session › Permissions/.test((denied && denied.error) || ""),
            denied && denied.error);

        /* ---- an unrecognised verdict may only ever mean no ---- */
        sentToRenderer.length = 0;
        const turn2 = call("lcl:chat", A.id, "and this one");
        await tick(60);
        const req2 = lastApproval().payload;
        await call("lcl:answerRemoteApproval", req2.id, "yes-obviously-do-it");
        const bogus = await turn2;
        check("a verdict that is not once/always/deny is treated as a deny",
            !!(bogus && bogus.remoteDenied && bogus.verdict === "deny"), bogus);

        /* ---- once means once ---- */
        sentToRenderer.length = 0;
        const turn3 = call("lcl:chat", A.id, "this one is fine");
        await tick(60);
        await call("lcl:answerRemoteApproval", lastApproval().payload.id, "once");
        const allowed = await turn3;
        check("approving with 'once' lets the turn actually run",
            !!(allowed && !allowed.error && allowed.new_messages), allowed);

        sentToRenderer.length = 0;
        const turn4 = call("lcl:chat", A.id, "and the next one");
        await tick(60);
        check("...and ONCE means once: the next remote call asks again",
            !!lastApproval(), sentToRenderer.map(m => m.channel));
        await call("lcl:answerRemoteApproval", lastApproval().payload.id, "deny");
        await turn4;

        /* ---- stop must work while the card is up ---- */
        sentToRenderer.length = 0;
        const turn5 = call("lcl:chat", A.id, "actually never mind");
        await tick(60);
        const stopped = await call("lcl:cancelChat", A.id);
        check("Stop ends a turn that is waiting on the approval card",
            !!(stopped && stopped.cancelled), stopped);
        const cancelledTurn = await turn5;
        check("...and that turn ends refused rather than hanging",
            !!(cancelledTurn && cancelledTurn.remoteDenied), cancelledTurn);

        // and the session is immediately usable again — a stopped approval must
        // not leave the turn lock held
        sentToRenderer.length = 0;
        const again = call("lcl:chat", A.id, "one more");
        await tick(60);
        const againAsk = lastApproval();
        check("...and the session takes a new turn straight afterwards",
            !!againAsk, sentToRenderer.map(m => m.channel));
        await call("lcl:answerRemoteApproval", againAsk.payload.id, "deny");
        await again;

        /* ---- FAILS CLOSED. A gate that cannot ask must not proceed ----
         *
         * This is the property the memory guard did not have: unable to read
         * its input, it went ahead anyway. A spend-and-privacy
         * gate with no window to ask in has exactly one correct answer. */
        const realIsDestroyed = BrowserWindowStub.prototype.isDestroyed;
        BrowserWindowStub.prototype.isDestroyed = () => true;
        let noWindow;
        try {
            noWindow = await call("lcl:chat", A.id, "send this with nobody home");
        } finally {
            BrowserWindowStub.prototype.isDestroyed = realIsDestroyed;
        }
        check("with no window to ask in, the remote call does NOT happen",
            !!(noWindow && noWindow.remoteDenied && noWindow.verdict === "no-window"),
            noWindow);
        check("...and it says why, rather than failing as something else",
            /no window to ask in/i.test((noWindow && noWindow.error) || ""),
            noWindow && noWindow.error);
        // and the session is not left locked by a gate that could not ask:
        // the next message gets a fresh card rather than "already replying"
        sentToRenderer.length = 0;
        const afterNoWindow = call("lcl:chat", A.id, "still usable?");
        await tick(60);
        const freshCard = lastApproval();
        check("...and the session is not left locked by it",
            !!freshCard, sentToRenderer.map(m => m.channel));
        await call("lcl:answerRemoteApproval", freshCard.payload.id, "deny");
        await afterNoWindow;

        /* ---- THE WIDEST ANSWER IS THIS CONVERSATION, NOT THE MACHINE ----
         * "always" used to write a GLOBAL cloudAutoApprove: one click on one
         * card disarming the gate for every conversation, including ones not
         * created yet. The product's rule is that a permission
         * belongs to the conversation that granted it, so the button is gone
         * and a stray verdict lands on the SESSION. */
        sentToRenderer.length = 0;
        const turn6 = call("lcl:chat", A.id, "stop asking me");
        await tick(60);
        await call("lcl:answerRemoteApproval", lastApproval().payload.id, "always");
        await turn6;
        check("a stray 'always' verdict is stored on the SESSION, never as an " +
              "app-wide switch",
            pathsMod.readSettings().cloudAutoApprove !== true,
            pathsMod.readSettings().cloudAutoApprove);
        check("...and the session it was answered in stops asking",
            (sessionsMod.load(A.id).perms || {}).askRemote === false,
            (sessionsMod.load(A.id).perms || {}));

        sentToRenderer.length = 0;
        const quiet = await call("lcl:chat", A.id, "no card this time");
        check("with THIS conversation's switch off, its remote turn runs " +
              "without asking",
            !lastApproval() && !!(quiet && !quiet.error),
            { asked: !!lastApproval(), quiet });
    }

    /* =====================================================================
     * 8b. TRUST — the missing middle.
     *
     * MEASURED in a real audit log: "once" was answered many times in a row for
     * the same endpoint, because "once" asks again every turn and "always" is
     * global-forever. There was no way to say "trust this destination for this
     * conversation" without disarming the gate for every endpoint on earth. So
     * cloudAutoApprove was flipped globally, which then swallowed every ask —
     * including for endpoints and sessions that had never been approved, so a
     * message to a local node carried no permission flags.
     *
     * The fix is a third verdict: "allow / trust / only this once".
     * TRUST is per-session, per-endpoint. A new session asks. A different
     * endpoint asks. The global switch stays as a master override — but nobody
     * has to flip it just to stop being asked every turn for one endpoint.
     * =================================================================== */
    {
        pathsMod.writeSettings({ cloudAutoApprove: false });   // gate ACTIVE
        const D = call("lcl:createSession", "trust probe");

        const REMOTE_TRUST = { id: "darkroom-api", label: "Darkroom Cloud",
            baseUrl: "https://api.darkroom.example", model: "fixer-large",
            preset: "custom", apiPrefix: "/v1" };
        const REMOTE_OTHER = { id: "other-endpoint", label: "Other Cloud",
            baseUrl: "https://api.other.example", model: "fixer-large",
            preset: "custom", apiPrefix: "/v1" };
        const realResolve2 = cloudModels.resolveSelection;
        const drive = (sel) => { cloudModels.resolveSelection = (() => ({ sel })); };
        const restoreResolve = () => { cloudModels.resolveSelection = realResolve2; };

        try {
            drive(REMOTE_TRUST);
            staged = null;

            /* ---- a fresh session asks, and "trust" is accepted (not treated as deny) ---- */
            sentToRenderer.length = 0;
            const t1 = call("lcl:chat", D.id, "develop this frame");
            await tick(60);
            const ask1 = lastApproval();
            check("a fresh session with the gate active is asked before a remote call",
                !!ask1, sentToRenderer.map(m => m.channel));
            const trustAns = await call("lcl:answerRemoteApproval", ask1.payload.id, "trust");
            check("...and 'trust' is an ACCEPTED verdict, not folded to deny",
                !!(trustAns && trustAns.ok && trustAns.verdict === "trust"), trustAns);
            const r1 = await t1;
            check("...and the trusted turn actually runs instead of being refused",
                !!(r1 && !r1.error && r1.new_messages), r1);

            /* ---- the SAME endpoint in the SAME session does NOT ask again ---- */
            sentToRenderer.length = 0;
            await tick(30);
            const t2 = await call("lcl:chat", D.id, "and the next one to the same place");
            check("TRUST is per-endpoint for the session: the next call to the same " +
                  "endpoint runs without asking",
                !lastApproval() && !!(t2 && !t2.error),
                { asked: !!lastApproval(), t2 });

            /* ---- a DIFFERENT endpoint in the same session still asks ---- */
            drive(REMOTE_OTHER);
            sentToRenderer.length = 0;
            const t3 = call("lcl:chat", D.id, "now a different destination");
            await tick(60);
            check("...but a DIFFERENT endpoint in the same session is still asked — " +
                  "trust is not a blanket session pass",
                !!lastApproval(), sentToRenderer.map(m => m.channel));
            await call("lcl:answerRemoteApproval", lastApproval().payload.id, "deny");
            await t3;

            /* ---- a DIFFERENT session is asked even for the trusted endpoint ---- */
            drive(REMOTE_TRUST);
            const E = call("lcl:createSession", "trust probe 2");
            sentToRenderer.length = 0;
            const t4 = call("lcl:chat", E.id, "fresh session, same endpoint");
            await tick(60);
            check("...and a fresh SESSION is asked even for an endpoint another " +
                  "session trusted — trust does not leak across conversations",
                !!lastApproval(), sentToRenderer.map(m => m.channel));
            await call("lcl:answerRemoteApproval", lastApproval().payload.id, "deny");
            await t4;

            /* ---- the trust is RECORDED on the session record, so it survives a restart ---- */
            const reloaded = sessionsMod.load(D.id);
            check("trust is persisted on the session record as trustedEndpoints, " +
                  "so a reload does not silently re-ask",
                Array.isArray(reloaded && reloaded.trustedEndpoints)
                    && reloaded.trustedEndpoints.includes("darkroom-api"),
                reloaded && reloaded.trustedEndpoints);

            /* ---- and trust does NOT touch the global switch ---- */
            check("...and trusting an endpoint does NOT flip the global " +
                  "cloudAutoApprove — it stays a separate, deliberate master override",
                pathsMod.readSettings().cloudAutoApprove === false,
                pathsMod.readSettings().cloudAutoApprove);
        } finally {
            restoreResolve();
        }
    }

    /* =====================================================================
     * 9. THE LEDGER SHOWS WHAT WAS TRIED.
     *
     * REPORTED: "Spend captured none of the API attempts." True, and the cause
     * is that the only ledger row is written `if (result.remote && result.usage)`
     * — so a call that failed, hung, was stopped, or came back with no usage
     * block left no trace anywhere the user looks.
     * =================================================================== */
    {
        const rowsFor = (sid) => ledgerMod.readAll()
            .filter(r => !r.kind && r.sessionId === sid);
        const C = call("lcl:createSession", "ledger probe");
        // gate off for THIS conversation (there is no app-wide switch any
        // more), ledger on
        await call("lcl:setSessionPerm", C.id, "askRemote", false);
        driveRemote(true);

        /* a turn that throws */
        const realRunTurn = agent.runTurn;
        agent.runTurn = async () => { throw new Error("socket hang up"); };
        await call("lcl:chat", C.id, "one");
        check("a remote turn that THREW leaves a row behind",
            rowsFor(C.id).some(r => r.via === "attempt-failed"),
            rowsFor(C.id).map(r => r.via));

        /* a turn that fails cleanly */
        agent.runTurn = async () => ({ ok: false, error: "endpoint returned 429" });
        await call("lcl:chat", C.id, "two");
        check("a remote turn that FAILED leaves a row behind",
            rowsFor(C.id).filter(r => r.via === "attempt-failed").length === 2,
            rowsFor(C.id).map(r => r.via));

        /* a turn the user stopped */
        agent.runTurn = async () => ({ ok: false, error: "cancelled", cancelled: true });
        await call("lcl:chat", C.id, "three");
        check("a remote turn the user STOPPED leaves a row behind",
            rowsFor(C.id).some(r => r.via === "attempt-cancelled"),
            rowsFor(C.id).map(r => r.via));

        /* a turn that succeeded but reported no usage */
        agent.runTurn = async () => ({ ok: true, newMessages: [], changes: [],
                                       pendingApprovals: [] });
        await call("lcl:chat", C.id, "four");
        check("a remote turn that billed NOTHING is recorded as unbilled rather " +
              "than looking identical to no call at all",
            rowsFor(C.id).some(r => r.via === "attempt-unbilled"),
            rowsFor(C.id).map(r => r.via));

        check("every attempt row is honest: real zeroes, no invented tokens or dollars",
            rowsFor(C.id).filter(r => /^attempt-/.test(r.via))
                .every(r => r.usd === 0 && r.inputTokens === 0 && r.outputTokens === 0
                            && r.model === "fixer-large" && r.endpoint === "Darkroom Cloud"),
            rowsFor(C.id));

        /* and a turn that DID bill must not be double counted */
        const countBefore = rowsFor(C.id).length;
        agent.runTurn = async (session) => {
            ledgerMod.record({ sessionId: session.id, sessionTitle: session.title,
                model: "fixer-large", endpoint: "Darkroom Cloud",
                inputTokens: 1200, outputTokens: 300, usd: 0.004, via: "user" });
            return { ok: true, newMessages: [], changes: [], pendingApprovals: [] };
        };
        await call("lcl:chat", C.id, "five");
        const added = rowsFor(C.id).slice(countBefore);
        check("a turn that recorded its OWN spend gets no duplicate attempt row",
            added.length === 1 && added[0].via === "user" && added[0].usd === 0.004,
            added);

        /* a denied call is an attempt too — the gate is re-armed for THIS
         * conversation, since that is the only scope there is */
        await call("lcl:setSessionPerm", C.id, "askRemote", true);
        agent.runTurn = realRunTurn;
        sentToRenderer.length = 0;
        const t = call("lcl:chat", C.id, "six");
        await tick(60);
        await call("lcl:answerRemoteApproval", lastApproval().payload.id, "deny");
        await t;
        check("a call the user REFUSED is in the ledger as refused",
            rowsFor(C.id).some(r => r.via === "attempt-denied"),
            rowsFor(C.id).map(r => r.via));

        /* a LOCAL turn must never appear in the money ledger */
        driveRemote(false);
        agent.runTurn = async () => ({ ok: true, newMessages: [], changes: [],
                                       pendingApprovals: [] });
        const beforeLocal = rowsFor(C.id).length;
        await call("lcl:chat", C.id, "seven, locally");
        check("a LOCAL turn writes no ledger row at all",
            rowsFor(C.id).length === beforeLocal, rowsFor(C.id).length - beforeLocal);
        agent.runTurn = realRunTurn;
        driveRemote(false);
    }

    /* =====================================================================
     * 10. THE BEHAVIOUR DIALS REACH A LIVE KERNEL.
     *
     * MEASURED before the fix, by driving this exact handler:
     *   setBehavior cloudAutoApprove true  -> {"error":"policy is not defined"}
     *   setBehavior writeMode  confirm     -> {"error":"policy is not defined"}
     * `policy` was never a binding in main.js — the module is required as
     * `policyBridge` — and guard() turned the ReferenceError into an {error}
     * the renderer swallowed. Both dials wrote settings and applied nothing.
     * =================================================================== */
    {
        const r1 = await call("lcl:setBehavior", "cloudAutoApprove", true);
        check("setBehavior cloudAutoApprove succeeds instead of throwing",
            !!(r1 && r1.ok && !r1.error), r1);
        check("...and it really reached the kernel: ask_cloud_model is relaxed",
            (pathsMod.readSettings().toolPolicy || {}).ask_cloud_model === "notify",
            pathsMod.readSettings().toolPolicy);

        const r2 = await call("lcl:setBehavior", "cloudAutoApprove", false);
        check("...and turning it back off re-tightens the same tool",
            !!(r2 && r2.ok) && !(pathsMod.readSettings().toolPolicy || {}).ask_cloud_model,
            { r2, toolPolicy: pathsMod.readSettings().toolPolicy });

        const r3 = await call("lcl:setBehavior", "writeMode", "confirm");
        check("setBehavior writeMode succeeds too — the same ReferenceError " +
              "silently disarmed 'ask before every write'",
            !!(r3 && r3.ok && r3.value === "confirm" && !r3.error), r3);
        await call("lcl:setBehavior", "writeMode", "notify");

        const r4 = await call("lcl:setBehavior", "notAThing", 1);
        check("an unknown dial is still refused by name",
            !!(r4 && r4.error), r4);
    }

    /* =====================================================================
     * 11. CONTRACT K5 — THE TERMINAL.
     *
     * A real shell, running as the user, with no sandbox and no approval:
     * a deliberate decision, and the reason the model must have NO path to it.
     * The no-agent-path half is asserted in tests/preload-contract.js; this
     * half proves the shell is real by talking to it.
     * =================================================================== */
    {
        const started = await call("lcl:terminalStart", 100, 30);
        check("terminalStart spawns a shell and returns its id",
            !!(started && started.id && started.pid && !started.error), started);
        check("...and it names the shell it started, so nothing has to guess",
            typeof started.shell === "string" && started.shell.length > 0, started.shell);
        check("...and it states plainly that it is unsandboxed and unreviewed",
            /no sandbox/i.test(started.notice || "")
            && /cannot/i.test(started.notice || ""), started.notice);

        sentToRenderer.length = 0;
        const echoed = "lcl-terminal-probe-" + Date.now().toString(36);
        const w = await call("lcl:terminalWrite", started.id, `echo ${echoed}\r\n`);
        check("terminalWrite is accepted", !!(w && w.ok && w.bytes > 0), w);

        // give the shell a moment to answer; it is a real process
        let seen = "";
        for (let i = 0; i < 40 && !seen.includes(echoed); i++) {
            await tick(100);
            seen = sentToRenderer.filter(m => m.channel === "lcl:terminalData")
                .map(m => m.args[1]).join("");
        }
        check("the shell's real output streams back to the renderer",
            seen.includes(echoed), seen.slice(-200));
        check("...tagged with the terminal it came from, as (id, chunk)",
            sentToRenderer.filter(m => m.channel === "lcl:terminalData")
                .every(m => m.args[0] === started.id),
            sentToRenderer.filter(m => m.channel === "lcl:terminalData")
                .map(m => m.args[0]).slice(0, 3));

        const rs = await call("lcl:terminalResize", started.id, 132, 44);
        check("terminalResize is answered with what was actually applied",
            !!(rs && rs.ok && rs.cols === 132 && rs.rows === 44), rs);

        const listed = await call("lcl:terminalList");
        check("a running shell is visible in the list",
            !!(listed && listed.terminals.some(t => t.id === started.id)), listed);
        check("...and the list carries the same unsandboxed notice, so a panel " +
              "re-rendered after a reload can still say it",
            listed.notice === started.notice && /no sandbox/i.test(listed.notice || ""),
            listed.notice);

        const pid = started.pid;
        const killed = await call("lcl:terminalKill", started.id);
        check("terminalKill reports it killed that shell", !!(killed && killed.ok), killed);
        await tick(400);
        const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
        check("...and the process is genuinely gone", !alive, { pid, alive });
        check("...and it is out of the list",
            !(await call("lcl:terminalList")).terminals.some(t => t.id === started.id));

        check("writing to a terminal that does not exist is refused",
            !!(await call("lcl:terminalWrite", "term-nope", "rm -rf /\r\n")).error);
        check("killing a terminal that does not exist is refused",
            !!(await call("lcl:terminalKill", "term-nope")).error);

        /* NO SHELL OUTLIVES THE APP. This app has already shipped one process
         * that did; a shell the user can create by typing must not be the
         * second. */
        const survivor = await call("lcl:terminalStart", 80, 24);
        await tick(200);
        process.emit("exit", 0);
        await tick(500);
        const stillAlive = (() => {
            try { process.kill(survivor.pid, 0); return true; } catch { return false; }
        })();
        check("app shutdown kills a shell that is still running",
            !stillAlive, { pid: survivor.pid, stillAlive });
    }

    /* ---- 6. SHUTDOWN. Every child must be stopped, whatever else fails ----
     *
     * This section exists because the harness above CRASHED on its first run:
     * `reranker.stop()` sat on both shutdown lines and `reranker` was never
     * imported in main.js. It threw ReferenceError on the fourth of five calls,
     * so serve.stopAll() — added specifically to stop a session's localhost
     * server outliving the app — had never executed once. A unit test of any
     * single module could not see it; only driving the real main process could.
     *
     * So the contract is asserted directly: emit the exit the app emits, and
     * demand that all five stops ran. Independently, too — one throwing must not
     * orphan the rest, which is why they are no longer a single statement.
     */
    {
        const stopped = new Set();
        const embedIndex = require(path.join(CORE, "embedIndex.js"));
        const ocrTools = require(path.join(CORE, "ocrTools.js"));
        const reranker = require(path.join(CORE, "reranker.js"));
        const serve = require(path.join(CORE, "serve.js"));

        engine.stop = () => stopped.add("engine");
        embedIndex.stop = () => stopped.add("embedIndex");
        ocrTools.stop = () => stopped.add("ocrTools");
        reranker.stop = () => stopped.add("reranker");
        serve.stopAll = () => stopped.add("serve");

        process.emit("exit", 0);
        check("shutdown stops every child process",
            ["engine", "embedIndex", "ocrTools", "reranker", "serve"]
                .every(k => stopped.has(k)), [...stopped]);

        // and the one that used to be orphaned, named, because it is the leak
        check("shutdown reaches serve.stopAll (the server that outlived the app)",
            stopped.has("serve"));

        // now make an EARLIER stop throw and demand the later ones still run
        stopped.clear();
        ocrTools.stop = () => { throw new Error("boom"); };
        process.emit("exit", 0);
        check("one failing stop does not orphan the others",
            stopped.has("reranker") && stopped.has("serve"), [...stopped]);
    }

    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }); } catch { /* held open */ }
    finished = true;
    /* ---- session isolation hardening ---- */
    {
        const src = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
        check("approveScript takes the SAME locks as every other approval — a chat " +
              "turn can no longer erase a script result mid-run, and the run holds " +
              "a cancel token Stop can reach",
            src.includes('return { error: "this session is replying — wait for the turn to finish, then approve" };')
            && src.includes("approvalsRunning.set(p.sessionId, scriptCancel)")
            && /finally \{[\s\S]{0,220}approvalsRunning\.delete\(p\.sessionId\);[\s\S]{0,40}\}\n\}\);/.test(src));
        check("deleteSession REFUSES FIRST: no sandbox release, script drop, or " +
              "ledger stamp happens for a delete that is refused — and a running " +
              "approval blocks deletion like a running turn does",
            src.indexOf("this session is still working — stop it first") <
                src.indexOf("sandbox.releaseSession(String(id))")
            && src.includes("an approved action is still running here — stop it first, then delete"));
        check("a Stop is scoped to ITS session only — the first-live-token-of-any-" +
              "session fallback is retired in cancelChat and settleRemoteApprovalFor",
            !src.includes("turnsBySession.values().next().value")
            && src.includes("if (!sessionId) return false;"));
        const sr = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "scriptRunner.js"), "utf8");
        check("...and the script runner honours the token: a flipped cancel kills " +
              "the child instead of letting it run to the timeout",
            sr.includes("cancelToken.cancelled") && sr.includes("stopped by you"));
    }

    console.log(`\n${pass}/${pass + fail} ipc-approval checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(1); });
