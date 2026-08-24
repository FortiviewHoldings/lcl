const fs = require("fs");
const path = require("path");
const engine = require("./engine");
const paths = require("./paths");
const { ToolError, resolveInRoot } = require("./fsTools");
// lazy: cloudModels pulls in electron safeStorage, and visionTool is loaded by
// the tool manifest in contexts (tests, the capability map) that have no
// Electron. Required at call time, never at module load.
let _cloud = null;
const cloudModels = new Proxy({}, { get: (_t, k) => {
    if (!_cloud) _cloud = require("./cloudModels");
    return _cloud[k];
} });

/**
 * read_image — the agent LOOKS at an image in the workspace.
 *
 * Runs through the SAME resident engine: when a vision-capable model (one
 * with an mmproj projector) is loaded, llama-server accepts image parts in
 * chat completions. No second engine, no extra memory beyond the projector
 * the planner already accounted for.
 *
 * Only offered when the ACTIVE model can actually see — a help line for a
 * blind model just teaches it to call things that fail.
 */

const MAX_IMAGE_BYTES = 8_000_000;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

/**
 * Model ids that are multimodal, by name.
 *
 * Same class of judgment cloudModels.isChatCapable already makes for the
 * picker: an endpoint rarely publishes a "can see" flag, but the family name
 * is unambiguous. Used ONLY to decide whether to offer the tool — a wrong
 * guess surfaces the endpoint's own error rather than a silent failure.
 */
const VISION_NAME = /(^|[-_/])(llava|bakllava|moondream|pixtral|minicpm-?v|cogvlm|internvl|glm-?4v|glm-?4\.\d*v)|vision|vl\b|-vl-|multimodal|gemma-?3|llama-?3\.2-(11|90)b|qwen2?\.?5?-?vl/i;

function looksVisionCapable(id) {
    return VISION_NAME.test(String(id || ""));
}

/**
 * WHO CAN SEE FOR THIS TURN — the local model, or the user's own node.
 *
 * Vision stays off third-party APIs by design (see readImage). A NODE is not
 * a third party: it is hardware the user owns and pays the power bill
 * for, and the requirement is that its models perform the same level of tasks
 * that the local models can. Refusing to look at an image because the work
 * moved to the user's own node is the opposite of that. Returns null,
 * "local", or "node".
 */
// `sessionSel` is THIS SESSION's resolved driver, when the caller has one:
// undefined keeps the app-wide answer (what every existing caller wants),
// null means the local engine, an object means that endpoint. Without it a
// session running on the node would be told "the current model cannot see
// images" because the APP default happens to be a text-only API — a decision
// about a conversation, made from another conversation's settings.
function visionDriver(sessionSel) {
    if (localModelSees()) return "local";
    try {
        const sel = sessionSel !== undefined
            ? sessionSel : cloudModels.selectedFor("driver");
        if (sel && cloudModels.isNodeEndpoint(sel) && looksVisionCapable(sel.model)) {
            return "node";
        }
    } catch { /* no endpoint configured */ }
    return null;
}

function activeModelSees(sessionSel) {
    return !!visionDriver(sessionSel);
}

function localModelSees() {
    const st = engine.status();
    // running: visionReady means the projector was ACTUALLY loaded — the
    // registry flag alone can be true while the file is absent.
    if (st.running) return !!st.visionReady;
    // Not running (idle-unloaded): the tool must still be OFFERED when the
    // preferred model will see once the turn's transparent reload brings it
    // back — withdrawing it here made vision vanish after every idle unload.
    const info = st.modelInfo;
    if (!info || !info.vision || !info.mmproj) return false;
    return [paths.bundledModelsDir(), paths.modelsDir()]
        .some(d => fs.existsSync(path.join(d, info.mmproj)));
}

async function readImage(root, { path: relPath, question } = {}, ctx = {}) {
    const who = visionDriver(ctx.selection);
    if (!who) {
        // say which of the two reasons applies, because the remedies differ
        let remote = null;
        try {
            remote = ctx.selection !== undefined
                ? ctx.selection : cloudModels.selectedFor("driver");
        } catch { /* none */ }
        if (remote && !cloudModels.isNodeEndpoint(remote)) {
            throw new ToolError(
                "images are not sent to a third-party API. Switch to a local " +
                "vision model, or run this on your own node.");
        }
        throw new ToolError(
            "the current model cannot see images — switch to a vision model " +
            "(qwen3-vl) from the model button first");
    }
    const full = resolveInRoot(root, relPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        throw new ToolError(`not a file: ${relPath}`);
    }
    const mime = MIME[path.extname(full).toLowerCase()];
    if (!mime) {
        throw new ToolError(`not a supported image type (${Object.keys(MIME).join(" ")})`);
    }
    if (fs.statSync(full).size > MAX_IMAGE_BYTES) {
        throw new ToolError("image is too large (8 MB cap)");
    }

    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote(`looking at ${relPath}`);

    const dataUri = `data:${mime};base64,${fs.readFileSync(full).toString("base64")}`;
    const ask = typeof question === "string" && question.trim()
        ? question.trim().slice(0, 500)
        : "Describe this image factually: subject, layout, any readable text. Be concise.";

    const messages = [{
        role: "user",
        content: [
            { type: "image_url", image_url: { url: dataUri } },
            { type: "text", text: ask }
        ]
    }];

    // NOT router.generate. The routing here is deliberate and narrower than
    // the router's: an image goes to the resident local model, or to the
    // user's OWN NODE, and nowhere else. Shipping someone's images to a
    // third-party API because they linked one for CHAT is not a thing this
    // does without being asked — but a node is their own hardware, so
    // refusing there was denying the parity the node exists to provide.
    if (who === "node") {
        const res = await cloudModels.streamChat(messages, {
            maxTokens: 512, temperature: 0.2, cancelToken: ctx.cancelToken,
            // the node THIS SESSION is on, not whichever one the app default
            // names — the two are no longer necessarily the same machine
            selection: ctx.selection
        });
        const out = String((res && res.output) || "").trim();
        if (!out) throw new ToolError("the node returned no description");
        return { file: relPath, question: ask, description: out, via: "node" };
    }

    const res = await engine.generate(messages, 512, ctx.cancelToken);
    if (res.error) throw new ToolError(`vision failed: ${res.error}`);
    return { file: relPath, question: ask, description: res.content.trim(), via: "local" };
}

const TOOL_ENTRY = {
    run: readImage,
    help: 'read_image {"path": "images/gen.png", "question": "what does it show?"} — ' +
        'look at an image in the folder and answer about it'
};

module.exports = { readImage, activeModelSees, visionDriver, looksVisionCapable, TOOL_ENTRY };
