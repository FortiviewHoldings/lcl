/**
 * REPAIR THE THREE DOCUMENTS THE SHIPPED INDEX LOST.
 *
 *   app> ./node_modules/.bin/electron ../devtools/repair-knowledge-index.js
 *
 * tests/knowledge-reader.js found three files with chunks in knowledge/index.json
 * and no entry in its `files` map:
 *
 *     mechanical/MIL-HDBK-5J-metallic-materials.pdf              632 of 1733 pages
 *     mathematics/Basic-Analysis-I-...-Jiri-Lebl-v6.3.pdf         16 of  312 pages
 *     mathematics/Basic-Analysis-II-...-Jiri-Lebl-v6.3.pdf        18 of  217 pages
 *
 * That is the signature of an interrupted index build: chunks are appended as
 * pages are processed, and the `files` entry is written at the END, when the
 * document is complete. Three documents never got there. The damage is worse
 * than a missing bookkeeping row:
 *
 *   - Only the first few pages of each book were ever searchable. Basic
 *     Analysis I is a 312-page real analysis textbook and the index held its
 *     front matter. The model could cite it and would find nothing in it.
 *   - With no `files` entry the incremental indexer sees each one as NEW on
 *     every run, so a rebuild appends a second copy of those chunks rather
 *     than replacing them.
 *
 * The repair drops the partial chunks and lets the ordinary indexer do the
 * whole job, so the result is produced by the same chunker and the same
 * embedder as everything else in the corpus — a hand-patched `files` entry
 * would have hidden the truncation instead of fixing it.
 *
 * Then re-run, in order:
 *     node devtools/pack-knowledge-index.js
 *     node devtools/build-knowledge-text.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");

const REPO = path.join(__dirname, "..");
const SHIPPED = path.join(REPO, "knowledge");
const OUT = path.join(SHIPPED, "index.json");
const LOG = path.join(os.tmpdir(), "lcl-knowledge-repair.log");

const log = (m) => {
    const line = typeof m === "string" ? m : JSON.stringify(m);
    fs.appendFileSync(LOG, line + "\n");
    process.stdout.write(line + "\n");
};

process.on("uncaughtException", (e) => log("UNCAUGHT: " + (e && e.stack || e)));
process.on("unhandledRejection", (e) => log("UNHANDLED: " + (e && e.stack || e)));
app.on("window-all-closed", () => { /* raster windows come and go */ });

app.whenReady().then(async () => {
    fs.writeFileSync(LOG, "knowledge repair " + new Date().toISOString() + "\n");
    const knowledge = require(path.join(REPO, ".lcl.engine", "core", "knowledge.js"));

    log("reading the shipped index…");
    const idx = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const chunks = idx.chunks || [];
    const files = idx.files || {};

    // Reattach vectors: the shipped index is packed (vectors live in a separate
    // Float32 blob), and reindex writes an UNPACKED index. Round-tripping
    // without this would drop every embedding in the corpus.
    if (idx.packed) {
        const dims = idx.vectorDims;
        const buf = fs.readFileSync(path.join(SHIPPED, "vectors.f32"));
        const all = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        if (all.length !== chunks.length * dims) {
            log(`ABORT: vectors.f32 has ${all.length / dims} rows for ${chunks.length} chunks`);
            return app.quit();
        }
        chunks.forEach((c, i) => { c.v = Array.from(all.subarray(i * dims, (i + 1) * dims)); });
        log(`reattached ${chunks.length} vectors x ${dims} dims`);
    }

    // Which documents have chunks but no completed entry?
    const withChunks = new Set(chunks.map(c => c.file));
    const broken = [...withChunks].filter(f => files[f] === undefined);
    if (!broken.length) {
        log("nothing to repair — every document with chunks has a files entry");
        return app.quit();
    }
    for (const f of broken) {
        const n = chunks.filter(c => c.file === f).length;
        log(`  incomplete: ${n} chunks, no entry — ${f}`);
    }

    // Drop the partial chunks. The indexer keys off the files map, so removing
    // the entry is what marks a document as needing work; removing the chunks
    // is what stops the partial copy surviving alongside the complete one.
    const keep = chunks.filter(c => !broken.includes(c.file));
    log(`dropping ${chunks.length - keep.length} partial chunks, keeping ${keep.length}`);

    // Seed a dev library at the shipped folder with the surviving index, then
    // let reindex fill the holes exactly the way it fills any other hole.
    // A NORMAL library at the shipped folder, never the built-in one.
    //
    // In a dev checkout the built-in library's root IS C:/.lcl/knowledge, so
    // matching by path finds it — and reindex refuses it outright: "the built-in
    // knowledge index is prebuilt and read-only". That guard is right (an
    // installed copy must never rewrite its own shipped index) and it is not
    // about this script, which is the thing that BUILDS that artefact.
    //
    // knowledge.add() derives its id from a hash of the path, so it produces a
    // distinct ordinary library over the same folder, which reindex will happily
    // work on. build-knowledge-index.js gets away with a path match only because
    // it runs when index.json does not exist yet, which makes the built-in
    // unavailable and absent from list().
    const lib = knowledge.add(SHIPPED, "Shipped knowledge (repair)");
    if (lib.builtin || lib.id === "builtin-knowledge") {
        log("ABORT: resolved to the read-only built-in library");
        return app.quit();
    }

    // EXCLUDE THE DERIVED ARTEFACTS, OR THE REPAIR EATS ITS OWN OUTPUT.
    //
    // knowledge/text/ is the human-readable EXTRACTION of this same corpus —
    // built FROM the index. The first repair run walked into it and started
    // embedding all 64 .txt files as brand-new source documents: every book in
    // the corpus twice, retrieval citing "text/physics/…" beside the PDF it
    // was copied out of, and hours of embedding spent on it. Same for the .bak
    // safety copies of the index itself. Excluded up front, and verified as
    // excluded, because setExclude also purges anything a previous
    // contaminated run already indexed.
    const ex = knowledge.setExclude(lib.id, ["text", "index.json.bak", "vectors.f32.bak"]);
    log(`excluded derived artefacts: ${JSON.stringify(ex.exclude)}` +
        (ex.purgedFiles ? ` (purged ${ex.purgedFiles} contaminated files)` : ""));
    const devIdxFile = path.join(REPO, "data", "knowledge", lib.id + ".json");
    fs.mkdirSync(path.dirname(devIdxFile), { recursive: true });
    fs.writeFileSync(devIdxFile, JSON.stringify({ files, chunks: keep }));
    log(`seeded ${devIdxFile}`);

    let last = 0;
    const t0 = Date.now();
    const r = await knowledge.reindex(lib.id, (m) => {
        const now = Date.now();
        if (now - last < 8000) return;
        last = now;
        log(`  [${Math.round((now - t0) / 1000)}s] ${String(m).slice(0, 120)}`);
    });
    log(`reindex done in ${Math.round((Date.now() - t0) / 1000)}s: ` +
        `${r.files} files, ${r.chunks} chunks, embedded ${r.embedded}` +
        (r.error ? `  ERROR ${r.error}` : ""));

    const after = JSON.parse(fs.readFileSync(devIdxFile, "utf8"));
    const stillBroken = [...new Set((after.chunks || []).map(c => c.file))]
        .filter(f => (after.files || {})[f] === undefined);
    if (stillBroken.length) {
        log("ABORT: still incomplete after reindex — " + stillBroken.join(", "));
        log("the shipped index was NOT overwritten");
        return app.quit();
    }

    for (const f of broken) {
        const n = (after.chunks || []).filter(c => c.file === f).length;
        log(`  repaired: ${n} chunks — ${f}`);
    }

    fs.copyFileSync(devIdxFile, OUT);
    log(`wrote ${OUT} (${Math.round(fs.statSync(OUT).size / 1e6)} MB, UNPACKED)`);
    log("now run:  node devtools/pack-knowledge-index.js");
    log("then:     node devtools/build-knowledge-text.js");
    app.quit();
});
