/**
 * OCR + its QUALITY GATE.
 *
 * The gate is the reason this module exists. Measured on a large scanned spec
 * library: 2048x1152 page captures OCR into usable prose (~2500 chars, 0.17
 * real-word ratio) while 1280x720 captures of the same pages produce ~106
 * chars of garbage. Indexing the latter would poison retrieval, so it must be
 * REPORTED AND SKIPPED — never silently stored.
 *
 * Pure-function checks always run. The recognition checks need the OCR assets
 * and a real scanned page, and skip cleanly when either is absent.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

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

const ocr = require(__dirname + "/../.lcl.engine/core/ocrTools.js");
const extTools = require(__dirname + "/../.lcl.engine/core/extTools.js");
const { execFileSync } = require("child_process");

/* A SUITE THAT NEVER FINISHES MUST NOT LOOK LIKE ONE THAT PASSED.
 *
 * MEASURED while fixing the OCR hang: an await that never settles, with no
 * handle left holding the event loop, makes node drain and exit 0 in the middle
 * of the run — no tally, no error, and an exit code anything automated would
 * read as success. That is a worse failure than the hang it replaced, because
 * the hang at least announced itself. This turns it into a loud one. */
let finished = false;
process.on("exit", (code) => {
    if (finished || code !== 0) return;
    console.log("\nFAIL | THE SUITE NEVER FINISHED — the process drained its " +
                "event loop and exited without printing a result. Something " +
                "awaited never settled.");
    process.exitCode = 1;
});

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 240) : ""); }
}

// a 1x1 PNG with a known header, for the size reader
const TINY_PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000004d20000029a0806000000" +
    "00000000000000000049454e44ae426082", "hex");

(async () => {
    // ---- textQuality: the garbage detector ----
    const realProse = "This specification defines the physical layer of the protocol and " +
        "shall be used for devices that process command data in the field.";
    const garbage = "=e © GED Ee om Ye i ot tr pio cgrse TAT tyr Spton roi in sry rnc";
    const q1 = ocr.textQuality(realProse);
    const q2 = ocr.textQuality(garbage);
    check("textQuality scores real prose above the bar",
        q1.realWordRatio >= ocr.MIN_REAL_WORD_RATIO, q1);
    check("textQuality scores OCR garbage below the bar",
        q2.realWordRatio < ocr.MIN_REAL_WORD_RATIO, q2);
    check("textQuality on empty text is 0, not NaN", ocr.textQuality("").realWordRatio === 0);
    check("textQuality separates the two by a wide margin",
        q1.realWordRatio > q2.realWordRatio * 2, { q1, q2 });

    // ---- imageSize: header parsing without decoding ----
    const tmp = path.join(os.tmpdir(), `lcl-ocr-${Date.now()}.png`);
    fs.writeFileSync(tmp, TINY_PNG);
    const dim = ocr.imageSize(tmp);
    check("imageSize reads PNG dimensions from the header",
        dim && dim.width === 1234 && dim.height === 666, dim);
    fs.rmSync(tmp, { force: true });
    check("imageSize returns null on a non-image", ocr.imageSize(__filename) === null);

    check("isImage recognises page scans", ocr.isImage("page_001.png") && ocr.isImage("a.TIFF"));
    check("isImage rejects text files", !ocr.isImage("notes.md"));

    // ---- recognition + gate, against REAL pages when available ----
    if (!ocr.available()) {
        console.log("\n-- recognition checks skipped: OCR assets not installed --");
    } else {
        /* ------------------------------------------------------------------
         * THE SAMPLE PAGES ARE GENERATED, NOT POINTED AT.
         *
         * These used to be two absolute paths into folders on one person's
         * drive. That leaked what they work on, and it meant the gate — the
         * reason this module exists — was only ever tested on that one
         * machine; everywhere else these eight checks silently skipped.
         *
         * The bundled ImageMagick renders a page of prose at 2048x1152, then
         * scales the whole frame to 1280x720, which is exactly what an
         * undersized viewer capture is. Measured on the real gate: the large
         * one clears it, the small one only clears it after the upscale, and a
         * noised copy fails it at any scale. Same three cases, on any machine,
         * with nobody's folder in the source.
         * ---------------------------------------------------------------- */
        const PAGE = [
            "Fixing removes the silver halide the developer did not reduce.",
            "A working bath holds about two hundred and fifty grams of sodium",
            "thiosulfate to the litre, and it clears an ordinary negative in",
            "ninety seconds at twenty degrees. Below two hundred and thirty",
            "grams the halide is never fully dissolved, and what remains will",
            "print through as a stain long after the film has been sleeved.",
            "",
            "The test for exhaustion is simple enough to do at the sink. Drop",
            "a clipping of undeveloped film into a measured sample and time",
            "how long it takes to go clear. When that has doubled from the",
            "fresh figure the bath is finished, whatever the label promises.",
            "",
            "Washing follows, and it is the step most often cut short.",
            "Residual thiosulfate is itself an attacking agent: it finds the",
            "image silver and converts it back, slowly, over years, in exactly",
            "the way an archival negative is not supposed to behave.",
            "",
            "None of this is difficult. It is merely unforgiving of guesswork,",
            "which is why the figures above are worth writing down somewhere",
            "other than memory."
        ].join("\n");

        const PAGES = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ocr-pages-"));
        let HI = process.env.LCL_OCR_PAGE_HI || "";
        let LO = process.env.LCL_OCR_PAGE_LO || "";
        let JUNKGEN = process.env.LCL_OCR_PAGE_JUNK || "";
        if (!HI && extTools.imageAvailable && extTools.imageAvailable()) {
            const magick = extTools.magickBin();
            const draw = (out, extra = []) => {
                execFileSync(magick, [
                    "-size", "2048x1152", "xc:white",
                    "-fill", "black", "-font", "Times-New-Roman", "-pointsize", "40",
                    "-annotate", "+80+120", PAGE, ...extra, out
                ], { stdio: "pipe", timeout: 90000 });
            };
            try {
                HI = path.join(PAGES, "page_hi.png");
                LO = path.join(PAGES, "page_lo.png");
                JUNKGEN = path.join(PAGES, "page_junk.png");
                draw(HI);
                // a real undersized capture: the same page, whole frame scaled down
                execFileSync(magick, [HI, "-resize", "1280x720!", LO],
                    { stdio: "pipe", timeout: 90000 });
                // and one that no amount of upscaling can rescue
                draw(JUNKGEN, ["-resize", "1280x720!", "+noise", "Gaussian",
                               "-blur", "0x2", "-attenuate", "3", "+noise", "Impulse"]);
            } catch { HI = LO = JUNKGEN = ""; }       // no usable font/binary; skip below
        }
        if (fs.existsSync(HI) && fs.existsSync(LO)) {
            const hi = await ocr.recognize(HI);
            check("a high-resolution spec page OCRs to usable text",
                hi.ok === true && hi.text.length > ocr.MIN_CHARS,
                { ok: hi.ok, chars: hi.text.length, conf: hi.confidence, reason: hi.reason });
            check("the usable page reads as real prose",
                hi.ok && hi.quality.realWordRatio >= ocr.MIN_REAL_WORD_RATIO, hi.quality);

            // UPSCALE-THEN-READ: a low-resolution page is enlarged and re-read
            // rather than written off. Measured on these exact pages, a 1280x720
            // capture goes from ~230 chars / 0.06 ratio (rejected) to ~2100
            // chars / 0.25 (accepted) after a lanczos upscale — the detail was
            // in the capture all along, tesseract just needed bigger glyphs.
            const lo = await ocr.recognize(LO);
            if (ocr.canUpscale()) {
                check("a low-resolution page is UPSCALED, not written off",
                    lo.upscaled >= 2, { upscaled: lo.upscaled, ok: lo.ok });
                check("upscaling recovers usable text from a 1280x720 capture",
                    lo.ok === true && lo.text.length > ocr.MIN_CHARS,
                    { ok: lo.ok, chars: (lo.text || "").length, ratio: lo.quality && lo.quality.realWordRatio });
                check("the recovered page still has to clear the quality bar",
                    lo.ok === false || lo.quality.realWordRatio >= ocr.MIN_REAL_WORD_RATIO, lo.quality);
            } else {
                check("without a resampler, a low-res page is rejected with a clear reason",
                    lo.ok === false && /resolution/i.test(lo.reason || ""), lo.reason);
            }

            // A page that is still garbage after upscaling must STILL be refused —
            // the gate is what keeps noise out of retrieval.
            const JUNK = JUNKGEN;                      // unreadable at any scale
            if (fs.existsSync(JUNK)) {
                /* THIS PAGE ONCE HUNG THE SUITE FOREVER, which is the friendly
                 * version of a document import that sits at "reading…" until
                 * the app is killed. Pure noise makes tesseract segment
                 * thousands of tiny components; leptonica prints "Image too
                 * small to scale!! (2x36 vs min width of 3)" and the worker
                 * never answers again. MEASURED: killed at 300150ms, then
                 * again with a 600s budget. A real page on this machine takes
                 * 2.6s cold and 0.94s warm, so the wait was never going to end.
                 *
                 * The guarantee is therefore not WHICH reason comes back — a
                 * noise page can legitimately fail the quality bar OR wedge the
                 * engine — but that the call RETURNS AT ALL, bounded, with the
                 * reason it actually hit. The bound is passed short here so the
                 * suite proves it in seconds instead of paying the product's
                 * generous ceiling twice. */
                const t0 = Date.now();
                const j = await ocr.recognize(JUNK, { timeoutMs: 20_000 });
                const took = Date.now() - t0;

                /* The ceiling is built from the module's OWN declared bounds
                 * rather than a magic number: the recognise bound passed in,
                 * plus the upscale bound, because this page is undersized and
                 * is enlarged before it is read. MEASURED on this machine with
                 * a 20s recognise bound: 37.4s and 41.1s — the enlargement of a
                 * noisy 1280x720 frame to 5120x2880 is most of the rest. */
                const ceiling = 20_000 + ocr.UPSCALE_TIMEOUT_MS;
                check("AN UNREADABLE PAGE CANNOT HANG THE APP — every stage of " +
                      "the read is bounded, so the whole read is bounded",
                    took < ceiling, { took, ceiling });

                check("a page that is unreadable even upscaled is still rejected",
                    j.ok === false, { ok: j.ok, reason: j.reason });

                check("...and the refusal says WHICH wall it hit — the quality " +
                      "bar with an upscale already tried, or the engine giving " +
                      "up on the page — never a bare failure",
                    j.ok === false &&
                    (/quality bar/i.test(j.reason || "") && /upscale/i.test(j.reason || "")
                     || /stopped answering/i.test(j.reason || "")),
                    j.reason);
            }

            /* The bound above cannot be proven by a page, because a page that
             * hangs the engine is exactly what we no longer have. Prove it
             * against a worker that never answers — this is the check that
             * fails if the bound is ever removed. */
            {
                const never = { recognize: () => new Promise(() => {}) };
                const t0 = Date.now();
                const r = await ocr.recognizeBounded(never, "irrelevant.png", 900);
                const took = Date.now() - t0;
                check("THE BOUND ITSELF: a worker whose promise never settles " +
                      "resolves as a timeout rather than hanging the caller",
                    r && r.timedOut === true && r.data === null && took >= 850 && took < 6000,
                    { timedOut: r && r.timedOut, took });

                const fine = { recognize: async () => ({ data: { text: "ok", confidence: 90 } }) };
                const good = await ocr.recognizeBounded(fine, "irrelevant.png", 5000);
                check("...and a worker that answers normally is not penalised by it",
                    good && good.timedOut === false && good.data && good.data.text === "ok",
                    good);

                const angry = { recognize: async () => { throw new Error("decode failed"); } };
                const bad = await ocr.recognizeBounded(angry, "irrelevant.png", 5000);
                check("...and an engine error is carried back as an error, not " +
                      "silently turned into a timeout",
                    bad && bad.timedOut === false && !!bad.error, bad && String(bad.error));
            }

            check("A SLIVER IS NEVER HANDED TO THE ENGINE — the crop that wedged " +
                  "it was one pixel wide, so a region under the floor is refused " +
                  "before any work is spawned",
                (await ocr.cropAndUpscale(HI, { x: 0, y: 0, w: 1, h: 36 }, 2200)) === null &&
                (await ocr.cropAndUpscale(HI, { x: 0, y: 0, w: 400, h: 300 }, 2200)) !== null);

            check("the OCR pipeline is versioned, so improvements re-examine old verdicts",
                typeof ocr.OCR_VERSION === "number" && ocr.OCR_VERSION >= 2, ocr.OCR_VERSION);
            await ocr.stop();
        } else {
            console.log("\n-- page checks skipped: no image tool to render the sample pages, " +
                        "and LCL_OCR_PAGE_HI / LCL_OCR_PAGE_LO are not set --");
        }
        try { fs.rmSync(PAGES, { recursive: true, force: true, maxRetries: 6 }); }
        catch { /* a worker may still hold one; the OS reclaims it */ }
    }

    // ---- the worker POOL: parallelism must be bounded by MEMORY, not just
    // cores. This machine froze once already by letting work outrun RAM; the
    // pool sizing is the guarantee that OCR cannot repeat it.
    check("planWorkers returns at least one worker",
        ocr.planWorkers() >= 1, ocr.planWorkers());
    check("planWorkers never exceeds a third of the cores",
        ocr.planWorkers() <= Math.max(1, Math.floor(require("os").cpus().length / 3)),
        { planned: ocr.planWorkers(), cores: require("os").cpus().length });
    check("planWorkers is capped regardless of core count", ocr.planWorkers() <= 8);

    const info = ocr.poolInfo();
    check("poolInfo reports cores, target and available memory",
        typeof info.cores === "number" && typeof info.target === "number"
        && typeof info.availableGB === "number", info);
    check("the pool starts empty (workers are created lazily)",
        info.workers === 0, info);

    // memory is the BINDING constraint: on a machine with almost nothing free,
    // the plan must collapse to a single worker rather than scale with cores
    const realFree = require("os").freemem;
    try {
        require("os").freemem = () => 2.1e9;          // just above the floor
        process.getSystemMemoryInfo = () => ({ free: 2.1e9 / 1024 });
        check("under memory pressure the pool collapses to one worker",
            ocr.planWorkers() === 1, ocr.planWorkers());
        require("os").freemem = () => 64e9;           // plenty free
        process.getSystemMemoryInfo = () => ({ free: 64e9 / 1024 });
        check("with ample memory the pool is bounded by cores, not RAM",
            ocr.planWorkers() === Math.min(8, Math.max(1,
                Math.floor(require("os").cpus().length / 3))), ocr.planWorkers());
    } finally {
        require("os").freemem = realFree;
        delete process.getSystemMemoryInfo;
    }

    // EXTRACTING THE TEXT IS THE DELIVERABLE — show it, cleaned, don't re-ask.
    // Measured: when asked to extract the text, the model summarised and
    // waited instead of showing it; the tool must show the full extracted text.
    {
        const help = ocr.TOOL_ENTRY.help;
        check("the tool tells the model to SHOW the full text, not summarise or re-ask",
            /SHOW them the full text/.test(help) && /do not just summarize/.test(help));
        check("...and to present it CLEANED of OCR noise without inventing words",
            /CLEANED/.test(help) && /never invent words/.test(help));
        check("...marking a truly unreadable stretch instead of guessing",
            /\[unclear\]/.test(help));
    }

    finished = true;
    console.log(`\n${pass}/${pass + fail} OCR checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
