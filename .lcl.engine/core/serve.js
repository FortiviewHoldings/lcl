const fs = require("fs");
const http = require("http");
const path = require("path");
const tasks = require("./tasks");
const { ToolError, resolveInRoot, realpathOrNull } = require("./fsTools");

/**
 * serve_folder — the session launches a real local web server for what it
 * just built.
 *
 * The operator's scenario: build a static site in the workspace, serve it,
 * open it in a browser, point its JavaScript at any API (the optional CORS
 * header is for exactly that). The server is ENGINE CODE serving files —
 * launching it never executes anything the model wrote, which is what makes
 * it offerable at all. Still EXECUTE-classified: it opens a port and exposes
 * folder contents over HTTP, so a human approves each launch via the
 * standard approval card.
 *
 * Containment: 127.0.0.1 only — reachable from this machine's browsers,
 * invisible to the network. GET/HEAD only. Every resolved path is realpath-
 * checked back into the served folder, so symlinks cannot escape it — same
 * rule the file tools live by. Servers are registered in the durable task
 * ledger: visible, stoppable, and honestly reported after a crash.
 */

const MAX_SERVERS = 4;
const MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8", ".pdf": "application/pdf",
    ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
    ".csv": "text/csv; charset=utf-8", ".xml": "application/xml"
};

const servers = new Map();   // id -> { server, dir, url, taskId, watchdog }

/**
 * A browsable HTML index of a directory, or null if it cannot be read/contained.
 * Entries link by ABSOLUTE encoded path so the links work regardless of a
 * trailing slash; names are HTML-escaped; the walk is contained to dirReal by
 * realpath so a symlinked directory cannot list files from outside the folder.
 */
function dirListing(dirFull, urlDecoded, dirReal) {
    const real = realpathOrNull(dirFull);
    if (!real || (real !== dirReal && !real.startsWith(dirReal + path.sep))) return null;
    let entries;
    try { entries = fs.readdirSync(dirFull, { withFileTypes: true }); } catch { return null; }
    const esc = (s) => String(s).replace(/[&<>"']/g,
        c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const base = urlDecoded.endsWith("/") ? urlDecoded : urlDecoded + "/";
    const href = (name) => (base + name).split("/").map(encodeURIComponent).join("/");
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b));
    const files = entries.filter(e => e.isFile()).map(e => e.name).sort((a, b) => a.localeCompare(b));
    const rows = [];
    if (base !== "/") {
        const parent = base.replace(/[^/]+\/$/, "") || "/";
        rows.push(`<li><a href="${esc(parent.split("/").map(encodeURIComponent).join("/"))}">../</a></li>`);
    }
    for (const d of dirs) rows.push(`<li><a href="${esc(href(d))}/">${esc(d)}/</a></li>`);
    for (const f of files) rows.push(`<li><a href="${esc(href(f))}">${esc(f)}</a></li>`);
    return "<!doctype html><meta charset=\"utf-8\">" +
        `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Index of ${esc(base)}</title>` +
        // an explicit background so the listing stays readable when embedded in a
        // frame that paints nothing behind it (Launch in Workspace)
        "<style>html{background:#fff}body{font:14px/1.7 ui-monospace,Consolas,monospace;max-width:52rem;margin:2rem auto;padding:0 1.2rem;color:#222}" +
        "h1{font-size:.95rem;color:#666;font-weight:600;word-break:break-all}ul{list-style:none;padding:0}li{padding:1px 0}" +
        "a{text-decoration:none;color:#0645ad}a:hover{text-decoration:underline}</style>" +
        `<h1>Index of ${esc(base)}</h1><ul>${rows.join("")}</ul>`;
}

function handler(dirReal, cors) {
    return (req, res) => {
        const headers = {};
        if (cors) {
            // `*` let ANY page the user happened to have open — an ad frame, a
            // random tab — fetch every file in the served folder, because the
            // browser enforces same-origin and this header switches it off.
            // The legitimate need is a page served from THIS server (or a
            // sibling localhost dev server) calling back, so the grant is
            // limited to loopback origins: still permissive enough for the
            // build-a-site-and-call-an-API case, useless to a remote site.
            const origin = String(req.headers.origin || "");
            const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
            if (loopback) {
                headers["Access-Control-Allow-Origin"] = origin;
                headers["Vary"] = "Origin";
                headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
                headers["Access-Control-Allow-Headers"] = "*";
            }
        }
        if (req.method === "OPTIONS" && cors) {
            res.writeHead(204, headers); return res.end();
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, headers); return res.end("method not allowed");
        }
        let rel;
        try { rel = decodeURIComponent(String(req.url || "/").split("?")[0]); }
        catch { res.writeHead(400, headers); return res.end("bad request"); }

        let full = path.normalize(path.join(dirReal, rel));
        if (full !== dirReal && !full.startsWith(dirReal + path.sep)) {
            res.writeHead(403, headers); return res.end("forbidden");
        }
        try {
            if (fs.statSync(full).isDirectory()) {
                const idx = path.join(full, "index.html");
                if (fs.existsSync(idx) && fs.statSync(idx).isFile()) {
                    full = idx;
                } else {
                    // NO index.html — SERVE A BROWSABLE LISTING, not a 404. A folder
                    // with no index used to answer "/" with "not found", so
                    // serve_folder reported a URL that showed nothing. A directory
                    // listing (like python -m http.server) makes the served folder
                    // actually browsable.
                    const listing = dirListing(full, rel, dirReal);
                    if (listing != null) {
                        headers["Content-Type"] = "text/html; charset=utf-8";
                        res.writeHead(200, headers);
                        return res.end(req.method === "HEAD" ? "" : listing);
                    }
                }
            }
        } catch { /* falls to the 404 below */ }
        // realpath containment: a symlink inside the folder must not serve
        // files from outside it
        const real = realpathOrNull(full);
        if (!real || (real !== dirReal && !real.startsWith(dirReal + path.sep))
            || !fs.existsSync(real) || !fs.statSync(real).isFile()) {
            res.writeHead(404, headers); return res.end("not found");
        }
        headers["Content-Type"] = MIME[path.extname(real).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, headers);
        if (req.method === "HEAD") return res.end();
        fs.createReadStream(real).pipe(res);
    };
}

async function serveFolder(root, args = {}, ctx = {}) {
    if (!root) throw new ToolError("link a workspace folder first — the server serves from it");
    if (servers.size >= MAX_SERVERS) {
        throw new ToolError(`already running ${MAX_SERVERS} servers — stop one first (stop_server)`);
    }
    const rel = String(args.path == null ? "." : args.path).trim() || ".";
    const dir = resolveInRoot(root, rel);
    const dirReal = realpathOrNull(dir);
    if (!dirReal || !fs.existsSync(dirReal) || !fs.statSync(dirReal).isDirectory()) {
        throw new ToolError(`not a folder in the workspace: ${rel}`);
    }
    let port = args.port == null ? 0 : Math.floor(+args.port);
    if (Number.isNaN(port) || (port !== 0 && (port < 1024 || port > 65535))) {
        throw new ToolError("port must be 1024-65535 (or omitted for automatic)");
    }
    const cors = !!args.cors;

    const server = http.createServer(handler(dirReal, cors));
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    }).catch(e => {
        throw new ToolError(e && e.code === "EADDRINUSE"
            ? `port ${port} is already in use` : `could not start the server: ${e.message}`);
    });

    const actual = server.address().port;
    const url = `http://127.0.0.1:${actual}/`;
    const id = `serve-${actual}`;
    const { cancelToken } = tasks.start({
        id: `srv:${actual}`, kind: "serve",
        title: `Serving ${rel === "." ? "the workspace" : rel} at ${url}`,
        detail: (cors ? "CORS enabled · " : "") + "localhost only · GET/HEAD",
        // the server belongs to the CONVERSATION that started it — without
        // this the ledger row painted into every session's panel after a
        // restart ("4 stale rows, all serving the workspace")
        sessionId: ctx.sessionId || null,
        cancellable: true, meta: { url, dir: dirReal, cors }
    });
    // the ledger's Stop button trips the token; the watchdog honours it
    const watchdog = setInterval(() => {
        if (cancelToken.cancelled) stopServer(id, "stopped from the task panel");
    }, 1000);
    if (watchdog.unref) watchdog.unref();
    servers.set(id, { server, dir: dirReal, url, taskId: `srv:${actual}`, watchdog });

    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote(`serving at ${url}`);
    return {
        id, url, folder: rel, cors,
        note: `Serving on this machine only. Open ${url} in a browser. ` +
              "Stop it with stop_server or the task panel's Stop button."
    };
}

function stopServer(idOrUrl, why = "stopped") {
    const key = String(idOrUrl || "").trim();
    const id = servers.has(key) ? key
        : [...servers.keys()].find(k => servers.get(k).url === key || servers.get(k).url === key + "/");
    if (!id) {
        const running = [...servers.values()].map(s => s.url).join(", ") || "none";
        throw new ToolError(`no such server (running: ${running})`);
    }
    const s = servers.get(id);
    servers.delete(id);
    clearInterval(s.watchdog);
    try { s.server.close(); } catch { /* already down */ }
    tasks.finish(s.taskId, "done", why);
    return { stopped: s.url };
}

function stopAll() {
    for (const id of [...servers.keys()]) {
        try { stopServer(id, "app shutting down"); } catch { /* already gone */ }
    }
}

function listServers() {
    return [...servers.entries()].map(([id, s]) => ({ id, url: s.url, dir: s.dir }));
}

const SERVE_ENTRY = {
    run: serveFolder,
    help: 'serve_folder {"path": "site", "port": 8080, "cors": true} — serve a workspace ' +
        "folder over HTTP on localhost so the user can open what you built in a browser; " +
        "cors:true lets the served pages call other local APIs"
};

const STOP_ENTRY = {
    run: async (_root, args = {}) => stopServer(args.id || args.url),
    help: 'stop_server {"id": "serve-8080"} — stop a server started with serve_folder'
};

module.exports = { serveFolder, stopServer, stopAll, listServers, SERVE_ENTRY, STOP_ENTRY };
