/**
 * PACK THE SHIPPED INSTALLER: runtime portable  +  appended app.
 *
 *   node installer/pack.js <runtime-portable.exe> <app-win-unpacked-dir> <out.exe>
 *
 * The runtime portable is small and starts in seconds. The app tree is tarred
 * (gzip) and appended after the program bytes with a 16-byte footer, so the one
 * shipped exe carries both and installer/payload.js can find and stream it.
 *
 * Kept dead simple and dependency-free: Windows' own tar makes the archive,
 * Node concatenates. Nothing here is clever, because the clever version is the
 * one that fails at 2 a.m.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MAGIC = "LCLPAYLD";

function tarBin() {
    const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    return fs.existsSync(sys) ? sys : "tar";
}

function die(m) { console.error("pack: " + m); process.exit(1); }

const [runtime, appDir, out] = process.argv.slice(2);
if (!runtime || !appDir || !out) die("usage: pack.js <runtime.exe> <app-dir> <out.exe>");
if (!fs.existsSync(runtime)) die("runtime not found: " + runtime);
if (!fs.existsSync(appDir)) die("app dir not found: " + appDir);

const tgz = out + ".payload.tgz";
console.log("pack: taring the app tree (gzip)…");
// -C into the app dir and archive "." so paths are relative to the install root
const t = spawnSync(tarBin(), ["-czf", tgz, "-C", appDir, "."],
    { stdio: "inherit", windowsHide: true });
if (t.status !== 0) die("tar failed with " + t.status);

const runtimeBytes = fs.statSync(runtime).size;
const tgzBytes = fs.statSync(tgz).size;
console.log(`pack: runtime ${(runtimeBytes / 1e6).toFixed(0)} MB + payload ${(tgzBytes / 1e6).toFixed(0)} MB`);

// footer: <8-byte gzip length LE><8-byte magic>
const footer = Buffer.alloc(16);
footer.writeBigUInt64LE(BigInt(tgzBytes), 0);
footer.write(MAGIC, 8, "ascii");

console.log("pack: appending payload to the runtime…");
const w = fs.createWriteStream(out);
w.on("error", (e) => die("write failed: " + e.message));

// stream runtime, then payload, then footer — never hold 2 GB in memory
function pump(src, stream) {
    return new Promise((resolve, reject) => {
        const r = fs.createReadStream(src, { highWaterMark: 1 << 22 });
        r.on("error", reject);
        r.on("end", resolve);
        r.pipe(stream, { end: false });
    });
}

(async () => {
    await pump(runtime, w);
    await pump(tgz, w);
    await new Promise((res, rej) => w.write(footer, (e) => e ? rej(e) : res()));
    await new Promise((res) => w.end(res));
    fs.rmSync(tgz, { force: true });
    const finalBytes = fs.statSync(out).size;
    console.log(`pack: wrote ${out}  (${(finalBytes / 1e6).toFixed(0)} MB)`);
    // prove the footer reads back before anyone ships it
    const p = require("./payload");
    const at = p.locate(out);
    if (!at || at.length !== tgzBytes) die("self-check FAILED: footer does not read back");
    console.log(`pack: self-check ok — payload at offset ${at.start}, ${(at.length / 1e6).toFixed(0)} MB`);
})().catch((e) => die(e.message));
