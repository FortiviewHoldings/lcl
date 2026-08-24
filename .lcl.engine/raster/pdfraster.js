/**
 * The hidden raster page: receives a PDF's bytes, renders requested pages to
 * a canvas, replies with PNG data URLs. Loaded only by pdfRaster.js in a
 * hidden window; the job channel arrives in the URL hash.
 */
import * as pdfjsLib from "../../node_modules/pdfjs-dist/legacy/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
    new URL("../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).href;

const channel = decodeURIComponent(location.hash.slice(1));
const canvas = document.getElementById("c");
let doc = null;

window.raster.listen(channel, async (msg) => {
    const reply = (m) => window.raster.reply(channel, { seq: msg.seq, ...m });
    try {
        if (msg.kind === "open") {
            doc = await pdfjsLib.getDocument({
                data: msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes),
                // no ranged fetches, no external cmaps/fonts — fully local
                disableAutoFetch: true, isEvalSupported: false
            }).promise;
            reply({ numPages: doc.numPages });
        } else if (msg.kind === "render") {
            if (!doc) throw new Error("no document open");
            const page = await doc.getPage(msg.page);
            const viewport = page.getViewport({ scale: msg.scale || 2 });
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const ctx = canvas.getContext("2d", { alpha: false });
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport }).promise;
            reply({ dataUrl: canvas.toDataURL("image/png") });
            page.cleanup();
        } else {
            throw new Error(`unknown raster job "${msg.kind}"`);
        }
    } catch (e) {
        reply({ error: String((e && e.message) || e).slice(0, 300) });
    }
});
