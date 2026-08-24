/**
 * THE PAYLOAD RIDES INSIDE THE INSTALLER EXE, AFTER THE PROGRAM.
 *
 * Why this exists: the portable wrapper used to bundle the whole 2.3 GB app in
 * its own directory and extract ALL of it to temp before a single line of our
 * code ran — the four-minute silence the operator saw before any window. Here
 * the installer program is small and starts in seconds; the app is a gzip'd tar
 * appended to the exe after the program bytes, and OUR code streams it straight
 * into the target folder with a live progress bar.
 *
 * LAYOUT of the shipped exe:
 *   [ installer program ][ payload.tar.gz ][ 16-byte footer ]
 *   footer = <8 bytes: gzip length, little-endian><8 bytes: "LCLPAYLD">
 *
 * The exe reads its own bytes — electron-builder's portable target hands us the
 * real on-disk path in PORTABLE_EXECUTABLE_FILE — finds the footer, seeks to the
 * start of the archive and pipes exactly that byte range to `tar`. Progress is
 * measured by bytes read from the archive, not by tar's chatter, because tar's
 * verbose output is not the same across builds and cannot be relied on.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const MAGIC = "LCLPAYLD";
const FOOTER = 16;                       // 8 bytes length + 8 bytes magic

/** Windows ships tar.exe in System32; prefer it over anything on PATH. */
function tarBin() {
    const sys = path.join(process.env.SystemRoot || "C:\\Windows",
        "System32", "tar.exe");
    return fs.existsSync(sys) ? sys : "tar";
}

/** The exe that is actually running, on disk — the one carrying the payload. */
function selfExe() {
    return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

/**
 * Where the appended archive sits inside `exe`, or null if there is no footer
 * (e.g. running from source, before packing). { start, length } in bytes.
 */
function locate(exe) {
    let fd;
    try {
        const size = fs.statSync(exe).size;
        if (size < FOOTER + 512) return null;
        fd = fs.openSync(exe, "r");
        const foot = Buffer.alloc(FOOTER);
        fs.readSync(fd, foot, 0, FOOTER, size - FOOTER);
        if (foot.toString("ascii", 8, 16) !== MAGIC) return null;
        const length = Number(foot.readBigUInt64LE(0));
        const start = size - FOOTER - length;
        if (start < 0) return null;
        return { start, length };
    } catch {
        return null;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
    }
}

function hasPayload(exe = selfExe()) {
    return locate(exe) !== null;
}

/**
 * Stream the appended app into `target`, reporting progress by bytes read.
 * Resolves { ok, bytes } or rejects with a shaped error. `onProgress({pct,
 * file})` is called as chunks move; `file` is the current archive read offset
 * turned into a human note, since per-file names would need tar's unreliable
 * verbose stream.
 */
function extract(exe, target, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
        const at = locate(exe);
        if (!at) return reject(new Error("this installer has no payload appended"));
        fs.mkdirSync(target, { recursive: true });

        const tar = spawn(tarBin(), ["-xz", "-C", target],
            { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });

        let tarErr = "";
        tar.stderr.on("data", (d) => { tarErr += d.toString(); });

        const rd = fs.createReadStream(exe,
            { start: at.start, end: at.start + at.length - 1, highWaterMark: 1 << 20 });

        let read = 0;
        rd.on("data", (chunk) => {
            read += chunk.length;
            const pct = Math.min(99, (read / at.length) * 100);
            // a moving byte count is honest and fast; the label reads like work
            onProgress({ pct, file: `unpacking ${(read / 1e6).toFixed(0)} of ${(at.length / 1e6).toFixed(0)} MB` });
        });
        rd.on("error", (e) => { try { tar.kill(); } catch {} reject(e); });

        tar.on("error", (e) => reject(new Error("tar could not run: " + e.message)));
        tar.on("close", (code) => {
            if (code === 0) { onProgress({ pct: 100, file: "done" }); resolve({ ok: true, bytes: read }); }
            else reject(new Error("unpacking failed (tar " + code + "): " + tarErr.slice(0, 300)));
        });

        rd.pipe(tar.stdin);
        tar.stdin.on("error", () => { /* tar closed early; close event carries the code */ });
    });
}

module.exports = { extract, hasPayload, locate, selfExe, MAGIC, FOOTER, tarBin };
