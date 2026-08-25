const fs = require("fs");
const path = require("path");
const { ToolError, resolveInRoot } = require("./fsTools");

/**
 * Document reading. PDFs are the daily-driver format the plain read_file
 * tool cannot touch (binary sniff rightly refuses them). pdf.js extracts
 * text fully offline; output is capped and pageable so a small-context
 * model is never handed a book.
 */

const MAX_PDF_BYTES = 50_000_000;
const TEXT_CAP_CHARS = 16_000;
const MAX_PAGES_PER_CALL = 20;

let pdfjsPromise = null;
function pdfjs() {
    // ESM-only package loaded once via dynamic import from CJS. Resolved to a
    // file URL through require's resolver FIRST: the engine core lives outside
    // app/, and ESM bare-specifier resolution does not follow the junction or
    // Module.globalPaths that make CJS requires work from here.
    if (!pdfjsPromise) {
        const { pathToFileURL } = require("url");
        pdfjsPromise = import(pathToFileURL(
            require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
    }
    return pdfjsPromise;
}

function available() {
    try { require.resolve("pdfjs-dist/package.json"); return true; }
    catch { return false; }
}

async function readPdf(root, { path: relPath, page_start = 1, page_end } = {}, ctx = {}) {
    const full = resolveInRoot(root, relPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        throw new ToolError(`not a file: ${relPath}`);
    }
    if (path.extname(full).toLowerCase() !== ".pdf") {
        throw new ToolError("read_pdf only reads .pdf files — use read_file for text");
    }
    if (fs.statSync(full).size > MAX_PDF_BYTES) {
        throw new ToolError("PDF is too large (50 MB cap)");
    }

    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote(`opening ${relPath}`);

    const lib = await pdfjs();
    const data = new Uint8Array(fs.readFileSync(full));
    let doc;
    try {
        doc = await lib.getDocument({
            data,
            // hard offline posture: never fetch fonts/resources from anywhere
            disableFontFace: true,
            isEvalSupported: false,
            useSystemFonts: false
        }).promise;
    } catch (err) {
        throw new ToolError(`could not open the PDF: ${String(err.message || err).slice(0, 120)}`);
    }

    try {
        const total = doc.numPages;
        const start = Math.max(1, Math.min(Number(page_start) || 1, total));
        const wantedEnd = page_end === undefined ? total : Number(page_end) || start;
        const end = Math.max(start, Math.min(wantedEnd, total, start + MAX_PAGES_PER_CALL - 1));

        let text = "";
        let truncated = false;
        let lastPageRead = start - 1;
        // how much the TEXT LAYER actually yielded — a scanned-era PDF has
        // none, and a run of empty page markers must never be handed to the
        // model as if it were content (the live session turned exactly that
        // into "The PDF contains text across 20 pages", invented wholesale)
        let textChars = 0;
        for (let p = start; p <= end; p++) {
            onNote(`reading page ${p}/${total}`);
            const page = await doc.getPage(p);
            const content = await page.getTextContent();
            const pageText = content.items.map(i => i.str).join(" ")
                .replace(/[ \t]{2,}/g, " ").trim();
            textChars += pageText.length;
            const block = `--- page ${p} ---\n${pageText}\n`;
            if (text.length + block.length > TEXT_CAP_CHARS) {
                truncated = true;
                text += block.slice(0, TEXT_CAP_CHARS - text.length);
                lastPageRead = p;
                break;
            }
            text += block;
            lastPageRead = p;
        }

        /* A SCANNED PDF IS NOT AN EMPTY PDF. Under ~20 chars across the whole
         * range means there is no text layer — the pages are images. The app
         * has had a full recovery pipeline for exactly this (pdfRaster renders
         * the page in a hidden window, ocrTools reads it) since the knowledge
         * indexer needed it — but read_pdf, the tool the operator actually
         * asks, never reached for it. Chapter 1.pdf, live: 26 pages, all
         * empty, answered with hallucinated confidence. Now the same recovery
         * runs here, bounded per call because OCR costs seconds per page; when
         * the pipeline is unavailable the result SAYS scanned and forbids
         * inventing content, instead of handing back 20 blank markers. */
        // per-page average, not an absolute floor: a legitimate one-line PDF
        // ("Invoice 42", 10 chars) is real text, while a 26-page scan whose
        // pages carry a stray header averages ~1 char/page — the invoice test
        // caught the absolute floor eating real text on the first run
        const pagesRead = lastPageRead - start + 1;
        if (pagesRead > 0 && textChars / pagesRead < 5) {
            const ocrTools = require("./ocrTools");
            const pdfRaster = require("./pdfRaster");
            const MAX_OCR_PAGES = 6;
            if (ocrTools.available() && pdfRaster.available()) {
              // the WHOLE pipeline attempt degrades honestly: the installed
              // build shipped without the raster window's html once, and the
              // raw ERR_FILE_NOT_FOUND that escaped here read to the model as
              // "storage problem" — it told the operator to link a workspace,
              // for the third time, for a file that was already attached
              try {
                /* THE EXTRACTION GOES TO A FILE, NOT THROUGH THE MODEL'S MOUTH.
                 *
                 * The first shape of this returned 6 OCR pages per call as tool
                 * text: 26 pages became six 40-second tool rounds and then TEN
                 * MINUTES of a 120B model re-typing 28k characters into chat —
                 * and the operator watched a stale wrong answer the whole time.
                 * The transcribe_audio pattern is the right one: the full text
                 * is WRITTEN BESIDE THE SOURCE, page by page as it reads (a
                 * crash keeps the pages already done), and the model gets the
                 * file's name plus a sample. Details are then read back with
                 * read_file and quoted verbatim — nothing is ever relayed
                 * through a context window again. With no relay to pay for,
                 * one call handles the whole document (bounded at 40 pages).
                 */
                // sized by the CALLER'S ask (page_end, default the whole doc),
                // not by the 20-page text-extraction window — with the relay
                // gone there is no reason to stop six pages in
                const OCR_PAGE_CAP = 40;
                const ocrEnd = Math.min(wantedEnd, total, start + OCR_PAGE_CAP - 1);
                const nPages = ocrEnd - start + 1;
                const outName = path.basename(relPath, path.extname(relPath)) + ".ocr.txt";
                const outFull = path.join(path.dirname(full), outName);
                const outRel = path.posix.join(path.posix.dirname(
                    String(relPath).split(path.sep).join("/")), outName)
                    .replace(/^\.\//, "");
                // the estimate is said UP FRONT — a multi-minute grind with no
                // stated horizon reads as a hang from the operator's chair
                onNote(`no text layer — ${total} scanned page(s); OCR-reading ` +
                    `${nPages} (pages ${start}-${ocrEnd}) at ~4s each, about ` +
                    `${Math.max(1, Math.round(nPages * 4 / 60))} min — writing the text to ` +
                    `${outName} as it reads`);
                if (start === 1 || !fs.existsSync(outFull)) fs.writeFileSync(outFull, "");
                let ocrText = "";
                let okPages = 0;
                const rdoc = await pdfRaster.openDoc(full);
                try {
                    for (let p = start; p <= ocrEnd; p++) {
                        onNote(`OCR page ${p}/${total}`);
                        let png = null;
                        let block;
                        try {
                            png = await rdoc.renderPageToFile(p, 2);
                            const res = await ocrTools.recognize(png, { minHeight: 1 });
                            block = `--- page ${p} (OCR) ---\n` +
                                ((res && res.ok) ? (okPages++, String(res.text || "").trim())
                                    : `[unreadable: ${(res && res.reason) || "OCR failed"}]`) + "\n";
                        } catch (err) {
                            block = `--- page ${p} (OCR) ---\n[failed: ` +
                                `${String(err.message || err).slice(0, 80)}]\n`;
                        } finally {
                            if (png) { try { fs.rmSync(png, { force: true }); } catch { /* temp */ } }
                        }
                        fs.appendFileSync(outFull, block);
                        ocrText += block;
                    }
                } finally { rdoc.close(); }
                const more = ocrEnd < Math.min(wantedEnd, total);
                return {
                    file: relPath, pages: total, pageStart: start, pageEnd: ocrEnd,
                    scanned: true, ocr: true, ocrPagesRead: okPages,
                    savedAs: outRel,
                    // a SAMPLE only — the file is the authoritative copy
                    text: ocrText.trim().slice(0, 4000),
                    truncated: true,
                    note: `this PDF has no text layer (scanned pages). The COMPLETE OCR text ` +
                        `of pages ${start}-${ocrEnd} is saved in "${outRel}" — the text above is ` +
                        `only a sample. To show or quote any of it, read "${outRel}" with ` +
                        `read_file and reproduce the content verbatim` +
                        (more ? `; for the remaining pages continue with ` +
                            `{"path": "${relPath}", "page_start": ${ocrEnd + 1}}` : "")
                };
              } catch (err) {
                onNote(`OCR pipeline failed: ${String(err.message || err).slice(0, 80)}`);
                // fall through to the honest scanned result below
              }
            }
            return {
                file: relPath, pages: total, pageStart: start, pageEnd: lastPageRead,
                scanned: true, text: "",
                truncated: false,
                note: "this PDF has NO TEXT LAYER — the pages are scanned images, and " +
                    "the OCR pipeline is not available in this context. Tell the user " +
                    "plainly that the pages are scans; do NOT invent or summarise " +
                    "content you have not seen, and do NOT ask them to link a " +
                    "workspace folder — a folder cannot add a text layer to a scan."
            };
        }

        return {
            file: relPath,
            pages: total,
            pageStart: start,
            pageEnd: lastPageRead,
            text: text.trim(),
            truncated: truncated || lastPageRead < wantedEnd,
            note: (truncated || lastPageRead < Math.min(wantedEnd, total))
                ? `continue with {"path": "${relPath}", "page_start": ${lastPageRead + (truncated ? 0 : 1)}}`
                : undefined
        };
    } finally {
        try { await doc.destroy(); } catch { /* released */ }
    }
}

/**
 * Full-document extraction for INDEXING (no 16KB cap): yields every page's
 * text so knowledge.js can chunk and embed a whole spec. Bounded only by a
 * page ceiling so a pathological 5000-page scan cannot run unbounded, and by
 * the same offline-font posture as readPdf. Returns [{ page, text }].
 */
/**
 * @param includeEmpty  keep pages whose text layer yields NOTHING.
 *
 * Default false, because a caller wanting prose does not want a run of blank
 * entries. But the indexer must have them: a purely scanned page has no text
 * layer at all, and dropping it here made it invisible to the rasterise+OCR
 * recovery path downstream — the exact pages that path exists for. Documents
 * whose scans carry a stray header still surfaced (they had a little text),
 * which is why the gap survived a live recovery run without being noticed.
 */
async function extractPdfPages(fullPath, { maxPages = 2000, maxBytes = MAX_PDF_BYTES, onNote = () => {}, includeEmpty = false } = {}) {
    if (fs.statSync(fullPath).size > maxBytes) {
        throw new ToolError("PDF is too large to index");
    }
    const lib = await pdfjs();
    const data = new Uint8Array(fs.readFileSync(fullPath));
    let doc;
    try {
        doc = await lib.getDocument({
            data, disableFontFace: true, isEvalSupported: false, useSystemFonts: false
        }).promise;
    } catch (err) {
        throw new ToolError(`could not open the PDF: ${String(err.message || err).slice(0, 120)}`);
    }
    try {
        const total = Math.min(doc.numPages, maxPages);
        const pages = [];
        for (let p = 1; p <= total; p++) {
            if (p % 10 === 0) onNote(`reading page ${p}/${doc.numPages}`);
            // one malformed page must not lose the rest of the document, and
            // each page is released so a 2000-page scan does not accumulate in
            // pdf.js's cache
            let page = null;
            try {
                page = await doc.getPage(p);
                const content = await page.getTextContent();
                const text = content.items.map(i => i.str).join(" ")
                    .replace(/[ \t]{2,}/g, " ").trim();
                if (text || includeEmpty) pages.push({ page: p, text });
            } catch { /* skip this page, keep going */ }
            finally { if (page) { try { page.cleanup(); } catch { /* ok */ } } }
        }
        return pages;
    } finally {
        try { await doc.destroy(); } catch { /* released */ }
    }
}

const TOOL_ENTRY = {
    run: readPdf,
    help: 'read_pdf {"path": "report.pdf", "page_start": 1, "page_end": 5} — ' +
        'extract just the TEXT from a PDF (16KB per call; the result says how to ' +
        'continue). For images, diagrams, tables, forms or scanned pages use extract_pdf.'
};

/* ============================================================ extract_pdf
 *
 * read_pdf is the cheap words-only tool. extract_pdf is the general one: it
 * pulls EVERYTHING a PDF can hold — the full text, a rendered image of every
 * page, every embedded image, per-page OCR of scanned pages, plus metadata,
 * outline, links, annotations, form values and embedded files — into a sidecar
 * "<name>.extract/" folder beside the source, and returns paths the model can
 * read and the user can see. The heavy lifting is pdfExtract.js (pure pdf.js,
 * headless-capable); rendering (pdfRaster) and OCR (ocrTools) are injected here
 * only when the app window makes them available, and the result says honestly
 * when they were not.
 */
const EXTRACT_PAGE_CAP = 30;
const EXTRACT_RENDER_SCALE = 3;                  // ~288 DPI, above tesseract's want

async function extractPdf(root, { path: relPath, page_start = 1, page_end } = {}, ctx = {}) {
    const full = resolveInRoot(root, relPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        throw new ToolError(`not a file: ${relPath}`);
    }
    if (path.extname(full).toLowerCase() !== ".pdf") {
        throw new ToolError("extract_pdf only reads .pdf files — use read_file for text");
    }
    if (fs.statSync(full).size > MAX_PDF_BYTES) {
        throw new ToolError("PDF is too large (50 MB cap)");
    }
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};

    const pdfExtract = require("./pdfExtract");
    let pdfRaster = null, ocrTools = null;
    try { pdfRaster = require("./pdfRaster"); } catch { /* headless: no render */ }
    try { ocrTools = require("./ocrTools"); } catch { /* headless: no ocr */ }

    // base comes from `full` (realpath-canonical casing), NEVER the model's
    // spelling of relPath — on NTFS "Report.pdf" and "report.pdf" are the
    // same file, and a case-variant basename would mint a second lock key
    // for the same physical sidecar, reopening the concurrent-write race
    const base = path.basename(full, path.extname(full));
    const dirName = base + ".extract";
    const outDir = path.join(path.dirname(full), dirName);
    // root-relative POSIX folder, so both the @attachments re-prefix (agent.js)
    // and the workspace viewer's relative-path reader resolve it unchanged
    const outRel = path.posix.join(
        path.posix.dirname(String(relPath).split(path.sep).join("/")), dirName)
        .replace(/^\.\//, "");

    // RENDER — a correctly-oriented image of the whole page, the only capture of
    // vector diagrams and the cleanest input for OCR. Injected from pdfRaster,
    // which needs the app window; absent in headless/test contexts.
    let rdoc = null, render = null;
    if (pdfRaster && pdfRaster.available()) {
        try {
            rdoc = await pdfRaster.openDoc(full);
            render = async (p) => { try { return await rdoc.renderPageToFile(p, EXTRACT_RENDER_SCALE); } catch { return null; } };
        } catch { rdoc = null; render = null; }
    }
    // OCR — per page, for pages with no text layer. ocrTools is tesseract.js.
    let ocr = null;
    if (ocrTools && ocrTools.available()) {
        ocr = async (png) => { try { return await ocrTools.recognize(png, { minHeight: 1 }); } catch { return null; } };
    }

    let m;
    try {
        onNote(`extracting everything from ${relPath}`);
        m = await pdfExtract.extract(full, {
            pageStart: page_start, pageEnd: page_end, outDir,
            render, ocr, onNote, pageCap: EXTRACT_PAGE_CAP,
        });
    } finally { if (rdoc) { try { rdoc.close(); } catch { /* released */ } } }

    let sample = "";
    try { sample = fs.readFileSync(path.join(outDir, "text", "full.txt"), "utf8").slice(0, 3000); }
    catch { /* no text */ }

    /* THE MAP RIDES WITH THE RESULT. Watched in a real session: a builder got
     * this result, read the first 16KB of full.txt seven times, and never
     * opened index.md or meta.json — so the document's own inventory (what is
     * on every page, where the images are, what the outline says) never
     * entered the model's context and 80% of the material was simply absent
     * from the build. The digest is that inventory, inline, paid for once. */
    const dig = [];
    const digTitle = (m.meta && (m.meta.Title || m.meta.title)) || m.file;
    dig.push(`${digTitle} — ${m.pages} page(s)` +
        (m.more ? ` (extracted ${m.pageStart}-${m.pageEnd} so far)` : ""));
    if (Array.isArray(m.outline) && m.outline.length) {
        const tops = m.outline.map(o => o && o.title).filter(Boolean).slice(0, 15);
        if (tops.length) dig.push("Outline: " + tops.join(" · "));
    }
    const perPage = Array.isArray(m.perPage) ? m.perPage : [];
    const pageLines = perPage.slice(0, 60).map(r => {
        const chars = r.textChars >= 1000
            ? (r.textChars / 1000).toFixed(1) + "k" : String(r.textChars || 0);
        return `p${r.page}: ${chars} chars` + (r.ocr ? " (OCR)" : "")
            + ((r.images || []).length ? `, ${r.images.length} image(s)` : "")
            + ((r.links || []).length ? `, ${r.links.length} link(s)` : "");
    });
    if (pageLines.length) {
        dig.push("Per page: " + pageLines.join("; ")
            + (perPage.length > 60 ? `; +${perPage.length - 60} more (see index.md)` : ""));
    }
    const digest = dig.join("\n").slice(0, 1600);

    const savedAs = path.posix.join(outRel, "index.md");
    const fullText = path.posix.join(outRel, "text", "full.txt");
    const imagesDir = path.posix.join(outRel, "images");
    const pagesDir = path.posix.join(outRel, "pages");
    const metaFile = path.posix.join(outRel, "meta.json");
    const c = m.counts;

    const note = [];
    note.push(`Extracted pages ${m.pageStart}-${m.pageEnd} of ${m.pages}.`);
    note.push(`The COMPLETE text is in "${fullText}" — read it with read_file and quote it verbatim; do not summarise from the sample.`);
    note.push(`read_file returns one slice per call — page FORWARD with {"path": "${fullText}", "fromLine": <last toLine + 1>, "lines": 400} until you reach the end; re-reading the same slice gains nothing. The "digest" field maps what is on every page.`);
    note.push(`Metadata, outline, links, annotations and form values are in "${metaFile}"; the rendered index is "${savedAs}".`);
    if (c.embeddedImages) note.push(`${c.embeddedImages} embedded image(s) saved in "${imagesDir}".`);
    if (c.renderedPages) note.push(`${c.renderedPages} full-page render(s) in "${pagesDir}".`);
    if (c.embeddedImages || c.renderedPages) note.push(`To SHOW the user a figure or page, reference its file under "${imagesDir}" or "${pagesDir}".`);
    if (m.unavailable && m.unavailable.length) {
        note.push(m.unavailable.join(" ") + " Tell the user plainly which pages are scans; do NOT invent their content, and do NOT ask them to link a folder.");
    }
    if (m.more) note.push(`Continue with {"path": "${relPath}", "page_start": ${m.pageEnd + 1}}.`);

    // FIELD ORDER IS SURVIVAL ORDER. The tool result is one JSON string cut at
    // the session's cap (4000 chars on a small local model) — whatever sits
    // past the cut does not exist for the model. The digest (what's in the
    // document) and the note (what to do next) go BEFORE the 3000-char text
    // sample, so a tight cap costs sample text, never the map or the plan.
    return {
        file: relPath, pages: m.pages, pageStart: m.pageStart, pageEnd: m.pageEnd,
        savedAs, fullText, imagesDir, pagesDir, metaFile,
        counts: c, render: m.render, ocr: m.ocr, unavailable: m.unavailable,
        digest,
        note: note.join(" "),
        text: sample, truncated: true, more: m.more,
    };
}

const EXTRACT_ENTRY = {
    run: extractPdf,
    help: 'extract_pdf {"path": "report.pdf"} — pull EVERYTHING out of a PDF (text, ' +
        'page images, embedded figures, scanned-page OCR, metadata, links, ' +
        'annotations, forms) into a "<name>.extract/" folder. Use instead of read_pdf ' +
        'for PDFs with images, diagrams, tables, forms, or scans.'
};

module.exports = { available, readPdf, extractPdf, extractPdfPages, TOOL_ENTRY, EXTRACT_ENTRY };
