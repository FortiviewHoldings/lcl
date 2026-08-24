/**
 * UNINSTALL AND REPAIR — the maintenance face of the same app.
 *
 * Reached as `.lcl.exe --uninstall` or `.lcl.exe --repair`, which is what the
 * Windows "Uninstall" and "Modify" buttons in Apps & Features invoke. It loads
 * a small themed window instead of the whole application and never starts the
 * engine, so it is instant — the app is already on disk, nothing to extract.
 *
 * TWO THINGS IT MUST GET RIGHT, because both are easy to get wrong:
 *
 *   ELEVATION. Deleting a folder under Program Files and a key under HKLM both
 *   need admin. The Uninstall button launches us as the plain user, so if we
 *   are not already elevated we relaunch ourselves through the shell with a UAC
 *   prompt and let the first copy exit. Without this, uninstall silently does
 *   nothing — the worst outcome, because Windows then thinks it worked.
 *
 *   SELF-DELETION. We are `.lcl.exe`, running out of the very folder we are
 *   asked to delete, so we cannot delete it from inside ourselves. A detached
 *   batch waits for this process to exit, THEN removes the tree. It is the only
 *   part that runs after the window closes.
 *
 *   THE DATA IS A DELIBERATE CHOICE. Everything the operator built — every API
 *   endpoint, the encrypted keys, the Spark node and its door token, the SSH
 *   identity — lives in %APPDATA%\.lcl, not here. Removing it is offered, and
 *   OFF by default, because keeping it means a reinstall comes back to a
 *   working Spark and working accounts rather than a blank slate.
 */
const { app, BrowserWindow, ipcMain, dialog, screen } = require("electron");
const { execFile, execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_NAME = ".lcl";
const APP_EXE = ".lcl.exe";
const REG_KEY = "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\lcl";

// LCL_MAINT_INSTALL / LCL_MAINT_DATA let the test drive this against throwaway
// folders instead of the real install and the operator's real data — deleting
// either for real is exactly what a test must never do
const installDir = () => process.env.LCL_MAINT_INSTALL || path.dirname(process.execPath);
const appDataDir = () => process.env.LCL_MAINT_DATA ||
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);

/** Are we running with the rights to delete Program Files and write HKLM? */
function isElevated() {
    try {
        // a write nobody but an administrator can make; removed immediately
        const probe = path.join(installDir(), ".lcl-elev-probe");
        fs.writeFileSync(probe, "x");
        fs.rmSync(probe, { force: true });
        return true;
    } catch { return false; }
}

/** Relaunch this exe elevated, same mode, and let this copy go. */
function relaunchElevated(mode) {
    const args = `'--${mode}'`;
    try {
        execFileSync("powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command",
             `Start-Process -FilePath '${process.execPath}' -ArgumentList ${args} -Verb RunAs`],
            { windowsHide: true });
    } catch { /* the user declined the prompt: nothing changes, which is safe */ }
}

function ps(script) {
    return new Promise((resolve) => {
        execFile("powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            { windowsHide: true, timeout: 60000 },
            (err, out, errOut) => resolve({ ok: !err, out: String(out || ""), err: String(errOut || "") }));
    });
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** Recreate the two shortcuts — the everyday breakage a repair actually fixes. */
async function writeShortcuts() {
    const target = installDir();
    const exe = path.join(target, APP_EXE);
    const startMenu = path.join(process.env.APPDATA || "",
        "Microsoft", "Windows", "Start Menu", "Programs", APP_NAME + ".lnk");
    const desktop = path.join(os.homedir(), "Desktop", APP_NAME + ".lnk");
    const mk = (lnk) =>
        `$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut(${q(lnk)}); ` +
        `$s.TargetPath = ${q(exe)}; $s.WorkingDirectory = ${q(target)}; ` +
        `$s.IconLocation = ${q(exe)}; $s.Description = 'Local Compute Layer'; $s.Save()`;
    await ps(mk(startMenu));
    await ps(mk(desktop));
    return { startMenu, desktop };
}

/**
 * The batch that outlives us. Waits for THIS pid to exit, then removes what was
 * asked. Written to temp so it is not deleting the ground it stands on.
 */
function scheduleRemoval({ removeData }) {
    const target = installDir();
    const data = appDataDir();
    const start = path.join(process.env.APPDATA || "",
        "Microsoft", "Windows", "Start Menu", "Programs", APP_NAME + ".lnk");
    const desk = path.join(os.homedir(), "Desktop", APP_NAME + ".lnk");
    const bat = path.join(os.tmpdir(), `lcl-uninstall-${process.pid}.cmd`);

    const lines = [
        "@echo off",
        // wait for us to release our own files
        ":wait",
        `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul`,
        "if %errorlevel%==0 ( timeout /t 1 /nobreak >nul & goto wait )",
        // registration and shortcuts first — cheap, and leaves no ghost entry
        `reg delete "${REG_KEY}" /f >nul 2>&1`,
        `del /q "${start}" >nul 2>&1`,
        `del /q "${desk}" >nul 2>&1`,
        // the app itself
        `rmdir /s /q "${target}" >nul 2>&1`,
        // the operator's data, ONLY if they asked
        removeData ? `rmdir /s /q "${data}" >nul 2>&1` : "rem data kept by choice",
        // and finally the batch removes itself
        `del /q "%~f0" >nul 2>&1`
    ];
    fs.writeFileSync(bat, lines.join("\r\n"), "utf8");

    // detached, its own console hidden, so it survives our exit
    const child = spawn("cmd.exe", ["/c", bat],
        { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
}

/**
 * Full repair re-runs the installer, because restoring a corrupted app file
 * needs the original payload and that only exists inside the setup exe. The
 * path it was run from is recorded at install time; if it has moved, ask.
 */
async function runRepair(win) {
    let setup = null;
    try {
        const out = execFileSync("reg",
            ["query", REG_KEY, "/v", "InstallerPath"],
            { encoding: "utf8", windowsHide: true });
        const m = /InstallerPath\s+REG_SZ\s+(.+)/.exec(out);
        if (m && m[1].trim() && fs.existsSync(m[1].trim())) setup = m[1].trim();
    } catch { /* not recorded, or reg absent */ }

    if (!setup) {
        const r = await dialog.showOpenDialog(win, {
            title: "Find your lcl-Setup.exe to repair from",
            properties: ["openFile"],
            filters: [{ name: "Installer", extensions: ["exe"] }]
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: "cancelled" };
        setup = r.filePaths[0];
    }
    // hand off to the installer; it copies over the existing files (a repair)
    // and this maintenance window steps aside
    spawn(setup, ["--repair"], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, handedOff: true };
}

/* ------------------------------------------------------------------- window */
function windowBox() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = d.workArea;
    const width = Math.min(560, Math.max(440, wa.width - 80));
    const height = Math.min(420, Math.max(320, wa.height - 80));
    return { width, height,
        x: Math.round(wa.x + (wa.width - width) / 2),
        y: Math.round(wa.y + (wa.height - height) / 2) };
}

function run(mode) {
    // elevate first; a non-elevated uninstall cannot delete anything and must
    // not pretend otherwise
    if (!isElevated()) {
        relaunchElevated(mode === "repair" ? "repair" : "uninstall");
        app.quit();
        return;
    }

    let win = null;
    app.whenReady().then(() => {
        win = new BrowserWindow({
            ...windowBox(), show: false, frame: false, transparent: false,
            resizable: false, maximizable: false, backgroundColor: "#050505",
            icon: path.join(__dirname, "assets", "icon.ico"),
            webPreferences: {
                preload: path.join(__dirname, "maintenance-preload.js"),
                contextIsolation: true, nodeIntegration: false
            }
        });
        win.loadFile(path.join(__dirname, "maintenance.html"),
            { query: { mode } });
        win.once("ready-to-show", () => { win.show(); win.focus(); });
    });

    ipcMain.handle("maint:mode", () => mode);
    ipcMain.handle("maint:paths", () => ({ install: installDir(), data: appDataDir() }));

    ipcMain.handle("maint:uninstall", async (_e, opts) => {
        scheduleRemoval({ removeData: !!(opts && opts.removeData) });
        setTimeout(() => app.exit(0), 300);   // let the batch's wait loop begin
        return { ok: true };
    });

    ipcMain.handle("maint:repair", async () => {
        const r = await runRepair(win);
        if (r.ok) setTimeout(() => app.exit(0), 300);
        return r;
    });

    ipcMain.handle("maint:cancel", () => app.exit(0));
    ipcMain.handle("maint:minimise", () => win && win.minimize());
}

module.exports = { run, isElevated, installDir, appDataDir };
