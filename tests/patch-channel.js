/**
 * PATCH CHANNELS — the local channel trusts local files; the GitHub channel puts
 * EVERY fetched installer through the two-factor trust gate (integrity +
 * authenticity) AND a rollback guard, verifying the same bytes it will hand back.
 * Network is mocked; the crypto is real. These prove the gate cannot be bypassed
 * by an unsigned, wrong-key, tampered, or rolled-back release.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const chan = require(path.join(__dirname, "..", ".lcl.engine", "core", "patchChannel"));
const trust = require(path.join(__dirname, "..", ".lcl.engine", "core", "releaseTrust"));

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 200) : ""); }
}

(async () => {
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-chan-"));

    // real release key + an attacker key
    const kp = crypto.generateKeyPairSync("ed25519");
    const pubPem = kp.publicKey.export({ type: "spki", format: "pem" });
    const privPem = kp.privateKey.export({ type: "pkcs8", format: "pem" });
    const evil = crypto.generateKeyPairSync("ed25519");
    const evilPriv = evil.privateKey.export({ type: "pkcs8", format: "pem" });

    // a fake installer sitting on a fake "server" (a local file the mock serves)
    const serverExe = path.join(WS, "server-lcl-Installer-1.0.0.exe");
    fs.writeFileSync(serverExe, Buffer.from("INSTALLER-BYTES-".repeat(8192)));
    const sha = trust.sha256FileSync(serverExe);

    // the signed manifest for official #8
    const manifest = JSON.stringify({ official: 8, local: 0, version: "1.0.0",
        buildId: "z-8", channel: "release", installerSha256: sha }, null, 2);
    const sig = trust.signManifest(manifest, privPem);

    // a mock github "release" + deps that serve our fixture from disk
    const release = { assets: [
        { name: "build-info.json", browser_download_url: "https://x/build-info.json" },
        { name: "lcl-Installer-1.0.0.exe", browser_download_url: "https://x/installer.exe" },
        { name: "build-info.json.sig", browser_download_url: "https://x/build-info.json.sig" },
    ] };
    const makeDeps = (over = {}) => ({
        getJson: async (u) => (/releases\/latest/.test(u) ? release : null),
        getText: async (u) => {
            if (/build-info\.json\.sig/.test(u)) return over.sig !== undefined ? over.sig : sig;
            if (/build-info\.json/.test(u)) return over.manifest !== undefined ? over.manifest : manifest;
            return null;
        },
        download: async (u, dest) => {
            const src = over.serveExe || serverExe;
            try { fs.copyFileSync(src, dest); return { ok: true, bytes: fs.statSync(dest).size }; }
            catch (e) { return { ok: false, reason: String(e.message) }; }
        },
        ...over.deps,
    });

    // ---- resolveChannel picks the right kind ----
    check("default settings => local channel",
        chan.resolveChannel({}, {}).kind === "local");
    check("github settings => github channel",
        chan.resolveChannel({ patchChannel: { kind: "github", owner: "o", repo: "r" } }, makeDeps()).kind === "github");

    // ---- local channel trusts local files (no signature needed) ----
    const localDir = path.join(WS, "dist");
    fs.mkdirSync(localDir);
    fs.writeFileSync(path.join(localDir, "build-info.json"), JSON.stringify({ official: 2, local: 0 }));
    fs.writeFileSync(path.join(localDir, "lcl-Installer-1.0.0.exe"), "x");
    const local = chan.localDirChannel(localDir);
    const ll = await local.latest();
    check("local channel reads its build-info", ll && ll.info.official === 2, ll);
    const li = await local.obtainInstaller(ll, { version: "1.0.0" });
    check("local channel returns the installer WITHOUT network verification (trusts own disk)",
        li.ok === true && li.verified === false, li);

    // ---- github channel: the happy path ----
    const gh = chan.githubReleasesChannel({ owner: "o", repo: "r" }, makeDeps());
    const gl = await gh.latest();
    check("github channel fetches + parses the release build-info (raw bytes kept)",
        gl && gl.info.official === 8 && gl.bytes === manifest, gl && gl.info);
    const dest = path.join(WS, "downloaded.exe");
    let gi = await gh.obtainInstaller(gl, { version: "1.0.0", platform: "win32",
        destPath: dest, installedOfficial: 7, publicKeyPem: pubPem });
    check("VALID signed+matching+newer release => verified installer returned",
        gi.ok === true && gi.verified === true && fs.existsSync(dest), gi);
    check("...and the launch path IS the downloaded (verified) file — no re-fetch",
        gi.installerPath === dest, gi);

    // ---- the gate refuses every attack ----
    const freshDest = () => path.join(WS, "d-" + Math.random().toString(36).slice(2) + ".exe");

    // unsigned release (mock returns no .sig)
    let g = chan.githubReleasesChannel({ owner: "o", repo: "r" },
        { ...makeDeps(), getText: async (u) => (/\.sig/.test(u) ? null : manifest),
          getJson: async () => ({ assets: release.assets.filter(a => a.name !== "build-info.json.sig") }) });
    gi = await g.obtainInstaller(await g.latest(), { version: "1.0.0", destPath: freshDest(), installedOfficial: 7, publicKeyPem: pubPem });
    check("UNSIGNED release => refused", gi.ok === false && /not signed/.test(gi.reason), gi);

    // wrong-key signature
    g = chan.githubReleasesChannel({ owner: "o", repo: "r" }, makeDeps({ sig: trust.signManifest(manifest, evilPriv) }));
    gi = await g.obtainInstaller(await g.latest(), { version: "1.0.0", destPath: freshDest(), installedOfficial: 7, publicKeyPem: pubPem });
    check("WRONG-KEY signature => refused (authenticity)", gi.ok === false && /signature did not verify/.test(gi.reason), gi);

    // tampered binary (server serves a different exe than the manifest hash)
    const tampered = path.join(WS, "tampered.exe");
    fs.writeFileSync(tampered, "A DIFFERENT BINARY");
    g = chan.githubReleasesChannel({ owner: "o", repo: "r" }, makeDeps({ serveExe: tampered }));
    gi = await g.obtainInstaller(await g.latest(), { version: "1.0.0", destPath: freshDest(), installedOfficial: 7, publicKeyPem: pubPem });
    check("TAMPERED binary (hash != signed manifest) => refused (integrity)", gi.ok === false && /hash does not match/.test(gi.reason), gi);

    // no baked public key => fail closed
    g = chan.githubReleasesChannel({ owner: "o", repo: "r" }, makeDeps());
    gi = await g.obtainInstaller(await g.latest(), { version: "1.0.0", destPath: freshDest(), installedOfficial: 7, publicKeyPem: null });
    check("NO public key => refused (fail closed)", gi.ok === false && /no release public key/.test(gi.reason), gi);

    // ROLLBACK: a validly-signed OLDER build (#8) offered to an install already on #8 or #9
    g = chan.githubReleasesChannel({ owner: "o", repo: "r" }, makeDeps());
    gi = await g.obtainInstaller(await g.latest(), { version: "1.0.0", destPath: freshDest(), installedOfficial: 8, publicKeyPem: pubPem });
    check("ROLLBACK: same official as installed => refused before download",
        gi.ok === false && /not newer than installed/.test(gi.reason), gi);
    gi = await g.obtainInstaller(await g.latest(), { version: "1.0.0", destPath: freshDest(), installedOfficial: 9, publicKeyPem: pubPem });
    check("ROLLBACK: a lower official than installed => refused (downgrade attack)",
        gi.ok === false && /not newer than installed/.test(gi.reason), gi);

    // ---- platform-aware asset selection ----
    check("win32 matches the .exe installer",
        chan.installerAssetMatcher("win32", "1.0.0")("lcl-Installer-1.0.0.exe") === true);
    check("darwin matches a mac .dmg, not the .exe",
        chan.installerAssetMatcher("darwin")("lcl-mac.dmg") === true
        && chan.installerAssetMatcher("darwin")("lcl-Installer-1.0.0.exe") === false);

    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    console.log(`\n${pass}/${pass + fail} patch-channel checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
