/**
 * RESEARCH — search the web, read the sources, write a folder that can be
 * adopted as a knowledge library.
 *
 * The network is stubbed at netTools.fetchGuarded, which is deliberate: that is
 * the single guarded path everything here must go through, so stubbing it also
 * proves nothing takes a private route to the socket. What is exercised for
 * real is the part that decides what lands on disk — extraction, the quality
 * floor, credential refusal, and the shape of the folder.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-research-"));
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const netTools = require(__dirname + "/../.lcl.engine/core/netTools.js");
const research = require(__dirname + "/../.lcl.engine/core/research.js");
const knowledge = require(__dirname + "/../.lcl.engine/core/knowledge.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 280) : ""); }
}

/* ---- a fake internet ------------------------------------------------- */
const PAGE = (body, title = "Doc") =>
    `<html><head><title>${title}</title></head><body><nav>skip me</nav>` +
    `<script>var tracking=1</script>${body}<footer>(c) 2026</footer></body></html>`;

const LONG = "A fixing bath must hold at least 230 grams of thiosulfate per litre so the " +
    "negative clears completely before it goes into the wash. ".repeat(8);

const SERP =
    `<a class="result__a" href="/l/?uddg=${encodeURIComponent("https://example.org/good")}">Good source</a>
     <a class="result__a" href="/l/?uddg=${encodeURIComponent("https://example.org/thin")}">Thin page</a>
     <a class="result__a" href="/l/?uddg=${encodeURIComponent("https://example.org/leak")}">Config dump</a>
     <a class="result__a" href="/l/?uddg=${encodeURIComponent("https://example.org/dead")}">Dead link</a>`;

const SITE = {
    "https://example.org/good": PAGE(`<p>${LONG}</p>`, "Fixing And Washing"),
    "https://example.org/thin": PAGE("<p>too short</p>", "Thin"),
    "https://example.org/leak": PAGE(
        `<p>${LONG}</p><pre>AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE</pre>`, "Config")
};

// Stubbing fetchGuarded is the point: it is the ONE guarded path to the
// network, so if research.js ever took a private route this stub would not
// catch the traffic and these tests would fail.
netTools.fetchGuarded = async (url) => {
    if (/duckduckgo\.com/.test(url)) {
        return { url, status: 200, contentType: "text/html", body: SERP,
                 raw: Buffer.from(SERP), bytes: SERP.length, truncated: false };
    }
    if (url === "https://example.org/dead") throw new Error("connection refused");
    const body = SITE[url];
    if (body === undefined) throw new Error("404");
    return { url, status: 200, contentType: "text/html", body,
             raw: Buffer.from(body), bytes: body.length, truncated: false };
};

(async () => {
    /* ---- search parsing ---- */
    const hits = await research.webSearch("fixer bath strength");
    check("search returns results", hits.length === 4, hits.length);
    check("DuckDuckGo's redirector is unwrapped to the real URL",
        hits[0].url === "https://example.org/good", hits[0]);
    check("result titles are plain text", hits[0].title === "Good source", hits[0].title);

    /* ---- extraction ---- */
    const doc = await research.harvest("https://example.org/good");
    check("the article text is extracted", /230 grams/.test(doc.text));
    check("the page title is captured", doc.title === "Fixing And Washing", doc.title);
    check("navigation, scripts and footers are stripped",
        !/skip me|tracking|\(c\) 2026/.test(doc.text));

    /* ---- the full run ---- */
    const r = await research.research("fixer bath strength", { maxSources: 6 });
    check("a folder is created", fs.existsSync(r.dir), r.dir);
    check("the good source is saved", r.saved === 1, { saved: r.saved, skipped: r.skipped });
    check("thin, dead and leaking pages are all skipped", r.skipped === 3, r.skipped);

    const files = fs.readdirSync(r.dir).sort();
    check("an index and a manifest are written",
        files.includes("00-index.md") && files.includes("research.json"), files);
    check("one markdown file per saved source",
        files.filter(f => f.endsWith(".md")).length === 2, files);   // index + 1 source

    const saved = files.find(f => f.endsWith(".md") && f !== "00-index.md");
    const body = fs.readFileSync(path.join(r.dir, saved), "utf8");
    check("the saved document records where it came from",
        /Source: https:\/\/example\.org\/good/.test(body) && /Retrieved: \d{4}-\d{2}-\d{2}/.test(body),
        body.slice(0, 160));
    check("the saved document carries the actual content", /230 grams/.test(body));

    /* ---- the security property that matters most ---- */
    // A fetched page is untrusted. One carrying a credential must not reach
    // disk, because the next thing that happens to this folder is indexing.
    const all = files.map(f => fs.readFileSync(path.join(r.dir, f), "utf8")).join("\n");
    check("NO credential from any fetched page is written to disk",
        !/AKIAIOSFODNN7EXAMPLE/.test(all));
    check("the index tells the user sources were skipped", /skipped/i.test(
        fs.readFileSync(path.join(r.dir, "00-index.md"), "utf8")));

    /* ---- the folder is adoptable ---- */
    const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, "research.json"), "utf8"));
    check("the manifest records the topic and its sources",
        manifest.topic === "fixer bath strength" && manifest.sources.length === 1, manifest);
    const listed = research.listFolders();
    check("the folder is listed for the UI to offer",
        listed.some(f => f.dir === r.dir && f.documents === 1), listed);

    /* ---- containment ---- */
    check("research writes only inside app data, never a workspace",
        r.dir.startsWith(path.join(DATA, "data", "research")), r.dir);

    /* ---- the operator's rule: a linked workspace owns the research ---- */
    {
        const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-research-ws-"));
        const rw = await research.RESEARCH_ENTRY.run(WS, { topic: "fixer bath strength" }, {});
        check("with a workspace, sources land under <workspace>/research/",
            rw.folder.startsWith(path.join(WS, "research") + path.sep), rw.folder);
        check("the topic folder is named for the topic, not the clock",
            path.basename(rw.folder) === "fixer-bath-strength", path.basename(rw.folder));
        check("ONE library root covers every topic",
            rw.libraryRoot === path.join(WS, "research"), rw.libraryRoot);
        check("the note names the library root to add, not the topic folder",
            /Add folder/i.test(rw.note) && /research/.test(rw.note), rw.note);

        // researching the same topic twice must not collide or overwrite
        const rw2 = await research.RESEARCH_ENTRY.run(WS, { topic: "fixer bath strength" }, {});
        check("a repeat topic gets its own folder, nothing overwritten",
            rw2.folder !== rw.folder && fs.existsSync(rw.folder) && fs.existsSync(rw2.folder),
            path.basename(rw2.folder));

        // once research/ is an added library, new topics reindex it instead of
        // asking for a second consent
        const lib = knowledge.add(path.join(WS, "research"), "Research");
        let dirtied = null;
        const rw3 = await research.RESEARCH_ENTRY.run(WS, { topic: "fsk signalling" },
            { onLibraryDirty: (l) => { dirtied = l; } });
        check("research inside an ADDED library triggers a reindex, not a prompt",
            dirtied && dirtied.id === lib.id, dirtied && dirtied.name);
        check("...and says so instead of asking to add it again",
            /reindex/i.test(rw3.note) && !/Add folder/i.test(rw3.note), rw3.note);
        check("it reports which library owns it", rw3.alreadyInLibrary === "Research");
        knowledge.remove(lib.id);

        const rn = await research.RESEARCH_ENTRY.run(null, { topic: "fixer bath strength" }, {});
        check("without a workspace, app data is the fallback",
            rn.folder.startsWith(path.join(DATA, "data", "research")), rn.folder);
        fs.rmSync(WS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    }

    /* ---- cancellation ---- */
    const token = { cancelled: true };
    const c = await research.research("fixer bath strength", { cancelToken: token });
    check("a cancelled run stops without saving sources",
        c.saved === 0 && c.cancelled === true, c);

    fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} research checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
