const { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerMonitor, Notification } = require("electron");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const paths = require("../.lcl.engine/core/paths");
const publicDns = require("../.lcl.engine/core/publicDns");
const engine = require("../.lcl.engine/core/engine");
const sessions = require("../.lcl.engine/core/sessions");
const agent = require("../.lcl.engine/core/agent");
const orchestrator = require("../.lcl.engine/core/orchestrator");
const ancientKnowledge = require("../.lcl.engine/core/ancientKnowledge");
const compaction = require("../.lcl.engine/core/compaction");
const sessionFork = require("../.lcl.engine/core/sessionFork");
const trainingExport = require("../.lcl.engine/core/trainingExport");
const usageWindow = require("../.lcl.engine/core/usageWindow");
const selfAudit = require("../.lcl.engine/core/selfAudit");
const fsTools = require("../.lcl.engine/core/fsTools");
const backups = require("../.lcl.engine/core/backups");
const scriptRunner = require("../.lcl.engine/core/scriptRunner");
const policyBridge = require("../.lcl.engine/core/policyBridge");
const sessionPerms = require("../.lcl.engine/core/sessionPerms");
const riskLevel = require("../.lcl.engine/core/riskLevel");
const { sparkWindowFor } = require("../.lcl.engine/core/sparkWindow");
const sandbox = require("../.lcl.engine/core/sandbox");
const deviceScan = require("../.lcl.engine/core/deviceScan");
const patchBay = require("../.lcl.engine/core/patchBay");
const repoShape = require("../.lcl.engine/core/repoShape");
const tailor = require("../.lcl.engine/core/tailor");
const voice = require("../.lcl.engine/core/voice");
const machine = require("../.lcl.engine/core/machine");
const capabilities = require("../.lcl.engine/core/capabilities");
const serve = require("../.lcl.engine/core/serve");
const githubAuth = require("../.lcl.engine/core/githubAuth");
const tasks = require("../.lcl.engine/core/tasks");
const memoryAdvisor = require("../.lcl.engine/core/memoryAdvisor");
const imageGen = require("../.lcl.engine/core/imageGen");
const embedIndex = require("../.lcl.engine/core/embedIndex");
const knowledge = require("../.lcl.engine/core/knowledge");
const speech = require("../.lcl.engine/core/speech");
const ledger = require("../.lcl.engine/core/ledger");
const router = require("../.lcl.engine/core/router");
const research = require("../.lcl.engine/core/research");
const ocrTools = require("../.lcl.engine/core/ocrTools");
const docTools = require("../.lcl.engine/core/docTools");
const reranker = require("../.lcl.engine/core/reranker");
const engagements = require("../.lcl.engine/core/engagements");
const cloudModels = require("../.lcl.engine/core/cloudModels");
const tokenCost = require("../.lcl.engine/core/tokenCost");
const nodeMemory = require("../.lcl.engine/core/nodeMemory");
const profile = require("../.lcl.engine/core/profile");
const { AuditLog } = require("../.lcl.engine/policy/audit");
const { TOOL_CLASS } = require("../.lcl.engine/policy/classify");

// same log the policy kernel writes to, so approvals sit beside decisions
const auditLog = new AuditLog(path.join(paths.dataDir(), "audit"));

/**
 * THE ERROR LOG — a core function, in the operator's words: "you should be
 * having error logs ... so if this is not working, we need to be able to debug
 * with logs, not me finding an error prompt and showing you."
 *
 * Every failure a handler swallows into an { error } return, every rejected
 * async handler, and every uncaught exception lands here as one JSON line —
 * append-only and rotated exactly like the audit trail. Local-only, in the
 * data dir: data/logs/errors.jsonl. Reading it is how a person (or a model
 * with the folder linked) debugs a live install without screenshot archaeology.
 */
const errorLog = new AuditLog(path.join(paths.dataDir(), "logs"), "errors.jsonl");
function logError(where, err, extra = {}) {
    try {
        errorLog.write({
            kind: "error", where,
            message: String((err && err.message) || err).slice(0, 600),
            stack: err && err.stack ? String(err.stack).split(String.fromCharCode(10)).slice(0, 6).join(" | ") : undefined,
            ...extra
        });
    } catch { /* the error log must never create errors of its own */ }
}
// PROCESS-LEVEL: log and preserve default lifecycle — these listeners observe,
// they do not rescue. A main-process crash still crashes; it just leaves a trace.
process.on("uncaughtException", (err) => {
    logError("uncaughtException", err);
    console.error("uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
    logError("unhandledRejection", reason);
});

// NOTHING DIES UNRECORDED. Before this, an uncaught main-process error left NO
// trace anywhere — the renderer's death was audited (render-process-gone) but
// main's own was invisible, which is exactly the blindness that made the VPN
// failures undiagnosable from the logs. These records are the floor of the
// self-diagnosis ledger the patch pipeline reads: readable text + stack +
// metadata, in the same append-only audit stream as everything else.
process.on("uncaughtException", (err) => {
    try {
        auditLog.write({ kind: "main-uncaught", error: String(err && err.message || err),
                         stack: String(err && err.stack || "").slice(0, 2000), at: Date.now() });
    } catch { /* the log must never take the process down with it */ }
});
process.on("unhandledRejection", (reason) => {
    try {
        auditLog.write({ kind: "main-unhandled-rejection", error: String(reason && reason.message || reason),
                         stack: String(reason && reason.stack || "").slice(0, 2000), at: Date.now() });
    } catch { /* ditto */ }
});

// AN ENDPOINT ID CHANGED — EVERY CONVERSATION THAT NAMED IT FOLLOWS.
//
// Endpoint ids are keyed on the address, so healing an old shared slot (or
// splitting one host into two providers, which is what Zen and GO are) renames
// them. cloudModels owns endpoints; it does not own session files, so it calls
// out here rather than learning to read them.
cloudModels.setEndpointRenameHook((fromId, toId) => {
    let moved = 0;
    try { moved = sessions.repointEndpoint(fromId, toId); } catch { moved = 0; }
    auditLog.write({ kind: "endpoint-renamed", from: fromId, to: toId,
                     sessionsRepointed: moved, at: Date.now() });
});

// Everything runs in-process: the renderer talks to this file over IPC, and
// this file talks to the local engine. There is no HTTP API for another
// process (or a web page) to reach, so no localhost attack surface exists.

let mainWindow = null;

// -------------------------------------------------------------
// WINDOW — frameless; all chrome is drawn by the UI
// -------------------------------------------------------------
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1360,
        height: 880,
        minWidth: 1040,
        minHeight: 660,
        show: false,
        frame: false,
        backgroundColor: "#050505",
        title: ".lcl",
        icon: path.join(__dirname, "assets", "icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    // MICROPHONE, AND NOTHING ELSE. Chromium asks the EMBEDDER for every
    // permission a page requests, and Electron's default answer is a shrug
    // that varies by version — on this one, getUserMedia was silently denied,
    // which is why the mic button armed, recorded nothing, and transcribed
    // silence. Deny-by-default with one named exception: audio capture for
    // local dictation. Camera, geolocation, notifications from the page, and
    // everything else stay denied.
    const ses = mainWindow.webContents.session;
    // typeof-guarded: the ipc-approval suite boots this file under a stub
    // electron whose session object has no permission API, and a version of
    // Electron that drops one of these methods should degrade to default
    // behaviour rather than crash the window into existence half-made
    // clipboard-sanitized-write is what Chromium asks for when the renderer
    // calls navigator.clipboard.writeText — the deny-all-but-audio version of
    // this handler silently broke EVERY copy button in the app the day the
    // mic landed, because the rejection surfaces nowhere.
    if (ses && typeof ses.setPermissionRequestHandler === "function")
    ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
        if (permission === "clipboard-sanitized-write") return cb(true);
        const wantsAudio = permission === "media"
            && (!details || !details.mediaTypes || details.mediaTypes.includes("audio"))
            && (!details || !details.mediaTypes || !details.mediaTypes.includes("video"));
        cb(wantsAudio);
    });
    if (ses && typeof ses.setPermissionCheckHandler === "function")
    ses.setPermissionCheckHandler((_wc, permission, _origin, details) => {
        if (permission === "clipboard-sanitized-write") return true;
        return permission === "media"
            && (!details || details.mediaType === undefined || details.mediaType === "audio");
    });

    // A DEAD RENDERER MUST NOT LOOK LIKE A BLACK WINDOW.
    //
    // Pressing the microphone killed the renderer process outright. The window
    // stayed open, painted black, and swallowed every click and keypress — and
    // nothing anywhere said a process had died. Confirmed by listing the app's
    // children: main, gpu-process, utility, utility, and no renderer at all.
    // Now the reason is recorded, the operator is told in words, and the page
    // is reloaded so the app is usable again instead of a black rectangle.
    mainWindow.webContents.on("render-process-gone", (_e, details) => {
        const why = `${details && details.reason} (exit ${details && details.exitCode})`;
        try {
            auditLog.write({ kind: "renderer-gone", reason: (details || {}).reason || "?",
                             exitCode: (details || {}).exitCode, at: Date.now() });
        } catch { /* logging must not compound a crash */ }
        try {
            if (Notification.isSupported()) {
                new Notification({
                    title: ".lcl recovered from a crash",
                    body: `The window stopped responding (${why}) and has been ` +
                          "reloaded. Your sessions are on disk and were not lost.",
                    // THE ONE TOAST THAT KEEPS THE OS SOUND. Every other one is
                    // silent because the renderer plays the app's own — but the
                    // renderer is precisely what just died here, so this is the
                    // only sound available.
                    silent: false
                }).show();
            }
        } catch { /* no notifications available */ }
        if (details && details.reason === "clean-exit") return;   // ordinary quit
        try { if (!mainWindow.isDestroyed()) mainWindow.reload(); } catch { /* gone */ }
    });
    mainWindow.webContents.on("unresponsive", () => {
        try { auditLog.write({ kind: "renderer-unresponsive", at: Date.now() }); }
        catch { /* best effort */ }
    });

    // Hard lock: a single local page. No navigation, no new windows, no webviews.
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());

    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
    mainWindow.once("ready-to-show", () => {
        // TAKE THE FRONT ON LAUNCH, without pinning. A fresh process the operator
        // just started is allowed to show and focus itself. NO always-on-top: the
        // z-bump hack stranded the window topmost over everything on the operator's
        // machine (see showMainWindow), which is far worse than the rare "opens a
        // touch behind" it was meant to cure.
        mainWindow.show();
        mainWindow.focus();
        setTimeout(healStaleEndpoints, 1500);
        setTimeout(startDoorWatch, 4000);
        // PROVE THE SANDBOX BEFORE ANYTHING CLAIMS IT. A canary runs inside a
        // real box and tries to write outside it; only a refusal earns the
        // word "boundary" in the UI. Off the startup path so a slow probe
        // never delays the window.
        // BOXES FROM A PREVIOUS RUN belong to no live session - nothing can be
        // using them, and leaving them is how scratch becomes clutter the
        // operator has to reason about.
        try { for (const b of sandbox.list()) sandbox.destroy(b.id); }
        catch { /* first run */ }
        setTimeout(() => {
            sandbox.verify()
                .then(iso => auditLog.write({ kind: "sandbox-verified", boundary: iso.kind,
                                              verified: !!iso.verified,
                                              proof: String(iso.proof || "").slice(0, 200),
                                              at: Date.now() }))
                .catch(() => { /* the panel reports it either way */ });
        }, 2500);
    });

    buildTray();

    // CLOSE HIDES, QUIT QUITS. A turn in flight — especially one on the node,
    // which can think for minutes — survives the window going away, and says
    // so once, the first time, rather than silently seeming to have exited.
    mainWindow.on("close", (e) => {
        if (quitting || !tray) return;             // real quit, or no tray to hide to
        e.preventDefault();
        mainWindow.hide();
        if (!trayHintShown) {
            trayHintShown = true;
            try {
                if (Notification.isSupported()) {
                    new Notification({
                        title: ".lcl is still running",
                        body: "It is in the system tray and will tell you when work " +
                              "finishes. Quit for real from the tray icon.",
                        silent: true
                    }).show();
                }
            } catch { /* the hide already happened, which is the point */ }
        }
    });

    const push = () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("lcl:windowState", { maximized: mainWindow.isMaximized() });
        }
    };
    mainWindow.on("maximize", push);
    mainWindow.on("unmaximize", push);

    return mainWindow;
}

// -------------------------------------------------------------
// POP-OUT FILE WINDOWS
// -------------------------------------------------------------
/**
 * "i would also like to be able to open in a new window. and that be a framed
 *  pop out, fully sizeable in this ui"
 *
 * A separate BrowserWindow per popped-out file. FRAMED on purpose — the OS
 * frame is what makes it independently sizeable, snappable and closeable
 * without this app re-implementing window management for a satellite window.
 * Same preload, same sandbox, same one-page lock as the main window; the only
 * page it can load is viewer.html, and the only data path in is the same
 * lcl:viewFile IPC the in-panel viewer uses, root-contained per session.
 */
const fileWindows = new Map();          // "sessionId|rel" -> BrowserWindow

function openFileWindow(sessionId, relPath) {
    const key = sessionId + "|" + relPath;
    const existing = fileWindows.get(key);
    if (existing && !existing.isDestroyed()) {
        existing.focus();
        return { ok: true, focused: true };
    }
    const win = new BrowserWindow({
        width: 780,
        height: 720,
        minWidth: 380,
        minHeight: 300,
        show: false,
        frame: true,
        autoHideMenuBar: true,
        backgroundColor: "#050505",
        title: path.basename(relPath) + " — .lcl",
        icon: path.join(__dirname, "assets", "icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.loadFile(path.join(__dirname, "renderer", "viewer.html"), {
        query: { session: sessionId, rel: relPath }
    });
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => fileWindows.delete(key));
    fileWindows.set(key, win);
    return { ok: true };
}

// -------------------------------------------------------------
// LIFECYCLE
// -------------------------------------------------------------
// MAINTENANCE MODE COMES FIRST — Apps & Features launches `.lcl.exe --uninstall`
// and `.lcl.exe --repair`, and those must load a small themed window rather than
// the whole application. It never starts the engine and never takes the
// single-instance lock, so it can run while the app is closed or elevate itself
// without fighting a running copy.
const MAINT_MODE = process.argv.includes("--uninstall") ? "uninstall"
                 : process.argv.includes("--repair") ? "repair" : null;

if (MAINT_MODE) {
    Menu.setApplicationMenu(null);
    require("./maintenance").run(MAINT_MODE);
} else if (!app.requestSingleInstanceLock()) {
    // Only one instance may own the engine port and session files.
    app.quit();
} else {
    app.on("second-instance", (_e, argv) => {
        // A PINNED / TASKBAR CLICK ON A TRAY-HIDDEN APP LANDS HERE — the click
        // launches a second process, the single-instance lock rejects it, and
        // this fires in the first. Route it through the SAME restore path the
        // tray click uses, so "click does nothing" is closed by one code path,
        // not a partial reimplementation that drifts from it.
        showMainWindow();
        // a Windows toast button arrives HERE, as an lcl:// argument on a
        // second launch — this is what makes Approve/Reject on the toast real
        for (const a of (argv || [])) {
            if (typeof a === "string" && a.startsWith("lcl://")) handleDeepLink(a);
        }
    });

    // Windows groups taskbar buttons by AppUserModelID. Without setting it to
    // the same id the installer stamps on the shortcut, the running window is
    // treated as a DIFFERENT app — which is why launching from the pinned icon
    // produced a second, separate taskbar button.
    if (process.platform === "win32") {
        app.setAppUserModelId("com.pragoptics.lcl");
    }

    // THE lcl:// SCHEME EXISTS SO A TOAST BUTTON CAN REACH THE APP.
    // Registered for the running binary; in development that means electron
    // plus this script's path, or Windows would hand the URL to the wrong exe.
    try {
        if (process.defaultApp && process.argv.length >= 2) {
            app.setAsDefaultProtocolClient("lcl", process.execPath,
                [path.resolve(process.argv[1])]);
        } else {
            app.setAsDefaultProtocolClient("lcl");
        }
    } catch { /* without it the toast buttons degrade to click-to-open */ }
    // macOS delivers the same thing as an event rather than an argv
    app.on("open-url", (e, url) => { e.preventDefault(); handleDeepLink(url); });

    app.whenReady().then(() => {
        // The UI draws its own menu bar; remove the native strip entirely.
        Menu.setApplicationMenu(null);

        createWindow();

        // idle unload: give ~3.2 GB back when the user walks away
        const savedIdle = paths.readSettings().idleUnloadMinutes;
        engine.setIdleUnloadMs((savedIdle === undefined ? 10 : savedIdle) * 60_000);
        engine.setStateListener((s) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("lcl:engineState", s);
            }
        });
        engine.startIdleWatch();
        // boot is an implicit load: if the preferred model does not fit right
        // now, come up on the best one that does (with a UI notice) instead
        // of greeting the user with a refusal and no model at all.
        //
        // BUT NOT WHEN A REMOTE MODEL IS DRIVING. Every other automatic load
        // asks this first — guard recovery and crash restart both do — and
        // boot skipping it is why a user whose driver is GLM-5.2 was greeted
        // on EVERY launch by a warning that their preferred local model would
        // not fit, while the app loaded a 1.5B nobody was going to use and
        // spent 1.5 GB doing it, on a machine that had 3.8 GB free.
        if (!engine.remoteDriving()) engine.start({ allowFallback: true });

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

/* ---------------------------------------------------------------------------
 * THE TRAY — closing the window must not throw the work away.
 *
 * The requirement: system-tray push notifications, so a user is notified when
 *  the window is closed.
 *
 * Before this, closing the window quit the application, so there was no such
 * thing as "closed but still working" — a remote model mid-answer died with
 * the window. Now the close button hides to the tray, the turn keeps running,
 * and the notification that fires when it finishes brings the window back.
 * Real quit stays available from the tray menu, File > Exit, and Ctrl+Q.
 * ------------------------------------------------------------------------- */
let tray = null;
let quitting = false;
let trayHintShown = false;

function trayIconPath() {
    return path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "mark-small.png");
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // THE ONE RESTORE PATH — used by the tray click AND a pinned-taskbar click
    // (which arrives via second-instance).
    //
    // The 300ms always-on-top PULSE was the bug behind "opens then closes" and
    // "have to minimize to click anything else": if a second restore landed
    // inside the window, or the deferred setAlwaysOnTop(false) was swallowed by
    // its try/catch, the window stayed PINNED above everything — indistinguishable
    // from the app closing again (it is covering, or being covered as focus
    // shifts, with no way to reach past it). The z-order bump Windows actually
    // needs happens the instant a window ENTERS always-on-top and PERSISTS after
    // it leaves — so flipping it true→false in the SAME tick surfaces the window
    // and never leaves it stuck on top. No timer, no pinned state, no race.
    // NO ALWAYS-ON-TOP, NO RAISE-ABOVE. The old z-bump hack left the window
    // stranded topmost on the operator's machine, so other apps opened BEHIND it
    // and the taskbar read as dead until .lcl was minimized. A tray/taskbar click
    // is user input, which Windows lets take the foreground on its own — restore,
    // show, focus, and nothing here that can pin .lcl above the operator's work.
    try {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.setSkipTaskbar(false);
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
    } catch { /* the window is going away; nothing to surface */ }
}

function buildTray() {
    if (tray) return;
    try {
        const { Tray } = require("electron");
        tray = new Tray(trayIconPath());
        // ONE handler, click only. Registering both "click" and "double-click"
        // meant a double-click fired restore twice — the second landing inside
        // the first's old pinned-window window and reading as a flicker/close.
        tray.on("click", showMainWindow);
        paintTray();
    } catch { /* a tray failing must never stop the app starting */ }
}

/**
 * THE TRAY SAYS WHAT IS HAPPENING, NOT JUST THAT THE APP EXISTS.
 *
 * It was a fixed tooltip (".lcl — running") and a three-item menu built once
 * at boot and never touched again. With the window closed and a node grinding
 * through an Ancient Knowledge loop, that icon was the ONLY surface left — and
 * it said nothing about which sessions were working, which had stopped, or
 * which were sitting waiting on an answer.
 *
 * Now it is repainted on every status change: the tooltip carries the counts,
 * and any session that needs the operator is a menu item that opens straight
 * to it. Windows caps a tray tooltip at 127 characters, so the summary is
 * built to stay well inside that.
 */
function paintTray() {
    if (!tray) return;
    try {
        const working = [], needsYou = [], errored = [];
        for (const [id, s] of sessionStatus) {
            if (!s) continue;
            if (s.state === "working") working.push(id);
            else if (s.state === "approval" || s.state === "waiting") needsYou.push(id);
            else if (s.state === "failed") errored.push(id);
        }
        // THE TRAY SURVIVES A RESTART. The status map above is in-memory and
        // empty after a relaunch, so the menu showed nothing even though the
        // session files carry durable stamps: a failure the operator has not
        // read since it happened is still an errored session worth listing.
        // Read off the list() projection — no per-session file opens here.
        try {
            for (const s of sessions.list()) {
                if (sessionStatus.has(s.id)) continue;
                if (s.lastErrorAt && s.lastErrorAt > (s.readAt || 0)
                    && !errored.includes(s.id)) errored.push(s.id);
            }
        } catch { /* the live map alone is still a working tray */ }
        const nameOf = (id) => {
            try {
                const t = (sessions.load(id) || {}).title;
                return String(t || "untitled").slice(0, 40);
            } catch { return "untitled"; }
        };
        const bits = [];
        if (needsYou.length) bits.push(`${needsYou.length} needs you`);
        if (errored.length) bits.push(`${errored.length} failed`);
        if (working.length) bits.push(`${working.length} working`);
        tray.setToolTip((".lcl — " + (bits.length ? bits.join(" · ") : "idle")).slice(0, 120));

        const items = [{ label: "Open .lcl", click: showMainWindow }];
        if (needsYou.length) {
            items.push({ type: "separator" });
            for (const id of needsYou.slice(0, 5)) {
                const st = sessionStatus.get(id) || {};
                items.push({
                    label: `${nameOf(id)} — ${st.detail || "needs you"}`.slice(0, 60),
                    click: () => focusSession(id, st.state === "approval" ? "approval" : "clarify")
                });
            }
        }
        // FAILED sessions get their own group — "navigate to a responding
        // session, or waiting session, or errored session": errored was the
        // one of the three the menu did not list.
        if (errored.length) {
            items.push({ type: "separator" });
            for (const id of errored.slice(0, 5)) {
                const st = sessionStatus.get(id) || {};
                items.push({ label: `${nameOf(id)} — ${st.detail || "failed"}`.slice(0, 60),
                             click: () => focusSession(id, "failed") });
            }
        }
        if (working.length) {
            items.push({ type: "separator" });
            for (const id of working.slice(0, 5)) {
                items.push({ label: `${nameOf(id)} — working…`.slice(0, 60),
                             click: () => focusSession(id, "working") });
            }
        }
        items.push({ type: "separator" },
                   { label: "Quit .lcl", click: () => { quitting = true; app.quit(); } });
        tray.setContextMenu(Menu.buildFromTemplate(items));
    } catch { /* the tray is a convenience; it never breaks the app */ }
}

/** Bring the window up ON a particular session — the one doorway for it. */
function focusSession(sessionId, kind, approvalId) {
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("lcl:focusSession", { sessionId, kind, approvalId });
    }
}

/**
 * WHAT A TOAST BUTTON IS ALLOWED TO DO.
 *
 * `lcl://` is a doorway into this process that anything on the machine can
 * knock on — a web page can navigate to a custom scheme. So the scheme is NOT
 * a general approve endpoint: only an approval this app itself put on a toast,
 * in the last few minutes, can be answered through it. Anything else opens the
 * window at the session and lets the operator decide in the app, which is the
 * behaviour a stray link deserves.
 */
const toastApprovals = new Map();        // approvalId -> shown-at ms
const TOAST_ACTION_WINDOW_MS = 10 * 60 * 1000;

function handleDeepLink(url) {
    try {
        const m = /^lcl:\/\/(approve|reject|open)\/(.*)$/i.exec(String(url || "").trim());
        if (!m) return;
        const verb = m[1].toLowerCase();
        const id = decodeURIComponent(m[2] || "").replace(/[/?#].*$/, "");
        if (verb === "open") { focusSession(id || null, "open"); return; }

        const shownAt = toastApprovals.get(id);
        const fresh = shownAt && (Date.now() - shownAt) < TOAST_ACTION_WINDOW_MS;
        if (!fresh) {
            // never silently act on an id this app did not just raise
            auditLog.write({ kind: "deep-link-refused", verb, approvalId: id,
                             reason: shownAt ? "expired" : "unknown", at: Date.now() });
            focusSession(null, "approval", id);
            return;
        }
        toastApprovals.delete(id);
        auditLog.write({ kind: "deep-link", verb, approvalId: id, at: Date.now() });
        const fn = verb === "approve" ? approveFromNotification : rejectFromNotification;
        Promise.resolve(fn(id)).catch(() => { /* the in-app card remains */ });
        showMainWindow();
    } catch { /* a malformed link is not an error worth surfacing */ }
}

/**
 * YOUR SOUND, NEVER WINDOWS'.
 *
 * A reported bug: the app played both its own notification sound and the
 * Windows system default, when only the app's own sound is wanted. Both were
 * true at once — the renderer plays app/assets/done.wav on the working→idle
 * transition, and main constructed the very same moment's toast with
 * `silent: false`, which is what asks Windows to add its own ding.
 *
 * Every toast this app raises is `silent: true` now, and the audible half is
 * this: the renderer plays the app's own sound. The one exception is the
 * crash-recovery toast, where the renderer is by definition not alive to play
 * anything and the OS sound is the only one available.
 */
function chime(kind) {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("lcl:chime", { kind: kind || "done" });
        }
    } catch { /* a sound must never affect the work */ }
}

/** Is the user actually looking at the app right now? */
function windowIsVisible() {
    return !!(mainWindow && !mainWindow.isDestroyed()
        && mainWindow.isVisible() && !mainWindow.isMinimized());
}

/**
 * Work finished while the user was away. Distinct from notifyWaiting, which
 * is for things that BLOCK — this is the "your answer is ready" that makes
 * closing the window to the tray a usable way to work.
 */
/** The session's own bell: muted means NO tray toast and NO chime for it —
 *  the sidebar dot still moves, because the mute silences noise, not truth. */
function sessionNotifyMuted(sessionId) {
    try { return !!(sessions.load(sessionId) || {}).notifyMuted; }
    catch { return false; }
}

function notifyFinished({ sessionId, title, body }) {
    try {
        if (!Notification.isSupported()) return;
        if (sessionNotifyMuted(sessionId)) return;
        if (windowIsVisible() && mainWindow.isFocused()) return;
        // ON WINDOWS THE CLICK RIDES THE lcl:// PROTOCOL, not the JS "click"
        // event. Our AppUserModelId is set in code but no installed shortcut
        // carries it, so once a plain toast slides into Action Center, Windows
        // resolves its click through the unregistered id and DROPS it — the
        // exact "clicking it doesn't open the session that is notifying".
        // Protocol activation re-enters through the registered lcl:// handler
        // instead, which lands in the same focusSession doorway.
        const win = process.platform === "win32";
        const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const opts = {
            title: title || ".lcl finished",
            body: String(body || "").slice(0, 240),
            // silent at the OS level — the renderer plays the app's own sound,
            // and `false` here is what made Windows add its default ding on top
            silent: true
        };
        if (win && sessionId) {
            opts.toastXml = `<toast activationType="protocol" launch="${
                esc("lcl://open/" + sessionId)}">
  <visual><binding template="ToastGeneric">
    <text>${esc(opts.title)}</text>
    <text>${esc(opts.body)}</text>
  </binding></visual>
  <audio silent="true"/>
</toast>`;
        }
        const n = new Notification(opts);
        n.on("click", () => focusSession(sessionId, "done"));
        n.show();
        chime("done");
    } catch { /* never let a notification affect the work */ }
}

app.on("before-quit", () => { quitting = true; });

app.on("window-all-closed", () => {
    // with close-to-tray this only fires on a real quit; without a tray
    // (creation failed) it must still behave the way it always did
    if (process.platform !== "darwin" && (quitting || !tray)) app.quit();
});

// the engines are child processes; none may outlive the app — the embed
// server was the reviewed gap (it kept running after quit)
// Trip every live cancel token FIRST so a worker stops at a safe point rather
// than being severed mid-file, then stop the engines. The ledger keeps the row,
// so an interrupted job is still visible on the next launch instead of
// vanishing as if it had never run.
// `reranker` was referenced on BOTH these lines and never imported at the top —
// so every shutdown threw ReferenceError on the fourth call and never reached
// the fifth. serve.stopAll() was added to close exactly the leak the comment
// above describes, and it had never once executed: a localhost server a session
// started outlived the app, holding its port. Found the first time a test drove
// the real main process instead of the modules underneath it. Each stop is now
// independent, because one throwing must not orphan the others.
const stopEverything = () => {
    for (const stop of [
        () => engine.stop(), () => embedIndex.stop(), () => ocrTools.stop(),
        () => reranker.stop(), () => serve.stopAll(),
        () => require("../.lcl.engine/core/webScaffold").stopAll()
    ]) {
        try { stop(); } catch { /* a failed stop must not block the rest */ }
    }
};
app.on("before-quit", () => {
    try { tasks.cancelAll(); } catch { /* never block a quit */ }
    try { flushProbeGov(); } catch { /* never block a quit */ }
    stopEverything();
});
process.on("exit", stopEverything);

app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (e) => e.preventDefault());
});

// -------------------------------------------------------------
// WINDOW CONTROLS
// -------------------------------------------------------------
ipcMain.handle("lcl:window", guard((_e, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    if (action === "minimize") mainWindow.minimize();
    else if (action === "toggleMaximize") {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    } else if (action === "close") mainWindow.close();      // hides to the tray
    else if (action === "quit") { quitting = true; app.quit(); }   // File > Exit
    else return { ok: false };
    return { ok: true, maximized: mainWindow.isMaximized() };
}));

// getGPUFeatureStatus() reports "disabled_software" at app-ready even on a
// perfectly good GPU, and only corrects itself after gpu-info-update. Reading
// it early would pin every user to lite mode forever.
let gpuStatus = null;
app.on("gpu-info-update", () => {
    try { gpuStatus = app.getGPUFeatureStatus() || null; } catch { /* no gpu process */ }
});

ipcMain.handle("lcl:renderMode", () => {
    const gc = String((gpuStatus && gpuStatus.gpu_compositing) || "");
    const forced = app.commandLine.hasSwitch("disable-gpu");  // correct immediately
    let battery = false;
    try { battery = powerMonitor.onBatteryPower; } catch { /* not supported */ }
    return {
        software: forced || (!!gc && /software|disabled|unavailable/i.test(gc)),
        gpu_compositing: gc || "pending",
        battery,
        motionPref: paths.readSettings().motionPref || "auto",
        // the intro clip carries an audio track; sound is on unless turned off
        introSound: paths.readSettings().introSound !== false
    };
});

/**
 * Machine resources. The user needs to know when the box is out of headroom —
 * a model load that exceeds free RAM will thrash or fail, and on a 16 GB laptop
 * that happens easily with other apps open.
 */
/**
 * Machine pressure.
 *
 * Free RAM is the WRONG signal on Windows and was actively misleading here: it
 * read "1.9 GB free" while the machine was 9 GB over-committed and thrashing
 * hard enough to stall Explorer's click handling. What predicts paging is
 * COMMIT vs physical RAM.
 *
 * Electron's process.getSystemMemoryInfo() reports commit on Windows as
 * swapTotal/swapFree (verified against Win32_OperatingSystem: 33.69 GB limit,
 * 8.74 GB free), so this needs no subprocess and is cheap enough to poll.
 */
function memorySnapshot() {
    const info = process.getSystemMemoryInfo();      // KB
    const KB = 1024;

    const physTotal = (info.total || 0) * KB;
    // Chromium's "free" on Windows is Available (free + reclaimable standby),
    // which is the number that actually governs whether the machine pages.
    const available = (info.free || 0) * KB;

    const commitLimit = (info.swapTotal || 0) * KB;
    const commitFree = (info.swapFree || 0) * KB;
    // commitFree === 0 is full commit exhaustion, not missing data — see
    // machine.js for the identical fix
    const commitUsed = commitLimit ? Math.max(0, commitLimit - commitFree) : 0;

    // Two independent signals, deliberately kept apart:
    //
    //  availability — how much room is left before Windows must page. THIS is
    //  what the user feels as a sluggish desktop.
    //
    //  commit vs the commit LIMIT — how close allocations are to failing
    //  outright. The limit includes the page file, so commit exceeding
    //  physical RAM is normal and is NOT by itself a problem. An earlier
    //  version reported commit/physical as the headline "pressure" and badly
    //  overstated the severity.
    const availRatio = physTotal ? available / physTotal : 1;
    const commitRatio = commitLimit ? commitUsed / commitLimit : 0;

    let level = "ok";
    if (available < 1.0e9 || commitRatio >= 0.92) level = "critical";
    else if (available < 2.5e9 || commitRatio >= 0.80) level = "low";

    return {
        physTotalBytes: physTotal,
        availableBytes: available,
        physUsedBytes: physTotal - available,
        commitLimitBytes: commitLimit,
        commitUsedBytes: commitUsed,
        commitFreeBytes: commitFree,
        availRatio,
        commitRatio,
        level
    };
}

ipcMain.handle("lcl:systemStats", () => {
    const mem = memorySnapshot();

    let modelBytes = 0;
    const model = paths.findModel();
    if (model) {
        try { modelBytes = fs.statSync(model).size; } catch { /* gone */ }
    }

    const eng = engine.status();
    return {
        ...mem,
        modelBytes,
        engineLoaded: !!eng.running,
        engineIdleSeconds: eng.idleSeconds || 0,
        // a second model must fit in AVAILABLE memory, not just commit space,
        // or it will simply page against the first one
        headroomForAnotherModel: mem.availableBytes - modelBytes > 1.5e9,
        cpuCount: os.cpus().length,
        appRssBytes: process.memoryUsage().rss
    };
});

/** Full resource inventory: memory AND compute. Shared with the future router. */
ipcMain.handle("lcl:machineInventory", () => machine.inventory());

/** Analyse what could be freed. Reports only — proposes nothing by itself. */
ipcMain.handle("lcl:analyseMemory", () => memoryAdvisor.analyse());

/**
 * Turn an analysis into a script PROPOSAL. Goes through the same approval card
 * as anything the model writes, so there is one review path for changes to this
 * machine, and the guard applies here too.
 */
ipcMain.handle("lcl:proposeMemoryScript", guard((_e, selected, sessionId) => {
    const built = memoryAdvisor.buildScript(selected);
    if (!built) return { error: "nothing selected" };

    return scriptRunner.propose({
        script: built.script,
        language: built.language,
        rollback: built.rollback,
        purpose: "Close background applications to free memory. " +
                 "Nothing security, driver or OS related is touched, and every app " +
                 "here reopens normally.",
        // the card is shown in the active session, so the audit records that
        // same session rather than a placeholder — otherwise the trail says one
        // thing and the transcript shows another
        sessionId: sessionId || "machine-view",
        modelId: null,
        engineId: "user"
    });
}));

/**
 * Read-only machine view. Spawned on demand only — never polled — because
 * launching PowerShell costs real memory on a box that is already short.
 */
ipcMain.handle("lcl:processList", () => new Promise((resolve) => {
    const script =
        "Get-Process | Group-Object ProcessName | ForEach-Object { " +
        "[pscustomobject]@{ name=$_.Name; count=$_.Count; " +
        "commit=(($_.Group|Measure-Object PrivateMemorySize64 -Sum).Sum); " +
        "ws=(($_.Group|Measure-Object WorkingSet64 -Sum).Sum) } } | " +
        "Sort-Object commit -Descending | Select-Object -First 30 | ConvertTo-Json -Compress";

    const ps = spawn("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true });

    let out = "";
    let err = "";
    const timer = setTimeout(() => { ps.kill(); resolve({ error: "timed out" }); }, 12000);

    ps.stdout.on("data", d => { out += d; });
    ps.stderr.on("data", d => { err += d; });
    ps.on("error", e => { clearTimeout(timer); resolve({ error: String(e.message || e) }); });
    ps.on("close", () => {
        clearTimeout(timer);
        try {
            const parsed = JSON.parse(out);
            const list = Array.isArray(parsed) ? parsed : [parsed];
            resolve({
                processes: list.filter(Boolean).map(p => ({
                    name: p.name,
                    count: p.count,
                    commitBytes: p.commit || 0,
                    workingBytes: p.ws || 0,
                    // our own footprint, so the user can see what .lcl costs —
                    // the engine process itself is named .lcl.engine
                    mine: /^(electron|llama-server|\.lcl(\.engine)?)$/i.test(p.name)
                })),
                memory: memorySnapshot()
            });
        } catch {
            resolve({ error: err.trim().slice(0, 200) || "could not read process list" });
        }
    });
}));

/**
 * PROCESSES THE USER MAY NOT END FROM HERE.
 *
 * The Machine page exists so someone can free memory without leaving the app.
 * That is a genuinely useful thing to be able to do and a genuinely easy way to
 * take the desktop down, so the list below is a hard refusal rather than a
 * warning: session and window management, the security stack, audio, input,
 * display and the kernel-adjacent services. Ending any of these does not free
 * usable memory — it logs the user out, blanks the screen, or bugchecks.
 *
 * Matching is on the bare process name, case-insensitively, anchored at both
 * ends, because "csrss" must not be reachable by asking to end "notcsrss".
 */
const UNKILLABLE = new Set([
    // session, logon and the shell
    "system", "idle", "registry", "memory compression", "smss", "csrss", "wininit",
    "winlogon", "services", "lsass", "lsaiso", "logonui", "userinit", "dwm",
    "sihost", "fontdrvhost", "explorer", "shellexperiencehost", "startmenuexperiencehost",
    "searchhost", "runtimebroker", "dllhost", "taskhostw", "ctfmon", "conhost",
    // security
    "msmpeng", "nissrv", "securityhealthservice", "securityhealthsystray",
    "mpdefendercoreservice", "smartscreen", "wscsvc", "mssense", "sensecncproxy",
    // hardware: audio, input, display, power
    "audiodg", "svchost", "spoolsv", "igfxem", "igfxcuiservice", "igfxext",
    "nvdisplay.container", "nvcontainer", "atieclxx", "atiesrxx", "rtkauduservice64",
    "textinputhost", "wudfhost", "dasHost", "wmiprvse",
    // us
    ".lcl", "lcl", "electron"
]);

function killRefusal(name) {
    const n = String(name || "").trim().toLowerCase().replace(/\.exe$/, "");
    if (!n) return "no process named";
    if (UNKILLABLE.has(n)) {
        return `${name} is part of Windows itself — ending it would take the ` +
               "desktop down rather than free usable memory.";
    }
    if (/^(system|secure)/i.test(n)) return `${name} is a protected system process.`;
    return null;
}

/**
 * End every instance of a named process.
 *
 * By name rather than by PID because that is the row the user is looking at:
 * "chrome ×14" is one line in the panel and one decision in their head. Killing
 * one of fourteen would free nothing and look broken.
 *
 * Stop-Process, not taskkill /F, so applications get the ordinary shutdown path
 * first. -Force here means "do not prompt", not "terminate without asking the
 * app" — the prompt is the confirmation dialog the renderer already showed.
 */
ipcMain.handle("lcl:endProcess", (_e, name) => new Promise((resolve) => {
    const refusal = killRefusal(name);
    if (refusal) return resolve({ ok: false, error: refusal });

    const clean = String(name).trim().replace(/\.exe$/i, "");
    if (!/^[A-Za-z0-9._+ -]{1,64}$/.test(clean)) {
        return resolve({ ok: false, error: "that process name is not one I can act on" });
    }

    // -Name is bound as a parameter value, and the regex above already rejects
    // quotes, semicolons and backticks, so there is no path from this string
    // into the PowerShell parser.
    const script =
        `$p = Get-Process -Name '${clean}' -ErrorAction SilentlyContinue; ` +
        "if (-not $p) { Write-Output 'GONE'; exit 0 }; " +
        "$n = @($p).Count; " +
        "$p | Stop-Process -Force -ErrorAction SilentlyContinue; " +
        "Start-Sleep -Milliseconds 400; " +
        `$left = @(Get-Process -Name '${clean}' -ErrorAction SilentlyContinue).Count; ` +
        "Write-Output \"$n $left\"";

    const ps = spawn("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true });

    let out = "", err = "";
    const timer = setTimeout(() => { ps.kill(); resolve({ ok: false, error: "timed out" }); }, 15000);
    ps.stdout.on("data", d => { out += d; });
    ps.stderr.on("data", d => { err += d; });
    ps.on("error", e => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }); });
    ps.on("close", () => {
        clearTimeout(timer);
        const t = out.trim();
        if (t === "GONE") return resolve({ ok: true, ended: 0, note: "it had already exited" });
        const m = t.match(/(\d+)\s+(\d+)/);
        if (!m) {
            return resolve({
                ok: false,
                error: err.trim().slice(0, 240) || "Windows would not end that process"
            });
        }
        const had = Number(m[1]), left = Number(m[2]);
        const ended = Math.max(0, had - left);
        if (left > 0 && ended === 0) {
            return resolve({
                ok: false,
                error: "Windows refused — that process is running at a higher " +
                       "privilege than .lcl. Ending it needs Task Manager as administrator."
            });
        }
        resolve({ ok: true, ended, left, memory: memorySnapshot() });
    });
}));

/**
 * Hand off to the Windows tools.
 *
 * Task Manager reopens on whichever tab it was last on and exposes no command
 * line for choosing one — the startup tab lives in a binary registry blob under
 * HKCU, and writing another application's preferences from an installer-grade
 * process is not something this app is going to do. So the second button opens
 * Resource Monitor instead, which IS the per-process performance view and DOES
 * launch straight into it. The tooltips in the UI say exactly this.
 */
ipcMain.handle("lcl:openSystemTool", guard((_e, which) => {
    const target = which === "performance"
        ? { exe: "perfmon.exe", args: ["/res"] }
        : { exe: "taskmgr.exe", args: [] };
    try {
        // via `start` so the child is fully detached and owns its own window;
        // spawning taskmgr directly ties its lifetime to ours.
        const p = spawn("cmd.exe", ["/c", "start", "", target.exe, ...target.args],
            { detached: true, stdio: "ignore", windowsHide: true });
        p.unref();
        return { ok: true, opened: target.exe };
    } catch (e) {
        return { ok: false, error: String(e.message || e) };
    }
}));

/**
 * DICTATION — the microphone button's other half.
 *
 * The renderer records 16 kHz mono PCM through Web Audio and sends a finished
 * wav, so no ffmpeg pass is needed and whisper runs on it directly. Fully
 * local by construction: the audio buffer arrives over IPC, touches a temp
 * file, and is deleted in the same breath. It works in every session,
 * including ones driven by a remote model — dictation is not a reason for a
 * recording of someone's voice to leave the machine.
 */
/**
 * DICTATION, TRACED.
 *
 * A black window appears when the microphone button is pressed, and neither
 * end says why. The renderer reports each step it reaches so the audit log
 * shows exactly how far the sequence gets — mic requested, permission
 * answered, recording started, stopped, transcription called, result — and
 * whatever appears on screen can be lined up against the last step reached.
 * Reading beats guessing, and guessing is what has cost this project days.
 */
ipcMain.handle("lcl:micTrace", guard((_e, step, detail) => {
    auditLog.write({ kind: "mic-trace", step: String(step).slice(0, 40),
                     detail: String(detail === undefined ? "" : detail).slice(0, 200),
                     at: Date.now() });
    return { ok: true };
}));

ipcMain.handle("lcl:transcribeMic", async (_e, wavBuffer) => {
    try {
        auditLog.write({ kind: "mic-trace", step: "transcribe-called",
                         detail: `${(wavBuffer && wavBuffer.byteLength) || 0} bytes`,
                         at: Date.now() });
        if (!wavBuffer || !wavBuffer.byteLength) return { error: "no audio captured" };
        if (wavBuffer.byteLength > 60e6) return { error: "recording too long" };
        const tmp = path.join(app.getPath("temp"),
            `lcl-mic-${process.pid}-${Date.now()}.wav`);
        fs.writeFileSync(tmp, Buffer.from(wavBuffer));
        try {
            const r = await speech.transcribeWav(tmp);
            auditLog.write({ kind: "mic-trace", step: "transcribe-ok",
                             detail: String(r.text || "").slice(0, 80), at: Date.now() });
            return { ok: true, text: r.text };
        } finally {
            try { fs.rmSync(tmp, { force: true }); } catch { /* temp */ }
        }
    } catch (err) {
        auditLog.write({ kind: "mic-trace", step: "transcribe-failed",
                         detail: String(err.message || err).slice(0, 200), at: Date.now() });
        return { error: String(err.message || err) };
    }
});

/**
 * Which knowledge libraries THIS session may read. The write path validates
 * against the registered libraries so a session can never name a folder the
 * user did not already consent to indexing. Read-only by construction — the
 * knowledge tools have no write surface at all.
 */
/**
 * Which model THIS session wants. The picker used to set one global model and
 * every session inherited it — switch sessions and your driver silently
 * changed. The choice is per-session now: recorded here, re-applied whenever
 * the session becomes active. Remote choices apply instantly and run
 * concurrently across sessions; a local choice queues behind the engine lock,
 * because there is one machine's worth of RAM however many sessions exist.
 */
/**
 * Heal an endpoint whose catalogue predates published metadata.
 *
 * Runs once per launch, in the background, for any endpoint still storing
 * bare {id,label} models. Without it the app keeps using the 8k fallback
 * budget forever on an endpoint that publishes a 1M-token window — the exact
 * defect that truncated three consecutive file writes.
 */
let healedEndpoints = false;
async function healStaleEndpoints() {
    if (healedEndpoints) return;
    healedEndpoints = true;
    try {
        for (const ep of cloudModels.endpoints()) {
            if (!cloudModels.endpointIsStale(ep)) continue;
            const r = await cloudModels.refreshEndpointCatalogue(ep.id);
            auditLog.write({ kind: "endpoint-healed", endpoint: ep.id,
                             models: r.models, priced: r.priced, at: Date.now() });
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("lcl:engineState", {
                    reason: "endpoint-healed", endpoint: ep.label,
                    models: r.models, hidden: r.hidden, priced: r.priced });
            }
        }

        /* AND THE REAL WINDOW, ON EVERY LAUNCH — HERE, BECAUSE THIS PATH RUNS.
         *
         * A restart still showed 32k — reported three times, and correct
         * every time. From a real audit log at 07:45:17 this heal ran and
         * rewrote the llama.cpp endpoint, while the stored window stayed
         * 32768 (ASSUMED) and /props on that same server answered 262144 in
         * five milliseconds.
         *
         * measureNodeWindows was wired into the NODES-PANEL refresh, so it only
         * ran if the user happened to open APIs & Connections. They opened a chat. The
         * number they actually talk to the model through was never asked for.
         * Placing a fix on a path the operator has to discover is the same as
         * not shipping it — this is the third variant of that mistake in one
         * night, and the lesson is to hook the path that PROVABLY runs rather
         * than the one that looks tidiest.
         *
         * Audited, so "did it ask?" is answerable from the log instead of by
         * reading the store and guessing. */
        for (const ep of cloudModels.endpoints()) {
            if (!ep.localNode) continue;
            try {
                const w = await cloudModels.measureNodeWindows(ep.id);
                auditLog.write({ kind: "node-window-measured", endpoint: ep.id,
                                 asked: true, changed: !!(w && w.changed),
                                 serverWide: (w && w.serverWide) || null,
                                 perModel: (w && w.perModel) || 0, at: Date.now() });
            } catch (e) {
                // the engine would not say; the assumption stands, still marked
                // as an assumption — but the ATTEMPT is on the record
                auditLog.write({ kind: "node-window-measured", endpoint: ep.id,
                                 asked: true, changed: false,
                                 error: String((e && e.message) || e).slice(0, 120),
                                 at: Date.now() });
            }
        }
    } catch { /* a stale catalogue is a degraded state, never a fatal one */ }
}

ipcMain.handle("lcl:costSummary", guard(() => ledger.summary()));
ipcMain.handle("lcl:costForSession", guard((_e, id) => ledger.forSession(id)));

ipcMain.handle("lcl:refreshEndpoint", guard(async (_e, id) => {
    const target = id || (cloudModels.endpoints()[0] || {}).id;
    if (!target) return { error: "no endpoint linked" };
    return cloudModels.refreshEndpointCatalogue(target);
}));

/**
 * WHICH REMOTE MODELS A LOCAL MODEL MAY CALL.
 *
 * ask_cloud_model / ask_reasoner let a local model escalate to a paid endpoint.
 * That must be a decision the user makes, not a default: "local models should
 * not be able to call api models, unless we have that feature enabled ...
 * global setting, [and] per session". Global switch here, per-session allowlist
 * on the session record; the agent consults both.
 */
ipcMain.handle("lcl:escalation", guard(() => ({
    enabled: paths.readSettings().allowEscalation === true
})));

ipcMain.handle("lcl:setEscalation", guard((_e, on) => {
    paths.writeSettings({ allowEscalation: !!on });
    auditLog.write({ kind: "escalation-set", enabled: !!on, at: Date.now() });
    return { ok: true, enabled: !!on };
}));

ipcMain.handle("lcl:setSessionEscalation", guard((_e, id, modelIds) => {
    const s2 = sessions.load(id);
    if (!s2) return { error: "session not found" };
    s2.escalateTo = Array.isArray(modelIds) ? modelIds.map(String).slice(0, 10) : [];
    sessions.save(s2);
    return { ok: true, escalateTo: s2.escalateTo };
}));

// the per-session task→model plan the driver follows and Ancient Knowledge
// reads (agent.orchestrationBlock / orchestrationDigest). Shape:
// { drawing?: {model,endpointId?,endpointLabel?}, code?: {...}, ... }
ipcMain.handle("lcl:setSessionTaskModels", guard((_e, id, map) => {
    const s2 = sessions.load(id);
    if (!s2) return { error: "session not found" };
    const clean = {};
    const CAPS = ["drawing", "vision", "code", "reasoning", "agentic"];
    if (map && typeof map === "object") {
        for (const cap of CAPS) {
            const v = map[cap];
            if (v && v.model) {
                clean[cap] = { model: String(v.model),
                    endpointId: v.endpointId ? String(v.endpointId) : undefined,
                    endpointLabel: v.endpointLabel ? String(v.endpointLabel) : undefined };
            }
        }
    }
    s2.taskModels = clean;
    sessions.save(s2);
    return { ok: true, taskModels: clean };
}));

/**
 * THIS SESSION'S MODEL — the choice that is now actually read.
 *
 * It stored a bare model id and nothing ever read it: routing went through the
 * one global driver, so the choice was written to disk and silently ignored,
 * and switching sessions did not switch the model. The id is now parsed into
 * the shape cloudModels.resolveSelection consumes, and the SESSION is the only
 * thing this touches — picking a model for one conversation must not reach
 * over and change what every other conversation is talking to.
 *
 *   "api:<endpointId>|<model>"  -> { endpointId, model }
 *   "<local model id>"          -> { local: <id> }
 *   null                        -> cleared: follow the app default again
 */
ipcMain.handle("lcl:setSessionModel", guard((_e, id, modelId) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    s.modelSel = parseModelSel(modelId);
    sessions.save(s);
    // POINTING A CONVERSATION AT SOMEBODY ELSE'S HARDWARE IS A DECISION WORTH
    // A ROW. The global default-model change has always been audited; the
    // per-session pick — which is the one that actually decides where this
    // conversation's words go now — was not, so "when did this start going to
    // a paid endpoint?" had no answer.
    try {
        const sel = s.modelSel;
        if (sel && typeof sel === "object" && sel.endpointId) {
            const ep = cloudModels.endpoints().find(e => e.id === sel.endpointId);
            auditLog.write({ kind: "session-model-selected", session: s.id,
                             endpoint: sel.endpointId,
                             endpointLabel: (ep && ep.label) || null,
                             model: sel.model || null,
                             ownHardware: !!(ep && cloudModels.isNodeEndpoint(ep)),
                             at: Date.now() });
        } else {
            auditLog.write({ kind: "session-model-selected", session: s.id,
                             local: true, model: (sel && sel.local) || null,
                             at: Date.now() });
        }
    } catch { /* the choice stands; the row is bookkeeping */ }
    return { ok: true, modelSel: s.modelSel,
             resolved: describeSelection(s) };
}));

/* THE ONE RESIDENT MODEL — moved to .lcl.engine/core/residency.js, where a
 * test can drive it. It deadlocked here for as long as it lived here: the
 * joining holder's releaser decremented without ever resolving the queue, so
 * the first pair of local sessions on one model wedged every later local turn
 * in the app. The only coverage it had was a regex over this file, which
 * matched the broken line. See that module's header and tests/residency.js. */
const { holdLocalResidency, residencyState } =
    require("../.lcl.engine/core/residency");

/**
 * Make a specific local gguf the resident one, for a session that chose it.
 *
 * Deliberately narrow: it loads, it never changes the app default and never
 * touches the global remote selection. The preflight is the same one the
 * picker uses, so a model that cannot fit is refused with numbers rather than
 * taking the machine down.
 */
async function loadLocalModel(modelId) {
    return withEngineLock(async () => {
        const registry = paths.modelRegistry();
        const m = (registry.models || [])
            .find(x => x.id === modelId && x.runtime === "llama.cpp");
        if (!m) return { error: "unknown model" };
        if (!isChatModel(m)) return { error: `${modelId} cannot hold a conversation` };
        let modelPath = null;
        for (const d of [paths.bundledModelsDir(), paths.modelsDir()]) {
            const p = path.join(d, m.file);
            if (fs.existsSync(p)) { modelPath = p; break; }
        }
        if (!modelPath) return { error: "that model is not on this machine" };
        const st0 = engine.status();
        if (st0 && st0.running && st0.model
            && path.resolve(st0.model) === path.resolve(modelPath)) return { ok: true };
        const check = engine.preflight(modelPath, { reclaimCurrent: true });
        if (!check.fits) return { error: check.message, refusal: check };
        // THE MACHINE'S DEFAULT IS NOT THIS CONVERSATION'S TO CHANGE.
        //
        // engine.start() loads whatever `modelPath` names, so it has to be set
        // to load anything at all — but leaving it set makes one session's
        // choice the model every future session and every restart begins on.
        // It is put back the moment the engine is up: what is RESIDENT is this
        // session's model, what is DEFAULT is whatever it was.
        const priorModelPath = paths.readSettings().modelPath || null;
        paths.writeSettings({ modelPath });
        await engine.stopAndWait();
        const started = await engine.start();
        if (priorModelPath !== modelPath) {
            try { paths.writeSettings({ modelPath: priorModelPath }); }
            catch { /* the resident model is what matters to this turn */ }
        }
        if (!started.ok) {
            // never leave the machine with nothing loaded
            const recovered = await engine.start({ allowFallback: true });
            return recovered.ok
                ? { ok: true, recovered: true, plan: recovered.plan }
                : { error: started.error || "the model did not start" };
        }
        auditLog.write({ kind: "model-selected", remote: false, model: modelId,
                         via: "session", at: Date.now() });
        return { ok: true, plan: started.plan };
    });
}

/** The picker's flat id -> the stored, structured choice. */
function parseModelSel(modelId) {
    const raw = modelId ? String(modelId) : null;
    if (!raw) return null;                       // cleared = follow the default
    if (raw.startsWith("api:")) {
        const rest = raw.slice(4);
        const cut = rest.indexOf("|");
        if (cut < 0) return null;
        return { endpointId: rest.slice(0, cut), model: rest.slice(cut + 1) };
    }
    return { local: raw };
}

/** The flat id for a stored choice — what the picker ticks. */
function modelSelId(sel) {
    if (!sel) return null;
    if (typeof sel === "string") return sel;            // legacy scalar
    if (sel.local) return String(sel.local);
    if (sel.endpointId && sel.model) return `api:${sel.endpointId}|${sel.model}`;
    return null;
}

/**
 * WHICH MODEL RUNS THE ANCIENT KNOWLEDGE AUDIT.
 *
 * Default is the model that answered the turn ("same as this conversation") —
 * expressed as `undefined`, which agent.js reads as "use the session's own
 * selection". The operator can name a different auditor in the Ancient
 * Knowledge settings; the flat picker id is stored in settings.ancientAuditorModel
 * and resolved here into what router.generate wants:
 *   - a remote id ("api:<ep>|<model>")  -> the endpoint's resolved selection
 *   - a local gguf id                   -> the "local" sentinel (engine model)
 *   - null / unresolvable               -> undefined (fall back to the session)
 */
/**
 * MODEL ORCHESTRATION ROUTES (wired). If this session's task map assigns
 * a model to the kind of work THIS message asks for, that model drives the
 * turn — "if you are using this screen, the session should follow these as
 * part of the instructions", made literal instead of a prompt hint.
 *
 * Honest edges: an assignment that no longer resolves (endpoint unlinked, key
 * lost) routes NOWHERE — the session's own model answers and nothing is
 * silently substituted. A LOCAL assignment routes to the local engine (per-turn
 * residency switching between specific local models is not attempted). A paid
 * assignment still passes the ask-before-every-remote-call gate downstream.
 * Every route taken is written to the audit log.
 */
function resolveTaskRoute(s, text) {
    const none = { route: null, broken: null, assigned: null };
    const map = s && s.taskModels;
    if (!map || typeof map !== "object") return none;
    let intent = null;
    try { intent = require("../.lcl.engine/core/modelOffer").intentOf(String(text || "")); }
    catch { return none; }
    if (!intent) return none;
    const a = map[intent.cap];
    if (!a || !a.model) return none;
    // A LOCAL assignment never hijacks the drive: routing sel:null would run
    // whatever local model is resident — NOT the assigned one — and on an
    // API-driven session it would silently swap the operator's model for a
    // different one. Local preference travels through the prompt block; the
    // documented limit (no per-turn local residency switching) stands.
    if (!a.endpointId) return { ...none, assigned: { cap: intent.cap, ...a } };
    try {
        const r = cloudModels.resolveSelection(
            { modelSel: { endpointId: a.endpointId, model: a.model } });
        // only honour the route when the ASSIGNED selection itself resolved —
        // a fallback source means the assignment is broken, and routing to a
        // substitute would be the quiet lie this app exists to end
        if (r && r.sel && r.source === "session") {
            auditLog.write({ kind: "orchestration-route", session: s.id, cap: intent.cap,
                             model: a.model, endpoint: a.endpointId, at: Date.now() });
            return { route: { sel: r.sel, source: "orchestration",
                              cap: intent.cap, model: a.model },
                     broken: null, assigned: { cap: intent.cap, ...a } };
        }
    } catch { /* unresolvable = broken, below */ }
    // the assignment exists and did NOT resolve — say so, out loud, instead of
    // silently answering on the session's own model (reviewed gap)
    auditLog.write({ kind: "orchestration-route-broken", session: s.id,
                     cap: intent.cap, model: a.model, endpoint: a.endpointId,
                     at: Date.now() });
    return { route: null, broken: { cap: intent.cap, model: a.model },
             assigned: { cap: intent.cap, ...a } };
}

function resolveAuditorSelection(session) {
    // SESSION-SCOPED, PERIOD — the auditor is a per-session agent. No
    // global fallback: it would override a session that deliberately chose
    // "same as this conversation" (null). Old global values are migrated onto
    // the session once, in getSessionAkSettings, so "default" genuinely clears.
    const id = session && session.akAuditor ? String(session.akAuditor) : null;
    if (!id) return undefined;
    const parsed = parseModelSel(id);
    if (!parsed) return undefined;
    if (parsed.local) return "local";
    try { return cloudModels.resolveSelection({ modelSel: parsed }).sel || undefined; }
    catch { return undefined; }
}

/**
 * WHAT WILL ACTUALLY ANSWER THIS SESSION — one answer, for every surface.
 *
 * The picker, the composer label and the status line each used to work this
 * out for themselves from global state, which is exactly how they came to
 * disagree. They all read this now, so they cannot.
 */
function describeSelection(s) {
    const r = cloudModels.resolveSelection(s);
    if (r.sel) {
        const d = cloudModels.destinationOf(r.sel);
        return { kind: cloudModels.isNodeEndpoint(r.sel) ? "node" : "api",
                 id: `api:${r.sel.id}|${r.sel.model}`,
                 model: r.sel.model, endpoint: r.sel.label,
                 label: `${r.sel.model} on ${r.sel.label}`,
                 where: d ? d.label : null,
                 source: r.source, missing: r.missing || null };
    }
    // local: which gguf is loaded, or would be
    const st = engine.status();
    const info = st && st.modelInfo;
    const chosen = s && s.modelSel && s.modelSel.local ? String(s.modelSel.local) : null;
    // The session's CHOICE names the label when it made one, so the picker and
    // the composer agree even while the engine has not swapped to it yet.
    const chosenInfo = chosen
        ? (paths.modelRegistry().models || []).find(m => m.id === chosen) : null;
    const shown = chosenInfo || info;
    return { kind: "local", id: chosen || (info && info.id) || null,
             model: (shown && shown.id) || null,
             endpoint: null,
             label: shown ? `${shown.family} ${shown.params}`.trim() : "local model",
             loaded: !!(info && (!chosen || info.id === chosen)),
             where: "this computer",
             source: r.source, missing: r.missing || null };
}

/**
 * WHAT THIS SESSION MAY DO — read.
 *
 * Returns the session's own grants, the catalog that describes them, WHERE the
 * model currently answers from (so the credentials switch can name the actual
 * destination rather than say "the model"), and what isolation this computer
 * can offer. One call, because the control and the "What .lcl can do" page must
 * never be able to disagree about any of it.
 */
ipcMain.handle("lcl:sessionPerms", guard((_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    // read ONCE — this handler also repaints the composer's permission chip,
    // so it runs on every header repaint, not only when the sheet opens
    const settingsNow = paths.readSettings();
    let destination = null;
    // THE DESTINATION THIS SESSION ACTUALLY SENDS TO. "may this conversation
    // send secrets" is answered against the machine THIS conversation talks
    // to, so the banner has to name that one, not the app default.
    try {
        const d = cloudModels.resolveSelection(s);
        destination = d.sel ? cloudModels.destinationOf(d.sel) : null;
        // a loopback endpoint answers ON this box — nothing leaves it, so it
        // scores green like the on-disk engine, not yellow like a node
        if (destination && destination.kind === "this-computer") destination.isLocalEngine = true;
    } catch { /* local model */ }
    const perms = sessionPerms.forSession(s);
    // ONE LADDER, computed where the destination is freshest. This handler is
    // also the composer chip's repaint path, so the risk it returns can never
    // be staler than the destination it was scored against.
    const risk = riskLevel.assess({
        destination,
        secrets: perms.secrets,
        autoRun: perms.autoRun,
        requireIsolation: perms.requireIsolation,
        workspaceLinked: !!s.repoPath
    });
    return {
        ok: true,
        perms,
        risk,
        catalog: sessionPerms.CATALOG,
        // this conversation's tool-by-tool overrides, so the Permissions panel
        // paints the dials at the session's own truth
        toolPolicy: (s.toolPolicy && typeof s.toolPolicy === "object") ? s.toolPolicy : {},
        destination,
        isolation: sandbox.isolation(),
        // THIS SESSION'S OWN BOX: where it is, and whose files are in it.
        // When running on someone else's machine, a user should be able to see
        // what is theirs and know the code underneath is untouched.
        sandboxRoot: sandbox.sandboxRoot(),
        box: (() => {
            try {
                const owned = sandbox.sessionBoxes().find(b => b.sessionId === String(id));
                return owned ? sandbox.inventory(owned.id) : null;
            } catch { return null; }
        })(),
        // the app-wide default, so "follow the app default" can show what that is
        appWriteMode: settingsNow.writeMode === "confirm" ? "confirm" : "notify",
        // same, for the self-review mode: off unless the app default says on
        appSelfReview: settingsNow.selfReview === true,
        // THE LEAVE-MACHINE GATE, in the panel that owns permissions now:
        // which endpoints THIS conversation already trusts (with labels, so
        // the row can say "api.deepinfra.com" instead of an id), whether the
        // app-wide gate is disarmed, and whether a waiting ask notifies.
        // one store read and one settings read for the whole block — this IPC
        // is also the composer chip's repaint path, not just the sheet's
        trustedEndpoints: (() => {
            const ids = Array.isArray(s.trustedEndpoints) ? s.trustedEndpoints : [];
            if (!ids.length) return [];
            let eps = [];
            try { eps = cloudModels.endpoints(); } catch { eps = []; }
            return ids.map(eid => {
                const ep = eps.find(e => e.id === eid);
                return { id: eid, label: (ep && ep.label) || eid };
            });
        })(),
        consentNotify: settingsNow.consentNotify !== false
    };
}));

/** STOP TRUSTING an endpoint for this conversation — the ask returns. */
ipcMain.handle("lcl:revokeTrustedEndpoint", guard((_e, id, endpointId) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const eid = String(endpointId || "");
    if (!Array.isArray(s.trustedEndpoints) || !s.trustedEndpoints.includes(eid)) {
        return { ok: true, trustedEndpoints: s.trustedEndpoints || [] };
    }
    s.trustedEndpoints = s.trustedEndpoints.filter(x => x !== eid);
    sessions.save(s);
    auditLog.write({ kind: "trusted-endpoint-revoked", session: s.id,
                     endpoint: eid, at: Date.now() });
    return { ok: true, trustedEndpoints: s.trustedEndpoints };
}));

/** WHAT THIS SESSION MAY DO — change one switch. Only ever a human click. */
ipcMain.handle("lcl:setSessionPerm", guard((_e, id, key, value) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const r = sessionPerms.set(s, key, value);
    if (r.error) return r;
    s.perms = r.perms;
    sessions.save(s);
    // a widened permission is worth a permanent record; the audit log is the
    // place the operator can answer "when did this become allowed?"
    auditLog.write({ kind: "session-permission", session: s.id,
                     permission: String(key), value: r.perms[key] === undefined
                         ? null : r.perms[key], at: Date.now() });
    // the kernel caches per session — drop it so the next tool call is judged
    // under the new rule instead of the old one
    try { policyBridge.drop(s.id); } catch { /* rebuilt on next check anyway */ }
    return { ok: true, perms: r.perms };
}));

/**
 * "ANSWER LIKE" — a per-session tone override. Free text the operator writes
 * ("direct, no overpromising, explains as it goes") that injects an
 * instruction into the system prompt for this conversation only. Kept simple:
 * a string on the session record, not a convoluted profile system. Empty
 * string clears it.
 */
// THE REASONING SLIDER HAS TO REACH THE DISK, OR IT IS DECORATION.
//
// The slider wrote `active.effortLevel` on the renderer's in-memory session
// and persisted only the answer-like sentence. lcl:chat loads the session
// FRESH FROM DISK before every turn, so `session.effortLevel` was always
// undefined by the time it mattered — and every consumer of it silently took
// its default: the API's reasoning_effort field was never sent, the local
// engine ran at 0.3 whatever the operator chose, the node temperature mapping
// never fired, and Ancient Knowledge's round ceiling was always the
// Terrestrial 2. Five levels, no effect, on every mode.
ipcMain.handle("lcl:setSessionEffort", guard((_e, id, level) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const n = Number(level);
    if (!Number.isFinite(n) || n < 0 || n > 4) return { error: "bad effort level" };
    s.effortLevel = Math.round(n);
    sessions.save(s);
    auditLog.write({ kind: "session-effort", session: s.id,
                     level: s.effortLevel, at: Date.now() });
    return { ok: true, effortLevel: s.effortLevel };
}));

/**
 * COMPACT — IN THE MAIN PROCESS, WHERE THE SESSION FILE IS.
 *
 * It used to run entirely in the renderer: it sent the summarisation request as
 * an ordinary chat turn (so "Please summarize this conversation so far…" was
 * recorded as something the user typed — landing in the session
 * file), then reassigned the renderer's copy of the message list.
 * Nothing carries a message list back here, and lcl:chat reloads from disk each
 * turn, so the full history went back to the model on the very next message.
 * The transcript looked compacted and the REQUEST never was — which is the only
 * thing compaction is for.
 *
 * Here it edits the session that the engine actually reads, and saves it.
 */
ipcMain.handle("lcl:compact", guard(async (_e, id, instructions) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    // A turn in flight owns this transcript; rewriting it underneath would
    // hand the model a history that changed mid-answer.
    if (turnsBySession.has(id)) {
        return { error: "this session is replying — compact it when the turn finishes" };
    }
    const before = agent.promptTokensOf(
        agent.buildModelMessages("", s.messages, { historyWindow: 10_000 }));
    const drive = router.resolveSelection(s);
    const res = await compaction.run(s, {
        generate: router.generate,
        instructions: String(instructions || "").slice(0, 400),
        selection: drive.sel
    });
    if (!res.ok) {
        // a prune with no summary is still a real reduction — save it
        if (res.pruned > 0) sessions.save(s);
        return { ok: false, reason: res.reason, pruned: res.pruned,
                 messages: res.pruned > 0 ? s.messages : undefined };
    }
    sessions.save(s);
    // BILLED LIKE ANY OTHER GENERATION. A remote summariser spends real money;
    // via:"compaction" so Spend can tell it apart from a turn.
    if (res.remote && res.usage) {
        try {
            ledger.record({
                sessionId: s.id, sessionTitle: s.title, model: res.model,
                endpoint: res.endpoint, inputTokens: res.usage.prompt_tokens,
                outputTokens: res.usage.completion_tokens,
                usd: (res.cost && res.cost.usd) || 0,
                via: "compaction", localNode: !!res.localNode
            });
        } catch { /* bookkeeping never breaks the edit */ }
    }
    const after = agent.promptTokensOf(
        agent.buildModelMessages("", s.messages, { historyWindow: 10_000 }));
    auditLog.write({ kind: "compaction", session: s.id, replaced: res.replaced,
                     pruned: res.pruned, before, after, at: Date.now() });
    return { ok: true, replaced: res.replaced, pruned: res.pruned,
             before, after, messages: s.messages };
}));

/**
 * THE GO WINDOW — the subscription's five-hour meter, from the real ledger.
 *
 * The window mechanics are the app's to know (usageWindow.js); the plan's
 * dollar ceiling is the OPERATOR'S to set — it lives in settings and the
 * meter shows spend-without-percentage until they set it, because a gauge
 * against an invented budget is a lie. via rows of every kind count when they
 * cost money: the plan does not care which feature spent it.
 */
ipcMain.handle("lcl:usageWindow", guard((_e, sessionId) => {
    // THE METER FOLLOWS THE DRIVER. "the GO stuff should only be visible when
    // a GO model is selected ... no other models are using the 5 hour context
    // that GO is." So: resolve THIS session's endpoint; if it carries a
    // windowed plan, meter the ledger rows billed to THAT endpoint against
    // the plan's tiers; a per-token vendor (DeepInfra) has no plan and the
    // strip stays out of the way entirely. GO publishes no usage API — the
    // console at opencode.ai/auth is the provider's own view, and the strip
    // links it so the two can be compared.
    const s = sessionId ? sessions.load(sessionId) : null;
    let ep = null;
    try {
        // A RESOLVED SELECTION IS AN ENDPOINT RECORD PLUS A MODEL — so its
        // endpoint key is `id`. This read `sel.endpointId` and `sel.endpoint`,
        // neither of which resolveSelection has ever produced, so BOTH
        // branches were unreachable and the handler returned planless on every
        // call: the GO dollar-window meter could never appear at all.
        const sel = cloudModels.resolveSelection(s || {}).sel
            // ...AND THE ENDPOINT THAT WILL ACTUALLY ANSWER, when this session
            // never pinned one. resolveSelection returns null unless the
            // session stored BOTH an endpointId and a model, so a conversation
            // started on the app default was reported planless and the meter
            // never appeared for it — which is most conversations.
            || cloudModels.selectedFor("driver");
        if (sel && sel.id) {
            ep = cloudModels.endpoints().find(e => e.id === sel.id) || null;
        }
    } catch { ep = null; }
    /* NO SUBSCRIPTION CEILING IS NOT NO WINDOW.
     *
     * "the 5 hour being a productivity context measure, just one that resets
     *  after 5 hours. in all modes except for Go, or any other api or provider
     *  that does this as an actual limiter."
     *
     * So a planless endpoint still gets a five-hour window — it just is not a
     * GAUGE, because there is no ceiling to be a share of. What comes back is
     * what was DONE in the current five hours: turns, tokens, and dollars where
     * they are known. The renderer draws that ring against TIME elapsed, which
     * is the only honest denominator when nothing stops at the end of it.
     *
     * The local engine counts here too. It costs no money and it is still work,
     * and "what have I got done since lunch" is the question this answers.
     */
    if (!ep || ep.plan !== "go-window") {
        const H5 = 5 * 3_600_000;
        const now = Date.now();
        let rows = [];
        try {
            rows = ledger.readAll().filter(r => {
                if (!r || !Number.isFinite(Number(r.at))) return false;
                if (now - Number(r.at) >= H5) return false;
                // this endpoint when there is one, everything when there is not
                if (!ep) return true;
                const e = String(r.endpoint || "");
                return !e || e === ep.id || e === ep.label;
            });
        } catch { rows = []; }
        if (!rows.length) {
            return { planless: true, work: { calls: 0, inputTokens: 0,
                                             outputTokens: 0, usd: 0,
                                             resetsInMs: H5, resetsWords: null } };
        }
        // the window is anchored at the OLDEST turn still inside five hours,
        // the same rule usageWindow uses — a window opens at first use
        const start = Math.min(...rows.map(r => Number(r.at)));
        const resetsInMs = Math.max(0, start + H5 - now);
        const sum = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
        const work = {
            calls: rows.length,
            inputTokens: sum("inputTokens"),
            outputTokens: sum("outputTokens"),
            usd: sum("usd"),
            resetsInMs,
            resetsWords: usageWindow.resetsWords(resetsInMs)
        };
        // the ring is filled by TOKENS against a 1M in / 1M out budget,
        // averaged, so it is conservative and reflects work done — not the clock
        return { planless: true, work: { ...work, ...usageWindow.workWindowPct(work) } };
    }

    const cfg = paths.readSettings();
    const ov = cfg.goBudgets || {};
    const tiers = usageWindow.GO_TIERS.map(t => ({
        ...t,
        budgetUsd: Number(ov[t.key]) > 0 ? Number(ov[t.key]) : t.budgetUsd
    }));
    /* ONLY ROWS BILLED TO THIS ENDPOINT — and the hostname is not the endpoint.
     *
     * The match fell back to `e.includes(host)`, and GO and Zen share an origin:
     * they differ only by PATH (/zen/go/v1 against /zen/v1). So every
     * pay-per-token Zen row counted against the GO subscription's dollar
     * windows — a meter that reports the user has spent money they have not,
     * on a ceiling that is not theirs. Exact id, then exact label; no substring. */
    const host = (() => { try { return new URL(ep.baseUrl).hostname; } catch { return ep.label || ""; } })();
    const rows = ledger.readAll().filter(r => {
        const e = String(r.endpoint || "");
        return e && (e === ep.id || e === ep.label);
    });
    const d = usageWindow.describeAll(rows, { tiers });
    return {
        planName: cfg.goPlanName || "GO",
        endpointLabel: ep.label || host,
        console: "https://opencode.ai/auth",
        tightest: d.tightest,
        tiers: d.tiers.map(t => ({
            ...t,
            resetsWords: t.active ? usageWindow.resetsWords(t.resetsInMs) : null
        }))
    };
}));

ipcMain.handle("lcl:setGoPlan", guard((_e, budgets) => {
    // per-tier overrides; an empty field falls back to GO's published number
    const clean = {};
    for (const k of ["h5", "week", "month"]) {
        const n = Number(budgets && budgets[k]);
        if (Number.isFinite(n) && n > 0) clean[k] = n;
    }
    paths.writeSettings({ goBudgets: clean });
    auditLog.write({ kind: "go-plan", budgets: clean, at: Date.now() });
    return { ok: true };
}));

ipcMain.handle("lcl:setSessionAnswerLike", guard((_e, id, text) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const v = String(text || "").trim().slice(0, 400);
    s.answerLike = v || undefined;
    sessions.save(s);
    auditLog.write({ kind: "session-answer-like", session: s.id,
                     set: !!v, length: v.length, at: Date.now() });
    return { ok: true, answerLike: s.answerLike || "" };
}));

/**
 * ANCIENT KNOWLEDGE — persists the ON/OFF flag on the session record so
 * agent.js can read it when the turn runs. The renderer sets it on its
 * in-memory `active` object, but the engine loads the session from disk,
 * so without this the audit never fires.
 */
ipcMain.handle("lcl:setSessionAncientKnowledge", guard((_e, id, on) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    s.ancientKnowledge = on === true;
    sessions.save(s);
    auditLog.write({ kind: "session-ancient-knowledge", session: s.id,
                     on: s.ancientKnowledge, at: Date.now() });
    return { ok: true, ancientKnowledge: s.ancientKnowledge };
}));

/**
 * THE ANCIENT KNOWLEDGE AUDITOR MODEL — app-wide, one writer.
 *
 * null (or absent) means "same as the model that answered", which is the
 * default and needs no storage. A flat picker id names a specific auditor.
 * Read back with the resolved label so the settings surface can show what it
 * currently is.
 */
ipcMain.handle("lcl:getAncientAuditor", guard(() => {
    const id = paths.readSettings().ancientAuditorModel || null;
    let label = null;
    if (id) {
        try {
            const sel = cloudModels.resolveSelection({ modelSel: parseModelSel(id) }).sel;
            label = sel ? `${sel.model} on ${sel.label}` : String(id);
        } catch { label = String(id); }
    }
    return { ok: true, auditorModel: id, label };
}));

ipcMain.handle("lcl:setAncientAuditor", guard((_e, modelId) => {
    const v = modelId ? String(modelId) : null;   // null = same as the session
    paths.writeSettings({ ancientAuditorModel: v });
    auditLog.write({ kind: "ancient-auditor-set", model: v, at: Date.now() });
    return { ok: true, auditorModel: v };
}));

/**
 * PER-SESSION ANCIENT KNOWLEDGE SETTINGS — the auditor agent is the
 * operator's, per conversation. Reads back the current session's own settings;
 * writes the auditor model, the round-ceiling knob, and the free-text ground
 * rules onto the session, and mirrors the ground rules into the workspace
 * companion file the agent reads.
 */
const auditorLabelFor = (id) => {
    if (!id) return null;
    try {
        const sel = cloudModels.resolveSelection({ modelSel: parseModelSel(id) }).sel;
        return sel ? `${sel.model} on ${sel.label}` : String(id);
    } catch { return String(id); }
};
ipcMain.handle("lcl:getSessionAkSettings", guard((_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    // MIGRATE the old global auditor onto the session ONCE, so the settings UI
    // reports the truth and "default" can actually clear it — resolveAuditorSelection
    // no longer reads the global at all.
    if (!s.akAuditor) {
        let g = null;
        try { g = paths.readSettings().ancientAuditorModel || null; } catch { g = null; }
        // A PAID auditor is never inherited silently. An explicit per-session
        // pick is the operator's consent to spend; a GLOBAL default migrating
        // onto a session is not — that path armed API spend the session never
        // opted into (the "abuse the users bank account" hole). A free/local
        // global still migrates; a paid one waits to be chosen here.
        if (g) {
            let paid = false;
            try {
                const parsed = parseModelSel(String(g));
                if (parsed && !parsed.local && parsed.endpointId) {
                    paid = !cloudModels.endpointIsFreeNode(parsed.endpointId);
                }
            } catch { paid = true; /* unknown = treat as paid, fail safe */ }
            if (!paid) { s.akAuditor = String(g); sessions.save(s); }
        }
    }
    const label = auditorLabelFor(s.akAuditor);
    // the SETTINGS UI must show what the AGENT reads — the companion file body
    // when a workspace is linked, else the session field. ancientKnowledge owns
    // that resolution, so the two never disagree.
    const rules = ancientKnowledge.groundRules(s);
    return { ok: true,
             enabled: s.ancientKnowledge === true,
             auditor: s.akAuditor || null, auditorLabel: label,
             rounds: Number.isFinite(Number(s.akRounds)) ? Number(s.akRounds) : null,
             spin: s.akSpin === "strict" || s.akSpin === "lenient" ? s.akSpin : "",
             groundRules: rules,
             hasWorkspace: !!s.repoPath };
}));

ipcMain.handle("lcl:setSessionAkSettings", guard((_e, id, patch) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const p = patch || {};
    if ("auditor" in p) s.akAuditor = p.auditor ? String(p.auditor) : null;
    if ("spin" in p) {
        s.akSpin = p.spin === "strict" || p.spin === "lenient" ? p.spin : null;
    }
    if ("rounds" in p) {
        const r = Number(p.rounds);
        s.akRounds = (Number.isFinite(r) && r >= 1) ? Math.max(1, Math.min(8, Math.round(r))) : null;
    }
    const touchedRules = "groundRules" in p;
    if (touchedRules) {
        s.akGroundRules = typeof p.groundRules === "string" ? p.groundRules.slice(0, 8000) : "";
    }
    sessions.save(s);
    // WRITE THE FILE ONLY WHEN THE RULES WERE THE THING EDITED. A save of just
    // the auditor or the round knob must not overwrite (or delete) a companion
    // file the operator hand-edited — that was clobbering direct edits.
    let file = null;
    if (touchedRules && s.repoPath) {
        try { const r = ancientKnowledge.writeGroundRules(s); if (r && r.ok) file = r.file; }
        catch { /* a failed write just means no companion file yet */ }
    }
    return { ok: true, auditor: s.akAuditor || null,
             rounds: Number.isFinite(Number(s.akRounds)) ? Number(s.akRounds) : null,
             groundRules: ancientKnowledge.groundRules(s), rulesFile: file };
}));

/**
 * "ALLOW FOR THIS CONVERSATION" — the session-scoped half of a capability grant.
 *
 * The in-place permission card offers three answers, and the middle one is the
 * "enable or trust" the operator asked for: it decides a capability for the rest
 * of THIS conversation and never touches the app-wide policy. The renderer holds
 * that grant in a Map, which is correct as far as it goes and dies with a
 * reload — so it probes for this call and, until now, never found it. Measured:
 * `setSessionToolPolicy` was one of six window.lcl.* names app.js reaches for
 * that preload.js never bridged.
 *
 * NO NEW MECHANISM. `session.toolPolicy` already exists and policyBridge already
 * builds every kernel from it (policyBridge.js:26). This is the writer that was
 * missing, and it is the ONLY writer — the same shape as lcl:setToolPolicy one
 * scope down.
 *
 * IT CANNOT LOOSEN WHAT MUST NOT LOOSEN. Every value goes through the same
 * classification floor as the app-wide dial, so "allow for this conversation"
 * on a delete that cannot be undone is refused here as well as in the card.
 * A session-scoped bypass of the floor would be a wider hole than the global
 * one it sits beside, not a narrower one.
 */
ipcMain.handle("lcl:setSessionToolPolicy", guard((_e, id, tool, level) => {
    const { TOOL_CLASS } = require("../.lcl.engine/policy/classify");
    const { PolicyKernel } = require("../.lcl.engine/policy/kernel");
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const name = String(tool || "");
    const spec = TOOL_CLASS[name];
    if (!spec) return { error: "unknown tool" };

    // The card speaks in "allow" and "ask"; the kernel speaks in four levels.
    // "ask" is confirm — hand it back to the UI — which is the state a
    // capability returns to when a session grant is taken back.
    const want = String(level || "") === "ask" ? "confirm" : String(level || "");
    const next = { ...(s.toolPolicy && typeof s.toolPolicy === "object" ? s.toolPolicy : {}) };

    if (want === "default") {
        delete next[name];
    } else {
        // The grant is CLAMPED to the tool's floor and STORED — never rejected.
        // The renderer sends "allow" for every "Allow for this conversation" click;
        // rejecting it (the old behaviour) made the grant silently fail and the
        // tool re-ask every turn. A device tool with sessionFloor "notify" now
        // stores "notify" (runs with progress, no gate); run_script clamps back to
        // "confirm" (a no-op, still welded).
        const floor = spec.sessionFloor || PolicyKernel.floorFor(spec.classification);
        const clamped = PolicyKernel.clampToFloor(want, floor);
        if (!clamped) return { error: "level must be allow, notify, confirm, ask, deny or default" };
        next[name] = clamped;
    }

    s.toolPolicy = next;
    sessions.save(s);
    // the kernel is cached per session — drop it so the very next tool call is
    // judged under the grant the operator just gave, not the one before it
    try { policyBridge.drop(s.id); } catch { /* rebuilt on next check anyway */ }
    auditLog.write({ kind: "session-tool-policy", session: s.id, tool: name,
                     level: want === "default" ? null : want, at: Date.now() });
    return { ok: true, session: s.id, tool: name,
             level: want === "default" ? null : want, toolPolicy: next };
}));

ipcMain.handle("lcl:setSessionKnowledge", guard((_e, id, ids) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const known = new Set(knowledge.list().map(l => l.id));
    s.knowledgeIds = (Array.isArray(ids) ? ids : [])
        .map(String).filter(x => known.has(x)).slice(0, 20);
    sessions.save(s);
    return { ok: true, knowledgeIds: s.knowledgeIds };
}));

/* -------------------------------------------------------------------------
 * NETWORKING: SSH KEYS AND SERIAL PORTS
 *
 * Keys are generated ON this machine, by the OS's own OpenSSH, into the app's
 * data directory. The private key never crosses IPC — every read path returns
 * the public half and metadata only, the same one-way rule the API keys
 * follow. Assigning a key to a session records the ASSIGNMENT; using it to
 * reach other machines is the feature this scaffolds.
 * ---------------------------------------------------------------------- */
function sshDir() {
    const d = path.join(paths.dataDir(), "ssh");
    fs.mkdirSync(d, { recursive: true });
    return d;
}

function sshKeygenBin() {
    const sys = path.join(process.env.SystemRoot || "C:\\Windows",
        "System32", "OpenSSH", "ssh-keygen.exe");
    return fs.existsSync(sys) ? sys : "ssh-keygen";
}

ipcMain.handle("lcl:sshKeys", guard(() => {
    const out = [];
    for (const f of fs.readdirSync(sshDir())) {
        if (!f.endsWith(".pub")) continue;
        const pub = fs.readFileSync(path.join(sshDir(), f), "utf8").trim();
        out.push({
            id: f.replace(/\.pub$/, ""),
            publicKey: pub,
            type: pub.split(" ")[0] || "?",
            comment: pub.split(" ").slice(2).join(" ")
        });
    }
    return { keys: out };
}));

ipcMain.handle("lcl:sshKeygen", (_e, name) => new Promise((resolve) => {
    const clean = String(name || "key").trim().toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "key";
    const file = path.join(sshDir(), `lcl-${clean}-${Date.now().toString(36)}`);
    // ed25519: small, fast, no parameter choices to get wrong. -N "" because
    // a passphrase prompt has nowhere to appear; the key is already inside
    // the user's profile, which is the same boundary OpenSSH itself uses for
    // an unencrypted default key.
    const child = spawn(sshKeygenBin(),
        ["-t", "ed25519", "-f", file, "-N", "", "-C", `lcl-${clean}`],
        { windowsHide: true });
    let err = "";
    const timer = setTimeout(() => { child.kill(); resolve({ error: "timed out" }); }, 20000);
    child.stderr.on("data", d => { err += d; });
    child.on("error", () => {
        clearTimeout(timer);
        resolve({ error: "ssh-keygen is not available — install the Windows " +
                         "'OpenSSH Client' optional feature" });
    });
    child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !fs.existsSync(file + ".pub")) {
            return resolve({ error: (err || "key generation failed").slice(0, 240) });
        }
        auditLog.write({ kind: "ssh-keygen", id: path.basename(file), at: Date.now() });
        resolve({ ok: true, id: path.basename(file),
                  publicKey: fs.readFileSync(file + ".pub", "utf8").trim() });
    });
}));

ipcMain.handle("lcl:sshKeyDelete", guard((_e, id) => {
    const clean = String(id || "").replace(/[^a-zA-Z0-9-]/g, "");
    if (!clean) return { error: "no key named" };
    const base = path.join(sshDir(), clean);
    if (!fs.existsSync(base + ".pub")) return { error: "no such key" };
    fs.rmSync(base, { force: true });
    fs.rmSync(base + ".pub", { force: true });
    auditLog.write({ kind: "ssh-key-deleted", id: clean, at: Date.now() });
    return { ok: true };
}));

ipcMain.handle("lcl:setSessionSshKey", guard((_e, id, keyId) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    s.sshKeyId = keyId ? String(keyId).replace(/[^a-zA-Z0-9-]/g, "") : null;
    sessions.save(s);
    return { ok: true, sshKeyId: s.sshKeyId };
}));

/** COM/serial ports present right now — the field-device side of Networking. */
/**
 * WHAT HARDWARE IS ATTACHED — the extension of the serial readout below.
 *
 * lcl:listComPorts answers "which COM ports exist". That is the OS's answer to
 * a narrower question than the one somebody who builds hardware is asking,
 * which is "what is on the end of my cable". This adds the identity: vendor
 * and product numbers from the device tree, the family where those numbers are
 * recognised, and a passive listen on any port already printing.
 *
 * Read-only end to end. deviceScan.js has no write path at all.
 */
/* -------------------------------------------------------------------------
 * THE PATCH BAY — the app's own code, reviewed and patched with its own tools.
 *
 * Reachable only where it can actually work: an installed build ships
 * compiled, with no git and no sources, and available() says so in those words
 * rather than failing obscurely. Nothing here APPLIES anything — review commits
 * to a branch in a throwaway worktree and hands back the one command the
 * operator runs themselves.
 * ---------------------------------------------------------------------- */
ipcMain.handle("lcl:patchAvailable", guard(() => patchBay.available()));

ipcMain.handle("lcl:patchOpen", guard((_e, sessionId, scope) => {
    const r = patchBay.open(String(sessionId || "s"), scope || []);
    if (r.ok) {
        patchSessions.set(r.id, r);
        auditLog.write({ kind: "patch-opened", id: r.id,
                         scope: (r.scope && r.scope.allowed) || [], at: Date.now() });
    }
    return r;
}));

ipcMain.handle("lcl:patchReview", guard((_e, id) => {
    const sess = patchSessions.get(String(id || ""));
    if (!sess) return { ok: false, error: "no such patch session" };
    const r = patchBay.review(sess);
    auditLog.write({ kind: "patch-reviewed", id: sess.id, passed: !!r.ok,
                     files: (r.files || []).length, at: Date.now() });
    return r;
}));

ipcMain.handle("lcl:patchDiscard", guard((_e, id) => {
    const sess = patchSessions.get(String(id || ""));
    if (!sess) return { ok: false, error: "no such patch session" };
    const r = patchBay.discard(sess);
    patchSessions.delete(sess.id);
    auditLog.write({ kind: "patch-discarded", id: sess.id, at: Date.now() });
    return r;
}));

/* -------------------------------------------------------------------------
 * YOUR CODE AS CONTEXT — the SHAPE of it. The operator picks the folder, sees
 * exactly what would be stored and what was withheld, and nothing is kept
 * until they say so. Local only; nothing leaves this machine here.
 * ---------------------------------------------------------------------- */
ipcMain.handle("lcl:surveyRepoShape", guard(async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
        title: "Choose a code folder to survey",
        buttonLabel: "Survey the shape",
        properties: ["openDirectory"]
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    let folder;
    try { folder = fs.realpathSync(picked.filePaths[0]); }
    catch { return { error: "could not resolve that folder" }; }
    const root = path.parse(folder).root;
    if (path.resolve(folder) === path.resolve(root)) {
        return { error: "refusing to survey a whole drive — pick a specific folder" };
    }
    const out = repoShape.survey(folder);
    if (!out.ok) return out;
    // the FOLDER NAME ITSELF can identify somebody, so it is never returned
    return { ...out, sample: out.files.slice(0, 25) };
}));

ipcMain.handle("lcl:inspectDevices", guard(async (_e, opts) => {
    try {
        const ms = Math.min(6000, Math.max(0, Number(opts && opts.listenMs) || 2000));
        // ONE NAMED PORT, WHEN THE OPERATOR POINTED AT ONE. Same shape
        // deviceScan.listen() enforces on its own side, checked again here
        // because this is the boundary a renderer string arrives at — a name
        // that is not COM<n> must never reach a PowerShell command line.
        const rawPort = String((opts && opts.port) || "").trim();
        if (rawPort && !/^COM\d+$/i.test(rawPort)) {
            return { error: "that is not a serial port name — expected something like COM4" };
        }
        const res = await deviceScan.inspect(
            rawPort ? { listenMs: ms, port: rawPort.toUpperCase() } : { listenMs: ms });
        // A FAILED PROBE IS NOT AN EMPTY BENCH.
        //
        // This handler used to stamp `ok: true` on whatever came back, so an
        // OS probe that threw — no PowerShell, WMI service down, the device
        // tree unreadable — arrived at the renderer as a clean success with an
        // empty device list, and the panel said "Nothing on USB." That is a
        // statement about the bench, and it was never measured. deviceScan
        // reports the failure as `scanError`, a human sentence; it is passed
        // through UNTOUCHED, and it is what decides `ok` — the one field that
        // must not disagree with it.
        return { ...res, ok: res.ok !== false && !res.scanError };
    } catch (err) {
        return { error: String((err && err.message) || err) };
    }
}));

ipcMain.handle("lcl:listComPorts", () => new Promise((resolve) => {
    const ps = spawn("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
         "[System.IO.Ports.SerialPort]::GetPortNames() | ConvertTo-Json -Compress"],
        { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => { ps.kill(); resolve({ ports: [] }); }, 8000);
    ps.stdout.on("data", d => { out += d; });
    ps.on("error", () => { clearTimeout(timer); resolve({ ports: [] }); });
    ps.on("close", () => {
        clearTimeout(timer);
        try {
            const j = JSON.parse(out || "[]");
            resolve({ ports: (Array.isArray(j) ? j : [j]).filter(Boolean) });
        } catch { resolve({ ports: [] }); }
    });
}));


/* -------------------------------------------------------------------------
 * LOCAL NODES — the DGX Spark, and anything like it.
 *
 * A node is a machine the user owns on their own network that can serve
 * models: reached over SSH for setup, over HTTP for inference. .lcl is the
 * driver: add the host, the app probes what is already serving, offers to
 * install and bind a server when nothing is, and links the endpoint into the
 * same picker as every other model source. NVIDIA's own playbooks are the
 * script — Ollama first because its install is one line, it autostarts as a
 * systemd service, and its OpenAI surface (11434) is a shape connect()
 * already speaks.
 *
 * SSH here is the OS's own client, key-based only (BatchMode) — the same
 * trust NVIDIA Sync already established on this machine. Setup runs in a
 * VISIBLE terminal window, deliberately: it needs sudo on the node, and the
 * user typing their own password into their own terminal is the honest
 * version of automation. The app never touches or stores that password.
 * ---------------------------------------------------------------------- */
// open patch sessions, by id — the worktree is the real record; this is the
// handle the renderer holds
const patchSessions = new Map();

const NODES_KEY = "localNodes";
/**
 * How long a pressed Finish stays armed. Long enough to cover "I am at work
 * all day and it will be reachable this evening"; short enough that an
 * instruction given last week does not act on a machine a month later.
 */
const ARM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * AN ARMED INSTRUCTION IS CARRIED OUT, NOT RE-RUN ON A TIMER.
 *
 * Measured from the audit log: one press of Finish drove 41 full
 * provisioning runs in half an hour — 23:40:38 to 00:09:08, median gap 40
 * seconds — against a machine that was already provisioned, storing an
 * identical route on every pass. The only thing outstanding the whole time
 * was one external fact (the funnel approval), which the one-request
 * activation check detects for free. So the cheap check runs every tick, and
 * the full provision re-runs on a stretching schedule instead — reset the
 * moment the operator does the thing being waited on (opens the approval
 * page, or presses Finish again).
 */
const ARM_RETRY_MIN_MS = 60_000;
const ARM_RETRY_MAX_MS = 10 * 60_000;
const armGov = new Map();     // node id -> { armedAt, holdMs, nextAt }
function armDue(n, now = Date.now()) {
    const g = armGov.get(n.id);
    if (!g || g.armedAt !== n.finishArmed) return true;   // a fresh press runs now
    return now >= g.nextAt;
}
function armRecord(n, now = Date.now()) {
    const prev = armGov.get(n.id);
    const g = (prev && prev.armedAt === n.finishArmed)
        ? prev : { armedAt: n.finishArmed, holdMs: 0 };
    g.holdMs = Math.min(Math.max(g.holdMs * 2, ARM_RETRY_MIN_MS), ARM_RETRY_MAX_MS);
    g.nextAt = now + g.holdMs;
    armGov.set(n.id, g);
}
function armReset() { armGov.forEach(g => { g.nextAt = 0; }); }

// nodes whose door install is already running, so a repaint cannot start
// a second one on top of it
const inFlightDoor = new Set();

/**
 * THE DOOR INSTALLS ITSELF IN WHATEVER WINDOW IT GETS.
 *
 * Measured on the test machine: turning a full-tunnel VPN off does NOT
 * restore the tailnet at once — port 22 came back after 35 seconds one time
 * and after more than 4 MINUTES another. So a person who switches their VPN
 * off, presses Refresh, sees "not reachable" and switches it back on is doing
 * everything right and will never once see it work. That is what happened all
 * day.
 *
 * This watches from the main process instead: a cheap TCP probe every 20s,
 * costing nothing while the node is unreachable, and the moment it answers
 * the door is adopted or built. No dialog need be open, no button pressed,
 * no timing guessed. It stops as soon as every node has a door.
 */
let doorWatch = null;

function tcpOpen(host, port, ms) {
    return new Promise((resolve) => {
        const sock = new (require("net").Socket)();
        const done = (v) => { try { sock.destroy(); } catch { /* closed */ } resolve(v); };
        sock.setTimeout(ms);
        sock.once("connect", () => done(true));
        sock.once("timeout", () => done(false));
        sock.once("error", () => done(false));
        sock.connect(port, host);
    });
}

async function doorWatchTick() {
    let nodes;
    try { nodes = readNodes().filter(n => !n.relayUrl); } catch { return; }
    if (!nodes.length) return;
    if (!networkAllowed()) return;          // egress is still the user's switch
    for (const n of nodes) {
        if (inFlightDoor.has(n.id)) continue;
        // A REMEMBERED ROUTE NEEDS NO LOCAL NETWORK AT ALL. Try it before the
        // port check below, which would skip this node on exactly the network
        // where the route is the only thing that can work.
        if (n.relayPending) {
            if (await activatePendingRelay(n.id).catch(() => false)) continue;
        }
        if (!await tcpOpen(n.host, 22, 3000)) continue;   // still blocked; costs nothing

        // AN INSTRUCTION ALREADY GIVEN IS CARRIED OUT WHEN IT BECOMES POSSIBLE.
        //
        // Finishing remote access needs a moment when the machine is
        // reachable. On the test machine that moment is exactly the
        // moment the user cannot act: a VPN required to use the network is
        // what blocks the machine, and it is not optional
        // for them, so every window closed unused. Zero attempts in a day.
        //
        // This is NOT a timer deciding to publish anything. It runs only for
        // a node the operator explicitly armed by pressing Finish, only while
        // that instruction is fresh, only for a pinned host, and only for the
        // node it was given for. Same consent as pressing the button — just
        // not requiring them to be watching when the door opens.
        if (n.finishArmed && Date.now() - n.finishArmed < ARM_TTL_MS) {
            // The activation attempt above is the cheap per-tick check. A full
            // provision is scheduled work: a machine that already answered
            // does not get re-provisioned every 40 seconds while everyone
            // waits on the same external fact (see armDue). The in-flight
            // guard is re-checked here because the awaits above are a window
            // the 5-second poll's own door work can enter.
            if (!armDue(n) || inFlightDoor.has(n.id)) continue;
            inFlightDoor.add(n.id);
            try {
                const port = (n.serving && n.serving[0] && n.serving[0].port) || 11434;
                armRecord(n);
                auditLog.write({ kind: "node-door-armed-run", host: n.host,
                                 armedAt: n.finishArmed, at: Date.now() });
                const r = await provisionDoor(n, port, { unattended: true });
                if (r && r.ok && r.published) {
                    armGov.delete(n.id);
                    const nodes2 = readNodes();
                    const rec = nodes2.find(x => x.id === n.id);
                    if (rec) { delete rec.finishArmed; paths.writeSettings({ [NODES_KEY]: nodes2 }); }
                    try {
                        if (Notification.isSupported()) {
                            new Notification({
                                title: "Remote access is ready",
                                body: `${n.name || n.host} can now be reached from ` +
                                      "any network, including behind a VPN.",
                                silent: true            // the app's own sound, below
                            }).show();
                            chime("done");
                        }
                    } catch { /* the row shows it either way */ }
                }
            } catch { /* the row reports its own state; retried next tick */ }
            finally { inFlightDoor.delete(n.id); }
            continue;
        }
        // A TIMER MAY NOT PUBLISH ANYTHING TO THE INTERNET.
        //
        // This used to build remote access unattended, which means it exposed
        // the node's inference API through Tailscale Funnel with no user
        // action at all. That is not a background task's decision to make.
        // The watchdog now only ADOPTS a relay the operator already set up —
        // recovering after a reboot or a network change — and never creates
        // one. Creating it stays in the wizard, where a human is present.
        //
        // It also requires the host key to be pinned: "ssh exited 0" is not
        // proof of identity, and an sshd that accepts any key would otherwise
        // have had its own relay URL adopted as this node's.
        // A failed adoption retries later, not next tick — and the in-flight
        // guard is re-checked because the awaits above are a window the
        // 5-second poll's own adopt can enter.
        if (!hostIsPinned(n.host)) continue;
        if (!adoptDue(n.id) || inFlightDoor.has(n.id)) continue;
        inFlightDoor.add(n.id);
        try {
            adoptRecord(n.id, !!await adoptNodeDoor(n.id));
        } catch { adoptRecord(n.id, false); /* the row reports its own state */ }
        finally { inFlightDoor.delete(n.id); }
    }
}

function startDoorWatch() {
    if (doorWatch) return;
    doorWatch = setInterval(() => { doorWatchTick().catch(() => {}); }, 20_000);
    if (doorWatch.unref) doorWatch.unref();
}


function readNodes() {
    const raw = paths.readSettings()[NODES_KEY];
    return Array.isArray(raw) ? raw : [];
}

/**
 * HOW BIG IS THAT MACHINE, ACTUALLY — remembered, so the load guard can ask.
 *
 * cloudModels.nodePreflight refuses a model that cannot fit on the node it is
 * being sent to. It reads `memBytes` off the endpoint's node record — and
 * nothing anywhere WROTE one, so every node was sized against a hardcoded
 * 128 GB. The measured consequence is the exact hang the check exists to
 * prevent: a 100 GB build aimed at a 32 GB box passes the guard, the node
 * allocates, and the machine goes down.
 *
 * The number is not a new probe. /proc/meminfo's MemTotal is already read on
 * every gauge tick and every dashboard paint; this keeps the answer on the
 * node's own record so the guard has it before the first chat, and so it
 * survives a restart. Written only when it CHANGES, because a settings write
 * on a five-second poll is a different kind of harm.
 */
function rememberNodeMem(id, bytes) {
    const b = Number(bytes) || 0;
    if (!id || b <= 0) return b;
    try {
        const nodes = readNodes();
        const rec = nodes.find(x => x.id === id);
        if (rec && rec.memBytes !== b) {
            rec.memBytes = b;
            paths.writeSettings({ [NODES_KEY]: nodes });
        }
    } catch { /* the gauge still paints; the guard stays blind one more tick */ }
    // AND HEAL THE COPY THE GUARD ACTUALLY READS. Attempted every time a size
    // is learned, not only when the registry row changed, because the two
    // stores drift independently: the registry can already hold the number
    // while the endpoint record — written once, at link time — still does not.
    // Never allowed to affect this function's own job: the gauge tick that
    // calls it must keep working whatever the endpoint store is doing.
    try { backfillEndpointNodeMem(id, b); } catch { /* healed on the next tick */ }
    return b;
}

/**
 * ONE SOURCE OF TRUTH FOR HOW BIG A NODE IS.  (contract K1)
 *
 * The registry row is the truth. `cloudModels.nodePreflight` used to read a
 * SECOND copy — `endpoint.node.memBytes` — that was written once at link time
 * and never again. Measured against a real install: the endpoint record held
 * {id, name, host, port} and NO memBytes, while the registry row for the same
 * machine held 130663002112. The guard read the copy without the number, sized
 * the machine as "unknown", and proceeded. The box went down.
 *
 * So the guard no longer has to depend on being handed a fresh record: it asks
 * this, through the resolver hook installed below, and this reads the registry
 * — the one place rememberNodeMem writes.
 */
function nodeMemBytes(nodeId) {
    const id = String(nodeId || "");
    if (!id) return null;
    try {
        const rec = readNodes().find(x => x.id === id);
        const b = Number(rec && rec.memBytes);
        // null, never a guess. An absent size must reach the guard AS absent so
        // it can fail closed; a fabricated number is how 128 GB became every
        // machine's size for as long as that check existed.
        return b > 0 ? b : null;
    } catch { return null; }
}

/**
 * HEAL EXISTING INSTALLS. Every endpoint whose node.id matches gets the size
 * written onto its own record, so an install that has already been running for
 * weeks stops carrying a sizeless copy — the resolver covers the live process,
 * this covers what is on disk, and a record that is right needs no resolver.
 *
 * Rewritten through cloudModels.linkEndpoint (which merges over the stored
 * record) rather than by touching its store directly: the key file's shape is
 * that module's business, and a second writer of an encrypted store is exactly
 * the kind of duplicate truth this whole contract exists to remove. Every
 * field is echoed back deliberately — linkEndpoint recomputes label/models
 * from the preset when they are absent, so passing a subset would erase them.
 */
const lastMemBackfill = new Map();      // nodeId -> { bytes, at }
const MEM_BACKFILL_EVERY_MS = 60_000;

function backfillEndpointNodeMem(nodeId, bytes) {
    const b = Number(bytes) || 0;
    if (!nodeId || b <= 0) return 0;
    // rememberNodeMem is on a five-second gauge poll. Reading the endpoint
    // store forty times a minute to re-confirm a number that has not moved is
    // the same class of harm the write throttle above avoids — so an unchanged
    // size is re-checked once a minute, which still heals an endpoint linked
    // after the first tick well inside the time it takes to type a message.
    const seen = lastMemBackfill.get(nodeId);
    if (seen && seen.bytes === b && Date.now() - seen.at < MEM_BACKFILL_EVERY_MS) return 0;
    lastMemBackfill.set(nodeId, { bytes: b, at: Date.now() });
    let patched = 0;
    try {
        for (const ep of cloudModels.endpoints()) {
            if (!ep.node || ep.node.id !== nodeId) continue;
            if (Number(ep.node.memBytes) === b) continue;
            // the SAME node record, with the size added — never a fresh one
            const healedNode = { ...ep.node, memBytes: b };
            cloudModels.linkEndpoint({
                id: ep.id, label: ep.label, baseUrl: ep.baseUrl,
                preset: ep.preset, models: ep.models,
                reasoningField: ep.reasoningField, apiPrefix: ep.apiPrefix,
                localNode: ep.localNode, rented: ep.rented, provider: ep.provider,
                node: healedNode
            });
            patched++;
        }
        if (patched) {
            auditLog.write({ kind: "node-mem-backfilled", node: nodeId,
                             memBytes: b, endpoints: patched, at: Date.now() });
        }
    } catch { /* the resolver still answers; the record heals on the next tick */ }
    return patched;
}

/**
 * INSTALL THE RESOLVER, AT STARTUP, BEFORE ANY WINDOW OR ANY TURN.  (K1)
 *
 * Module scope on purpose. Doing this inside whenReady() would leave a window
 * — short, but real — in which a restored session could drive a node turn with
 * the guard still reading whatever the endpoint record happened to carry.
 * Guarded by typeof so a cloudModels that has not yet grown the hook cannot
 * take the whole app down at require time.
 */
try {
    if (typeof cloudModels.setNodeMemResolver === "function") {
        cloudModels.setNodeMemResolver(nodeMemBytes);
    }
} catch { /* the guard falls back to the record it is handed */ }

/** The serving ports worth probing, in the order the playbooks use them. */
const NODE_PORTS = [
    { port: 11434, label: "Ollama" },
    { port: 30000, label: "llama.cpp" },
    { port: 8000,  label: "vLLM / NIM" },
    { port: 8355,  label: "TRT-LLM" }
];

/**
 * What Ollama has RESIDENT on a node, over the serving port. Unprivileged and
 * usually reachable when SSH and the stats door are not, so it is the fallback
 * that lets the sidebar gauge work on a node with no login configured — the
 * total comes from the registry, this fills in what is used.
 */
function ollamaPs(host, port, timeoutMs = 2500) {
    return new Promise((resolve) => {
        const req = require("http").get(
            { host, port, path: "/api/ps", timeout: timeoutMs },
            (res) => {
                let b = "";
                res.on("data", c => { if (b.length < 200_000) b += c; });
                res.on("end", () => {
                    try {
                        const j = JSON.parse(b);
                        resolve({ ok: res.statusCode === 200, models: j.models || [] });
                    } catch { resolve({ ok: false, models: [] }); }
                });
            });
        req.on("error", () => resolve({ ok: false, models: [] }));
        req.on("timeout", () => { req.destroy(); resolve({ ok: false, models: [] }); });
    });
}

function probeNodePort(host, port, timeoutMs = 2500) {
    return new Promise((resolve) => {
        // WHY the probe failed is the whole diagnosis, so the error code is
        // carried out rather than flattened to `up: false`. EACCES/EPERM in
        // particular is Windows saying local software refused the socket —
        // a VPN kill switch — which is a completely different problem from a
        // timeout (node asleep) or ECONNREFUSED (node up, service down).
        const req = require("http").get(
            { host, port, path: "/v1/models", timeout: timeoutMs,
              // OFF THE THREAD POOL. A dead ".local" name takes twenty seconds
              // of Windows mDNS/LLMNR/NBNS walking per lookup, and the socket
              // timeout below cannot cancel an in-flight getaddrinfo — the
              // thread stays held long after this promise settles.
              lookup: cloudModels.lookupOffThreadPool },
            (res) => {
                let b = "";
                res.on("data", c => { if (b.length < 100_000) b += c; });
                res.on("end", () => {
                    try {
                        const j = JSON.parse(b);
                        const list = Array.isArray(j.data) ? j.data
                            : Array.isArray(j.models) ? j.models : [];
                        // A FINGERPRINT OF WHAT THIS ADDRESS SERVES. One
                        // machine is commonly reachable by several names — a
                        // Tailscale address AND an NVIDIA Sync alias, say —
                        // and listing it once per name is exactly the
                        // confusion this whole discovery flow exists to end.
                        // Two addresses serving an identical model set are the
                        // same machine.
                        const ids = list.map(m => m.id || m.name || "").filter(Boolean).sort();
                        resolve({
                            up: res.statusCode === 200,
                            models: ids.length,
                            fingerprint: ids.length ? ids.join("|").slice(0, 400) : null
                        });
                    } catch { resolve({ up: false }); }
                });
            });
        req.on("timeout", () => { req.destroy(); resolve({ up: false, err: "ETIMEDOUT" }); });
        req.on("error", (e) => resolve({ up: false, err: String((e && e.code) || "ERROR") }));
    });
}

/** Local software refused the socket — not a network condition. */
const BLOCKED_CODES = new Set(["EACCES", "EPERM"]);

/* ----------------------------------------------------------------------
 * THE PROBE GOVERNOR — how often the EXPENSIVE checks may run.
 *
 * Measured from this app's own audit log: 2,109 node-ssh-probe
 * events in one day, median gap 5.0 seconds — every one an ssh.exe spawned
 * by a dialog poll, re-deriving an answer that had not changed, while a
 * working relay sat beside it. The port probes are sockets and stay on every
 * refresh: they are the sentinel that notices a road coming BACK the moment
 * it does. What backs off is what costs something and cannot change while
 * the road stays in the same state: the ssh probe and the adoption pass.
 *
 * Shape: an identical result stretches the interval (doubling, to a
 * ceiling); any change of road state probes at once and resets it.
 * EACCES/EPERM — local software refusing the socket — is special: ssh goes
 * through the same filter and cannot answer differently, so while that
 * state holds, the ssh probe runs only on the way IN (one confirming line
 * for the log) and the per-refresh port probes carry the watch. Recovery
 * therefore costs one poll tick, never a backoff window.
 * -------------------------------------------------------------------- */
const PROBE_HOLD_MIN_MS = 10_000;
const PROBE_HOLD_MAX_MS = 10 * 60_000;
const probeGov = new Map();   // node id -> { cls, holdMs, nextAt, probedAt, ssh, held }

function govFor(id) {
    let g = probeGov.get(id);
    if (!g) {
        g = { cls: null, holdMs: 0, nextAt: 0, probedAt: 0, ssh: null,
              held: 0, busy: false };
        probeGov.set(id, g);
    }
    return g;
}

/** May the expensive tier run now? Pure over (record, road class, clock).
 *  `cls` is a composite — "<road>/<22-state>" — so a change visible only at
 *  the ssh layer (sshd died, sshd came back) still moves the class; prefix
 *  checks keep the road-level rules working on the composite. */
function govShouldProbe(g, cls, now) {
    if (g.cls === null) return true;                    // never looked yet
    if (cls !== g.cls) {
        // The road moved. Coming back — something answers where nothing did —
        // is the moment being watched for, so probe at once. Going quiet
        // keeps a short floor, so a road that flaps cannot re-create the storm.
        if (cls.startsWith("open") || cls.startsWith("refused")) return true;
        return now - g.probedAt >= PROBE_HOLD_MIN_MS;
    }
    if (cls.startsWith("blocked")) return false;   // the filter holds every socket; ssh has nothing new to say
    return now >= g.nextAt;
}

/** Record a completed expensive probe. Returns true when the outcome changed
 *  (= worth an audit line); an identical repeat stretches the hold instead. */
function govRecord(g, cls, outcome, now) {
    const changed = g.ssh !== outcome;
    g.holdMs = changed ? PROBE_HOLD_MIN_MS
                       : Math.min(Math.max(g.holdMs, PROBE_HOLD_MIN_MS) * 2, PROBE_HOLD_MAX_MS);
    g.nextAt = now + g.holdMs;
    g.probedAt = now;
    g.cls = cls;
    g.ssh = outcome;
    return changed;
}

/**
 * Door adoption gets the same treatment: a failed attempt is not retried on
 * the next repaint, it is retried later — and a success or a road change
 * resets the clock. Adoption used to re-spawn ssh on every refresh for as
 * long as a doorless node answered; the log shows what that cost.
 */
/**
 * The held counters live in process memory and are written out on the next
 * outcome transition — so a quit mid-hold would silently drop them, and the
 * log's claim that `held` accounts for every identical observation would be
 * false across a restart. One flush line at quit keeps the ledger whole.
 */
function flushProbeGov() {
    try {
        for (const [id, g] of probeGov) {
            if (g.held > 0) {
                auditLog.write({ kind: "node-probe-hold-flush", nodeId: id,
                                 result: g.ssh, held: g.held, at: Date.now() });
                g.held = 0;
            }
        }
    } catch { /* never block a quit */ }
}

const ADOPT_RETRY_MIN_MS = 30_000;
const ADOPT_RETRY_MAX_MS = 10 * 60_000;
const adoptGov = new Map();   // node id -> { holdMs, nextAt }
function adoptDue(id, now = Date.now()) {
    const g = adoptGov.get(id);
    return !g || now >= g.nextAt;
}
function adoptRecord(id, ok, now = Date.now()) {
    if (ok) { adoptGov.delete(id); return; }
    const g = adoptGov.get(id) || { holdMs: 0 };
    g.holdMs = Math.min(Math.max(g.holdMs * 2, ADOPT_RETRY_MIN_MS), ADOPT_RETRY_MAX_MS);
    g.nextAt = now + g.holdMs;
    adoptGov.set(id, g);
}

/**
 * NVIDIA Sync's managed ssh_config, when present. Sync writes the host alias,
 * the key and the username here when the user pairs their machine — which
 * means a Spark added through Sync is reachable by HOSTNAME ALONE, key-based,
 * no password, no username field. Found the hard way: the first node build
 * shelled plain `ssh user@host`, which knows nothing of Sync's key, and would
 * have called a perfectly paired Spark "not reachable".
 */
function syncSshConfig() {
    const f = path.join(process.env.LOCALAPPDATA || "",
        "NVIDIA Corporation", "Sync", "config", "ssh_config");
    return fs.existsSync(f) ? f : null;
}

/**
 * The credentials NVIDIA Sync holds, as data rather than as a config file.
 *
 * Sync writes ONE block per machine, keyed on the alias it created:
 *
 *     Host ai-node-01.local
 *       IdentityFile ...\nvsync.key
 *       User ai-node-01
 *
 * `-F` applies that block only when the address MATCHES THE ALIAS STRING.
 * The app adds nodes by Tailscale address, because that is the address that
 * also works from another network — so every SSH ran as the WINDOWS username
 * with no key, failed authentication, and reported the node unreachable.
 * That is why "Install remote door" never appeared: not the VPN, not the
 * network, a string comparison. Credentials belong to the MACHINE, so they
 * have to follow it to whatever address is used to reach it.
 */
function syncCredentials() {
    const f = syncSshConfig();
    if (!f) return [];
    let txt = "";
    try { txt = fs.readFileSync(f, "utf8"); } catch { return []; }
    const out = [];
    let cur = null;
    for (const raw of txt.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = /^(\S+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const val = m[2].trim().replace(/^"(.*)"$/, "$1");
        if (key === "host") { cur = { alias: val, names: [val] }; out.push(cur); continue; }
        if (!cur) continue;
        if (key === "hostname") cur.names.push(val);
        else if (key === "user") cur.user = val;
        else if (key === "identityfile") cur.identityFile = val;
    }
    return out.filter(c => c.user && c.identityFile);
}

/**
 * How to reach this host: the explicit user when one was set, otherwise the
 * paired machine's own key and username when `-F` alone would not apply them.
 */
/**
 * A visible SSH terminal, launched through a .cmd file.
 *
 * `cmd /c start "title" ssh -F <path> -i <path> user@host "<script>"` RE-PARSES
 * every argument. NVIDIA Sync stores its key and config under
 * "...\NVIDIA Corporation\..." — a path with a space — so start split those
 * paths, ssh received fragments, and the window closed instantly. Both the
 * node setup and the door install appeared to do nothing when clicked.
 *
 * Writing the command into a batch file quotes it exactly once, and cmd only
 * ever sees a single filename with no spaces in it.
 *
 * A BATCH FILE EATS PERCENT SIGNS, AND QUOTING DOES NOT PROTECT THEM.
 *
 * cmd runs a percent phase over every line of a .cmd BEFORE it parses quotes,
 * so `-w '%{http_code}' http:` is chewed down to `-w '` on its way to ssh and
 * the remote shell receives a syntax error instead of a script. MEASURED, with
 * the real node-setup script through the real writeTerminalScript and a
 * stand-in for ssh:
 *
 *     sent 1088 bytes, ssh received 1075
 *     first divergence at 48:  "-w '%{http_code}' http://127.0.0.1:11434"
 *                          ->  "-w '//127.0.0.1:11434"
 *     bash -n on what arrived: exit 2,
 *       "unexpected EOF while looking for matching `''"
 *
 * The whole script died at the first statement, the batch printed "Done. This
 * window can be closed.", and the handler had already returned ok:true. So the
 * install ran NOTHING and reported success.
 *
 * Doubling every percent hands cmd the escape it collapses back to one — the
 * delivered argument is then byte-identical to the string passed in here, and
 * a script with no percent in it is untouched (`%%` only ever comes from a `%`).
 */
function writeTerminalScript(title, creds, remoteScript, host) {
    const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
    const line = ["ssh", "-t", ...creds.args.map(q), q(creds.target),
                  q(remoteScript)].join(" ")
        // survive cmd's percent phase — see above. Last, over the whole line,
        // so nothing an argument contains can slip past it.
        .replace(/%/g, "%%");
    const bat = path.join(app.getPath("temp"),
        `lcl-term-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}.cmd`);
    fs.writeFileSync(bat,
        // A BOM, AND A CODEPAGE. The same round trip that caught the percent
        // caught this one line later: without them cmd decodes the file in the
        // OEM codepage, so the em dash in "setup complete — this window can be
        // closed" reached ssh as "ΓÇö" and the batch's own banner printed the
        // same mojibake at the operator. MEASURED: BOM alone already delivers
        // the argument byte-identical (the payload travels as UTF-16 to
        // CreateProcess); chcp is what makes the ECHO lines legible in the
        // window the user is looking at. Both, because both halves are read.
        "﻿" +
        "@echo off\r\n" +
        "chcp 65001>nul\r\n" +
        `title ${title}\r\n` +
        `echo ${title} — ${host}\r\n` +
        "echo Your node's password is asked for below. It goes to your own\r\n" +
        "echo machine over SSH and is never seen by .lcl.\r\n" +
        "echo.\r\n" +
        line + "\r\n" +
        "echo.\r\n" +
        "echo Done. This window can be closed.\r\n" +
        "pause\r\n", "utf8");
    return bat;
}

/**
 * WINDOWS OPENSSH REFUSES A PRIVATE KEY ANY OTHER ACCOUNT CAN READ.
 *
 * Recorded on the test machine, after seven builds of theories:
 *
 *     ok=false  "@  WARNING: UNPROTECTED PRIVATE KEY FILE"
 *
 * NVIDIA Sync's nvsync.key carries an extra ACE — on that machine
 * "User\SandboxUsers", left by other tooling — so ssh rejects the key
 * before it ever authenticates. Every probe failed, ssh was never "ok", and
 * the Install door button was therefore never enabled. It had nothing to do
 * with the VPN, which is why turning the VPN off never helped.
 *
 * The vendor's file is NOT modified: it belongs to NVIDIA Sync and the user,
 * and rewriting someone else's ACLs to fix our own problem is not something
 * this should do. Instead the app keeps its own copy under its data directory
 * with inheritance stripped and exactly one grantee, and points ssh at that.
 * Refreshed whenever the source key changes.
 */
function hardenedKey(srcKey) {
    try {
        const crypto = require("crypto");
        const dir = path.join(paths.dataDir(), "ssh");
        fs.mkdirSync(dir, { recursive: true });
        const dst = path.join(dir,
            crypto.createHash("sha1").update(srcKey).digest("hex").slice(0, 12) + ".key");
        const srcM = fs.statSync(srcKey).mtimeMs;
        let stale = true;
        try { stale = fs.statSync(dst).mtimeMs < srcM; } catch { stale = true; }
        if (stale) {
            fs.copyFileSync(srcKey, dst);
            // strip inheritance, then grant this user alone. Without
            // /inheritance:r the parent's ACEs survive and ssh still refuses.
            const me = process.env.USERNAME || process.env.USER;
            try {
                require("child_process").execFileSync("icacls",
                    [dst, "/inheritance:r", "/grant:r", `${me}:F`],
                    { windowsHide: true, stdio: "ignore" });
            } catch { /* fall through: the copy alone often suffices */ }
        }
        return dst;
    } catch {
        return srcKey;      // never make the situation worse than it was
    }
}

/* ---------------------------------------------------------------------------
 * HOST IDENTITY IS VERIFIED, NOT ASSUMED.
 *
 * Every SSH call used StrictHostKeyChecking=accept-new, which silently trusts
 * whatever answers an address on first contact, and no fingerprint was ever
 * computed, shown or stored. Three confirmed attacks followed from that one
 * decision:
 *
 *   - nodeAuthorize typed the operator's account password into an unverified
 *     host with PubkeyAuthentication=no, so anyone able to answer for that
 *     address on the LAN — ARP spoof, rogue AP, or just taking the DHCP lease
 *     of a node that is powered off — received it in plaintext. On a typical
 *     Linux node that is also the sudo password.
 *   - "ssh exited 0" was treated as proof of identity, so an sshd that accepts
 *     any offered key got remote access installed unattended, then controlled
 *     the stdout of every command including the relay URL — pointing the chat
 *     transport at the attacker.
 *   - the wizard grouped candidates by whether a reverse-DNS name existed, so
 *     a hostile host could label itself into the trusted group.
 *
 * The fix is one app-owned known_hosts file. A key enters it only when the
 * operator confirms the fingerprint, at the one moment a human is present.
 * Everything else runs with StrictHostKeyChecking=yes against that file, so an
 * unknown or changed key fails the connection instead of being adopted.
 * ------------------------------------------------------------------------- */

function knownHostsFile() {
    const dir = path.join(paths.dataDir(), "ssh");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "known_hosts");
    if (!fs.existsSync(f)) fs.writeFileSync(f, "", { encoding: "utf8", mode: 0o600 });
    return f;
}

/** Is this host pinned? Nothing unattended may act on one that is not. */
/**
 * WHAT SSH WILL ACTUALLY CALL THIS HOST.
 *
 * A machine added by one of NVIDIA Sync's aliases is reached through that
 * config, and ssh files the host key under the RESOLVED HostName, not the
 * alias that was typed. Checking the typed string alone would never match, so
 * the wizard would ask for the same machine to be confirmed every single time
 * and never progress. `ssh -G` answers this offline — it only parses config,
 * it does not connect.
 */
// `ssh -G` is a synchronous process spawn, and hostIsPinned runs on every
// 5-second refresh — measured while fixing the probe storm: one ssh.exe per
// tick that never appeared in any log because it talks to no network. The
// answer only changes when Sync's ssh_config does, so it is cached against
// that file's mtime (plus a 5-minute lease). A resolution FAILURE is never
// cached: a transient miss must not un-pin a host for five minutes.
const effHostCache = new Map();   // host -> { at, cfgM, val }
const EFF_HOST_TTL_MS = 5 * 60_000;
function effectiveHost(host) {
    try {
        const cfg = syncSshConfig();
        let cfgM = 0;
        try { cfgM = cfg ? fs.statSync(cfg).mtimeMs : 0; } catch { cfgM = 0; }
        const c = effHostCache.get(host);
        if (c && c.cfgM === cfgM && Date.now() - c.at < EFF_HOST_TTL_MS) return c.val;
        const creds = sshCreds(null, host);
        const out = execFileSync("ssh", ["-G", ...creds.args, creds.target],
            { encoding: "utf8", windowsHide: true, timeout: 5000 });
        const m = /^hostname\s+(\S+)/mi.exec(out);
        const val = m ? m[1] : null;
        effHostCache.set(host, { at: Date.now(), cfgM, val });
        return val;
    } catch { return null; }
}

function hostIsPinned(host) {
    try {
        const txt = fs.readFileSync(knownHostsFile(), "utf8");
        const names = new Set([String(host || "").toLowerCase()]);
        const eff = effectiveHost(host);
        if (eff) names.add(eff.toLowerCase());
        return txt.split(/\r?\n/).some((line) => {
            if (!line.trim() || line.startsWith("#")) return false;
            const first = line.split(/\s+/)[0] || "";
            return first.toLowerCase().split(",")
                .some(p => [...names].some(h => p === h || p === `[${h}]:22`));
        });
    } catch { return false; }
}

/**
 * Ask the host for its public key WITHOUT trusting it yet, and return the
 * fingerprint for a human to compare. ssh-keyscan performs no authentication
 * and sends nothing secret, so running it against an unverified host is safe —
 * it is exactly the step that lets the operator detect one.
 */
function scanHostKey(host, timeoutMs = 12000) {
    return new Promise((resolve) => {
        // NOT ssh-keyscan. Windows ships OpenSSH 9.5, whose keyscan cannot
        // negotiate with a modern sshd:
        //
        //   choose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com
        //
        // Observed against an Ubuntu 9.6p1 node. Regular ssh on
        // the same machine connects to that host perfectly, so ssh is what asks
        // for the key: it is pointed at a THROWAWAY known_hosts, records what
        // the host offers, and that file is read and deleted. Nothing is
        // trusted by this — the key only reaches the real known_hosts after a
        // human confirms the fingerprint.
        const tmpKh = path.join(app.getPath("temp"), `lcl-kh-${Date.now()}.tmp`);
        const creds = sshCreds(null, host);
        const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                      "-o", "StrictHostKeyChecking=accept-new",
                      "-o", `UserKnownHostsFile=${tmpKh}`,
                      ...creds.args, creds.target, "true"];
        const child = spawn("ssh", args, { windowsHide: true });
        let err = "";
        const finish = () => {
            let out = "";
            try { out = fs.readFileSync(tmpKh, "utf8"); } catch { /* nothing recorded */ }
            try { fs.unlinkSync(tmpKh); } catch { /* temp */ }
            return out;
        };
        const timer = setTimeout(() => { child.kill(); resolve({ error: "timed out" }); }, timeoutMs);
        child.stderr.on("data", d => { err += d; });
        child.on("error", () => { clearTimeout(timer); resolve({ error: "ssh is not available" }); });
        child.on("close", () => {
            clearTimeout(timer);
            // the host key is exchanged BEFORE authentication, so it is
            // recorded even when the login itself fails
            const out = finish();
            const lines = out.split(/\r?\n/).filter(l => l.trim() && !l.startsWith("#"));
            if (!lines.length) {
                const last = (err || "").split(/\r?\n/).filter(Boolean).pop() || "no key offered";
                return resolve({ error: last.slice(0, 200) });
            }
            // fingerprint each offered key so the operator can compare it with
            // what the machine itself reports
            const tmp = path.join(app.getPath("temp"), `lcl-keyscan-${Date.now()}.pub`);
            fs.writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
            let prints = [];
            try {
                const outp = execFileSync("ssh-keygen", ["-lf", tmp],
                    { encoding: "utf8", windowsHide: true });
                prints = outp.split(/\r?\n/).filter(Boolean).map(l => {
                    const p = l.trim().split(/\s+/);
                    return { bits: p[0], fingerprint: p[1], type: (p[p.length - 1] || "").replace(/[()]/g, "") };
                });
            } catch { /* reported as unavailable below */ }
            try { fs.unlinkSync(tmp); } catch { /* temp */ }
            if (!prints.length) return resolve({ error: "could not fingerprint the offered key" });
            resolve({ ok: true, lines, prints });
        });
    });
}

ipcMain.handle("lcl:nodeHostKey", guard(async (_e, host) => {
    const h = String(host || "").trim();
    if (!h || /[\s'"`;|&]/.test(h)) return { error: "that does not look like a host" };
    const r = await scanHostKey(h);
    if (!r.ok) return { error: r.error };
    return { ok: true, pinned: hostIsPinned(h), prints: r.prints,
             // the command the operator runs ON the machine to compare
             verifyOn: "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub" };
}));

/**
 * Pin it. Only ever called from an explicit user confirmation.
 *
 * It pins what the operator SAW, not what answers now. Re-scanning and
 * trusting the second answer would hand an impostor the one window pinning
 * exists to close: show a real fingerprint, wait for the click, answer the
 * second scan yourself. The fingerprints confirmed on screen come back with
 * the request and have to match, exactly and in full, or nothing is written.
 */
ipcMain.handle("lcl:nodePinHostKey", guard(async (_e, host, expect) => {
    const h = String(host || "").trim();
    if (!h || /[\s'"`;|&]/.test(h)) return { error: "that does not look like a host" };
    const want = Array.isArray(expect) ? expect.map(String) : null;
    if (!want || !want.length) return { error: "nothing was confirmed to record" };
    const r = await scanHostKey(h);
    if (!r.ok) return { error: r.error };
    const got = r.prints.map(p => p.fingerprint);
    if (got.length !== want.length || got.some((g, i) => g !== want[i])) {
        auditLog.write({ kind: "node-hostkey-changed", host: h,
                         confirmed: want, offered: got, at: Date.now() });
        return { error: "that machine is now offering a different identity than the " +
                        "one you confirmed. Nothing was recorded. Stop and find out why." };
    }
    const f = knownHostsFile();
    const existing = fs.readFileSync(f, "utf8");
    const add = r.lines.filter(l => !existing.includes(l)).join("\n");
    if (add) fs.appendFileSync(f, (existing.endsWith("\n") || !existing ? "" : "\n") + add + "\n");
    auditLog.write({ kind: "node-hostkey-pinned", host: h,
                     fingerprints: r.prints.map(p => p.fingerprint), at: Date.now() });
    return { ok: true, prints: r.prints };
}));

/**
 * THE KEY .lcl INSTALLED ON THE NODE, OFFERED ON THE CALLS THAT FOLLOW.
 *
 * `lcl:nodeAuthorize` mints `lcl-node-*` and appends its public half to the
 * node's authorized_keys — and then NOTHING ever offered it again. Its only
 * `-i` was inside that one batch file, so every later sshBatch and scp fell
 * back to ssh's default identity search (`~/.ssh/id_*`). On a machine whose
 * default key happens to be authorised that works by luck; on one where it is
 * not, .lcl authorises itself and then cannot log in — with an error about
 * permission, not about the key it just installed.
 */
function lclNodeKey() {
    try {
        const f = fs.readdirSync(sshDir())
            .filter(n => /^lcl-node-.*\.pub$/.test(n))
            .map(n => path.join(sshDir(), n.replace(/\.pub$/, "")))
            .find(p => fs.existsSync(p));
        return f || null;
    } catch { return null; }
}

function sshCreds(user, host) {
    const cfg = syncSshConfig();
    const args = [];
    if (cfg) args.push("-F", cfg);
    // OUR OWN KEY FIRST, when we have one. Offered rather than forced: no
    // IdentitiesOnly here, so ssh still falls through to the agent and the
    // default identities if this key is not the one the node accepts. That
    // keeps every existing working setup working.
    const mine = lclNodeKey();
    if (mine) args.push("-i", mine);
    if (user) return { args, target: `${user}@${host}` };

    const creds = syncCredentials();
    const h = String(host || "").toLowerCase();
    // the address already names a machine Sync knows — -F does the work
    if (creds.some(c => c.names.some(n => String(n).toLowerCase() === h))) {
        return { args, target: host };
    }
    // otherwise lend this address the paired machine's key and username.
    // IdentitiesOnly is deliberate on this branch and unchanged: the vendor
    // key is being lent to an address Sync does not name, and trying a pile of
    // other identities against it is how an account gets locked out.
    if (creds.length === 1) {
        const c = creds[0];
        return { args: [...args, "-i", hardenedKey(c.identityFile), "-o", "IdentitiesOnly=yes"],
                 target: `${c.user}@${host}` };
    }
    return { args, target: host };
}

/**
 * IS A CONSUMER VPN HOLDING THE ROUTES?
 *
 * With the VPN up, traffic to the Tailscale range rides into the VPN
 * tunnel and dies, and every probe of the Spark comes back "not reachable" —
 * which reads as the app failing when it is the routing table. The app cannot
 * fix another vendor's tunnel, but it can NAME the culprit and the fix
 * instead of shrugging. Telling the user to reconfigure their VPN was the
 * FIRST answer and it was the wrong one — on the test machine the VPN is
 * not optional ("you can not work on this network without it"), so the fix has
 * to be something the app does, which is the door.
 *
 * Get-NetAdapter is asked rather than os.networkInterfaces() because Windows
 * keys interfaces by friendly name ("Ethernet 2") while the vendor's name
 * lives in the description — the one place the culprit is identifiable.
 * Cached for a minute; adapters do not churn.
 */
const VPN_ADAPTER =
    /express\s*vpn|lightway|nordvpn|nordlynx|proton\s*vpn|mullvad|surfshark|cyberghost|windscribe|private internet access|openvpn|globalprotect|anyconnect|zscaler|fortissl|fortinet/i;
// AN ADAPTER IS NOT A VERDICT.
//
// This used to report "the VPN is active" whenever a VPN adapter was Up —
// and a disconnected the VPN leaves its TUN adapter Up forever. Measured
// on the test machine: TUN adapter Up, and the ONLY default route was
// Wi-Fi. So the app latched onto a VPN that was not routing anything and
// would not let go: "once it sees it, it locks in."
//
// What is actually true is only knowable from a connection attempt. The same
// machine, same moment:
//     node -> spark:22     EACCES     (local software refused the socket)
//     node -> spark:11434  EACCES
//     node -> public :443  OPEN       (the internet is entirely fine)
// EACCES is Windows reporting a local filter — a VPN kill switch — not a
// network condition. THAT is the evidence. The adapter list is consulted only
// to put a name to it, and never to decide it.
let vpnCache = { at: 0, val: { active: false } };
function vpnAdapter(force = false) {
    if (!force && Date.now() - vpnCache.at < 8_000) return Promise.resolve(vpnCache.val);
    if (process.platform !== "win32") return Promise.resolve({ active: false });
    return new Promise((resolve) => {
        const done = (val) => { vpnCache = { at: Date.now(), val }; resolve(val); };
        const ps = spawn("powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command",
             "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | " +
             "ForEach-Object {$_.Name + '|' + $_.InterfaceDescription}"],
            { windowsHide: true });
        let out = "";
        const timer = setTimeout(() => { ps.kill(); done({ active: false }); }, 4000);
        ps.stdout.on("data", d => { out += d; });
        ps.on("error", () => { clearTimeout(timer); done({ active: false }); });
        ps.on("close", () => {
            clearTimeout(timer);
            for (const line of out.split(/\r?\n/)) {
                if (/tailscale/i.test(line)) continue;      // tailscale IS the road, not the roadblock
                if (VPN_ADAPTER.test(line)) {
                    const m = VPN_ADAPTER.exec(line);
                    return done({ active: true, name: m[0].replace(/\s+/g, " ").trim() });
                }
            }
            done({ active: false });
        });
    });
}

/**
 * Is something on this machine blocking the tailnet, and if so what is it?
 *
 * `blocked` comes from a real connection attempt (EACCES/EPERM). Without that
 * evidence this reports nothing at all, no matter how many VPN adapters exist
 * — which is the difference between a diagnosis and a superstition.
 */
/**
 * THE VERDICT HAS TO REMEMBER, OR IT STROBES.
 *
 * Observed: the block warning went away after a few seconds,
 * then came back after a few seconds. The diagnosis was recomputed from
 * scratch every cycle and only fired when a probe came back EACCES — but a
 * socket a kill switch is holding sometimes TIMES OUT instead of being
 * refused, and a cycle of timeouts read as "nothing is blocking anything".
 * Same VPN, same machine, banner blinking.
 *
 * So a block is sticky for a short window, and one genuine success clears it
 * instantly — because the moment the filter goes off, the warning must go
 * with it, not linger for a minute.
 */
const BLOCK_STICKY_MS = 45_000;
let lastBlockAt = 0;

async function blockDiagnosis(blocked, reached) {
    if (reached) { lastBlockAt = 0; return { active: false }; }
    if (blocked) lastBlockAt = Date.now();
    else if (!lastBlockAt || Date.now() - lastBlockAt > BLOCK_STICKY_MS) {
        return { active: false };
    }
    const a = await vpnAdapter(true);
    return a.active
        ? { active: true, name: a.name, blocked: true }
        // something IS filtering, we just cannot name it
        : { active: true, name: null, blocked: true };
}

/**
 * A LONG JOB ON THE NODE, WATCHED WHILE IT RUNS.
 *
 * sshBatch is built for questions: it buffers everything, answers in 8
 * seconds, and on a timeout THROWS AWAY whatever had already arrived. None of
 * that suits pulling 40 GB of model weights, where the only thing the operator
 * wants is to watch it happen and be able to stop it.
 *
 * So: same hardening, same credentials, same one-argv-element command — but
 * output is streamed line by line as it appears, an idle timer replaces the
 * wall-clock one (a download that is still moving is not stuck), and the
 * returned handle can kill the job. Nothing from the renderer is ever
 * interpolated into `cmd`; every caller passes a literal, exactly as the rest
 * of this file does.
 */
/**
 * @param stdin  written to the remote command and closed at once. This is how
 *               `sudo -S` gets a password.
 *
 * ON STDIN, NEVER IN THE COMMAND. A password put in `cmd` becomes an argv
 * element: readable in `ps` on both machines for the life of the connection,
 * and it would land in the script text this app shows the operator before it
 * runs. stdin is read once, by sudo, and gone.
 */
function sshStream(user, host, cmd, { onLine = () => {}, idleMs = 120_000,
                                      maxMs = 6 * 60 * 60 * 1000,
                                      stdin = null } = {}) {
    const creds = sshCreds(user, host);
    const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                  "-o", "StrictHostKeyChecking=yes",
                  "-o", `UserKnownHostsFile=${knownHostsFile()}`,
                  // a long transfer must not be dropped by an idle NAT
                  "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=6",
                  ...creds.args, creds.target, cmd];
    const child = spawn("ssh", args, { windowsHide: true });
    if (stdin) { try { child.stdin.write(String(stdin) + "\n"); } catch { } }
    try { child.stdin.end(); } catch { } // EOF, so nothing downstream waits on it
    // WHY it was killed, not just that it was. Reporting a five-minute
    // silence with the same word the Stop button uses says the operator did it.
    let killed = false, timedOut = false, lastAt = Date.now();
    let bufOut = "", bufErr = "";
    const tail = [];                       // the last lines, for the error report

    const feed = (chunk, which) => {
        lastAt = Date.now();
        const s = (which === "err" ? (bufErr += chunk) : (bufOut += chunk));
        // curl and hf write progress with \r; treat it as a line break so a
        // percentage actually reaches the operator instead of one huge line
        const parts = s.split(/\r\n|\r|\n/);
        const rest = parts.pop();
        if (which === "err") bufErr = rest; else bufOut = rest;
        for (const line of parts) {
            const t = line.trim();
            if (!t) continue;
            tail.push(t);
            if (tail.length > 40) tail.shift();
            try { onLine(t, which); } catch { /* a listener must not kill the job */ }
        }
    };
    child.stdout.on("data", d => feed(String(d), "out"));
    child.stderr.on("data", d => feed(String(d), "err"));

    const done = new Promise((resolve) => {
        // IDLE, NOT ELAPSED. A 40 GB pull is not stuck because it has been an
        // hour; it is stuck because nothing has been said for two minutes.
        const tick = setInterval(() => {
            if (Date.now() - lastAt > idleMs) {
                killed = true; timedOut = true;
                try { child.kill(); } catch { /* gone */ }
            }
        }, 5000);
        const hard = setTimeout(() => {
            killed = true; timedOut = true;
            try { child.kill(); } catch { /* gone */ }
        }, maxMs);
        const finish = (res) => {
            clearInterval(tick); clearTimeout(hard);
            resolve(res);
        };
        child.on("error", e => finish({ ok: false, err: String(e.message), tail }));
        child.on("close", code => finish({
            ok: code === 0 && !killed,
            code,
            cancelled: killed && !timedOut,
            timedOut,
            idleMs,
            err: killed ? (timedOut ? "went quiet" : "stopped") : "",
            tail
        }));
    });

    return {
        done,
        cancel: () => { killed = true; try { child.kill(); } catch { /* gone */ } }
    };
}

/**
 * WHY IT FAILED, IN A WORD, FROM SSH'S OWN OUTPUT.
 *
 * A reported failure: a node install reports it did not finish with permission
 * denied, and entering a password to log in from .lcl still ends in "DENIED".
 *
 * The investigation went to sudo. It was never sudo. Measured on the test
 * machine, the same minute it was reported:
 *
 *     spark:22      EACCES        spark:11434   EACCES
 *     1.1.1.1:443   OPEN          example.com:443  OPEN
 *
 * the VPN's kill switch was refusing every socket to the tailnet while the
 * internet stayed perfect, and ssh reported it as
 *
 *     ssh: connect to host 100.64.0.1 port 22: Permission denied
 *
 * which the install passed through verbatim. "Permission denied" from a tool
 * that installs software reads as ROOT — so the app spent two days answering a
 * question about sudo that the operator only asked because this sentence made
 * him ask it. A machine you cannot reach must never be reported in the words
 * of a machine refusing you.
 *
 * `connect to host` is what separates the two: it appears in the unreachable
 * case and never in `Permission denied (publickey)`.
 */
function sshFailure(tail = []) {
    const t = (tail || []).join("\n");
    // a local filter refused the socket — this is the kill-switch signature
    if (/connect to host .*: Permission denied/i.test(t)) return "blocked";
    if (/connect to host .*: (Connection timed out|Network is unreachable|No route to host|Connection refused)/i
        .test(t)) return "unreachable";
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(t)) return "hostkey";
    if (/Permission denied \(|Too many authentication failures|No supported authentication/i
        .test(t)) return "auth";
    return null;                       // it reached the node; the recipe failed
}

/**
 * ...and the same in a sentence the operator can act on. `vpn` is the app's
 * existing kill-switch diagnosis, which only ever speaks when a real socket
 * came back EACCES — a name, never a superstition.
 */
function sshFailureSays(reason, host, vpn) {
    if (reason === "blocked") {
        return (vpn && vpn.name
            ? `${vpn.name} on THIS computer is blocking the connection to ${host}. `
            : `Something on THIS computer is blocking the connection to ${host}. `) +
            "The internet is fine — only your tailnet is refused, which is what a " +
            "VPN kill switch does. Nothing on the node was touched. Turn the VPN " +
            "off, or allow local network traffic in its settings, and run this again.";
    }
    if (reason === "unreachable") {
        return `${host} did not answer. Nothing on the node was touched — check ` +
               "it is powered on and on the same tailnet.";
    }
    if (reason === "hostkey") {
        return `${host} presented a different host key than the one .lcl pinned. ` +
               "Nothing ran. Confirm the node's key again before installing anything.";
    }
    if (reason === "auth") {
        return `${host} refused the login itself — this is the SSH key, not sudo, ` +
               "and no password box will change it. Nothing on the node was touched.";
    }
    return null;
}

/**
 * UNLOCKING sudo FOR ONE RUN — the same text down both roads.
 *
 * The reported symptom: a password was typed and run was clicked, yet it still
 * failed.
 *
 * The first version primed sudo's credential cache with `sudo -S -v`
 * and let the recipe's own `sudo -n` calls ride on it. Measured on a test node:
 * the prime SUCCEEDED (no bad-password marker) and the very next `sudo -n`
 * failed anyway, 505 ms in. A cached credential is a machine-wide policy
 * decision — `timestamp_timeout=0` disables it outright, and tty_tickets and
 * timestamp_type change what it is even keyed on. Building on it means the
 * password works or does not depending on how somebody's image was configured,
 * which is not a thing an operator can be expected to know or fix.
 *
 * So nothing is cached. sudo's own askpass mechanism hands the password to
 * EVERY call that needs one: SUDO_ASKPASS names a helper, `sudo -A` runs it,
 * and a node with passwordless sudo never invokes it at all — so one form works
 * in both cases.
 *
 * The password is never written to disk. The helper is three lines that echo an
 * environment variable, and the variable lives only in this one shell for the
 * length of this one run. It is not in argv, where `ps` on either machine would
 * show it, and the helper is removed by a trap on EXIT however the run ends.
 */
const SUDO_PRIME =
    "read -r LCL_SUDO_PW\n" +
    "export LCL_SUDO_PW\n" +
    "LCL_ASKPASS=$(mktemp)\n" +
    "trap 'rm -f \"$LCL_ASKPASS\"' EXIT INT TERM\n" +
    // the helper reads the environment; the secret never lands in the file
    "printf '%s\\n' '#!/bin/sh' 'printf \"%s\\\\n\" \"$LCL_SUDO_PW\"' > \"$LCL_ASKPASS\"\n" +
    "chmod 700 \"$LCL_ASKPASS\"\n" +
    "export SUDO_ASKPASS=\"$LCL_ASKPASS\"\n" +
    // PROVED ONCE, HERE, so a wrong password is one clear line and not a
    // failure four steps into an install
    "LCL_SUDO_ERR=$(sudo -A -v 2>&1) || { " +
    "case \"$LCL_SUDO_ERR\" in " +
    "*'not in the sudoers'*|*'not allowed to run sudo'*) echo LCL-NOT-A-SUDOER ;; " +
    "*tty*|*askpass*) echo LCL-SUDO-NEEDS-TTY ;; " +
    "*) echo LCL-BAD-PASSWORD ;; " +
    "esac; exit 1; }\n";
/**
 * RUN A NAMED RECIPE THROUGH THE NODE'S DOOR.
 *
 * The same job sshStream does, over the road a VPN kill switch cannot close:
 * ordinary outbound HTTPS to a Funnel hostname, resolved with publicDns so the
 * local Tailscale resolver does not hand back the tailnet address that is
 * exactly what is blocked. Measured on the test machine — the Funnel host answered
 * 401 through the VPN while spark:22 was EACCES.
 *
 * Shaped like sshStream's return on purpose: { done, cancel }, resolving
 * { ok, tail, cancelled }, so the install path does not care which road it took.
 */
function doorRun(n, key, { password = null, onLine = () => {}, idleMs = 300_000 } = {}) {
    const tail = [];
    let killed = false, req = null, exitCode = null;
    const done = new Promise((resolve) => {
        let tok = null;
        try { tok = doorTokenOf(n); } catch { /* below */ }
        if (!tok) return resolve({ ok: false, tail: ["no door token for this node"] });
        const body = JSON.stringify(password ? { key, password } : { key });
        let lastAt = Date.now(), buf = "";
        const idle = setInterval(() => {
            if (Date.now() - lastAt > idleMs) { killed = true; try { req.destroy(); } catch { } }
        }, 5000);
        const finish = (res) => { clearInterval(idle); resolve(res); };
        req = require("https").request(n.relayUrl + "/lcl/run", {
            method: "POST",
            headers: { Authorization: `Bearer ${tok}`,
                       "Content-Type": "application/json",
                       "Content-Length": Buffer.byteLength(body) },
            timeout: 30_000, lookup: publicDns.lookup
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return finish({ ok: false, tail: [
                    res.statusCode === 404
                        ? "this node's remote access is too old to run a recipe — update it"
                        : res.statusCode === 409
                            ? "the node is already running an install"
                            : `the door answered ${res.statusCode}`] });
            }
            res.setEncoding("utf8");
            res.on("data", (c) => {
                lastAt = Date.now();
                buf += c;
                let i;
                while ((i = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, i).trim();
                    buf = buf.slice(i + 1);
                    if (!line) continue;
                    // the door's own end-of-run marker, not part of the recipe
                    const m = /^LCL-DOOR-EXIT (\d+)$/.exec(line);
                    if (m) { exitCode = Number(m[1]); continue; }
                    tail.push(line);
                    if (tail.length > 40) tail.shift();
                    try { onLine(line, "out"); } catch { /* a listener must not kill the job */ }
                }
            });
            res.on("end", () => finish({
                ok: exitCode === 0 && !killed, code: exitCode,
                cancelled: killed, err: killed ? "stopped" : "", tail
            }));
            res.on("error", () => finish({ ok: false, cancelled: killed, tail }));
        });
        req.on("timeout", () => { try { req.destroy(); } catch { } });
        req.on("error", (e) => finish({ ok: false, cancelled: killed,
            err: String(e.code || e.message), tail }));
        req.write(body);
        req.end();
    });
    return { done, cancel: () => { killed = true; try { req && req.destroy(); } catch { } } };
}

/**
 * HOW FAR ALONG IS THIS LINE?
 *
 * The requirement: show the real progress of a download.
 *
 * Every downloader says so, and none of them agree on how. The lines already
 * arrive — sshStream splits on \r for exactly this reason — and then nothing
 * read them, so a 20 GB pull was a wall of scrolling text with no number in it.
 *
 *   ollama   pulling 8934d96d... 45% ▕███ ▏ 2.0 GB/4.7 GB  30 MB/s  1m30s
 *   pip      ━━━━━━  45.2/212.0 MB  10.2 MB/s  eta 0:00:16
 *   docker   abc123: Downloading [====>    ]  45.2MB/212MB
 *   apt      Progress: [ 45%]
 *   curl     45  212M   45 95.4M    0     0  10.0M      0  0:00:21 --:--:-- 11.2M
 *
 * Returns null for an ordinary log line, which is most of them.
 */
/* DOCKER PUBLISHES NO PERCENTAGE WITHOUT A TERMINAL. IT PUBLISHES LAYERS.
 *
 * "once again the installer is not complete with progress percentage bars that
 *  update as the steps run ... so it just sits there forever waiting, no idea
 *  to the user what the heck is going on on the local node ... like right now
 *  it is just saying pull complete on step 2 of installing unsloth. and its got
 *  a timer, counting. so im just sitting here waiting"
 *
 * Asked three times. The recipe text even apologised for it — "Docker reports no
 * percentage without a terminal, so watch the layer lines" — which is a true
 * sentence and a useless one: the layer lines ARE the progress and nothing was
 * counting them. With no TTY, `docker pull` drops its bars and prints one status
 * line per layer transition:
 *
 *     a1b2c3d4: Pulling fs layer      <- the denominator, all printed up front
 *     a1b2c3d4: Downloading
 *     a1b2c3d4: Pull complete         <- the numerator
 *
 * Layers are not equal in size, so this is an APPROXIMATION and the note says so
 * by naming the count rather than implying bytes: "7 of 24 layers". An honest
 * approximation beats a timer counting up next to the word "waiting".
 *
 * State lives on the STEP, not in a module variable: two nodes can install at
 * once, and a shared counter would have them adding up each other's layers.
 */
function dockerProgress(step, line) {
    // declared INSIDE so the function stands alone: the suite lifts it out
    // of this file by name and runs it, and a free variable would lift to
    // a ReferenceError that reads as "could not be tested"
    const DOCKER_STATUS =
        /^(pulling fs layer|waiting|downloading|verifying checksum|download complete|extracting|pull complete|already exists)/;
    const m = /^([0-9a-f]{6,}):\s+(.+?)\s*$/.exec(String(line || "").trim());
    if (!m) return null;
    const what = m[2].toLowerCase();
    if (!DOCKER_STATUS.test(what)) return null;
    const t = step._layers || (step._layers = { seen: new Set(), done: new Set() });
    t.seen.add(m[1]);
    // a layer already on the machine is finished work, and counts as such —
    // re-pulling an image that is mostly cached must not read as 0%
    if (what.startsWith("pull complete") || what.startsWith("already exists")) {
        t.done.add(m[1]);
    }
    const total = t.seen.size, done = t.done.size;
    if (!total) return null;
    return { pct: Math.min(100, Math.round(done / total * 100)),
             note: done + " of " + total + " layer" + (total === 1 ? "" : "s") };
}

function progressOf(line) {
    const s = String(line || "");
    // pip's --progress-bar raw: the only shape that survives having no
    // terminal, which is the shape this transport always has
    let m = /Progress\s+(\d+)\s+of\s+(\d+)/i.exec(s);
    if (m && +m[2] > 0) {
        return { pct: Math.min(100, Math.round(+m[1] / +m[2] * 100)), note: null };
    }
    // "45%" anywhere — ollama, apt, docker's own percent
    m = /(\d{1,3})\s*%/.exec(s);
    if (m && +m[1] <= 100) return { pct: +m[1], note: rateOf(s) };
    // "2.0 GB/4.7 GB", "45.2/212.0 MB", "45.2MB/212MB"
    m = /([\d.]+)\s*([KMGT]i?B)?\s*\/\s*([\d.]+)\s*([KMGT]i?B)/i.exec(s);
    if (m) {
        const unit = (u) => ({ k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[
            String(u || m[4])[0].toLowerCase()] || 1);
        const done = parseFloat(m[1]) * unit(m[2]), total = parseFloat(m[3]) * unit(m[4]);
        if (total > 0 && done <= total) {
            return { pct: Math.round(done / total * 100), note: rateOf(s) };
        }
    }
    // curl's plain layout: percent, size, percent, size...
    m = /^\s*(\d{1,3})\s+[\d.]+[kKMGT]?\s+\d{1,3}\s/.exec(s);
    if (m && +m[1] <= 100) return { pct: +m[1], note: rateOf(s) };
    return null;
}

// the speed and the time left, when the tool bothered to say
function rateOf(s) {
    const parts = [];
    const r = /([\d.]+\s*[KMGT]i?B\/s)/i.exec(s);
    if (r) parts.push(r[1]);
    const e = /(?:eta\s+)?(\d+:\d{2}(?::\d{2})?|\d+m\d+s)\s*$/i.exec(s.trim());
    if (e) parts.push(e[1] + " left");
    return parts.join(" · ") || null;
}

function sshBatch(user, host, cmd, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const creds = sshCreds(user, host);
        // STRICT, against the app's own pinned file. accept-new adopted the
        // first key that answered, which is the whole MITM window; an unknown
        // or changed key must fail the connection instead.
        const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6",
                      "-o", "StrictHostKeyChecking=yes",
                      "-o", `UserKnownHostsFile=${knownHostsFile()}`, ...creds.args];
        args.push(creds.target, cmd);
        const child = spawn("ssh", args,
            { windowsHide: true });
        let out = "", err = "";
        const timer = setTimeout(() => { child.kill(); resolve({ ok: false, err: "timed out" }); }, timeoutMs);
        child.stdout.on("data", d => { out += d; });
        child.stderr.on("data", d => { err += d; });
        child.on("error", e => { clearTimeout(timer); resolve({ ok: false, err: String(e.message) }); });
        child.on("close", code => {
            clearTimeout(timer);
            resolve({ ok: code === 0, out: out.trim(), err: err.trim().slice(0, 300) });
        });
    });
}

/**
 * The stored node records, nothing probed. The sidebar gauge polls every few
 * seconds and must not pay four port probes plus an SSH fallback per tick —
 * that is lcl:nodes, the Connections dialog's refresh. This is just the list.
 */
ipcMain.handle("lcl:nodeList", () => ({ nodes: readNodes() }));

// `force` is a person pressing Refresh or opening the dialog — that bypasses
// the probe governor's hold, because "check again NOW" is exactly what the
// press means. The 5-second background poll passes nothing.
ipcMain.handle("lcl:nodes", async (_e, force) => {
    // A REMEMBERED ROUTE IS TRIED FIRST, AND FROM ANYWHERE.
    //
    // If remote access was set up but the address was not answering yet — the
    // usual case: Funnel approved on Tailscale's site after the wizard ran —
    // this is where it comes good. One HTTPS request, no SSH, so it succeeds
    // on exactly the networks where everything else is blocked. Cheap: it
    // only runs while a node still has a pending route.
    for (const p of readNodes()) {
        if (!p.relayUrl && p.relayPending) {
            await activatePendingRelay(p.id).catch(() => false);
        }
    }
    const nodes = readNodes();
    const out = [];
    for (const n of nodes) {
        // SHORT LEASH ON A ROAD ALREADY KNOWN DEAD — the same thinking as
        // DIRECT_PROBE_MS in cloudModels, read from the same door-first map.
        // The per-refresh dial IS the direct road's re-check; it just stops
        // paying full timeouts for it while the relay is the road in use.
        const epId = nodeEndpointId(n);
        // any of this machine's engines preferring the door means the door is
        // the road for the machine
        const doorPreferred = !!n.relayUrl &&
            (nodeEndpointsOf(n).some(e => cloudModels.preferDoor(e.id))
             || cloudModels.preferDoor(epId));
        // a manual Refresh gets the FULL leash even while the door is
        // preferred — "check again NOW" must be able to catch a direct road
        // that answers slowly, or the short leash becomes a ratchet no
        // click can break (found in review)
        const leash = doorPreferred && !force ? 1200 : 2500;
        const [probes, ssh22] = await Promise.all([
            Promise.all(NODE_PORTS.map(p => probeNodePort(n.host, p.port, leash))),
            // the ssh-layer sentinel: a socket, not a spawn. Without it a
            // dead (or revived) sshd is invisible to the road class, and a
            // held verdict could outlive the truth by the whole ceiling.
            tcpOpen(n.host, 22, leash)
        ]);
        let serving = NODE_PORTS
            .map((p, i) => ({ ...p, ...probes[i] }))
            .filter(p => p.up);
        const direct = serving.length > 0;

        // ASK THE DOOR WHAT IT SERVES, WHEN THE DIRECT ROAD IS SHUT.
        //
        // Every port probe above dials the node's DIRECT address, which is
        // exactly what a full-tunnel VPN blocks — so a machine serving ten
        // models through a working relay came back with serving: [] and the
        // row said "Next: Install the model server on it. NVIDIA Sync does
        // not install one." Observed on a restricted network,
        // while the dashboard beside it was pulling live memory
        // from that same machine over that same relay. The door proxies
        // /v1/models already; nothing new is exposed by asking.
        if (!serving.length && n.relayUrl) {
            const via = await doorFetch(n, "/v1/models", 8000).catch(() => null);
            const list = via && (Array.isArray(via.data) ? via.data
                : Array.isArray(via.models) ? via.models : null);
            if (list && list.length) {
                // the port is the one the door was built to front; the label
                // stays honest about how we learned it
                serving = [{ port: DOOR_PORT, label: "model server",
                             up: true, models: list.length, via: "door" }];
            }
        }
        // learned through the relay, not the direct road
        const doorServing = !direct && serving.length > 0;
        // What state is the DIRECT road in, as observed on THIS refresh. The
        // port probes above are the cheap sentinel; this class is what the
        // probe governor keys on.
        const errs = probes.map(p => p.err).filter(Boolean);
        const roadCls = (direct ? "open"
            : errs.some(c => BLOCKED_CODES.has(c)) ? "blocked"
            : errs.includes("ECONNREFUSED") ? "refused"
            : "down") + (ssh22 ? "/22-open" : "/22-closed");
        if (n.relayUrl) {
            // ONE preference, shared with chat — the door-first map inside
            // cloudModels: prefer what works, and drop the preference the
            // instant the direct road answers again — no restart, no click,
            // no TTL to wait out.
            if (direct) cloudModels.noteDirectAlive(epId);
            else if (doorServing) cloudModels.noteDoorFirst(epId);
        }
        // SSH is the slow probe, so it ran only when nothing was serving —
        // which meant a HEALTHY node never got probed, ssh stayed null, and
        // the "Install remote door" button (gated on ssh === "ok") could not
        // appear on exactly the nodes able to install one. Observed:
        // VPN off, node serving, Refresh, and no button anywhere.
        // Now it also runs when the node has no door yet, because that is the
        // moment the answer is needed. A node with a door skips it as before.
        let ssh = null;
        let sshFresh = false;   // true only when the probe actually ran THIS tick
        if (!serving.length || !n.relayUrl) {
            // NOT CONFIRMED IS NOT UNREACHABLE.
            //
            // Strict host-key checking (added for the MITM finding) makes every
            // ssh to an unpinned machine fail with "Host key verification
            // failed" — and that was being reported as "cannot be reached from
            // here", which is simply false. The machine is right there; nobody
            // has confirmed it is the right one yet. Distinguish the two, so
            // the row asks for the confirmation instead of blaming the network.
            if (!hostIsPinned(n.host)) {
                const up = ssh22;    // the sentinel above already dialled 22
                ssh = up ? "unconfirmed" : "no answer on port 22";
                out.push({ ...n, serving, ssh, doorOk: false, hasDoor: !!n.relayUrl,
                   doorStale: !!n.relayUrl &&
                       (n.doorVersion == null || Number(n.doorVersion) < DOOR_WANTED),
                           route: direct ? "direct" : doorServing ? "relay" : null,
                           linked: nodeIsLinked(n),
                           probeErrs: probes.map(p => p.err).filter(Boolean) });
                continue;
            }
            // THE GOVERNOR, NOT THE POLL, DECIDES WHEN SSH RUNS. The dialog
            // repaints every 5 seconds; that cadence is right for sockets and
            // wrong for spawning ssh.exe at an answer that has not changed —
            // the log counted 2,109 of those in one day. A held tick serves
            // the last measured verdict; the port probes above stay live, so
            // any change of road state is seen at poll speed and probed at
            // once (govShouldProbe).
            const g = govFor(n.id);
            // g.busy: a probe is already in flight from an overlapping call —
            // the 5s poll does not await its previous pass, so without this
            // one due window could spawn two or three ssh.exe at once
            if (g.busy || (!force && !govShouldProbe(g, roadCls, Date.now()))) {
                g.held++;
                ssh = g.ssh;
            } else {
                g.busy = true;
                try {
                    const r = await sshBatch(n.user || null, n.host, "true", 12000);
                    // the STDERR line, not a summary — "unreachable" told nobody
                    // anything, and this probe's failure is the whole reason the
                    // door cannot be installed. Whatever ssh says is what the row
                    // shows.
                    ssh = r.ok ? "ok"
                        : ((r.err || "").split(/\r?\n/).filter(Boolean).pop() || "no answer");
                    sshFresh = true;
                    const changed = govRecord(g, roadCls, ssh, Date.now());
                    // ON DISK, NOT JUST ON SCREEN — but the TRANSITIONS, not the
                    // repetition. Every distinct result still lands with its exact
                    // argv (six releases were spent guessing at this probe), and
                    // `held` records how many identical observations sat between
                    // this line and the last one, so the day remains reconstructible
                    // from the log without 2,000 copies of the same line.
                    if (changed) {
                        try {
                            const creds = sshCreds(n.user || null, n.host);
                            auditLog.write({ kind: "node-ssh-probe", host: n.host,
                                             ok: !!r.ok, result: ssh.slice(0, 300),
                                             target: creds.target, args: creds.args.join(" "),
                                             held: g.held, at: Date.now() });
                        } catch { /* diagnostics must never break the probe */ }
                        g.held = 0;
                    } else {
                        g.held++;
                    }
                } finally { g.busy = false; }
            }
        }
        // THE DOOR GETS ITSELF INSTALLED.
        //
        // A door can only be built while the node is reachable — and the user
        // who most needs one is the user whose node is usually NOT reachable,
        // stuck on a network where a kill switch blocks the tailnet and the
        // install can never run. Waiting for them to notice a button during
        // the brief window it works is a plan that fails by design.
        //
        // So: whenever SSH answers and no door exists, adopt one the node
        // already has — and if it has none, build it, unattended, using the
        // passwordless-sudo path. If sudo needs a password we do nothing here
        // and leave the button, because a hidden prompt nobody can see is
        // worse than no attempt.
        // FIRE AND FORGET. This is the handler that paints the Connections
        // dialog, and it used to AWAIT a full door installation here: two scp
        // transfers at 20s each plus an sshBatch with a 120 SECOND timeout.
        // So the moment SSH started working — exactly when the user turned
        // their VPN off to make it work — a routine refresh blocked for
        // minutes, the dialog sat on "probing your nodes…", and the row never
        // updated. Reported as "the install door button still doesn't
        // enable": the button was never repainted at all.
        //
        // The install still happens; it just does not hold the UI hostage.
        // inFlightDoor keeps a second refresh from starting a duplicate.
        // ADOPT ONLY, AND ONLY A PINNED HOST. Creating remote access exposes
        // this machine's inference API to the internet, so it belongs to the
        // wizard where the operator is present — not to a dialog refresh. And
        // `ssh === "ok"` was never proof of identity: an sshd that accepts any
        // offered key would have had ITS relay URL adopted as this node's,
        // pointing the chat transport at it.
        if (ssh === "ok" && !n.relayUrl && hostIsPinned(n.host)
            && !inFlightDoor.has(n.id) && (force || adoptDue(n.id))) {
            inFlightDoor.add(n.id);
            Promise.resolve()
                .then(() => adoptNodeDoor(n.id))
                .then(got => adoptRecord(n.id, !!got))
                .catch(() => { adoptRecord(n.id, false); /* the row reports its own state next refresh */ })
                .then(() => { inFlightDoor.delete(n.id); });
        }
        let doorOk = false;
        if (!serving.length && ssh !== "ok" && n.relayUrl) {
            const d = await doorFetch(n, "/lcl/ping", 6000);
            doorOk = !!(d && d.ok);
        }
        // A MACHINE THAT SERVES MODELS HAS ITS MODELS. No button for it.
        //
        // "if the only reason we are adding the spark is to run models, why is
        //  there a link models button. that should be as soon as the device is
        //  connected... that being said, we can not afford to have the models
        //  go stale."
        //
        // Both halves: link on sight, and re-read whenever the machine's own
        // count stops matching what is registered — models get pulled and
        // deleted on the node, and a picker listing a model that is no longer
        // there is worse than one that is a minute behind.
        await syncNodeModels(n, serving);
        // ...and the WINDOW is as perishable as the model list: a server
        // restarted with a different --ctx-size serves a different window, and
        // a stale one silently truncates the conversation. Same cadence.
        await healNodeWindows(n);
        // WHICH ROAD IS IN USE, stated as a field the row can draw — "remote
        // access on" says one exists; this says which one is carrying traffic.
        const route = direct ? "direct" : (doorServing || doorOk) ? "relay" : null;
        out.push({ ...n, serving, ssh, sshFresh, doorOk, hasDoor: !!n.relayUrl, route,
                   doorStale: !!n.relayUrl &&
                       (n.doorVersion == null || Number(n.doorVersion) < DOOR_WANTED),
                   linked: nodeIsLinked(n),
                   probeErrs: probes.map(p => p.err).filter(Boolean) });
    }
    // Only an OBSERVED block accuses anything. A node that merely timed out
    // is a node that might be switched off, and saying "your VPN" about it is
    // how the old reading latched onto a VPN that was not even routing.
    const blocked = out.some(n => (n.serving || []).length === 0
        && (n.probeErrs || []).some(c => BLOCKED_CODES.has(c)));
    // anything actually answering is proof the road is open again — but only
    // an answer MEASURED THIS TICK counts. A governor-held "ok" from before a
    // kill switch engaged is not proof of anything (found in review: it reset
    // the block verdict's sticky memory at the exact moment the block began)
    const reached = out.some(n => (n.serving || []).length
        || (n.sshFresh && n.ssh === "ok") || n.doorOk);
    return { nodes: out, vpn: await blockDiagnosis(blocked, reached) };
});

/**
 * WHAT MACHINES CAN THIS APP SEE?
 *
 * Asking a person to paste 100.64.0.1 into a box hinted "spark-xxxx.local"
 * is two failures at once: the hint contradicts the answer, and the answer is
 * a number they never chose. They named the device. Tailscale knows that name,
 * knows its address, and knows whether it is online — so the app asks
 * Tailscale and shows a LIST TO CLICK.
 *
 * Falls back to the machine's own ssh_config aliases (what NVIDIA Sync wrote)
 * when Tailscale is not installed, so a LAN-only user still gets a list.
 */
function tailscalePeers() {
    return new Promise((resolve) => {
        const exe = process.platform === "win32"
            ? path.join(process.env["ProgramFiles"] || "C:\\Program Files",
                        "Tailscale", "tailscale.exe")
            : "tailscale";
        const child = spawn(exe, ["status", "--json"], { windowsHide: true });
        let out = "";
        const timer = setTimeout(() => { child.kill(); resolve([]); }, 6000);
        child.stdout.on("data", d => { out += d; });
        child.on("error", () => { clearTimeout(timer); resolve([]); });
        child.on("close", () => {
            clearTimeout(timer);
            try {
                const j = JSON.parse(out);
                const all = { ...(j.Peer || {}) };
                const list = Object.values(all).map(p2 => ({
                    name: (p2.HostName || p2.DNSName || "").replace(/\..*$/, ""),
                    address: (p2.TailscaleIPs || [])[0] || null,
                    os: p2.OS || "",
                    online: !!p2.Online,
                    via: "tailscale"
                })).filter(x => x.address && x.name);
                resolve(list);
            } catch { resolve([]); }
        });
    });
}

function syncAliases() {
    try {
        const f = syncSshConfig();
        if (!f) return [];
        const txt = fs.readFileSync(f, "utf8");
        const out = [];
        for (const m of txt.matchAll(/^Host\s+(\S+)/gmi)) {
            out.push({ name: m[1].replace(/\.local$/, ""), address: m[1],
                       os: "linux", online: true, via: "nvidia-sync" });
        }
        return out;
    } catch { return []; }
}

/**
 * Every candidate machine, each probed for a model server, deduplicated by
 * address. Already-added nodes are marked so the UI can say "added" rather
 * than offering a duplicate.
 */
/*
 * ONE DEAD NAME MUST NOT COST FOUR LOOKUPS EVERY FIVE SECONDS.
 *
 * discoverNodes probed four ports per candidate, each an independent
 * http.get by HOSTNAME — so one alias produced four simultaneous
 * getaddrinfo calls. Measured on a test machine: a vendor sync tool's
 * ssh_config names "ai-node-01.local", a single lookup of which
 * takes 20,287 ms before ENOTFOUND, and the 2 s socket timeout does NOT
 * cancel the resolution — the threads stay held for 20-40 s. The API's &
 * Connections dialog re-runs this every 5 s with no in-flight guard, so the
 * queue grew without bound while the user sat on the page pressing Refresh. A
 * victim lookup measured 40,362 ms against 11 ms on an idle process.
 *
 * The name is resolved ONCE per candidate here, off the pool, and the ports
 * are probed against the resulting address. A name that does not resolve is
 * remembered as dead for a while, so a machine that is simply not on this
 * network stops costing anything at all.
 */
const deadNames = new Map();               // host -> when it last failed
const DEAD_NAME_TTL_MS = 5 * 60_000;

function resolveCandidate(host) {
    if (require("net").isIP(host)) return Promise.resolve(host);
    const failedAt = deadNames.get(host);
    if (failedAt && Date.now() - failedAt < DEAD_NAME_TTL_MS) return Promise.resolve(null);
    return new Promise((resolve) => {
        let settled = false;
        const t = setTimeout(() => {
            if (settled) return;
            settled = true;
            deadNames.set(host, Date.now());
            resolve(null);
        }, 3000);
        if (t.unref) t.unref();
        try {
            cloudModels.lookupOffThreadPool(host, {}, (err, addr) => {
                if (settled) return;
                settled = true;
                clearTimeout(t);
                if (err || !addr) { deadNames.set(host, Date.now()); return resolve(null); }
                deadNames.delete(host);
                resolve(addr);
            });
        } catch { settled = true; clearTimeout(t); deadNames.set(host, Date.now()); resolve(null); }
    });
}

ipcMain.handle("lcl:discoverNodes", async () => {
    const seen = new Map();
    for (const c of [...(await tailscalePeers()), ...syncAliases()]) {
        if (!seen.has(c.address)) seen.set(c.address, c);
    }
    const known = new Set(readNodes().map(n => n.host));
    const cands = [...seen.values()];
    const probed = await Promise.all(cands.map(async (c) => {
        // resolved ONCE; a name that does not answer costs nothing further
        const addr = await resolveCandidate(c.address);
        if (!addr) {
            return { ...c, serving: [], added: known.has(c.address),
                     probeErrs: ["ENOTFOUND"] };
        }
        const hits = await Promise.all(NODE_PORTS.map(p2 => probeNodePort(addr, p2.port, 2000)));
        const serving = NODE_PORTS.map((p2, i) => ({ ...p2, ...hits[i] })).filter(x => x.up);
        return { ...c, serving, added: known.has(c.address),
                 probeErrs: hits.map(h => h.err).filter(Boolean) };
    }));

    // ONE MACHINE, ONE ROW. The Spark answers to both a Tailscale name and an
    // NVIDIA Sync alias; without this it appears twice and the user has to
    // guess which entry is real. Where two addresses serve an identical model
    // set, keep the TAILSCALE one — it is the address that also works from
    // another network, so choosing it removes the second decision too. Also
    // collapses by name, for machines that serve nothing yet.
    const byPrint = new Map();
    const merged = [];
    for (const c of probed) {
        const print = (c.serving.find(x => x.fingerprint) || {}).fingerprint
            || ("name:" + c.name.toLowerCase());
        const prev = byPrint.get(print);
        if (!prev) { byPrint.set(print, c); merged.push(c); continue; }
        // same machine seen twice — keep the better address, remember the other
        const keepNew = c.via === "tailscale" && prev.via !== "tailscale";
        const winner = keepNew ? c : prev;
        const loser = keepNew ? prev : c;
        winner.alsoKnownAs = [...(winner.alsoKnownAs || []), loser.address];
        winner.added = winner.added || loser.added;
        if (keepNew) {
            merged[merged.indexOf(prev)] = c;
            byPrint.set(print, c);
        }
    }

    // machines that already serve models first — those are the ones to click
    merged.sort((a, b) => (b.serving.length - a.serving.length) || a.name.localeCompare(b.name));
    const blocked = probed.some(c => (c.serving || []).length === 0
        && (c.probeErrs || []).some(x => BLOCKED_CODES.has(x)));
    const reached = probed.some(c => (c.serving || []).length);
    return { candidates: merged, vpn: await blockDiagnosis(blocked, reached) };
});

/* ---------------------------------------------------------------------------
 * ANY OWNED MACHINE, NOT JUST AN NVIDIA ONE.
 *
 * Discovery was Tailscale peers plus a vendor sync tool's ssh_config, and
 * credentials came only from that tool. So a vendor-paired node worked and every
 * other box a user owns — a second node, a Linux tower, a mini PC — got nothing.
 * The requirement: the product must detect a local node whatever it is, no
 * matter the manufacturer.
 *
 * This scans the local subnets for machines that either answer SSH or already
 * serve a model port. No vendor agent, no assumption about who made it.
 * ------------------------------------------------------------------------- */

/** Every IPv4 /24 this machine sits on, excluding link-local and loopback. */
function localSubnets() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
        for (const a of list || []) {
            if (a.family !== "IPv4" || a.internal) continue;
            if (/^169\.254\./.test(a.address)) continue;
            if (/^100\./.test(a.address)) continue;          // tailscale CGNAT
            const base = a.address.replace(/\.\d+$/, "");
            if (!out.includes(base)) out.push(base);
        }
    }
    return out;
}

/** Is a TCP port open? Short timeout — this runs 254 times per subnet. */
function tcpProbe(host, port, ms = 400) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        const done = (v) => { try { sock.destroy(); } catch { /* closed */ } resolve(v); };
        sock.setTimeout(ms);
        sock.once("connect", () => done(true));
        sock.once("timeout", () => done(false));
        sock.once("error", () => done(false));
        sock.connect(port, host);
    });
}

/**
 * Machines on the LAN worth offering. A host qualifies if it answers SSH (we
 * can set it up) or already serves a model port (it is already useful).
 * Bounded concurrency so a /24 sweep does not open 254 sockets at once.
 */
async function lanCandidates(timeoutMs = 12000) {
    const bases = localSubnets();
    if (!bases.length) return [];
    const deadline = Date.now() + timeoutMs;
    const hits = new Map();
    const self = new Set(Object.values(os.networkInterfaces()).flat()
        .filter(a => a && a.family === "IPv4").map(a => a.address));

    for (const base of bases) {
        const targets = [];
        for (let i = 1; i <= 254; i++) {
            const ip = `${base}.${i}`;
            if (!self.has(ip)) targets.push(ip);
        }
        let idx = 0;
        const worker = async () => {
            while (idx < targets.length && Date.now() < deadline) {
                const ip = targets[idx++];
                if (await tcpProbe(ip, 22, 350)) {
                    hits.set(ip, { address: ip, name: ip, os: "", online: true,
                                   via: "lan", ssh: true, serving: [] });
                    continue;
                }
                for (const p of NODE_PORTS) {
                    if (await tcpProbe(ip, p.port, 250)) {
                        const e = hits.get(ip) || { address: ip, name: ip, os: "",
                            online: true, via: "lan", ssh: false, serving: [] };
                        e.serving.push({ ...p, up: true });
                        hits.set(ip, e);
                        break;
                    }
                }
            }
        };
        await Promise.all(Array.from({ length: 32 }, worker));
    }

    // a reverse lookup turns 192.168.0.42 into something a person recognises
    await Promise.all([...hits.values()].map(async (h) => {
        try {
            const names = await require("dns").promises.reverse(h.address);
            // A PTR RECORD IS AN ATTACKER-CONTROLLED STRING. It is whatever the
            // host (or whoever runs reverse DNS for that range) chose to say,
            // and it was being rendered as this row's identity. Validated to
            // plain ASCII hostname shape, length-capped, and never allowed to
            // look like an address; anything else is dropped and the numeric
            // address stands. The renderer additionally treats it as unverified
            // rather than as a reason to trust the row.
            const raw = String((names && names[0]) || "")
                .replace(/\.$/, "").replace(/\.(local|lan)$/i, "");
            const shaped = raw.length > 0 && raw.length <= 63
                && /^(?!-)[a-z0-9-]+(\.(?!-)[a-z0-9-]+)*$/i.test(raw)
                && !/^\d+(\.\d+)*$/.test(raw);
            if (shaped) { h.name = raw; h.nameFrom = "reverse-dns"; }
        } catch { /* no PTR record; the address stands */ }
    }));

    return [...hits.values()];
}

ipcMain.handle("lcl:scanLan", guard(async () => {
    const found = await lanCandidates();
    const known = new Set(readNodes().map(n => n.host));
    return { candidates: found.map(c => ({ ...c, added: known.has(c.address) })) };
}));

/**
 * AUTHORISE THIS MACHINE ON THAT NODE — one password, in a terminal.
 *
 * OpenSSH cannot accept a password non-interactively and Windows ships no
 * sshpass, so the honest version is a visible terminal where the operator
 * types their own node password once. .lcl's public key is appended to the
 * node's authorized_keys; from then on every access is key-based and silent.
 *
 * The password goes to the node's own sshd. It is never read, stored or seen
 * by this application.
 */
ipcMain.handle("lcl:nodeAuthorize", guard(async (_e, spec) => {
    const host = String((spec && spec.host) || "").trim();
    const user = String((spec && spec.user) || "").trim();
    if (!host || /[\s'"`;|&]/.test(host)) return { error: "that does not look like a host" };
    if (!user || /[\s'"`;|&]/.test(user)) return { error: "a username is required" };

    // reuse .lcl's own node key, or make one
    let keyFile = null;
    try {
        const existing = fs.readdirSync(sshDir())
            .filter(f => /^lcl-node-.*\.pub$/.test(f))
            .map(f => path.join(sshDir(), f.replace(/\.pub$/, "")));
        keyFile = existing[0] || null;
    } catch { /* dir may not exist yet */ }

    if (!keyFile) {
        const base = path.join(sshDir(), `lcl-node-${Date.now().toString(36)}`);
        fs.mkdirSync(sshDir(), { recursive: true });
        const gen = await new Promise((resolve) => {
            const c = spawn(sshKeygenBin(),
                ["-t", "ed25519", "-f", base, "-N", "", "-C", "lcl-node"],
                { windowsHide: true });
            const t = setTimeout(() => { c.kill(); resolve(false); }, 20000);
            c.on("error", () => { clearTimeout(t); resolve(false); });
            c.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
        });
        if (!gen || !fs.existsSync(base + ".pub")) {
            return { error: "could not generate a key — install the Windows OpenSSH Client feature" };
        }
        keyFile = base;
    }

    const pub = fs.readFileSync(keyFile + ".pub", "utf8").trim();
    // append idempotently; never duplicate the line
    const remote =
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && " +
        `grep -qxF '${pub}' ~/.ssh/authorized_keys 2>/dev/null || ` +
        `echo '${pub}' >> ~/.ssh/authorized_keys; ` +
        "chmod 600 ~/.ssh/authorized_keys && echo LCL-KEY-INSTALLED";

    // NO PASSWORD TO AN UNVERIFIED HOST. This previously ran
    // StrictHostKeyChecking=accept-new with PubkeyAuthentication=no — trusting
    // whatever answered the address AND removing the one auth method that
    // cannot be phished. Anyone able to answer for that address on the LAN
    // collected the operator's account password, which on a typical Linux node
    // is also its sudo password. The host key must be pinned first, by a human
    // comparing the fingerprint, and this refuses to run until it is.
    if (!hostIsPinned(host)) {
        return { error: "this machine's identity has not been confirmed yet — " +
                        "check its fingerprint first" };
    }
    const kh = knownHostsFile();

    const bat = path.join(app.getPath("temp"), `lcl-auth-${Date.now()}.cmd`);
    fs.writeFileSync(bat,
        "@echo off\r\n" +
        "title .lcl - authorise this computer\r\n" +
        `echo Authorising this computer on ${host}\r\n` +
        "echo.\r\n" +
        `echo You will be asked for the password of "${user}" on that machine.\r\n` +
        "echo Its identity was confirmed by you beforehand, so the password goes\r\n" +
        "echo to that machine and nowhere else. .lcl never sees it.\r\n" +
        "echo.\r\n" +
        // an already-installed key short-circuits the prompt entirely; the
        // password is only ever reached when publickey genuinely fails
        `ssh -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${kh}" ` +
            `-i "${keyFile}" -o IdentitiesOnly=yes ` +
            `-o PreferredAuthentications=publickey,password ` +
            `"${user}@${host}" "${remote.replace(/"/g, '""')}"\r\n` +
        "echo.\r\n" +
        "echo If you saw LCL-KEY-INSTALLED above, this computer is authorised.\r\n" +
        "pause\r\n", "utf8");

    const p = spawn("cmd.exe", ["/c", "start", "", bat],
        { detached: true, stdio: "ignore", windowsHide: false });
    p.unref();
    auditLog.write({ kind: "node-authorize-launched", host, user, at: Date.now() });
    return { ok: true, keyId: path.basename(keyFile),
             note: "a terminal opened — type that machine's password once" };
}));

/** Did the key take? Proven by using it, not by trusting the terminal. */
ipcMain.handle("lcl:nodeAuthCheck", guard(async (_e, spec) => {
    const host = String((spec && spec.host) || "").trim();
    const user = String((spec && spec.user) || "").trim();
    if (!host) return { error: "no host" };
    const r = await sshBatch(user || null, host, "echo LCL-AUTH-OK", 10000);
    return { ok: !!(r.ok && /LCL-AUTH-OK/.test(r.out || "")),
             detail: r.ok ? "" : ((r.err || "").split(/\r?\n/).filter(Boolean).pop() || "no answer") };
}));

/**
 * What does this node still need? Read-only: reports, changes nothing.
 * The wizard uses it to decide which steps to offer.
 */
ipcMain.handle("lcl:nodeReadiness", guard(async (_e, spec) => {
    const host = String((spec && spec.host) || "").trim();
    const user = String((spec && spec.user) || "").trim();
    if (!host) return { error: "no host" };
    const r = await sshBatch(user || null, host,
        "echo OS=$(uname -s); echo ARCH=$(uname -m); " +
        "echo PY=$(command -v python3 || echo no); " +
        "echo TS=$(command -v tailscale || echo no); " +
        "echo OLLAMA=$(command -v ollama || echo no); " +
        "echo SUDONP=$(sudo -n true 2>/dev/null && echo yes || echo no); " +
        "echo SERVING=$(curl -s -m 2 -o /dev/null -w '%{http_code}' " +
            "http://127.0.0.1:11434/api/tags 2>/dev/null || echo 000); " +
        "echo DOOR=$([ -s $HOME/.config/lcl-door/token ] && echo yes || echo no); " +
        // WHICH door, not just whether one. A node running an older door is
        // missing routes this build depends on — v4 is what carries an install
        // through a VPN kill switch — and the wizard used to skip its own
        // setup screen entirely once a door of ANY age was installed, so there
        // was no way to update one from inside the app.
        // NOT `tr -dc 0-9` ON THE WHOLE LINE. The version line names itself in
        // its own comment — DOOR_VERSION = "4"  # 4 adds /lcl/run — so stripping
        // non-digits from the line returned "44": the version with the comment's
        // digits glued on. Every door version carries such a comment, so this
        // was never one number, and the comparison that decides whether to offer
        // an update was made against it. Take what is between the quotes.
        "echo DOORV=$(grep -m1 '^DOOR_VERSION' $HOME/.config/lcl-door/lcl-door.py " +
            "2>/dev/null | cut -d'\"' -f2 | tr -dc 0-9 || echo 0); " +
        // INSTALLED IS NOT PUBLISHED. A token file proves the door was set up
        // once; only `tailscale funnel status` showing an https address proves
        // the internet can actually reach it. Conflating the two made the
        // wizard skip the one screen that finishes the job — observed as
        // remote access "installed" that worked from nowhere.
        "echo FUNNEL=$(tailscale funnel status 2>/dev/null | grep -q https " +
            "&& echo yes || echo no); " +
        "echo TSUP=$(tailscale status --json 2>/dev/null | " +
            "python3 -c 'import json,sys; print(json.load(sys.stdin)[\"BackendState\"])' 2>/dev/null || echo no)",
        15000);
    if (!r.ok) return { error: (r.err || "unreachable").slice(0, 200) };
    const g = (k) => (new RegExp("^" + k + "=(.*)$", "m").exec(r.out || "") || [])[1] || "";
    return {
        ok: true,
        os: g("OS"), arch: g("ARCH"),
        python3: g("PY") !== "no", tailscale: g("TS") !== "no",
        ollama: g("OLLAMA") !== "no", passwordlessSudo: g("SUDONP") === "yes",
        servingOllama: g("SERVING") === "200",
        doorInstalled: g("DOOR") === "yes",
        doorVersion: Number(g("DOORV") || 0),
        doorWanted: DOOR_WANTED,
        doorStale: g("DOOR") === "yes" && Number(g("DOORV") || 0) < DOOR_WANTED,
        doorPublished: g("FUNNEL") === "yes",
        tailscaleUp: g("TSUP") === "Running"
    };
}));

/* THE DOOR VERSION THIS BUILD SHIPS, read out of the script itself so it can
 * never disagree with what actually gets uploaded. */
const DOOR_WANTED = (() => {
    try {
        const p = [path.join(process.resourcesPath || path.join(__dirname, ".."),
                             "tools", "node-door", "lcl-door.py"),
                   path.join(__dirname, "..", "tools", "node-door", "lcl-door.py")]
            .find(x => fs.existsSync(x));
        if (!p) return 0;
        const m = /DOOR_VERSION = "(\d+)"/.exec(fs.readFileSync(p, "utf8"));
        return m ? Number(m[1]) : 0;
    } catch { return 0; }
})();

/**
 * STOP ASKING THIS NODE FOR A PASSWORD.
 *
 * "so it seems like the first thing to do, it get the spark to stop requiring
 *  sudo. that was one of my first ever requests weeks ago"
 *
 * It was, and everything since has been working around it: a preflight that
 * refused, then a password box, then an askpass helper because the box's
 * password would not survive to the next step. All of that is still needed for
 * a node .lcl does not own. None of it is needed on the user's own appliance,
 * which was the priority.
 *
 * WHAT IT ACTUALLY DOES is one file:
 *
 *     <user> ALL=(ALL) NOPASSWD:ALL   ->  /etc/sudoers.d/lcl-nopasswd  (0440)
 *
 * VALIDATED BEFORE IT IS INSTALLED. A malformed file in /etc/sudoers.d breaks
 * sudo for EVERY user on the machine, including the one that would have to fix
 * it — the single way this could do real harm. So it is written to a temp file,
 * checked with `visudo -c`, and only then moved into place with `install`,
 * which puts it there in one step rather than leaving a half-written file.
 *
 * Reversible from the same button, because a security change nobody can undo
 * from where they made it is not a setting, it is a trap.
 */
ipcMain.handle("lcl:nodeSudoNoPassword", guard(async (_e, spec) => {
    const nodeId = String((spec && spec.nodeId) || "");
    const on = !!(spec && spec.enable);
    const password = (spec && typeof spec.password === "string" && spec.password)
        ? spec.password : null;
    const n = readNodes().find(x => x.id === nodeId);
    if (!n) return { error: "no such node" };
    if (!hostIsPinned(n.host)) {
        return { error: "confirm this node's host key before changing anything on it" };
    }

    // literals, as everywhere else: the only thing the caller chooses is on/off
    const FILE = "/etc/sudoers.d/lcl-nopasswd";
    const body = on
        ? "T=$(mktemp)\n" +
          "printf '%s ALL=(ALL) NOPASSWD:ALL\\n' \"$USER\" > \"$T\"\n" +
          // THE CHECK THAT MATTERS. An invalid file here breaks sudo for
          // everyone, so nothing is installed until visudo has read it.
          "sudo -A visudo -cqf \"$T\" || { echo LCL-SUDOERS-INVALID; rm -f \"$T\"; exit 1; }\n" +
          "sudo -A install -m 0440 -o root -g root \"$T\" " + FILE + " || " +
          "{ echo LCL-SUDOERS-WRITE-FAILED; rm -f \"$T\"; exit 1; }\n" +
          "rm -f \"$T\"\n" +
          // ...and it is only true when the node says so without being asked
          "sudo -n true 2>/dev/null && echo LCL-NOPASSWD-ON || " +
          "{ echo LCL-NOPASSWD-DID-NOT-TAKE; exit 1; }\n"
        : "sudo -A rm -f " + FILE + " || { echo LCL-SUDOERS-WRITE-FAILED; exit 1; }\n" +
          "sudo -n true 2>/dev/null && echo LCL-NOPASSWD-STILL-ON || echo LCL-NOPASSWD-OFF\n";

    const script = password ? SUDO_PRIME + "set -e\n" + body : "set -e\n" + body;
    const job = sshStream(n.user || null, n.host, script, {
        stdin: password, idleMs: 60_000, maxMs: 120_000
    });
    const res = await job.done;
    const said = (m) => (res.tail || []).some(l => l.includes(m));

    const why = sshFailure(res.tail);
    if (why) {
        const vpn = why === "blocked" ? await blockDiagnosis(true, false) : null;
        return { error: sshFailureSays(why, n.host, vpn) };
    }
    if (said("LCL-SUDOERS-INVALID")) {
        return { error: "the rule did not pass sudo's own syntax check, so nothing " +
                        "was written. Your node's sudo is untouched." };
    }
    if (said("LCL-BAD-PASSWORD")) {
        return { error: "that password was not accepted on the node", badPassword: true };
    }
    if (said("LCL-NOT-A-SUDOER")) {
        return { error: (n.user || "this login") + " is not allowed to run sudo on " +
                        n.host + " at all, so this cannot be changed from here." };
    }
    if (said("LCL-NOPASSWD-ON")) {
        auditLog.write({ kind: "node-sudo-nopassword", node: nodeId, on: true, at: Date.now() });
        return { ok: true, on: true };
    }
    if (said("LCL-NOPASSWD-OFF")) {
        auditLog.write({ kind: "node-sudo-nopassword", node: nodeId, on: false, at: Date.now() });
        return { ok: true, on: false };
    }
    return { error: (res.tail || []).slice(-3).join(" · ").slice(0, 300)
                    || "the node did not confirm the change" };
}));

/**
 * WHICH CONVERSATIONS ARE POINTED AT THIS ADDRESS RIGHT NOW.
 *
 * .lcl is multi-session: more than one session may be running at once, and
 *  they may be using different services.
 *
 * An install that takes a port does not just replace a server — it can cut
 * the ground from under a session that is mid-turn on it, in another tab,
 * belonging to work that has nothing to do with the install. Naming the
 * losing recipe was only half the warning; this is the half that is about
 * him rather than about the roster.
 */
ipcMain.handle("lcl:sessionsOnPort", guard((_e, spec) => {
    const host = String((spec && spec.host) || "").trim();
    const port = Number((spec && spec.port) || 0);
    if (!host || !port) return { ok: true, sessions: [] };
    let eps = [];
    try { eps = cloudModels.endpoints().list || cloudModels.endpoints() || []; }
    catch { eps = []; }
    const hit = new Set((Array.isArray(eps) ? eps : [])
        .filter(e => String(e.baseUrl || "").includes(host + ":" + port))
        .map(e => e.id));
    if (!hit.size) return { ok: true, sessions: [] };
    // both shapes a selection has ever been stored in
    const idOf = (sel) => {
        if (!sel) return null;
        if (typeof sel === "object") return sel.endpointId || null;
        const m = /^api:([^|]+)\|/.exec(String(sel));
        return m ? m[1] : null;
    };
    const out = sessions.list()
        .filter(s => hit.has(idOf(s.modelSel)))
        .map(s => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
    return { ok: true, sessions: out };
}));

/** The model files on THIS machine — what Local Models is a page about. */
ipcMain.handle("lcl:localModels", guard(() => {
    const dir = paths.modelsDir();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return { ok: true, dir, models: [] }; }
    const out = [];
    for (const f of names) {
        if (!f.toLowerCase().endsWith(".gguf")) continue;
        let bytes = 0, mtime = 0;
        try {
            const st = fs.statSync(path.join(dir, f));
            bytes = st.size; mtime = st.mtimeMs;
        } catch { /* listed anyway; the size is the nicety */ }
        out.push({ file: f, bytes, mtime });
    }
    out.sort((a, b) => b.bytes - a.bytes);
    // which one the engine would actually load, so "in use" is a fact and not
    // an inference the operator has to make from filenames
    let inUse = null;
    try { inUse = path.basename(paths.findModel() || "") || null; } catch { }
    return { ok: true, dir, inUse, models: out };
}));

/**
 * Remove one model file from this machine.
 *
 * THE NAME IS A NAME, NEVER A PATH. Anything with a separator in it, or that
 * resolves outside the models directory, is refused — a delete driven from the
 * renderer is exactly where a traversal would be worth someone's time.
 */
ipcMain.handle("lcl:localModelRemove", guard((_e, file) => {
    const name = String(file || "");
    if (!name || name !== path.basename(name) || !name.toLowerCase().endsWith(".gguf")) {
        return { error: "not a model file name" };
    }
    const dir = paths.modelsDir();
    const full = path.join(dir, name);
    if (path.resolve(path.dirname(full)) !== path.resolve(dir)) {
        return { error: "that is not in this machine's model folder" };
    }
    if (!fs.existsSync(full)) return { error: "already gone" };
    try { fs.unlinkSync(full); }
    catch (e) { return { error: String((e && e.message) || e).slice(0, 160) }; }
    auditLog.write({ kind: "local-model-removed", file: name, at: Date.now() });
    return { ok: true };
}));
ipcMain.handle("lcl:nodeAdd", guard((_e, spec) => {
    const host = String((spec && spec.host) || "").trim();
    const user = String((spec && spec.user) || "").trim();
    // The name the USER gave the device, not the address they had to type.
    const name = String((spec && spec.name) || "").trim() || host;
    if (!host || /[\s'"`;|&]/.test(host) || /[\s'"`;|&]/.test(user)) {
        return { error: "that does not look like a hostname" };
    }
    // username is OPTIONAL: a Sync-paired machine authenticates through
    // Sync's own ssh_config, alias + key + user included
    const nodes = readNodes().filter(n => n.host !== host);
    nodes.push({ id: "node-" + Date.now().toString(36), name, host, user });
    paths.writeSettings({ [NODES_KEY]: nodes });
    auditLog.write({ kind: "node-added", host, at: Date.now() });
    return { ok: true };
}));

ipcMain.handle("lcl:nodeRemove", guard(async (_e, id) => {
    const n = readNodes().find(x => x.id === id);
    paths.writeSettings({ [NODES_KEY]: readNodes().filter(x => x.id !== id) });
    // a removed node takes its scheduler state with it — held verdicts,
    // backoff clocks and re-read floors must not outlive the record
    probeGov.delete(id); adoptGov.delete(id); armGov.delete(id); lastSync.delete(id);
    // REMOVING A NODE MUST REVOKE ITS DOOR. Leaving the funnel published and
    // the token valid means "remove" quietly left a public, credentialed
    // route into a machine the user just told the app to forget.
    if (n && n.relayUrl) {
        try { cloudModels.clearKey(nodeEndpointId(n) + "::door"); } catch { /* best effort */ }
        try { cloudModels.setNodeRelay(nodeEndpointId(n), null, null); } catch { /* not linked */ }
        // tear it down on the node too, when the node is still reachable
        sshBatch(n.user || null, n.host,
            "sudo systemctl disable --now lcl-door 2>/dev/null; " +
            "tailscale funnel --https=443 off 2>/dev/null; " +
            "rm -f ~/.config/lcl-door/token ~/.config/lcl-door/public.json", 9000)
            .then(r => auditLog.write({ kind: "node-door-revoked", host: n.host,
                                        onNode: !!(r && r.ok), at: Date.now() }))
            .catch(() => { /* the local half is already revoked */ });
    }
    return { ok: true };
}));

/**
 * Install and bind a model server on the node, in a visible terminal.
 *
 * The script is NVIDIA's Ollama playbook plus the one change that makes the
 * node reachable from other machines: OLLAMA_HOST=0.0.0.0. sudo will prompt
 * in the terminal — the user's password goes to their own sshd, never here.
 */
ipcMain.handle("lcl:nodeSetup", guard((_e, id) => {
    const n = readNodes().find(x => x.id === id);
    if (!n) return { error: "no such node" };
    // ALREADY SET UP MEANS NOTHING TO DO — AND NO PASSWORD TO TYPE.
    //
    // "you still use sudo in the commands you send to the spark. that shows me
    //  that you have not prepared my device fully"
    //
    // Fair. Everything below is the INSTALL, not the routine, and it ran once
    // months ago. Re-running it against a machine that is already serving on
    // 0.0.0.0 asks for a root password in order to change nothing. So the
    // script checks first and exits clean when the work is done — which on a
    // prepared machine is every time. The privileged half only ever runs on a
    // machine that genuinely has not been set up.
    const script =
        "set -e; " +
        "SERVING=$(curl -s -m 3 -o /dev/null -w '%{http_code}' " +
            "http://127.0.0.1:11434/api/tags 2>/dev/null || echo 000); " +
        "BOUND=$(systemctl show ollama -p Environment 2>/dev/null | " +
            "grep -c 'OLLAMA_HOST=0.0.0.0' || true); " +
        "if [ \"$SERVING\" = \"200\" ] && [ \"$BOUND\" != \"0\" ]; then " +
        "  echo 'Already set up: ollama is serving and bound to 0.0.0.0:11434.'; " +
        "  echo 'Nothing to change, and no password needed.'; " +
        "  echo; echo '=== .lcl node setup complete — this window can be closed ==='; " +
        "  exit 0; " +
        "fi; " +
        "echo 'This machine is not set up yet — the next steps need its root password.'; " +
        "command -v ollama >/dev/null || (curl -fsSL https://ollama.com/install.sh | sh); " +
        "sudo mkdir -p /etc/systemd/system/ollama.service.d; " +
        "printf '[Service]\\nEnvironment=OLLAMA_HOST=0.0.0.0:11434\\n' | " +
        "sudo tee /etc/systemd/system/ollama.service.d/lcl.conf >/dev/null; " +
        "sudo systemctl daemon-reload; sudo systemctl enable --now ollama; " +
        "sudo systemctl restart ollama; sleep 2; " +
        "echo; echo '=== .lcl node setup complete — this window can be closed ==='; " +
        "echo 'Serving on port 11434. Back in .lcl, click Refresh then Link models.'";
    try {
        // same batch-file launch as the door: Sync's key path contains a
        // space ("NVIDIA Corporation"), and `start` re-parses arguments, so
        // passing ssh's argv through it shredded the -i and -F paths
        const creds = sshCreds(n.user || null, n.host);
        const p = spawn("cmd.exe", ["/c", "start", "",
            writeTerminalScript(".lcl node setup", creds, script, n.host)],
            { detached: true, stdio: "ignore", windowsHide: false });
        p.unref();
        auditLog.write({ kind: "node-setup-launched", host: n.host, at: Date.now() });
        return { ok: true, note: "a terminal opened — sudo will ask for the node's password there" };
    } catch (e) {
        return { error: String(e.message || e) };
    }
}));

/**
 * THE REMOTE DOOR — VPN coexistence, solved instead of recommended.
 *
 * A full-tunnel VPN (the VPN et al.) firewalls every packet that does not
 * ride its tunnel, which kills Tailscale's direct paths and made the node
 * "unreachable" any time the VPN was up. Measured on the machine that hit it:
 * tailscaled's own traffic is blocked, but ordinary outbound HTTPS sails
 * through. So the node gets a DOOR: a token-authenticated HTTPS endpoint
 * published through Tailscale Funnel, whose TLS terminates ON THE NODE (the
 * relay carries ciphertext). The laptop walks in as ordinary web traffic —
 * the one thing a VPN never blocks.
 *
 * Setup needs sudo once, in the same visible terminal the Ollama setup used:
 * the user's password goes to their own sshd, never here. After that the app
 * adopts the door on its own (see adoptNodeDoor) and fails over to it
 * automatically. Nothing to configure, nothing to remember.
 */
const DOOR_PORT = 8347;

/**
 * Stage and run the door provisioning on a node.
 *
 * Two callers, one implementation: the visible-terminal flow (sudo may
 * prompt, the user sees it) and the unattended flow used by autoInstallDoor
 * when the node has already proven `sudo -n` works. Everything up to the
 * final invocation is identical — the only difference is whether the last
 * step opens a window or runs over BatchMode ssh.
 */
async function provisionDoor(n, backendPort, { unattended = false } = {}) {
    const backendUrl = `http://127.0.0.1:${backendPort}`;
    /* WHICH SERVER THIS DOOR PROXIES, on the node's own record. One door, one
       fixed backend — so an answer it gives is about THAT backend and not
       about whichever endpoint happened to ask. Unrecorded, a llama.cpp model
       was judged against Ollama's catalogue and refused outright. Stamped here
       because this is the only place the number is known. */
    try {
        const all = readNodes();
        const me = all.find(x => x.id === n.id);
        if (me) { me.doorBackendPort = backendPort;
                  paths.writeSettings({ [NODES_KEY]: all }); }
    } catch { /* the record catches up on the next write */ }

    // stage the door script and a token over BatchMode ssh first — no sudo
    // needed for either, and scp is the only clean way to move the file
    const doorSrc = path.join(process.resourcesPath || path.join(__dirname, ".."),
        "tools", "node-door", "lcl-door.py");
    const devDoor = path.join(__dirname, "..", "tools", "node-door", "lcl-door.py");
    const src = fs.existsSync(doorSrc) ? doorSrc : devDoor;
    if (!fs.existsSync(src)) return { error: "door script missing from this install" };

    const prep = await sshBatch(n.user || null, n.host,
        "mkdir -p ~/.config/lcl-door && chmod 700 ~/.config/lcl-door && " +
        "([ -s ~/.config/lcl-door/token ] || " +
        "(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 40 " +
        "> ~/.config/lcl-door/token)) && chmod 600 ~/.config/lcl-door/token && echo staged",
        20000);
    if (!prep.ok) {
        // verbatim, and the command that produced it, so the failure can be
        // reproduced in a terminal instead of guessed at across releases
        const line = (prep.err || "").split(/\r?\n/).filter(Boolean).pop() || "no answer";
        const creds = sshCreds(n.user || null, n.host);
        return { error: `ssh to ${creds.target} failed: ${line}` };
    }

    const creds = sshCreds(n.user || null, n.host);
    const scpArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${knownHostsFile()}`, ...creds.args];
    scpArgs.push(src, creds.target + ":.config/lcl-door/lcl-door.py");
    const scpOk = await new Promise((resolve) => {
        const c = spawn("scp", scpArgs, { windowsHide: true });
        const t = setTimeout(() => { c.kill(); resolve(false); }, 20000);
        c.on("error", () => { clearTimeout(t); resolve(false); });
        c.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
    });
    if (!scpOk) return { error: "could not copy the door script to the node" };

    /* THE RECIPE TABLE GOES WITH THE DOOR.
     *
     * A full-tunnel VPN must remain usable without breaking the app.
     *
     * A full-tunnel VPN refuses every socket to the tailnet, so ssh to a node
     * is dead while ordinary HTTPS is untouched — which is the whole reason
     * the door exists, and inference already came through it. Installing did
     * not: that went to sshStream and died, and the app told him to switch the
     * VPN off. /lcl/run is the missing half, and it takes a KEY, so the
     * commands have to already be on the node.
     *
     * Same literals as the SSH path, out of the same array. Nothing the app
     * sends at run time is ever executed; the wire carries a name.
     */
    const stacksMod = require("../.lcl.engine/core/nodeStacks");
    // the prime is DATA here too: the door prepends it when a password is
    // given and never composes shell of its own
    const table = { __prime: SUDO_PRIME };
    for (const st of stacksMod.STACKS) {
        if (!stacksMod.installable(st.key)) continue;
        table[st.key] = { name: st.name, verify: st.verify || null,
                          script: stacksMod.script(st.key) };
    }
    // THE SPARK RECIPES ARE PART OF THE TABLE, NOT BOX-SIDE FOLKLORE. They
    // were hand-added on the node once, which meant every re-provision
    // OVERWROTE recipes.json and silently dropped mode switching and
    // training — and the awaited-wrapper bug would then have reported those
    // 404s as success. The scripts they name ship right below, from the
    // repo's canonical copies (tools/node-door/), so a re-provision
    // CONVERGES the box instead of lobotomizing it.
    for (const mk of ["deep", "balanced", "wide", "vast", "swarm", "status"]) {
        table["spark-mode-" + mk] = { script: "~/spark-mode.sh " + mk };
    }
    table["spark-train"] = { script: "~/training/train-lcl.sh" };
    const recTmp = path.join(app.getPath("temp"), `lcl-recipes-${Date.now()}.json`);
    fs.writeFileSync(recTmp, JSON.stringify(table), { mode: 0o600 });
    const recArgs = [...scpArgs.slice(0, -2), recTmp,
                     creds.target + ":.config/lcl-door/recipes.json"];
    const recOk = await new Promise((resolve) => {
        const c = spawn("scp", recArgs, { windowsHide: true });
        const t = setTimeout(() => { c.kill(); resolve(false); }, 20000);
        c.on("error", () => { clearTimeout(t); resolve(false); });
        c.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
    });
    try { fs.unlinkSync(recTmp); } catch { /* temp */ }
    // NOT FATAL. A door that serves inference is worth having even if the
    // recipe table did not land; installs simply keep using ssh until it does.
    if (!recOk) log("door: recipe table did not copy — installs will need the tailnet");

    // THE SCRIPTS THE SPARK RECIPES NAME, converged from the repo's canonical
    // copies. This is the .lcl-native delivery path: the operator's VPN makes
    // SSH unreachable from every working session, so box-side script fixes
    // ride THIS provisioning (and the repair below) whenever the APP has
    // reach — never a "turn the VPN off" ask, never a waiting watcher.
    {
        const shDir = path.dirname(src);
        const ships = [
            [path.join(shDir, "spark-mode.sh"), "spark-mode.sh"],
            [path.join(shDir, "train-lcl.sh"), "training/train-lcl.sh"]
        ].filter(([p]) => fs.existsSync(p));
        for (const [local, remote] of ships) {
            const shArgs = [...scpArgs.slice(0, -2), local, creds.target + ":" + remote];
            if (remote.includes("/")) {
                await sshBatch(n.user || null, n.host,
                    "mkdir -p ~/" + remote.split("/").slice(0, -1).join("/"), 10000)
                    .catch(() => null);
            }
            const ok = await new Promise((resolve) => {
                const c = spawn("scp", shArgs, { windowsHide: true });
                const t = setTimeout(() => { c.kill(); resolve(false); }, 20000);
                c.on("error", () => { clearTimeout(t); resolve(false); });
                c.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
            });
            if (!ok) { log("door: " + remote + " did not copy"); continue; }
        }
        if (ships.length) {
            await sshBatch(n.user || null, n.host,
                "sed -i 's/\\r$//' ~/spark-mode.sh ~/training/train-lcl.sh 2>/dev/null; " +
                "chmod +x ~/spark-mode.sh ~/training/train-lcl.sh 2>/dev/null; echo converged",
                15000).catch(() => null);
        }
    }

    // THE SUDO HALF, AS A FILE — never as an argument.
    //
    // The first version passed a multi-line heredoc through
    // `cmd.exe /c start ... ssh <host> <script>`. cmd truncates at the first
    // newline and eats the quoting, so the install could not possibly work:
    // it would have written an empty systemd unit and reported success.
    // The script is uploaded and then RUN BY NAME, so cmd only ever sees one
    // short token-free word.
    // THE REMOTE INSTALLER — NO ROOT ANYWHERE.
    //
    // The first version wrote a system systemd unit with sudo, which meant a
    // password prompt, which meant a visible terminal, which meant the user
    // had to be present. A user-level unit under ~/.config/systemd/user needs
    // no root and still survives reboot; setsid covers the case where user
    // systemd is unavailable. Funnel is permitted for the ordinary user once
    // the operator is set, which `tailscale funnel status` answering without
    // sudo confirms.
    const setupSh =
        "#!/bin/sh\n" +
        "set -e\n" +
        "D=\"$HOME/.config/lcl-door\"\n" +
        "mkdir -p \"$D\"; chmod 700 \"$D\"\n" +
        "[ -s \"$D/token\" ] || (head -c 24 /dev/urandom | base64 | " +
            "tr -dc 'a-zA-Z0-9' | head -c 40 > \"$D/token\")\n" +
        "chmod 600 \"$D/token\"\n" +
        "pkill -f '[l]cl-door.py' 2>/dev/null || true\n" +
        "sleep 1\n" +
        "mkdir -p \"$HOME/.config/systemd/user\"\n" +
        "cat > \"$HOME/.config/systemd/user/lcl-door.service\" <<UNIT\n" +
        "[Unit]\n" +
        "Description=.lcl node door\n" +
        "After=network-online.target\n" +
        "\n" +
        "[Service]\n" +
        "Environment=LCL_DOOR_PORT=" + DOOR_PORT + "\n" +
        "Environment=LCL_DOOR_BACKEND=" + backendUrl + "\n" +
        "Environment=LCL_DOOR_TOKEN_FILE=$HOME/.config/lcl-door/token\n" +
        "ExecStart=/usr/bin/python3 $HOME/.config/lcl-door/lcl-door.py\n" +
        "Restart=always\n" +
        "RestartSec=3\n" +
        "\n" +
        "[Install]\n" +
        "WantedBy=default.target\n" +
        "UNIT\n" +
        "systemctl --user daemon-reload 2>/dev/null || true\n" +
        "systemctl --user enable lcl-door 2>/dev/null || true\n" +
        "systemctl --user restart lcl-door 2>/dev/null || true\n" +
        // survive a logout: without this the unit dies when the ssh session ends
        "loginctl enable-linger \"$USER\" 2>/dev/null || true\n" +
        "sleep 2\n" +
        "if ! pgrep -f '[l]cl-door.py' >/dev/null 2>&1; then\n" +
        "  LCL_DOOR_PORT=" + DOOR_PORT + " LCL_DOOR_BACKEND=" + backendUrl + " \\\n" +
        "  LCL_DOOR_TOKEN_FILE=\"$D/token\" setsid nohup /usr/bin/python3 " +
            "\"$D/lcl-door.py\" > \"$D/door.log\" 2>&1 &\n" +
        "  sleep 2\n" +
        "fi\n" +
        "pgrep -f '[l]cl-door.py' >/dev/null || { echo LCL-DOOR-NOT-RUNNING; exit 1; }\n" +
        // THE TOKEN NEVER APPEARS IN A COMMAND LINE. `curl -H "... $TOK"` puts
        // it in argv, where any local user on that machine can read it out of
        // /proc for the life of the process. curl's -K config file is read from
        // disk instead, created 0600 and deleted straight after.
        // cat receives only the PATH; the token itself never becomes an
        // argument to anything, so it cannot be read from /proc by another
        // local user. Assembled by redirection into a 0600 file.
        "umask 077\n" +
        "{ printf 'header = \"Authorization: Bearer '; cat \"$D/token\"; " +
            "printf '\"\\n'; } > \"$D/.curlrc\"\n" +
        "curl -s -m 5 -K \"$D/.curlrc\" " +
            "http://127.0.0.1:" + DOOR_PORT + "/lcl/ping | grep -q '\"ok\": true' " +
            "&& SELFTEST=ok || SELFTEST=fail\n" +
        "rm -f \"$D/.curlrc\"\n" +
        "[ \"$SELFTEST\" = ok ] || { echo LCL-DOOR-SELFTEST-FAILED; exit 1; }\n" +
        // Funnel. When the tailnet has never enabled it, tailscale prints an
        // owner-authenticated URL — captured and handed back so the app can
        // offer ONE click instead of a terminal instruction.
        "FUN=$(timeout 20 tailscale funnel --bg " + DOOR_PORT + " 2>&1 || true)\n" +
        "echo \"$FUN\" | grep -o 'https://login.tailscale.com/f/funnel[^ ]*' | " +
            "head -1 | sed 's/^/LCL-FUNNEL-ENABLE=/'\n" +
        // THE THIRD REASON PUBLISHING FAILS, AND THE ONE THAT ACTUALLY BIT.
        //
        // Tailscale refuses `funnel` to a non-root user until the tailnet
        // owner has run `tailscale set --operator` once:
        //   "Access denied: serve config denied ... To not require root, use
        //    'sudo tailscale set --operator=$USER' once."
        // Measured on the test machine at 22:47 with Funnel already
        // approved account-wide and the door running. Every unattended
        // attempt, every watchdog retry and every wizard run died here in
        // silence, because nothing could type a sudo password. Named, so the
        // app can open a terminal and let the operator type it once.
        "echo \"$FUN\" | grep -qi 'serve config denied\\|sudo tailscale set --operator' " +
            "&& echo LCL-NEEDS-OPERATOR\n" +
        // public.json is written ONLY when the funnel is actually serving.
        // Writing it optimistically made a door that the internet could not
        // reach look adoptable, and made readiness call the job done while
        // the one step that mattered had never happened.
        "if tailscale funnel status 2>/dev/null | grep -q https; then\n" +
        "  NAME=$(tailscale status --json | python3 -c " +
            "\"import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))\")\n" +
        "  printf '{\"url\":\"https://%s\",\"host\":\"%s\"}' \"$NAME\" \"$NAME\" " +
            "> \"$D/public.json\"\n" +
        "  echo LCL-FUNNEL-LIVE\n" +
        "else\n" +
        "  rm -f \"$D/public.json\"\n" +
        "fi\n" +
        // THE ROUTE IS REPORTED EVEN WHEN IT IS NOT LIVE YET.
        //
        // Adopting the route used to require SSH — to read the token and the
        // node's own tailnet name. That put the escape hatch behind the very
        // door it exists to open: a VPN kill switch blocks SSH, so the app
        // could never learn the address precisely when it needed it. They are
        // reported HERE instead, in the one session that is guaranteed to be
        // on the machine's own network, and stored. After that, activating
        // the route is a plain HTTPS request that works from anywhere.
        "echo LCL-DOOR-NAME=$(tailscale status --json | python3 -c " +
            "\"import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))\")\n" +
        "echo LCL-DOOR-TOKEN=$(cat \"$D/token\")\n" +
        "echo LCL-DOOR-OK\n";

    const shTmp = path.join(app.getPath("temp"), `lcl-door-setup-${Date.now()}.sh`);
    try { fs.writeFileSync(shTmp, setupSh, { encoding: "utf8" }); }
    catch (e) { return { error: "could not stage the setup script: " + e.message }; }
    const shOk = await new Promise((resolve) => {
        const a = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6",
            "-o", "StrictHostKeyChecking=yes",
            "-o", `UserKnownHostsFile=${knownHostsFile()}`, ...creds.args];
        a.push(shTmp, creds.target + ":.config/lcl-door/setup.sh");
        const c = spawn("scp", a, { windowsHide: true });
        const t = setTimeout(() => { c.kill(); resolve(false); }, 20000);
        c.on("error", () => { clearTimeout(t); resolve(false); });
        c.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
    });
    try { fs.unlinkSync(shTmp); } catch { /* temp */ }
    if (!shOk) return { error: "could not copy the setup script to the node" };

    // UNATTENDED: no window, no prompt. Only reached after `sudo -n true`
    // succeeded, so nothing can block waiting for a password nobody can see.
    if (unattended) {
        const run = await sshBatch(n.user || null, n.host,
            "sh ~/.config/lcl-door/setup.sh", 120_000);
        const out = String(run.out || "");
        // Tailscale requires the tailnet OWNER to turn Funnel on once, at a
        // login-authenticated page. That is the one step no automation can do,
        // so it is carried back as a URL the UI can offer as a single click
        // rather than a terminal instruction.
        const gate = (/LCL-FUNNEL-ENABLE=(\S+)/.exec(out) || [])[1] || null;
        if (gate) {
            const nodes = readNodes();
            const rec = nodes.find(x => x.id === n.id);
            // the same gate re-observed is not news — stored and logged when
            // it CHANGES (the log carried 61 identical needs-funnel lines in
            // one day, each presented as new work)
            if (rec && rec.funnelEnableUrl !== gate) {
                rec.funnelEnableUrl = gate; paths.writeSettings({ [NODES_KEY]: nodes });
                auditLog.write({ kind: "node-door-needs-funnel", host: n.host, at: Date.now() });
            }
        }
        if (!/LCL-DOOR-OK/.test(out)) {
            return { error: (run.err || out || "setup failed").slice(0, 300) };
        }

        // REMEMBER THE ROUTE NOW, WHILE WE ARE STILL ON ITS NETWORK.
        //
        // The name comes from the node's own tailscale daemon in this SSH
        // session — the same binding adoptNodeDoor verifies — so storing it
        // here is exactly as trustworthy and no longer needs the machine to
        // be reachable later. Stored even when the funnel is not live yet:
        // that is the case where the operator approves on Tailscale's site,
        // leaves the house, and must not be stranded.
        const selfName = (/LCL-DOOR-NAME=(\S+)/.exec(out) || [])[1] || "";
        const tok = (/LCL-DOOR-TOKEN=(\S+)/.exec(out) || [])[1] || "";
        if (selfName && tok) {
            const nodes = readNodes();
            const rec = nodes.find(x => x.id === n.id);
            // AN IDENTICAL ROUTE IS NOT STORED AGAIN. The same URL and token
            // were re-stored — and re-logged as though they were new work —
            // 41 times in half an hour. Re-provisioning can
            // legitimately mint a new token or name; only THAT is a store.
            let sameTok = false;
            try { sameTok = doorTokenOf(n) === tok; }
            catch { sameTok = false; }
            const already = !!rec && sameTok
                && rec.relayPending === `https://${selfName.toLowerCase()}`;
            if (!already) {
                // WARM THE PUBLIC ADDRESS WHILE THE NETWORK IS GOOD. Learning
                // it here means the door can be dialled later from a network
                // where the system resolver would only ever answer with the
                // tailnet address — which is every network the door exists for.
                try { await publicDns.publicAddress(selfName.toLowerCase()); }
                catch { /* activation resolves it again anyway */ }
                if (rec) {
                    rec.relayPending = `https://${selfName.toLowerCase()}`;
                    paths.writeSettings({ [NODES_KEY]: nodes });
                }
                try { cloudModels.putKey(nodeEndpointId(n) + "::door", tok); }
                catch { /* activation reports the failure */ }
                auditLog.write({ kind: "node-door-route-stored", host: n.host,
                                 url: `https://${selfName.toLowerCase()}`, at: Date.now() });
            }
        }

        // published: activate the route NOW, so "ready anywhere" is a verified
        // fact by the time the wizard paints its answer
        if (/LCL-FUNNEL-LIVE/.test(out)) {
            const live = await activatePendingRelay(n.id).catch(() => false);
            return { ok: true, published: true, adopted: !!live,
                     note: live ? "remote access is up — reachable from any network"
                                : "published, but the address did not answer yet" };
        }
        // NEEDS THE MACHINE'S PASSWORD, ONCE. Reported as a state the UI can
        // act on, not as an instruction for the operator to carry out.
        if (/LCL-NEEDS-OPERATOR/.test(out)) {
            return { ok: true, published: false, needsPassword: true,
                     note: "one step on that machine needs its password, once" };
        }
        return { ok: true, published: false, funnelEnableUrl: gate,
                 note: gate ? "one approval left on your Tailscale account"
                            : "door installed, but publishing did not complete" };
    }

    try {
        // THE VISIBLE TERMINAL, LAUNCHED THROUGH A BATCH FILE.
        //
        // `cmd /c start "title" ssh -F <path> -i <path> ...` RE-PARSES every
        // argument, and NVIDIA Sync's key and config both live under
        // "...\NVIDIA Corporation\..." — a path with a space. start split
        // them, ssh got fragments, and the window closed instantly: clicking
        // Install door appeared to do nothing at all. Reported exactly that
        // way. The command now lives inside a .cmd file, quoted once, and
        // cmd only ever sees one filename.
        const bat = writeTerminalScript(".lcl remote door setup", creds,
            "sh ~/.config/lcl-door/setup.sh", n.host);
        const p = spawn("cmd.exe", ["/c", "start", "", bat],
            { detached: true, stdio: "ignore", windowsHide: false });
        p.unref();
        auditLog.write({ kind: "node-door-setup-launched", host: n.host, at: Date.now() });
        // adopt as soon as the terminal work lands — poll for a few minutes
        let tries = 0;
        const poll = () => setTimeout(async () => {
            const got = await adoptNodeDoor(n.id);
            if (!got && ++tries < 20) poll();
        }, 15000);
        poll();
        return { ok: true, note: "a terminal opened — sudo asks for the node's password " +
                 "there. The door is adopted automatically once it is up." };
    } catch (e) {
        return { error: String(e.message || e) };
    }
}

/**
 * Open a URL in the user's browser — ALLOWLISTED, not general purpose.
 *
 * The only external URL this product ever needs to open is Tailscale's own
 * Funnel-enable page, which is owner-authenticated and cannot be automated.
 * A general "open anything" bridge in an offline-first app is a hole; this
 * one accepts that single host and refuses everything else.
 */
ipcMain.handle("lcl:openExternal", guard(async (_e, url) => {
    let u;
    try { u = new URL(String(url || "")); } catch { return { error: "not a url" }; }
    if (u.protocol !== "https:" || u.hostname !== "login.tailscale.com") {
        return { error: "only the Tailscale Funnel page may be opened from here" };
    }
    await shell.openExternal(u.toString());
    auditLog.write({ kind: "opened-funnel-gate", host: u.hostname, at: Date.now() });
    // visiting the approval page is the very event an armed run waits on —
    // let it retry promptly instead of riding out its backoff
    armReset();
    return { ok: true };
}));

/**
 * ARM "finish remote access", and do it now if the machine happens to answer.
 *
 * The operator cannot always press this during a window when the machine is
 * reachable — theirs is blocked by a VPN they cannot work without. So the
 * press records the instruction, and the watchdog carries it out the moment a
 * window appears. Returns which of the two happened, so the row can say so.
 */
ipcMain.handle("lcl:nodeArmFinish", guard(async (_e, id) => {
    const n = readNodes().find(x => x.id === id);
    if (!n) return { error: "no such node" };
    if (n.relayUrl) return { ok: true, already: true };

    // A STORED ROUTE THAT ANSWERS ENDS THIS RIGHT HERE: one HTTPS request,
    // no ssh, no re-provisioning of a machine that is already provisioned.
    if (n.relayPending && await activatePendingRelay(id).catch(() => false)) {
        return { ok: true, published: true,
                 note: "remote access is up — reachable from any network" };
    }

    const nodes = readNodes();
    const rec = nodes.find(x => x.id === id);
    rec.finishArmed = Date.now();
    paths.writeSettings({ [NODES_KEY]: nodes });
    auditLog.write({ kind: "node-door-armed", host: n.host, at: Date.now() });

    // reachable right now? then there is nothing to wait for
    if (hostIsPinned(n.host) && await tcpOpen(n.host, 22, 3000)) {
        const port = (n.serving && n.serving[0] && n.serving[0].port) || 11434;
        const r = await provisionDoor(n, port, { unattended: true });
        if (r && r.ok && r.published) {
            const after = readNodes();
            const rec2 = after.find(x => x.id === id);
            if (rec2) { delete rec2.finishArmed; paths.writeSettings({ [NODES_KEY]: after }); }
            return { ok: true, published: true, note: r.note };
        }
        return { ...(r || {}), armed: true };
    }
    return { ok: true, armed: true,
             note: "Saved. .lcl will finish this by itself the moment that " +
                   "machine is reachable — you do not have to be watching." };
}));

/**
 * THE ONE STEP THAT NEEDS A PASSWORD — DRIVEN BY THE APP, NOT BY THE OPERATOR.
 *
 * The standing rule is that everything is driven from local: no loose commands
 * handed to the user to run themselves.
 *
 * That is already the rule: the product does the work.
 * Tailscale will not let a non-root user publish a funnel until the owner has
 * run `tailscale set --operator` once, and sudo on that machine wants a
 * password. No automation can type it — so the app opens a terminal, states
 * whose password is being asked for, runs BOTH commands, and the password
 * goes over SSH to the user's own machine without .lcl ever seeing it.
 * That is the precedent already accepted for the model-server install.
 *
 * After this runs once, publishing needs no root ever again and the button
 * alone is enough.
 */
ipcMain.handle("lcl:nodeFunnelGrant", guard(async (_e, id, port) => {
    const n = readNodes().find(x => x.id === id);
    if (!n) return { error: "no such node" };
    if (!hostIsPinned(n.host)) {
        return { error: "that machine's identity has not been confirmed yet" };
    }
    const p = Number(port) > 0 ? Number(port) : DOOR_PORT;
    const creds = sshCreds(n.user || null, n.host);
    const remote =
        "sudo tailscale set --operator=$USER && " +
        `tailscale funnel --bg ${p} && ` +
        "tailscale funnel status";
    try {
        const bat = writeTerminalScript(
            ".lcl — allow remote access on this machine", creds, remote, n.host);
        const proc = spawn("cmd.exe", ["/c", "start", "", bat],
            { detached: true, stdio: "ignore", windowsHide: false });
        proc.unref();
        auditLog.write({ kind: "node-funnel-grant-launched", host: n.host,
                         port: p, at: Date.now() });
        return { ok: true, note: "A terminal opened. Type that machine's password " +
                 "there — it goes straight to the machine and is never seen here. " +
                 "When it finishes, come back and press Check again." };
    } catch (e) {
        return { error: String(e.message || e) };
    }
}));

ipcMain.handle("lcl:nodeDoorSetup", guard(async (_e, id, port) => {
    const n = readNodes().find(x => x.id === id);
    if (!n) return { error: "no such node" };
    // the door fronts WHATEVER this node serves — Ollama on 11434 is the
    // common case, but a llama.cpp/vLLM/TRT node is served on its own port
    // and a door hardwired to 11434 would proxy chat into a closed socket
    //
    // UNATTENDED, because the wizard only reaches this step after key auth
    // is proven and the setup needs no sudo — and because the one thing the
    // operator may still have to do (Tailscale's owner approval) comes back
    // as a URL the wizard shows IN the UI, instead of scrolling past in a
    // terminal window. That terminal is exactly where the approval got lost
    // on the test machine.
    return provisionDoor(n, Number(port) > 0 ? Number(port) : 11434,
                         { unattended: true });
}));

/**
 * Adopt a node's door: read its public URL and token over SSH, prove the door
 * answers from THIS machine, then store the route (token OS-encrypted) and
 * teach the linked endpoint about it. Runs opportunistically — every nodes
 * refresh where SSH works and no door is known yet. Zero interaction.
 */
/**
 * ACTIVATE A REMEMBERED ROUTE — WITHOUT SSH.
 *
 * This is the path that makes remote access actually mean "from anywhere".
 * provisionDoor stored the node's own tailnet address and its token while it
 * was on the machine's network, where that binding is verifiable; all that is
 * left is to find out whether the address answers yet. That is one HTTPS
 * request, and it works from any network — including one where a VPN kill
 * switch blocks every route to the tailnet.
 *
 * A real scenario: a user approved Funnel on Tailscale's site,
 * then changed locations, and the app was stuck saying the machine had refused it —
 * because learning the address needed SSH, and SSH was the thing being
 * blocked. The escape hatch was behind the locked door.
 */
async function activatePendingRelay(nodeId) {
    const n = readNodes().find(x => x.id === nodeId);
    if (!n || n.relayUrl || !n.relayPending) return false;
    if (!networkAllowed()) return false;          // the route is on the internet

    let url;
    try {
        const u = new URL(n.relayPending);
        if (u.protocol !== "https:") return false;
        url = u.origin;
    } catch { return false; }

    let tok = null;
    // getKey is NOT exported — getDoorToken is the only decrypted-token export,
    // and it appends "::door" itself. Calling the unexported one threw on every
    // single attempt, the throw was swallowed, and activation returned false
    // silently: the route sat in relayPending forever while the door was live
    // and answering. Measured in one session: zero activation events, a
    // stored token, network on, and a door returning 401 from the internet.
    try { tok = doorTokenOf(n); } catch { /* below */ }
    if (!tok) return false;

    const alive = await new Promise((resolve) => {
        const rq = require("https").get(url + "/lcl/ping",
            { headers: { Authorization: `Bearer ${tok}` }, timeout: 8000,
              lookup: publicDns.lookup }, (res) => {
                let b = "";
                res.on("data", c => { if (b.length < 4096) b += c; });
                res.on("end", () => {
                    try { resolve(res.statusCode === 200 && JSON.parse(b).ok === true); }
                    catch { resolve(false); }
                });
            });
        rq.on("timeout", () => { rq.destroy(); resolve(false); });
        rq.on("error", () => resolve(false));
    });
    if (!alive) return false;

    const nodes = readNodes();
    const rec = nodes.find(x => x.id === nodeId);
    if (!rec) return false;
    rec.relayUrl = url;
    // WHICH SERVER THIS DOOR ACTUALLY PROXIES. One door, one fixed backend —
    // so an answer it gives is about that backend and not about whichever
    // endpoint happened to ask. Without this recorded, a llama.cpp model was
    // judged against Ollama's catalogue and refused. See nodePreflight.
    // what just went onto the machine, so the row can stop offering an update
    rec.doorVersion = DOOR_WANTED;
    delete rec.relayPending;
    // the approval link was the unfinished-business marker; the job is done
    delete rec.funnelEnableUrl;
    // an armed Finish is satisfied by the route going live — clear it here
    // too, or the watchdog keeps acting on an instruction already carried out
    delete rec.finishArmed;
    paths.writeSettings({ [NODES_KEY]: nodes });
    // the door serves the whole machine, so every engine on it gets the road
    try {
        const ids = nodeEndpointsOf(n).map(e => e.id);
        if (!ids.length) ids.push(nodeEndpointId(n));
        for (const id of ids) cloudModels.setNodeRelay(id, url, tok);
    }
    catch { /* endpoint not linked yet — nodeLink teaches it */ }
    auditLog.write({ kind: "node-door-activated", host: n.host, url, at: Date.now() });
    try {
        const w = BrowserWindow.getAllWindows()[0];
        // the renderer greets this by NAME — sending only the host printed
        // "undefined is now reachable from any network" on the reporting
        // machine. Both are sent, and the name falls back to the host.
        if (w) w.webContents.send("lcl:nodeDoorReady",
            { name: n.name || n.host, host: n.host, url });
    } catch { /* no window */ }
    return true;
}

async function adoptNodeDoor(nodeId) {
    const n = readNodes().find(x => x.id === nodeId);
    if (!n || n.relayUrl) return false;
    if (!networkAllowed()) return false;         // adoption talks to the internet
    // The node's OWN tailnet identity is read here, in the same SSH session,
    // rather than trusted from the file — see the binding check below.
    const r = await sshBatch(n.user || null, n.host,
        "cat ~/.config/lcl-door/public.json 2>/dev/null; echo ---; " +
        "cat ~/.config/lcl-door/token 2>/dev/null; echo ---; " +
        "tailscale status --json 2>/dev/null | python3 -c " +
        "\"import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))\" " +
        "2>/dev/null || true", 9000);
    if (!r.ok) return false;
    const [pub, tok, dnsName] = r.out.split("---").map(s2 => s2.trim());
    let url = null, urlHost = null;
    try {
        const u = new URL(JSON.parse(pub).url);
        url = u.origin; urlHost = u.hostname.toLowerCase();
    } catch { return false; }
    if (!tok || !/^https:/.test(url)) return false;

    // THE URL MUST BE THE NODE'S OWN NAME.
    //
    // public.json is an ordinary file on the node. Anything able to write it
    // — a second account, a compromised user-level service, a machine the
    // user does not solely control — could name ANY https host, and the app
    // would then stream whole conversations (including every repo file the
    // agent has read) to it, and parse its replies as model output driving
    // tool calls. A liveness ping proves nothing: any host can answer 200.
    // So the address must match the tailnet DNS name the node reports for
    // itself, which an attacker editing one file cannot forge.
    const selfName = String(dnsName || "").toLowerCase();
    if (!selfName || !(urlHost === selfName || urlHost.endsWith("." + selfName))) {
        auditLog.write({ kind: "node-door-rejected", host: n.host,
                         url, expected: selfName || "(node reported no tailnet name)",
                         why: "relay host is not the node's own tailnet name", at: Date.now() });
        return false;
    }

    const alive = await new Promise((resolve) => {
        const rq = require("https").get(url + "/lcl/ping",
            { headers: { Authorization: `Bearer ${tok}` }, timeout: 8000,
              lookup: publicDns.lookup }, (res) => {
                let b = "";
                res.on("data", c => { b += c; });
                res.on("end", () => {
                    try { resolve(res.statusCode === 200 && JSON.parse(b).ok === true); }
                    catch { resolve(false); }
                });
            });
        rq.on("timeout", () => { rq.destroy(); resolve(false); });
        rq.on("error", () => resolve(false));
    });
    if (!alive) return false;

    const nodes = readNodes();
    const rec = nodes.find(x => x.id === nodeId);
    rec.relayUrl = url;
    // adoption is a SUCCESS path exactly like activation: the pending-route
    // and approval markers are superseded, and an armed Finish is satisfied —
    // found in review as the fourth success path, the only one not clearing it
    delete rec.relayPending;
    delete rec.funnelEnableUrl;
    delete rec.finishArmed;
    paths.writeSettings({ [NODES_KEY]: nodes });
    // token: OS-encrypted next to the API keys, under the door's own id
    try { cloudModels.putKey(nodeEndpointId(n) + "::door", tok); } catch { /* below */ }
    // what just went onto the machine — the row stops offering an update
    try {
        const all2 = readNodes();
        const r2 = all2.find(x => x.id === n.id);
        if (r2) { r2.doorVersion = DOOR_WANTED; paths.writeSettings({ [NODES_KEY]: all2 }); }
    } catch { /* the door still works; the badge is bookkeeping */ }
    try {
        const ids2 = nodeEndpointsOf(n).map(e => e.id);
        if (!ids2.length) ids2.push(nodeEndpointId(n));
        for (const id of ids2) cloudModels.setNodeRelay(id, url, tok);
    } catch { /* endpoint not linked yet */ }
    auditLog.write({ kind: "node-door-adopted", host: n.host, url, at: Date.now() });
    // Tell the window. The watchdog adopts silently after a reboot or a
    // network change, and the operator asked for that to happen without them —
    // but should still be told it did. (This event used to be sent by the
    // unattended installer, which has been removed; adoption is the honest
    // place for it, and the preload contract check caught the dangling
    // listener the moment that code went.)
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("lcl:nodeDoorReady", { name: n.name || n.host });
    }
    return true;
}

/**
 * Is the app allowed to talk to the internet right now?
 *
 * A Funnel URL is a PUBLIC host, not the LAN — reaching it is egress, and
 * egress is exactly what the network switch governs. Without this the node
 * poll would beacon to a public endpoint carrying a bearer credential every
 * few seconds with networking switched off, which is the one thing this
 * product promises never to do.
 */
function networkAllowed() {
    try { return paths.readSettings().networkEnabled === true; } catch { return false; }
}

/**
 * The endpoint id cloudModels.connect() will have derived for this node.
 *
 * connect() passes `node-<host>` to linkEndpoint, which sanitises and
 * LOWERCASES it. Building the same string here by concatenation alone meant
 * any host with a capital letter — or an IPv6 address, whose colons are
 * rewritten — filed the door token under an id no lookup would ever ask
 * for, and chat failover silently never engaged. One derivation, mirrored
 * from the one place that owns it.
 */
/** The one recipe that serves this port, when only one can. */
let _portNames = null;
function enginesOnPort(port) {
    if (!port) return null;
    if (!_portNames) {
        _portNames = {};
        try {
            const st = require("../.lcl.engine/core/nodeStacks");
            for (const x of st.STACKS) {
                const p = x.endpoint && x.endpoint.port;
                if (!p) continue;
                (_portNames[p] = _portNames[p] || []).push(
                    String(x.name || "").split(" \u2014 ")[0].trim());
            }
        } catch { _portNames = {}; }
    }
    const v = _portNames[String(port)] || _portNames[Number(port)];
    // two engines can serve one port, and only one of them is; naming
    // the wrong one is worse than naming the port
    return (v && v.length === 1) ? v[0] : null;
}

function nodeEndpointId(n) {
    return ("node-" + String((n && n.host) || "")).replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
}


/** The door token for this machine, wherever the store happens to hold it. */
function doorTokenOf(n) {
    const tryIds = [nodeEndpointId(n)];
    try { for (const e of nodeEndpointsOf(n)) tryIds.push(e.id); } catch { }
    for (const id of tryIds) {
        try {
            const t = cloudModels.getDoorToken(id);
            if (t) return t;
        } catch { /* try the next */ }
    }
    return null;
}

/** Every endpoint that belongs to this machine — one per engine on it. */
function nodeEndpointsOf(n) {
    try {
        const host = String((n && n.host) || "");
        const id = nodeEndpointId(n);
        return cloudModels.endpoints().filter(e =>
            (e.node && (e.node.id === (n && n.id) || e.node.host === host))
            // ...and an entry linked before this app knew about ports
            || e.id === id);
    } catch { return []; }
}

/** Has this node's model list been linked into the picker yet? */
function nodeIsLinked(n) {
    // ANY of its engines counts. Matching one derived id meant a machine
    // running two engines was reported as linked to neither.
    return nodeEndpointsOf(n).some(e => (e.models || []).length > 0);
}

/** How many models this node is registered as offering, right now. */
function nodeLinkedCount(n) {
    try {
        const id = nodeEndpointId(n);
        const ep = cloudModels.endpoints().find(e => e.id === id);
        return ((ep && ep.models) || []).length;
    } catch { return 0; }
}

/**
 * KEEP A NODE'S MODELS LINKED, AND CURRENT, WITHOUT BEING ASKED.
 *
 * Linking used to be a button. Reported, correctly: "if the only reason we are
 * adding the spark is to run models, why is there a link models button. that
 * should be as soon as the device is connected." There is no decision in it —
 * a machine that serves models has models, and the picker should say so.
 *
 * Staleness is the other half of that report. The node's own /v1/models count
 * comes back on every probe for free, so a mismatch against what is registered
 * means something was pulled or deleted on the machine and the picker is now
 * lying. That re-reads; an equal count does nothing at all, so the common case
 * costs one integer comparison per refresh.
 */
const lastSync = new Map();          // node id -> ms, a floor on re-reads
/**
 * THE REAL CONTEXT WINDOW, ON EVERY REFRESH — NOT ONLY ON A RE-LINK.
 *
 * The reported symptom: the context window does not show the actual context it
 * should, showing 32k instead, so context is not remembered.
 *
 * Read out of a real session store, hours after llama.cpp was measured over
 * ssh at "n_ctx": 262144:
 *
 *     node-...-30000  unsloth/Qwen3.6-35B-A3B  ctx=32768 (ASSUMED)
 *
 * That stale number is not cosmetic. router.limits() reads contextLength and
 * from it derives the HISTORY WINDOW, the OUTPUT budget and maxSteps — so one
 * wrong figure produced three separate symptoms it was reported as unrelated:
 *
 *   - the donut showing 32k
 *   - history trimmed to 32k, hence "I don't have context for what the
 *     previous response was supposed to cover" mid-conversation
 *   - an output budget sized for 32k, which a reasoning model spends entirely
 *     inside its chain of thought — "spent its whole reply thinking", three
 *     times in that one session
 *
 * measureNodeWindows existed but ran only inside connect(), i.e. on a link. A
 * fix that needs a ritual to take effect is a fix the operator does not have.
 * This runs it on the ordinary nodes refresh, against every endpoint the node
 * owns, so the number heals itself. Best-effort and silent: a probe that fails
 * leaves the assumption in place, still marked as an assumption.
 */
async function healNodeWindows(n) {
    try {
        for (const ep of nodeEndpointsOf(n)) {
            try { await cloudModels.measureNodeWindows(ep.id); }
            catch { /* this endpoint would not say; the next may */ }
        }
    } catch { /* no endpoints yet — nodeLink will bring them */ }
}

async function syncNodeModels(n, serving) {
    const port = serving && serving[0] && serving[0].port;
    if (!port) return false;
    // egress is the user's switch, and cloudModels.connect enforces it anyway
    if (!networkAllowed()) return false;

    const offered = Number(serving[0].models || 0);
    const linked = nodeLinkedCount(n);
    if (linked && (!offered || offered === linked)) return false;

    // a node that answers but cannot be read should not be re-probed every
    // few seconds forever
    const last = lastSync.get(n.id) || 0;
    if (Date.now() - last < 30_000) return false;
    lastSync.set(n.id, Date.now());

    try {
        await cloudModels.connect(`${n.host}:${port}`, {
            // memBytes travels with the node or the load guard sizes it against
            // a constant — see rememberNodeMem. null, never a guess: an absent
            // number makes nodePreflight fail OPEN, and a wrong one lets a
            // model through that takes the machine down.
            node: { id: n.id, name: n.name || n.host, host: n.host, port,
                    memBytes: n.memBytes || null,
                    // WHICH SERVER THE DOOR PROXIES. Trimmed out of this record,
                    // the load guard cannot tell a door answer about Ollama from
                    // one about llama.cpp — which is how a model that was loaded
                    // and serving got refused for "unknown size".
                    doorBackendPort: n.doorBackendPort || null }
        });
        auditLog.write({ kind: linked ? "node-models-refreshed" : "node-models-linked",
                         host: n.host, port, was: linked, now: offered, at: Date.now() });
        return true;
    } catch { return false; }
}
/* autoInstallDoor was removed. It created remote access unattended, which
 * publishes the node's inference API to the internet with no user action —
 * confirmed as a finding. Creating remote access now lives only in the wizard,
 * where the operator is present. The watchdog and the nodes refresh ADOPT an
 * existing relay and never create one.
 */


/** GET a door route and parse JSON — the transport for every relay fallback. */
function doorFetch(n, route, timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (!n || !n.relayUrl) return resolve(null);
        if (!networkAllowed()) return resolve(null);
        let token = null;
        try { token = doorTokenOf(n); } catch { /* below */ }
        if (!token) return resolve(null);
        const rq = require("https").get(n.relayUrl + route,
            { headers: { Authorization: `Bearer ${token}` }, timeout: timeoutMs,
              // resolved publicly: MagicDNS would answer this name with the
              // node's tailnet address and send the door back into the tunnel
              lookup: publicDns.lookup }, (res) => {
                let b = "";
                res.on("data", c => { if (b.length < 1_000_000) b += c; });
                res.on("end", () => {
                    if (res.statusCode !== 200) return resolve(null);
                    try { resolve(JSON.parse(b)); } catch { resolve(null); }
                });
            });
        rq.on("timeout", () => { rq.destroy(); resolve(null); });
        rq.on("error", () => resolve(null));
    });
}

/**
 * THE NODE'S OWN GAUGE — the number the user asked for by name.
 *
 * "just like we have ram monitoring on our local machine, when one of these
 *  bad boys is connected, we would need its monitor as well ... a real
 *  intuitive indication, not the dgx dashboard."
 *
 * On GB10 unified memory, nvidia-smi cannot report usage (NVIDIA staff,
 * forum-confirmed) — /proc/meminfo is the truth. One SSH round trip returns
 * MemTotal/MemAvailable plus what Ollama holds resident, and the renderer
 * draws it with the same gauge the local RAM uses. Same thresholds, same
 * colours, same honesty.
 */
ipcMain.handle("lcl:nodeStats", guard(async (_e, id) => {
    const n = readNodes().find(x => x.id === id);
    if (!n) return { error: "no such node" };

    // THE ORDER AND THE ARITHMETIC LIVE IN nodeMemory.js, WHERE THEY CAN BE
    // RUN. They were inline here through two rounds of "i see no ram
    // utilization for the spark in the sidebar" precisely because nothing in
    // tests/ could reach them — the only way to exercise this was to install
    // the app and look. Everything below is now plumbing: the real readers go
    // in, the decision comes back already tested against the live machine.
    const res = await nodeMemory.readNodeMemory(
        { ...n, memBytes: Number(n.memBytes) || nodeMemBytes(n.id) || 0 },
        {
            ssh: (cmd) => sshBatch(n.user || null, n.host, cmd, 9000),
            door: (route) => doorFetch(n, route).then(d => (d && d.ok) ? d : null),
            ollamaPs: (host, port) => ollamaPs(host, port, 2500)
        });

    if (res.ok) {
        // the load guard's only source of this machine's size — see
        // rememberNodeMem. A serving-port reading is a FLOOR, not a measured
        // total, so it must not become the number the crash guard trusts.
        if (!res.floor) rememberNodeMem(n.id, res.physTotalBytes);
        return { ...res, host: n.host, name: n.name };
    }

    // Nothing answered. SSH failing tells us nothing about WHY; probe the
    // serving port to find out whether a local filter is refusing the socket.
    const probe = await probeNodePort(n.host, 11434, 2500);
    return { error: "unreachable",
             vpn: await blockDiagnosis(BLOCKED_CODES.has(probe.err), !!probe.up) };
}));

/**
 * THE NODE'S DASHBOARD — everything a resource monitor shows, one round trip.
 *
 * "like the gnome resource manager, or dgx dashboard. something robust that
 *  can show true insight into the spark."
 *
 * One SSH batch reads the kernel's own counters: /proc/stat for CPU,
 * /proc/meminfo for memory, nvidia-smi for GPU utilisation/temperature/power
 * (those it CAN report on GB10 — memory it cannot, /proc/meminfo covers that
 * because the memory is unified), df for disk, /proc/net/dev for network.
 * CPU and network are CUMULATIVE counters, returned as-is with a timestamp;
 * the renderer keeps the previous sample and differences them, because a rate
 * is two readings and only the caller knows when it last asked.
 */
/* ======================= THE MODEL LIBRARY ==============================
 * Search an index, see what a model costs in disk and memory, and pull it
 * onto the node — so the user can add a capability without waiting for
 * anyone, staying self-sufficient and less reliant on hosted AI in general.
 *
 * INSTALLS DO NOT RIDE THE PUBLIC DOOR. That door is on the internet behind
 * one static token and its allowlist refuses /api/pull, /api/create and
 * /api/delete for exactly the reasons written in it: arbitrary downloads,
 * model exfiltration, destruction. Installing is that class of operation, so
 * it goes over the operator-owned SSH path instead. Two doors, two threat
 * models, and the dangerous verbs stay on the one only the operator can open.
 * ====================================================================== */
ipcMain.handle("lcl:modelSearch", guard(async (_e, spec) => {
    const cat = require("../.lcl.engine/core/modelCatalog");
    try {
        const rows = await cat.search(String((spec && spec.query) || ""), {
            kind: (spec && spec.kind) || null,
            limit: (spec && spec.limit) || 25
        });
        return { ok: true, models: rows };
    } catch (e) { return { error: String(e.message || e) }; }
}));

/* ---- node stacks: the software that RUNS the weights ---- */
ipcMain.handle("lcl:stacks", guard(() => {
    const s = require("../.lcl.engine/core/nodeStacks");
    // the recipes without the commands — the preview is asked for separately,
    // so a list render never carries a shell script into the renderer
    return { ok: true, stacks: s.STACKS.map(x => ({
        key: x.key, name: x.name, why: x.why, playbook: x.playbook,
        serves: x.serves || null, needs: x.needs || null,
        after: x.after || null, rollback: x.rollback || null,
        checksOnly: !!x.checksOnly,
        // the panel needs both to warn about a port two recipes share,
        // and to say how long NVIDIA reckons it takes
        endpoint: x.endpoint || null, takes: x.takes || null,
        // WHICH SEAT, AND WHICH PORTS IT LEAVES LISTENING. The row used to
        // mark "INSTALLED" from endpoint.port alone, so ComfyUI on 8188 and
        // txt2kg on 3001 — which have no OpenAI endpoint — never showed as
        // installed no matter how long they had been running. That is the
        // "doesnt resolve the list for that device" report.
        role: s.roleOf(x.key).role, holds: !!s.roleOf(x.key).holds,
        ports: s.roleOf(x.key).ports || [],
        capability: s.roleOf(x.key).capability || null,
        manual: x.manual || null, installable: s.installable(x.key)
    })) };
}));

/**
 * What the install on this node is doing right now.
 *
 * Cheap and side-effect free: it reads a record this process already holds.
 * Safe to call every second, and answers after the run has finished too, so a
 * panel reopened later still shows how it went.
 */
ipcMain.handle("lcl:stackProgress", guard((_e, nodeId) => {
    const run = installRuns.get(String(nodeId || ""));
    if (!run) return { ok: true, running: false, run: null };
    return { ok: true, running: !run.done, run: {
        stack: run.stack, name: run.name,
        step: run.step, stepNo: run.stepNo, totalSteps: run.totalSteps,
        elapsedMs: Date.now() - run.startedAt,
        road: run.road,
        // the whole list, every tick: the panel draws all of them with the
        // live one marked, so it needs their states and not just the current
        steps: (run.steps || []).map(st => ({
            say: st.say, state: st.state, pct: st.pct, note: st.note,
            line: st.line,
            ms: st.startedAt ? (st.endedAt || Date.now()) - st.startedAt : null
        })),
        lines: run.lines.slice(-8),
        done: run.done, ok: run.ok, error: run.error, wired: run.wired
    } };
}));

/**
 * WHAT IS ALREADY RUNNING ON THAT MACHINE, ASKED OF THE MACHINE.
 *
 * Two needs: knowing what is already installed before adding more (a node near
 * full usage with vLLM running risks a crash), and resolving the running list
 * for a device even when a playbook is installed.
 *
 * One `ss -ltn`. An open port is a server that is running, which is the only
 * form of "installed" that matters to either question — and unlike a record of
 * .lcl's own installs it also sees what the user put there by hand, and
 * stops seeing it the moment it is stopped.
 *
 * Read-only and side-effect free, so it is safe to call whenever the panel
 * opens. A node that cannot be reached returns `reached: false` rather than an
 * empty list: "nothing is running there" and "I could not ask" are opposite
 * answers and collapsing them is how a wizard cheerfully installs a fourth
 * engine onto a full box.
 */
ipcMain.handle("lcl:nodePresent", guard(async (_e, id) => {
    const stacks = require("../.lcl.engine/core/nodeStacks");
    const n = readNodes().find(x => x.id === String(id || ""));
    if (!n) return { error: "no such node" };
    // ss on anything modern, netstat on anything that still has not got it
    const probe = await sshBatch(n.user || null, n.host,
        "(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}'", 12000);
    if (!probe.ok) {
        return { ok: true, reached: false, why: "the node did not answer",
                 present: [], ports: [] };
    }
    // "0.0.0.0:8000", "[::]:8000", "*:11434" — the port is what follows the LAST
    // colon, which is the one rule that survives all three shapes
    const ports = [...new Set(String(probe.out || "").split(/\r?\n/)
        .map(l => { const m = /:(\d+)\s*$/.exec(l.trim()); return m ? Number(m[1]) : 0; })
        .filter(p => p > 0))];
    return { ok: true, reached: true, ports,
             present: stacks.presentFrom(ports) };
}));

ipcMain.handle("lcl:stackPreview", guard((_e, key) => {
    const s = require("../.lcl.engine/core/nodeStacks");
    if (!s.installable(key)) return { error: "that one is not installed by .lcl" };
    return { ok: true, steps: s.preview(key) };
}));

ipcMain.handle("lcl:stackInstall", guard(async (_e, spec) => {
    const stacks = require("../.lcl.engine/core/nodeStacks");
    const nodeId = String((spec && spec.nodeId) || "");
    const key = String((spec && spec.key) || "");
    /* Entering a password to log in from .lcl should just work — there is no
     * reason it cannot: sudo
     * reads one from stdin with -S and this transport has a stdin. It primes
     * sudo's credential cache for this run only: never stored, never logged,
     * never in argv where `ps` could read it. tests/node-stacks.js proves it. */
    const sudoPw = (spec && typeof spec.password === "string" && spec.password)
        ? spec.password : null;
    // the ONLY thing the caller chooses is which recipe, by key — the commands
    // are literals in nodeStacks.js and nothing from the UI reaches them
    if (!stacks.installable(key)) return { error: "that one is not installed by .lcl" };
    const rec = stacks.get(key);
    const n = readNodes().find(x => x.id === nodeId);
    if (!n) return { error: "no such node" };
    if (!hostIsPinned(n.host)) {
        return { error: "confirm this node's host key before installing anything on it" };
    }
    if (installs.has(nodeId)) return { error: "this node is already installing something" };

    // WHAT THE PANEL DRAWS. One entry per step, so the wizard can show all of
    // them at once with the live one marked — "each step being seen as it goes".
    const run = {
        stack: key, name: rec.name, startedAt: Date.now(),
        step: "connecting to the node…", stepNo: 0,
        totalSteps: (rec.steps || []).length,
        steps: (rec.steps || []).map(s => ({
            say: s.say, state: "waiting", startedAt: null, endedAt: null,
            pct: null, note: null, line: null
        })),
        road: "tailnet",
        lines: [], done: false, ok: false, error: null, wired: null
    };
    installRuns.set(nodeId, run);

    // the step currently running, or null before the first LCL-STEP arrives
    const cur = () => run.steps.find(s => s.state === "running") || null;

    const send = (payload) => {
        // RECORDED FIRST, PUSHED SECOND. The push is a nicety; the record is
        // what the operator actually reads.
        if (payload && payload.phase === "line") {
            const line = String(payload.line || "");
            const st = /^LCL-STEP\s+(.+)$/.exec(line.trim());
            if (st) {
                const done = cur();
                if (done) { done.state = "done"; done.endedAt = Date.now(); done.pct = null; }
                run.stepNo++;
                run.step = st[1];
                // matched by NAME, not by position: a recipe that short-circuits
                // a step never prints it, and counting would then attribute
                // every later line to the wrong row
                const next = run.steps.find(s => s.say === st[1] && s.state === "waiting")
                    || run.steps[run.stepNo - 1];
                if (next) { next.state = "running"; next.startedAt = Date.now(); }
            } else {
                run.lines.push(line);
                if (run.lines.length > 200) run.lines.shift();
                const c = cur();
                if (c) {
                    c.line = line.slice(0, 200);
                    // the layer count FIRST: a docker line like
                    // "a1b2: Downloading 12MB/456MB" also matches the byte-pair
                    // rule below, and one layer's bytes is not the pull's progress
                    const p = dockerProgress(c, line) || progressOf(line);
                    if (p) { c.pct = p.pct; c.note = p.note; }
                }
            }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("lcl:modelInstallProgress", { nodeId, ...payload });
        }
    };
    // WHETHER a password was used is worth recording. WHAT it was, never.
    auditLog.write({ kind: "stack-install-start", node: nodeId, stack: key,
                     withPassword: !!sudoPw, at: Date.now() });
    send({ phase: "starting", repo: rec.name });

    const script = sudoPw ? SUDO_PRIME + stacks.script(key) : stacks.script(key);

    let job = sshStream(n.user || null, n.host, script, {
        stdin: sudoPw,
        onLine: (line) => send({ phase: "line", line: line.slice(0, 400) }),
        // A CUDA BUILD IS LEGITIMATELY QUIET. Five minutes killed a real
        // llamacpp run at 480 s. Every recipe reports in every ~30 s now, so
        // this is a backstop for a hung connection, not a budget for how long
        // work is allowed to take.
        idleMs: 20 * 60_000
    });
    installs.set(nodeId, job);
    let res;
    try { res = await job.done; }
    finally { installs.delete(nodeId); }

    /* THE VPN DOES NOT GET TO STOP THE WORK.
     *
     * A full-tunnel VPN must remain usable without breaking the app.
     *
     * A kill switch refuses the tailnet and leaves ordinary HTTPS alone, so
     * ssh dies in about forty milliseconds while the node's Funnel door keeps
     * answering. Telling the user to turn the VPN off was the app's answer twice,
     * and its own source already said that was the wrong one. The road is
     * changed instead: same recipe, same key, in through the front door.
     *
     * Only on `blocked`. A node that is genuinely off, or refusing the login,
     * must not be retried down another road that will fail the same way and
     * cost another timeout to find out.
     */
    let road = "tailnet";
    if (sshFailure(res.tail) === "blocked" && n.relayUrl) {
        send({ phase: "line", line: "LCL-STEP the private network is blocked — going in through remote access" });
        run.step = "the private network is blocked — going in through remote access";
        road = "door"; run.road = "door";
        job = doorRun(n, key, {
            password: sudoPw,
            onLine: (line) => send({ phase: "line", line: line.slice(0, 400) })
        });
        installs.set(nodeId, job);
        try { res = await job.done; }
        finally { installs.delete(nodeId); }
    }

    let proved = !!(rec.verify && (res.tail || []).some(l => l.includes(rec.verify)));
    run.done = true;
    run.ok = !!res.ok && proved;
    for (const st of run.steps) {
        if (st.state === "running") {
            st.state = run.ok ? "done" : "failed";
            st.endedAt = Date.now();
            st.pct = null;
        } else if (st.state === "waiting" && !run.ok) {
            st.state = "skipped";
        } else if (st.state === "waiting") {
            // a recipe short-circuits steps it does not need; that is not
            // a failure and must not be drawn as one
            st.state = "notneeded";
        }
    }
    run.step = res.cancelled ? "stopped"
        : run.ok ? "finished — and it proved itself working"
                 : "did not finish";
    if (Array.isArray(res.tail) && res.tail.length) {
        run.lines = res.tail.slice(-12);
    }
    const liveStep = (run.steps || []).find(x => x.state === "running");
    const liveStepName = liveStep ? liveStep.say : null;
    // which step was live, and the node's last words: an install that fails
    // must be diagnosable from this file alone
    auditLog.write({ kind: "stack-install-end", node: nodeId, stack: key,
                     ok: !!res.ok, proved, cancelled: !!res.cancelled,
                     timedOut: !!res.timedOut, step: liveStepName,
                     tail: (res.tail || []).slice(-4), at: Date.now() });
    send({ phase: "done", ok: !!res.ok && proved, cancelled: !!res.cancelled,
           tail: (res.tail || []).slice(-6) });
    if (res.cancelled) return { error: "stopped" };
    /* IT WENT QUIET, WHICH IS NOT THE SAME AS STOPPING. A run killed for
     * silence reported the word the Stop button uses, so an eight-minute
     * llamacpp run read as something the user had done. */
    if (res.timedOut) {
        /* ...BUT LOOK BEFORE SAYING SO.
         *
         * "what about what already ran from .lcl on the spark before this
         *  patch you just made"
         *
         * It had finished. Every recipe that leaves a server behind installs it
         * as a systemd service precisely so the ssh connection dying does not
         * touch it — so the run .lcl gave up on carried on, downloaded 20 GB,
         * loaded a 35B model and was serving on 30000 while the app called it a
         * failure and skipped the wiring. Giving up watching is not evidence of
         * anything, so ask the node before reporting. */
        if (rec.endpoint && rec.endpoint.port) {
            const probe = await sshBatch(n.user || null, n.host,
                "curl -sf -m 3 http://127.0.0.1:" + rec.endpoint.port +
                (rec.endpoint.path || "") + "/models >/dev/null && echo LCL-LATE-OK", 12000);
            if (probe.ok && String(probe.out || "").includes("LCL-LATE-OK")) {
                run.step = "finished on its own after .lcl stopped watching";
                proved = true;
                res.ok = true;
                res.timedOut = false;
            }
        }
    }
    if (res.timedOut) {
        const at = (run.steps || []).find(x => x.state === "running");
        const says = "Nothing came back from " + n.host + " for " +
            Math.round((res.idleMs || 0) / 60000) + " minutes" +
            (at ? " while it was " + at.say : "") +
            ", so .lcl stopped waiting. The node may still be working, and " +
            "nothing was undone.";
        run.step = "no answer from the node — .lcl stopped waiting";
        run.lines = [says, ...(res.tail || []).slice(-6)];
        return { error: says, timedOut: true };
    }
    /* IT NEVER GOT THERE. Said first, because everything below this line
     * describes a node that answered — and reporting a blocked socket in those
     * words is what sent two days into sudo. */
    const why = sshFailure(res.tail);
    if (why) {
        const vpn = why === "blocked" ? await blockDiagnosis(true, false) : null;
        const says = sshFailureSays(why, n.host, vpn);
        run.step = why === "blocked" ? "could not reach the node" : "did not finish";
        run.lines = [says];
        return { error: says, unreached: true, reason: why };
    }
    // SAY WHICH THING WAS WRONG. A wrong password, a login with no sudo rights
    // at all, and a broken recipe all used to end as "did not finish", and each
    // is fixed by a different action.
    const sudoSaid = (m) => (res.tail || []).some(l => l.includes(m));
    if (sudoSaid("LCL-NEEDS-PASSWORD")) {
        const says = "This one has to install a package on " + n.host +
            ", which needs sudo, and no password was given. Type your password " +
            "for that node in the box on the Run panel and run it again.";
        run.step = "it needs your password to install a package";
        run.lines = [says, ...(res.tail || []).slice(-6)];
        return { error: says, badPassword: true };
    }
    if (sudoSaid("LCL-APT-FAILED")) {
        const says = "apt could not install what this recipe needs on " + n.host +
            ". The last lines from the node are below.";
        run.step = "the package install failed on the node";
        return { error: says };
    }
    if (sudoSaid("LCL-NOT-A-SUDOER")) {
        const says = `${n.user || "this login"} on ${n.host} is not allowed to ` +
            "run sudo at all, so no password will get past it. Nothing was " +
            "installed. Give the account sudo rights on the node, or install " +
            "this one by hand.";
        run.step = "this login cannot install software on the node";
        run.lines = [says, ...(res.tail || []).slice(-6)];
        return { error: says };
    }
    if (sudoSaid("LCL-SUDO-NEEDS-TTY")) {
        const says = `sudo on ${n.host} is configured to require a terminal ` +
            "(requiretty), which no unattended connection can give it. Nothing " +
            "was installed. Removing that line from its sudoers file, or giving " +
            "this login passwordless sudo, both fix it.";
        run.step = "the node's sudo demands a terminal";
        run.lines = [says, ...(res.tail || []).slice(-6)];
        return { error: says };
    }
    if (sudoSaid("LCL-BAD-PASSWORD")) {
        run.step = "that password was not accepted on the node";
        run.lines = ["The node refused it. This is the password for " +
                     (n.user || "your login") + " on " + n.host +
                     ", the one you would type at a terminal there."];
        return { error: "that password was not accepted on the node", badPassword: true };
    }
    if (!res.ok) {
        return { error: (res.tail || []).slice(-3).join(" · ").slice(0, 300)
                        || res.err || "the install failed on the node" };
    }
    // IT RAN IS NOT IT WORKS. Every installable recipe names a line it must
    // see before this reports success — the same rule the rest of the app
    // follows about proven versus written.
    if (!proved) {
        return { error: "the steps ran but it did not prove itself working — " +
                        (res.tail || []).slice(-2).join(" · ").slice(0, 200) };
    }

    /* ...AND INSTALLED IS NOT REACHABLE.
     *
     * "you can not just install a bunch of shit and it expect to work. that is
     *  why we need .lcl."
     *
     * A recipe that leaves a SERVER running carries an `endpoint` descriptor.
     * Standing one up and then making the operator go to Connections, work out
     * the port, and paste an address is two jobs where there was one — and it
     * is the join that decides whether any of this is a product or a pile of
     * installed software. The endpoint is registered against the node it just
     * ran on, so the model picker has it before the log has finished scrolling.
     *
     * connect() owns id derivation and model discovery; this only supplies the
     * address. A failure here is reported, never fatal: the install DID work,
     * and saying otherwise because the wiring stumbled would be the same lie
     * in the other direction. */
    let wired = null;
    if (rec.endpoint && rec.endpoint.port) {
        try {
            const scheme = rec.endpoint.https ? "https" : "http";
            const host = String(n.host || "");
            // an IPv6 literal needs its brackets back before it is a URL
            const hostPart = host.includes(":") ? `[${host}]` : host;
            const base = `${scheme}://${hostPart}:${rec.endpoint.port}` +
                         (rec.endpoint.path || "");
            // the recipe's own name, up to the dash — "llama.cpp server",
            // "Ollama" — so the picker can tell one engine on this machine
            // from another instead of showing one flat list under the node
            const engine = String(rec.name || "").split(" — ")[0].trim()
                || ("port " + rec.endpoint.port);
            /* AND WHAT KIND OF ENGINE IT IS, which is the difference between
               "the model you talk to" and "the engine your agents run on".
               Without this the picker had one bin for both, and vLLM — twenty
               concurrent streams, no bigger a window than anything else —
               arrived as one more thing to chat with beside llama.cpp. */
            const kind = require("../.lcl.engine/core/nodeStacks").roleOf(key);
            const link = await cloudModels.connect(base, {
                node: n, label: engine, role: kind.role, stack: key });
            if (link && !link.error) {
                wired = { baseUrl: base, models: (link.models || []).length };
                auditLog.write({ kind: "stack-endpoint-linked", node: nodeId,
                                 stack: key, baseUrl: base,
                                 models: wired.models, at: Date.now() });
            } else {
                wired = { baseUrl: base, error: (link && link.error) || "could not link" };
            }
        } catch (e) {
            wired = { error: String((e && e.message) || e).slice(0, 160) };
        }
    }

    return { ok: true, after: rec.after || null, wired,
             tail: (res.tail || []).slice(-4) };
}));

ipcMain.handle("lcl:modelFiles", guard(async (_e, id) => {
    const cat = require("../.lcl.engine/core/modelCatalog");
    try { return { ok: true, ...(await cat.files(String(id || ""))) }; }
    catch (e) { return { error: String(e.message || e) }; }
}));

// one install at a time, per node — two 40 GB pulls at once help nobody
const installs = new Map();          // nodeId -> { cancel, id }

/* WHAT A RUNNING INSTALL HAS SAID SO FAR.
 *
 * The progress channel pushes to the renderer, and four separate attempts to
 * receive it there measured zero lines arriving while the node demonstrably
 * sent them. Rather than keep guessing at that, the run keeps its own record
 * here and the renderer ASKS. A poll cannot be missed by a listener that was
 * never registered, cannot be lost to a closure from an earlier panel, and
 * survives the operator closing the page and coming back — which the push
 * channel never did.
 *
 * nodeId -> { stack, name, startedAt, step, stepNo, totalSteps, lines[],
 *             done, ok, error }
 */
const installRuns = new Map();

ipcMain.handle("lcl:modelInstallCancel", guard((_e, nodeId) => {
    const job = installs.get(String(nodeId || ""));
    if (!job) return { ok: true, already: true };
    job.cancel();
    return { ok: true };
}));

ipcMain.handle("lcl:modelInstall", guard(async (_e, spec) => {
    const cat = require("../.lcl.engine/core/modelCatalog");
    const nodeId = String((spec && spec.nodeId) || "");
    const repo = String((spec && spec.repo) || "");
    const file = String((spec && spec.file) || "");
    const kind = String((spec && spec.kind) || "image");

    // THE VALIDATION IS THE SECURITY. These strings are bound for a shell on
    // the operator's machine; they are refused here if they are not exactly
    // what a Hugging Face id and path can be, rather than escaped later.
    if (!cat.validRepoId(repo)) return { error: "that is not a valid model id" };
    if (file && !cat.validRepoFile(file)) return { error: "that is not a valid file path" };
    if (!["image", "video", "audio", "text"].includes(kind)) return { error: "unknown model kind" };

    const n = readNodes().find(x => x.id === nodeId);
    if (!n) return { error: "no such node" };
    if (!hostIsPinned(n.host)) {
        return { error: "confirm this node's host key before installing anything on it" };
    }
    if (installs.has(nodeId)) return { error: "this node is already installing something" };

    // WHERE IT GOES. Into the layouts the box already uses — ComfyUI's own
    // models tree, or the Hugging Face cache vLLM and friends read — rather
    // than a third directory invented by this app that nothing else knows.
    const DEST = {
        image: "$HOME/ComfyUI/models/checkpoints",
        video: "$HOME/ComfyUI/models/diffusion_models",
        audio: "$HOME/lcl-models/audio",
        text:  "$HOME/lcl-models/text"
    };
    const dest = DEST[kind];

    // The command is a LITERAL with validated ids substituted — the same
    // shape every other ssh call in this file uses. No renderer string
    // reaches it unvalidated, and the pieces that do are constrained to
    // [A-Za-z0-9._-] and a single slash by the checks above.
    const url = file
        ? `https://huggingface.co/${repo}/resolve/main/${file}?download=true`
        : "";
    const name = file ? file.split("/").pop() : "";
    const cmd = file
        ? `set -e; mkdir -p "${dest}"; cd "${dest}"; ` +
          `echo "LCL-DEST ${dest}"; ` +
          `curl -fL --retry 3 --retry-delay 2 -C - --progress-bar ` +
          `-o "${name}.part" "${url}" && mv -f "${name}.part" "${name}"; ` +
          `echo "LCL-DONE $(ls -l "${name}" | awk '{print $5}') ${dest}/${name}"`
        // no single file named: let the box's own tooling take the whole repo
        : `set -e; mkdir -p "${dest}"; ` +
          `(command -v hf >/dev/null 2>&1 || python3 -m pip install --quiet huggingface_hub[cli]); ` +
          `hf download "${repo}" --local-dir "${dest}/${repo.split("/")[1]}" ; ` +
          `echo "LCL-DONE repo ${dest}/${repo.split("/")[1]}"`;

    const send = (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("lcl:modelInstallProgress", { nodeId, ...payload });
        }
    };
    auditLog.write({ kind: "model-install-start", node: nodeId, repo, file, at: Date.now() });
    send({ phase: "starting", repo, file });

    const job = sshStream(n.user || null, n.host, cmd, {
        onLine: (line) => send({ phase: "line", line: line.slice(0, 400) }),
        idleMs: 180_000
    });
    installs.set(nodeId, job);
    let res;
    try { res = await job.done; }
    finally { installs.delete(nodeId); }

    auditLog.write({ kind: "model-install-end", node: nodeId, repo,
                     ok: !!res.ok, cancelled: !!res.cancelled, at: Date.now() });
    send({ phase: "done", ok: !!res.ok, cancelled: !!res.cancelled,
           tail: (res.tail || []).slice(-6) });
    if (res.cancelled) return { error: "stopped" };
    if (res.timedOut) {
        return { error: "Nothing came back from " + n.host + " for " +
            Math.round((res.idleMs || 0) / 60000) + " minutes, so .lcl stopped " +
            "waiting. The download may still be running on the node." };
    }
    if (!res.ok) {
        return { error: (res.tail || []).slice(-3).join(" · ").slice(0, 300)
                        || res.err || "the install failed on the node" };
    }
    return { ok: true, tail: (res.tail || []).slice(-4) };
}));

ipcMain.handle("lcl:nodeDash", guard(async (_e, id) => {
    const n = readNodes().find(x => x.id === id);
    if (!n) return { error: "no such node" };
    const cmd =
        "echo @CPU@; head -1 /proc/stat; " +
        "echo @MEM@; grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree' /proc/meminfo; " +
        "echo @LOAD@; cat /proc/loadavg; " +
        "echo @UP@; cat /proc/uptime; " +
        "echo @GPU@; nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw " +
            "--format=csv,noheader,nounits 2>/dev/null || true; " +
        "echo @DISK@; df -B1 --output=size,used / 2>/dev/null | tail -1; " +
        "echo @NET@; cat /proc/net/dev; " +
        "echo @CORES@; nproc; " +
        "echo @PS@; curl -s -m 2 http://127.0.0.1:11434/api/ps 2>/dev/null || true";
    const r = await sshBatch(n.user || null, n.host, cmd, 9000);
    if (!r.ok) {
        // the door's /lcl/stats returns this handler's exact shape, computed
        // by the same kernel counters — read on the node instead of over SSH
        const d = await doorFetch(n, "/lcl/stats");
        if (d && d.ok && d.cpu) {
            rememberNodeMem(n.id, d.mem && d.mem.totalBytes);
            return { ...d, name: n.name, host: n.host, via: "door" };
        }
        // SSH failing tells us nothing about WHY; probe the serving port to
        // find out whether a local filter is refusing the socket
        const probe = await probeNodePort(n.host, 11434, 2500);
        return { error: r.err || "unreachable",
                 vpn: await blockDiagnosis(BLOCKED_CODES.has(probe.err), !!probe.up) };
    }

    const sec = {};
    let cur = null;
    for (const line of r.out.split(/\r?\n/)) {
        const m = /^@([A-Z]+)@$/.exec(line.trim());
        if (m) { cur = m[1]; sec[cur] = []; continue; }
        if (cur) sec[cur].push(line);
    }
    const S = (k) => (sec[k] || []).join("\n").trim();

    // cpu: user nice system idle iowait irq softirq steal — idle+iowait is idle
    const cp = S("CPU").split(/\s+/).slice(1).map(Number);
    const idleTicks = (cp[3] || 0) + (cp[4] || 0);
    const totalTicks = cp.reduce((a, b) => a + (b || 0), 0);

    const mem = {};
    for (const mm of S("MEM").matchAll(/(\w+):\s+(\d+)/g)) mem[mm[1]] = Number(mm[2]) * 1024;
    // the load guard's only source of this machine's size — see rememberNodeMem
    rememberNodeMem(n.id, mem.MemTotal);

    const load = S("LOAD").split(/\s+/).slice(0, 3).map(Number);
    const uptimeSec = Number(S("UP").split(/\s+/)[0] || 0);

    // each field on its own: GB10's nvidia-smi answers some queries with
    // "[N/A]", and one absent number must not blank the two present ones
    let gpu = null;
    const g = S("GPU").split(",").map(s => parseFloat(s));
    const fin = (x) => Number.isFinite(x) ? x : null;
    if (g.some(Number.isFinite)) {
        gpu = { util: fin(g[0]), tempC: fin(g[1]), powerW: fin(g[2]) };
    }

    const dk = S("DISK").split(/\s+/).map(Number).filter(Number.isFinite);
    const disk = dk.length >= 2 ? { totalBytes: dk[0], usedBytes: dk[1] } : null;

    // every interface except loopback, summed — the machine's traffic, not a NIC's
    let rxBytes = 0, txBytes = 0;
    for (const ln of S("NET").split(/\n/)) {
        const nm = /^\s*([\w.@-]+):\s*(.+)$/.exec(ln);
        if (!nm || nm[1] === "lo") continue;
        const f = nm[2].trim().split(/\s+/).map(Number);
        rxBytes += f[0] || 0; txBytes += f[8] || 0;
    }

    let models = [];
    try {
        models = (JSON.parse(S("PS")).models || []).map(m2 => ({
            name: m2.name, sizeBytes: m2.size || 0, until: m2.expires_at || null
        }));
    } catch { /* server not up — dashboard still works */ }

    return {
        ok: true, at: Date.now(), name: n.name, host: n.host,
        cpu: { idleTicks, totalTicks, cores: Number(S("CORES")) || null },
        mem: {
            totalBytes: mem.MemTotal || 0, availableBytes: mem.MemAvailable || 0,
            swapTotalBytes: mem.SwapTotal || 0, swapFreeBytes: mem.SwapFree || 0
        },
        load, uptimeSec, gpu, disk,
        net: { rxBytes, txBytes },
        models
    };
}));

/**
 * Link whatever the node is serving into the model picker — AS A NODE.
 *
 * The endpoint that comes out of this is not a vendor the user bought tokens
 * from, and the whole app has to know that. connect() is told which node this
 * is, and marks the endpoint accordingly; from there router.limits() sizes the
 * agent loop from the node's window instead of the floor meant for an unknown
 * paid host, and the cost meter reads $0 rather than "no rate set".
 *
 * The address is passed through as the node's own record — the id, the NAME THE
 * USER GAVE THE DEVICE, and the port actually serving — so the picker can say
 * "Spark" rather than an IP address the user never chose.
 */
ipcMain.handle("lcl:nodeLink", guard(async (_e, id, port) => {
    const n = readNodes().find(x => x.id === id);
    if (!n) return { error: "no such node" };
    const p = Number(port) || 11434;
    try {
        const r = await cloudModels.connect(`${n.host}:${p}`, {
            // see the note in syncNodeModels: this is what the load guard sizes
            // the machine by, and null is the honest answer until it is measured
            node: { id: n.id, name: n.name || n.host, host: n.host, port: p,
                    memBytes: n.memBytes || null,
                    // WHICH SERVER THE DOOR PROXIES. Trimmed out of this record,
                    // the load guard cannot tell a door answer about Ollama from
                    // one about llama.cpp — which is how a model that was loaded
                    // and serving got refused for "unknown size".
                    doorBackendPort: n.doorBackendPort || null }
        });
        // a node with a door teaches its endpoint the VPN-proof route NOW,
        // not on the next opportunistic adoption pass
        if (n.relayUrl) {
            try {
                const tok = doorTokenOf(n);
                if (tok) cloudModels.setNodeRelay(nodeEndpointId(n), n.relayUrl, tok);
            } catch { /* endpoint id differs — adoption pass covers it */ }
        }
        auditLog.write({ kind: "node-linked", host: n.host, port: p, at: Date.now() });
        return r;
    } catch (e) {
        return { error: String(e.message || e) };
    }
}));

ipcMain.handle("lcl:setIntroSound", (_e, on) => {
    paths.writeSettings({ introSound: !!on });
    return { introSound: !!on };
});

ipcMain.handle("lcl:setMotionPref", guard((_e, pref) => {
    const v = ["auto", "on", "off"].includes(pref) ? pref : "auto";
    paths.writeSettings({ motionPref: v });
    return { motionPref: v };
}));

// The capability map the user can actually SEE: what is installed, what will
// load on this machine right now, and exactly which tools can act without
// asking. Same computation the README generator uses.
// the tool groups ALONE — the Permissions panel needs nothing else, and the
// full capabilityMap stats every model on disk to answer questions this panel
// never asks (that scan is why the panel took so long to open)
ipcMain.handle("lcl:toolGroups", guard(() => {
    let toolNames = [];
    try { toolNames = Object.keys(agent.effectiveTools({ all: true })).concat("run_script"); }
    catch { /* the classified list below still answers */ }
    return { ok: true, toolGroups: capabilities.tools(toolNames) };
}));

ipcMain.handle("lcl:capabilityMap", guard(() => {
    let toolNames = [];
    try { toolNames = Object.keys(agent.effectiveTools({ all: true })).concat("run_script"); }
    catch { /* fall back to the full classified list */ }
    const mem = machine.memory ? machine.memory() : null;
    const availableBytes = (mem && mem.availableBytes) || os.freemem();
    return capabilities.snapshot({
        availBytes: availableBytes,
        totalBytes: os.totalmem(),
        cores: os.cpus().length,
        toolNames,
        extras: {
            ocr: (() => { try { return require("../.lcl.engine/core/ocrTools").available(); } catch { return false; } })(),
            reranker: (() => { try { return require("../.lcl.engine/core/reranker").available(); } catch { return false; } })(),
            semanticSearch: (() => { try { return embedIndex.available(); } catch { return false; } })(),
            networkEnabled: paths.readSettings().networkEnabled === true,
            libraries: (() => { try { return knowledge.list().length; } catch { return 0; } })()
        }
    });
}));

ipcMain.handle("lcl:appInfo", () => {
    // Report what this install can ACTUALLY do right now — models present on
    // disk, not models the registry wishes for, and tools the policy kernel
    // really knows about. A static blurb goes stale the first time either moves.
    const reg = paths.modelRegistry();
    const dirs = [paths.bundledModelsDir(), paths.modelsDir()];
    const onDisk = (m) => dirs.some(d => {
        try { return fs.existsSync(path.join(d, m.file)); } catch { return false; }
    });
    const present = (reg.models || []).filter(onDisk);
    let toolCount = 0;
    try { toolCount = Object.keys(agent.effectiveTools({ all: true })).length + 1; } // +run_script
    catch { /* count is cosmetic */ }

    return {
        name: ".lcl",
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        dataDir: paths.dataDir(),
        packaged: paths.isPackaged(),
        cpus: os.cpus().length,
        totalMemBytes: os.totalmem(),
        capabilities: {
            toolCount,
            modelsInstalled: present.length,
            modelsKnown: (reg.models || []).length,
            languageModels: present.filter(m => m.kvBytesPerToken).length,
            vision: present.some(m => m.vision),
            imageGen: present.some(m => m.role === "image"),
            embedding: present.some(m => m.role === "embedding"),
            ocr: (() => { try { return require("../.lcl.engine/core/ocrTools").available(); } catch { return false; } })(),
            flagship: (present.find(m => m.id === (reg.roles || {}).flagship) || {}).id || null
        }
    };
});

// -------------------------------------------------------------
// HEALTH / ENGINE
// -------------------------------------------------------------
/**
 * Script approval. The renderer can only reference a proposal by id, so there
 * is no IPC path that accepts script text and runs it.
 */
ipcMain.handle("lcl:approveScript", async (_e, id) => {
    const p = scriptRunner.get(String(id || ""));
    if (!p) return { error: "no such script proposal" };

    // THE SAME LOCKS EVERY OTHER APPROVAL TAKES. Without them a chat turn
    // started during a two-minute script run loads the session file BEFORE the
    // run's result is appended, and its final whole-file save erases that
    // result — the exact "model blind to its own script" regression the append
    // below exists to fix. And a run that registers no cancel token is a run
    // Stop cannot reach.
    if (turnsBySession.has(p.sessionId)) {
        return { error: "this session is replying — wait for the turn to finish, then approve" };
    }
    if (approvalsRunning.has(p.sessionId)) {
        return { error: "another approved action is still running in this session" };
    }
    const scriptCancel = { cancelled: false };
    approvalsRunning.set(p.sessionId, scriptCancel);

    auditLog.write({
        kind: "script-approved",
        proposalId: p.id, sessionId: p.sessionId,
        modelId: p.modelId, engineId: p.engineId,
        mutating: p.mutating, lines: p.lines, purpose: p.purpose,
        runsIn: p.runsIn || "sandbox", workspaceDir: p.workspaceDir || null
    });

    let result;
    try {
    result = await scriptRunner.approve(String(id), {
        cancelToken: scriptCancel,
        onOutput: (chunk) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("lcl:scriptOutput", { id: p.id, chunk });
            }
        }
    });

    auditLog.write({
        kind: "script-finished",
        proposalId: p.id, sessionId: p.sessionId,
        ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs
    });

    // THE MODEL HAS TO SEE WHAT ITS SCRIPT DID. Until now an approved run
    // streamed its output to the CARD and stopped — the result never re-entered
    // the conversation, so the model was blind to its own script and just
    // re-proposed. The model needs to see the results of the scripts it
    // suggests. This appends the outcome as a
    // tool result the next turn reads, exactly like every other tool does.
    try {
        const s = sessions.load(p.sessionId);
        if (s) {
            const where = result.ranIn || (result.isolation === "workspace"
                ? (p.workspaceDir || "the workspace")
                : result.isolation === "none" ? "your folder"
                : result.sandboxId ? "the sandbox" : (result.isolation || "the sandbox"));
            const cap = 6000;
            let out = String(result.output || "").trim();
            const clipped = out.length > cap;
            if (clipped) out = out.slice(0, cap) + "\n…(" + (out.length - cap) + " more chars)";
            const head = result.timedOut
                ? `run_script TIMED OUT after ${Math.round((result.durationMs || 0) / 1000)}s`
                : `run_script finished: exit ${result.exitCode}` +
                  (result.clean ? " (clean)"
                    : result.ok ? " (exit 0 but wrote to stderr — read the output)"
                    : " (FAILED)");
            const body = `${head}. It ran in ${where}.\n` +
                (out ? `Output:\n${out}` : "Output: (none)");
            // stamp the staging card as resolved so a re-render shows it done
            const staged = s.messages.find(m => m.proposal && m.proposal.id === p.id);
            if (staged) staged.proposal = { ...staged.proposal, resolved: result.ok ? "approved" : "failed" };
            s.messages.push({
                role: "tool", name: "run_script", approved: true,
                failed: !result.ok, content: body, ranIn: where
            });
            sessions.save(s);
            result.messages = s.messages;
            // tell the renderer the model can now continue on this result
            result.continue = result.ok;
        }
    } catch (e) {
        auditLog.write({ kind: "script-result-append-failed",
                         sessionId: p.sessionId, error: String(e && e.message) });
    }
    return result;
    } finally {
        // the lock releases on EVERY exit — a leaked lock would wedge the
        // session ("an approved action is still running") forever
        approvalsRunning.delete(p.sessionId);
    }
});

ipcMain.handle("lcl:rejectScript", guard((_e, id) => {
    const p = scriptRunner.get(String(id || ""));
    if (p) {
        auditLog.write({
            kind: "script-rejected",
            proposalId: p.id, sessionId: p.sessionId, purpose: p.purpose
        });
    }
    return scriptRunner.reject(String(id || ""));
}));

// -------------------------------------------------------------
// SECURITY: engagements (offensive-tool authorization) + network toggle
// -------------------------------------------------------------
// An engagement is created ONLY here, from an explicit user action — never by
// a model. Creating one requires the affirmed `authorized` flag; the offensive
// tools deny any target that no live engagement names.
ipcMain.handle("lcl:listEngagements", guard(() => ({ engagements: engagements.list() })));

ipcMain.handle("lcl:createEngagement", guard((_e, spec) => {
    const s = spec && typeof spec === "object" ? spec : {};
    try {
        const eng = engagements.create({
            target: s.target, authorized: s.authorized === true,
            hours: s.hours, note: s.note
        }, (r) => auditLog.write(r));
        return { engagement: eng };
    } catch (err) {
        return { error: String(err.message || err) };
    }
}));

ipcMain.handle("lcl:revokeEngagement", guard((_e, id) => {
    const removed = engagements.revoke(String(id || ""), (r) => auditLog.write(r));
    return { revoked: removed > 0 };
}));

// Networking is OFF by default — the product is local-first. Turning it on is a
// deliberate, audited settings change; it is the only thing that grants
// net.read, which is the only capability http_fetch runs under.
ipcMain.handle("lcl:setNetworkEnabled", guard((_e, on) => {
    const enabled = on === true;
    paths.writeSettings({ networkEnabled: enabled });
    auditLog.write({ kind: enabled ? "network-enabled" : "network-disabled", at: Date.now() });
    return { networkEnabled: enabled };
}));

ipcMain.handle("lcl:securityState", guard(() => ({
    networkEnabled: paths.readSettings().networkEnabled === true,
    engagements: engagements.list()
})));

ipcMain.handle("lcl:setIdleUnload", (_e, minutes) => {
    const m = Math.max(0, Math.min(240, Number(minutes) || 0));
    engine.setIdleUnloadMs(m * 60_000);
    paths.writeSettings({ idleUnloadMinutes: m });
    return { idleUnloadMinutes: m };
});

ipcMain.handle("lcl:unloadModel", guard(() => {
    engine.unloadNow();
    return { unloaded: true };
}));

/**
 * IS THERE ANYTHING THAT CAN ANSWER RIGHT NOW?
 *
 * This used to be engine.health() alone — purely "is llama-server up". That is
 * the wrong question the moment a remote model is in the picture, and it is
 * exactly the shape of the reported stalemate: with a linked API selected and
 * no local model resident (the memory guard stopped it, or this machine never
 * had one that fits), the renderer sat in waitForBackend() forever, the
 * composer said "Model not loaded", and every session was dead — while a
 * perfectly good frontier model was one HTTP call away.
 *
 * A remote selection IS a healthy backend. Reported as ok with kind:"remote"
 * so the UI can say which one is answering rather than implying a local load.
 */
/**
 * IS THERE A BACKEND FOR *THIS SESSION*?
 *
 * This asked the GLOBAL driver role while every other part of the app resolved
 * the model per session. Pick a model hosted on your own machine for one
 * conversation, leave the app default alone, and this reported on the local
 * engine instead — the one that conversation was never going to use. The
 * renderer's readiness loop then waited on a local model that had no reason to
 * load, so the composer never unlocked and the placeholder sat on whatever
 * phase the local engine happened to reach:
 *
 *     "it just stayed saying warming up in the message prompt"
 *     "i can not type a message into the message prompt, even though ... there
 *      is a model currently loaded"
 *
 * Resolution is now the SAME inherit-unless-set path the router uses, so the
 * question "is the thing that will answer me alive" has one answer everywhere.
 */
ipcMain.handle("lcl:checkHealth", async (_e, sessionId) => {
    try {
        const s = sessionId ? sessions.load(String(sessionId)) : null;
        const r = router.resolveSelection(s);
        if (r && r.remote && r.sel) {
            // A MODEL ON ANOTHER MACHINE NEEDS THE NETWORK SWITCH, AND SAYING
            // "ok" WHEN IT IS OFF IS A LIE THE WHOLE APP THEN ACTS ON.
            //
            // streamChat calls requireNetwork() and throws before a packet
            // leaves, so the turn dies at the last possible moment with nothing
            // on screen having warned about it. Reported, after an entire day
            // lost to it: "tried a local model on the spark. nothing. again."
            // The switch was off the whole time and no surface said so.
            if (paths.readSettings().networkEnabled !== true) {
                return {
                    status: "network_off",
                    kind: "remote",
                    model: r.sel.model,
                    endpoint: r.sel.label,
                    note: `${r.sel.label} is on the network, and internet access is off`
                };
            }
            return {
                status: "ok",
                kind: "remote",
                model: r.sel.model,
                endpoint: r.sel.label,
                source: r.source,          // "session" or "default" — say which
                note: `${r.sel.model} on ${r.sel.label}`
            };
        }
    } catch { /* fall through to the local engine */ }
    // AWAITED. engine.health() is async, and this handler was not: spreading a
    // pending Promise copies its own enumerable properties, of which a Promise
    // has none. So this returned literally { kind: "local" } — no `status` —
    // and waitForBackend()'s every exit test reads h.status. The loop could
    // never break, the composer never unlocked, and the placeholder kept
    // showing whatever phase the engine had last reached. Silent, total, and
    // invisible to any check that did not actually call it.
    return { ...(await engine.health()), kind: "local" };
});
ipcMain.handle("lcl:engineStatus", () => ({
    ...engine.status(),
    log: engine.recentLog(),
    endpoint: engine.endpoint(),
    apiKey: engine.apiKey()   // needed to open the engine's own web UI for debugging
}));
/**
 * One engine operation at a time. setModel, chooseModel and restartEngine each
 * run a stop -> measure -> start sequence; two of them interleaved can pass
 * the planner on the same memory snapshot and double-load (the review's
 * verifier reproduced exactly that). A promise chain is the whole mutex: every
 * lifecycle handler queues behind whatever is already running.
 */
let engineOpChain = Promise.resolve();
function withEngineLock(fn) {
    const run = engineOpChain.then(fn, fn);
    engineOpChain = run.catch(() => { /* keep the chain alive after failures */ });
    return run;
}

ipcMain.handle("lcl:restartEngine", () => withEngineLock(async () => {
    await engine.stopAndWait();
    // An IMPLICIT load, like boot and idle-reload: degrade to a smaller model
    // that fits rather than refusing outright. This handler's only caller is
    // waitForBackend's rescue start, which stands in for the boot start — and
    // the boot start could fall back. Without this the rescue was strictly
    // worse than the thing it replaced: on a machine where the preferred model
    // no longer fits, boot would have loaded something, and the rescue refuses.
    return engine.start({ allowFallback: true });
}));

// The registry-backed model picker. Presence is computed against the disk on
// every call — the registry's static "present" flag is documentation, not truth.
/**
 * Can this model be the CHAT model?
 *
 * Two independent reasons it might not be, and both must be checked:
 *
 *  - It has a non-chat ROLE. An embedder turns text into a vector; a reranker
 *    scores a pair; an image model draws. None of them generate a reply.
 *  - It has no KV cache. Encoder architectures (BERT and friends, which is what
 *    bge is) read a whole sequence in one pass and emit a vector or a score.
 *    They have no kvBytesPerToken because there is nothing to cache.
 *
 * The role list alone was the bug: it named "embedding" and nothing else, so a
 * reranker added later sailed into the picker, and selecting it produced a chat
 * that could not answer. Requiring generative geometry as well means the next
 * encoder model added to the registry is excluded by construction rather than
 * by remembering to update a list.
 */
const NON_CHAT_ROLES = new Set(["embedding", "reranker", "image"]);
function isChatModel(m) {
    if (!m || NON_CHAT_ROLES.has(m.role)) return false;
    return !!m.kvBytesPerToken;
}

// A sessionId makes the ACTIVE tick mean "what answers THIS conversation".
// Without one it means the app default, which is what the settings panels want.
ipcMain.handle("lcl:listModels", guard((_e, sessionId) => {
    // WHAT THIS SESSION CHOSE — the tick follows the conversation, not the app.
    // The picker used to tick whatever was globally running, so two sessions on
    // two models could not both be shown truthfully and the label contradicted
    // the session that was actually answering.
    const _sess = sessionId ? sessions.load(sessionId) : null;
    const _sessSel = _sess ? cloudModels.resolveSelection(_sess) : null;
    const _sessId = _sess ? modelSelId(_sess.modelSel) : null;
    const registry = paths.modelRegistry();
    // the current spark mode, read once — the picker heals node windows from the
    // mode table (below) the same way the donut does, so a not-yet-loaded spark
    // model shows its real window rather than the 32k assumption
    const _curSparkMode = (paths.readSettings() || {}).sparkMode;
    // "active" is what is actually RUNNING — during a memory fallback that is
    // not the settings preference, and the picker must not claim otherwise
    const engineState = engine.status();
    // ACTIVE MEANS RUNNING. NOTHING ELSE.
    //
    // This used to be `(running && model) || paths.findModel()` — falling back
    // to the model that WOULD be chosen when nothing was loaded. So after the
    // memory guard stopped the engine, the picker put its active tick on a
    // model that was not running, next to a composer saying "no model loaded":
    //
    //   "i can not unload the model right now because there is not one loaded,
    //    but the ui swears up and down becasue that little green check is
    //    showing 1.5B is loaded. and i can not select it"
    //
    // It could not be selected because the row it ticked was already the
    // current one, so clicking it was a no-op. Two different facts had been
    // collapsed into one flag; they are separate fields now.
    const activePath = (engineState.running && engineState.model) || null;
    const wouldLoadPath = activePath ? null : paths.findModel();
    const dirs = [paths.bundledModelsDir(), paths.modelsDir()];
    const onDisk = (m) => {
        for (const d of dirs) {
            const p = path.join(d, m.file);
            if (fs.existsSync(p)) return p;
        }
        return null;
    };

    // While a REMOTE model is selected, no local model is "active" — the picker
    // must show one answer to "what am I talking to", not two.
    const cloudCfg = cloudModels.config();
    const remoteInUse = !!(cloudCfg.enabled && cloudCfg.model);
    const preferredId = paths.readSettings().preferredModel || null;

    const models = (registry.models || [])
        .filter(m => m.runtime === "llama.cpp" && isChatModel(m))
        .map(m => {
            const file = onDisk(m);
            return {
                id: m.id,
                family: m.family,
                params: m.params,
                quant: m.quant,
                contextMax: m.contextMax,
                sizeBytes: m.sizeBytes,
                notes: m.notes || "",
                // traits drive the picker's most-capable-first ordering
                reasoning: (m.traits && m.traits.reasoning) || 0,
                code: (m.traits && m.traits.code) || 0,
                chat: (m.traits && m.traits.chat) || 0,
                // "sees images" is only claimed when the projector file is
                // actually on disk — the registry flag alone is a promise
                vision: !!(m.vision && m.mmproj && onDisk({ file: m.mmproj })),
                present: !!file,
                preferred: preferredId === m.id,
                // For a SESSION, active means the model this conversation
                // will use — a local pick is active even while the engine has
                // not loaded it yet, because that is what will answer the next
                // message. With no session this is unchanged: what is running.
                active: _sess
                    ? (_sessSel && !_sessSel.sel
                        && (_sessId ? _sessId === m.id
                                    : !!file && !!activePath
                                      && path.resolve(file) === path.resolve(activePath)))
                    : (!remoteInUse && !!file && !!activePath
                       && path.resolve(file) === path.resolve(activePath)),
                // separate fact, separate field: the model the planner would
                // start if a message arrived right now. The picker shows it as
                // "loads next", never as the active tick.
                wouldLoad: !remoteInUse && !!file && !!wouldLoadPath
                    && path.resolve(file) === path.resolve(wouldLoadPath)
            };
        });

    // LINKED API MODELS ride in the SAME list as the local ones.
    //
    // A remote model is a model. Putting it in a separate panel would mean the
    // question "which model am I talking to" has two places to look and no single
    // answer — so it appears in the picker beside the local ones, marked remote,
    // with its endpoint and its rate.
    for (const ep of cloudModels.endpoints()) {
        for (const m of ep.models || []) {
            // CHAT MODELS ONLY, same rule the local list already enforced.
            //
            // isChatModel() gates the local ladder eight lines up, and the
            // remote loop had no equivalent — so an endpoint's embedding,
            // rerank, speech and image models were all offered in the CHAT
            // picker, marked usable, sorted ABOVE every local model by the
            // hardcoded traits below. Selecting one produced a session that
            // failed on its first message with a provider error.
            //
            // connect() now filters at link time too, so this is the second
            // line of defence — and the one that covers endpoints linked
            // before that fix, and presets that list models by hand.
            if (!cloudModels.isChatCapable(m.id)) continue;
            // A NODE'S MODELS ARE FREE, AND THE ROW HAS TO SAY SO.
            //
            // Without this the picker either shows nothing where the price goes
            // — which reads as "unknown, probably expensive" for the one entry
            // that is certainly not — or, worse, shows a rate learned from a
            // paid catalogue for a model id the node happens to share with it.
            const onNode = cloudModels.isNodeEndpoint(ep);
            const rate = tokenCost.rateFor(m.id, null, { localNode: onNode });
            models.push({
                id: "api:" + ep.id + "|" + m.id,
                family: ep.label,
                params: "api",
                quant: null,
                // what the endpoint published about this model, healed from the
                // mode table for a spark node (the VPN case, where the published
                // number is the stale 32k assumption)
                contextMax: (onNode ? sparkWindowFor(SPARK_MODES, _curSparkMode, m.id) : 0)
                    || m.contextLength || null,
                sizeBytes: Number(m.sizeBytes) || 0,
                // A SEND THAT CAN NEVER SUCCEED IS NOT AN OPTION, IT IS A TRAP.
                // The guard's own arithmetic, asked with the machine entirely
                // empty: if the model still does not fit, every send refuses in
                // half a second forever (and, before the guard, the same load
                // killed the machine twice). The picker says so on the row
                // instead of letting the operator find out one refusal at a
                // time. The guard itself is unchanged — this is the same
                // verdict, delivered before the click instead of after it.
                neverFits: !!(onNode && ep.node && Number(ep.node.memBytes) > 0
                    && Number(m.sizeBytes) > 0
                    && !cloudModels.canEverFitNode(m.sizeBytes, ep.node.memBytes)),
                notes: ep.baseUrl,
                // Ordering: a linked remote model is almost always the most
                // capable thing available, so it sorts above the local ones —
                // but only when it can actually be used.
                reasoning: 5, code: 5, chat: 5,
                // THE PROVIDER'S OWN SHEET, where it publishes one.
                //
                // DeepInfra serves /models/list: of its 360 entries, 138 are
                // RETIRED and 213 declare no tool calling. .lcl listed them as
                // equal choices, which is how a deprecated gemini serving —
                // retired in June, no replacement named — got picked and
                // answered four clean 200s with nothing in them. A row that
                // knows it is retired says so before the click.
                retired: !!m.deprecated,
                retiredAt: m.deprecated || null,
                replacedBy: m.replacedBy || null,
                // an agent whose model cannot call tools is a chat box; the
                // row says which it is rather than letting the loop find out
                toolCalling: Array.isArray(m.features) && m.features.length
                    ? m.features.includes("tools") : null,
                modelType: m.type || null,
                // published capability, not a guess from the name
                vision: Array.isArray(m.tags)
                    ? (m.tags.includes("vision") || m.tags.includes("vlm"))
                    : false,
                remote: true,
                // remote, but on hardware in the room. The picker uses this to
                // say "your node" instead of quoting a price that does not exist.
                localNode: onNode,
                /* WHICH SEAT THIS ENGINE SITS IN — see nodeStacks.ROLES.
                   "chat" is selectable as the session model. "fleet" is what
                   agents run on: many streams, no bigger a window, and no
                   business being offered as a thing to talk to. */
                nodeRole: ep.nodeRole || null,
                nodeStack: ep.nodeStack || null,
                node: ep.node || null,
                // a GPU rented by the hour: its own tier in the picker, and
                // never folded in with hardware the operator owns
                rented: !!ep.rented,
                provider: ep.provider || null,
                endpointId: ep.id,
                endpointLabel: ep.label,
                // Zen and GO are two endpoints of ONE product; the picker
                // nests them under it instead of listing them as strangers
                // NOT `family`: that name is already taken on a model row for
                // its WEIGHT family (qwen2.5-coder). Two different meanings under
                // one key is a bug waiting for a quiet afternoon.
                /* DERIVED LIVE, NOT READ OFF THE STORED RECORD.
                 *
                 * The family reached the picker only if the endpoint record
                 * carried it, and the record only carried it if healKnownPresets
                 * had run over a store written before presets were recognised.
                 * That is a chain of three conditions to answer a question the
                 * BASE URL answers on its own — and the operator has told me
                 * three times that the grouping is not there while every hop I
                 * could execute said it was.
                 *
                 * presetForBase is pure and cheap: origin plus path against a
                 * table in this process. Asking it here cannot be stale, cannot
                 * depend on a migration having run, and cannot be null because
                 * something did not get written down.
                 */
                ...(() => {
                    let known = null;
                    try { known = cloudModels.presetForBase(ep.baseUrl); } catch { }
                    const nd = ep.node || null;
                    let port = "";
                    try { port = new URL(ep.baseUrl).port || ""; } catch { }
                    // the engine's own name, or the port when every endpoint on
                    // this machine was called the same thing
                    const engine = nd
                        ? ((ep.label && ep.label !== (nd.name || nd.host))
                            ? ep.label
                            : (enginesOnPort(port) || (port ? "port " + port
                                                            : (nd.name || nd.host))))
                        : null;
                    return {
                        providerFamily: ep.providerFamily
                            || (nd ? "node-" + (nd.id || nd.host) : null)
                            || (known && known.providerFamily) || null,
                        providerFamilyLabel: ep.providerFamilyLabel
                            || (nd ? (nd.name || nd.host) : null)
                            || (known && known.providerFamilyLabel) || null,
                        shortLabel: engine || ep.shortLabel
                            || (known && known.shortLabel) || null
                    };
                })(),
                modelId: m.id,
                // A key that cannot be decrypted is the case the operator asked
                // about: the endpoint is still configured, the key is gone. Say
                // so here so the picker can prompt instead of failing at send.
                keyRequired: !cloudModels.isLocalHost(new URL(ep.baseUrl).hostname),
                hasKey: ep.hasKey,
                keyEncrypted: ep.keyEncrypted,
                keyLost: ep.keyEncrypted && !ep.hasKey,
                rate: rate ? { in: rate.in, out: rate.out, source: rate.source } : null,
                present: true,
                preferred: preferredId === ("api:" + ep.id + "|" + m.id),
                // CONTRACT K4 — A MACHINE THAT IS OFF DOES NOT GET LISTED AS IF
                // IT WERE ON.
                //
                // "the picker still lists the Spark's models while the machine
                // is unreachable, and the UI reported the model as switched with
                // no weights loaded." cloudModels carries the verdict on the
                // ENDPOINT record and the renderer greys any row carrying it —
                // and this loop, the one place the two meet, copied neither, so
                // both halves of K4 were built and the picker still lied.
                //
                // Copied rather than dialled: this handler paints a menu, and a
                // picker that opens a socket per row is a picker that hangs.
                // The verdict is whatever the last real attempt learned, and it
                // lapses on its own (see endpointHealth), so a machine that
                // comes back is not greyed until a restart.
                offline: !!ep.offline,
                offlineReason: ep.offline
                    ? (ep.offlineReason || "that machine did not answer")
                    : null,
                // AND IT IS NOT SELECTABLE. `usable` is what the picker gates
                // selection on, so an unreachable endpoint has to fall out of it
                // — otherwise the row greys and still switches the session to a
                // model with no weights behind it, which is the second half of
                // the same report.
                usable: !ep.offline &&
                    (ep.hasKey || cloudModels.isLocalHost(new URL(ep.baseUrl).hostname)),
                active: _sess
                    ? !!(_sessSel && _sessSel.sel && _sessSel.sel.id === ep.id
                         && _sessSel.sel.model === m.id)
                    : !!(cloudCfg.enabled && cloudCfg.endpointId === ep.id
                         && cloudCfg.model === m.id)
            });
        }
    }

    // Non-chat engines ride along so the picker can SHOW them — the user
    // should never have to wonder whether an installed engine exists. Image
    // models are not selectable (the agent invokes them per call); ready
    // means both halves are on disk: the model AND its runtime.
    const imageModels = (registry.models || [])
        .filter(m => m.role === "image")
        .map(m => ({
            id: m.id,
            family: m.family,
            params: m.params,
            quant: m.quant,
            sizeBytes: m.sizeBytes,
            present: !!onDisk(m),
            ready: !!onDisk(m) && imageGen.available()
        }));

    return { models, imageModels };
}));

/**
 * Dry-run the load planner for one model so the picker can say, per row,
 * whether it fits RIGHT NOW and at what settings — instead of letting the user
 * discover a refusal after clicking.
 */
ipcMain.handle("lcl:planModel", guard((_e, id) => {
    const registry = paths.modelRegistry();
    const m = (registry.models || []).find(x => x.id === id && x.runtime === "llama.cpp");
    if (!m) return { error: "unknown model" };
    for (const d of [paths.bundledModelsDir(), paths.modelsDir()]) {
        const p = path.join(d, m.file);
        if (fs.existsSync(p)) {
            return { id, plan: engine.preflight(p, { reclaimCurrent: true }) };
        }
    }
    return { error: "not on disk" };
}));

/**
 * Switching models is a memory event, not a settings write. The sequence that
 * once froze this machine was: write settings, fire-and-forget stop, blind
 * start 400 ms later — both models briefly resident, no preflight, and the
 * caller told "success" before anything loaded. Now:
 *
 *   1. preflight the NEW model with credit for what stopping the old one
 *      frees — if even that world doesn't fit, refuse WITHOUT touching the
 *      running model, so a failed switch leaves the user exactly where they
 *      were;
 *   2. stop the old engine and WAIT for its memory to actually return;
 *   3. start the new model (start() re-plans against fresh numbers and is the
 *      final gate) and only then report the outcome.
 */
// `scope` is "session" when the pick came from a conversation's own picker.
// The difference is narrow and important: loading a gguf is a MACHINE-wide act
// (one llama-server, one resident model — physics), but clearing the global
// remote driver is a POLICY act, and doing it on behalf of one conversation
// would drag every session that never chose onto local with it.
ipcMain.handle("lcl:setModel", (_e, id, scope) => withEngineLock(async () => {
    try {
        // A REMOTE model is picked from the same list, so it arrives here. It does
        // not touch the engine lock's real work — nothing loads — but it does mean
        // the local engine can be released, which is the point: switching to an
        // API model should give this laptop its memory back.
        if (String(id || "").startsWith("api:")) {
            const rest = String(id).slice(4);
            const cut = rest.indexOf("|");
            const endpointId = rest.slice(0, cut), model = rest.slice(cut + 1);
            const ep = cloudModels.endpoints().find(e => e.id === endpointId);
            if (!ep) return { error: "that endpoint is no longer linked" };
            const needsKey = !cloudModels.isLocalHost(new URL(ep.baseUrl).hostname);
            if (needsKey && !ep.hasKey) {
                return { error: ep.keyEncrypted
                    ? `the stored key for ${ep.label} can no longer be read — it was ` +
                      "encrypted for a different Windows account or machine. Paste it again."
                    : `${ep.label} needs an API key — paste one in the capability panel.` };
            }
            // a SESSION-scoped remote pick must never write the app-wide role
            // — the renderer's picker records it on the session and returns
            // early, but this handler is not allowed to be the loophole
            if (scope !== "session") {
                cloudModels.selectModel({ endpointId, model, enabled: true });
            }
            // ACTUALLY RELEASE THE MEMORY. The note below claimed "the local
            // engine is idle" while llama-server sat resident with a full
            // model in RAM. On a 15.6 GB machine that is not idle, it is the
            // reason the memory guard fired mid-session — "Model stopped to
            // protect the machine: available memory fell to 1.1 GB" — during a
            // conversation that was being answered remotely and needed no
            // local model at all. Reasoning went to the cloud; the RAM stayed
            // spent. Stop the engine; picking a local model later reloads it.
            // unloadNow, not bare stop(): it marks the stop as deliberate so
            // the crash-restart machinery and the UI both read it as "model
            // unloaded" rather than as an engine death to recover from.
            try { if (engine.status().running) engine.unloadNow(); }
            catch { /* selection stands; the guard remains the backstop */ }
                        /* When the model is changed mid-session, this needs to
                reflect the real context window of the selected model, not a
                fake or assumed number. Measured on the switch, not only at
                launch — a node whose server was restarted between the two
                serves a different window than the one on file. */
            if (ep && ep.localNode) {
                cloudModels.measureNodeWindows(endpointId).catch(() => {});
            }
            auditLog.write({ kind: "model-selected", remote: true, endpoint: endpointId,
                             model, at: Date.now() });
            return { ok: true, remote: true, model, endpoint: ep.label,
                     note: `${model} on ${ep.label} — the local engine is unloaded, ` +
                           "its memory is yours again" };
        }
        // Picking a LOCAL model turns the remote one off — for the APP. One
        // answer to "what am I talking to", always. A session-scoped pick says
        // nothing about the app default, so it leaves it alone.
        if (scope !== "session" && cloudModels.config().enabled) {
            cloudModels.selectModel({ enabled: false });
        }
        const registry = paths.modelRegistry();
        const m = (registry.models || []).find(x => x.id === id && x.runtime === "llama.cpp");
        if (!m) return { error: "unknown model" };
        // The picker filters these out, but the UI must not be the only guard:
        // loading an encoder as the chat model yields a session that silently
        // answers nothing, which is far worse than a clear refusal.
        if (!isChatModel(m)) {
            const what = NON_CHAT_ROLES.has(m.role) ? `an ${m.role} model` : "not a chat model";
            return { error: `"${m.id}" is ${what} — it cannot hold a conversation. ` +
                             "It is used automatically by the features that need it." };
        }

        let modelPath = null;
        for (const d of [paths.bundledModelsDir(), paths.modelsDir()]) {
            const p = path.join(d, m.file);
            if (fs.existsSync(p)) { modelPath = p; break; }
        }
        if (!modelPath) return { error: "that model is not on this machine yet" };

        const check = engine.preflight(modelPath, { reclaimCurrent: true });
        if (!check.fits) {
            return { error: check.message, refusal: check, kept: true };
        }

        paths.writeSettings({ modelPath });
        await engine.stopAndWait();
        let started = await engine.start();
        if (!started.ok) {
            // NEVER LEAVE THE APP WITH NOTHING LOADED.
            //
            // Reported: "this locks the ui to the model that did not load,
            // instead of reverting to the best available model" ... "No model is
            // loaded right now." The old engine was already stopped by the line
            // above, so a failed start left zero models running and every session
            // dead until the user worked out what to do. A refusal is information;
            // an unusable app is not.
            const recovered = await engine.start({ allowFallback: true });
            if (recovered.ok) {
                return {
                    error: started.error, refusal: started.refusal || null,
                    kept: false, recovered: true,
                    id: (recovered.plan && recovered.plan.modelId) || null,
                    plan: recovered.plan,
                    note: "loaded the best model that fits instead — your preference is unchanged"
                };
            }
            return { error: started.error, refusal: started.refusal || null, kept: false };
        }
        return { id: m.id, modelPath, plan: started.plan };
    } catch (err) {
        return { error: String(err.message || err) };
    }
}));

ipcMain.handle("lcl:chooseModel", async () => {
    // the file dialog stays OUTSIDE the lock — a user leaving it open must not
    // block every other engine operation behind it
    const picked = await dialog.showOpenDialog(mainWindow, {
        title: "Select a GGUF model file",
        buttonLabel: "Use this model",
        filters: [{ name: "GGUF model", extensions: ["gguf"] }],
        properties: ["openFile"]
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };

    return withEngineLock(async () => {
        const model = picked.filePaths[0];
        // same discipline as lcl:setModel — user-picked files get no registry
        // entry, so the planner sizes them from disk and assumes worst-case KV
        const check = engine.preflight(model, { reclaimCurrent: true });
        if (!check.fits) return { error: check.message, refusal: check, kept: true };

        paths.writeSettings({ modelPath: model });
        await engine.stopAndWait();
        const started = await engine.start();
        if (!started.ok) return { error: started.error, refusal: started.refusal || null };
        return { modelPath: model, plan: started.plan };
    });
});

// -------------------------------------------------------------
// SESSIONS
// -------------------------------------------------------------
function guard(fn) {
    // Sync throws AND async rejections both land in the error log and come
    // back as { error } — before this, an async handler's rejection bypassed
    // the try entirely (fn returned a promise; the try only covered creating
    // it), surfacing to the renderer as a raw IPC error with nothing logged.
    return (...args) => {
        try {
            const r = fn(...args);
            if (r && typeof r.then === "function") {
                return r.catch((err) => {
                    logError("ipc-handler", err);
                    return { error: String((err && err.message) || err) };
                });
            }
            return r;
        } catch (err) {
            logError("ipc-handler", err);
            return { error: String(err.message || err) };
        }
    };
}

ipcMain.handle("lcl:listSessions", guard(() => ({ sessions: sessions.list() })));

// THE INTENT LEDGER, read-only to the UI — the durable Tier-2 record for a
// session (intent, open/done criteria, archived count). This is what the
// coming Ancient Knowledge surface reads to show the build's true state; for
// now it makes the ledger visible instead of a black box.
ipcMain.handle("lcl:intentSummary", guard((_e, sessionId) => {
    try {
        const il = require("../.lcl.engine/core/intentLedger");
        return il.summarize(paths.intentDir(), sessionId);
    } catch (e) { return { intent: "", open: [], done: [], archivedCount: 0, total: 0 }; }
}));

ipcMain.handle("lcl:createSession", guard((_e, title) => sessions.create(String(title || ""))));

/**
 * FORK — a new conversation that begins where this one was.
 *
 * Semantics are opencode's Session.fork, held in .lcl.engine/core/sessionFork
 * (pure, tested); this handler only loads, forks, and persists. Forking a
 * session mid-turn is allowed on purpose: the PARENT keeps running and the
 * fork simply owns the transcript as it stood — that is half the point of
 * forking, exploring a different direction while the first one works.
 */
ipcMain.handle("lcl:forkSession", guard((_e, id, messageIndex) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const forked = sessionFork.fork(s,
        Number.isInteger(messageIndex) ? messageIndex : undefined);
    sessions.save(forked);
    auditLog.write({ kind: "session-fork", session: forked.id,
                     from: s.id, messages: forked.messages.length, at: Date.now() });
    return { id: forked.id, title: forked.title,
             messages: forked.messages.length, forkedFrom: forked.forkedFrom };
}));

/**
 * THE CONTEXT WINDOW, AS AN AUDIT TRAIL.
 *
 * What the context panel shows must be what the next request will actually
 * carry — the system contract and the exact messages that survive the window
 * budget — not a paraphrase of the transcript. This computes it with the SAME
 * functions the turn uses (systemPrompt, buildModelMessages, fitToWindow), so
 * the panel cannot drift from the request.
 */
ipcMain.handle("lcl:contextSnapshot", guard((_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const sel = cloudModels.resolveSelection(s).sel;
    const limits = healSparkLimits(sel, router.limits(sel));
    const system = agent.systemPrompt(s.repoPath, undefined, sel);
    const built = agent.buildModelMessages(system, s.messages || [],
        { historyWindow: limits.historyWindow });
    const win = router.usingRemote(sel)
        ? (limits.contextLength || null)
        : engine.contextWindow();
    const fit = agent.fitToWindow(built, { window: win,
        replyTokens: limits.maxTokens });
    return {
        system,
        // role + content of exactly what would be sent, in order
        messages: fit.messages.map(m => ({ role: m.role,
            content: String(m.content || "") })),
        window: fit.window,
        promptTokens: fit.promptTokens,
        droppedMessages: fit.droppedMessages,
        historyWindow: limits.historyWindow,
        totalMessages: (s.messages || []).length
    };
}));

/**
 * EXPORT THE SESSION — the whole conversation as one markdown file, where the
 * operator chooses. opencode's context tab has the same button; here it is the
 * operator's own data leaving through their own file dialog, no cloud in the
 * path.
 */
ipcMain.handle("lcl:exportSession", guard(async (_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = String(s.title || "session").replace(/[^\w.-]+/g, "-").slice(0, 60);
    const picked = await dialog.showSaveDialog(mainWindow, {
        title: "Export this conversation",
        defaultPath: `lcl-${safe}-${stamp}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }]
    });
    if (picked.canceled || !picked.filePath) return { cancelled: true };
    const lines = [`# ${s.title || "Session"}`, ``,
        `*exported ${new Date().toISOString()} · ${(s.messages || []).length} messages*`, ``];
    for (const m of (s.messages || [])) {
        const who = m.role === "user" ? "You"
            : m.role === "tool" ? `Tool · ${m.name || "tool"}${m.failed ? " (failed)" : ""}`
            : (m.meta && m.meta.model) || "Assistant";
        lines.push(`## ${who}`, ``, String(m.content || ""), ``);
    }
    fs.writeFileSync(picked.filePath, lines.join("\n"), "utf8");
    return { ok: true, path: picked.filePath };
}));

/**
 * EXPORT TRAINING DATA — the local corpus (session transcripts + Claude Code
 * memory notes) folded into one sharegpt dataset under data/training/, secrets
 * redacted on the way out. runExport is deliberately synchronous: guard()'s
 * try/catch only holds for a throw, not a rejection, so an async handler here
 * would turn every failure into a rejected invoke the renderer cannot read.
 */
ipcMain.handle("lcl:exportTrainingData", guard((_e, o) => trainingExport.runExport({
    sessions: !!(o && o.sessions),
    memory: !!(o && o.memory),
    probe: !!(o && o.probe)
})));

ipcMain.handle("lcl:getSession", guard((_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    // FILTER DEAD KNOWLEDGE IDS ON READ. Removing a library does not sweep its
    // id out of every session's record, so the knowledge chip over-counted a
    // library that no longer exists. Filtering against the live list here heals
    // every session on load, without a sweep; the record self-corrects on its
    // next save.
    if (Array.isArray(s.knowledgeIds) && s.knowledgeIds.length) {
        const known = new Set(knowledge.list().map(l => l.id));
        const live = s.knowledgeIds.filter(x => known.has(x));
        if (live.length !== s.knowledgeIds.length) s.knowledgeIds = live;
    }
    return s;
}));

// =============================================================
// TRAINING SYNC — You > Import Training Data
// -------------------------------------------------------------
// An assistant that already knows the operator keeps that knowledge in a
// provider-shaped folder on this machine (Claude Code: per-project memory
// dirs). .lcl discovers those folders, imports them REDACTED as a training
// corpus, and exports the merged profile back out — so the Spark's LoRA, the
// local model, and the parent CLI can all be fed from one synced source.
// Discovery is a provider registry, not a hardcode: more providers add rows.
const TRAINING_PROVIDERS = [
    {
        id: "claude-code", label: "Claude Code memory",
        discover: () => {
            const out = [];
            const base = path.join(os.homedir(), ".claude", "projects");
            let dirs = [];
            try { dirs = fs.readdirSync(base); } catch { return out; }
            for (const d of dirs) {
                const mem = path.join(base, d, "memory");
                try {
                    const files = fs.readdirSync(mem).filter(f => f.endsWith(".md"));
                    if (!files.length) continue;
                    const st = fs.statSync(path.join(mem, "MEMORY.md"));
                    out.push({ provider: "claude-code",
                        label: "Claude Code — " + d.replace(/^C--/, "").replace(/-/g, "/").slice(0, 60),
                        path: mem, files: files.length,
                        updatedAt: st.mtimeMs || null });
                } catch { /* not a memory dir */ }
            }
            return out;
        }
    }
];
function redactTraining(text) {
    const user = (() => { try { return os.userInfo().username; } catch { return null; } })();
    const rules = [
        [/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+[\\/]OneDrive[^"'\s)\]]*/g, "[workspace]"],
        ...(user ? [[new RegExp("[A-Za-z]:[\\\\/]Users[\\\\/]" + user, "gi"), "C:/Users/[user]"],
                    [new RegExp("\\b" + user + "\\b", "gi"), "[user]"]] : []),
        [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email]"],
        [/\b(sk|djEw)[A-Za-z0-9+/_-]{20,}\b/g, "[key]"],
        [/\b(fuck(?:ing|ed|er|ers)?|motherfuckers?|shit(?:ty|s)?|bullshit|asshole|bitch(?:es)?|goddamn|damn(?:it)?|dumbass|half-?ass(?:ed)?)\b/gi, "[expletive]"]
    ];
    let t = text;
    for (const [re, rep] of rules) t = t.replace(re, rep);
    return t;
}
// =============================================================
// SPARK MODES — the operating-mode switch, from the UI
// -------------------------------------------------------------
// The box carries spark-mode.sh + door v4 recipes; this drives them. A mode
// defines the model AND the per-conversation window, so the store is updated
// the moment the switch is accepted — the picker, donut and context readout
// all re-derive from it without waiting on a probe.
// Each mode carries its own display NAME and ICON, so the whole app names a
// mode the same way wherever it shows: a model's single highest-context mode is
// "Vast" (bulb), its two-up mode is "Balanced" (scales), its four-up mode is
// "Swarm" (bee) — same name, same glyph across both models. The keys below
// (deep/balanced/wide/vast/swarm) stay as the Spark's own switch identifiers.
const SPARK_MODES = {
    deep:     { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 131072,
                name: "Vast", icon: "bulb", blurb: "one conversation, the whole 131k window" },
    balanced: { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 65536,
                name: "Balanced", icon: "scales", blurb: "two at a time, 65k each" },
    wide:     { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 32768,
                name: "Swarm", icon: "bee", blurb: "four at a time, 32k each" },
    vast:     { model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", label: "Qwen3.6-35B", ctx: 262144,
                name: "Vast", icon: "bulb", blurb: "one conversation, a 262k window — weaker driver, huge context" },
    swarm:    { model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", label: "Qwen3.6-35B", ctx: 65536,
                name: "Swarm", icon: "bee", blurb: "four light agents, 65k each" }
};
// THE SWITCH LIVES HERE, NOT IN A MENU CLOSURE. Closing the picker used to
// orphan a running switch: the UI forgot it, reopening showed rest-state
// buttons mid-switch, and a second click could fire a concurrent recipe.
// Main owns the in-flight record; every surface reads and REJOINS it.
let sparkSwitch = null;   // { nodeId, mode, startedAt } while one runs

/**
 * HEAL A NODE SELECTION'S WINDOW FROM THE MODE TABLE.
 *
 * router.limits() falls to a 32k assumption for a spark model the box could not
 * be probed for — and under the operator's VPN the direct probe is always dark,
 * so gpt-oss read 32k when it is really 131k. SPARK_MODES knows the truth and
 * survives the VPN. This only ever RAISES to a real known window, never lowers a
 * correctly-measured one (the loaded mode's own ctx equals the table's, so it is
 * a no-op there); a non-spark node has no table entry and is left untouched.
 */
function healSparkLimits(sel, limits) {
    try {
        if (!limits || !sel || !cloudModels.isNodeEndpoint(sel)) return limits;
        const known = sparkWindowFor(SPARK_MODES, (paths.readSettings() || {}).sparkMode, sel.model);
        if (known && known > (Number(limits.contextLength) || 0)) {
            return { ...limits, contextLength: known,
                basis: `${Math.round(known / 1000)}k context on ${(sel && sel.label) || "your node"}` +
                    " — from the mode table (the box was not reachable to probe directly)" };
        }
    } catch { /* fall through to the unhealed limits */ }
    return limits;
}

ipcMain.handle("lcl:sparkModes", guard(() => ({ ok: true, modes: SPARK_MODES,
    // the highlightable CURRENT mode: the last switch this install drove.
    // ctx arithmetic can never derive it (a 2-slot mode's measured n_ctx is
    // the pool, not the per-conversation share), so main just remembers.
    current: (paths.readSettings() || {}).sparkMode || null,
    inFlight: sparkSwitch })));

/** POST one JSON body through the door; resolves { status, body } or null.
 *  Each call is its own connection, so a VPN toggle between polls is free. */
function doorPostJson(n, route, payload, timeoutMs = 12_000) {
    return new Promise((resolve) => {
        if (!n || !n.relayUrl) return resolve(null);
        let tok = null;
        try { tok = doorTokenOf(n); } catch { /* below */ }
        if (!tok) return resolve(null);
        const data = Buffer.from(JSON.stringify(payload), "utf8");
        let u;
        try { u = new URL(n.relayUrl.replace(/\/$/, "") + route); }
        catch { return resolve(null); }
        const req = require("https").request(u, {
            method: "POST",
            headers: { Authorization: `Bearer ${tok}`,
                       "Content-Type": "application/json",
                       "Content-Length": data.length },
            // public DNS — same EACCES story as doorPut above
            lookup: publicDns.lookup,
            timeout: timeoutMs
        }, (res) => {
            let b = "";
            res.on("data", (c) => { b += c; });
            res.on("end", () => {
                let body = null;
                try { body = JSON.parse(b); } catch { body = null; }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on("error", (e) => resolve({ status: null,
            body: null, transport: String((e && e.code) || e).slice(0, 80) }));
        req.on("timeout", () => { req.destroy();
            resolve({ status: null, body: null, transport: "timeout" }); });
        req.end(data);
    });
}

/** live switch progress to every listening surface (picker fold, node dash) */
function sparkModeState(payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("lcl:sparkModeState", payload);
    }
}

ipcMain.handle("lcl:sparkMode", async (_e, nodeId, mode) => {
    const m = SPARK_MODES[String(mode || "")];
    if (!m) return { error: "unknown mode" };
    let n = readNodes().find(x => x.id === String(nodeId || ""));
    if (!n) {
        // resolve an endpoint id to its node — the picker holds endpoint ids
        try {
            const ep = cloudModels.endpoints().find(e => e.id === String(nodeId || ""));
            const nid = ep && ep.node && ep.node.id;
            n = readNodes().find(x => x.id === nid)
                || (ep && ep.relayUrl ? { id: nid || ep.id, host: ep.node && ep.node.host, relayUrl: ep.relayUrl } : null);
        } catch { /* unresolvable */ }
    }
    if (!n || !n.relayUrl) return { error: "that node has no remote door" };

    // ONE SWITCH AT A TIME, app-wide — refused HERE so the picker fold, the
    // node dashboard, and a reopened menu can never stack recipes on the box
    if (sparkSwitch) {
        const el = Math.round((Date.now() - sparkSwitch.startedAt) / 1000);
        return { error: `a switch to ${sparkSwitch.mode} is already running (${el}s) — ` +
                        `it finishes or fails on its own` };
    }
    sparkSwitch = { nodeId: n.id, mode, startedAt: Date.now() };
    try {

    // THE DRIVER ENDPOINT, FROM THE STORE — not a hardcoded port convention.
    // "node-<host>-30000" silently missed any driver on another port or host
    // string, and setEndpointModels' false return was thrown away with it.
    let driverEp = null;
    try {
        driverEp = cloudModels.endpoints().find(e =>
            e.node && String(e.node.id) === String(n.id) && e.nodeRole !== "fleet")
            || cloudModels.endpoints().find(e => e.id === "node-" + (n.host || "") + "-30000");
    } catch { /* no store — the switch can still run; the probe will say so */ }

    // THE PROBE IS THE AUTHORITY, AND IT RUNS FROM SECOND ZERO. The recipe is
    // fired and its lines feed the progress note — but nothing WAITS on it.
    // The last version awaited the recipe first, so a box script stuck in a
    // wrong readiness loop held the app hostage for 540s while the model had
    // been serving since 70s, and a VPN toggle mid-wait froze the timer, then
    // surfaced a connection-drop as babble ("showed as if balanced loaded,
    // then door blocked or some shit"). Now: the door's /v1/models proxy is
    // polled every 4s from the start — the first answer naming the requested
    // model ends the switch; the recipe result matters only as a FAST hard
    // failure (busy door, missing recipe) inside the first grace window, and
    // every stream/socket death is survivable because each poll is its own
    // fresh connection.
    const lines = [];
    let lastBoxLine = "";
    sparkModeState({ nodeId: n.id, mode, phase: "door", detail: "starting the switch on the box…" });
    const started = Date.now();
    let recipeResult = null;
    const job = doorRun(n, "spark-mode-" + mode, {
        idleMs: 90_000,
        // ONE CLOCK. The box's lines carry their OWN elapsed seconds, and
        // emitting them as events made two clocks fight over the note — the
        // operator watched the timer bounce "11s… 10s… 12s…". The box's
        // latest words ride the app-tick line below instead.
        onLine: (l) => { lines.push(l); lastBoxLine = String(l).slice(0, 90); }
    });
    job.done.then((r) => { recipeResult = r || { ok: false }; })
        .catch((e) => { recipeResult = { ok: false, tail: [String(e && e.message || e)] }; });

    {
        const READY_LIMIT_MS = 10 * 60_000;
        const HARD_FAIL_GRACE_MS = 25_000;
        let servingOk = false;
        let lastProbe = null;      // evidence for the ledger — never guess again
        let healthRoute = true;    // newer doors answer /lcl/driver-health
        while (Date.now() - started < READY_LIMIT_MS) {
            // FIRST CHOICE: the driver's own /health via the door — llama.cpp
            // answers it INSTANTLY however busy the slot is: 503 loading, 200
            // serving. No queueing behind the user's own sends, which is
            // how the 1-token probe starved for 8 minutes against a healthy
            // box (each 60s client timeout abandoned a job INTO the single
            // slot's queue and re-fired — a self-inflicted pile-up).
            if (healthRoute) {
                const h = await doorFetch(n, "/lcl/driver-health", 6000).catch(() => null);
                if (h && h.ok === true && typeof h.status === "number") {
                    lastProbe = { via: "driver-health", status: h.status };
                    if (h.status === 200) { servingOk = true; break; }
                } else {
                    // doorFetch resolves NULL for every non-200, so an old
                    // door's 403 deny is indistinguishable from a dead funnel
                    // by itself — the last 10-minute timeout was this branch
                    // never falling back. The funnel ping splits them: ping
                    // answers -> the door is alive and simply lacks the route
                    // (or it flaked) -> use the REAL probe from now on; ping
                    // dark -> a VPN blip, keep looping, a later poll heals.
                    const ping = await doorFetch(n, "/lcl/ping", 6000).catch(() => null);
                    const control = ping && ping.ok ? "funnel-ok" : "funnel-dark";
                    lastProbe = { via: "driver-health", status: null,
                                  transport: "no answer", control };
                    if (control === "funnel-ok") healthRoute = false;
                }
            }
            // FALLBACK for doors without the route: one real 1-token
            // completion. 90s timeout — a held request is a QUEUE, not an
            // absence — and a funnel control ping so the ledger can split
            // "funnel dark" from "route broken".
            if (!healthRoute) {
                const probe = await doorPostJson(n, "/v1/chat/completions", {
                    model: m.model, stream: false, max_tokens: 1,
                    messages: [{ role: "user", content: "ping" }]
                }, 90_000).catch(() => null);
                let control = null;
                if (!probe || probe.status !== 200) {
                    const ping = await doorFetch(n, "/lcl/ping", 6000).catch(() => null);
                    control = ping && ping.ok ? "funnel-ok" : "funnel-dark";
                }
                lastProbe = probe
                    ? { via: "completion", status: probe.status,
                        transport: probe.transport || null, control,
                        body: JSON.stringify(probe.body || "").slice(0, 160) }
                    : { via: "completion", status: null, transport: "null-probe",
                        control, body: null };
                if (probe && probe.status === 200
                    && probe.body && Array.isArray(probe.body.choices)
                    && probe.body.choices.length) {
                    servingOk = true;
                    break;
                }
            }
            // a recipe that died QUICKLY died for a real reason — 409 another
            // recipe running, 404 no recipe, no door. Late failures (the box
            // script's own broken serve-check, a dropped stream) are noise the
            // probe outlives.
            if (recipeResult && recipeResult.ok === false
                && Date.now() - started < HARD_FAIL_GRACE_MS) {
                const tailText = ((recipeResult.tail) || lines).join(" ");
                // an empty refusal this early is the door's single-flight lock:
                // the PREVIOUS switch's recipe is still finishing on the box.
                // "the door refused" told the operator nothing three times over.
                const why = (tailText.match(/ERROR:[^"]{0,180}/) || [])[0]
                    || (/already running|429|409/.test(tailText) || !tailText.trim()
                        ? "the box is still finishing the previous switch — give it a minute and click again"
                        : tailText.slice(0, 200));
                sparkModeState({ nodeId: n.id, mode, phase: "failed", detail: why });
                auditLog.write({ kind: "spark-mode-failed", nodeId: n.id, mode, why, at: Date.now() });
                return { error: why };
            }
            // the app's OWN tick, every cycle — the note can never freeze on a
            // dead stream again
            const secs = Math.round((Date.now() - started) / 1000);
            sparkModeState({ nodeId: n.id, mode, phase: "loading",
                detail: `${m.label} loading on the node — ${secs}s`
                    + (lastBoxLine ? ` · box: ${lastBoxLine}` : "") });
            await new Promise(res => setTimeout(res, 4000));
        }
        try { job.cancel(); } catch { /* recipe finishes on the box regardless */ }
        if (!servingOk) {
            const why = `${m.label} is not serving yet — the box may still be downloading ` +
                        `weights; the mode will show as running once it answers`;
            sparkModeState({ nodeId: n.id, mode, phase: "failed", detail: why });
            // the last probe's actual answer rides the ledger, so the NEXT
            // "error 503. read" is answered by reading, not by theorizing
            auditLog.write({ kind: "spark-mode-timeout", nodeId: n.id, mode,
                             lastProbe, at: Date.now() });
            return { error: why };
        }
    }

    // 2. the store, written through the REAL endpoint id, loudly if it misses —
    // ON RECIPE SUCCESS, so the picker can never go stale behind a completed
    // switch again (the write used to hide behind the flaky probe)
    let stored = false;
    try {
        if (driverEp) stored = cloudModels.setEndpointModels(driverEp.id, [{
            id: m.model, label: m.label, contextLength: m.ctx, maxTokens: null, chat: true
        }]) !== false;
    } catch { stored = false; }
    if (!stored) auditLog.write({ kind: "spark-mode-store-miss", nodeId: n.id, mode,
                                  epId: driverEp && driverEp.id, at: Date.now() });
    try { paths.writeSettings({ sparkMode: mode }); } catch { /* highlight only */ }

    // 3. best-effort OUTSIDE confirmation: lets measureNodeWindows record the
    // served window when the endpoint is reachable directly. Non-fatal by
    // design — under the VPN this path is dark while the door still works.
    try { if (driverEp) await cloudModels.measureNodeWindows(driverEp.id); }
    catch { /* the box already verified itself */ }

    const seconds = Math.round((Date.now() - started) / 1000);
    auditLog.write({ kind: "spark-mode", nodeId: n.id, mode, model: m.model, ctx: m.ctx,
                     seconds, at: Date.now() });
    sparkModeState({ nodeId: n.id, mode, phase: "ready",
                     detail: `${m.label} is serving (${seconds}s)` });
    return { ok: true, mode, model: m.model, label: m.label, ctx: m.ctx,
             note: `${m.label} is serving — verified on the box in ${seconds}s` };
    } finally { sparkSwitch = null; }
});

/**
 * TRAIN ON THIS NODE — the manage-machine button that productizes the proven
 * manual run: distill the imported training data into instruction pairs, send
 * them through the door's fixed SLOTS (never a caller path), run the box's
 * spark-train recipe (which pauses the fleet, trains, restarts the fleet, and
 * names the adapter), and stream every line back live. VPN-proof: everything
 * rides the same relay the recipes already use.
 */
function doorPut(n, slot, bytes) {
    return new Promise((resolve) => {
        let tok = null;
        try { tok = doorTokenOf(n); } catch { /* below */ }
        if (!tok || !n || !n.relayUrl) return resolve({ ok: false, error: "no door token for this node" });
        let u;
        try { u = new URL(n.relayUrl.replace(/\/$/, "") + "/lcl/put?slot=" + encodeURIComponent(slot)); }
        catch { return resolve({ ok: false, error: "bad relay url" }); }
        const req = require("https").request(u, {
            method: "POST",
            headers: { Authorization: `Bearer ${tok}`, "Content-Length": Buffer.byteLength(bytes) },
            // PUBLIC DNS, like doorFetch: MagicDNS answers the funnel name with
            // the TAILNET address, and the VPN kill-switch EACCESes it — every
            // POST died pre-network while GETs (which pin public DNS) sailed
            lookup: publicDns.lookup,
            timeout: 30_000
        }, (res) => {
            let b = "";
            res.on("data", (c) => { b += c; });
            res.on("end", () => {
                try { resolve(JSON.parse(b)); }
                catch { resolve({ ok: res.statusCode === 200 }); }
            });
        });
        req.on("error", (e) => resolve({ ok: false, error: String(e && e.message || e) }));
        req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "the door did not answer" }); });
        req.end(bytes);
    });
}

// the BAKE tier, distilled the same way the first Spark LoRA was: one pair
// per imported memory note — the rule's name asks, the note answers
function buildTrainingPairs() {
    const dir = path.join(paths.dataDir(), "training");
    const pairs = [];
    const walk = (d) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const f of entries) {
            const p = path.join(d, f.name);
            if (f.isDirectory()) { walk(p); continue; }
            if (!/\.md$/i.test(f.name) || f.name.toUpperCase() === "MEMORY.MD") continue;
            try {
                const t = fs.readFileSync(p, "utf8");
                const name = (t.match(/^name:\s*(.+)$/m) || [])[1]
                    || f.name.replace(/\.md$/i, "");
                const body = t.replace(/^---[\s\S]*?---\s*/, "").trim();
                if (!body) continue;
                pairs.push({
                    instruction: "How does the operator want you to handle " +
                        String(name).replace(/[-_]/g, " ").trim() + "?",
                    input: "",
                    output: body.slice(0, 8000)
                });
            } catch { /* skip unreadable */ }
        }
    };
    walk(dir);
    return pairs;
}

function nodeTrainState(payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("lcl:nodeTrainState", payload);
    }
}

let nodeTrainRunning = false;
ipcMain.handle("lcl:nodeTrain", async (_e, nodeId) => {
    if (nodeTrainRunning) return { error: "a training run is already going" };
    const n = readNodes().find(x => x.id === String(nodeId || ""));
    if (!n || !n.relayUrl) return { error: "that node has no remote door" };
    const pairs = buildTrainingPairs();
    if (!pairs.length) {
        return { error: "no training data staged - run Train > Import Training Data first" };
    }
    nodeTrainRunning = true;
    const started = Date.now();
    const taskId = "train:" + n.id;
    try {
        nodeTrainState({ nodeId: n.id, phase: "staging",
            detail: pairs.length + " pairs distilled from the imported training data" });
        const jsonl = pairs.map(p => JSON.stringify(p)).join("\n") + "\n";
        const p1 = await doorPut(n, "training-dataset", Buffer.from(jsonl, "utf8"));
        if (!p1 || p1.ok === false) {
            return { error: (p1 && p1.error) || "could not send the dataset through the door" };
        }
        const p2 = await doorPut(n, "training-dataset-info",
            Buffer.from(JSON.stringify({ lcl_operator: { file_name: "instruction-pairs.jsonl" } }), "utf8"));
        if (!p2 || p2.ok === false) {
            return { error: (p2 && p2.error) || "could not register the dataset" };
        }
        tasks.start({ id: taskId, kind: "train",
            title: "Training on " + (n.name || "node"),
            detail: pairs.length + " pairs", cancellable: false, scope: "library" });
        nodeTrainState({ nodeId: n.id, phase: "training",
            detail: "training started - the fleet pauses while it runs" });
        const lines = [];
        const job = doorRun(n, "spark-train", { idleMs: 120_000, onLine: (l) => {
            lines.push(l);
            const line = String(l).slice(0, 140);
            nodeTrainState({ nodeId: n.id, phase: "training", detail: line });
            try { tasks.progress(taskId, line); } catch { /* row still moves via events */ }
        } });
        const r = await job.done;
        const tail = ((r && r.tail) || lines).join(" ");
        const adapter = (tail.match(/ADAPTER: (\S+)/) || [])[1] || null;
        if (!r || r.ok === false || !adapter) {
            const why = (tail.match(/ERROR:[^"]{0,180}/) || [])[0] || "training did not finish";
            tasks.finish(taskId, "failed", why);
            nodeTrainState({ nodeId: n.id, phase: "failed", detail: why });
            auditLog.write({ kind: "node-train-failed", nodeId: n.id, why, at: Date.now() });
            return { error: why };
        }
        const seconds = Math.round((Date.now() - started) / 1000);
        tasks.finish(taskId, "done", "adapter " + adapter);
        auditLog.write({ kind: "node-train", nodeId: n.id, pairs: pairs.length,
                         adapter, seconds, at: Date.now() });
        nodeTrainState({ nodeId: n.id, phase: "done",
            detail: "adapter baked in " + seconds + "s - " + adapter });
        return { ok: true, adapter, pairs: pairs.length, seconds };
    } finally { nodeTrainRunning = false; }
});

ipcMain.handle("lcl:trainingSources", guard(() => {
    const sources = [];
    for (const p of TRAINING_PROVIDERS) {
        try { sources.push(...p.discover()); } catch { /* provider absent */ }
    }
    // what is already synced, so the panel can say fresh vs stale
    const dir = path.join(paths.dataDir(), "training");
    let synced = {};
    try { synced = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); }
    catch { synced = {}; }
    return { ok: true, sources, synced };
}));
ipcMain.handle("lcl:trainingSync", guard((_e, srcPath) => {
    const src = String(srcPath || "");
    const known = TRAINING_PROVIDERS.some(p => {
        try { return p.discover().some(s => s.path === src); } catch { return false; }
    });
    if (!known) return { error: "that folder is not a discovered training source" };
    const slug = src.replace(/[^a-z0-9]+/gi, "-").slice(-60);
    const dir = path.join(paths.dataDir(), "training", slug);
    fs.mkdirSync(dir, { recursive: true });
    let n = 0, bytes = 0;
    for (const f of fs.readdirSync(src).filter(x => x.endsWith(".md"))) {
        const t = redactTraining(fs.readFileSync(path.join(src, f), "utf8"));
        fs.writeFileSync(path.join(dir, f), t);
        n++; bytes += Buffer.byteLength(t);
    }
    const manifestPath = path.join(paths.dataDir(), "training", "manifest.json");
    let man = {}; try { man = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { }
    man[src] = { syncedAt: Date.now(), files: n, bytes, dir };
    fs.writeFileSync(manifestPath, JSON.stringify(man, null, 1));
    auditLog.write({ kind: "training-sync", src, files: n, bytes, at: Date.now() });
    return { ok: true, files: n, bytes, dir };
}));
ipcMain.handle("lcl:trainingExport", guard(() => {
    // the merged corpus: every synced source + this install's sessions, all
    // redacted — one folder the Spark's LLaMA-Factory or a parent CLI can eat
    const out = path.join(paths.dataDir(), "training-export");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, "sessions"), { recursive: true });
    let files = 0;
    const tdir = path.join(paths.dataDir(), "training");
    try {
        for (const d of fs.readdirSync(tdir)) {
            const sub = path.join(tdir, d);
            if (!fs.statSync(sub).isDirectory()) continue;
            fs.mkdirSync(path.join(out, d), { recursive: true });
            for (const f of fs.readdirSync(sub)) {
                fs.copyFileSync(path.join(sub, f), path.join(out, d, f)); files++;
            }
        }
    } catch { /* nothing synced yet */ }
    try {
        for (const f of fs.readdirSync(paths.sessionsDir()).filter(x => x.endsWith(".json"))) {
            const t = redactTraining(fs.readFileSync(path.join(paths.sessionsDir(), f), "utf8"));
            fs.writeFileSync(path.join(out, "sessions", f), t); files++;
        }
    } catch { /* no sessions */ }
    try { shell.showItemInFolder(out); } catch { /* headless */ }
    auditLog.write({ kind: "training-export", files, at: Date.now() });
    return { ok: true, files, dir: out };
}));

ipcMain.handle("lcl:renameSession", guard((_e, id, title) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const next = String(title || "").trim().slice(0, 120);
    if (!next) return { error: "title cannot be empty" };
    s.title = next;
    sessions.save(s);
    return { id: s.id, title: s.title };
}));

// THE SESSION'S BELL. Muted = no tray toast, no chime, for THIS session only.
// The dot, the in-app cards and the tray MENU keep working — the mute
// silences announcements, never state. Default is unmuted: notifications on.
ipcMain.handle("lcl:setSessionNotify", guard((_e, id, muted) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    s.notifyMuted = !!muted;
    sessions.save(s);
    auditLog.write({ kind: "session-notify", id: s.id, muted: s.notifyMuted, at: Date.now() });
    return { id: s.id, notifyMuted: s.notifyMuted };
}));

// KNOWING WHAT HAS BEEN READ. readAt >= doneAt is the acknowledged
// state the sidebar dot shows; stamped when the operator actually opens the
// session (and when a turn finishes right in front of them).
ipcMain.handle("lcl:markSessionRead", guard((_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    s.readAt = Date.now();
    sessions.save(s);
    return { id: s.id, readAt: s.readAt };
}));

// The renderer's own errors, into the same ledger. window.onerror survives
// where render-process-gone does not fire (the page lived, the feature died) —
// before this, a thrown click handler vanished without a trace.
ipcMain.handle("lcl:diag", (_e, rec) => {
    try {
        auditLog.write({ kind: "renderer-error",
            error: String((rec && rec.error) || "").slice(0, 500),
            stack: String((rec && rec.stack) || "").slice(0, 2000),
            where: String((rec && rec.where) || "").slice(0, 200), at: Date.now() });
    } catch { /* never let logging hurt */ }
    return { ok: true };
});

ipcMain.handle("lcl:deleteSession", guard((_e, id) => {
    // THE REFUSAL COMES FIRST. These guards used to sit BELOW the side
    // effects, so a REFUSED delete on a working session had already destroyed
    // its sandbox box under the running turn, dropped its pending script
    // proposals, and stamped its ledger rows deleted — for a session that
    // still existed. Nothing destructive happens until the delete is allowed.
    // deleting a session whose turn is mid-flight would have the turn's final
    // save resurrect the file — stop the turn first, then it can be deleted.
    // approvalsRunning is the SECOND writer with the same resurrection power:
    // an approved tool holds the session in memory and saves it when it lands.
    if (turnsBySession.has(id)) {
        return { error: "this session is still working — stop it first, then delete" };
    }
    if (approvalsRunning.has(id)) {
        return { error: "an approved action is still running here — stop it first, then delete" };
    }
    // THE BOX GOES WITH THE CONVERSATION. releaseSession had no caller at
    // all, so boxes accumulated: never cleaned up, and after a restart
    // orphaned and invisible in the panel. "Exists only while in use" has to
    // be enforced by something actually calling it.
    try { sandbox.releaseSession(String(id)); } catch { /* nothing owned */ }
    try { scriptRunner.dropSession(String(id)); } catch { /* none pending */ }
    // The transcript goes; the SPEND STAYS. A ledger you can erase by tidying
    // up is not a ledger — the row keeps the session's name and a deleted mark.
    try {
        const s2 = sessions.load(id);
        ledger.markSessionDeleted(id, s2 && s2.title);
    } catch { /* the delete proceeds regardless */ }
    sessionStatus.delete(id);
    // pending approvals die with their session — the map must not grow
    // entries no card can ever reference again
    for (const [pid, p] of pendingToolApprovals) {
        if (p.sessionId === id) pendingToolApprovals.delete(pid);
    }
    if (!sessions.remove(id)) return { error: "session not found" };
    backups.purge(id);   // don't leave orphaned snapshots behind
    // staged attachment copies die with their conversation — same rule
    try {
        fs.rmSync(path.join(paths.dataDir(), "attachments", String(id)),
                  { recursive: true, force: true });
    } catch { /* nothing staged */ }
    return { deleted: id };
}));

ipcMain.handle("lcl:listFiles", guard((_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    if (!s.repoPath) return { repoPath: null, entries: [], truncated: false };
    if (!fs.existsSync(s.repoPath)) return { error: `linked folder no longer exists: ${s.repoPath}` };
    try {
        // THE EXPLORER IS FOR A PERSON, NOT FOR A PROMPT. The model's tool
        // keeps its small cap so a listing cannot eat its context; the panel
        // showing the operator their own folder asks for the whole thing.
        return { repoPath: s.repoPath,
                 ...fsTools.listFiles(s.repoPath, { path: ".", cap: 20_000 }) };
    } catch (err) {
        return { error: String(err.message || err) };
    }
}));

// Read one file for the workspace VIEWER. Same containment as the agent's
// file tools — resolveInRoot defeats traversal and junction escapes — with
// bigger caps because a human is reading, not a 4k-context model. Images come
// back as data URIs so the renderer's CSP (img-src 'self' data:) can show
// them without loosening file:// access.
const VIEW_TEXT_CAP = 2_000_000;
const VIEW_IMAGE_CAP = 12_000_000;
const VIEW_IMAGE_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".ico": "image/x-icon", ".svg": "image/svg+xml"
};

/**
 * ONE READER, FOR ANY FILE THIS APP SHOWS A PERSON.
 *
 * The reading logic used to live inside the workspace-file handler, so it
 * could only ever read a file inside a session's linked folder. Knowledge
 * documents live outside any workspace, which is the ONLY reason they could
 * not be opened with it — and the answer to that is not a second reader.
 * "you already have a reader. so whatever, just make it work for knowledge
 *  libraries as well."
 */
function readFileForViewer(full, rel) {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return { error: "not a file" };
    }
    const size = fs.statSync(full).size;
    const name = path.basename(full);
    const ext = path.extname(full).toLowerCase();

    if (VIEW_IMAGE_MIME[ext]) {
        if (size > VIEW_IMAGE_CAP) {
            return { error: `image too large to preview (${Math.round(VIEW_IMAGE_CAP / 1e6)} MB cap)` };
        }
        return {
            kind: "image", name, relPath: rel, size,
            dataUri: `data:${VIEW_IMAGE_MIME[ext]};base64,${fs.readFileSync(full).toString("base64")}`
        };
    }
    // A PDF IS SHOWN AS A PDF. Chromium ships a complete PDF viewer — toolbar,
    // thumbnails, zoom, find — and it streams from disk, so a 100 MB reference
    // book costs nothing over IPC. Proven under this app's exact sandbox
    // settings before being wired in. The extracted text exists for SEARCH and
    // for the model; a person asked to read a document gets the document.
    //   Extracted text should not be shown in the UI; it exists only for
    //   searching and use in the modeling.
    if (ext === ".pdf") {
        return { kind: "pdf", name, relPath: rel, size,
                 fileUrl: require("url").pathToFileURL(full).href };
    }
    if (fsTools.isProbablyBinary(full)) {
        return { kind: "binary", name, relPath: rel, size };
    }
    const fd = fs.openSync(full, "r");
    try {
        const buf = Buffer.alloc(Math.min(VIEW_TEXT_CAP, size));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return {
            kind: "text", name, relPath: rel, size, ext,
            content: buf.subarray(0, n).toString("utf8"),
            truncated: size > VIEW_TEXT_CAP
        };
    } finally {
        fs.closeSync(fd);
    }
}

ipcMain.handle("lcl:viewFile", guard((_e, id, relPath) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const rel = String(relPath || "");
    // ARTIFACTS BESIDE AN ATTACHMENT ARE VIEWABLE TOO. extract_pdf writes its
    // sidecar (page renders, extracted figures, index.md) beside the source; for
    // an out-of-workspace attachment that source lives in the session's own
    // attachments dir, reached by the same @attachments/ prefix the model uses.
    // Re-root there — contained by resolveInRoot against that per-session dir,
    // the symmetric partner to runTool's re-root — so the user can SEE an
    // attached PDF's extracted images with no folder linked at all.
    const ATT = "@attachments/";
    if (rel.startsWith(ATT)) {
        let full;
        try { full = fsTools.resolveInRoot(attachmentsDirFor(s.id), rel.slice(ATT.length)); }
        catch (err) { return { error: String((err && err.message) || err) }; }
        if (!fs.existsSync(full)) return { error: "not on disk any more: " + full };
        return readFileForViewer(full, rel);
    }
    if (!s.repoPath) return { error: "no folder linked" };
    const full = fsTools.resolveInRoot(s.repoPath, rel);   // throws on escape
    return readFileForViewer(full, rel);
}));

/**
 * A KNOWLEDGE DOCUMENT, THROUGH THE SAME READER.
 *
 * Resolved against the library's own root with the same containment rule the
 * workspace viewer uses, then handed to readFileForViewer — so markdown
 * renders as markdown, an image as an image, and nothing new was invented.
 */
ipcMain.handle("lcl:viewKnowledgeFile", guard((_e, libId, relPath) => {
    const lib = (knowledge.list() || []).find(l => String(l.id) === String(libId));
    // A library's folder is `root` — `folder` is a property no library has
    // ever had, so this refused every document it was asked for.
    if (!lib || !lib.root) return { error: "no such knowledge library" };
    let full;
    try {
        // The workspace viewer's own containment helper, not a second one
        // written beside it. The hand-rolled version here took realpath on the
        // ROOT and never on the target, so a junction or symlink planted inside
        // a library resolved to a path outside it and passed the string
        // comparison. resolveInRoot also refuses NTFS alternate data streams,
        // reserved device names and embedded nulls — none of which the local
        // version knew about.
        full = fsTools.resolveInRoot(lib.root, String(relPath || ""));
    } catch (err) {
        return { error: String((err && err.message) || err) };
    }
    // the message carries the PATH IT LOOKED FOR, because "file does not
    // exist" with no path is unactionable and undiagnosable from a report
    if (!fs.existsSync(full)) {
        return { error: "not on disk any more: " + full };
    }
    return readFileForViewer(full, String(relPath || ""));
}));

// -------------------------------------------------------------
// CHAT (agent turn) — one turn PER SESSION, sessions independent
// -------------------------------------------------------------
/**
 * The old design held ONE global activeTurn: while any session was generating,
 * every other session was locked — no new session, no switching in and doing
 * work. That was the correct rule for the ENGINE (one llama-server, one model
 * resident: physics) and the SESSION FILE (whole-file saves; two writers lose
 * messages) — but wrong as an app-wide lock.
 *
 * So the locks now live at their true scopes:
 *   - per SESSION: one turn per session at a time (protects the session file)
 *   - the ENGINE serialises itself: generate() calls queue on the single
 *     llama-server, so concurrent sessions take turns for tokens rather than
 *     failing. Another session CAN be opened, typed into, and queued while a
 *     long turn runs elsewhere.
 *
 * STATUS is tracked here — the process that actually knows — and broadcast to
 * the sidebar. Four states, exactly as specified: working (a turn or task is
 * live), waiting (the model asked the user something, or staged an approval),
 * failed (the last turn errored), idle (done). See sessionStatus.
 */
const turnsBySession = new Map();      // sessionId -> cancelToken
// Afterthoughts sent while a turn is running, per session. NOT a queue: they
// are handed to Ancient Knowledge as part of the request being answered right
// now, and cleared when that turn ends. See the addendum branch in lcl:chat.
const sessionAddenda = new Map();      // sessionId -> [text]
const sessionStatus = new Map();       // sessionId -> { state, detail, at }

/* ============================================================== POST-CHECK
 * THE DETERMINISTIC GATE. A real session shipped an artifact that loaded its
 * charts from a CDN — in an offline-first product — and named files that did
 * not exist. The full self-review is optional and priced; THIS is neither: a
 * grep-grade pass over the turn's own written files, every turn that wrote
 * any, no model in the loop.
 *
 * Two checks, both chosen because they can be RIGHT:
 *   1. OFFLINE — load-bearing network references (script/link/media src,
 *      dynamic loader .src=, url(), @import, fetch, XHR, WebSocket,
 *      import-from, protocol-relative included) in written web files. An
 *      <a href> to the web still works offline, a <link rel=canonical>
 *      loads nothing, and localhost is THIS machine — none of those flag.
 *   2. FILES — path-like names ("site/app.js", never bare prose words) the
 *      reply mentions that do not exist on disk. Files deleted this turn
 *      and domain-shaped tokens are exempt; a turn that STAGED an approval
 *      may name its future outputs, so nothing is flagged there.
 *
 * There is deliberately NO prose-claims check. A term-grep over the reply
 * ("mentions BCD but nothing written contains it") was built, adversarially
 * reviewed, and killed: it deterministically accused honest replies (every
 * "removed the CDN reference" fix re-flags CDN forever) while the motivating
 * fabrication — features claimed in plain prose — never matches an acronym
 * regex at all. Judging prose is the model-graded reviews' job (self-audit,
 * Ancient Knowledge); this gate only asserts what disk can prove.
 *
 * Findings ride the transcript as their own message (meta.model
 * "post-check"), the same pattern as the self-audit note — never only in a
 * log. Kill switch: settings.postCheck === false.
 */
const POST_CHECK_WEB_EXT = new Set([".html", ".htm", ".js", ".mjs", ".css"]);
const POST_CHECK_MAX_FILES = 12;
const POST_CHECK_READ_CAP = 512_000;   // lint the HEAD of even a huge page —
                                       // a size skip would exempt exactly the
                                       // big single-file artifacts most
                                       // likely to carry a CDN reference
// hosts that are THIS machine — a generated page talking to the local
// engine or a Local Node service is a legitimately offline artifact
const POST_CHECK_LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)(:\d+)?$/i;
// machine-authored transcript messages — the gate examines the MODEL's
// reply, never the auditors' notes or the orchestrator's own template
const POST_CHECK_MACHINE = new Set(["self-audit", "post-check", "ancient-knowledge", "orchestrator"]);

function postCheckHeadOf(full) {
    const fd = fs.openSync(full, "r");
    try {
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(Math.min(POST_CHECK_READ_CAP, size));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, n).toString("utf8");
    } finally { fs.closeSync(fd); }
}

function postCheckExternalRefs(content) {
    // load-bearing references only; protocol-relative ("//cdn…") resolves to
    // the network everywhere but file://, so it counts
    const U = "(?:https?:)?\\/\\/";
    const pats = [
        new RegExp(`<script[^>]{0,300}\\bsrc\\s*=\\s*["']${U}[^"']+`, "gi"),
        new RegExp(`<link[^>]{0,300}\\bhref\\s*=\\s*["']${U}[^"']+[^>]{0,100}`, "gi"),
        new RegExp(`<(?:img|iframe|video|audio|source)[^>]{0,300}\\bsrc\\s*=\\s*["']${U}[^"']+`, "gi"),
        new RegExp(`\\.src\\s*=\\s*["'\`]${U}[^"'\`]+`, "gi"),   // dynamic loader injection
        /url\(\s*["']?(?:https?:)?\/\/[^"')]+/gi,
        /@import\s+["'](?:https?:)?\/\/[^"']+/gi,
        /\bfetch\(\s*["'`]https?:\/\/[^"'`]+/gi,
        /\bnew WebSocket\(\s*["'`]wss?:\/\/[^"'`]+/gi,
        /\.open\(\s*["'][A-Za-z]+["']\s*,\s*["'`]https?:\/\/[^"'`]+/gi,   // XHR
        /\bimport\s+[^;]{0,160}\bfrom\s*["']https?:\/\/[^"']+/gi,
        /\bimport\(\s*["'`]https?:\/\/[^"'`]+/gi,
    ];
    const hits = [];
    for (const re of pats) {
        for (const m of content.matchAll(re)) {
            const tag = m[0];
            // a <link> that loads nothing (rel=canonical, alternate, …) is
            // not a network dependency — only resource-loading rels count
            if (/^<link/i.test(tag)
                && !/rel\s*=\s*["']?[^"'>]*(stylesheet|icon|preload|modulepreload|manifest|font)/i.test(tag)) {
                continue;
            }
            const u = (tag.match(/(?:wss?:|https?:)?\/\/[^\s"'`<>)]+/i) || [])[0];
            if (!u) continue;
            const host = u.replace(/^(?:wss?:|https?:)?\/\//i, "").split(/[/?#]/)[0];
            if (!host || POST_CHECK_LOCAL_HOST.test(host)) continue;
            hits.push(u);
        }
    }
    return [...new Set(hits)];
}

function postCheckTurn(s, result) {
    if (paths.readSettings().postCheck === false) return null;
    if (!s || !s.repoPath) return null;
    const changes = (result && result.changes) || [];
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
    const written = [...new Map(changes
        .filter(c => c && c.path && c.kind !== "deleted" && !String(c.path).includes(".."))
        .map(c => [norm(c.path), c])).values()];
    if (!written.length) return null;    // a turn that built nothing has no artifacts to check

    const findings = [];

    // 1. OFFLINE: written web files that load from the network
    for (const c of written.slice(0, POST_CHECK_MAX_FILES)) {
        const rel = norm(c.path);
        if (!POST_CHECK_WEB_EXT.has(path.extname(rel).toLowerCase())) continue;
        let body = "";
        try { body = postCheckHeadOf(path.join(s.repoPath, rel)); } catch { continue; }
        const refs = postCheckExternalRefs(body);
        if (refs.length) {
            findings.push(`${rel} loads from the network (${refs.slice(0, 3).join(", ")}`
                + (refs.length > 3 ? ` +${refs.length - 3} more` : "") + `) — it will not work offline.`);
        }
    }

    // 2. FILES: path-like names in the MODEL's reply that do not exist.
    //    A staged approval may legitimately name the file it will create, so
    //    a turn that is waiting on the human is not second-guessed here.
    const staged = ((result && result.pendingApprovals) || []).length > 0;
    const finalMsg = [...((result && result.newMessages) || [])].reverse().find(m =>
        m && m.role === "assistant" && typeof m.content === "string"
        && !(m.meta && POST_CHECK_MACHINE.has(m.meta.model)));
    const finalText = finalMsg ? finalMsg.content : "";
    if (!staged && finalText) {
        const deleted = new Set(changes
            .filter(c => c && c.kind === "deleted" && c.path).map(c => norm(c.path)));
        const noUrls = finalText.replace(/(?:wss?|https?):\/\/[^\s"'<>)]+/gi, " ");
        const missing = [];
        for (const m of noUrls.matchAll(/\b[\w][\w./\\-]{0,80}\.(html?|css|js|mjs|json|md|py|png|jpe?g|svg|txt|csv)\b/gi)) {
            const rel = norm(m[0]);
            // path-like only: "site/app.js" asserts a location, bare
            // "index.html" (or prose like "Node.js") asserts nothing checkable
            if (!rel.includes("/") || rel.includes("..") || missing.includes(rel)) continue;
            // a domain-shaped head ("cdn.jsdelivr.net/…") is a URL, not a path
            if (/^[\w-]+\.[a-z]{2,4}\//i.test(rel)) continue;
            if (deleted.has(rel)) continue;    // truthfully reported as removed
            try { if (!fs.existsSync(path.join(s.repoPath, rel))) missing.push(rel); }
            catch { /* unresolvable name — not a finding */ }
        }
        if (missing.length) {
            findings.push(`The reply names ${missing.slice(0, 6).map(f => `"${f}"`).join(", ")}`
                + (missing.length > 6 ? ` (+${missing.length - 6} more)` : "")
                + ` but ${missing.length === 1 ? "that file does" : "those files do"} not exist in the workspace.`);
        }
    }

    if (!findings.length) return null;
    return {
        text: `Post-check — ${findings.length} finding(s) against this turn's files:\n`
            + findings.map(f => `- ${f}`).join("\n"),
        data: { findings: findings.length, files: written.length }
    };
}

function setSessionStatus(sessionId, state, detail = "") {
    const prev = sessionStatus.get(sessionId);
    sessionStatus.set(sessionId, { state, detail: String(detail).slice(0, 140), at: Date.now() });
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("lcl:sessionStatus",
            { sessionId, state, detail: String(detail).slice(0, 140) });
    }
    // WORKING -> DONE while the user is away is the whole reason the tray
    // exists. Only on the transition, so a status refresh cannot re-notify.
    if (prev && prev.state === "working" && (state === "idle" || state === "failed")) {
        // the DURABLE record of the finish: doneAt on the session file, so the
        // sidebar can tell "finished, not yet read" from "read" — across app
        // restarts, which the in-memory status map above never survives. A
        // failure also keeps its reason (lastError), because a red dot whose
        // "why" evaporated on relaunch explains nothing.
        try {
            const s = sessions.load(sessionId);
            if (s) {
                s.doneAt = Date.now();
                if (state === "failed") {
                    s.lastError = { at: s.doneAt, detail: String(detail).slice(0, 300) };
                }
                sessions.save(s);
            }
        } catch { /* the notification still fires; the stamp heals next turn */ }
        notifyFinished({
            sessionId,
            title: state === "failed" ? ".lcl hit an error" : ".lcl finished",
            body: state === "failed"
                ? (detail || "The last turn failed — open .lcl to see why.")
                : (detail || "Your answer is ready.")
        });
    }
    // the tray is the only surface left when the window is closed — it has to
    // move when the work does
    paintTray();
}

/**
 * IS ANYTHING STILL WAITING ON THE OPERATOR IN THIS SESSION?
 *
 * The "approval" state is only honest while a request is genuinely staged, so
 * clearing it asks the registries rather than guessing from the last thing
 * that happened.
 */
function hasPendingApprovalFor(sessionId) {
    try {
        for (const p of pendingToolApprovals.values()) {
            if (p && String(p.sessionId) === String(sessionId)) return true;
        }
        for (const p of pendingRemoteApprovals.values()) {
            if (p && String(p.sessionId) === String(sessionId)) return true;
        }
    } catch { /* an unknown registry shape means "nothing pending" */ }
    return false;
}


/**
 * TELL THE USER SOMETHING IS WAITING ON THEM.
 *
 * The whole value of background work is not having to watch it. A question that
 * only appears inside a window you are not looking at is not a question, it is a
 * stall — the task sits there and the user finds out twenty minutes later.
 *
 * So: an OS notification, but only when it is genuinely needed. Two rules.
 *
 *   NOT WHEN THE USER IS ALREADY LOOKING. If the window is focused they can see
 *   the card. A notification then is noise, and noise is how notifications get
 *   turned off.
 *
 *   ONLY FOR THINGS THAT BLOCK. A question or an approval halts the work until
 *   answered. Progress does not, and must never notify.
 *
 * Clicking it focuses the window on the session that asked.
 */
function notifyWaiting({ sessionId, title, body, kind, approvalId }) {
    try {
        if (!Notification.isSupported()) return;
        // the session's bell: muted silences the toast AND the chime below —
        // the in-app card and the sidebar dot still show, so nothing blocks
        // silently; it just stops shouting about it
        if (sessionNotifyMuted(sessionId)) return;
        // already watching -> the card in front of them is the notification
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;
        // ACT FROM THE NOTIFICATION ITSELF.
        //
        // "having buttons in that, that can actually execute the logic, that
        //  is important." Approve runs the SAME ipc path the in-app card runs,
        //  with every re-check it performs — the button is a second doorway to
        //  one mechanism, never a shortcut around it. Windows shows actions
        //  only on toasts, so this degrades to click-to-open elsewhere.
        // THE BUTTONS NEVER RENDERED ON WINDOWS. `actions` is documented
        // `@platform darwin` (electron.d.ts), as is the 'action' event — so on
        // the operator's actual machine this whole branch drew nothing and the
        // only thing that ever worked was click-to-open.
        //
        // Windows' own doorway is `toastXml`, whose buttons activate a
        // PROTOCOL. Approving from the toast therefore re-enters the app
        // through lcl://approve/<id>, which lands in the same approveToolById
        // the in-app card calls — a second doorway to one mechanism, never a
        // shortcut around it.
        const win = process.platform === "win32";
        const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const actions = (!win && approvalId)
            ? [{ type: "button", text: "Approve" }, { type: "button", text: "Reject" }]
            : [];
        // EVERY windows waiting-toast is a protocol toast — not only the
        // approval one. The clarify and remote-approval toasts rode the JS
        // "click" event, which Windows drops from Action Center when no
        // shortcut carries our AppUserModelId; their clicks did nothing.
        const toastXml = (win && (approvalId || sessionId)) ? `<toast activationType="protocol" launch="${
            esc("lcl://open/" + (sessionId || ""))}">
  <visual><binding template="ToastGeneric">
    <text>${esc(title || ".lcl needs you")}</text>
    <text>${esc(String(body || "").slice(0, 240))}</text>
  </binding></visual>${approvalId ? `
  <actions>
    <action content="Approve" activationType="protocol" arguments="${
        esc("lcl://approve/" + approvalId)}"/>
    <action content="Reject" activationType="protocol" arguments="${
        esc("lcl://reject/" + approvalId)}"/>
    <action content="Open" activationType="protocol" arguments="${
        esc("lcl://open/" + (sessionId || ""))}"/>
  </actions>` : ""}
  <audio silent="true"/>
</toast>` : undefined;
        const n = new Notification({
            title: title || ".lcl needs you",
            body: String(body || "").slice(0, 240),
            // the app's own sound plays in the renderer; see chime()
            silent: true,
            urgency: "normal",
            actions,
            ...(toastXml ? { toastXml } : {}),
            // macOS needs this for buttons to appear at all; harmless elsewhere
            ...(actions.length ? { hasReply: false } : {})
        });
        if (approvalId) {
            n.on("action", async (_e, index) => {
                const approve = index === 0;
                auditLog.write({ kind: "notification-action", sessionId: sessionId || null,
                                 approvalId, action: approve ? "approve" : "reject",
                                 at: Date.now() });
                try {
                    // the one mechanism, reached from a different doorway
                    const fn = approve ? approveFromNotification : rejectFromNotification;
                    await fn(approvalId);
                } catch { /* the card in the window remains the fallback */ }
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("lcl:focusSession", { sessionId, kind });
                }
            });
        }
        n.on("click", () => focusSession(sessionId, kind, approvalId));
        // only an id this app actually put on a toast may be answered from one
        if (approvalId) toastApprovals.set(approvalId, Date.now());
        n.show();
        // the attention sound, played by the renderer — see chime()
        chime("attention");
        auditLog.write({ kind: "notified", reason: kind, sessionId: sessionId || null,
                         at: Date.now() });
    } catch { /* a notification failing must never affect the work */ }
}

ipcMain.handle("lcl:sessionStatuses", guard(() => {
    const out = {};
    for (const [id, s] of sessionStatus) out[id] = s;
    return { statuses: out };
}));

ipcMain.handle("lcl:cancelChat", guard((_e, sessionId) => {
    // A TURN WAITING FOR THE REMOTE-CALL PROMPT IS STILL A TURN. Stop must end
    // it, or the only way out of an approval card the user has changed their
    // mind about is to wait out the timeout with the session locked.
    if (settleRemoteApprovalFor(sessionId)) return { cancelled: true };
    // cancel THIS session's turn, and ONLY this session's. The old no-id
    // fallback grabbed the first live token of ANY session — with concurrent
    // sessions shipped, that is a Stop in one conversation killing another's
    // work. No id, no cancel.
    const token = sessionId
        ? (turnsBySession.get(sessionId) || approvalsRunning.get(sessionId))
        : null;
    if (!token) return { cancelled: false };
    token.cancelled = true;
    if (typeof token.abort === "function") token.abort();
    return { cancelled: true };
}));

/* ==========================================================================
 * "ASK BEFORE EVERY REMOTE CALL" — the control, actually wired to the call.
 * Contract K3.
 *
 * MEASURED BEFORE THIS EXISTED: `cloudAutoApprove` was written by setBehavior
 * and read back only to paint its own dropdown. Four hits in the whole repo,
 * all of them in main.js or the renderer, and nothing in the agent, the router
 * or cloudModels ever consulted it. The operator selected a spend-and-privacy
 * control, the app said nothing, and he "never saw any escalation attempts. or
 * requests." A control that is believed and does nothing is worse than one
 * that is missing.
 *
 * Worse than that, and also measured by driving the real handler:
 *
 *   node probe-setbehavior.js
 *   setBehavior cloudAutoApprove true  -> {"error":"policy is not defined"}
 *   setBehavior writeMode  confirm     -> {"error":"policy is not defined"}
 *
 * `policy` was never a binding in this file — the module is required as
 * `policyBridge`. guard() turned the ReferenceError into {error}, the renderer
 * swallowed it, so BOTH the remote-call dial and "ask before every write"
 * failed at the last line of their own handler. Fixed at the call sites below.
 *
 * WHERE THE GATE SITS. On the SESSION DRIVER, in lcl:chat, before the turn
 * starts — that is the path a message to a linked API or to the user's own
 * node actually takes, and it was ungated. The other remote path, a LOCAL
 * model escalating through ask_cloud_model, is gated by the policy kernel
 * (EGRESS -> confirm) and stays that way; applyCloudAutoApprove is what
 * relaxes it, and it now actually runs.
 *
 * FAILS CLOSED. No window, no answer, or an unanswerable request means the
 * call does not happen. A spend-and-privacy gate that proceeds when it cannot
 * ask is the guard-that-could-not-fire defect wearing a different hat.
 * ======================================================================== */

const REMOTE_APPROVAL_TIMEOUT_MS = 120_000;
const pendingRemoteApprovals = new Map();       // id -> { id, sessionId, settle }
let remoteApprovalSeq = 0;
// endpoints TRUSTED DURING THE TURN THAT IS STILL RUNNING, per session. The
// end-of-turn save rewrites the whole session file from the turn's own object,
// so it has to tell a grant made mid-turn (keep it) from a revoke made
// mid-turn (honour it) — see the merge block in lcl:chat. Never persisted.
const trustGrantedThisTurn = new Map();         // sessionId -> Set(endpointId)

/** Settle one waiting request by id. Returns whether anything was waiting. */
function settleRemoteApproval(id, verdict) {
    const p = pendingRemoteApprovals.get(String(id || ""));
    if (!p) return false;
    pendingRemoteApprovals.delete(p.id);
    p.settle(String(verdict || "deny"));
    return true;
}

/** Settle whatever this session is waiting on — the Stop button's doorway. */
function settleRemoteApprovalFor(sessionId) {
    // scoped to the NAMED session only — the old `!sessionId ||` denied the
    // first pending approval of whichever session happened to be first
    if (!sessionId) return false;
    for (const p of pendingRemoteApprovals.values()) {
        if (p.sessionId === sessionId) {
            return settleRemoteApproval(p.id, "deny");
        }
    }
    return false;
}

/**
 * What this message is about to cost, BEFORE it is sent — the same instrument
 * the composer's meter uses, asked from here so the approval card states a
 * number rather than asking the user to consent to an unknown.
 *
 * AND WHEN IT IS NOT KNOWN, IT SAYS SO. tokenCost returns inputUsd: null for a
 * model it has no rate for. Flattening that to 0 would put "$0" on the card for
 * a call that may cost real money — the same shape of lie as a guard that
 * reports a size nobody measured. So estCostUsd stays a NUMBER (a card that
 * formats it cannot break) and `estCostKnown` carries whether it means
 * anything. $0 with estCostKnown true is a genuine zero: the user's own
 * node, where the rate is known and it is free.
 */
function estimateRemoteCost(s, sel, text) {
    try {
        const localNode = cloudModels.isNodeEndpoint(sel);
        // the standing context is most of the input on any turn past the first,
        // so an estimate that ignored it would understate the cost of exactly
        // the messages that cost the most. Only the tail of it: this runs on
        // the reply path and a long conversation must not be re-joined whole
        // to produce a number that is an estimate either way.
        let chars = 0;
        for (const m of (s.messages || []).slice(-60)) {
            chars += String((m && m.content) || "").length;
        }
        // counted, not re-materialised: this model's own learned ratio, applied
        // to a character count, is exactly what estimateTokens would do
        const contextTokens = Math.round(chars / (tokenCost.charsPerToken(sel.model) || 4));
        const est = tokenCost.estimateCost(String(text || ""), sel.model,
            { contextTokens, localNode });
        return {
            estCostUsd: Number(est.inputUsd) || 0,
            estCostKnown: est.inputUsd !== null && est.inputUsd !== undefined,
            estInputTokens: est.inputTokens || 0,
            costNote: est.note || null,
            localNode
        };
    } catch {
        return { estCostUsd: 0, estCostKnown: false, estInputTokens: 0,
                 costNote: "the cost of this call could not be estimated",
                 localNode: false };
    }
}

/**
 * Ask, and wait. Resolves { allowed, verdict } and never throws.
 */
async function askRemoteApproval(s, sel, text, extra = {}) {
    const destination = (() => {
        try { return cloudModels.destinationOf(sel); } catch { return null; }
    })();
    const id = `ra-${Date.now().toString(36)}-${++remoteApprovalSeq}`;
    const req = {
        id, sessionId: s.id,
        model: sel.model, endpoint: sel.label,
        destination, ...estimateRemoteCost(s, sel, text),
        // A FALLBACK ASK NAMES ITSELF. `extra` carries { fallback: true,
        // reason, fellBackFrom } so the card can say "spark refused this —
        // send it to X instead?" rather than looking like the ask the
        // operator already answered. An approval for "$0, your machine" was
        // treated as covering "real money, somebody else's" eight times;
        // this is the question that was never put.
        ...extra
    };
    auditLog.write({ kind: "remote-approval-asked", session: s.id, model: sel.model,
                     endpoint: sel.label, estCostUsd: req.estCostUsd,
                     estCostKnown: req.estCostKnown, at: Date.now() });

    if (!mainWindow || mainWindow.isDestroyed()) {
        return { allowed: false, verdict: "no-window", request: req };
    }

    const verdict = await new Promise((resolve) => {
        let done = false;
        let timer = null;
        // ONE EXIT, AND IT ALWAYS CLEANS UP. An early settle that left the id in
        // the map would leave a dead request for a later Stop to "cancel",
        // which is the kind of ghost that makes a gate untrustworthy.
        const settle = (v) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            pendingRemoteApprovals.delete(id);
            // THE CARD MUST DIE WITH THE QUESTION. Anything that settles this
            // ask WITHOUT the operator answering it — the 120s timeout, Stop,
            // a closed window — used to leave the card floating: its buttons
            // still live, its queue still blocked behind it, and answering it
            // later printed "sent once" for a turn that was denied minutes
            // ago. The renderer is told, so it can withdraw the card and say
            // what happened.
            if (v !== "once" && v !== "always" && v !== "trust") {
                try {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send("lcl:remoteApprovalWithdrawn",
                            { id, sessionId: s.id, reason: v });
                    }
                } catch { /* the renderer's own guard is the backstop */ }
            }
            resolve(v);
        };
        timer = setTimeout(() => settle("timeout"), REMOTE_APPROVAL_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        pendingRemoteApprovals.set(id, { id, sessionId: s.id, settle });
        try {
            mainWindow.webContents.send("lcl:remoteApproval", req);
        } catch { settle("no-window"); }
        // the window may not be the thing they are looking at — but the
        // toast has an off-switch (Session › Permissions), honoured here
        if (paths.readSettings().consentNotify !== false) {
            notifyWaiting({
                sessionId: s.id, kind: "remote-approval",
                title: (s.title || "Session") + " wants to send a message out",
                body: `${sel.model} on ${sel.label} — ` + (req.estCostKnown
                    ? `about ${tokenCost.usd(req.estCostUsd) || "$0"} of input`
                    : "cost unknown for this model")
            });
        }
    });

    // THERE IS NO "ALWAYS, EVERY SESSION" ANY MORE. It wrote a global switch —
    // one click on one card disarming the gate for every conversation on the
    // machine, including ones not open yet. The operator's rule is that a
    // permission belongs to the conversation that granted it, so the widest
    // answer this card offers is "this conversation", and it is stored on the
    // session. A verdict of "always" can no longer arrive (the button is gone);
    // if an old renderer sends one it is treated as the session-scoped grant
    // rather than silently widened.
    if (verdict === "always") {
        try {
            const p = { ...(s.perms || {}), askRemote: false };
            s.perms = p;
            sessions.save(s);
        } catch { /* the call is still approved; the switch reasserts next time */ }
    }
    // "TRUST" IS PER-SESSION, PER-ENDPOINT — the missing middle. "once" asks
    // every turn and "always" disarms the gate for every endpoint on earth;
    // trust silences THIS endpoint for THIS conversation only. A new session
    // asks, a different endpoint asks, and the global switch is untouched.
    // Measured in a real audit log: a user answered "once" twenty
    // times in a row for one endpoint, then flipped the global to make it
    // stop — and then no ask appeared at all, for anything.
    if (verdict === "trust") {
        try {
            // MUTATE THE HANDLER'S OWN s, not a fresh load. lcl:chat saves its
            // session at end-of-turn (sessions.save(s)), so a fresh copy saved
            // here would be overwritten a moment later — and trust would vanish
            // before the next turn. s is the same object reference the handler
            // holds, so this survives its save too.
            if (!Array.isArray(s.trustedEndpoints)) s.trustedEndpoints = [];
            const eid = (sel && sel.id) || (sel && sel.label) || null;
            if (eid && !s.trustedEndpoints.includes(eid)) {
                s.trustedEndpoints.push(eid);
                // remembered so the end-of-turn merge can tell a grant made
                // DURING this turn from one the disk copy simply predates
                if (!trustGrantedThisTurn.has(s.id)) trustGrantedThisTurn.set(s.id, new Set());
                trustGrantedThisTurn.get(s.id).add(eid);
                sessions.save(s);
            }
        } catch { /* the call is still approved; the trust re-asserts next time */ }
    }
    auditLog.write({ kind: "remote-approval-answered", session: s.id, model: sel.model,
                     endpoint: sel.label, verdict, at: Date.now() });
    return { allowed: verdict === "once" || verdict === "always" || verdict === "trust",
             verdict, request: req };
}

/**
 * The renderer's answer. "once" | "always" | "deny" — anything else is a deny,
 * because an unrecognised verdict on a safety gate may only ever mean no.
 */
ipcMain.handle("lcl:answerRemoteApproval", guard((_e, id, verdict) => {
    const v = String(verdict || "");
    // THREE VERDICTS, not two. "once" asks again next turn; "always" is the
    // global master override; "trust" is the per-session, per-endpoint middle
    // the operator asked for ("allow / trust / only this once") — the one that
    // was missing, which is why the user flipped cloudAutoApprove globally and then
    // no ask appeared at all. Anything else is a deny: an unrecognised verdict
    // on a safety gate may only ever mean no.
    const clean = (v === "once" || v === "always" || v === "trust") ? v : "deny";
    const found = settleRemoteApproval(id, clean);
    return { ok: found, verdict: clean,
             error: found ? undefined : "that request is no longer waiting" };
}));

/* --------------------------------------------------------------------------
 * A.5 — THE SECRET-EGRESS ASK. A shared session about to send a DETECTED
 * secret out stops here. Same round-trip shape as the remote-call ask: a
 * pending-promise keyed by id, a card in the renderer, and a hard fail-closed
 * (redact) on timeout or a missing window — a broken prompt must never send a
 * secret.
 * ------------------------------------------------------------------------ */
const pendingSecretEgress = new Map();          // id -> settle(action)
let secretEgressSeq = 0;
async function askSecretEgress(s, dest, reasons) {
    if (!mainWindow || mainWindow.isDestroyed()) return { action: "redact" };
    const id = `se-${++secretEgressSeq}`;
    const req = { id, sessionId: s.id, destination: dest || null,
                  reasons: (reasons || []).slice(0, 3) };
    auditLog.write({ kind: "secret-egress-asked", session: s.id,
                     destination: dest && dest.label, at: Date.now() });
    const action = await new Promise((resolve) => {
        let done = false;
        const settle = (a) => {
            if (done) return;
            done = true;
            pendingSecretEgress.delete(id);
            resolve(a);
        };
        pendingSecretEgress.set(id, settle);
        // fail CLOSED — an unanswered ask redacts, never sends
        const timer = setTimeout(() => settle("redact"), 120_000);
        if (timer.unref) timer.unref();
        try { mainWindow.webContents.send("lcl:secretEgress", req); }
        catch { settle("redact"); }
    });
    auditLog.write({ kind: "secret-egress-answered", session: s.id,
                     action, destination: dest && dest.label, at: Date.now() });
    return { action };
}
ipcMain.handle("lcl:answerSecretEgress", guard((_e, id, action) => {
    const settle = pendingSecretEgress.get(String(id || ""));
    // an unrecognised answer on a secret gate may only ever mean redact
    const clean = (action === "send" || action === "cancel") ? action : "redact";
    if (settle) settle(clean);
    return { ok: !!settle, action: clean };
}));

/* --------------------------------------------------------------------------
 * THE LEDGER MUST SHOW WHAT WAS TRIED, NOT ONLY WHAT SUCCEEDED.
 *
 * REPORTED: "Spend captured none of the API attempts." It is true and the
 * cause is one line in the agent loop: the ledger row is written only
 * `if (result.remote && result.usage)`. A call that timed out, was refused by
 * the provider, was stopped by the user, or came back without a usage block
 * leaves NO trace in the one place the operator goes to ask what happened —
 * so an evening of failing API calls reads as an evening of doing nothing.
 *
 * So: this handler knows the destination and can see whether the turn produced
 * a ledger row. When a remote turn ends without one, the attempt is recorded
 * with real zeroes — no invented tokens, no invented dollars — and the outcome
 * in `via`, which is the only free-form field ledger.record() passes through
 * (that module is not this agent's file to widen). The existing Transactions
 * table renders it as an ordinary $0 row rather than dropping it, and the
 * average-composition readout is deliberately left untouched: a zeroed
 * composition would drag that average down, and a fix that damages a working
 * readout is not a fix.
 * ------------------------------------------------------------------------ */
function recordRemoteAttempt(s, sel, outcome, detail) {
    try {
        if (!sel || !sel.model) return null;
        const row = ledger.record({
            sessionId: s.id, sessionTitle: s.title || null,
            model: sel.model, endpoint: sel.label || null,
            inputTokens: 0, outputTokens: 0, usd: 0,
            via: "attempt-" + String(outcome || "failed"),
            localNode: (() => {
                try { return cloudModels.isNodeEndpoint(sel); } catch { return false; }
            })()
        });
        auditLog.write({ kind: "remote-attempt", session: s.id, model: sel.model,
                         endpoint: sel.label || null, outcome: String(outcome || "failed"),
                         detail: String(detail || "").slice(0, 200), at: Date.now() });
        return row;
    } catch { return null; }      // bookkeeping never breaks a turn
}

ipcMain.handle("lcl:chat", async (_e, id, content, chatOpts) => {
    // a CONTINUATION resumes the turn the user already started (e.g. after an
    // approved script ran) — no new user message, no re-brief, the model picks
    // up from the transcript it already has
    const continueTurn = !!(chatOpts && chatOpts.continuation);
    // An approval running in THIS session mutates the same session file outside
    // this handler's lock, so it excludes a new turn here — and only here.
    if (approvalsRunning.has(id)) {
        return { error: "an approved action is still running in this session — stop it or wait" };
    }
    // ONE TURN PER SESSION — but an afterthought is not a second turn.
    //
    // "hypothetically if the user inputs a request, and the model is thinking,
    //  and then the user had an afterthought ... i do not want a queue. what i
    //  want is for that message to be added to ancient knowledge per that
    //  session, so when the model responds, ancient knowledge is ready to
    //  respond to the model, with the original request, and the after thoughts
    //  the user had. this happens often, and it beats a queue because a queue
    //  answers in order."
    //
    // So a message sent into a working session with Ancient Knowledge on is
    // captured as an ADDENDUM to the ask being answered right now. The
    // interrogation reads it as part of the original request, which is what
    // makes "did you do everything?" cover it. Without AK there is nothing to
    // carry it, and the honest answer is still the refusal below.
    if (turnsBySession.has(id)) {
        const live = sessions.load(id);
        if (live && live.ancientKnowledge === true) {
            const text = String(content || "").slice(0, 4000).trim();
            if (!text) return { error: "message is empty" };
            const list = sessionAddenda.get(id) || [];
            if (list.length >= 10) {
                return { error: "that is a lot of afterthoughts — let this turn finish" };
            }
            list.push(text);
            sessionAddenda.set(id, list);
            auditLog.write({ kind: "addendum", session: id,
                             n: list.length, chars: text.length, at: Date.now() });
            return { ok: true, addendum: true, count: list.length };
        }
        return { error: "this session is already replying — open another session or wait" };
    }
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };

    const text = String(content || "").slice(0, 32_000);
    if (!text.trim()) return { error: "message is empty" };

    if (s.repoPath && !fs.existsSync(s.repoPath)) {
        s.repoPath = null;
        // AND THE BRAIN GOES OFF WITH IT. Ancient Knowledge cannot be enabled
        // without a linked folder — that is enforced when you switch it on —
        // so leaving the flag set here left it enabled with nowhere to write:
        // it would audit, bill for the auditor, and drop ancient_knowledge.md
        // on the floor. Unlinking from the sidebar already does this; the
        // folder disappearing underneath the session has to do it too.
        s.ancientKnowledge = false;
        sessions.save(s);
        return { error: "the linked folder no longer exists — it has been unlinked" };
    }

    // THE MODEL THIS SESSION CHOSE IS THE MODEL THAT ANSWERS IT.
    //
    // One machine, one llama-server, one resident model — so if this session
    // chose a local gguf and a DIFFERENT one is loaded (because another
    // session picked it, or the memory guard swapped it), the choice would
    // quietly be answered by the wrong model.
    //
    // LOADING IT IS NOT ENOUGH. The engine's queue orders GENERATIONS, not
    // residency: session A loads X and starts its turn, session B loads Y
    // between A's tool calls, and A's next generation runs on Y. So a turn
    // that named a specific local model holds the residency gate for its whole
    // length. Local turns already queue on one llama-server — that is the
    // physics this makes honest, not a new restriction. Remote sessions never
    // touch this gate and stay wide.
    // freed in the same finally that releases the turn, so a thrown turn can
    // never strand the machine's one resident model behind a dead session
    let releaseResidency = null;
    // orchestration first: an assigned model for this kind of work DRIVES the
    // turn; everything downstream (the K3 spend gate, health, limits, the
    // orchestrate decision, the audit) reads the routed selection
    // ATTACHMENTS RIDE THIS TURN — consumed off the turn's own copy, and only
    // below the vanished-folder save above: a FAILED turn never saves, so the
    // chips survive on disk and a retry still carries them.
    const atts = Array.isArray(s.stagedAttachments) ? s.stagedAttachments : [];
    s.stagedAttachments = [];
    const taskRoute = resolveTaskRoute(s, text);
    const orchRoute = taskRoute.route;
    const drive = orchRoute || cloudModels.resolveSelection(s);
    // FALLBACK PREFERS THE PLAN — through the router's own seam
    // (resolveFallback opts.preferred), because reordering escalateTo was
    // provably inert: every consumer reads the list as a SET. The allowlist
    // still gates it downstream; a plan model that is not ticked never runs.
    const planFallback = taskRoute.assigned && taskRoute.assigned.endpointId
        ? { endpointId: taskRoute.assigned.endpointId, model: taskRoute.assigned.model }
        : null;
    // parsed, not read raw: a session saved before the structured form still
    // carries a bare model id, and reading `.local` off a string finds nothing
    const chosenLocal = (() => {
        const raw = s.modelSel;
        if (!raw) return null;
        if (typeof raw === "string") return raw.startsWith("api:") ? null : raw;
        return raw.local ? String(raw.local) : null;
    })();

    /* ---- K3: ASK BEFORE THIS CALL LEAVES THE MACHINE ------------------- */
    // Three ways a call may proceed without a card: the global master override
    // (cloudAutoApprove), a per-session per-endpoint trust (the "trust" verdict
    // — the middle answer that was missing), or a local model (not remote).
    // A new session asks. A different endpoint asks. The global is untouched by
    // trust, so the two cannot disagree.
    const trustedHere = drive.sel && Array.isArray(s.trustedEndpoints)
        && (drive.sel.id || drive.sel.label)
        ? s.trustedEndpoints.includes(drive.sel.id || drive.sel.label)
        : false;
    // A SEND THAT SKIPS THE ASK STILL LEAVES A MARK. Knowing a message left the
    // machine is the whole point of the gate — once trust is granted the card
    // rightly stops appearing, and with it went every per-send indication.
    // The renderer draws a quiet line instead, with the revoke on it.
    if (drive.sel && trustedHere) {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("lcl:remoteSendAllowed", {
                    sessionId: id, model: drive.sel.model,
                    endpoint: drive.sel.label,
                    endpointId: drive.sel.id || drive.sel.label,
                    destination: (() => {
                        try { return cloudModels.destinationOf(drive.sel); } catch { return null; }
                    })()
                });
            }
        } catch { /* the ledger still records the call */ }
    }
    // NOTHING IS APP-WIDE. This read a global cloudAutoApprove, so one answer
    // on one card silenced the gate for every conversation — and the
    // Permissions sheet had to describe it as app-wide, which is the thing
    // ruled out more firmly than any other: all permissions are session
    // specific, nothing is app wide.
    // The switch is this conversation's own now.
    const asksHere = sessionPerms.forSession(s).askRemote;
    if (drive.sel && !trustedHere && asksHere) {
        // Registered as this session's live turn for the length of the ask, so
        // the sidebar says why it is stalled, a second message cannot start a
        // parallel turn behind the card, and Stop can end it.
        const waitToken = { cancelled: false, awaitingApproval: true };
        turnsBySession.set(id, waitToken);
        setSessionStatus(id, "approval", `approve sending to ${drive.sel.label}`);
        let ask;
        try {
            ask = await askRemoteApproval(s, drive.sel, text);
        } finally {
            turnsBySession.delete(id);
        }
        if (!ask.allowed) {
            const why = ask.verdict === "deny" ? "you did not approve it"
                : ask.verdict === "timeout" ? "the approval request went unanswered"
                : "there was no window to ask in";
            // THE ATTEMPT IS STILL AN ATTEMPT. It is exactly what the operator
            // asked the ledger to show him.
            recordRemoteAttempt(s, drive.sel, ask.verdict === "timeout" ? "timeout" : "denied", why);
            setSessionStatus(id, "idle", "not sent");
            return { error: `Not sent to ${drive.sel.label}: ${why}. ` +
                `Send again and answer "Allow for this conversation" to stop ` +
                `being asked; Session › Permissions shows what this ` +
                `conversation already trusts and can take it back.`,
                     cancelled: true, remoteDenied: true, verdict: ask.verdict };
        }
    }

    // What the ledger looked like before this turn, so a remote turn that ends
    // without a row can be told apart from one that recorded its own spend.
    const spendRowsBefore = drive.sel ? ledger.forSession(id).calls : 0;

    if (!drive.sel && chosenLocal) {
        const want = chosenLocal;
        const st = engine.status();
        const loaded = (st && st.running && st.modelInfo && st.modelInfo.id) || null;
        if (loaded !== want) {
            const r = await loadLocalModel(want);
            if (r && r.error) {
                // said plainly rather than answered by the wrong model
                setSessionStatus(id, "failed", "the chosen model could not load");
                return { error: `${want} could not be loaded: ${r.error}` };
            }
            // A RECOVERY IS NOT THE MODEL YOU ASKED FOR. loadLocalModel falls
            // back to something that fits rather than leaving the machine with
            // nothing loaded — correct for the app, and NOT a licence to answer
            // this conversation on a model it did not choose and never hear
            // about it.
            if (r && r.recovered) {
                setSessionStatus(id, "failed", "the chosen model did not fit");
                return { error: `${want} could not be loaded on this machine right ` +
                    `now, so it was not used. A model that fits is loaded instead — ` +
                    `pick it for this conversation, or free some memory and try again.` };
            }
        }
        releaseResidency = await holdLocalResidency(want);
    }

    const cancelToken = { cancelled: false };

    const onProgress = (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("lcl:progress", { sessionId: s.id, ...info });
        }
        // keep the sidebar's sense of "working" current with the real phase
        if (info && info.phase === "clarify") {
            setSessionStatus(id, "waiting", "asked you a question");
            notifyWaiting({ sessionId: s.id, kind: "clarify",
                title: (s.title || "Session") + " has a question",
                body: (info.detail && info.detail.question) || "It needs a detail from you." });
        } else if (info && info.phase === "needs-approval") {
            setSessionStatus(id, "approval", "waiting for your approval");
            notifyWaiting({ sessionId: s.id, kind: "approval",
                title: (s.title || "Session") + " needs approval",
                body: (info.detail && info.detail.tool)
                    ? `${info.detail.tool} is waiting for you to approve it.`
                    : "An action is waiting for your approval.",
                // carries the Approve / Reject buttons
                approvalId: (info.detail && info.detail.approvalId) || null });
        } else if (info && info.phase === "audit" && info.detail
                   && info.detail.phase === "ancient-knowledge") {
            // THE SIDEBAR SAYS THE AUDITOR IS ALIVE. A long orchestrated goal
            // spends real minutes in here, and every one of them used to read
            // as a flat "thinking" — so an audit that WAS running looked
            // exactly like a session that had wandered off. The round counter
            // is the cheapest possible proof of life.
            setSessionStatus(id, "working",
                `Ancient Knowledge · round ${info.detail.round}` +
                (info.detail.of ? ` of ${info.detail.of}` : ""));
        }
    };
    const onTask = (task) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("lcl:task", { sessionId: s.id, ...task });
        }
    };

    // A multi-step build in a linked folder goes through the ORCHESTRATOR: it
    // plans, then executes each step as a focused sub-turn, streaming the plan
    // to the task panel. A correction that continues a build ("try again, that
    // is not a site") routes here too, planned against the ORIGINAL request.
    // THE ORCHESTRATOR IS FOR SMALL LOCAL MODELS. It exists to break a build
    // goal into steps a 1.5B model can survive, with a critic checking each
    // one. A frontier model NEEDS none of that — it plans inside its own
    // reasoning and runs many tool steps per message — and being hijacked into
    // the step machine is how a conversational request ("we could start with
    // the microphone...") died as "Ran 1 steps but wrote no files — the model
    // may need a clearer goal": watched live, the single worst reply in the
    // session. The agent loop with remote limits IS the orchestrator for a
    // capable model.
    // ASKED OF THIS SESSION'S DRIVER, not the app's. The step machine exists
    // for a small LOCAL model; a session on a frontier endpoint must not be
    // pushed into it because the app default happens to be local — nor a
    // session on the local engine skip it because the default happens to be
    // remote. Both were possible while this read the global answer.
    // WHO MAY RUN THE STEP MACHINE.
    //
    // LOCAL always could. A NODE may now too — a linked node such as a DGX Spark
    // exists specifically to run agents offline, and the old `!usingRemote` gate
    // excluded it along with every paid API, so the node got one turn and the
    // 64-step budget the router already sized for it was never reached. An API
    // driver is still bypassed BY DEFAULT: a frontier model plans inside its
    // own reasoning and being hijacked into the step machine is how a
    // conversational request died as "ran 1 step, wrote nothing". A session
    // may opt an API driver in with the per-session `agentMode` permission,
    // for the work where a plan of focused sub-turns genuinely helps.
    const driveIsNode = drive.sel && (() => {
        try { return cloudModels.isNodeEndpoint(drive.sel); } catch { return false; }
    })();
    // read the EFFECTIVE permission (default-on), not the raw stored flag —
    // an unset session inherits the default, so agent mode is on unless the
    // operator explicitly turned it off
    const apiAgentMode = drive.sel && !driveIsNode
        && sessionPerms.forSession(s).agentMode === true;
    const orchestrate = !!s.repoPath && orchestrator.looksMultiStep(text, s)
        && (!router.usingRemote(drive.sel) || driveIsNode || apiAgentMode)
        // an attachment turn runs the plain agent loop — runGoal's step turns
        // cannot carry the appendix yet, so the step machine would drop it
        && atts.length === 0;

    // THE QUESTION THE FALLBACK PATH NEVER ASKED. When the model this session
    // picked cannot answer and the router wants to re-run the turn somewhere
    // else, this is the same K3 card as any other remote send — with the
    // refusal reason on it and the REAL destination named. The router refuses
    // to reroute to anywhere the operator does not own without this answering
    // yes. Approving "mistral-large on spark, $0" stops being a blank cheque
    // for "Qwen on api.deepinfra.com, real money". One function, handed to
    // both the chat turn and the orchestrator's step turns.
    const approveFallback = async (q) => {
        const target = q.selection || { model: q.model, label: q.endpoint };
        const ask = await askRemoteApproval(s, target, text, {
            fallback: true,
            reason: String(q.reason || "").slice(0, 300),
            fellBackFrom: q.fellBackFrom || null
        });
        return ask.allowed;
    };

    // A.5 — the secret-egress asker, handed to the send path the same way. The
    // engine calls it with { reasons, destination } the moment a shared session
    // is about to send a detected secret; it blocks on a card and returns the
    // verdict. Absent, the send path lets the standing grant stand; a broken or
    // unanswered card fails closed to redact.
    const approveSecretEgress = async (info) =>
        askSecretEgress(s, info && info.destination, info && info.reasons);

    // THE LOCK GOES ON IMMEDIATELY BEFORE THE TRY THAT RELEASES IT. It used to
    // be set seventy lines up, before this function's helpers were even
    // defined — so any throw in between (setSessionStatus has thrown; the
    // orchestrator's step-detector can) left the session permanently claiming
    // "already replying" with restart as the only cure. Nothing between the
    // old site and this one awaits, so no second turn can slip in; the only
    // change is that every path that sets the lock now provably reaches the
    // finally that clears it.
    let result;
    turnsBySession.set(id, cancelToken);
    try {
        setSessionStatus(id, "working", "thinking");
        // WHAT ANCIENT KNOWLEDGE NEEDS, ON EITHER PATH. These three used to be
        // passed only to runTurn, so even after the orchestrator learned to
        // audit it would have run with no chosen auditor, the engine's own
        // budget constant instead of the operator's setting, and blind to
        // afterthoughts. The audit is one feature; it gets one set of inputs.
        const akOpts = {
            // which model runs the Ancient Knowledge audit — undefined means
            // "same as this conversation" (the default), a resolved
            // selection or the "local" sentinel means a chosen auditor
            auditorSelection: resolveAuditorSelection(s),
            // WHAT AN AUDITED TURN MAY SPEND. The engine's ceiling was
            // documented as a "default" while nothing in the app could
            // change it — a knob that exists only in tests is not a knob.
            // Settings own it; absent or unparseable falls back to the
            // engine's own constant.
            akBudgetUsd: (() => {
                const v = Number(paths.readSettings().ancientBudgetUsd);
                return Number.isFinite(v) && v >= 0 ? v : undefined;
            })(),
            // read live, not captured: an afterthought sent DURING this
            // turn has to reach the interrogation that judges it
            get addenda() { return sessionAddenda.get(id) || []; }
        };
        if (orchestrate) {
            // the orchestrator owns the transcript for this turn: it records
            // the user goal (so its steps have context) and its summary. The
            // resolved goal turns a bare "try again" into the real build ask.
            const goal = orchestrator.resolveGoal(text, s);
            result = await orchestrator.runGoal(s, text, {
                onProgress, onTask, cancelToken, planGoal: goal, approveFallback,
                approveSecretEgress,
                // THE ROUTED DRIVE REACHES THE MODEL. Both runners re-resolve
                // from the session when selection is undefined, which silently
                // dropped an orchestration route at the last hop — the gates
                // read the routed model while the generation ran on the
                // session's own. Passed explicitly, always, so resolution is
                // single-sourced here.
                selection: drive.sel,
                preferredFallback: planFallback,
                auditorSelection: akOpts.auditorSelection,
                akBudgetUsd: akOpts.akBudgetUsd,
                get addenda() { return sessionAddenda.get(id) || []; } });
        } else {
            result = await agent.runTurn(s, text, {
                // this turn's attachments, and the staging root that keeps
                // already-staged copies readable on LATER turns (@attachments/)
                attachments: atts, attachRoot: attachmentsDirFor(s.id),
                continuation: continueTurn,
                onProgress, cancelToken,
                selection: drive.sel,
                preferredFallback: planFallback,
                // a tool wrote into an already-added library: reindex it on the
                // spot, with the same task row and concurrency guard as any
                // other index run
                onLibraryDirty: (lib) => { try { runReindex(id, lib); } catch { /* reported by the ledger */ } },
                approveFallback,
                approveSecretEgress,
                auditorSelection: akOpts.auditorSelection,
                akBudgetUsd: akOpts.akBudgetUsd,
                // read live, not captured: an afterthought sent DURING this
                // turn has to reach the interrogation that judges it. Spread
                // would defeat that — it evaluates the getter once, here.
                get addenda() { return sessionAddenda.get(id) || []; }
            });

            // THE AUDIT IS NOT AN ORCHESTRATOR-ONLY FEATURE.
            //
            // This comment used to claim the orchestrator "runs only for a
            // LOCAL driver". It has not been true since nodes and agent-mode
            // APIs were added to the fork above (driveIsNode, apiAgentMode),
            // and believing it is how Ancient Knowledge ended up wired into
            // one path only: a node-driven build looked like a chat turn on
            // paper and went through runGoal in fact. Both branches audit
            // now, and both reach the same module.
            //
            // This is the runTurn side: a plain chat turn, or a driver the
            // fork sent here. Same module, same reviewers, same termination
            // rule, reached from the other side.
            // NOT WHEN THE TURN IS WAITING ON THE HUMAN. A turn that asked a
            // question, or staged an action for approval, is not finished work
            // — reviewing it holds the session lock while the operator's answer
            // is the next thing that should happen, and a repair would act on
            // a decision they have not made yet.
            const asked = (result && (result.newMessages || [])
                .some(m => m.meta && m.meta.clarify));
            const stagedHere = (result && (result.pendingApprovals || []).length) > 0;
            // A MODE, NOT A HABIT. The review panel is capacity this session can
            // be put into for work that earns it — a repo being read and
            // modified — and it stays off everywhere else unless asked for.
            const reviewOn = sessionPerms.selfReviewOn(
                s, paths.readSettings().selfReview === true);
            if (reviewOn && result && result.ok && (result.changes || []).length && s.repoPath
                && !cancelToken.cancelled && !asked && !stagedHere) {
                const audit = await orchestrator.runAuditPass(s, {
                    goal: text, changes: result.changes,
                    // this session's model, and the width THAT model allows —
                    // a panel sized from the app default would run four
                    // concurrent generations against one resident local model
                    selection: drive.sel,
                    width: orchestrator.stepConcurrency(drive.sel),
                    cancelToken, onTask, onProgress
                });
                if (audit.ran) {
                    // repairs are real changes to this turn's work — merged by
                    // path so the transcript's revert affordance still covers
                    // every file the turn touched
                    const byPath = new Map((result.changes || []).map(c => [c.path, c]));
                    for (const c of audit.changes || []) if (c && c.path) byPath.set(c.path, c);
                    result.changes = [...byPath.values()];
                    // ONLY WHAT THE REPAIRS WROTE. runTurn already recorded
                    // this turn's own changes on the session; appending the
                    // audit's merged list put every file in twice, doubling
                    // the revert affordances for a single edit.
                    if ((audit.repairChanges || []).length) {
                        s.changes = [...(s.changes || []), ...audit.repairChanges].slice(-200);
                    }
                    // an action the repair staged is still an action awaiting a
                    // human — it joins this turn's approvals rather than being
                    // built and dropped
                    if ((audit.pendingApprovals || []).length) {
                        result.pendingApprovals = [...(result.pendingApprovals || []),
                                                   ...audit.pendingApprovals];
                    }
                    // and the verdict goes in the transcript, on its own line,
                    // where the operator reads the answer — not only in a task
                    // row that scrolls away
                    const note = [audit.summary,
                        (audit.remaining || []).length
                            ? `Still open after review:\n${selfAudit.findingsText(audit.remaining)}`
                            : ""].filter(Boolean).join("\n\n");
                    if (note) {
                        const auditMsg = { role: "assistant", content: note,
                                           meta: { model: "self-audit",
                                                   audit: { rounds: audit.rounds.length,
                                                            stopped: audit.stopped,
                                                            repaired: audit.repaired.length,
                                                            open: (audit.remaining || []).length,
                                                            contested: (audit.contested || []).length,
                                                            usd: audit.spend && audit.spend.priced
                                                                ? audit.spend.usd : 0 } } };
                        s.messages.push(auditMsg);
                        result.newMessages = [...(result.newMessages || []), auditMsg];
                    }
                }
            }
        }
    } catch (err) {
        setSessionStatus(id, "failed", String(err.message || err).slice(0, 100));
        // A THROWN REMOTE TURN IS AN ATTEMPT THAT LEFT NO TRACE. It does now.
        if (drive.sel && ledger.forSession(id).calls === spendRowsBefore) {
            recordRemoteAttempt(s, drive.sel, "failed", String(err.message || err));
        }
        return { error: String(err.message || err) };
    } finally {
        turnsBySession.delete(id);
        // the afterthoughts belonged to THIS turn; the next message is a
        // message again, not an addendum to something already answered
        sessionAddenda.delete(id);
        if (releaseResidency) { try { releaseResidency(); } catch { /* already freed */ } }
    }

    if (!result.ok) {
        setSessionStatus(id, result.cancelled ? "idle" : "failed",
            result.cancelled ? "stopped" : String(result.error || "").slice(0, 100));
        if (drive.sel && ledger.forSession(id).calls === spendRowsBefore) {
            recordRemoteAttempt(s, drive.sel,
                result.cancelled ? "cancelled" : "failed", result.error);
        }
        return { error: result.error, cancelled: !!result.cancelled };
    }
    // THE REFUSED MODEL GETS ITS ROW EVEN WHEN A FALLBACK BILLED MID-TURN.
    // The old backstop below only fired when the turn left the ledger
    // untouched — and a fallback's own row counted as "touched", so the one
    // model the operator actually picked was the only model with no trace
    // anywhere. Eight mistral refusals were invisible for exactly this reason.
    if (drive.sel && result.fellBack) {
        recordRemoteAttempt(s, drive.sel, "refused-fell-back",
            result.fellBack.reason || "the selected model could not answer");
        auditLog.write({ kind: "fallback-fired", session: s.id,
                         from: `${drive.sel.model} on ${drive.sel.label}`,
                         to: result.fellBack.model
                             ? `${result.fellBack.model} on ${result.fellBack.endpoint || "?"}`
                             : null,
                         reason: String(result.fellBack.reason || "").slice(0, 300),
                         at: Date.now() });
    }
    // A REMOTE TURN THAT SUCCEEDED AND BILLED NOTHING is still worth a row: it
    // means the provider returned no usage block, or the answer never came from
    // the endpoint this session is pointed at. Both are things the operator has
    // been trying to see, and both currently look identical to "no calls made".
    else if (drive.sel && ledger.forSession(id).calls === spendRowsBefore) {
        recordRemoteAttempt(s, drive.sel, "unbilled",
            "the turn completed but the endpoint reported no token usage");
    }

    // THE DETERMINISTIC GATE — every turn that wrote files, no model in the
    // loop. Both paths (orchestrated and chat) converge here. It asserts only
    // what disk can prove — network loads in written web files, phantom paths
    // in the reply; judging prose stays with the model-graded reviews. The
    // finding rides the transcript like the self-audit note; failure of the
    // CHECK must never sink a finished turn.
    try {
        const post = postCheckTurn(s, result);
        if (post) {
            const pcMsg = { role: "assistant", content: post.text,
                            meta: { model: "post-check", postCheck: post.data } };
            s.messages.push(pcMsg);
            result.newMessages = [...(result.newMessages || []), pcMsg];
            auditLog.write({ kind: "post-check", session: s.id,
                             findings: post.data.findings, files: post.data.files,
                             at: Date.now() });
        }
    } catch { /* the gate reports on the work; it never becomes the failure */ }

    // confirm-class tool calls staged this turn become approvable: the card
    // in the transcript carries the id, and ONLY lcl:approveTool can run it
    let staged = 0;
    for (const p of result.pendingApprovals || []) {
        if (p.kind === "tool" && p.id) { pendingToolApprovals.set(p.id, p); staged++; }
    }
    // final state: waiting if the model asked something or staged an approval,
    // otherwise idle-complete
    const askedUser = (result.newMessages || []).some(m => m.meta && m.meta.clarify);
    setSessionStatus(id,
        staged ? "approval" : askedUser ? "waiting" : "idle",
        askedUser ? "asked you a question" : staged ? "an action needs your approval" : "");

    if (!s.title || s.title === "New session") {
        s.title = text.trim().slice(0, 48);
    }
    // THE OPERATOR'S TOGGLES BEAT THIS TURN'S STALE COPY.
    //
    // sessions.save writes the whole file, and `s` was loaded when the turn
    // STARTED. So switching the brain on, moving the effort slider, or
    // answering an approval with "always allow" DURING a long run was
    // reverted the instant that run finished — the setting stuck for exactly
    // as long as it took the model to finish talking, then vanished with no
    // error. On a 22-minute orchestrated goal that is a toggle that appears
    // to do nothing at all.
    //
    // These three are operator state, not turn state, and nothing in the
    // engine mutates them in place — so the disk copy is authoritative for
    // them and this turn's copy is authoritative for everything else.
    try {
        const cur = sessions.load(id);
        if (cur) {
            s.ancientKnowledge = cur.ancientKnowledge;
            if (cur.effortLevel !== undefined) s.effortLevel = cur.effortLevel;
            if (cur.perms) s.perms = cur.perms;
            // files staged DURING this turn are operator state too — the disk
            // copy keeps them, minus exactly what this turn just consumed
            if (Array.isArray(cur.stagedAttachments)) {
                const consumed = new Set(atts.map(a => a.id));
                s.stagedAttachments = cur.stagedAttachments.filter(a => !consumed.has(a.id));
            }
            // A REVOCATION MUST NOT BE UNDONE BY A TURN THAT WAS ALREADY
            // RUNNING. Revoking a trusted endpoint mid-turn edits the DISK
            // copy; this save rewrites the whole file from the turn's own
            // object, so without this line the trust came back and the next
            // call sent without asking — a security control that confirmed
            // itself in the UI and the audit log and did nothing.
            if (Array.isArray(cur.trustedEndpoints)) {
                // the disk copy is authoritative — plus anything THIS turn
                // granted, which the disk copy may not have seen yet. Nothing
                // granted is lost; nothing revoked is resurrected.
                const mine = trustGrantedThisTurn.get(id);
                const keep = mine ? [...mine].filter(x => !cur.trustedEndpoints.includes(x)) : [];
                s.trustedEndpoints = cur.trustedEndpoints.concat(keep);
            }
            // THE READ/UNREAD STAMPS ARE DISK-AUTHORITATIVE TOO. setSessionStatus
            // stamps doneAt (and lastError) on the fresh disk copy at the moment
            // the turn resolves — THIS save then rewrote the whole file from the
            // turn-start snapshot, reverting the stamp: the operator watched the
            // dot "flash cyan and then go to the read state" with no click.
            // Same for the bell: a mute flipped mid-turn must survive the turn.
            if (cur.doneAt !== undefined) s.doneAt = cur.doneAt;
            if (cur.readAt !== undefined) s.readAt = cur.readAt;
            if (cur.lastError !== undefined) s.lastError = cur.lastError;
            if (cur.notifyMuted !== undefined) s.notifyMuted = cur.notifyMuted;
        }
    } catch { /* a stale toggle is still better than a lost transcript */ }
    trustGrantedThisTurn.delete(id);
    sessions.save(s);

    // IT LEARNS FROM USE, NOT FROM A QUESTIONNAIRE. Re-derived from the
    // session files that already exist — arithmetic only, no model call.
    //
    // NOT ON THE REPLY PATH, AND NOT EVERY TURN. This ran inline before the
    // handler returned, and sessions.list() already reads and parses every
    // session file to build its summaries — so each turn re-read and re-parsed
    // the entire history TWICE, synchronously, on the main process, with the
    // reply waiting behind it. At a few dozen sessions that is a stutter; at a
    // few hundred it is a visible freeze on every message, growing with use.
    // Deferred past the return, throttled so a burst of turns coalesces, and
    // bounded to the recent sessions that describe how the operator works now.
    scheduleLearn();

    // THE OFFER, SURFACED TO THE OPERATOR: when no orchestration route
    // fired and a reachable model clearly suits this kind of work better, the
    // reply carries the suggestion. Advisory: the renderer shows it with a
    // one-click "assign for this kind of work", which writes the task map —
    // and from then on such messages ROUTE. Never computed when the plan
    // already routed (that would second-guess the user's own assignment).
    let modelOfferOut = null;
    if (!orchRoute && !taskRoute.broken) {
        try {
            const mo = require("../.lcl.engine/core/modelOffer");
            const curId = drive.sel ? drive.sel.model
                : (chosenLocal || (paths.readSettings().preferredModel || null));
            const o = mo.offer(text, mo.reachableModels(), curId);
            // never offer the model that just answered under another id —
            // registry ids and served ids differ by prefix AND by Ollama's
            // ":tag" suffix (glm-5.2:latest vs z-ai/glm-5.2 are the same
            // weights; offering the paid twin of a free node model was the
            // reviewed failure)
            const tail = (x) => String(x || "").split("/").pop()
                .split(":")[0].toLowerCase();
            // only ROUTE-ABLE suggestions are offered: a local suggestion
            // would write a task-map entry nothing executes (local assignments
            // guide via the prompt, not the drive)
            if (o && o.suggested.endpointId && tail(o.suggested.id) !== tail(curId)) {
                // ONCE, NOT EVERY TURN. The offer was recomputed and re-shown
                // on every drive turn — "this local node model is over
                // offering the better model." One cap+model suggestion is made
                // once per session; it comes back only if the suggestion
                // CHANGES (a new candidate appeared or scores moved).
                const seen = s.offerLog && s.offerLog[o.cap];
                const assigned = s.taskModels && s.taskModels[o.cap]
                    && s.taskModels[o.cap].model;
                if (!assigned && seen !== o.suggested.id) {
                    s.offerLog = { ...(s.offerLog || {}), [o.cap]: o.suggested.id };
                    modelOfferOut = { cap: o.cap, reason: o.reason, suggested: o.suggested };
                }
            }
        } catch { /* an offer is never worth breaking a turn over */ }
    }

    // WHAT THE PROVIDER SAYS ABOUT THE MODEL THAT JUST ANSWERED. A retired
    // serving answers a clean 200 with nothing in it — the operator met that
    // four times before anything told him the model had been retired in June.
    // A model with no tool calling cannot run the agent loop it is being asked
    // to run. Both are published facts, said once per turn, never guessed.
    let modelNotice = null;
    try {
        // A CHOICE THAT COULD NOT BE HONOURED IS SAID ON THE TURN, not only in
        // a picker banner nobody has open. The endpoint was unlinked or lost
        // its key, so this answer came from the local engine instead.
        if (drive.missing) {
            modelNotice = {
                kind: "missing-choice",
                model: drive.missing.model || null,
                text: `The model this conversation chose (${drive.missing.model}) is ` +
                    `not available — its endpoint is not linked, or its key cannot ` +
                    `be read. This answer came from the model on this machine.`
            };
        } else if (drive.sel) {
            const retired = cloudModels.modelRetirement(drive.sel);
            const canTools = cloudModels.modelCan(drive.sel, "tools");
            if (retired) {
                modelNotice = {
                    kind: "retired", model: drive.sel.model,
                    replacedBy: retired.replacedBy,
                    siblings: retired.siblings || [],
                    /* "No replacement is named." was true, useless, and read as
                     * "this family is gone" — about a family that is very much
                     * alive. The provider names a successor on maybe a third of
                     * its retired models; for the rest, the live siblings from
                     * the SAME captured sheet are the answer. */
                    text: `${drive.sel.label} lists ${drive.sel.model} as RETIRED. ` +
                        (retired.replacedBy
                            ? `Its named replacement is ${retired.replacedBy}.`
                            : (retired.siblings || []).length
                                ? `The provider names no replacement, but these are ` +
                                  `live on this endpoint right now: ` +
                                  `${retired.siblings.join(", ")}.`
                                : "No replacement is named, and nothing similar is live here.") +
                        " A retired serving is the kind that answers with nothing at all."
                };
            } else if (canTools === false) {
                modelNotice = {
                    kind: "no-tools", model: drive.sel.model,
                    text: `${drive.sel.label} publishes no tool calling for ` +
                        `${drive.sel.model}, so this conversation cannot read ` +
                        `files, search, or run anything — it can only talk.`
                };
            }
        }
    } catch { /* a notice is never worth breaking a turn over */ }

    return {
        id: s.id,
        title: s.title,
        new_messages: result.newMessages,
        changes: result.changes || [],
        modelOffer: modelOfferOut,
        // the fleet a tool DISCOVERED this turn (ask_fleet, unassigned
        // session) — the renderer maps it onto the same strip and the same
        // task-map write the \u25B6 fleet row makes
        fleetOffer: result.fleetOffer || null,
        // the provider's own verdict on the model that answered
        modelNotice,
        // an assignment that exists but did not resolve — surfaced, never silent
        routeBroken: taskRoute.broken
    };
});

// -------------------------------------------------------------
// TOOL APPROVALS (confirm-class tools: delete_file and future peers)
// -------------------------------------------------------------
/**
 * Mirrors the script-approval split: the agent can only STAGE a destructive
 * tool call; executing it requires this separate human action referencing the
 * proposal id. The approval path applies the same backup + change-record
 * treatment as a direct tool run, so an approved delete is still revertable.
 */
const pendingToolApprovals = new Map();
// sessionId -> cancelToken for an approval executing RIGHT NOW.
//
// This was a single global boolean. Because lcl:chat consulted it for every
// session, one approved long-running tool — a research run, an image, an OCR
// pass — froze chat in every other session too, and since the approval path
// also ran with an empty ctx there was no cancel token to stop it with. The
// lock is per session for the same reason the turn lock is: session files are
// whole-file last-writer-wins, so the conflict is with the SAME session's
// writer, not with unrelated ones.
const approvalsRunning = new Map();

/** Stamp a staged card resolved in the session so re-renders show its outcome. */
function stampProposal(s, id, resolved) {
    const staged = s.messages.find(m => m.proposal && m.proposal.id === id);
    if (staged) staged.proposal = { ...staged.proposal, resolved };
}

// The ONE approval path. Named so a notification button can reach exactly
// this code — every re-check it performs included — instead of a shortcut
// around it. A second doorway to one mechanism, never a second mechanism.
async function approveToolById(id) {
    const p = pendingToolApprovals.get(String(id || ""));
    if (!p) return { error: "unknown or expired proposal" };

    // An approval must not interleave with a running turn IN THE SAME SESSION:
    // session saves are whole-file last-writer-wins, so two writers eat each
    // other's work. It is scoped per session because that is what concurrent
    // sessions made possible — a reply running in session B is no reason to
    // refuse an approval in session A.
    //
    // This line read `if (activeTurn)` until an audit found it. `activeTurn`
    // was the OLD single-turn global; when concurrent sessions replaced it
    // with turnsBySession this reference was missed, and because nothing here
    // is inside a try, every approval threw ReferenceError before it could
    // run. The approve button was dead for every confirm-class action, and
    // 1000+ unit tests never saw it because none of them cross the IPC layer.
    if (turnsBySession.has(p.sessionId)) {
        return { error: "wait for the current reply to finish, then approve" };
    }
    if (approvalsRunning.has(p.sessionId)) {
        return { error: "another approval is still running in this session" };
    }
    const cancelToken = { cancelled: false };
    const approvalStartedAt = Date.now();
    approvalsRunning.set(p.sessionId, cancelToken);

    try {
    pendingToolApprovals.delete(p.id);

    const s = sessions.load(p.sessionId);
    if (!s) return { error: "session not found" };
    // A linked folder is needed only by tools whose CAPABILITY is
    // workspace-bound. "scoped" alone is not the signal: an offensive tool is
    // scoped to an engagement TARGET, not a folder, and http_fetch/clipboard
    // are unscoped — none of those need a workspace to approve.
    const toolSpec = TOOL_CLASS[p.tool];
    const WORKSPACE_CAPS = new Set(["fs.read", "fs.write", "media.read", "media.write", "sec.defensive"]);
    const needsWorkspace = !toolSpec || WORKSPACE_CAPS.has(toolSpec.capability);
    if (needsWorkspace && (!s.repoPath || !fs.existsSync(s.repoPath))) {
        return { error: "the linked folder is no longer available" };
    }

    const expire = (why) => {
        stampProposal(s, p.id, "expired");
        s.messages.push({
            role: "tool", name: p.tool, failed: true,
            content: `NOT RUN: ${why}`
        });
        sessions.save(s);
        return { error: why, messages: s.messages, changes: s.changes || [] };
    };

    // The card was reviewed against a specific workspace. If the session has
    // been re-linked since, the same relative path now names a file the user
    // never looked at — refuse rather than act on the wrong folder.
    if (p.repoPath && path.resolve(p.repoPath) !== path.resolve(s.repoPath)) {
        return expire("the linked folder changed after this was staged — ask again");
    }

    // Same for the target itself: what runs must be what was reviewed.
    if (p.target && p.target.exists) {
        try {
            const full = fsTools.resolveInRoot(s.repoPath, agent.backupTargetOf(p.tool, p.args));
            const st = fs.statSync(full);
            if (st.size !== p.target.size || st.mtimeMs !== p.target.mtimeMs) {
                return expire("the file changed after this was staged — review it again");
            }
        } catch {
            return expire("the file is no longer there");
        }
    }

    // THE GATE applies here too: approval satisfies the kernel's CONFIRM, but
    // capability, scope and blast-radius checks still stand.
    const verdict = policyBridge.check(s, p.tool, p.args, {
        modelId: s.modelId || null, engineId: "user-approval", turnId: `approve:${p.id}`
    });
    if (verdict.decision === "deny") {
        return expire(`denied by policy: ${verdict.reason}`);
    }

    // the human already approved; the tool re-checks its own preconditions
    // (an offensive tool still validates the target against a live engagement)
    const tools = agent.effectiveTools({ all: true });
    const entry = tools[p.tool];
    if (!entry) return expire(`tool '${p.tool}' is not available`);

    auditLog.write({
        kind: "tool-approved", tool: p.tool, sessionId: s.id,
        digest: p.digest, at: Date.now()
    });

    // the image engine cannot share memory with a resident LLM — the direct
    // agent path unloads first, and the approval path owes the same care
    if (p.tool === "generate_image") {
        engine.unloadNow();
        await engine.stopAndWait();
    }

    const backupTarget = agent.backupTargetOf(p.tool, p.args);
    // Capture whether the snapshot target pre-existed (before the write, and
    // independent of whether the snapshot itself succeeded) so describeChange can
    // tell a NEW output file from an OVERWRITE and revert never deletes a
    // pre-existing file — the same protection the agent loop applies.
    let backupTargetResolved = null, backupTargetExisted = false;
    if (backupTarget) {
        try {
            backupTargetResolved = fsTools.resolveInRoot(s.repoPath, backupTarget);
            backupTargetExisted = fs.existsSync(backupTargetResolved)
                && fs.statSync(backupTargetResolved).isFile();
        } catch { backupTargetResolved = null; backupTargetExisted = false; }
    }
    const backupId = backupTarget ? backups.snapshot(s.id, s.repoPath, backupTarget) : null;

    // The ctx here was a literal `{}`. Every tool that reports progress, checks
    // for cancellation, or tells the app a library changed lost all three the
    // moment it was routed through an approval instead of the agent loop — so an
    // approved research_topic promised a reindex that never happened, an
    // approved OCR pass showed no progress, and nothing was stoppable. Approval
    // changes WHO decided to run the tool, not what the tool is owed.
    const approvalCtx = {
        cancelToken,
        // THE SECOND DISPATCH SITE. An approved tool runs HERE, not through
        // agent.runTool — so without these a human-approved image generation
        // that ran out of memory would be the one call in the app that could
        // not fall back to the node or an endpoint. Same context, same gates.
        root: s.repoPath,
        session: s,
        sessionId: s.id,
        sessionTitle: s.title,
        approveFallback: async (q) => {
            const target = q.selection || { model: q.model, label: q.endpoint };
            const ask = await askRemoteApproval(s, target, `${p.tool} (rerouted)`, {
                fallback: true,
                reason: String(q.reason || "").slice(0, 300),
                fellBackFrom: q.fellBackFrom || null
            });
            return ask.allowed;
        },
        onLibraryDirty: (lib) => {
            try { runReindex(s.id, lib); } catch { /* reported by the ledger */ }
        },
        onNote: (note, extra) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("lcl:progress", {
                    sessionId: s.id, phase: "tool-progress",
                    // the extra object carries pct / etaMs / indeterminate for
                    // the renderer's progress bar — the agent-loop ctx already
                    // forwards it (agent.js onNote), and dropping it HERE was
                    // why a human-approved flash showed words but no bar
                    detail: { tool: p.tool, note,
                              ...(extra && typeof extra === "object" ? extra : {}) },
                    elapsedMs: Date.now() - approvalStartedAt
                });
            }
        }
    };
    setSessionStatus(s.id, "working", `running ${p.tool}`);

    let toolResult, failed = false, output;
    try {
        toolResult = await entry.run(s.repoPath, p.args, approvalCtx);
        output = JSON.stringify(toolResult);
    } catch (err) {
        failed = true;
        output = `ERROR: ${err.message}`;
        // ...and if this machine simply could not, ask the ones that can —
        // the same chain, the same gates, the same reporting the agent loop
        // gets. Without this, approving a tool was the way to LOSE the
        // fallback, which is the opposite of what an approval means.
        try {
            const tf = require("../.lcl.engine/core/toolFallback");
            const alt = await tf.attempt({ entry, name: p.tool, args: p.args,
                                           ctx: approvalCtx, localError: output });
            if (alt.ok) {
                toolResult = alt.result;
                output = JSON.stringify(alt.result);
                failed = false;
                auditLog.write({ kind: "tool-fallback", tool: p.tool, sessionId: s.id,
                                 ranOn: alt.where, at: Date.now() });
            } else {
                output += tf.explain(alt.tried, alt.reason);
            }
        } catch { /* the original failure stands */ }
    }
    if (cancelToken.cancelled && !failed) {
        failed = true;
        output = "ERROR: stopped by you";
    }

    auditLog.write({
        kind: "tool-approval-outcome", tool: p.tool, sessionId: s.id,
        ok: !failed, backupTaken: !!backupId, at: Date.now()
    });

    let change = null;
    if (!failed && toolResult) {
        const c = agent.describeChange(p.tool, toolResult, backupId,
            { root: s.repoPath, backupTargetResolved, backupTargetExisted });
        if (c) {
            change = { id: `${Date.now()}-a`, at: Date.now(), ...c };
            s.changes = [...(s.changes || []), change].slice(-200);
        }
    }

    // stamp the ORIGINAL staging message so a re-render shows the card as
    // resolved instead of offering live buttons for a proposal that is gone
    stampProposal(s, p.id, failed ? "failed" : "approved");

    s.messages.push({
        role: "tool", name: p.tool, content: output, failed,
        approved: true, change: change || undefined,
        // an approved delete whose file was too big to snapshot is PERMANENT;
        // the message says so instead of letting the chip imply a revert
        backupTaken: !!backupId
    });
    // THE FLOOR HOLDS ON EVERY DISPATCH SITE. An approved write is a write:
    // the path's read history clears so the next read is fresh (a session in
    // confirm-write mode must not collect stale "re-reading gains nothing"
    // nudges on its own rewrites), and the artifact gets the same
    // deterministic post-check every agent-loop turn gets — the most
    // cautious mode must never be the one mode that ships unlinted.
    if (change) {
        try {
            agent.clearReadHistory(s.id, s.repoPath,
                [p.args && p.args.path, p.args && p.args.from, p.args && p.args.to]);
        } catch { /* advisory — never blocks the approval */ }
        try {
            const post = postCheckTurn(s, { changes: [change], newMessages: [] });
            if (post) {
                s.messages.push({ role: "assistant", content: post.text,
                                  meta: { model: "post-check", postCheck: post.data } });
                auditLog.write({ kind: "post-check", session: s.id,
                                 findings: post.data.findings, files: post.data.files,
                                 approval: true, at: Date.now() });
            }
        } catch { /* the gate reports on the work; it never becomes the failure */ }
    }
    sessions.save(s);

    return { ok: !failed, failed, output, change, backupTaken: !!backupId,
             messages: s.messages, changes: s.changes || [] };
    } finally {
        approvalsRunning.delete(p.sessionId);
        // every early return above (expired card, changed file, policy deny) lands
        // here too, so the sidebar cannot be left saying "working" forever
        const st = sessionStatus.get(p.sessionId);
        if (st && (st.state === "working" || st.state === "approval")
            && !hasPendingApprovalFor(p.sessionId)) {
            setSessionStatus(p.sessionId, "idle", "");
        }
    }
}

/** Drop (and visually expire) every pending approval bound to a session. */
function expireApprovalsFor(sessionId, why) {
    for (const [pid, p] of pendingToolApprovals) {
        if (p.sessionId !== sessionId) continue;
        pendingToolApprovals.delete(pid);
        const s = sessions.load(sessionId);
        if (s) { stampProposal(s, pid, "expired"); sessions.save(s); }
        auditLog.write({ kind: "tool-approval-expired", tool: p.tool,
                         sessionId, reason: why, at: Date.now() });
    }
    // the amber "needs you" dot is a promise that something is genuinely
    // staged — expiring the last one has to take the dot with it
    const st = sessionStatus.get(sessionId);
    if (st && st.state === "approval" && !hasPendingApprovalFor(sessionId)) {
        setSessionStatus(sessionId, "idle", "");
    }
}

function rejectToolById(id) {
    const p = pendingToolApprovals.get(String(id || ""));
    if (!p) return { rejected: true, already: true };
    pendingToolApprovals.delete(p.id);
    auditLog.write({
        kind: "tool-rejected", tool: p.tool, sessionId: p.sessionId,
        digest: p.digest, at: Date.now()
    });

    const s = sessions.load(p.sessionId);
    if (s) {
        const staged = s.messages.find(m => m.proposal && m.proposal.id === p.id);
        if (staged) staged.proposal = { ...staged.proposal, resolved: "rejected" };
        s.messages.push({
            role: "tool", name: p.tool, failed: true, rejectedByUser: true,
            content: `REJECTED by the user: the ${p.tool} call was not run.`
        });
        sessions.save(s);
    }
    // rejecting set no status at all, so a session could sit amber forever
    // after the operator had already answered it
    const st = sessionStatus.get(p.sessionId);
    if (st && st.state === "approval" && !hasPendingApprovalFor(p.sessionId)) {
        setSessionStatus(p.sessionId, "idle", "");
    }
    return { rejected: true };
}

ipcMain.handle("lcl:approveTool", async (_e, id) => approveToolById(id));
ipcMain.handle("lcl:rejectTool", guard((_e, id) => rejectToolById(id)));

// The notification's Approve / Reject buttons. Same functions, same checks.
async function approveFromNotification(id) { return approveToolById(id); }
async function rejectFromNotification(id) { return rejectToolById(id); }

// -------------------------------------------------------------
// WORKSPACE LINKING
// -------------------------------------------------------------
/** Shared validation for a candidate workspace folder. */
function validateFolder(input) {
    let folder;
    try {
        folder = fs.realpathSync(input);
    } catch {
        return { error: "could not resolve that folder" };
    }

    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        return { error: "not a directory" };
    }

    const root = path.parse(folder).root;
    if (path.resolve(folder) === path.resolve(root)) {
        return { error: "refusing to link a whole drive root — pick a project folder" };
    }
    if (sensitiveRoots().has(folder) ||
        path.resolve(folder).toLowerCase() === path.join(root, "Users").toLowerCase()) {
        return { error: "refusing to link a home or system directory — pick a project folder" };
    }

    return { folder };
}

function sensitiveRoots() {
    const set = new Set();
    for (const env of ["USERPROFILE", "WINDIR", "SystemRoot", "ProgramFiles",
                       "ProgramFiles(x86)", "ProgramData", "HOME"]) {
        const v = process.env[env];
        if (v) {
            try { set.add(fs.realpathSync(v)); } catch { set.add(path.resolve(v)); }
        }
    }
    return set;
}

// Directories whose contents are credentials or app/system state — the home
// ROOT is already refused, but its secret SUBTREES (~/.ssh, AppData token
// stores) are not, and plaintext-previewing them into an index (or granting
// write access) is exactly what a security-conscious tool must not do. Matched
// by path segment, so any depth is caught.
const SECRET_SEGMENTS = new Set([
    "appdata", ".ssh", ".aws", ".gnupg", ".gpg", ".azure", ".kube",
    ".config", ".password-store", "credentials", ".docker"
]);
function looksLikeSecretDir(folder) {
    return path.resolve(folder).toLowerCase().split(path.sep)
        .some(seg => SECRET_SEGMENTS.has(seg));
}

/* =================================================================== *
 *  CHAT ATTACHMENTS — files staged onto the session's NEXT message.
 *
 *  The staged list lives ON THE SESSION FILE, so it is per-session by
 *  construction and survives a restart. A file inside the linked folder
 *  attaches BY REFERENCE — the model reads the current copy with its own
 *  tools. Anything outside is COPIED into dataDir/attachments/<id>/,
 *  because resolveInRoot makes an outside path unreadable by every tool;
 *  the staging dir is then reached through the same resolveInRoot via
 *  the "@attachments/" prefix (read-only tools — see agent.js runTool).
 * =================================================================== */
const ATT_MAX_COUNT = 10, ATT_MAX_BYTES = 50 * 1024 * 1024;
const ATT_IMG_RE = /\.(png|jpe?g|gif|bmp|webp)$/i, ATT_PDF_RE = /\.pdf$/i;
let attSeq = 0;
function attachmentsDirFor(id) {
    const d = path.join(paths.dataDir(), "attachments", String(id));
    fs.mkdirSync(d, { recursive: true });
    return d;
}
function attKindOf(full) {
    if (ATT_IMG_RE.test(full)) return "image";
    if (ATT_PDF_RE.test(full)) return "pdf";
    // the same 4KB NUL sniff fsTools uses to split text from binary
    try {
        const fd = fs.openSync(full, "r");
        const b = Buffer.alloc(4096);
        const n = fs.readSync(fd, b, 0, 4096, 0);
        fs.closeSync(fd);
        return b.subarray(0, n).includes(0) ? "binary" : "text";
    } catch { return "binary"; }
}
function stageOne(s, ref) {
    if ((s.stagedAttachments || []).length >= ATT_MAX_COUNT) {
        return { error: `no more than ${ATT_MAX_COUNT} files on one message` };
    }
    let full, rel = null;
    if (ref && ref.rel !== undefined) {
        // from the workspace explorer: {rel} resolves through the SAME
        // containment every tool uses, so an escaping rel is refused here
        // rather than quietly copied out from behind the workspace wall
        if (!s.repoPath) return { error: "no folder is linked" };
        full = fs.realpathSync(fsTools.resolveInRoot(s.repoPath, String(ref.rel)));
    } else {
        full = fs.realpathSync(String(ref));   // from the OS picker — any file
    }
    const st = fs.statSync(full);
    if (!st.isFile()) return { error: "not a file" };
    if (st.size > ATT_MAX_BYTES) return { error: "larger than 50 MB" };
    if (s.repoPath) {
        const rp = fs.realpathSync(s.repoPath);
        if (full === rp || full.startsWith(rp + path.sep)) {
            rel = path.relative(rp, full).split(path.sep).join("/");
        }
    }
    const a = { id: `a${Date.now().toString(36)}${(attSeq++).toString(36)}`,
                name: path.basename(full), path: full, rel, bytes: st.size,
                kind: attKindOf(full), staged: false, readPath: full };
    if (rel === null) {
        // outside the root: resolveInRoot would refuse it — copy it in
        const dest = path.join(attachmentsDirFor(s.id), `${a.id}-${a.name}`);
        fs.copyFileSync(full, dest);
        a.staged = true; a.stagedName = path.basename(dest); a.readPath = dest;
    }
    s.stagedAttachments = [...(s.stagedAttachments || []), a];
    return { ok: true };
}

ipcMain.handle("lcl:chooseAttachments", async (_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const picked = await dialog.showOpenDialog(mainWindow, {
        title: "Attach files to this message", buttonLabel: "Attach",
        properties: ["openFile", "multiSelections"]
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    // honest per-file errors: one oversized pick must not sink its siblings
    const errors = [];
    for (const p of picked.filePaths) {
        try {
            const r = stageOne(s, p);
            if (r.error) errors.push(`${path.basename(p)}: ${r.error}`);
        } catch (err) { errors.push(String(err.message || err)); }
    }
    sessions.save(s);
    return { ok: true, staged: s.stagedAttachments, errors };
});

ipcMain.handle("lcl:stageAttachment", guard((_e, id, ref) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const r = stageOne(s, ref);
    if (r.error) return r;
    sessions.save(s);
    return { ok: true, staged: s.stagedAttachments };
}));

ipcMain.handle("lcl:unstageAttachment", guard((_e, id, attId) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    const gone = (s.stagedAttachments || []).find(a => a.id === String(attId));
    s.stagedAttachments = (s.stagedAttachments || []).filter(a => a.id !== String(attId));
    if (gone && gone.staged && gone.stagedName) {
        // its disk copy goes with it — basename() so a tampered session file
        // cannot aim this delete outside the staging dir
        try { fs.rmSync(path.join(attachmentsDirFor(s.id), path.basename(gone.stagedName))); }
        catch { /* already gone */ }
    }
    sessions.save(s);
    return { ok: true, staged: s.stagedAttachments };
}));

/**
 * Folder linking is split in two so the CONFIRMATION can be branded in-app:
 *   pickFolder  → native OS picker (must stay native) + validation, commits nothing
 *   grantFolder → commits the grant after the in-app modal is accepted
 */
ipcMain.handle("lcl:pickFolder", async (_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };

    const picked = await dialog.showOpenDialog(mainWindow, {
        title: "Choose a workspace folder",
        buttonLabel: "Select folder",
        properties: ["openDirectory"]
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };

    const check = validateFolder(picked.filePaths[0]);
    if (check.error) return check;

    let fileCount = 0;
    try {
        fileCount = (fsTools.listFiles(check.folder, { path: "." }).entries || []).length;
    } catch { /* count is cosmetic */ }

    return { folder: check.folder, fileCount };
});

ipcMain.handle("lcl:grantFolder", guard((_e, id, folder) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };

    // linking (or re-linking) retargets every workspace-relative path — cards
    // reviewed against the old folder must not survive into the new one
    expireApprovalsFor(id, "workspace re-linked");

    const check = validateFolder(String(folder || ""));
    if (check.error) return check;

    s.repoPath = check.folder;
    sessions.save(s);
    return { id: s.id, repoPath: check.folder };
}));

ipcMain.handle("lcl:revertChange", guard((_e, id, changeId) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    if (!s.repoPath) return { error: "this session has no linked folder" };

    const change = (s.changes || []).find(c => c.id === changeId);
    if (!change) return { error: "change not found" };

    const res = backups.revert(s.id, s.repoPath, change);
    if (!res.ok) return { error: res.error };

    change.reverted = true;
    sessions.save(s);
    return { ok: true, action: res.action, path: res.path };
}));

ipcMain.handle("lcl:deleteMessages", guard((_e, id, indexes) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };

    const drop = new Set((Array.isArray(indexes) ? indexes : []).map(Number));
    s.messages = s.messages.filter((_m, i) => !drop.has(i));
    sessions.save(s);
    return { ok: true, messages: s.messages };
}));

ipcMain.handle("lcl:linkRepo", async (_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };

    const picked = await dialog.showOpenDialog(mainWindow, {
        title: "Choose a workspace folder",
        buttonLabel: "Select folder",
        properties: ["openDirectory"]
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };

    let folder;
    try {
        folder = fs.realpathSync(picked.filePaths[0]);
    } catch {
        return { error: "could not resolve that folder" };
    }

    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        return { error: "not a directory" };
    }

    const root = path.parse(folder).root;
    if (path.resolve(folder) === path.resolve(root)) {
        return { error: "refusing to link a whole drive root — pick a project folder" };
    }
    if (sensitiveRoots().has(folder) ||
        path.resolve(folder).toLowerCase() === path.join(root, "Users").toLowerCase()) {
        return { error: "refusing to link a home or system directory — pick a project folder" };
    }
    if (looksLikeSecretDir(folder)) {
        return { error: "refusing to link a credential or app-data directory (.ssh, AppData, and the like)" };
    }

    // Explicit confirmation: the user sees exactly which path they authorize.
    const confirm = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Confirm workspace",
        message: "Give .lcl access to this folder?",
        detail:
            `${folder}\n\n` +
            "The agent will be able to read, create, and overwrite files inside " +
            "this folder (and nowhere else) for this session.",
        buttons: ["Grant access", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    });
    if (confirm.response !== 0) return { canceled: true };

    s.repoPath = folder;
    sessions.save(s);
    return { id: s.id, repoPath: folder };
});

ipcMain.handle("lcl:unlinkRepo", guard((_e, id) => {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    // a pending approval was reviewed against THIS folder; unlinking makes
    // every one of them meaningless (and re-linking would silently retarget
    // them — the exact swap the review demonstrated)
    expireApprovalsFor(id, "workspace unlinked");
    // the semantic index holds plaintext previews of the folder's files —
    // unlinking is the user saying "let go of it", so let go of ALL of it
    if (s.repoPath) embedIndex.purgeIndex(s.repoPath);
    s.repoPath = null;
    sessions.save(s);
    return { id: s.id, repoPath: null };
}));

// -------------------------------------------------------------
// KNOWLEDGE LIBRARIES — local RAG over user-designated reference folders.
// A library is read-only reference material (a spec dump, datasheets, a repo
// the agent should KNOW but not touch), separate from the linked workspace.
// Indexing streams into the same task panel as an orchestrated build.
// -------------------------------------------------------------
const indexingLibs = new Set();

// Indexing a library is APP-scoped work, not session work: it keeps running
// when the user switches sessions, and it starts from a modal that may have no
// active session at all. Tag it so the renderer shows it regardless of which
// session is on screen, instead of filtering it out and leaving a row that can
// never resolve.
function sendLibTask(sessionId, task) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("lcl:task",
            { sessionId: sessionId || null, scope: "library", ...task });
    }
}

// A library whose contents changed while it was ALREADY indexing. The guard
// below correctly refuses to run two indexers over one library, but simply
// returning meant the new files were never picked up — and research_topic had
// just told the user "it is being reindexed now and will be searchable
// shortly", which was then untrue. Remember the request and honour it when
// the running pass finishes.
const reindexAgain = new Map();          // libId -> { sessionId, lib }

async function runReindex(sessionId, lib) {
    if (indexingLibs.has(lib.id)) {
        reindexAgain.set(lib.id, { sessionId, lib });
        return;
    }
    indexingLibs.add(lib.id);
    const taskId = `kb:${lib.id}`;
    const title = `Indexing "${lib.name}"`;

    // Record it in the DURABLE ledger and take a cancel token. Both matter:
    // an hour-long job must be visible after a restart, and stoppable while it
    // runs. reindex() has always accepted a token — nothing ever passed one.
    const { cancelToken } = tasks.start({
        id: taskId, kind: "index", title, detail: "scanning folder…",
        // library work is APP-scoped: it outlives sessions and shows everywhere
        scope: "library",
        cancellable: true, meta: { library: lib.name, libraryId: lib.id },
        // "how long will this take" is answered from what indexing a FILE has
        // cost on this machine before, multiplied by how big this library was
        // LAST time. Both halves are needed for a number at submit: the rate
        // alone cannot size the job, and the scan does not finish counting for
        // several seconds. A previous file count is a good prior and the live
        // total replaces it on the first progress tick anyway.
        unit: "index:file",
        total: (() => {
            try {
                const known = knowledge.list().find(l => l.id === lib.id);
                return (known && known.files) || 0;
            } catch { return 0; }
        })()
    });

    sendLibTask(sessionId, { id: taskId, n: 0, total: 0, title,
        status: "running", detail: "scanning folder…", cancellable: true });
    // Real progress, not elapsed time: reindex counts its candidates first
    // and reports done/total as it goes. The numbers ride on every update —
    // the ledger keeps them in meta so a restart still shows where it stood.
    let prog = { n: 0, total: 0 };
    let lastSent = 0;
    // tasks.progress() refines the forecast from the live rate and writes it
    // back onto the ledger row; read it straight back off so the UI shows the
    // same number the ledger holds rather than a second, disagreeing estimate.
    const etaOf = () => {
        const row = tasks.list({ limit: 1, id: taskId })[0]
            || tasks.list({ limit: 60 }).find(t => t.id === taskId);
        return row ? { etaMs: row.etaMs, etaBasis: row.etaBasis } : {};
    };
    const onNote = (msg) => {
        const now = Date.now();
        if (now - lastSent < 300) return;   // throttle: indexing is chatty
        lastSent = now;
        const detail = String(msg).slice(0, 120);
        tasks.progress(taskId, detail, { n: prog.n, total: prog.total });
        sendLibTask(sessionId, { id: taskId, title, status: "running",
            detail, n: prog.n, total: prog.total, cancellable: true, ...etaOf() });
    };
    const onProgress = ({ done, total }) => {
        prog = { n: done, total };
        tasks.progress(taskId, undefined, { n: done, total });
        sendLibTask(sessionId, { id: taskId, title, status: "running",
            n: done, total, cancellable: true, ...etaOf() });
    };
    try {
        const r = await knowledge.reindex(lib.id, onNote, cancelToken, onProgress);
        const detail = `${r.files} files · ${r.chunks} passages`
            + (r.unreadable ? ` · ${r.unreadable} unreadable page${r.unreadable === 1 ? "" : "s"}` : "")
            + (r.redacted ? ` · ${r.redacted} skipped as credentials` : "");
        const status = r.cancelled ? "cancelled" : "done";
        tasks.finish(taskId, status, detail,
            { files: r.files, chunks: r.chunks, unreadable: r.unreadable, workers: r.workers });
        sendLibTask(sessionId, {
            id: taskId, title: r.cancelled ? `${title} — stopped` : `Indexed "${lib.name}"`,
            status, detail });
    } catch (e) {
        const msg = String(e.message || e).slice(0, 140);
        tasks.finish(taskId, "failed", msg);
        sendLibTask(sessionId, { id: taskId, title: `${title} — failed`,
            status: "failed", detail: msg });
    } finally {
        indexingLibs.delete(lib.id);
        // Something changed the library while this pass was running — honour
        // the request now rather than dropping it. Deleted from the map
        // BEFORE the call so a change arriving during THAT run queues again
        // instead of being lost.
        const pending = reindexAgain.get(lib.id);
        if (pending) {
            reindexAgain.delete(lib.id);
            setImmediate(() => runReindex(pending.sessionId, pending.lib));
        }
    }
}

// Per-tool permission dial. Set by a human clicking a selector — this handler
// is the ONLY writer, and the kernel clamps every value to its classification
// floor, so neither a model nor a corrupted settings file can loosen what must
// not loosen. Applied to live kernels immediately.
ipcMain.handle("lcl:setToolPolicy", guard((_e, tool, level) => {
    const { TOOL_CLASS } = require("../.lcl.engine/policy/classify");
    const { PolicyKernel } = require("../.lcl.engine/policy/kernel");
    const name = String(tool || "");
    const spec = TOOL_CLASS[name];
    if (!spec) return { error: "unknown tool" };

    const current = paths.readSettings().toolPolicy || {};
    const next = { ...current };
    const want = String(level || "");

    if (want === "default") {
        delete next[name];                     // back to the classification default
    } else {
        const floor = PolicyKernel.floorFor(spec.classification);
        const clamped = PolicyKernel.clampToFloor(want, floor);
        if (!clamped) return { error: "level must be allow, notify, confirm, deny or default" };
        if (clamped !== want) {
            return { error: `"${name}" cannot be looser than "${floor}" — that floor is fixed`, floor };
        }
        next[name] = want;
    }
    paths.writeSettings({ toolPolicy: next });
    policyBridge.applyToolPolicy(next);        // live sessions feel it now
    auditLog.write({ kind: "tool-policy", tool: name, level: want });
    return { ok: true, tool: name, level: want === "default" ? null : want };
}));

// App-function toggles that live in settings. One writer, values validated —
// a settings file a model could somehow influence still cannot invent levels.
// BRING YOUR OWN ENDPOINT. The user links their own server or their own API
// key; nothing ships and nothing is preconfigured. The KEY is accepted here —
// that is the feature — and cloudModels encrypts it with OS-backed storage
// before it touches disk. It is never returned to the renderer, never written to
// a session, and scrubbed out of every audit line below.
// A sessionId makes this answer FOR THAT SESSION — which model drives it, and
// what limits it runs under. Omitted, it answers about the app default exactly
// as before, which is what the settings panels want.
/**
 * RE-DERIVE WHAT THIS INSTALL KNOWS, OFF THE REPLY PATH.
 *
 * Deferred so the turn returns first, throttled so ten quick messages cost one
 * pass rather than ten, and bounded to the most recent sessions — a profile of
 * how someone works now is not improved by re-reading a conversation from
 * eight months ago on every message, and the cost of doing so grows forever.
 */
const LEARN_RECENT_SESSIONS = 40;
const LEARN_MIN_INTERVAL_MS = 60_000;
let learnTimer = null;
let lastLearnAt = 0;
function scheduleLearn() {
    if (learnTimer) return;
    const wait = Math.max(0, LEARN_MIN_INTERVAL_MS - (Date.now() - lastLearnAt));
    learnTimer = setTimeout(() => {
        learnTimer = null;
        lastLearnAt = Date.now();
        try {
            const recent = sessions.list().slice(0, LEARN_RECENT_SESSIONS)
                .map(x => sessions.load(x.id)).filter(Boolean);
            tailor.learn(recent);
        } catch { /* tailoring must never cost a turn, or break one */ }
    }, wait);
    if (learnTimer.unref) learnTimer.unref();   // never hold the app open
}

/**
 * WHAT IT HAS LEARNED — readable, editable, deletable, and never anywhere else.
 * The files are plain markdown in the data folder; this is the same content,
 * for a panel that saves the operator opening a text editor.
 */
ipcMain.handle("lcl:learned", guard(() => ({
    ok: true,
    lines: voice.lines(),
    dir: tailor.learnedDir(),
    facts: tailor.facts(),
    summary: tailor.summary(),
    tone: voice.current(),
    tones: voice.TONES.map(t => ({ id: t.id, label: t.label, blurb: t.blurb }))
})));

ipcMain.handle("lcl:forgetLearned", guard((_e, name) => {
    const r = name ? tailor.forget(String(name)) : tailor.forgetEverything();
    auditLog.write({ kind: "learned-forgotten", what: name ? String(name) : "everything",
                     at: Date.now() });
    return { ...r, facts: tailor.facts(), summary: tailor.summary() };
}));

ipcMain.handle("lcl:voiceLines", guard(() => ({ ok: true, tone: voice.current(), lines: voice.lines() })));

ipcMain.handle("lcl:setTone", guard((_e, id) => {
    const r = voice.set(id);
    if (r.ok) auditLog.write({ kind: "tone-set", tone: r.tone, at: Date.now() });
    return { ...r, lines: voice.lines(),
             tones: voice.TONES.map(t => ({ id: t.id, label: t.label, blurb: t.blurb })) };
}));

ipcMain.handle("lcl:cloudState", guard((_e, sessionId) => {
    const s = sessionId ? sessions.load(sessionId) : null;
    const drive = cloudModels.resolveSelection(s);
    return ({
    presets: cloudModels.PRESETS.map(p => ({
        id: p.id, label: p.label, baseUrl: p.baseUrl, docs: p.docs,
        needsKey: p.needsKey, models: p.models
    })),
    endpoints: cloudModels.endpoints(),
    config: cloudModels.config(),
    selected: cloudModels.selected(),
    roles: { driver: cloudModels.selectedFor("driver"),
             reasoner: cloudModels.selectedFor("reasoner") },
    hasReasoner: cloudModels.hasReasoner(),
    available: cloudModels.available(),
    // Is the model driving right now running on the user's own node? One
    // answer, computed where the endpoint records live, so the panel and the
    // composer cannot disagree about whether this conversation costs money.
    selectedIsNode: cloudModels.selectedIsNode("driver"),
    // THIS SESSION's driver and its limits — the picker, the composer label
    // and the status line all read these, so they cannot disagree about what
    // is answering. Absent a session id, this is the app default.
    session: s ? describeSelection(s) : null,
    sessionSource: drive.source,
    // healed from the mode table when the box could not be probed (the VPN case),
    // so the donut, history budget and output budget size to the real window
    limits: healSparkLimits(s ? drive.sel : undefined,
                            router.limits(s ? drive.sel : undefined)),
    encryptionAvailable: cloudModels.encryptionAvailable(),
    networkEnabled: paths.readSettings().networkEnabled === true,
    behaviours: {
        cloudAutoApprove: paths.readSettings().cloudAutoApprove === true,
        preferredModel: paths.readSettings().preferredModel || null
    }
});
}));

// ONE CALL. Paste an address, and a key if it needs one; this normalises the
// URL, probes the server, discovers its models, picks one and selects it. The
// pasted text may contain a key, so it is never echoed back and never audited
// verbatim — only what happened to it.
// WHAT WILL THIS COST, BEFORE I SEND IT.
//
// Runs on every keystroke in the composer, so it does arithmetic and nothing
// else: no network, no tokeniser, no model. Input cost is REAL — the tokens
// exist and the rate is known. Output cost is quoted per thousand tokens of
// reply rather than invented, because the model has not answered yet and adding
// a fabricated number to a real one would ruin the only trustworthy half.
// Which model a NEW session starts on. Local or remote — one list, one answer.
// The user's own details. Written only from the UI, never by a model — a
// preference a model can rewrite is not a preference.
/**
 * READING THE KNOWLEDGE, not querying it.
 *
 * Reported: the knowledge is only reachable chunked into index paths, with no
 * way to just open a document and read it.
 *
 * Fair. Everything built so far pointed at the SEARCH INDEX — passages, scores,
 * citations. Useful to a model, useless to a person. The actual books are sitting
 * in knowledge/<subject>/*.pdf and nothing ever just opened one.
 */
/**
 * THE SHELF — what is actually readable, from what is actually installed.
 *
 * This used to glob knowledge/ for *.pdf. In a packaged build there are none:
 * builder-config.json ships the index and not the 907 MB of source documents,
 * because NSIS cannot produce an installer that large. So the shelf came up
 * empty on every installed copy — "Read the knowledge opens a pop up, that says
 * there is nothing there" — while the library view, which reads index.json,
 * listed all 64 books. Two views of one corpus disagreeing because one of them
 * was looking at the wrong artefact.
 *
 * knowledge/text/ is the readable form: the extracted text of every document,
 * page-marked, generated by devtools/build-knowledge-text.js and shipped whole.
 * The shelf is its manifest, so listing costs one small JSON read rather than
 * parsing 68 MB.
 *
 * BUILT-IN vs ADDED is carried on every subject, because the two are not the
 * same kind of thing and the user asked for them not to be mixed: the built-in
 * corpus is public-domain and government reference material chosen so it can be
 * redistributed, and anything a user adds is their own material under their own
 * terms. Nothing here merges them.
 */
ipcMain.handle("lcl:knowledgeShelf", guard(() => {
    const textRoot = path.join(paths.resourceRoot(), "knowledge", "text");
    const out = { subjects: [], layers: { builtin: 0, added: 0 } };

    const shelfFile = path.join(textRoot, "shelf.json");
    if (fs.existsSync(shelfFile)) {
        try {
            const shelf = JSON.parse(fs.readFileSync(shelfFile, "utf8"));
            for (const s of shelf.subjects || []) {
                out.subjects.push({ ...s, layer: "builtin" });
                out.layers.builtin += (s.docs || []).length;
            }
        } catch { /* fall through to the disk scan below */ }
    }

    // Dev checkouts have the PDFs and may have no text build yet; user-added
    // libraries always live as real files on disk. Both are found the same way.
    for (const lib of userLibraries()) {
        const docs = [];
        let stack = [{ dir: lib.path, prefix: "" }];
        let guardCount = 0;
        while (stack.length && guardCount++ < 4000) {
            const { dir, prefix } = stack.pop();
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) {
                if (e.isDirectory()) {
                    stack.push({ dir: path.join(dir, e.name), prefix: prefix + e.name + "/" });
                } else if (/\.(pdf|txt|md)$/i.test(e.name)) {
                    let bytes = 0;
                    try { bytes = fs.statSync(path.join(dir, e.name)).size; } catch { /* gone */ }
                    docs.push({
                        file: prefix + e.name,
                        title: e.name.replace(/\.[a-z0-9]+$/i, "").replace(/-+/g, " ").trim(),
                        bytes,
                        libraryId: lib.id
                    });
                }
            }
        }
        if (docs.length) {
            out.subjects.push({
                name: lib.name,
                layer: "added",
                libraryId: lib.id,
                docs: docs.sort((a, b) => a.title.localeCompare(b.title))
            });
            out.layers.added += docs.length;
        }
    }

    return out;
}));

/**
 * User-added knowledge libraries: id, display name, and the folder they point
 * at. Read through the knowledge module so there is one definition of what a
 * library is, and tolerant of it not being there yet.
 */
function userLibraries() {
    try {
        // straight from settings, NOT knowledge.list(): list() loads each
        // library's index to report file and chunk counts, and for the built-in
        // that is a 68 MB JSON parse. Opening a shelf must not cost that.
        const raw = paths.readSettings().knowledgeLibraries;
        return (Array.isArray(raw) ? raw : [])
            .filter(l => l && l.root && !l.builtin && fs.existsSync(l.root))
            .map(l => ({ id: l.id, name: l.name || path.basename(l.root), path: l.root }));
    } catch {
        return [];
    }
}

/* =========================================================================
 * CONTRACT K6 — ONE KNOWLEDGE API.
 *
 *   window.lcl.knowledgeLibraries() -> [{ id, title, docs, sourceOnDisk,
 *                                         sourceUrl, addedByUser }]
 *   window.lcl.openKnowledgeDoc(id) -> opens the real document, or
 *                                      { ok:false, needsFetch:true, sourceUrl }
 *
 * Extracted text is NEVER shown as a document. It backs search only.
 *
 * WHY THIS EXISTS AT ALL. The renderer was written to this contract and probed
 * for it; preload bridged none of it, so every install fell through to the two
 * older calls and the panel could say nothing about an uninstalled source but
 * "not on disk". Measured on this checkout: six window.lcl.* names app.js
 * reaches for that preload.js never carried, `knowledgeLibraries` and
 * `openKnowledgeDoc` among them.
 *
 * WHAT AN ID IS. `<libraryId>::<corpus-relative path>` — the same id the
 * renderer already mints for a legacy record, so both halves agree without a
 * second scheme. The built-in library's id is the literal "builtin-knowledge".
 *
 * WHAT IS NEVER AN ID. Anything under knowledge/text/. That is the extraction
 * the index was built from, and resolving one is refused BY PATH below rather
 * than by trusting the caller to ask nicely.
 * ====================================================================== */

const BUILTIN_LIB_ID = "builtin-knowledge";
const DOC_EXT_RE = /\.(pdf|txt|md|htm|html|epub|djvu)$/i;

/** Downloaded built-in-corpus sources live here — a WRITABLE mirror of
 *  resources/knowledge, because resources/ is read-only in a packaged build.
 *  One definition, used by resolveKnowledgeDocId (write/read) and the inventory
 *  (so a downloaded source reads as installed). */
// ONE definition, owned by the engine (knowledge.sourceCacheRoot) — the engine's
// fetchKnowledgeSource writes there too, so the two paths always see each
// other's downloads. Two copies of this path is how the engine half kept the
// read-only-dir bug after the UI half was fixed.
function builtinSourceCacheRoot() { return knowledge.sourceCacheRoot(); }

/** Where each shipped document came from. Absent in a checkout that has never
 *  run devtools/build-knowledge-sources.js — which is a missing URL, not an
 *  error, and the UI already draws that state. */
function knowledgeSourceMap() {
    try {
        const f = path.join(paths.resourceRoot(), "knowledge", "sources.json");
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        return (j && j.docs && typeof j.docs === "object") ? j.docs : {};
    } catch { return {}; }
}

/** knowledge/text/*.txt exists and is searchable — counted, never listed. */
function extractionFileCount() {
    const root = path.join(paths.resourceRoot(), "knowledge", "text");
    let n = 0;
    const stack = [root];
    let guardCount = 0;
    while (stack.length && guardCount++ < 4000) {
        let entries = [];
        const dir = stack.pop();
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.isDirectory()) stack.push(path.join(dir, e.name));
            else if (/\.txt$/i.test(e.name)) n++;
        }
    }
    return n;
}

/** THE ONE PLACE AN ID BECOMES A PATH. Every K6 call resolves through this, so
 *  containment and the extraction refusal are written once. */
function resolveKnowledgeDocId(id) {
    const raw = String(id || "");
    const cut = raw.indexOf("::");
    if (cut < 0) return { error: "not a document id" };
    const libId = raw.slice(0, cut);
    const rel = raw.slice(cut + 2);
    if (!rel) return { error: "not a document id" };

    // EXTRACTED TEXT IS NOT A DOCUMENT, refused before anything touches disk.
    // Checked on the normalised relative path so "physics/../text/x.txt" and
    // "text\\x.txt" are the same refusal as "text/x.txt".
    const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    if (/(^|\/)text\//i.test(path.posix.normalize(norm))) {
        return { error: "that is extracted text, not a document. It backs search " +
                        "and is never opened as a document." };
    }

    let root = null, addedByUser = false;
    if (libId === BUILTIN_LIB_ID) {
        root = path.join(paths.resourceRoot(), "knowledge");
    } else {
        const lib = userLibraries().find(l => String(l.id) === libId);
        if (!lib) return { error: "no such knowledge library" };
        root = lib.path;
        addedByUser = true;
    }
    let full;
    // the workspace viewer's own containment helper — the same one
    // lcl:viewKnowledgeFile uses, so a junction planted inside a library is
    // refused here too rather than by a second hand-rolled string compare
    try { full = fsTools.resolveInRoot(root, norm); }
    catch (err) { return { error: String((err && err.message) || err) }; }

    // A DOWNLOADED BUILT-IN SOURCE CANNOT LIVE IN `resources/`.
    //
    // The shipped corpus ships as extracted text only; the 62 source PDFs are
    // fetched on demand. In a packaged install `root` is `resources/knowledge`
    // under Program Files — READ-ONLY — so writing the download to `full` fails
    // with EACCES and the whole "download it" feature was dead in production
    // (only user-added libraries, whose roots the operator chose and can write,
    // ever worked). Built-in downloads land in a writable mirror under the data
    // dir instead, contained the same way. A user library is already writable,
    // so its cache path IS its real path.
    let cacheFull = full;
    if (!addedByUser) {
        // COMPUTED LEXICALLY, because the mirror does not exist until the
        // first download creates it — resolveInRoot realpaths the ROOT and
        // threw "linked folder is unavailable" on every fresh install, and the
        // old catch fell back to the READ-ONLY resources path, so the first
        // download of a machine's life aimed at Program Files and died EPERM.
        // `norm` already passed resolveInRoot's strict vetting against the
        // shipped root above (ADS, reserved names, containment), so a resolved
        // prefix check is the only remaining question — and a violation is an
        // ERROR, never a silent fallback to a location that cannot be written.
        const mirrorRoot = path.resolve(builtinSourceCacheRoot());
        const target = path.resolve(mirrorRoot, norm);
        if (target === mirrorRoot || !target.startsWith(mirrorRoot + path.sep)) {
            return { error: "that path escapes the download mirror" };
        }
        cacheFull = target;
    }
    // where a reader should look: the downloaded copy if it exists, else the
    // shipped location (present in a dev checkout, absent in a packaged build)
    const readFull = (!addedByUser && (() => {
        try { return fs.existsSync(cacheFull); } catch { return false; }
    })()) ? cacheFull : full;
    return { libId, rel: norm, root, full, cacheFull, readFull, addedByUser };
}

/**
 * THE INVENTORY. One list, both layers, told apart by a flag and never by
 * living in two different dropdowns.
 */
ipcMain.handle("lcl:knowledgeLibraries", guard(() => {
    const kroot = path.join(paths.resourceRoot(), "knowledge");
    const urls = knowledgeSourceMap();
    const libs = [];

    /* ---- what ships with .lcl ---- */
    const shelfFile = path.join(kroot, "text", "shelf.json");
    let shelf = null;
    try { shelf = JSON.parse(fs.readFileSync(shelfFile, "utf8")); } catch { /* below */ }
    if (shelf && Array.isArray(shelf.subjects)) {
        const docs = [];
        // hoisted: this resolves the data dir — once per inventory, not once
        // per document of a 64-volume shelf
        const mirror = builtinSourceCacheRoot();
        for (const sub of shelf.subjects) {
            for (const d of sub.docs || []) {
                // THE SOURCE, NEVER THE EXTRACTION. `d.file` is the .txt the
                // index was built from and `d.source` is the real document;
                // reaching for the wrong one puts the extraction straight back
                // in the list under a title that looks identical.
                const rel = String(d.source || "");
                if (!rel || !DOC_EXT_RE.test(rel)) continue;
                const full = path.join(kroot, rel);
                const src = urls[rel] || null;
                let bytes = 0, onDisk = false;
                // installed = present in the writable download cache OR shipped
                // under resources; the cache is checked first because that is
                // where a download lands in a packaged build
                for (const p of [path.join(mirror, rel), full]) {
                    try { const st = fs.statSync(p); if (st.isFile()) { onDisk = true; bytes = st.size; break; } }
                    catch { /* try the next location */ }
                }
                docs.push({
                    id: `${BUILTIN_LIB_ID}::${rel}`,
                    libraryId: BUILTIN_LIB_ID,
                    title: d.title || path.basename(rel),
                    file: rel,
                    ext: path.extname(rel).replace(".", "").toLowerCase(),
                    pages: d.pages || null,
                    bytes: bytes || d.bytes || 0,
                    sourceOnDisk: onDisk,
                    sourceUrl: src ? src.url : null,
                    sourceUrlKnown: !!src,
                    licence: src ? src.licence : null,
                    // the extraction exists, so this document IS searchable even
                    // with no source installed. "indexed, source not installed"
                    // is the honest reading of a corpus with no PDFs in it.
                    searchBacked: true,
                    subject: sub.name || null,
                    addedByUser: false
                });
            }
        }
        // THE NEWEST AT THE TOP OF THE SHIPPED SHELF. A patch that adds
        // knowledge adds sources this machine has not downloaded yet — those
        // float first (fetchable ones ahead of URL-less ones), because they
        // are exactly what Download-all is about to act on. The sort is
        // stable, so shelf order survives inside each band. The user's own
        // libraries are never reordered this way — their folders, their order.
        docs.sort((a, b) =>
            ((a.sourceOnDisk ? 2 : (a.sourceUrl ? 0 : 1))
           - (b.sourceOnDisk ? 2 : (b.sourceUrl ? 0 : 1))));
        libs.push({
            id: BUILTIN_LIB_ID, title: "Ships with .lcl",
            addedByUser: false, builtin: true,
            root: kroot,
            sourceOnDisk: docs.some(d => d.sourceOnDisk),
            sourceUrl: null,
            docs, docCount: docs.length,
            sourcesPresent: docs.filter(d => d.sourceOnDisk).length,
            sourcesMissing: docs.filter(d => !d.sourceOnDisk).length,
            searchBackedDocs: docs.length,
            // COUNTED, NOT LISTED. A corpus whose sources were never downloaded
            // must not read as empty.
            extractedTextFiles: extractionFileCount(),
            manifest: fs.existsSync(path.join(kroot, "MANIFEST.md"))
                ? "knowledge/MANIFEST.md" : null
        });
    }

    /* ---- what the operator added ---- */
    for (const lib of userLibraries()) {
        const docs = [];
        const stack = [{ dir: lib.path, prefix: "" }];
        let guardCount = 0;
        while (stack.length && guardCount++ < 4000) {
            const { dir, prefix } = stack.pop();
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) {
                if (e.isDirectory()) {
                    stack.push({ dir: path.join(dir, e.name), prefix: prefix + e.name + "/" });
                } else if (DOC_EXT_RE.test(e.name)) {
                    const rel = prefix + e.name;
                    let bytes = 0;
                    try { bytes = fs.statSync(path.join(dir, e.name)).size; } catch { /* gone */ }
                    docs.push({
                        id: `${lib.id}::${rel}`,
                        libraryId: lib.id,
                        title: e.name.replace(/\.[a-z0-9]+$/i, "").replace(/-+/g, " ").trim(),
                        file: rel,
                        ext: path.extname(e.name).replace(".", "").toLowerCase(),
                        pages: null, bytes,
                        // a user's own folder IS the source: it is on disk by
                        // definition, and there is no URL to re-fetch it from
                        sourceOnDisk: true, sourceUrl: null, sourceUrlKnown: false,
                        licence: null, searchBacked: true,
                        subject: null, addedByUser: true
                    });
                }
            }
        }
        libs.push({
            id: lib.id, title: lib.name,
            addedByUser: true, builtin: false,
            root: lib.path, missing: !fs.existsSync(lib.path),
            sourceOnDisk: true, sourceUrl: null,
            docs: docs.sort((a, b) => a.title.localeCompare(b.title)),
            docCount: docs.length,
            sourcesPresent: docs.length, sourcesMissing: 0,
            searchBackedDocs: docs.length,
            extractedTextFiles: 0, manifest: null
        });
    }

    return libs;
}));

/**
 * THE CHEAP COUNT BEHIND THE BADGE. "i really want that to also be a badge
 * ... prefixing the Knowledge button ... when there is knowledge in the
 * source list, that is not downloaded to the machine." The renderer needs
 * this number at BOOT, long before anyone opens the panel — so it must never
 * ride the full inventory (user-library walks, per-doc metadata). This is
 * shelf.json + sources.json + two existsSyncs per built-in doc, nothing else.
 * `fetchable` counts only missing docs WITH a recorded URL — the ones
 * Download-all can actually act on, which is what the badge promises.
 */
ipcMain.handle("lcl:knowledgeMissingCount", guard(() => {
    const kroot = path.join(paths.resourceRoot(), "knowledge");
    let shelf = null;
    try {
        shelf = JSON.parse(fs.readFileSync(
            path.join(kroot, "text", "shelf.json"), "utf8"));
    } catch { return { missing: 0, fetchable: 0 }; }
    if (!shelf || !Array.isArray(shelf.subjects)) return { missing: 0, fetchable: 0 };
    const urls = knowledgeSourceMap();
    const mirror = builtinSourceCacheRoot();
    let missing = 0, fetchable = 0;
    for (const sub of shelf.subjects) {
        for (const d of sub.docs || []) {
            const rel = String(d.source || "");
            if (!rel || !DOC_EXT_RE.test(rel)) continue;
            let onDisk = false;
            for (const p of [path.join(mirror, rel), path.join(kroot, rel)]) {
                try { if (fs.statSync(p).isFile()) { onDisk = true; break; } }
                catch { /* try the next location */ }
            }
            if (onDisk) continue;
            missing++;
            if (urls[rel]) fetchable++;
        }
    }
    return { missing, fetchable };
}));

/**
 * OPEN A DOCUMENT AS ITSELF — or say precisely why it cannot be, and offer the
 * fix. The one answer this must never give is "not on disk".
 */
ipcMain.handle("lcl:openKnowledgeDoc", guard((_e, id) => {
    const r = resolveKnowledgeDocId(id);
    if (r.error) return { ok: false, error: r.error };
    if (!DOC_EXT_RE.test(r.rel)) {
        return { ok: false, error: "that is not a document this library serves" };
    }
    // readFull is the downloaded copy (writable data dir) when one exists,
    // otherwise the shipped resources path — so a fetched built-in source opens
    // even though it could never have been written under resources/.
    if (fs.existsSync(r.readFull) && fs.statSync(r.readFull).isFile()) {
        const view = readFileForViewer(r.readFull, r.rel);
        if (view && view.error) return { ok: false, error: view.error };
        return { ok: true, id: String(id), path: r.readFull, ...view };
    }
    // NOT INSTALLED IS A STATE WITH AN ACTION, not an error message.
    const src = r.addedByUser ? null : (knowledgeSourceMap()[r.rel] || null);
    return {
        ok: false, needsFetch: true, id: String(id),
        title: path.basename(r.rel),
        sourceUrl: src ? src.url : null,
        licence: src ? src.licence : null,
        searchBacked: !r.addedByUser,
        reason: src
            ? "the source document is not installed — it can be downloaded"
            : "the source document is not installed, and no download URL is " +
              "recorded for it"
    };
}));

/**
 * FETCH ONE SOURCE THE OPERATOR ASKED FOR.
 *
 * Narrow on purpose: it downloads the exact URL the shipped manifest records
 * for that id and nothing else — no redirect to a host the manifest does not
 * name, no caller-supplied URL, no automatic fetching of anything. Only a
 * renderer click reaches this, and the model has no path to it.
 */
ipcMain.handle("lcl:fetchKnowledgeSource", guard(async (_e, id) => {
    const r = resolveKnowledgeDocId(id);
    if (r.error) return { ok: false, error: r.error };
    if (r.addedByUser) {
        return { ok: false, error: "that document is in your own folder — there is " +
                                   "nothing to download" };
    }
    if (fs.existsSync(r.readFull)) return { ok: true, already: true, path: r.readFull };
    const src = knowledgeSourceMap()[r.rel];
    if (!src || !src.url) {
        return { ok: false, error: "no download URL is recorded for that document" };
    }
    // THE SAME SWITCH EVERYTHING ELSE OBEYS. networkAllowed() is the app's one
    // egress gate; a knowledge download that quietly had its own idea of
    // "offline" would be a second answer to a question that already has one.
    // `blocked` is what the panel reads to point at the switch by name.
    if (!networkAllowed()) {
        return { ok: false, blocked: "network",
                 error: "internet access is off, so nothing was fetched" };
    }
    try {
        const buf = await fetchToBuffer(src.url);
        // A TRUNCATED PDF KEEPS ITS HEADER AND LOSES ITS TRAILER, and that exact
        // failure has already cost this corpus two volumes once. Verified by
        // structure before anything is written where the reader will find it.
        const looksPdf = buf.slice(0, 4).toString() === "%PDF";
        if (/\.pdf$/i.test(r.rel) && !looksPdf) {
            // NOT truncation — the wrong KIND of thing came back. A recorded URL
            // that points at a landing page (everyspec's document pages fetch
            // 200 as HTML) or a captive portal produces a perfectly complete
            // download of something that is not the document. Say which
            // happened; "incomplete" sent the operator hunting a network
            // problem when the DATA (the recorded URL) was the defect.
            const asText = buf.slice(0, 512).toString("latin1").toLowerCase();
            const isHtml = asText.includes("<!doctype") || asText.includes("<html");
            logError("knowledge-fetch", new Error(isHtml ? "url serves a web page" : "not a PDF"),
                     { doc: String(id), url: src.url });
            return { ok: false, error: isHtml
                ? "the recorded URL serves a web page, not the document — the " +
                  "manifest likely points at the document's landing page instead " +
                  "of the file itself. Nothing was kept"
                : "what came back is not a PDF — nothing was kept" };
        }
        if (/\.pdf$/i.test(r.rel) &&
            !buf.slice(-2048).toString("latin1").includes("%%EOF")) {
            logError("knowledge-fetch", new Error("PDF missing trailer"),
                     { doc: String(id), url: src.url });
            return { ok: false, error: "the download arrived incomplete " +
                     "(the PDF is missing its trailer) — nothing was kept" };
        }
        // built-in downloads go to the writable cache mirror (r.cacheFull);
        // a user library's cacheFull IS its own writable path
        const dest = r.cacheFull;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        auditLog.write({ kind: "knowledge-source-fetched", doc: String(id),
                         url: src.url, bytes: buf.length, dest, at: Date.now() });
        return { ok: true, path: dest, bytes: buf.length };
    } catch (err) {
        logError("knowledge-fetch", err, { doc: String(id), url: src && src.url });
        return { ok: false, error: String((err && err.message) || err) };
    }
}));

/** One GET, redirects followed only within the manifest's own scheme. */
function fetchToBuffer(url, depth = 0) {
    return new Promise((resolve, reject) => {
        if (depth > 5) return reject(new Error("too many redirects"));
        let u;
        try { u = new URL(url); } catch { return reject(new Error("bad URL")); }
        if (u.protocol !== "https:") return reject(new Error("only https sources are fetched"));
        // BROWSER-GRADE headers, same as the engine path (knowledge.js
        // httpsDownload): many document hosts sit behind bot-scoring fronts —
        // DOE, everyspec and NASA NTRS all answer a bare Node GET with 403 and
        // the same request with these headers 200 (measured across the whole
        // corpus). The operator chose this URL; fetch it the way a browser would.
        const rq = require("https").get(u, { timeout: 60_000, headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/pdf," +
                "application/octet-stream,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9"
        } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(fetchToBuffer(new URL(res.headers.location, u).href, depth + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`the host answered ${res.statusCode}`));
            }
            const chunks = [];
            let n = 0;
            res.on("data", (c) => {
                n += c.length;
                if (n > 300_000_000) { rq.destroy(); return reject(new Error("that document is implausibly large")); }
                chunks.push(c);
            });
            res.on("end", () => resolve(Buffer.concat(chunks)));
        });
        rq.on("timeout", () => { rq.destroy(); reject(new Error("the host did not respond")); });
        rq.on("error", (e) => reject(new Error(String(e.message || e))));
    });
}

/**
 * Read one document, one window of pages.
 *
 * Two sources, in this order:
 *
 *   knowledge/text/<doc>.txt   the shipped extraction. Present in every
 *                              installed build, page-marked, and the exact text
 *                              the model was indexed on — so what you read is
 *                              what it was given, which is the entire point of
 *                              being able to read it.
 *
 *   the original PDF           only in a dev checkout or a user-added library.
 *                              Parsed with the same pdf.js path the indexer
 *                              uses.
 *
 * The PDF path used to be the only one, which is why the reader was dead in
 * every installed copy: there are no PDFs in a packaged build.
 */
ipcMain.handle("lcl:readKnowledgeDoc", async (_e, rel, from, count) => {
    try {
        const root = path.join(paths.resourceRoot(), "knowledge");
        const asked = String(rel || "");
        const start0 = Math.max(1, parseInt(from, 10) || 1);
        const want0 = Math.min(40, Math.max(1, parseInt(count, 10) || 6));

        // --- the extracted text, if we have it ---------------------------
        const textRel = asked.replace(/\.[a-z0-9]+$/i, "") + ".txt";
        const textFull = path.resolve(root, "text", textRel);
        if (textFull.startsWith(path.resolve(root, "text") + path.sep)
            && fs.existsSync(textFull)) {
            const body = fs.readFileSync(textFull, "utf8");
            // \f[page N]\n ... — the marker written by build-knowledge-text.js
            const parts = body.split(/\f\[page (\d+)\]\n/);
            // split on a capturing group: ["", "1", text, "2", text, …]
            const pages = [];
            for (let i = 1; i < parts.length; i += 2) {
                pages.push({ page: Number(parts[i]), text: (parts[i + 1] || "").trim() });
            }
            const window = pages.filter(p => p.page >= start0 && p.page < start0 + want0);
            return {
                file: asked,
                pages: window,
                from: start0,
                returned: window.length,
                totalPages: pages.length,
                more: pages.length > 0 && start0 + want0 <= pages[pages.length - 1].page,
                source: "extracted"
            };
        }

        // --- otherwise the original document -----------------------------
        const full = path.resolve(root, asked);
        // containment: a crafted rel must not escape the corpus
        if (!full.startsWith(path.resolve(root) + path.sep)) {
            return { error: "outside the knowledge folder" };
        }
        if (!fs.existsSync(full)) {
            return { error: "that document is not installed — reinstall .lcl " +
                            "to restore the built-in library" };
        }
        if (/\.(txt|md)$/i.test(full)) {
            const body = fs.readFileSync(full, "utf8");
            // plain text has no pages; window it by a fixed slab so the reader
            // behaves the same either way
            const PER = 3000;
            const total = Math.max(1, Math.ceil(body.length / PER));
            const window = [];
            for (let p = start0; p < start0 + want0 && p <= total; p++) {
                window.push({ page: p, text: body.slice((p - 1) * PER, p * PER) });
            }
            return { file: asked, pages: window, from: start0, returned: window.length,
                     totalPages: total, more: start0 + want0 <= total, source: "file" };
        }
        const start = start0, want = want0;
        // extractPdfPages(fullPath, { maxPages, includeEmpty }) returns a flat
        // ARRAY of {page, text} — checked against docTools.js rather than
        // assumed. It walks from page 1, so cap the walk at the last page we
        // need and slice the window out of the result.
        const all = await docTools.extractPdfPages(full, {
            maxPages: start + want - 1,
            includeEmpty: true,         // a blank page is still a page to turn
            // The 50 MB default is an INDEXING guard — it stops a huge scan
            // eating an hour of OCR. Reading six pages costs nothing like that,
            // and the cap was blocking the largest books in the corpus outright:
            // Light and Matter is 82 MB and simply would not open.
            maxBytes: 400_000_000
        });
        const pages = all.filter(pg => pg.page >= start && pg.page < start + want);
        return { file: asked, pages, from: start, returned: pages.length,
                 // there is more if the walk hit our cap rather than the end
                 more: all.length >= start + want - 1, source: "pdf" };
    } catch (err) {
        return { error: String(err.message || err) };
    }
});

ipcMain.handle("lcl:profile", guard(() => ({
    profile: profile.read(), summary: profile.summary(), caps: profile.CAPS
})));
ipcMain.handle("lcl:setProfile", guard((_e, next) => {
    const saved = profile.write(next || {});
    auditLog.write({ kind: "profile-updated",
                     fields: Object.keys(next || {}), at: Date.now() });
    return { ok: true, profile: saved, summary: profile.summary() };
}));

ipcMain.handle("lcl:setPreferredModel", guard((_e, id) => {
    const v = id ? String(id) : null;
    paths.writeSettings({ preferredModel: v });
    auditLog.write({ kind: "preferred-model", model: v, at: Date.now() });
    return { ok: true, preferredModel: v };
}));

// The estimate is for THIS SESSION's endpoint: with one session on a paid API
// and another on the node, a single global figure is wrong for at least one of
// them — and the composer showing a price for a conversation that costs nothing
// (or nothing for one that costs) is the disagreement this feature removes.
ipcMain.handle("lcl:estimateCost", guard((_e, text, contextTokens, sessionId) => {
    const _s = sessionId ? sessions.load(sessionId) : null;
    const sel = _s ? cloudModels.resolveSelection(_s).sel : cloudModels.selected();
    if (!sel) return { remote: false };
    // THE ONE CASE WHERE THE ANSWER IS A NUMBER AND NOT A SHRUG. A model on the
    // user's own node has no rate to look up and needs none: it is $0, and the
    // token counts beside it are still worth showing because they are what the
    // node's memory is actually spent on.
    const localNode = cloudModels.isNodeEndpoint(sel);
    return {
        remote: true,
        localNode,
        model: sel.model,
        endpoint: sel.label,
        ...tokenCost.estimateCost(String(text || ""), sel.model,
                                  { contextTokens: contextTokens || 0, localNode })
    };
}));

// Shipped rates go stale. This is how the user corrects them.
ipcMain.handle("lcl:setModelRate", guard((_e, modelId, rate) => {
    const r = tokenCost.setRate(String(modelId || ""), rate || null);
    auditLog.write({ kind: "model-rate-set", model: String(modelId || ""),
                     inPerM: r && r.in, outPerM: r && r.out, at: Date.now() });
    return { ok: true, rate: r, all: tokenCost.allRates() };
}));

ipcMain.handle("lcl:modelRates", guard(() => ({
    rates: tokenCost.allRates(), asOf: tokenCost.SHIPPED_RATES_AS_OF
})));

// the shipped capability catalog — providers, models, editorial caps
ipcMain.handle("lcl:modelIntel", guard(() =>
    require("../.lcl.engine/core/modelIntel").catalog()));

ipcMain.handle("lcl:connectCloud", async (_e, pasted, opts) => {
    try {
        // opts is the half of the answer the pasted address does not contain:
        // { rented, provider } for a GPU billed by the hour. It is FORWARDED,
        // not re-derived — connect() hands it to linkEndpoint, which is the one
        // place an endpoint's kind is decided. Without this the checkbox in the
        // Connect box changed nothing and a rented box was billed as if the
        // operator owned it.
        const r = await cloudModels.connect(pasted, opts || {});
        auditLog.write({ kind: "cloud-connected", endpoint: r.endpoint.id,
                         baseUrl: r.endpoint.baseUrl, model: r.model,
                         models: r.models.length, shape: r.shape,
                         rented: !!(opts && opts.rented),
                         provider: (opts && opts.provider) || null,
                         keyStored: r.keyState && r.keyState.stored, at: Date.now() });
        return { ok: true, endpoint: r.endpoint, model: r.model,
                 models: r.models, summary: r.summary, keyState: r.keyState };
    } catch (err) {
        const error = cloudModels.scrub(String((err && err.message) || err));
        // A FAILED CONNECT LEAVES EVIDENCE — the OpenRouter attempt left no
        // endpoint, no key, no line anywhere. The reason is scrubbed; the
        // pasted text itself is NEVER logged — it contains the credential.
        try { auditLog.write({ kind: "cloud-connect-failed", error,
                               at: Date.now() }); } catch { /* never fail the reply */ }
        return { ok: false, error };
    }
});

ipcMain.handle("lcl:linkCloudEndpoint", guard((_e, spec) => {
    const r = cloudModels.linkEndpoint(spec || {});
    auditLog.write({ kind: "cloud-endpoint-linked", endpoint: r.id,
                     baseUrl: r.baseUrl, keyStored: r.keyState && r.keyState.stored,
                     encrypted: !!(r.keyState && r.keyState.encrypted), at: Date.now() });
    // hasKey is a boolean; the key itself never crosses this boundary
    return { ok: true, endpoint: { id: r.id, label: r.label, baseUrl: r.baseUrl,
                                   hasKey: r.hasKey, models: r.models },
             keyState: r.keyState, endpoints: cloudModels.endpoints() };
}));

ipcMain.handle("lcl:unlinkCloudEndpoint", guard((_e, id) => {
    const r = cloudModels.unlinkEndpoint(String(id || ""));
    auditLog.write({ kind: "cloud-endpoint-unlinked", endpoint: String(id || ""), at: Date.now() });
    return { ...r, endpoints: cloudModels.endpoints() };
}));

ipcMain.handle("lcl:setCloudKey", guard((_e, id, key) => {
    const st = key ? cloudModels.putKey(String(id || ""), key)
                   : cloudModels.clearKey(String(id || ""));
    auditLog.write({ kind: "cloud-key-set", endpoint: String(id || ""),
                     stored: st.stored, encrypted: !!st.encrypted, at: Date.now() });
    return { ok: true, keyState: st, endpoints: cloudModels.endpoints() };
}));

ipcMain.handle("lcl:testCloudEndpoint", async (_e, id) => {
    try { return await cloudModels.testEndpoint(String(id || "")); }
    catch (err) { return { ok: false, status: 0, detail: String(err.message || err) }; }
});

ipcMain.handle("lcl:discoverCloudModels", async (_e, id) => {
    // A FAILED REFRESH LEAVES EVIDENCE. The card shows the error and then the
    // operator closes the panel — "Refresh failed" was all
    // that survived, and a defect nobody can read the message of is a defect
    // nobody can fix. Both outcomes are recorded, with the reason.
    const started = Date.now();
    try {
        const r = await cloudModels.discoverModels(String(id || ""));
        auditLog.write({ kind: "endpoint-refresh", endpoint: String(id || ""),
                         ok: true, models: (r.models || []).length,
                         keyRejected: !!r.keyRejected,
                         ms: Date.now() - started, at: Date.now() });
        return { ok: true, ...r };
    } catch (err) {
        const message = String((err && err.message) || err);
        auditLog.write({ kind: "endpoint-refresh", endpoint: String(id || ""),
                         ok: false, error: message,
                         // WHICH PHASE STALLED — dns / tcp / tls / reply. A
                         // timeout reports all four identically otherwise.
                         phase: (err && err.phase) || null,
                         phaseMs: (err && err.phaseMs) || null,
                         ms: Date.now() - started, at: Date.now() });
        return { ok: false, error: message };
    }
});

ipcMain.handle("lcl:selectCloudModel", guard((_e, spec) => {
    const role = (spec && spec.role) || "driver";
    const next = cloudModels.selectModel({ ...(spec || {}), role });
    auditLog.write({ kind: "cloud-model-selected", role,
                     endpoint: (spec && spec.endpointId) || null,
                     model: (spec && spec.model) || null,
                     enabled: !!next.enabled, at: Date.now() });
    return { ok: true, config: next, available: cloudModels.available(),
             hasReasoner: cloudModels.hasReasoner(),
             roles: { driver: cloudModels.selectedFor("driver"),
                      reasoner: cloudModels.selectedFor("reasoner") } };
}));

ipcMain.handle("lcl:setBehavior", guard((_e, key, value) => {
    const k = String(key || "");
    if (k === "writeMode") {
        const v = value === "confirm" ? "confirm" : "notify";
        paths.writeSettings({ writeMode: v });
        // reach the LIVE kernels too, not just the next session.
        // `policy` was never a binding in this file — the module is required at
        // the top as `policyBridge`. guard() caught the ReferenceError and
        // handed the renderer {error:"policy is not defined"}, which it
        // swallowed, so "ask before every write" was written to settings and
        // never applied to a running kernel. Measured, then fixed:
        //   setBehavior writeMode confirm -> {"error":"policy is not defined"}
        policyBridge.applyWriteMode(v);
        return { ok: true, key: k, value: v };
    }
    if (k === "groundingEnabled") {
        paths.writeSettings({ groundingEnabled: value !== false });
        return { ok: true, key: k, value: value !== false };
    }
    if (k === "cloudAutoApprove") {
        // the "do not ask every time" setting. OFF is now the thing that matters: with
        // it off, lcl:chat asks before every remote call (K3), and the tool
        // path stays at CONFIRM. On, both are relaxed together — the meter
        // beside the composer still states the cost before sending, the audit
        // log still records every call, and the secret guard still refuses to
        // let a credential leave regardless of this setting.
        const on = value === true;
        paths.writeSettings({ cloudAutoApprove: on });
        // same ReferenceError as writeMode above: `policy` does not exist here.
        policyBridge.applyCloudAutoApprove(on);
        auditLog.write({ kind: "cloud-auto-approve", enabled: on, at: Date.now() });
        return { ok: true, key: k, value: on };
    }
    if (k === "consentNotify") {
        // whether a waiting leave-machine ask raises an OS notification when
        // the window is not being watched. Default on; the gate itself is
        // untouched either way — this only governs the toast.
        paths.writeSettings({ consentNotify: value !== false });
        return { ok: true, key: k, value: value !== false };
    }
    return { error: "unknown behavior setting" };
}));

// The task ledger: what is running, what ran, and the ability to stop it.
ipcMain.handle("lcl:listTasks", guard((_e, opts) => ({ tasks: tasks.list(opts || {}) })));
ipcMain.handle("lcl:cancelTask", guard((_e, id) => tasks.cancel(String(id || ""))));
ipcMain.handle("lcl:clearFinishedTasks", guard(() => tasks.clearFinished()));

// Research folders the agent built. They are ordinary folders of markdown, so
// adopting one is the same add() any other folder gets — no special path, and
// no elevated trust just because we wrote it.
ipcMain.handle("lcl:listResearch", guard(() => ({ folders: research.listFolders() })));
ipcMain.handle("lcl:adoptResearch", guard((_e, id, dir) => {
    const folders = research.listFolders();
    const found = folders.find(f => f.dir === dir);
    if (!found) return { error: "unknown research folder" };
    const lib = knowledge.add(found.dir, found.topic || found.name);
    runReindex(id, lib);
    return { library: { ...lib, files: 0, chunks: 0 } };
}));

ipcMain.handle("lcl:listLibraries", guard(() => ({ libraries: knowledge.list() })));
// what is actually in the index — so "3,480 passages" can be inspected rather
// than taken on trust, which for OCR'd scans is the only question that matters
ipcMain.handle("lcl:libraryContents", guard((_e, libId, opts) =>
    knowledge.contents(String(libId || ""), opts || {})));

ipcMain.handle("lcl:addLibrary", async (_e, id) => {
    const picked = await dialog.showOpenDialog(mainWindow, {
        title: "Choose a knowledge folder",
        buttonLabel: "Add as knowledge",
        properties: ["openDirectory"]
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };

    let folder;
    try { folder = fs.realpathSync(picked.filePaths[0]); }
    catch { return { error: "could not resolve that folder" }; }
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        return { error: "not a directory" };
    }
    const root = path.parse(folder).root;
    if (path.resolve(folder) === path.resolve(root)) {
        return { error: "refusing to index a whole drive — pick a specific folder" };
    }
    if (sensitiveRoots().has(folder) ||
        path.resolve(folder).toLowerCase() === path.join(root, "Users").toLowerCase()) {
        return { error: "refusing to index a home or system directory — pick a specific folder" };
    }
    if (looksLikeSecretDir(folder)) {
        return { error: "refusing to index a credential or app-data directory (.ssh, AppData, and the like)" };
    }

    const confirm = await dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Add knowledge library",
        message: "Let .lcl read this folder as reference knowledge?",
        detail:
            `${folder}\n\n` +
            "The agent will READ these files to ground and cite its answers. It " +
            "never writes to this folder. A private index is stored in app data.",
        buttons: ["Add", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    });
    if (confirm.response !== 0) return { canceled: true };

    const lib = knowledge.add(folder);
    runReindex(id, lib);                       // index in the background
    return { library: { ...lib, files: 0, chunks: 0 } };
});

ipcMain.handle("lcl:reindexLibrary", guard((_e, _id, libId) => {
    const lib = knowledge.list().find(l => l.id === libId);
    if (!lib) return { error: "unknown library" };
    runReindex(_id, lib);
    return { ok: true };
}));

ipcMain.handle("lcl:removeLibrary", guard((_e, _id, libId) => knowledge.remove(libId)));

ipcMain.handle("lcl:revealFolder", async (_e, folder) => {
    if (typeof folder !== "string" || !folder || !fs.existsSync(folder)) {
        return { ok: false, error: "folder not found" };
    }
    const err = await shell.openPath(folder);
    return { ok: !err, error: err || undefined };
});

// Which localhost servers are LIVE right now — so a chat "Open the served site"
// button can tell a live url from one whose server died on an app restart
// (servers are in-process; the persisted tool message keeps the old port).
ipcMain.handle("lcl:listServers", guard(async () => {
    try { return { ok: true, servers: serve.listServers() }; }
    catch { return { ok: true, servers: [] }; }
}));

/* ----------------------------------------------------------------------------
 * GITHUB AS A CONNECTED ACCOUNT (APIs & Connections). "make that a global under
 * apis and connections, as a connected account... it is essentially a storage
 * account." Sign-in is GCM's browser OAuth; the token is stored by GCM, never
 * seen here. Connecting does NOT touch tool policy — all permissions are
 * per-conversation, so git_clone / github_sign_in are granted per session on the
 * approval card (which sticks now that they carry a notify sessionFloor). No
 * app-wide grant is minted from connecting an account.
 * ------------------------------------------------------------------------- */
ipcMain.handle("lcl:githubStatus", guard(async () => githubAuth.status()));

ipcMain.handle("lcl:githubConnect", guard(async () => githubAuth.signIn()));

ipcMain.handle("lcl:githubDisconnect", guard(async (_e, account) => githubAuth.logout(account)));

/* ----------------------------------------------------------------------------
 * PATCH NOTIFICATION — know when a newer installer is waiting, and apply it with
 * one click. The product should detect that a patch is ready and show a physical
 * button when the running .lcl differs from the installer — a real patch system
 * clickable from the UI that initiates the installer, the same as launching it
 * by hand. The running app carries a build fingerprint (release.js
 * bakes resources/build-info.json); the installer drops a matching
 * dist/build-info.json beside it. Different id + a real installer = a patch.
 * ------------------------------------------------------------------------- */
function readBuildInfo(file) {
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return (j && j.buildId) ? j : null; }
    catch { return null; }
}
function runningBuild() {
    return readBuildInfo(path.join(paths.resourceRoot(), "build-info.json"));
}
function patchChannelDir() {
    const s = paths.readSettings().patchChannelDir;
    return (s && typeof s === "string" && s.trim()) ? s : "C:\\.lcl\\dist";
}
async function availablePatch() {
    const running = runningBuild();
    // WHERE we look is a CHANNEL (see the design notes): a local dir today, a GitHub
    // release once configured. One detection path serves both; a github channel
    // fetches over the network, a local channel reads the dist directory.
    const patchChannel = require("../.lcl.engine/core/patchChannel");
    const channel = patchChannel.resolveChannel(paths.readSettings());
    const source = channel.kind;
    let latest = null, hasInstaller = false;
    try {
        const res = await channel.latest();
        if (res) {
            latest = res.info;
            if (channel.kind === "local") {
                // the local installer file must actually exist on disk
                try { hasInstaller = fs.statSync(path.join(patchChannelDir(),
                    `lcl-Installer-${app.getVersion()}.exe`)).isFile(); } catch { /* none */ }
            } else {
                // a SIGNED release must carry BOTH this platform's installer asset
                // AND the signature — without either there is nothing safe to fetch
                const assets = (res.release && res.release.assets) || [];
                const match = patchChannel.installerAssetMatcher(process.platform, app.getVersion());
                hasInstaller = assets.some((a) => match(a.name))
                    && assets.some((a) => a.name === "build-info.json.sig");
            }
        }
    } catch { /* offline / unreachable channel → simply no patch, never a crash */ }
    // TWO LANES (see the design notes). Only the OFFICIAL base decides "am I behind":
    // an update is offered when the channel's official number is strictly higher.
    // The LOCAL marker (a machine's own customizations on top of the base) NEVER
    // participates in the newer test and never impersonates the base — it is
    // display-only, so a local rebuild can never read as an official update.
    // Only a real `official` number is a lane number. An app installed before the
    // lanes existed carries a legacy `buildNumber` in a DIFFERENT numbering space
    // — never compare the two as if they were one lane (a legacy #1 and an
    // official #1 are unrelated builds). When either side lacks `official`, fall
    // back to the exact buildId (any difference = a patch): the one upgrade that
    // crosses the lane boundary, and it always offers the newer official build.
    const offOf = (b) => b && Number.isInteger(b.official) ? b.official : null;
    const rOff = offOf(running);
    const lOff = offOf(latest);
    const newer = (rOff !== null && lOff !== null)
        ? lOff > rOff
        : !!(running && running.buildId && latest && latest.buildId
             && latest.buildId !== running.buildId);
    // offered ONLY when we know our OWN build, a NEWER official one is published,
    // and the installer carrying it actually exists — never a false alarm in dev
    // (no baked build-info) or when the channel is empty
    const available = !!(running && running.buildId && latest && latest.buildId
        && newer && hasInstaller);
    const localOf = (b) => b && Number.isInteger(b.local) ? b.local : 0;
    // NO installer path leaves here for a network channel: the launch path
    // obtains + VERIFIES the file itself (applyPatch), so nothing downstream can
    // be handed an unverified binary to run.
    return { available,
             running: running || null, latest: latest || null,
             // the two lanes the banner renders: the official base each side is on,
             // the running copy's local divergence, and where the offer came from
             runningOfficial: rOff, latestOfficial: lOff,
             runningLocal: localOf(running),
             source,
             builtAt: (latest && latest.builtAt) || null };
}

ipcMain.handle("lcl:patchStatus", guard(async () => availablePatch()));

// A helper so BOTH the local and the network path launch the SAME way: shell,
// not spawn(). The installer is admin-manifested, so a plain spawn fails with
// ELEVATION_REQUIRED — async, after we'd already quit, so the app closed and
// nothing ran. shell.openPath raises UAC and actually starts it; we quit only
// once it has launched.
async function launchInstaller(installerPath) {
    let err = "";
    try { err = await shell.openPath(installerPath); }
    catch (e) { err = String((e && e.message) || e); }
    if (err) return { ok: false, error: "could not start the installer: " + err };
    // NEVER QUIT ON THE SHELL'S WORD ALONE. openPath reporting success only
    // means the shell ACCEPTED the request — the UAC consent may still be
    // pending, dismissed, or torn down. Measured live: a github patch
    // downloaded, verified, quit the app on this answer, and installed
    // nothing. So wait until the installer PROCESS actually exists (the
    // consent was approved and it is running) before quitting; if it never
    // appears, say so honestly and stay open so the operator can retry.
    const imageName = path.basename(installerPath);
    const started = await new Promise((resolve) => {
        const { execFile } = require("child_process");
        let waited = 0;
        const tick = () => {
            execFile("tasklist.exe",
                ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
                (e, out) => {
                    if (!e && String(out || "").toLowerCase()
                            .includes(imageName.toLowerCase())) return resolve(true);
                    waited += 2000;
                    if (waited >= 120_000) return resolve(false);
                    setTimeout(tick, 2000);
                });
        };
        setTimeout(tick, 2000);
    });
    if (!started) {
        return { ok: false, error: "the installer never started — if the Windows " +
                 "permission prompt was dismissed or timed out, click Patch Ready " +
                 "to try again. Nothing was changed." };
    }
    setTimeout(() => { try { app.quit(); } catch { /* already quitting */ } }, 1500);
    return { ok: true };
}

ipcMain.handle("lcl:applyPatch", guard(async () => {
    const patchChannel = require("../.lcl.engine/core/patchChannel");
    const channel = patchChannel.resolveChannel(paths.readSettings());

    // LOCAL CHANNEL: the installer is a file already on the user's own disk
    // (dev builds, the self-patch pipeline). Trusted as-is — launch it.
    if (channel.kind === "local") {
        const installer = path.join(patchChannelDir(), `lcl-Installer-${app.getVersion()}.exe`);
        if (!fs.existsSync(installer)) return { ok: false, error: "no patch is available" };
        return launchInstaller(installer);
    }

    // NETWORK CHANNEL (github): a fetched installer runs WITH ADMIN, so it MUST
    // pass the trust gate first. obtainInstaller downloads to an app-private path
    // and verifies integrity + Ed25519 signature + rollback, returning ONLY a
    // verified path — and we launch that SAME file (no TOCTOU). There is no branch
    // here that can shell.openPath an unverified binary.
    const latest = await channel.latest();
    if (!latest) return { ok: false, error: "the update channel has no release to offer" };
    const running = runningBuild();
    // NAME THE CACHE FILE BY WHAT IT CONTAINS — the INCOMING release's version,
    // never the running app's. Naming it by app.getVersion() produced a
    // "lcl-Installer-1.0.1.exe" that actually held the 1.0.2 payload, which sat
    // beside a REAL old 1.0.1 installer in dist/ — and the operator, told to run
    // "the 1.0.1 installer", reinstalled the old build. Sanitized strictly:
    // this string comes from the channel BEFORE the signature is verified, so it
    // must never be able to shape a path.
    const claimed = String((latest.info && latest.info.version) || "");
    const incoming = /^[0-9A-Za-z][0-9A-Za-z.-]{0,40}$/.test(claimed) ? claimed : app.getVersion();
    const dest = path.join(paths.dataDir(), "patch-cache", `lcl-Installer-${incoming}.exe`);
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* exists */ }
    const got = await channel.obtainInstaller(latest, {
        version: app.getVersion(), platform: process.platform, destPath: dest,
        installedOfficial: running && Number.isInteger(running.official) ? running.official : null,
        onProgress: (pr) => { try {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lcl:patch-progress", pr);
        } catch { /* window gone */ } },
    });
    if (!got.ok) return { ok: false, error: "update refused: " + got.reason };
    return launchInstaller(got.installerPath);
}));

async function pushPatchStatus() {
    try {
        const p = await availablePatch();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("lcl:patch-available", p);
        }
    } catch { /* non-fatal */ }
}
// tell the renderer shortly after launch, then on a slow poll (a new installer
// can land while the app is open)
setTimeout(pushPatchStatus, 4000);
{ const t = setInterval(pushPatchStatus, 60_000); if (t.unref) t.unref(); }

/* ----------------------------------------------------------------------------
 * OPEN IN — launch the linked workspace folder in whatever app the operator
 * keeps their work in. "there are other softwares capable of things": File
 * Explorer and VS Code are detected; anything else is added once through the OS
 * app picker and remembered. Local, operator-initiated, opens their OWN folder
 * — no network, no credentials, so it needs no approval card.
 * ------------------------------------------------------------------------- */
const OPENERS_KEY = "openWithApps";   // persisted custom launchers: [{name, path}]

/** The VS Code CLI shim, by PATH first, then its default per-user install. */
function detectVSCode() {
    const firstLine = (cmd, arg) => {
        try {
            const out = execFileSync(cmd, [arg], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            const hit = String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
            return hit && fs.existsSync(hit) ? hit : null;
        } catch { return null; }
    };
    if (process.platform === "win32") {
        const byPath = firstLine("where", "code.cmd") || firstLine("where", "code");
        if (byPath) return byPath;
        for (const g of [
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "bin", "code.cmd"),
            path.join(process.env.ProgramFiles || "", "Microsoft VS Code", "bin", "code.cmd")
        ]) if (g && fs.existsSync(g)) return g;
        return null;
    }
    return firstLine("which", "code");
}

function readOpeners() {
    const raw = paths.readSettings()[OPENERS_KEY];
    return Array.isArray(raw) ? raw.filter(o => o && o.path && o.name) : [];
}

ipcMain.handle("lcl:listOpeners", guard(async () => {
    const list = [{ id: "explorer", name: process.platform === "win32" ? "File Explorer" : "Files", builtin: true }];
    const code = detectVSCode();
    if (code) list.push({ id: "vscode", name: "VS Code", builtin: true });
    for (const o of readOpeners()) {
        list.push({ id: "custom:" + o.path, name: o.name, removable: true });
    }
    return { ok: true, openers: list };
}));

ipcMain.handle("lcl:openWith", guard(async (_e, opener, folder) => {
    if (typeof folder !== "string" || !folder || !fs.existsSync(folder)) {
        return { ok: false, error: "folder not found" };
    }
    const id = String(opener || "");
    try {
        if (id === "explorer") {
            const err = await shell.openPath(folder);
            return { ok: !err, error: err || undefined };
        }
        if (id === "vscode") {
            const code = detectVSCode();
            if (!code) return { ok: false, error: "VS Code was not found on this machine" };
            // code.cmd is a batch shim: on Windows it must go through the shell,
            // and a quoted command string survives spaces in either path
            spawn(`"${code}" "${folder}"`,
                { detached: true, stdio: "ignore", windowsHide: true, shell: true }).unref();
            return { ok: true };
        }
        if (id.startsWith("custom:")) {
            const appPath = id.slice(7);
            if (!appPath || !fs.existsSync(appPath)) {
                return { ok: false, error: "that app is no longer at its saved location" };
            }
            // a batch shim (.cmd/.bat) must go through the shell like code.cmd;
            // a normal .exe takes the folder as a plain argument
            if (/\.(cmd|bat)$/i.test(appPath)) {
                spawn(`"${appPath}" "${folder}"`,
                    { detached: true, stdio: "ignore", windowsHide: true, shell: true }).unref();
            } else {
                spawn(appPath, [folder], { detached: true, stdio: "ignore", windowsHide: true }).unref();
            }
            return { ok: true };
        }
        return { ok: false, error: "unknown opener" };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}));

// -------------------------------------------------------------
// CONTRIBUTOR SHIP (Patch menu → Ship a release…)
// -------------------------------------------------------------
/**
 * The operator's whole release ritual — add, commit, push, gate+build,
 * publish — run from the app, for CONTRIBUTORS only: a person with the gh
 * CLI authenticated and push rights on the repo their checkout points at.
 * "these can not run concurrently, so we have to know when one finished, so
 * the next can run. so we need to be measuring the output of the command and
 * visualizing it." Every step is one spawned process, awaited to exit,
 * stdout/stderr streamed to the renderer line by line; a non-zero exit stops
 * the chain where it stands. Identity, versions, tag and artifact names are
 * READ from the checkout and from gh — never hardcoded.
 */
let contribRunState = null;      // { cancelled, child, transcript } while a run is live
// THE LAST RUN'S EVIDENCE SURVIVES — every step's output, its states, and
// where it stopped. The first failed run recorded only "git push exited 1"
// and reopening the panel wiped the consoles; the operator's standing rule
// is that failures are debugged from logs, not from a prompt he has to
// screenshot before it vanishes.
let contribLastRun = null;

// THE THREE FILES THE BUMP ITSELF EDITS. Lane bookkeeping is never patch
// content: a run's own residue (a bump that never got committed) must not
// light the ready badge, arm the run button, or count as "an available
// patch" — the operator's rule, verbatim: the badge is about "whether there
// was an available patch or not only".
const CONTRIB_LANE_FILES = new Set([
    "app/package.json", "devtools/RELEASE.json", "devtools/installer/package.json"]);
function contribContentFiles(porcelainOut) {
    return String(porcelainOut || "").split(/\r?\n/).filter(l => l.trim())
        .filter(l => !CONTRIB_LANE_FILES.has(l.slice(3).trim().replace(/\\/g, "/")));
}

function contribRepoRoot() {
    const p0 = paths.readSettings().contribRepoPath;
    if (!p0) return null;
    try {
        if (!fs.existsSync(path.join(p0, ".git"))) return null;
        if (!fs.existsSync(path.join(p0, "devtools", "release.js"))) return null;
        if (!fs.existsSync(path.join(p0, "app", "package.json"))) return null;
        return p0;
    } catch { return null; }
}

function contribExec(bin, args, cwd, timeoutMs = 20000) {
    try {
        return { ok: true, out: execFileSync(bin, args,
            { cwd, encoding: "utf8", timeout: timeoutMs,
              stdio: ["ignore", "pipe", "pipe"] }).trim() };
    } catch (e) {
        return { ok: false, out: String((e && (e.stdout || e.message)) || e).trim() };
    }
}

/** owner/repo from the checkout's origin URL — https or ssh, either form. */
function contribRemote(repo) {
    const r = contribExec("git", ["remote", "get-url", "origin"], repo);
    if (!r.ok) return null;
    const m = r.out.match(/github\.com[:/]([^/]+)\/([^/.\s]+)/);
    return m ? { owner: m[1], repo: m[2], url: r.out } : null;
}

/**
 * THE APP FINDS ITS OWN CHECKOUT. "why are we giving the option to use
 * another location" — because the installed app is not a git checkout; but
 * asking was lazy: the patch channel already names the repo this app patches
 * FROM, and the operator's own sessions say where they work. Any session
 * folder that is a git checkout whose origin matches the channel IS the
 * checkout. Found once, saved, said out loud. The picker survives only as
 * the fallback for a contributor whose checkout has never been a session.
 */
function contribDiscoverRepo() {
    const set = contribRepoRoot();
    if (set) return { repo: set, how: "linked" };
    // WHICH REPO AM I FROM — answered by the INSTALLATION ITSELF first: the
    // build stamps its checkout's origin into the baked build-info at release
    // time, so the installed app reads its own identity. The patch-channel
    // setting stands in only for builds cut before the stamp existed.
    let ident = null;
    const baked = runningBuild();
    if (baked && baked.repo && baked.repo.owner && baked.repo.repo) {
        ident = baked.repo;
    } else {
        let chan = null;
        try { chan = paths.readSettings().patchChannel; } catch { }
        if (chan && chan.kind === "github" && chan.owner && chan.repo) {
            ident = { owner: chan.owner, repo: chan.repo };
        }
    }
    if (!ident) return { repo: null };
    const want = (ident.owner + "/" + ident.repo).toLowerCase();
    const seen = new Set();
    let sums = [];
    try { sums = sessions.list() || []; } catch { }
    for (const s0 of sums) {
        const rp = s0 && s0.repoPath;
        if (!rp || seen.has(rp)) continue;
        seen.add(rp);
        try {
            if (!fs.existsSync(path.join(rp, ".git"))) continue;
            if (!fs.existsSync(path.join(rp, "devtools", "release.js"))) continue;
            const r = contribExec("git", ["remote", "get-url", "origin"], rp, 8000);
            if (!r.ok) continue;
            const m = r.out.match(/github\.com[:/]([^/]+)\/([^/.\s]+)/);
            if (m && (m[1] + "/" + m[2]).toLowerCase() === want) {
                paths.writeSettings({ contribRepoPath: rp });
                return { repo: rp, how: "discovered" };
            }
        } catch { /* the next candidate */ }
    }
    return { repo: null, channel: ident.owner + "/" + ident.repo };
}

/* READY-TO-CUT, CHEAPLY. The Patch badge asks this at boot and when the menu
 * opens, so it must never spawn gh or touch the network — pure local git on
 * the ALREADY-LINKED checkout (no discovery scan at boot). "Ready" = there
 * is something a contributor could cut right now: uncommitted changes, or
 * commits origin does not have (a failed push, an unshipped resume). */
/* CONTRIBUTOR OR NOT — the cheap check that decides whether "Release Patch"
 * is even VISIBLE. A logged-in non-contributor (gh installed and authed, but
 * no push rights on this app's repo, or no linked checkout at all) must never
 * SEE the item, not merely be refused on click. Fail CLOSED: anything short
 * of proven push access returns false, so the item stays hidden by default.
 *
 * ASYNC, NEVER execFileSync — this runs at BOOT, and the synchronous version
 * blocked the whole main process (and thus the window and all IPC) for as
 * long as gh took, up to seconds each. Every subprocess here is awaited off
 * the event loop, so the boot check never freezes the UI. */
function contribExecAsync(bin, args, cwd, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const { execFile } = require("child_process");
        execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true,
                              env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } },
            (err, stdout) => resolve({ ok: !err, out: String(stdout || "").trim() }));
    });
}
ipcMain.handle("lcl:contribCanRelease", guard(async () => {
    const repo = contribDiscoverRepo().repo;
    if (!repo) return { contributor: false };
    if (!(await contribExecAsync("gh", ["--version"], repo)).ok) return { contributor: false };
    if (!(await contribExecAsync("gh", ["auth", "status"], repo)).ok) return { contributor: false };
    const remote = contribRemote(repo);
    if (!remote) return { contributor: false };
    const perm = await contribExecAsync("gh",
        ["api", `repos/${remote.owner}/${remote.repo}`, "--jq", ".permissions.push"], repo);
    return { contributor: perm.ok && /true/.test(perm.out) };
}));

ipcMain.handle("lcl:contribReady", guard(async () => {
    const repo = contribRepoRoot();
    if (!repo) return { ready: false };
    const st = contribExec("git", ["status", "--porcelain"], repo, 8000);
    // CONTENT only — lane-file residue is bookkeeping, not an available patch
    const dirty = st.ok ? contribContentFiles(st.out).length : 0;
    let ahead = 0;
    const ah = contribExec("git", ["rev-list", "--count", "origin/main..HEAD"], repo, 8000);
    if (ah.ok) ahead = Number(ah.out) || 0;
    return { ready: dirty > 0 || ahead > 0, dirty, ahead };
}));

ipcMain.handle("lcl:contribStatus", guard(async () => {
    const found = contribDiscoverRepo();
    const repo = found.repo;
    const missing = [];
    if (!repo) missing.push(
        `a checkout of ${found.channel || "the app's repo"} — none of your session `
        + "folders is one, so point at it once (Choose checkout…)");
    const git = contribExec("git", ["--version"], repo || undefined);
    if (!git.ok) missing.push("the git CLI on PATH");
    const gh = contribExec("gh", ["--version"], repo || undefined);
    if (!gh.ok) missing.push("the GitHub CLI (gh) on PATH");
    let login = null, pushAllowed = false, remote = null;
    if (gh.ok) {
        const auth = contribExec("gh", ["auth", "status"], repo || undefined);
        if (!auth.ok) missing.push("gh auth login (not signed in)");
        const who = contribExec("gh", ["api", "user", "--jq", ".login"], repo || undefined);
        if (who.ok) login = who.out;
        if (repo) {
            remote = contribRemote(repo);
            if (!remote) missing.push("an origin remote on github.com");
            else {
                const perm = contribExec("gh",
                    ["api", `repos/${remote.owner}/${remote.repo}`,
                     "--jq", ".permissions.push"], repo);
                pushAllowed = perm.ok && /true/.test(perm.out);
                if (!pushAllowed) missing.push(
                    `push access to ${remote.owner}/${remote.repo}`);
            }
        }
    }
    // THE IDENTITY IS READ, NOT TYPED — and the EMAIL IS ALWAYS THE GH
    // NOREPLY. The first cut preferred git config's email, which was the
    // operator's private address: GitHub's email-privacy guard rejected the
    // push with GH007 — twice — and the audit tail named it. A GitHub-bound
    // commit gets the GitHub-safe address, full stop; config supplies only
    // the display name (falling back to the login), and config email is the
    // last resort for the no-gh case that cannot ship anyway.
    let name = null, email = null;
    if (repo) {
        const n = contribExec("git", ["config", "user.name"], repo);
        if (n.ok && n.out) name = n.out;
    }
    if (!name && login) name = login;
    if (login) {
        const id = contribExec("gh", ["api", "user", "--jq", ".id"], repo || undefined);
        if (id.ok && /^\d+$/.test(id.out)) email = `${id.out}+${login}@users.noreply.github.com`;
    }
    if (!email && repo) {
        const e2 = contribExec("git", ["config", "user.email"], repo);
        if (e2.ok && e2.out) email = e2.out;
    }
    return { ok: missing.length === 0, repo, missing, remote,
             repoHow: found.how || null,
             identity: { name, email, login },
             running: !!contribRunState };
}));

ipcMain.handle("lcl:contribPickRepo", guard(async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
        title: "Where is your .lcl checkout?",
        buttonLabel: "Use this checkout",
        properties: ["openDirectory"]
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false };
    const p0 = picked.filePaths[0];
    if (!fs.existsSync(path.join(p0, ".git"))
        || !fs.existsSync(path.join(p0, "devtools", "release.js"))) {
        return { ok: false, error: "that folder is not a .lcl checkout (no .git or devtools/release.js)" };
    }
    paths.writeSettings({ contribRepoPath: p0 });
    return { ok: true, repo: p0 };
}));

/** What is pending: dirty files, the version lanes, the last published tag. */
ipcMain.handle("lcl:contribPlan", guard(async () => {
    const repo = contribDiscoverRepo().repo;
    if (!repo) return { error: "no checkout found — open the Ship panel to link one" };
    const st = contribExec("git", ["status", "--porcelain"], repo);
    const files = st.ok ? st.out.split(/\r?\n/).filter(Boolean) : [];
    let official = null, version = null;
    try { official = JSON.parse(fs.readFileSync(
        path.join(repo, "devtools", "RELEASE.json"), "utf8")).official; } catch { }
    try { version = JSON.parse(fs.readFileSync(
        path.join(repo, "app", "package.json"), "utf8")).version; } catch { }
    let latestTag = null, tagTaken = false;
    const remote = contribRemote(repo);
    if (remote) {
        const t = contribExec("gh",
            ["api", `repos/${remote.owner}/${remote.repo}/releases/latest`,
             "--jq", ".tag_name"], repo);
        if (t.ok) latestTag = t.out;
        // THE BUMP IS A FACT, NOT A CHECKBOX. "im shipping, would i not
        // always want to make sure there is no conflict there? so why even
        // ask" — if the tree's version is already a published tag, shipping
        // it again can only collide; if it is unpublished, bumping past it
        // would skip a number. Decided here, stated to the operator, done.
        if (version) {
            const tt = contribExec("gh",
                ["api", `repos/${remote.owner}/${remote.repo}/releases/tags/v${version}`,
                 "--jq", ".tag_name"], repo);
            tagTaken = tt.ok && tt.out === `v${version}`;
        }
    }
    const nextVersion = version
        ? version.replace(/(\d+)$/, (n) => String(Number(n) + 1)) : null;
    const nextOfficial = Number.isInteger(official) ? official + 1 : null;
    const willBump = tagTaken;
    const bumpNote = !version ? "could not read the tree's version"
        : tagTaken
            ? `v${version} is already published — this ship bumps to v${nextVersion} · official #${nextOfficial}`
            : `v${version} is unpublished — this ship releases it as-is`;
    const branch = contribExec("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo);
    // RELEASABLE IS A FACT THE PANEL OBEYS. Content changes (beyond the lane
    // trio), unpushed commits, or a FULLY-CLEAN tree whose version was never
    // published (a failed publish being resumed) = something real to release.
    // A clean-and-live tree is NOT — and neither is lane-only residue, whose
    // bumped version numbers would otherwise read as "unpublished" and reopen
    // the exact empty-release hole this line closes.
    const contentCount = contribContentFiles(st.ok ? st.out : "").length;
    let ahead = 0;
    const ah = contribExec("git", ["rev-list", "--count", "origin/main..HEAD"], repo);
    if (ah.ok) ahead = Number(ah.out) || 0;
    const releasable = contentCount > 0 || ahead > 0
        || (!tagTaken && files.length === 0);
    return { repo, files: files.slice(0, 200), dirtyCount: files.length,
             contentCount, ahead, releasable,
             official, version, latestTag, willBump, bumpNote,
             nextVersion, nextOfficial,
             branch: branch.ok ? branch.out : null };
}));

/**
 * THE COMMIT MESSAGE AND RELEASE NOTES ARE DRAFTED BY A LOCAL MODEL reading
 * the actual diff — "agentic and dynamic", editable before anything runs.
 * When no model can answer, an honest heuristic from the file list stands in
 * and says so.
 */
ipcMain.handle("lcl:contribDraft", guard(async () => {
    const repo = contribDiscoverRepo().repo;
    if (!repo) return { error: "no checkout found — open the Ship panel to link one" };
    const stat = contribExec("git", ["diff", "--stat", "HEAD"], repo, 30000);
    const names = contribExec("git", ["diff", "--name-status", "HEAD"], repo, 30000);
    const sample = contribExec("git", ["diff", "HEAD"], repo, 30000);
    const diffStat = stat.ok ? stat.out.slice(0, 3000) : "";
    const diffSample = sample.ok ? sample.out.slice(0, 9000) : "";
    const fileList = names.ok ? names.out.slice(0, 2000) : "";
    const fallback = () => {
        const n = fileList.split(/\r?\n/).filter(Boolean).length;
        return {
            commitMessage: `Update ${n} file${n === 1 ? "" : "s"}`,
            releaseNotes: (`Changes across ${n} file${n === 1 ? "" : "s"}.\n`
                + (diffStat.split(/\r?\n/).slice(-1)[0] || "")).trim(),
            model: null
        };
    };
    // THE DRAFT IS WATCHED, NOT WAITED ON. "reading the diff is INSANELY
    // slow, and has absolutely no insight to what the fuck is going on" —
    // every phase says itself, and the generation STREAMS token by token so
    // the message writes itself on screen instead of appearing after a
    // silent minute (the silence was mostly the model loading).
    const draftSay = (line) => {
        try { mainWindow.webContents.send("lcl:contribProgress",
            { step: "draft", line }); } catch { }
    };
    try {
        const n = fileList.split(/\r?\n/).filter(Boolean).length;
        draftSay(`diff read — ${n} file${n === 1 ? "" : "s"}, `
            + `${(diffStat.split(/\r?\n/).slice(-1)[0] || "").trim() || "no stat"}`);
        draftSay("loading the local model — the first draft after a boot takes the longest…");
        await engine.ensureLoaded("contrib-draft");
        draftSay("drafting…");
        const res = await engine.generate([
            { role: "system", content:
                "You write release copy for a software patch from its git diff. " +
                "Answer with EXACTLY two lines:\n" +
                "COMMIT: <one sentence, present tense, what this patch does and why — no file lists>\n" +
                "NOTES: <one or two sentences for the release page, plain language, user-facing>" },
            { role: "user", content:
                `Files changed:\n${fileList}\n\nDiff stat:\n${diffStat}\n\nDiff sample:\n${diffSample}` }
        ], 320, null, (t) => {
            // the stream IS the visualization — the engine hands back the
            // accumulated text each tick and the renderer paints it into the
            // field, so the message writes itself on screen
            try { mainWindow.webContents.send("lcl:contribProgress",
                { step: "draft", draftText: String((t && t.text) || ""),
                  draftTokens: (t && t.tokens) || 0 }); } catch { }
        }, { temperature: 0.4 });
        const text = String((res && (res.text || res.content)) || "");
        const cm = (text.match(/COMMIT:\s*(.+)/i) || [])[1];
        const nt = (text.match(/NOTES:\s*([\s\S]+)/i) || [])[1];
        if (cm && nt) {
            return { commitMessage: cm.trim().slice(0, 300),
                     releaseNotes: nt.trim().slice(0, 800),
                     model: (res && res.model) || "local" };
        }
        return fallback();
    } catch { return fallback(); }
}));

/** One spawned step: streamed, awaited, never overlapped with the next. */
function contribStep(step, bin, args, cwd) {
    return new Promise((resolve) => {
        const send = (line) => {
            const clean = String(line).replace(/\r?\n$/, "");
            const t = contribRunState.transcript[step]
                || (contribRunState.transcript[step] = []);
            t.push(clean);
            if (t.length > 400) t.splice(0, t.length - 400);
            try { mainWindow.webContents.send("lcl:contribProgress",
                { step, line: clean }); } catch { }
        };
        send(`$ ${bin} ${args.join(" ")}`);
        let child = null;
        try {
            child = spawn(bin, args, { cwd, windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
                // no hidden prompts: a credential problem must FAIL with its
                // message in the console, never hang a windowless process
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0",
                       GCM_INTERACTIVE: "Never" } });
        } catch (e) {
            send("could not start: " + String((e && e.message) || e));
            return resolve({ code: -1 });
        }
        contribRunState.child = child;
        let buf = "";
        const feed = (d) => {
            buf += d.toString("utf8");
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                send(buf.slice(0, nl)); buf = buf.slice(nl + 1);
            }
        };
        child.stdout.on("data", feed);
        child.stderr.on("data", feed);
        child.on("close", (code) => {
            if (buf.trim()) send(buf);
            resolve({ code: code === null ? -1 : code });
        });
        child.on("error", (e) => { send(String(e.message || e)); resolve({ code: -1 }); });
    });
}

ipcMain.handle("lcl:contribRun", guard(async (_e, opts) => {
    if (contribRunState) return { error: "a ship run is already in progress" };
    const repo = contribDiscoverRepo().repo;
    if (!repo) return { error: "no checkout found — open the Ship panel to link one" };
    const o = opts || {};
    const msg = String(o.commitMessage || "").trim();
    const notes = String(o.releaseNotes || "").trim();
    // a message is required only when there is something to commit — a
    // resume over an already-committed tree carries its message in history
    const name = String(o.name || "").trim(), email = String(o.email || "").trim();
    if (!name || !email) return { error: "no git identity — sign in with gh or set git config" };
    // THE LIVE RUN IS READABLE FROM OUTSIDE. Its step states used to live in
    // a local const, so a panel reopened mid-run could not know a run was
    // happening at all — "i have no clue if it is actually running still as
    // the ui is showing that it is not running". They live on the run state
    // now, beside the transcript, and lcl:contribLastRun serves them live.
    contribRunState = { cancelled: false, child: null, transcript: {},
                        states: {}, startedAt: Date.now() };
    const states = contribRunState.states;
    const emit = (step, state, line) => {
        if (state) states[step] = state;
        if (line) {
            const t = contribRunState.transcript[step]
                || (contribRunState.transcript[step] = []);
            t.push(line);
        }
        try { mainWindow.webContents.send("lcl:contribProgress",
            { step, state, line }); } catch { }
    };
    const record = (ok, failedStep, version) => {
        contribLastRun = { at: Date.now(), ok, failedStep: failedStep || null,
            version: version || null, states: { ...states },
            transcript: Object.fromEntries(Object.entries(contribRunState.transcript)
                .map(([k, v]) => [k, v.slice(-120)])) };
    };
    const fail = (step, why) => {
        emit(step, "failed", why);
        // the audit entry carries the step's own last words — the exit code
        // alone told us nothing the first time this fired
        const tail = (contribRunState.transcript[step] || []).slice(-25);
        auditLog.write({ kind: "contrib-ship-failed", step, why, tail, at: Date.now() });
        record(false, step, null);
        contribRunState = null;
        return { ok: false, failedStep: step, error: why };
    };
    try {
        // 0 — the lanes. NOT A CHOICE: the run re-derives the same fact the
        //     plan showed — a tree version that is already a published tag
        //     MUST bump past it; an unpublished one MUST NOT skip a number.
        //     Computed here independently, never trusted from the renderer.
        let version = null;
        try { version = JSON.parse(fs.readFileSync(
            path.join(repo, "app", "package.json"), "utf8")).version; } catch { }
        let mustBump = false;
        {
            const remote = contribRemote(repo);
            if (remote && version) {
                const tt = contribExec("gh",
                    ["api", `repos/${remote.owner}/${remote.repo}/releases/tags/v${version}`,
                     "--jq", ".tag_name"], repo);
                mustBump = tt.ok && tt.out === `v${version}`;
            }
        }
        // NOTHING TO RELEASE IS A REFUSAL, NOT A RUN. Watched live: a clean,
        // fully-released tree let a second run start — its bump fired FIRST
        // and stranded the lanes a version ahead with no content behind them.
        // Re-derived here independently of the renderer, before anything can
        // write: content = changes beyond the lane trio; lane-only dirt is a
        // previous bump's residue; a fully clean, not-ahead, unpublished tree
        // is the one legitimate empty case (resuming a failed publish).
        {
            const st0 = contribExec("git", ["status", "--porcelain"], repo);
            const dirtyAll = st0.ok
                ? st0.out.split(/\r?\n/).filter(l => l.trim()) : [];
            const content = contribContentFiles(st0.ok ? st0.out : "");
            const ah0 = contribExec("git",
                ["rev-list", "--count", "origin/main..HEAD"], repo);
            const ahead = ah0.ok ? (Number(ah0.out) || 0) : 0;
            if (!content.length && ahead === 0) {
                if (dirtyAll.length) {
                    contribRunState = null;
                    return { error: "nothing to release — only the version-lane "
                        + "files differ (a previous run's bump residue); revert "
                        + "them or make real changes first" };
                }
                if (mustBump) {
                    contribRunState = null;
                    return { error: `nothing to release — v${version} is already `
                        + "live and the tree is clean" };
                }
                // clean, not ahead, unpublished: resume the failed publish
            }
        }
        if (mustBump) {
            emit("bump", "running");
            try {
                const rj = path.join(repo, "devtools", "RELEASE.json");
                const rel = JSON.parse(fs.readFileSync(rj, "utf8"));
                rel.official = Number(rel.official) + 1;
                fs.writeFileSync(rj, JSON.stringify(rel, null, 2) + "\n");
                const bumpPkg = (pp) => {
                    const j = JSON.parse(fs.readFileSync(pp, "utf8"));
                    j.version = j.version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
                    fs.writeFileSync(pp, JSON.stringify(j, null, 2) + "\n");
                    return j.version;
                };
                version = bumpPkg(path.join(repo, "app", "package.json"));
                bumpPkg(path.join(repo, "devtools", "installer", "package.json"));
                emit("bump", "done", `official #${rel.official} · v${version}`);
            } catch (e) {
                return fail("bump", "lane bump failed: " + String((e && e.message) || e));
            }
        } else emit("bump", "skipped",
            `v${version} is unpublished — no bump needed`);
        if (!version) return fail("bump", "could not read app/package.json version");

        // 1+2 — stage and commit. A RETRY AFTER A MID-CHAIN FAILURE finds the
        // tree already committed (the first run died at push, exactly this) —
        // that is not an error, it is work already done: say so, resume.
        let r;
        const dirty = contribExec("git", ["status", "--porcelain"], repo);
        if (dirty.ok && !dirty.out.trim()) {
            emit("add", "skipped", "tree already clean");
            emit("commit", "skipped", "already committed — resuming at push");
        } else {
            if (!msg) return fail("commit", "a commit message is required");
            emit("add", "running");
            r = await contribStep("add", "git", ["add", "-A"], repo);
            if (contribRunState.cancelled) return fail("add", "cancelled");
            if (r.code !== 0) return fail("add", "git add exited " + r.code);
            emit("add", "done");

            emit("commit", "running");
            r = await contribStep("commit", "git",
                ["-c", `user.name=${name}`, "-c", `user.email=${email}`,
                 "commit", "-m", msg], repo);
            if (contribRunState.cancelled) return fail("commit", "cancelled");
            if (r.code !== 0) return fail("commit", "git commit exited " + r.code
                + " (nothing to commit, or hooks refused)");
            emit("commit", "done");
        }

        // 3 — push the current branch onto main
        const br = contribExec("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo);
        const refspec = `${br.ok ? br.out : "HEAD"}:main`;
        emit("push", "running");
        r = await contribStep("push", "git", ["push", "origin", refspec], repo);
        if (contribRunState.cancelled) return fail("push", "cancelled");
        if (r.code !== 0) return fail("push", "git push exited " + r.code);
        emit("push", "done");

        // 4 — the release gate and build (the long one; its output IS the show).
        // THE APP'S OWN ENGINE STANDS DOWN FIRST: the gate's engine suite
        // spawns a llama-server on the same fixed port this app's resident
        // model holds — with the model loaded (the draft loads it!), the
        // suite hit the app's server, got 401s, and refused the build. The
        // gate gets the port and the RAM; the model reloads on next use.
        emit("gate", "running", "releasing the local engine so the gate can use its port…");
        try { if (engine.status().running) engine.unloadNow(); } catch { /* already down */ }
        r = await contribStep("gate", "node",
            [path.join(repo, "devtools", "release.js"), "--release"], repo);
        if (contribRunState.cancelled) return fail("gate", "cancelled");
        if (r.code !== 0) return fail("gate", "the release gate refused this build — read its output above");
        emit("gate", "done");

        // 5 — publish, with the artifacts PROVEN on disk first
        const installer = path.join(repo, "dist", `lcl-Installer-${version}.exe`);
        const info = path.join(repo, "dist", "build-info.json");
        const sig = path.join(repo, "dist", "build-info.json.sig");
        for (const f of [installer, info, sig]) {
            if (!fs.existsSync(f)) {
                return fail("publish", `missing artifact: ${path.basename(f)} — the build did not produce what the publish step needs`);
            }
        }
        emit("publish", "running");
        r = await contribStep("publish", "gh",
            ["release", "create", `v${version}`, installer, info, sig,
             "--title", `v${version}`, "--notes", notes || `v${version}`], repo);
        if (contribRunState.cancelled) return fail("publish", "cancelled");
        if (r.code !== 0) return fail("publish", "gh release create exited " + r.code);
        emit("publish", "done", `v${version} is live — installs on the channel see it within a minute`);

        auditLog.write({ kind: "contrib-ship", version, at: Date.now() });
        record(true, null, version);
        contribRunState = null;
        return { ok: true, version };
    } catch (e) {
        return fail("run", String((e && e.message) || e));
    }
}));

ipcMain.handle("lcl:contribLastRun", guard(async () => {
    // A RUN IN FLIGHT ANSWERS FIRST — the panel reopens onto the run that is
    // actually happening, with its consoles and step states, instead of the
    // record of some previous one.
    if (contribRunState) {
        return { at: contribRunState.startedAt, running: true, ok: false,
                 failedStep: null, version: null,
                 states: { ...contribRunState.states },
                 transcript: Object.fromEntries(
                     Object.entries(contribRunState.transcript)
                         .map(([k, v]) => [k, v.slice(-120)])) };
    }
    return contribLastRun;
}));

ipcMain.handle("lcl:contribCancel", guard(async () => {
    if (!contribRunState) return { ok: false };
    contribRunState.cancelled = true;
    try { if (contribRunState.child) contribRunState.child.kill(); } catch { }
    return { ok: true };
}));


ipcMain.handle("lcl:pickOpenerApp", guard(async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
        title: "Choose an app to open the workspace with",
        buttonLabel: "Use this app",
        properties: ["openFile"],
        filters: process.platform === "win32"
            ? [{ name: "Programs", extensions: ["exe", "cmd", "bat"] }] : []
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    const appPath = picked.filePaths[0];
    const name = path.basename(appPath).replace(/\.(exe|cmd|bat|app)$/i, "");
    const list = readOpeners().filter(o => o.path !== appPath);
    list.push({ name, path: appPath });
    paths.writeSettings({ [OPENERS_KEY]: list.slice(-12) });
    return { ok: true, opener: { id: "custom:" + appPath, name, removable: true } };
}));

ipcMain.handle("lcl:removeOpener", guard(async (_e, id) => {
    const appPath = String(id || "").startsWith("custom:") ? String(id).slice(7) : null;
    if (!appPath) return { ok: false, error: "not a removable opener" };
    paths.writeSettings({ [OPENERS_KEY]: readOpeners().filter(o => o.path !== appPath) });
    return { ok: true };
}));

/**
 * The right-click actions on a workspace file. All three resolve the path the
 * same way viewFile does — through the session's linked root, throwing on
 * escape — so a crafted rel can reach exactly what the panel can and no more.
 */
function resolveSessionFile(id, relPath) {
    const s = sessions.load(id);
    if (!s) return { error: "session not found" };
    if (!s.repoPath) return { error: "no folder linked" };
    const full = fsTools.resolveInRoot(s.repoPath, String(relPath || ""));
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { error: "not a file" };
    return { full };
}

ipcMain.handle("lcl:openFileWindow", guard((_e, id, relPath) => {
    const r = resolveSessionFile(id, relPath);
    if (r.error) return { ok: false, error: r.error };
    return openFileWindow(String(id), String(relPath));
}));

ipcMain.handle("lcl:openFileExternal", guard(async (_e, id, relPath) => {
    const r = resolveSessionFile(id, relPath);
    if (r.error) return { ok: false, error: r.error };
    // the OS default application for the type — .lcl does not guess what a
    // .dwg or a .xlsx should open in
    const err = await shell.openPath(r.full);
    return { ok: !err, error: err || undefined };
}));

ipcMain.handle("lcl:revealFile", guard((_e, id, relPath) => {
    const r = resolveSessionFile(id, relPath);
    if (r.error) return { ok: false, error: r.error };
    shell.showItemInFolder(r.full);
    return { ok: true };
}));

ipcMain.handle("lcl:confirm", async (_e, opts) => {
    const o = opts && typeof opts === "object" ? opts : {};
    const res = await dialog.showMessageBox(mainWindow, {
        type: "question",
        title: String(o.title || "Confirm"),
        message: String(o.message || "Are you sure?"),
        detail: o.detail ? String(o.detail) : undefined,
        buttons: [String(o.confirmLabel || "OK"), "Cancel"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    });
    return { confirmed: res.response === 0 };
});

/* ==========================================================================
 * THE TERMINAL — A REAL SHELL THE OPERATOR OWNS.  Contract K5.
 *
 * The requirement: a real terminal that rises from the bottom of the window,
 * to run commands.
 *
 * NO SANDBOX AND NO APPROVAL, by explicit decision. This is the user's machine
 * and their shell, running as them, with their environment. Everything else in .lcl that
 * can touch the system asks first because a MODEL is proposing the action; here
 * a human is typing, and putting a confirmation between a person and their own
 * command prompt would be theatre.
 *
 * WHICH IS EXACTLY WHY THE MODEL MUST NEVER REACH IT. The whole safety argument
 * above rests on one fact: every byte that enters this shell was typed by the
 * operator. So there is deliberately NO tool, NO manifest entry and NO
 * agent-reachable path to terminalWrite — the only door is ipcMain, which only
 * the renderer can knock on, driven by a keystroke. tests/preload-contract.js
 * asserts that: no terminal tool is registered, none is classified, and no file
 * under .lcl.engine so much as names the channels. If a future change hands the
 * agent a way in, that test fails before it ships.
 *
 * PIPES, NOT A PTY. There is no pty binary in this app and installing one is
 * not on the table. Measured on this machine rather than assumed — a piped
 * COMSPEC is genuinely usable:
 *
 *   Microsoft Windows [Version 10.0.26200.8973]\r\n...
 *   C:\.lcl>echo hello-from-lcl\r\nhello-from-lcl\r\n
 *   C:\.lcl>notacommand123\r\n
 *   [stderr] 'notacommand123' is not recognized as an internal or external command
 *
 * the banner, the prompt, the echo of what was typed, and errors on stderr. No
 * cursor addressing, no colour, no full-screen editors — stated plainly in the
 * UI rather than pretended away.
 * ======================================================================== */

const terminals = new Map();        // id -> { id, child, cols, rows, shell, startedAt }
let terminalSeq = 0;
const TERMINAL_MAX = 4;             // one panel, a few tabs — not a process farm

// THE UI MUST SAY THIS OUT LOUD, so it is stated once here rather than left for
// each surface to word for itself — and returned by BOTH terminalStart and
// terminalList, so a panel that is re-rendered after a reload can still show it
// without having to remember what it was told when the shell was created.
const TERMINAL_NOTICE =
    "This is your real shell, running as you, with no sandbox and no approval " +
    "step. .lcl does not review what you type here. The model cannot see this " +
    "shell and cannot type into it.";
const TERMINAL_LIMITS =
    "No pty: no colour, no cursor control, and full-screen programs " +
    "(vim, less, top) will not draw.";

/** The operator's own shell, as the OS defines it. */
function userShell() {
    if (process.platform === "win32") {
        const comspec = process.env.COMSPEC;
        if (comspec && fs.existsSync(comspec)) return { file: comspec, args: [] };
        const ps = path.join(process.env.SystemRoot || "C:\\Windows",
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (fs.existsSync(ps)) return { file: ps, args: ["-NoLogo"] };
        return { file: "cmd.exe", args: [] };
    }
    // -i so profile aliases and the prompt are the ones the user actually has
    return { file: process.env.SHELL || "/bin/bash", args: ["-i"] };
}

function sendTerminal(id, chunk) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.webContents.send("lcl:terminalData", id, chunk); }
    catch { /* the window went away mid-write; the shell is reaped on exit */ }
}

/**
 * THE SHELL IS GONE — said as an event.  (contract K5)
 *
 * A signal is reported as itself rather than flattened into a number: a shell
 * killed by SIGKILL exits with a null code, and `[shell exited with code null]`
 * is the panel telling the operator nothing at the one moment they need telling.
 */
function sendTerminalExit(id, code, signal) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.webContents.send("lcl:terminalExit", id, signal || code); }
    catch { /* the window is going away too; nothing left to inform */ }
}

/**
 * KILL THE TREE, NOT THE SHELL.  Measured, because the obvious call is wrong:
 *
 *   plain | PING.EXE before kill: 1   ->  after kill: 1     (child.kill())
 *   tree  | PING.EXE before kill: 2   ->  after kill: 1     (taskkill /T /F)
 *
 * child.kill() ends cmd.exe and leaves whatever it started running forever.
 * This app has already shipped one process that outlived it; it does not get
 * to ship a second one the user can create by typing.
 */
function killTerminal(t) {
    if (!t || !t.child) return;
    const pid = t.child.pid;
    try {
        if (process.platform === "win32") {
            execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"],
                { stdio: "ignore", timeout: 5000 });
        } else {
            // spawned detached, so this is the whole process GROUP
            try { process.kill(-pid, "SIGKILL"); } catch { t.child.kill("SIGKILL"); }
        }
    } catch { try { t.child.kill(); } catch { /* already gone */ } }
}

function killAllTerminals() {
    for (const t of [...terminals.values()]) {
        try { killTerminal(t); } catch { /* one failing must not orphan the rest */ }
        terminals.delete(t.id);
    }
}

ipcMain.handle("lcl:terminalStart", guard((_e, cols, rows) => {
    if (terminals.size >= TERMINAL_MAX) {
        return { error: `already running ${terminals.size} shells — close one first` };
    }
    const sh = userShell();
    const id = `term-${Date.now().toString(36)}-${++terminalSeq}`;
    const c = Math.max(20, Math.min(500, Number(cols) || 80));
    const r = Math.max(5, Math.min(200, Number(rows) || 24));
    let child;
    try {
        child = spawn(sh.file, sh.args, {
            // The user's shell, home, environment. COLUMNS/LINES are the only
            // additions: without a pty they are the only way a program can be
            // told how wide the panel is.
            cwd: os.homedir(),
            env: { ...process.env, COLUMNS: String(c), LINES: String(r), TERM: "dumb" },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32"
        });
    } catch (err) {
        return { error: `could not start ${sh.file}: ${String(err.message || err)}` };
    }
    const t = { id, child, cols: c, rows: r, shell: sh.file, startedAt: Date.now() };
    terminals.set(id, t);

    // stdout and stderr both go to the panel, in arrival order, the way a
    // terminal shows them. Nothing is parsed and nothing is filtered: the
    // operator sees what their shell said.
    child.stdout.on("data", (d) => sendTerminal(id, d.toString("utf8")));
    child.stderr.on("data", (d) => sendTerminal(id, d.toString("utf8")));
    child.on("error", (err) => sendTerminal(id, `\r\n[.lcl] ${String(err.message || err)}\r\n`));
    child.on("exit", (code, signal) => {
        terminals.delete(id);
        sendTerminal(id, `\r\n[.lcl] shell exited (${signal || code})\r\n`);
        // AND SAY IT AS AN EVENT, not only as text in the stream.
        //
        // The line above is for the operator to read; this is for the panel to
        // act on. app.js keeps a per-shell `exited` flag that decides whether
        // typing is still accepted, and the only way it could set that flag was
        // window.lcl.onTerminalExit — which the renderer probed for and never
        // found, because nothing sent it. The measured result is a dead shell
        // the panel still shows as running and still accepts keystrokes for,
        // every one of which returns "no such terminal" from terminalWrite.
        sendTerminalExit(id, code, signal);
    });

    auditLog.write({ kind: "terminal-start", terminal: id, shell: sh.file,
                     pid: child.pid, at: Date.now() });
    return { id, shell: sh.file, pid: child.pid, cols: c, rows: r,
             notice: TERMINAL_NOTICE, limits: TERMINAL_LIMITS };
}));

ipcMain.handle("lcl:terminalWrite", guard((_e, id, data) => {
    const t = terminals.get(String(id || ""));
    if (!t) return { error: "no such terminal" };
    // A KEYSTROKE, NOT A PROGRAM. The cap is a paste guard, not a policy: this
    // path has no policy, by design.
    const s = String(data == null ? "" : data).slice(0, 100_000);
    try { t.child.stdin.write(s); } catch (err) {
        return { error: String(err.message || err) };
    }
    return { ok: true, bytes: Buffer.byteLength(s) };
}));

ipcMain.handle("lcl:terminalResize", guard((_e, id, cols, rows) => {
    const t = terminals.get(String(id || ""));
    if (!t) return { error: "no such terminal" };
    t.cols = Math.max(20, Math.min(500, Number(cols) || t.cols));
    t.rows = Math.max(5, Math.min(200, Number(rows) || t.rows));
    // A pipe has no window size to set. The numbers are still kept and still
    // reported, because the NEXT program started from this shell reads
    // COLUMNS/LINES out of the environment, and because a resize that silently
    // returns nothing is indistinguishable from one that failed.
    return { ok: true, cols: t.cols, rows: t.rows, applied: "env-only" };
}));

ipcMain.handle("lcl:terminalKill", guard((_e, id) => {
    const t = terminals.get(String(id || ""));
    if (!t) return { error: "no such terminal" };
    killTerminal(t);
    terminals.delete(t.id);
    auditLog.write({ kind: "terminal-kill", terminal: t.id, at: Date.now() });
    return { ok: true, id: t.id };
}));

ipcMain.handle("lcl:terminalList", guard(() => ({
    terminals: [...terminals.values()].map(t => ({
        id: t.id, shell: t.shell, pid: t.child.pid,
        cols: t.cols, rows: t.rows, startedAt: t.startedAt
    })),
    max: TERMINAL_MAX,
    notice: TERMINAL_NOTICE, limits: TERMINAL_LIMITS
})));

// NO SHELL OUTLIVES THE APP. Same rule as every other child process here, and
// the one this codebase has already been bitten by once.
app.on("before-quit", () => { try { killAllTerminals(); } catch { /* quit anyway */ } });
process.on("exit", () => { try { killAllTerminals(); } catch { /* exiting */ } });
