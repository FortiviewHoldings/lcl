/**
 * serve_folder — a session launches a real localhost server for what it built.
 *
 * What must hold: it serves the folder and nothing but the folder (path
 * traversal and junction escapes refused by realpath containment), localhost
 * only, GET/HEAD only, CORS only when asked, registered in the task ledger,
 * and stoppable — including via the ledger's cancel token, which is how the
 * UI's Stop button reaches it.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execSync } = require("child_process");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-serve-data-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const serve = require(__dirname + "/../.lcl.engine/core/serve.js");
const tasks = require(__dirname + "/../.lcl.engine/core/tasks.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}
const get = (url, opts = {}) => new Promise((resolve) => {
    const req = http.request(url, { method: opts.method || "GET" }, res => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", e => resolve({ error: e.message }));
    req.end();
});

(async () => {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-serve-root-"));
    fs.mkdirSync(path.join(ROOT, "site"));
    fs.writeFileSync(path.join(ROOT, "site", "index.html"), "<h1>built by the session</h1>");
    fs.writeFileSync(path.join(ROOT, "site", "app.js"), "console.log(1)");
    fs.writeFileSync(path.join(ROOT, "secret-outside.txt"), "must never be served");

    /* ---- serve a subfolder ---- */
    const s = await serve.serveFolder(ROOT, { path: "site" }, {});
    check("server starts and reports a localhost url", /^http:\/\/127\.0\.0\.1:\d+\/$/.test(s.url), s.url);

    const idx = await get(s.url);
    check("serves index.html for /", idx.status === 200 && /built by the session/.test(idx.body));
    check("content-type is html", /text\/html/.test(idx.headers["content-type"] || ""));
    const js = await get(s.url + "app.js");
    check("serves files with the right mime", js.status === 200 && /javascript/.test(js.headers["content-type"]));
    check("no CORS header unless asked", idx.headers["access-control-allow-origin"] === undefined);

    /* ---- containment ---- */
    const trav = await get(s.url + "..%2Fsecret-outside.txt");
    check("path traversal is refused", trav.status === 403 || trav.status === 404, trav.status);
    const trav2 = await get(s.url + "../secret-outside.txt");
    check("plain ../ is refused too", trav2.status !== 200 || !/never be served/.test(trav2.body));
    const post = await get(s.url, { method: "POST" });
    check("POST is refused", post.status === 405);

    // junction escape: a link inside the served folder pointing outside it
    let junctionMade = false;
    try {
        execSync(`cmd /c mklink /J "${path.join(ROOT, "site", "jump")}" "${ROOT}"`, { stdio: "pipe" });
        junctionMade = true;
    } catch { /* mklink not available: skip */ }
    if (junctionMade) {
        const via = await get(s.url + "jump/secret-outside.txt");
        check("a junction inside the folder cannot serve files outside it",
            via.status === 404 || via.status === 403, via.status);
    }

    /* ---- ledger + stop ---- */
    const row = tasks.list().find(t => t.kind === "serve");
    check("the server is in the durable task ledger", !!row && row.status === "running", row && row.title);
    check("listServers shows it", serve.listServers().some(x => x.url === s.url));

    const stopped = serve.stopServer(s.id);
    check("stop_server stops it", stopped.stopped === s.url);
    const after = await get(s.url);
    check("the port is actually closed", !!after.error, after.status);
    const rowAfter = tasks.list().find(t => t.kind === "serve");
    check("the ledger row is finished", rowAfter && rowAfter.status === "done", rowAfter && rowAfter.status);

    /* ---- CORS on request; cancel token stops it (the UI Stop path) ---- */
    const s2 = await serve.serveFolder(ROOT, { path: "site", cors: true }, {});
    // cors:true used to answer `Access-Control-Allow-Origin: *`, which let ANY
    // page the user had open — an ad frame, a random tab — read every file in
    // the served folder, since that header is precisely what switches the
    // browser's same-origin protection off. The grant is now limited to
    // loopback origins: enough for a page served here (or a sibling dev
    // server) to call back, useless to a remote site.
    const withOrigin = (url, origin) => new Promise(res => {
        const r = http.request(url, { headers: origin ? { Origin: origin } : {} }, s => {
            s.resume();
            s.on("end", () => res({ status: s.statusCode, headers: s.headers }));
        });
        r.on("error", e => res({ error: e.message }));
        r.end();
    });
    const local = await withOrigin(s2.url, "http://localhost:5173");
    check("cors:true grants a loopback origin",
        local.headers["access-control-allow-origin"] === "http://localhost:5173",
        local.headers && local.headers["access-control-allow-origin"]);
    const remote = await withOrigin(s2.url, "https://evil.example.com");
    check("cors:true does NOT grant a remote website",
        !remote.headers["access-control-allow-origin"],
        remote.headers && remote.headers["access-control-allow-origin"]);
    const none = await get(s2.url);
    check("a same-origin request needs no grant",
        none.status === 200 && !none.headers["access-control-allow-origin"]);
    const pre = await get(s2.url, { method: "OPTIONS" });
    check("OPTIONS preflight answers 204 with cors", pre.status === 204);
    const token = tasks.cancel(tasks.list().find(t => t.kind === "serve" && t.status === "running").id);
    check("ledger cancel trips the token", token !== null);
    await new Promise(r => setTimeout(r, 1600));   // watchdog interval + margin
    const gone = await get(s2.url);
    check("the Stop button path actually stops the server", !!gone.error, gone.status);

    /* ---- guardrails ---- */
    check("no workspace -> refused", await serve.serveFolder(null, {}, {}).then(() => false, () => true));
    check("nonexistent folder -> refused",
        await serve.serveFolder(ROOT, { path: "nope" }, {}).then(() => false, () => true));
    check("privileged port -> refused",
        await serve.serveFolder(ROOT, { path: "site", port: 80 }, {}).then(() => false, () => true));

    /* ---- a folder with NO index.html is BROWSABLE, not a 404 ---- */
    // Reported live: serve_folder returned a URL but "the serving folder is not
    // serving anything" — the Assistant workspace has no index.html, so "/"
    // answered 404. A directory listing makes the folder actually browsable.
    fs.mkdirSync(path.join(ROOT, "noindex"));
    fs.writeFileSync(path.join(ROOT, "noindex", "notes.md"), "# notes");
    fs.mkdirSync(path.join(ROOT, "noindex", "sub"));
    fs.writeFileSync(path.join(ROOT, "noindex", "sub", "a.js"), "x");
    const sl = await serve.serveFolder(ROOT, { path: "noindex" }, {});
    const rootList = await get(sl.url);
    check("a folder with no index.html serves a browsable listing, not a 404",
        rootList.status === 200 && /text\/html/.test(rootList.headers["content-type"] || "")
        && /notes\.md/.test(rootList.body) && /sub\//.test(rootList.body), rootList.status);
    const subList = await get(sl.url + "sub/");
    check("...and its subfolders list too", subList.status === 200 && /a\.js/.test(subList.body), subList.status);
    const stillFile = await get(sl.url + "notes.md");
    check("...while real files still stream", stillFile.status === 200 && /# notes/.test(stillFile.body));

    serve.stopAll();
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} serve checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
