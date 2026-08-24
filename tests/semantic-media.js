/**
 * Live tests for semantic_search (real bge embeddings) and the media tools
 * (real ffmpeg on a synthesized tone). No mocks — if the engines are broken,
 * these fail.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// stub electron for paths.js (dev layout)
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
// packaged mode reads process.resourcesPath (undefined under plain node);
// the repo root carries the same tools/ and knowledge/ layout, read-only
process.resourcesPath = path.join(__dirname, "..");
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
// isPackaged: TRUE, deliberately — in dev mode paths.dataDir() ignores getPath
// and resolves to the REPO's shared data/ directory, so this suite's semantic
// index entries would land in the developer's own data/semindex. Packaged mode
// routes through getPath, which is this run's throwaway directory.
require.cache[__filename] = { exports: { app: { isPackaged: true, getPath: () => LCL_TEST_DATA } } };

const embedIndex = require(__dirname + "/../.lcl.engine/core/embedIndex.js");
const mediaTools = require(__dirname + "/../.lcl.engine/core/mediaTools.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 160) : ""); }
}

(async () => {
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-sem-"));

    // ---- chunker units ----
    const chunks = embedIndex.chunkText("line one\n".repeat(400));
    check("long text chunks with overlap", chunks.length >= 3 && chunks[0].line === 1, chunks.length);
    check("cosine of identical vectors is 1",
        Math.abs(embedIndex.cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
    check("cosine of orthogonal vectors is 0",
        Math.abs(embedIndex.cosine([1, 0], [0, 1])) < 1e-9);

    // ---- live semantic search ----
    check("embed stack available (bge + llama.cpp)", embedIndex.available());

    fs.writeFileSync(path.join(WS, "recipes.md"),
        "# Grandma's soup\nSimmer the broth with carrots, celery and thyme for two hours.\n");
    fs.writeFileSync(path.join(WS, "deploy.md"),
        "# Shipping to production\nRun the build, sign the installer, upload the artifact to the release page.\n");
    fs.writeFileSync(path.join(WS, "engine-notes.md"),
        "# Memory rules\nThe watchdog kills the model process when available RAM crosses the floor.\n");

    const r1 = await embedIndex.semanticSearch(WS, { query: "how do we publish a new version" });
    console.log("   top hit for 'publish a new version':", r1.results[0] && r1.results[0].file,
        r1.results[0] && r1.results[0].score);
    check("meaning beats keywords: deploy.md wins for 'publish a new version'",
        r1.results[0] && r1.results[0].file === "deploy.md", r1.results.slice(0, 2));

    const r2 = await embedIndex.semanticSearch(WS, { query: "cooking with vegetables" });
    check("recipes.md wins for 'cooking with vegetables'",
        r2.results[0] && r2.results[0].file === "recipes.md", r2.results.slice(0, 2));
    check("second search reuses the index (no re-embeds)",
        r2.refreshedFiles === 0, r2.refreshedFiles);

    // incremental: touch one file, only it re-embeds
    fs.writeFileSync(path.join(WS, "recipes.md"),
        "# Grandma's soup\nSimmer the broth with carrots and onions overnight.\n");
    const r3 = await embedIndex.semanticSearch(WS, { query: "soup" });
    check("edited file re-embeds alone", r3.refreshedFiles === 1, r3.refreshedFiles);

    // a token-dense ~2000-char query must DEGRADE (truncate to bge-small's
    // 512-token window) rather than abort the search: it goes through embedOne,
    // not a raw embedRequest that rejects the whole call with "input is too large".
    const denseQuery = "α=1 β=2 γ=3 μ0 ε0 ℏ ∇×E ∂B/∂t Σ ∫ √ ≈ ± ∞ ".repeat(60).slice(0, 2000);
    let longOk = true, longErr = "";
    try {
        const r4 = await embedIndex.semanticSearch(WS, { query: denseQuery });
        longOk = Array.isArray(r4.results);
    } catch (e) { longOk = false; longErr = String(e.message || e); }
    check("a token-dense ~2000-char query degrades instead of aborting the whole search",
        longOk, longErr);

    // ---- live media tools ----
    check("ffmpeg stack available", mediaTools.available());

    // synthesize a 6s test tone INSIDE the workspace (spawn-array, no shell)
    const ffmpeg = path.join(__dirname, "..", "tools", "ffmpeg", "win-x64", "ffmpeg.exe");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        path.join(WS, "tone.wav")]);
    check("test tone synthesized", fs.existsSync(path.join(WS, "tone.wav")));

    const probe = await mediaTools.mediaProbe(WS, { path: "tone.wav" });
    console.log("   probe:", JSON.stringify(probe).slice(0, 140));
    check("probe reads duration ~6s", probe.seconds > 5.5 && probe.seconds < 6.5, probe.seconds);
    check("probe sees the audio stream", probe.streams.some(s => s.type === "audio"), probe.streams);

    // THE original use case: pan the volume down toward the end
    const faded = await mediaTools.mediaTransform(WS,
        { op: "fade_out", input: "tone.wav", output: "tone-faded.wav", start_seconds: 3, fade_seconds: 3 });
    check("fade_out writes a NEW file", faded.created && fs.existsSync(path.join(WS, "tone-faded.wav")), faded);
    const p2 = await mediaTools.mediaProbe(WS, { path: "tone-faded.wav" });
    check("faded copy keeps the duration", p2.seconds > 5.5 && p2.seconds < 6.5, p2.seconds);

    const trimmed = await mediaTools.mediaTransform(WS,
        { op: "trim", input: "tone.wav", output: "tone-cut.wav", start_seconds: 1, end_seconds: 3 });
    const p3 = await mediaTools.mediaProbe(WS, { path: "tone-cut.wav" });
    check("trim produces ~2s", p3.seconds > 1.5 && p3.seconds < 2.6, p3.seconds);
    check("transform result carries change-record fields",
        trimmed.written === "tone-cut.wav" && trimmed.bytes > 0 && trimmed.created === true, trimmed);

    // THE EXPLOIT the adversarial review reproduced: an in-workspace playlist
    // naming an absolute path outside the folder. ffmpeg's demuxer would have
    // opened and copied it. Both tools must refuse at the door.
    const outside = path.join(os.tmpdir(), `lcl-outside-${Date.now()}.mp3`);
    fs.writeFileSync(outside, "not really an mp3");
    fs.writeFileSync(path.join(WS, "intro.m3u8"),
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1.0,\nfile:${outside.replace(/\\/g, "/")}\n#EXT-X-ENDLIST\n`);
    let hlsBlocked = null;
    try { await mediaTools.mediaProbe(WS, { path: "intro.m3u8" }); }
    catch (e) { hlsBlocked = e.message; }
    check("HLS playlist probe refused (sandbox escape closed)",
        /playlist|manifest|extension/.test(hlsBlocked || ""), hlsBlocked);
    hlsBlocked = null;
    try {
        await mediaTools.mediaTransform(WS,
            { op: "convert", input: "intro.m3u8", output: "exfil.mp3" });
    } catch (e) { hlsBlocked = e.message; }
    check("HLS playlist transform refused", /playlist|manifest|extension/.test(hlsBlocked || ""), hlsBlocked);
    check("nothing was exfiltrated into the workspace", !fs.existsSync(path.join(WS, "exfil.mp3")));
    // a playlist DISGUISED with a media extension: magic sniff must catch it
    fs.writeFileSync(path.join(WS, "sneaky.mp3"),
        "#EXTM3U\n#EXTINF:1.0,\nfile:C:/anything\n");
    hlsBlocked = null;
    try { await mediaTools.mediaProbe(WS, { path: "sneaky.mp3" }); }
    catch (e) { hlsBlocked = e.message; }
    check("manifest magic under a media extension refused",
        /playlist|manifest/.test(hlsBlocked || ""), hlsBlocked);
    fs.rmSync(outside, { force: true });

    // guardrails
    let threw = null;
    try { await mediaTools.mediaTransform(WS, { op: "volume", input: "tone.wav", output: "tone.wav", factor: 2 }); }
    catch (e) { threw = e.message; }
    check("in-place overwrite refused", /different file|already exists/.test(threw || ""), threw);
    threw = null;
    try { await mediaTools.mediaTransform(WS, { op: "shell", input: "tone.wav", output: "x.wav" }); }
    catch (e) { threw = e.message; }
    check("unknown op refused with the whitelist", /unknown op/.test(threw || ""), threw);
    threw = null;
    try { await mediaTools.mediaProbe(WS, { path: "../../outside.mp3" }); }
    catch (e) { threw = e.message; }
    check("probe is contained to the workspace", /escapes|not a file/.test(threw || ""), threw);

    embedIndex.stop();
    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} semantic+media checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
