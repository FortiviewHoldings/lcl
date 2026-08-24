/**
 * GENERATE THE RELEASE SIGNING KEY — run ONCE, by the release gatekeeper.
 *
 *   node devtools/gen-release-key.js
 *
 * Produces an Ed25519 keypair:
 *   - the PRIVATE key is written OUTSIDE the repo (default
 *     ~/.lcl-release-signing/release.key, or wherever LCL_RELEASE_KEY points),
 *     so it can never be committed or published. GUARD IT AND BACK IT UP: it is
 *     the sole proof a release is genuinely yours. Losing it means rotating the
 *     public key; leaking it means anyone can sign a patch this app will trust.
 *   - the PUBLIC key is written to the repo root as release-pubkey.pem, COMMITTED
 *     and shipped inside the app, so every install can verify a release.
 *
 * It refuses to overwrite an existing private key (rotation must be deliberate).
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const privPath = process.env.LCL_RELEASE_KEY
    || path.join(os.homedir(), ".lcl-release-signing", "release.key");
const pubPath = path.join(ROOT, "release-pubkey.pem");

if (fs.existsSync(privPath)) {
    console.error(`REFUSING to overwrite an existing private key at:\n  ${privPath}\n` +
        `Rotating the release key is deliberate: move or delete that file first, ` +
        `then re-run. (Every install carrying the OLD public key will stop trusting ` +
        `new releases until it updates.)`);
    process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubPem = publicKey.export({ type: "spki", format: "pem" });

fs.mkdirSync(path.dirname(privPath), { recursive: true });
fs.writeFileSync(privPath, privPem, { mode: 0o600 });
fs.writeFileSync(pubPath, pubPem);

console.log("Release signing key generated.\n");
console.log(`  PRIVATE key (keep secret, back up):  ${privPath}`);
console.log(`  PUBLIC key  (commit this):           ${pubPath}\n`);
console.log("Next: commit release-pubkey.pem, then cut a signed release with");
console.log("  node devtools/release.js --release");
