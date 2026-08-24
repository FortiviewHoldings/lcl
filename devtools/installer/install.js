/**
 * WHAT THE PRETTY WINDOW ACTUALLY DOES.
 *
 * The payload sits beside this file as `payload/` — the same tree
 * electron-builder produces as win-unpacked. Installing is therefore a copy, a
 * pair of shortcuts, and the registry entries that make Windows list the app in
 * Apps & Features and know how to remove it. Nothing here shells out to NSIS;
 * this IS the installer.
 *
 * Progress is per FILE, because the point of the line under the bar is to move
 * too fast to read. A byte-weighted percentage would be smoother but would need
 * a full stat pass first, and on 1.5 GB of model weights that pause is longer
 * than the honesty is worth: the count is taken once, cheaply, and the bar
 * tracks files.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const payload = require("./payload");

/**
 * AN .asar IS A FILE. ELECTRON DISAGREES, AND IT COST AN INSTALL.
 *
 * Electron patches `fs` so an .asar archive behaves like a directory: readdir
 * lists what is inside it, stat says directory. That is exactly right when you
 * are RUNNING an app out of one, and exactly wrong when you are COPYING one.
 * The walk descended into the payload's own app.asar, tried to copy the entries
 * it found there as if they were files on disk, and the install died with:
 *
 *   ENOENT, not found in
 *   C:\Users\…\Temp\lcl-setup\resources\payload\resources\app.asar
 *
 * — the archive's own error, surfacing because we asked the archive for a file
 * path that only exists as a member. Turning the patch off makes fs tell the
 * truth: app.asar is one file, 40-odd MB, copied whole.
 *
 * BUT IT IS SWITCHED OFF ONLY AROUND THE COPY, NEVER GLOBALLY. Setting it at
 * module load broke the installer far worse than the bug it fixed: this
 * installer's OWN ui.html lives inside its OWN app.asar, so disabling the patch
 * made loadFile fail and produced a window that was present, visible to the
 * API, 720x500 on screen — and completely blank, because it is transparent and
 * had nothing to paint: double-clicking the setup appeared to do nothing.
 * The test missed it because the test ran this file loose on disk, where
 * nothing is ever read out of an archive.
 */

const APP_NAME = ".lcl";
const APP_EXE = ".lcl.exe";
const PUBLISHER = "PragOptics";
/* MACHINE-WIDE, because that is where the previous installer put it and this
 * one replaces that install rather than sitting beside it. A prior install
 * registered as:
 *   HKLM\...\Uninstall\dc4cbf74-…   DisplayName .lcl
 *   UninstallString "C:\Program Files\.lcl\Uninstall .lcl.exe" /allusers
 * Writing our entry under the SAME hive keeps one .lcl in Apps & Features
 * instead of two disagreeing about where it lives. */
const REG_ROOT = "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const REG_KEY = REG_ROOT + "\\lcl";

function payloadRoot() {
    // LCL_PAYLOAD lets the asar test drive this against a REAL extracted
    // payload rather than a fixture — the defect it exists to catch only
    // appears with a genuine .asar in the tree
    if (process.env.LCL_PAYLOAD && fs.existsSync(process.env.LCL_PAYLOAD)) {
        return process.env.LCL_PAYLOAD;
    }
    // packaged: resources/payload   ·  dev: ./payload
    const packed = path.join(process.resourcesPath || "", "payload");
    if (fs.existsSync(packed)) return packed;
    return path.join(__dirname, "payload");
}

/**
 * WHERE .lcl ALREADY LIVES, if it does. An upgrade must land on top of the
 * existing copy — installing over the previous install, as the old installer
 * did — so the previous location wins over any default we would have picked.
 * Read from the registry the old installer wrote, then from the obvious place,
 * and only then fall back.
 */
function existingInstall() {
    const probes = [
        "reg query \"" + REG_KEY + "\" /v InstallLocation",
        "reg query \"" + REG_ROOT + "\" /s /f .lcl"
    ];
    for (const p of probes) {
        try {
            const out = require("child_process")
                .execSync(p + " 2>nul", { encoding: "utf8", windowsHide: true });
            const m = /InstallLocation\s+REG_SZ\s+(.+)/.exec(out);
            if (m && m[1].trim()) return m[1].trim();
            const u = /UninstallString\s+REG_SZ\s+"?([A-Za-z]:\\[^"\r\n]+)"?/.exec(out);
            if (u && u[1]) return path.dirname(u[1].replace(/"/g, "").trim());
        } catch { /* not registered: try the next probe */ }
    }
    const guess = path.join(process.env.PROGRAMFILES || "C:\\Program Files", APP_NAME);
    return fs.existsSync(path.join(guess, APP_EXE)) ? guess : null;
}

function defaultDir() {
    return existingInstall()
        || path.join(process.env.PROGRAMFILES || "C:\\Program Files", APP_NAME);
}

/**
 * Run something with Electron's asar patch off, and put it back afterwards.
 * Every walk of a tree that CONTAINS an .asar needs this, and nothing else
 * does — scoping it here is what keeps the installer able to read its own
 * files out of its own archive while it works.
 */
function withoutAsar(fn) {
    const prev = process.noAsar;
    process.noAsar = true;
    try { return fn(); } finally { process.noAsar = prev; }
}

/**
 * The same thing for work that AWAITS. The synchronous version restores the
 * flag the moment its callback returns a promise — which for the copy meant it
 * was restored before the first file moved, putting the original bug straight
 * back while looking like it had been scoped correctly.
 */
async function withoutAsarAsync(fn) {
    const prev = process.noAsar;
    process.noAsar = true;
    try { return await fn(); } finally { process.noAsar = prev; }
}

/** Every file under a root, so the bar has a denominator. */
function walk(root) {
    const out = [];
    const stack = [root];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.isFile()) out.push(full);
        }
    }
    return out;
}

/**
 * Copy the tree, reporting each file. Copy rather than rename: the target is
 * frequently on a different volume from the staging directory, and a rename
 * across volumes fails in a way that would only show up on somebody else's
 * machine.
 */
async function copyTree(from, to, onFile) {
    // the patch is off for exactly as long as the copy, and restored on every
    // exit path — this window still has to read its own files out of its own
    // archive after the install finishes
    return withoutAsarAsync(async () => {
        const files = walk(from);
        let done = 0;
        for (const src of files) {
            const rel = path.relative(from, src);
            const dst = path.join(to, rel);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            await fs.promises.copyFile(src, dst);
            done++;
            onFile(rel, done, files.length);
        }
        return files.length;
    });
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

/** Start-menu and desktop shortcuts, through the shell's own COM object. */
async function shortcuts(target) {
    const exe = path.join(target, APP_EXE);
    const startMenu = path.join(process.env.APPDATA || "",
        "Microsoft", "Windows", "Start Menu", "Programs", APP_NAME + ".lnk");
    const desktop = path.join(os.homedir(), "Desktop", APP_NAME + ".lnk");
    const mk = (lnk) =>
        `$w = New-Object -ComObject WScript.Shell; ` +
        `$s = $w.CreateShortcut(${q(lnk)}); ` +
        `$s.TargetPath = ${q(exe)}; ` +
        `$s.WorkingDirectory = ${q(target)}; ` +
        `$s.IconLocation = ${q(exe)}; ` +
        `$s.Description = 'Local Compute Layer'; $s.Save()`;
    await ps(mk(startMenu));
    await ps(mk(desktop));
    return { startMenu, desktop };
}

/**
 * Apps & Features. Written under HKLM, matching where the previous installer
 * put both the app and its registration, so an upgrade replaces that entry
 * instead of adding a second one beside it. HKLM needs elevation, which is why
 * this installer asks for it — the one Windows dialog nobody can theme.
 */
// reg.exe DIRECTLY, arguments as an array — no shell, no re-quoting. The old
// path built a `reg add …` STRING and ran it through `powershell -Command`,
// and the values that carry a quoted path with spaces —
//   UninstallString = "C:\Program Files\.lcl\.lcl.exe" --uninstall
// — were backslash-escaped C-style and then mangled by PowerShell's own parser,
// so reg saw garbage and stored the value EMPTY. That is why Apps & Features
// showed no working Uninstall or Modify: the strings behind them were blank.
// Passed as argv, the value reaches reg.exe byte for byte.
function regAdd(name, value, type = "REG_SZ") {
    return new Promise((resolve) => {
        execFile("reg",
            ["add", REG_KEY, "/v", name, "/t", type, "/d", String(value), "/f"],
            { windowsHide: true },
            (err, out, errOut) => resolve({ ok: !err, out: String(out || ""), err: String(errOut || "") }));
    });
}

async function registerUninstall(target, sizeKb) {
    const exe = path.join(target, APP_EXE);
    // WHERE THIS INSTALLER RAN FROM. electron-builder's portable target exposes
    // its own on-disk path here; full-recopy repair re-launches it. If it is
    // gone by then, the maintenance window asks the operator to point at it.
    const setupExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const values = [
        ["DisplayName", APP_NAME],
        ["DisplayVersion", "1.0.0"],
        ["Publisher", PUBLISHER],
        ["DisplayIcon", exe],
        ["InstallLocation", target],
        // Apps & Features "Uninstall" and "Modify" both come back to the app in
        // maintenance mode — instant, themed, and already on disk. The value is
        // a quoted exe path plus a flag, which is exactly what broke before.
        ["UninstallString", `"${exe}" --uninstall`],
        ["ModifyPath", `"${exe}" --repair`],
        ["InstallerPath", setupExe],
        ["EstimatedSize", String(sizeKb), "REG_DWORD"],
        ["NoModify", "0", "REG_DWORD"],      // show "Modify" — that is Repair
        ["NoRepair", "0", "REG_DWORD"]
    ];
    for (const [name, value, type] of values) await regAdd(name, value, type);

    /* ONE ENTRY IN APPS & FEATURES, NOT TWO. The previous installer registered
     * itself under a generated GUID (measured: dc4cbf74-a64d-59ea-…) pointing at
     * "Uninstall .lcl.exe". Installing over the top without clearing it leaves
     * the operator with two .lcl rows, one of which removes files the other
     * still claims. Any sibling key whose DisplayName is ours and which is not
     * this key is a previous registration and goes. */
    await ps(
        `Get-ChildItem 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' ` +
        `-ErrorAction SilentlyContinue | ForEach-Object { ` +
        `  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; ` +
        `  if ($p.DisplayName -eq '${APP_NAME}' -and $_.PSChildName -ne 'lcl') { ` +
        `    Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue } }`);

    // ...and the old uninstaller binary itself, which no longer owns anything
    try { fs.rmSync(path.join(target, "Uninstall .lcl.exe"), { force: true }); }
    catch { /* not there, or held: the registry no longer points at it either */ }
    // ...and the stopgap rmdir script from earlier builds of THIS installer,
    // now superseded by the app's own maintenance window
    try { fs.rmSync(path.join(target, "uninstall.cmd"), { force: true }); }
    catch { /* absent */ }
}

async function install(targetDir, onProgress, opts = {}) {
    /* A DRY RUN COPIES AND NOTHING ELSE.
     *
     * Rehearsing this module for real overwrote the user's own Desktop and
     * Start Menu shortcuts with ones aimed into a temp folder, and registered a
     * fixture in Apps & Features. Copying files into a throwaway directory is
     * safe to practise; reaching into the shell and the registry is not. So the
     * two are separable, and a test gets only the half that cannot hurt. */
    const dry = opts.dryRun === true;

    /* TWO WAYS THE APP CAN ARRIVE:
     *   - appended to this exe (the shipped installer) — streamed straight to
     *     the target, which is why the window comes up in seconds instead of
     *     after minutes of silent pre-extraction;
     *   - a payload/ directory beside this file (dev, and the old shape) —
     *     copied. Kept so the installer still runs from source. */
    const appended = payload.hasPayload();
    const from = appended ? null : payloadRoot();
    if (!appended && !fs.existsSync(from)) {
        throw new Error("the payload is missing from this installer");
    }
    const target = path.resolve(String(targetDir || defaultDir()));
    if (!/^[A-Za-z]:\\/.test(target)) throw new Error("that is not a full path");

    fs.mkdirSync(target, { recursive: true });

    /* UPGRADE IN PLACE, but never unpack into a stranger's folder. A directory
     * holding .lcl.exe or resources/ is a previous install and is ours to
     * replace; anything else with contents is somebody's documents and gets
     * refused rather than merged into. */
    const existing = fs.readdirSync(target);
    const isOurs = existing.includes(APP_EXE) || existing.includes("resources")
                || existing.includes("Uninstall .lcl.exe");
    if (existing.length && !isOurs) {
        throw new Error("that folder already has something else in it");
    }

    /* A RUNNING COPY HOLDS ITS OWN FILES OPEN. Overwriting .lcl.exe while the
     * app is up fails with EBUSY partway through, which would leave a half
     * written install — worse than not starting. Close it first, and wait,
     * because the process does not die the instant it is asked to. */
    if (isOurs) {
        onProgress({ pct: 1, file: "closing .lcl if it is running" });
        await ps("Get-Process -Name '.lcl','lcl' -ErrorAction SilentlyContinue | " +
                 "Stop-Process -Force -ErrorAction SilentlyContinue");
        // UNTIL IT IS ACTUALLY GONE, not a fixed nap. A teardown that outlives
        // 1.5s (five processes, files still open) met the extraction mid-write
        // and EBUSY'd a half-written install. Poll to a bounded deadline; the
        // fallback nap remains only for the day the poll itself cannot run.
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            const left = await ps(
                "(Get-Process -Name '.lcl','lcl' -ErrorAction SilentlyContinue | " +
                "Measure-Object).Count");
            if (String(left.out).trim() === "0") break;
            await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, 500));   // file handles release last
    }

    let bytes = 0;
    let count = 0;
    if (appended) {
        // stream the appended archive straight into the target, 0..96%
        await payload.extract(payload.selfExe(), target, (p) => {
            onProgress({ pct: Math.min(96, p.pct * 0.96), file: p.file });
        });
    } else {
        count = await copyTree(from, target, (rel, done, total) => {
            onProgress({ pct: (done / total) * 96, file: rel });
        });
    }
    // the target now HOLDS an app.asar, so this walk needs the patch off too or
    // it counts the archive members instead of the archive
    try { withoutAsar(() => { for (const f of walk(target)) bytes += fs.statSync(f).size; }); }
    catch { /* size is cosmetic */ }

    if (!dry) {
        onProgress({ pct: 97, file: "creating shortcuts" });
        await shortcuts(target);
        onProgress({ pct: 99, file: "registering with Windows" });
        await registerUninstall(target, Math.round(bytes / 1024));
    }
    onProgress({ pct: 100, file: "done" });

    return { ok: true, target, files: count };
}

/** Is there already an .lcl in this folder? Drives the wording, not the work. */
function isUpgrade(dir) {
    try {
        const d = String(dir || "");
        return fs.existsSync(path.join(d, APP_EXE))
            || fs.existsSync(path.join(d, "Uninstall .lcl.exe"));
    } catch { return false; }
}

module.exports = { install, defaultDir, isUpgrade, existingInstall, payloadRoot, APP_EXE };
