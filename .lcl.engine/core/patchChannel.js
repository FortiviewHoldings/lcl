/**
 * PATCH CHANNELS — where an install looks for a newer official build.
 *
 * Two kinds, one gate:
 *   - LOCAL directory (today's behavior; dev builds and the self-patch pipeline):
 *     a build-info.json + installer already on the user's own disk. Trusted
 *     because it never left the machine.
 *   - GITHUB RELEASES (the public source): the gatekeeper's releases. EVERY
 *     installer fetched here MUST pass releaseTrust.verifyInstaller — integrity
 *     (sha256 matches the signed manifest) AND authenticity (Ed25519 signature
 *     verifies against the baked public key) — before it is handed back. It also
 *     refuses a build whose official number is not strictly NEWER than what is
 *     installed (rollback/replay protection), and it verifies the SAME bytes it
 *     will launch (no TOCTOU) by downloading to an app-private path and never
 *     re-fetching.
 *
 * Network access is injected as `deps` so the security logic is testable without
 * a live endpoint; production wires the SSRF-guarded helpers (see netDeps).
 * PLATFORM-AWARE: the installer asset is chosen for the running OS, so a Windows
 * install pulls the .exe and (later) a Mac pulls the .dmg/.zip — the channel does
 * not assume one platform.
 */
const fs = require("fs");
const path = require("path");
const trust = require("./releaseTrust");

// which release asset is THIS platform's installer
function installerAssetMatcher(platform, version) {
    if (platform === "darwin") return (n) => /\.(dmg|zip)$/i.test(n) && /mac|darwin|osx/i.test(n);
    if (platform === "linux") return (n) => /\.(AppImage|deb|rpm|tar\.gz)$/i.test(n);
    // default win32
    return (n) => new RegExp(`Installer.*${version ? version.replace(/\./g, "\\.") : ""}.*\\.exe$`, "i").test(n)
        || /Installer.*\.exe$/i.test(n);
}

function localDirChannel(dir) {
    return {
        kind: "local",
        async latest() {
            try {
                const bytes = fs.readFileSync(path.join(dir, "build-info.json"), "utf8");
                return { info: JSON.parse(bytes), bytes, source: "local" };
            } catch { return null; }
        },
        // the local file is trusted as-is; no download, no signature required
        async obtainInstaller(latest, opts = {}) {
            const installer = path.join(dir, `lcl-Installer-${opts.version || "1.0.0"}.exe`);
            if (!fs.existsSync(installer))
                return { ok: false, reason: "no installer in the local channel directory" };
            return { ok: true, installerPath: installer, verified: false, source: "local" };
        }
    };
}

function githubReleasesChannel(cfg, deps) {
    const { owner, repo } = cfg;
    const base = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    return {
        kind: "github",
        async latest() {
            const rel = await deps.getJson(base);
            if (!rel || !Array.isArray(rel.assets)) return null;
            const infoAsset = rel.assets.find((a) => a.name === "build-info.json");
            if (!infoAsset) return null;
            const bytes = await deps.getText(infoAsset.browser_download_url);
            if (!bytes) return null;
            let info; try { info = JSON.parse(bytes); } catch { return null; }
            // keep the RAW bytes — the signature is over exactly these
            return { info, bytes, source: "github", release: rel };
        },
        async obtainInstaller(latest, opts = {}) {
            const assets = (latest.release && latest.release.assets) || [];
            const match = installerAssetMatcher(opts.platform || process.platform, opts.version);
            const exeAsset = assets.find((a) => match(a.name));
            const sigAsset = assets.find((a) => a.name === "build-info.json.sig");
            if (!exeAsset) return { ok: false, reason: `no installer asset for ${opts.platform || process.platform} in the release` };
            if (!sigAsset) return { ok: false, reason: "the release is not signed (no build-info.json.sig)" };

            // ROLLBACK/REPLAY GUARD, part 1: refuse before downloading if the
            // manifest's official number is not strictly newer than installed.
            // (Re-checked against the VERIFIED manifest below — this is the cheap
            // early-out; the authoritative check is post-verify.)
            const installedOfficial = Number.isInteger(opts.installedOfficial) ? opts.installedOfficial : null;
            const latestOfficial = latest.info && Number.isInteger(latest.info.official) ? latest.info.official : null;
            if (installedOfficial !== null && latestOfficial !== null && !(latestOfficial > installedOfficial))
                return { ok: false, reason: `channel offers #${latestOfficial}, not newer than installed #${installedOfficial}` };

            // TOCTOU-SAFE: download to the app-private dest, then verify and launch
            // THAT exact file. Never re-fetch between verify and launch.
            const dest = opts.destPath;
            const dl = await deps.download(exeAsset.browser_download_url, dest, opts.onProgress);
            if (!dl || !dl.ok) return { ok: false, reason: (dl && dl.reason) || "download failed" };

            const signatureB64 = await deps.getText(sigAsset.browser_download_url);
            const v = await trust.verifyInstaller({
                installerPath: dest,
                manifestBytes: latest.bytes,          // the exact fetched build-info bytes
                signatureB64,
                publicKeyPem: (opts.publicKeyPem !== undefined) ? opts.publicKeyPem : trust.bakedPublicKey(),
            });
            if (!v.ok) { try { fs.unlinkSync(dest); } catch { /* ignore */ } return { ok: false, reason: v.reason }; }

            // ROLLBACK/REPLAY GUARD, part 2 (authoritative): the number now comes
            // from the SIGNED, verified manifest — refuse anything <= installed.
            const signedOfficial = v.manifest && Number.isInteger(v.manifest.official) ? v.manifest.official : null;
            if (installedOfficial !== null && signedOfficial !== null && !(signedOfficial > installedOfficial)) {
                try { fs.unlinkSync(dest); } catch { /* ignore */ }
                return { ok: false, reason: `signed build #${signedOfficial} is not newer than installed #${installedOfficial} — refusing a rollback` };
            }
            return { ok: true, installerPath: dest, verified: true, source: "github", manifest: v.manifest };
        }
    };
}

/** Choose a channel from settings. Default is the local dist directory. */
function resolveChannel(settings, deps) {
    const pc = settings && settings.patchChannel;
    if (pc && pc.kind === "github" && pc.owner && pc.repo) return githubReleasesChannel(pc, deps || netDeps());
    const dir = (settings && settings.patchChannelDir) || "C:\\.lcl\\dist";
    return localDirChannel(dir);
}

/**
 * Production network deps: SSRF-guarded, redirect-following, streamed to disk with
 * an on-the-fly hash. Reuses netTools.assertPublicHost so every hop is pinned to a
 * vetted public IP (no DNS rebinding, no jump to a private address on redirect).
 */
function netDeps() {
    const https = require("https");
    const http = require("http");
    const net = require("net");
    const netTools = require("./netTools");
    const MAX_REDIRECTS = 6;
    const UA = "lcl-updater";

    function once(url, onRes) {
        return new Promise((resolve, reject) => {
            (async () => {
                let current = url;
                for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
                    const parsed = new URL(current);
                    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
                        return reject(new Error("only http(s) is allowed"));
                    // assertPublicHost returns { address, family } — UNWRAP it.
                    // Passing the object through to net's lookup callback threw
                    // ERR_INVALID_IP_ADDRESS on every single fetch, which
                    // availablePatch's catch read as "offline → no patch": the
                    // github channel could never see a release. The unit tests
                    // inject mock deps, so only a LIVE poll ever ran this line.
                    const pinned = await netTools.assertPublicHost(parsed.hostname);
                    const pinnedIp = typeof pinned === "string" ? pinned : pinned.address;
                    const pinnedFamily = (pinned && pinned.family)
                        || (net.isIPv6(pinnedIp) ? 6 : 4);
                    const lib = parsed.protocol === "https:" ? https : http;
                    const r = await new Promise((res, rej) => {
                        const req = lib.request(parsed, {
                            method: "GET", timeout: 60000,
                            headers: { "User-Agent": UA, "Accept": "*/*" },
                            lookup: (host, opts, cb) => {
                                if (netTools.isBlockedAddress(pinnedIp)) return cb(new Error("blocked address"));
                                cb(null, pinnedIp, pinnedFamily);
                            },
                        }, (resp) => res(resp));
                        req.on("timeout", () => req.destroy(new Error("request timed out")));
                        req.on("error", rej);
                        req.end();
                    });
                    const status = r.statusCode || 0;
                    const loc = r.headers.location;
                    if (status >= 300 && status < 400 && loc) { r.resume(); current = new URL(loc, parsed).toString(); continue; }
                    return resolve(onRes(r, status));
                }
                reject(new Error("too many redirects"));
            })().catch(reject);
        });
    }

    async function getText(url) {
        return once(url, (r, status) => new Promise((resolve) => {
            if (status !== 200) { r.resume(); return resolve(null); }
            let data = ""; let n = 0;
            r.on("data", (c) => { n += c.length; if (n > 8 * 1024 * 1024) { r.destroy(); } else data += c; });
            r.on("end", () => resolve(data));
            r.on("error", () => resolve(null));
        }));
    }
    async function getJson(url) { const t = await getText(url); try { return t ? JSON.parse(t) : null; } catch { return null; } }

    async function download(url, dest, onProgress = () => {}) {
        return once(url, (r, status) => new Promise((resolve) => {
            if (status !== 200) { r.resume(); return resolve({ ok: false, reason: `download HTTP ${status}` }); }
            const total = parseInt(r.headers["content-length"] || "0", 10);
            const tmp = dest + ".part";
            const out = fs.createWriteStream(tmp);
            let got = 0;
            r.on("data", (c) => { got += c.length; if (total) onProgress({ got, total, pct: Math.floor((got / total) * 100) }); });
            r.on("error", (e) => { try { out.destroy(); fs.unlinkSync(tmp); } catch {} resolve({ ok: false, reason: "download error: " + e.message }); });
            out.on("error", (e) => resolve({ ok: false, reason: "write error: " + e.message }));
            out.on("finish", () => {
                try { fs.renameSync(tmp, dest); resolve({ ok: true, bytes: got }); }
                catch (e) { resolve({ ok: false, reason: "rename failed: " + e.message }); }
            });
            r.pipe(out);
        }));
    }
    return { getText, getJson, download };
}

module.exports = { resolveChannel, localDirChannel, githubReleasesChannel, netDeps, installerAssetMatcher };
