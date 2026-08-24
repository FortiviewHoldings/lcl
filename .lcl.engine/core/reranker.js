const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const paths = require("./paths");
const { ToolError } = require("./fsTools");

/**
 * Cross-encoder RERANKING — the precision half of retrieval.
 *
 * Embedding search scores the query and a passage SEPARATELY and compares the
 * two vectors, so it can only ever measure "these are about similar things".
 * That is why bge-small clusters everything a library contains into a narrow
 * 0.5-0.7 band: it is good at finding the right neighbourhood and bad at
 * ordering within it.
 *
 * A cross-encoder reads the query and the passage TOGETHER and scores that
 * pair directly. It cannot be used to search — scoring every chunk in a
 * library would take minutes — but over the ~20 candidates the embedder
 * returns it is fast, and it is far better at deciding which one actually
 * answers the question. Recall from the bi-encoder, precision from the
 * cross-encoder: that is the whole design.
 *
 * Same operational posture as the embedding server: our own llama-server on a
 * random loopback port with a per-run key, spawned on demand, stopped when
 * idle. It is a 640 MB model, so idling it out matters more than it does for
 * the 35 MB embedder.
 */

const PORT = 20000 + Math.floor(Math.random() * 30000);
const HOST = "127.0.0.1";
const IDLE_STOP_MS = 3 * 60_000;
const MAX_DOCS = 32;              // candidates per call; more is slower, not better
const DOC_CHARS = 1600;           // what the cross-encoder actually reads
const REQUEST_TIMEOUT_MS = 90_000;

let child = null;
let idleTimer = null;
let starting = null;
const apiKey = crypto.randomBytes(16).toString("hex");

function modelFile() {
    const registry = paths.modelRegistry();
    const entry = (registry.models || []).find(m => m.role === "reranker");
    if (!entry || !entry.file) return null;
    for (const d of [paths.bundledModelsDir(), paths.modelsDir()]) {
        const p = path.join(d, entry.file);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function available() {
    const build = paths.selectBuild("llama.cpp");
    return !!(build && fs.existsSync(build.binary) && modelFile());
}

function touchIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, IDLE_STOP_MS);
    if (idleTimer.unref) idleTimer.unref();
}

function stop() {
    if (child && child.pid) {
        try {
            if (process.platform === "win32") {
                spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
            } else child.kill();
        } catch { /* gone */ }
    }
    child = null;
}

function health() {
    return new Promise(resolve => {
        http.get({ host: HOST, port: PORT, path: "/health", timeout: 1500,
                   headers: { Authorization: `Bearer ${apiKey}` } },
            r => resolve(r.statusCode === 200)).on("error", () => resolve(false));
    });
}

async function ensureUp() {
    if (child && await health()) { touchIdle(); return; }
    if (starting) { await starting; return; }

    starting = (async () => {
        const build = paths.selectBuild("llama.cpp");
        const model = modelFile();
        if (!build || !model) throw new ToolError("the reranking model is not installed");

        child = spawn(build.binary, [
            "--model", model,
            "--host", HOST, "--port", String(PORT),
            // --reranking turns on /v1/rerank; rank pooling is what a
            // cross-encoder needs (a single relevance logit, not an embedding)
            "--reranking", "--pooling", "rank",
            "--ctx-size", "2048",
            "--threads", "4", "--gpu-layers", "0",
            "--api-key", apiKey
        ], { cwd: path.dirname(build.binary), windowsHide: true, stdio: "ignore" });
        child.on("close", () => { child = null; });

        for (let i = 0; i < 60; i++) {
            // OUR child must be the thing answering — a health 200 with the
            // child dead means someone else owns the port
            if (!child) throw new ToolError("the reranking engine exited while starting");
            if (await health()) { touchIdle(); return; }
            await new Promise(r => setTimeout(r, 500));
        }
        stop();
        throw new ToolError("the reranking engine did not start");
    })();
    try { await starting; } finally { starting = null; }
}

function rankRequest(query, documents) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ model: "r", query, documents, top_n: documents.length });
        const req = http.request({
            host: HOST, port: PORT, path: "/v1/rerank", method: "POST",
            headers: { "Content-Type": "application/json",
                       "Content-Length": Buffer.byteLength(body),
                       Authorization: `Bearer ${apiKey}` },
            timeout: REQUEST_TIMEOUT_MS
        }, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    const j = JSON.parse(data);
                    const rows = j.results || j.data || [];
                    if (!Array.isArray(rows)) return reject(new ToolError("rerank returned no results"));
                    resolve(rows);
                } catch { reject(new ToolError("reranking engine returned malformed data")); }
            });
        });
        req.on("error", e => reject(new ToolError(`rerank request failed: ${e.message}`)));
        req.on("timeout", () => { req.destroy(new Error("timed out")); });
        req.write(body); req.end();
    });
}

/**
 * Re-score `hits` against the query and return them best-first.
 *
 * Each hit needs the passage text (hit.text, falling back to hit.preview). The
 * returned hits carry BOTH scores: `score` becomes the cross-encoder's verdict
 * and `embedScore` preserves what the embedder thought, so a caller can show
 * or debug the difference rather than losing it.
 *
 * NEVER throws: reranking is an improvement, not a dependency. If the engine
 * is missing or misbehaves the original embedding order is returned unchanged.
 */
async function rerank(query, hits, { topK = hits.length } = {}) {
    const q = String(query || "").trim();
    if (!Array.isArray(hits)) return [];
    // Every early exit must still honour topK: the caller asked for N results
    // and must get N whether or not the cross-encoder was involved.
    if (!q || hits.length < 2 || !available()) return hits.slice(0, topK);

    const candidates = hits.slice(0, MAX_DOCS);
    const rest = hits.slice(MAX_DOCS);
    const docs = candidates.map(h =>
        String(h.text || h.preview || "").slice(0, DOC_CHARS));
    if (docs.some(d => !d.trim())) {
        // a passage with no text cannot be scored fairly; leave the order alone
        return hits.slice(0, topK);
    }

    let rows;
    try {
        await ensureUp();
        rows = await rankRequest(q, docs);
        touchIdle();
    } catch {
        return hits.slice(0, topK);      // fall back to embedding order
    }

    const scored = candidates.map((h) => ({ ...h, embedScore: h.score, score: h.score }));
    for (const r of rows) {
        const i = typeof r.index === "number" ? r.index : -1;
        if (i < 0 || i >= scored.length) continue;
        const s = typeof r.relevance_score === "number" ? r.relevance_score : r.score;
        if (typeof s !== "number") continue;
        // A cross-encoder emits an unbounded LOGIT (observed range here: -0.3
        // to -11). Callers compare scores against 0..1 thresholds, so a raw
        // logit silently reads as "irrelevant" and would switch grounding off
        // entirely. Squash it into a relevance probability and keep the raw
        // value for anyone who wants it.
        scored[i].logit = +s.toFixed(3);
        scored[i].score = +(1 / (1 + Math.exp(-s))).toFixed(3);
        scored[i].reranked = true;
    }
    // if nothing came back scored, do not pretend we reordered anything
    if (!scored.some(h => h.reranked)) return hits.slice(0, topK);

    scored.sort((a, b) => b.score - a.score);
    return scored.concat(rest).slice(0, topK);
}

module.exports = { available, rerank, stop, MAX_DOCS, DOC_CHARS };
