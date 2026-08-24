/**
 * Pack the shipped knowledge index for distribution.
 *
 * The raw index stores every embedding as decimal text — 37,514 chunks came
 * to 358 MB, most of it digits. Shipping splits it:
 *   knowledge/index.json   files map + chunks (file, loc, preview, text) — no vectors
 *   knowledge/vectors.f32  all embeddings, concatenated Float32 rows
 * loadIndex() for the built-in reattaches vectors as Float32Array views:
 * no float parsing at boot, ~4x smaller on disk, exact same retrieval math.
 *
 *   node devtools/pack-knowledge-index.js
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "knowledge");
const SRC = path.join(DIR, "index.json");

const idx = JSON.parse(fs.readFileSync(SRC, "utf8"));
const chunks = idx.chunks || [];
const dims = chunks.length ? chunks[0].v.length : 0;
for (const c of chunks) {
    if (!Array.isArray(c.v) || c.v.length !== dims) {
        throw new Error("inconsistent vector dims at " + c.file);
    }
}
const f32 = new Float32Array(chunks.length * dims);
chunks.forEach((c, i) => { f32.set(c.v, i * dims); delete c.v; });

fs.writeFileSync(path.join(DIR, "vectors.f32"), Buffer.from(f32.buffer));
fs.writeFileSync(SRC, JSON.stringify({ ...idx, chunks, vectorDims: dims, packed: true }));

console.log(`packed ${chunks.length} chunks x ${dims} dims`);
console.log(`index.json  ${Math.round(fs.statSync(SRC).size / 1e6)} MB`);
console.log(`vectors.f32 ${Math.round(fs.statSync(path.join(DIR, "vectors.f32")).size / 1e6)} MB`);
