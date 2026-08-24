/**
 * THE BUNDLED INSTRUMENTS — qpdf, ImageMagick, SQLite, Graphviz.
 *
 * Each is a third-party executable driven by argv this engine composes. Two
 * things must hold for every one of them: it actually does the job on a real
 * file, and the model cannot use it to reach past the workspace or out to the
 * machine. The SQL guard gets the most attention, because a query language
 * with file functions and shell dot-commands is the sharpest edge here.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
// ISOLATED per run: paths.js derives the data directory from this,
// so a shared os.tmpdir() made every suite inherit whatever settings
// an earlier suite had written — an order-dependent gate that failed
// builds at random.
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const ext = require(__dirname + "/../.lcl.engine/core/extTools.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 220) : ""); }
}
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };

(async () => {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ext-"));
    fs.writeFileSync(path.join(ROOT, "outside-marker.txt"), "secret");

    /* ================= the SQL guard — pure, always tested ================= */
    for (const bad of [
        ".shell echo pwned",
        ".system calc.exe",
        "select readfile('C:/Windows/win.ini')",
        "select writefile('x.txt','y')",
        "ATTACH DATABASE 'C:/other.db' AS o; select * from o.t",
        "select load_extension('evil.dll')",
        "  .import x.csv t"
    ]) {
        let threw = false;
        try { ext.assertSafeSql(bad); } catch { threw = true; }
        check(`SQL guard refuses: ${bad.trim().slice(0, 34)}`, threw);
    }
    for (const good of [
        "select 1",
        "select tag, avg(value) from readings group by tag order by 2 desc",
        "with t as (select * from a) select count(*) from t"
    ]) {
        let ok = true;
        try { ext.assertSafeSql(good); } catch { ok = false; }
        check(`SQL guard allows: ${good.slice(0, 34)}`, ok);
    }
    check("empty SQL is refused", await rejects(async () => ext.assertSafeSql("")));

    /* ========================= query_data, for real ======================== */
    if (!ext.dataAvailable()) {
        console.log("-- sqlite not installed: query checks skipped --");
    } else {
        fs.writeFileSync(path.join(ROOT, "readings.csv"),
            "tag,value\nFT-101,4.2\nFT-101,4.6\nPT-200,12.1\nPT-200,11.9\nPT-200,12.5\n");
        const q = await ext.queryData(ROOT, {
            csv: ["readings.csv"],
            sql: "select tag, count(*) n, round(avg(value),2) avg from readings group by tag order by tag"
        }, {});
        check("CSV becomes a queryable table",
            q.rows.length === 2 && q.rows[0].tag === "FT-101" && Number(q.rows[0].n) === 2, q.rows);
        check("aggregates compute correctly",
            Math.abs(Number(q.rows[1].avg) - 12.17) < 0.02, q.rows[1]);
        check("a dot-command in sql is refused before sqlite sees it",
            await rejects(() => ext.queryData(ROOT, { csv: ["readings.csv"], sql: ".tables" }, {})));
        check("readfile() is refused",
            await rejects(() => ext.queryData(ROOT,
                { csv: ["readings.csv"], sql: "select readfile('outside-marker.txt')" }, {})));
        check("a CSV outside the workspace is refused",
            await rejects(() => ext.queryData(ROOT,
                { csv: ["../../etc/passwd"], sql: "select 1" }, {})));
        check("a bad table name is refused",
            await rejects(() => ext.queryData(ROOT,
                { csv: [{ path: "readings.csv", table: "a; drop table b" }], sql: "select 1" }, {})));
    }

    /* =========================== draw_diagram ============================= */
    if (!ext.diagramAvailable()) {
        console.log("-- graphviz not installed: diagram checks skipped --");
    } else {
        const d = await ext.drawDiagram(ROOT, {
            dot: 'digraph { rankdir=LR; PSU -> F1 [label="L1"]; F1 -> K1; K1 -> M1 }',
            out: "loop.svg"
        }, {});
        check("DOT renders to SVG", d.out === "loop.svg" && fs.existsSync(path.join(ROOT, "loop.svg")));
        const svg = fs.readFileSync(path.join(ROOT, "loop.svg"), "utf8");
        check("the SVG contains the nodes we asked for", /PSU/.test(svg) && /K1/.test(svg));
        check("the diagram comes back displayable in chat",
            d.kind === "image" && /^data:image\/svg\+xml;base64,/.test(d.dataUri || ""));
        const p = await ext.drawDiagram(ROOT, { dot: "graph { a -- b }", engine: "neato",
            format: "png", out: "n.png" }, {});
        check("other engines and formats work", p.engine === "neato" && p.format === "png"
            && fs.statSync(path.join(ROOT, "n.png")).size > 100);
        check("invalid DOT fails with a reason",
            await rejects(() => ext.drawDiagram(ROOT, { dot: "this is not dot {{{", out: "x.svg" }, {})));
        check("empty DOT is refused",
            await rejects(() => ext.drawDiagram(ROOT, { dot: "" }, {})));
    }

    /* ============================= edit_image ============================= */
    if (!ext.imageAvailable()) {
        console.log("-- imagemagick not installed: image checks skipped --");
    } else {
        // make a real source image with magick itself
        const { execFileSync } = require("child_process");
        execFileSync(ext.magickBin(), ["-size", "800x600", "xc:navy",
            path.join(ROOT, "src.png")], { timeout: 60000 });
        const r = await ext.editImage(ROOT, { op: "resize", path: "src.png",
            size: "200x", out: "small.png" }, {});
        check("resize produces the requested width", r.size === "200x150", r.size);
        const c = await ext.editImage(ROOT, { op: "crop", path: "src.png",
            region: "100x100+10+10", out: "crop.png" }, {});
        check("crop produces the requested region", c.size === "100x100", c.size);
        const id = await ext.editImage(ROOT, { op: "identify", path: "src.png" }, {});
        check("identify reports real metadata", id.size === "800x600" && id.format === "PNG", id);
        check("a malformed geometry is refused",
            await rejects(() => ext.editImage(ROOT,
                { op: "resize", path: "src.png", size: "200x; calc.exe" }, {})));
        check("an image outside the workspace is refused",
            await rejects(() => ext.editImage(ROOT,
                { op: "identify", path: "../../Windows/win.ini" }, {})));
    }

    /* =============================== edit_pdf ============================= */
    if (!ext.pdfAvailable()) {
        console.log("-- qpdf not installed: pdf checks skipped --");
    } else if (!ext.imageAvailable()) {
        console.log("-- no way to make a test PDF: pdf checks skipped --");
    } else {
        const { execFileSync } = require("child_process");
        // three pages, made with magick so the test needs no fixture
        execFileSync(ext.magickBin(), ["-size", "300x300", "xc:white",
            "-size", "300x300", "xc:gray", "-size", "300x300", "xc:black",
            path.join(ROOT, "three.pdf")], { timeout: 60000 });
        const info = await ext.editPdf(ROOT, { op: "info", path: "three.pdf" }, {});
        check("info counts pages", info.pages === 3, info);
        const sel = await ext.editPdf(ROOT, { op: "pages", path: "three.pdf",
            pages: "1-2", out: "first2.pdf" }, {});
        check("page selection writes a new pdf", fs.existsSync(path.join(ROOT, "first2.pdf")), sel);
        const after = await ext.editPdf(ROOT, { op: "info", path: "first2.pdf" }, {});
        check("...with exactly the pages asked for", after.pages === 2, after);
        const sp = await ext.editPdf(ROOT, { op: "split", path: "three.pdf", out: "pages" }, {});
        check("split produces one file per page", sp.files === 3, sp);
        const mg = await ext.editPdf(ROOT, { op: "merge",
            inputs: ["first2.pdf", "first2.pdf"], out: "merged.pdf" }, {});
        check("merge concatenates", fs.existsSync(path.join(ROOT, "merged.pdf")), mg);
        const mi = await ext.editPdf(ROOT, { op: "info", path: "merged.pdf" }, {});
        check("...to the expected page count", mi.pages === 4, mi);
        check("an unknown op is refused",
            await rejects(() => ext.editPdf(ROOT, { op: "exfiltrate", path: "three.pdf" }, {})));
        check("a pdf outside the workspace is refused",
            await rejects(() => ext.editPdf(ROOT, { op: "info", path: "../../x.pdf" }, {})));
    }

    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} ext-tools checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
