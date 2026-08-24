/**
 * BRING YOUR OWN ENDPOINT — the gates, and the stream parser.
 *
 * .lcl ships no key and no account. The user links their own server or their own
 * API key, to whatever model they chose. So the tests that matter are: the key
 * never reaches disk in the clear, never comes back out of the module, nothing
 * goes out with networking off, and a reasoning stream is split correctly even
 * when the tags arrive one character at a time.
 *
 * The endpoint here is a REAL http server standing in for a hosted provider, so
 * the link -> key -> discover -> test -> select -> stream chain is exercised end
 * to end rather than mocked at the seams.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

process.resourcesPath = "C:/.lcl";      // paths.toolsRoot needs it in packaged mode
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-cloud-"));
// No safeStorage under plain node, which exercises the branch that must NEVER
// write a key to disk: session-only, or nothing.
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const { createThinkSplitter } = require(__dirname + "/../.lcl.engine/core/thinkStream.js");
const cloud = require(__dirname + "/../.lcl.engine/core/cloudModels.js");
const guard = require(__dirname + "/../.lcl.engine/core/secretGuard.js");
const paths = require(__dirname + "/../.lcl.engine/core/paths.js");
const agent = require(__dirname + "/../.lcl.engine/core/agent.js");

const io_readSource = () => fs.readFileSync(
    __dirname + "/../.lcl.engine/core/cloudModels.js", "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 220) : ""); }
}

/** Feed a whole response through the splitter in chunks of exactly `size`. */
function split(text, size) {
    let reasoning = "", output = "";
    const s = createThinkSplitter({
        onReasoning: t => reasoning += t,
        onOutput: t => output += t
    });
    for (let i = 0; i < text.length; i += size) s.push(text.slice(i, i + size));
    // end() FIRST, then read: it flushes the held-back suffix through the same
    // handlers, and an object literal would have captured the pre-flush values.
    const end = s.end();
    return { reasoning, output, end };
}

const KEY = "sk-live-test-key-9f3a2b7c1d8e";
let sawAuth = null;

/** A stand-in hosted provider: /v1/models, plus a stream carrying <think>. */
const askedPaths = [];
function server() {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            sawAuth = req.headers.authorization || null;
            askedPaths.push(req.url);
            if (req.url.endsWith("/v1/models")) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ data: [
                    { id: "deepseek-reasoner" }, { id: "deepseek-chat" }] }));
            }
            let body = "";
            req.on("data", c => body += c);
            req.on("end", () => {
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                // the tag is deliberately split across frames
                for (const f of [{ delta: { content: "<th" } },
                                 { delta: { content: "ink>weighing the checksum" } },
                                 { delta: { content: "</thi" } },
                                 { delta: { content: "nk>XOR every byte but the last." } }]) {
                    res.write("data: " + JSON.stringify({ choices: [f] }) + "\n\n");
                }
                res.write("data: " + JSON.stringify({ choices: [{ delta: {} }],
                    usage: { prompt_tokens: 120, completion_tokens: 40 } }) + "\n\n");
                res.write("data: [DONE]\n\n");
                res.end();
            });
        });
        s.listen(0, "127.0.0.1", () => resolve(s));
    });
}

(async () => {
    /* ==================== the <think> splitter ==================== */

    const WIRE = "<think>The user wants a checksum. XOR all but the last byte.</think>" +
                 "def parse(frame):\n    return frame[0]";
    const REASON = "The user wants a checksum. XOR all but the last byte.";
    const ANSWER = "def parse(frame):\n    return frame[0]";

    // THE CASE PER-CHUNK REGEX GETS WRONG: one character at a time, so "<think>"
    // never appears whole inside any single chunk.
    {
        const r = split(WIRE, 1);
        check("one character per chunk: reasoning captured whole", r.reasoning === REASON,
            r.reasoning.slice(0, 60));
        check("one character per chunk: no tag debris in the answer", r.output === ANSWER,
            r.output.slice(0, 60));
    }
    {
        const bad = [];
        for (let size = 1; size <= 40; size++) {
            const r = split(WIRE, size);
            if (r.reasoning !== REASON || r.output !== ANSWER) bad.push(size);
        }
        check("every chunk size 1..40 parses identically", bad.length === 0, bad);
    }
    {
        let reasoning = "", output = "";
        const s = createThinkSplitter({ onReasoning: t => reasoning += t, onOutput: t => output += t });
        for (const c of ["<th", "ink>", "hidden", "</thi", "nk>", "visible"]) s.push(c);
        s.end();
        check("a tag straddling two chunks is recognised",
            reasoning === "hidden" && output === "visible", { reasoning, output });
    }
    {
        const r = split("just a plain answer with no reasoning", 3);
        check("a plain stream is all output",
            r.output === "just a plain answer with no reasoning" && r.reasoning === "");
    }
    {
        const r = split("compare a<b and c>d, plus <thinking> and </thin", 2);
        check("angle brackets that are not tags pass through",
            r.output === "compare a<b and c>d, plus <thinking> and </thin", r.output);
        check("nothing is silently held back at end of stream", r.end.reasoningChars === 0);
    }
    {
        const r = split("<think>I was interrupted mid-", 4);
        check("an unterminated think block reports itself", r.end.unterminated === true);
        check("its text is delivered as reasoning, not lost",
            r.reasoning === "I was interrupted mid-", r.reasoning);
        check("and none of it leaked into the answer", r.output === "", r.output);
    }
    // A stream that begins INSIDE the reasoning: no streaming parser can know
    // retroactively, so the contract is "stop, and say what to move".
    {
        let reasoning = "", output = "", moved = null;
        const s = createThinkSplitter({
            onReasoning: t => reasoning += t,
            onOutput: t => output += t,
            onReclassify: t => {
                moved = t;
                output = output.slice(0, output.length - t.length);
                reasoning = t + reasoning;
            }
        });
        for (const c of ["already think", "ing</thi", "nk>answer"]) s.push(c);
        s.end();
        check("a closing tag with no opener switches to output", output === "answer",
            { output, reasoning });
        check("and the caller is told which text to move", moved === "already thinking", moved);
        check("the tag itself never appears anywhere",
            !/<\/?think>/.test(output + reasoning), { output, reasoning });
        check("the split is reported", s.reclassified === true);
    }
    {
        const r = split("<think>one</think>A<think>two</think>B", 3);
        check("multiple reasoning blocks all route to reasoning", r.reasoning === "onetwo", r.reasoning);
        check("and the answer keeps only its own text", r.output === "AB", r.output);
    }

    /* ============ BRING YOUR OWN ENDPOINT, against a real server ======= */

    const srv = await server();
    const base = `http://127.0.0.1:${srv.address().port}`;
    paths.writeSettings({ networkEnabled: true });

    // nothing is linked until the user links it
    check("no endpoint is preconfigured", cloud.endpoints().length === 0);
    check("and nothing is available", cloud.available() === false);

    // LINK IT — a URL and a pasted key, which is the whole feature
    let linked = cloud.linkEndpoint({
        preset: "custom", label: "my deepseek", baseUrl: base, key: KEY
    });
    check("an endpoint links from a URL plus a pasted key", !!linked.id, linked.id);
    check("the key is registered against it", linked.hasKey === true);
    check("with no OS encryption it is session-only, NOT written to disk",
        linked.keyState.stored === "session" && linked.keyState.encrypted === false,
        linked.keyState);

    // THE KEY MUST NOT BE ON DISK IN THE CLEAR, anywhere
    {
        const hits = [];
        const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const f = path.join(d, e.name);
                if (e.isDirectory()) { walk(f); continue; }
                let t = "";
                try { t = fs.readFileSync(f, "utf8"); } catch { /* binary */ }
                if (t.includes(KEY)) hits.push(f);
            }
        };
        walk(DATA);
        check("the key appears in NO file under the data directory", hits.length === 0, hits);
    }

    // nor is it ever handed back out
    {
        const eps = cloud.endpoints();
        check("endpoints() reports hasKey, never the key",
            !JSON.stringify(eps).includes(KEY));
        check("and hasKey is true", eps[0].hasKey === true);
    }

    const disc = await cloud.discoverModels(linked.id);
    check("models are discovered from the endpoint",
        disc.models.includes("deepseek-reasoner"), disc.models);
    check("the key is sent as a bearer token", sawAuth === `Bearer ${KEY}`, sawAuth);

    const t = await cloud.testEndpoint(linked.id);
    check("the test reports reachable with a model count", t.ok === true && t.models === 2, t);

    cloud.selectModel({ endpointId: linked.id, model: "deepseek-reasoner" });
    check("the selection sticks", cloud.selected().model === "deepseek-reasoner");
    check("and the endpoint is now available", cloud.available() === true);
    check("ask_cloud_model is offered to the agent",
        !!agent.effectiveTools({ all: false }).ask_cloud_model);

    // STREAM — tags split across frames, reasoning separated from the answer
    {
        let reasoning = "", output = "";
        const r = await cloud.streamChat(
            [{ role: "user", content: "how do I checksum a firmware image" }],
            { onReasoning: x => reasoning += x, onOutput: x => output += x });
        check("reasoning routes to the reasoning stream",
            reasoning === "weighing the checksum", reasoning);
        check("the answer is clean of tag debris",
            output === "XOR every byte but the last.", output);
        check("usage comes back", !!r.usage && r.usage.completion_tokens === 40, r.usage);
    }

    // the tool, through the agent
    {
        const tool = agent.effectiveTools({ all: true }).ask_cloud_model;
        const out = await tool.run(null, { question: "again please" }, {});
        check("ask_cloud_model returns the answer, not the chain of thought",
            out.answer === "XOR every byte but the last." && out.reasoningChars > 0, out);
    }

    /* ---- ONE PASTE, ONE BUTTON ----------------------------------------
     *
     * The panel this replaces asked seven questions to answer one: use that
     * server. connect() takes whatever was pasted and does the rest.
     */
    {
        cloud.unlinkEndpoint(linked.id);          // start from nothing

        // an address and a key, in one box, in either order
        let r = await cloud.connect(`127.0.0.1:${srv.address().port} ${KEY}`);
        check("one paste connects: address and key together", r.ok === true, r && r.summary);
        check("it discovered the models itself", r.models.length === 2, r.models);
        check("it picked the reasoning model as the default",
            r.model === "deepseek-reasoner", r.model);
        check("LINKING IS NOT CHOOSING — connect() no longer writes the global " +
            "driver role, so a paid model cannot become every new " +
            "conversation's default just by being linked (a linked paid model " +
            "was becoming the default model on its own)",
            !cloud.selected() || cloud.selected().model !== "deepseek-reasoner");
        // the roles are the user's own act now — done explicitly here,
        // exactly as Model Orchestration does it
        cloud.selectModel({ endpointId: r.endpoint.id, model: "deepseek-reasoner" });
        check("...and an explicit selection still takes immediately",
            cloud.selected() && cloud.selected().model === "deepseek-reasoner");
        check("the summary is one line a person can read",
            /connected to .* models, using /.test(r.summary), r.summary);
        cloud.unlinkEndpoint(r.endpoint.id);

        r = await cloud.connect(`${KEY}   127.0.0.1:${srv.address().port}`);
        check("order does not matter", r.ok === true && r.model === "deepseek-reasoner");
        cloud.unlinkEndpoint(r.endpoint.id);

        // URLs as people actually paste them, out of documentation
        check("a full endpoint URL is trimmed to its base",
            cloud.normaliseBase("https://api.deepseek.com/v1/chat/completions")
                === "https://api.deepseek.com");
        check("a bare public host gets https",
            cloud.normaliseBase("api.deepseek.com") === "https://api.deepseek.com");
        check("a bare LAN address gets http, not https",
            cloud.normaliseBase("192.168.1.20:11434") === "http://192.168.1.20:11434");
        check("trailing /v1 is dropped",
            cloud.normaliseBase("  https://api.together.xyz/v1  ") === "https://api.together.xyz");

        // ZEN AND GO ARE TWO PROVIDERS (opencode.ai/docs/go): one host, two
        // base paths, two catalogs — the endpoint id must keep them apart
        check("the endpoint id carries the base PATH, so Zen and GO on one " +
            "host get two slots and can be linked at once",
            cloud.endpointIdFor("https://opencode.ai/zen/v1", "opencode.ai", false)
                !== cloud.endpointIdFor("https://opencode.ai/zen/go/v1", "opencode.ai", false));
        check("...a bare-host address keeps its plain id",
            cloud.endpointIdFor("https://api.deepseek.com", "api.deepseek.com", false)
                === "api-api.deepseek.com");
        check("...and a NODE id carries its PORT for the same reason, because " +
            "one machine runs more than one engine — Ollama on 11434 and " +
            "llama.cpp on 30000 are two catalogs and must not share a slot",
            cloud.endpointIdFor("http://192.168.1.20:11434", "192.168.1.20", true)
                !== cloud.endpointIdFor("http://192.168.1.20:30000", "192.168.1.20", true)
            && cloud.endpointIdFor("http://192.168.1.20:11434", "192.168.1.20", true)
                === "node-192.168.1.20-11434");
        check("...while an address with no port keeps the plain node id, so " +
            "nothing that never had one is renamed out from under a session",
            cloud.endpointIdFor("http://192.168.1.20", "192.168.1.20", true)
                === "node-192.168.1.20");

        // ---- the node is the folder; the engine is what sits inside it ----
        const cmSrc = fs.readFileSync(
            path.join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"), "utf8");
        check("A NODE ENDPOINT CARRIES THE NODE AS ITS FAMILY, so the picker " +
            "can draw a folder per machine instead of one flat list",
            /providerFamily: node \? "node-" \+ \(node\.id \|\| host\)/.test(cmSrc)
            && /providerFamilyLabel: node \? \(\(node\.name\) \|\| host\)/.test(cmSrc));
        check("...and an explicit label WINS over the node name, so two engines " +
            "on one machine are two entries and not one — labelling both with " +
            "the node collapsed Ollama's ten models and llama.cpp's one into " +
            "eleven rows under a single heading",
            /label: \(opts && opts\.label\) \|\| \(node && node\.name\)/.test(cmSrc));
        check("...and the installer supplies that label from the recipe it just " +
            "ran, rather than leaving every engine on a node called the same thing",
            /const engine = String\(rec\.name \|\| ""\)\.split\(" — "\)\[0\]/.test(
                fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8")));
        check("the GO preset points at GO's OWN endpoint, not Zen's — the docs " +
            "give GO a separate base URL and catalog",
            (() => {
                const go = cloud.PRESETS.find(p => p.id === "zen-go");
                const zen = cloud.PRESETS.find(p => p.id === "zen");
                return go && zen
                    && go.baseUrl === "https://opencode.ai/zen/go/v1"
                    && zen.baseUrl === "https://opencode.ai/zen/v1"
                    && go.plan === "go-window" && !zen.plan;
            })());

        // THE PER-MODEL SCHEMA IS THE PROVIDER'S OWN WORD (DeepInfra publishes
        // capability tags per model; "reasoning_effort" is a literal tag).
        // Optional fields must not be applied globally when they will not work
        // across every provider — the request builder consults these before
        // sending optional fields.
        check("a model whose published tags EXCLUDE reasoning_effort never " +
            "receives it",
            cloud.effortSupported({ model: "m",
                models: [{ id: "m", tags: ["chat", "vlm"] }] }) === false);
        check("...a model whose tags include it does",
            cloud.effortSupported({ model: "m",
                models: [{ id: "m", tags: ["chat", "reasoning_effort"] }] }) === true);
        check("...and a host that publishes no tags keeps the old behaviour — " +
            "send it, with the strip-and-retry as the net",
            cloud.effortSupported({ model: "m", models: [{ id: "m" }] }) === true
            && cloud.effortSupported({ model: "m" }) === true);

        // NODE SHAPE decides effort, not node-ness. A llama.cpp/vLLM node
        // (openai shape) accepts reasoning_effort — measured 200 — so the
        // user's effort setting must reach it; only Ollama, which rejects
        // unknown fields, stays gated. Lumping every node in suppressed the
        // setting on a linked node's own driver.
        check("a llama.cpp / vLLM node (openai shape) gets reasoning_effort — " +
            "the setting was silently dead on a linked node's own driver before",
            cloud.effortSupported({ id: "n", model: "m", shape: "openai", localNode: true }) === true);
        check("...but an Ollama node stays suppressed — it rejects unknown body fields",
            cloud.effortSupported({ id: "s", model: "m", shape: "ollama", localNode: true }) === false);

        /* THE PROVIDER'S OWN SHEET. DeepInfra serves /models/list at its
         * ORIGIN: 360 entries carrying type, feature tags (tools, json,
         * structured-output), a `deprecated` unix stamp and `replaced_by`.
         * Measured live: 138 of the 360 are RETIRED and 213
         * declare no tool calling — and .lcl offered them all as equal
         * choices, which is how a gemini serving retired in June got picked
         * and answered four clean 200s with nothing in them. */
        check("modelCan answers from the provider's published tags, merging " +
            "both vocabularies (the OpenAI list's metadata.tags and " +
            "/models/list's feature tags)",
            cloud.modelCan({ model: "m", models: [{ id: "m",
                tags: ["chat", "vision"], features: ["tools", "json"] }] }, "tools") === true
            && cloud.modelCan({ model: "m", models: [{ id: "m",
                tags: ["chat", "vision"], features: ["tools"] }] }, "vision") === true);
        check("...and says FALSE only when the provider published a list this " +
            "capability is not on — an unpublished capability is null, not no",
            cloud.modelCan({ model: "m", models: [{ id: "m", features: ["json"] }] }, "tools") === false
            && cloud.modelCan({ model: "m", models: [{ id: "m" }] }, "tools") === null
            && cloud.modelCan({ model: "m" }, "tools") === null);
        check("A RETIRED MODEL IS NAMED AS RETIRED — the stamp and the named " +
            "successor, so 'it just answers nothing' has an explanation",
            (() => {
                const r = cloud.modelRetirement({ model: "g", models: [{ id: "g",
                    deprecated: 1749069072, replacedBy: "google/gemma-4-31B-it" }] });
                return r && r.at === 1749069072 && r.replacedBy === "google/gemma-4-31B-it"
                    && cloud.modelRetirement({ model: "g", models: [{ id: "g" }] }) === null;
            })());
        check("...and it is NEVER the model the app picks on the user's " +
            "behalf; nor is one with no published tool calling, in a workbench " +
            "whose whole loop is tools",
            (() => {
                const cat = [
                    { id: "live/good", description: "", features: ["tools"] },
                    { id: "dead/retired", description: "", deprecated: 1749069072,
                      features: ["tools"] },
                    { id: "live/chatonly", description: "", features: ["json"] }
                ];
                return cloud.pickDefaultModel(cat.map(c => c.id), cat) === "live/good";
            })());

        /* DNS THAT CANNOT BE STARVED. Node's dns.lookup is getaddrinfo on
         * libuv's FOUR-THREAD pool; four hung lookups take the whole
         * process's name resolution with them. Measured: four lookups to
         * unroutable names, then one to api.deepinfra.com — 22,006 ms for a
         * name that resolves in 11 ms idle. That matches the reported failure
         * (DNS never resolved, socket assigned, no lookup event, dead at the
         * cap) and why chat sits there forever. dns.resolve4 is c-ares: event
         * loop, no pool. */
        {
            const dnsMod = require("dns");
            // jam every slot with lookups that will not return
            for (let i = 0; i < 6; i++) {
                dnsMod.lookup("blackhole-" + i + "-lcl-pin.invalid", () => {});
            }
            const raced = (fn) => new Promise((res) => {
                let settled = false;
                const t = setTimeout(() => { if (!settled) { settled = true; res("slow"); } }, 2500);
                fn((err) => {
                    if (settled) return;
                    settled = true; clearTimeout(t); res(err ? "err" : "ok");
                });
            });
            const viaPool = await raced(cb => dnsMod.lookup("localhost", cb));
            const viaCares = await raced(cb => cloud.lookupOffThreadPool("localhost", {}, cb));
            check("the pool-free resolver answers while libuv's DNS threads are " +
                "all jammed — the starvation that made a reachable endpoint " +
                "report \"DNS never resolved\"",
                viaCares === "ok", { viaCares, viaPool });
            check("...and an IP literal never touches a resolver at all",
                await raced(cb => cloud.lookupOffThreadPool("127.0.0.1", {}, cb)) === "ok");
            check("...and every outbound request uses it by default, chat included",
                /lookup: lookup \|\| lookupOffThreadPool/.test(io_readSource())
                && /viaDoor \? publicDns\.lookup : lookupOffThreadPool/.test(io_readSource()));
        }

        // key vs address, told apart by shape alone
        check("an sk- token is read as a key", cloud.looksLikeKey("sk-1234567890abcdefghij"));
        check("an hf_ token is read as a key", cloud.looksLikeKey("hf_AbCdEfGhIjKlMnOpQrSt"));
        check("a hostname is not read as a key", !cloud.looksLikeKey("api.deepseek.com"));
        check("a host:port is read as an address", cloud.looksLikeUrl("localhost:11434"));

        // the default pick prefers capability and never an embedder
        check("reasoning models win the default",
            cloud.pickDefaultModel(["deepseek-chat", "deepseek-reasoner", "bge-small"])
                === "deepseek-reasoner");
        check("embedders never win",
            cloud.pickDefaultModel(["nomic-embed-text", "qwen2.5-coder:32b"])
                === "qwen2.5-coder:32b");

        // Reasoning models report their chain of thought in a separate field,
        // not in <think> — getting this wrong drops it entirely for exactly the
        // models people link an endpoint FOR.
        //
        // This was a 120-character slice of the source after "const
        // reasoningField", which broke the moment the host list grew past one
        // entry. Behaviour, not source text: the declared hint must cover
        // DeepInfra as well as DeepSeek's own API, because the same weights are
        // served from both and only one of them was recognised — and the stream
        // parser must ALSO sniff the field off the wire, so a host nobody
        // thought of still works.
        {
            const src = io_readSource();
            const hint = /const reasoningField\s*=\s*([\s\S]{0,400}?);/.exec(src);
            check("the reasoning-field hint exists", !!hint);
            const hintSrc = hint ? hint[1] : "";
            check("...and declares reasoning_content",
                /reasoning_content/.test(hintSrc), hintSrc.slice(0, 120));
            check("...for DeepSeek's own API",
                /deepseek\\?\.com/.test(hintSrc), hintSrc.slice(0, 200));
            check("...and for DeepInfra, which serves the same weights US-hosted",
                /deepinfra/.test(hintSrc), hintSrc.slice(0, 200));
            check("the stream parser detects the field from the frame, not only the host",
                /for \(const cand of \[/.test(src) && /"reasoning_content", "reasoning", "thinking"/.test(src));
        }

        // failures say what to do, not what went wrong internally
        let msg = "";
        try { await cloud.connect("sk-loosekeywithnoserver123"); } catch (e) { msg = e.message; }
        check("a key with no address explains what is missing",
            /no server address with it/.test(msg), msg);

        // A KEY THAT NAMES ITS OWN HOME NEEDS NO ADDRESS — sk-or-v1- IS an
        // OpenRouter key (measured: the OpenRouter add failed exactly here,
        // a bare key paste told "no server address" for a provider the app
        // could have inferred). The fake key must reach openrouter.ai and be
        // REJECTED BY THE SERVER (or fail to reach it) — never "no address".
        try { msg = ""; await cloud.connect("sk-or-v1-" + "0".repeat(64)); }
        catch (e) { msg = e.message; }
        check("a bare OpenRouter key resolves its home instead of demanding an address",
            !/no server address/.test(msg), msg);
        try { await cloud.connect("banana"); } catch (e) { msg = e.message; }
        check("nonsense is rejected plainly", /no server address/.test(msg), msg);
        try { await cloud.connect("127.0.0.1:59999"); } catch (e) { msg = e.message; }
        check("an unreachable server says so", /could not reach/.test(msg), msg);

        // put it back for the remaining checks — and select it explicitly,
        // because connect() deliberately no longer touches the roles
        const again = await cloud.connect(`127.0.0.1:${srv.address().port} ${KEY}`);
        linked.id = again.endpoint.id;
        cloud.selectModel({ endpointId: again.endpoint.id, model: again.model });

        /* A REFRESH IS NOT A DISCOVERY. Measured on a real install: a refresh
         * died after 20,006 ms with "the endpoint did not respond", having
         * spent its whole budget on an Ollama sniff and a /v1/models rung the
         * endpoint has never answered — the documented route it DOES answer
         * was never reached. A re-probe uses the prefix and shape already on
         * the record. */
        {
            const ep0 = cloud.endpoints().find(e => e.baseUrl.includes("127.0.0.1"));
            if (ep0) {
                askedPaths.length = 0;
                await cloud.discoverModels(ep0.id).catch(() => null);
                const modelCalls = askedPaths.filter(p => /models/.test(p));
                check("a REFRESH goes straight to the route this endpoint already " +
                    "answered — no Ollama sniff, no ladder rungs it is known to 404",
                    !askedPaths.some(p => /\/api\/tags$/.test(p)) && modelCalls.length <= 2,
                    askedPaths.slice(0, 6));
            }
        }

    }

    // THE EGRESS GATE, over the whole body — a gate that REDACTS, not one
    // that detonates. The old contract was a hard throw, and it cost a real
    // user a fifty-read turn: the model read a repo containing a key, the key
    // rode into the prompt, the throw killed the turn, and a failed turn
    // persists nothing. The product's standing rule is the contract
    // now: read freely, NEVER let the value leave, tell the user. So the
    // request goes out with the secret replaced, and the result says so.
    {
        guard.reset();
        guard.rememberFile("config/.env", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY\n");
        let r = null, threw = null;
        try {
            r = await cloud.streamChat([{ role: "user",
                content: "why does this fail: wJalrXUtnFEMI/K7MDENG/bPxRfiCY" }]);
        } catch (e) { threw = e.message; }
        check("a secret in the PROMPT BODY does not kill the turn",
            !threw && !!r && !r.error, threw || (r && r.error));
        check("the result carries the redaction flag so the user is told",
            !!r && r.redacted === true, r && r.redacted);
        guard.reset();
    }

    // plain http to a PUBLIC host would put the key on the wire
    {
        let refused = false, why = "";
        try { cloud.linkEndpoint({ preset: "custom", baseUrl: "http://api.example.com" }); }
        catch (e) { refused = true; why = e.message; }
        check("plain http to a public host is refused", refused, why);
        check("and the reason names the risk", /unencrypted/.test(why), why);
        check("but http to your own machine or LAN is allowed",
            cloud.isLocalHost("192.168.1.20") && cloud.isLocalHost("127.0.0.1")
            && cloud.isLocalHost("10.0.0.5") && cloud.isLocalHost("localhost"));
        check("a public host is not mistaken for local",
            !cloud.isLocalHost("api.deepseek.com") && !cloud.isLocalHost("8.8.8.8"));
    }

    // errors never carry the key
    {
        const dirty = `failed with Authorization: Bearer ${KEY} on retry`;
        const clean = cloud.scrub(dirty, KEY);
        check("scrub removes the literal key", !clean.includes(KEY), clean);
        check("scrub removes any bearer shape",
            !/Bearer\s+[A-Za-z0-9._-]{8,}/.test(clean), clean);
        check("scrub catches sk- shapes it has never seen",
            !cloud.scrub("leaked sk-abcdefghijklmnopqrstuvwxyz").includes("abcdefghij"));
    }

    // networking off -> nothing leaves, even fully linked and selected
    {
        paths.writeSettings({ networkEnabled: false });
        let blocked = false, msg = "";
        try { await cloud.streamChat([{ role: "user", content: "hi" }]); }
        catch (e) { blocked = true; msg = e.message; }
        check("with networking off the call is refused", blocked, msg);
        check("and the refusal names the switch", /network access is off/i.test(msg), msg);
        check("the agent stops offering the tool too",
            !agent.effectiveTools({ all: false }).ask_cloud_model);
        paths.writeSettings({ networkEnabled: true });
    }

    // unlink wipes it
    cloud.unlinkEndpoint(linked.id);
    check("unlink removes the endpoint", cloud.endpoints().length === 0);
    check("and deselects it", cloud.available() === false);

    srv.close();
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }); }
    catch { /* windows */ }
    /* ============ A RETIRED MODEL IS NOT A DEAD FAMILY ====================== */
/*
 * A gemini flash model can be present in the provider's model library — listed
 * on DeepInfra's website as an available model — while a specific id is retired.
 *
 * Live on DeepInfra right now: gemini-2.5-flash, gemini-3.5-flash,
 * gemini-3.1-flash-lite. Retired: the 1.5-flash pair, and NEITHER carries a
 * replaced_by. So the report said "No replacement is named" — true about that
 * one id, and read as "this family is gone", which is the stale answer that was
 * called out. The successor comes from the endpoint's own captured sheet now,
 * so a suggestion can never name a model this endpoint does not serve.
 */
{
    const sel = { model: "google/gemini-1.5-flash-8b", models: [
        { id: "google/gemini-1.5-flash-8b", deprecated: 1749069072 },
        { id: "google/gemini-1.5-flash", deprecated: 1749069072 },
        { id: "google/gemini-2.5-flash" },
        { id: "google/gemini-3.5-flash" },
        { id: "google/gemini-3.1-flash-lite" },
        { id: "google/gemini-3.1-pro" },
        { id: "meta-llama/Llama-3.3-70B" }
    ] };
    const r = cloud.modelRetirement(sel);
    check("A RETIRED MODEL NAMES THE LIVE ONES IN ITS OWN FAMILY when the " +
          "provider names no successor. Saying only that no replacement exists " +
          "was true about the id and wrong about the family",
        !!r && r.replacedBy === null && r.siblings.length >= 3, r);
    check("...newest first, so the first suggestion is the one worth taking",
        r && r.siblings[0] === "google/gemini-3.5-flash", r && r.siblings);
    check("...and it never suggests another RETIRED model",
        r && !r.siblings.includes("google/gemini-1.5-flash"), r && r.siblings);
    check("...nor a different trait: the user was using FLASH, so pro is not an answer",
        r && !r.siblings.includes("google/gemini-3.1-pro"), r && r.siblings);
    check("...nor a different publisher entirely",
        r && !r.siblings.some(x => x.indexOf("meta-llama/") === 0), r && r.siblings);
    check("...and a model the provider DID name a successor for still uses it",
        (() => {
            const g = cloud.modelRetirement({ model: "a/x", models: [
                { id: "a/x", deprecated: 1, replacedBy: "a/y" }, { id: "a/y" } ] });
            return !!g && g.replacedBy === "a/y";
        })());
    check("...and a LIVE model is not reported as retired at all",
        cloud.modelRetirement({ model: "google/gemini-2.5-flash",
            models: sel.models }) === null);
}
/* ============ OPENCODE PUBLISHES NO PRICES OVER THE WIRE ================= */
/*
 * The published rates for both Zen and GO were still missing.
 *
 * Checked live against both products: /models returns id, object, created and
 * owned_by, and NO pricing. The catalogue scraper reads DeepInfra's
 * metadata.pricing shape, so learnRate was never called for a single OpenCode
 * model and every rate table read empty — which also starved the GO window
 * meter, because spend cannot be counted against $12 without a price.
 *
 * The numbers come from opencode.ai/docs/zen and apply to BOTH products: GO is
 * the same catalogue drawn against a dollar window rather than a balance.
 */
{
    const rates = cloud.OPENCODE_RATES;
    check("THE PUBLISHED PRICES ARE CARRIED, because the provider does not send " +
          "them — /models has no pricing field at all",
        !!rates && Object.keys(rates).length > 25, rates && Object.keys(rates).length);

    check("...in dollars per MILLION tokens, the same unit the rest of the cost " +
          "layer speaks. A host quoting per-token would be off by a factor of a " +
          "million and read $2,600 for one message",
        rates["claude-opus-5"][0] === 5 && rates["claude-opus-5"][1] === 25
        && rates["kimi-k3"][0] === 3 && rates["kimi-k3"][1] === 15
        && rates["deepseek-v4-flash"][0] === 0.14, null);

    check("...and FREE is a price, recorded as 0, not left out. An omitted entry " +
          "is indistinguishable from one nobody knows",
        rates["big-pickle"][0] === 0 && rates["big-pickle"][1] === 0,
        rates["big-pickle"]);

    check("...and both presets carry them, because GO spends the same catalogue " +
          "against a window instead of a balance",
        cloud.presetForBase("https://opencode.ai/zen/v1").rates === rates
        && cloud.presetForBase("https://opencode.ai/zen/go/v1").rates === rates, null);

    check("...and each names itself SHORTLY for the picker, so the tree reads " +
          "OpenCode > GO rather than OpenCode > OpenCode GO",
        cloud.presetForBase("https://opencode.ai/zen/v1").shortLabel === "Zen"
        && cloud.presetForBase("https://opencode.ai/zen/go/v1").shortLabel === "GO",
        null);

    check("...and the table is declared ABOVE the presets that read it. A const " +
          "is hoisted into the temporal dead zone, not into scope, so a preset " +
          "literal reading it from further up the file throws at REQUIRE time — " +
          "which node --check never sees, and which the first real run found",
        (() => {
            const src = fs.readFileSync(
                path.join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"),
                "utf8");
            return src.indexOf("const OPENCODE_RATES") < src.indexOf("const PRESETS = [")
                && src.indexOf("const OPENCODE_RATES") > 0;
        })(), null);
}
/* ================= THE PRICE TABLE MUST NOT COST THE UI ================== */
/*
 * The UI became so laggy it was unusable.
 *
 * Measured. Seeding the published prices was wired into
 * healKnownPresets, which runs inside endpoints() — and endpoints() is called
 * by cloudState, listModels and every picker refresh. So each of those became
 * thirty-five learnRate calls, and learnRate read the settings file and
 * rewrote it whole EVERY TIME, including when it was storing a value already
 * there.
 *
 * Measured, per endpoints() call:  ~42 settings reads + ~35 full JSON writes
 * After:                            1 read, 0 writes
 *
 * Two independent guards, because either alone still leaves a hot path doing
 * file I/O for no reason.
 */
{
    const px = require("path");
    const tcSrc = fs.readFileSync(
        px.join(__dirname, "..", ".lcl.engine", "core", "tokenCost.js"), "utf8");
    const cmSrc = fs.readFileSync(
        px.join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"), "utf8");

    check("A WRITE THAT CHANGES NOTHING IS NOT MADE. learnRate rewrote the whole " +
          "settings file even when the rate was already exactly that",
        /const prev = all\[modelId\];/.test(tcSrc)
        && /if \(prev && Number\(prev\.in\) === i && Number\(prev\.out\) === o\) return false;/
            .test(tcSrc), null);

    check("...and a preset's table is seeded ONCE PER PROCESS, not once per " +
          "lookup. Published prices do not change while the app is running, and " +
          "endpoints() is on the picker's hot path",
        /const seededPresets = new Set\(\);/.test(cmSrc)
        && /if \(!force && seededPresets\.has\(preset\.id\)\) return 0;/.test(cmSrc),
        null);

    check("...and the prices still LAND despite both guards — a cache that " +
          "forgets is not a cache, it is a bug with better manners",
        (() => {
            const zen = cloud.presetForBase("https://opencode.ai/zen/v1");
            cloud.seedPresetRates(zen, true);
            const tc = require(px.join(__dirname, "..", ".lcl.engine", "core", "tokenCost.js"));
            const r = tc.rateFor("kimi-k3");
            return !!r && Number(r.in) === 3 && Number(r.out) === 15;
        })(), null);
}
/* ============ THE IDS ARE THE PROVIDER'S, CHARACTER FOR CHARACTER ======== */
/*
 * Some models had rates for the new GO and Zen, but not all.
 *
 * The first table wrote "gemini-3-6-flash" and "grok-4-6", converting the dots
 * to dashes the way the claude ids happen to be written. The provider serves
 * "gemini-3.6-flash" and "grok-4.6". Those keys matched nothing — a rate table
 * that is present and silently keyed wrong is worse than an absent one,
 * because it looks done.
 *
 * The lists below were captured from a LIVE /models call on both endpoints.
 */
{
    const px = require("path");
    const tc = require(px.join(__dirname, "..", ".lcl.engine", "core", "tokenCost.js"));
    cloud.seedPresetRates(cloud.presetForBase("https://opencode.ai/zen/v1"), true);

    const ZEN = ("claude-fable-5 claude-opus-5 claude-opus-4-8 claude-sonnet-5 " +
        "claude-haiku-4-5 gemini-3.6-flash gemini-3.5-flash-lite gemini-3.1-pro " +
        "gpt-5.6-sol gpt-5.5-pro gpt-5.4-nano gpt-5.1-codex-max gpt-5-nano " +
        "grok-build-0.1 grok-4.6 deepseek-v4-pro glm-5.2 minimax-m3 kimi-k3 " +
        "qwen3.6-plus big-pickle hy3-free").split(" ");
    const unpricedZen = ZEN.filter(id => !tc.rateFor(id));
    check("EVERY MODEL ZEN SERVES HAS A RATE — the dotted ids included, which " +
          "are the ones that silently matched nothing",
        unpricedZen.length === 0, unpricedZen);

    check("...and the dotted ids resolve to the published numbers, not to " +
          "whatever a dashed near-miss would have found",
        (() => {
            const g = tc.rateFor("gemini-3.6-flash");
            const k = tc.rateFor("grok-4.6");
            const n = tc.rateFor("gpt-5-nano");
            return g && Number(g.in) === 1.5 && Number(g.out) === 7.5
                && k && Number(k.in) === 2 && Number(k.out) === 6
                && n && Number(n.in) === 0.05 && Number(n.out) === 0.4;
        })(), null);

    check("...and a model the provider serves but does NOT publish a price for " +
          "reports unknown rather than a number that is wrong",
        ["qwen3.8-max", "mimo-v2-omni", "hy3-preview"]
            .every(id => !tc.rateFor(id)), null);
}

/* ================= SELF-HEALING IS NOT ONE VENDOR'S FIELD NAME =========== */
/*
 * The cost accounting should be self-healing, the same way it is for the
 * DeepInfra API.
 *
 * It healed from `usage.estimated_cost`, which is DeepInfra's name for it —
 * so it worked for exactly one vendor. The point was never that field; it was
 * noticing a cost the provider volunteered. Anything not recognised stays
 * unknown, because the alternative to a missing number is a wrong one.
 */
{
    const px = require("path");
    const tc = require(px.join(__dirname, "..", ".lcl.engine", "core", "tokenCost.js"));
    const base = { prompt_tokens: 1000, completion_tokens: 500 };
    check("A REPORTED COST IS FOUND WHEREVER THE PROVIDER PUT IT",
        [{ ...base, estimated_cost: 0.003 }, { ...base, total_cost: 0.003 },
         { ...base, cost: 0.003 }, { ...base, cost_usd: 0.003 },
         { ...base, cost: { total: 0.003 } }]
            .every(u => Number(tc.reportedCost(u)) === 0.003), null);
    check("...and a turn that reported none stays UNKNOWN rather than zero — " +
          "$0.00 and \"nobody said\" are different facts, and the plan meter " +
          "counts one of them",
        !isFinite(tc.reportedCost({ ...base }))
        && !isFinite(tc.reportedCost({ ...base, cost: 0 }))
        && !isFinite(tc.reportedCost(null)), null);
}
    /* ---- AN OPENROUTER-SHAPED LISTING IS READ WHOLE -----------------------
     *
     * OpenRouter publishes pricing (per-TOKEN strings), context_length,
     * architecture.output_modalities and top_provider at the TOP level of each
     * model, and lists at /api/v1/models. Reading only DeepInfra's metadata
     * shape dropped every price and window — "the rate table is not up to
     * date". This drives connect() against a faithful fixture server.
     */
    {
        paths.writeSettings({ networkEnabled: true });   // a later block switches it off
        const orSrv = await new Promise((resolve) => {
            const x = http.createServer((req, res) => {
                if (req.url === "/api/v1/models") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ data: [
                        { id: "vendor/chatty-70b", description: "a chat model",
                          context_length: 131072,
                          architecture: { output_modalities: ["text"] },
                          top_provider: { max_completion_tokens: 16384 },
                          pricing: { prompt: "0.000003", completion: "0.000015" } },
                        { id: "vendor/llama-guard-4", description: "safety classifier",
                          context_length: 8192,
                          architecture: { output_modalities: ["text"] },
                          pricing: { prompt: "0.0000002", completion: "0.0000002" } },
                        { id: "vendor/paint-3", description: "image generation",
                          context_length: 32768,
                          architecture: { output_modalities: ["image"] },
                          pricing: { prompt: "0.00001", completion: "0.00003" } }
                    ] }));
                    return;
                }
                res.writeHead(404); res.end("{}");    // /v1/models does NOT exist here
            });
            x.listen(0, "127.0.0.1", () => resolve(x));
        });
        const r = await cloud.connect(`127.0.0.1:${orSrv.address().port} sk-or-v1-testtesttesttest`);
        check("an /api/v1-only host links (the rung OpenRouter actually answers)",
            r.ok === true, r && (r.error || r.summary));
        const tokenCost = require(path.join(__dirname, "..", ".lcl.engine", "core", "tokenCost.js"));
        check("the CHAT picker holds the chat model, and the classifier and the " +
              "image model are hidden BY the provider's own signals — with the " +
              "count of hidden models stated in the summary",
            r.ok && r.models.length === 1 && r.models[0] === "vendor/chatty-70b"
            && r.allModels.length === 3 && /hidden/.test(r.summary), r && r.summary);
        const rec = cloud.endpoints().find(e => e.id === (r.endpoint && r.endpoint.id));
        const chatty = rec && (rec.models || []).find(m => m.id === "vendor/chatty-70b");
        // pricing does NOT ride the stored model record — tokenCost owns it (the
        // rateFor check below is the contract); the record carries the window
        check("the stored record exists for the chat model", !!chatty, rec && rec.models);
        check("top-level context_length and max_completion_tokens are read",
            !!chatty && chatty.contextLength === 131072 && chatty.maxTokens === 16384, chatty);
        check("the provider's own rate reaches the cost meter (learned, user overrides still win)",
            (() => { const rr = tokenCost.rateFor("vendor/chatty-70b");
                     return rr && rr.in === 3 && rr.out === 15; })());
        check("a text-modality model is chat-capable by the provider's own word",
            cloud.isChatCapable("vendor/chatty-70b",
                [{ id: "vendor/chatty-70b", outputModalities: ["text"], contextLength: 131072 }]) === true);
        check("...but a guard/safety classifier never rides modality into the chat picker",
            cloud.isChatCapable("vendor/llama-guard-4",
                [{ id: "vendor/llama-guard-4", outputModalities: ["text"], contextLength: 8192 }]) === false);
        check("...and an image-modality model is excluded",
            cloud.isChatCapable("vendor/paint-3",
                [{ id: "vendor/paint-3", outputModalities: ["image"], contextLength: 32768 }]) === false);
        // DOC-GROUNDED: OpenRouter ":batch" is a
        // Batch-API-only variant, rejected by chat/completions — 61 of a
        // user's 414 OpenRouter models. The id suffix is the only signal.
        check("an OpenRouter :batch variant is excluded (Batch API only, not chat)",
            cloud.isChatCapable("anthropic/claude-opus-5:batch",
                [{ id: "anthropic/claude-opus-5:batch", outputModalities: ["text"], contextLength: 200000 }]) === false);
        check("...but its plain sibling and a :free variant are NOT dropped",
            cloud.isChatCapable("anthropic/claude-opus-5",
                [{ id: "anthropic/claude-opus-5", outputModalities: ["text"], contextLength: 200000 }]) === true
            && cloud.isChatCapable("meta/llama:free",
                [{ id: "meta/llama:free", outputModalities: ["text"], contextLength: 128000 }]) === true);
        // DeepInfra stamps `deprecated` (a unix time; 138/361 retired). A dead
        // model still reads type=text-generation and was being LISTED as live.
        check("a deprecated model (unix-stamped) is excluded, not just deprioritized",
            cloud.isChatCapable("old/retired",
                [{ id: "old/retired", type: "text-generation", deprecated: 1719000000 }]) === false
            && cloud.isChatCapable("live/model",
                [{ id: "live/model", type: "text-generation" }]) === true);
        // LEARN-FROM-ERROR PRUNING: OpenCode's catalog carries NO deprecation
        // flags (measured — bare id list), so call-time retirement sentences
        // are the only signal there. Upstream-definitive strings prune; a 500 /
        // timeout / "provider returned error" must NOT (the prior lesson: our
        // own broken body once deleted working models).
        {
            const src = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"), "utf8");
            check("dead-model pruning also learns from upstream retirement sentences",
                /endpoint is unavailable\|model is unavailable\|has been deprecated\|only available hosted in china/i.test(src));
            check("...but never from a generic 500/timeout (our own body once broke calls)",
                !/provider returned error|internal server error/i.test(
                    (src.match(/\|\| \/[^\n]*only available hosted in china[^\n]*/i) || [""])[0]));
        }
        cloud.unlinkEndpoint(r.endpoint && r.endpoint.id);
        orSrv.close();
    }

    /* ---- A SERVER ALREADY SERVING IT IS PAST ITS LOAD ---------------------
     * A real error, twice: the preflight guard, blind (a VPN blocked
     * the direct road) or size-less (llama.cpp's /api/tags lists the model
     * with no size), fell back to a NAME guess and refused a 120B the node
     * was actively serving. Both refusal sites now ask the endpoint's own
     * /v1/models first — on the direct road here; the keyed-door road is the
     * same helper. */
    {
        const stub = await new Promise((resolve) => {
            const x = http.createServer((req, res) => {
                res.setHeader("content-type", "application/json");
                if (req.url.startsWith("/api/tags")) return res.end(JSON.stringify(
                    { models: [{ name: "unsloth/gpt-oss-120b-GGUF:F16" }] }));   // no size
                if (req.url.startsWith("/api/ps")) return res.end(JSON.stringify({ models: [] }));
                if (req.url.startsWith("/v1/models")) return res.end(JSON.stringify(
                    { data: [{ id: "unsloth/gpt-oss-120b-GGUF:F16" }] }));
                res.statusCode = 404; res.end("{}");
            });
            x.listen(0, "127.0.0.1", () => resolve(x));
        });
        const sEp = { id: "pf", label: "llama.cpp server",
            baseUrl: "http://127.0.0.1:" + stub.address().port,
            model: "unsloth/gpt-oss-120b-GGUF:F16", localNode: true, apiPrefix: "/v1" };
        let refused = null;
        try { await cloud.nodePreflight(sEp); } catch (e) { refused = e.message; }
        check("a size-less catalogue no longer refuses a model the server itself lists on /v1/models",
            refused === null, refused);
        stub.close();
    }

console.log(`\n${pass}/${pass + fail} cloud-model checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", (e && e.stack) || e); process.exit(1); });
