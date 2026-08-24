const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const paths = require("./paths");
const mediaTools = require("./mediaTools");
const { ToolError, resolveInRoot, resolveForWrite } = require("./fsTools");

/**
 * transcribe_audio — offline speech to text, via whisper.cpp (MIT).
 *
 * The point for this workbench: dictate a note instead of typing it, and
 * turn a meeting recording into text the knowledge index can read.
 * Nothing leaves the machine — same posture as every other tool here.
 *
 * whisper.cpp only accepts 16 kHz mono PCM WAV, so anything else goes through
 * the bundled ffmpeg first. That conversion is not a detail: an mp3 or an m4a
 * from a phone is the normal input, and a tool that refused them would be
 * useless in practice.
 *
 * Timestamps are kept as a per-segment list rather than baked into the text,
 * because the two consumers want different things — a human reading a
 * transcript wants prose, and "jump to where they mentioned the deadline" wants
 * seconds.
 */

const MAX_AUDIO_BYTES = 500_000_000;      // a long meeting recording is normal
const MAX_SECONDS = 4 * 60 * 60;          // refuse a mis-selected 12-hour file
const CONVERT_TIMEOUT_MS = 15 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 4 * 60 * 60_000;
const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus",
                           ".wma", ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4b"]);

function whisperDir() {
    return path.join(paths.toolsRoot(), "whisper");
}
function whisperBin() {
    return path.join(whisperDir(), process.platform === "win32" ? "win-x64" : "mac-arm64",
        process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
}

/** The speech model: bundled first, then the user's models dir. */
function modelFile() {
    const names = ["ggml-base.en-q5_1.bin", "ggml-base-q5_1.bin",
                   "ggml-small.en-q5_1.bin", "ggml-medium.en-q5_0.bin"];
    for (const dir of [whisperDir(), paths.modelsDir()]) {
        for (const n of names) {
            const p = path.join(dir, n);
            if (fs.existsSync(p)) return p;
        }
    }
    return null;
}

function available() {
    try {
        // ffmpeg is not optional here. whisper.cpp accepts only 16 kHz mono
        // PCM, so EVERY input goes through a conversion first — the tool
        // throws on ffmpeg's absence after the user has already asked for a
        // transcript. Offering a tool that can only fail is worse than not
        // offering it, so the dependency is part of "available".
        return fs.existsSync(whisperBin()) && !!modelFile() && mediaTools.available();
    } catch { return false; }
}

/** Run a child process to completion, capturing output. Never uses a shell. */
function run(bin, args, timeoutMs, onTick) {
    return new Promise((resolve) => {
        let child;
        try { child = spawn(bin, args, { windowsHide: true, cwd: path.dirname(bin) }); }
        catch (e) { return resolve({ code: -1, out: "", err: String(e.message) }); }
        let out = "", err = "";
        child.stdout.on("data", d => {
            out += d;
            if (onTick) onTick(String(d));
            if (out.length > 8e6) out = out.slice(-4e6);
        });
        child.stderr.on("data", d => { err += d; if (err.length > 2e6) err = err.slice(-1e6); });
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } },
            timeoutMs);
        if (timer.unref) timer.unref();
        child.on("error", e => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
        child.on("close", code => { clearTimeout(timer); resolve({ code, out, err }); });
    });
}

/* ======================================================================
 * BLANK AUDIO MUST NEVER REACH THE TRANSCRIPT
 * ======================================================================
 *
 * Whisper does not return nothing for nothing. Measured on this machine,
 * through the real path, with the bundled binary and model:
 *
 *   3 s of digital silence   -> "You"
 *   3 s of room tone         -> "[BLANK_AUDIO]"
 *
 * Both were appended straight into the operator's message box. A window that
 * contains no speech has no text to contribute, and inventing one costs a
 * manual delete every time.
 *
 * Three layers, in order of confidence, because one is not enough:
 *
 *  1. MEASURE THE AUDIO FIRST. If the loudest sample in the window is below
 *     SPEECH_PEAK_DBFS, no human said anything into it. Whisper is never run
 *     — which also removes the whole latency of that pass.
 *  2. DROP NON-SPEECH TAGS ALWAYS. "[BLANK_AUDIO]", "(silence)", "[Music]",
 *     "*coughs*", a lone full stop: a segment that is entirely a bracketed
 *     tag or entirely punctuation carries no words in any language and is
 *     never something a person dictated.
 *  3. DROP THE KNOWN SILENCE HALLUCINATIONS, BUT ONLY IN A QUIET WINDOW.
 *     "you" and "thank you" are real words, so they are only discarded when
 *     the window's own measurement says nothing audible happened. Above that
 *     level they are kept, because deleting a word the operator actually
 *     said is the worse failure of the two.
 *
 * The measurement FAILS OPEN on purpose. If the wav cannot be parsed, the
 * audio is transcribed anyway: this guard's job is to remove text nobody
 * spoke, and a guard that eats real dictation when it gets confused is worse
 * than the defect it was written for.
 */

// Real speech, attenuated by 40 dB until it is barely audible, still peaked at
// -40.3 dBFS and still transcribed perfectly. Digital silence measures -inf.
// -50 dBFS therefore sits ~10 dB below the quietest thing that has ever
// transcribed here, and 3 dB is a doubling of amplitude.
const SPEECH_PEAK_DBFS = -50;
// Between the gate and this, there is sound but nothing anyone would call
// dictation. Only in this band does layer 3 apply.
const QUIET_PEAK_DBFS = -45;
const FRAME_MS = 20;                       // one frame ≈ a phoneme's worth
const ACTIVE_FRAME_DBFS = -60;             // a frame with any speech energy in it

/** A segment that is a bracketed tag, or punctuation, and nothing else. */
const NON_SPEECH_TAG = /^(\s*[[(*<][^\])*>]*[\])*>][\s.,!?…-]*)+$/;

/**
 * Whisper's documented silence hallucinations — the sentences it emits when
 * asked to transcribe nothing. Normalised: lowercase, no surrounding
 * punctuation, single-spaced.
 */
const QUIET_ARTEFACTS = new Set([
    "you", "thank you", "thanks", "thanks for watching",
    "thank you for watching", "thanks for watching everyone",
    "bye", "bye bye", "please subscribe", "subscribe",
    "subtitles by the amara org community", "transcription by castingwords",
    "amara org", "www amara org"
]);

function normaliseArtefact(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[.,!?…"'`´’”“\-–—:;]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** True when this text carries no spoken words at all. */
function isNonSpeechText(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return true;
    if (NON_SPEECH_TAG.test(s)) return true;          // [BLANK_AUDIO], (silence), *sniffs*
    if (!/[\p{L}\p{N}]/u.test(s)) return true;        // punctuation or dashes only
    return false;
}

/** True when the WHOLE transcript is one of whisper's silence hallucinations. */
function isSilenceHallucination(text) {
    return QUIET_ARTEFACTS.has(normaliseArtefact(text));
}

/**
 * Walk the RIFF chunks rather than assuming a 44-byte header. The renderer
 * writes a bare 44-byte wav, ffmpeg writes a LIST/INFO chunk first, and an
 * earlier version of this measurement read that metadata as if it were audio
 * — which reported digital silence as peaking at -0.6 dBFS. Parse it properly
 * or do not parse it at all.
 */
function readWavPcm(file) {
    const buf = fs.readFileSync(file);
    if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF"
        || buf.toString("latin1", 8, 12) !== "WAVE") return null;
    let off = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (off + 8 <= buf.length) {
        const id = buf.toString("latin1", off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === "fmt " && off + 8 + 16 <= buf.length) {
            fmt = {
                format: buf.readUInt16LE(off + 8),
                channels: buf.readUInt16LE(off + 10),
                rate: buf.readUInt32LE(off + 12),
                bits: buf.readUInt16LE(off + 22)
            };
        } else if (id === "data") {
            dataOff = off + 8;
            dataLen = Math.min(size, buf.length - dataOff);
            break;
        }
        off += 8 + size + (size & 1);
    }
    if (!fmt || dataOff < 0 || fmt.bits !== 16 || fmt.format !== 1 || !fmt.rate) return null;
    return { buf, dataOff, dataLen, ...fmt };
}

/**
 * What is actually in this window: seconds, peak, rms, and how many 20 ms
 * frames carry any energy at all. Returned as numbers so a caller can print
 * them — a guard that refuses without showing its measurement is the kind
 * that gets argued with later.
 */
function measureWav(file) {
    let w = null;
    try { w = readWavPcm(file); } catch { w = null; }
    if (!w) return { ok: false, reason: "not 16-bit PCM wav" };
    const samples = Math.floor(w.dataLen / 2);
    const perFrame = Math.max(1, Math.round(w.rate * w.channels * FRAME_MS / 1000));
    const activeFloor = Math.pow(10, ACTIVE_FRAME_DBFS / 20);
    let sum = 0, peak = 0, frames = 0, active = 0, fSum = 0, fCount = 0;
    for (let i = 0; i < samples; i++) {
        const s = w.buf.readInt16LE(w.dataOff + i * 2) / 32768;
        const sq = s * s;
        sum += sq;
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
        fSum += sq;
        if (++fCount === perFrame) {
            frames++;
            if (Math.sqrt(fSum / fCount) > activeFloor) active++;
            fSum = 0; fCount = 0;
        }
    }
    if (fCount) { frames++; if (Math.sqrt(fSum / fCount) > activeFloor) active++; }
    const rms = Math.sqrt(sum / Math.max(1, samples));
    const db = v => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    return {
        ok: true,
        seconds: +(samples / (w.rate * (w.channels || 1))).toFixed(3),
        rate: w.rate,
        peakDb: +db(peak).toFixed(1),
        rmsDb: +db(rms).toFixed(1),
        frames, activeFrames: active
    };
}

/** whisper.cpp's own JSON output: segments with millisecond offsets. */
function parseWhisperJson(file) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const all = (raw.transcription || []).map(s => ({
        from: (s.offsets && s.offsets.from != null) ? +(s.offsets.from / 1000).toFixed(2) : null,
        to: (s.offsets && s.offsets.to != null) ? +(s.offsets.to / 1000).toFixed(2) : null,
        text: String(s.text || "").trim()
    }));
    // layer 2: a segment with no words in it never becomes transcript text.
    // The count is kept and returned, because a dropped segment is a fact
    // about the recording and deleting the evidence is how this got missed.
    const segments = all.filter(s => !isNonSpeechText(s.text));
    return {
        text: segments.map(s => s.text).join(" ").replace(/\s+/g, " ").trim(),
        segments,
        blankSegments: all.length - segments.length
    };
}

async function transcribe(root, args = {}, ctx = {}) {
    if (!root) throw new ToolError("link a workspace folder first");
    if (!fs.existsSync(whisperBin())) {
        throw new ToolError("speech-to-text is not installed in this build");
    }
    const model = modelFile();
    if (!model) {
        throw new ToolError("no speech model found — expected ggml-base.en-q5_1.bin " +
            `in ${whisperDir()} or the models folder`);
    }
    const rel = String(args.path || "").trim();
    if (!rel) throw new ToolError('transcribe_audio needs a path, e.g. {"path": "notes.m4a"}');
    const full = resolveInRoot(root, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        throw new ToolError(`no such file: ${rel}`);
    }
    const ext = path.extname(full).toLowerCase();
    if (!AUDIO_EXT.has(ext)) {
        throw new ToolError(`not an audio or video file (${[...AUDIO_EXT].join(" ")})`);
    }
    if (fs.statSync(full).size > MAX_AUDIO_BYTES) {
        throw new ToolError("file is too large to transcribe (500 MB cap)");
    }

    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    const cancelToken = ctx.cancelToken || {};

    // Duration first: it is the honest basis for both the refusal and the
    // "this will take a while" note. Roughly real-time on CPU for base.en.
    let seconds = null;
    if (mediaTools.available()) {
        try {
            const probe = await mediaTools.PROBE_ENTRY.run(root, { path: rel }, {});
            seconds = probe && probe.seconds ? Math.round(probe.seconds) : null;
        } catch { /* duration is a nicety, not a gate */ }
    }
    if (seconds && seconds > MAX_SECONDS) {
        throw new ToolError(`that is ${(seconds / 3600).toFixed(1)} hours of audio — ` +
            "split it before transcribing (4 hour cap)");
    }

    // whisper.cpp wants 16 kHz mono PCM. A phone recording never is.
    const tmp = path.join(os.tmpdir(),
        `lcl-stt-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const wav = tmp + ".wav";
    let converted = false;
    if (!mediaTools.available()) {
        throw new ToolError("ffmpeg is required to prepare audio and is missing from this build");
    }
    onNote(`preparing audio${seconds ? ` (${Math.round(seconds / 60)} min)` : ""}`);
    const conv = await run(mediaTools.ffmpegBin(),
        ["-y", "-loglevel", "error", "-i", full, "-ar", "16000", "-ac", "1",
         "-c:a", "pcm_s16le", wav], CONVERT_TIMEOUT_MS);
    if (conv.code !== 0 || !fs.existsSync(wav)) {
        throw new ToolError(`could not decode that audio: ${(conv.err || "").slice(-160)}`);
    }
    converted = true;

    try {
        if (cancelToken.cancelled) throw new ToolError("cancelled");
        onNote(seconds
            ? `transcribing ${Math.round(seconds / 60)} min of audio — roughly real time`
            : "transcribing");

        const outBase = tmp;
        const wArgs = ["-m", model, "-f", wav, "-oj", "-of", outBase, "-np", "-pp"];
        if (args.language) wArgs.push("-l", String(args.language).slice(0, 8));
        if (args.translate) wArgs.push("-tr");
        const threads = Math.max(1, Math.min(8, Math.floor((os.cpus().length || 4) / 2)));
        wArgs.push("-t", String(threads));

        let lastTick = 0;
        const r = await run(whisperBin(), wArgs, TRANSCRIBE_TIMEOUT_MS, (chunk) => {
            // whisper prints progress to stdout with -pp; throttle it
            const m = /progress\s*=\s*(\d+)%/i.exec(chunk);
            if (!m) return;
            const now = Date.now();
            if (now - lastTick < 3000) return;
            lastTick = now;
            onNote(`transcribing… ${m[1]}%`);
        });
        const jsonFile = outBase + ".json";
        if (r.code !== 0 || !fs.existsSync(jsonFile)) {
            throw new ToolError(`transcription failed: ${(r.err || r.out || "").slice(-200)}`);
        }
        const { text, segments, blankSegments } = parseWhisperJson(jsonFile);
        try { fs.rmSync(jsonFile, { force: true }); } catch { /* temp */ }
        if (!text) {
            return { file: rel, text: "", segments: [], words: 0, blankSegments,
                     note: "No speech was detected in that file." };
        }

        // Optional: write the transcript next to the audio, so it can be
        // indexed like any other document.
        let written = null;
        if (args.save !== false) {
            const outRel = String(args.out || rel.replace(/\.[^.]+$/, "") + ".txt");
            const outFull = resolveForWrite(root, outRel, "write");
            fs.writeFileSync(outFull, text + "\n", "utf8");
            written = path.relative(root, outFull).split(path.sep).join("/");
        }
        const words = text.split(/\s+/).filter(Boolean).length;
        return {
            file: rel, written, words, seconds, blankSegments,
            segments: segments.slice(0, 400),
            text: text.length > 20000 ? text.slice(0, 20000) + "…" : text,
            note: written
                ? `Transcribed ${words} words to ${written}.`
                : `Transcribed ${words} words.`
        };
    } finally {
        if (converted) { try { fs.rmSync(wav, { force: true }); } catch { /* temp */ } }
    }
}

/* ======================================================================
 * DICTATION LATENCY
 * ======================================================================
 *
 * Measured, on this machine, through this function, before any of it was
 * changed: a live window took 4.5 to 9.8 SECONDS to come back, and the cost
 * barely moved between a 0.5 s window and a 14 s one. The renderer fires a
 * pass every 900 ms, so every pass was already stale when it started. That
 * is the whole of "it is still slow".
 *
 * The reason it did not depend on window length: whisper pads every window
 * out to a full 30 seconds and encodes all of it. A half-second of speech
 * paid for 29.5 seconds of padding. -ac trims the encoder's context to the
 * audio that is really there, and it is the single biggest win available
 * without a resident process:
 *
 *      1 s window   4705 ms -> 1083 ms
 *      2 s window   3439 ms -> 1308 ms
 *      9 s window   4153 ms -> 1626 ms
 *
 * It has to be SCALED, not fixed. 1500 context positions cover 30 s, so
 * roughly 50 per second; measured, a 5 s window at -ac 128 came back with
 * "at least 200-thirty." and lost the rest of the sentence. The 1.6x
 * headroom below is deliberate, and above ~19 s the flag is dropped
 * entirely rather than clipped, because a clipped window loses words.
 *
 * The decoder settings are the second half, AND THEY ARE NOT APPLIED TO A
 * LONG RECORDING. Greedy with no temperature fallback returned identical
 * text to the 5-beam default on every window up to 10 s, and on the 1 s
 * window it was better — the default hallucinated "The Fixer Bathmoor",
 * greedy said "The Fixer Bath". On an 87 s recording it was measurably
 * WORSE: it dropped a sentence at a chunk boundary and repeated another.
 * So the fast decoder rides with the trimmed context and stops where it
 * stops. A live window is provisional and replaced when you stop; the pass
 * that runs at the end of a long recording is the one you keep, and it gets
 * whisper's own defaults.
 *
 * Non-speech token suppression is applied to both. It is what whisper's
 * reference implementation does by default; whisper.cpp leaves it off, which
 * is one of the reasons "[BLANK_AUDIO]" reaches a caller at all.
 *
 * Thread count is deliberately NOT raised. Measured on a 22-core machine:
 * 8 threads 1.5 s, 22 threads 5.7 s for the same window. More is worse.
 */
const CTX_PER_SECOND = 50;         // 1500 encoder positions == 30 s of audio
const CTX_HEADROOM = 1.6;
const CTX_FULL = 1500;
const CTX_MIN = 128;

/** The audio-context size for a window of this length, or null for "all". */
function audioCtxFor(seconds) {
    if (!(seconds > 0)) return null;                       // unknown: never clip
    const want = Math.ceil(seconds * CTX_PER_SECOND * CTX_HEADROOM);
    if (want >= CTX_FULL) return null;                     // long enough to need it all
    return Math.max(CTX_MIN, want);
}

/**
 * Transcribe a wav that is ALREADY 16 kHz mono PCM — the microphone path.
 *
 * The mic button records through Web Audio, which hands over raw PCM, so the
 * renderer writes a correct wav directly and this skips the ffmpeg convert the
 * file path needs. No workspace, no session, no network: dictation works in
 * every session including remote ones, and the audio never leaves the machine
 * — which is the entire reason to run whisper locally instead of an API.
 *
 * Returns { text, ms, audio, dropped, reason }. The extra fields are
 * diagnostics: ms is the real time this pass took, audio is what the window
 * actually measured, and reason names why a window produced nothing. A caller
 * that only wants words reads .text and is unaffected.
 */
async function transcribeWav(absWavPath, { language } = {}) {
    const startedAt = Date.now();
    if (!fs.existsSync(whisperBin())) {
        throw new ToolError("speech-to-text is not installed in this build");
    }
    const model = modelFile();
    if (!model) throw new ToolError("no speech model found");
    if (!fs.existsSync(absWavPath)) throw new ToolError("no audio captured");
    if (fs.statSync(absWavPath).size > 200e6) {
        throw new ToolError("that recording is too long");
    }

    // LAYER 1 — measure the window before spending anything on it.
    const audio = measureWav(absWavPath);
    if (audio.ok && audio.peakDb < SPEECH_PEAK_DBFS) {
        return { text: "", dropped: true,
                 reason: `no speech in this window (peak ${audio.peakDb} dBFS, ` +
                         `floor ${SPEECH_PEAK_DBFS} dBFS)`,
                 audio, blankSegments: 0, audioCtx: null, ms: Date.now() - startedAt };
    }

    const outBase = absWavPath.replace(/\.wav$/i, "");
    const wArgs = ["-m", model, "-f", absWavPath, "-oj", "-of", outBase, "-np", "-sns"];
    const ctx = audio.ok ? audioCtxFor(audio.seconds) : null;
    // short enough to trim: take the fast decoder with it. Long: whisper's own.
    if (ctx) wArgs.push("-ac", String(ctx), "-bs", "1", "-bo", "1", "-nf");
    if (language) wArgs.push("-l", String(language).slice(0, 8));
    const threads = Math.max(1, Math.min(8, Math.floor((os.cpus().length || 4) / 2)));
    wArgs.push("-t", String(threads));
    const r = await run(whisperBin(), wArgs, 180_000);
    const jsonFile = outBase + ".json";
    if (r.code !== 0 || !fs.existsSync(jsonFile)) {
        throw new ToolError(`transcription failed: ${(r.err || r.out || "").slice(-160)}`);
    }
    // LAYER 2 lives in parseWhisperJson: tags and punctuation never survive it.
    const { text, blankSegments } = parseWhisperJson(jsonFile);
    try { fs.rmSync(jsonFile, { force: true }); } catch { /* temp */ }
    const out = (text || "").trim();

    // LAYER 3 — a whole window that came back as one of whisper's silence
    // sentences, from audio too quiet to be dictation, is not dictation.
    if (out && audio.ok && audio.peakDb < QUIET_PEAK_DBFS && isSilenceHallucination(out)) {
        return { text: "", dropped: true,
                 reason: `silence artefact "${out}" from a quiet window ` +
                         `(peak ${audio.peakDb} dBFS)`,
                 audio, blankSegments,
                 audioCtx: wArgs.includes("-ac") ? +wArgs[wArgs.indexOf("-ac") + 1] : null,
                 ms: Date.now() - startedAt };
    }
    return {
        text: out,
        dropped: !out,
        reason: out ? null : "nothing was said in this window",
        audio, blankSegments,
        // read back off the command line that actually ran, not off the
        // intention. A readout that reports what was meant rather than what
        // happened is the defect this whole pass exists to stop repeating.
        audioCtx: wArgs.includes("-ac") ? +wArgs[wArgs.indexOf("-ac") + 1] : null,
        ms: Date.now() - startedAt
    };
}

const TOOL_ENTRY = {
    run: transcribe,
    help: 'transcribe_audio {"path": "meeting.m4a"} — transcribe speech in an audio ' +
        "or video file to text, offline; writes a .txt next to it by default"
};

module.exports = {
    available, transcribe, transcribeWav, modelFile, whisperBin, TOOL_ENTRY,
    // the blank-audio guard, exported so it can be driven directly as well as
    // through a real recording
    measureWav, isNonSpeechText, isSilenceHallucination, audioCtxFor, parseWhisperJson,
    SPEECH_PEAK_DBFS, QUIET_PEAK_DBFS
};
