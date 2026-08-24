const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const { ToolError, resolveInRoot } = require("./fsTools");

/**
 * Media tools over a bundled ffmpeg (LGPL build, license alongside the exe).
 *
 * Security posture mirrors generate_image:
 *  - every path resolves through the same containment gate as the file tools
 *  - ffmpeg/ffprobe run via spawn() ARRAYS — nothing the model supplies can
 *    become a flag or a shell fragment
 *  - media_transform is a WHITELIST of operations with clamped numeric
 *    parameters, not an argv passthrough; there is deliberately no way for
 *    the model to hand ffmpeg raw arguments
 *  - output is always a NEW file (never in-place), so every transform is a
 *    "created" change record the user can revert
 */

const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_INPUT_BYTES = 1_500_000_000;
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".wma"]);
const VIDEO_EXT = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi"]);
const OUTPUT_EXT = new Set([...AUDIO_EXT, ...VIDEO_EXT, ".gif"]);

function binDir() {
    return path.join(paths.toolsRoot(), "ffmpeg",
        process.platform === "win32" ? "win-x64" : "mac-arm64");
}
function ffmpegBin()  { return path.join(binDir(), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"); }
function ffprobeBin() { return path.join(binDir(), process.platform === "win32" ? "ffprobe.exe" : "ffprobe"); }

function available() {
    return fs.existsSync(ffmpegBin()) && fs.existsSync(ffprobeBin());
}

function num(v, lo, hi, fallback) {
    const n = Number(v);
    if (!isFinite(n)) {
        if (fallback !== undefined) return fallback;
        throw new ToolError(`expected a number, got: ${v}`);
    }
    return Math.max(lo, Math.min(hi, n));
}

const INPUT_EXT = new Set([...AUDIO_EXT, ...VIDEO_EXT, ".gif"]);
// Playlist/manifest containers make ffmpeg's demuxer OPEN OTHER FILES — an
// in-workspace .m3u8 naming file:C:/anything reads and copies it into the
// linked folder. Reproduced live by the adversarial review. Path containment
// covers the argv; these checks contain what the demuxer does next.
const MANIFEST_MAGIC_RE = /^\uFEFF?\s*(#EXTM3U|#EXT-X-|ffconcat\s+version|<\?xml|<asx|\[playlist\])/i;

function assertRealMedia(full, relPath) {
    if (!INPUT_EXT.has(path.extname(full).toLowerCase())) {
        throw new ToolError(
            `input extension must be one of: ${[...INPUT_EXT].join(" ")} — ` +
            "playlists and manifests are not accepted");
    }
    let fd;
    try {
        fd = fs.openSync(full, "r");
        const head = Buffer.alloc(96);
        const n = fs.readSync(fd, head, 0, 96, 0);
        if (MANIFEST_MAGIC_RE.test(head.subarray(0, n).toString("latin1"))) {
            throw new ToolError(
                `${relPath} is a playlist/manifest, not media — it could reference ` +
                "files outside the folder and is refused");
        }
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } }
    }
}

function resolveMedia(root, relPath, { mustExist }) {
    if (typeof relPath !== "string" || !relPath.trim()) {
        throw new ToolError("a file path is required");
    }
    const full = resolveInRoot(root, relPath);
    if (mustExist) {
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
            throw new ToolError(`not a file: ${relPath}`);
        }
        if (fs.statSync(full).size > MAX_INPUT_BYTES) {
            throw new ToolError("input file is too large (1.5 GB cap)");
        }
        assertRealMedia(full, relPath);
    } else {
        if (fs.existsSync(full)) {
            throw new ToolError(`output already exists: ${relPath} — pick another name`);
        }
        if (!OUTPUT_EXT.has(path.extname(full).toLowerCase())) {
            throw new ToolError(`output extension must be one of: ${[...OUTPUT_EXT].join(" ")}`);
        }
        // same protected-directory rule as every other write path in the app
        const parts = path.relative(root, full).split(path.sep).map(s => s.toLowerCase());
        const blocked = parts.filter(p =>
            [".git", ".github", ".vscode", ".hg", ".svn", ".idea"].includes(p));
        if (blocked.length) {
            throw new ToolError(`refusing to write inside a protected directory: ${blocked.join(", ")}`);
        }
    }
    return full;
}

// platform-correct kill, same shape as every sibling module — an unconditional
// taskkill spawn on macOS raises an uncatchable async ENOENT
function killTree(child) {
    try {
        if (process.platform === "win32") {
            const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
            k.on("error", () => { /* nothing to kill */ });
        } else {
            child.kill("SIGKILL");
        }
    } catch { /* already gone */ }
}

function run(bin, args, cancelToken) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", d => { out += d; if (out.length > 4_000_000) out = out.slice(-2_000_000); });
        child.stderr.on("data", d => { err += d; if (err.length > 200_000) err = err.slice(-100_000); });

        const timer = setTimeout(() => {
            killTree(child);
            reject(new ToolError("media operation timed out"));
        }, RUN_TIMEOUT_MS);
        const cancelWatch = setInterval(() => {
            if (cancelToken && cancelToken.cancelled) killTree(child);
        }, 400);

        child.on("error", e => { clearTimeout(timer); clearInterval(cancelWatch); reject(new ToolError(e.message)); });
        child.on("close", code => {
            clearTimeout(timer); clearInterval(cancelWatch);
            if (cancelToken && cancelToken.cancelled) return reject(new ToolError("cancelled"));
            if (code !== 0) {
                const tail = err.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
                return reject(new ToolError(`ffmpeg failed (exit ${code}): ${tail}`));
            }
            resolve({ out, err });
        });
    });
}

/* ------------------------------------------------------------------ probe */

async function mediaProbe(root, { path: relPath } = {}, ctx = {}) {
    if (!available()) throw new ToolError("media tools are not installed on this machine");
    const full = resolveMedia(root, relPath, { mustExist: true });

    const { out } = await run(ffprobeBin(), [
        "-v", "error",
        // belt over the magic-sniff braces: even a playlist that slips the
        // sniff cannot open anything beyond plain local files
        "-protocol_whitelist", "file",
        "-print_format", "json",
        "-show_format", "-show_streams", full
    ], ctx.cancelToken);

    let j;
    try { j = JSON.parse(out); } catch { throw new ToolError("could not parse media info"); }

    const fmt = j.format || {};
    const streams = (j.streams || []).map(s => ({
        type: s.codec_type, codec: s.codec_name,
        ...(s.codec_type === "audio" ? { channels: s.channels, sampleRate: s.sample_rate } : {}),
        ...(s.codec_type === "video" ? { width: s.width, height: s.height, fps: s.avg_frame_rate } : {})
    }));
    return {
        file: relPath,
        seconds: fmt.duration ? +Number(fmt.duration).toFixed(2) : null,
        bytes: fmt.size ? Number(fmt.size) : null,
        container: fmt.format_name,
        bitrate: fmt.bit_rate ? Number(fmt.bit_rate) : null,
        streams
    };
}

/* -------------------------------------------------------------- transform */

/**
 * The operation whitelist. Each op maps CLAMPED numeric params onto a fixed
 * argv shape. Growing this table is how media capability grows — never by
 * letting the model write ffmpeg arguments.
 */
const OPS = {
    // the original .lcl use case: bring the volume down toward the end
    fade_out: (full, p) => {
        const start = num(p.start_seconds, 0, 86_400);
        const dur = num(p.fade_seconds, 0.1, 600, 4);
        return ["-i", full, "-af", `afade=t=out:st=${start}:d=${dur}`];
    },
    fade_in: (full, p) => {
        const dur = num(p.fade_seconds, 0.1, 600, 3);
        return ["-i", full, "-af", `afade=t=in:st=0:d=${dur}`];
    },
    volume: (full, p) => {
        const factor = num(p.factor, 0, 8);
        return ["-i", full, "-af", `volume=${factor}`];
    },
    trim: (full, p) => {
        const start = num(p.start_seconds, 0, 86_400, 0);
        const args = ["-ss", String(start), "-i", full];
        if (p.end_seconds !== undefined) {
            const end = num(p.end_seconds, 0, 86_400);
            if (end <= start) throw new ToolError("end_seconds must be after start_seconds");
            args.push("-t", String(end - start));
        }
        args.push("-c", "copy");
        return args;
    },
    convert: (full) => ["-i", full],
    extract_audio: (full) => ["-i", full, "-vn"],
    normalize: (full) => ["-i", full, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11"]
};

async function mediaTransform(root, args = {}, ctx = {}) {
    if (!available()) throw new ToolError("media tools are not installed on this machine");
    const op = String(args.op || "");
    if (!OPS[op]) {
        throw new ToolError(`unknown op '${op}'. Available: ${Object.keys(OPS).join(", ")}`);
    }
    const input = resolveMedia(root, args.input, { mustExist: true });
    const output = resolveMedia(root, args.output, { mustExist: false });
    if (path.resolve(input) === path.resolve(output)) {
        throw new ToolError("output must be a different file from input");
    }

    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote(`ffmpeg ${op} — working`);

    fs.mkdirSync(path.dirname(output), { recursive: true });
    const started = Date.now();
    // -threads caps the encode so a video job cannot starve the resident LLM;
    // -protocol_whitelist file backs up the manifest sniff in resolveMedia
    const argv = ["-v", "error", "-y", "-threads", "4",
        "-protocol_whitelist", "file",
        ...OPS[op](input, args), output];
    try {
        await run(ffmpegBin(), argv, ctx.cancelToken);
    } catch (e) {
        try { fs.rmSync(output, { force: true }); } catch { /* nothing to clean */ }
        throw e;
    }

    if (!fs.existsSync(output)) throw new ToolError("ffmpeg produced no output");
    return {
        written: String(args.output).split(path.sep).join("/"),
        bytes: fs.statSync(output).size,
        created: true,
        op,
        seconds: Math.round((Date.now() - started) / 100) / 10
    };
}

const PROBE_ENTRY = {
    run: mediaProbe,
    help: 'media_probe {"path": "song.mp3"} — duration, codecs, channels, dimensions of an audio/video file'
};
const TRANSFORM_ENTRY = {
    run: mediaTransform,
    help: 'media_transform {"op": "fade_out", "input": "a.mp3", "output": "b.mp3", ' +
        '"start_seconds": 100} — ops: fade_out, fade_in, volume, trim, convert, ' +
        'extract_audio, normalize; always writes a NEW file'
};

module.exports = { available, ffmpegBin, mediaProbe, mediaTransform, PROBE_ENTRY, TRANSFORM_ENTRY, OPS };
