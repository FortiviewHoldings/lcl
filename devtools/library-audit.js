#!/usr/bin/env node
/**
 * Audit a folder of page scans BEFORE spending an hour OCR-ing it.
 *
 * Written after a real failure: 781 of 1,439 spec captures turned out to
 * be 1280x720 frames holding TWO document pages plus the PDF viewer's chrome,
 * leaving each page ~460px wide. Tesseract wants roughly 300 DPI; that is
 * closer to 60. The OCR ran for 55 minutes and returned text where the ohm
 * sign had become "Q" and the numbers could not be trusted — and none of that
 * was visible until afterwards.
 *
 * This reads PNG/JPEG headers only (no decoding, no OCR), so auditing
 * thousands of pages takes a second. It reports what will read well, what will
 * not, and which folders a sharper capture has already superseded.
 *
 *   node tools/library-audit.js <folder> [--json] [--write-todo]
 */
const fs = require("fs");
const path = require("path");

// Matches ocrTools: below MIN_HEIGHT a letter page has too few pixels to read,
// and TARGET_HEIGHT is roughly the 300 DPI tesseract actually wants.
const MIN_HEIGHT = 900;
const TARGET_HEIGHT = 2200;
const GOOD_WIDTH = 1600;

function imageSize(file) {
    let fd;
    try {
        fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(32);
        fs.readSync(fd, buf, 0, 32, 0);
        if (buf.readUInt32BE(0) === 0x89504e47) {          // PNG
            return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
        }
        if (buf[0] === 0xff && buf[1] === 0xd8) {          // JPEG: walk segments
            const st = fs.fstatSync(fd);
            const big = Buffer.alloc(Math.min(st.size, 1 << 20));
            fs.readSync(fd, big, 0, big.length, 0);
            let o = 2;
            while (o < big.length - 9) {
                if (big[o] !== 0xff) { o++; continue; }
                const marker = big[o + 1];
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
                const len = big.readUInt16BE(o + 2);
                if (len < 2) break;
                // SOF0-15 except DHT/JPG/DAC
                if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { h: big.readUInt16BE(o + 5), w: big.readUInt16BE(o + 7) };
                }
                o += 2 + len;
            }
        }
        return null;
    } catch { return null; }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

function auditFolder(dir) {
    let files;
    try { files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g)$/i.test(f)).sort(); }
    catch { return null; }
    if (!files.length) return null;

    // sample rather than read every header: a capture run is uniform, and
    // outliers show up in the spread
    const step = Math.max(1, Math.floor(files.length / 12));
    const sizes = [];
    for (let i = 0; i < files.length; i += step) {
        const s = imageSize(path.join(dir, files[i]));
        if (s && s.w && s.h) sizes.push(s);
    }
    if (!sizes.length) return null;

    const heights = sizes.map(s => s.h).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    const w = sizes[Math.floor(sizes.length / 2)].w;
    const varied = new Set(sizes.map(s => `${s.w}x${s.h}`)).size > 1;

    // A capture wider than ~1.4x its height is almost certainly a two-page
    // spread, which halves the usable resolution per document page.
    const spread = w / median > 1.4;
    const perPageWidth = spread ? Math.round(w / 2) : w;
    const upscaleNeeded = median < TARGET_HEIGHT
        ? Math.min(4, Math.ceil(TARGET_HEIGHT / median)) : 1;

    let verdict, why;
    if (median < MIN_HEIGHT) {
        verdict = "unreadable";
        why = `pages are ${median}px tall — below the ${MIN_HEIGHT}px floor even before the spread`;
    } else if (w < GOOD_WIDTH) {
        verdict = "poor";
        why = spread
            ? `two pages in a ${w}x${median} frame leaves ~${perPageWidth}px per page`
            : `${w}x${median} is under the ${GOOD_WIDTH}px width that reads reliably`;
    } else if (spread && perPageWidth < GOOD_WIDTH * 0.6) {
        verdict = "poor";
        why = `a ${w}px spread gives only ~${perPageWidth}px per document page`;
    } else {
        verdict = "good";
        why = `${w}x${median}${spread ? " (spread, ~" + perPageWidth + "px/page)" : ""}`;
    }

    return { dir, name: path.basename(dir), count: files.length,
             width: w, height: median, spread, perPageWidth,
             upscaleNeeded, varied, verdict, why };
}

function main() {
    const args = process.argv.slice(2);
    const root = args.find(a => !a.startsWith("--"));
    if (!root) {
        console.error("usage: node tools/library-audit.js <folder> [--json] [--write-todo]");
        process.exit(2);
    }
    if (!fs.existsSync(root)) { console.error("no such folder:", root); process.exit(2); }

    const folders = [];
    const self = auditFolder(root);
    if (self) folders.push(self);
    for (const name of fs.readdirSync(root)) {
        const p = path.join(root, name);
        try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
        const a = auditFolder(p);
        if (a) folders.push(a);
    }
    if (!folders.length) { console.log("no page images found under", root); return; }

    // A folder is SUPERSEDED when another folder holds a sharper capture of
    // what looks like the same document (same page count, or a name that is
    // this one plus a qualifier).
    const good = folders.filter(f => f.verdict === "good");
    for (const f of folders) {
        if (f.verdict === "good") continue;
        const base = f.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        f.supersededBy = (good.find(g => {
            const gb = g.name.toLowerCase().replace(/[^a-z0-9]/g, "");
            return gb.startsWith(base) || base.startsWith(gb.replace(/enhanced$/, ""));
        }) || {}).name || null;
    }

    if (args.includes("--json")) {
        console.log(JSON.stringify({ root, folders }, null, 2));
        return;
    }

    const order = { unreadable: 0, poor: 1, good: 2 };
    folders.sort((a, b) => order[a.verdict] - order[b.verdict] || b.count - a.count);

    console.log(`\nCapture audit — ${root}\n`);
    console.log("verdict".padEnd(12) + "pages".padStart(6) + "  " + "folder".padEnd(38) + "why");
    console.log("-".repeat(112));
    for (const f of folders) {
        const tag = f.supersededBy ? "superseded" : f.verdict;
        console.log(tag.padEnd(12) + String(f.count).padStart(6) + "  " +
            f.name.slice(0, 36).padEnd(38) +
            (f.supersededBy ? `a sharper capture exists: "${f.supersededBy}"` : f.why));
    }
    console.log("-".repeat(112));

    const todo = folders.filter(f => f.verdict !== "good" && !f.supersededBy);
    const dupes = folders.filter(f => f.supersededBy);
    const okPages = folders.filter(f => f.verdict === "good").reduce((n, f) => n + f.count, 0);
    const todoPages = todo.reduce((n, f) => n + f.count, 0);

    console.log(`${okPages} pages will OCR well.`);
    if (dupes.length) {
        console.log(`${dupes.reduce((n, f) => n + f.count, 0)} pages are superseded — exclude them from the library ` +
                    `so their garbled text stops competing in search.`);
    }
    if (todoPages) {
        console.log(`${todoPages} pages need re-capturing at a higher resolution ` +
                    `(aim for ~${TARGET_HEIGHT}px tall per document page, one page per image).`);
    }

    if (args.includes("--write-todo") && todo.length) {
        const out = path.join(root, "RECAPTURE-TODO.txt");
        fs.writeFileSync(out,
            `Captures too low-resolution to OCR reliably, with no sharper copy.\n` +
            `Aim for ~${TARGET_HEIGHT}px per document page, one page per image.\n\n` +
            todo.map(f => `${String(f.count).padStart(5)}  ${f.name}\n       ${f.why}`).join("\n") +
            `\n\n${todo.length} folders, ${todoPages} captures.\n`, "utf8");
        console.log(`\nwrote ${out}`);
    }
    console.log("");
}

if (require.main === module) main();
module.exports = { imageSize, auditFolder };
