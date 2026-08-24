/**
 * RELEASE TRUST — the two-factor gate on a network-fetched patch: INTEGRITY (the
 * installer's SHA-256 matches the signed manifest) AND AUTHENTICITY (the manifest
 * carries an Ed25519 signature that verifies against the baked public key). Both
 * must pass; every failure mode must FAIL CLOSED. These prove the crypto round-
 * trips and, more importantly, that every tampered or unsigned case is refused.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const trust = require(path.join(__dirname, "..", ".lcl.engine", "core", "releaseTrust"));

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 200) : ""); }
}

(async () => {
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-trust-"));

    // an Ed25519 release keypair (the operator's, but ephemeral here), and a
    // SECOND, unrelated keypair to stand in for an attacker's
    const kp = crypto.generateKeyPairSync("ed25519");
    const pubPem = kp.publicKey.export({ type: "spki", format: "pem" });
    const privPem = kp.privateKey.export({ type: "pkcs8", format: "pem" });
    const evil = crypto.generateKeyPairSync("ed25519");
    const evilPrivPem = evil.privateKey.export({ type: "pkcs8", format: "pem" });

    // a fake installer + the signed manifest that describes it
    const installer = path.join(WS, "lcl-Installer-1.0.0.exe");
    fs.writeFileSync(installer, Buffer.from("PRETEND-INSTALLER-BYTES-".repeat(4096)));
    const sha = trust.sha256FileSync(installer);

    // ---- hashing: sync and async agree, and detect a changed byte ----
    check("sha256FileSync and sha256File agree on the same file",
        sha === await trust.sha256File(installer), sha);
    fs.writeFileSync(path.join(WS, "other.bin"), "different");
    check("a different file hashes differently",
        trust.sha256FileSync(path.join(WS, "other.bin")) !== sha);

    // the manifest is the EXACT bytes that get signed and later verified
    const manifestObj = { official: 7, local: 0, version: "1.0.0",
        buildId: "abc-1", installerSha256: sha };
    const manifestBytes = JSON.stringify(manifestObj, null, 2);
    const sig = trust.signManifest(manifestBytes, privPem);

    // ---- signature round-trip ----
    check("a manifest signed by the release key verifies against its public key",
        trust.verifyManifest(manifestBytes, sig, pubPem) === true);
    check("a manifest signed by ANOTHER key does NOT verify (authenticity)",
        trust.verifyManifest(manifestBytes, trust.signManifest(manifestBytes, evilPrivPem), pubPem) === false);
    check("a TAMPERED manifest (one byte changed) does not verify",
        trust.verifyManifest(manifestBytes.replace('"official": 7', '"official": 8'), sig, pubPem) === false);
    check("garbage signature does not verify (and does not throw)",
        trust.verifyManifest(manifestBytes, "not-base64-!!!", pubPem) === false);
    check("empty/missing signature does not verify",
        trust.verifyManifest(manifestBytes, "", pubPem) === false);

    // ---- the FULL gate: verifyInstaller ----
    let r = await trust.verifyInstaller({ installerPath: installer,
        manifestBytes, signatureB64: sig, publicKeyPem: pubPem });
    check("VALID: correct hash + valid signature => trusted", r.ok === true, r.reason);
    check("...and it returns the parsed manifest (with the official number)",
        r.manifest && r.manifest.official === 7, r.manifest);

    // integrity failure: the binary was swapped for a different one of the SAME
    // declared hash claim — i.e. the file no longer matches the signed hash
    const swapped = path.join(WS, "swapped.exe");
    fs.writeFileSync(swapped, Buffer.from("A-COMPLETELY-DIFFERENT-BINARY"));
    r = await trust.verifyInstaller({ installerPath: swapped,
        manifestBytes, signatureB64: sig, publicKeyPem: pubPem });
    check("INTEGRITY: a binary whose hash != the signed manifest is REFUSED",
        r.ok === false && /hash does not match/.test(r.reason), r.reason);

    // authenticity failure: an attacker re-hashes their own binary and writes a
    // matching manifest, but cannot sign it with the real key
    const evilInstaller = path.join(WS, "evil.exe");
    fs.writeFileSync(evilInstaller, Buffer.from("MALICIOUS-PAYLOAD"));
    const evilManifest = JSON.stringify({ official: 99, version: "1.0.0",
        installerSha256: trust.sha256FileSync(evilInstaller) }, null, 2);
    const evilSig = trust.signManifest(evilManifest, evilPrivPem);   // signed with the WRONG key
    r = await trust.verifyInstaller({ installerPath: evilInstaller,
        manifestBytes: evilManifest, signatureB64: evilSig, publicKeyPem: pubPem });
    check("AUTHENTICITY: a self-consistent (hash matches) but WRONG-KEY-signed " +
          "release is REFUSED — the compromised-GitHub case",
        r.ok === false && /signature did not verify/.test(r.reason), r.reason);

    // fail-closed: no public key at all
    r = await trust.verifyInstaller({ installerPath: installer,
        manifestBytes, signatureB64: sig, publicKeyPem: null });
    check("FAIL CLOSED: no baked public key => refused, never launched",
        r.ok === false && /no release public key/.test(r.reason), r.reason);

    // fail-closed: an unsigned release
    r = await trust.verifyInstaller({ installerPath: installer,
        manifestBytes, signatureB64: "", publicKeyPem: pubPem });
    check("FAIL CLOSED: an unsigned release => refused",
        r.ok === false && /not signed/.test(r.reason), r.reason);

    // a signed manifest that declares no installer hash
    const noHash = JSON.stringify({ official: 7, version: "1.0.0" }, null, 2);
    r = await trust.verifyInstaller({ installerPath: installer,
        manifestBytes: noHash, signatureB64: trust.signManifest(noHash, privPem), publicKeyPem: pubPem });
    check("a signed manifest with no installer hash => refused",
        r.ok === false && /declares no installer hash/.test(r.reason), r.reason);

    // ---- bakedPublicKey fails closed when no key is shipped ----
    // (there is no release-pubkey.pem in the tree yet; if one is ever added this
    // still must return a PEM or null, never throw)
    const baked = trust.bakedPublicKey();
    check("bakedPublicKey returns a PEM string or null, never throws",
        baked === null || (typeof baked === "string" && baked.includes("PUBLIC KEY")), typeof baked);

    // ---- the exact release.js flow: sign the bytes written, verify the same ----
    const sidecarBytes = JSON.stringify({ official: 3, local: 0, version: "1.0.0",
        buildId: "z-9", channel: "release", installerSha256: sha }, null, 2);
    const relSig = trust.signManifest(sidecarBytes, privPem);
    r = await trust.verifyInstaller({ installerPath: installer,
        manifestBytes: sidecarBytes, signatureB64: relSig, publicKeyPem: pubPem });
    check("the release.js sign path (sign the exact sidecar bytes) verifies end to end",
        r.ok === true && r.manifest.channel === "release", r.reason);

    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    console.log(`\n${pass}/${pass + fail} release-trust checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
