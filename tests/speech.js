/**
 * SPEECH TO TEXT — offline transcription via whisper.cpp, and the dictation
 * path that writes into the message box.
 *
 * The guards are tested always; the real transcription runs only when the
 * binary, the model, ffmpeg AND a speakable sample are all present, because a
 * suite that needs a microphone is a suite nobody runs. The sample is
 * synthesised by Windows' own TTS (SAPI) when available — that makes this an
 * end-to-end proof on a clean machine: text -> spoken audio -> whisper -> text.
 *
 * THE BLANK-AUDIO CHECKS ARE NOT SYNTHETIC. Silence is generated with the
 * bundled ffmpeg and pushed through the same transcribeWav() the microphone
 * button calls. Measured here before the guard existed, that path returned
 * "You" for three seconds of digital silence and "[BLANK_AUDIO]" for three
 * seconds of room tone, and both were appended into the composer. Every check
 * below that says "nothing is emitted" fails if either comes back.
 *
 * The latency ceilings are deliberately loose — four to six times the measured
 * time, not the measured time — so they catch a lost flag rather than a busy
 * machine. Before the work they were 3.2 to 4.2 SECONDS a window; a regression
 * that drops -ac or the silence gate blows straight through them.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
// ISOLATED per run: paths.js derives the data directory from this,
// so a shared os.tmpdir() made every suite inherit whatever settings
// an earlier suite had written — an order-dependent gate that failed
// builds at random.
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const speech = require(__dirname + "/../.lcl.engine/core/speech.js");
const mediaTools = require(__dirname + "/../.lcl.engine/core/mediaTools.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 220) : ""); }
}
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };

/**
 * A wav shaped exactly the way the RENDERER writes one: a bare 44-byte
 * header, no LIST chunk, 16 kHz mono PCM. This is the only shape the
 * microphone path ever sees in the product, so the measurement has to parse
 * it — every other fixture here comes out of ffmpeg, which writes a
 * LIST/INFO chunk first and would hide a 44-byte assumption rather than
 * expose it. Mirrors wavFromPcm() in app/renderer/app.js.
 */
function rendererWav(out, int16, rate = 16000) {
    const buf = Buffer.alloc(44 + int16.length * 2);
    buf.write("RIFF", 0, "latin1");
    buf.writeUInt32LE(36 + int16.length * 2, 4);
    buf.write("WAVE", 8, "latin1");
    buf.write("fmt ", 12, "latin1");
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);           // PCM
    buf.writeUInt16LE(1, 22);           // mono
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36, "latin1");
    buf.writeUInt32LE(int16.length * 2, 40);
    for (let i = 0; i < int16.length; i++) buf.writeInt16LE(int16[i], 44 + i * 2);
    fs.writeFileSync(out, buf);
    return out;
}

/** The samples out of a 16-bit PCM wav, whatever chunks precede them. */
function samplesOf(file) {
    const b = fs.readFileSync(file);
    let off = 12;
    while (off + 8 <= b.length) {
        const id = b.toString("latin1", off, off + 4);
        const size = b.readUInt32LE(off + 4);
        if (id === "data") {
            const n = Math.floor(Math.min(size, b.length - off - 8) / 2);
            const a = new Int16Array(n);
            for (let i = 0; i < n; i++) a[i] = b.readInt16LE(off + 8 + i * 2);
            return a;
        }
        off += 8 + size + (size & 1);
    }
    return new Int16Array(0);
}

/** Generate a wav with the bundled ffmpeg. Returns the path, or null. */
function ffmpegWav(out, inputArgs) {
    try {
        execFileSync(mediaTools.ffmpegBin(),
            ["-y", "-loglevel", "error", ...inputArgs, "-ac", "1", "-c:a", "pcm_s16le", out],
            { stdio: "pipe", timeout: 60000 });
        return fs.existsSync(out) ? out : null;
    } catch { return null; }
}

(async () => {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-speech-"));

    /* ---- guards, always ---- */
    check("no workspace -> refused",
        await rejects(() => speech.transcribe(null, { path: "a.wav" }, {})));
    check("missing path -> refused",
        await rejects(() => speech.transcribe(ROOT, {}, {})));
    fs.writeFileSync(path.join(ROOT, "notes.txt"), "not audio");
    check("a non-audio file -> refused",
        await rejects(() => speech.transcribe(ROOT, { path: "notes.txt" }, {})));
    check("a missing file -> refused",
        await rejects(() => speech.transcribe(ROOT, { path: "gone.mp3" }, {})));
    fs.writeFileSync(path.join(ROOT, "broken.wav"), "RIFFnot-really-a-wav");
    check("an undecodable file fails with a reason, not a crash",
        await rejects(() => speech.transcribe(ROOT, { path: "broken.wav" }, {})));
    // escaping the workspace must be impossible, same rule as every file tool
    check("a path outside the workspace -> refused",
        await rejects(() => speech.transcribe(ROOT, { path: "../outside.mp3" }, {})));

    /* =================================================================
     * BLANK AUDIO — the classifier, on the exact strings whisper emits
     * ================================================================= */
    console.log("\n-- blank-audio classifier --");
    check('"[BLANK_AUDIO]" is not speech', speech.isNonSpeechText("[BLANK_AUDIO]"));
    check('"[BLANK_AUDIO]." with punctuation is not speech',
        speech.isNonSpeechText("[BLANK_AUDIO]."));
    check("two tags in one segment are not speech",
        speech.isNonSpeechText("[BLANK_AUDIO] [BLANK_AUDIO]"));
    check('"(silence)" is not speech', speech.isNonSpeechText("(silence)"));
    check('"[Music]" is not speech', speech.isNonSpeechText("[Music]"));
    check('"*coughs*" is not speech', speech.isNonSpeechText("*coughs*"));
    check("a lone full stop is not speech", speech.isNonSpeechText("."));
    check("an ellipsis is not speech", speech.isNonSpeechText("…"));
    check("a dash is not speech", speech.isNonSpeechText(" -- "));
    check("empty is not speech", speech.isNonSpeechText("") && speech.isNonSpeechText(null));
    check("REAL WORDS SURVIVE the classifier",
        !speech.isNonSpeechText("The fixer bath must be at least 230 grams per litre."));
    check("a word in brackets mid-sentence survives",
        !speech.isNonSpeechText("the fixer bath [230 g] per litre"));
    check("a bare word is still speech at this layer",
        !speech.isNonSpeechText("you"), "layer 2 must not judge real words");

    check('"You" is a known silence hallucination',
        speech.isSilenceHallucination("You"));
    check('"Thank you." is a known silence hallucination',
        speech.isSilenceHallucination("Thank you."));
    check("a real sentence is NOT a silence hallucination",
        !speech.isSilenceHallucination("The fixer bath must be at least 230 grams per litre."));
    check("the quiet band sits above the silence gate, never below",
        speech.SPEECH_PEAK_DBFS < speech.QUIET_PEAK_DBFS,
        [speech.SPEECH_PEAK_DBFS, speech.QUIET_PEAK_DBFS]);

    /* ---- the audio-context schedule: trim short windows, never clip long ones ---- */
    console.log("\n-- audio context, scaled to the window --");
    check("a half-second window is trimmed to the floor", speech.audioCtxFor(0.5) === 128,
        speech.audioCtxFor(0.5));
    check("a 2 s window trims to 160", speech.audioCtxFor(2) === 160, speech.audioCtxFor(2));
    check("a 5 s window trims to 400", speech.audioCtxFor(5) === 400, speech.audioCtxFor(5));
    check("a 14 s window trims to 1120", speech.audioCtxFor(14) === 1120, speech.audioCtxFor(14));
    check("a 19 s window is NOT trimmed — clipping loses words",
        speech.audioCtxFor(19) === null, speech.audioCtxFor(19));
    check("a 10 minute recording is NOT trimmed",
        speech.audioCtxFor(600) === null, speech.audioCtxFor(600));
    check("an unknown duration is NOT trimmed (fail open, keep the words)",
        speech.audioCtxFor(0) === null && speech.audioCtxFor(NaN) === null);

    /* =================================================================
     * MEASURING REAL AUDIO — needs ffmpeg only
     * ================================================================= */
    if (!mediaTools.available()) {
        console.log("\n-- ffmpeg missing: audio measurement checks skipped --");
    } else {
        console.log("\n-- measuring real audio --");
        const silence = ffmpegWav(path.join(ROOT, "silence.wav"),
            ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "3"]);
        check("ffmpeg produced a silent wav", !!silence);
        const m = speech.measureWav(silence);
        check("silence measures as silence, not as header bytes",
            m.ok && m.peakDb === -Infinity && m.rmsDb === -Infinity, m);
        // REGRESSION: an earlier measurement assumed a 44-byte header and read
        // ffmpeg's LIST/INFO chunk as audio, reporting silence as -0.6 dBFS.
        check("the RIFF chunks are walked, so the duration is right",
            m.ok && Math.abs(m.seconds - 3) < 0.05, m);
        check("no frame of silence is counted as active",
            m.activeFrames === 0 && m.frames > 100, m);

        const room = ffmpegWav(path.join(ROOT, "room.wav"),
            ["-f", "lavfi", "-i", "anoisesrc=r=16000:a=0.0008:d=3"]);
        const mr = speech.measureWav(room);
        check("room tone measures below the speech floor",
            mr.ok && mr.peakDb < speech.SPEECH_PEAK_DBFS, mr);

        const loud = ffmpegWav(path.join(ROOT, "loud.wav"),
            ["-f", "lavfi", "-i", "anoisesrc=r=16000:a=0.03:d=3"]);
        const ml = speech.measureWav(loud);
        check("audible noise measures ABOVE the speech floor, so it is not gated",
            ml.ok && ml.peakDb > speech.SPEECH_PEAK_DBFS, ml);

        check("a file that is not 16-bit PCM measures ok:false (fail open)",
            speech.measureWav(path.join(ROOT, "broken.wav")).ok === false);

        // THE SHAPE THE PRODUCT ACTUALLY SENDS. Everything above came from
        // ffmpeg; the microphone never does. A 44-byte header must measure
        // the same as a 78-byte one.
        const bareSil = rendererWav(path.join(ROOT, "bare-silence.wav"),
            new Int16Array(16000 * 3));
        const mb = speech.measureWav(bareSil);
        check("a renderer-shaped 44-byte-header wav measures correctly",
            mb.ok && mb.rate === 16000 && Math.abs(mb.seconds - 3) < 0.01
            && mb.peakDb === -Infinity, mb);
    }

    /* =================================================================
     * THE REAL DICTATION PATH — whisper + ffmpeg
     * ================================================================= */
    if (!speech.available()) {
        console.log("\n-- whisper not installed: transcription checks skipped --");
    } else if (!mediaTools.available()) {
        console.log("\n-- ffmpeg missing: transcription checks skipped --");
    } else {
        console.log("\n-- blank audio through the REAL microphone path --");
        // Measured before the guard: 3200 ms and the word "You".
        const silence = path.join(ROOT, "silence.wav");
        let t0 = Date.now();
        const rs = await speech.transcribeWav(silence);
        const silMs = Date.now() - t0;
        console.log(`     3 s of digital silence -> ${JSON.stringify(rs.text)} in ${silMs} ms`);
        check("3 s of digital silence emits NOTHING", rs.text === "", rs);
        check("a silent window says why it was dropped, it does not go quiet about it",
            rs.dropped === true && /peak/.test(String(rs.reason)), rs);
        check("a silent window costs nothing — whisper is never started",
            silMs < 500, silMs + " ms");

        // Measured before the guard: 3400 ms and the string "[BLANK_AUDIO]".
        const room = path.join(ROOT, "room.wav");
        t0 = Date.now();
        const rr = await speech.transcribeWav(room);
        const roomMs = Date.now() - t0;
        console.log(`     3 s of room tone      -> ${JSON.stringify(rr.text)} in ${roomMs} ms`);
        check("3 s of room tone emits NOTHING", rr.text === "", rr);
        check("no [BLANK_AUDIO] reaches the caller, ever",
            !/\[?BLANK_AUDIO\]?/i.test(rr.text || ""), rr);

        // Loud enough to clear the gate, so whisper really runs on it.
        const loud = path.join(ROOT, "loud.wav");
        const rl = await speech.transcribeWav(loud);
        console.log(`     3 s of audible noise  -> ${JSON.stringify(rl.text)} in ${rl.ms} ms`);
        check("audible noise reaches whisper but still contributes no tag text",
            !/^[[(*<]/.test(String(rl.text || "").trim()), rl);
        check("the measurement is reported, not hidden",
            rl.audio && typeof rl.audio.peakDb === "number", rl.audio);

        /* ---- layer 2, against output whisper really produced ----
         * The energy gate means room tone never normally reaches the decoder,
         * so the segment filter is proven here on a JSON file made by running
         * the real binary the way it ran before this work: no -sns, whisper's
         * default beam search. That is the run that returns "[BLANK_AUDIO]". */
        const rawOut = path.join(ROOT, "rawjson");
        try {
            execFileSync(speech.whisperBin(),
                ["-m", speech.modelFile(), "-f", room, "-oj", "-of", rawOut, "-np"],
                { stdio: "pipe", timeout: 180000, cwd: path.dirname(speech.whisperBin()) });
        } catch { /* checked below */ }
        const rawJson = rawOut + ".json";
        if (!fs.existsSync(rawJson)) {
            console.log("     -- whisper produced no JSON: segment-filter check skipped --");
        } else {
            const emitted = (JSON.parse(fs.readFileSync(rawJson, "utf8")).transcription || [])
                .map(s => String(s.text || "").trim());
            console.log("     whisper's own segments for room tone:", JSON.stringify(emitted));
            check("whisper really does emit a blank-audio tag (the defect is real)",
                emitted.some(t => /BLANK_AUDIO|silence|^\s*$/i.test(t)), emitted);
            const parsed = speech.parseWhisperJson(rawJson);
            check("and parseWhisperJson lets none of it through",
                parsed.text === "" && parsed.segments.length === 0, parsed);
            check("while counting what it dropped",
                parsed.blankSegments === emitted.length, parsed);
        }

        /* ---- real speech: everything above must not have eaten it ---- */
        const SPOKEN = "The fixer bath must be at least two hundred thirty grams per litre.";
        const wav = path.join(ROOT, "dictated.wav");
        let made = false;
        try {
            // Windows SAPI: synthesise the sentence so the test needs no fixture
            execFileSync("powershell", ["-NoProfile", "-Command",
                "Add-Type -AssemblyName System.Speech; " +
                "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
                `$s.SetOutputToWaveFile('${wav.replace(/\\/g, "\\\\")}'); ` +
                `$s.Speak('${SPOKEN}'); $s.Dispose()`],
                { stdio: "pipe", timeout: 60000 });
            made = fs.existsSync(wav) && fs.statSync(wav).size > 1000;
        } catch { made = false; }

        if (!made) {
            console.log("\n-- no TTS available to synthesise a sample: skipped --");
        } else {
            console.log("\n-- the file path --");
            const r = await speech.transcribe(ROOT, { path: "dictated.wav" }, {});
            const got = String(r.text || "").toLowerCase();
            check("transcribes real speech", got.length > 0, r.text);
            // whisper spells numbers its own way; check the words that carry meaning
            check("the words that matter come through",
                /fixer/.test(got) && /grams/.test(got), r.text);
            check("a transcript file is written next to the audio",
                r.written === "dictated.txt" && fs.existsSync(path.join(ROOT, "dictated.txt")),
                r.written);
            check("timestamped segments are returned",
                Array.isArray(r.segments) && r.segments.length > 0
                && typeof r.segments[0].from === "number", r.segments && r.segments[0]);
            check("the word count is reported", r.words > 0, r.words);
            check("dropped segments are counted, not silently discarded",
                typeof r.blankSegments === "number", r.blankSegments);
            check("no segment of the transcript is a bracketed tag",
                r.segments.every(s => !speech.isNonSpeechText(s.text)), r.segments);

            const r2 = await speech.transcribe(ROOT, { path: "dictated.wav", save: false }, {});
            check("save:false returns text without writing a file", r2.written === null);

            /* ---- LATENCY, on the windows live dictation actually sends ---- */
            console.log("\n-- live dictation latency --");
            const mic16 = ffmpegWav(path.join(ROOT, "mic16.wav"), ["-i", wav, "-ar", "16000"]);
            const win2 = ffmpegWav(path.join(ROOT, "win2.wav"), ["-i", mic16, "-t", "2", "-ar", "16000"]);
            const rw = await speech.transcribeWav(win2);
            console.log(`     2 s window -> ${JSON.stringify(rw.text)} in ${rw.ms} ms ` +
                        `(ctx ${rw.audioCtx})`);
            check("a 2 s live window still transcribes its words",
                /fixer/i.test(rw.text || ""), rw.text);
            check("a 2 s live window is trimmed to its own length",
                rw.audioCtx === 160, rw.audioCtx);
            // measured 638 ms here, 4179 ms before the work. 2500 ms catches a
            // dropped flag without failing on a loaded machine.
            check("a 2 s live window comes back in under 2.5 s",
                rw.ms < 2500, rw.ms + " ms");

            const rf = await speech.transcribeWav(mic16);
            console.log(`     whole clip -> ${rf.ms} ms (ctx ${rf.audioCtx})`);
            check("the whole-clip pass keeps its words",
                /fixer/i.test(rf.text || "") && /grams/i.test(rf.text || ""), rf.text);

            /* ---- and again in the exact wav the microphone produces ---- */
            console.log("\n-- the renderer's own wav shape, end to end --");
            const bareSpeech = rendererWav(path.join(ROOT, "bare-speech.wav"),
                samplesOf(mic16));
            const rb = await speech.transcribeWav(bareSpeech);
            console.log(`     44-byte-header speech -> ${JSON.stringify(rb.text)} in ${rb.ms} ms`);
            check("speech in a renderer-shaped wav transcribes",
                /fixer/i.test(rb.text || ""), rb);
            const bareSilence = path.join(ROOT, "bare-silence.wav");
            const rbs = await speech.transcribeWav(bareSilence);
            console.log(`     44-byte-header silence -> ${JSON.stringify(rbs.text)} in ${rbs.ms} ms`);
            check("silence in a renderer-shaped wav emits NOTHING, fast",
                rbs.text === "" && rbs.dropped === true && rbs.ms < 500, rbs);

            /* ---- layer 3: a silence hallucination out of a quiet window ---- */
            console.log("\n-- the quiet-window artefact rule --");
            const ty = path.join(ROOT, "thanks.wav");
            let tyMade = false;
            try {
                execFileSync("powershell", ["-NoProfile", "-Command",
                    "Add-Type -AssemblyName System.Speech; " +
                    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
                    `$s.SetOutputToWaveFile('${ty.replace(/\\/g, "\\\\")}'); ` +
                    "$s.Speak('Thank you.'); $s.Dispose()"],
                    { stdio: "pipe", timeout: 60000 });
                tyMade = fs.existsSync(ty) && fs.statSync(ty).size > 1000;
            } catch { tyMade = false; }
            if (!tyMade) {
                console.log("     -- no TTS sample: quiet-window checks skipped --");
            } else {
                const audible = ffmpegWav(path.join(ROOT, "thanks-loud.wav"),
                    ["-i", ty, "-af", "volume=-20dB", "-ar", "16000"]);
                const ra = await speech.transcribeWav(audible);
                console.log(`     "thank you" at ${speech.measureWav(audible).peakDb} dBFS -> ` +
                            JSON.stringify(ra.text));
                check("a REAL 'thank you' that anyone could hear is KEPT",
                    /thank/i.test(ra.text || ""), ra);

                const inaudible = ffmpegWav(path.join(ROOT, "thanks-quiet.wav"),
                    ["-i", ty, "-af", "volume=-45dB", "-ar", "16000"]);
                const rq = await speech.transcribeWav(inaudible);
                console.log(`     "thank you" at ${speech.measureWav(inaudible).peakDb} dBFS -> ` +
                            JSON.stringify(rq.text) + " | " + rq.reason);
                check("the same phrase out of an inaudible window is DROPPED",
                    rq.text === "" && rq.dropped === true, rq);
                check("and the drop names the artefact and the level it measured",
                    /artefact/.test(String(rq.reason)) && /dBFS/.test(String(rq.reason)),
                    rq.reason);
            }
        }
    }

    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} speech checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
