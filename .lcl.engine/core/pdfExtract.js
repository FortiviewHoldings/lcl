/**
 * COMPREHENSIVE PDF EXTRACTION — pull EVERYTHING out of any PDF.
 *
 * The old read_pdf captured two of the ten things a PDF can hold (machine text,
 * and whole-document-gated OCR) and dropped the rest: embedded images, vector
 * diagrams, tables, form values, annotations, links, metadata, embedded files.
 * Worse, its OCR fired only when the WHOLE page range averaged under five
 * characters a page, so a scanned page sitting next to a text page vanished as a
 * blank marker. This module is the general answer: for ANY pdf it writes a
 * sidecar folder holding the complete text, a rendered image of every page, the
 * embedded images pulled out as their own files, per-page OCR of the pages that
 * have no text layer, and a metadata record of the outline, form fields,
 * annotations, links and embedded attachments.
 *
 * PURE pdf.js does the text, image, metadata and annotation work, so all of that
 * runs headless and is unit-testable without the app window. RENDERING (the only
 * way to capture vector graphics as they look) and OCR are injected — the app
 * passes pdfRaster and ocrTools; a test passes nothing and those steps degrade
 * honestly instead of lying about scanned content.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pathToFileURL } = require("url");
// temp-then-rename for every sidecar file a reader might catch half-written
const { atomicWriteSync } = require("./fsTools");

/* pdfjs is ESM-only; resolved once from the engine's own module graph. The
 * legacy build runs in bare node as well as the Electron main process. */
let pdfjsPromise = null;
function pdfjs() {
    if (!pdfjsPromise) {
        pdfjsPromise = import(pathToFileURL(
            require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
    }
    return pdfjsPromise;
}
function available() {
    try { require.resolve("pdfjs-dist/legacy/build/pdf.mjs"); return true; }
    catch { return false; }
}

/* ------------------------------------------------------------- one at a time
 * Watched in a real session: an orchestrated plan ran extract_pdf THREE times
 * concurrently on the same PDF (parallel step-turns, same tool), and the
 * interleaved appends left full.txt with 61 page markers for a 26-page
 * document, pages shuffled mid-sentence — and the builder pasted that
 * scrambled text into the product. Extraction into a given sidecar is
 * serialized here, at the writer, so EVERY caller is covered: identical
 * calls, different page windows, even two sessions on the same folder. */
const sidecarLocks = new Map();   // outDir -> tail of the promise chain (never-rejecting)
function withSidecarLock(key, fn) {
    const tail = sidecarLocks.get(key) || Promise.resolve();
    const run = tail.then(fn);
    const settled = run.then(() => {}, () => {});   // a failed run must not wedge the lock
    sidecarLocks.set(key, settled);
    settled.then(() => { if (sidecarLocks.get(key) === settled) sidecarLocks.delete(key); });
    return run;
}

/* ---------------------------------------------------------------- PNG, no deps
 * pdf.js hands back raw RGBA/RGB/1-bpp pixels; we owe a real PNG and cannot rely
 * on a native canvas resolving from the engine core. A PNG is a signature, an
 * IHDR, one zlib'd IDAT of filtered rows, and an IEND — all of which Node's own
 * zlib and a CRC table give us. This is why image extraction has no dependency
 * that can fail to install. */
const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (~c) >>> 0;
}
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}
/** Encode 8-bit RGBA pixels (w*h*4 bytes) to a PNG buffer. */
function encodePng(rgba, w, h) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6;                    // 8-bit, colour type 6 (RGBA)
    const stride = w * 4;
    const raw = Buffer.alloc((stride + 1) * h);  // one filter byte (0) per row
    for (let y = 0; y < h; y++) {
        raw[y * (stride + 1)] = 0;
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
            .copy(raw, y * (stride + 1) + 1);
    }
    const idat = zlib.deflateSync(raw, { level: 6 });
    return Buffer.concat([sig, pngChunk("IHDR", ihdr),
        pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

/* ------------------------------------------------- pdf image object -> RGBA */
function imageToRgba(img) {
    const { width: w, height: h, kind, data } = img;
    if (!w || !h || !data) return null;
    const out = Buffer.alloc(w * h * 4);
    if (kind === 3) {                            // RGBA_32BPP
        Buffer.from(data.buffer || data, data.byteOffset || 0, w * h * 4).copy(out);
    } else if (kind === 2) {                     // RGB_24BPP
        for (let i = 0, j = 0; i < w * h; i++) {
            out[j++] = data[i * 3]; out[j++] = data[i * 3 + 1];
            out[j++] = data[i * 3 + 2]; out[j++] = 255;
        }
    } else if (kind === 1) {                      // GRAYSCALE_1BPP, MSB first, set bit = white
        const rowBytes = (w + 7) >> 3;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const byte = data[y * rowBytes + (x >> 3)];
            const v = ((byte >> (7 - (x & 7))) & 1) ? 255 : 0;
            const o = (y * w + x) * 4;
            out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
        }
    } else return null;
    return { rgba: out, w, h };
}

/* Orient a decoded image to how it sits ON THE PAGE, from the current transform
 * matrix at the paint op. The raw image data is top-down; PDF user space is
 * y-up, and images are frequently placed with a negative or rotated matrix, so
 * a straight extract can come out flipped or turned (measured: a scanned page
 * came out 180°). We correct from the linear part [a b c d] of the CTM. */
function orientRgba(pix, m) {
    if (!m) return pix;
    const [a, b, c, d] = m;
    const axisAligned = Math.abs(b) <= Math.abs(a) && Math.abs(c) <= Math.abs(d);
    let { rgba, w, h } = pix;
    const px = (buf, W, x, y) => { const o = (y * W + x) * 4; return [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]; };
    const set = (buf, W, x, y, p) => { const o = (y * W + x) * 4; buf[o] = p[0]; buf[o + 1] = p[1]; buf[o + 2] = p[2]; buf[o + 3] = p[3]; };
    if (axisAligned) {
        // Handedness (the determinant sign) says whether the image is genuinely
        // MIRRORED; a<0 alone is just a rotation, not a mirror. Only a positive
        // determinant is a true horizontal flip. Vertical: a positive d means the
        // top-down image bytes map bottom-up on the y-up page, so it needs a
        // vertical flip to read upright. (Measured: a scanned page had a<0,d>0,
        // det<0 — a pure vertical flip, NOT the 180° both-flips a<0 would imply.)
        const det = a * d - b * c;
        const hFlip = det > 0, vFlip = d > 0;
        if (!hFlip && !vFlip) return pix;
        const out = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
            set(out, w, hFlip ? w - 1 - x : x, vFlip ? h - 1 - y : y, px(rgba, w, x, y));
        return { rgba: out, w, h };
    }
    // rotated 90/270: b,c dominate. Sign of b picks the direction.
    const out = Buffer.alloc(w * h * 4);
    const cw = b < 0;                             // clockwise when b negative
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const nx = cw ? h - 1 - y : y;
        const ny = cw ? x : w - 1 - x;
        set(out, h, nx, ny, px(rgba, w, x, y));
    }
    return { rgba: out, w: h, h: w };
}

/* 2D affine multiply, PDF row-vector convention: result = m (applied first) x n */
function matMul(m, n) {
    return [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ];
}

/**
 * Every embedded raster image painted on a page, in paint order, each with the
 * transform matrix in effect so it can be oriented. Pure pdf.js — works headless.
 */
async function pageImages(lib, page) {
    const ops = await page.getOperatorList();
    const OPS = lib.OPS;
    const out = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (fn === OPS.save) { stack.push(ctm.slice()); continue; }
        if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); continue; }
        if (fn === OPS.transform) { ctm = matMul(ops.argsArray[i], ctm); continue; }
        const isXObj = fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat;
        const isInline = fn === OPS.paintInlineImageXObject;
        if (!isXObj && !isInline) continue;
        let img = null;
        try {
            if (isInline) img = ops.argsArray[i][0];
            else {
                const objId = ops.argsArray[i][0];
                const store = String(objId).startsWith("g_") ? page.commonObjs : page.objs;
                // callback form — plain get() throws if the worker has not resolved it
                img = await new Promise((res) => { try { store.get(objId, res); } catch { res(null); } });
            }
        } catch { img = null; }
        const pix = img && imageToRgba(img);
        if (!pix) continue;
        out.push({ pix: orientRgba(pix, ctm), srcW: img.width, srcH: img.height });
    }
    return out;
}

/* -------------------------------------------------- geometry-aware page text
 * The old path did items.map(i => i.str).join(" "), which flattens columns and
 * tables into one interleaved line. We group text items into lines by their y
 * position and order each line left-to-right, which recovers reading order for
 * the common single- and multi-column cases without pretending to be a full
 * table parser (the page render is the honest fallback for real grids). */
function pageTextFromItems(items) {
    const lines = [];
    for (const it of items) {
        const s = (it.str || "");
        if (!s) continue;
        const x = it.transform ? it.transform[4] : 0;
        const y = it.transform ? it.transform[5] : 0;
        let line = lines.find(l => Math.abs(l.y - y) <= 2);
        if (!line) { line = { y, parts: [] }; lines.push(line); }
        line.parts.push({ x, s });
    }
    lines.sort((a, b) => b.y - a.y);             // PDF y-up: larger y is higher
    return lines.map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(" ")
        .replace(/[ \t]{2,}/g, " ").trim()).filter(Boolean).join("\n");
}

/* --------------------------------------------------------- annotation shaping */
function shapeAnnotations(anns) {
    const links = [], notes = [], widgets = [];
    for (const a of (anns || [])) {
        const st = a.subtype;
        if (st === "Link") {
            const url = a.url || a.unsafeUrl || null;
            const dest = a.dest ? (typeof a.dest === "string" ? a.dest : "internal") : null;
            if (url || dest) links.push({ url, dest });
        } else if (st === "Widget") {
            widgets.push({ field: a.fieldName || null, type: a.fieldType || null,
                value: a.fieldValue != null ? a.fieldValue : null });
        } else if (a.contents || ["Text", "Popup", "Highlight", "Underline",
            "StrikeOut", "Squiggly", "FreeText", "Ink", "Stamp"].includes(st)) {
            notes.push({ type: st, author: a.title || null,
                text: (a.contents || "").trim() || null, date: a.modificationDate || null });
        }
    }
    return { links, notes, widgets };
}

const pad = (n) => String(n).padStart(3, "0");

/**
 * Extract everything from `pdfPath` into `<outDir>/`. Options:
 *   pageStart, pageEnd   1-based window (paged like read_pdf for very large docs)
 *   render(pageNum)      optional async -> a PNG file path for the whole page,
 *                        correctly oriented (the app passes a pdfRaster-backed fn)
 *   ocr(pngPath)         optional async -> { ok, text } (the app passes ocrTools)
 *   onNote(msg)          progress
 *   pageCap              max pages this call (default 30)
 *   ocrFloorChars        a page with fewer real chars than this is treated as
 *                        scanned and OCR'd (default 10)
 * Returns a manifest describing exactly what was and was not captured.
 */
async function extract(pdfPath, opts = {}) {
    if (!opts.outDir) throw new Error("extract: outDir is required");
    // serialize per sidecar — see withSidecarLock above. The key is
    // case-folded on Windows: NTFS treats "Report.extract" and
    // "report.extract" as ONE directory, so the lock must too. (The lock is
    // per-process — the app's single main process, which every session's
    // tool call runs through; a separate headless engine run is not covered.)
    let key = path.resolve(opts.outDir);
    if (process.platform === "win32") key = key.toLowerCase();
    return withSidecarLock(key, () => extractInner(pdfPath, opts));
}

async function extractInner(pdfPath, opts = {}) {
    const {
        pageStart = 1, pageEnd, outDir,
        render = null, ocr = null, onNote = () => {},
        pageCap = 30, ocrFloorChars = 10,
    } = opts;
    const lib = await pdfjs();
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await lib.getDocument({
        data,
        disableFontFace: true, isEvalSupported: false, useSystemFonts: false,
        // FORCE raw pixel objects instead of an ImageBitmap in every environment,
        // so image bytes are always readable without a canvas.
        isOffscreenCanvasSupported: false,
    }).promise;

    const dirs = {
        root: outDir,
        text: path.join(outDir, "text"),      // full.txt — the ONE flat text source (incl. OCR)
        pages: path.join(outDir, "pages"),    // a rendered PNG of every page
        images: path.join(outDir, "images"),  // embedded figures pulled out
        files: path.join(outDir, "files"),    // files embedded inside the PDF
    };
    const firstCall = pageStart <= 1 || !fs.existsSync(dirs.root);
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const fullTxt = path.join(dirs.text, "full.txt");
    // THIS WINDOW'S TEXT ACCUMULATES IN MEMORY (30-page cap = bounded) and
    // lands in full.txt as ONE atomic write after the page loop. The old
    // truncate-then-append-per-page left a half-written file on screen for the
    // whole run and interleaved when two extractions overlapped.
    const textBlocks = [];

    const manifest = {
        file: path.basename(pdfPath), pages: doc.numPages,
        meta: {}, outline: null, pageLabels: null, isTagged: false,
        formFields: null, embeddedFiles: [], perPage: [],
        counts: { textPages: 0, ocrPages: 0, renderedPages: 0, embeddedImages: 0,
            annotations: 0, links: 0, formFields: 0, embeddedFiles: 0 },
        render: !!render, ocr: !!ocr, unavailable: [],
    };
    if (!render) manifest.unavailable.push(
        "page rendering was unavailable (needs the app window) — vector diagrams and scanned pages were not rendered to page images");
    if (!ocr) manifest.unavailable.push(
        "OCR was unavailable — pages with no text layer could not be transcribed");

    // ---- document level (each guarded so a missing feature never sinks the run)
    try { const md = await doc.getMetadata();
        manifest.meta = md && md.info ? md.info : {};
        if (md && md.metadata && md.metadata.getAll) manifest.meta._xmp = md.metadata.getAll();
    } catch { /* no metadata */ }
    try { manifest.outline = await doc.getOutline(); } catch { /* none */ }
    try { manifest.pageLabels = await doc.getPageLabels(); } catch { /* none */ }
    try { const mi = await doc.getMarkInfo(); manifest.isTagged = !!(mi && mi.Marked); } catch { /* */ }
    try { manifest.formFields = await doc.getFieldObjects(); } catch { /* none */ }
    try {
        const atts = await doc.getAttachments();
        if (atts) for (const k of Object.keys(atts)) {
            const a = atts[k];
            const name = (a && a.filename) ? path.basename(a.filename) : k;
            const bytes = a && a.content ? Buffer.from(a.content) : Buffer.alloc(0);
            fs.writeFileSync(path.join(dirs.files, name), bytes);   // written, never opened
            manifest.embeddedFiles.push({ name, bytes: bytes.length });
        }
    } catch { /* none */ }
    manifest.counts.embeddedFiles = manifest.embeddedFiles.length;
    manifest.counts.formFields = manifest.formFields ? Object.keys(manifest.formFields).length : 0;

    const total = doc.numPages;
    const start = Math.max(1, Math.min(Number(pageStart) || 1, total));
    const end = Math.max(start, Math.min(
        pageEnd === undefined ? total : (Number(pageEnd) || start),
        total, start + pageCap - 1));

    for (let p = start; p <= end; p++) {
        onNote(`extracting page ${p}/${total}`);
        const rec = { page: p, textChars: 0, ocr: false, rendered: false,
            images: [], links: [], notes: [], widgets: [] };
        const page = await doc.getPage(p);

        // TEXT (geometry-aware)
        let text = "";
        try { const tc = await page.getTextContent(); text = pageTextFromItems(tc.items); }
        catch { text = ""; }
        rec.textChars = text.length;
        if (text.length) manifest.counts.textPages++;

        // ANNOTATIONS / LINKS / FORM WIDGETS
        try {
            const shaped = shapeAnnotations(await page.getAnnotations({ intent: "display" }));
            rec.links = shaped.links; rec.notes = shaped.notes; rec.widgets = shaped.widgets;
            manifest.counts.links += shaped.links.length;
            manifest.counts.annotations += shaped.notes.length;
        } catch { /* none */ }

        // EMBEDDED IMAGES (headless) — write each out, remember the largest
        let biggest = null;
        try {
            const imgs = await pageImages(lib, page);
            let k = 0;
            for (const im of imgs) {
                const name = `p${pad(p)}-img${k}.png`;
                fs.writeFileSync(path.join(dirs.images, name),
                    encodePng(im.pix.rgba, im.pix.w, im.pix.h));
                rec.images.push({ name, w: im.pix.w, h: im.pix.h });
                if (!biggest || im.pix.w * im.pix.h > biggest.area)
                    biggest = { path: path.join(dirs.images, name), area: im.pix.w * im.pix.h };
                k++;
            }
            manifest.counts.embeddedImages += imgs.length;
        } catch { /* images best-effort */ }

        // PAGE RENDER (correct orientation, captures vector graphics) — injected
        let pageImgPath = null;
        if (render) {
            try {
                const rp = await render(p);
                if (rp) {
                    const dest = path.join(dirs.pages, `page-${pad(p)}.png`);
                    fs.copyFileSync(rp, dest);
                    try { if (rp !== dest) fs.rmSync(rp, { force: true }); } catch { /* temp */ }
                    pageImgPath = dest; rec.rendered = true; manifest.counts.renderedPages++;
                }
            } catch { /* render best-effort */ }
        }

        // OCR the pages that have no text layer — PER PAGE, not per document
        if (ocr && text.length < ocrFloorChars) {
            const target = pageImgPath || (biggest && biggest.path);
            if (target) {
                try {
                    const r = await ocr(target);
                    if (r && r.ok && (r.text || "").trim()) {
                        text = String(r.text).trim();
                        // KEEP IT FLAT. The OCR text is appended to text/full.txt
                        // below with a "(OCR)" page marker — that IS the copy the
                        // model reads. A separate ocr/page-NNN.txt per page was a
                        // second identical copy of every scanned page: 26 files of
                        // the same words the model could (and did) read a second
                        // time, ballooning the context. One flat source, not two.
                        rec.ocr = true; manifest.counts.ocrPages++;
                    }
                } catch { /* ocr best-effort */ }
            }
        }

        textBlocks.push(`--- page ${p}${rec.ocr ? " (OCR)" : ""} ---\n${text}\n\n`);
        manifest.perPage.push(rec);
        page.cleanup();
    }
    manifest.pageStart = start; manifest.pageEnd = end;
    manifest.more = end < total;

    // full.txt: prior windows' text survives a continuation call; a re-run
    // from page 1 replaces the file whole. One rename either way.
    let priorText = "";
    if (!firstCall) {
        try { priorText = fs.readFileSync(fullTxt, "utf8"); } catch { /* none yet */ }
    }
    atomicWriteSync(fullTxt, priorText + textBlocks.join(""));

    // MERGE with any prior extraction window so the sidecar (meta.json + index.md)
    // describes the WHOLE document, not only this call's page range. full.txt
    // already accumulates across paged calls; the manifest used to be rebuilt
    // fresh each call and written over the old one, leaving the index describing
    // just the last window even though the text held every page.
    if (!firstCall) {
        try {
            const prev = JSON.parse(fs.readFileSync(path.join(dirs.root, "meta.json"), "utf8"));
            if (prev && Array.isArray(prev.perPage) && prev.perPage.length) {
                const coveredNow = new Set(manifest.perPage.map(r => r.page));
                const merged = prev.perPage.filter(r => !coveredNow.has(r.page))
                    .concat(manifest.perPage)
                    .sort((a, b) => a.page - b.page);
                manifest.perPage = merged;
                // per-page counts recomputed from the merged records, so re-running
                // a window replaces rather than double-counts; the document-level
                // counts (formFields, embeddedFiles) are recomputed every call.
                const c = manifest.counts;
                c.textPages = merged.filter(r => (r.textChars || 0) > 0).length;
                c.ocrPages = merged.filter(r => r.ocr).length;
                c.renderedPages = merged.filter(r => r.rendered).length;
                c.embeddedImages = merged.reduce((n, r) => n + (r.images ? r.images.length : 0), 0);
                c.links = merged.reduce((n, r) => n + (r.links ? r.links.length : 0), 0);
                c.annotations = merged.reduce((n, r) => n + (r.notes ? r.notes.length : 0), 0);
                manifest.pageStart = merged[0].page;
                manifest.pageEnd = merged[merged.length - 1].page;
                manifest.more = manifest.pageEnd < total;
            }
        } catch { /* no readable prior window — write this one as-is */ }
    }

    // meta.json + a human, viewer-renderable index.md assembled from the parts
    atomicWriteSync(path.join(dirs.root, "meta.json"), JSON.stringify(manifest, null, 2));
    writeIndex(dirs.root, manifest);

    try { await doc.destroy(); } catch { /* released */ }
    return manifest;
}

function writeIndex(root, m) {
    const rel = (...p) => p.join("/");
    const L = [];
    const title = (m.meta && (m.meta.Title || m.meta.title)) || m.file;
    L.push(`# ${title}`, "");
    const info = [];
    if (m.meta) for (const [k, v] of Object.entries(m.meta)) {
        if (k.startsWith("_") || v == null || v === "") continue;
        if (typeof v === "object") continue;
        info.push(`- **${k}:** ${v}`);
    }
    info.push(`- **pages:** ${m.pages}` + (m.more ? ` (this extract covers ${m.pageStart}–${m.pageEnd})` : ""));
    if (info.length) { L.push("## Document", ...info, ""); }
    if (m.embeddedFiles && m.embeddedFiles.length) {
        L.push("## Embedded files", ...m.embeddedFiles.map(f => `- \`files/${f.name}\` (${f.bytes} bytes)`), "");
    }
    if (m.formFields && Object.keys(m.formFields).length) {
        L.push("## Form fields");
        for (const k of Object.keys(m.formFields)) {
            const arr = m.formFields[k]; const first = Array.isArray(arr) ? arr[0] : arr;
            L.push(`- **${k}:** ${first && first.value != null ? first.value : ""}`);
        }
        L.push("");
    }
    if (Array.isArray(m.outline) && m.outline.length) {
        L.push("## Outline");
        const walk = (items, d) => { for (const it of items) { L.push(`${"  ".repeat(d)}- ${it.title}`); if (it.items && it.items.length) walk(it.items, d + 1); } };
        walk(m.outline, 0); L.push("");
    }
    if (m.unavailable && m.unavailable.length) {
        L.push("> **Not captured:** " + m.unavailable.join("; "), "");
    }
    for (const r of m.perPage) {
        L.push(`## Page ${r.page}${r.ocr ? " (OCR)" : ""}`);
        if (r.rendered) L.push("", `![page ${r.page}](${rel("pages", `page-${pad(r.page)}.png`)})`, "");
        for (const im of r.images) L.push(`![${im.name}](${rel("images", im.name)}) `);
        if (r.images.length) L.push("");
        if (r.links.length) { L.push("**Links:**"); for (const lk of r.links) L.push(`- ${lk.url || lk.dest}`); L.push(""); }
        if (r.notes.length) { L.push("**Comments:**"); for (const n of r.notes) L.push(`- ${n.author ? n.author + ": " : ""}${n.text || "(" + n.type + ")"}`); L.push(""); }
        // the page's text lives in text/full.txt; index.md points at it rather than
        // duplicating a whole book inline
        L.push(`_Text on this page is in [text/full.txt](text/full.txt)._`, "");
    }
    atomicWriteSync(path.join(root, "index.md"), L.join("\n"));
}

module.exports = { available, extract, encodePng, imageToRgba, orientRgba, pageImages, pageTextFromItems, shapeAnnotations, pdfjs };
