/**
 * PACKAGING contract — the class of bug that passes every test in dev and then
 * fails 100% of the time in the installed app.
 *
 * The OCR worker runs in a worker_thread loaded from a REAL path under
 * app.asar.unpacked, so Node resolves its bare requires against that unpacked
 * tree rather than through Electron's asar shim. tesseract.js has no nested
 * node_modules, so its dependencies resolve to HOISTED copies — which means
 * every one of them must be unpacked too, or the worker dies with
 * MODULE_NOT_FOUND. tesseract.js never listens for a worker 'error' event, so
 * the failure is a hang, not a clean error.
 *
 * This test derives the requirement from the SOURCE (it greps the worker tree
 * for bare requires) instead of hardcoding a list, so a tesseract.js upgrade
 * that adds a dependency fails here rather than in a user's installer.
 */
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "app");
const NM = path.join(APP, "node_modules");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

const cfg = JSON.parse(fs.readFileSync(path.join(APP, "builder-config.json"), "utf8"));
const unpack = cfg.asarUnpack || [];
const files = cfg.files || [];

// electron-builder validates its config against a STRICT schema and refuses to
// run on any unknown top-level key — including "//" comment keys, which are
// fine in our own JSON but fatal here. A parse check is not enough: the config
// can be valid JSON and still abort the build three minutes in. This turns
// that into an instant failure. (List from electron-builder 24's own error.)
const VALID_TOP_LEVEL = new Set(["afterAllArtifactBuild", "afterPack", "afterSign", "apk",
    "appId", "appImage", "appx", "appxManifestCreated", "artifactBuildCompleted",
    "artifactBuildStarted", "artifactName", "asar", "asarUnpack", "beforeBuild", "beforePack",
    "buildDependenciesFromSource", "buildNumber", "buildVersion", "compression", "copyright",
    "cscKeyPassword", "cscLink", "deb", "defaultArch", "detectUpdateChannel", "directories",
    "dmg", "downloadAlternateFFmpeg", "electronBranding", "electronCompile", "electronDist",
    "electronDownload", "electronLanguages", "electronUpdaterCompatibility", "electronVersion",
    "executableName", "extends", "extraFiles", "extraMetadata", "extraResources",
    "fileAssociations", "flatpak", "files", "forceCodeSigning", "framework", "freebsd",
    "generateUpdatesFilesForAllChannels", "icon", "includePdb", "includeSubNodeModules",
    "launchUiVersion", "linux", "mac", "mas", "masDev", "msi", "msiProjectCreated",
    "msiWrapped", "nodeGypRebuild", "nodeVersion", "npmArgs", "npmRebuild", "nsis", "nsisWeb",
    "onNodeModuleFile", "p5p", "pacman", "pkg", "portable", "productName", "protocols",
    "publish", "releaseInfo", "removePackageKeywords", "removePackageScripts", "rpm", "snap",
    "squirrelWindows", "target", "win", "$schema"]);
const badKeys = Object.keys(cfg).filter(k => !VALID_TOP_LEVEL.has(k));
check("builder-config has no keys electron-builder will reject",
    badKeys.length === 0, { rejected: badKeys });
check("builder-config carries no '//' comment keys (the schema forbids them)",
    !Object.keys(cfg).some(k => k.startsWith("//")),
    Object.keys(cfg).filter(k => k.startsWith("//")));

/** Is this package covered by an asarUnpack glob? */
function unpacked(pkg) {
    return unpack.some(g => g === `node_modules/${pkg}/**/*` || g === `node_modules/${pkg}/**`);
}
function listed(pkg) {
    return files.some(g => typeof g === "string" && g.includes(`node_modules/${pkg}`));
}

/** Bare (non-relative, non-builtin) requires in a directory tree. */
const BUILTIN = new Set(["fs", "path", "util", "zlib", "worker_threads", "crypto",
    "os", "http", "https", "stream", "events", "buffer", "child_process", "url"]);
function bareRequires(dir) {
    const out = new Set();
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) { stack.push(full); continue; }
            if (!e.name.endsWith(".js")) continue;
            let src;
            try { src = fs.readFileSync(full, "utf8"); } catch { continue; }
            const re = /require\(\s*["']([^"'.][^"']*)["']\s*\)/g;
            let m;
            while ((m = re.exec(src))) {
                const pkg = m[1].startsWith("@")
                    ? m[1].split("/").slice(0, 2).join("/")
                    : m[1].split("/")[0];
                if (!BUILTIN.has(pkg)) out.add(pkg);
            }
        }
    }
    return out;
}

const tessRoot = path.join(NM, "tesseract.js");
if (!fs.existsSync(tessRoot)) {
    console.log("SKIP: tesseract.js is not installed — run npm install in app/");
    console.log("\n0/0 packaging checks passed");
    process.exit(0);
}

// The worker script actually spawned by ocrTools.
const workerScript = path.join(tessRoot, "src", "worker-script", "node", "index.js");
check("the worker script ocrTools spawns exists in the package",
    fs.existsSync(workerScript), workerScript);

// tesseract.js must not be assumed self-contained
check("tesseract.js has no nested node_modules (so deps are hoisted)",
    !fs.existsSync(path.join(tessRoot, "node_modules")));

// Derive the closure from source, then assert coverage.
const deps = [...bareRequires(path.join(tessRoot, "src"))].sort();
console.log("     worker tree requires:", deps.join(", ") || "(none)");

const notUnpacked = [];
for (const d of deps) {
    // only packages that really exist need unpacking (guarded/optional ones may not)
    if (!fs.existsSync(path.join(NM, d))) continue;
    if (!unpacked(d)) notUnpacked.push(d);
}
check("every real dependency of the OCR worker tree is in asarUnpack",
    notUnpacked.length === 0, { missingFromAsarUnpack: notUnpacked });

// tesseract.js itself and its core must be unpacked (they are read as real files)
check("tesseract.js is in asarUnpack", unpacked("tesseract.js"));
check("tesseract.js-core is in asarUnpack", unpacked("tesseract.js-core"));

// node-fetch, when present, drags in whatwg-url's tree
if (fs.existsSync(path.join(NM, "node-fetch")) && unpacked("node-fetch")) {
    for (const t of ["whatwg-url", "tr46", "webidl-conversions"]) {
        if (fs.existsSync(path.join(NM, t))) {
            check(`node-fetch's transitive dep ${t} is unpacked too`, unpacked(t));
        }
    }
}

// Anything unpacked must also be SHIPPED — asarUnpack does not imply inclusion.
const notShipped = unpack
    .map(g => (g.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//) || [])[1])
    .filter(Boolean)
    .filter(p => fs.existsSync(path.join(NM, p)) && !listed(p));
check("every asarUnpack entry is also present in the files list",
    notShipped.length === 0, { unpackedButNotShipped: notShipped });

// The language data ships via extraResources and is what available() checks.
const extra = cfg.extraResources || [];
const toolsEntry = extra.find(e => e && e.to === "tools");
check("tools is copied as an extraResource", !!toolsEntry);
check("the extraResources filter includes *.traineddata",
    !!toolsEntry && (toolsEntry.filter || []).some(f => f.includes("traineddata")),
    toolsEntry && toolsEntry.filter);

// The engine binary is a DOT-PREFIXED file (.lcl.engine.exe), and
// electron-builder's "**/*.exe" glob does not match dotfiles — the first
// renamed build shipped every DLL but no engine exe, and started nothing.
// So the runtimes filter must name each manifest binary EXPLICITLY, derived
// from engine.json rather than hardcoded, so a future binary rename fails
// here instead of after install.
{
    const runtimesEntry = extra.find(e => e && e.to === "runtimes");
    check("runtimes is copied as an extraResource", !!runtimesEntry);
    const manifest = JSON.parse(fs.readFileSync(
        path.join(__dirname, "..", "runtimes", "llama.cpp", "engine.json"), "utf8")
        .replace(/^﻿/, ""));
    const filter = (runtimesEntry && runtimesEntry.filter) || [];
    for (const b of manifest.builds || []) {
        const dotName = b.binary.startsWith(".");
        if (!dotName) continue;   // plain names are covered by the *.exe globs
        check(`filter explicitly names the dot-prefixed binary "${b.binary}"`,
            filter.some(f => f === `**/${b.binary}`), filter);
    }
}

// The installer must close a RUNNING app in every install mode.
// electron-builder's stock CHECK_APP_RUNNING is wrapped in
// `${ifNot} ${UAC_IsInnerInstance}` for assisted installers — and with
// selectPerMachineByDefault, every normal install IS the elevated inner
// instance, so the stock check never ran and the app was left running with
// its binaries locked. The fix is a customCheckAppRunning macro (which the
// template prefers unconditionally); these checks pin it to the config that
// makes it necessary, so removing either side alone fails the build.
{
    const nsh = fs.readFileSync(path.join(APP, "build", "installer.nsh"), "utf8");
    if (cfg.nsis && cfg.nsis.selectPerMachineByDefault) {
        // customCheckAppRunning alone is NOT enough: the template's UAC guard
        // wraps its insertion, so it is skipped in the elevated inner instance
        // — the instance that does all the work of a machine-wide install.
        // customInit is inserted in .onInit, which every instance runs.
        check("per-machine default: the running-app close is wired into " +
              "customInit (the section-level check never runs when elevated)",
            /!macro\s+customInit[\s\S]*?LCL_CLOSE_RUNNING_APP[\s\S]*?!macroend/.test(nsh));
        check("the close body exists and closes gracefully before force-killing",
            /!macro\s+LCL_CLOSE_RUNNING_APP/.test(nsh) &&
            /taskkill\.exe" \/im "\$\{APP_EXECUTABLE_FILENAME\}"/.test(nsh) &&
            /taskkill\.exe" \/f \/im "\$\{APP_EXECUTABLE_FILENAME\}"/.test(nsh));
        check("a force kill also takes the engine child down (orphaned " +
              "llama-server.exe keeps resources\\runtimes locked)",
            /taskkill\.exe" \/f \/im "llama-server\.exe"/.test(nsh));

        // MEASURED, NOT ASSUMED. A probe compiled and run on the target
        // machine showed %SYSTEMROOT%\System32\cmd.exe returns "error" from
        // nsExec — NSIS does not expand the variable and CreateProcess will
        // not resolve the literal path, so every guarded close block was
        // skipped and the app was never closed. $SYSDIR is NSIS's own
        // resolved path and returns a real exit code.
        // the comments above the macro DESCRIBE the broken form on purpose,
        // so these read executable lines only
        const nshCode = nsh.split(/\r?\n/)
            .filter(l => !/^\s*;/.test(l)).join("\n");
        check("the close uses $SYSDIR, never %SYSTEMROOT% — nsExec cannot " +
              "launch the environment-variable form and returns \"error\"",
            !/%SYSTEMROOT%/.test(nshCode) && /\$SYSDIR\\taskkill\.exe/.test(nshCode));
        check("detection is taskkill's own exit code — no tasklist pipe, no " +
              "find.exe, nothing else to misquote",
            !/tasklist/.test(nshCode) && !/find\.exe/.test(nshCode));

        // ALSO MEASURED. Graceful taskkill returns 1, not 0, when any matched
        // process has no window — and .lcl is five processes, four of them
        // windowless helpers. Any ${if} around the kill is therefore a branch
        // that will not be taken on the real app, which is how three separate
        // versions of this macro shipped doing nothing at all.
        const killBlock = (nshCode.match(
            /!macro LCL_CLOSE_RUNNING_APP([\s\S]*?)!macroend/) || [])[1] || "";
        check("nothing gates the kill sequence on an exit code — graceful " +
              "taskkill returns 1 whenever a windowless helper is matched",
            killBlock.length > 0 && !/\$\{if\}|\$\{unless\}|\$\{ifNot\}/i.test(killBlock));
        check("the force kill is unconditional, so a refused graceful close " +
              "still ends with the app closed",
            /\/f \/im "\$\{APP_EXECUTABLE_FILENAME\}"/.test(killBlock));
        check("the running-app prompt uses relative jumps, not labels " +
              "(a label in a macro inserted twice is a duplicate-label error)",
            !/lclDoClose|lclClose_/.test(nsh));
        check("the close does not depend on $(appRunning) or ${isUpdated} " +
              "(.onInit runs before language strings and update flags exist)",
            !/\$\(appRunning\)/.test(nsh) && !/isUpdated/.test(nsh));
    }
    // THE GUARANTEE OUTLIVED THE INSTALLER THAT CARRIED IT.
    //
    // The checks above pin an NSIS installer that no longer ships: the app now
    // builds to "dir" and the ONE deliverable is the admin wrapper in
    // devtools/installer (the design calls for one installer, not two). They
    // are guarded on cfg.nsis and simply skip.
    //
    // What must NOT lapse is the reason they existed — "the installer must
    // close a RUNNING app in every install mode", learned the hard way when a
    // machine-wide install left the app up with its binaries locked and wrote a
    // half install over them. So the same guarantee is asserted here against
    // the installer that actually ships. A deleted test for a live requirement
    // is how a fixed bug comes back.
    {
        const inst = fs.readFileSync(
            path.join(APP, "..", "devtools", "installer", "install.js"), "utf8");
        check("THE SHIPPED INSTALLER CLOSES A RUNNING APP BEFORE OVERWRITING IT " +
              "— EBUSY partway through leaves a half-written install, which is " +
              "worse than not starting",
            /Stop-Process -Force/.test(inst) && /Get-Process -Name '\.lcl'/.test(inst));
        check("...and WAITS, because the process does not die the instant it " +
              "is asked to",
            /setTimeout\(r, \d{3,}\)/.test(inst));
        check("...and says so while it happens, rather than appearing to hang",
            /closing \.lcl if it is running/.test(inst));
        check("...and only for an install of OURS — it must never reach into " +
              "a directory it did not put there",
            /if \(isOurs\) \{/.test(inst));
    }
}

console.log(`\n${pass}/${pass + fail} packaging checks passed`);
process.exit(fail ? 1 : 0);
