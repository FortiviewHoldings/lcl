/**
 * THE BUG THAT KILLED THE FIRST REAL INSTALL, AS A TEST.
 *
 * Must run under ELECTRON, not node: plain node does not patch fs, so the
 * defect cannot reproduce there and a green result would mean nothing. Under
 * Electron an .asar reads as a directory, and the copy walks into it.
 *
 *   electron installer/asar-check.js
 *
 * Runs the REAL install module in dryRun against the REAL payload, and asserts
 * the archive arrived as ONE FILE of the right size rather than as a folder of
 * its own members.
 */
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SRC = process.env.LCL_PAYLOAD
    || path.join(os.tmpdir(), "lcl-setup", "resources", "payload");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    let pass = 0, fail = 0;
    const check = (name, cond, detail) => {
        if (cond) { pass++; console.log("PASS |", name); }
        else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + JSON.stringify(detail) : ""); }
    };

    check("(setup) a real payload with a real app.asar is present",
        fs.existsSync(path.join(SRC, "resources", "app.asar")), SRC);
    if (!fs.existsSync(SRC)) { app.exit(1); return; }

    /* First, show the trap is real: with the patch ON, an archive lies. */
    process.noAsar = false;
    const asar = path.join(SRC, "resources", "app.asar");
    const liesAsDir = fs.statSync(asar).isDirectory();
    check("WITH ELECTRON'S PATCH ON, app.asar reports itself a DIRECTORY — this " +
          "is the whole defect: the copy walked into the archive and tried to " +
          "write its members as if they were files",
        liesAsDir === true, { isDirectory: liesAsDir });

    /* THE SECOND BUG, WHICH WAS WORSE THAN THE FIRST.
     *
     * The first fix set process.noAsar = true at module load. That fixed the
     * copy and broke everything else: this installer reads its OWN ui.html out
     * of its OWN app.asar, so loadFile failed and the operator got a window
     * that was on screen, sized, "visible" to the API, and completely blank.
     * The patch must therefore be off ONLY while copying, and on at every other
     * moment. */
    const { install } = require("./install");
    check("REQUIRING THE INSTALLER DOES NOT DISABLE ASAR GLOBALLY — doing that " +
          "stopped it reading its own ui.html and produced a blank window",
        process.noAsar !== true, { noAsar: process.noAsar });

    check("...so a file can still be READ from inside an archive after require, " +
          "which is exactly what loadFile does",
        (() => {
            try { return fs.readdirSync(asar).length > 0; } catch { return false; }
        })());

    /* Sizing an archive needs the patch off too — with it on, stat calls it a
     * directory and reports 0, which made this check compare 0 against 0 and
     * pass for the wrong reason. */
    const sizeOf = (f) => {
        const prev = process.noAsar;
        process.noAsar = true;
        try { return fs.statSync(f).size; } finally { process.noAsar = prev; }
    };
    const srcBytes = sizeOf(asar);
    check("(setup) the source archive has a real size", srcBytes > 40e6, srcBytes);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-asar-check-"));
    let err = null, res = null;
    try {
        res = await install(target, () => {}, { dryRun: true });
    } catch (e) { err = String((e && e.message) || e); }

    check("THE COPY COMPLETES. It died here on the operator's machine with " +
          "'ENOENT, not found in …\\payload\\resources\\app.asar'",
        !err && res && res.ok === true, err);

    const out = path.join(target, "resources", "app.asar");
    check("...and the archive landed as ONE FILE, byte for byte, not unpacked " +
          "into a folder of its own members",
        fs.existsSync(out) && sizeOf(out) === srcBytes,
        { expected: srcBytes, got: fs.existsSync(out) ? sizeOf(out) : null });

    check("...and the app executable came across too",
        fs.existsSync(path.join(target, ".lcl.exe")));

    /* AND THE FLAG IS BACK. If the copy leaves it off, the finish page cannot
     * load, the window goes blank at the last step instead of the first, and
     * the operator is told nothing. */
    check("THE PATCH IS RESTORED AFTER THE COPY, so the window can still read " +
          "its own files when the install finishes",
        process.noAsar !== true, { noAsar: process.noAsar });
    check("...proven by reading out of an archive again, after installing",
        (() => {
            try { return fs.readdirSync(asar).length > 0; } catch { return false; }
        })());

    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 4 }); } catch { /* held */ }
    console.log(`\n${pass}/${pass + fail} asar checks passed`);
    app.exit(fail ? 1 : 0);
});
