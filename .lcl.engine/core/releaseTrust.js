/**
 * RELEASE TRUST — a patch fetched over the network is trusted only if BOTH hold:
 *
 *   1. INTEGRITY  — the downloaded installer's SHA-256 matches the hash declared
 *                   in the release manifest (build-info.json). Catches corruption
 *                   and a man-in-the-middle swap of the binary.
 *   2. AUTHENTICITY — the manifest itself carries an Ed25519 signature that
 *                   verifies against the release PUBLIC KEY baked into this app.
 *                   Because the hash is INSIDE the signed manifest, a valid
 *                   signature binds the official number, the version, AND the
 *                   exact binary together. This survives even a compromised
 *                   GitHub account: without the offline PRIVATE key, an attacker
 *                   cannot produce a manifest this app will accept.
 *
 * The local-directory channel (dev builds, the self-patch pipeline) does not go
 * through here — it trusts a file already on the user's own disk. Only a
 * NETWORK channel must prove itself, and it must FAIL CLOSED: no public key, no
 * signature, or any mismatch means the patch is refused, never launched.
 *
 * Ed25519 via Node's built-in crypto — no dependency, small keys, and the whole
 * check is offline. The private key never lives in the repo (see
 * devtools/gen-release-key.js); the public key is committed and shipped.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** SHA-256 of a file, streamed so a ~2 GB installer never loads into memory. */
function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash("sha256");
        const s = fs.createReadStream(file);
        s.on("error", reject);
        s.on("data", (d) => h.update(d));
        s.on("end", () => resolve(h.digest("hex")));
    });
}
function sha256Buffer(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

/** SHA-256 of a file, SYNCHRONOUS and chunked — for the build script, which is
 *  linear and would rather not thread a promise through the pack step. Still
 *  reads in 1 MB chunks so a multi-GB installer never loads whole into memory. */
function sha256FileSync(file) {
    const h = crypto.createHash("sha256");
    const fd = fs.openSync(file, "r");
    try {
        const buf = Buffer.allocUnsafe(1 << 20);
        let n;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    } finally { fs.closeSync(fd); }
    return h.digest("hex");
}

/**
 * Sign the EXACT bytes of the manifest with an Ed25519 private key (PEM). Signing
 * the literal file bytes — not a re-serialization — is what lets the verifier
 * check the same bytes it fetched without any canonicalization ambiguity.
 */
function signManifest(manifestBytes, privateKeyPem) {
    const key = crypto.createPrivateKey(privateKeyPem);
    return crypto.sign(null, Buffer.from(manifestBytes), key).toString("base64");   // Ed25519 → algorithm null
}

/** True iff the signature verifies the manifest bytes against the Ed25519 public key (PEM). */
function verifyManifest(manifestBytes, signatureB64, publicKeyPem) {
    try {
        const key = crypto.createPublicKey(publicKeyPem);
        return crypto.verify(null, Buffer.from(manifestBytes),
            key, Buffer.from(String(signatureB64 || ""), "base64"));
    } catch { return false; }
}

/**
 * The full gate. Returns { ok, reason?, manifest? }. Both halves must pass, in
 * this order (cheap signature check before hashing a multi-GB file).
 */
async function verifyInstaller({ installerPath, manifestBytes, signatureB64, publicKeyPem }) {
    if (!publicKeyPem)
        return { ok: false, reason: "no release public key is baked in — cannot verify authenticity" };
    if (!signatureB64)
        return { ok: false, reason: "the release is not signed" };
    if (!verifyManifest(manifestBytes, signatureB64, publicKeyPem))
        return { ok: false, reason: "signature did not verify — this manifest was not produced with the release key" };
    let manifest;
    try { manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")); }
    catch { return { ok: false, reason: "the signed manifest is not valid JSON" }; }
    const declared = manifest && manifest.installerSha256;
    if (!declared || typeof declared !== "string")
        return { ok: false, reason: "the signed manifest declares no installer hash" };
    let actual;
    try { actual = await sha256File(installerPath); }
    catch (e) { return { ok: false, reason: "could not hash the downloaded installer: " + (e && e.message) }; }
    if (actual !== declared)
        return { ok: false,
                 reason: `installer hash does not match the signed manifest (${actual.slice(0, 12)}… vs ${declared.slice(0, 12)}…)` };
    return { ok: true, manifest };
}

/**
 * The release PUBLIC KEY shipped with this app, or null if none is present yet.
 * Committed at the repo root and copied into resources/ at pack time, so the
 * same resolve works in dev (resourceRoot = repo) and packaged (resourceRoot =
 * resources). Null → the network channel fails closed until a key exists.
 */
function bakedPublicKey() {
    try {
        const paths = require("./paths");
        const pem = fs.readFileSync(path.join(paths.resourceRoot(), "release-pubkey.pem"), "utf8");
        return pem && pem.includes("PUBLIC KEY") ? pem : null;
    } catch { return null; }
}

module.exports = {
    sha256File, sha256FileSync, sha256Buffer,
    signManifest, verifyManifest, verifyInstaller, bakedPublicKey,
};
