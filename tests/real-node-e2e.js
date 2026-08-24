/**
 * THE REMOTE PATH, WITH A REAL MODEL. The other half of tests/real-model-e2e.js.
 *
 * A model on a machine of the user's own does NOT go through engine.js. It
 * goes through cloudModels.streamChat, over HTTP, and that path had no
 * context-overflow handling at all — it read `context_length` out of model
 * metadata and then never looked at the error the far side sent back.
 *
 * MEASURED against a real model behind a real endpoint, before the fix:
 *   bench-node returned 400: request (6432 tokens) exceeds the available
 *   context size (2048 tokens), try increasing it        ...THROWN
 * and after:
 *   ANSWERED -> "Hello! How can I assist you today?"     ...1.5 s, dropped 118
 *
 * WHERE IT RUNS, STATED EXACTLY. This does NOT contact the operator's node. It
 * stands up the bundled llama-server on loopback and drives cloudModels at it,
 * because that server speaks the same OpenAI-compatible protocol a node serves
 * — so the CODE PATH is the real one, with a real model, while the hardware is
 * not. That distinction is the whole reason this file exists: the previous
 * build was called ready on the strength of code being present rather than
 * running, and this must not repeat the trick one level down by implying it
 * tested a machine it never touched.
 *
 * What it therefore proves: cloudModels.streamChat re-fits an over-long
 * conversation and answers. What it does not prove: that any particular node is
 * reachable, correctly configured, or using its GPU. Those need the machine.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MODEL = path.join(ROOT, "models", "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf");
const SERVER = path.join(ROOT, "runtimes", "llama.cpp", "win-x64", "llama-server.exe");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

/* The overflow rule itself is pure and always testable, model or no model. */
const contextFit = require(path.join(ROOT, ".lcl.engine", "core", "contextFit.js"));
{
    const over = contextFit.overflowFrom(
        'request (6432 tokens) exceeds the available context size (2048 tokens)');
    check("the far side's own numbers are read out of its refusal, not estimated",
        over && over.promptTokens === 6432 && over.windowTokens === 2048, over);

    check("...and the JSON shape some builds send instead is read too",
        (() => { const o = contextFit.overflowFrom(
            '{"type":"exceed_context_size_error","n_prompt_tokens":9000,"n_ctx":4096}');
            return o && o.promptTokens === 9000 && o.windowTokens === 4096; })());

    check("an ordinary error is NOT mistaken for an overflow",
        contextFit.overflowFrom("connection refused") === null &&
        contextFit.overflowFrom("") === null);

    const msgs = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 40; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: "m" + i });
    const t = contextFit.trimForWindow(msgs, { promptTokens: 6432, windowTokens: 2048 });
    check("THE SYSTEM MESSAGE IS NEVER DROPPED — it is the instructions",
        t && t.messages[0].role === "system" && t.messages[0].content === "sys");
    check("...and the newest exchange is never dropped — it is what was just asked",
        t && t.messages[t.messages.length - 1].content === "m39");
    check("...and it lands WELL INSIDE the window rather than against its wall, " +
          "because a just-fits prompt still has to be read before the first " +
          "token and leaves no room for the reply",
        t && t.dropped > 20, t && { kept: t.messages.length, dropped: t.dropped });
    check("a conversation too short to shed reports so instead of looping",
        contextFit.trimForWindow([{ role: "user", content: "hi" }], null) === null);
}

if (!fs.existsSync(MODEL) || !fs.existsSync(SERVER)) {
    console.log("\n-- live half skipped: model or llama-server not fetched here --");
    console.log(`\n${pass}/${pass + fail} real-node checks passed`);
    process.exit(fail ? 1 : 0);
}

/* ---------------------------------------------------------- the live half */
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
    if (r === "electron") return __filename;
    return orig.call(this, r, ...a);
};
process.getSystemMemoryInfo = () => ({
    total: Math.round(os.totalmem() / 1024), free: Math.round(os.freemem() / 1024),
    swapTotal: 0, swapFree: 0
});
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-node-e2e-"));
process.env.LCL_DATA_DIR = DATA;
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

const cloud = require(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"));
const paths = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));

const PORT = 8099;
const CTX = 2048;            // small on purpose: the overflow is the subject

function serving(port, ms = 180000) {
    const until = Date.now() + ms;
    return new Promise((resolve) => {
        const tick = () => {
            if (Date.now() > until) return resolve(false);
            http.get(`http://127.0.0.1:${port}/health`, (res) => {
                let b = ""; res.on("data", d => b += d);
                res.on("end", () => (res.statusCode === 200 && !/Loading/i.test(b))
                    ? resolve(true) : setTimeout(tick, 800));
            }).on("error", () => setTimeout(tick, 800));
        };
        tick();
    });
}

(async () => {
    paths.writeSettings({ networkEnabled: true });
    const srv = spawn(SERVER, ["-m", MODEL, "--port", String(PORT), "-c", String(CTX),
                               "--host", "127.0.0.1", "-t", "4"], { stdio: "ignore" });
    const up = await serving(PORT);
    check("(setup) a node-shaped endpoint is serving a real model", up);

    if (up) {
        cloud.linkEndpoint({
            id: "e2e-node", label: "bench-node", baseUrl: `http://127.0.0.1:${PORT}`,
            key: "none", models: [{ id: "qwen" }], localNode: true,
            node: { id: "n-e2e", name: "bench-node", host: "127.0.0.1", port: PORT,
                    memBytes: 34e9 }
        });

        /* Darkroom notes, so the fixture carries nothing personal. */
        const history = [];
        while (JSON.stringify(history).length < 40000) {
            history.push({ role: "user", content: "how long in the stop bath at 20C, and why" });
            history.push({ role: "assistant",
                           content: "Thirty seconds with continuous agitation. ".repeat(12) });
        }

        const selection = { id: "e2e-node", model: "qwen", label: "bench-node",
                            baseUrl: `http://127.0.0.1:${PORT}`, preset: "custom",
                            localNode: true, node: { id: "n-e2e", memBytes: 34e9 } };

        const t0 = Date.now();
        let text = "", threw = null, res = null;
        try {
            res = await cloud.streamChat([...history, { role: "user", content: "hello" }],
                { selection, maxTokens: 48, onOutput: (t) => { text += t; } });
            if (!text) text = String((res && res.output) || "");
        } catch (e) { threw = String(e.message || e); }
        const took = Date.now() - t0;

        check("A CONVERSATION ON A MACHINE OF YOUR OWN STILL ANSWERS ONCE ITS " +
              "HISTORY OUTGROWS THE WINDOW. This path threw a 400 and killed the " +
              "session outright, and nothing in this directory could see it",
            !threw && text.trim().length > 0, { threw, took, text: text.slice(0, 120) });

        check("...and it says what it had to leave out, rather than quietly " +
              "losing the start of the conversation",
            res && res.trimmed === true && res.dropped > 0,
            res && { trimmed: res.trimmed, dropped: res.dropped });

        check("...and it is a real reply, not an error surfaced as prose",
            text.trim().length > 0 && !/exceeds|context size|error/i.test(text), text.slice(0, 140));

        console.log(`\n   measured: answered in ${took}ms, dropped ` +
                    `${res && res.dropped} of ${history.length} earlier messages`);
        console.log(`   answer: ${JSON.stringify(text.trim().slice(0, 120))}`);
    }

    try { srv.kill(); } catch { /* already gone */ }
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 6 }); } catch { /* held */ }
    console.log(`\n${pass}/${pass + fail} real-node checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
