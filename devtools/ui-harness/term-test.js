/* Drive the REAL terminal in the REAL renderer with a REAL shell, and prove a
 * typed command runs and its output lands in the pane. This is the test that
 * was missing when the operator said "i can not type in it and do anything". */
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

app.disableHardwareAcceleration();
const ROOT = path.join(__dirname, "..", "..");
const terminals = new Map();
let mainWindow = null;

function userShell() {
    if (process.platform === "win32") {
        const c = process.env.COMSPEC;
        return c && fs.existsSync(c) ? { file: c, args: [] }
             : { file: "powershell.exe", args: ["-NoLogo"] };
    }
    return { file: process.env.SHELL || "/bin/bash", args: ["-i"] };
}

ipcMain.handle("lcl:terminalStart", (_e, cols, rows) => {
    const sh = userShell();
    const id = "t" + terminals.size;
    const child = spawn(sh.file, sh.args, {
        cwd: os.homedir(),
        env: { ...process.env, COLUMNS: String(cols || 80), LINES: String(rows || 24), TERM: "dumb" },
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    terminals.set(id, child);
    const send = (d) => mainWindow && mainWindow.webContents.send("lcl:terminalData", id, d.toString("utf8"));
    child.stdout.on("data", send);
    child.stderr.on("data", send);
    child.on("exit", (code, sig) => mainWindow && mainWindow.webContents.send("lcl:terminalExit", id, sig || code));
    return { id, shell: sh.file, pid: child.pid, cols: cols || 80, rows: rows || 24,
             notice: "real shell, unsandboxed", limits: "no pty" };
});
ipcMain.handle("lcl:terminalWrite", (_e, id, data) => {
    const c = terminals.get(String(id));
    if (!c) return { error: "no such terminal" };
    try { c.stdin.write(String(data)); return { ok: true }; }
    catch (e) { return { error: String(e.message) }; }
});
ipcMain.handle("lcl:terminalResize", () => ({ ok: true }));
ipcMain.handle("lcl:terminalKill", (_e, id) => { const c = terminals.get(String(id)); if (c) c.kill(); return { ok: true }; });
ipcMain.handle("lcl:terminalList", () => ({ list: [] }));

const wait = (ms) => new Promise(r => setTimeout(r, ms));

const step = (m) => process.stderr.write("[step] " + m + "\n");
setTimeout(() => { step("HARD TIMEOUT 60s — exiting"); app.exit(2); }, 60000);

app.whenReady().then(async () => {
    step("ready");
    mainWindow = new BrowserWindow({
        width: 1200, height: 800, show: false,
        webPreferences: { preload: path.join(__dirname, "term-preload.js"),
                          contextIsolation: false, nodeIntegration: true, sandbox: false }
    });
    mainWindow.webContents.on("render-process-gone", (_e, d) => step("RENDERER GONE " + JSON.stringify(d)));
    step("loading index.html");
    await mainWindow.loadFile(path.join(ROOT, "app", "renderer", "index.html"));
    step("loaded; settling");
    await wait(1200);
    step("driving terminal");

    const js = (s) => mainWindow.webContents.executeJavaScript(s, true);
    let pass = 0, fail = 0;
    const check = (n, c, d) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} | ${n}${c || d === undefined ? "" : " <- " + JSON.stringify(d).slice(0, 200)}`); };

    // 1. open the terminal
    await js(`toggleTerminal(true)`);
    await wait(1500);   // let the shell start and print its first prompt
    let st = await js(`({ open: !document.getElementById("terminal").classList.contains("hidden"),
                          shells: (typeof shells !== "undefined") ? shells.size : -1,
                          active: (typeof termActive !== "undefined") ? termActive : null,
                          focused: document.activeElement === document.getElementById("terminal-view"),
                          out: (typeof shells !== "undefined" && termActive && shells.get(termActive)) ? shells.get(termActive).out.slice(-120) : "" })`);
    check("the terminal panel opens", st.open, st);
    check("a shell actually started", st.shells >= 1, st);
    check("it is the active shell", !!st.active, st);
    check("the shell printed a prompt into the pane", /PS |>|\$/.test(st.out), st.out);
    check("the terminal view has keyboard focus", st.focused, st);

    // 2. type with REAL key events through the full document->target->bubble
    // path — the way a keyboard actually delivers them, not a synthetic
    // dispatchEvent that would fire the listener even if the real path is broken
    mainWindow.focus(); mainWindow.webContents.focus();
    const wc = mainWindow.webContents;
    for (const ch of "echo termworks") {
        wc.sendInputEvent({ type: "keyDown", keyCode: ch });
        wc.sendInputEvent({ type: "char", keyCode: ch });
        wc.sendInputEvent({ type: "keyUp", keyCode: ch });
        await wait(20);
    }
    await wait(150);
    const echo = await js(`(typeof shells !== "undefined" && termActive) ? shells.get(termActive).echo : "?"`);
    check("REAL keystrokes build the echo line — the full event path works, not " +
          "just a synthetic dispatch", echo === "echo termworks", echo);

    wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await wait(1500);

    const out = await js(`(typeof shells !== "undefined" && termActive) ? shells.get(termActive).out : ""`);
    check("THE TYPED COMMAND RAN AND ITS OUTPUT IS IN THE PANE — 'echo termworks' " +
          "produced termworks", /termworks/.test(out) && /\btermworks\b/.test(out.split("echo termworks").pop()),
        out.slice(-160));
    check("...AND THE COMMAND IS NOT DOUBLE-ECHOED — it appears once, from the " +
          "shell, not twice from us adding our own copy",
        (out.match(/echo termworks/g) || []).length === 1, out.slice(-160));

    fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
    const img = await mainWindow.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, "out", "terminal.png"), img.toPNG());

    console.log(`\n${pass}/${pass + fail} terminal checks passed`);
    for (const c of terminals.values()) try { c.kill(); } catch {}
    app.exit(fail ? 1 : 0);
});
