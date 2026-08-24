const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const netTools = require("./netTools");
const docTools = require("./docTools");
const securityTools = require("./securityTools");
const { ToolError } = require("./fsTools");
const secretGuard = require("./secretGuard");

/**
 * RESEARCH — turn a question into a folder of readable source material.
 *
 * The loop this closes: the model answered a specialist question from memory and
 * invented the details, because it had no way to go and read the actual
 * document. Knowledge libraries fixed that for material already on disk. This
 * fixes it for material that is not: search, fetch, extract, and write a folder
 * that can be handed straight to "Add a folder".
 *
 * Deliberate choices:
 *
 * - Output is PLAIN MARKDOWN, one file per source, with the URL and fetch date
 *   in a header. Not a database, not a bespoke format — the folder is useful on
 *   its own, readable without this app, and is exactly what the indexer already
 *   knows how to eat.
 * - Everything goes through netTools.fetchGuarded, so the SSRF protections
 *   (scheme check, host validation, IP pinning per redirect, size cap) apply
 *   here too. There is no second path to the network.
 * - Fetched pages are UNTRUSTED. Credentials are stripped before writing, and
 *   the source URL is recorded so any claim can be traced back.
 * - It writes only inside its own directory in app data. It never writes to a
 *   workspace, and never to a knowledge library.
 */

const MAX_RESULTS = 12;
const MAX_SOURCES = 8;              // how many results to actually fetch
const MIN_TEXT_CHARS = 400;         // below this a page carried no article
const MAX_DOC_CHARS = 120_000;
const FETCH_GAP_MS = 400;           // be a polite client

/* ------------------------------------------------------------------ search */

/**
 * Web search with no API key and no account: DuckDuckGo's HTML endpoint. That
 * choice matters for a fully-local product — the alternative is an API key,
 * which means an account, a bill and a third party who logs the queries.
 */
async function webSearch(query, { limit = MAX_RESULTS, onNote = () => {} } = {}) {
    const q = String(query || "").trim();
    if (!q) throw new ToolError("search needs a query");
    // a search query is outbound data sent to a third party
    try { secretGuard.assertNoLeak(q, "this search query"); }
    catch (e) { throw new ToolError(e.message); }
    onNote(`searching for "${q.slice(0, 60)}"`);

    const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q);
    const res = await netTools.fetchGuarded(url, () => {});
    const html = res.body || "";

    const out = [];
    const seen = new Set();
    // result anchors carry class="result__a"; the href is DDG's redirector
    const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < limit) {
        const href = decodeDdg(m[1]);
        if (!href || seen.has(href)) continue;
        try { const u = new URL(href); if (!/^https?:$/.test(u.protocol)) continue; }
        catch { continue; }
        seen.add(href);
        out.push({ url: href, title: stripTags(m[2]).slice(0, 200) });
    }
    // THE CHALLENGE PAGE IS A SILENT ZERO. html.duckduckgo.com answers bot
    // suspicion (VPN/datacenter exits especially) with a 202 challenge — 14KB
    // of page, no results, and the tool reported "no results" as if the web
    // were empty. The LITE endpoint is served the plain markup far more often;
    // fall through to it before conceding, and SAY when both were walled.
    if (!out.length) {
        onNote("primary search walled — trying the lite endpoint");
        const lres = await netTools.fetchGuarded(
            "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q), () => {});
        const lhtml = lres.body || "";
        const lre = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let lm;
        while ((lm = lre.exec(lhtml)) && out.length < limit) {
            const href = decodeDdg(lm[1]);
            if (!href || seen.has(href)) continue;
            try { const u = new URL(href); if (!/^https?:$/.test(u.protocol)) continue; }
            catch { continue; }
            seen.add(href);
            out.push({ url: href, title: stripTags(lm[2]).slice(0, 200) });
        }
        // Bing serves plain result markup where DDG challenges — measured 200
        // with 10 b_algo results through the SAME VPN exit both DDG endpoints
        // walled. Last rung, not first: DDG logs less.
        if (!out.length) {
            onNote("lite walled too — trying bing");
            const bres = await netTools.fetchGuarded(
                "https://www.bing.com/search?q=" + encodeURIComponent(q), () => {});
            const bhtml = bres.body || "";
            const bre = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            // bing wraps results in /ck/a?...&u=a1<base64-of-real-url>; hand the
            // model the DESTINATION, not the tracker
            const unwrapBing = (h) => {
                try {
                    const u = new URL(String(h).replace(/&amp;/g, "&"), "https://www.bing.com");
                    const p = u.searchParams.get("u");
                    if (p && /^a1/.test(p)) {
                        const b = p.slice(2).replace(/-/g, "+").replace(/_/g, "/");
                        const dec = Buffer.from(b + "===".slice((b.length + 3) % 4), "base64").toString("utf8");
                        if (/^https?:\/\//.test(dec)) return dec;
                    }
                    return u.hostname === "www.bing.com" ? null : String(h);
                } catch { return null; }
            };
            let bm;
            while ((bm = bre.exec(bhtml)) && out.length < limit) {
                const href = unwrapBing(bm[1]);
                if (!href || seen.has(href)) continue;
                try { const u = new URL(href); if (!/^https?:$/.test(u.protocol)) continue; }
                catch { continue; }
                seen.add(href);
                out.push({ url: href, title: stripTags(bm[2]).slice(0, 200) });
            }
        }
        if (!out.length) {
            throw new ToolError(
                "every search engine walled the request (bot challenge — a VPN exit " +
                "address makes this more likely). Not an empty web: try again, or " +
                "fetch a known URL directly with http_fetch.");
        }
    }
    onNote(`${out.length} result${out.length === 1 ? "" : "s"}`);
    return out;
}

/** DDG wraps results as /l/?uddg=<encoded>. Unwrap to the real destination. */
function decodeDdg(href) {
    try {
        const s = href.startsWith("//") ? "https:" + href : href;
        const u = new URL(s, "https://duckduckgo.com");
        const target = u.searchParams.get("uddg");
        return target ? decodeURIComponent(target) : (u.protocol.startsWith("http") ? u.toString() : null);
    } catch { return null; }
}

const stripTags = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/* ----------------------------------------------------------------- extract */

/**
 * HTML to readable text. Not a full reader implementation — script/style/nav
 * removal plus tag stripping gets the article on the overwhelming majority of
 * documentation and spec pages, which is what this is for.
 */
function htmlToText(html) {
    let s = String(html || "");
    s = s.replace(/<script[\s\S]*?<\/script>/gi, " ")
         .replace(/<style[\s\S]*?<\/style>/gi, " ")
         .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
         .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
         .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
         .replace(/<!--[\s\S]*?-->/g, " ");
    const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    // keep block structure as newlines so the chunker has real boundaries
    s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n")
         .replace(/<br\s*\/?>/gi, "\n")
         .replace(/<li[^>]*>/gi, "- ");
    return { title: stripTags(title || ""), text: stripTags(s.replace(/<[^>]*>/g, " "))
        .replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n") };
}

/** Fetch one URL and return readable text, whatever it turns out to be. */
async function harvest(url, onNote = () => {}) {
    const res = await netTools.fetchGuarded(url, onNote);
    const ct = (res.contentType || "").toLowerCase();

    if (ct.includes("pdf") || /\.pdf($|\?)/i.test(url)) {
        // a PDF needs its bytes, not a utf8 decode of them
        const tmp = path.join(paths.dataDir(), `.fetch-${Date.now()}.pdf`);
        try {
            fs.writeFileSync(tmp, res.raw);
            const pages = await docTools.extractPdfPages(tmp, { onNote });
            const text = pages.map(p => `--- page ${p.page} ---\n${p.text}`).join("\n\n");
            return { kind: "pdf", title: "", text, pages: pages.length, url: res.url };
        } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } }
    }

    if (/json|xml|text\/plain|markdown|csv/.test(ct)) {
        return { kind: "text", title: "", text: res.body, url: res.url };
    }
    const { title, text } = htmlToText(res.body);
    return { kind: "html", title, text, url: res.url };
}

/* ------------------------------------------------------------------- write */

const slug = (s) => String(s || "topic").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "topic";

/** Where a research folder lives: app data, never a workspace or a library. */
function researchRoot() {
    const dir = path.join(paths.dataDir(), "research");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function listFolders() {
    const root = researchRoot();
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
    return names.map(name => {
        const dir = path.join(root, name);
        let files = [];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith(".md")); } catch { /* empty */ }
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, "research.json"), "utf8")); }
        catch { /* older folder */ }
        return { name, dir, documents: Math.max(0, files.length - 1), topic: meta.topic || name,
                 createdAt: meta.createdAt || null };
    }).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

/**
 * Research a topic into a folder.
 *
 * Returns { dir, saved, skipped, sources } — `dir` is the thing to hand to
 * "Add a folder", which is the whole point: the model builds the library, the
 * user adopts it with one click.
 */
async function research(topic, {
    maxSources = MAX_SOURCES, onNote = () => {}, cancelToken = {}, baseDir = null
} = {}) {
    const t = String(topic || "").trim();
    if (!t) throw new ToolError("research needs a topic");

    const results = await webSearch(t, { onNote });
    if (!results.length) throw new ToolError("the search returned nothing");

    // The operator's rule: research belongs to the session's WORKSPACE when
    // one is linked — that folder is theirs, they can see it fill up, and one
    // "Add folder" click makes it knowledge. App data is only the fallback
    // for a session with no workspace.
    //
    // The topic folder is named for the TOPIC, not the clock. A base36
    // timestamp suffix guaranteed uniqueness and made the folder unreadable to
    // the human who has to find it later; a collision counter costs nothing
    // and keeps "fixer-bath-strength" looking like what it is.
    const parent = baseDir || researchRoot();
    fs.mkdirSync(parent, { recursive: true });
    const base = slug(t);
    let dir = path.join(parent, base);
    for (let n = 2; fs.existsSync(dir); n++) dir = path.join(parent, `${base}-${n}`);
    fs.mkdirSync(dir, { recursive: true });

    const sources = [];
    let skipped = 0;
    for (const r of results.slice(0, Math.max(1, Math.min(maxSources, MAX_SOURCES)))) {
        if (cancelToken.cancelled) break;
        let doc;
        try {
            onNote(`reading ${new URL(r.url).hostname}`);
            doc = await harvest(r.url, () => {});
        } catch (e) {
            skipped++;
            onNote(`skipped ${new URL(r.url).hostname}: ${String(e.message || e).slice(0, 60)}`);
            continue;
        }
        const text = String(doc.text || "").slice(0, MAX_DOC_CHARS).trim();
        if (text.length < MIN_TEXT_CHARS) { skipped++; continue; }

        // Fetched pages are untrusted input. A page carrying something that
        // looks like a credential does not get written to disk, because the
        // next thing that happens to this folder is being indexed.
        const sec = securityTools.looksLikeSecret(text);
        if (sec.found) { skipped++; onNote(`skipped a page containing ${sec.kinds[0]}`); continue; }

        const name = `${String(sources.length + 1).padStart(2, "0")}-${slug(doc.title || r.title || "source")}.md`;
        // the header is what makes a claim traceable back to where it came from
        const body =
            `# ${doc.title || r.title || r.url}\n\n` +
            `> Source: ${doc.url}\n` +
            `> Retrieved: ${new Date().toISOString().slice(0, 10)}\n` +
            `> Type: ${doc.kind}${doc.pages ? ` (${doc.pages} pages)` : ""}\n\n` +
            `${text}\n`;
        fs.writeFileSync(path.join(dir, name), body, "utf8");
        sources.push({ file: name, url: doc.url, title: doc.title || r.title,
                       kind: doc.kind, chars: text.length });
        await new Promise(res => setTimeout(res, FETCH_GAP_MS));
    }

    // An index the user reads, and a manifest the app reads.
    const index = `# ${t}\n\n` +
        `Researched ${new Date().toISOString().slice(0, 10)} · ${sources.length} source` +
        `${sources.length === 1 ? "" : "s"}\n\n` +
        sources.map(s => `- [${s.title || s.file}](${s.file}) — ${s.url}`).join("\n") + "\n" +
        (skipped ? `\n_${skipped} result(s) skipped: unreadable, too short, or containing credentials._\n` : "");
    fs.writeFileSync(path.join(dir, "00-index.md"), index, "utf8");
    fs.writeFileSync(path.join(dir, "research.json"), JSON.stringify({
        topic: t, createdAt: new Date().toISOString(), sources, skipped
    }, null, 2), "utf8");

    onNote(`saved ${sources.length} document${sources.length === 1 ? "" : "s"}`);
    return { dir, saved: sources.length, skipped, sources,
             cancelled: !!cancelToken.cancelled };
}

const SEARCH_ENTRY = {
    run: async (_root, args = {}, ctx = {}) => {
        const hits = await webSearch(args.query, { limit: args.limit, onNote: ctx.onNote });
        return { results: hits };
    },
    help: 'web_search {"query": "what you want to find out"} — search the web and ' +
        'return result titles and URLs (network must be enabled). Use this whenever ' +
        'the answer depends on current, local or external information you do not ' +
        'already know — prices, places, news, releases, anything after your training ' +
        'cutoff. Do not guess from memory and do not ask the user to look it up.'
};

const RESEARCH_ENTRY = {
    run: async (root, args = {}, ctx = {}) => {
        // linked workspace -> the sources land THERE, under research/, where
        // the user can see them and adopt them; app data only as the fallback
        const libraryRoot = root ? path.join(root, "research") : researchRoot();
        const r = await research(args.topic, {
            maxSources: args.max_sources, onNote: ctx.onNote,
            cancelToken: ctx.cancelToken || {}, baseDir: root ? libraryRoot : null
        });

        // ONE library for all research, not one per topic. Every run drops a
        // subfolder into research/, so the user adds research/ once and every
        // future topic is already covered — the earlier design would have made
        // them add a new library per question.
        //
        // And if research/ (or an ancestor) is ALREADY an added library, the
        // consent exists: reindex it rather than asking again. Adding a folder
        // is the human act; files appearing inside an added folder are what a
        // library IS.
        const knowledge = require("./knowledge");
        const owner = knowledge.libraryContaining(r.dir);
        let note;
        if (owner) {
            note = `Saved to ${path.relative(root || libraryRoot, r.dir)} — already ` +
                   `inside your "${owner.name}" library, so it is being reindexed now ` +
                   "and will be searchable shortly.";
            if (typeof ctx.onLibraryDirty === "function") {
                try { ctx.onLibraryDirty(owner); } catch { /* display-only */ }
            }
        } else if (root) {
            note = `Saved into the workspace at ${path.relative(root, r.dir)}. ` +
                   `Add the folder "${path.relative(root, libraryRoot)}" as a knowledge ` +
                   "library (the Add folder button) — one library covers every topic " +
                   "you research from here.";
        } else {
            note = `No workspace is linked, so this went to ${r.dir}. ` +
                   "Add that folder as a knowledge library to search it.";
        }
        return { folder: r.dir, libraryRoot, saved: r.saved, skipped: r.skipped,
                 alreadyInLibrary: owner ? owner.name : null, note };
    },
    help: 'research_topic {"topic": "the subject to read up on"} — search the ' +
        "web, read the sources, and save them into the workspace's research/ folder " +
        "(app data if no workspace is linked); the user adds it as knowledge via the UI"
};

module.exports = {
    webSearch, harvest, research, htmlToText, listFolders, researchRoot,
    SEARCH_ENTRY, RESEARCH_ENTRY
};
