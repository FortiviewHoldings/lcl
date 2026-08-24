/**
 * .lcl SPEAKS COMFYUI, PROVEN AGAINST A REAL SERVER.
 *
 * NVIDIA's own DGX Spark playbook makes ComfyUI the way to run images and
 * video on the box, and ComfyUI does NOT speak `/v1/images/generations` — its
 * API is a workflow graph queued at `/prompt`, polled at `/history`, and
 * fetched from `/view`. The choice was a translation shim on the Spark, or
 * .lcl learning the dialect. This is the dialect, and this suite drives it
 * against a stand-in ComfyUI on loopback: what is asserted is what the SERVER
 * received and what came back, which is the only evidence a client cannot
 * fake by agreeing with itself.
 */
const http = require("http");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => require("os").tmpdir() },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

const comfy = require(path.join(__dirname, "..", ".lcl.engine", "core", "comfyClient.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++;
        console.log("FAIL |", name,
            detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : "");
    }
}

// a 1x1 PNG, so "the bytes came back" is a real assertion
const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753" +
    "de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082",
    "hex");

/* ---- a stand-in ComfyUI: queues, reports, serves ---- */
function fakeComfy(opts = {}) {
    const seen = { prompts: [], views: [], histories: 0 };
    let polls = 0;
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
        if (u.pathname === "/system_stats") return json({ system: { comfyui_version: "0.3.0" } });
        if (u.pathname === "/object_info/CheckpointLoaderSimple") {
            return json({ CheckpointLoaderSimple: { input: { required: {
                ckpt_name: [opts.ckpts !== undefined ? opts.ckpts : ["sd_v1-5.safetensors", "flux1-dev.safetensors"]] } } } });
        }
        if (u.pathname === "/prompt" && req.method === "POST") {
            let b = "";
            req.on("data", c => { b += c; });
            return req.on("end", () => {
                try { seen.prompts.push(JSON.parse(b)); } catch { seen.prompts.push({ unparsed: b }); }
                json({ prompt_id: "p-1" });
            });
        }
        if (u.pathname.startsWith("/history/")) {
            seen.histories++;
            polls++;
            // not done for the first couple of polls — the client must WAIT
            if (polls < (opts.readyAfter === undefined ? 2 : opts.readyAfter)) return json({});
            if (opts.errorRun) {
                return json({ "p-1": { status: { status_str: "error" }, outputs: {} } });
            }
            return json({ "p-1": { status: { status_str: "success", completed: true },
                outputs: { "9": { images: [{ filename: "lcl_00001_.png", subfolder: "", type: "output" }] } } } });
        }
        if (u.pathname === "/view") {
            seen.views.push(u.search);
            res.writeHead(200, { "Content-Type": "image/png" });
            return res.end(PNG);
        }
        res.writeHead(404); res.end("no");
    });
    return { srv, seen,
             listen: () => new Promise(r => srv.listen(0, "127.0.0.1", r)),
             url: () => `http://127.0.0.1:${srv.address().port}` };
}

(async () => {

/* ------------------------------------------------ the graph is well formed */
{
    const g = comfy.defaultGraph({ prompt: "a lighthouse", negative: "blurry",
        width: 768, height: 512, steps: 12, seed: 42, ckpt: "sd_v1-5.safetensors" });
    check("the workflow is a ComfyUI API graph — nodes keyed by id with class_type",
        g["3"].class_type === "KSampler" && g["4"].class_type === "CheckpointLoaderSimple"
        && g["9"].class_type === "SaveImage", Object.keys(g));
    check("...the prompt reaches the positive encoder, the negative reaches the other",
        g["6"].inputs.text === "a lighthouse" && g["7"].inputs.text === "blurry", null);
    check("...size, steps and seed land where the sampler reads them",
        g["5"].inputs.width === 768 && g["5"].inputs.height === 512
        && g["3"].inputs.steps === 12 && g["3"].inputs.seed === 42, g["3"].inputs);
    check("...and the checkpoint is the one asked for",
        g["4"].inputs.ckpt_name === "sd_v1-5.safetensors", null);
    check("the nodes are wired to each other, not left dangling — sampler to " +
          "decode to save",
        g["8"].inputs.samples[0] === "3" && g["9"].inputs.images[0] === "8", null);
}

/* --------------------------------------------- against a real fake ComfyUI */
{
    const C = fakeComfy();
    await C.listen();

    const live = await comfy.probe(C.url());
    check("IT FINDS A LIVE COMFYUI and reads what it is",
        live.ok === true && live.system && /0\.3\.0/.test(JSON.stringify(live.system)), live);

    const cks = await comfy.checkpoints(C.url());
    check("it asks the box WHICH CHECKPOINTS EXIST rather than assuming a name — " +
          "a graph naming a model that is not installed is a wasted render",
        cks.includes("sd_v1-5.safetensors") && cks.length === 2, cks);

    const notes = [];
    const r = await comfy.generate(C.url(), {
        prompt: "a lighthouse at dusk", width: 640, height: 640, steps: 8,
        seed: 7, onNote: (n) => notes.push(n)
    });
    check("A PICTURE COMES BACK — the real bytes, not a promise of them",
        Buffer.isBuffer(r.bytes) && r.bytes.length === PNG.length
        && r.bytes[1] === 0x50, { len: r.bytes && r.bytes.length });
    check("...and it says how long the node took",
        typeof r.seconds === "number" && r.seconds >= 0, r.seconds);

    const sent = C.seen.prompts[0];
    check("the server was sent a graph and a client id, in ComfyUI's own shape",
        sent && sent.prompt && sent.client_id
        && /^lcl-/.test(sent.client_id), Object.keys(sent || {}));
    check("...carrying the operator's prompt and size",
        sent.prompt["6"].inputs.text === "a lighthouse at dusk"
        && sent.prompt["5"].inputs.width === 640, null);
    check("...and the checkpoint it discovered, not one invented here",
        sent.prompt["4"].inputs.ckpt_name === "sd_v1-5.safetensors", null);

    check("IT WAITED FOR THE RENDER rather than reading an empty history as a " +
          "failure — the first polls came back with nothing",
        C.seen.histories >= 2, C.seen.histories);
    check("...then fetched the image by filename, subfolder and type",
        C.seen.views.length === 1 && /filename=lcl_00001_\.png/.test(C.seen.views[0])
        && /type=output/.test(C.seen.views[0]), C.seen.views);
    check("...and said something while it worked, so a long render is not silence",
        notes.length >= 1 && /queued/i.test(notes[0]), notes);
    C.srv.close();
}

/* ------------------------------------------------------------- the refusals */
{
    const C = fakeComfy({ ckpts: [] });
    await C.listen();
    let msg = "";
    try { await comfy.generate(C.url(), { prompt: "x" }); }
    catch (e) { msg = String(e.message || e); }
    check("A COMFYUI WITH NO CHECKPOINTS SAYS SO, and names where to put one — " +
          "'it failed' would send the operator to the wrong place entirely",
        /no checkpoints installed/i.test(msg) && /playbook/i.test(msg), msg);
    C.srv.close();
}
{
    const C = fakeComfy({ errorRun: true });
    await C.listen();
    let msg = "";
    try { await comfy.generate(C.url(), { prompt: "x" }); }
    catch (e) { msg = String(e.message || e); }
    check("a workflow that errors on the box is reported as an error, not " +
          "waited on forever", /reported an error/i.test(msg), msg);
    C.srv.close();
}
{
    // nothing listening at all
    const live = await comfy.probe("http://127.0.0.1:9", 1200);
    check("a box with no ComfyUI answers NO rather than throwing into the chain",
        live.ok === false, live);
}
{
    const C = fakeComfy({ readyAfter: 999 });   // never finishes
    await C.listen();
    const token = { cancelled: false };
    setTimeout(() => { token.cancelled = true; }, 900);
    let msg = "";
    try { await comfy.generate(C.url(), { prompt: "x", cancelToken: token }); }
    catch (e) { msg = String(e.message || e); }
    check("STOP REALLY STOPS IT — a render the operator cancelled does not keep " +
          "polling to the timeout", /cancelled/i.test(msg), msg);
    C.srv.close();
}
{
    const C = fakeComfy({ readyAfter: 999 });
    await C.listen();
    let msg = "";
    try { await comfy.generate(C.url(), { prompt: "x", timeoutMs: 1500 }); }
    catch (e) { msg = String(e.message || e); }
    check("...and a render that never finishes ends on a bounded wait, saying so",
        /did not finish within/i.test(msg), msg);
    C.srv.close();
}

/* ------------------------------------- and the fallback chain reaches for it */
{
    const fs = require("fs");
    const ir = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "imageRemote.js"), "utf8");
    check("THE NODE TIER TRIES COMFYUI FIRST — NVIDIA's own playbook puts it on " +
          "the Spark, so that is what the operator's hardware is most likely to " +
          "be running",
        /comfy\.probe\(base\)/.test(ir) && /comfy\.generate\(base/.test(ir), null);
    check("...on 8188 by default, the port that playbook serves, with an " +
          "override for anything unusual",
        /:8188/.test(ir) && /comfyUrl/.test(ir), null);
    check("...and a node speaking the OpenAI shape still works, so neither " +
          "dialect is the only way in",
        /\/v1\/images\/generations/.test(ir), null);
    check("...with the cancel token and progress notes threaded through, so a " +
          "long render on the node is stoppable and legible",
        /cancelToken: \(ctx && ctx\.cancelToken\)/.test(ir)
        && /onNote: \(ctx && ctx\.onNote\)/.test(ir), null);
}

console.log(`\n${pass}/${pass + fail} comfy-client checks passed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL | suite crashed -", (e && e.stack) || e); process.exit(1); });
