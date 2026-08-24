/**
 * THE PRODUCTION NETWORK PATH OF THE PATCH CHANNEL, ACTUALLY DRIVEN.
 *
 * The github channel's security logic is unit-tested with INJECTED deps
 * (tests/patch-channel.js), which left exactly one path never executed before
 * release: the real netDeps() — the SSRF-guarded fetcher the installed app
 * uses on every 60-second patch poll. It carried a shape bug the whole time:
 * netTools.assertPublicHost returns { address, family }, and netDeps passed
 * that OBJECT into net's lookup callback, which throws ERR_INVALID_IP_ADDRESS
 * on every single fetch. availablePatch's catch read the throw as "offline →
 * no patch", so the github channel could never see a release — measured live
 * on an installed build polling a real published release, showing no banner.
 *
 * This suite drives the REAL netDeps() over a REAL local socket. netTools is
 * stubbed at the require layer to return the exact object shape the real
 * assertPublicHost returns (and to allow loopback, which the real vetting
 * rightly refuses) — everything downstream of that seam is the production
 * code: the request, the pinned lookup, redirects, getText, getJson, download.
 */
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 240) : ""); }
}
setTimeout(() => {
    console.log(`\n${pass}/${pass + fail + 1} patch-netdeps checks passed (TIMED OUT)`);
    process.exit(1);
}, 60000).unref();

// ---- stub netTools BEFORE patchChannel is required: the REAL return shape,
//      loopback allowed so a local server can stand in for the internet ----
const netToolsPath = require.resolve(path.join(ROOT, ".lcl.engine", "core", "netTools.js"));
require.cache[netToolsPath] = { exports: {
    // the EXACT shape the real assertPublicHost returns (netTools.js:86)
    assertPublicHost: async (_hostname) => ({ address: "127.0.0.1", family: 4 }),
    isBlockedAddress: () => false
} };
const patchChannel = require(path.join(ROOT, ".lcl.engine", "core", "patchChannel.js"));

(async () => {
    // a tiny release server: JSON, text, a redirect hop, and a binary download
    const BODY = Buffer.from("payload-bytes-" + "x".repeat(4096));
    const server = http.createServer((rq, rs) => {
        if (rq.url === "/json") { rs.writeHead(200); rs.end(JSON.stringify({ ok: 1, tag: "v9" })); return; }
        if (rq.url === "/text") { rs.writeHead(200); rs.end("signature-b64"); return; }
        if (rq.url === "/hop") { rs.writeHead(302, { Location: "/text" }); rs.end(); return; }
        if (rq.url === "/bin") { rs.writeHead(200, { "Content-Length": BODY.length }); rs.end(BODY); return; }
        rs.writeHead(404); rs.end();
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const PORT = server.address().port;
    const base = `http://release-host.example:${PORT}`;   // hostname forces the lookup path

    const deps = patchChannel.netDeps();

    const j = await deps.getJson(`${base}/json`).catch(e => ({ __err: String(e.message) }));
    check("netDeps.getJson works through the PINNED lookup — the object-shaped " +
          "assertPublicHost return is unwrapped, not passed to net raw (the bug " +
          "threw ERR_INVALID_IP_ADDRESS here on every real poll)",
        j && j.ok === 1 && !j.__err, j);

    const t = await deps.getText(`${base}/text`).catch(e => "ERR:" + e.message);
    check("netDeps.getText works the same way", t === "signature-b64", t);

    const hop = await deps.getText(`${base}/hop`).catch(e => "ERR:" + e.message);
    check("a redirect re-pins and follows — every hop runs the same unwrap",
        hop === "signature-b64", hop);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-netdeps-"));
    const dest = path.join(dir, "installer.bin");
    const dl = await deps.download(`${base}/bin`, dest).catch(e => ({ ok: false, reason: String(e.message) }));
    check("netDeps.download streams to disk over the pinned socket",
        dl && dl.ok === true && fs.readFileSync(dest).equals(BODY), dl);

    // a BLOCKED pin must still refuse — the guard half of the seam
    require.cache[netToolsPath].exports.isBlockedAddress = () => "loopback";
    const blocked = await deps.getText(`${base}/text`).then(v => v, e => "REFUSED:" + e.message);
    check("...and a pin the guard rejects is refused, never fetched",
        blocked === null || /REFUSED/.test(String(blocked)), blocked);
    require.cache[netToolsPath].exports.isBlockedAddress = () => false;

    // a bare-string pin (defensive tolerance) must also work
    require.cache[netToolsPath].exports.assertPublicHost = async () => "127.0.0.1";
    const s = await deps.getJson(`${base}/json`).catch(e => ({ __err: String(e.message) }));
    check("a bare-string pin is tolerated too — either shape of assertPublicHost works",
        s && s.ok === 1, s);

    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* open handle */ }
    console.log(`\n${pass}/${pass + fail} patch-netdeps checks passed`);
    process.exit(fail ? 1 : 0);
})();
