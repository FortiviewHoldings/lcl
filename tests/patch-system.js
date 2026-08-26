/**
 * PATCH NOTIFICATION + ONE-CLICK INSTALL. "I want .lcl to know that there is a
 * patch ready... a physical button that pops up when the running .lcl is
 * different than the installer... a real patch system I can click from the ui,
 * that initiates the installer, just like me clicking it."
 *
 * The build stamps a fingerprint into the app (resources/build-info.json) and
 * beside the installer (dist/build-info.json). The running app compares the two:
 * a DIFFERENT id + a real installer = a patch. Clicking launches the installer
 * and quits so it can replace files.
 *
 * Pins the wiring (source) AND the decision rule (re-implemented and exercised).
 */
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..");
const release = fs.readFileSync(path.join(R, "devtools", "release.js"), "utf8");
const main = fs.readFileSync(path.join(R, "app", "main.js"), "utf8");
const preload = fs.readFileSync(path.join(R, "app", "preload.js"), "utf8");
const appjs = fs.readFileSync(path.join(R, "app", "renderer", "app.js"), "utf8");
const css = fs.readFileSync(path.join(R, "app", "renderer", "styles.css"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 160) : ""); }
}

/* ---- the build stamps a TWO-LANE fingerprint in BOTH places ---- */
check("release.js computes a two-lane fingerprint — official base + local marker " +
      "+ base-of-record + git hash/time",
    /function buildFingerprint\(\)/.test(release) && /git rev-parse --short HEAD/.test(release)
    && /buildId:/.test(release)
    && /official,/.test(release) && /local,/.test(release)
    && /base: \{ official, commit: gitHash \}/.test(release));
check("the OFFICIAL base is sourced from the REPO (RELEASE.json), not a machine " +
      "counter — so two builders never disagree about what a number means",
    /function officialBase\(\)/.test(release) && /RELEASE\.json/.test(release));
check("the LOCAL marker is a per-machine counter that resets when the base " +
      "changes, and never impersonates the official base",
    /function nextLocalMarker\(base\)/.test(release) && /build-seq\.json/.test(release)
    && /stored\.base === base \? stored\.local : 0\) \+ 1/.test(release));
check("a --release cut sits AT the base (local 0); a plain build sits ABOVE it",
    /process\.argv\.includes\("--release"\)/.test(release)
    && /isRelease \? \(resetLocalMarker\(official\), 0\) : nextLocalMarker\(official\)/.test(release));
check("it bakes build-info.json into the packed resources (travels in the installer)",
    /const resDir = path\.join\(DIST, "win-unpacked", "resources"\)/.test(release)
    && /path\.join\(resDir, "build-info\.json"\)/.test(release));
check("it writes the sidecar dist/build-info.json (the 'what is available' marker)",
    /path\.join\(DIST, "build-info\.json"\)/.test(release));
check("the sidecar carries the installer SHA-256 (integrity) and a --release cut " +
      "signs the manifest (authenticity)",
    /installerSha256: trust\.sha256FileSync\(installerPath\(\)\)/.test(release)
    && /fp\.channel === "release"/.test(release) && /trust\.signManifest\(bytes,/.test(release)
    && /build-info\.json\.sig/.test(release));
check("the release PUBLIC key is shipped inside the installer so an install can " +
      "verify future patches (absent => a dev build, network channel fails closed)",
    /release-pubkey\.pem/.test(release));

/* ---- main: detection + apply ---- */
check("main reads the running build from resources/build-info.json",
    /function runningBuild\(\)/.test(main) && /paths\.resourceRoot\(\), "build-info\.json"/.test(main));
check("main compares against a patch channel (dist), installer must exist",
    /function availablePatch\(\)/.test(main) && /function patchChannelDir\(\)/.test(main)
    && /lcl-Installer-\$\{app\.getVersion\(\)\}\.exe/.test(main));
check("applyPatch launches the installer via the SHELL (elevation-safe) and only quits if it started",
    /ipcMain\.handle\("lcl:applyPatch"/.test(main)
    && /async function launchInstaller\(installerPath\)/.test(main)
    && /shell\.openPath\(installerPath\)/.test(main)
    && /if \(err\) return \{ ok: false/.test(main)
    && /app\.quit\(\)/.test(main));
check("applyPatch routes through the CHANNEL, and a NETWORK source is FORCED " +
      "through obtainInstaller (verify) — no branch can launch an unverified " +
      "binary; the local channel trusts a file on the user's own disk",
    /patchChannel\.resolveChannel\(paths\.readSettings\(\)\)/.test(main)
    && /if \(channel\.kind === "local"\)/.test(main)
    && /channel\.obtainInstaller\(latest, \{/.test(main)
    && /return launchInstaller\(got\.installerPath\)/.test(main));
/* ---- the three defects the FIRST live github patch exposed, pinned ---- */
check("THE LAUNCHER NEVER QUITS ON THE SHELL'S WORD ALONE — it waits until the " +
      "installer PROCESS exists (UAC answered) before quitting, and an " +
      "unanswered prompt is reported honestly with the app left open. Measured: " +
      "a github patch downloaded, verified, quit on openPath's success answer, " +
      "and installed nothing",
    /tasklist\.exe/.test(main)
    && /IMAGENAME eq \$\{imageName\}/.test(main)
    && /the installer never started/.test(main)
    && /Nothing was changed/.test(main));
check("THE CACHE FILE IS NAMED BY WHAT IT CONTAINS — the incoming release's " +
      "version, never the running app's. A '1.0.1' cache file holding the 1.0.2 " +
      "payload sat beside a REAL old 1.0.1 installer, and the operator " +
      "reinstalled the old build. The claimed version is sanitized because it " +
      "arrives BEFORE the signature is verified",
    /latest\.info && latest\.info\.version/.test(main)
    && /\^\[0-9A-Za-z\]\[0-9A-Za-z.-\]\{0,40\}\$/.test(main)
    && /lcl-Installer-\$\{incoming\}\.exe/.test(main));
check("THE DOWNLOAD IS NOT A BLACK BOX — preload bridges the progress stream " +
      "and the button says the percent, then hands off to the Windows prompt",
    /onPatchProgress:\s*\(cb\)/.test(preload)
    && /lcl:patch-progress/.test(preload)
    && /downloading… \$\{pr\.pct\}%/.test(appjs)
    && /approve the Windows prompt/.test(appjs));
check("A RELEASE BUILD PRUNES STALE INSTALLERS FROM DIST — a rolling installer " +
      "means the newest replaces the rest, so an old exe cannot sit beside the " +
      "new one waiting to be mis-clicked",
    /pruned\s+stale/.test(release)
    && /\^lcl-Installer-\.\*\\\.exe\$/.test(release));
check("main pushes patch status to the renderer (startup + poll)",
    /function pushPatchStatus\(\)/.test(main) && /"lcl:patch-available"/.test(main) && /setInterval\(pushPatchStatus/.test(main));

/* ---- preload + renderer ---- */
check("preload bridges patchStatus / applyPatch / onPatchAvailable",
    /patchStatus:\s*\(\)/.test(preload) && /applyPatch:\s*\(\)/.test(preload) && /onPatchAvailable:\s*\(cb\)/.test(preload));
check("renderer shows a puzzle-piece 'Patch Ready' button and confirms before launching",
    /function showPatchBanner\(p\)/.test(appjs) && /Patch Ready/.test(appjs)
    && /patch-puzzle/.test(appjs)
    && /window\.lcl\.applyPatch\(\)/.test(appjs) && /Install & restart/.test(appjs));
check("renderer subscribes to patch-available and checks once on load",
    /window\.lcl\.onPatchAvailable\(showPatchBanner\)/.test(appjs)
    && /window\.lcl\.patchStatus\(\)\.then\(showPatchBanner\)/.test(appjs));
check("THE VERSION LEADS THE BANNER — 'the version is the true number': the " +
      "label says v1.0.9 ready / you're on v1.0.8, the local marker rides " +
      "alongside, and the official lane number is TOOLTIP bookkeeping (the " +
      "lanes started before the public repo, so they run two ahead of the " +
      "version and confuse as a headline)",
    /function patchLabel\(p\)/.test(appjs)
    && /\$\{lv\} ready\$\{from\}/.test(appjs)
    && /you're on \$\{rv\}/.test(appjs)
    && /\+\$\{local\} local/.test(appjs)
    && /"Official #" \+ p\.latestOfficial/.test(appjs)
    && /Official #\$\{off\} ready/.test(appjs) /* the no-version fallback */);
check("a newer build landing while the banner is up REFRESHES the number in " +
      "place — it does not freeze at a stale one (the bug that showed an old " +
      "patch number after a rebuild)",
    /existing\.dataset\.offer === offer/.test(appjs)
    && /existing\.dataset\.offer = offer/.test(appjs)
    && !/if \(existing\) return; *\/\/ already showing/.test(appjs));
check("main returns BOTH lanes for the banner — the official base each side is " +
      "on, the running copy's local divergence, and the offer's source",
    /runningOfficial: rOff, latestOfficial: lOff/.test(main)
    && /runningLocal: localOf\(running\)/.test(main) && /source:/.test(main));
check("the banner has styling (and no lozenge radius)",
    /#patch-banner/.test(css) && !/#patch-banner[\s\S]*?border-radius:[^;]*\d{3,}px/.test(css));

/* ---- the DECISION RULE, re-implemented and exercised ---- */
// mirrors availablePatch(): only the OFFICIAL lane decides "am I behind"; the
// LOCAL marker never participates. Legacy `buildNumber` is read as an official
// number (an app installed before the lanes); else fall back to the exact buildId.
const decide = (running, latest, hasInstaller) => {
    const offOf = (b) => b && Number.isInteger(b.official) ? b.official : null;
    const rOff = offOf(running);
    const lOff = offOf(latest);
    const newer = (rOff !== null && lOff !== null)
        ? lOff > rOff
        : !!(running && running.buildId && latest && latest.buildId
             && latest.buildId !== running.buildId);
    return !!(running && running.buildId && latest && latest.buildId && newer && hasInstaller);
};
check("a NEWER build + a real installer => patch available",
    decide({ buildId: "a-1" }, { buildId: "b-2" }, true) === true);
check("the SAME build => no patch",
    decide({ buildId: "a-1" }, { buildId: "a-1" }, true) === false);
check("a different build but NO installer => no patch (no false alarm)",
    decide({ buildId: "a-1" }, { buildId: "b-2" }, false) === false);
check("dev with no baked build-info => no patch (never nags the source tree)",
    decide(null, { buildId: "b-2" }, true) === false);
check("no marker in the channel yet => no patch",
    decide({ buildId: "a-1" }, null, true) === false);
/* ---- the OFFICIAL lane decides once both builds carry one ---- */
check("a HIGHER official base => patch available",
    decide({ buildId: "a-1", official: 5 }, { buildId: "b-2", official: 6 }, true) === true);
check("the SAME official base => no patch (even if buildId differs)",
    decide({ buildId: "a-1", official: 6 }, { buildId: "b-2", official: 6 }, true) === false);
check("a LOWER official base => NO patch — never offer a downgrade",
    decide({ buildId: "a-2", official: 7 }, { buildId: "b-1", official: 6 }, true) === false);
/* ---- THE LANE INVARIANT: the local marker never triggers a patch ---- */
check("SAME official base but a DIFFERENT local marker => NO patch — a local " +
      "rebuild/customization must never read as an official update",
    decide({ buildId: "a-1", official: 7, local: 5 },
           { buildId: "b-2", official: 7, local: 0 }, true) === false);
check("a locally-customized copy STILL gets offered a higher official base — " +
      "the two lanes are independent",
    decide({ buildId: "a-1", official: 7, local: 3 },
           { buildId: "b-2", official: 8, local: 0 }, true) === true);
check("running predates the lanes (legacy buildNumber, no official) but a numbered " +
      "build is published => patch, via the buildId fallback — NOT by conflating " +
      "the legacy number with the official lane",
    decide({ buildId: "a-1", buildNumber: 1 }, { buildId: "b-2", official: 2 }, true) === true);
check("THE SCHEMA-TRANSITION TRAP: a legacy buildNumber must NOT be read as an " +
      "official number — a new official #1 is still offered to a legacy #1 install " +
      "(different numbering spaces; buildId differs, so it offers)",
    decide({ buildId: "a-1", buildNumber: 1 }, { buildId: "b-2", official: 1 }, true) === true);
check("running predates ALL numbers (buildId only) but a numbered build is " +
      "published => patch, via the buildId fallback",
    decide({ buildId: "a-1" }, { buildId: "b-2", official: 1 }, true) === true);

check("THE PATCH CARD SITS ABOVE THE \"SESSIONS\" TITLE — the top of the " +
      "panel, where something waiting on the operator belongs. Anchored to " +
      "the New Session button it sat UNDER the title and read as one more " +
      "session-list control instead of news about the app itself",
    appjs.includes('document.getElementById("sidebar-head")')
    && (() => {
        const i = appjs.indexOf('ABOVE THE "SESSIONS" TITLE');
        if (i < 0) return false;
        const seg = appjs.slice(i, i + 600);
        // the head is the anchor, with the old button kept only as a fallback
        return seg.indexOf('getElementById("sidebar-head")')
             < seg.indexOf('getElementById("new-session")')
            && seg.includes("anchor.parentNode.insertBefore(el, anchor)");
    })()
    && fs.readFileSync(path.join(R, "app", "renderer", "index.html"), "utf8")
        .includes('id="sidebar-head"'), null);

console.log(`\n${pass}/${pass + fail} patch-system checks passed`);
process.exit(fail ? 1 : 0);
