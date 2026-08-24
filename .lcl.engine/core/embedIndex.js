const { spawn } = require("child_process");
const os = require("os");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const paths = require("./paths");
const { ToolError, resolveInRoot, realpathOrNull, isProbablyBinary } = require("./fsTools");

/**
 * Semantic search over a linked workspace, fully local.
 *
 * bge-small (35 MB) runs as its own llama-server in --embedding mode on a
 * second loopback port, spawned on demand and stopped after idling. At that
 * size it needs no load planner: weights + context fit in under 100 MB, two
 * orders of magnitude below anything the memory rules care about.
 *
 * The index lives OUTSIDE the workspace (app data dir, keyed by workspace
 * path hash) so the agent's own writes can never corrupt it, and it refreshes
 * incrementally by file mtime+size — a search after editing one file
 * re-embeds one file, not the folder.
 */

// A RANDOM port per app run: a fixed port means any local process that binds
// it first would receive the workspace's text (our spawn would fail and the
// health poll would happily accept the impostor's 200). Random + child-alive
// checks shrink that to nothing.
const EMBED_PORT = 20000 + Math.floor(Math.random() * 30000);
const HOST = "127.0.0.1";
const IDLE_STOP_MS = 5 * 60_000;
const CHUNK_CHARS = 1100;           // ~250-280 tokens, inside bge's 512 window
const CHUNK_OVERLAP = 150;
// The largest text chunkText() may emit — a HARD ceiling, not a target.
//
// bge-small's position embedding is 512 tokens. Anything longer is not
// truncated by the server, it is REFUSED with HTTP 500 "input is too large".
// This constant briefly carried 200 chars of slack (CHUNK_CHARS + 200) so a
// sentence would not be cut mid-word; on real source code 1300 chars tokenised
// to 560 and every ingest died on it. 1100 chars is ~500 tokens even at the
// worst density code produces (~2.2 chars/token), so the ceiling now holds.
//
// EXPORTED because knowledge.js caps stored passages against it: when its cap
// was the smaller of the two, every full chunk was quietly shortened on the way
// to disk — after being embedded at full length. Two constants in two files,
// drifting apart in silence. One source of truth, and a test that pins them.
const MAX_CHUNK_CHARS = CHUNK_CHARS;
const MAX_FILE_BYTES = 512_000;     // match search_files' cap
const MAX_INDEX_FILES = 400;
const TOP_K_MAX = 12;
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".gguf",
    ".zip", ".exe", ".dll", ".pdf", ".mp3", ".wav", ".mp4", ".woff", ".woff2"]);

let child = null;
let idleTimer = null;
let starting = null;
let apiKey = crypto.randomBytes(16).toString("hex");

function embedModelFile() {
    const registry = paths.modelRegistry();
    const entry = (registry.models || []).find(m => m.role === "embedding");
    if (!entry || !entry.file) return null;
    for (const d of [paths.bundledModelsDir(), paths.modelsDir()]) {
        const p = path.join(d, entry.file);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function available() {
    const build = paths.selectBuild("llama.cpp");
    return !!(build && fs.existsSync(build.binary) && embedModelFile());
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
        http.get({ host: HOST, port: EMBED_PORT, path: "/health", timeout: 1500,
                   headers: { Authorization: `Bearer ${apiKey}` } },
            r => resolve(r.statusCode === 200)).on("error", () => resolve(false));
    });
}

async function ensureUp() {
    if (child && await health()) { touchIdle(); return; }
    if (starting) { await starting; return; }

    starting = (async () => {
        const build = paths.selectBuild("llama.cpp");
        const model = embedModelFile();
        if (!build || !model) throw new ToolError("the embedding model is not installed");

        // bge-small is 33 MB. It was being run on 2 CPU threads with no GPU —
        // settings sized for a model two orders of magnitude larger. Indexing a
        // 118-file repo took 146 seconds almost entirely in this server.
        //
        // It gets the GPU (33 MB cannot threaten a load plan; the planner exists
        // for multi-gigabyte weights) and half the cores. --batch-size matches
        // the 512-token window so a full chunk is one batch instead of two.
        const threads = Math.max(2, Math.min(8, Math.floor((os.cpus().length || 4) / 2)));
        child = spawn(build.binary, [
            "--model", model,
            "--host", HOST, "--port", String(EMBED_PORT),
            "--embedding", "--ctx-size", "512",
            "--batch-size", "512", "--ubatch-size", "512",
            "--threads", String(threads), "--gpu-layers", "99",
            "--api-key", apiKey
        ], { cwd: path.dirname(build.binary), windowsHide: true, stdio: "ignore" });
        child.on("close", () => { child = null; });

        for (let i = 0; i < 30; i++) {
            // OUR child must be the thing answering — a health 200 with the
            // child dead means someone else owns the port; never talk to it
            if (!child) throw new ToolError("the embedding engine exited while starting");
            if (await health()) { touchIdle(); return; }
            await new Promise(r => setTimeout(r, 500));
        }
        stop();
        throw new ToolError("the embedding engine did not start");
    })();
    try { await starting; } finally { starting = null; }
}

function embedRequest(inputs) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ input: inputs, model: "e" });
        const req = http.request({
            host: HOST, port: EMBED_PORT, path: "/v1/embeddings", method: "POST",
            headers: { "Content-Type": "application/json",
                       "Content-Length": Buffer.byteLength(body),
                       Authorization: `Bearer ${apiKey}` },
            timeout: 60_000
        }, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    const j = JSON.parse(data);
                    // An error body ({"error":{...}}, a 503 while the model
                    // loads, an overloaded server) must REJECT, not resolve
                    // as an empty list — `(j.data || [])` silently became
                    // all-null vectors downstream, and the indexer once
                    // recorded files as fully indexed off the back of it.
                    if (res.statusCode !== 200 || !Array.isArray(j.data)
                        || j.data.length !== inputs.length) {
                        return reject(new ToolError(
                            `embedding engine error (${res.statusCode}): ` +
                            ((j.error && j.error.message) || data.slice(0, 80))));
                    }
                    resolve(j.data.map(d => d.embedding));
                } catch { reject(new ToolError("embedding engine returned malformed data")); }
            });
        });
        req.on("error", e => reject(new ToolError(`embedding request failed: ${e.message}`)));
        req.write(body); req.end();
    });
}

/* ------------------------------------------------------------------ index */

function indexFile(root) {
    // case-fold only where the filesystem does — lowercasing on a
    // case-sensitive volume would merge two distinct workspaces' indexes
    let norm = String(realpathOrNull(root) || root);
    if (process.platform === "win32") norm = norm.toLowerCase();
    const key = crypto.createHash("sha1").update(norm).digest("hex").slice(0, 16);
    const dir = path.join(paths.dataDir(), "semindex");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${key}.json`);
}

// parsed-index cache: re-reading and re-parsing megabytes of vectors on every
// search was pure waste; entries invalidate whenever we write the file
const indexCache = new Map();

function loadIndex(root) {
    const file = indexFile(root);
    const cached = indexCache.get(file);
    if (cached) return cached;
    let idx;
    try { idx = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { idx = { files: {}, chunks: [] }; }
    indexCache.set(file, idx);
    return idx;
}

function saveIndex(root, idx) {
    const file = indexFile(root);
    fs.writeFileSync(file, JSON.stringify(idx), "utf8");
    indexCache.set(file, idx);
}

/** Forget a workspace: its index holds plaintext previews of its files. */
function purgeIndex(root) {
    try {
        const file = indexFile(root);
        indexCache.delete(file);
        fs.rmSync(file, { force: true });
    } catch { /* nothing stored */ }
}

/**
 * Split a line that is longer than a chunk into chunk-sized pieces, breaking
 * at a space so words survive.
 *
 * This exists because A PDF PAGE IS ONE LINE. pdf.js joins a page's text items
 * with spaces, so every page arrives here as a single line with no newlines at
 * all — and the line-oriented loop below could only ever emit two chunks for
 * it: one truncated to CHUNK_CHARS, and one final chunk holding the entire
 * rest of the page. Storage then caps each chunk at PASSAGE_CHARS, so a
 * 23,600-character page kept 2,400 characters and dropped the other 90% with
 * no error anywhere. Measured, not theorised.
 */
function splitLongLine(line, size) {
    const out = [];
    let i = 0;
    while (i < line.length) {
        let end = Math.min(i + size, line.length);
        if (end < line.length) {
            // back off to the last space in the final 15% so words stay whole
            const window = Math.floor(size * 0.15);
            const space = line.lastIndexOf(" ", end);
            if (space > end - window && space > i) end = space;
        }
        out.push(line.slice(i, end));
        i = end;
        while (line[i] === " ") i++;          // do not start a chunk on a space
    }
    return out;
}

/**
 * Split text into embeddable chunks, BOUNDED BY CONSTRUCTION.
 *
 * The old shape was "append, then truncate": push a line, and once the buffer
 * passed CHUNK_CHARS emit `buf.join("\n").slice(0, CHUNK_CHARS + 200)`. Two
 * defects came out of that one line.
 *
 *   - Truncating after the fact DISCARDS text. The slice threw away whatever
 *     sat past the cap, silently, after the chunker had correctly produced it.
 *   - The final chunk (line 268 in the old file) was pushed with NO cap at all,
 *     so a trailing buffer could be any size whatsoever — and an oversized chunk
 *     is not truncated by the embedding server, it is REFUSED with HTTP 500.
 *
 * Now the buffer is flushed BEFORE it would overflow, so every chunk is within
 * the ceiling without a single character being dropped. Long lines are split to
 * MAX_CHUNK_CHARS - CHUNK_OVERLAP so that even a full-size line landing on top
 * of a full-size overlap still fits.
 */
function chunkText(text) {
    const chunks = [];
    const lineCap = MAX_CHUNK_CHARS - CHUNK_OVERLAP;
    const lines = String(text || "").split("\n")
        .flatMap(l => (l.length > lineCap ? splitLongLine(l, lineCap) : l));
    let buf = [];
    let bufChars = 0;
    let startLine = 1;
    for (let i = 0; i < lines.length; i++) {
        const add = lines[i].length + 1;
        if (buf.length && bufChars + add > MAX_CHUNK_CHARS) {
            const emitted = buf.join("\n");
            chunks.push({ text: emitted, line: startLine });
            // Overlap so a match sitting on a boundary survives in one piece.
            //
            // It is a CHARACTER tail, not a run of whole lines. Keeping whole
            // lines works for source code and collapses for prose: a PDF page
            // arrives as one enormous line, splitLongLine cuts it into ~950
            // character pieces, and "keep whole lines until 150 characters" then
            // keeps a 950 character line — an overlap the size of a chunk. The
            // buffer never drained, every chunk was the previous chunk plus one
            // line, and the output blew past the ceiling.
            const tail = emitted.slice(-CHUNK_OVERLAP);
            startLine = i;
            buf = tail ? [tail] : [];
            bufChars = tail ? tail.length + 1 : 0;
        }
        buf.push(lines[i]);
        bufChars += add;
    }
    if (buf.join("").trim()) chunks.push({ text: buf.join("\n"), line: startLine });

    // BACKSTOP. The loop above keeps chunks inside the ceiling by construction,
    // but separator arithmetic is exactly the kind of off-by-one that ships: a
    // 50,000-character unbroken token came out one byte over. An oversized chunk
    // is not clipped by the embedding server, it is REFUSED, and a refusal used
    // to kill the whole ingest — so the ceiling is enforced twice.
    //
    // It SPLITS; it does not truncate. Truncating here would be the same silent
    // text loss this whole file has been chasing.
    const out = [];
    for (const c of chunks) {
        if (c.text.length <= MAX_CHUNK_CHARS) { out.push(c); continue; }
        for (const piece of splitLongLine(c.text, MAX_CHUNK_CHARS)) {
            if (piece) out.push({ text: piece, line: c.line });
        }
    }
    return out;
}

function* walkFiles(rootReal) {
    const stack = [rootReal];
    const skipDirs = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "images"]);
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            const rp = realpathOrNull(full);
            if (!rp || (rp !== rootReal && !rp.startsWith(rootReal + path.sep))) continue;
            if (e.isDirectory()) {
                if (!skipDirs.has(e.name)) stack.push(full);
            } else if (e.isFile()) {
                yield full;
            }
        }
    }
}

/**
 * Bring the index up to date. Returns {embedded, removed, total} so the tool
 * can report real work. Progress lands on onNote for the activity feed.
 */
async function refreshIndex(root, onNote = () => {}) {
    const rootReal = realpathOrNull(root);
    if (!rootReal) throw new ToolError("linked folder is unavailable");
    const idx = loadIndex(root);
    const seen = new Set();
    let embedded = 0;
    let fileCount = 0;
    let skipped = 0;

    for (const full of walkFiles(rootReal)) {
        if (++fileCount > MAX_INDEX_FILES) break;
        const rel = path.relative(rootReal, full).split(path.sep).join("/");
        seen.add(rel);

        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size > MAX_FILE_BYTES || st.size === 0) continue;
        if (SKIP_EXT.has(path.extname(full).toLowerCase())) continue;

        const known = idx.files[rel];
        if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) continue;
        if (isProbablyBinary(full)) continue;

        let text;
        try { text = fs.readFileSync(full, "utf8"); } catch { continue; }

        const chunks = chunkText(text);
        if (!chunks.length) continue;

        onNote(`embedding ${rel} (${chunks.length} chunks)`);

        // embed(), NOT embedRequest(). This line called the raw request for its
        // whole life, which meant workspace indexing had NONE of the protection
        // embed() provides: bge-small's window is 512 tokens, one token-dense
        // chunk (a minified line, a wide table, a base64 blob) returns HTTP 500
        // "input is too large", and because nothing caught it the error escaped
        // refreshIndex and KILLED THE ENTIRE INGEST. Indexing this repo died on
        // .gitignore — the first file. That is why linking a workspace never
        // finished. embed() splits and truncates the offender and keeps going.
        let vectors;
        try {
            vectors = await embed(chunks.map(c => c.text));
        } catch (e) {
            // A file that still cannot be embedded is skipped, not fatal. The
            // run must survive one bad file out of four hundred.
            onNote(`skipped ${rel}: ${String(e.message || e).slice(0, 90)}`);
            skipped++;
            continue;
        }

        idx.chunks = idx.chunks.filter(c => c.file !== rel);
        for (let i = 0; i < chunks.length; i++) {
            if (!vectors[i]) continue;
            idx.chunks.push({ file: rel, line: chunks[i].line,
                              preview: chunks[i].text.slice(0, 160),
                              v: vectors[i] });
        }
        idx.files[rel] = { size: st.size, mtimeMs: st.mtimeMs };
        embedded++;
    }

    // drop entries for files that no longer exist
    let removed = 0;
    for (const rel of Object.keys(idx.files)) {
        if (!seen.has(rel)) {
            delete idx.files[rel];
            idx.chunks = idx.chunks.filter(c => c.file !== rel);
            removed++;
        }
    }

    if (embedded || removed) saveIndex(root, idx);
    return { embedded, removed, skipped, totalChunks: idx.chunks.length, idx };
}

function cosine(a, b) {
    // a stale or malformed index entry (null/short vector) must score 0, never
    // throw and abort the whole retrieval
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d ? dot / d : 0;
}

/**
 * Tool entry: meaning-based search. Refreshes the index incrementally first,
 * so results always reflect the folder as it is now.
 */
async function semanticSearch(root, { query, top_k = 6 } = {}, ctx = {}) {
    if (typeof query !== "string" || !query.trim()) {
        throw new ToolError('semantic_search needs {"query": "what you are looking for"}');
    }
    resolveInRoot(root, ".");            // same containment gate as every tool
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    const k = Math.max(1, Math.min(Number(top_k) || 6, TOP_K_MAX));

    const { embedded, totalChunks, idx } = await refreshIndex(root, onNote);
    if (!idx.chunks.length) {
        return { results: [], note: "no indexable text files in this folder" };
    }

    onNote(embedded ? `index refreshed (${embedded} files) — searching` : "searching index");
    await ensureUp();
    // embedOne progressively truncates to fit bge-small's 512-token window; a raw
    // embedRequest with only a char cap let a token-dense ~2000-char query exceed
    // the window and reject ("input is too large"), aborting the whole search
    // instead of degrading — exactly what embedOne exists to prevent.
    const qv = await embedOne(query);
    if (!qv) throw new ToolError("could not embed the query");

    const scored = idx.chunks
        .map(c => ({ file: c.file, line: c.line, preview: c.preview,
                     score: +cosine(qv, c.v).toFixed(3) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

    return { results: scored, indexedChunks: totalChunks, refreshedFiles: embedded };
}

/**
 * Shared embedding primitive: ensure the bge server is up, embed a batch of
 * strings, and keep it warm. knowledge.js reuses this so there is exactly ONE
 * embedding server on the machine, not two competing for the same tiny model.
 */
/**
 * Is the embedding server already running?
 *
 * The distinction matters on the per-turn grounding path: embedding a query
 * against a WARM server costs milliseconds, but a cold one has to spawn
 * llama-server and load the model first, and doing that between the user
 * pressing enter and the first token is a stall they did not ask for. Callers
 * that can afford to skip retrieval check this and skip.
 */
function isWarm() {
    return !!child;
}

/** Start the server in the background without blocking the caller. */
function warm() {
    if (child || starting) return;
    ensureUp().catch(() => { /* it will be retried on the next real use */ });
}

/**
 * One input, with progressive truncation. bge-small's positional limit is 512
 * TOKENS, and the server rejects anything past it — but the only unit we have
 * client-side is characters, and the chars-per-token ratio swings from ~4
 * (English prose) to ~1.4 (bilingual text, symbol tables: a real SI-brochure
 * chunk hit 1416 tokens inside 2000 chars). So rather than strangling every
 * chunk to the worst case, retry the rare offender at tighter caps. The tail
 * lost to truncation is lost to the 512-token window either way.
 */
async function embedOne(text) {
    let lastLen = Infinity;
    for (const cap of [2000, 1200, 700, 350]) {
        const t = text.slice(0, cap);
        if (t.length >= lastLen) continue;    // identical to the previous attempt
        lastLen = t.length;
        try {
            const v = await embedRequest([t]);
            return v[0] || null;
        } catch (e) {
            if (!/too large/i.test(String(e.message))) throw e;
        }
    }
    return null;
}

async function embed(inputs) {
    // POSITION-PRESERVING: return exactly one slot per input, null for blanks.
    // Compacting the array (dropping blanks) would misalign vectors with the
    // caller's parallel metadata array — a chunk after a blank one would be
    // stored against the WRONG citation. The null slots let callers skip with
    // `if (!v) continue` and stay aligned.
    const arr = (Array.isArray(inputs) ? inputs : [inputs])
        .map(s => String(s || "").slice(0, 2000));
    const keep = [];
    for (let i = 0; i < arr.length; i++) if (arr[i].trim()) keep.push(i);
    if (!keep.length) return arr.map(() => null);
    await ensureUp();
    const out = arr.map(() => null);
    try {
        const vecs = await embedRequest(keep.map(i => arr[i]));
        keep.forEach((k, j) => { out[k] = vecs[j] || null; });
    } catch (e) {
        // ONE oversized input fails the WHOLE batch with "too large" — the
        // server gives no per-input verdicts. Fall back to per-input embeds
        // with truncation, so 47 good chunks are not held hostage by one
        // token-dense table. Anything else propagates: a down server must
        // fail loudly, not degrade into nulls.
        if (!/too large/i.test(String(e.message))) throw e;
        for (const k of keep) out[k] = await embedOne(arr[k]);
    }
    return out;
}

const TOOL_ENTRY = {
    run: semanticSearch,
    help: 'semantic_search {"query": "where sessions get saved"} — find files by MEANING, ' +
        'not exact text; returns the closest passages with file:line'
};

module.exports = { available, isWarm, warm, semanticSearch, TOOL_ENTRY, stop, purgeIndex,
                   chunkText, cosine, refreshIndex, embed, MAX_CHUNK_CHARS };
