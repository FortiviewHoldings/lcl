/**
 * The critic's DETERMINISTIC gate — the cheap, reliable half that catches the
 * common step failures without a model call. (The model critique defaults to
 * PASS and is exercised live.) These prove the gate rejects stubs/empties and
 * accepts real files, and that a retry overwrite keeps the change list clean.
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
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
// ISOLATED per run: paths.js derives the data directory from this,
// so a shared os.tmpdir() made every suite inherit whatever settings
// an earlier suite had written — an order-dependent gate that failed
// builds at random.
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

// stub the model so critiqueStep's model half is deterministic in this test:
// make engine.generate return PASS, so ONLY the deterministic gate decides.
const engine = require(__dirname + "/../.lcl.engine/core/engine.js");
engine.generate = async () => ({ content: "PASS" });

const orch = require(__dirname + "/../.lcl.engine/core/orchestrator.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail) : ""); }
}

(async () => {
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-crit-"));
    const session = { repoPath: WS };
    const write = (p, c) => { fs.writeFileSync(path.join(WS, p), c); return [{ path: p, kind: "created" }]; };

    // expectsFile classification
    check("expectsFile: 'Write index.html: ...' true",
        orch.expectsFile({ action: "Write index.html: a landing page" }) === true);
    check("expectsFile: 'Explain the plan' false",
        orch.expectsFile({ action: "Explain what you will do" }) === false);

    // a step that should write a file but produced nothing -> FAIL
    let c = await orch.critiqueStep(session, { action: "Write index.html: a page" }, []);
    check("no-file-when-expected fails", c.pass === false && /no file/.test(c.problem), c);

    // a real, substantive HTML file -> PASS (a realistic page is well over 180 chars)
    const good = write("index.html",
        "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>.lcl — local AI workbench</title>\n  <link rel=\"stylesheet\" href=\"styles.css\">\n</head>\n<body>\n  <header><h1>.lcl</h1><p class=\"tag\">A local AI agent that runs fully offline on your own machine.</p></header>\n  <main>\n    <section><h2>Private</h2><p>No cloud calls. Your files never leave the device.</p></section>\n    <section><h2>Capable</h2><p>Reads and edits real files, generates images, and more.</p></section>\n  </main>\n  <footer><p>Built with .lcl</p></footer>\n</body>\n</html>");
    c = await orch.critiqueStep(session, { action: "Write index.html: a landing page" }, good);
    check("real HTML passes the gate", c.pass === true, c);

    // an empty HTML skeleton (tags, no words) -> FAIL (the one deterministic check)
    const skel = write("skel.html", "<!doctype html><html><head></head><body></body></html>");
    c = await orch.critiqueStep(session, { action: "Write skel.html: a full page" }, skel);
    check("empty HTML skeleton fails", c.pass === false && /no visible content/.test(c.problem), c);

    // --- the review's FALSE-POSITIVE cases: legitimate output must PASS ---
    const reset = write("reset.css", "*{margin:0;padding:0;box-sizing:border-box}");
    c = await orch.critiqueStep(session, { action: "Write reset.css: a CSS reset" }, reset);
    check("43-char valid CSS reset passes (no length floor)", c.pass === true, c);

    const cfg = write("config.json", '{"port":3000}');
    c = await orch.critiqueStep(session, { action: "Write config.json" }, cfg);
    check("13-char valid JSON passes", c.pass === true, c);

    const njk = write(".nojekyll", "");
    c = await orch.critiqueStep(session, { action: "Add a .nojekyll file" }, njk);
    check("empty .nojekyll passes (tiny-by-design)", c.pass === true, c);

    const form = write("form.html", "<!doctype html><html><body><h1>Contact us</h1><form><input placeholder=\"Your name here\"><button>Send</button></form></body></html>");
    c = await orch.critiqueStep(session, { action: "Write form.html with a contact form" }, form);
    check("input placeholder='Your name here' is NOT flagged as a stub", c.pass === true, c);

    const soon = write("soon.html", "<!doctype html><html><body><h1>Coming Soon</h1><p>Our new product launches this spring. Sign up below to be notified when we go live.</p></body></html>");
    c = await orch.critiqueStep(session, { action: "Write soon.html: a coming-soon page" }, soon);
    check("a real 'Coming Soon' page passes", c.pass === true, c);

    // binary output (a PNG) must NOT be read as text / critiqued
    fs.writeFileSync(path.join(WS, "hero.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0xff, 0xfe]));
    c = await orch.critiqueStep(session, { action: "generate_image hero.png" }, [{ path: "hero.png", kind: "created" }]);
    check("binary image passes without being decoded", c.pass === true, c);

    // a non-file step (no file expected, no changes) -> PASS
    c = await orch.critiqueStep(session, { action: "Summarize the result for the user" }, []);
    check("non-file step passes with no changes", c.pass === true, c);

    // expectsFile now includes edit verbs (a no-op edit step is a failure)
    check("expectsFile: 'Update index.html nav' true",
        orch.expectsFile({ action: "Update the nav in index.html" }) === true);

    // model-critique path: when deterministic gate passes, a FAIL verdict
    // from the model is honored
    engine.generate = async () => ({ content: "FAIL: the page has no navigation as the step required" });
    c = await orch.critiqueStep(session, { action: "Write index.html with navigation" }, good);
    check("model critique FAIL is honored", c.pass === false && /navigation/.test(c.problem), c);
    // ...and an unclear/PASS verdict does not block
    engine.generate = async () => ({ content: "Looks fine to me" });
    c = await orch.critiqueStep(session, { action: "Write index.html" }, good);
    check("non-FAIL model verdict passes (no false block)", c.pass === true, c);
    // FAIL parser robustness (review #5/#6):
    engine.generate = async () => ({ content: "FAILURE: none, the page looks complete" });
    c = await orch.critiqueStep(session, { action: "Write index.html" }, good);
    check("'FAILURE: none' is NOT read as a fail", c.pass === true, c);
    engine.generate = async () => ({ content: "This does not FAIL any requirement." });
    c = await orch.critiqueStep(session, { action: "Write index.html" }, good);
    check("'does not FAIL' mid-sentence is NOT a fail", c.pass === true, c);
    engine.generate = async () => ({ content: "FAIL" });
    c = await orch.critiqueStep(session, { action: "Write index.html" }, good);
    check("bare 'FAIL' (no reason) IS a fail", c.pass === false && c.problem, c);
    // model error -> default PASS (never a bottleneck)
    engine.generate = async () => ({ error: "engine down" });
    c = await orch.critiqueStep(session, { action: "Write index.html" }, good);
    check("model error defaults to PASS", c.pass === true, c);

    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} critic-gate checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
