/**
 * SCAFFOLD → BUILD → SERVE a React app, without leaving .lcl. Three first-class
 * tools that run npm in the real main-process context (not the run_script
 * sandbox, which traps output away from the workspace). The static build is
 * served by the existing serve_folder. BUILD, NEVER PUSH — no deploy verb.
 *
 * Static wiring test — it does NOT run npm (that needs the network + minutes).
 */
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..");
const mod = fs.readFileSync(path.join(R, ".lcl.engine", "core", "webScaffold.js"), "utf8");
const agentSrc = fs.readFileSync(path.join(R, ".lcl.engine", "core", "agent.js"), "utf8");
const classify = fs.readFileSync(path.join(R, ".lcl.engine", "policy", "classify.js"), "utf8");
const manifest = fs.readFileSync(path.join(R, ".lcl.engine", "core", "toolManifest.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(R, "app", "main.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 160) : ""); }
}

/* ---- the module loads and is shaped right ---- */
const ws = require(path.join(R, ".lcl.engine", "core", "webScaffold.js"));
for (const fn of ["toolchain", "scaffoldApp", "buildApp", "runDevServer", "stopAll"]) {
    check(`webScaffold exports ${fn}`, typeof ws[fn] === "function");
}
check("exposes the three tool entries", !!ws.SCAFFOLD_ENTRY && !!ws.BUILD_ENTRY && !!ws.DEV_ENTRY);
check("toolchain() finds this machine's node + npm-cli (real context)", (() => {
    try { const t = ws.toolchain(); return t && typeof t === "object" && "ok" in t; } catch { return false; }
})());

/* ---- the Windows spawn gotcha is handled: node against npm-cli.js, no .cmd ---- */
check("runs `node npm-cli.js …` (no npm.cmd spawn, no shell:true)",
    /spawn\(tc\.node, \[tc\.npmCli/.test(mod) && !/spawn\([^)]*npm\.cmd/.test(mod) && !/shell: true/.test(mod));
check("scaffolds Vite+React non-interactively and installs",
    /create", "vite@latest"/.test(mod) && /"--template"/.test(mod) && /\["install"\]/.test(mod) && /CI: "1"/.test(mod));
check("build lands in <dir>/dist and points at serve_folder",
    /"run", "build"/.test(mod) && /serve_folder/.test(mod) && /dist/.test(mod));
check("dev server is loopback, task-registered and stoppable",
    /--host", "127\.0\.0\.1"/.test(mod) && /tasks\.start/.test(mod) && /function stopDev/.test(mod));
check("BUILD NEVER PUSH — the module spawns only create/install/build/dev, no publish/push/deploy command",
    /"create", "vite@latest"/.test(mod) && /\["install"\]/.test(mod) && /"run", "build"/.test(mod)
    && !/\["?(publish|deploy)"?\]|"run", "(publish|deploy)"|\bnpm publish\b|git.*push/.test(mod));

/* ---- registration + gating ---- */
check("build_app / run_dev_server register behind a linked workspace",
    /tools\.build_app = webScaffold\.BUILD_ENTRY/.test(agentSrc)
    && /tools\.run_dev_server = webScaffold\.DEV_ENTRY/.test(agentSrc));
check("scaffold_app is gated on network AND workspace (it hits the registry)",
    /if \(hasWorkspace\) tools\.scaffold_app = webScaffold\.SCAFFOLD_ENTRY/.test(agentSrc));
check("dev servers are torn down on app shutdown",
    /webScaffold"\)\.stopAll\(\)/.test(mainSrc));

/* ---- policy + schema ---- */
check("all three are EXECUTE with a notify sessionFloor (grants stick)",
    /scaffold_app:\s*\{ capability: "sys\.execute", classification: CLASSIFICATION\.EXECUTE[^}]*sessionFloor: "notify"/.test(classify)
    && /build_app:\s*\{[^}]*sessionFloor: "notify"/.test(classify)
    && /run_dev_server:\s*\{[^}]*sessionFloor: "notify"/.test(classify));
check("schemaOnly ARG_DETAIL so native calling gets args without prompt bloat",
    /scaffold_app: \{\s*schemaOnly: true/.test(manifest)
    && /build_app: \{\s*schemaOnly: true/.test(manifest)
    && /run_dev_server: \{\s*schemaOnly: true/.test(manifest));

console.log(`\n${pass}/${pass + fail} web-scaffold checks passed`);
process.exit(fail ? 1 : 0);
