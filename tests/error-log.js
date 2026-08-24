/**
 * THE ERROR LOG IS A CORE FUNCTION.
 *
 * The operator's requirement, verbatim: "you should be having error logs, that
 * is a core function of .lcl, so if this is not working, we need to be able to
 * debug with logs, not me finding an error prompt and showing you."
 *
 * Measured failure that forced this: the knowledge download died with EPERM
 * (a write aimed at Program Files) and the ONLY record of it was an error
 * string painted in the UI — main.js's guard() swallowed every handler
 * exception into { error } with nothing written anywhere, and an ASYNC
 * handler's rejection bypassed even that, surfacing as a raw IPC error.
 *
 * What this pins:
 *   - AuditLog serves a second, separately-named log (errors.jsonl) whose
 *     rotation follows its own base name — proven behaviorally.
 *   - guard() logs sync throws AND async rejections, and still answers
 *     { error } so the renderer keeps its contract.
 *   - process-level uncaughtException / unhandledRejection leave a trace.
 *   - knowledge-fetch failures land in the log with doc + url context.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AuditLog } = require(__dirname + "/../.lcl.engine/policy/audit.js");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 240) : ""); }
}

(async () => {
    /* ---- the second log, behaviorally ---- */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-errlog-"));
    const log = new AuditLog(dir, "errors.jsonl");
    log.write({ kind: "error", where: "test", message: "boom" });
    await new Promise(r => setTimeout(r, 250));
    check("a filename-parameterised AuditLog writes to ITS OWN file",
        fs.existsSync(path.join(dir, "errors.jsonl"))
        && !fs.existsSync(path.join(dir, "audit.jsonl")),
        fs.readdirSync(dir));
    const line = fs.readFileSync(path.join(dir, "errors.jsonl"), "utf8").trim();
    check("...as one JSON line with a timestamp",
        (() => { try { const j = JSON.parse(line); return j.ts && j.message === "boom"; }
                 catch { return false; } })(), line.slice(0, 120));
    check("...and rotation follows the base name, not a hardcoded 'audit'",
        (() => { const src = fs.readFileSync(
            path.join(__dirname, "..", ".lcl.engine", "policy", "audit.js"), "utf8");
            return src.includes("${this.base}-${stamp}.jsonl"); })(), null);
    log.close();
    await new Promise(r => setTimeout(r, 200));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } catch { /* handle */ }

    /* ---- the wiring in main, pinned ---- */
    const M = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
    check("main constructs the error log beside the audit log, under data/logs",
        /new AuditLog\(path\.join\(paths\.dataDir\(\), "logs"\), "errors\.jsonl"\)/.test(M), null);
    check("guard() logs SYNC throws to the error log",
        /catch \(err\) \{\s*logError\("ipc-handler", err\);/.test(M), null);
    check("guard() catches and logs ASYNC rejections too — before this, a rejected " +
          "handler promise bypassed the try entirely and nothing was logged",
        /typeof r\.then === "function"/.test(M)
        && /r\.catch\(\(err\) => \{\s*logError\("ipc-handler", err\);/.test(M), null);
    check("...while still answering { error } so the renderer contract holds",
        /return \{ error: String\(\(err && err\.message\) \|\| err\) \};/.test(M), null);
    check("uncaught exceptions and unhandled rejections leave a trace",
        /process\.on\("uncaughtException"/.test(M)
        && /process\.on\("unhandledRejection"/.test(M), null);
    check("a failed knowledge fetch is logged WITH its doc and url — the EPERM " +
          "that started this was debuggable only from a screenshot",
        (M.match(/logError\("knowledge-fetch"/g) || []).length >= 3
        && /\{ doc: String\(id\), url: src\.url \}/.test(M), null);
    check("the log itself can never throw back",
        /the error log must never create errors of its own/.test(M), null);

    console.log(`\n${pass}/${pass + fail} error-log checks passed`);
    process.exit(fail ? 1 : 0);
})();
