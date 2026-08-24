"use strict";
/**
 * SCAFFOLD → BUILD → SERVE A WEB APP, without leaving .lcl.
 *
 * The operator wants models to stand up React apps locally. These run npm in the
 * REAL main-process context (full PATH, real env, and able to write into the
 * linked workspace) — NOT the run_script sandbox, whose scrubbed low-integrity
 * box traps the output away from the workspace and cannot reach the registry
 * cleanly. Same reasoning, same shape as githubAuth.cloneRepo.
 *
 * Windows gotcha, handled: never spawn npm.cmd (the .cmd shim fails under spawn
 * without a shell, and shell:true invites quoting bugs). Run node against npm's
 * own CLI entry — `node <nodeDir>/node_modules/npm/bin/npm-cli.js <args>` — so
 * it is a plain exe with an array of args, no shell, no .cmd.
 *
 * BUILD, NEVER PUSH / DEPLOY: this scaffolds, installs, builds, and serves
 * locally. Nothing here publishes or deploys — that stays the operator's hand.
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const tasks = require("./tasks");
const { ToolError, resolveInRoot, realpathOrNull } = require("./fsTools");

const WIN = process.platform === "win32";
const devServers = new Map();   // id -> { child, url, taskId, watchdog }
const MAX_DEV = 3;

function onPath(name) {
    try {
        const out = execFileSync(WIN ? "where" : "which", [name],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const hit = String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
        return hit && fs.existsSync(hit) ? hit : null;
    } catch { return null; }
}

/** A real node.exe — process.execPath is Electron here, not node. */
function findNode() {
    return onPath("node") || [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files (x86)\\nodejs\\node.exe",
        "/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node"
    ].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/** npm's own CLI entry, beside the node binary — spawned with node, no .cmd. */
function findNpmCli(node) {
    if (!node) return null;
    const dir = path.dirname(node);
    for (const rel of [
        ["node_modules", "npm", "bin", "npm-cli.js"],
        ["..", "lib", "node_modules", "npm", "bin", "npm-cli.js"]
    ]) {
        const p = path.join(dir, ...rel);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function toolchain() {
    const node = findNode();
    const npmCli = findNpmCli(node);
    return { node, npmCli, ok: !!(node && npmCli) };
}

/** Run one npm command in `cwd`, streaming progress; resolves {code, out}. */
function runNpm(tc, args, cwd, { onNote = () => {}, timeoutMs = 600_000 } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(tc.node, [tc.npmCli, ...args], {
                cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
                // a non-interactive npm never stops to prompt; keep the real env
                env: { ...process.env, CI: "1", NO_UPDATE_NOTIFIER: "1", npm_config_yes: "true" }
            });
        } catch (e) { return resolve({ code: -1, out: String((e && e.message) || e) }); }
        let out = "";
        const grab = (d) => {
            out += d; if (out.length > 40000) out = out.slice(-40000);
            const line = String(d).split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
            if (line) onNote(line.slice(0, 200));
        };
        child.stdout.on("data", grab);
        child.stderr.on("data", grab);
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ }
            finish({ code: -2, out: out.slice(-2000) + "\n(timed out)" }); }, timeoutMs);
        if (timer.unref) timer.unref();
        child.on("error", (e) => finish({ code: -1, out: String((e && e.message) || e) }));
        child.on("exit", (code) => finish({ code, out }));
    });
}

const SAFE_NAME = (s) => String(s || "").trim().replace(/[^\w.-]/g, "").slice(0, 60);

/** Scaffold a Vite + React app and install its deps into the workspace. */
async function scaffoldApp(root, args = {}, ctx = {}) {
    const tc = toolchain();
    if (!tc.ok) throw new ToolError("Node.js was not found on this machine. Install Node, then try again.");
    if (!root) throw new ToolError("Link a workspace folder first — the app scaffolds into it.");
    const name = SAFE_NAME(args.name) || "app";
    const template = /^react-ts$/i.test(String(args.template || "")) ? "react-ts" : "react";
    const dest = resolveInRoot(root, name);
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
        throw new ToolError(`"${name}" already exists in the workspace and is not empty.`);
    }
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote(`scaffolding ${name} (vite + ${template})…`);
    const scaf = await runNpm(tc, ["create", "vite@latest", name, "--", "--template", template], root,
        { onNote, timeoutMs: 300_000 });
    if (scaf.code !== 0 || !fs.existsSync(dest)) {
        return { ok: false, error: "scaffold failed", output: scaf.out.slice(-1500) };
    }
    onNote("installing dependencies (this can take a minute)…");
    const inst = await runNpm(tc, ["install"], dest, { onNote, timeoutMs: 600_000 });
    if (inst.code !== 0) {
        return { ok: false, folder: name, error: "npm install failed", output: inst.out.slice(-1500) };
    }
    return { ok: true, folder: name,
        note: `Scaffolded ${name}/ (vite + ${template}) and installed deps. Next: build_app ` +
              `{"dir":"${name}"} then serve_folder {"path":"${name}/dist"}, or run_dev_server ` +
              `{"dir":"${name}"} for live reload.` };
}

/** Build a scaffolded app; the static output lands in <dir>/dist. */
async function buildApp(root, args = {}, ctx = {}) {
    const tc = toolchain();
    if (!tc.ok) throw new ToolError("Node.js was not found on this machine.");
    if (!root) throw new ToolError("Link a workspace folder first.");
    const dir = SAFE_NAME(args.dir);
    if (!dir) throw new ToolError('Which app? e.g. {"dir": "my-app"}');
    const appDir = resolveInRoot(root, dir);
    if (!fs.existsSync(path.join(appDir, "package.json"))) {
        throw new ToolError(`no package.json in ${dir} — scaffold it first with scaffold_app.`);
    }
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote(`building ${dir}…`);
    const r = await runNpm(tc, ["run", "build"], appDir, { onNote, timeoutMs: 300_000 });
    const dist = path.join(dir, "dist").replace(/\\/g, "/");
    if (r.code !== 0 || !fs.existsSync(resolveInRoot(root, dist))) {
        return { ok: false, error: "build failed", output: r.out.slice(-1500) };
    }
    return { ok: true, dist,
        note: `Built to ${dist}. Serve it with serve_folder {"path":"${dist}"}.` };
}

/** Start Vite's dev server (loopback), registered and stoppable like serve_folder. */
async function runDevServer(root, args = {}, ctx = {}) {
    const tc = toolchain();
    if (!tc.ok) throw new ToolError("Node.js was not found on this machine.");
    if (!root) throw new ToolError("Link a workspace folder first.");
    if (devServers.size >= MAX_DEV) {
        throw new ToolError(`already running ${MAX_DEV} dev servers — stop one first (stop_server).`);
    }
    const dir = SAFE_NAME(args.dir);
    if (!dir) throw new ToolError('Which app? e.g. {"dir": "my-app"}');
    const appDir = resolveInRoot(root, dir);
    if (!fs.existsSync(path.join(appDir, "package.json"))) {
        throw new ToolError(`no package.json in ${dir} — scaffold it first.`);
    }
    let port = args.port == null ? 0 : Math.floor(+args.port);
    if (Number.isNaN(port) || (port !== 0 && (port < 1024 || port > 65535))) {
        throw new ToolError("port must be 1024-65535 (or omitted for automatic).");
    }
    const child = spawn(tc.node,
        [tc.npmCli, "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port || 0), "--strictPort", "false"],
        { cwd: appDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
          env: { ...process.env, CI: "1", NO_UPDATE_NOTIFIER: "1" } });

    // Vite prints "Local: http://127.0.0.1:<port>/" once it is up — resolve on that.
    return await new Promise((resolve) => {
        let out = "", settled = false, startedId = null;
        const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
        const onData = (d) => {
            out += d;
            const m = out.match(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?/i);
            if (m) {
                const url = m[0].endsWith("/") ? m[0] : m[0] + "/";
                const id = `dev-${Date.now()}`;
                startedId = id;
                const { cancelToken } = tasks.start({
                    id, kind: "serve", title: `Dev server for ${dir} at ${url}`,
                    detail: "vite dev · localhost only", sessionId: ctx.sessionId || null,
                    cancellable: true, meta: { url, dir: appDir, dev: true }
                });
                const watchdog = setInterval(() => {
                    if (cancelToken.cancelled) stopDev(id, "stopped from the task panel");
                }, 1000);
                if (watchdog.unref) watchdog.unref();
                devServers.set(id, { child, url, taskId: id, watchdog });
                if (typeof ctx.onNote === "function") ctx.onNote(`dev server at ${url}`);
                finish({ ok: true, id, url,
                    note: `Live dev server on this machine only at ${url}. Stop it with ` +
                          "stop_server or the task panel." });
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (e) => finish({ ok: false, error: String((e && e.message) || e) }));
        child.on("exit", (code) => {
            // Before start: report the failed launch. AFTER a successful start:
            // finish() is a no-op, so a server that self-exits used to leave its
            // ledger row "running", its devServers entry, and one of the MAX_DEV
            // slots leaked until app shutdown. Clean it up on exit instead.
            if (settled) { if (startedId) stopDev(startedId, "dev server exited"); return; }
            finish({ ok: false, error: `dev server exited (code ${code})`, output: out.slice(-1500) });
        });
        const timer = setTimeout(() => finish({ ok: false, error: "dev server did not report a URL in 90s", output: out.slice(-1500) }), 90_000);
        if (timer.unref) timer.unref();
    });
}

function stopDev(id, why = "stopped") {
    const s = devServers.get(id);
    if (!s) return false;
    devServers.delete(id);
    clearInterval(s.watchdog);
    try { s.child.kill(); } catch { /* already down */ }
    try { tasks.finish(s.taskId, "done", why); } catch { /* ledger best-effort */ }
    return true;
}
function stopAll() { for (const id of [...devServers.keys()]) { try { stopDev(id, "app shutting down"); } catch { /* gone */ } } }

const SCAFFOLD_ENTRY = {
    run: (root, args, ctx) => scaffoldApp(root, args, ctx),
    help: 'scaffold_app {"name":"…"} — create a Vite+React app in the workspace (+install).'
};
const BUILD_ENTRY = {
    run: (root, args, ctx) => buildApp(root, args, ctx),
    help: 'build_app {"dir":"my-app"} — build a scaffolded app to <dir>/dist, then serve_folder it.'
};
const DEV_ENTRY = {
    run: (root, args, ctx) => runDevServer(root, args, ctx),
    help: 'run_dev_server {"dir":"my-app"} — start the live Vite dev server (localhost only), stoppable.'
};

module.exports = {
    toolchain, scaffoldApp, buildApp, runDevServer, stopDev, stopAll,
    SCAFFOLD_ENTRY, BUILD_ENTRY, DEV_ENTRY
};
