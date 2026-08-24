#!/usr/bin/env node
/**
 * Generate the installer's branding bitmaps.
 *
 *   node devtools/make-installer-art.js
 *
 * NSIS wants uncompressed 24-bit BMP at exact sizes and will silently ignore
 * anything else, so these are emitted programmatically rather than committed as
 * binary blobs: the palette stays in sync with app/renderer/styles.css, and a
 * change is a diff you can read instead of a file you have to trust.
 *
 * Two images, both required by MUI2:
 *   welcome/finish sidebar   164 x 314
 *   interior header          150 x  57
 *
 * The mark is the REAL logo — app/assets/mark.png, the same rounded badge the
 * title bar shows — decoded by Electron's nativeImage and composited over the
 * background. It was previously drawn from rectangles, and the operator's
 * review said exactly what that looked like: "you didnt use my logo in the
 * right, you created some block text there. but we have a logo, why not use
 * it?" No answer to that survives contact with the question. Run under
 * Electron:
 *
 *   app> ./node_modules/.bin/electron ../devtools/make-installer-art.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { app, nativeImage } = require("electron");

// electron-builder resolves buildResources relative to the PROJECT dir, which
// for this repo is app/ (npm run build runs there). directories.buildResources
// is "assets", so ${BUILD_RESOURCES_DIR} is app/assets. Writing to a build/
// folder at the repo root produced files nothing ever read — the first build
// with them shipped with no branding at all and the check caught it.
const OUT = path.join(__dirname, "..", "app", "assets");

// straight from styles.css so the installer and the app cannot drift apart
const BG        = [0x05, 0x05, 0x05];   // --bg
const BG_RAISE  = [0x0b, 0x0b, 0x0b];   // --bg-raise
const LINE      = [0x2b, 0x2b, 0x2e];   // --line-strong
const TEXT      = [0xf4, 0xf4, 0xf5];   // --text
const TEXT_DIM  = [0x6b, 0x6b, 0x70];   // --text-faint

/** A writable pixel buffer. Origin top-left; BMP row order is handled on write. */
function canvas(w, h, fill) {
    const px = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) {
        px[i * 3] = fill[0]; px[i * 3 + 1] = fill[1]; px[i * 3 + 2] = fill[2];
    }
    return { w, h, px };
}

function put(c, x, y, rgb, alpha = 1) {
    if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
    const i = (y * c.w + x) * 3;
    for (let k = 0; k < 3; k++) {
        c.px[i + k] = Math.round(c.px[i + k] * (1 - alpha) + rgb[k] * alpha);
    }
}

function rect(c, x, y, w, h, rgb, alpha = 1) {
    for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) put(c, xx, yy, rgb, alpha);
    }
}

/**
 * Composite the real mark over the canvas.
 *
 * nativeImage gives BGRA; the alpha channel is what lets the badge's rounded
 * corners sit on the gradient instead of punching a square hole in it.
 */
function drawImage(c, img, x, y, w, h) {
    const scaled = img.resize({ width: w, height: h, quality: "best" });
    const size = scaled.getSize();
    const buf = scaled.toBitmap();          // BGRA, premultiplied
    for (let yy = 0; yy < size.height; yy++) {
        for (let xx = 0; xx < size.width; xx++) {
            const i = (yy * size.width + xx) * 4;
            const a = buf[i + 3] / 255;
            if (a <= 0.004) continue;
            // un-premultiply so the blend in put() is not double-counted
            put(c, x + xx, y + yy, [buf[i + 2] / a, buf[i + 1] / a, buf[i] / a], a);
        }
    }
    return { w: size.width, h: size.height };
}

const MARK = nativeImage.createFromPath(
    path.join(__dirname, "..", "app", "assets", "mark.png"));
if (MARK.isEmpty()) {
    console.error("app/assets/mark.png did not decode — no branding without it");
    process.exit(1);
}

/** 24-bit BMP: bottom-up rows, each padded to a 4-byte boundary. */
function writeBmp(file, c) {
    const rowBytes = c.w * 3;
    const pad = (4 - (rowBytes % 4)) % 4;
    const dataSize = (rowBytes + pad) * c.h;
    const head = Buffer.alloc(54);
    head.write("BM", 0);
    head.writeUInt32LE(54 + dataSize, 2);
    head.writeUInt32LE(54, 10);            // pixel offset
    head.writeUInt32LE(40, 14);            // DIB header size
    head.writeInt32LE(c.w, 18);
    head.writeInt32LE(c.h, 22);
    head.writeUInt16LE(1, 26);             // planes
    head.writeUInt16LE(24, 28);            // bits per pixel
    head.writeUInt32LE(0, 30);             // BI_RGB, uncompressed
    head.writeUInt32LE(dataSize, 34);
    head.writeInt32LE(2835, 38);           // 72 dpi
    head.writeInt32LE(2835, 42);

    const body = Buffer.alloc(dataSize);
    let o = 0;
    for (let y = c.h - 1; y >= 0; y--) {    // BMP stores rows bottom-up
        for (let x = 0; x < c.w; x++) {
            const i = (y * c.w + x) * 3;
            body[o++] = c.px[i + 2];        // B
            body[o++] = c.px[i + 1];        // G
            body[o++] = c.px[i];            // R
        }
        o += pad;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([head, body]));
    return dataSize + 54;
}

/* ------------------------------------------------------------- the sidebar */

function sidebar() {
    const c = canvas(164, 314, BG);

    // a slow vertical lift, so it is not a flat black slab
    for (let y = 0; y < c.h; y++) {
        const t = y / c.h;
        const v = Math.round(0x05 + (0x0e - 0x05) * (1 - t) * (1 - t));
        rect(c, 0, y, c.w, 1, [v, v, v]);
    }

    // a field of faint dots that thins toward the bottom — deterministic, so
    // regenerating produces a byte-identical file
    let seed = 20260730;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 320; i++) {
        const x = Math.floor(rnd() * c.w);
        const y = Math.floor(rnd() * c.h);
        if (rnd() < y / c.h) continue;
        put(c, x, y, TEXT, 0.05 + rnd() * 0.10);
    }

    // THE logo, centred in the upper third — the sidebar is the one piece of
    // installer real estate big enough to show it at a size worth having
    const mw = 108;
    const ratio = MARK.getSize().height / MARK.getSize().width;
    drawImage(c, MARK, Math.round((c.w - mw) / 2), 44, mw, Math.round(mw * ratio));

    rect(c, 28, 196, c.w - 56, 1, LINE);

    rect(c, 0, c.h - 1, c.w, 1, LINE);
    return c;
}

/* -------------------------------------------------------------- the header */

function header() {
    const c = canvas(150, 57, BG_RAISE);
    for (let y = 0; y < c.h; y++) {
        const v = Math.round(0x0b + (0x05 - 0x0b) * (y / c.h));
        rect(c, 0, y, c.w, 1, [v, v, v]);
    }
    const hh = 40;
    const ratio = MARK.getSize().width / MARK.getSize().height;
    drawImage(c, MARK, c.w - Math.round(hh * ratio) - 12,
              Math.round((c.h - hh) / 2), Math.round(hh * ratio), hh);
    rect(c, 0, c.h - 1, c.w, 1, LINE);
    return c;
}

/**
 * WRITE, REPORT, EXIT.
 *
 * Three things this got wrong, all in the exit path:
 *
 *   1. It never exited. Requiring electron starts an app whose event loop has
 *      nothing to end it — no window is ever created, so "window-all-closed"
 *      never fires — and three Electron processes sat holding ~190 MB until
 *      they were killed by hand. On a 15.6 GB machine where the memory planner
 *      is already refusing models, a devtools script that leaks a fifth of a
 *      gigabyte per run is not a cosmetic bug. app.exit() is unconditional:
 *      no before-quit handlers, no windows to consult, gone.
 *
 *   2. Its output went nowhere. Electron on Windows builds against the GUI
 *      subsystem, so a main-process console.log is not attached to the parent's
 *      stdout — piping this to a file produced zero bytes while the run
 *      succeeded. The report goes to a log file, and the path is the one thing
 *      printed, so there is somewhere to look either way.
 *
 *   3. It said "written to build/". The files go to app/assets. That sentence
 *      is what sent the first version of this to a directory electron-builder
 *      never reads, and the artefact shipped with no branding at all.
 */
const LOG = path.join(os.tmpdir(), "lcl-installer-art.log");

const lines = ["installer art " + new Date().toISOString()];
try {
    for (const [name, c] of [
        ["installer-sidebar.bmp", sidebar()],
        ["installer-header.bmp", header()]
    ]) {
        const bytes = writeBmp(path.join(OUT, name), c);
        lines.push(`  ${name.padEnd(24)} ${c.w}x${c.h}  ${bytes.toLocaleString()} bytes`);
    }
    lines.push("", "written to " + OUT,
        "referenced from app/builder-config.json as installerSidebar / installerHeader");
} catch (err) {
    lines.push("FAILED: " + (err && err.stack || err));
    const failed = lines.join("\n") + "\n";
    fs.writeFileSync(LOG, failed);
    process.stdout.write(failed);
    app.exit(1);
}

const report = lines.join("\n") + "\n";

fs.writeFileSync(LOG, report);
process.stdout.write(report);
app.exit(0);
