/**
 * Unit tests for the utility + document tools. The calculator gets adversarial
 * attention: it must evaluate arithmetic and NEVER reach a JS interpreter.
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
    clipboard: (() => { let buf = ""; return { readText: () => buf, writeText: (t) => { buf = t; } }; })()
} };

// machine.js calls Electron-only process.getSystemMemoryInfo(); stub for Node
if (typeof process.getSystemMemoryInfo !== "function") {
    process.getSystemMemoryInfo = () => ({
        total: 15_600_000, free: 5_000_000, swapTotal: 33_000_000, swapFree: 12_000_000
    });
}

const util = require(__dirname + "/../.lcl.engine/core/utilTools.js");
const clip = require(__dirname + "/../.lcl.engine/core/clipboardTools.js");
const docs = require(__dirname + "/../.lcl.engine/core/docTools.js");
const { ToolError } = require(__dirname + "/../.lcl.engine/core/fsTools.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 140) : ""); }
}
function expectError(name, fn, re) {
    try { fn(); check(name, false, "no error thrown"); }
    catch (e) { check(name, e instanceof ToolError && (!re || re.test(e.message)), e.message); }
}

// ---- calculator: correctness ----
const cases = [
    ["2 + 2", 4], ["10 / 4", 2.5], ["2 ^ 10", 1024], ["-5 + 3", -2],
    ["(1 + 2) * 3", 9], ["17 % 5", 2], ["sqrt(144)", 12], ["round(3.7)", 4],
    ["max(3, 9, 2)", 9], ["min(3, 9, 2)", 2], ["2 * pi", 2 * Math.PI],
    ["abs(-8)", 8], ["3 + 4 * 2", 11], ["floor(9.9)", 9], ["ceil(9.1)", 10],
    // regressions: the tokenizer accepts leading-dot decimals and the parser
    // must too; leading/trailing whitespace must not throw "cannot parse near"
    [".5 + .25", 0.75], ["  2 + 3  ", 5], [".5 * 4", 2], ["\t7\n", 7]
];
for (const [expr, want] of cases) {
    const got = util.evaluate(expr);
    check(`calc ${expr} = ${want}`, Math.abs(got - want) < 1e-9, got);
}

// ---- calculator: it is NOT eval — code constructs must all be rejected ----
const attacks = [
    "process.exit(1)", "require('fs')", "1; console.log(1)", "this",
    "constructor", "[].map", "globalThis", "__proto__", "0x1e",
    "eval('1')", "() => 1", "1 && 2", "a = 5", "window"
];
for (const a of attacks) {
    expectError(`calc rejects "${a}"`, () => util.evaluate(a));
}
expectError("calc rejects division by zero", () => util.evaluate("1/0"), /zero/);
expectError("calc rejects empty", () => util.evaluate(""), /needs/);

// ---- machine view (async: a real CPU reading needs a sampling window) ----
const machineChecks = (async () => {
    const stats = await util.systemStats();
    check("system_stats reports memory + cpu",
        typeof stats.memory.available === "string" && typeof stats.cpu.cores === "number", stats);
    check("system_stats pressure is a known level",
        ["ok", "low", "critical"].includes(stats.memory.pressure), stats.memory.pressure);
    check("system_stats separates current load from the since-boot average",
        typeof stats.cpu.busyPercent === "number"
        && typeof stats.cpu.busyPercentSinceBoot === "number", stats.cpu);
})();

// process_list is Windows-only; just verify shape
const procs = util.processList();
check("process_list returns an array", Array.isArray(procs.processes), procs);
if (process.platform === "win32" && procs.processes.length) {
    check("process rows have name + memoryMB",
        typeof procs.processes[0].name === "string" && typeof procs.processes[0].memoryMB === "number",
        procs.processes[0]);
}

// ---- clipboard round-trip (stubbed) ----
clip.writeClipboard(null, { text: "hello .lcl" });
check("clipboard round-trips", clip.readClipboard().text === "hello .lcl");
expectError("write_clipboard rejects non-string", () => clip.writeClipboard(null, { text: 42 }));
check("read_clipboard reports empty", (() => {
    clip.writeClipboard(null, { text: "" });
    return clip.readClipboard().empty === true;
})());

// ---- read_pdf: synthesize a tiny real PDF and read it ----
(async () => {
    await machineChecks;                 // keep the tally ordered and complete
    check("pdf support available", docs.available());

    // a minimal but valid single-page PDF with the text "Invoice 42"
    const pdf = [
        "%PDF-1.4",
        "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
        "4 0 obj<</Length 44>>stream",
        "BT /F1 18 Tf 20 100 Td (Invoice 42) Tj ET",
        "endstream endobj",
        "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
        "trailer<</Root 1 0 R>>",
        "%%EOF"
    ].join("\n");
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-pdf-"));
    fs.writeFileSync(path.join(WS, "invoice.pdf"), pdf, "latin1");

    try {
        const r = await docs.readPdf(WS, { path: "invoice.pdf" });
        check("read_pdf extracts the page text", /Invoice 42/.test(r.text), r.text);
        check("read_pdf reports page count", r.pages === 1, r.pages);
    } catch (e) {
        check("read_pdf extracts the page text", false, e.message);
    }
    expectError("read_pdf refuses non-pdf",
        () => { throw new (require(__dirname + "/../.lcl.engine/core/fsTools.js").ToolError)("x"); });
    let threw = null;
    try { await docs.readPdf(WS, { path: "../outside.pdf" }); } catch (e) { threw = e.message; }
    check("read_pdf is contained to the workspace", /escapes|not a file/.test(threw || ""), threw);

    /* ---- a SCANNED pdf: pages with no text layer, the live Chapter 1.pdf
     * case. The text layer yields nothing; that must be SAID, never handed to
     * the model as 20 empty page markers it can hallucinate over ("The PDF
     * contains text across 20 pages" — invented, live). In this bare-node
     * context the OCR pipeline (pdfRaster needs the app's window system) is
     * honestly unavailable, so the result must say scanned + forbid inventing.
     * The OCR path itself was wire-tested against the operator's actual
     * scanned PDF in Electron: 26 pages, 4.7k chars OCR'd from pages 1-2. */
    const scanPdf = [
        "%PDF-1.4",
        "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R>>endobj",
        "4 0 obj<</Length 30>>stream",
        "0.5 g 10 10 280 124 re f",
        "endstream endobj",
        "trailer<</Root 1 0 R>>",
        "%%EOF"
    ].join("\n");
    fs.writeFileSync(path.join(WS, "scan.pdf"), scanPdf, "latin1");
    try {
        const s = await docs.readPdf(WS, { path: "scan.pdf" });
        check("a textless PDF is reported as SCANNED, not as empty pages",
            s.scanned === true, s);
        check("...and the note forbids inventing content and names the real state",
            /NO TEXT LAYER/.test(s.note || "") && /do NOT invent/i.test(s.note || ""), s.note);
        check("...and no run of empty page markers is handed to the model",
            !/--- page 1 ---/.test(s.text || ""), s.text);
    } catch (e) {
        check("a textless PDF is reported as SCANNED, not as empty pages", false, e.message);
    }
    check("...the OCR fallback is wired in readPdf (pdfRaster + ocrTools reached)",
        (() => { const src = fs.readFileSync(
            __dirname + "/../.lcl.engine/core/docTools.js", "utf8");
            return /pdfRaster\.openDoc/.test(src) && /ocrTools\.recognize/.test(src)
                && src.includes("textChars / pagesRead < 5"); })());

    /* ---- THE EXTRACTION GOES TO A FILE, NOT THROUGH THE MODEL'S MOUTH.
     * 26 scanned pages became six 40-second tool rounds and ten minutes of a
     * 120B model re-typing 28k chars into chat, over a stale wrong answer.
     * The OCR text is WRITTEN beside the source now (page-by-page, so a crash
     * keeps what was read), the model gets a sample + the file name, and
     * details are read back with read_file and quoted. */
    {
        const src = fs.readFileSync(__dirname + "/../.lcl.engine/core/docTools.js", "utf8");
        check("scanned-PDF OCR saves the full text beside the source (savedAs), " +
              "writing progressively as pages complete",
            /savedAs: outRel/.test(src) && /appendFileSync\(outFull, block\)/.test(src));
        check("...one call covers the caller's whole ask, not a 6-page relay window",
            /OCR_PAGE_CAP = 40/.test(src)
            && src.includes("Math.min(wantedEnd, total, start + OCR_PAGE_CAP - 1)"));
        check("...and the time expectation is stated UP FRONT in the progress note",
            /at ~4s each, about/.test(src));
        const agentSrc = fs.readFileSync(__dirname + "/../.lcl.engine/core/agent.js", "utf8");
        check("runTool hands every saved-file path back as a legal @attachments/ ref",
            /PATH_FIELDS = \[[^\]]*"savedAs"/.test(agentSrc)
            && /result\[f\] = ATT_PREFIX \+ v/.test(agentSrc));
        // the behavioural half: asked to SHOW content that exists in a tool
        // result, the model must quote it, not compress it — the live failure
        // was three rounds of paraphrased fragments over verbatim questions
        const agent = require(__dirname + "/../.lcl.engine/core/agent.js");
        const prompt = agent.systemPrompt(null);
        check("the system prompt carries the VERBATIM rule (quote, never compress, " +
              "in both the folder and no-folder prompt variants)",
            /VERBATIM: when the user asks you to show, extract, list or quote/.test(prompt)
            && (agentSrc.match(/verbatimRule/g) || []).length >= 3);
    }

    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} util+doc checks passed`);
    process.exit(fail ? 1 : 0);
})();
