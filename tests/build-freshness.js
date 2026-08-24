/**
 * A PACKAGE OLDER THAN THE CODE MUST NOT PASS THE GATE.
 *
 * Measured on 9 August 2026, and it is the reason this file exists: an
 * installer built, packed, self-checked and passed `asar-check` 10/10 while
 * MISSING A WHOLE FEATURE. The engine module and the renderer changes had been
 * written after electron-builder ran, so they were in neither the package nor
 * the missing-modules check — that check asks whether every module in the repo
 * reached the package, and a file created after the build passes it trivially
 * by being absent from both sides.
 *
 * Every check in the gate was asking whether the build was internally
 * consistent. None was asking whether it contained the work. This is that
 * question, asked the only way it can be: the newest source file must be older
 * than the artefact.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++;
        console.log("FAIL |", name,
            detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 240) : "");
    }
}

const R = path.join(__dirname, "..");
const rel = fs.readFileSync(path.join(R, "devtools", "release.js"), "utf8");

/* ---- the gate carries the check, and says what it is for ---- */
check("THE GATE ASKS WHETHER THE PACKAGE CONTAINS THE WORK, not only whether " +
      "it is internally consistent",
    /IS THE BUILD OLDER THAN THE CODE\?/.test(rel));
check("...it compares the NEWEST source against the artefact",
    /const newest = \(dir, exts\)/.test(rel)
    && /fs\.statSync\(asar\)\.mtimeMs/.test(rel));
check("...over both the app and the engine, and the file types that ship",
    /newest\(path\.join\(ROOT, "app"\), \[".js", "\.html"|newest\(path\.join\(ROOT, "app"\)/.test(rel)
    && /newest\(path\.join\(ROOT, "\.lcl\.engine"\)/.test(rel));
check("...it NAMES the offending file, so the fix is obvious rather than a hunt",
    /path\.relative\(ROOT, src\.who\)/.test(rel));
check("...it explains why everything else would have passed",
    /would pass/.test(rel) && /missing-modules check/.test(rel));
check("...it dies rather than warning — a package missing a feature is not a " +
      "package", /die\(`the package is OLDER than the source/.test(rel));
check("...and it allows a little slack for filesystem timestamp granularity",
    /built \+ 2000/.test(rel));
check("...and it reports the check when it passes, so the gate says it looked",
    /freshness  newest source predates the package/.test(rel));

/* ---- the comparison itself, exercised ---- */
{
    // the gate's rule, lifted so it can be driven with real files rather than
    // asserted about in prose
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-fresh-"));
    const built = path.join(dir, "app.asar");
    const src = path.join(dir, "later.js");

    fs.writeFileSync(built, "x");
    const builtAt = fs.statSync(built).mtimeMs;

    // a source file written 60 seconds AFTER the package
    fs.writeFileSync(src, "y");
    fs.utimesSync(src, new Date(), new Date(builtAt + 60_000));
    const srcAt = fs.statSync(src).mtimeMs;
    check("a source file newer than the package is CAUGHT", srcAt > builtAt + 2000,
        { srcAt, builtAt });

    // and one written before it is not
    fs.utimesSync(src, new Date(), new Date(builtAt - 60_000));
    check("...while a source file older than the package passes",
        !(fs.statSync(src).mtimeMs > builtAt + 2000), null);

    // the granularity slack must not swallow a real edit
    fs.utimesSync(src, new Date(), new Date(builtAt + 30_000));
    check("...and the slack is small enough that a real edit still trips it",
        fs.statSync(src).mtimeMs > builtAt + 2000, null);

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}

/* ---- the walk skips what must never count ---- */
check("the walk ignores node_modules and dotted directories, or a dependency's " +
      "timestamp would fail every build",
    /e\.name === "node_modules" \|\| e\.name\.startsWith\("\."\)/.test(rel));
check("...and it survives an unreadable directory instead of crashing the gate",
    /catch \{ return; \}/.test(rel));


/* ============ THE GATE PRODUCES THE DELIVERABLE, NOT ITS NEIGHBOUR ======= */
{
    // ONE INSTALLER. NOT TWO — a firm product requirement: a single Electron
    // installer, never a pair.
    //
    // dist used to hold a SECOND ~1.5 GB exe — electron-builder's NSIS output —
    // beside the real deliverable. Same size, same folder, same day. That pair
    // is exactly how the NSIS installer got renamed into the deliverable's
    // place and shipped, and a user ran a file that could not upgrade
    // anything.
    //
    // So the app builds to "dir" — the unpacked tree and nothing else — and the
    // single deliverable is dist/lcl-Installer-<v>.exe: devtools/installer as a
    // PORTABLE admin-manifested runtime with the app tree appended by pack.js
    // behind an LCLPAYLD footer.
    const rel = fs.readFileSync(path.join(R, "devtools", "release.js"), "utf8");

    const has = (s) => rel.includes(s);
    const appCfg0 = JSON.parse(fs.readFileSync(
        path.join(R, "app", "builder-config.json"), "utf8"));
    check("the gate BUILDS the installer wrapper itself — as a step somebody " +
          "had to remember to run, it stopped being run",
        has("3b.") && has("INSTALLER_SRC") && has("pack.js"));
    check("...building the admin-manifested runtime from devtools/installer, " +
          "not reusing the app's own electron-builder output",
        has("cwd: INSTALLER_SRC"));
    check("THE APP BUILDS TO 'dir' — the unpacked tree and NOTHING ELSE. An " +
          "installer target here emits a second exe beside the deliverable, " +
          "which is the pair that got them confused for each other",
        appCfg0.win.target.every(t => t.target === "dir"),
        appCfg0.win.target);
    check("...so there is no second installer config left to emit one",
        appCfg0.nsis === undefined && appCfg0.win.artifactName === undefined,
        { nsis: appCfg0.nsis, artifactName: appCfg0.win.artifactName });
    check("the runtime and the deliverable are still separate paths in the " +
          "gate — one function called 'the installer' is how they came to be " +
          "confused in the first place",
        has("function installerPath(") && has("function runtimePath(")
        && !has("function nsisPath("));
    check("THE DELIVERABLE IS VERIFIED TO CARRY ITS PAYLOAD. A wrapper without " +
          "one is a 69 MB program that starts, finds nothing to install and " +
          "stops — indistinguishable by name, size or date from the real thing",
        has("carries NO app payload") && has(".locate(setup)"));
    check("...and the offset is printed, so a human reading the gate can see " +
          "the payload is really there",
        has("MB appended at"));
    check("the ONE deliverable is named and explained where the confusion " +
          "happened, not only in somebody's memory",
        has("lcl-Installer-<v>.exe") && has("ONE INSTALLER. NOT TWO."));
    check("...and dist/win-unpacked is called out as an INPUT, so nobody " +
          "mistakes the app tree for something to hand over",
        has("is an INPUT to that"));

    const cfg = JSON.parse(fs.readFileSync(
        path.join(R, "devtools", "installer", "builder-config.json"), "utf8"));
    check("the installer runtime is PORTABLE and admin-manifested — the admin " +
          "manifest is what lets it write into Program Files",
        cfg.win.target[0].target === "portable"
        && cfg.portable.requestExecutionLevel === "admin",
        { target: cfg.win.target[0].target, level: cfg.portable.requestExecutionLevel });
    check("...and dist therefore holds ONE installer, which is the stated " +
          "requirement",
        appCfg0.win.target.length === 1, appCfg0.win.target);
}

console.log(`\n${pass}/${pass + fail} build-freshness checks passed`);
process.exit(fail ? 1 : 0);
