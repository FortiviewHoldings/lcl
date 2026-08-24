/**
 * SPEAKING COMFYUI, BECAUSE COMFYUI DOES NOT SPEAK OPENAI.
 *
 * NVIDIA's own DGX Spark playbook (build.nvidia.com/spark/comfyui) makes
 * ComfyUI the way to run images AND video on the box — Stable Diffusion, FLUX,
 * Wan 2.1, HunyuanVideo, Cosmos. It serves on port 8188 and its API is a
 * WORKFLOW GRAPH, not `/v1/images/generations`:
 *
 *     POST /prompt          {prompt: <graph>, client_id}  -> {prompt_id}
 *     GET  /history/<id>                                  -> outputs, when done
 *     GET  /view?filename=&subfolder=&type=output         -> the bytes
 *
 * There were two ways to bridge that. A shim on the Spark translating OpenAI
 * to ComfyUI is one more service to install, keep running and debug on a
 * machine the operator is not sitting at. Teaching .lcl the dialect is a file
 * in this repo, versioned with the app, testable here. That is this file.
 *
 * THE GRAPH IS DATA, NOT CODE. The workflow below is the ordinary
 * text-to-image graph every ComfyUI install can run, kept minimal on purpose;
 * a richer one (FLUX, or a video graph) can be dropped in as JSON without
 * touching this logic, which is exactly why NVIDIA publishes `*.api.json`
 * files alongside the playbook.
 */
const http = require("http");
const https = require("https");
const { ToolError } = require("./fsTools");

/** The default text-to-image graph, in ComfyUI's API format. */
function defaultGraph({ prompt, negative, width, height, steps, seed, ckpt }) {
    return {
        "3": { class_type: "KSampler", inputs: {
            seed, steps, cfg: 7, sampler_name: "euler", scheduler: "normal",
            denoise: 1, model: ["4", 0], positive: ["6", 0],
            negative: ["7", 0], latent_image: ["5", 0] } },
        "4": { class_type: "CheckpointLoaderSimple",
               inputs: { ckpt_name: ckpt } },
        "5": { class_type: "EmptyLatentImage",
               inputs: { width, height, batch_size: 1 } },
        "6": { class_type: "CLIPTextEncode",
               inputs: { text: prompt, clip: ["4", 1] } },
        "7": { class_type: "CLIPTextEncode",
               inputs: { text: negative || "", clip: ["4", 1] } },
        "8": { class_type: "VAEDecode",
               inputs: { samples: ["3", 0], vae: ["4", 2] } },
        "9": { class_type: "SaveImage",
               inputs: { filename_prefix: "lcl", images: ["8", 0] } }
    };
}

function req(base, urlPath, { method = "GET", body = null, timeoutMs = 30_000, raw = false } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base.replace(/\/+$/, "") + urlPath);
        const lib = u.protocol === "https:" ? https : http;
        const headers = {};
        if (body) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(body);
        }
        const r = lib.request({
            host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + u.search, method, headers, timeout: timeoutMs
        }, (res) => {
            const chunks = [];
            let n = 0;
            res.on("data", (c) => {
                n += c.length;
                // a picture is the only large thing here; anything past this is
                // not an answer this client should be holding in memory
                if (n > 32 * 1024 * 1024) { r.destroy(); return reject(new ToolError("ComfyUI sent too much data")); }
                chunks.push(c);
            });
            res.on("end", () => {
                const buf = Buffer.concat(chunks);
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new ToolError(
                        `ComfyUI refused (HTTP ${res.statusCode}): ` +
                        buf.toString("utf8").slice(0, 300)));
                }
                if (raw) return resolve(buf);
                try { resolve(JSON.parse(buf.toString("utf8"))); }
                catch { reject(new ToolError("ComfyUI did not answer with JSON")); }
            });
        });
        r.on("timeout", () => { r.destroy(); reject(new ToolError("ComfyUI timed out")); });
        r.on("error", (e) => reject(new ToolError(`ComfyUI is unreachable: ${e.message}`)));
        if (body) r.write(body);
        r.end();
    });
}

/** Is a ComfyUI actually there? Cheap, and it names what it found. */
async function probe(base, timeoutMs = 6000) {
    try {
        const stats = await req(base, "/system_stats", { timeoutMs });
        return { ok: true, system: (stats && stats.system) || null };
    } catch { return { ok: false }; }
}

/** Which checkpoints the box has, so a prompt is not sent to a graph that
 *  names a model that is not installed. */
async function checkpoints(base, timeoutMs = 8000) {
    try {
        const info = await req(base, "/object_info/CheckpointLoaderSimple", { timeoutMs });
        const node = info && info.CheckpointLoaderSimple;
        const list = node && node.input && node.input.required
            && node.input.required.ckpt_name && node.input.required.ckpt_name[0];
        return Array.isArray(list) ? list : [];
    } catch { return []; }
}

/**
 * Render one image and return its BYTES.
 *
 * Polls `/history` rather than opening the websocket: the websocket carries
 * live node-by-node progress, which is lovely and is not what a tool call
 * needs — it needs the picture, a bounded wait, and a way to be cancelled.
 */
async function generate(base, opts = {}) {
    const {
        prompt, negative = "", width = 512, height = 512, steps = 20,
        seed = Math.floor(Math.random() * 1e15), ckpt = null,
        graph = null, timeoutMs = 300_000, cancelToken = { cancelled: false },
        onNote = () => {}
    } = opts;
    if (!String(prompt || "").trim()) throw new ToolError("a prompt is required");

    let useCkpt = ckpt;
    if (!graph && !useCkpt) {
        const list = await checkpoints(base);
        if (!list.length) {
            throw new ToolError(
                "ComfyUI is running but has no checkpoints installed — add one to " +
                "its models/checkpoints folder (see the DGX Spark ComfyUI playbook)");
        }
        useCkpt = list[0];
    }
    const workflow = graph || defaultGraph({
        prompt: String(prompt), negative: String(negative),
        width, height, steps, seed, ckpt: useCkpt
    });

    const clientId = "lcl-" + Math.random().toString(36).slice(2, 10);
    const queued = await req(base, "/prompt", {
        method: "POST",
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        timeoutMs: 30_000
    });
    const id = queued && queued.prompt_id;
    if (!id) throw new ToolError("ComfyUI accepted nothing — no prompt id came back");
    onNote(`queued on the node (${useCkpt || "custom graph"})`);

    const startedAt = Date.now();
    let waited = 0;
    for (;;) {
        if (cancelToken.cancelled) throw new ToolError("cancelled");
        if (Date.now() - startedAt > timeoutMs) {
            throw new ToolError(`ComfyUI did not finish within ${Math.round(timeoutMs / 1000)}s`);
        }
        await new Promise(r => setTimeout(r, waited < 5 ? 700 : 2000));
        waited++;
        let hist = null;
        try { hist = await req(base, `/history/${encodeURIComponent(id)}`, { timeoutMs: 10_000 }); }
        catch { continue; }        // a blip while it works is not a failure
        const entry = hist && hist[id];
        if (!entry) continue;
        const status = entry.status || {};
        if (status.status_str === "error" || (status.completed === false && status.status_str === "error")) {
            throw new ToolError("ComfyUI reported an error running the workflow");
        }
        const outputs = entry.outputs || {};
        for (const nodeId of Object.keys(outputs)) {
            const imgs = outputs[nodeId] && outputs[nodeId].images;
            if (!Array.isArray(imgs) || !imgs.length) continue;
            const im = imgs[0];
            const q = `/view?filename=${encodeURIComponent(im.filename)}` +
                      `&subfolder=${encodeURIComponent(im.subfolder || "")}` +
                      `&type=${encodeURIComponent(im.type || "output")}`;
            const bytes = await req(base, q, { timeoutMs: 60_000, raw: true });
            return { bytes, filename: im.filename,
                     seconds: Math.round((Date.now() - startedAt) / 100) / 10 };
        }
        if (waited % 10 === 0) onNote(`still rendering on the node (${waited * 2}s)`);
    }
}

module.exports = { defaultGraph, probe, checkpoints, generate };
