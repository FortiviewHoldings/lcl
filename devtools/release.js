#!/usr/bin/env node
/**
 * Patch -> verified build, in one command.
 *
 * The standing rule on this project is that every patch gets rebuilt and
 * reinstalled, because the installed app is what actually gets used — a fix
 * left in the repo does nothing. Two early failures shaped this:
 *
 *   - A "//" comment key in builder-config.json aborted a build three minutes
 *     in, on a schema error a one-second check would have caught.
 *   - OCR was dead in every packaged build while every dev test passed, because
 *     the worker's dependencies were not unpacked. Only a real build shows that.
 *
 * So: run the suite, DRIVE THE REAL UI, build, then INSPECT THE ARTEFACT.
 * electron-builder can exit 0 having produced something unusable, and a
 * grep-based renderer "test" can pass 25/25 on a dropdown that throws on its
 * first row — so the gate now boots the actual renderer in a real window and
 * MEASURES what paints. "it built" is not the claim that matters — "the new
 * code is really in there, and the UI it draws is the one we checked" is.
 *
 *   node devtools/release.js               test + UI, build, verify
 *   node devtools/release.js --skip-tests  build and verify only
 *   node devtools/release.js --skip-ui     skip only the UI harness (headless)
 */
const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "app");
const DIST = path.join(ROOT, "dist");

/**
 * ONE INSTALLER. NOT TWO.
 *
 * The requirement is a single installer, not two: one Electron installer beside
 * the deliverable, never a second exe alongside it.
 *
 * So app/builder-config.json targets "dir": electron-builder produces the
 * unpacked app tree and NOTHING else. It used to target "nsis", which emitted a
 * second ~1.5 GB installer that looked exactly like the real one, sat in the
 * same folder, and was the wrong thing to run. The pair is what let the NSIS
 * output get renamed into the deliverable's place and shipped.
 *
 * The one deliverable:
 *
 *   dist/lcl-Installer-<v>.exe   devtools/installer built as a PORTABLE exe
 *                                with requestExecutionLevel:admin (that is the
 *                                manifest that lets it write to Program Files),
 *                                with the whole app tree appended by pack.js as
 *                                a gzip payload behind an LCLPAYLD footer. It
 *                                upgrades the install under Program Files in
 *                                place.
 *
 * dist/win-unpacked is an INPUT to that, not something anybody runs.
 */
const INSTALLER_SRC = path.join(__dirname, "installer");
const RUNTIME_OUT = path.join(__dirname, "dist-runtime33");
const version = () =>
    JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")).version;

/** the portable admin-manifested runtime that pack.js appends the app to */
function runtimePath() {
    const cfg = JSON.parse(fs.readFileSync(
        path.join(INSTALLER_SRC, "builder-config.json"), "utf8"));
    const pattern = (cfg.portable && cfg.portable.artifactName)
        || (cfg.win && cfg.win.artifactName) || "lcl-Setup-${version}.${ext}";
    return path.join(RUNTIME_OUT, pattern.replace(/\$\{version\}/g, version())
                                         .replace(/\$\{ext\}/g, "exe"));
}
/** THE DELIVERABLE. */
function installerPath() {
    return path.join(DIST, `lcl-Installer-${version()}.exe`);
}

/**
 * THE OFFICIAL BASE — the shared patch number, sourced from the REPO so two
 * machines building never disagree about what "#7" means. A
 * checkout always carries devtools/RELEASE.json, so a build never has to guess;
 * the gatekeeper bumps it at a cut. null = a checkout with no RELEASE.json (a
 * dev build with no official identity), which the running app tolerates via the
 * buildId fallback.
 */
function officialBase() {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(ROOT, "devtools", "RELEASE.json"), "utf8"));
        if (Number.isInteger(j.official) && j.official > 0) return j.official;
    } catch { /* no file / malformed → no official number */ }
    return null;
}

/**
 * THE LOCAL MARKER — per-machine, never shared, never impersonates the base.
 * It counts a machine's own builds layered ON TOP OF the
 * current official base, and RESETS to start over the moment the base changes (a
 * new cut here, or a pulled release), so "+2 local" always means two above THIS
 * base. Stored gitignored so it stays machine-local; skipped numbers are fine.
 */
function nextLocalMarker(base) {
    const f = path.join(ROOT, "devtools", "build-seq.json");
    let stored = { base: null, local: 0 };
    try { const j = JSON.parse(fs.readFileSync(f, "utf8"));
          if (j && Number.isInteger(j.local)) stored = j; } catch { /* seed */ }
    const local = (stored.base === base ? stored.local : 0) + 1;
    try { fs.writeFileSync(f, JSON.stringify({ base, local }, null, 2) + "\n"); }
    catch { /* non-fatal */ }
    return local;
}
function resetLocalMarker(base) {
    try { fs.writeFileSync(path.join(ROOT, "devtools", "build-seq.json"),
        JSON.stringify({ base, local: 0 }, null, 2) + "\n"); } catch { /* non-fatal */ }
}

/**
 * A build FINGERPRINT the running app compares to decide it is behind — now TWO
 * LANES. `official` is the shared base; `local` is this
 * machine's divergence on top of it; `base` records the official build this copy
 * sits on, so a later three-way merge has a BASE to diff THEIRS/SOURCE against.
 * `buildId` (gitHash + time) stays as the exact, unique id the decision falls
 * back to for an install built before the lanes existed. `--release` = a
 * gatekeeper cut: this build IS the base (local 0). A plain build is a local one:
 * same base, local marker++. Written into the packed resources (→ the installed
 * app's identity) AND beside the installer as dist/build-info.json.
 */
function buildFingerprint() {
    let gitHash = "nogit";
    try { gitHash = execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim() || "nogit"; }
    catch { /* not a git checkout */ }
    // THE BUILD KNOWS ITS OWN REPO. Stamped from the checkout's origin at
    // build time, so the INSTALLED app can answer "which repository am I
    // from" by reading its own baked identity — never a hand-set setting.
    let repo = null;
    try {
        const url = execSync("git remote get-url origin",
            { cwd: ROOT, encoding: "utf8" }).trim();
        const m = url.match(/github\.com[:/]([^/]+)\/([^/.\s]+)/);
        if (m) repo = { owner: m[1], repo: m[2] };
    } catch { /* a checkout with no remote builds fine; identity stays null */ }
    const now = new Date();
    const official = officialBase();
    const isRelease = process.argv.includes("--release");
    // an official CUT sits AT the base (local 0) and rebases this machine's local
    // counter onto it; a plain build sits ABOVE the base (local marker++)
    const local = isRelease ? (resetLocalMarker(official), 0) : nextLocalMarker(official);
    return {
        buildId: `${gitHash}-${now.getTime()}`,
        gitHash,
        builtAt: now.toISOString(),
        version: version(),
        official,                              // the shared, repo-sourced base (null in dev)
        base: { official, commit: gitHash },   // the official build THIS copy sits on
        local,                                 // per-machine divergence above the base
        repo,                                  // the origin this build came from
        channel: isRelease ? "release" : "dev"
    };
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
function die(msg) { console.error(red("\n  " + msg)); process.exit(1); }

/* ---------------------------------------------------------------- 1. tests */
if (!process.argv.includes("--skip-tests")) {
    console.log(bold("\n1. Test suite"));
    const SUITE_TIMEOUT_MS = 600_000;   // ten minutes; the slowest real suite is OCR at ~2
    const files = fs.readdirSync(path.join(ROOT, "tests"))
        .filter(f => f.endsWith(".js")).sort();
    let total = 0;
    const failed = new Map();       // name -> the output that condemned it
    for (const f of files) {
        let out = "";
        try {
            // BOUNDED. A suite that hangs used to stall the release gate with
            // no message at all — measured: tests/ocr.js wedged on a page the
            // OCR engine never answered for, and the build simply stopped,
            // forever, printing nothing. A gate that can hang is not a gate.
            out = execFileSync(process.execPath, [path.join(ROOT, "tests", f)],
                { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
                  timeout: SUITE_TIMEOUT_MS, killSignal: "SIGKILL" });
        } catch (e) {
            out = String((e.stdout || "") + (e.stderr || ""));
            if (e.killed || e.signal) {
                out += `\nFAIL | this suite did not finish within ` +
                       `${Math.round(SUITE_TIMEOUT_MS / 1000)}s and was killed. ` +
                       `A suite that never returns is a failure, not a pass.\n`;
            }
            failed.set(f, out);
        }
        const last = out.trim().split("\n").pop() || "";
        const m = last.match(/^(\d+)\/(\d+)/);
        if (m) {
            total += Number(m[1]);
            if (m[1] !== m[2]) failed.set(f, out);
        }
        console.log(`   ${failed.has(f) ? red("FAIL") : "ok  "}  ${last.slice(0, 60)}`);
    }
    if (failed.size) {
        // SHOW THE FAILURE, not its name. "2 failing suite(s): secret-guard.js,
        // secret-guard.js" is a dead end: it does not say which check broke, it
        // counted one suite twice, and the suite passes when run by hand — so
        // the only way to learn anything was to go reproduce it. A gate that
        // blocks a release owes the reason on the spot.
        for (const [name, out] of failed) {
            console.error(red(`\n  ---- ${name} ----`));
            const lines = out.trim().split(/\r?\n/);
            const bad = lines.filter(l => /^FAIL|Error|error:|throw|at Object|Cannot|not defined/.test(l));
            for (const l of (bad.length ? bad : lines).slice(0, 20)) console.error("  " + l);
        }
        die(`${failed.size} failing suite(s): ${[...failed.keys()].join(", ")} — not building.`);
    }
    console.log(green(`   ${total} checks passed`));
} else {
    console.log(dim("\n1. Test suite skipped (--skip-tests)"));
}

/* ------------------------------------------- 1b. real UI, actually measured */
// THE SUITES ABOVE NEVER PAINT A PIXEL. This drives the actual renderer in a
// real Electron window with a stubbed bridge and MEASURES what paints — the
// check that catches a dropdown throwing on its first row while every
// grep-based "renderer test" passed 25/25, and the reason a fix "left in the
// repo" was never really verified. It exits non-zero on any failed check, and
// a build that cannot prove its own UI must not ship. (--skip-ui for the rare
// headless run where no window can open.)
if (!process.argv.includes("--skip-tests") && !process.argv.includes("--skip-ui")) {
    console.log(bold("\n1b. UI harness (the real renderer)"));
    // required from a plain node process, electron's main export IS the path to
    // its executable — the same binary devtools/ui-harness is launched with
    const electronBin = require("electron");
    let out = "";
    try {
        // BOUNDED, like the suites: a scene that never resolves used to leave
        // Electron alive with no output. The harness has its own 120s watchdog;
        // this is the outer backstop in case even that wedges.
        out = execFileSync(electronBin, [path.join(ROOT, "devtools", "ui-harness")],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
              timeout: 180_000, killSignal: "SIGKILL" });
    } catch (e) {
        out = String((e.stdout || "") + (e.stderr || ""));
        // SHOW THE FAILING CHECKS, on the spot — the same courtesy the suite
        // step pays. A UI gate that only says "it failed" sends you to go run
        // the harness by hand, which is the friction that got it skipped.
        // A CHECK NAME CAN BE MULTI-LINE, and the measurement is printed at the
        // END of it — so filtering for lines that START with FAIL threw away
        // the numbers and left "it failed" with nothing to act on. Measured:
        // a workspace check failed under the gate, and the values that would
        // have said WHY were in the output and dropped on the way to the
        // screen. Everything up to the next verdict belongs to the failure.
        const lines = out.split(/\r?\n/);
        const fails = [];
        for (let i = 0; i < lines.length; i++) {
            if (!/^FAIL/.test(lines[i])) continue;
            let block = lines[i];
            for (let j = i + 1; j < lines.length && !/^(PASS|FAIL|\s*\|)/.test(lines[j]); j++) {
                if (lines[j].trim()) block += "\n    " + lines[j].trim();
            }
            fails.push(block);
        }
        for (const l of fails.slice(0, 25)) console.error(red("  " + l));
        if (e.killed || e.signal) {
            console.error(red("  the harness was killed on a timeout — a scene never resolved"));
        }
        die(`${fails.length || "some"} UI check(s) failed — not building. ` +
            `The screenshots in devtools/ui-harness/out show the state that failed.`);
    }
    const line = (out.split(/\r?\n/).find(l => /UI checks passed/.test(l)) || "").trim();
    console.log(green("   " + (line || "UI harness passed")));
} else if (process.argv.includes("--skip-ui")) {
    console.log(dim("\n1b. UI harness skipped (--skip-ui)"));
}

/* -------------------------------------------------- 2. config sanity (fast) */
console.log(bold("\n2. Build config"));
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path.join(APP, "builder-config.json"), "utf8")); }
catch (e) { die("builder-config.json is not valid JSON: " + e.message); }
const commentKeys = Object.keys(cfg).filter(k => k.startsWith("//"));
if (commentKeys.length) {
    die(`electron-builder rejects unknown keys — remove: ${commentKeys.join(", ")}`);
}
console.log("   config parses, no comment keys");

/* --------------------------------------------------------------- 3. build */
// --verify-only: inspect whatever is in dist WITHOUT rebuilding. Exists
// because a hung electron-builder had to be killed after the artefact was
// already worth checking, and the only way to run step 4 was to pay for a
// whole second build first.
const VERIFY_ONLY = process.argv.includes("--verify-only");
console.log(bold("\n3. Building"));
const before = (() => {
    try { return fs.statSync(installerPath()).mtimeMs; }
    catch { return 0; }
})();
if (VERIFY_ONLY) {
    console.log(dim("   skipped (--verify-only) — inspecting the artefact already in dist"));
} else {
    try {
        // inherit stdio: a buffered pipe means a hung build shows NOTHING —
        // 47 minutes of silence before anyone could see which stage stalled
        execSync("npx electron-builder --win --config builder-config.json",
            { cwd: APP, stdio: ["ignore", "inherit", "inherit"] });
    } catch (e) {
        die("build failed — the electron-builder output above has the stage that broke");
    }

    // ---------------------------------------- 3b. THE DELIVERABLE ITSELF
    //
    // The step above produces dist/win-unpacked and an NSIS installer. Neither
    // is what the user runs. This builds the admin-manifested portable
    // runtime and appends the app tree to it — and it lives IN THE GATE
    // because when it was a separate command somebody remembered to run, it
    // stopped being run, and the NSIS output got renamed into its place.
    console.log(bold("\n3b. Packing the installer (admin wrapper + app payload)"));
    // THE RUNTIME IS AN INPUT, NOT AN OUTPUT — REBUILD IT ONLY WHEN IT CHANGED.
    //
    // The wrapper's own sources (devtools/installer/*.js, its ui.html and its
    // config) change perhaps once a month; the app changes every gate run.
    // Rebuilding an unchanged 69 MB runtime every time cost a minute and, more
    // to the point, electron-builder EMPTIES its output directory first — which
    // fails outright while anything holds a handle on the runtime's own
    // app.asar. A packed asar stays locked in this environment until the
    // process that read it exits, so the gate was one stray handle away from
    // never producing a deliverable again.
    //
    // Freshness is the same question step 4 asks about the app: is the artefact
    // older than the code that made it?
    const rtStale = (() => {
        let built = 0;
        try { built = fs.statSync(runtimePath()).mtimeMs; } catch { return true; }
        let newest = 0;
        for (const f of fs.readdirSync(INSTALLER_SRC)) {
            if (f === "node_modules" || f.startsWith(".")) continue;
            const p = path.join(INSTALLER_SRC, f);
            try {
                const st = fs.statSync(p);
                if (st.isFile()) newest = Math.max(newest, st.mtimeMs);
            } catch { /* unreadable entries cannot make it stale */ }
        }
        return newest > built + 2000;
    })();
    if (rtStale) {
        try {
            execSync("npx electron-builder --win --config builder-config.json",
                { cwd: INSTALLER_SRC, stdio: ["ignore", "inherit", "inherit"] });
        } catch (e) {
            die("the installer runtime failed to build. If this is a file lock " +
                "on its app.asar, something still holds a handle on the previous " +
                "runtime — see the output above.");
        }
    } else {
        console.log(dim(`   runtime    reused (unchanged since ` +
            `${new Date(fs.statSync(runtimePath()).mtimeMs).toLocaleString()})`));
    }
    if (!fs.existsSync(runtimePath())) {
        die(`the installer runtime was not produced: expected ${runtimePath()}`);
    }
    // STAMP THE BUILD before packing, so the fingerprint travels INSIDE the
    // installer and becomes the installed app's identity; the matching sidecar
    // beside the installer is what a running (older) app compares against.
    const fp = buildFingerprint();
    const resDir = path.join(DIST, "win-unpacked", "resources");
    try {
        fs.writeFileSync(path.join(resDir, "build-info.json"), JSON.stringify(fp, null, 2));
        // SHIP THE RELEASE PUBLIC KEY inside the installer, so the installed app
        // can verify FUTURE patches it fetches. Absent on a machine that never
        // ran gen-release-key.js — a dev build; the network channel then fails
        // closed, which is the correct default.
        const pub = path.join(ROOT, "release-pubkey.pem");
        if (fs.existsSync(pub)) fs.copyFileSync(pub, path.join(resDir, "release-pubkey.pem"));
    } catch (e) { die("could not stamp the build fingerprint: " + e.message); }
    try {
        execFileSync(process.execPath,
            [path.join(INSTALLER_SRC, "pack.js"), runtimePath(),
             path.join(DIST, "win-unpacked"), installerPath()],
            { stdio: ["ignore", "inherit", "inherit"] });
    } catch (e) {
        die("packing the installer failed — see the output above. If it is a " +
            "file lock, the previous installer is still RUNNING; close it.");
    }
    // ONE INSTALLER IN DIST, and it is the current one. Old lcl-Installer-*.exe
    // accumulated beside each new build, and the operator — pointed at "the
    // 1.0.1 installer" — double-clicked the STALE 1.0.1 in dist and reinstalled
    // the old build. A rolling installer means the newest replaces the rest.
    try {
        const keep = path.basename(installerPath()).toLowerCase();
        for (const f of fs.readdirSync(DIST)) {
            if (/^lcl-Installer-.*\.exe$/i.test(f) && f.toLowerCase() !== keep) {
                try { fs.unlinkSync(path.join(DIST, f));
                      console.log(dim(`   pruned     stale ${f}`)); }
                catch { /* locked — an old installer still running; leave it */ }
            }
        }
    } catch { /* dist unreadable — the verify step below will say so loudly */ }
    // THE "WHAT IS AVAILABLE" MARKER the running app reads to offer a patch. Now
    // it also carries the installer's SHA-256 (integrity) and, on a --release
    // cut, a detached Ed25519 signature over these exact bytes (authenticity).
    try {
        const trust = require(path.join(ROOT, ".lcl.engine", "core", "releaseTrust"));
        const sidecar = { ...fp, installerSha256: trust.sha256FileSync(installerPath()) };
        const bytes = JSON.stringify(sidecar, null, 2);
        fs.writeFileSync(path.join(DIST, "build-info.json"), bytes);
        // sign ONLY a real release cut, and only if the private key is present;
        // the signature is over the EXACT sidecar bytes just written
        const sigPath = path.join(DIST, "build-info.json.sig");
        try { fs.unlinkSync(sigPath); } catch { /* none to clear */ }
        if (fp.channel === "release") {
            const keyPath = process.env.LCL_RELEASE_KEY
                || path.join(require("os").homedir(), ".lcl-release-signing", "release.key");
            if (fs.existsSync(keyPath)) {
                const sig = trust.signManifest(bytes, fs.readFileSync(keyPath, "utf8"));
                fs.writeFileSync(sigPath, sig);
                console.log(dim(`   signed     release manifest (Ed25519)`));
            } else {
                console.log(red(`   UNSIGNED   no release key at ${keyPath} — run ` +
                    `devtools/gen-release-key.js before a public cut`));
            }
        }
        console.log(dim(`   stamped    ${fp.channel === "release"
            ? `Official #${fp.official}` : `${fp.official != null ? `official #${fp.official} · ` : ""}+${fp.local} local (dev)`} (${fp.buildId})`));
    } catch (e) { console.log(red("   stamp/sign step failed: " + (e && e.message))); }
}

/* ------------------------------------------------- 4. inspect the artefact */
console.log(bold("\n4. Verifying the artefact"));
const setup = installerPath();
if (!fs.existsSync(setup)) {
    die(`the DELIVERABLE was not produced — expected ${path.basename(setup)} ` +
        `(the admin wrapper with the app payload appended, not the NSIS ` +
        `installer beside it). dist holds: ` +
        `${(() => { try { return fs.readdirSync(DIST).join(", ") || "(empty)"; }
                    catch { return "(no dist)"; } })()}`);
}
// IT MUST CARRY THE PAYLOAD. A wrapper without one is a 69 MB program that
// starts, finds nothing to install and stops — and it is indistinguishable
// from the real thing by name, date or a glance at the folder. This is the
// check that would have caught the NSIS output wearing the wrapper's name.
{
    const at = (() => {
        try { return require(path.join(INSTALLER_SRC, "payload")).locate(setup); }
        catch { return null; }
    })();
    if (!at || !(at.length > 0)) {
        die(`${path.basename(setup)} carries NO app payload — its LCLPAYLD ` +
            `footer is missing. That is the NSIS installer or a bare runtime ` +
            `under the deliverable's name, and it cannot upgrade an install.`);
    }
    console.log(`   payload    ${(at.length / 1e6).toFixed(0)} MB appended at ${at.start}`);
}
const st = fs.statSync(setup);
if (!VERIFY_ONLY && st.mtimeMs <= before) die("the installer was not rewritten — the build did not produce a new one");
console.log(`   installer  ${(st.size / 1e6).toFixed(0)} MB  ${new Date(st.mtimeMs).toLocaleTimeString()}`);

// the packaged app must actually contain the current source
const asar = path.join(DIST, "win-unpacked", "resources", "app.asar");
if (!fs.existsSync(asar)) die("app.asar missing from the packaged output");
const fd = fs.openSync(asar, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const hdrLen = head.readUInt32LE(12);
const hdr = Buffer.alloc(hdrLen);
fs.readSync(fd, hdr, 0, hdrLen, 16);
fs.closeSync(fd);
const tree = JSON.parse(hdr.toString("utf8").replace(/\0+$/, ""));
const packed = [];
(function walk(node, pre) {
    for (const [k, v] of Object.entries(node.files || {})) {
        if (v.files) walk(v, pre + k + "/"); else packed.push(pre + k);
    }
})(tree, "");

// every core module in the repo must be in the package — this is what catches
// "built fine, shipped last week's code"
const coreDir = path.join(APP, "..", ".lcl.engine", "core");
const expected = fs.readdirSync(coreDir).filter(f => f.endsWith(".js"));
const shippedCore = path.join(DIST, "win-unpacked", "resources", ".lcl.engine", "core");
const missing = expected.filter(f => !fs.existsSync(path.join(shippedCore, f)));
if (missing.length) die(`packaged app is missing core modules: ${missing.join(", ")}`);
// ...and EVERY engine file of every kind, not just core/*.js. The extraResources
// filter ships by extension, and an extension missing from that list is a file
// silently dropped: pdfraster.html was excluded that way, so the installed app's
// scanned-PDF OCR died with ERR_FILE_NOT_FOUND on a window the dev tree loads
// fine — a live failure the module-count check above sailed straight past.
{
    const engRoot = path.join(APP, "..", ".lcl.engine");
    const shipRoot = path.join(DIST, "win-unpacked", "resources", ".lcl.engine");
    const lost = [];
    const walkEng = (rel) => {
        for (const e of fs.readdirSync(path.join(engRoot, rel), { withFileTypes: true })) {
            const r = rel ? rel + "/" + e.name : e.name;
            if (e.isDirectory()) { if (e.name !== "node_modules") walkEng(r); continue; }
            if (!fs.existsSync(path.join(shipRoot, r))) lost.push(r);
        }
    };
    walkEng("");
    if (lost.length) die(`packaged engine dropped ${lost.length} file(s): ` +
        `${lost.slice(0, 8).join(", ")} — if a file is NOT engine code (a scratch ` +
        `note, a local artifact), REMOVE it from .lcl.engine rather than widening ` +
        `the filter; only genuinely shipped engine code earns a path in ` +
        `app/builder-config.json's extraResources filter. The filter is scoped on ` +
        `purpose: a stray personal file must fail this build loudly, never ride ` +
        `into a public installer silently.`);
}

// IS THE BUILD OLDER THAN THE CODE?
//
// The check above asks whether every module in the repo reached the package —
// which a file created AFTER the build passes trivially, because it is in
// neither. Measured once: an installer packed cleanly, self-checked,
// passed asar-check 10/10 and was still missing a whole feature, because the
// module and the renderer changes were written after electron-builder ran.
// Every check was asking whether the build was internally consistent, and none
// was asking whether it contained the work.
//
// So: the newest source file must be OLDER than the packaged artefact.
{
    const newest = (dir, exts) => {
        let t = 0, who = null;
        const walk = (d) => {
            let entries = [];
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (e.name === "node_modules" || e.name.startsWith(".")) continue;
                const p = path.join(d, e.name);
                if (e.isDirectory()) { walk(p); continue; }
                if (!exts.some(x => e.name.endsWith(x))) continue;
                let st; try { st = fs.statSync(p); } catch { continue; }
                if (st.mtimeMs > t) { t = st.mtimeMs; who = p; }
            }
        };
        walk(dir);
        return { t, who };
    };
    const src = [
        newest(path.join(ROOT, "app"), [".js", ".html", ".css", ".json"]),
        newest(path.join(ROOT, ".lcl.engine"), [".js", ".ps1"])
    ].sort((a, b) => b.t - a.t)[0];
    const built = fs.statSync(asar).mtimeMs;
    // a couple of seconds of slack for filesystem timestamp granularity
    if (src.t > built + 2000) {
        die(`the package is OLDER than the source: ${path.relative(ROOT, src.who)} ` +
            `was written ${Math.round((src.t - built) / 1000)}s after app.asar was built.\n` +
            `   Everything else here would pass — a file written after the build is ` +
            `missing from the package AND from the missing-modules check.\n` +
            `   Build again.`);
    }
    console.log(`   freshness  newest source predates the package`);
}
// THE SANDBOX LAUNCHER IS NOT A .js FILE, so the engine filter that ships
// "**/*.js" would have left it behind — and the boundary would degrade to "no
// boundary" on every installed copy while working perfectly in dev. Named
// explicitly, because a filter that silently drops one file is exactly how
// that happens.
const lowbox = path.join(shippedCore, "lowbox.ps1");
if (!fs.existsSync(lowbox)) {
    die("the sandbox launcher (lowbox.ps1) is missing from the package — " +
        "scripts would run with no boundary on an installed copy");
}
console.log(`   sandbox   lowbox.ps1 shipped (the boundary works in an installed copy)`);
console.log(`   app.asar   ${packed.length} files; engine ${expected.length} core modules shipped`);

// anything unpacked must be on disk, or a worker dies only after install
const unpackedDir = path.join(DIST, "win-unpacked", "resources", "app.asar.unpacked", "node_modules");
const needUnpacked = (cfg.asarUnpack || [])
    .map(g => (g.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//) || [])[1]).filter(Boolean);
const notThere = needUnpacked.filter(m => !fs.existsSync(path.join(unpackedDir, m)));
if (notThere.length) die(`asarUnpack modules missing from the build: ${notThere.join(", ")}`);
console.log(`   unpacked   ${needUnpacked.length} modules present`);

// engine assets the app checks for at runtime
const tessData = path.join(DIST, "win-unpacked", "resources", "tools",
    "tesseract", "eng.traineddata");
console.log(`   OCR data   ${fs.existsSync(tessData) ? "shipped" : red("MISSING — OCR will be unavailable")}`);

// speech-to-text: the exe and the model are useless apart, so check both
const whisperExe = path.join(DIST, "win-unpacked", "resources", "tools", "whisper", "win-x64", "whisper-cli.exe");
const whisperModel = path.join(DIST, "win-unpacked", "resources", "tools", "whisper", "ggml-base.en-q5_1.bin");
console.log(`   speech     ${fs.existsSync(whisperExe) && fs.existsSync(whisperModel) ? "whisper + model shipped" : red("MISSING — transcription will be unavailable")}`);

// The four bundled instruments. Each is useless if its exe did not ship, and
// a packaging glob that quietly stops matching is exactly the failure this
// verifier exists to catch — it already happened once with a dot-prefixed
// engine binary that every other check passed straight over.
const instruments = [
    ["qpdf", "qpdf/win-x64/qpdf.exe"],
    ["imagemagick", "imagemagick/win-x64/magick.exe"],
    ["sqlite", "sqlite/win-x64/sqlite3.exe"],
    ["graphviz", "graphviz/win-x64/dot.exe"]
];
const missingTools = instruments.filter(([, p]) =>
    !fs.existsSync(path.join(DIST, "win-unpacked", "resources", "tools", ...p.split("/"))));
if (missingTools.length) {
    die("bundled tools missing from the package: " + missingTools.map(t => t[0]).join(", "));
}
console.log("   tools      " + instruments.map(t => t[0]).join(", ") + " shipped");

// The engine BINARY itself, resolved the same way the app resolves it: from
// the packaged manifest's matching build. This check exists because the first
// .lcl.engine build shipped without its exe — electron-builder's "**/*.exe"
// glob does not match dot-prefixed files, everything else packaged fine, and
// the old verifier passed a build whose engine could never start.
const rtDir = path.join(DIST, "win-unpacked", "resources", "runtimes", "llama.cpp");
const manifest = JSON.parse(fs.readFileSync(path.join(rtDir, "engine.json"), "utf8").replace(/^﻿/, ""));
const winBuild = (manifest.builds || []).find(b => b.platform === "win32");
if (!winBuild) die("packaged engine.json has no win32 build entry");
const engineExe = path.join(rtDir, winBuild.dir, winBuild.binary);
if (!fs.existsSync(engineExe)) {
    die(`the ENGINE BINARY is missing from the package: ${engineExe}\n` +
        "   (dot-prefixed names need an explicit extraResources filter entry)");
}
console.log(`   engine     ${winBuild.binary} shipped`);

console.log(green(bold("\n   Ready to install:")) + " " + setup + "\n");
