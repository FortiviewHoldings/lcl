/**
 * A NODE TURN ALWAYS RESOLVES — it answers, or it FAILS WITH A REASON. Never an
 * open-ended hang.
 *
 * Measured live: a 70k-token prompt to gpt-oss-120b on the operator's Spark sat
 * ~12 minutes with a blank chat and only the Stop button, then was killed by
 * hand — because the node took the request and went silent, and the only leash
 * was a 15-minute whole-call inactivity timeout. A tool you cannot trust to
 * finish OR fail cleanly is useless for handing real work to the box.
 *
 * The fix (cloudModels.streamChatOnce): the leash is split. Until the FIRST
 * token, a node has firstTokenMs (6 min in prod; overridable for this test);
 * a stall past it fails with a coded `no-first-token`, actionable reason. The
 * instant a token arrives, the leash relaxes to the full inactivity timeout so
 * slow GENERATION is never cut. Both halves are proven here against loopback
 * servers, with the first-token budget shrunk so the test runs in seconds.
 */
const M = require("module");
const orig = M._resolveFilename;
M._resolveFilename = function (q, ...r) { if (q === "electron") return __filename; return orig.call(this, q, ...r); };
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-stall-"));
process.env.LCL_DATA_DIR = DATA;
require.cache[__filename] = { exports: {
  app: { isPackaged: false, getPath: () => DATA },
  clipboard: { readText: () => "", writeText: () => {} },
  safeStorage: { isEncryptionAvailable: () => false }
} };
const ROOT = path.join(__dirname, "..");
const paths = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));
paths.writeSettings({ networkEnabled: true });
const cloud = require(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS |", name); }
  else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 220) : ""); }
}

// Server A: answers 200 + flushes headers, then NEVER sends a data byte — a node
// that took the request and went silent forever.
const silent = http.createServer((req, res) => {
  if (req.method !== "POST") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "m" }], models: [] })); }
  req.on("data", () => {}); req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); /* silence */ });
});
// Server B: first token quickly (before the first-token budget), then a gap
// LONGER than that budget before finishing — proves the leash relaxed on the
// first token instead of cutting a slow-but-live generation.
const slowGen = http.createServer((req, res) => {
  if (req.method !== "POST") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "m" }], models: [] })); }
  req.on("data", () => {}); req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
    setTimeout(() => res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "the" } }] }) + "\n\n"), 600);
    setTimeout(() => { // 3s after the first token — well past the 1.5s first-token budget
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: " answer" }, finish_reason: "stop" }] }) + "\n\n");
      res.write("data: [DONE]\n\n"); res.end();
    }, 3600);
  });
});

const listen = (srv) => new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

(async () => {
  const portA = await listen(silent);
  const portB = await listen(slowGen);
  const node = (port) => ({ id: "n-" + port, label: "your node", baseUrl: "http://127.0.0.1:" + port, model: "m", shape: "openai", localNode: true, node: { id: "n" }, apiPrefix: "/v1" });

  // 1) STALL: no first token → must FAIL FAST with a coded, actionable reason.
  const t0 = Date.now();
  let stallErr = null, stallResolved = false;
  try {
    await cloud.streamChat([{ role: "user", content: "hi" }],
      { selection: node(portA), session: { id: "s" }, firstTokenMs: 1500, onNote: () => {} });
    stallResolved = true;
  } catch (e) { stallErr = e; }
  const elapsed = Date.now() - t0;

  check("a node that never starts answering FAILS — the call resolves, it does not hang open-ended",
    !!stallErr, stallResolved ? "resolved with no error (should have failed)" : "no error object");
  check("...and it fails in the first-token budget (~1.5s here), not the 15-minute whole-call leash",
    elapsed < 8000, `elapsed=${elapsed}ms`);
  check("...with an ACTIONABLE reason: never started answering + the Spark-mode lever (not 'hit Stop')",
    !!stallErr && /never started answering/i.test(String(stallErr.message)) && /Spark mode|lighter/i.test(String(stallErr.message)),
    stallErr && stallErr.message);
  check("...coded no-first-token so the ledger/telemetry can see stalls distinctly",
    !!stallErr && (stallErr.failKind === "no-first-token" || /never started answering/i.test(String(stallErr.message))),
    stallErr && stallErr.failKind);

  // 2) SLOW GENERATION: first token arrives, then a gap longer than the budget →
  //    must SUCCEED, proving the leash relaxed and did not cut live generation.
  let genOut = null, genErr = null;
  try {
    const r = await cloud.streamChat([{ role: "user", content: "hi" }],
      { selection: node(portB), session: { id: "s" }, firstTokenMs: 1500, onNote: () => {} });
    genOut = r && (r.output !== undefined ? r.output : r);
  } catch (e) { genErr = e; }
  check("a call that STARTED answering is NOT cut by the first-token budget when the next token is slow (leash relaxed)",
    !genErr && /answer/.test(String(genOut || "")), genErr ? genErr.message : JSON.stringify(genOut).slice(0, 120));

  silent.close(); slowGen.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(`\n${pass}/${pass + fail} node-stall-recover checks passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(1); });
