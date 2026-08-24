/**
 * Dev launcher for .lcl
 *
 * The app is self-contained: app/ supervises the llama.cpp engine itself
 * (see app/core/engine.js), so there is no separate backend process to start
 * any more. This script just runs the Electron app from source.
 *
 * For an installed build, use the .lcl desktop / Start Menu shortcut instead.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "app");

const electronBin = path.join(
    UI_DIR, "node_modules", ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron"
);

if (!fs.existsSync(electronBin)) {
    console.error(`[.lcl] Electron is not installed. Run "npm install" in ${UI_DIR} first.`);
    process.exit(1);
}

console.log("[.lcl] starting…");

const child = spawn(electronBin, ["."], {
    cwd: UI_DIR,
    shell: true,
    stdio: "inherit",
    env: process.env
});

child.on("close", code => process.exit(code || 0));

process.on("SIGINT", () => {
    child.kill();
    process.exit(0);
});
