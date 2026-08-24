/**
 * ATOMIC FILE WRITES — a crash mid-write never corrupts the source file.
 *
 * Gap named in the Gemini architectural pass and confirmed real against the
 * code: write_file and edit_file did a DIRECT fs.writeFileSync, so an OOM or
 * crash while writing a large file left it half-written. The endpoint store
 * was already atomic (tmp + rename); the model's own file writes were not.
 * Now both write a sibling temp and atomic-rename it over the target: a
 * failure leaves the TEMP half-written and the real file untouched, and the
 * temp is cleaned up.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => os.tmpdir() },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };
const ROOT = path.join(__dirname, "..");
const ft = require(path.join(ROOT, ".lcl.engine", "core", "fsTools.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 200) : ""); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-atomic-"));

/* ---- happy path: write_file creates, edit_file changes atomically ---- */
ft.writeFile(WS, { path: "a.txt", content: "hello world" });
check("write_file creates the file with the exact content",
    fs.readFileSync(path.join(WS, "a.txt"), "utf8") === "hello world");
ft.editFile(WS, { path: "a.txt", find: "hello world", replace: "EDITED" });
check("edit_file replaces an existing file through the atomic path (rename-over-existing works)",
    fs.readFileSync(path.join(WS, "a.txt"), "utf8") === "EDITED");
check("no temp files are left behind after a successful write",
    fs.readdirSync(WS).filter(f => f.includes("lcl-tmp")).length === 0);

/* ---- write_file NEVER clobbers a FOREIGN working file (the anti-misdiagnosis guard) ---- */
{
    // a FOREIGN file — one this session did not write (placed on disk directly,
    // exactly like the operator's real audio_sync.py feeder). Reading it does
    // NOT grant an overwrite; the misdiagnosis read the feeder first.
    fs.writeFileSync(path.join(WS, "feeder.py"), "# the real working feeder\nimport numpy\n");
    ft.readFile(WS, { path: "feeder.py" });
    let msg = "";
    try { ft.writeFile(WS, { path: "feeder.py", content: "A HALLUCINATED REWRITE" }); }
    catch (e) { msg = String(e.message); }
    check("write_file REFUSES to overwrite a FOREIGN existing non-empty file (even after reading it)",
        /will not overwrite/.test(msg));
    check("...and points at edit_file (change) and delete_file (replace) instead",
        /edit_file/.test(msg) && /delete_file/.test(msg));
    check("...the working file is byte-for-byte untouched — a wrong guess cannot eat it",
        fs.readFileSync(path.join(WS, "feeder.py"), "utf8").includes("the real working feeder"));

    // ...but a file THIS session wrote is the model's own fresh work — the
    // audit repairing a thin page it just built must succeed.
    ft.writeFile(WS, { path: "page.html", content: "<html><body><h1>thin</h1></body></html>" });
    let ownOk = true;
    try { ft.writeFile(WS, { path: "page.html", content: "<html><body><h1>Repaired</h1><nav>full</nav></body></html>" }); }
    catch { ownOk = false; }
    check("...but overwriting the session's OWN just-written file is allowed (the audit repair path)",
        ownOk && fs.readFileSync(path.join(WS, "page.html"), "utf8").includes("Repaired"));

    // an EMPTY foreign file holds nothing to lose — overwriting it is allowed
    fs.writeFileSync(path.join(WS, "blank.txt"), "");
    let blankOk = true;
    try { ft.writeFile(WS, { path: "blank.txt", content: "now has content" }); }
    catch { blankOk = false; }
    check("...and overwriting an EMPTY file is allowed (nothing to lose)",
        blankOk && fs.readFileSync(path.join(WS, "blank.txt"), "utf8") === "now has content");
}

/* ---- THE POINT: a failure mid-write never corrupts the real file (via edit_file, the overwrite path) ---- */
{
    fs.writeFileSync(path.join(WS, "safe.txt"), "ORIGINAL-INTACT");
    const realRename = fs.renameSync;
    let threw = false;
    fs.renameSync = () => { throw new Error("simulated crash during rename"); };
    try { ft.editFile(WS, { path: "safe.txt", find: "ORIGINAL-INTACT", replace: "THIS-SHOULD-NOT-LAND" }); }
    catch { threw = true; }
    fs.renameSync = realRename;
    check("an edit that fails at the rename throws rather than pretending success", threw);
    check("...and the ORIGINAL file is byte-for-byte untouched — no half-written corruption",
        fs.readFileSync(path.join(WS, "safe.txt"), "utf8") === "ORIGINAL-INTACT");
    check("...and the temp file is cleaned up, not left as litter",
        fs.readdirSync(WS).filter(f => f.includes("lcl-tmp")).length === 0);
}

/* ---- source pin: the levers cannot silently regress to a direct write ---- */
{
    const src = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "fsTools.js"), "utf8");
    check("the helper exists and renames a sibling temp over the target",
        /function atomicWriteSync\(full, content\)/.test(src)
        && src.includes("fs.renameSync(tmp, full)"));
    check("write_file routes through it, not a bare writeFileSync(full, …)",
        src.includes("atomicWriteSync(full, content);")
        && !/fs\.writeFileSync\(full, content, "utf8"\)/.test(src));
    check("edit_file routes through it too",
        src.includes("atomicWriteSync(full, next);")
        && !/fs\.writeFileSync\(full, next, "utf8"\)/.test(src));
    check("a failed rename cleans the temp (no leak on the error path)",
        /catch \(e\) \{[\s\S]*fs\.unlinkSync\(tmp\)[\s\S]*throw e;/.test(src));
}

try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${pass}/${pass + fail} atomic-write checks passed`);
if (fail) process.exit(1);
