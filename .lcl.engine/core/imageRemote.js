/**
 * RENDERING A PICTURE SOMEWHERE ELSE, WITH THE SAME CONTRACT.
 *
 * The two non-local tiers of the image fallback chain. Both return EXACTLY the
 * shape `imageGen.generate` returns — `{written, bytes, created, seconds,
 * width, height}` plus a `where` — so the agent, the transcript and the
 * workspace cannot tell which machine produced the file. A fallback that
 * returned a different shape would be a second code path through every
 * consumer, which is how "it works, except sometimes" gets built.
 *
 * THE FILE ALWAYS LANDS IN THE WORKSPACE, root-contained through the same
 * resolveInRoot every local write uses. Bytes arriving from a remote service
 * are still bytes being written to the operator's disk, and they get the same
 * containment as anything else.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { ToolError, resolveInRoot } = require("./fsTools");
const paths = require("./paths");
const cloudModels = require("./cloudModels");
const secretGuard = require("./secretGuard");
const comfy = require("./comfyClient");

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;   // a PNG larger than this is a mistake

/** Where the picture goes, decided the same way the local renderer decides. */
function outPathFor(root, args) {
    let rel = typeof args.path === "string" && args.path.trim()
        ? args.path.trim()
        : `images/generated-${Date.now()}.png`;
    if (!/\.png$/i.test(rel)) rel += ".png";
    let full = resolveInRoot(root, rel);      // throws on escape attempts
    // same overwrite discipline as the local engine: a collision diverts to a
    // fresh name unless {"overwrite": true} was explicit, and existed is only
    // ever true for a sanctioned replacement — created stays honest downstream
    let existed = fs.existsSync(full);
    let preserved = null;
    if (existed && args.overwrite !== true) {
        const stem = rel.replace(/\.png$/i, "");
        for (let n = 2; n < 1000; n++) {
            const cand = `${stem}-${n}.png`;
            const candFull = resolveInRoot(root, cand);
            if (!fs.existsSync(candFull)) { preserved = rel; rel = cand; full = candFull; existed = false; break; }
        }
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    return { rel: rel.split(path.sep).join("/"), full, existed, preserved };
}

function writeImage(full, buf) {
    if (!buf || !buf.length) throw new ToolError("the image service returned no image data");
    if (buf.length > MAX_IMAGE_BYTES) {
        throw new ToolError(`the image service returned ${(buf.length / 1e6).toFixed(1)} MB, ` +
                            `which is larger than this tool will write`);
    }
    // a PNG starts \x89PNG; a JPEG starts \xFF\xD8. Anything else is not an
    // image and must not be written under a .png name.
    const png = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
    const jpg = buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8;
    if (!png && !jpg) throw new ToolError("the image service returned something that is not an image");
    fs.writeFileSync(full, buf);
    return buf.length;
}

function fetchBuffer(url, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === "https:" ? https : http;
        const req = lib.get(url, { timeout: timeoutMs }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new ToolError(`image download failed (HTTP ${res.statusCode})`));
            }
            const chunks = [];
            let n = 0;
            res.on("data", (c) => {
                n += c.length;
                if (n > MAX_IMAGE_BYTES) { req.destroy(); return reject(new ToolError("image too large")); }
                chunks.push(c);
            });
            res.on("end", () => resolve(Buffer.concat(chunks)));
        });
        req.on("timeout", () => { req.destroy(); reject(new ToolError("image download timed out")); });
        req.on("error", (e) => reject(new ToolError(`image download failed: ${e.message}`)));
    });
}

/**
 * The endpoint's own authenticated POST. The API key stays inside
 * cloudModels — this module never sees it, which is why there is no key
 * getter anywhere in this file.
 */
function postJson(ep, urlPath, bodyObj, timeoutMs = 180_000) {
    return cloudModels.authedPostJson(ep, urlPath, bodyObj, timeoutMs);
}

/* ------------------------------------------------------------- the node --- */
/**
 * THE USER'S OWN MACHINE, WHEN IT CAN.
 *
 * Measured, not assumed: the node door (tools/node-door/lcl-door.py) proxies
 * an ALLOWLIST of LLM routes only — /v1/chat/completions, /v1/embeddings,
 * /api/generate and friends. There is no image route on it, so today this tier
 * cannot run and says so with the reason rather than pretending to try.
 *
 * It is written as a real tier anyway because the moment a node advertises an
 * image endpoint, this is the only place that has to change — and the chain,
 * the gates and the reporting around it are already proven.
 */
/**
 * The node's ComfyUI, if it has one. NVIDIA's Spark playbook serves it on
 * 8188; `comfyUrl` on the node record overrides that for anything unusual.
 */
function comfyBaseFor(node) {
    if (node && typeof node.comfyUrl === "string" && node.comfyUrl.trim()) {
        return node.comfyUrl.trim().replace(/\/+$/, "");
    }
    try {
        const u = new URL(node.baseUrl);
        return `${u.protocol}//${u.hostname}:8188`;
    } catch { return null; }
}

async function viaNode({ args, ctx }) {
    const nodes = (() => {
        try { return (cloudModels.endpoints() || []).filter(e => cloudModels.isNodeEndpoint(e)); }
        catch { return []; }
    })();
    if (!nodes.length) return { ok: false, skipped: "no local node is linked" };
    const root = ctx && ctx.root;
    if (!root) return { ok: false, skipped: "no workspace folder to write into" };

    // TWO DIALECTS, THE OPERATOR'S HARDWARE FIRST EITHER WAY.
    //
    // ComfyUI is what NVIDIA's own DGX Spark playbook installs for images and
    // video, and it does NOT speak /v1/images/generations — its API is a
    // workflow graph. Rather than demand a translation shim be installed and
    // kept running on a machine the operator is not sitting at, .lcl speaks
    // both: ComfyUI natively, and the OpenAI shape for any node that offers it.
    for (const node of nodes) {
        const base = comfyBaseFor(node);
        if (!base) continue;
        const live = await comfy.probe(base);
        if (!live.ok) continue;
        const startedAt = Date.now();
        const out = outPathFor(root, args);
        const r = await comfy.generate(base, {
            prompt: String(args.prompt || ""),
            negative: String(args.negative || ""),
            width: args.width || 512, height: args.height || 512,
            steps: Number(args.steps) || 20,
            cancelToken: (ctx && ctx.cancelToken) || { cancelled: false },
            onNote: (ctx && ctx.onNote) || (() => {})
        });
        const bytes = writeImage(out.full, r.bytes);
        return { ok: true, where: `your node ${node.label || node.id} (ComfyUI)`,
                 result: { written: out.rel, bytes, created: !out.existed,
                           seconds: r.seconds,
                           width: args.width || 512, height: args.height || 512,
                           renderedOn: `${node.label || node.id} · ComfyUI` } };
    }

    // no ComfyUI answered — fall through to a node that declares the OpenAI shape
    const capable = nodes.filter(n => n && Array.isArray(n.capabilities)
        && n.capabilities.includes("image"));
    if (!capable.length) {
        return { ok: false,
                 skipped: "no linked node is running ComfyUI (port 8188) or offers " +
                          "an image endpoint — see the DGX Spark ComfyUI playbook" };
    }
    // the session's drawing assignment outranks list order here too
    const wantN = (() => {
        try { return ctx && ctx.session && ctx.session.taskModels
            && ctx.session.taskModels.drawing
            && ctx.session.taskModels.drawing.endpointId; } catch { return null; }
    })();
    const node = (wantN && capable.find(n => n.id === wantN)) || capable[0];
    const startedAt = Date.now();
    const out = outPathFor(root, args);
    const j = await postJson(node, cloudModels.apiPrefixOf(node) + "/images/generations", {
        prompt: String(args.prompt || ""),
        n: 1,
        size: `${args.width || 512}x${args.height || 512}`,
        response_format: "b64_json"
    });
    const item = (j && j.data && j.data[0]) || {};
    const buf = item.b64_json ? Buffer.from(item.b64_json, "base64")
        : item.url ? await fetchBuffer(item.url) : null;
    const bytes = writeImage(out.full, buf);
    return { ok: true, where: `your node ${node.label || node.id}`,
             result: { written: out.rel, bytes, created: !out.existed,
                       seconds: Math.round((Date.now() - startedAt) / 100) / 10,
                       width: args.width || 512, height: args.height || 512,
                       renderedOn: node.label || node.id } };
}

/* -------------------------------------------------------------- the API --- */
/**
 * A PAID ENDPOINT, UNDER EVERY RULE AN OUTBOUND CALL ALREADY OBEYS.
 *
 * Four things must be true before a prompt leaves the machine, and none of
 * them is new here — they are the same rules the model path follows:
 *   - the network switch is on;
 *   - the endpoint is linked and advertises image generation;
 *   - the SECRET GUARD has seen the prompt and found nothing of the
 *     operator's in it (a prompt is user text, and user text is exactly where
 *     a pasted key ends up);
 *   - the K3 approval names the destination and is answered yes. No approve
 *     hook supplied is a NO, exactly as the router treats it.
 */
async function viaApi({ args, ctx }) {
    if (paths.readSettings().networkEnabled !== true) {
        return { ok: false, skipped: "the network switch is off" };
    }
    const eps = (() => {
        try { return cloudModels.endpoints() || []; } catch { return []; }
    })();
    // THE SESSION'S OWN DRAWING ASSIGNMENT STEERS THE ENGINE. Model
    // Orchestration's drawing pick routed only the chat drive before — the
    // image tool ignored it and took the first capable endpoint. The
    // assignment is preferred; capability still decides eligibility.
    const want = (() => {
        try { return ctx && ctx.session && ctx.session.taskModels
            && ctx.session.taskModels.drawing
            && ctx.session.taskModels.drawing.endpointId; } catch { return null; }
    })();
    const drawable = (e) => e && !cloudModels.isNodeEndpoint(e)
        && Array.isArray(e.capabilities) && e.capabilities.includes("image")
        && e.imageModel;
    // an endpoint declares it can draw; nothing is guessed from a vendor name
    const target = (want && eps.find(e => drawable(e) && e.id === want))
        || eps.find(drawable);
    if (!target) {
        return { ok: false,
                 skipped: "no linked endpoint offers image generation (set one up in " +
                          "Global › Models & API)" };
    }

    // THE LOCAL VERDICT DOES NOT TRAVEL.
    //
    // `generate_image` is classified MUTATE (media.write) — a picture written
    // to disk. Sending the prompt to a third party is EGRESS, a different
    // classification with a different floor, and inheriting the local approval
    // into it would be a real escape: the operator agreed to a file being
    // written here, not to their words leaving the machine. So the egress
    // decision is asked FRESH, of the kernel, for this session.
    try {
        const policy = require("./policyBridge");
        const session = (ctx && ctx.session) || {};
        const verdict = policy.check(session, "ask_cloud_model",
            { prompt: String(args.prompt || "") }, {});
        if (verdict && verdict.decision === policy.DECISION.DENY) {
            return { ok: false, skipped: "this conversation does not allow anything " +
                                         "to leave the machine" };
        }
    } catch { /* an unreadable policy is not permission — fall through to the card */ }

    const prompt = String(args.prompt || "");
    // THE PROMPT IS USER TEXT, AND USER TEXT IS WHERE A PASTED KEY ENDS UP.
    secretGuard.assertNoLeak(prompt, `this image prompt to ${target.label || target.id}`);

    // CONSENT, THROUGH THE ONE CARD. No hook means no — the same rule the
    // router applies, so a tool can never become the quiet way to spend.
    const approve = ctx && typeof ctx.approveFallback === "function" ? ctx.approveFallback : null;
    if (!approve) return { ok: false, skipped: "nothing was able to ask you about paying for it" };
    const allowed = await approve({
        selection: { model: target.imageModel, label: target.label || target.id, id: target.id },
        model: target.imageModel, endpoint: target.label || target.id,
        reason: "image generation could not run on this machine",
        fellBackFrom: "this machine",
        kind: "image"
    });
    if (!allowed) return { ok: false, skipped: "you declined paying for it" };

    const root = ctx && ctx.root;
    if (!root) return { ok: false, skipped: "no workspace folder to write into" };
    const startedAt = Date.now();
    const out = outPathFor(root, args);
    // THE ROUTE IS BUILT FROM THE ENDPOINT'S OWN PREFIX. A hardcoded "/v1"
    // doubles the path on a host whose base already carries one — DeepInfra
    // roots at /v1/openai, so this asked for /v1/openai/v1/images/generations
    // and 404d every time. The capability probe has always used the prefix.
    const j = await postJson(target, cloudModels.apiPrefixOf(target) + "/images/generations", {
        model: target.imageModel,
        prompt,
        n: 1,
        size: `${args.width || 512}x${args.height || 512}`,
        response_format: "b64_json"
    });
    const item = (j && j.data && j.data[0]) || {};
    const buf = item.b64_json ? Buffer.from(item.b64_json, "base64")
        : item.url ? await fetchBuffer(item.url) : null;
    const bytes = writeImage(out.full, buf);

    // IT COST MONEY, SO IT IS IN THE LEDGER. Image endpoints price per image
    // rather than per token, so the row carries the endpoint's own declared
    // price and no invented token counts.
    try {
        const usd = Number(target.imageUsdPerImage) || 0;
        if (usd > 0) {
            require("./ledger").record({
                sessionId: ctx && ctx.sessionId, sessionTitle: ctx && ctx.sessionTitle,
                model: target.imageModel, endpoint: target.label || target.id,
                inputTokens: 0, outputTokens: 0, usd,
                via: "tool-fallback"
            });
            if (typeof ctx.onSpend === "function") ctx.onSpend(usd);
        }
    } catch { /* bookkeeping never breaks a tool */ }

    return { ok: true, where: `${target.label || target.id}`,
             result: { written: out.rel, bytes, created: !out.existed,
                       seconds: Math.round((Date.now() - startedAt) / 100) / 10,
                       width: args.width || 512, height: args.height || 512,
                       renderedOn: target.label || target.id } };
}

module.exports = { viaNode, viaApi, outPathFor, writeImage };
