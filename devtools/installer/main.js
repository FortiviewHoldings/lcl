/**
 * The installer window. Frameless, rounded, and the only window Windows shows
 * for this product other than its own elevation prompt.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const { install, defaultDir, isUpgrade, APP_EXE } = require("./install");

app.disableHardwareAcceleration();
let win = null;
let installedAt = null;

/**
 * FIT THE SCREEN THAT IS ACTUALLY THERE.
 *
 * 720x500 was hardcoded and never checked against a real desktop. On the
 * operator's machine — a 3200x900 virtual screen across two displays — the
 * window was placed with its top at y=176 and ran 500px tall, so it fell off
 * the bottom of a 900px-high work area and it was reported, three builds running,
 * "i see nothing". It was painting perfectly the whole time, just mostly below
 * the edge of the screen.
 *
 * So the size is clamped to the work area of the display the cursor is on, and
 * the window is centred there rather than trusting a default.
 */
function windowBox() {
    const { screen } = require("electron");
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = d.workArea;                       // excludes the taskbar
    const width = Math.min(720, Math.max(480, wa.width - 80));
    const height = Math.min(500, Math.max(360, wa.height - 80));
    return {
        width, height,
        x: Math.round(wa.x + (wa.width - width) / 2),
        y: Math.round(wa.y + (wa.height - height) / 2)
    };
}

function create() {
    const box = windowBox();
    win = new BrowserWindow({
        ...box, show: false,
        /* OPAQUE, NOT TRANSPARENT — and this is the whole "i see nothing".
         *
         * MEASURED: run from source, unelevated, the window painted perfectly.
         * Run from the installer, which requests admin, it was present, sized,
         * on-screen at the right coordinates and utterly blank. A transparent
         * frameless window on a 2x HiDPI display under elevation does not
         * composite, and there is nothing behind it to see because the whole
         * background lives in CSS.
         *
         * So the window carries its own colour instead. Windows 11 rounds a
         * frameless window itself, which is where the rounded corner was
         * coming from anyway — the CSS radius only ever mattered for the
         * transparent case that did not work. */
        frame: false, transparent: false, resizable: false, maximizable: false,
        roundedCorners: true,
        backgroundColor: "#050505",
        icon: path.join(__dirname, "assets", "icon.ico"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true, nodeIntegration: false
        }
    });
    win.loadFile(path.join(__dirname, "ui.html"));
    /* COME TO THE FRONT WHEN READY. After the long silent extraction the window
     * was appearing behind other windows, so the operator saw only a taskbar
     * button and had to click it — "i get a taskbar icon appear i have to click
     * it for it to open". show, then focus, then flash the taskbar button so a
     * window that opens minutes later actually announces itself. */
    win.once("ready-to-show", () => {
        // COME TO THE FRONT ON ITS OWN. A plain focus() is REFUSED by Windows
        // when the call comes from a background process — which this is, after
        // minutes of extraction during which the operator has clicked away —
        // so the window sat in the taskbar and had to be clicked. MEASURED: a
        // bare focus() does not surface it; setAlwaysOnTop(true) does, because
        // it orders the window above the others regardless of who owns focus.
        // Drop the always-on-top a moment later so it does not stay pinned.
        win.show();
        win.setAlwaysOnTop(true);
        win.focus();
        win.moveTop();
        setTimeout(() => { if (!win.isDestroyed()) win.setAlwaysOnTop(false); }, 1200);
        if (process.platform === "win32") win.flashFrame(true);
    });
    win.on("focus", () => win.flashFrame(false));
}

ipcMain.handle("setup:defaultDir", () => defaultDir());

ipcMain.handle("setup:isUpgrade", (_e, dir) => isUpgrade(dir));

ipcMain.handle("setup:pickFolder", async (_e, current) => {
    const r = await dialog.showOpenDialog(win, {
        title: "Where should .lcl live?",
        defaultPath: current || defaultDir(),
        properties: ["openDirectory", "createDirectory"]
    });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});

ipcMain.handle("setup:install", async (_e, dir) => {
    try {
        const r = await install(dir, (p) => {
            if (win && !win.isDestroyed()) win.webContents.send("setup:progress", p);
        });
        installedAt = r.target;
        return r;
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
});

/**
 * OPEN THE APP WITHOUT ADMIN — through the shell that is already running.
 *
 * This installer runs ELEVATED (it writes Program Files). Spawning .lcl as our
 * own child would hand it that elevation, and an elevated .lcl is the taskbar
 * bug: Windows UIPI blocks the non-elevated Explorer (the taskbar / pinned-icon
 * click) from delivering the single-instance "second-instance" message to an
 * elevated window, so a tray-hidden elevated app never comes back from the
 * taskbar. It MUST start non-elevated.
 *
 * explorer.exe is the launcher. The interactive user's shell is already running
 * at medium integrity; handing it the path makes IT create the process, so .lcl
 * inherits the shell's medium token instead of our high one — de-elevated, and a
 * child of Explorer rather than of this installer, so it survives our exit.
 *
 * THIS REPLACES A schtasks /rl LIMITED TASK THAT LIED. Measured on the operator's
 * own machine: the task created cleanly, /run returned success, "Last Result" was
 * 0 — and no .lcl process ever appeared, 8 seconds later still nothing. A launch
 * that reports success and starts nothing is the whole "it doesn't open after the
 * installer finishes" bug. The explorer.exe hand-off, on the same machine, brings
 * the app up within ~0.5s every time. (The earlier note that explorer.exe
 * "launched nothing" did not survive re-measurement; schtasks was the one that
 * failed silently.)
 */
function launchDeElevated(exe) {
    const { execFile } = require("child_process");
    return new Promise((resolve) => {
        // explorer.exe exits with a non-zero code the instant it forwards the
        // request to the running shell — that is not a failure, so its callback
        // error is deliberately ignored. Node quotes the space-bearing path for
        // us, so explorer receives "C:\Program Files\.lcl\.lcl.exe" intact.
        try {
            execFile("explorer.exe", [exe], { windowsHide: true }, () => {});
        } catch { /* explorer.exe is always present; a throw here is unreachable */ }
        // let the shell pick up the hand-off before the installer is allowed to
        // exit. The app is Explorer's child, not ours, so it would survive our
        // exit regardless — this is only so the two do not race on screen.
        setTimeout(() => resolve(true), 1200);
    });
}

ipcMain.handle("setup:finish", async (_e, run) => {
    if (run && installedAt) {
        await launchDeElevated(path.join(installedAt, APP_EXE));
    }
    setTimeout(() => app.exit(0), 800);
    return { ok: true };
});

ipcMain.handle("setup:minimise", () => win && win.minimize());
ipcMain.handle("setup:quit", () => app.exit(0));

app.whenReady().then(create);
app.on("window-all-closed", () => app.exit(0));
