/**
 * REASONING EFFORT REACHES THE WIRE — the slider is not a no-op.
 *
 * The design notes flagged this as status-unverified — do not assert it works.
 * This proves it end to end against a loopback server that captures the actual
 * request body: the session's effortLevel (0-4) maps to the OpenAI-style
 * reasoning_effort word and is sent to a capable node, and an Ollama-shaped
 * endpoint (which rejects unknown body fields) correctly gets NO such field.
 *
 * streamChat keeps its socket open past the first response on this minimal
 * stub, so each call is raced against a short timeout — but the body is
 * captured synchronously when the POST ends, BEFORE any timeout, so the
 * assertion is deterministic regardless of what streamChat does afterward.
 */
const M = require("module");
const orig = M._resolveFilename;
M._resolveFilename = function (q, ...r) { if (q === "electron") return __filename; return orig.call(this, q, ...r); };
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-rew-"));
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
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 200) : ""); }
}

let captured = null;
const srv = http.createServer((req, res) => {
    if (req.method === "POST") {
        let b = ""; req.on("data", d => b += d); req.on("end", () => {
            try { captured = JSON.parse(b); } catch { }
            res.setHeader("content-type", "text/event-stream");
            res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "\n\n");
            res.write("data: [DONE]\n\n"); res.end();
        });
    } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "gpt-oss-120b" }], models: [] }));
    }
});
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r("t"), ms))]);

(async () => {
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const mk = (shape) => ({ id: "n-" + shape, label: shape,
        baseUrl: "http://127.0.0.1:" + port, model: "gpt-oss-120b",
        shape, localNode: true, apiPrefix: "/v1" });

    for (const [lvl, word] of [[1, "low"], [2, "medium"], [3, "high"]]) {
        captured = null;
        await withTimeout(cloud.streamChat([{ role: "user", content: "hi" }],
            { selection: mk("openai"), session: { id: "s", effortLevel: lvl } }), 5000);
        check(`effortLevel ${lvl} sends reasoning_effort "${word}" to a capable node`,
            captured && captured.reasoning_effort === word,
            captured && captured.reasoning_effort);
    }

    // DOC-GROUNDED: "max"/"xhigh" are OpenRouter-only enums; DeepInfra/OpenCode
    // canonical is low|medium|high. effortLevel 4 → "max" must clamp to "high"
    // off OpenRouter (this stub is 127.0.0.1, not openrouter.ai).
    captured = null;
    await withTimeout(cloud.streamChat([{ role: "user", content: "hi" }],
        { selection: mk("openai"), session: { id: "s", effortLevel: 4 } }), 5000);
    check("effortLevel 4 (\"max\") clamps to \"high\" on a non-OpenRouter endpoint",
        captured && captured.reasoning_effort === "high", captured && captured.reasoning_effort);

    captured = null;
    await withTimeout(cloud.streamChat([{ role: "user", content: "hi" }],
        { selection: mk("ollama"), session: { id: "s", effortLevel: 2 } }), 5000);
    check("an Ollama-shaped endpoint gets NO reasoning_effort field (it would reject it)",
        !!captured && !("reasoning_effort" in captured));

    // and with no effort set, no field is forced
    captured = null;
    await withTimeout(cloud.streamChat([{ role: "user", content: "hi" }],
        { selection: mk("openai"), session: { id: "s" } }), 5000);
    check("no effortLevel on the session sends no reasoning_effort at all",
        !!captured && !("reasoning_effort" in captured));

    // REASONING NEEDS HEADROOM — measured: gpt-5.x-codex under a small cap
    // returns an EMPTY completion because the hidden reasoning eats the whole
    // budget. When effort is sent to a HOSTED endpoint the cap floors at 8192.
    captured = null;
    await withTimeout(cloud.streamChat([{ role: "user", content: "hi" }],
        { selection: { ...mk("openai"), localNode: false },
          session: { id: "s", effortLevel: 2 }, maxTokens: 2048 }), 5000);
    check("effort sent to a HOSTED endpoint floors max_tokens at 8192 (reasoning headroom)",
        captured && captured.max_tokens === 8192, captured && captured.max_tokens);
    // ...and a linked NODE now floors too. This used to keep the
    // caller's 2048 cap, which was exactly the bug: gpt-oss on the node reasons
    // by default (medium) EVEN WITH no reasoning_effort sent, so a small cap was
    // consumed inside the chain of thought and the visible answer came back
    // empty — the "spent its whole reply thinking" flood in the node logs.
    // max_tokens is n_predict (a generation ceiling, not a preallocation; KV is
    // governed by num_ctx), so flooring it costs the node no memory.
    captured = null;
    await withTimeout(cloud.streamChat([{ role: "user", content: "hi" }],
        { selection: mk("openai"), session: { id: "s", effortLevel: 2 }, maxTokens: 2048 }), 5000);
    check("a localNode ALSO floors max_tokens at 8192 (reasoning headroom)",
        captured && captured.max_tokens === 8192, captured && captured.max_tokens);
    // ...even with NO effort on the session, because a node reasoner still needs
    // the headroom (effortOut is false here, yet gpt-oss reasons regardless)
    captured = null;
    await withTimeout(cloud.streamChat([{ role: "user", content: "hi" }],
        { selection: mk("openai"), session: { id: "s" }, maxTokens: 2048 }), 5000);
    check("a localNode floors max_tokens even with no effort sent",
        captured && captured.max_tokens === 8192, captured && captured.max_tokens);
    // ...and without effort, no floor is applied anywhere
    captured = null;
    await withTimeout(cloud.streamChat([{ role: "user", content: "hi" }],
        { selection: { ...mk("openai"), localNode: false }, session: { id: "s" }, maxTokens: 512 }), 5000);
    check("...and with no effort sent, the cap rides through untouched",
        captured && captured.max_tokens === 512, captured && captured.max_tokens);

    srv.close();
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* temp */ }
    console.log(`\n${pass}/${pass + fail} reasoning-effort-wire checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
