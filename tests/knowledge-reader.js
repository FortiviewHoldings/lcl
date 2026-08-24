/**
 * CAN A PERSON ACTUALLY READ THE KNOWLEDGE?
 *
 * Reported from an installed build: "Read the knowledge" opened a popup saying
 * there was nothing there. The knowledge libraries listed items; opening a
 * subject showed the cards, but none could be clicked to open and read the
 * full content of anything.
 *
 * One cause behind all three. The corpus is 907 MB of PDFs; the installer ships
 * index.json and vectors.f32 and nothing else out of knowledge/, because NSIS
 * cannot build a 2.4 GB installer. The library view reads the index, so it
 * listed 64 books. The reader globbed for *.pdf, found zero, and reported an
 * empty shelf — while every card it did draw pointed at a file that was not on
 * the disk.
 *
 * knowledge/text/ is the fix: the extracted text of every document, page
 * marked, generated from the index by devtools/build-knowledge-text.js. It
 * ships. This suite asserts it is there, that it agrees with the index, and
 * that a page window comes back as readable prose — the three things that were
 * each individually true-looking while the feature was dead.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const KROOT = path.join(ROOT, "knowledge");
const TROOT = path.join(KROOT, "text");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++;
        console.log("FAIL |", name,
            detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : "");
    }
}

/* ------------------------------------------------------------ it exists --- */
check("the extracted-text corpus exists", fs.existsSync(TROOT),
    "run: node devtools/build-knowledge-text.js");
if (!fs.existsSync(TROOT)) {
    console.log(`\n${pass}/${pass + fail} knowledge-reader checks passed`);
    process.exit(1);
}

const shelfPath = path.join(TROOT, "shelf.json");
check("the shelf manifest exists", fs.existsSync(shelfPath));
const shelf = JSON.parse(fs.readFileSync(shelfPath, "utf8"));

const docs = (shelf.subjects || []).flatMap(s => (s.docs || []).map(d => ({ ...s, ...d })));
check("the shelf lists documents", docs.length > 0, docs.length);
check("every subject has a name and at least one document",
    (shelf.subjects || []).every(s => s.name && (s.docs || []).length > 0));

/* --------------------------------------------- it agrees with the index --- */
// The index is the model's view of the corpus; the text is the human's. If they
// disagree, someone is reading a different book than the one being cited.
const idxPath = path.join(KROOT, "index.json");
if (fs.existsSync(idxPath)) {
    // Only the file map is needed, and index.json is 68 MB — stream out just
    // the "files" object rather than parsing the whole thing for a name list.
    const raw = fs.readFileSync(idxPath, "utf8");
    const start = raw.indexOf('"files":');
    const open = raw.indexOf("{", start);
    let depth = 0, end = open;
    for (let i = open; i < raw.length; i++) {
        if (raw[i] === "{") depth++;
        else if (raw[i] === "}") { depth--; if (!depth) { end = i; break; } }
    }
    const files = JSON.parse(raw.slice(open, end + 1));
    const indexed = Object.keys(files).filter(f => f.includes("/") && /\.pdf$/i.test(f));
    const extracted = new Set(docs.map(d => d.source));

    const missing = indexed.filter(f => !extracted.has(f));
    check("every indexed document has extracted text a user can open",
        missing.length === 0, missing.slice(0, 6));

    check("the extraction did not invent documents the index has never seen",
        docs.every(d => files[d.source] !== undefined),
        docs.filter(d => files[d.source] === undefined).map(d => d.source).slice(0, 6));
}

/* ------------------------------------------------------- it is readable --- */
// Every claimed file present, non-trivial, and page-marked the way the reader
// splits on. A silently truncated extraction passes a file-exists check.
const missingFiles = docs.filter(d => !fs.existsSync(path.join(TROOT, d.file)));
check("every document on the shelf is present on disk",
    missingFiles.length === 0, missingFiles.map(d => d.file).slice(0, 6));

let thin = [], unmarked = [], wrongPages = [];
for (const d of docs) {
    const full = path.join(TROOT, d.file);
    if (!fs.existsSync(full)) continue;
    const body = fs.readFileSync(full, "utf8");
    if (body.length < 500) thin.push(d.file + " (" + body.length + " chars)");
    const marks = body.match(/\f\[page \d+\]\n/g) || [];
    if (!marks.length) unmarked.push(d.file);
    else if (marks.length !== d.pages) {
        wrongPages.push(`${d.file}: ${marks.length} markers, shelf says ${d.pages}`);
    }
}
check("no document is an empty shell", thin.length === 0, thin.slice(0, 6));
check("every document carries the page markers the reader splits on",
    unmarked.length === 0, unmarked.slice(0, 6));
check("the shelf's page count matches the text",
    wrongPages.length === 0, wrongPages.slice(0, 6));

/* --------------------------------------------- a page window comes back --- */
// The exact split the main-process handler performs. If this drifts, the reader
// shows blank pages for a corpus that is present and correct on disk.
function readWindow(rel, from, count) {
    const body = fs.readFileSync(path.join(TROOT, rel), "utf8");
    const parts = body.split(/\f\[page (\d+)\]\n/);
    const pages = [];
    for (let i = 1; i < parts.length; i += 2) {
        pages.push({ page: Number(parts[i]), text: (parts[i + 1] || "").trim() });
    }
    return pages.filter(p => p.page >= from && p.page < from + count);
}

const sample = docs.filter(d => d.pages >= 12).slice(0, 8);
check("there are substantial documents to sample", sample.length > 0, docs.length);

let noProse = [];
for (const d of sample) {
    const win = readWindow(d.file, 1, 40);
    if (!win.length) { noProse.push(d.file + " — no pages returned"); continue; }
    // Somewhere in the first 40 pages there must be real prose. A cover page
    // with no text layer is normal; forty of them means the extraction failed.
    const best = Math.max(...win.map(p => p.text.length));
    if (best < 300) noProse.push(`${d.file} — longest of 40 pages is ${best} chars`);
}
check("reading the first pages of a document returns real prose",
    noProse.length === 0, noProse);

// Page numbers must be ordered and unique, or "pages 12-15" in the reader's
// header describes something other than what is under it.
let disordered = [];
for (const d of sample) {
    const win = readWindow(d.file, 1, 200).map(p => p.page);
    for (let i = 1; i < win.length; i++) {
        if (win[i] <= win[i - 1]) { disordered.push(`${d.file} at ${win[i - 1]}→${win[i]}`); break; }
    }
}
check("pages come back in order, with no repeats", disordered.length === 0, disordered);

/* -------------------------------------------------- it will be INSTALLED --- */
// The whole bug was a packaging filter. Assert the filter, not the folder.
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "app", "builder-config.json"), "utf8"));
const kRes = (cfg.extraResources || []).find(r => r && r.to === "knowledge");
check("knowledge is declared as a shipped resource", !!kRes);
check("the packaging filter includes the extracted text",
    !!kRes && (kRes.filter || []).some(f => String(f).startsWith("text/")),
    kRes && kRes.filter);

/* ----------------------------------------------------- layers stay apart --- */
// Built-in (default) material stays segregated from what the user added.
check("the built-in shelf declares no user-added material",
    (shelf.subjects || []).every(s => s.layer === undefined || s.layer === "builtin"),
    (shelf.subjects || []).map(s => s.layer));

/* ==========================================================================
 * K6 — ONE KNOWLEDGE API. The half that lives in knowledge.js.
 *
 * Reported from the installed build: the second drop-down menu showed all the
 * libraries; clicking View then reported "not on disk".
 *
 * MEASURED before any of this was written:
 *
 *     knowledge                               | docs 62 | on disk 62 | MISSING 0
 *     dist/win-unpacked/resources/knowledge   | docs 62 | on disk  0 | MISSING 62
 *     MANIFEST.md urls recorded: 0
 *     MANIFEST.md claim present: true
 *
 * So View was telling the truth, and the truth was a dead end: the artefact
 * ships the index and the extracted text and none of the 62 source documents,
 * while MANIFEST.md claims they are "re-fetchable from the URLs recorded here"
 * and records no URLs at all.
 *
 * What is asserted here:
 *   - ONE list covers the shipped corpus and everything the user added
 *   - a document that is not installed says needsFetch and hands over the URL
 *   - EXTRACTED TEXT IS NOT A DOCUMENT, structurally, not by convention
 *   - a fetch is a network action and cannot happen quietly
 * ======================================================================== */

// Electron stub + an ISOLATED settings store. isPackaged:false so resourceRoot()
// is the real checkout (this suite is about the real corpus); LCL_DATA_DIR so
// registering a fixture library never touches the user's own store.
const oss = require("os");
const K6DATA = fs.mkdtempSync(path.join(oss.tmpdir(), "lcl-k6-data-"));
process.env.LCL_DATA_DIR = K6DATA;
const Module = require("module");
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return _resolve.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => K6DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };
const knowledge = require(path.join(ROOT, ".lcl.engine", "core", "knowledge.js"));

/* ------------------------------------------- MANIFEST.md is the ONE table --- */
// Parsed, not invented. Every shape the file could plausibly carry its URLs in,
// because the fix on the data side must be a text edit and not a negotiation.
{
    const fixture = [
        "# Shipped knowledge — source manifest",
        "",
        "| Document | Author | License | Source |",
        "|---|---|---|---|",
        "| SI Brochure, 9th edition | BIPM | CC BY 4.0 | https://example.org/si9.pdf |",
        "| `metrology/NIST-SP-811-2008-SI-guide.pdf` | NIST | PD | https://example.org/sp811.pdf |",
        "| [Copper Wire Tables](https://example.org/nbs100.pdf) | NBS | PD |",
        "| Planck — Thermodynamics; Maxwell — Treatise | various | PD | https://example.org/two.pdf |",
        "| A document with no source recorded | Nobody | PD | |",
        "",
        "## Sources",
        "- physics/CODATA-2022-paper-RevModPhys.pdf — https://example.org/codata.pdf",
        "* Fastener Design Manual: https://example.org/rp1228.pdf"
    ].join("\n");
    const t = knowledge.parseManifestSources(fixture);

    check("MANIFEST: a table Source column binds by document title",
        knowledge.sourceUrlFor("metrology/BIPM-SI-Brochure-9.pdf",
            "SI Brochure, 9th edition", t) === "https://example.org/si9.pdf");
    check("MANIFEST: a document path in a cell binds by exact path",
        knowledge.sourceUrlFor("metrology/NIST-SP-811-2008-SI-guide.pdf", "anything", t)
            === "https://example.org/sp811.pdf");
    check("MANIFEST: a markdown link binds the name it labels",
        knowledge.sourceUrlFor("electrical/NBS-100.pdf", "Copper Wire Tables", t)
            === "https://example.org/nbs100.pdf");
    check("MANIFEST: a semicolon row binds every document it names",
        knowledge.sourceUrlFor("x/a.pdf", "Planck — Thermodynamics", t)
            === "https://example.org/two.pdf"
        && knowledge.sourceUrlFor("x/b.pdf", "Maxwell — Treatise", t)
            === "https://example.org/two.pdf");
    check("MANIFEST: a '## Sources' list item binds by path",
        knowledge.sourceUrlFor("physics/CODATA-2022-paper-RevModPhys.pdf", "", t)
            === "https://example.org/codata.pdf");
    check("MANIFEST: a 'Title: url' list item binds by title",
        knowledge.sourceUrlFor("mechanical/NASA-RP-1228.pdf", "Fastener Design Manual", t)
            === "https://example.org/rp1228.pdf");
    check("MANIFEST: a row with no URL yields no URL",
        knowledge.sourceUrlFor("x/none.pdf", "A document with no source recorded", t) === null);
    // THE WHOLE POINT OF EXACT KEYS. A guessed download URL is worse than none:
    // it sends the user's machine to fetch the wrong document and calls it
    // the right one. The title below deliberately SHARES its opening word with
    // a real row ("SI Brochure, 9th edition"), which is precisely the near-miss
    // any loosening would swallow.
    check("MANIFEST: a near-miss title resolves to nothing, not to a neighbour",
        knowledge.sourceUrlFor("metrology/SI-units-for-beginners.pdf",
            "SI units for beginners", t) === null,
        knowledge.sourceUrlFor("metrology/SI-units-for-beginners.pdf",
            "SI units for beginners", t));
    check("MANIFEST: nothing is fuzzy-matched",
        knowledge.sourceUrlFor("physics/Some-Other-Book.pdf", "Some Other Book", t) === null);
    check("MANIFEST: urlsRecorded counts what is actually there", t.urlsRecorded === 6, t.urlsRecorded);
}

// The real corpus against the URL table it WOULD have. devtools/fetch-knowledge.js
// already holds every source URL; this renders it into MANIFEST.md's own table
// shape and proves the parser resolves all 62 shipped documents from it. Read as
// TEXT, never required — that module downloads the corpus when it runs.
{
    const fk = path.join(ROOT, "devtools", "fetch-knowledge.js");
    if (fs.existsSync(fk)) {
        const src = fs.readFileSync(fk, "utf8");
        const rows = [];
        const re = /"into":\s*"knowledge\/([^"]+)",\s*\n\s*"file":\s*"([^"]+)",\s*\n\s*"url":\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(src))) rows.push(`| \`${m[1]}/${m[2]}\` | | | ${m[3]} |`);
        check("the real source URLs can be read out of the fetch tool", rows.length >= 60, rows.length);

        const table = knowledge.parseManifestSources(
            "| Document | Author | License | Source |\n|---|---|---|---|\n" + rows.join("\n"));
        const builtin = knowledge.knowledgeLibraries({ libraryId: knowledge.BUILTIN_ID })[0];
        const unresolved = (builtin ? builtin.docs : [])
            .filter(d => !knowledge.sourceUrlFor(d.file, d.title, table));
        check("with URLs in MANIFEST.md every shipped document resolves one",
            builtin && builtin.docs.length > 0 && unresolved.length === 0,
            unresolved.map(d => d.file).slice(0, 6));
    }
}

// ...and what the file ACTUALLY says today, reported rather than assumed.
{
    const man = knowledge.manifestSources();
    const builtin = knowledge.knowledgeLibraries({ libraryId: knowledge.BUILTIN_ID })[0];
    console.log(`INFO | MANIFEST.md records ${man.urlsRecorded} source URL(s)` +
        (man.urlsRecorded === 0
            ? " — every shipped document therefore reports sourceUrl:null"
            : ""));
    // The API must never present "no URLs recorded" as "no sources exist".
    check("a manifest with no URLs is REPORTED, not hidden",
        !!builtin && !!builtin.manifest
        && builtin.manifest.urlsRecorded === man.urlsRecorded
        && (man.urlsRecorded > 0 || /records no source URLs/.test(builtin.manifest.note || "")),
        builtin && builtin.manifest);
}

/* --------------------------------------------------------- ONE list, both --- */
const FIX = fs.mkdtempSync(path.join(oss.tmpdir(), "lcl-k6-lib-"));
fs.writeFileSync(path.join(FIX, "Fixer-Bath-Chemistry.pdf"),
    "%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n%%EOF\n");
fs.writeFileSync(path.join(FIX, "stop-bath-notes.md"),
    "# Stop bath\nAcetic acid at 2 percent halts development in five seconds.\n");
const added = knowledge.add(FIX, "Darkroom reference");

const libs = knowledge.knowledgeLibraries();
check("knowledgeLibraries() returns ONE list covering both layers",
    libs.length >= 2
    && libs.some(l => l.id === knowledge.BUILTIN_ID && l.addedByUser === false)
    && libs.some(l => l.id === added.id && l.addedByUser === true),
    libs.map(l => ({ id: l.id, addedByUser: l.addedByUser })));

const CONTRACT = ["id", "title", "docs", "sourceOnDisk", "sourceUrl", "addedByUser"];
const missingField = libs.filter(l => CONTRACT.some(f => l[f] === undefined));
check("every library carries the K6 contract fields",
    missingField.length === 0,
    missingField.map(l => ({ id: l.id, has: Object.keys(l) })).slice(0, 3));

const allDocs = libs.flatMap(l => l.docs);
check("every document carries sourceOnDisk, sourceUrl and addedByUser",
    allDocs.length > 0 && allDocs.every(d =>
        typeof d.sourceOnDisk === "boolean"
        && d.sourceUrl !== undefined
        && typeof d.addedByUser === "boolean"),
    allDocs.find(d => typeof d.sourceOnDisk !== "boolean"));

{
    const builtin = libs.find(l => l.id === knowledge.BUILTIN_ID);
    check("the shipped corpus lists exactly the documents on the shelf",
        builtin && builtin.docCount === docs.length, {
            api: builtin && builtin.docCount, shelf: docs.length });
    check("library-level sourceOnDisk means EVERY document, not some",
        builtin && builtin.sourceOnDisk === (builtin.sourcesMissing === 0),
        builtin && { onDisk: builtin.sourceOnDisk, missing: builtin.sourcesMissing });
    const user = libs.find(l => l.id === added.id);
    check("a user-added library reports its own documents",
        user && user.docCount === 2 && user.docs.every(d => d.addedByUser === true),
        user && user.docs.map(d => d.file));
}

/* ------------------------------------ EXTRACTED TEXT IS NOT A DOCUMENT --- */
// Structural. Not a UI convention, not a naming habit — the records cannot
// carry a path into text/, and the opener refuses one if handed it anyway.
{
    const textRoot = path.join(ROOT, "knowledge", EXT_DIRNAME());
    function EXT_DIRNAME() { return knowledge.EXTRACTED_DIR; }
    check("isExtractedTextPath() knows the extraction tree",
        knowledge.isExtractedTextPath(path.join(textRoot, "physics", "x.txt")) === true
        && knowledge.isExtractedTextPath(path.join(ROOT, "knowledge", "physics", "x.pdf")) === false);

    const leaked = allDocs.filter(d =>
        Object.values(d).some(v => typeof v === "string"
            && /(^|[\\/])text[\\/]/i.test(v) && /\.txt$/i.test(v)));
    check("no document record exposes a path into the extraction tree",
        leaked.length === 0, leaked.slice(0, 3).map(d => d.id));

    const builtinDocs = libs.find(l => l.id === knowledge.BUILTIN_ID).docs;
    check("no shipped document is offered as a .txt",
        builtinDocs.every(d => d.ext !== ".txt"),
        builtinDocs.filter(d => d.ext === ".txt").slice(0, 3).map(d => d.file));

    // AIMED AT A .txt THAT REALLY EXISTS, reached the way it really can be:
    // by adding knowledge/ itself as a library, which is a configuration that
    // exists on this machine. A guard tested against a path that is merely
    // absent is refused for the wrong reason and rots without anyone noticing —
    // the first version of this check did exactly that and caught nothing when
    // the guard was deleted.
    const realTxt = docs[0] && docs[0].file;                 // "physics/x.txt"
    check("there is a real extraction file to aim the guard at",
        !!realTxt && fs.existsSync(path.join(textRoot, realTxt)), realTxt);

    const corpusLib = knowledge.add(path.join(ROOT, "knowledge"), "Corpus folder");
    const txtId = corpusLib.id + "::" + knowledge.EXTRACTED_DIR + "/" + realTxt;
    const rec = knowledge.findKnowledgeDoc(txtId);
    check("an extraction file reached through a user library is MARKED, never on disk",
        !!rec && rec.extracted === true && rec.sourceOnDisk === false
        && rec.sourcePath === null, rec);

    const corpusRow = knowledge.knowledgeLibraries({ libraryId: corpusLib.id })[0];
    check("extraction files are absent from the docs list, and COUNTED instead",
        corpusRow.docs.every(d => !/(^|\/)text\//i.test(d.file))
        && corpusRow.extractedTextFiles >= docs.length,
        { extracted: corpusRow.extractedTextFiles,
          leaked: corpusRow.docs.filter(d => /(^|\/)text\//i.test(d.file)).slice(0, 3) });

    const r = knowledge.openKnowledgeDoc(txtId);
    check("openKnowledgeDoc refuses an extraction file BY NAME, not by absence",
        r && r.ok === false && !r.path && r.extracted === true
        && /extracted text/i.test(r.error || ""), r);
    // and it must not quietly become a download offer either
    check("...and does not turn it into a fetch offer", !(r && r.needsFetch), r);
    try { knowledge.remove(corpusLib.id); } catch { /* nothing stored */ }
}

/* ------------------------------------------------------- open, or say why --- */
{
    const onDisk = allDocs.find(d => d.sourceOnDisk && d.ext === ".pdf");
    const r = knowledge.openKnowledgeDoc(onDisk.id);
    check("openKnowledgeDoc resolves a REAL document that is installed",
        r.ok === true && r.path && fs.existsSync(r.path)
        && path.extname(r.path).toLowerCase() === ".pdf", r);
    check("...and hands back the file itself, not the extraction",
        r.ok === true && !knowledge.isExtractedTextPath(r.path), r.path);

    const unknown = knowledge.openKnowledgeDoc("no-such-lib::no/such.pdf");
    check("an unknown id answers, it does not throw",
        unknown && unknown.ok === false && !!unknown.error, unknown);
}

/* --------------------- THE REPORTED CASE: indexed, cited, and not there --- */
// The shipped corpus is exactly this shape — the index knows 62 documents and
// the installer ships none of them. Reproduced on the fixture library, because
// a dev checkout HAS all 62 and an assertion that only holds in a packaged
// build is an assertion that never runs. Index it, then take the file away.
const embedIndex = require(path.join(ROOT, ".lcl.engine", "core", "embedIndex.js"));
embedIndex.embed = async (inputs) => (Array.isArray(inputs) ? inputs : [inputs])
    .map(s => (String(s || "").trim() ? new Array(64).fill(0.1) : null));
embedIndex.isWarm = () => true;

const K6MAIN = (async () => {
    await knowledge.reindex(added.id, () => {});
    const before = knowledge.knowledgeLibraries({ libraryId: added.id })[0];
    check("the fixture library is indexed before its file is removed",
        before.docs.some(d => /Fixer-Bath/i.test(d.file) && d.sourceOnDisk),
        before.docs.map(d => ({ f: d.file, on: d.sourceOnDisk })));

    fs.rmSync(path.join(FIX, "Fixer-Bath-Chemistry.pdf"));
    const after = knowledge.knowledgeLibraries({ libraryId: added.id })[0];
    const missingDoc = after.docs.find(d => /Fixer-Bath/i.test(d.file));
    check("a document whose source is gone is still LISTED, marked not-on-disk",
        !!missingDoc && missingDoc.sourceOnDisk === false && missingDoc.sourcePath === null,
        after.docs.map(d => ({ f: d.file, on: d.sourceOnDisk })));
    check("...and the library row counts it as missing rather than claiming health",
        after.sourceOnDisk === false && after.sourcesMissing === 1,
        { onDisk: after.sourceOnDisk, missing: after.sourcesMissing });

    const m = knowledge.openKnowledgeDoc(added.id + "::Fixer-Bath-Chemistry.pdf");
    check("a missing document answers needsFetch, not a bare refusal",
        m.ok === false && m.needsFetch === true && "sourceUrl" in m, m);
    check("...and says WHY it cannot simply be downloaded",
        typeof m.reason === "string" && /MANIFEST\.md/.test(m.reason), m.reason);
    check("...and reports whether networking is even on",
        typeof m.networkEnabled === "boolean", m);
    check("...and never substitutes the extracted text it DOES have",
        !m.path && !m.text, m);
})();

/* ------------------------------------------- a fetch cannot happen quietly --- */
// Two independent locks. Each one is proven ON ITS OWN, against the isolated
// settings store — nothing here reaches the network, and that is the assertion.
(async () => {
    await K6MAIN;
    const paths = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));
    const id = added.id + "::Fixer-Bath-Chemistry.pdf";

    paths.writeSettings({ networkEnabled: false });
    const noApproval = await knowledge.fetchKnowledgeSource(id, { approved: false });
    check("a fetch without operator approval is blocked",
        noApproval.ok === false && noApproval.blocked === "approval", noApproval);
    check("...and the refusal reports every fact, not just the first no",
        noApproval.approved === false && noApproval.networkEnabled === false
        && "sourceUrl" in noApproval, noApproval);
    const netOff = await knowledge.fetchKnowledgeSource(id, { approved: true });
    check("an approved fetch is still blocked while networking is off",
        netOff.ok === false && netOff.blocked === "network", netOff);

    // Both locks open, and it STILL does not reach out — because MANIFEST.md
    // records no URL for this document. Three gates, three separate proofs.
    paths.writeSettings({ networkEnabled: true });
    const noUrl = await knowledge.fetchKnowledgeSource(id, { approved: true });
    check("with both locks open, a document with no recorded URL is not fetched",
        noUrl.ok === false && noUrl.blocked === "no-source-url"
        && /MANIFEST\.md/.test(noUrl.error || ""), noUrl);
    paths.writeSettings({ networkEnabled: false });

    /* ------------- THE READ-ONLY-DIR FIX: downloads live in the MIRROR -------
     * resources/knowledge is READ-ONLY in a packaged install (Program Files),
     * so a fetched built-in source can never be written into lib.root — it
     * lands in the writable mirror under the data dir, and every reader
     * prefers the mirror. The UI path (main.js) was fixed first; the engine
     * path (fetchKnowledgeSource) kept the bug, which is why the download
     * links stayed broken. */
    {
        const mirrorRoot = knowledge.sourceCacheRoot();
        check("the mirror lives under the DATA dir (writable), never under resources/",
            mirrorRoot.startsWith(path.resolve(K6DATA))
            && !mirrorRoot.startsWith(path.resolve(ROOT, "knowledge")), mirrorRoot);

        // a real builtin doc, with a fake downloaded copy placed in the mirror
        const blib = knowledge.knowledgeLibraries({ libraryId: knowledge.BUILTIN_ID })[0];
        const bdoc = blib && (blib.docs || []).find(d => d.ext === ".pdf" && !d.extracted);
        check("(setup) the builtin corpus offers a PDF to exercise", !!bdoc, blib && blib.docs && blib.docs.length);
        if (bdoc) {
            const mirrorFile = path.join(mirrorRoot, bdoc.file);
            fs.mkdirSync(path.dirname(mirrorFile), { recursive: true });
            fs.writeFileSync(mirrorFile, "%PDF-1.4 fake downloaded copy %%EOF");

            const found = knowledge.findKnowledgeDoc(bdoc.id);
            check("a downloaded copy in the mirror reads as INSTALLED, preferred over the shipped path",
                !!found && found.sourceOnDisk === true
                && String(found.sourcePath || "").startsWith(path.resolve(mirrorRoot)),
                found && { onDisk: found.sourceOnDisk, path: found.sourcePath });
            const already = await knowledge.fetchKnowledgeSource(bdoc.id, { approved: true });
            check("...so a fetch of it says alreadyPresent WITH the mirror path — no network touched",
                already.ok === true && already.alreadyPresent === true
                && String(already.path || "").startsWith(path.resolve(mirrorRoot)), already);
            const opened = knowledge.openKnowledgeDoc(bdoc.id);
            check("...and openKnowledgeDoc hands back the mirror copy to read",
                opened.ok === true
                && String(opened.path || "").startsWith(path.resolve(mirrorRoot)), opened);

            fs.rmSync(mirrorFile, { force: true });
            const gone = knowledge.findKnowledgeDoc(bdoc.id);
            check("removing the mirror copy restores the shipped-disk truth (no stale claim)",
                !!gone && String(gone.sourcePath || "") !== mirrorFile,
                gone && gone.sourcePath);
        }

        // the WRITE side, pinned in source: the engine fetch destines the
        // mirror, never lib.root — and a user's own folder is never written
        const ksrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "knowledge.js"), "utf8");
        check("fetchKnowledgeSource writes to sourceCacheRoot(), never into lib.root " +
              "(resources/ is read-only when installed — the exact broken-download bug)",
            /const destRoot = sourceCacheRoot\(\)/.test(ksrc)
            && !/path\.resolve\(lib\.root, doc\.file\)/.test(ksrc), null);
        check("...and a user-added document is refused — their folder is theirs to manage",
            /in your own\s*"\s*\+\s*"folder — there is nothing to download/.test(ksrc.replace(/\n/g, " "))
            || /in your own folder — there is nothing to download/.test(ksrc), null);
        const msrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
        check("main.js shares the ONE mirror definition — two copies of this path is " +
              "how the engine half kept the bug after the UI half was fixed",
            /builtinSourceCacheRoot\(\)\s*\{\s*return knowledge\.sourceCacheRoot\(\);\s*\}/.test(msrc), null);
        // THE 403 LESSON: the UI download (fetchToBuffer) must send browser-grade
        // headers, like the engine path always has — DOE, everyspec and NASA NTRS
        // all answer a BARE Node GET with 403 and the same request with a real
        // User-Agent with 200 (measured across the whole corpus). A downloader
        // with no User-Agent is a downloader that fails on half the manifest.
        {
            const ftb = msrc.slice(msrc.indexOf("function fetchToBuffer"),
                                   msrc.indexOf("function fetchToBuffer") + 1600);
            check("the UI knowledge download sends browser-grade headers — a bare " +
                  "GET gets bot-scored to 403 by half the corpus's hosts",
                /User-Agent/.test(ftb) && /Mozilla\/5\.0/.test(ftb)
                && /Accept-Language/.test(ftb), null);
            // ...and a wrong-KIND download is named as such: an everyspec-style
            // landing page fetches 200 as complete HTML, which is not
            // "incomplete" — calling it that sent the operator hunting a network
            // problem when the recorded URL was the defect
            check("an HTML page masquerading as the document is called a WRONG URL, " +
                  "and a header-without-trailer is called truncation — two " +
                  "different defects, two different messages",
                /serves a web page, not the document/.test(msrc)
                && /missing its trailer/.test(msrc), null);
        }
    }

    // cleanup: the fixture library, and the isolated store
    try { knowledge.remove(added.id); } catch { /* already gone */ }
    try { fs.rmSync(FIX, { recursive: true, force: true }); } catch { /* gone */ }
    try { fs.rmSync(K6DATA, { recursive: true, force: true }); } catch { /* gone */ }

    console.log(`\n${pass}/${pass + fail} knowledge-reader checks passed`);
    process.exit(fail ? 1 : 0);
})();
