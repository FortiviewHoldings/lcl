/**
 * THE TERMINAL RUNS EACH LANGUAGE AS ITSELF.
 *
 * Measured from the operator's session, nine failures deep: interpreterFor on
 * Windows returned POWERSHELL FOR EVERY LANGUAGE, so a python script was
 * written to _lcl_script.ps1 and parsed by powershell.exe — "Missing
 * expression after ','", exit 1, every single time — and the operator ended
 * up running scripts BY HAND in a real terminal. sandbox_test meanwhile
 * refused the {code, language} shape the model actually emits, nine times,
 * teaching it nothing.
 *
 * These are LIVE checks: the python and node halves execute real
 * interpreters when present and are skipped honestly when not.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-termtest-"));
process.env.LCL_DATA_DIR = DATA;
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

const sr = require(path.join(ROOT, ".lcl.engine", "core", "scriptRunner.js"));
const sandbox = require(path.join(ROOT, ".lcl.engine", "core", "sandbox.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 200) : ""); }
}
const has = (cmd) => {
    try { return spawnSync(cmd, ["--version"], { timeout: 8000 }).status === 0; }
    catch { return false; }
};
const PY = process.platform === "win32" ? "py" : "python3";

(async () => {
    /* ---- the source-of-truth pins (no interpreters needed) ---- */
    const SRC = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "scriptRunner.js"), "utf8");
    check("python maps to a python interpreter, never the platform shell",
        /py\(thon\)\?3\?\$\/\.test\(lang\)/.test(SRC.replace(/\\/g, "")) || SRC.includes('command: win ? "py" : "python3"'));
    check("node maps to node", SRC.includes('command: win ? "node.exe" : "node"'));

    /* ---- live: a REAL python script through the real runner ---- */
    if (has(PY)) {
        const prop = sr.propose({
            script: 'print("PY_OK")', language: "python",
            purpose: "regression: python runs as python", rollback: "prints only",
            sessionId: "termtest"
        });
        check("a python script stages as python, not powershell",
            prop.ok && prop.proposal.language === "python", prop.error);
        if (prop.ok) {
            const run = await sr.approve(prop.proposal.id);
            check("...and RUNS, printing through the real interpreter",
                run.ok === true && /PY_OK/.test(String(run.out || run.output || "")),
                JSON.stringify(run).slice(0, 160));
        }
    } else {
        console.log("SKIP | python not installed on this machine — live half skipped");
    }

    /* ---- live: node ---- */
    const propN = sr.propose({
        script: 'console.log("NODE_OK")', language: "node",
        purpose: "regression: node runs as node", rollback: "prints only", sessionId: "termtest"
    });
    check("a node script stages as node", propN.ok && propN.proposal.language === "node", propN.error);
    if (propN.ok) {
        const run = await sr.approve(propN.proposal.id);
        check("...and RUNS under node", run.ok === true && /NODE_OK/.test(String(run.out || run.output || "")),
            JSON.stringify(run).slice(0, 160));
    }

    /* ---- sandbox_test coercion: the model's exact failing shape ---- */
    if (has(PY)) {
        const r = await sandbox.TOOL_ENTRY.run(null, { code: 'print("SB_OK")', language: "python" }, {});
        check("sandbox_test accepts {code, language} — the shape refused nine times",
            r && r.green === true, JSON.stringify(r && r.checks).slice(0, 160));
    }
    const rj = await sandbox.TOOL_ENTRY.run(null, { code: 'console.log("SBJS_OK")', language: "node" }, {});
    check("...and the default check runs the file in its OWN language",
        rj && rj.green === true, JSON.stringify(rj && rj.checks).slice(0, 160));
    let refused = "";
    try { await sandbox.TOOL_ENTRY.run(null, {}, {}); } catch (e) { refused = e.message; }
    check("an empty call is still refused, and the error teaches BOTH easy shapes — " +
          "fresh {code} AND {file} for a file already in the workspace",
        /\{"code"/.test(refused) && /\{"file"/.test(refused), refused);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
