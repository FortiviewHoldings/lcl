/**
 * THE AUDIT LOG ROTATES MID-RUN, NOT ONLY ACROSS RESTARTS.
 *
 * The 8 MB rotation check lived inside #open(), after its cached-stream early
 * return — so it ran once per process. The audit log is a never-closed module
 * singleton, so a long-lived engine process grew audit.jsonl without bound and
 * "rotated" only when the app was restarted. The fix tracks bytes written and
 * closes-then-reopens when the current file crosses the cap, so #open rotates
 * the now-oversized file. Nothing is ever truncated; the old file is renamed.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AuditLog } = require(__dirname + "/../.lcl.engine/policy/audit.js");

const MAX = 8 * 1024 * 1024;
let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 200) : ""); }
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-audit-"));
    const log = new AuditLog(dir);
    const pad = "x".repeat(512 * 1024);   // 0.5 MB per record

    // write ~12 MB WITHOUT restarting the process; drain the event loop between
    // writes so the stream flush/close that rotation relies on can run (real
    // audit writes are spaced out by whole tool decisions, so this is faithful).
    for (let i = 0; i < 24; i++) {
        log.write({ decision: "allow", tool: "read_file", i, pad });
        await new Promise(r => setImmediate(r));
        await new Promise(r => setTimeout(r, 5));
    }
    await new Promise(r => setTimeout(r, 200));

    const files = fs.readdirSync(dir);
    const rotated = files.filter(f => /^audit-.*\.jsonl$/.test(f));
    check("a long-running log ROTATES mid-process — not only on restart",
        rotated.length >= 1, files);
    check("...the live audit.jsonl is a fresh file, well under the 8 MB cap",
        fs.existsSync(path.join(dir, "audit.jsonl"))
        && fs.statSync(path.join(dir, "audit.jsonl")).size < MAX,
        fs.existsSync(path.join(dir, "audit.jsonl")) ? fs.statSync(path.join(dir, "audit.jsonl")).size : "missing");
    check("...and NOTHING was destroyed — the rotated file still holds the earlier records",
        rotated.length >= 1 && fs.statSync(path.join(dir, rotated[0])).size > MAX * 0.5,
        rotated.map(f => fs.statSync(path.join(dir, f)).size));

    log.close();
    await new Promise(r => setTimeout(r, 250));   // let the final stream close its handle
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }); }
    catch { /* a still-open handle on Windows — a temp dir, best-effort cleanup */ }
    console.log(`\n${pass}/${pass + fail} audit-rotation checks passed`);
    process.exit(fail ? 1 : 0);
})();
