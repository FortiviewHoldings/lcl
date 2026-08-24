const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * PDF pages -> PNG images, locally, via a hidden BrowserWindow.
 *
 * Why this exists: a scanned-era PDF has no text layer, so extractPdfPages
 * honestly returns nothing — which excluded exactly the reference works
 * (MIL-HDBK-5J, NBS Handbook 100) a knowledge library is for. pdf.js can
 * RENDER any page, but rendering needs a canvas, and the main process has
 * none — so a hidden renderer window does the drawing and hands back PNG
 * bytes. The same machinery lets capture_drawing accept a PDF schematic
 * directly instead of demanding a screenshot of it.
 *
 * Availability is runtime-honest: in the Electron main process this works;
 * in a bare Node context (tests, headless scripts) available() is false and
 * every caller must degrade exactly as before this module existed.
 *
 * One document = one hidden window, reused across its pages — window
 * creation is the expensive part, and a 1,700-page handbook cannot pay it
 * per page. The window dies with close(), and a watchdog kills any raster
 * older than RASTER_TIMEOUT_MS so a corrupt page cannot wedge indexing.
 */

const RASTER_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 20_000;
const MAX_SCALE = 4;

function electronMain() {
    try {
        const e = require("electron");
        // BrowserWindow exists only in the MAIN process of a running app
        return e && e.BrowserWindow && e.app && typeof e.app.isReady === "function"
            ? e : null;
    } catch { return null; }
}

function available() {
    const e = electronMain();
    if (!e) return false;
    try { require.resolve("pdfjs-dist/legacy/build/pdf.min.mjs"); }
    catch { return false; }
    return e.app.isReady();
}

/** Open a PDF for rasterising. Returns { numPages, renderPage, close }. */
async function openDoc(pdfPath) {
    const e = electronMain();
    if (!e) throw new Error("PDF rasterising needs the app's window system");
    const bytes = fs.readFileSync(pdfPath);

    const win = new e.BrowserWindow({
        show: false, width: 100, height: 100,
        webPreferences: {
            preload: path.join(__dirname, "..", "raster", "pdfraster-preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,           // the preload needs ipcRenderer
            offscreen: true
        }
    });

    const channel = `pdfraster:${win.webContents.id}`;
    const pending = new Map();
    let seq = 0;
    const onReply = (_ev, msg) => {
        const p = pending.get(msg.seq);
        if (!p) return;
        pending.delete(msg.seq);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg);
    };
    e.ipcMain.on(channel + ":reply", onReply);

    const closed = () => win.isDestroyed();
    function ask(kind, payload, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (closed()) return reject(new Error("raster window is gone"));
            const mySeq = ++seq;
            const timer = setTimeout(() => {
                pending.delete(mySeq);
                // The renderer is STILL BUSY on the page that timed out, and
                // this window is reused for every page of the document — so
                // abandoning the request without tearing it down left each
                // subsequent page to wait out its own timeout behind a wedged
                // renderer. On a 2000-page scan that is a day of hanging
                // instead of one honest failure. Destroying the window makes
                // every later ask fail immediately with "raster window is
                // gone", which the caller already treats as "skip this file".
                if (!win.isDestroyed()) { try { win.destroy(); } catch { /* gone */ } }
                for (const p of pending.values()) p.reject(new Error("raster window was reset"));
                pending.clear();
                reject(new Error(`raster ${kind} timed out`));
            }, timeoutMs);
            pending.set(mySeq, {
                resolve: (m) => { clearTimeout(timer); resolve(m); },
                reject: (err) => { clearTimeout(timer); reject(err); }
            });
            win.webContents.send(channel, { kind, seq: mySeq, ...payload });
        });
    }

    try {
        // the page learns its job channel from the URL hash — it has no other
        // way to know its own webContents id before the first message arrives
        await win.loadFile(path.join(__dirname, "..", "raster", "pdfraster.html"),
            { hash: channel });
        const opened = await ask("open", { bytes }, LOAD_TIMEOUT_MS);
        const numPages = opened.numPages;

        return {
            numPages,
            /** Render one page (1-based) at `scale` (1 ≈ 96 DPI). Returns a PNG Buffer. */
            async renderPage(pageNum, scale = 2) {
                const s = Math.max(0.5, Math.min(MAX_SCALE, +scale || 2));
                const r = await ask("render", { page: pageNum, scale: s }, RASTER_TIMEOUT_MS);
                // dataURL -> bytes; the renderer cannot hand raw buffers back
                const b64 = String(r.dataUrl || "").split(",")[1];
                if (!b64) throw new Error("raster produced no image");
                return Buffer.from(b64, "base64");
            },
            /** Render straight to a temp PNG file; caller owns cleanup. */
            async renderPageToFile(pageNum, scale = 2) {
                const buf = await this.renderPage(pageNum, scale);
                const out = path.join(os.tmpdir(),
                    `lcl-raster-${process.pid}-${Date.now()}-${pageNum}.png`);
                fs.writeFileSync(out, buf);
                return out;
            },
            close() {
                e.ipcMain.removeListener(channel + ":reply", onReply);
                for (const p of pending.values()) p.reject(new Error("raster closed"));
                pending.clear();
                if (!win.isDestroyed()) win.destroy();
            }
        };
    } catch (err) {
        e.ipcMain.removeListener(channel + ":reply", onReply);
        if (!win.isDestroyed()) win.destroy();
        throw err;
    }
}

/** Convenience: rasterise ONE page of a PDF to a temp PNG. */
async function rasterizePageToFile(pdfPath, pageNum = 1, scale = 2) {
    const doc = await openDoc(pdfPath);
    try {
        if (pageNum < 1 || pageNum > doc.numPages) {
            throw new Error(`page ${pageNum} is out of range (1-${doc.numPages})`);
        }
        return { file: await doc.renderPageToFile(pageNum, scale), numPages: doc.numPages };
    } finally { doc.close(); }
}

module.exports = { available, openDoc, rasterizePageToFile };
