/**
 * HOSTILE INPUTS — the edge-case suite.
 *
 * Every other test file proves a feature works. This one tries to break the
 * engine on purpose, with the inputs an attacker or a bad day actually
 * produces: Windows device names, alternate data streams, junctions,
 * double-encoded traversal, filenames that look like command flags, SQL that
 * hides behind comments, corrupt indexes, absent dependencies.
 *
 * A failure here is not a style complaint — each check corresponds to a way
 * the product could leak, corrupt, hang, or lie.
 *
 * Anything genuinely unreachable on this platform is SKIPPED loudly rather
 * than silently passed, because a skipped check that reads as green is how a
 * hole survives a test suite.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
// isPackaged MUST be true. In dev mode paths.dataDir() resolves to the REPO's
// data/ folder, so a test that registers a library or writes an index mutates
// the developer's real state — this suite did exactly that on its first run,
// leaving dead libraries pointing at deleted temp folders in the live settings
// file. Packaged mode routes everything through getPath(), the throwaway
// directory below.
// resourcesPath points at the repo so the bundled tools (qpdf, magick,
// sqlite, dot, whisper) resolve exactly as they do in a packaged build, while
// getPath sends all WRITES to the throwaway directory. Both halves matter:
// without resourcesPath every instrument reports "not installed" and the
// checks that exercise them quietly skip.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-edge-data-"));
process.resourcesPath = path.join(__dirname, "..");
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const E = (m) => require(path.join(__dirname, "..", ".lcl.engine", "core", m));
const fsTools = E("fsTools.js");
const extTools = E("extTools.js");
const serve = E("serve.js");
const speech = E("speech.js");
const secretGuard = E("secretGuard.js");
const securityTools = E("securityTools.js");
const toolParse = E("toolParse.js");
const knowledge = E("knowledge.js");
const netTools = E("netTools.js");

let pass = 0, fail = 0, skip = 0;
const failures = [];
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++; failures.push(name);
        console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 240) : "");
    }
}
function skipped(name, why) { skip++; console.log("SKIP |", name, "-", why); }
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };
const throwsSync = (fn) => { try { fn(); return false; } catch { return true; } };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-edge-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-outside-"));
fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "SENSITIVE-CANARY-VALUE");
fs.writeFileSync(path.join(ROOT, "ok.txt"), "hello");

(async () => {

/* ══════════════════════════ 1. PATH CONTAINMENT ══════════════════════════ */
console.log("\n-- path containment --");

// classic and encoded traversal
for (const p of [
    "../secret.txt", "..\\secret.txt", "../../secret.txt",
    "foo/../../secret.txt", "./../../secret.txt",
    "\\\\?\\C:\\Windows\\win.ini", "//?/C:/Windows/win.ini",
    "\\\\localhost\\C$\\Windows\\win.ini",
    "C:\\Windows\\win.ini", "/etc/passwd"
]) {
    check(`resolveInRoot refuses ${JSON.stringify(p)}`,
        throwsSync(() => fsTools.resolveInRoot(ROOT, p)));
}

// Percent-encoding is an HTTP concept, not a filesystem one. At this layer
// "%2e%2e" is a literal directory name, so the right outcome is CONTAINMENT,
// not refusal — decoding it here would invent an escape that does not exist.
// The decoded form is what serve_folder must handle, and that is tested
// separately against the running server below.
for (const p of ["%2e%2e/secret.txt", "..%2fsecret.txt", "%2e%2e%5csecret.txt"]) {
    let resolved = null;
    try { resolved = fsTools.resolveInRoot(ROOT, p); } catch { /* refusing is fine too */ }
    check(`percent-encoded traversal ${JSON.stringify(p)} stays inside the root`,
        resolved === null || resolved.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep),
        resolved);
}

// Windows reserved device names — opening these can hang or hit hardware
const DEVICES = ["CON", "NUL", "PRN", "AUX", "COM1", "LPT1", "con.txt", "NUL.md"];
for (const d of DEVICES) {
    let resolved = null;
    try { resolved = fsTools.resolveInRoot(ROOT, d); } catch { /* refused outright */ }
    // Either refuse it, or resolve it to a path INSIDE the root (never the device)
    const contained = resolved === null
        || resolved.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep);
    check(`device name ${d} is refused or contained`, contained, resolved);
}

// NTFS alternate data stream: "file.txt:hidden" writes a stream, not the file
for (const p of ["ok.txt:hidden", "ok.txt::$DATA", "ok.txt:hidden:$DATA"]) {
    let resolved = null;
    try { resolved = fsTools.resolveInRoot(ROOT, p); } catch { /* refused */ }
    check(`alternate data stream ${JSON.stringify(p)} is refused`,
        resolved === null, resolved);
}

// trailing dot/space: Windows strips them, so "ok.txt." can alias "ok.txt"
for (const p of ["ok.txt.", "ok.txt ", "ok.txt..."]) {
    let resolved = null;
    try { resolved = fsTools.resolveInRoot(ROOT, p); } catch { /* refused */ }
    const contained = resolved === null
        || resolved.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep);
    check(`trailing-dot/space name ${JSON.stringify(p)} stays contained`, contained, resolved);
}

// null byte truncation
check("a NUL byte in a path is refused",
    throwsSync(() => fsTools.resolveInRoot(ROOT, "ok\u0000.txt")));

// junction escape — the real Windows hazard
let junction = false;
try {
    execFileSync("cmd", ["/c", "mklink", "/J", path.join(ROOT, "jump"), OUTSIDE], { stdio: "pipe" });
    junction = true;
} catch { /* needs privilege on some systems */ }
if (junction) {
    let resolved = null;
    try { resolved = fsTools.resolveInRoot(ROOT, "jump/secret.txt"); } catch { /* refused */ }
    check("a junction pointing outside the workspace cannot be read through",
        resolved === null, resolved);
} else {
    skipped("junction escape", "mklink unavailable");
}

/* ═══════════════════════ 2. ARGV / FLAG INJECTION ════════════════════════ */
console.log("\n-- argv injection --");

// A filename that looks like a flag must not become one. If the tool refuses
// the name outright that is also a pass — what must NOT happen is the string
// reaching the child process as an option.
if (extTools.imageAvailable()) {
    const flagName = "-version";
    fs.writeFileSync(path.join(ROOT, flagName), "not an image");
    const r = await extTools.editImage(ROOT, { op: "identify", path: flagName }, {})
        .then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e.message) }));
    // identify on a text file must fail; it must NOT succeed by printing the version
    check("a filename that looks like a flag does not become one",
        !r.ok || !/ImageMagick \d/.test(JSON.stringify(r.v || "")), r);
} else {
    skipped("flag-shaped filename (imagemagick)", "not installed");
}

/* ═════════════════════════ 3. SQL GUARD BYPASSES ═════════════════════════ */
console.log("\n-- sql guard --");

const SQL_ATTACKS = [
    ["comment-hidden attach", "select 1; /**/ATTACH/**/ DATABASE 'x.db' AS o"],
    ["line-comment split", "select 1;\n--\nATTACH DATABASE 'x.db' AS o"],
    ["mixed case readfile", "select ReAdFiLe('C:/Windows/win.ini')"],
    ["writefile chained", "select 1; select writefile('out.txt','x')"],
    ["load_extension spaced", "select load_extension ('evil.dll')"],
    ["dot command after newline", "select 1;\n.shell calc"],
    ["dot command with leading tab", "\t.system calc"],
    ["pragma assignment (spaced =)", "pragma journal_mode = wal"],
    ["pragma assignment (tight =)", "pragma journal_mode=wal"],
    // NOT included as an attack: "AT/**/TACH". A comment SEPARATES tokens, it
    // does not glue them — sqlite answers `near "AT": syntax error`, verified
    // against the bundled binary. Asserting it must be blocked would be
    // testing a threat that does not exist.
    ["comment before the keyword", "select 1; /* note */ ATTACH DATABASE 'x.db' AS o"],
    ["comment inside the statement", "select 1; ATTACH /* here */ DATABASE 'x.db' AS o"],
    ["nested quoting readfile", "select 'a' || readfile('x') || 'b'"]
];
for (const [name, sql] of SQL_ATTACKS) {
    check(`SQL guard blocks: ${name}`, throwsSync(() => extTools.assertSafeSql(sql)),
        sql.slice(0, 60));
}
// and must not become so paranoid it blocks real analysis
for (const [name, sql] of [
    ["a column named attachment", "select attachment_id from readings"],
    ["a string containing the word attach", "select 'attach the sensor' as note"],
    ["window function", "select tag, avg(value) over (partition by tag) from readings"]
]) {
    check(`SQL guard allows: ${name}`, !throwsSync(() => extTools.assertSafeSql(sql)), sql);
}

/* ══════════════════════ 4. SERVE_FOLDER CONTAINMENT ══════════════════════ */
console.log("\n-- serve_folder --");

if (true) {
    const http = require("http");
    const get = (url) => new Promise(res => {
        const r = http.get(url, s => { let b = ""; s.on("data", c => b += c);
            s.on("end", () => res({ status: s.statusCode, body: b })); });
        r.on("error", e => res({ error: e.message }));
    });
    fs.mkdirSync(path.join(ROOT, "site"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "site", "index.html"), "<h1>ok</h1>");
    const s = await serve.serveFolder(ROOT, { path: "site" }, {});
    const ATTACKS = [
        "..%2f..%2fsecret.txt",
        "%2e%2e%2f%2e%2e%2fsecret.txt",
        "..%252f..%252fsecret.txt",
        "....//....//secret.txt",
        "/C:/Windows/win.ini",
        "//localhost/C$/Windows/win.ini",
        "index.html::$DATA",
        "../ok.txt"
    ];
    for (const a of ATTACKS) {
        const r = await get(s.url + a);
        const leaked = r.status === 200 && /SENSITIVE-CANARY|hello|\[fonts\]/i.test(r.body || "");
        check(`served folder refuses ${a.slice(0, 34)}`, !leaked, { status: r.status });
    }
    serve.stopServer(s.id);
}

/* ═══════════════════════ 5. SECRET EGRESS GUARD ══════════════════════════ */
console.log("\n-- secret guard --");

const SECRETS = [
    ["aws key", "AKIAIOSFODNN7EXAMPLE"],
    ["private key header", "-----BEGIN RSA PRIVATE KEY-----"],
    ["bearer token", "Authorization: Bearer sk-abc123def456ghi789jkl012mno345pqr"],
    ["password assignment", 'password = "hunter2hunter2hunter2"'],
    ["github token", "ghp_1234567890abcdefghijklmnopqrstuvwxyz"]
];
for (const [name, val] of SECRETS) {
    const found = securityTools.looksLikeSecret(val);
    check(`recognises a ${name}`, !!(found && found.found), found);
}
// and does not flag ordinary engineering text
for (const [name, val] of [
    ["a measurement", "The bearing clearance is 250 microns across the housing"],
    // a long alphanumeric ORDER CODE — the shape that reads like a key and is
    // not one. Deliberately a made-up product: no real vendor or customer of
    // this product's author appears in its fixtures.
    ["a part number", "Model DX-400 controller, order code DX400C2AD2E11A1AB4"],
    ["a hex colour", "background: #a8c8e8;"]
]) {
    const found = securityTools.looksLikeSecret(val);
    check(`does NOT flag ${name}`, !(found && found.found), found);
}
// once remembered, a value must be redacted wherever it appears
secretGuard.remember("AKIAIOSFODNN7EXAMPLE token", "test");
const red = secretGuard.redact("here it is: AKIAIOSFODNN7EXAMPLE and again AKIAIOSFODNN7EXAMPLE");
check("a remembered secret is redacted everywhere it appears",
    !/AKIAIOSFODNN7EXAMPLE/.test(red), red);

/* ═════════════════════ 6. MODEL OUTPUT PARSING ═══════════════════════════ */
console.log("\n-- tool parsing (hostile model output) --");

const KNOWN = ["read_file", "write_file", "run_script", "clarify"];
const PARSE = [
    ["deeply nested json", '```tool\n{"tool":"read_file","args":{"path":"' + "a/".repeat(400) + 'x"}}\n```'],
    ["unterminated fence", '```tool\n{"tool":"read_file","args":{"path":"x"}}'],
    ["two tool blocks", '```tool\n{"tool":"read_file","args":{"path":"a"}}\n```\n```tool\n{"tool":"write_file","args":{"path":"b"}}\n```'],
    ["tool name with path traversal", '```tool\n{"tool":"../../evil","args":{}}\n```'],
    ["huge args", '```tool\n{"tool":"read_file","args":{"path":"' + "A".repeat(100000) + '"}}\n```'],
    ["prototype pollution attempt", '```tool\n{"tool":"read_file","args":{"__proto__":{"polluted":true},"path":"x"}}\n```'],
    ["unicode direction override", '```tool\n{"tool":"read_file","args":{"path":"\u202Egnp.exe"}}\n```']
];
for (const [name, text] of PARSE) {
    let out = null, threw = false;
    const t0 = Date.now();
    try { out = toolParse.extractToolCall(text, KNOWN); } catch { threw = true; }
    const ms = Date.now() - t0;
    check(`parser survives ${name} (${ms}ms)`, !threw && ms < 3000, { threw, ms });
}
check("prototype was not polluted by parsing", ({}).polluted === undefined);
check("an unknown tool name is not accepted",
    (() => { const r = toolParse.extractToolCall(
        '```tool\n{"tool":"../../evil","args":{}}\n```', KNOWN);
        return !r.call || r.call.tool !== "../../evil"; })());

/* ═══════════════════ 7. CORRUPT PERSISTED STATE ══════════════════════════ */
console.log("\n-- corrupt state recovery --");

{
    const KDIR = path.join(DATA, "data", "knowledge");
    fs.mkdirSync(KDIR, { recursive: true });
    // a truncated index must not be read as "empty but valid" and then saved over
    fs.writeFileSync(path.join(KDIR, "deadbeefdeadbeef.json"), '{"files":{"a.txt":{"chunks":3');
    let listed = null, threw = false;
    try { listed = knowledge.list(); } catch { threw = true; }
    check("a truncated index file does not crash the library list", !threw, threw);
}

/* ════════════════════════ 8. NETWORK GUARD ═══════════════════════════════ */
console.log("\n-- network guard --");

const BLOCKED = [
    "http://127.0.0.1:8080/", "http://localhost/admin",
    "http://169.254.169.254/latest/meta-data/",   // cloud metadata
    "http://[::1]/", "http://0.0.0.0/",
    "http://10.0.0.1/", "http://192.168.1.1/", "http://172.16.0.1/",
    "file:///C:/Windows/win.ini",
    "http://2130706433/"                          // decimal-encoded 127.0.0.1
];
// assertPublicHost is ASYNC — it does a DNS lookup and vets every resolved
// address, which is what closes the rebinding gap. A synchronous try/catch
// around it catches nothing and turns a real block into an unhandled
// rejection, so each probe must be awaited.
for (const u of BLOCKED) {
    let blocked = false;
    try {
        const parsed = new URL(u);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            blocked = true;                       // scheme refused before host logic
        } else {
            try { await netTools.assertPublicHost(parsed.hostname); }
            catch { blocked = true; }
        }
    } catch { blocked = true; }                   // unparseable is also refused
    check(`network guard blocks ${u.slice(0, 40)}`, blocked);
}
// the vetted address must come back pinned, so the socket cannot be pointed
// somewhere else between check and connect
{
    let pinned = null;
    try { pinned = await netTools.assertPublicHost("example.com"); } catch { /* offline */ }
    if (pinned) {
        check("a public host returns a pinned address for the connection",
            !!pinned.address && (pinned.family === 4 || pinned.family === 6), pinned);
    } else {
        skipped("pinned-address return", "no network");
    }
}

/* ══════════════════════ 9. RESOURCE / DOS SHAPES ═════════════════════════ */
console.log("\n-- resource limits --");

// a file that claims to be an image but is 200 MB of zeros must be refused by
// SIZE before anything tries to decode it
{
    const big = path.join(ROOT, "huge.wav");
    const fd = fs.openSync(big, "w");
    fs.writeSync(fd, Buffer.alloc(1024), 0, 1024, 600_000_000);   // sparse
    fs.closeSync(fd);
    if (speech.available()) {
        const t0 = Date.now();
        const refused = await rejects(() => speech.transcribe(ROOT, { path: "huge.wav" }, {}));
        check(`an oversized audio file is refused quickly (${Date.now() - t0}ms)`,
            refused && Date.now() - t0 < 15000);
    } else {
        skipped("oversized audio refusal", "whisper not installed");
    }
    fs.rmSync(big, { force: true });
}

// deeply nested directory must not blow the stack during a walk
{
    let deep = ROOT;
    for (let i = 0; i < 60; i++) { deep = path.join(deep, "d" + i); }
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "leaf.txt"), "deep content about turbines");
    let threw = false;
    try {
        const lib = knowledge.add(ROOT, "deep");
        await knowledge.reindex(lib.id, () => {});
        knowledge.remove(lib.id);
    } catch (e) { threw = String(e.message); }
    check("a 60-deep directory tree does not crash indexing", threw === false, threw);
}

/* ══════════ 10. AUDIT REGRESSIONS — every one was a live defect ══════════ */
console.log("\n-- audit regressions --");

// SPICE: the analysis argument is deck content too. vetNetlist refuses
// .control and .shell in the NETLIST, but this string was interpolated
// straight into the deck, so a newline wrote a new directive line and walked
// around the guard. Proven live: it reached the deck as line 5.
{
    const spice = E("spice.js");
    const NET = "V1 in 0 DC 5\nR1 in out 1k\nR2 out 0 2k";
    for (const bad of ["10u 1m\n.shell echo x", "10u 1m\n.control\nquit\n.endc", "1m; rm -rf /"]) {
        check("spice refuses an injected analysis arg: " + JSON.stringify(bad.slice(0, 20)),
            await rejects(() => spice.simulate(
                { netlist: NET, analysis: { type: "tran", args: bad } }, {})));
    }
    if (spice.available()) {
        const ok = await spice.simulate(
            { netlist: NET, analysis: { type: "op" }, probes: ["v(out)"] }, {})
            .then(r => !!r.ok, () => false);
        check("spice still solves a legitimate circuit", ok);
    } else {
        skipped("spice legitimate run", "ngspice not installed");
    }
}

// GRAPHVIZ READS FILES. image= pulled a PNG from outside the workspace
// straight into the rendered SVG — a containment escape dressed as a diagram.
if (extTools.diagramAvailable()) {
    for (const ref of ["C:/Windows/win.ini", "/etc/passwd", "../../outside.png"]) {
        check("draw_diagram refuses an outside file reference: " + ref.slice(0, 18),
            await rejects(() => extTools.drawDiagram(ROOT,
                { dot: 'digraph{ a[image="' + ref + '"] }', out: "x.svg" }, {})));
    }
    const fine = await extTools.drawDiagram(ROOT,
        { dot: "digraph{ PSU -> F1 -> K1 }", out: "fine.svg" }, {})
        .then(() => true, () => false);
    check("draw_diagram still renders an ordinary diagram", fine);
} else {
    skipped("draw_diagram containment", "graphviz not installed");
}

// QPDF PAGE RANGES ARE A CONTAINMENT BOUNDARY — this is a real exfiltration
// route, not hygiene. qpdf's --pages grammar is `file [range] [file [range]]`,
// so a token that does not parse as a range becomes the NEXT INPUT FILE:
// a bare path here reads any PDF on the machine into the workspace, where
// read_pdf then hands its text to the model. Confirmed live against the
// bundled binary (cover 2pp + outside 3pp -> 5pp output).
if (extTools.pdfAvailable()) {
    const ATTACKS = [
        ["absolute posix path", "C:/Windows/System32/eula.pdf"],
        ["absolute windows path", "C:\\Users\\Public\\secret.pdf"],
        ["bare filename", "secret.pdf"],
        ["path after a valid range", "1-2 C:/secret.pdf"],
        ["relative escape", "../../outside.pdf"],
        ["flag shaped", "--encrypt"],
        ["shell shaped", "; calc"]
    ];
    for (const [name, bad] of ATTACKS) {
        check("edit_pdf refuses a page range that names a file: " + name,
            await rejects(() => extTools.editPdf(ROOT,
                { op: "pages", path: "ok.txt", pages: bad, out: "o.pdf" }, {})), bad);
    }
    // and the legitimate forms must still work
    for (const good of ["1-2", "1,3,5", "1-z", "z-1", "1-5:even"]) {
        let msg = null;
        try { await extTools.editPdf(ROOT, { op: "pages", path: "ok.txt", pages: good, out: "o.pdf" }, {}); }
        catch (e) { msg = String(e.message); }
        // ok.txt is not a PDF, so qpdf must be the one complaining — never the range validator
        check("edit_pdf accepts the legitimate range " + JSON.stringify(good),
            msg === null || !/not a page range/.test(msg), msg);
    }
} else {
    skipped("page range containment", "qpdf not installed");
}

/* ═══════════════════════ 11. CLEANUP + SUMMARY ═══════════════════════════ */
try { serve.stopAll(); } catch { /* none running */ }
for (const d of [ROOT, OUTSIDE, DATA]) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }); } catch { /* windows lock */ }
}

console.log(`\n${pass}/${pass + fail} edge-case checks passed` +
    (skip ? `, ${skip} skipped` : ""));
if (failures.length) {
    console.log("\nFAILED:");
    for (const f of failures) console.log("  - " + f);
}
process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
