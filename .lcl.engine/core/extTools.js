const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const paths = require("./paths");
const { ToolError, resolveInRoot, resolveForWrite } = require("./fsTools");

/**
 * FOUR BUNDLED INSTRUMENTS — qpdf, ImageMagick, SQLite and Graphviz.
 *
 * They live together because they share one shape: a licence-clean
 * third-party executable, driven by arguments THIS module composes. The model
 * never supplies a command line — it supplies structured intent, and each
 * builder below turns that into an argv array. That is the whole security
 * story: no shell, no interpolation, no "just pass the user's string through".
 *
 *   edit_pdf      qpdf (Apache-2.0)      split, merge, rotate, decrypt, repair
 *   edit_image    ImageMagick (permissive) resize, crop, rotate, convert, annotate
 *   query_data    SQLite (public domain)  SQL over CSVs and .db files
 *   draw_diagram  Graphviz (EPL-2.0)      DOT text -> SVG/PNG, shown in chat
 *
 * Every path goes through resolveInRoot, so nothing reaches outside the linked
 * workspace, and every child process is bounded by a timeout.
 */

const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 4_000_000;

function toolBin(dir, exe) {
    return path.join(paths.toolsRoot(), dir,
        process.platform === "win32" ? "win-x64" : "mac-arm64",
        process.platform === "win32" ? exe + ".exe" : exe);
}
const qpdfBin = () => toolBin("qpdf", "qpdf");
const magickBin = () => toolBin("imagemagick", "magick");
const sqliteBin = () => toolBin("sqlite", "sqlite3");
const dotBin = () => toolBin("graphviz", "dot");

/** Run a bundled tool. ARRAY args only — never a shell, never a joined string. */
function run(bin, args, { stdin = null, timeoutMs = RUN_TIMEOUT_MS, cwd = null } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(bin, args, {
                windowsHide: true, cwd: cwd || path.dirname(bin)
            });
        }
        catch (e) { return resolve({ code: -1, out: "", err: String(e.message) }); }
        let out = "", err = "";
        child.stdout.on("data", d => { if (out.length < MAX_OUTPUT) out += d; });
        child.stderr.on("data", d => { if (err.length < 200_000) err += d; });
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
        if (timer.unref) timer.unref();
        child.on("error", e => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
        child.on("close", code => { clearTimeout(timer); resolve({ code, out, err }); });
        if (stdin !== null) {
            // A child that exits or rejects its input before we finish writing
            // makes the pipe error. An unhandled 'error' on a stream is an
            // uncaught exception, which in the main process takes the WHOLE
            // APP down — a malformed diagram or query would have been enough.
            // The close handler above already reports the real failure.
            child.stdin.on("error", () => { /* reported via exit code */ });
            try { child.stdin.end(stdin); } catch { /* pipe already gone */ }
        }
    });
}

/* ------------------------------------------------------------- edit_pdf --- */

const PDF_OPS = new Set(["split", "merge", "rotate", "pages", "decrypt", "repair", "info"]);

async function editPdf(root, args = {}, ctx = {}) {
    if (!root) throw new ToolError("link a workspace folder first");
    if (!fs.existsSync(qpdfBin())) throw new ToolError("PDF editing is not installed in this build");
    const op = String(args.op || "").toLowerCase();
    if (!PDF_OPS.has(op)) throw new ToolError(`op must be one of: ${[...PDF_OPS].join(", ")}`);
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};

    const inRel = String(args.path || "").trim();
    if (!inRel && op !== "merge") throw new ToolError("edit_pdf needs a path");
    const inFull = inRel ? resolveInRoot(root, inRel) : null;
    if (inFull && !fs.existsSync(inFull)) throw new ToolError(`no such file: ${inRel}`);

    const outRel = args.out ? String(args.out) : null;
    const outFull = outRel ? resolveForWrite(root, outRel, "write") : null;
    const rel = (p) => path.relative(root, p).split(path.sep).join("/");

    let argv, produced = [];
    if (op === "info") {
        argv = ["--show-npages", inFull];
        const r = await run(qpdfBin(), argv);
        if (r.code !== 0) throw new ToolError(`qpdf: ${(r.err || "").slice(-160)}`);
        return { file: inRel, pages: parseInt(r.out.trim(), 10) || null };
    }
    if (op === "split") {
        // one file per page, into a folder we name — qpdf writes %d itself
        const dirRel = outRel || inRel.replace(/\.pdf$/i, "") + "-pages";
        const dirFull = resolveInRoot(root, dirRel);
        fs.mkdirSync(dirFull, { recursive: true });
        const pattern = path.join(dirFull, "page-%d.pdf");
        argv = [inFull, "--split-pages=1", "--", pattern];
        onNote(`splitting ${inRel}`);
        const r = await run(qpdfBin(), argv);
        // qpdf exit 3 = warnings but output written
        if (r.code !== 0 && r.code !== 3) throw new ToolError(`qpdf: ${(r.err || "").slice(-200)}`);
        produced = fs.readdirSync(dirFull).filter(f => f.endsWith(".pdf")).sort();
        return { op, out: rel(dirFull), files: produced.length, note: `Split into ${produced.length} pages.` };
    }
    if (op === "merge") {
        const list = Array.isArray(args.inputs) ? args.inputs : [];
        if (list.length < 2) throw new ToolError('merge needs inputs: ["a.pdf","b.pdf", …]');
        if (!outFull) throw new ToolError("merge needs an out path");
        const ins = list.map(p => {
            const f = resolveInRoot(root, String(p));
            if (!fs.existsSync(f)) throw new ToolError(`no such file: ${p}`);
            return f;
        });
        argv = ["--empty", "--pages", ...ins, "--", outFull];
        onNote(`merging ${ins.length} files`);
    } else if (op === "rotate") {
        if (!outFull) throw new ToolError("rotate needs an out path");
        const deg = [90, 180, 270, -90].includes(+args.degrees) ? +args.degrees : 90;
        const range = String(args.pages || "1-z");
        argv = [inFull, `--rotate=${deg > 0 ? "+" : ""}${deg}:${range}`, "--", outFull];
    } else if (op === "pages") {
        if (!outFull) throw new ToolError("pages needs an out path");
        const range = String(args.pages || "").trim();
        if (!range) throw new ToolError('pages needs a range, e.g. "1-5" or "1,3,7-9"');
        // THIS CHECK IS A CONTAINMENT BOUNDARY. Do not weaken it.
        //
        // qpdf's --pages grammar is `file [range] [file [range]]... --`, and a
        // token that does not parse as a range is taken as the NEXT INPUT
        // FILE. So a bare path in this slot reads a PDF from anywhere on the
        // machine into the workspace, where read_pdf then feeds its text to
        // the model. edit_pdf is MUTATE, so it runs on NOTIFY without asking.
        // Nothing upstream catches it: resolveInRoot only sees path/out, and
        // policyBridge's scope check never looks at `pages` because it is not
        // a workspace-relative path.
        //
        // Verified against the bundled qpdf 12.3.2:
        //   qpdf --empty --pages cover.pdf OUTSIDE.pdf -- exfil.pdf
        //   -> exit 0, exfil.pdf = cover(2) + OUTSIDE(3) = 5 pages
        //
        // An earlier pass called this "not exploitable" after testing the
        // WRONG shape — a compound string like "1 /path 1-3", which qpdf
        // rejects as malformed. The attack is the bare path alone. A range is
        // digits, z, r, commas, colons and hyphens; nothing else belongs here.
        // qpdf's grammar: comma-separated terms of digits, z (last page),
        // r<n> (counted from the end) and x (exclude), joined by hyphens,
        // with an optional :even / :odd suffix. Expressed as a grammar rather
        // than a loose character class — the first attempt was a charset and
        // it both let a space through and rejected the legitimate "1-5:even".
        if (!/^[0-9zrx,\-]+(:(even|odd))?$/i.test(range)) {
            throw new ToolError(
                `that is not a page range: ${JSON.stringify(range)} — ` +
                'use digits, commas and hyphens, e.g. "1-5" or "1,3,7-9" ("z" is the last page)');
        }
        argv = ["--empty", "--pages", inFull, range, "--", outFull];
    } else if (op === "decrypt") {
        if (!outFull) throw new ToolError("decrypt needs an out path");
        argv = [inFull, "--decrypt", "--", outFull];
        if (args.password) argv.splice(1, 0, `--password=${String(args.password)}`);
    } else if (op === "repair") {
        if (!outFull) throw new ToolError("repair needs an out path");
        // qpdf reconstructs a damaged xref simply by rewriting the file
        argv = [inFull, "--", outFull];
    }

    const r = await run(qpdfBin(), argv);
    if (r.code !== 0 && r.code !== 3) throw new ToolError(`qpdf: ${(r.err || "").slice(-200)}`);
    if (!fs.existsSync(outFull)) throw new ToolError("qpdf produced no output");
    return { op, out: rel(outFull), bytes: fs.statSync(outFull).size,
             warnings: r.code === 3 ? (r.err || "").slice(-200) : undefined,
             note: `Wrote ${rel(outFull)}.` };
}

/* ----------------------------------------------------------- edit_image --- */

const IMG_OPS = new Set(["resize", "crop", "rotate", "convert", "grayscale",
                         "trim", "thumbnail", "identify"]);

async function editImage(root, args = {}, ctx = {}) {
    if (!root) throw new ToolError("link a workspace folder first");
    if (!fs.existsSync(magickBin())) throw new ToolError("image editing is not installed in this build");
    const op = String(args.op || "").toLowerCase();
    if (!IMG_OPS.has(op)) throw new ToolError(`op must be one of: ${[...IMG_OPS].join(", ")}`);
    const inFull = resolveInRoot(root, String(args.path || ""));
    if (!fs.existsSync(inFull)) throw new ToolError(`no such file: ${args.path}`);
    const rel = (p) => path.relative(root, p).split(path.sep).join("/");

    if (op === "identify") {
        const r = await run(magickBin(), ["identify", "-format",
            "%m %wx%h %[colorspace] %b", inFull]);
        if (r.code !== 0) throw new ToolError(`magick: ${(r.err || "").slice(-160)}`);
        const [format, size, colorspace, bytes] = r.out.trim().split(" ");
        return { file: args.path, format, size, colorspace, bytes };
    }

    const outRel = args.out ? String(args.out)
        : String(args.path).replace(/(\.[^.]+)$/, `-${op}$1`);
    const outFull = resolveForWrite(root, outRel, "write");
    // NEVER over the source. magick reads and writes streaming, so naming the
    // input as the output destroys the original BEFORE it can be read — the
    // refusal is about that streaming hazard, not about revertability (the out
    // path IS snapshotted now, via the agent's MUTATING_TOOLS backup, so an
    // overwrite of a pre-existing output can be reverted). mediaTools has refused
    // this since it was written (mediaTools.js resolveMedia); this module did not.
    if (path.resolve(outFull) === path.resolve(inFull)) {
        throw new ToolError(
            "refusing to write over the source image — name a different out " +
            "file so the original survives");
    }

    // Geometry strings are the one place a model could smuggle something in,
    // so they are validated against a strict shape rather than trusted.
    const geom = (s, re, what) => {
        const v = String(s || "").trim();
        if (!re.test(v)) throw new ToolError(`${what} looks wrong: ${JSON.stringify(v)}`);
        return v;
    };

    const argv = [inFull];
    if (op === "resize" || op === "thumbnail") {
        argv.push(op === "thumbnail" ? "-thumbnail" : "-resize",
            // "1200x" (width, keep aspect) and "x800" (height, keep aspect) are
            // the two most useful forms and the first version rejected both
            geom(args.size, /^(\d{1,5}(x\d{0,5})?|x\d{1,5})[%^!<>]?$/, "size"));
    } else if (op === "crop") {
        argv.push("-crop", geom(args.region, /^\d{1,5}x\d{1,5}([+-]\d{1,5}){0,2}$/, "region"),
            "+repage");
    } else if (op === "rotate") {
        const deg = Number(args.degrees);
        if (!Number.isFinite(deg) || Math.abs(deg) > 360) throw new ToolError("degrees must be -360..360");
        argv.push("-rotate", String(deg));
    } else if (op === "grayscale") {
        argv.push("-colorspace", "Gray");
    } else if (op === "trim") {
        argv.push("-trim", "+repage");
    }
    if (args.quality != null) {
        const q = Math.max(1, Math.min(100, Math.floor(+args.quality)));
        argv.push("-quality", String(q));
    }
    argv.push(outFull);

    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote(`${op} ${args.path}`);
    const r = await run(magickBin(), argv);
    if (r.code !== 0 || !fs.existsSync(outFull)) {
        throw new ToolError(`magick: ${(r.err || "").slice(-200) || "produced no output"}`);
    }
    const id = await run(magickBin(), ["identify", "-format", "%wx%h", outFull]);
    return { op, out: rel(outFull), size: id.out.trim() || null,
             bytes: fs.statSync(outFull).size, note: `Wrote ${rel(outFull)}.` };
}

/* ----------------------------------------------------------- query_data --- */

// Dot-commands and file-touching functions are the escape hatches out of a
// query and into the machine. sqlite's own -safe mode blocks most of them; we
// refuse them before they are ever handed over, because defence that depends
// on one flag being present is not defence.
// Two separate patterns, because one alternation could not carry both shapes:
// the pragma-assignment form ends in "=", and a trailing \b after "=" demands
// a word character next — so "pragma journal_mode = wal" (spaces around the
// equals) sailed straight through while "pragma journal_mode=wal" was caught.
const SQL_FORBIDDEN = /\b(attach|detach|load_extension|readfile|writefile|edit|fts3_tokenizer|sqlite_dbpage)\b/i;
const SQL_PRAGMA_SET = /\bpragma\s+\w+\s*=/i;

/**
 * Strip string literals and comments before scanning for dangerous
 * constructs. Without this, `select 'attach the sensor' as note` — an
 * entirely ordinary query — is refused because the word appears inside a
 * quoted string, and a guard that blocks real work gets switched off.
 * Stripping is the conservative direction: it can only ever REMOVE text from
 * the scan, and hiding a keyword inside a literal cannot execute it.
 */
function stripLiterals(sql) {
    return String(sql)
        .replace(/'(?:''|[^'])*'/g, "''")        // '...' with '' escaping
        .replace(/"(?:""|[^"])*"/g, '""')        // "identifier" quoting
        .replace(/\/\*[\s\S]*?\*\//g, " ")       // /* block comments */
        .replace(/--[^\n]*/g, " ");              // -- line comments
}

function assertSafeSql(sql) {
    const s = String(sql || "").trim();
    if (!s) throw new ToolError("query_data needs sql");
    if (s.length > 20000) throw new ToolError("that query is too long");
    // a leading dot is a CLI command, not SQL — never legitimate here.
    // Checked on the RAW text: a dot-command cannot hide inside a literal,
    // and stripping first would let "--\n.shell x" through.
    for (const line of s.split(/\r?\n/)) {
        if (/^\s*\./.test(line)) {
            throw new ToolError("dot-commands are not allowed — write SQL only");
        }
    }
    const scan = stripLiterals(s);
    if (SQL_PRAGMA_SET.test(scan)) {
        throw new ToolError("PRAGMA assignments are not allowed — this is a read-only query");
    }
    if (SQL_FORBIDDEN.test(scan)) {
        throw new ToolError("that query uses a construct that can reach outside the " +
            "database (ATTACH, load_extension, readfile/writefile) — not allowed");
    }
    return s;
}

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

async function queryData(root, args = {}, ctx = {}) {
    if (!root) throw new ToolError("link a workspace folder first");
    if (!fs.existsSync(sqliteBin())) throw new ToolError("data querying is not installed in this build");
    const sql = assertSafeSql(args.sql);
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};

    let dbPath = null;
    let temp = null;
    if (args.database) {
        dbPath = resolveInRoot(root, String(args.database));
        if (!fs.existsSync(dbPath)) throw new ToolError(`no such database: ${args.database}`);
    } else {
        // CSVs become tables in a throwaway database. Every dot-command here
        // is composed by US — the model only names files and tables.
        const files = Array.isArray(args.csv) ? args.csv
            : (args.csv ? [args.csv] : []);
        if (!files.length) {
            throw new ToolError('query_data needs either {"database": "x.db"} or {"csv": ["data.csv"]}');
        }
        if (files.length > 12) throw new ToolError("at most 12 CSV files per query");
        temp = path.join(os.tmpdir(), `lcl-sql-${process.pid}-${Date.now()}.db`);
        dbPath = temp;
        const cmds = [];
        for (const f of files) {
            const spec = typeof f === "string" ? { path: f } : (f || {});
            const p = resolveInRoot(root, String(spec.path || ""));
            if (!fs.existsSync(p)) throw new ToolError(`no such file: ${spec.path}`);
            const table = String(spec.table
                || path.basename(String(spec.path)).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_"));
            if (!TABLE_NAME.test(table)) throw new ToolError(`bad table name: ${table}`);
            // FORWARD SLASHES, always: sqlite's dot-command parser treats
            // backslash as an escape inside a quoted argument, so a Windows
            // path silently became "C:UsersyouAppData…" (separators eaten,
            // segments fused) and the import failed. sqlite itself accepts
            // forward slashes on Windows.
            const importPath = p.replace(/\\/g, "/");
            cmds.push(".mode csv", `.import "${importPath.replace(/"/g, '""')}" ${table}`);
            onNote(`loading ${spec.path || spec} as ${table}`);
        }
        const load = await run(sqliteBin(), [dbPath], { stdin: cmds.join("\n") + "\n.quit\n" });
        if (load.code !== 0) {
            try { fs.rmSync(temp, { force: true }); } catch { /* temp */ }
            throw new ToolError(`could not load the CSV: ${(load.err || "").slice(-200)}`);
        }
    }

    try {
        // -readonly and -safe together: the query cannot write, cannot attach,
        // cannot shell out. The CSV load above already happened in its own
        // process, so nothing the model wrote runs with write access.
        const r = await run(sqliteBin(), ["-readonly", "-safe", "-json", dbPath],
            { stdin: sql.endsWith(";") ? sql : sql + ";" });
        if (r.code !== 0) throw new ToolError(`sqlite: ${(r.err || "").slice(-240)}`);
        let rows;
        try { rows = JSON.parse(r.out.trim() || "[]"); }
        catch { return { rows: [], raw: r.out.slice(0, 4000) }; }
        const capped = Array.isArray(rows) ? rows.slice(0, 500) : rows;
        return {
            rows: capped,
            count: Array.isArray(rows) ? rows.length : null,
            truncated: Array.isArray(rows) && rows.length > 500,
            note: Array.isArray(rows)
                ? `${rows.length} row${rows.length === 1 ? "" : "s"}` +
                  (rows.length > 500 ? " (showing the first 500)" : "")
                : undefined
        };
    } finally {
        if (temp) { try { fs.rmSync(temp, { force: true }); } catch { /* temp */ } }
    }
}

/* --------------------------------------------------------- draw_diagram --- */

const DOT_ENGINES = new Set(["dot", "neato", "fdp", "circo", "twopi"]);
const DOT_FORMATS = new Set(["svg", "png", "pdf"]);

async function drawDiagram(root, args = {}, ctx = {}) {
    if (!root) throw new ToolError("link a workspace folder first");
    if (!fs.existsSync(dotBin())) throw new ToolError("diagram rendering is not installed in this build");
    const src = String(args.dot || "").trim();
    if (!src) {
        throw new ToolError('draw_diagram needs dot, e.g. ' +
            '{"dot": "digraph { PSU -> F1 -> K1 }"}');
    }
    if (src.length > 200_000) throw new ToolError("that diagram source is too large");
    const format = DOT_FORMATS.has(String(args.format || "svg").toLowerCase())
        ? String(args.format || "svg").toLowerCase() : "svg";
    const engine = DOT_ENGINES.has(String(args.engine || "dot").toLowerCase())
        ? String(args.engine || "dot").toLowerCase() : "dot";

    const outRel = String(args.out || `diagram.${format}`);
    const outFull = resolveForWrite(root, outRel, "write");
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote(`rendering with ${engine}`);

    // GRAPHVIZ READS FILES. image=, shapefile= and fontpath pull a file from
    // disk into the rendering — an audit confirmed a PNG from outside the
    // workspace being embedded straight into the output SVG, which is a
    // containment escape dressed up as a diagram. Two layers close it:
    //
    //  1. Absolute paths and parent traversal are refused in the SOURCE, so
    //     the attempt is reported rather than silently yielding a diagram
    //     with a missing image.
    //  2. The child runs with its CWD set to the workspace, so a relative
    //     reference resolves inside the workspace instead of against the
    //     tools directory (where it would otherwise land, since every other
    //     tool here runs beside its binary).
    //
    // NOT used: GV_FILE_PATH, graphviz's own sandbox. It was the obvious
    // answer and it is gone — Graphviz 15 exits immediately with "$GV_FILE_PATH
    // environment variable set; exiting / This sandboxing mechanism is no
    // longer supported". Setting it does not harden the tool, it breaks it.
    const fileRef = /\b(image|shapefile|fontpath|imagepath)\s*=\s*"?([^",\]\s]+)/gi;
    let m;
    while ((m = fileRef.exec(src)) !== null) {
        const ref = m[2];
        if (path.isAbsolute(ref) || /^[A-Za-z]:/.test(ref) || ref.split(/[\\/]/).includes("..")) {
            throw new ToolError(
                `the diagram references a file outside the workspace (${m[1]}="${ref}") — ` +
                "use a path relative to the workspace");
        }
    }

    // -K selects the layout engine, so one binary covers all five
    const r = await run(dotBin(), [`-K${engine}`, `-T${format}`, "-o", outFull],
        { stdin: src, cwd: root });
    if (r.code !== 0 || !fs.existsSync(outFull)) {
        throw new ToolError(`graphviz: ${(r.err || "").slice(-240) || "produced no output"}`);
    }

    // hand the picture back so it renders in the conversation, like a schematic
    let dataUri = null;
    try {
        const raw = fs.readFileSync(outFull);
        if (raw.length < 4_000_000) {
            const mime = format === "svg" ? "image/svg+xml"
                : format === "png" ? "image/png" : "application/pdf";
            if (format !== "pdf") dataUri = `data:${mime};base64,${raw.toString("base64")}`;
        }
    } catch { /* the file exists either way */ }

    return {
        out: path.relative(root, outFull).split(path.sep).join("/"),
        format, engine, bytes: fs.statSync(outFull).size,
        kind: dataUri ? "image" : undefined, dataUri,
        warnings: (r.err || "").trim().slice(0, 200) || undefined,
        note: `Rendered ${path.relative(root, outFull).split(path.sep).join("/")}.`
    };
}

/* ---------------------------------------------------------------- wiring -- */

const pdfAvailable = () => { try { return fs.existsSync(qpdfBin()); } catch { return false; } };
const imageAvailable = () => { try { return fs.existsSync(magickBin()); } catch { return false; } };
const dataAvailable = () => { try { return fs.existsSync(sqliteBin()); } catch { return false; } };
const diagramAvailable = () => { try { return fs.existsSync(dotBin()); } catch { return false; } };

const PDF_ENTRY = {
    run: editPdf,
    help: 'edit_pdf {"op": "pages", "path": "big.pdf", "pages": "1-5", "out": "first5.pdf"} — ' +
        "split / merge / rotate / pages / decrypt / repair / info on a PDF"
};
const IMAGE_ENTRY = {
    run: editImage,
    help: 'edit_image {"op": "resize", "path": "photo.jpg", "size": "1200x", "out": "small.jpg"} — ' +
        "resize / crop / rotate / convert / grayscale / trim / thumbnail / identify"
};
const DATA_ENTRY = {
    run: queryData,
    help: 'query_data {"csv": ["readings.csv"], "sql": "select tag, avg(value) from readings group by tag"} — ' +
        "run SQL over CSV files or a .db (read-only; no file access from inside the query)"
};
const DIAGRAM_ENTRY = {
    run: drawDiagram,
    help: 'draw_diagram {"dot": "digraph { PSU -> F1 -> K1 [label=\\"L1\\"] }", "out": "loop.svg"} — ' +
        "render a Graphviz DOT diagram (dot/neato/fdp/circo/twopi) as svg/png/pdf"
};

module.exports = {
    pdfAvailable, imageAvailable, dataAvailable, diagramAvailable,
    editPdf, editImage, queryData, drawDiagram, assertSafeSql,
    qpdfBin, magickBin, sqliteBin, dotBin,
    PDF_ENTRY, IMAGE_ENTRY, DATA_ENTRY, DIAGRAM_ENTRY
};
