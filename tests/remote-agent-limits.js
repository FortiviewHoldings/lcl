/**
 * A LINKED MODEL HAS TO BE ABLE TO DO A PIECE OF WORK.
 *
 * The question this exists to answer: "will i be able to have those models read
 * this logic that we are building, and work inside of it like you are doing,
 * altering it and iterating over it?"
 *
 * The plumbing was there — router.generate is a drop-in for engine.generate, so
 * a remote model already got the whole tool registry and the whole agent loop.
 * What was NOT there was room to use it. Four constants in agent.js sized the
 * loop for a 1.5B model on a 15.6 GB laptop, where each one is a memory
 * decision:
 *
 *     MAX_STEPS       4       tool calls per message
 *     MAX_TOKENS      1536    output tokens per generation
 *     HISTORY_WINDOW  12      messages of context
 *     TOOL_RESULT_CAP 4000    characters of any tool's output
 *
 * Applied to DeepSeek V4-Pro — 1,048,576-token window, published by the
 * endpoint — those stop being caution. Four tool calls is enough to read a file
 * and comment on it. 4000 characters is a truncated read of any real source
 * file, which makes an exact-match edit impossible to construct. And the
 * ceiling was reported as a bare "(stopped)", indistinguishable from the model
 * deciding it had finished.
 *
 * So the limits follow the model, sized from what the endpoint publishes about
 * it. This suite pins both directions: local is UNCHANGED (that machine still
 * has 15.6 GB and those numbers are still right), and remote scales.
 */
const os = require("os");
const path = require("path");
const fs = require("fs");

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
    app: { isPackaged: true, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

const ROOT = path.join(__dirname, "..");
const router = require(path.join(ROOT, ".lcl.engine", "core", "router.js"));
const cloudModels = require(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"));
const tokenCost = require(path.join(ROOT, ".lcl.engine", "core", "tokenCost.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++;
        console.log("FAIL |", name,
            detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 240) : "");
    }
}

/* ------------------------------------------------------ local is unchanged --- */
// Nothing is linked in this process, so limits() must return exactly the
// constants the local loop has always used. If this drifts, a 15.6 GB laptop
// starts being asked to hold 60 messages of history.
{
    const L = router.limits();
    check("local: kind is local", L.kind === "local", L);
    check("local: 4 tool calls per message", L.maxSteps === 4, L.maxSteps);
    check("local: 1536 output tokens", L.maxTokens === 1536, L.maxTokens);
    check("local: 12 messages of history", L.historyWindow === 12, L.historyWindow);
    check("local: 4000 chars of tool output", L.toolResultCap === 4000, L.toolResultCap);
    check("the exported LOCAL_LIMITS agree with what limits() returns",
        router.LOCAL_LIMITS.maxSteps === L.maxSteps
        && router.LOCAL_LIMITS.maxTokens === L.maxTokens
        && router.LOCAL_LIMITS.historyWindow === L.historyWindow
        && router.LOCAL_LIMITS.toolResultCap === L.toolResultCap);
}

/* ------------------------------------------------ the remote floor is sane --- */
{
    const F = router.REMOTE_FLOOR;
    const L = router.LOCAL_LIMITS;
    check("a remote model with NO published metadata still gets more room than local",
        F.maxSteps > L.maxSteps && F.maxTokens > L.maxTokens
        && F.historyWindow > L.historyWindow && F.toolResultCap > L.toolResultCap, F);
    check("the floor is not unbounded — a runaway loop still hits a wall",
        F.maxSteps <= 32 && F.maxTokens <= 8192, F);
}

/* ------------------------------------------- the agent loop uses them, not
                                                the old constants ------------- */
{
    const src = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
    for (const dead of ["MAX_STEPS", "MAX_TOKENS", "HISTORY_WINDOW", "TOOL_RESULT_CAP"]) {
        check(`agent.js no longer hardcodes ${dead}`,
            !new RegExp("\\b" + dead + "\\b").test(src));
    }
    check("agent.js reads its limits from the router — and sizes them to the " +
          "model driving THIS SESSION, not to the app-wide selection",
        /const limits = LIMITS\(sel\)/.test(src) && /router\.limits\(sel\)/.test(src));
    check("the step ceiling tells the user the number and how to continue",
        /Stopped after \$\{limits\.maxSteps\} tool calls/.test(src));
    // The notice used to be the `||` fallback of scrubToolEchoes, so it only
    // appeared when the model had written nothing else — which a capable model
    // never does. It has to be APPENDED to whatever was said, or a turn that
    // was cut off reads exactly like a turn that finished.
    check("the ceiling notice is appended, not used as a fallback",
        /const note = said \? `\$\{said\}\\n\\n\$\{notice\}` : notice;/.test(src));
    check("the discarded tool call is named, since its tokens were paid for",
        /The next step would have been/.test(src));
    // Tests the INTENT, not one variable name. This pinned the literal
    // `messages.slice(-historyWindow)` and so failed the moment the list being
    // sliced was given a name of its own — while the thing it exists to
    // protect, that the window is a parameter rather than a hardcoded number,
    // was never in danger.
    check("the history window is a parameter, not a constant",
        /\.slice\(-historyWindow\)/.test(src)
        && /historyWindow = \d+ \} = \{\}/.test(src));
    check("...and the Ancient Knowledge audit is kept OUT of that window — it " +
          "is its own context, and feeding its bubbles back would spend the " +
          "model's twelve-message view on commentary about the work",
        /m\.meta\.model === "ancient-knowledge"/.test(src)
        && /\.slice\(-historyWindow\)/.test(src.slice(src.indexOf("const visible"))),
        null);
    check("the tool-result cap reaches runTool through its context",
        /toolResultCap: limits\.toolResultCap/.test(src));
}

/* ------------------------------------------- catalogue metadata is retained --- */
// probe() used to be `.map(m => m.id)`. Everything below depends on it keeping
// the rest, so assert the SHAPE the rest of the app now relies on.
{
    const src = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"), "utf8");
    check("discovery keeps context_length from the endpoint",
        /context_length/.test(src));
    check("discovery keeps the endpoint's published pricing",
        /pricing/.test(src) && /input_tokens/.test(src));
    check("connect() teaches those rates to the cost model",
        /tokenCost\.learnRate/.test(src));
    check("models carry contextLength through to the endpoint record",
        /contextLength: info\.contextLength/.test(src));
    check("`models` stays an array of id strings for existing callers",
        /models: entries\.map\(e => e\.id\)/.test(src));
}

/* ---------------------------------------------------- non-chat models are out --- */
// A catalogue this size is mostly not chat models. Selecting an embedding model
// as the driver produces a session that fails on its first message.
{
    const cat = [
        { id: "deepseek-ai/DeepSeek-V4-Pro", contextLength: 1048576,
          description: "MoE model built for advanced reasoning, coding, and long-running agent tasks." },
        { id: "BAAI/bge-large-en-v1.5", contextLength: 512,
          description: "BGE embedding model that maps text to a dense vector." },
        { id: "black-forest-labs/FLUX-2-dev", contextLength: null,
          description: "A rectified flow transformer for text-to-image generation." },
        { id: "ResembleAI/chatterbox-turbo", contextLength: null,
          description: "A text-to-speech model for expressive voice generation." },
        { id: "Sao10K/L3.1-70B-Euryale-v2.2", contextLength: 8192,
          description: "A 70B roleplay and companion finetune." },
        { id: "meta-llama/Llama-4-Maverick", contextLength: 131072,
          description: "Instruction-tuned chat and coding model." }
    ];
    const ids = cat.map(c => c.id);

    check("an embedding model is not offered as a chat model",
        cloudModels.isChatCapable("BAAI/bge-large-en-v1.5", cat) === false);

    // EVERY ONE OF THESE IS A REAL ID FROM THE LIVE DEEPINFRA CATALOGUE that
    // slipped through an earlier version of this filter. Each names the signal
    // that was missing.
    for (const [id, why] of [
        ["intfloat/multilingual-e5-large",  "e5 is an embedding family; the name says nothing"],
        ["ResembleAI/chatterbox-turbo",     "TTS; neither the name nor the blurb says so"],
        ["bosonai/HiggsAudioV2.5",          "audio model"],
        ["shibing624/text2vec-base-chinese","text2vec; declares a 1k window"],
        ["black-forest-labs/FLUX.1-Kontext-dev", "image editing; blurb avoided every keyword"],
        ["openai/whisper-large-v3",         "speech recognition"],
        ["Qwen/Qwen3-ASR-1.7B",             "ASR"],
        ["sentence-transformers/clip-ViT-B-32", "a multimodal encoder, not a chat model"],
        ["Wan-AI/Wan2.6-T2V",               "text-to-video; the T2V suffix is the only tell"],
        ["Pixverse/Pixverse-6-T2V",         "text-to-video"],
        ["ByteDance/Seedream-4",            "image generation"],
        ["meta-llama/Llama-Guard-4-12B",    "a safety classifier: answers, but not conversationally"],
        ["sesame/csm-1b",                   "conversational SPEECH model, not a chat model"],
        ["mistralai/Voxtral-Mini-3B-2507",  "audio"]
    ]) {
        check(`hidden from the chat picker — ${id.split("/").pop()} (${why})`,
            cloudModels.isChatCapable(id) === false);
    }

    // ...and the models a user actually came for are NOT hidden. This is the
    // direction that matters more: over-filtering silently removes the thing
    // they paid for.
    for (const id of [
        "deepseek-ai/DeepSeek-V4-Pro", "deepseek-ai/DeepSeek-V4-Flash",
        "deepseek-ai/DeepSeek-R1-0528", "deepseek-ai/DeepSeek-V3.1-Terminus",
        "meta-llama/Llama-4-Maverick", "Qwen/Qwen3.5-397B-A17B",
        "zai-org/GLM-5.2", "google/gemini-2.5-pro",
        "moonshotai/Kimi-K2-Instruct", "mistralai/Mistral-Small-3.2-24B-Instruct-2506"
    ]) {
        check(`still offered — ${id.split("/").pop()}`,
            cloudModels.isChatCapable(id) === true);
    }

    // A tiny declared window is the strongest signal there is: a published
    // number, not a word anyone chose.
    check("a model declaring a 1k window is not a chat model whatever it is called",
        cloudModels.isChatCapable("some-vendor/friendly-sounding-name",
            [{ id: "some-vendor/friendly-sounding-name", contextLength: 1024, description: "" }]) === false);
    check("...but 128k is fine",
        cloudModels.isChatCapable("some-vendor/friendly-sounding-name",
            [{ id: "some-vendor/friendly-sounding-name", contextLength: 131072, description: "" }]) === true);
    check("an image model is not offered as a chat model",
        cloudModels.isChatCapable("black-forest-labs/FLUX-2-dev", cat) === false);
    check("a TTS model is not offered as a chat model",
        cloudModels.isChatCapable("ResembleAI/chatterbox-turbo", cat) === false);
    check("a real chat model is offered",
        cloudModels.isChatCapable("deepseek-ai/DeepSeek-V4-Pro", cat) === true);

    const picked = cloudModels.pickDefaultModel(ids, cat);
    check("the default pick is a chat model with a long window",
        picked === "deepseek-ai/DeepSeek-V4-Pro", picked);
    check("a roleplay finetune never wins on size alone",
        picked !== "Sao10K/L3.1-70B-Euryale-v2.2", picked);

    // The bug this specifically catches: pickDefaultModel and isChatCapable
    // once used two different regexes, and an image model came back as the
    // default from a catalogue where every entry had already been rejected.
    const nonChat = ids.filter(id => !cloudModels.isChatCapable(id, cat));
    check("a catalogue with no chat model at all returns null, not the least-bad one",
        cloudModels.pickDefaultModel(nonChat, cat) === null,
        cloudModels.pickDefaultModel(nonChat, cat));

    // Context length must be able to beat a name heuristic: a model whose name
    // says nothing but whose window is huge is the better agent driver.
    check("published context outranks name guessing",
        cloudModels.pickDefaultModel(
            ["meta-llama/Llama-4-Maverick", "Sao10K/L3.1-70B-Euryale-v2.2"], cat)
            === "meta-llama/Llama-4-Maverick");
}

/* ------------------------------------------------------- learned rates -------- */
{
    // A host quoting per-token instead of per-million would be off by 1e6 and
    // show a $2,600 cost meter for one message. Refuse the implausible.
    check("an absurd rate is refused rather than displayed",
        tokenCost.learnRate("test/absurd-model", 1_300_000, 2_600_000) === false);
    check("a negative rate is refused",
        tokenCost.learnRate("test/negative-model", -1, 2) === false);
    check("a sane rate is accepted",
        tokenCost.learnRate("test/sane-model", 1.3, 2.6) === true);

    const r = tokenCost.rateFor("test/sane-model");
    check("a learned rate is reported as coming from the endpoint",
        !!r && r.source === "endpoint" && r.in === 1.3 && r.out === 2.6, r);

    // The user's own number is a decision. Relinking must not discard it.
    tokenCost.setRate("test/sane-model", { in: 9, out: 9 });
    check("a user override wins over the endpoint's published rate",
        tokenCost.rateFor("test/sane-model").source === "user");
    check("relearning does NOT overwrite a rate the user set by hand",
        tokenCost.learnRate("test/sane-model", 1.3, 2.6) === false);
    check("...and the user's number survives it",
        tokenCost.rateFor("test/sane-model").in === 9);

    tokenCost.setRate("test/sane-model", null);          // clean up after ourselves
    check("clearing the override falls back to the endpoint's rate",
        tokenCost.rateFor("test/sane-model").source === "endpoint");
}

console.log(`\n${pass}/${pass + fail} remote-agent-limits checks passed`);
process.exit(fail ? 1 : 0);
