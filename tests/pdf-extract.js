/**
 * COMPREHENSIVE PDF EXTRACTION — the general "pull everything out of any PDF"
 * path, tested against fixtures GENERATED in the test (no external files), so a
 * regression fails here rather than on a user's document.
 *
 * The operator's demand, verbatim: pull ANY pdf — attachment or workspace — and
 * extract WHATEVER is inside, "any god damn thing that could be in a pdf": text,
 * scanned pages, AND images. The old read_pdf captured two of the ten content
 * types and, worse, gated OCR on the WHOLE-document average so a scanned page
 * beside a text page vanished. This suite proves the new engine on the pure
 * pdf.js parts that run headless: full text (geometry-aware, no data-losing
 * cap), embedded image extraction with correct orientation and a
 * dependency-free PNG encoder, metadata/annotation shaping, and honest handling
 * when rendering/OCR are unavailable.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const pdfExtract = require(path.join(__dirname, "..", ".lcl.engine", "core", "pdfExtract.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 200) : ""); }
}

/* ---- fixture builders: valid PDFs with correct xref offsets, built in-test -- */
function buildPdf(objs, binByObj = {}) {
    // objs: 1-based array of body strings; binByObj: {index: Buffer} appended raw
    let pdf = Buffer.from("%PDF-1.4\n", "latin1");
    const offsets = [];
    for (let i = 1; i < objs.length; i++) {
        offsets[i] = pdf.length;
        let head = Buffer.from(`${i} 0 obj\n${objs[i]}\n`, "latin1");
        pdf = Buffer.concat([pdf, head]);
        if (binByObj[i]) pdf = Buffer.concat([pdf, Buffer.from("stream\n", "latin1"), binByObj[i], Buffer.from("\nendstream\n", "latin1")]);
        pdf = Buffer.concat([pdf, Buffer.from("endobj\n", "latin1")]);
    }
    const xrefAt = pdf.length;
    let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    xref += `trailer\n<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF`;
    return Buffer.concat([pdf, Buffer.from(xref, "latin1")]);
}

function textPdf() {
    const c1 = "BT /F1 24 Tf 72 700 Td (Extraction Engine Test) Tj ET\n" +
               "BT /F1 12 Tf 72 660 Td (Left column.) Tj ET\n" +
               "BT /F1 12 Tf 360 660 Td (Right column.) Tj ET";
    const c2 = "BT /F1 14 Tf 72 700 Td (Page two body.) Tj ET";
    const objs = [];
    objs[1] = "<</Type/Catalog/Pages 2 0 R>>";
    objs[2] = "<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>";
    objs[3] = "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>";
    objs[4] = `<</Length ${c1.length}>>\nstream\n${c1}\nendstream`;
    objs[5] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
    objs[6] = "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 7 0 R/Resources<</Font<</F1 5 0 R>>>>>>";
    objs[7] = `<</Length ${c2.length}>>\nstream\n${c2}\nendstream`;
    return buildPdf(objs);
}

function imagePdf() {
    // a 2x2 DeviceRGB image: red, green, blue, white — painted onto the page
    const px = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const content = Buffer.from("q 50 0 0 50 25 25 cm /Im0 Do Q", "latin1");
    const objs = [];
    objs[1] = "<</Type/Catalog/Pages 2 0 R>>";
    objs[2] = "<</Type/Pages/Kids[3 0 R]/Count 1>>";
    objs[3] = "<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im0 5 0 R>>>>>>";
    objs[4] = `<</Length ${content.length}>>`;
    objs[5] = "<</Type/XObject/Subtype/Image/Width 2/Height 2/ColorSpace/DeviceRGB/BitsPerComponent 8/Length 12>>";
    return buildPdf(objs, { 4: content, 5: px });
}

/* decode a PNG's IHDR to confirm the encoder produced a real, valid image */
function pngDims(buf) {
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504E47) return null;
    if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

(async () => {
    check("the engine reports available (pdfjs resolves)", pdfExtract.available());

    /* ---- unit: dependency-free PNG encoder ---- */
    {
        const w = 3, h = 2;
        const rgba = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) { rgba[i * 4] = i * 10; rgba[i * 4 + 3] = 255; }
        const png = pdfExtract.encodePng(rgba, w, h);
        const d = pngDims(png);
        check("encodePng writes a valid PNG (signature + IHDR) with the right dimensions",
            d && d.w === 3 && d.h === 2 && d.bitDepth === 8 && d.colorType === 6, JSON.stringify(d));
        // and the pixels round-trip through zlib (IDAT is real deflate)
        check("...and its IDAT is real deflate data (decompresses to filtered rows)",
            (() => { try {
                const sigLen = 8, ihdr = 12 + 13 + 4; // sig + (len+type+data+crc) not exact; scan chunks instead
                // find IDAT chunk
                let off = 8, idat = null;
                while (off < png.length) { const len = png.readUInt32BE(off); const type = png.toString("latin1", off + 4, off + 8); if (type === "IDAT") { idat = png.slice(off + 8, off + 8 + len); break; } off += 12 + len; }
                const raw = zlib.inflateSync(idat);
                return raw.length === (w * 4 + 1) * h;   // one filter byte per row
            } catch { return false; } })());
    }

    /* ---- unit: image kind -> RGBA ---- */
    {
        const rgb = pdfExtract.imageToRgba({ width: 1, height: 1, kind: 2, data: new Uint8Array([10, 20, 30]) });
        check("imageToRgba RGB_24BPP adds an opaque alpha",
            rgb && rgb.rgba[0] === 10 && rgb.rgba[1] === 20 && rgb.rgba[2] === 30 && rgb.rgba[3] === 255);
        const rgba = pdfExtract.imageToRgba({ width: 1, height: 1, kind: 3, data: new Uint8Array([1, 2, 3, 4]) });
        check("imageToRgba RGBA_32BPP is copied through",
            rgba && rgba.rgba[3] === 4);
        const gray = pdfExtract.imageToRgba({ width: 8, height: 1, kind: 1, data: new Uint8Array([0b10000000]) });
        check("imageToRgba GRAYSCALE_1BPP unpacks MSB-first, set bit = white",
            gray && gray.rgba[0] === 255 && gray.rgba[4] === 0);   // px0 white, px1 black
    }

    /* ---- unit: orientation from the CTM ---- */
    {
        const mk = () => { const p = { rgba: Buffer.alloc(2 * 2 * 4), w: 2, h: 2 }; for (let i = 0; i < 4; i++) p.rgba[i * 4] = i; return p; };
        // normal image placement [w 0 0 -h e f]: det<0, d<0 -> no change
        const same = pdfExtract.orientRgba(mk(), [50, 0, 0, -50, 0, 0]);
        check("orientRgba leaves a normally-placed image (d<0, det<0) untouched",
            same.rgba[0] === 0 && same.rgba[4] === 1);
        // upside-down placement [w 0 0 h ...] (d>0, det>0? no: a>0,d>0 det>0 = mirror+vflip)
        // the measured scanned case: a<0, d>0, det<0 -> vertical flip only, NO mirror
        const flipped = pdfExtract.orientRgba(mk(), [-50, 0, 0, 50, 0, 0]);
        // row 0 (indices 0,1) should now be row 1 -> value at (0,0) becomes old (0,1)=2
        check("orientRgba on the scanned case (a<0,d>0,det<0) applies a vertical flip only (not a mirror)",
            flipped.rgba[0] === 2 && flipped.rgba[4] === 3);
    }

    /* ---- unit: reading-order text ---- */
    {
        const items = [
            { str: "second", transform: [1, 0, 0, 1, 300, 700] },
            { str: "first", transform: [1, 0, 0, 1, 72, 700] },
            { str: "below", transform: [1, 0, 0, 1, 72, 680] },
        ];
        const t = pdfExtract.pageTextFromItems(items);
        check("pageTextFromItems orders a line left-to-right and lines top-to-bottom",
            t === "first second\nbelow", JSON.stringify(t));
    }

    /* ---- unit: annotation shaping ---- */
    {
        const s = pdfExtract.shapeAnnotations([
            { subtype: "Link", url: "https://example.com" },
            { subtype: "Highlight", contents: "note here", title: "Alex", modificationDate: "D:2026" },
            { subtype: "Widget", fieldName: "name", fieldType: "Tx", fieldValue: "Doe" },
        ]);
        check("shapeAnnotations captures a link's URL, a comment's text+author, and a form widget's field+value",
            s.links[0].url === "https://example.com" && s.notes[0].text === "note here"
            && s.notes[0].author === "Alex" && s.widgets[0].field === "name" && s.widgets[0].value === "Doe");
    }

    /* ---- integration: born-digital text PDF ---- */
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-pdfx-"));
        const pdf = path.join(dir, "text.pdf"); fs.writeFileSync(pdf, textPdf());
        const out = path.join(dir, "out");
        const m = await pdfExtract.extract(pdf, { outDir: out });   // headless: no render, no ocr
        const full = fs.readFileSync(path.join(out, "text", "full.txt"), "utf8");
        check("text PDF: the FULL text of every page reaches text/full.txt, uncapped",
            full.includes("Extraction Engine Test") && full.includes("Page two body."), full.slice(0, 120));
        check("text PDF: same-line items are ordered by x (no column interleaving)",
            /Left column\. Right column\./.test(full), full);
        check("text PDF: counts.textPages == pages, no OCR invented",
            m.counts.textPages === 2 && m.counts.ocrPages === 0, JSON.stringify(m.counts));
        check("headless honesty: render:false, ocr:false, unavailable names both",
            m.render === false && m.ocr === false && m.unavailable.length === 2, JSON.stringify(m.unavailable));
        check("meta.json and index.md are written",
            fs.existsSync(path.join(out, "meta.json")) && fs.existsSync(path.join(out, "index.md")));
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    }

    /* ---- integration: embedded image extraction (headless, dependency-free) ---- */
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-pdfx-"));
        const pdf = path.join(dir, "img.pdf"); fs.writeFileSync(pdf, imagePdf());
        const out = path.join(dir, "out");
        const m = await pdfExtract.extract(pdf, { outDir: out });
        check("image PDF: the embedded raster image is pulled out to images/",
            m.counts.embeddedImages >= 1, JSON.stringify(m.counts));
        const imgFile = path.join(out, "images", "p001-img0.png");
        const d = fs.existsSync(imgFile) ? pngDims(fs.readFileSync(imgFile)) : null;
        check("image PDF: the extracted file is a valid 2x2 PNG (getOperatorList -> objs -> PNG works end to end)",
            d && d.w === 2 && d.h === 2, JSON.stringify(d));
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    }

    console.log(`\n${pass}/${pass + fail} pdf-extract checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(1); });
