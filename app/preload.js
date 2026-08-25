const { contextBridge, ipcRenderer } = require("electron");

// -------------------------------------------------------------
// EXPOSE SAFE API TO RENDERER
// -------------------------------------------------------------
contextBridge.exposeInMainWorld("lcl", {
    // window chrome
    windowAction: (action) => ipcRenderer.invoke("lcl:window", String(action)),
    onWindowState: (cb) => ipcRenderer.on("lcl:windowState",
        (_e, state) => cb(state)),
    appInfo: () => ipcRenderer.invoke("lcl:appInfo"),
    renderMode: () => ipcRenderer.invoke("lcl:renderMode"),
    setMotionPref: (p) => ipcRenderer.invoke("lcl:setMotionPref", String(p)),
    setIntroSound: (on) => ipcRenderer.invoke("lcl:setIntroSound", !!on),
    systemStats: () => ipcRenderer.invoke("lcl:systemStats"),
    approveScript: (id) => ipcRenderer.invoke("lcl:approveScript", id),
    rejectScript: (id) => ipcRenderer.invoke("lcl:rejectScript", id),
    approveTool: (id) => ipcRenderer.invoke("lcl:approveTool", id),
    rejectTool: (id) => ipcRenderer.invoke("lcl:rejectTool", id),
    // security: engagements + network toggle (user-only actions)
    securityState: () => ipcRenderer.invoke("lcl:securityState"),
    listEngagements: () => ipcRenderer.invoke("lcl:listEngagements"),
    createEngagement: (spec) => ipcRenderer.invoke("lcl:createEngagement", spec),
    revokeEngagement: (id) => ipcRenderer.invoke("lcl:revokeEngagement", id),
    setNetworkEnabled: (on) => ipcRenderer.invoke("lcl:setNetworkEnabled", on),
    onScriptOutput: (cb) => ipcRenderer.on("lcl:scriptOutput", (_e, d) => cb(d)),
    processList: () => ipcRenderer.invoke("lcl:processList"),
    endProcess: (name) => ipcRenderer.invoke("lcl:endProcess", name),
    openSystemTool: (which) => ipcRenderer.invoke("lcl:openSystemTool", which),
    transcribeMic: (buf) => ipcRenderer.invoke("lcl:transcribeMic", buf),
    costSummary: () => ipcRenderer.invoke("lcl:costSummary"),
    costForSession: (id) => ipcRenderer.invoke("lcl:costForSession", id),
    refreshEndpoint: (id) => ipcRenderer.invoke("lcl:refreshEndpoint", id),
    escalation: () => ipcRenderer.invoke("lcl:escalation"),
    setEscalation: (on) => ipcRenderer.invoke("lcl:setEscalation", on),
    setSessionEscalation: (id, ids) => ipcRenderer.invoke("lcl:setSessionEscalation", id, ids),
    setSessionModel: (id, modelId) => ipcRenderer.invoke("lcl:setSessionModel", id, modelId),
    setSessionKnowledge: (id, ids) => ipcRenderer.invoke("lcl:setSessionKnowledge", id, ids),
    discoverNodes: () => ipcRenderer.invoke("lcl:discoverNodes"),
    nodes: (force) => ipcRenderer.invoke("lcl:nodes", !!force),
    nodeList: () => ipcRenderer.invoke("lcl:nodeList"),
    nodeAdd: (spec) => ipcRenderer.invoke("lcl:nodeAdd", spec),
    nodeRemove: (id) => ipcRenderer.invoke("lcl:nodeRemove", id),
    nodeSetup: (id) => ipcRenderer.invoke("lcl:nodeSetup", id),
    nodeLink: (id, port) => ipcRenderer.invoke("lcl:nodeLink", id, port),
    nodeStats: (id) => ipcRenderer.invoke("lcl:nodeStats", id),
    nodeDash: (id) => ipcRenderer.invoke("lcl:nodeDash", id),
    openExternal: (url) => ipcRenderer.invoke("lcl:openExternal", url),
    scanLan: () => ipcRenderer.invoke("lcl:scanLan"),
    nodeHostKey: (host) => ipcRenderer.invoke("lcl:nodeHostKey", host),
    nodePinHostKey: (host, expect) => ipcRenderer.invoke("lcl:nodePinHostKey", host, expect),
    micTrace: (step, detail) => ipcRenderer.invoke("lcl:micTrace", step, detail),
    sessionPerms: (id) => ipcRenderer.invoke("lcl:sessionPerms", id),
    revokeTrustedEndpoint: (id, endpointId) =>
        ipcRenderer.invoke("lcl:revokeTrustedEndpoint", id, endpointId),
    setSessionPerm: (id, key, value) => ipcRenderer.invoke("lcl:setSessionPerm", id, key, value),
    setSessionAnswerLike: (id, text) => ipcRenderer.invoke("lcl:setSessionAnswerLike", id, text),
    setSessionEffort: (id, level) => ipcRenderer.invoke("lcl:setSessionEffort", id, level),
    // the model library: look one up, see what it costs, put it on the node
    modelSearch: (spec) => ipcRenderer.invoke("lcl:modelSearch", spec),
    modelFiles: (id) => ipcRenderer.invoke("lcl:modelFiles", id),
    modelInstall: (spec) => ipcRenderer.invoke("lcl:modelInstall", spec),
    // the software that runs the weights — NVIDIA's Spark playbooks
    stacks: () => ipcRenderer.invoke("lcl:stacks"),
    // ASKED, NOT LISTENED FOR. The push channel never reached the renderer;
    // this reads a record the main process already holds.
    stackProgress: (nodeId) => ipcRenderer.invoke("lcl:stackProgress", nodeId),
    stackPreview: (key) => ipcRenderer.invoke("lcl:stackPreview", key),
    // what is ALREADY running on that machine, asked of the machine itself —
    // an open port is a server that is running, which is the only form of
    // "installed" that decides whether a fourth engine has anywhere to go
    nodePresent: (nodeId) => ipcRenderer.invoke("lcl:nodePresent", nodeId),
    stackInstall: (spec) => ipcRenderer.invoke("lcl:stackInstall", spec),
    modelInstallCancel: (nodeId) => ipcRenderer.invoke("lcl:modelInstallCancel", nodeId),
    onModelInstallProgress: (cb) =>
        ipcRenderer.on("lcl:modelInstallProgress", (_e, d) => cb(d)),
    setSessionAncientKnowledge: (id, on) => ipcRenderer.invoke("lcl:setSessionAncientKnowledge", id, on),
    // compaction edits the SESSION FILE, so it has to happen here rather than in
    // the renderer's copy — see the handler for what the renderer-only version
    // failed to do
    compact: (id, instructions) => ipcRenderer.invoke("lcl:compact", id, instructions),
    forkSession: (id, messageIndex) => ipcRenderer.invoke("lcl:forkSession", id, messageIndex),
    // the exact system prompt + messages the next request will carry — the
    // context panel's audit trail reads THIS, never a paraphrase
    contextSnapshot: (id) => ipcRenderer.invoke("lcl:contextSnapshot", id),
    exportSession: (id) => ipcRenderer.invoke("lcl:exportSession", id),
    // sessions + memory notes → one local sharegpt dataset (nothing uploaded)
    exportTrainingData: (opts) => ipcRenderer.invoke("lcl:exportTrainingData", opts),
    // the GO subscription's five-hour window, computed from the cost ledger
    usageWindow: (sessionId) => ipcRenderer.invoke("lcl:usageWindow", sessionId),
    setGoPlan: (budgets) => ipcRenderer.invoke("lcl:setGoPlan", budgets),
    // Ancient Knowledge auditor model (app-wide; null = same as the session)
    getAncientAuditor: () => ipcRenderer.invoke("lcl:getAncientAuditor"),
    setAncientAuditor: (modelId) => ipcRenderer.invoke("lcl:setAncientAuditor", modelId || null),
    getSessionAkSettings: (id) => ipcRenderer.invoke("lcl:getSessionAkSettings", id),
    setSessionAkSettings: (id, patch) => ipcRenderer.invoke("lcl:setSessionAkSettings", id, patch),
    // "allow for this conversation" from the in-place permission card. Session
    // scoped by construction: it writes session.toolPolicy and never settings.
    setSessionToolPolicy: (id, tool, level) =>
        ipcRenderer.invoke("lcl:setSessionToolPolicy", id, tool, level),
    nodeAuthorize: (spec) => ipcRenderer.invoke("lcl:nodeAuthorize", spec),
    nodeAuthCheck: (spec) => ipcRenderer.invoke("lcl:nodeAuthCheck", spec),
    nodeReadiness: (spec) => ipcRenderer.invoke("lcl:nodeReadiness", spec),
    nodeSudoNoPassword: (spec) => ipcRenderer.invoke("lcl:nodeSudoNoPassword", spec),
    sessionsOnPort: (spec) => ipcRenderer.invoke("lcl:sessionsOnPort", spec),
    localModels: () => ipcRenderer.invoke("lcl:localModels"),
    localModelRemove: (file) => ipcRenderer.invoke("lcl:localModelRemove", file),
    nodeDoorSetup: (id, port) => ipcRenderer.invoke("lcl:nodeDoorSetup", id, port),
    nodeFunnelGrant: (id, port) => ipcRenderer.invoke("lcl:nodeFunnelGrant", id, port),
    nodeArmFinish: (id) => ipcRenderer.invoke("lcl:nodeArmFinish", id),
    sshKeys: () => ipcRenderer.invoke("lcl:sshKeys"),
    sshKeygen: (name) => ipcRenderer.invoke("lcl:sshKeygen", name),
    sshKeyDelete: (id) => ipcRenderer.invoke("lcl:sshKeyDelete", id),
    setSessionSshKey: (id, keyId) => ipcRenderer.invoke("lcl:setSessionSshKey", id, keyId),
    listComPorts: () => ipcRenderer.invoke("lcl:listComPorts"),
    inspectDevices: (opts) => ipcRenderer.invoke("lcl:inspectDevices", opts || {}),
    patchAvailable: () => ipcRenderer.invoke("lcl:patchAvailable"),
    patchOpen: (sessionId, scope) => ipcRenderer.invoke("lcl:patchOpen", sessionId, scope),
    patchReview: (id) => ipcRenderer.invoke("lcl:patchReview", id),
    patchDiscard: (id) => ipcRenderer.invoke("lcl:patchDiscard", id),
    surveyRepoShape: () => ipcRenderer.invoke("lcl:surveyRepoShape"),
    machineInventory: () => ipcRenderer.invoke("lcl:machineInventory"),
    analyseMemory: () => ipcRenderer.invoke("lcl:analyseMemory"),
    proposeMemoryScript: (sel, sessionId) =>
        ipcRenderer.invoke("lcl:proposeMemoryScript", sel, sessionId),
    unloadModel: () => ipcRenderer.invoke("lcl:unloadModel"),
    setIdleUnload: (min) => ipcRenderer.invoke("lcl:setIdleUnload", min),
    onEngineState: (cb) => ipcRenderer.on("lcl:engineState", (_e, s) => cb(s)),
    confirm: (opts) => ipcRenderer.invoke("lcl:confirm", opts),

    // engine
    // the session decides which backend has to be alive, so it has to travel
    checkHealth: (sessionId) => ipcRenderer.invoke("lcl:checkHealth", sessionId || null),
    engineStatus: () => ipcRenderer.invoke("lcl:engineStatus"),
    restartEngine: () => ipcRenderer.invoke("lcl:restartEngine"),
    chooseModel: () => ipcRenderer.invoke("lcl:chooseModel"),
    listSessions: () => ipcRenderer.invoke("lcl:listSessions"),
    createSession: (title) => ipcRenderer.invoke("lcl:createSession", title),
    getSession: (id) => ipcRenderer.invoke("lcl:getSession", id),
    renameSession: (id, title) => ipcRenderer.invoke("lcl:renameSession", id, title),
    setSessionNotify: (id, muted) => ipcRenderer.invoke("lcl:setSessionNotify", id, muted),
    markSessionRead: (id) => ipcRenderer.invoke("lcl:markSessionRead", id),
    diag: (rec) => ipcRenderer.invoke("lcl:diag", rec),
    deleteSession: (id) => ipcRenderer.invoke("lcl:deleteSession", id),
    chat: (id, content) => ipcRenderer.invoke("lcl:chat", id, content),
    trainingSources: () => ipcRenderer.invoke("lcl:trainingSources"),
    sparkModes: () => ipcRenderer.invoke("lcl:sparkModes"),
    sparkMode: (nodeId, mode) => ipcRenderer.invoke("lcl:sparkMode", nodeId, mode),
    nodeTrain: (nodeId) => ipcRenderer.invoke("lcl:nodeTrain", nodeId),
    onNodeTrainState: (cb) => ipcRenderer.on("lcl:nodeTrainState", (_e, d) => cb(d)),
    trainingSync: (src) => ipcRenderer.invoke("lcl:trainingSync", src),
    trainingExport: () => ipcRenderer.invoke("lcl:trainingExport"),
    // attachments: staged onto the SESSION file, consumed by its next turn
    chooseAttachments: (id) => ipcRenderer.invoke("lcl:chooseAttachments", id),
    stageAttachment: (id, ref) => ipcRenderer.invoke("lcl:stageAttachment", id, ref),
    unstageAttachment: (id, attId) => ipcRenderer.invoke("lcl:unstageAttachment", id, attId),
    cancelChat: (sessionId) => ipcRenderer.invoke("lcl:cancelChat", sessionId),
    sessionStatuses: () => ipcRenderer.invoke("lcl:sessionStatuses"),
    onSessionStatus: (cb) => ipcRenderer.on("lcl:sessionStatus", (_e, s) => cb(s)),
    onProgress: (cb) => ipcRenderer.on("lcl:progress", (_e, info) => cb(info)),
    onTask: (cb) => ipcRenderer.on("lcl:task", (_e, task) => cb(task)),
    // clicking an OS notification jumps to the session that is waiting
    onFocusSession: (cb) => ipcRenderer.on("lcl:focusSession", (_e, d) => cb(d)),
    // main raises a silent toast and asks the renderer for the sound, so the
    // OS never adds its own on top — see chime() in main.js
    onChime: (cb) => ipcRenderer.on("lcl:chime", (_e, d) => cb(d)),
    onSparkModeState: (cb) => ipcRenderer.on("lcl:sparkModeState", (_e, d) => cb(d)),
    onNodeDoorReady: (cb) => ipcRenderer.on("lcl:nodeDoorReady", (_e, d) => cb(d)),
    listFiles: (id) => ipcRenderer.invoke("lcl:listFiles", id),
    viewFile: (id, relPath) => ipcRenderer.invoke("lcl:viewFile", id, relPath),
    openFileWindow: (id, relPath) => ipcRenderer.invoke("lcl:openFileWindow", id, relPath),
    openFileExternal: (id, relPath) => ipcRenderer.invoke("lcl:openFileExternal", id, relPath),
    revealFile: (id, relPath) => ipcRenderer.invoke("lcl:revealFile", id, relPath),
    listModels: (sessionId) => ipcRenderer.invoke("lcl:listModels", sessionId || null),
    setModel: (modelId, scope) => ipcRenderer.invoke("lcl:setModel", modelId, scope || null),
    planModel: (modelId) => ipcRenderer.invoke("lcl:planModel", modelId),
    linkRepo: (id) => ipcRenderer.invoke("lcl:linkRepo", id),
    pickFolder: (id) => ipcRenderer.invoke("lcl:pickFolder", id),
    grantFolder: (id, folder) => ipcRenderer.invoke("lcl:grantFolder", id, folder),
    unlinkRepo: (id) => ipcRenderer.invoke("lcl:unlinkRepo", id),
    revertChange: (id, changeId) => ipcRenderer.invoke("lcl:revertChange", id, changeId),
    deleteMessages: (id, indexes) => ipcRenderer.invoke("lcl:deleteMessages", id, indexes),
    revealFolder: (folder) => ipcRenderer.invoke("lcl:revealFolder", folder),
    listServers: () => ipcRenderer.invoke("lcl:listServers"),
    // GitHub as a connected account (APIs & Connections)
    githubStatus: () => ipcRenderer.invoke("lcl:githubStatus"),
    githubConnect: () => ipcRenderer.invoke("lcl:githubConnect"),
    githubDisconnect: (account) => ipcRenderer.invoke("lcl:githubDisconnect", account),
    // patch notification + one-click install
    patchStatus: () => ipcRenderer.invoke("lcl:patchStatus"),
    applyPatch: () => ipcRenderer.invoke("lcl:applyPatch"),
    onPatchAvailable: (cb) => ipcRenderer.on("lcl:patch-available", (_e, p) => cb(p)),
    // download progress while a network patch is being fetched — without it the
    // button reads a frozen "launching…" for the whole multi-minute download
    onPatchProgress: (cb) => ipcRenderer.on("lcl:patch-progress", (_e, p) => cb(p)),
    // OPEN IN: launch the workspace folder in Explorer / VS Code / a chosen app
    listOpeners: () => ipcRenderer.invoke("lcl:listOpeners"),
    openWith: (opener, folder) => ipcRenderer.invoke("lcl:openWith", opener, folder),
    pickOpenerApp: () => ipcRenderer.invoke("lcl:pickOpenerApp"),
    removeOpener: (id) => ipcRenderer.invoke("lcl:removeOpener", id),
    capabilityMap: () => ipcRenderer.invoke("lcl:capabilityMap"),
    setToolPolicy: (tool, level) => ipcRenderer.invoke("lcl:setToolPolicy", tool, level),
    // App-function dials (write mode, grounding). This line was MISSING while
    // the renderer called window.lcl.setBehavior(...) behind a .catch(() => null)
    // — so the "ask before every write" selector and the grounding toggle threw
    // on every change and silently reverted. A security control that appears to
    // work is worse than one that is absent, and the swallowed rejection is why
    // it went unnoticed: tests/preload-contract.js now diffs this surface
    // against every window.lcl.* call in the renderer.
    setBehavior: (key, value) => ipcRenderer.invoke("lcl:setBehavior", key, value),
    // Bring your own endpoint. A key travels renderer -> main ONCE, on
    // setCloudKey/linkCloudEndpoint, and never comes back: every read path
    // returns hasKey, a boolean.
    // ONE call for the whole thing: paste an address (+ key) and it connects.
    // The second argument carries what the address itself cannot say — { rented,
    // provider } for a GPU billed by the hour. Dropping it here made the Connect
    // box's rented checkbox a control with no wire behind it: the flag reached
    // this line and stopped, so every rented box was filed as ordinary hardware.
    connectCloud: (pasted, opts) => ipcRenderer.invoke("lcl:connectCloud", pasted, opts),
    // live cost while typing, and the rate table the user can override
    estimateCost: (text, contextTokens, sessionId) =>
        ipcRenderer.invoke("lcl:estimateCost", text, contextTokens, sessionId || null),
    modelRates: () => ipcRenderer.invoke("lcl:modelRates"),
    modelIntel: () => ipcRenderer.invoke("lcl:modelIntel"),
    toolGroups: () => ipcRenderer.invoke("lcl:toolGroups"),
    setSessionTaskModels: (id, map) => ipcRenderer.invoke("lcl:setSessionTaskModels", id, map),
    setPreferredModel: (id) => ipcRenderer.invoke("lcl:setPreferredModel", id),
    // who you are, so the model stops starting every session blank
    // reading the shipped books, not searching them
    knowledgeShelf: () => ipcRenderer.invoke("lcl:knowledgeShelf"),
    // CONTRACT K6 — ONE knowledge API. The shipped corpus and the user's own
    // folders arrive as one list; a document opens as ITSELF; extracted text is
    // never a document and openKnowledgeDoc refuses it by path. Without these
    // three the panel falls through to the older calls and an uninstalled source
    // can only be reported as "not on disk", which is the defect, not the state.
    // CONTRIBUTOR SHIP — the release ritual from the Patch menu, contributors
    // only; every step streamed back through onContribProgress
    contribStatus: () => ipcRenderer.invoke("lcl:contribStatus"),
    contribPickRepo: () => ipcRenderer.invoke("lcl:contribPickRepo"),
    contribPlan: () => ipcRenderer.invoke("lcl:contribPlan"),
    contribDraft: () => ipcRenderer.invoke("lcl:contribDraft"),
    contribRun: (opts) => ipcRenderer.invoke("lcl:contribRun", opts),
    contribCancel: () => ipcRenderer.invoke("lcl:contribCancel"),
    onContribProgress: (cb) => ipcRenderer.on("lcl:contribProgress", (_e, p) => cb(p)),
    knowledgeLibraries: () => ipcRenderer.invoke("lcl:knowledgeLibraries"),
    // the badge's number, cheap enough to ask at boot — never the inventory
    knowledgeMissingCount: () => ipcRenderer.invoke("lcl:knowledgeMissingCount"),
    openKnowledgeDoc: (id) => ipcRenderer.invoke("lcl:openKnowledgeDoc", id),
    fetchKnowledgeSource: (id) => ipcRenderer.invoke("lcl:fetchKnowledgeSource", id),
    // the renderer accepts either name (`fetchKnowledgeSource || fetchKnowledgeDoc`);
    // both are bridged so neither probe can fall through to a dead control
    fetchKnowledgeDoc: (id) => ipcRenderer.invoke("lcl:fetchKnowledgeSource", id),
    readKnowledgeDoc: (rel, from, count) =>
        ipcRenderer.invoke("lcl:readKnowledgeDoc", rel, from, count),
    profile: () => ipcRenderer.invoke("lcl:profile"),
    setProfile: (next) => ipcRenderer.invoke("lcl:setProfile", next),
    setModelRate: (modelId, rate) => ipcRenderer.invoke("lcl:setModelRate", modelId, rate),
    viewKnowledgeFile: (libId, relPath) =>
        ipcRenderer.invoke("lcl:viewKnowledgeFile", libId, relPath),
    learned: () => ipcRenderer.invoke("lcl:learned"),
    forgetLearned: (name) => ipcRenderer.invoke("lcl:forgetLearned", name || null),
    setTone: (id) => ipcRenderer.invoke("lcl:setTone", id),
    voiceLines: () => ipcRenderer.invoke("lcl:voiceLines"),
    cloudState: (sessionId) => ipcRenderer.invoke("lcl:cloudState", sessionId || null),
    linkCloudEndpoint: (spec) => ipcRenderer.invoke("lcl:linkCloudEndpoint", spec),
    unlinkCloudEndpoint: (id) => ipcRenderer.invoke("lcl:unlinkCloudEndpoint", id),
    setCloudKey: (id, key) => ipcRenderer.invoke("lcl:setCloudKey", id, key),
    testCloudEndpoint: (id) => ipcRenderer.invoke("lcl:testCloudEndpoint", id),
    discoverCloudModels: (id) => ipcRenderer.invoke("lcl:discoverCloudModels", id),
    selectCloudModel: (spec) => ipcRenderer.invoke("lcl:selectCloudModel", spec),
    // durable task ledger: see running work, stop it, review what ran
    listTasks: (opts) => ipcRenderer.invoke("lcl:listTasks", opts),
    cancelTask: (id) => ipcRenderer.invoke("lcl:cancelTask", id),
    clearFinishedTasks: () => ipcRenderer.invoke("lcl:clearFinishedTasks"),
    // ---------------------------------------------------------------
    // ASK BEFORE EVERY REMOTE CALL — contract K3.
    //
    // The dropdown for this existed and was believed for weeks while nothing
    // consulted it: cloudAutoApprove was written by setBehavior and read back
    // only to paint itself, which is why the operator "never saw any
    // escalation attempts. or requests." main.js now holds the turn and asks
    // through these two lines. onRemoteApproval receives
    // { id, model, endpoint, destination, estCostUsd }; the answer is one of
    // "once" | "always" | "deny", and anything else main treats as a deny.
    // ---------------------------------------------------------------
    onRemoteApproval: (cb) => ipcRenderer.on("lcl:remoteApproval", (_e, req) => cb(req)),
    // the other half of the same contract: main settled the ask without an
    // answer (timeout / Stop / no window), so the card must go
    onRemoteApprovalWithdrawn: (cb) =>
        ipcRenderer.on("lcl:remoteApprovalWithdrawn", (_e, info) => cb(info)),
    // a send that skipped the ask because this conversation trusts the
    // endpoint — drawn as a quiet line so no message leaves unrecorded
    onRemoteSendAllowed: (cb) =>
        ipcRenderer.on("lcl:remoteSendAllowed", (_e, info) => cb(info)),
    answerRemoteApproval: (id, verdict) =>
        ipcRenderer.invoke("lcl:answerRemoteApproval", id, String(verdict || "deny")),

    // ASK BEFORE A SECRET LEAVES — A.5. A shared session (send-secrets on) that
    // is about to send a DETECTED secret out is stopped here: main asks, the
    // renderer shows a blocking card, and the answer is "send" | "redact". Same
    // two-line shape as the remote-call ask; main fails closed (redact) if the
    // card is never answered.
    onSecretEgress: (cb) => ipcRenderer.on("lcl:secretEgress", (_e, req) => cb(req)),
    answerSecretEgress: (id, action) =>
        ipcRenderer.invoke("lcl:answerSecretEgress", id, String(action || "redact")),

    // ---------------------------------------------------------------
    // THE TERMINAL — contract K5. A real shell, no sandbox, no approval.
    //
    // These four calls are reachable ONLY from the renderer, driven by a
    // keystroke. There is deliberately no tool, no manifest entry and no agent
    // path to terminalWrite: the entire reason this surface is allowed to skip
    // the approval machinery is that a human is the one typing. Adding an
    // agent-reachable route to it would remove the ground that argument stands
    // on — tests/preload-contract.js fails if anyone ever does.
    // ---------------------------------------------------------------
    terminalStart: (cols, rows) => ipcRenderer.invoke("lcl:terminalStart", cols, rows),
    terminalWrite: (id, data) => ipcRenderer.invoke("lcl:terminalWrite", id, data),
    terminalResize: (id, cols, rows) => ipcRenderer.invoke("lcl:terminalResize", id, cols, rows),
    terminalKill: (id) => ipcRenderer.invoke("lcl:terminalKill", id),
    terminalList: () => ipcRenderer.invoke("lcl:terminalList"),
    onTerminalData: (cb) => ipcRenderer.on("lcl:terminalData", (_e, id, chunk) => cb(id, chunk)),
    // A shell that dies has to say so. Without this the panel keeps a dead
    // shell marked running and keeps accepting keystrokes for it, every one of
    // which main answers with "no such terminal" into a void.
    onTerminalExit: (cb) => ipcRenderer.on("lcl:terminalExit", (_e, id, code) => cb(id, code)),

    // knowledge libraries (local RAG over reference folders)
    listLibraries: () => ipcRenderer.invoke("lcl:listLibraries"),
    listResearch: () => ipcRenderer.invoke("lcl:listResearch"),
    adoptResearch: (id, dir) => ipcRenderer.invoke("lcl:adoptResearch", id, dir),
    libraryContents: (libId, opts) => ipcRenderer.invoke("lcl:libraryContents", libId, opts),
    addLibrary: (id) => ipcRenderer.invoke("lcl:addLibrary", id),
    reindexLibrary: (id, libId) => ipcRenderer.invoke("lcl:reindexLibrary", id, libId),
    removeLibrary: (id, libId) => ipcRenderer.invoke("lcl:removeLibrary", id, libId)
});
