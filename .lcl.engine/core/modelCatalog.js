/**
 * FINDING AN OPEN-WEIGHT MODEL, AND SAYING WHAT IT WILL COST YOU.
 *
 * The aim: add a model to a node from this UI — look it up, get a download,
 * then install it — so the user is more self-sufficient and less reliant on
 * paid AI in general.
 *
 * So this searches Hugging Face — the index every open-weight model actually
 * lives in — and answers the three questions that decide whether a model is
 * worth pulling onto a 128 GB box: how big is it, what licence is it under,
 * and which file do I actually want. It never downloads anything itself; it
 * returns facts, and the install path (over SSH, on the node) does the work.
 *
 * TWO RULES RUN THROUGH THIS FILE.
 *
 * 1. THE NETWORK SWITCH IS THE NETWORK SWITCH. A search is egress like any
 *    other, refused when the app is offline. There is no "just a search"
 *    exception, because that is how an offline-by-default app stops being one.
 *
 * 2. AN ID FROM THE INTERNET IS NEVER A COMMAND. Every identifier that comes
 *    back from here is destined for a shell on the operator's node, so it is
 *    validated against what a Hugging Face id can actually be — not escaped,
 *    VALIDATED, because escaping is a thing you get subtly wrong once and a
 *    remote code execution forever. Anything that does not match is refused
 *    here, at the door, rather than quoted carefully somewhere later.
 */
const https = require("https");
const paths = require("./paths");
const { ToolError } = require("./fsTools");

const HF = "huggingface.co";

/* ------------------------------------------------------------ validation --- */
/**
 * A Hugging Face repo id: `owner/name`, each 1-96 chars of letters, digits,
 * dot, dash or underscore. No slashes beyond the one, no spaces, no shell
 * metacharacters, no leading dash (which a command would read as a flag), no
 * `..` (which a path would read as an escape).
 */
const ID_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
function validRepoId(id) {
    const s = String(id || "");
    if (s.length > 193 || s.includes("..")) return false;
    const parts = s.split("/");
    if (parts.length !== 2) return false;
    return parts.every(p => ID_PART.test(p));
}

/**
 * A file path inside a repo: the same character set, plus `/`, and still no
 * `..` and no leading dash on any segment.
 */
function validRepoFile(f) {
    const s = String(f || "");
    if (!s || s.length > 400 || s.includes("..") || s.startsWith("/")) return false;
    return s.split("/").every(seg => ID_PART.test(seg));
}

/* ---------------------------------------------------------------- fetch --- */
function getJson(urlPath, { timeoutMs = 15_000, token = null } = {}) {
    return new Promise((resolve, reject) => {
        const headers = { Accept: "application/json",
            // a descriptive UA — bare "lcl" gets 403'd by Cloudflare-fronted hosts
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const req = https.request({
            host: HF, path: urlPath, method: "GET", headers, timeout: timeoutMs
        }, (res) => {
            let data = "";
            let n = 0;
            res.setEncoding("utf8");
            res.on("data", (c) => {
                n += c.length;
                if (n > 4_000_000) { req.destroy(); return reject(new ToolError("the index sent too much")); }
                data += c;
            });
            res.on("end", () => {
                if (res.statusCode === 401 || res.statusCode === 403) {
                    return reject(new ToolError(
                        "that model is gated — accept its licence on Hugging Face and " +
                        "add a token before it can be downloaded"));
                }
                if (res.statusCode === 404) return reject(new ToolError("no such model on Hugging Face"));
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new ToolError(`Hugging Face answered HTTP ${res.statusCode}`));
                }
                try { resolve(JSON.parse(data)); }
                catch { reject(new ToolError("Hugging Face did not answer with JSON")); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new ToolError("Hugging Face did not respond")); });
        req.on("error", (e) => reject(new ToolError(`could not reach Hugging Face: ${e.message}`)));
        req.end();
    });
}

function requireNetwork() {
    if (paths.readSettings().networkEnabled !== true) {
        throw new ToolError(
            "internet access is off for this — it turns on automatically when you " +
            "link an endpoint in Global › API's & Connections, or per conversation " +
            "in Session › Permissions");
    }
}

/* ---------------------------------------------------------- what we want --- */
/**
 * The shapes worth installing, per modality. `pipeline_tag` is Hugging Face's
 * own classification, so this is their taxonomy rather than one invented here.
 */
const KINDS = {
    image: { tags: ["text-to-image"], into: "ComfyUI checkpoints",
             exts: [".safetensors", ".ckpt", ".gguf"] },
    video: { tags: ["text-to-video", "image-to-video"], into: "ComfyUI models",
             exts: [".safetensors", ".gguf"] },
    // HONEST ABOUT THE MISSING ENGINE. This kind downloads weights to a
    // folder NO stack in nodeStacks.js creates and nothing on the node
    // serves — NVIDIA still publishes no audio-generation playbook (the
    // Nemotron Omni recipe covers audio INPUT only). The flag below is what
    // lets the panel say that to the operator instead of letting a download
    // imply a capability that is not there.
    audio: { tags: ["text-to-speech", "text-to-audio", "automatic-speech-recognition"],
             into: "audio models", exts: [".safetensors", ".gguf", ".bin", ".pt"],
             unserved: "no stack on the node serves audio models yet — NVIDIA " +
                       "publishes no audio-generation playbook. The download " +
                       "works; nothing will run it until an engine exists." },
    text:  { tags: ["text-generation"], into: "the LLM cache",
             exts: [".gguf", ".safetensors"] }
};

/** Search the index. Returns facts, never a download. */
async function search(query, { kind = null, limit = 25, token = null } = {}) {
    requireNetwork();
    const q = String(query || "").trim().slice(0, 120);
    const params = new URLSearchParams();
    if (q) params.set("search", q);
    if (kind && KINDS[kind]) params.set("pipeline_tag", KINDS[kind].tags[0]);
    params.set("limit", String(Math.max(1, Math.min(100, limit))));
    params.set("sort", "downloads");
    params.set("direction", "-1");
    params.set("full", "true");

    const rows = await getJson("/api/models?" + params.toString(), { token });
    if (!Array.isArray(rows)) return [];
    return rows.map(r => ({
        id: r.modelId || r.id,
        author: r.author || String(r.modelId || r.id || "").split("/")[0],
        pipeline: r.pipeline_tag || null,
        downloads: Number(r.downloads) || 0,
        likes: Number(r.likes) || 0,
        // THE LICENCE IS NOT A DETAIL. "Open weight" is not one thing, and the
        // operator's whole reason for this is self-sufficiency — a model he
        // cannot legally use for what he does is not self-sufficiency.
        license: (r.cardData && r.cardData.license) || null,
        gated: !!r.gated,
        updated: r.lastModified || null,
        // refused rather than trusted: an id that cannot be validated can
        // never reach a shell on the node, so it is not offered at all
        usable: validRepoId(r.modelId || r.id)
    })).filter(m => m.id && m.usable);
}

/** What is actually in a repo, and how big — the numbers that decide a pull. */
async function files(repoId, { token = null } = {}) {
    requireNetwork();
    if (!validRepoId(repoId)) throw new ToolError("that is not a valid model id");
    const info = await getJson(`/api/models/${repoId}?blobs=true`, { token });
    const siblings = Array.isArray(info.siblings) ? info.siblings : [];
    const out = siblings.map(s => ({
        path: s.rfilename,
        bytes: Number(s.size) || Number(s.lfs && s.lfs.size) || 0,
        usable: validRepoFile(s.rfilename)
    })).filter(f => f.path && f.usable);
    return {
        id: repoId,
        gated: !!info.gated,
        license: (info.cardData && info.cardData.license) || null,
        pipeline: info.pipeline_tag || null,
        files: out,
        totalBytes: out.reduce((a, f) => a + f.bytes, 0)
    };
}

/**
 * Which single file to pull for a modality, when the operator has not picked.
 * Prefers a quantised GGUF (smaller, and what llama.cpp wants), then the
 * largest safetensors — which for a diffusion repo is the checkpoint.
 */
function suggestFile(fileList, kind) {
    const want = (KINDS[kind] && KINDS[kind].exts) || [".safetensors", ".gguf"];
    const ok = (fileList || []).filter(f =>
        want.some(e => f.path.toLowerCase().endsWith(e)));
    if (!ok.length) return null;
    const gguf = ok.filter(f => f.path.toLowerCase().endsWith(".gguf"));
    const pool = gguf.length ? gguf : ok;
    return pool.slice().sort((a, b) => b.bytes - a.bytes)[0];
}

/** Human-sized, because 27917287424 is not a number anyone reads. */
function human(bytes) {
    const n = Number(bytes) || 0;
    // "128.0 GB" is not how anyone says it; the tenth is only worth printing
    // when it carries information
    if (n >= 1e9) return String(+(n / 1e9).toFixed(1)) + " GB";
    if (n >= 1e6) return Math.round(n / 1e6) + " MB";
    if (n >= 1e3) return Math.round(n / 1e3) + " KB";
    return n + " B";
}

/**
 * WILL IT FIT, AND WILL IT RUN? Asked before a 40 GB pull rather than after.
 * `freeBytes` comes from the node's own df; `memBytes` from its meminfo.
 */
function fitsOnNode(totalBytes, { freeBytes = 0, memBytes = 0 } = {}) {
    const need = Number(totalBytes) || 0;
    const reasons = [];
    // a download needs room for itself and a little to work in
    if (freeBytes && need > freeBytes - 5e9) {
        reasons.push(`needs ${human(need)} and the node has ${human(freeBytes)} free`);
    }
    // a model materially larger than memory will not load, however well it downloads
    if (memBytes && need > memBytes * 0.9) {
        reasons.push(`needs ${human(need)} against ${human(memBytes)} of memory`);
    }
    return { ok: reasons.length === 0, reasons };
}

module.exports = {
    KINDS, search, files, suggestFile, human, fitsOnNode,
    validRepoId, validRepoFile
};
