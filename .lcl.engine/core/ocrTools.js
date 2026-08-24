const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ToolError, resolveInRoot } = require("./fsTools");

/**
 * Offline OCR — turning page-image scans into searchable, citable text.
 *
 * Everything runs locally: the WASM engine ships in node_modules and the
 * English traineddata sits in engine/tools/tesseract, so recognition never
 * touches the network (tesseract.js would otherwise fetch language data on
 * first use — langPath + cachePath + gzip:false pin it to our copy).
 *
 * A QUALITY GATE is the point of this module, not an afterthought. Measured on
 * a scanned spec library: 2048x1152 page captures OCR at ~2500 chars/page with
 * a 0.17 real-word ratio (usable prose), while a 1280x720 capture of the same
 * kind of page yields ~230 chars at 0.06 — garbage. Indexing that noise would
 * poison retrieval, so pages below the bar are REPORTED AND SKIPPED rather
 * than silently stored.
 *
 * UPSCALE-THEN-READ. A low-resolution page is NOT necessarily an unreadable
 * one. Tesseract wants roughly 300 DPI; a 1280x720 letter-page capture is
 * ~110 DPI and its recognition collapses — but the glyph detail is still
 * there. Enlarging with a good resampler before recognition recovers it, and
 * the measurements are decisive (same pages, raw vs 3x lanczos):
 *
 *   scanned spec p012:  232 chars conf 47 ratio 0.063  ->  2100 chars conf 62 ratio 0.253
 *   scanned spec p015:  636 chars conf 34 ratio 0.118  ->  2902 chars conf 80 ratio 0.280
 *
 * Both go from REJECTED to comfortably above the bar. That is 63% of that
 * library recovered without re-capturing a single page, so an undersized page
 * is upscaled through the bundled ffmpeg and re-read before any verdict. The
 * gate still decides — this only gives it a fair image to judge.
 */

const MIN_HEIGHT = 900;          // below this a letter-size page has too few px
const TARGET_HEIGHT = 2200;      // ~300 DPI for a letter page: what tesseract wants
const MAX_UPSCALE = 4;
const MIN_CHARS = 400;           // a real page of spec prose clears this easily
const MIN_REAL_WORD_RATIO = 0.10;
const MIN_CONFIDENCE = 45;
const MAX_IMAGE_BYTES = 40_000_000;
const UPSCALE_TIMEOUT_MS = 60_000;
const RECOGNIZE_TIMEOUT_MS = 120_000;   // one page, bounded — see recognizeBounded
const MIN_REGION_PX = 64;               // a region smaller than this holds no line
const MIN_REGION_FRAC = 0.05;           // ...nor does one under 5% of the frame

/**
 * Bump when the recognition pipeline changes in a way that could turn a
 * previously-unreadable page into a readable one. Indexes stamp entries with
 * this, so an improvement automatically re-examines pages that were written
 * off under an older version — otherwise a cached "empty" verdict, whose file
 * mtime never changes, would outlive every future fix.
 *   1: initial OCR + quality gate
 *   2: upscale-then-read for low-resolution pages
 */
const OCR_VERSION = 3;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"]);

// Frequent English + spec vocabulary. A garbage OCR pass produces very few of
// these; real prose produces many. It is a ratio, so page length cancels out.
const COMMON_WORDS = new Set(
    ("the of and to in is a for this be that with are or as by shall it not from " +
     "an at which each may all can when if any other such use used using specification " +
     "data device field message command protocol layer signal value byte bytes " +
     "response request status address must should section table figure").split(" "));

function tesseractDir() {
    // engine/tools/tesseract — resolved the same way in dev and packaged
    const paths = require("./paths");
    return path.join(paths.toolsRoot(), "tesseract");
}

function available() {
    try {
        require.resolve("tesseract.js");
        return fs.existsSync(path.join(tesseractDir(), "eng.traineddata"));
    } catch {
        return false;
    }
}

// Everything the tesseract.js worker script requires by bare specifier.
// tesseract.js has no nested node_modules, so these resolve to HOISTED copies
// which must be unpacked alongside it — see builder-config.json asarUnpack.
const WORKER_DEPS = ["bmp-js", "idb-keyval", "is-url", "regenerator-runtime",
                     "wasm-feature-detect", "zlibjs", "tesseract.js-core"];
const WORKER_START_MS = 60_000;

/**
 * The worker runs in a worker_thread loaded from a REAL path, so Node resolves
 * its requires against the unpacked tree rather than through Electron's asar
 * shim. If that tree is incomplete the worker throws MODULE_NOT_FOUND — and
 * tesseract.js never listens for a worker 'error' event, so the promise would
 * simply never settle and the whole reindex would wedge. Verify the closure
 * BEFORE spawning, and bound the wait, so a packaging regression is a clear
 * error instead of a hang.
 */
function missingWorkerDeps(workerDir) {
    const missing = [];
    for (const m of WORKER_DEPS) {
        try { require.resolve(m, { paths: [workerDir] }); }
        catch { missing.push(m); }
    }
    return missing;
}

/* --------------------------------------------------------------- the pool */
/**
 * OCR is embarrassingly parallel — every page is independent — and it was the
 * whole reason indexing crawled: one worker meant 0.8 of 22 cores busy, ~4% of
 * the machine, while a library took hours.
 *
 * The pool is sized from AVAILABLE MEMORY first and cores second, and it grows
 * lazily. That order matters: this app's cardinal sin is spawning work that
 * exhausts RAM and takes the desktop down with it, and a tesseract worker
 * holding an upscaled 2560x1440 page is not free. Cores decide how much
 * parallelism is USEFUL; memory decides how much is SAFE, and safe wins.
 */
const WORKER_RAM_BYTES = 700e6;   // measured envelope per worker incl. an upscaled page
const MEM_FLOOR_BYTES = 2.0e9;    // never plan into the last 2 GB
const MAX_WORKERS = 8;            // past this, disk and the embed server dominate

const pool = { idle: [], waiters: [], created: 0, target: 0 };

function availableBytes() {
    // freemem() undercounts on Windows (standby cache is reclaimable), so take
    // the more optimistic of the two but stay conservative overall
    try {
        const info = process.getSystemMemoryInfo && process.getSystemMemoryInfo();
        if (info && info.free) return Math.max(os.freemem(), info.free * 1024);
    } catch { /* fall through */ }
    return os.freemem();
}

/** How many workers this machine can safely run right now. */
function planWorkers() {
    const cores = os.cpus().length || 4;
    // leave a third of the machine for the OS, the embed server and ffmpeg
    const byCore = Math.max(1, Math.floor(cores / 3));
    const spare = availableBytes() - MEM_FLOOR_BYTES;
    const byRam = Math.max(1, Math.floor(spare / WORKER_RAM_BYTES));
    return Math.max(1, Math.min(byCore, byRam, MAX_WORKERS));
}

function spawnWorker() {
    const { createWorker } = require("tesseract.js");
    const dir = tesseractDir();
    // The wasm core and the worker script are real files on disk, so they
    // must be read from the UNPACKED copy when running from an asar
    // archive — require.resolve reports the in-archive path, which the
    // worker cannot load.
    const unpacked = (p) => p.replace(/\bapp\.asar\b/, "app.asar.unpacked");
    const workerPath = unpacked(path.join(
        path.dirname(require.resolve("tesseract.js/package.json")),
        "src", "worker-script", "node", "index.js"));

    if (!fs.existsSync(workerPath)) {
        return Promise.reject(new ToolError(
            `the OCR worker is missing from this build (${workerPath})`));
    }
    const missing = missingWorkerDeps(path.dirname(workerPath));
    if (missing.length) {
        return Promise.reject(new ToolError(
            "the OCR engine is incomplete in this build — these modules are not " +
            `unpacked next to the worker: ${missing.join(", ")}`));
    }

    const worker = createWorker("eng", 1, {
        langPath: dir,        // OUR traineddata — never fetched at runtime
        cachePath: dir,
        workerPath,
        gzip: false,
        logger: () => {}
    });
    // a worker that dies on load never settles its promise; never let that
    // wedge an indexing run
    let timer;
    const bounded = new Promise((_res, rej) => {
        timer = setTimeout(() => rej(new ToolError("the OCR engine did not start")),
                           WORKER_START_MS);
        if (timer.unref) timer.unref();
    });
    return Promise.race([worker, bounded]).finally(() => clearTimeout(timer));
}

/** Take a worker, creating one only while under the current safe ceiling. */
async function acquire() {
    const w = pool.idle.pop();
    if (w) return w;
    // re-plan on every growth decision: memory pressure changes DURING a run,
    // so a ceiling computed once at startup is not a safety guarantee
    pool.target = Math.max(pool.target ? 1 : 0, planWorkers());
    if (pool.created < pool.target) {
        pool.created++;
        try { return await spawnWorker(); }
        catch (e) { pool.created--; throw e; }
    }
    return new Promise(resolve => pool.waiters.push(resolve));
}

function release(worker) {
    const next = pool.waiters.shift();
    if (next) next(worker);
    else pool.idle.push(worker);
}

/** Drop a worker that errored: do not hand a broken engine to the next page. */
async function retire(worker) {
    pool.created = Math.max(0, pool.created - 1);
    try { await worker.terminate(); } catch { /* already gone */ }
    // someone may be blocked waiting for a worker that is never coming back
    const next = pool.waiters.shift();
    if (next) {
        try { pool.created++; next(await spawnWorker()); }
        catch { pool.created--; next(null); }
    }
}

/** Current pool state — surfaced so a run can report the parallelism it used. */
function poolInfo() {
    return { workers: pool.created, target: pool.target || planWorkers(),
             cores: os.cpus().length,
             availableGB: +(availableBytes() / 1e9).toFixed(1) };
}

async function stop() {
    const all = pool.idle.splice(0);
    pool.created = 0;
    pool.target = 0;
    for (const r of pool.waiters.splice(0)) r(null);
    await Promise.all(all.map(w => w.terminate().catch(() => {})));
}

/** Width/height from a PNG/JPEG header without decoding the whole image. */
function imageSize(file) {
    let fd;
    try {
        fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(32);
        fs.readSync(fd, buf, 0, 32, 0);
        if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            // JPEG: walk segments for a SOFn frame header
            const size = fs.statSync(file).size;
            let off = 2;
            const seg = Buffer.alloc(9);
            while (off < size - 9) {
                fs.readSync(fd, seg, 0, 9, off);
                if (seg[0] !== 0xff) break;
                const marker = seg[1];
                const len = seg.readUInt16BE(2);
                if (marker >= 0xc0 && marker <= 0xcf &&
                    marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { height: seg.readUInt16BE(5), width: seg.readUInt16BE(7) };
                }
                off += 2 + len;
            }
        }
        return null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ok */ } }
    }
}

/** The bundled ffmpeg, reused as an image resampler. */
function ffmpegBin() {
    const paths = require("./paths");
    return path.join(paths.toolsRoot(), "ffmpeg",
        process.platform === "win32" ? "win-x64" : "mac-arm64",
        process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}
function canUpscale() {
    try { return fs.existsSync(ffmpegBin()); } catch { return false; }
}

/**
 * Enlarge a page so tesseract sees glyphs at a size it can actually segment.
 * Returns the temp file path, or null if it could not be produced. Callers own
 * the cleanup. spawn() with an ARRAY — no shell, so a path cannot inject args.
 */
function upscale(file, factor) {
    return new Promise((resolve) => {
        const out = path.join(os.tmpdir(),
            `lcl-ocr-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
        let child;
        try {
            child = spawn(ffmpegBin(), [
                "-y", "-loglevel", "error",
                "-i", file,
                "-vf", `scale=iw*${factor}:ih*${factor}:flags=lanczos`,
                out
            ], { windowsHide: true, stdio: "ignore" });
        } catch { return resolve(null); }

        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, UPSCALE_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        child.on("error", () => { clearTimeout(timer); resolve(null); });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(out)) return resolve(out);
            try { fs.rmSync(out, { force: true }); } catch { /* nothing written */ }
            resolve(null);
        });
    });
}

/**
 * Detect the bright page regions inside a screen capture — a PDF viewer
 * screenshot is dark chrome around one or two white pages, and OCR of the
 * whole frame wastes its resolution budget on the chrome. Downsample to raw
 * grayscale through the bundled ffmpeg, find bright column bands, and return
 * full-resolution crop boxes (one per page; a two-page spread yields two).
 * Returns [] when the image IS the page (bright everywhere) or on any failure
 * — callers treat that as "no region pass possible", never an error.
 */
const DETECT_W = 160, DETECT_H = 90;
function detectPageRegions(file, dim) {
    if (!dim || !dim.width || !dim.height || !canUpscale()) return [];
    let g;
    try {
        g = execFileSync(ffmpegBin(), [
            "-v", "quiet", "-i", file,
            "-vf", `scale=${DETECT_W}:${DETECT_H}`,
            "-f", "rawvideo", "-pix_fmt", "gray", "-"
        ], { maxBuffer: 1e7, windowsHide: true });
    } catch { return []; }
    if (!g || g.length < DETECT_W * DETECT_H) return [];

    const bright = (x, y) => g[y * DETECT_W + x] > 200;
    let brightTotal = 0;
    for (let i = 0; i < DETECT_W * DETECT_H; i++) if (g[i] > 200) brightTotal++;
    // mostly-bright frame = the image already is the page; no region pass
    if (brightTotal / (DETECT_W * DETECT_H) > 0.8) return [];

    const colFrac = [];
    for (let x = 0; x < DETECT_W; x++) {
        let n = 0;
        for (let y = 0; y < DETECT_H; y++) if (bright(x, y)) n++;
        colFrac.push(n / DETECT_H);
    }
    const runs = [];
    let start = -1;
    for (let x = 0; x < DETECT_W; x++) {
        const isPage = colFrac[x] > 0.35;
        if (isPage && start < 0) start = x;
        if ((!isPage || x === DETECT_W - 1) && start >= 0) {
            const end = isPage ? x : x - 1;
            if (end - start >= 8) runs.push([start, end]);
            start = -1;
        }
    }
    const boxes = [];
    const sx = dim.width / DETECT_W, sy = dim.height / DETECT_H;
    for (const [x0, x1] of runs) {
        let y0 = DETECT_H, y1 = 0;
        for (let y = 0; y < DETECT_H; y++) {
            let n = 0;
            for (let x = x0; x <= x1; x++) if (bright(x, y)) n++;
            if (n / (x1 - x0 + 1) > 0.5) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
        if (y1 <= y0) continue;
        const w = Math.ceil((x1 - x0 + 1) * sx), h = Math.ceil((y1 - y0 + 1) * sy);
        // a run twice as wide as tall is a two-page spread the column scan
        // failed to split (thin gap): halve it
        const parts = w / h > 1.2 ? 2 : 1;
        for (let i = 0; i < parts; i++) {
            const box = {
                x: Math.max(0, Math.floor(x0 * sx) + Math.floor((w / parts) * i)),
                y: Math.max(0, Math.floor(y0 * sy)),
                w: Math.floor(w / parts),
                h: Math.min(dim.height, h)
            };
            // A SLIVER IS NOT A PAGE. On a noise-only frame the column scan
            // finds runs one detect-row tall, which scale up to boxes a few
            // pixels across; cropping those produced the 1x36 image that hung
            // the engine. A real page region in a screen capture is a large
            // fraction of the frame, so this floor costs nothing and the
            // boxes it drops could not have held a line of text anyway.
            if (box.w < MIN_REGION_PX || box.h < MIN_REGION_PX) continue;
            if (box.w < dim.width * MIN_REGION_FRAC
                || box.h < dim.height * MIN_REGION_FRAC) continue;
            boxes.push(box);
        }
    }
    return boxes;
}

/* A WEDGED ENGINE MUST NOT BECOME A WEDGED APP.
 *
 * tesseract.js hands back a promise that on some inputs simply never settles.
 * MEASURED: a one-pixel-wide crop makes leptonica print "Image too small to
 * scale!! (1x36 vs min width of 3)" and the worker never answers again — the
 * await above it hangs forever, and with it the whole read. A test suite that
 * never returns is the friendly version of that failure; the operator's is a
 * document import that sits at "reading…" until the app is killed.
 *
 * So every call into the engine is bounded, and a worker that misses its bound
 * is RETIRED rather than returned to the pool, because it is still holding the
 * page that hung it. The bound is generous — a dense 300 DPI page really can
 * take a minute — because the point is to have a ceiling, not a deadline. */
function recognizeBounded(worker, file, ms = RECOGNIZE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let done = false;
        // NOT unref'd, deliberately. The upscale timer beside this one can be,
        // because its child process holds the loop open; this timer IS the
        // guarantee, and a worker that never answers holds nothing. MEASURED
        // with it unref'd: the process drained its loop and exited 0 in the
        // middle of a run, printing no result at all — a quieter version of the
        // hang this function exists to prevent. It is cleared on every settle,
        // so it never delays a normal exit.
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve({ data: null, timedOut: true });
        }, ms);
        const settle = (v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(v);
        };
        try {
            worker.recognize(file).then(
                (r) => settle({ data: r && r.data, timedOut: false }),
                (e) => settle({ data: null, timedOut: false, error: e }));
        } catch (e) { settle({ data: null, timedOut: false, error: e }); }
    });
}

/** Crop one region and enlarge it to a height tesseract can work with. */
function cropAndUpscale(file, box, targetH) {
    // a degenerate box is not a page — and handing one to the engine is what
    // wedges it, so it is refused here as well as where boxes are built
    if (!box || !(box.w >= MIN_REGION_PX) || !(box.h >= MIN_REGION_PX)) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        const out = path.join(os.tmpdir(),
            `lcl-ocr-crop-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
        const factor = Math.max(2, Math.min(6, Math.ceil(targetH / box.h)));
        let child;
        try {
            child = spawn(ffmpegBin(), [
                "-y", "-loglevel", "error", "-i", file,
                "-vf", `crop=${box.w}:${box.h}:${box.x}:${box.y},` +
                       `scale=iw*${factor}:ih*${factor}:flags=lanczos,` +
                       "format=gray,unsharp=5:5:0.8",
                out
            ], { windowsHide: true, stdio: "ignore" });
        } catch { return resolve(null); }
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, UPSCALE_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        child.on("error", () => { clearTimeout(timer); resolve(null); });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(out)) return resolve(out);
            try { fs.rmSync(out, { force: true }); } catch { /* nothing written */ }
            resolve(null);
        });
    });
}

/** How much of this text looks like real words? Garbage OCR scores near zero. */
function textQuality(text) {
    const words = String(text || "").toLowerCase().match(/[a-z]{2,}/g) || [];
    if (!words.length) return { realWordRatio: 0, words: 0 };
    const hits = words.filter(w => COMMON_WORDS.has(w)).length;
    return { realWordRatio: +(hits / words.length).toFixed(3), words: words.length };
}

/**
 * OCR one image. Returns { ok, text, confidence, quality, width, height,
 * reason } — ok:false with a REASON when the page is below the usable bar, so
 * callers can report honestly instead of indexing noise.
 */
async function recognize(file, { minHeight = MIN_HEIGHT,
                                 timeoutMs = RECOGNIZE_TIMEOUT_MS } = {}) {
    if (!available()) throw new ToolError("OCR is not installed");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new ToolError(`not a file: ${path.basename(file)}`);
    }
    if (fs.statSync(file).size > MAX_IMAGE_BYTES) {
        return { ok: false, reason: "image is too large to OCR", text: "" };
    }

    const dim = imageSize(file);

    // An undersized page is ENLARGED, not rejected: at ~110 DPI tesseract's
    // recognition collapses even though the glyph detail is present, and a
    // lanczos upscale to roughly 300 DPI recovers it (see the header). Only if
    // we cannot upscale does low resolution become a verdict.
    let readFile = file;
    let temp = null;
    let upscaled = 0;
    if (dim && dim.height && dim.height < minHeight) {
        if (!canUpscale()) {
            return {
                ok: false, text: "", width: dim.width, height: dim.height,
                reason: `resolution too low to read (${dim.width}x${dim.height}; ` +
                        `needs ~${minHeight}px tall) and the image resampler is not ` +
                        "available in this build."
            };
        }
        const factor = Math.max(2, Math.min(MAX_UPSCALE,
            Math.ceil(TARGET_HEIGHT / dim.height)));
        temp = await upscale(file, factor);
        if (temp) { readFile = temp; upscaled = factor; }
    }

    // An engine or decode failure must come back as a RESULT with a reason, not
    // a throw: the caller turns a throw into "no chunks", which gets cached as
    // "this file is empty" and the page is then never retried or reported.
    let data;
    let worker = null;
    let broke = false;
    try {
        worker = await acquire();
        if (!worker) throw new ToolError("the OCR engine was shut down");
        const r = await recognizeBounded(worker, readFile, timeoutMs);
        if (r.timedOut) {
            throw new ToolError(
                `the OCR engine stopped answering on this page after ` +
                `${Math.round(timeoutMs / 1000)}s`);
        }
        if (r.error) throw r.error;
        data = r.data;
        if (!data) throw new ToolError("the OCR engine returned nothing");
    } catch (e) {
        broke = !!worker;   // the engine itself misbehaved — do not reuse it
        return {
            ok: false, text: "", retry: true,
            width: dim && dim.width, height: dim && dim.height,
            reason: `OCR failed on this page (${String(e.message || e).slice(0, 120)})`
        };
    } finally {
        if (worker) { if (broke) await retire(worker); else release(worker); }
        if (temp) { try { fs.rmSync(temp, { force: true }); } catch { /* already gone */ } }
    }
    const text = String(data.text || "").replace(/[ \t]{2,}/g, " ").trim();
    const q = textQuality(text);

    if (text.length < MIN_CHARS || q.realWordRatio < MIN_REAL_WORD_RATIO
        || (data.confidence || 0) < MIN_CONFIDENCE) {
        // REGION PASS. A screen capture of a PDF viewer buries one or two
        // small bright pages in dark chrome; whole-frame OCR spends its pixels
        // on the chrome and fails. Crop each detected page region, enlarge it
        // alone, and re-read. The gate still judges the result — this only
        // gives tesseract a fair image.
        const boxes = detectPageRegions(file, dim);
        if (boxes.length) {
            let regionText = "";
            const confs = [];
            for (const box of boxes) {
                const crop = await cropAndUpscale(file, box, 2200);
                if (!crop) continue;
                try {
                    const w = await acquire();
                    if (!w) break;
                    let rd = null;
                    const rr = await recognizeBounded(w, crop, timeoutMs);
                    // a worker that missed its bound is holding the crop that
                    // hung it — retire it rather than hand it to the next page
                    if (rr.timedOut) { await retire(w); continue; }
                    release(w);
                    if (rr.error || !rr.data) continue;
                    rd = rr.data;
                    const t = String(rd.text || "").replace(/[ \t]{2,}/g, " ").trim();
                    if (t) { regionText += t + "\n\n"; confs.push(rd.confidence || 0); }
                } catch { /* one bad crop must not sink the others */ }
                finally { try { fs.rmSync(crop, { force: true }); } catch { /* gone */ } }
            }
            const rq = textQuality(regionText);
            const rConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
            if (regionText.length >= MIN_CHARS && rq.realWordRatio >= MIN_REAL_WORD_RATIO
                && rConf >= MIN_CONFIDENCE) {
                return { ok: true, text: regionText.trim(), confidence: rConf,
                         quality: rq, upscaled, regions: boxes.length,
                         width: dim && dim.width, height: dim && dim.height };
            }
        }
        return {
            ok: false, text, confidence: data.confidence, upscaled,
            quality: q, width: dim && dim.width, height: dim && dim.height,
            regions: boxes.length,
            reason: `OCR output failed the quality bar (${text.length} chars, ` +
                    `${q.realWordRatio} real-word ratio, confidence ` +
                    `${Math.round(data.confidence || 0)}` +
                    (upscaled ? `, even after a ${upscaled}x upscale` : "") +
                    (boxes.length ? ` and a ${boxes.length}-region crop pass` : "") +
                    ") — not indexed, to keep noise out of search results."
        };
    }
    return { ok: true, text, confidence: data.confidence, quality: q, upscaled,
             width: dim && dim.width, height: dim && dim.height };
}

/** Is this a file OCR could apply to? */
function isImage(file) {
    return IMAGE_EXT.has(path.extname(file).toLowerCase());
}

/* ------------------------------------------------------------ tool entry */

async function readImageText(root, { path: relPath } = {}, ctx = {}) {
    if (typeof relPath !== "string" || !relPath.trim()) {
        throw new ToolError('read_image_text needs {"path": "scan.png"}');
    }
    const full = resolveInRoot(root, relPath);
    if (!isImage(full)) {
        throw new ToolError("read_image_text reads image files — use read_file for text");
    }
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote(`reading text from ${relPath}`);
    const res = await recognize(full);
    if (!res.ok) return { file: relPath, text: res.text || "", usable: false, note: res.reason };
    return {
        file: relPath,
        text: res.text.slice(0, 12_000),
        usable: true,
        confidence: Math.round(res.confidence)
    };
}

const TOOL_ENTRY = {
    run: readImageText,
    help: 'read_image_text {"path": "scan.png"} — extract text from a scanned page ' +
        'or screenshot with offline OCR (says so when a page is too low-resolution to read). ' +
        'Extracting the text IS the deliverable: when the person asked to get, strip, read, ' +
        'or pull the text out, SHOW them the full text — do not just summarize it or ask what ' +
        'they want next. Present it CLEANED: fix the obvious OCR garbling (stray | / ~ marks, ' +
        'split words, margin/binding noise, mangled line breaks) into clean readable prose, but ' +
        'never invent words that were not there. If a stretch is truly unreadable, mark it [unclear].'
};

module.exports = {
    available, recognize, isImage, imageSize, textQuality, stop, TOOL_ENTRY,
    canUpscale, OCR_VERSION, planWorkers, poolInfo,
    detectPageRegions, cropAndUpscale,
    // exported so the bound can be proven against a worker that never answers,
    // which is the only way to test it without an image that wedges the engine
    recognizeBounded,
    MIN_HEIGHT, MIN_CHARS, MIN_REAL_WORD_RATIO,
    RECOGNIZE_TIMEOUT_MS, UPSCALE_TIMEOUT_MS, MIN_REGION_PX
};
