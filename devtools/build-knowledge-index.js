/**
 * Build the SHIPPED knowledge index — run under Electron on the dev machine:
 *
 *   app> ./node_modules/.bin/electron ../devtools/build-knowledge-index.js
 *
 * The built-in library ships as an INDEX (passages + vectors + citations),
 * not as gigabytes of source PDFs: the index IS the hardcoded knowledge the
 * product ships with, and every entry in it must be redistributable —
 * public domain, CC BY, CC BY-SA, or DSL. knowledge/MANIFEST.md carries the
 * per-document license and attribution.
 *
 * Chunks already computed for the same bytes under any existing library are
 * TRANSPLANTED by content hash (vectors included), so the hours of raster+OCR
 * spent on scanned handbooks are never paid twice. Only genuinely new files
 * extract and embed.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

const REPO = "C:/.lcl";
const SHIPPED = path.join(REPO, "knowledge");
const OUT = path.join(SHIPPED, "index.json");
const HARVEST_DIRS = [
    // the operator's installed .lcl data dir, resolved from the environment so
    // the path carries no username (works for any account, leaks nobody's)
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
              ".lcl", "data", "knowledge"),
    path.join(REPO, "data", "knowledge")
];
const LOG = path.join(os.tmpdir(), "lcl-shipped-index.log");
const log = (m) => { fs.appendFileSync(LOG, m + "\n"); };

process.on("uncaughtException", (e) => log("UNCAUGHT: " + (e && e.stack || e)));
process.on("unhandledRejection", (e) => log("UNHANDLED: " + (e && e.stack || e)));
app.on("window-all-closed", () => { /* raster windows come and go */ });

app.whenReady().then(async () => {
    fs.writeFileSync(LOG, "shipped index build " + new Date().toISOString() + "\n");
    const knowledge = require(path.join(REPO, ".lcl.engine", "core", "knowledge.js"));

    // 1. harvest: sha1 -> {chunks, entry} from every existing index
    //
    // --rebuild skips this entirely. The transplant keys on the SOURCE FILE's
    // sha1, which is exactly right when only the corpus changes and exactly
    // wrong when the CHUNKER changes: the bytes are identical, so every stale
    // chunk is adopted and not one page is re-extracted. Both chunker fixes so
    // far (the line-oriented split, and the storage cap that shortened 31 of
    // every 32 chunks) would have been silently transplanted straight past.
    const REBUILD = process.argv.includes("--rebuild");
    const bySha = new Map();
    for (const dir of REBUILD ? [] : HARVEST_DIRS) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".json")) continue;
            let idx;
            try { idx = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
            catch { continue; }
            const chunksByFile = new Map();
            for (const c of idx.chunks || []) {
                if (!chunksByFile.has(c.file)) chunksByFile.set(c.file, []);
                chunksByFile.get(c.file).push(c);
            }
            for (const [rel, e] of Object.entries(idx.files || {})) {
                if (e && e.sha1 && e.chunks > 0 && chunksByFile.has(rel)) {
                    if (!bySha.has(e.sha1)) {
                        bySha.set(e.sha1, { entry: e, chunks: chunksByFile.get(rel) });
                    }
                }
            }
        }
    }
    log(`harvested ${bySha.size} indexed documents from existing libraries`);

    // 2. register the shipped folder as a dev library and seed its index
    const lib = knowledge.list().find(l =>
        String(l.root).toLowerCase().replace(/\\/g, "/") === SHIPPED.toLowerCase())
        || knowledge.add(SHIPPED, "Shipped knowledge (build)");
    const devIdxFile = path.join(REPO, "data", "knowledge", lib.id + ".json");
    let idx = { files: {}, chunks: [] };
    let transplanted = 0;
    const walk = (d, base = "") => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(d, e.name), base + e.name + "/")
            : [[base + e.name, path.join(d, e.name)]]);
    for (const [rel, full] of walk(SHIPPED)) {
        if (rel === "index.json" || rel.endsWith(".md")) continue;
        const st = fs.statSync(full);
        const sha1 = crypto.createHash("sha1").update(fs.readFileSync(full)).digest("hex");
        const hit = bySha.get(sha1);
        if (hit) {
            idx.files[rel] = { ...hit.entry, size: st.size, mtimeMs: st.mtimeMs, sha1 };
            for (const c of hit.chunks) idx.chunks.push({ ...c, file: rel });
            transplanted++;
        }
    }
    fs.mkdirSync(path.dirname(devIdxFile), { recursive: true });
    fs.writeFileSync(devIdxFile, JSON.stringify(idx));
    log(REBUILD
        ? "--rebuild: transplant skipped, every document re-extracted from source"
        : `seeded ${transplanted} documents (${idx.chunks.length} chunks) by transplant`);

    // 3. reindex fills the gaps (new files extract + embed; raster available)
    let last = 0;
    const t0 = Date.now();
    const r = await knowledge.reindex(lib.id, (m) => {
        const now = Date.now();
        if (now - last < 10_000) return;
        last = now;
        log(`  [${Math.round((now - t0) / 1000)}s] ${String(m).slice(0, 110)}`);
    });
    log(`reindex DONE ${Math.round((Date.now() - t0) / 1000)}s: ` +
        `${r.files} files, ${r.chunks} chunks, embedded ${r.embedded}` +
        (r.error ? ` ERROR ${r.error}` : ""));

    // 4. emit the shipped index
    fs.copyFileSync(devIdxFile, OUT);
    log(`wrote ${OUT} (${Math.round(fs.statSync(OUT).size / 1e6)} MB)`);
    app.quit();
});
