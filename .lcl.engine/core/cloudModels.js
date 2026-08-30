const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");

/*
 * DNS THAT CANNOT BE STARVED BY SOMETHING ELSE.
 *
 * Node's dns.lookup() is getaddrinfo on libuv's THREAD POOL — four threads by
 * default, shared with fs and crypto. Any four lookups that hang take the
 * whole process's name resolution with them, and every later request waits
 * without ever opening a socket.
 *
 * Measured: four lookups to unroutable names, then one to api.deepinfra.com —
 * 22,006 ms for a name that resolves in 11 ms on an idle process. That is
 * exactly the symptom a refresh reported (DNS never resolved, socket assigned,
 * no lookup event, dead at the 7 s cap) and why chat "sits there forever" and
 * then answers.
 *
 * dns.resolve4/6 is c-ares: real async I/O on the event loop, no pool, no
 * starvation. It is tried first. It does NOT read the hosts file and does not
 * do mDNS, so getaddrinfo remains the fallback for LAN and .local names — the
 * fallback can still be slow, but it is no longer the only road.
 */
function lookupOffThreadPool(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    const opts = options || {};
    const done = (err, addr, fam) => {
        if (opts.all) callback(err, err ? undefined : [{ address: addr, family: fam }]);
        else callback(err, addr, fam);
    };
    // an address needs no resolving at all
    const lit = net.isIP(hostname);
    if (lit) return process.nextTick(() => done(null, hostname, lit));

    const wantV6 = opts.family === 6;
    const resolver = wantV6 ? dns.resolve6 : dns.resolve4;
    let settled = false;
    // c-ares can also hang on a dead resolver; cap it and fall through rather
    // than inheriting the very problem this exists to avoid
    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        dns.lookup(hostname, opts.all ? { ...opts, all: true } : opts, callback);
    }, 4000);
    if (timer.unref) timer.unref();
    resolver(hostname, (err, addrs) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!err && addrs && addrs.length) return done(null, addrs[0], wantV6 ? 6 : 4);
        // no A record, NXDOMAIN, or c-ares cannot answer (hosts file, mDNS):
        // the OS resolver is the one that knows
        dns.lookup(hostname, opts.all ? { ...opts, all: true } : opts, callback);
    });
}
const publicDns = require("./publicDns");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const paths = require("./paths");
const contextFit = require("./contextFit");
const secretGuard = require("./secretGuard");
const { ToolError } = require("./fsTools");
const { createThinkSplitter } = require("./thinkStream");
const tokenCost = require("./tokenCost");

/**
 * BRING YOUR OWN ENDPOINT.
 *
 * .lcl is a local product and nothing here changes that: no key ships, no
 * account is required, no endpoint is preconfigured, and with nothing linked
 * this module is inert. It is a FEATURE — the user links their own server or
 * their own API key, to whatever model they chose and paid for. DeepSeek R1 70B
 * on a serverless host, a llama.cpp server on the workstation in the next room,
 * an Ollama box on the LAN, anything that speaks the OpenAI chat protocol.
 *
 * WHY THE KEY IS STORED HERE AND HOW.
 *
 * A previous version of this file refused to store a key at all and required an
 * environment variable. That is not a feature anyone can use: "link my key"
 * means a field you paste into, not a reboot and a system setting. So keys are
 * stored, and stored properly:
 *
 *   - encrypted with Electron safeStorage, which is DPAPI on Windows and the
 *     Keychain on macOS — the ciphertext is bound to the OS user account, so
 *     copying the file to another machine yields nothing
 *   - in the user data directory, never the repo, and that directory is
 *     git-ignored
 *   - written 0600 where the platform honours it
 *   - never returned upward: every read path reports hasKey, a boolean
 *   - scrubbed out of every error, log line and audit record this module emits
 *
 * If safeStorage is unavailable (a headless test, a Linux box with no keyring)
 * the key is NOT written in the clear. It is held for the session only and the
 * UI says so, because a plaintext key on disk is exactly the thing the
 * product must never do.
 */

const KEYS_FILE = "cloud-endpoints.json";
const CFG_KEY = "cloudModel";               // which endpoint+model is selected

// The window to credit a LOCAL node's model with when nothing publishes one.
// Ollama's /v1/models returns bare ids — no context, no max tokens, no prices —
// and with no number there router.limits() falls to REMOTE_FLOOR, the cautious
// shape meant for an unknown host, on a machine sitting on your own network.
// 32k is the default num_ctx territory every current local build ships in and
// is stated as an assumption, never as something the host published.
const LOCAL_ASSUMED_CONTEXT = 32768;

// Presets, so linking DeepSeek is two fields instead of six. Prices are the
// provider's published per-million-token rates, shown so the choice is informed.
// WHERE YOUR PROMPTS PHYSICALLY GO is a property of the HOST, not the model.
// The DeepSeek weights are open; DeepInfra, Together and Fireworks serve them
// from the US. api.deepseek.com is DeepSeek's own infrastructure in China. That
// distinction was never surfaced to the user and it should have been the
// first thing said — for anyone whose prompts carry client or confidential data
// it decides the choice outright. Every preset now states it.
/* ======================================= OPENCODE'S PUBLISHED PRICES
 *
 * Per-model rates were needed for BOTH the Zen and GO products, and neither
 * was present.
 *
 * They were never going to arrive on their own. OpenCode's /models endpoint
 * publishes id, object, created and owned_by — checked live, both products —
 * and NO pricing at all. The catalogue scraper reads DeepInfra's
 * metadata.pricing shape, which OpenCode does not emit, so learnRate was never
 * called for a single OpenCode model and every rate table read empty.
 *
 * These are read off opencode.ai/docs/zen, in dollars per MILLION tokens, and
 * they apply to BOTH products: GO is the same catalogue drawn against a dollar
 * window rather than a balance, which is exactly why the window meter needs
 * them — without a price, spend cannot be counted against $12.
 *
 * Free tiers are recorded as 0/0 deliberately: "free" is a price, and a table
 * that omits it is indistinguishable from one that does not know.
 */
const OPENCODE_RATES = {
    /* THE IDS ARE THE PROVIDER'S, CHARACTER FOR CHARACTER.
     *
     * The first version of this table wrote "gemini-3-6-flash" and "grok-4-6",
     * converting the dots to dashes the way the claude ids happen to be
     * written. The provider serves "gemini-3.6-flash" and "grok-4.6". Those
     * keys matched nothing, which is exactly the reported symptom: some models
     * had rates for the new GO and Zen, but not all.
     *
     * Every key below was taken from a live /models listing of the two
     * endpoints, not from the docs page and not from memory. The prices come
     * from opencode.ai/docs/zen, in dollars per MILLION tokens, base tier where
     * a model is tiered. A model the provider serves but does not price is left
     * OUT deliberately — an absent rate reports "unknown", and a guessed one
     * reports a number that is wrong.
     */
    /* --- Anthropic ------------------------------------------------------ */
    "claude-fable-5": [10.00, 50.00],
    "claude-opus-5": [5.00, 25.00],   "claude-opus-4-8": [5.00, 25.00],
    "claude-opus-4-7": [5.00, 25.00], "claude-opus-4-6": [5.00, 25.00],
    "claude-opus-4-5": [5.00, 25.00],
    "claude-sonnet-5": [2.00, 10.00], "claude-sonnet-4-6": [3.00, 15.00],
    "claude-sonnet-4-5": [3.00, 15.00], "claude-sonnet-4": [3.00, 15.00],
    "claude-haiku-4-5": [1.00, 5.00],
    /* --- OpenAI --------------------------------------------------------- */
    "gpt-5.6-sol": [5.00, 30.00], "gpt-5.6-terra": [2.00, 12.00],
    "gpt-5.6-luna": [0.20, 1.20],
    "gpt-5.5": [5.00, 30.00], "gpt-5.5-pro": [30.00, 180.00],
    "gpt-5.4": [2.50, 15.00], "gpt-5.4-pro": [30.00, 180.00],
    "gpt-5.4-mini": [0.75, 4.50], "gpt-5.4-nano": [0.20, 1.25],
    "gpt-5.3-codex": [1.75, 14.00], "gpt-5.3-codex-spark": [1.75, 14.00],
    "gpt-5.2": [1.75, 14.00], "gpt-5.2-codex": [1.75, 14.00],
    "gpt-5.1": [1.07, 8.50], "gpt-5.1-codex": [1.07, 8.50],
    "gpt-5.1-codex-max": [1.25, 10.00], "gpt-5.1-codex-mini": [0.25, 2.00],
    "gpt-5": [1.07, 8.50], "gpt-5-codex": [1.07, 8.50],
    "gpt-5-nano": [0.05, 0.40],
    /* --- Google (dots, not dashes) -------------------------------------- */
    "gemini-3.6-flash": [1.50, 7.50], "gemini-3.5-flash": [1.50, 9.00],
    "gemini-3.5-flash-lite": [0.30, 2.50], "gemini-3.1-pro": [2.00, 12.00],
    "gemini-3-flash": [0.50, 3.00],
    /* --- xAI (dots, not dashes) ----------------------------------------- */
    "grok-4.6": [2.00, 6.00], "grok-4.5": [2.00, 6.00],
    "grok-build-0.1": [1.00, 2.00],
    /* --- the open-weight families, served by BOTH products -------------- */
    "deepseek-v4-pro": [1.74, 3.48], "deepseek-v4-flash": [0.14, 0.28],
    "glm-5.2": [1.40, 4.40], "glm-5.1": [1.40, 4.40], "glm-5": [1.00, 3.20],
    "minimax-m3": [0.30, 1.20], "minimax-m2.7": [0.30, 1.20],
    "minimax-m2.5": [0.30, 1.20],
    "kimi-k3": [3.00, 15.00], "kimi-k2.7-code": [0.95, 4.00],
    "kimi-k2.6": [0.95, 4.00], "kimi-k2.5": [0.60, 3.00],
    "qwen3.7-max": [2.50, 7.50], "qwen3.7-plus": [0.40, 1.60],
    "qwen3.6-plus": [0.50, 3.00], "qwen3.5-plus": [0.20, 1.20],
    /* --- free, priced as free rather than left unknown ------------------ */
    "big-pickle": [0, 0], "deepseek-v4-flash-free": [0, 0],
    "mimo-v2.5-free": [0, 0], "hy3-free": [0, 0],
    "laguna-s-2.1-free": [0, 0], "nemotron-3-ultra-free": [0, 0],
    "nemotron-3.5-lightning-free": [0, 0]
    /* NOT PRICED, because the provider does not publish one: qwen3.8-max,
     * mimo-v2-pro, mimo-v2-omni, mimo-v2.5-pro, mimo-v2.5, hy3, hy3-preview.
     * They report "unknown", which is true, rather than a number that is not. */};

/**
 * Teach the cost layer every price a preset publishes.
 *
 * Called when an endpoint of that preset is linked or healed. learnRate
 * refuses to overwrite a rate the operator set themselves, so this can run as
 * often as it likes.
 */
/* Which preset tables have already been taught, this process. */
const seededPresets = new Set();

function seedPresetRates(preset, force) {
    if (!preset || !preset.rates) return 0;
    /* ONCE PER PROCESS, NOT ONCE PER LOOKUP.
     *
     * healKnownPresets runs inside endpoints(), and endpoints() is called by
     * cloudState, listModels and every picker refresh. Seeding from there
     * unguarded meant thirty-five learnRate calls on every one of those.
     * Measured consequence: the UI became so laggy it was unusable. Published
     * prices do not change while the app is running.
     */
    if (!force && seededPresets.has(preset.id)) return 0;
    seededPresets.add(preset.id);
    let seeded = 0;
    for (const [id, pair] of Object.entries(preset.rates)) {
        try { if (tokenCost.learnRate(id, pair[0], pair[1])) seeded++; }
        catch { /* a price is a courtesy; never break linking for one */ }
    }
    return seeded;
}


const PRESETS = [
    {
        // OpenCode GO (opencode.ai/docs/go): the $10/mo subscription. Per the
        // published docs GO is its OWN provider with its OWN base URL —
        // opencode.ai/zen/go/v1 — and its own /models catalog (~18-25 open
        // coding models), distinct from Zen pay-per-token at
        // opencode.ai/zen/v1. The opencode client itself lists them as two
        // separate providers. plan: "go-window" is what tells the usage meter
        // this endpoint is metered in the plan's dollar windows
        // ($12/5h · $30/wk · $60/mo) — per-token vendors have no plan and
        // get no meter.
        id: "zen-go", label: "OpenCode GO",
        // ONE ACCOUNT, TWO PRODUCTS. Zen and GO are separate endpoints with
        // separate terms and separate keys, and they are BOTH OpenCode — so
        // the picker nests them under it rather than standing them beside each
        // other as if they were unrelated vendors.
        providerFamily: "opencode", providerFamilyLabel: "OpenCode",
        // inside the OpenCode folder the child is "GO", not "OpenCode GO" —
        // repeating the family in every child is the confusion this nesting
        // fixes: one OpenCode entry in the menu that expands to GO and Zen
        // when clicked
        shortLabel: "GO",
        rates: OPENCODE_RATES,
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiPrefix: "",
        docs: "opencode.ai/docs/go", needsKey: true,
        plan: "go-window",
        models: []
    },
    {
        // OpenCode Zen (opencode.ai/docs/zen): the pay-per-token gateway —
        // ~60 curated models, credits-funded, OpenAI-compatible. Functions
        // like any other provider; no plan, no window meter.
        id: "zen", label: "OpenCode Zen",
        providerFamily: "opencode", providerFamilyLabel: "OpenCode",
        shortLabel: "Zen",
        rates: OPENCODE_RATES,
        baseUrl: "https://opencode.ai/zen/v1",
        apiPrefix: "",
        docs: "opencode.ai/docs/zen", needsKey: true,
        models: []
    },
    {
        id: "deepinfra", label: "DeepInfra (US-hosted)",
        baseUrl: "https://api.deepinfra.com/v1/openai",
        apiPrefix: "",              // its base ALREADY includes the OpenAI root
        docs: "deepinfra.com", needsKey: true, region: "United States",
        reasoningField: "reasoning_content",
        // Read from deepinfra.com on 2026-07-30, not recalled.
        models: [
            { id: "deepseek-ai/DeepSeek-V4-Pro", label: "DeepSeek V4 Pro",
              inputPerM: 1.30, outputPerM: 2.60, reasoning: true },
            { id: "deepseek-ai/DeepSeek-V4-Flash", label: "DeepSeek V4 Flash",
              inputPerM: 0.09, outputPerM: 0.18 },
            { id: "deepseek-ai/DeepSeek-V3.2", label: "DeepSeek V3.2",
              inputPerM: 0.26, outputPerM: 0.38 }
        ]
    },
    {
        id: "deepseek", label: "DeepSeek (hosted in China)",
        baseUrl: "https://api.deepseek.com", region: "China", apiPrefix: "/v1",
        docs: "platform.deepseek.com", needsKey: true,
        // DeepSeek streams chain-of-thought in its own field, not in <think>
        reasoningField: "reasoning_content",
        models: [
            { id: "deepseek-chat", label: "DeepSeek V3", inputPerM: 0.27, outputPerM: 1.10 },
            { id: "deepseek-reasoner", label: "DeepSeek R1", inputPerM: 0.55, outputPerM: 2.19,
              reasoning: true }
        ]
    },
    {
        id: "together", label: "Together AI (US-hosted)",
        baseUrl: "https://api.together.xyz", region: "United States",
        apiPrefix: "/v1",
        docs: "api.together.xyz", needsKey: true, reasoningField: null,
        models: [
            { id: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
              label: "DeepSeek R1 Distill 70B", inputPerM: 2.00, outputPerM: 2.00,
              reasoning: true }
        ]
    },
    {
        id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api",
        docs: "openrouter.ai", needsKey: true, reasoningField: null, models: []
    },
    {
        id: "ollama", label: "Ollama (your machine or LAN)",
        baseUrl: "http://127.0.0.1:11434", docs: "ollama.com",
        needsKey: false, reasoningField: null, models: []
    },
    {
        id: "custom", label: "Any OpenAI-compatible server", baseUrl: "",
        docs: null, needsKey: false, reasoningField: null, models: []
    }
];

/* ------------------------------------------------------------- key storage */

function keysFile() { return path.join(paths.dataDir(), KEYS_FILE); }

function safeStorage() {
    try {
        const s = require("electron").safeStorage;
        return (s && typeof s.isEncryptionAvailable === "function"
                && s.isEncryptionAvailable()) ? s : null;
    } catch { return null; }
}

// Session-only fallback when the OS offers no encryption. Never persisted.
const memoryKeys = new Map();

function readStore() {
    try {
        const j = JSON.parse(fs.readFileSync(keysFile(), "utf8"));
        return (j && typeof j === "object" && j.endpoints) ? j : { endpoints: {} };
    } catch { return { endpoints: {} }; }
}

function writeStore(store) {
    const f = keysFile();
    const tmp = f + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, f);
    try { fs.chmodSync(f, 0o600); } catch { /* not all platforms */ }
}

/** Store a key for an endpoint. Returns how it ended up being held. */
function putKey(endpointId, key) {
    const k = String(key || "").trim();
    if (!k) { return clearKey(endpointId); }
    const ss = safeStorage();
    if (!ss) {
        // No OS encryption: hold it for this session only. A plaintext key on
        // disk is not an acceptable fallback.
        memoryKeys.set(endpointId, k);
        return { stored: "session", encrypted: false };
    }
    const store = readStore();
    store.endpoints[endpointId] = store.endpoints[endpointId] || {};
    store.endpoints[endpointId].key = ss.encryptString(k).toString("base64");
    writeStore(store);
    memoryKeys.set(endpointId, k);
    return { stored: "disk", encrypted: true };
}

function getKey(endpointId) {
    if (memoryKeys.has(endpointId)) return memoryKeys.get(endpointId);
    const enc = (readStore().endpoints[endpointId] || {}).key;
    if (!enc) return null;
    const ss = safeStorage();
    if (!ss) return null;
    try {
        const k = ss.decryptString(Buffer.from(enc, "base64"));
        memoryKeys.set(endpointId, k);
        return k;
    } catch { return null; }   // written by a different OS user or machine
}

function clearKey(endpointId) {
    memoryKeys.delete(endpointId);
    const store = readStore();
    if (store.endpoints[endpointId]) {
        delete store.endpoints[endpointId].key;
        if (!Object.keys(store.endpoints[endpointId]).length) delete store.endpoints[endpointId];
        writeStore(store);
    }
    return { stored: "none", encrypted: false };
}

/** Strip a key out of anything before it reaches a log, a UI or a session. */
function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key && key.length >= 8) s = s.split(key).join("[key redacted]");
    for (const k of memoryKeys.values()) {
        if (k && k.length >= 8) s = s.split(k).join("[key redacted]");
    }
    return s.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1[redacted]")
            .replace(/\b(sk|sk-or|sk-ant|hf)[-_][A-Za-z0-9._\-]{12,}/gi, "[key redacted]");
}

/* -------------------------------------------------------------- endpoints */

/** User-linked endpoints. Keys are NEVER included — only hasKey. */
/**
 * HEAL WHAT WAS ALREADY FILED AS "custom".
 *
 * presetForBase teaches connect() to recognise a known product. It does not
 * help the endpoints already in the store, and telling the operator to delete
 * and re-add two subscriptions he has just pasted keys into is not a fix —
 * especially when the keys are the part he cannot get back.
 *
 * So an endpoint whose address IS a known preset adopts that preset's identity
 * on the way past: its name, and its plan when it has one and the record does
 * not. Only fields that are absent or literally the hostname are touched, so a
 * name the operator typed himself is never overwritten. Idempotent, and it
 * writes only when something actually changed.
 */
function healKnownPresets(store) {
    let changed = false;
    for (const [id, v] of Object.entries(store.endpoints || {})) {
        if (!v || !v.baseUrl || v.localNode) continue;
        const known = presetForBase(v.baseUrl);
        if (!known) continue;
        let host = "";
        try { host = new URL(v.baseUrl).hostname.toLowerCase(); } catch { }
        // only a name nobody chose: absent, the id, or the bare hostname
        const unnamed = !v.label || v.label === id ||
                        String(v.label).toLowerCase() === host;
        if (unnamed && v.label !== known.label) { v.label = known.label; changed = true; }
        if ((!v.preset || v.preset === "custom") && v.preset !== known.id) {
            v.preset = known.id; changed = true;
        }
        if (known.plan && !v.plan) { v.plan = known.plan; changed = true; }
        // the provider publishes no prices over the wire, so a recognised
        // preset teaches them here — otherwise every rate table reads empty
        // and the plan meter has no dollars to count
        try { seedPresetRates(known); } catch { }
    }
    return changed;
}

function endpoints() {
    const store = readStore();
    // a store written before presets were recognised is corrected once, here,
    // rather than leaving the user to delete and re-paste their keys
    try { if (healKnownPresets(store)) writeStore(store); } catch { }
    const cfg = config();
    return Object.entries(store.endpoints)
        .filter(([, v]) => v.baseUrl)
        .map(([id, v]) => ({
            id, label: v.label || id, baseUrl: v.baseUrl,
            preset: v.preset || "custom",
            // the product family this endpoint belongs to, when it is one of a
            // set — read off the preset so nothing has to infer it from a name
            ...(() => {
                const p = PRESETS.find(x => x.id === (v.preset || ""));
                return p && p.providerFamily
                    ? { providerFamily: p.providerFamily,
                        providerFamilyLabel: p.providerFamilyLabel || p.providerFamily,
                        // what this endpoint is called INSIDE its family folder
                        shortLabel: p.shortLabel || null }
                    : {};
            })(),
            reasoningField: v.reasoningField || null,
            // the wire shape probed at link time ("ollama" rejects unknown body
            // fields; "openai" tolerates them)
            shape: v.shape || null,
            // WHAT THIS ENDPOINT TURNED OUT TO BE ABLE TO DO, and which model
            // does the drawing. Both were WRITTEN to the store and neither was
            // projected out of it, so imageRemote.viaApi — whose gate reads
            // exactly these two — could never find a target: the entire API
            // tier of image generation was unreachable code.
            capabilities: Array.isArray(v.capabilities) ? v.capabilities : [],
            imageModel: v.imageModel || null,
            // "" is a VALID prefix (DeepInfra: its base already ends /v1/openai).
            // `|| "/v1"` silently rewrote it and produced a 404 on every call.
            apiPrefix: v.apiPrefix === undefined ? "/v1" : v.apiPrefix,
            // A CURATED LIST THAT CAME BACK EMPTY IS NOT AN EMPTY PROVIDER.
            //
            // `models` is written by a refresh; `allModels` is everything the
            // endpoint reported. A refresh that half-failed (network down
            // mid-call, catalogue fetch refused) wrote models: [] while
            // allModels kept all 179 — and the picker then showed the provider
            // with nothing under it. Reported symptom: the provider showed no
            // linked models, on a store that still held the key
            // and all 179 ids. Falling back keeps the endpoint usable until
            // the next successful refresh re-curates it.
            models: (v.models && v.models.length) ? v.models
                : (v.allModels || []).map(id => (typeof id === "string" ? { id } : id)),
            allModels: v.allModels || [],
            // A NODE IS NOT A VENDOR. Set when the endpoint was linked through
            // the Nodes panel — a machine the user added by name, owns, and
            // pays the power bill for. Everything downstream that would
            // otherwise treat it as a paid API reads this: the agent loop's
            // budget, the cost meter, the ledger.
            localNode: !!v.localNode,
            // WHICH SEAT: "chat" is selectable as the session model, "fleet"
            // is what agents run on and is never offered as a thing to talk to.
            nodeRole: v.nodeRole || null,
            nodeStack: v.nodeStack || null,
            node: v.node || null,
            rented: !!v.rented,
            provider: v.provider || null,
            // the billing shape rides with the endpoint: "go-window" is what
            // turns the dollar-window meter on, and the UI badges the card
            // with it — a metered plan the operator cannot see is a bill the
            // operator cannot predict
            plan: v.plan || null,
            // THE DOOR: an authenticated HTTPS route to the same machine that
            // survives full-tunnel VPNs, because it is ordinary web traffic.
            // Transport only — baseUrl stays the machine's direct address and
            // remains the identity everything else keys on.
            relayUrl: v.relayUrl || null,
            hasKey: !!getKey(id),
            keyEncrypted: !!(store.endpoints[id] || {}).key,
            // CONTRACT K4 — IS THAT MACHINE THERE? Carried on the record so the
            // picker can grey the row without dialling anything. The verdict is
            // whatever the last real attempt learned, and it lapses; see
            // endpointHealth. `offlineReason` is a sentence, because "offline"
            // with no reason is the thing the operator cannot act on.
            ...(() => {
                const h = endpointHealth(id);
                return { offline: h.offline, offlineReason: h.offlineReason };
            })(),
            selected: cfg.endpointId === id
        }));
}

/** Is this endpoint a machine the user owns, linked through the Nodes panel? */
/** Is this endpoint id a FREE machine the operator owns? (never a rented GPU) */
function endpointIsFreeNode(id) {
    const rec = readStore().endpoints[String(id || "")];
    return !!(rec && rec.localNode && !rec.rented);
}

/**
 * The first FREE fleet seat in the store — owned, never rented, linked as
 * "fleet". Store read only: safe at prompt-build, no network. Prefers a
 * seat the health map does not currently mark offline, so discovery dials
 * a live machine first. It is exactly the free-node test the money gate
 * already trusts, narrowed to the fleet seat.
 */
function freeFleetEndpoint() {
    const all = Object.entries(readStore().endpoints)
        .filter(([, v]) => v && v.baseUrl && v.localNode && !v.rented
                        && v.nodeRole === "fleet")
        .map(([id, v]) => ({ id, label: v.label || id }));
    if (!all.length) return null;
    const live = all.find(e => {
        try { return !endpointHealth(e.id).offline; } catch { return true; }
    });
    return live || all[0];
}

function isNodeEndpoint(ep) {
    // A RENTED GPU IS NOT A MACHINE YOU OWN, however similar it looks.
    //
    // It arrives with the same shape as a node — an address, a model list, an
    // OpenAI surface, often a relay — and every instinct in this file wants to
    // treat it as one. That instinct is the bug: node-ness is what suppresses
    // the cost meter, relaxes the secrets warning to "your own hardware", and
    // grants fifteen minutes of first-token patience because the user's own
    // disk is slow. All three are wrong for a box somebody else administers.
    // So `rented` is checked FIRST and short-circuits, before any other signal.
    if (ep && ep.rented) return false;
    return !!(ep && (ep.localNode || (ep.node && ep.node.id)));
}

/** A GPU rented by the hour: somebody else's hardware, billed. */
function isRentedEndpoint(ep) { return !!(ep && ep.rented); }

/**
 * WHERE THE WORDS ACTUALLY GO.
 *
 * A permission about sensitive data is meaningless as "may the model see it".
 * Every model can see it — that is what a prompt is. The only question that
 * matters is whether it LEAVES hardware the operator controls, and that is a
 * property of the endpoint, not of the model:
 *
 *   this-computer  loopback — the words never cross a network card
 *   your-machine   a node linked in Connections: the user's own hardware,
 *                  reached over their own mesh
 *   third-party    somebody else's servers, with somebody else's logs, and no
 *                  way to take it back
 *
 * Stated as: "if the local model can do it, the api model should definitely be
 * able to do it" — true about CAPABILITY, which is why the switch exists at
 * all; and the reason the switch still has to name the destination.
 */
function destinationOf(ep) {
    const host = (() => {
        try { return new URL(ep.baseUrl).hostname; } catch { return String(ep.baseUrl || ""); }
    })();
    if (isNodeEndpoint(ep)) {
        const name = (ep.node && (ep.node.name || ep.node.host)) || ep.label || host;
        return { kind: "your-machine", host, label: `${name} — your machine`, owned: true };
    }
    if (isRentedEndpoint(ep)) {
        // NAMED IN THE WORDS THE PERMISSION UI WILL SAY. "a rented machine" is
        // not a softer way of saying third party — it is the same category with
        // the detail that makes it concrete, and `owned` stays false so every
        // downstream guard treats it as what it is.
        const who = (ep.provider || ep.label || host);
        return { kind: "third-party", host, rented: true, owned: false,
                 label: `${who} — a rented machine, not yours` };
    }
    if (isLocalHost(host)) {
        return { kind: "this-computer", host, label: "this computer", owned: true };
    }
    return { kind: "third-party", host, label: host, owned: false };
}

/** The destination of whichever endpoint currently drives a role. */
function destinationFor(role = "driver") {
    const s = selectedFor(role);
    return s ? destinationOf(s) : null;
}

/**
 * Attach (or refresh) a node endpoint's door — the VPN-proof route.
 * The URL is metadata; the door token is a credential and rides the same
 * OS-encrypted store as API keys, under its own id.
 */
function setNodeRelay(endpointId, url, token) {
    const store = readStore();
    if (!store.endpoints[endpointId]) return { ok: false, error: "no such endpoint" };
    store.endpoints[endpointId].relayUrl = String(url || "").replace(/\/+$/, "") || null;
    writeStore(store);
    if (token) putKey(endpointId + "::door", token);
    return { ok: true };
}

/**
 * Which endpoints go through their door first, and WHEN THAT WAS DECIDED.
 *
 * Set after a direct road fails once, so later messages in the same sitting
 * do not each pay the dead road's connect timeout. It EXPIRES, because the
 * condition that closed the road is temporary by nature — the VPN goes off,
 * the laptop comes home — and a preference held for the life of the process
 * would keep routing over the internet long after the direct path came back.
 * On expiry the next call quietly re-probes direct; if it is still dead, the
 * failover re-pins it for another interval.
 */
const doorFirst = new Map();
const DOOR_FIRST_TTL_MS = 120_000;

function preferDoor(id) {
    const at = doorFirst.get(id);
    if (!at) return false;
    if (Date.now() - at > DOOR_FIRST_TTL_MS) { doorFirst.delete(id); return false; }
    return true;
}

/**
 * THE SAME PREFERENCE, WRITTEN BY THE NODE MONITOR.
 *
 * The Connections poll dials the direct road every few seconds anyway, so it
 * learns "blocked" and "back" before any chat message pays to find out. It
 * records what it saw HERE — the one door-first map chat already reads —
 * rather than keeping a second opinion beside it that could disagree. A
 * monitor observation of a live direct road clears the preference at once,
 * so turning the VPN off needs no restart, no click, and no TTL to lapse.
 */
function noteDoorFirst(id) { doorFirst.set(id, Date.now()); }
function noteDirectAlive(id) { doorFirst.delete(id); }

/**
 * How long to wait for the DIRECT road before trying the door.
 *
 * A VPN that blackholes the tailnet does not refuse the connection, it drops
 * the packets — so the socket sits in SYN retry until the OS gives up (~21s
 * on Windows). Paying that on the first message of every session is the
 * difference between "it just works" and "it hangs, then works". When a door
 * is available the direct attempt gets a short leash instead, restored to
 * the full inactivity timeout the moment the response headers land, so a
 * long generation is never cut short.
 */
const DIRECT_PROBE_MS = 6000;

/**
 * WHAT THIS APP ASKED OF A MACHINE ON THE NETWORK, AND WHEN.
 *
 * "at some point today, whatever you did restarted my spark ... not sure when
 *  or why, because you have 0 telemetry."
 *
 * That was true and it is the real defect behind the question. The app could
 * open a stream to someone's own hardware, time it out, fall to a second route
 * and retry — and leave nothing on disk saying it had happened. When that
 * machine then misbehaved there was no way to tell whether this app was
 * involved, so the honest answer was a shrug.
 *
 * One line per outbound request to a node, appended locally, never sent
 * anywhere. Prompts and keys are NOT recorded — this is a record of the CALL,
 * not of the conversation: which endpoint, which model, which road, how long,
 * and how it ended. That is enough to answer "was it me, and when".
 */
const NODE_LOG_MAX = 4_000_000;                 // ~20k calls, then it rolls
function nodeLogPath() { return path.join(paths.dataDir(), "node-calls.jsonl"); }
function recordNodeCall(rec) {
    try {
        const f = nodeLogPath();
        try {
            if (fs.statSync(f).size > NODE_LOG_MAX) {
                fs.renameSync(f, f + ".1");        // one generation back, then gone
            }
        } catch { /* no file yet */ }
        fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
    } catch { /* telemetry must never break a turn */ }
}

/* API FAILURES WERE CAPTURED NOWHERE. node-calls.jsonl records owned
 * hardware only (logCall returns on !isNode), and the non-200 path rejected
 * without writing the provider's error at all — so a DeepInfra/OpenCode 400
 * vanished the instant it happened, with no way to capture it. "A broken
 * request schema on our side" and "the endpoint does not exist" cannot be told
 * apart without the provider's own words AND the SHAPE of what we sent. This
 * writes both (never the content), rotated small. */
function apiErrorLogPath() { return path.join(paths.dataDir(), "api-errors.jsonl"); }
function recordApiError(rec) {
    try {
        const f = apiErrorLogPath();
        try { if (fs.statSync(f).size > NODE_LOG_MAX) fs.renameSync(f, f + ".1"); } catch { /* no file yet */ }
        fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
    } catch { /* diagnostics must never break a turn */ }
}
function requestShape(messages, opts) {
    const roles = (messages || []).map(m =>
        m.role === "assistant" && Array.isArray(m.tool_calls) ? "assistant*"
        : m.role === "tool" ? "tool" : m.role);
    // count the exact schema features a strict provider rejects
    let nullContent = 0, toolMsgsNoId = 0, asstToolCalls = 0;
    for (const m of (messages || [])) {
        if ((m.content === null || m.content === undefined) && !(Array.isArray(m.tool_calls) && m.tool_calls.length)) nullContent++;
        if (m.role === "tool" && !m.tool_call_id) toolMsgsNoId++;
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) asstToolCalls++;
    }
    return {
        messageCount: (messages || []).length,
        roles: roles.join(","),
        toolsSent: !!(Array.isArray(opts.tools) && opts.tools.length && !opts.noTools),
        toolCount: Array.isArray(opts.tools) ? opts.tools.length : 0,
        stripEffort: !!opts.stripEffort,
        // the three schema hazards, counted so a bad request is legible at a glance
        nullContentMsgs: nullContent, toolMsgsMissingId: toolMsgsNoId, assistantToolCallMsgs: asstToolCalls
    };
}

/**
 * Is the model currently driving (or filling `role`) running on the user's own
 * node? The single question the cost meter, the ledger and router.limits() all
 * ask, answered in one place so they cannot disagree.
 */
function selectedIsNode(role = "driver") {
    try { return isNodeEndpoint(selectedFor(role)); } catch { return false; }
}

/**
 * Link an endpoint. The KEY is accepted here — that is the point of the
 * feature — and is immediately encrypted and separated from the metadata.
 */
/**
 * PASTES USED TO SHARE THE ONE "custom" SLOT. Old installs may still hold a
 * hosted endpoint under that id; the first time its ADDRESS is re-linked, the
 * whole record moves to its per-host id — encrypted key included, because it
 * is the same host and the same secret — and any role pinned to "custom"
 * follows it. Without this, a re-paste would orphan the old record as a
 * duplicate card holding a key nothing can reach.
 */
/* THE PATH IS PART OF THE ADDRESS. OpenCode serves Zen at opencode.ai/zen/v1
 * and GO at opencode.ai/zen/go/v1 — one host, two separate providers with two
 * separate catalogs (opencode.ai/docs/go). An id keyed on the host alone made
 * them ONE slot, so adding GO silently replaced Zen: the shared-slot bug
 * reborn one layer down. */
/**
 * WHICH PRESET IS THIS ADDRESS, IF ANY.
 *
 * A pasted endpoint was filed as `preset: "custom"` with `label: host`, always.
 * Two OpenCode subscriptions differ only by PATH — /zen/v1 and /zen/go/v1 — so
 * both came back as "opencode.ai" and the user could not tell which row in
 * the picker was which: two separately keyed OpenCode connections, Zen and GO,
 * both showing up under one indistinguishable "opencode.ai" entry.
 *
 * The confusion was ours. Worse than the name: GO is metered in its plan's
 * dollar windows ($12/5h · $30/wk · $60/mo) and that meter is switched on by
 * `plan: "go-window"`, which lives on the preset. Filed as custom, GO got no
 * plan, so the window meter never appeared and its rate table read empty.
 *
 * Matched on origin + path, both normalised, because those are the two things
 * that actually distinguish these two products.
 */
function presetForBase(baseUrl) {
    const norm = (u) => {
        try {
            const x = new URL(String(u));
            return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase();
        } catch { return ""; }
    };
    const want = norm(baseUrl);
    if (!want) return null;
    // EXACT, then MORE-SPECIFIC-THAN, then UNAMBIGUOUSLY-ABOVE.
    //
    // Exact-only was too strict to be useful: a user pastes what the
    // provider showed them, and that is not always the string in this table — a
    // trailing /chat/completions, /zen/go without /v1. A product that says it
    // recognises your subscription and then does not is worse than one that
    // never claimed to.
    //
    // But prefix matching in the other direction is a TRAP, and the first
    // version of this fell in it: /zen/go/v1 also lives under /zen, so a paste
    // of plain /zen matched GO — and so did a bare https://opencode.ai. Reading
    // "GO subscription, dollar windows" off an address that says no such thing
    // is the same defect this function exists to fix, wearing the fix as a
    // disguise. Measured, both of them, before this comment existed.
    //
    // So the two directions get different rules:
    //   the paste is AT OR BELOW a preset root  -> most specific root wins
    //   the paste is ABOVE preset roots         -> only when exactly ONE is
    //                                              under it; two is a guess
    const exact = PRESETS.find(p => p.baseUrl && norm(p.baseUrl) === want);
    if (exact) return exact;

    let below = null, belowLen = 0;
    const above = [];
    for (const p of PRESETS) {
        if (!p.baseUrl) continue;
        const base = norm(p.baseUrl);
        if (!base) continue;
        if (want.startsWith(base + "/")) {
            if (base.length > belowLen) { below = p; belowLen = base.length; }
        } else if (base.startsWith(want + "/")) {
            above.push(p);
        }
    }
    if (below) return below;
    /* AMBIGUOUS IS NOT THE SAME AS UNDECIDABLE.
     *
     * Refusing whenever more than one preset sat under the pasted path was too
     * blunt, and it produced the exact symptom: /zen/go matched GO
     * (one preset under it) while plain /zen matched NOTHING, because both
     * /zen/v1 and /zen/go/v1 live under it. So GO grouped and Zen stayed filed
     * as a bare hostname — GO grouped correctly, but Zen still sat under its
     * own separate opencode.ai menu.
     *
     * /zen is one segment short of /zen/v1 and two short of /zen/go/v1. The
     * nearer one is the answer, and it is not a guess: reaching GO from /zen
     * would mean inventing the "go" segment the operator did not type.
     *
     * Still bounded at ONE missing segment, so a bare origin — two short of
     * everything — resolves to nothing rather than to whichever product
     * happens to sort first. */
    const extra = (p) => {
        const base = norm(p.baseUrl);
        return base.slice(want.length).split("/").filter(Boolean).length;
    };
    const near = above.filter(p => extra(p) === 1);
    if (near.length === 1) return near[0];
    return above.length === 1 ? above[0] : null;
}

/* ONE MACHINE CAN RUN MORE THAN ONE ENGINE.
 *
 * A local node with more than one engine still showed only one of its models.
 *
 * An API endpoint was qualified by its path; a NODE endpoint was qualified by
 * nothing at all, so a node had exactly one slot. A node ran Ollama on 11434 with
 * ten models — mistral-large 123b down to gemma3:27b, about 460 GB — and
 * linking llama.cpp on 30000 wrote into the same id and took the entry with
 * it. The models were never gone from the Spark; the app forgot where they
 * were, which is worse, because it looked like loss.
 *
 * The port qualifies it now, exactly as the path qualifies an API. The old
 * `node-<host>` id is listed as a legacy slot at the migrate call below, so an
 * existing entry moves to its port-qualified id the first time it reconnects
 * and every session that named it follows via onRenamed.
 *
 * The DOOR key is deliberately untouched: `<node-host>::door` is a fact about
 * the machine, not about one of the services on it. */
function endpointIdFor(baseUrl, host, isNode) {
    const part = (which) => {
        try {
            const u = new URL(baseUrl);
            if (which === "path") {
                const p = u.pathname.replace(/\/+$/, "");
                return p && p !== "/" ? p.replace(/\//g, "-") : "";
            }
            return u.port ? `-${u.port}` : "";
        } catch { return ""; }
    };
    return isNode ? `node-${host}${part("port")}` : `api-${host}${part("path")}`;
}

/* A RENAME IS A RENAME EVERYWHERE, OR IT IS DATA LOSS.
 *
 * An endpoint's id is referenced from five places: the store record (with its
 * encrypted key, and a `<id>::door` sibling for a relay token), the global
 * roles, and — on every session file — modelSel, taskModels, akAuditor and
 * trustedEndpoints. Moving only the first two dropped live conversations onto
 * the local engine and left task assignments pointing at nothing.
 *
 * `onRenamed` is how the session layer is told; cloudModels owns no session
 * files and must not learn to.
 */
let onEndpointRenamed = null;
function setEndpointRenameHook(fn) { onEndpointRenamed = typeof fn === "function" ? fn : null; }

function migrateSharedSlot(newId, baseUrl, legacyIds = ["custom"]) {
    if (!newId) return;
    // THE ADDRESS IS THE SAME ADDRESS EVEN WHEN IT WAS TYPED DIFFERENTLY.
    // Exact string equality meant the heal never fired for the real store: a
    // record saved as "https://api.deepinfra.com/v1/openai" against a chip
    // that fills "api.deepinfra.com" are the same endpoint and did not match.
    const same = (a, b) => {
        if (!a || !b) return false;
        if (a === b) return true;
        try { return normaliseBase(a) === normaliseBase(b); } catch { return false; }
    };
    for (const legacy of legacyIds) {
        if (!legacy || legacy === newId) continue;
        const store = readStore();
        const old = store.endpoints && store.endpoints[legacy];
        if (!old || !same(old.baseUrl, baseUrl)) continue;
        // NEVER DESTROY A CREDENTIAL. When a record already stands at the new
        // id, the legacy one is folded in — its key is only dropped when the
        // destination already has one, and its models/plan fill any gap.
        if (!store.endpoints[newId]) {
            store.endpoints[newId] = { ...old };
        } else {
            const dst = store.endpoints[newId];
            if (!dst.key && old.key) dst.key = old.key;
            if (!(dst.models || []).length && (old.models || []).length) dst.models = old.models;
            if (!dst.plan && old.plan) dst.plan = old.plan;
            if (!dst.node && old.node) dst.node = old.node;
        }
        // the relay token rides on a sibling id and has to move with it
        const doorFrom = store.endpoints[legacy + "::door"];
        if (doorFrom && !store.endpoints[newId + "::door"]) {
            store.endpoints[newId + "::door"] = { ...doorFrom };
        }
        delete store.endpoints[legacy];
        delete store.endpoints[legacy + "::door"];
        writeStore(store);
        for (const [from, to] of [[legacy, newId], [legacy + "::door", newId + "::door"]]) {
            if (memoryKeys.has(from) && !memoryKeys.has(to)) {
                memoryKeys.set(to, memoryKeys.get(from));
            }
            memoryKeys.delete(from);
        }
        const cur = config();
        const roles = { ...(cur.roles || {}) };
        let moved = false;
        for (const r of Object.keys(roles)) {
            if (roles[r] && roles[r].endpointId === legacy) {
                roles[r] = { ...roles[r], endpointId: newId };
                moved = true;
            }
        }
        if (moved) paths.writeSettings({ [CFG_KEY]: { enabled: !!cur.enabled, roles } });
        // ...and every conversation that named it
        try { if (onEndpointRenamed) onEndpointRenamed(legacy, newId); } catch { }
    }
}

/* A MEASURED WINDOW OUTRANKS AN ASSUMED ONE, AND MUST SURVIVE THE REFRESH.
 *
 * After a restart the measured window was gone: the picker showed 32k again.
 *
 * The report was right and the write was real — the store held 262144 at 07:18
 * and 32768 (ASSUMED) again at 07:25. The app overwrote it. Every catalogue refresh
 * calls linkEndpoint with a freshly built `models` array, and modelRecords fills
 * contextLength from `assumeContext` — the flat LOCAL_ASSUMED_CONTEXT — for any
 * model whose host publishes no window. So the measurement was destroyed by the
 * next poll, every time, and healing it faster would only have lost the same
 * race more often.
 *
 * This file already carries FOUR facts through a relink for exactly this reason
 * — localNode, rented, nodeRole, plan — each with a comment saying a refresh
 * must not quietly reclassify something known. A measured context window is the
 * same kind of fact: llama.cpp said 262144 out of its own /props, and no amount
 * of re-polling a catalogue that publishes no window makes 32768 truer.
 *
 * Only MEASURED values are kept (contextAssumed unset). An assumption never
 * outranks anything, and a host that starts publishing a real window overwrites
 * this on its next answer — which is the one case where the new number wins.
 */
function keepMeasuredWindows(incoming, previous) {
    if (!Array.isArray(incoming) || !incoming.length) return incoming;
    const measured = new Map();
    for (const m of (Array.isArray(previous) ? previous : [])) {
        if (m && m.id && !m.contextAssumed && Number(m.contextLength) > 0) {
            measured.set(String(m.id), Number(m.contextLength));
        }
    }
    if (!measured.size) return incoming;
    return incoming.map(m => {
        if (!m || !m.id) return m;
        const known = measured.get(String(m.id));
        // an incoming record that carries its OWN measured figure wins: the host
        // has started publishing, and that is newer truth than anything stored
        if (!known || (Number(m.contextLength) > 0 && !m.contextAssumed)) return m;
        const out = { ...m, contextLength: known };
        delete out.contextAssumed;
        return out;
    });
}

function linkEndpoint({ id, label, baseUrl, preset, key, models, reasoningField,
                        apiPrefix, localNode, node, rented, provider, plan,
                        shape, nodeRole, nodeStack } = {}) {
    const pre = PRESETS.find(p => p.id === preset) || null;
    const url = String(baseUrl || (pre && pre.baseUrl) || "").trim().replace(/\/+$/, "");
    if (!url) throw new ToolError("an endpoint needs a base URL, e.g. https://api.deepinfra.com");
    let parsed;
    try { parsed = new URL(url); } catch { throw new ToolError(`not a valid URL: ${url}`); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ToolError("only http and https endpoints are supported");
    }
    // http is allowed ONLY for a server on this machine or the local network —
    // that is the "link my own server" case. A public host over plain http would
    // put the key and every prompt on the wire in the clear.
    if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname)) {
        throw new ToolError(
            `${parsed.hostname} is not on your machine or local network, so http would send ` +
            "your key and your prompts unencrypted — use https for a public endpoint");
    }

    const epId = String(id || preset || parsed.hostname).replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
    const store = readStore();
    const prev = store.endpoints[epId] || {};
    store.endpoints[epId] = {
        ...(store.endpoints[epId] || {}),
        label: String(label || (pre && pre.label) || parsed.hostname).slice(0, 60),
        baseUrl: url,
        preset: preset || "custom",
        reasoningField: reasoningField !== undefined
            ? reasoningField : (pre ? pre.reasoningField : null),
        // a window this app MEASURED off the engine survives the refresh that
        // would otherwise replace it with a flat assumption — see above
        models: Array.isArray(models) && models.length
            ? keepMeasuredWindows(models.slice(0, 200), prev.models)
            : (pre ? pre.models : []),
        // Which path this host roots its OpenAI surface at, discovered by
        // probing rather than assumed. DeepInfra is /v1/openai, DeepSeek is /v1.
        apiPrefix: apiPrefix !== undefined ? apiPrefix
                 : (store.endpoints[epId] || {}).apiPrefix || (pre && pre.apiPrefix) || "/v1",
        // A MACHINE THE USER OWNS, NOT A VENDOR THEY BUY FROM.
        //
        // Set once, by the Nodes panel, and then relied on by three separate
        // places that would otherwise each have to guess: the agent loop's
        // budget (no per-token cost, so the only ceiling is the node's RAM),
        // the cost meter ($0, stated), and the ledger (real tokens, $0). It is
        // NOT derived from the address — a private IP is a good hint but the
        // user's own laptop serving Ollama is a different thing from the box
        // they added by name, and only the panel that added it knows which.
        //
        // Carried through an unrelated relink rather than cleared, so a
        // catalogue refresh cannot quietly demote the Spark back to "some API".
        localNode: localNode !== undefined ? !!localNode : !!prev.localNode,
        node: node !== undefined ? node : (prev.node || null),
        /* WHICH SEAT THIS ENGINE SITS IN ON THAT MACHINE.
         *
         * "instead of making vLLM its own selector ... make it a session based
         *  toggle. as in the local node model running on llama.cpp can run
         *  larger context, and invoke agents running on vLLM"
         *
         * "chat" is the seat a session selects — one stream, the biggest
         * window, the model the operator talks to. "fleet" is what its agents
         * run on: many streams, continuous batching, and no better at being a
         * chat model than the thing already in the chat seat. Offering both in
         * one list asked the operator to choose between two engines that do
         * different jobs, when the right answer is both at once.
         *
         * Carried through a relink for the same reason localNode is: a
         * catalogue refresh must not restamp a node engine's seat. Undefined
         * on a pasted address — someone typing a URL is naming something to
         * chat with, and only an install off the recipe table knows better. */
        nodeRole: nodeRole !== undefined ? (nodeRole || null) : (prev.nodeRole || null),
        nodeStack: nodeStack !== undefined ? (nodeStack || null) : (prev.nodeStack || null),
        // A RENTED GPU. Same shape as a node, different owner — and the
        // difference is what every guard downstream keys on, so it is stored
        // rather than inferred. Carried through a relink for the same reason
        // localNode is: a catalogue refresh must not quietly reclassify
        // somebody else's hardware as the user's own.
        rented: rented !== undefined ? !!rented : !!prev.rented,
        provider: provider !== undefined ? (provider || null) : (prev.provider || null),
        // WHICH SUBSCRIPTION METERS THIS ENDPOINT, IF ANY. "go-window" means
        // the GO plan's dollar windows govern it and the usage meter shows;
        // absent means per-token billing, and the meter stays out of the way —
        // "the GO stuff should only be visible when a GO model is selected."
        plan: plan !== undefined ? (plan || null)
            : (prev.plan || (pre && pre.plan) || null),
        // THE WIRE SHAPE, kept because "would this server reject an unknown
        // field" is a question about the protocol, not about who owns the box:
        // a pasted LAN Ollama and a rented Ollama reject exactly what the
        // operator's own does.
        shape: shape !== undefined ? (shape || null) : (prev.shape || null)
    };
    writeStore(store);
    let keyState = { stored: getKey(epId) ? "disk" : "none", encrypted: false };
    if (key !== undefined && key !== null && String(key).length) keyState = putKey(epId, key);
    return { id: epId, ...store.endpoints[epId], hasKey: !!getKey(epId), keyState };
}

function unlinkEndpoint(id) {
    const store = readStore();
    delete store.endpoints[id];
    writeStore(store);
    memoryKeys.delete(id);
    const cfg = config();
    if (cfg.endpointId === id) paths.writeSettings({ [CFG_KEY]: { enabled: false } });
    return { ok: true };
}

/** Loopback or RFC1918/link-local — "my machine or my network". */
function isLocalHost(host) {
    const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".localhost")) return true;
    // Tailscale: MagicDNS names and the CGNAT range it assigns (100.64/10).
    // Inside the mesh every packet is already WireGuard-encrypted end to end,
    // so plain http here is not plaintext on any wire — and it is exactly how
    // a DGX Spark is reached from another network via NVIDIA Sync's own
    // Tailscale integration. Refusing http on these hosts would break the
    // documented path while protecting nothing.
    if (h.endsWith(".ts.net")) return true;
    if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const [a, b] = [ +m[1], +m[2] ];
    return a === 127 || a === 10 || (a === 192 && b === 168)
        || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
        || (a === 100 && b >= 64 && b <= 127);   // Tailscale CGNAT
}

/* ----------------------------------------------------------------- config */

/**
 * TWO ROLES, NOT ONE MODEL.
 *
 * V3 and R1 are good at different things and they are not interchangeable. V3 is
 * trained for function calling and is cheap; R1 is trained to reason and costs
 * four times as much for output. Forcing a choice between them wastes whichever
 * one you did not pick.
 *
 *   DRIVER   runs the agent loop. Emits tool calls, reads results, decides the
 *            next step. Wants reliable tool syntax far more than depth.
 *   REASONER is a TOOL the driver can call when it hits something that actually
 *            needs thinking. Wants depth and does not need to call anything.
 *
 * The important property is that the routing decision costs nothing. There is no
 * local analysis pass between calls — such a pass would
 * eat exactly the latency the remote model exists to save. The driver is
 * already generating; deciding to call ask_reasoner is one more tool call to it,
 * not a separate round trip to anything else.
 *
 * Either role may be unset. One model in both is fine and is what a single-model
 * setup looks like.
 */
function config() {
    const c = paths.readSettings()[CFG_KEY];
    if (!c || typeof c !== "object") return { enabled: false, roles: {} };
    // Migrate the single-model shape: it was always the driver.
    if (c.endpointId && c.model && !c.roles) {
        return { enabled: !!c.enabled,
                 roles: { driver: { endpointId: c.endpointId, model: c.model } },
                 // kept so anything still reading the flat shape keeps working
                 endpointId: c.endpointId, model: c.model };
    }
    return { enabled: !!c.enabled, roles: c.roles || {},
             endpointId: (c.roles && c.roles.driver && c.roles.driver.endpointId) || null,
             model: (c.roles && c.roles.driver && c.roles.driver.model) || null };
}

const ROLES = ["driver", "reasoner"];

/**
 * Assign a model to a role. Omitting `role` means driver, so every existing
 * caller keeps working.
 */
function selectModel({ endpointId, model, enabled = true, role = "driver" } = {}) {
    if (!ROLES.includes(role)) throw new ToolError(`unknown role '${role}'`);
    const cur = config();
    const roles = { ...(cur.roles || {}) };

    if (!enabled) {
        // disabling a role clears just that one; clearing the driver turns the
        // whole thing off, because a reasoner with nothing driving it is unreachable
        delete roles[role];
        const stillOn = !!roles.driver;
        const next = { enabled: stillOn, roles };
        paths.writeSettings({ [CFG_KEY]: next });
        return config();
    }

    const ep = endpoints().find(e => e.id === endpointId);
    if (!ep) throw new ToolError("link that endpoint first");
    if (!model) throw new ToolError("pick a model on that endpoint");
    roles[role] = { endpointId, model: String(model) };
    // assigning a reasoner while nothing drives would be inert — make it the
    // driver too, so one assignment always produces a working setup
    if (role === "reasoner" && !roles.driver) roles.driver = { ...roles[role] };
    paths.writeSettings({ [CFG_KEY]: { enabled: true, roles } });
    return config();
}

/** The endpoint+model for a role, or null. */
/**
 * REFRESH AN ENDPOINT'S CATALOGUE IN PLACE.
 *
 * An endpoint linked before catalogue metadata existed stores {id,label} per
 * model and nothing else — no contextLength, no maxTokens, no chat filter.
 * limits() then finds no published window, falls back to the conservative
 * REMOTE_FLOOR of 4096 output tokens, and every file a frontier model tries to
 * write is guillotined at ~14,000 characters mid-JSON. Measured exactly that
 * way against a real GLM-5.2 session: three consecutive truncated write_file
 * calls, nothing written, the model apologising each time.
 *
 * So the app heals itself: re-probe, keep the chat models with their published
 * numbers, and learn the rates. Called on demand, and automatically by
 * cloudState() when a stale endpoint is spotted.
 */
async function refreshEndpointCatalogue(endpointId) {
    const ep = endpoints().find(e => e.id === endpointId);
    if (!ep) throw new ToolError("no such endpoint");
    // A REFRESH IS NOT A DISCOVERY. This endpoint already told us which route
    // it answers on and what shape it speaks; re-deriving both on every click
    // walks rungs this host is known to 404 — and pays a full timeout for each
    // when the network is unwell.
    const found = await probe(ep.baseUrl, getKey(ep.id),
        { prefix: ep.apiPrefix, shape: ep.shape });
    // the catalogue is being re-read, so any remembered tools refusal is stale
    clearToolsRefused(ep.id);
    const chatIds = found.models.filter(id => isChatCapable(id, found.catalogue));
    let priced = 0;
    if (tokenCost.learnRates) {
        priced += tokenCost.learnRates((found.catalogue || [])
            .filter(e => e && e.rate)
            .map(e => ({ id: e.id, in: e.rate.in, out: e.rate.out })));
    }
    // A refresh must not throw away the window a local node was given at link
    // time: healing an endpoint back into REMOTE_FLOOR is the failure this
    // whole function exists to undo.
    const local = isLocalHost(new URL(ep.baseUrl).hostname);
    const sel = selectedFor("driver");
    const inUse = (sel && sel.id === ep.id && sel.model) || null;
    const models = modelRecords(chatIds, found.catalogue, {
        assumeContext: local ? LOCAL_ASSUMED_CONTEXT : 0,
        reportedFor: inUse,
        reported: (local && found.shape === "ollama" && inUse)
            ? await ollamaContextLength(ep.baseUrl, inUse) : 0
    });
    const store = readStore();
    /* THE SECOND WRITER, AND IT WAS UNDOING THE FIRST.
       keepMeasuredWindows was added to linkEndpoint and this path writes the
       store DIRECTLY — so a measured window survived one launch and was thrown
       away by the next catalogue heal. Caught by simulating two launches back
       to back against a real store, not by reading either function. */
    store.endpoints[ep.id] = { ...(store.endpoints[ep.id] || {}),
                               models: keepMeasuredWindows(models, (store.endpoints[ep.id] || {}).models),
                               allModels: found.models, apiPrefix: found.apiPrefix,
                               shape: found.shape || null };
    if (!store.endpoints[ep.id].imageModel) {
        const img = pickImageModel(found.catalogue);
        if (img) store.endpoints[ep.id].imageModel = img;
    }
    writeStore(store);
    return { ok: true, models: models.length, hidden: found.models.length - chatIds.length,
             priced,
             // the list refreshed, but the credential behind it did not work —
             // said here rather than left for the next chat turn to discover
             keyRejected: !!found.keyRejected };
}

/** Does this endpoint predate catalogue metadata? */
function endpointIsStale(ep) {
    const ms = (ep && ep.models) || [];
    if (!ms.length) return false;
    if (!ms.some(m => m && m.contextLength)) return true;
    // A NODE WHOSE MODELS HAVE NO WEIGHTS ON RECORD is stale the same way: the
    // probe has always captured Ollama's per-model size, modelRecords used to
    // drop it, and without it the picker cannot mark a model the fit rule will
    // refuse forever. One refresh heals a record linked before sizes were kept.
    if (ep.localNode && !ms.some(m => m && Number(m.sizeBytes) > 0)) return true;
    // A HOSTED ENDPOINT WITH NO CAPABILITY SHEET is stale too, and this is the
    // case that matters most on the first launch after an update: every record
    // linked before the provider's own catalogue was read carries no tags, no
    // feature list and no retirement flags. Without this, the operator keeps a
    // picker full of models it cannot tell apart — including retired ones —
    // until he happens to press Refresh on the card. One heal at startup,
    // through the path that already exists for exactly this.
    if (!ep.localNode && !ms.some(m => m && (Array.isArray(m.tags)
                                             || Array.isArray(m.features)))) {
        return true;
    }
    return false;
}

function selectedFor(role = "driver") {
    const cfg = config();
    if (!cfg.enabled) return null;
    const r = (cfg.roles || {})[role];
    if (!r || !r.endpointId || !r.model) return null;
    const ep = endpoints().find(e => e.id === r.endpointId);
    if (!ep) return null;
    return { ...ep, model: r.model, role };
}

/** The driver — what the agent loop runs on. */
function selected() { return selectedFor("driver"); }

/** Is THIS selection usable — key present where a key is needed? */
function usableSelection(s) {
    if (!s) return false;
    const pre = PRESETS.find(p => p.id === s.preset);
    // a local server needs no key; a hosted provider does
    const needsKey = pre ? pre.needsKey : !isLocalHost(new URL(s.baseUrl).hostname);
    return !needsKey || s.hasKey;
}

function usableFor(role = "driver") {
    return usableSelection(selectedFor(role));
}

/**
 * WHICH MODEL DRIVES *THIS SESSION* — the inherit-unless-set resolution.
 *
 * lcl:setSessionModel stored a choice on the session record from the first
 * day the picker existed, and nothing ever read it: routing went through the
 * one global `roles.driver`, so the per-session choice was written to disk
 * and silently ignored. This is the reader.
 *
 * The shape is the SAME one the per-session permissions use — inherit unless
 * set. A session that never chose follows the app default forever, including
 * when the default changes. A session that chose keeps its choice:
 *
 *   modelSel absent/null            -> the LOCAL engine (never a remote
 *                                      default — a paid API model is a per-
 *                                      conversation choice, not a default)
 *   modelSel { local: true }        -> the local engine, explicitly
 *   modelSel { endpointId, model }  -> that endpoint, that model
 *
 * A chosen endpoint that has since been unlinked (or lost its key) falls back
 * to the LOCAL engine — and says so via `missing`, because silently answering
 * from a different machine than the one the user picked is the exact class of
 * lie this feature exists to end.
 *
 * Returns { sel, source, missing? }:
 *   sel      the endpoint+model object streamChat runs on, or null = local
 *   source   "session" | "default" | "fallback" (chosen but unusable -> default)
 */
function resolveSelection(session) {
    let raw = session && session.modelSel;
    // A SESSION SAVED BEFORE THIS EXISTED still has the old scalar id on it —
    // "api:<endpointId>|<model>" or a bare local model id. Those choices were
    // real choices; they are read in the shape they were written rather than
    // being discarded because the format moved on.
    if (typeof raw === "string") {
        raw = raw.startsWith("api:")
            ? (() => {
                const rest = raw.slice(4), cut = rest.indexOf("|");
                return cut < 0 ? null
                    : { endpointId: rest.slice(0, cut), model: rest.slice(cut + 1) };
            })()
            : { local: raw };
    }
    if (raw && raw.local) return { sel: null, source: "session" };
    if (raw && raw.endpointId && raw.model) {
        const ep = endpoints().find(e => e.id === raw.endpointId);
        const sel = ep ? { ...ep, model: String(raw.model), role: "driver" } : null;
        if (sel && usableSelection(sel)) return { sel, source: "session" };
        // the chosen endpoint is gone: fall to the LOCAL engine and say so —
        // never to a different remote machine the operator did not pick
        return { sel: null, source: "fallback",
                 missing: { endpointId: raw.endpointId, model: raw.model } };
    }
    // NO CHOICE MEANS THIS MACHINE. The default used to be the global
    // roles.driver — a remote, paid model whenever one had ever been assigned
    // (or silently stamped by an endpoint link), so a brand-new conversation
    // opened already pointed at an API. Out of the box .lcl has no API; the
    // default is the local engine, always. The global roles still serve what
    // they were for — escalation, the reasoner handoff, fallback — all of
    // which are explicit assignments with their own consent gates.
    return { sel: null, source: "default" };
}

function available() { return usableFor("driver"); }

/** Is a DISTINCT reasoner configured? One model in both roles is not a handoff. */
function hasReasoner() {
    const d = selectedFor("driver"), r = selectedFor("reasoner");
    return !!(r && usableFor("reasoner")
              && !(d && d.id === r.id && d.model === r.model));
}

/* ------------------------------------------------------------- transport */

/** "" is a valid prefix; only undefined means "we never probed, assume /v1". */
function apiPrefixOf(ep) {
    return (ep && ep.apiPrefix !== undefined && ep.apiPrefix !== null)
        ? ep.apiPrefix : "/v1";
}

function request(ep, urlPath, { method = "GET", body = null, timeoutMs = 30_000,
                                lookup = undefined, fromRoot = false } = {}) {
    const base = new URL(ep.baseUrl);
    const isHttps = base.protocol === "https:";
    const lib = isHttps ? https : http;
    const key = getKey(ep.id);
    const headers = { Accept: "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(body);
    }
    return new Promise((resolve, reject) => {
        // WHERE DID IT STALL? "the endpoint did not respond" is true and
        // useless: DNS, the TCP connect, the TLS handshake and the reply are
        // four different failures with four different causes, and a timeout
        // reports them identically. A refresh on the operator's install timed
        // out at exactly 7,004 ms while the same request from a standalone
        // process on the same machine took 389 ms — nothing in the message
        // could tell those apart. The phases are stamped as they happen and
        // the last one reached is named in the error.
        const t0 = Date.now();
        const phase = { at: "queued", ms: {} };
        const mark = (name) => { phase.at = name; phase.ms[name] = Date.now() - t0; };
        const req = lib.request({
            host: base.hostname,
            port: base.port || (isHttps ? 443 : 80),
            // fromRoot: a provider's own metadata surface usually hangs off the
            // ORIGIN, not the OpenAI-compatible base path — DeepInfra serves
            // /models/list at the root while its chat base is /v1/openai
            path: (fromRoot ? urlPath
                            : (base.pathname.replace(/\/+$/, "") + urlPath)) || urlPath,
            // A DOOR IS RESOLVED THE WAY THE INTERNET RESOLVES IT. streamChat
            // has always passed publicDns.lookup for the door and this helper
            // had no way to, so every request() aimed at a funnel name went
            // through MagicDNS — which answers with the node's PRIVATE tailnet
            // address and sends the one route built to survive a full-tunnel
            // VPN straight back into the tunnel. Undefined for everything else,
            // which is the OS resolver, exactly as before.
            // pool-free by default; a caller with its own resolver (the door
            // uses public DNS on purpose) still wins
            lookup: lookup || lookupOffThreadPool,
            method, headers, timeout: timeoutMs
        }, (res) => {
            // A CAP THAT SAYS SO WHEN IT BITES.
            //
            // This silently stopped appending past 200 KB, leaving a JSON
            // document cut off mid-object. Every caller then hit `JSON.parse`
            // throwing and reported something that pointed nowhere near the
            // cause — probe() falls through its whole ladder and says "answered,
            // but not with a model list — is it an OpenAI-compatible server?"
            // about a server that answered perfectly.
            //
            // Measured: DeepInfra's catalogue is 114,962 bytes across 174 models
            // WITH their metadata, so the old cap was not truncating — but it
            // was inside a factor of two of a list that grows every month, and
            // the failure would have been undiagnosable. 2 MB is far past any
            // legitimate model list and still bounded.
            const CAP = 2_000_000;
            let data = "";
            let truncated = false;
            res.setEncoding("utf8");
            res.on("data", c => {
                if (data.length + c.length <= CAP) data += c;
                else if (!truncated) { truncated = true; res.destroy(); }
            });
            mark("headers");
            res.on("data", () => { if (!phase.ms.body) mark("body"); });
            res.on("end", () => resolve({ status: res.statusCode, body: data, truncated }));
            res.on("close", () => {
                if (truncated) resolve({ status: res.statusCode, body: data, truncated });
            });
        });
        req.on("socket", (sock) => {
            mark("socket");
            sock.on("lookup", (err, addr) => { mark("dns"); phase.ip = addr || null; });
            sock.on("connect", () => mark("tcp"));
            sock.on("secureConnect", () => mark("tls"));
        });
        req.on("timeout", () => {
            req.destroy();
            // the phase names what actually stalled, so the next report is a
            // diagnosis instead of a shrug
            // an ADDRESS needs no resolving, so a socket that never got past
            // "socket" stalled on the connect, not on DNS — Node emits no
            // lookup event at all when the host is already an IP
            const isIp = !!require("net").isIP(base.hostname);
            const where = ({
                queued: "the request never got a socket",
                socket: isIp ? "the TCP connection never completed"
                             : "DNS never resolved",
                dns: "the TCP connection never completed" +
                     (phase.ip ? ` (resolved to ${phase.ip})` : ""),
                tcp: "the TLS handshake never completed",
                tls: "connected, but the server sent no reply",
                headers: "the reply stopped part-way"
            })[phase.at] || "no reply";
            const e = new ToolError(`the endpoint did not respond — ${where}`);
            e.phase = phase.at;
            e.phaseMs = phase.ms;
            reject(e);
        });
        req.on("error", e => reject(new ToolError(scrub(e.message, key))));
        if (body) req.write(body);
        req.end();
    });
}

function requireNetwork() {
    if (paths.readSettings().networkEnabled !== true) {
        throw new ToolError("network access is off — turn it on in Security first");
    }
}

/** Ask the endpoint what models it serves. Works on DeepSeek, Ollama, vLLM, etc. */
/**
 * Remove a dead model from an endpoint's stored lists. Called when the
 * provider returns "model not found" / "invalid model" — DeepInfra's
 * /models endpoint keeps deprecated models in the listing, so a refresh
 * alone cannot clear them. This prunes from both `models` and `allModels`
 * so the picker stops offering a model that will only 404 when called.
 */
function pruneModelFromEndpoint(endpointId, modelId) {
    if (!endpointId || !modelId) return;
    try {
        const store = readStore();
        const ep = store.endpoints[endpointId];
        if (!ep) return;
        if (Array.isArray(ep.models)) {
            ep.models = ep.models.filter(m => (m.id || m) !== modelId);
        }
        if (Array.isArray(ep.allModels)) {
            ep.allModels = ep.allModels.filter(m => (typeof m === "string" ? m : (m.id || m)) !== modelId);
        }
        writeStore(store);
    } catch { /* bookkeeping never breaks a call */ }
}

/*
 * A REFRESH MUST NOT MAKE THE RECORD POORER THAN A LINK DOES.
 *
 * This used to write `{ id, label }` and nothing else — so pressing Refresh on
 * an endpoint card threw away every per-model fact the link had gathered:
 * context length, published rate, weights, the capability tags the request
 * builder now gates reasoning_effort on, and the provider's retirement flags.
 * One click silently disarmed the whole per-model layer.
 *
 * refreshEndpointCatalogue is the path that gathers all of it; this is now its
 * front door, so the two cannot drift again.
 */
async function discoverModels(endpointId) {
    requireNetwork();
    const ep = endpoints().find(e => e.id === endpointId);
    if (!ep) throw new ToolError("unknown endpoint");
    const r = await refreshEndpointCatalogue(endpointId);
    const after = endpoints().find(e => e.id === endpointId);
    return { models: ((after && after.models) || []).map(m => m.id),
             keyRejected: !!(r && r.keyRejected) };
}

/** Is it reachable, and does the key work? One cheap round trip. */
/**
 * CAN THIS MACHINE DRAW? ASKED WITHOUT DRAWING ANYTHING.
 *
 * The tool-fallback chain prefers the user's own hardware over a paid
 * endpoint, but only if it knows the hardware can do the job. Asking properly
 * would mean POSTing a real prompt and paying for (or waiting on) a real
 * image just to learn whether the route exists.
 *
 * So it is asked the cheap way: POST a DELIBERATELY EMPTY body. A server with
 * no such route answers 404 or 405 — the route is not there. A server that
 * HAS the route rejects the body instead (400/422), which is the answer we
 * wanted: it exists. Nothing is generated and nothing is spent either way.
 *
 * Anything else (a timeout, a 5xx, a network refusal) is read as NO, because
 * an unproven capability must never send the chain somewhere that cannot
 * answer.
 */
async function probeImageCapability(ep) {
    try {
        const r = await request(ep, apiPrefixOf(ep) + "/images/generations",
            { method: "POST", body: "{}", timeoutMs: 8_000 });
        // 400/422 = "I know this route, your body is wrong" = it exists.
        // 401/403 = the route exists and is guarded; a key problem is not absence.
        return r.status === 400 || r.status === 422
            || r.status === 401 || r.status === 403;
    } catch { return false; }
}

/*
 * WHICH MODEL DOES THE DRAWING, chosen from what the host publishes rather
 * than from a vendor name. DeepInfra tags 28 of its models "image-gen" (and
 * types them text-to-image); the first one it lists is the seed, and the
 * operator can change it. Without this the image capability was detected,
 * recorded, and then impossible to use: viaApi's gate requires imageModel.
 */
function pickImageModel(catalogue) {
    for (const e of catalogue || []) {
        if (!e || !e.id) continue;
        const tags = (Array.isArray(e.tags) ? e.tags : []).map(t => String(t).toLowerCase());
        if (e.type === "text-to-image" || tags.includes("image-gen")) return e.id;
    }
    return null;
}

/** Point an endpoint's image generation at a specific model. */
function setImageModel(endpointId, modelId) {
    const store = readStore();
    const rec = store.endpoints[endpointId];
    if (!rec) return false;
    rec.imageModel = modelId ? String(modelId) : null;
    writeStore(store);
    return true;
}

/** Remember what an endpoint turned out to be able to do. */
function setCapability(endpointId, name, on) {
    const store = readStore();
    const rec = store.endpoints[endpointId];
    if (!rec) return false;
    const set = new Set(Array.isArray(rec.capabilities) ? rec.capabilities : []);
    if (on) set.add(name); else set.delete(name);
    rec.capabilities = [...set];
    writeStore(store);
    return true;
}

async function testEndpoint(endpointId) {
    requireNetwork();
    const ep = endpoints().find(e => e.id === endpointId);
    if (!ep) throw new ToolError("unknown endpoint");
    // learn what else it can do while we are already talking to it
    try { setCapability(endpointId, "image", await probeImageCapability(ep)); }
    catch { /* a capability we could not prove is one we do not claim */ }
    try {
        const r = await request(ep, apiPrefixOf(ep) + "/models", { timeoutMs: 12_000 });
        if (r.status === 200) {
            let n = 0;
            try { const j = JSON.parse(r.body); n = (j.data || j.models || []).length; } catch { /* fine */ }
            // The catalogue being reachable says nothing about the key on hosts
            // that publish it openly, so Test spends one token the same way
            // connect does. A Test that passes while sending fails is worthless.
            const sel = selectedFor("driver");
            const model = (sel && sel.id === ep.id && sel.model)
                || (ep.models && ep.models[0] && ep.models[0].id);
            // ...but not against a machine on your own network, which has no key
            // to spend it on. The same completion that costs a hosted provider
            // one token makes a local node load the whole model off disk to
            // answer it — 100 GB and a timeout on the Ollama box, to prove a
            // credential that does not exist. Reachable and listing is the whole
            // truth available there, so that is what it reports.
            if (model && !isLocalHost(new URL(ep.baseUrl).hostname)) {
                const v = await verifyKey(ep, model);
                if (!v.ok) return { ok: false, status: 401, detail: v.why };
                return { ok: true, status: 200, models: n,
                         detail: `working — ${n} model${n === 1 ? "" : "s"}, key accepted`
                                 + (v.warn ? ` (${v.warn})` : "") };
            }
            return { ok: true, status: 200, models: n, detail: `reachable — ${n} models` };
        }
        if (r.status === 401 || r.status === 403) {
            return { ok: false, status: r.status,
                     detail: ep.hasKey ? "the key was rejected" : "this endpoint needs an API key" };
        }
        return { ok: false, status: r.status, detail: scrub(r.body).slice(0, 160) };
    } catch (e) {
        return { ok: false, status: 0, detail: scrub(e.message) };
    }
}

/* ------------------------------------------------- is that machine there? */

/**
 * CONTRACT K4 — A MACHINE THAT IS SWITCHED OFF MAY NOT BE OFFERED.
 *
 * "the picker still lists the Spark's models while the machine is unreachable,
 *  and the UI reported the model as switched with no weights loaded."
 *
 * Reachability is learned in the places that already dial the machine — the
 * preflight, the chat stream, the nodes poll in main.js — and remembered HERE,
 * in one map, so the picker does not have to dial anything to know. Every
 * endpoint record carries the verdict out as `offline` + `offlineReason`, and
 * listModels copies those onto each of that endpoint's model rows.
 *
 * The verdict LAPSES. A machine that was off at 09:00 is not off forever, and
 * a stale "offline" that greys a row until the app restarts is the same class
 * of lie in the other direction. After OFFLINE_TTL_MS it decays to unknown and
 * the next real attempt decides again.
 */
const OFFLINE_TTL_MS = 5 * 60_000;
const endpointStatus = new Map();       // endpointId -> { reason, at }

function markEndpointOffline(id, reason) {
    if (!id) return;
    endpointStatus.set(id, { reason: String(reason || "unreachable").slice(0, 160),
                             at: Date.now() });
}
function markEndpointOnline(id) { if (id) endpointStatus.delete(id); }

/** { offline, offlineReason, at } — never a guess, and never stale forever. */
function endpointHealth(id) {
    const h = endpointStatus.get(id);
    if (!h) return { offline: false, offlineReason: null, at: 0 };
    if (Date.now() - h.at > OFFLINE_TTL_MS) {
        endpointStatus.delete(id);
        return { offline: false, offlineReason: null, at: 0 };
    }
    return { offline: true, offlineReason: h.reason, at: h.at };
}

/**
 * Dial an endpoint's catalogue and record what happened. One cheap round trip,
 * for a caller that wants the verdict refreshed rather than remembered.
 */
async function checkEndpointReachable(id, timeoutMs = 6000) {
    const ep = endpoints().find(e => e.id === id);
    if (!ep) return { offline: true, offlineReason: "no such endpoint" };
    try {
        const r = await request(ep, apiPrefixOf(ep) + "/models", { timeoutMs });
        if (r.status >= 200 && r.status < 500) { markEndpointOnline(id); return endpointHealth(id); }
        markEndpointOffline(id, `answered ${r.status}`);
    } catch (e) {
        markEndpointOffline(id, scrub(e.message));
    }
    return endpointHealth(id);
}

/* -------------------------------------------------------------- streaming */

/**
 * CONTRACT K1 — A NODE'S SIZE HAS ONE SOURCE OF TRUTH, AND IT IS NOT HERE.
 *
 * MEASURED against the record on the operator's installed app's disk:
 *
 *     endpoint record   {"id":"node-example1","name":"spark",
 *                        "host":"100.64.0.1","port":11434}
 *     registry record   memBytes 130663002112
 *     nodePreflight     null -> PROCEEDED, for a 100 GB model
 *
 * Two copies of one truth, and the guard read the copy nothing backfills.
 * `rememberNodeMem` in main.js writes the registry; the endpoint's embedded
 * `node` block is a snapshot taken at link time and is stale by construction.
 * So the embedded copy is now the LAST resort, and the registry is asked first
 * through a hook main.js installs at startup:
 *
 *     cloudModels.setNodeMemResolver(fn)      // fn(nodeId) -> bytes | null
 *
 * The hook may also answer with an object, which is how the free-memory half
 * of contract K2 gets here from the gauge tick that already measures it:
 *
 *     { totalBytes, availableBytes, at }      // at = when it was measured
 */
let nodeMemResolver = null;
function setNodeMemResolver(fn) {
    nodeMemResolver = typeof fn === "function" ? fn : null;
    return !!nodeMemResolver;
}

/**
 * HOW OLD A FREE-MEMORY READING MAY BE AND STILL BE EVIDENCE.
 *
 * This is the number that matters most in the whole guard. A reading taken
 * while the machine was idle, replayed a minute later against a machine that
 * has since loaded something, reports room that is not there — and reporting
 * room that is not there is the entire failure being fixed. Anything older
 * than this is not a stale measurement, it is no measurement.
 */
const MEM_FRESH_MS = 60_000;

/** The node id this selection belongs to, when it belongs to one. */
function nodeIdOf(s) { return (s && s.node && s.node.id) || null; }

/** What the registry says, through the hook — number or object, both accepted. */
function nodeMemFromHook(s) {
    const id = nodeIdOf(s);
    if (!id || !nodeMemResolver) return null;
    let v = null;
    try { v = nodeMemResolver(id); } catch { return null; }
    if (v == null) return null;
    if (typeof v === "number") {
        return Number(v) > 0 ? { totalBytes: Number(v) } : null;
    }
    if (typeof v !== "object") return null;
    const out = {};
    const total = Number(v.totalBytes || v.memBytes || v.physTotalBytes || 0);
    const avail = Number(v.availableBytes || v.freeBytes || 0);
    if (total > 0) out.totalBytes = total;
    if (avail > 0) { out.availableBytes = avail; out.at = Number(v.at || v.measuredAt) || 0; }
    return Object.keys(out).length ? out : null;
}

/**
 * The node's own /proc/meminfo, over remote access.
 *
 * The door already serves it — /lcl/stats is what the dashboard gauge draws —
 * and it is the one live free-memory reading this module can take entirely on
 * its own, without main.js having wired anything. Transport only: no prompt,
 * no key, one GET.
 */
function doorStats(s, timeoutMs = 6000) {
    return new Promise((resolve) => {
        const token = (s && s.relayUrl) ? getKey(s.id + "::door") : null;
        if (!token) return resolve(null);
        let u;
        try { u = new URL(String(s.relayUrl).replace(/\/+$/, "") + "/lcl/stats"); }
        catch { return resolve(null); }
        const isHttps = u.protocol === "https:";
        const rq = (isHttps ? https : http).get({
            host: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname,
            headers: { Authorization: `Bearer ${token}` }, timeout: timeoutMs,
            // the door is resolved the way the internet resolves it — MagicDNS
            // would answer this name with the tailnet address and send the one
            // route built to survive a VPN straight back into the tunnel
            lookup: publicDns.lookup
        }, (res) => {
            let b = "";
            res.on("data", c => { if (b.length < 200_000) b += c; });
            res.on("end", () => {
                if (res.statusCode !== 200) return resolve(null);
                try { resolve(JSON.parse(b)); } catch { resolve(null); }
            });
        });
        rq.on("timeout", () => { rq.destroy(); resolve(null); });
        rq.on("error", () => resolve(null));
    });
}

/**
 * Ask the node something, over whichever road is open.
 *
 * The preflight used to dial the direct address only. On the machine this
 * product was built for, the direct address is exactly what a full-tunnel VPN
 * closes — so the guard would have gone blind precisely when the door was
 * carrying the chat, and a blind guard now REFUSES a large model. The door
 * proxies /api/ps, /api/tags and /api/generate verbatim, so the same question
 * asked down the other road gets the same answer.
 */
/* IS THE MODEL ALREADY BEING SERVED — asked on the roads the chat itself uses.
 *
 * Measured on a restricted network behind a full-tunnel VPN: direct 100.x is blocked by the
 * VPN, the door over the funnel WORKS (chat proved it with a real 400 through
 * it) — but the preflight's measurement probes are direct-only, so the guard
 * went blind, guessed from the model NAME, and refused a 120B the node was
 * actively serving. A one-model server that lists the model on /v1/models is
 * past its load; there is nothing left to guard. Direct first, then the keyed
 * door resolved through publicDns (MagicDNS hands the blocked private address).
 */
async function servedOnAnyRoad(s, timeoutMs = 3500) {
    const prefix = apiPrefixOf(s) || "/v1";
    const listHas = (body) => {
        try {
            const j = JSON.parse(body);
            const ids = (j.data || j.models || []).map(m => m.id || m.name || m.model);
            return ids.some(id => id === s.model);
        } catch { return false; }
    };
    try {
        const r = await request(s, prefix + "/models", { timeoutMs });
        if (r.status === 200 && listHas(r.body)) return true;
    } catch { /* direct road blocked — the door may still answer */ }
    const doorToken = s.relayUrl ? getKey(s.id + "::door") : null;
    if (!s.relayUrl || !doorToken) return false;
    return await new Promise((resolve) => {
        let u;
        try { u = new URL(s.relayUrl); } catch { return resolve(false); }
        const req = require("https").request({
            hostname: u.hostname,
            port: u.port || 443,
            path: prefix + "/models",
            method: "GET",
            lookup: publicDns.lookup,
            headers: { Authorization: `Bearer ${doorToken}` },
            timeout: timeoutMs
        }, (res) => {
            let b = "";
            res.on("data", (d) => { if (b.length < 65536) b += d; });
            res.on("end", () => resolve(res.statusCode === 200 && listHas(b)));
        });
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.on("error", () => resolve(false));
        req.end();
    });
}

async function askNode(s, urlPath, { method = "GET", body = null, timeoutMs = 4000 } = {}) {
    // REACHED IS NOT THE SAME AS ANSWERED, and collapsing the two is what would
    // make this guard refuse every turn on a llama.cpp node. A 404 means the
    // machine is THERE and does not serve that route; a timeout means nothing
    // is known about the machine at all. Those lead to opposite decisions.
    const out = { reached: false, status: 0, json: null };
    const tryOn = async (ep, lookup) => {
        const r = await request(ep, urlPath, { method, body, timeoutMs, lookup });
        out.reached = true;
        out.status = r.status;
        if (r.status >= 200 && r.status < 300) {
            try { out.json = JSON.parse(r.body); } catch { out.json = null; }
        }
    };
    try { await tryOn(s); if (out.json) { out.via = "direct"; return out; } }
    catch { /* the road may be shut; the door is below */ }
    const token = (s && s.relayUrl) ? getKey(s.id + "::door") : null;
    if (token) {
        // publicDns, or the door is dialled straight back into the tunnel it
        // exists to get around — which would leave this guard blind under
        // exactly the condition the door was built for, and a blind guard now
        // refuses a large model rather than sending it.
        try { await tryOn({ id: s.id + "::door", baseUrl: s.relayUrl }, publicDns.lookup);
              out.via = "door"; }
        catch { /* both roads shut */ }
    }
    return out;
}

/**
 * WHAT IS ACTUALLY FREE ON THAT MACHINE, AND WHO SAID SO.
 *
 * Returns { totalBytes, freeBytes, freeAt, freeFrom } with freeBytes 0 when
 * nothing could be measured — which is a verdict in itself, not a zero.
 */
async function measureNodeMemory(s) {
    const rec = (s && s.node) || {};
    const hook = nodeMemFromHook(s);
    const fresh = (at) => Number(at) > 0 && (Date.now() - Number(at)) <= MEM_FRESH_MS;

    let totalBytes = Number(hook && hook.totalBytes) || Number(rec.memBytes) || 0;
    let freeBytes = 0, freeAt = 0, freeFrom = null;

    if (hook && hook.availableBytes > 0 && fresh(hook.at)) {
        freeBytes = hook.availableBytes; freeAt = hook.at;
        freeFrom = "the node's own gauge";
    } else if (Number(rec.availableBytes) > 0 && fresh(rec.availableAt || rec.memAt)) {
        freeBytes = Number(rec.availableBytes);
        freeAt = Number(rec.availableAt || rec.memAt);
        freeFrom = "the node record";
    }
    if (!freeBytes) {
        const d = await doorStats(s);
        const m = d && d.mem;
        if (m && Number(m.availableBytes) > 0) {
            freeBytes = Number(m.availableBytes);
            freeAt = Number(d.at) || Date.now();
            freeFrom = "the node's /proc/meminfo, read over remote access";
            if (!totalBytes && Number(m.totalBytes) > 0) totalBytes = Number(m.totalBytes);
        }
    }
    return { totalBytes, freeBytes, freeAt, freeFrom };
}

/**
 * WILL THIS MODEL FIT ON THAT MACHINE, RIGHT NOW? MEASURED, NOT COMPUTED.
 *
 * The local engine has refused unsafe loads since the day it existed — that
 * planner is this product's keystone. The node path had no equivalent, which
 * meant a 128 GB Spark node trying to swallow a ~100 GB
 * mistral-large q6_K beside a running desktop: NVIDIA allocator out of memory
 * at 28 seconds, gnome-shell hung at 122s, a memory-pressure spiral, and only
 * holding the power button got the machine back. It then happened a SECOND
 * time, through a guard written to stop exactly that, because:
 *
 *   1. the guard read `s.node.memBytes` off the endpoint record, and the
 *      number lives on the registry record — see setNodeMemResolver above;
 *   2. even handed the right number the arithmetic passed the load. The old
 *      sum was `total - resident - 6 GB kernel`, and a comment in this very
 *      function called the result "a thin margin, run on purpose". That
 *      reasoning is deleted. Wanting to run the big model is not consent to
 *      lose the machine, and this function is the only thing standing between
 *      the two.
 *
 * WHAT REPLACES THE ARITHMETIC. `total - resident` is not free memory, it is
 * an upper bound on free memory, and in the measured incident the gap between
 * the two is the whole story: a model had just been stopped, so Ollama reported nothing
 * resident while the kernel had not yet handed a single page back. The sum
 * said 124 GB were available on a machine that had far less. So the guard
 * MEASURES — /proc/meminfo's MemAvailable, from the gauge that already reads
 * it or from the door — and uses the arithmetic only as a ceiling on what it
 * measured, never as a substitute for measuring.
 *
 * AND IT FAILS CLOSED. The old rule was "unreadable telemetry proceeds",
 * which is defensible for a small model and indefensible for a large one:
 * proceeding blind is the single outcome that can kill a box, and it has now
 * killed this one twice. A model that is large in absolute terms is refused
 * when its size or the machine's free memory cannot be read. A small one still
 * proceeds, because a 3 GB load has never taken a machine down.
 */

// WHAT MUST STILL BE FREE AFTER THE LOAD LANDS.
//
// 6 GB was the old figure and it was called "the kernel's survival floor",
// which it is — and the kernel survived the incident perfectly well while the
// machine still had to be recovered with the power button. What went first was
// everything ABOVE the kernel: the compositor hung at 122s, then the page cache
// the loader needed to stream 100 GB off disk, then the session. So the floor
// stays as a floor and the real requirement is a FRACTION, because 6 GB of
// slack means something completely different on a 32 GB mini-PC and on a
// 130 GB Spark.
//
// CALIBRATED AGAINST THE ONE LOAD THAT HAS ACTUALLY BEEN MEASURED. In the
// measured incident a ~110 GB allocation went at roughly 124 GB of nominal room: it
// left about 11% of the machine for the machine, and the machine stopped
// answering. 11% is therefore known-insufficient, measured, on this hardware.
// 18% is the first clear step past it. Everything below scales from those two
// numbers and nothing here is a preference.
const NODE_SYS_RESERVE = 6e9;
const NODE_HEADROOM_FRACTION = 0.18;

// Weights plus KV and runtime overhead at default context. Deliberately modest,
// and deliberately NOT where the safety lives: inflating an estimate until it
// happens to refuse is the same guess-with-authority this rebuild removes. The
// safety is the measured free memory and the headroom above it.
const LOAD_OVERHEAD = 1.1;

// "LARGE IN ABSOLUTE TERMS" — the size at which not knowing is not survivable.
// More than any ordinary workstation has spare and more than any consumer GPU
// holds, so a load this size cannot be absorbed by whatever slack a machine
// happens to have. Below it the worst case is a failed request; above it the
// worst case is the power button.
const NODE_LARGE_BYTES = 24e9;
// ...and the same question asked of a model whose size the host never
// published. paramCount reads the largest number in the name, so
// mistral-large:123b is 123 and qwen3:4b is 4.
const NODE_LARGE_PARAMS = 30;

// How long to wait for a model that has been asked to leave, and how often to
// look. Ollama's own keep_alive is five minutes, which is not a wait anyone
// will sit through; asking it to go now and watching until the MEMORY comes
// back is.
const UNLOAD_WAIT_MS = 90_000;
const UNLOAD_POLL_MS = 2_500;

const gbOf = (n) => (Number(n) / 1e9).toFixed(n >= 1e10 ? 0 : 1) + " GB";

async function nodePreflight(s, opts = {}) {
    if (!isNodeEndpoint(s)) return null;
    // THE ROOT: this whole guard exists to stop an ON-DEMAND loader (Ollama)
    // from cold-loading a model too big for RAM and taking the box down. A
    // start-time server — llama.cpp, vLLM, TRT-LLM — loads ONE model when it
    // boots and serves it; a chat request triggers no load, so there is
    // nothing here to guard. Newer llama.cpp answers Ollama's /api/tags now
    // (with no size), which made this guard misread it as on-demand and refuse
    // a 120B the node was actively serving. It is not on-demand. Do not guess
    // from a name, do not probe: a non-Ollama node has no load to prevent.
    if (!isOllamaShape(s)) return null;
    const note = typeof opts.onNote === "function" ? opts.onNote : () => {};
    const mayUnload = opts.unload !== false;
    // STOP HAS TO WORK IN HERE TOO. This function can now spend ninety seconds
    // watching a model leave memory, and cancellation was checked in exactly
    // one place before — inside the response stream, which does not exist yet.
    // That is the same shape as a stop request that will not stop: a
    // wait nobody can interrupt is indistinguishable from a hang.
    const cancelled = () => !!(opts.cancelToken && opts.cancelToken.cancelled);
    const STOPPED = () => new ToolError("stopped before anything was sent to " + s.label);
    if (cancelled()) throw STOPPED();

    const [psR, tagsR] = await Promise.all([askNode(s, "/api/ps"), askNode(s, "/api/tags")]);
    // CONTRACT K4, learned on the way past: the turn dials the machine anyway,
    // so the picker never has to.
    if (psR.reached || tagsR.reached) markEndpointOnline(s.id);
    else markEndpointOffline(s.id, "did not answer on either road");

    const same = (m) => m && (m.name === s.model || m.model === s.model);

    /* A DOOR ANSWER IS ABOUT THE DOOR'S BACKEND, NOT ABOUT THIS ENDPOINT.
     *
     * "Error: llama.cpp server did not publish a size for
     *  unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL ... too big to load onto a
     *  machine without knowing what it weighs."
     *
     * llama.cpp on 30000 was serving that model, loaded, right then. But the
     * direct road to 30000 did not answer, so the probe fell through to the
     * DOOR — and the door is a single fixed proxy, provisioned at Ollama on
     * 11434. So `/api/tags` came back with OLLAMA'S ten models, none of which
     * is this one, and the guard read "not in the catalogue" as "size unknown"
     * and refused a 35B model. It measured the wrong machine and then spoke
     * with authority about it, which is the exact failure the design notes name:
     * reached is not the same as reached THE THING YOU ASKED ABOUT.
     *
     * The guard itself stays as strict as it was — this only refuses to accept
     * evidence about a different server. With the door answer discarded there
     * is no catalogue, the machine was still reached, and the branch below
     * already knows what that means: a one-model server has no cold load for a
     * chat request to trigger, so there is nothing here to guard.
     * AND UNKNOWN MEANS TRUST IT. A door provisioned before this was recorded
     * has no backend port on its record, and refusing its evidence there would
     * blind the guard under exactly the condition the door was built for — a
     * full-tunnel VPN, direct road shut, the door the only road left. So the
     * answer is discarded only when the record KNOWS the door serves a
     * different port than this endpoint. Pressing Update remote access stamps
     * it; until then this behaves as it always did.
     */
    const doorBackendPort = Number((s.node && s.node.doorBackendPort) || 0);
    const myPort = (() => {
        try { return Number(new URL(s.baseUrl).port) || 0; } catch { return 0; }
    })();
    const aboutThisServer = (r) =>
        r.via !== "door" || !doorBackendPort || !myPort || myPort === doorBackendPort;
    if (!aboutThisServer(psR)) { psR.json = null; }
    if (!aboutThisServer(tagsR)) { tagsR.json = null; }

    /* ASK THE SERVER ITSELF BEFORE BELIEVING ANYONE ELSE ABOUT IT.
     *
     * Measured on a Spark node, over ssh, while it was refusing the load:
     *
     *     30000 /api/tags: 404
     *     30000 /api/ps:   404
     *     30000 /v1/models: {"models":[{"name":"unsloth/Qwen3.6-35B-A3B-MTP-
     *                        GGUF:UD-Q4_K_XL", ... "size":""}]}
     *
     * llama.cpp does not serve Ollama's two routes at all, so BOTH probes fall
     * through to the door — and the door is one fixed proxy pointed at Ollama.
     * The model was then judged against a different server's inventory, found
     * absent, and refused for "unknown size" while it sat there loaded and
     * serving.
     *
     * The server's OWN OpenAI catalogue answers the question directly, and it
     * is the one road that cannot be about some other machine. A server with no
     * /api/ps is not load-on-demand — llama.cpp, vLLM and TRT-LLM each serve ONE
     * model, loaded when the process started. If it names the model, the model
     * is resident, there is no cold load for a chat request to trigger, and
     * there is nothing here to guard. Note this does NOT weaken Ollama: Ollama
     * answers /api/ps, so it never takes this branch, and its /v1/models lists
     * everything PULLED rather than everything loaded.
     */
    const servesItAlready = await (async () => {
        if (psR.via === "direct" && psR.json) return false;   // Ollama-shaped: not this
        // fromRoot, because request() otherwise prefixes base.pathname — and a
        // baseUrl that already ends in /v1 would ask for /v1/v1/models. Direct
        // road only: the whole point is an answer that cannot be about another
        // machine, and the door is a proxy for one fixed backend.
        let own = null;
        try {
            const r = await request(s, (s.apiPrefix || "/v1") + "/models",
                                    { timeoutMs: 4000, fromRoot: true });
            if (r.status >= 200 && r.status < 300) {
                try { own = JSON.parse(r.body); } catch { own = null; }
            }
        } catch { return false; }            // its own road is shut: nothing claimed
        if (!own) return false;
        const list = Array.isArray(own.models) ? own.models
                   : Array.isArray(own.data) ? own.data : [];
        return list.some(m => m && (m.id === s.model || m.name === s.model
                                    || m.model === s.model));
    })();
    if (servesItAlready) return null;

    let loaded = (psR.json && Array.isArray(psR.json.models)) ? psR.json.models : [];
    // ALREADY RESIDENT: there is no load to guard. The cost being guarded
    // against is the LOAD, and this model is past it.
    if (loaded.some(same)) return null;

    const catalogue = (tagsR.json && Array.isArray(tagsR.json.models))
        ? tagsR.json.models : null;
    const params = paramCount(s.model);

    if (!catalogue) {
        // THE MACHINE ANSWERED AND DOES NOT LOAD ON DEMAND. llama.cpp, vLLM and
        // TRT-LLM serve ONE model, loaded when the server was started — there is
        // no cold load for a chat request to trigger, so there is nothing here
        // to guard and refusing would be an outage this guard invented.
        if (tagsR.reached) return null;
        // NOTHING ANSWERED. Not what it has loaded, not what it has free, not
        // what the model weighs. A small model still goes, because a telemetry
        // hiccup must not become an outage — and because the chat request that
        // follows will report the real failure in a sentence a person can read.
        // A large one does not: proceeding blind is the single outcome that can
        // kill a box, and it has now killed this one twice.
        if (params < NODE_LARGE_PARAMS) return null;
        // the measurement probes are not the only roads — if the endpoint's own
        // OpenAI surface (direct or keyed door) lists the model, it is ALREADY
        // loaded and the load this guard exists to prevent cannot happen
        if (await servedOnAnyRoad(s)) return null;
        throw new ToolError(
            `${s.label} did not answer on either road, so nothing about it could be ` +
            `measured — not what it has loaded, not what it has free. ${s.model} ` +
            `names about ${params}B parameters, which is too big to send to a machine ` +
            `whose state is unknown. Nothing was sent.`);
    }

    const entry = catalogue.find(same);
    const sizeBytes = Number(entry && entry.size) > 0 ? Number(entry.size) : 0;
    const large = sizeBytes > 0 ? sizeBytes >= NODE_LARGE_BYTES
                                : params >= NODE_LARGE_PARAMS;

    const mem = await measureNodeMemory(s);
    const residentBytes = loaded.reduce((n, m) => n + (Number(m.size) || 0), 0);
    const held = () => `${gbOf(residentBytes)} held by ${loaded.length} loaded ` +
                       `model${loaded.length === 1 ? "" : "s"}`;

    /* ---- the two ways of being blind, and neither of them proceeds big ---- */

    if (!sizeBytes) {
        if (!large) return null;              // small, or unknowably small: go
        // SAME MERCY AS THE BLIND BRANCH, same reason: a catalogue that lists
        // the model without a size (llama.cpp's /api/tags) is still a server
        // that is ALREADY SERVING it — /v1/models on either road settles it,
        // and a model past its load has nothing left for this guard to guard.
        if (await servedOnAnyRoad(s)) return null;
        throw new ToolError(
            `${s.label} did not publish a size for ${s.model}, and its name says ` +
            `about ${params}B parameters — too big to load onto a machine without ` +
            `knowing what it weighs. This guard used to proceed here, and that is ` +
            `how the machine went down twice. Pull the model on the node so it ` +
            `appears in its own catalogue, or pick a build it has listed.`);
    }

    /**
     * NO /proc/meminfo READING? THEN USE WHAT *IS* MEASURED.
     *
     * A gauge read needs SSH credentials or an authenticated door, and a node
     * can legitimately have neither — measured on a linked node whose record
     * carries `user: ""` and whose relay answers 401. Refusing outright there
     * does not make the machine safe, it makes the main model permanently
     * unusable, which is a fix that removed the feature.
     *
     * But `/api/ps` IS a measurement, of exactly the quantity that took the
     * machine down: what Ollama is already holding. The crash was a 100 GB load
     * fired at a box that still had a 32B resident from the model just
     * switched away from. Total is known from the node registry. So the
     * ceiling — total, minus what is measurably resident, minus a real reserve
     * for the operating system — is grounded in two measured numbers and one
     * conservative constant, not in guesswork.
     *
     * The reserve is deliberately larger than the gauge path's, because the one
     * thing genuinely unknown here is what the REST of the machine is using: a
     * desktop session, other services. Paying for that ignorance in headroom is
     * the honest trade. If it still does not fit, the refusal says so with the
     * measured numbers in it.
     */
    if (!mem.freeBytes) {
        if (!large) return null;
        if (!mem.totalBytes) {
            throw new ToolError(
                `${s.model} is ${gbOf(sizeBytes)} on disk and how much memory ` +
                `${s.label} has free right now could not be measured — nor its ` +
                `total size, so nothing about it is known at all. A build this ` +
                `size is refused rather than sent blind. Add the node in ` +
                `Connections so its size is recorded, then send again.`);
        }
        /* AND `/api/ps` IS NOT A SUBSTITUTE FOR READING THE MACHINE.
         *
         * I tried to make it one, so a node with no gauge could still run a big
         * model, and an existing check refused the change — correctly. Ollama
         * reporting nothing resident does NOT mean the memory is back: a model
         * that has just been stopped is gone from `/api/ps` while the kernel
         * still holds every page of it. That precise gap is the crash. Total
         * minus residency would have said 118 GB free with 20 GB still held,
         * and sent the 111 GB load anyway.
         *
         * The gauge is not a nicety, it is the measurement. It reaches the node
         * over the door (/lcl/stats) or over SSH, and when neither is
         * configured the honest answer to "how much room is there" is that
         * nobody knows. */
        throw new ToolError(
            `${s.model} is ${gbOf(sizeBytes)} on disk and how much memory ` +
            `${s.label} has free right now could not be measured. It reports ` +
            `${gbOf(mem.totalBytes)} in total with ` +
            `${residentBytes ? held() : "nothing currently loaded"}, but what a ` +
            `model server has unloaded is not the same as what the kernel has ` +
            `handed back — a build stopped seconds ago still occupies the ` +
            `memory it is no longer listed in, and sending this load into that ` +
            `gap is what took the machine down twice. Open the node in ` +
            `Connections so its memory gauge reads, or give it remote access, ` +
            `then send again.`);
    }

    /* ---- everything is known. Measure, then decide. ---- */

    const needBytes = sizeBytes * LOAD_OVERHEAD;
    // The measurement is the truth; the arithmetic is only a ceiling on it. A
    // gauge tick from before something else loaded cannot report more room
    // than total-minus-resident allows.
    const ceiling = mem.totalBytes > 0 ? Math.max(0, mem.totalBytes - residentBytes) : 0;
    const freeBytes = ceiling ? Math.min(mem.freeBytes, ceiling) : mem.freeBytes;
    // The room the rest of the machine keeps, scaled to the machine: a floor so
    // a small node is never squeezed to nothing, a fraction so a big one is
    // never left with the 11% that was measured to be fatal.
    const headroomFor = (free) => Math.max(NODE_SYS_RESERVE, free * NODE_HEADROOM_FRACTION);
    const fits = (free) => free > 0 && needBytes + headroomFor(free) <= free;

    if (fits(freeBytes)) return null;

    /* ---- UNLOAD BEFORE LOAD, and WAIT for the memory to actually come back.
     *
     * The alternative — which is what happened — is firing a second load on
     * top of the first and letting the machine arbitrate. It cannot: a second
     * runner beside a 100 GB one is not a slow request, it is a dead box.
     *
     * Only attempted when it could possibly help, so the node is never poked
     * for nothing, and only when the answer would otherwise be a refusal —
     * which makes unloading strictly better than the alternative rather than
     * something done to a machine behind the operator's back.
     * ------------------------------------------------------------------- */
    let waited = null;
    if (mayUnload && loaded.length && fits(freeBytes + residentBytes)) {
        const names = loaded.map(m => m.name || m.model).filter(Boolean);
        note(`${names.join(", ")} still ${names.length === 1 ? "holds" : "hold"} ` +
             `${gbOf(residentBytes)} on ${s.label} — asking it to unload before ` +
             `${s.model} is loaded`);
        for (const name of names) {
            // Ollama's documented unload: a generate with keep_alive 0. No
            // prompt, so nothing is generated and nothing is loaded.
            await askNode(s, "/api/generate", { method: "POST", timeoutMs: 8000,
                body: JSON.stringify({ model: name, keep_alive: 0 }) });
        }
        const t0 = Date.now();
        let free2 = freeBytes, resident2 = residentBytes, lastNote = 0;
        while (Date.now() - t0 < UNLOAD_WAIT_MS) {
            await new Promise(r => setTimeout(r, UNLOAD_POLL_MS));
            if (cancelled()) throw STOPPED();
            const [psN, memN] = await Promise.all([askNode(s, "/api/ps"), measureNodeMemory(s)]);
            const still = (psN.json && Array.isArray(psN.json.models)) ? psN.json.models : [];
            resident2 = still.reduce((n, m) => n + (Number(m.size) || 0), 0);
            const ceil2 = memN.totalBytes > 0
                ? Math.max(0, memN.totalBytes - resident2) : 0;
            // AND THE POINT OF WAITING: /api/ps going empty is Ollama letting
            // go, which is not the kernel handing the pages back. The wait ends
            // when the MEMORY returns, not when the bookkeeping says it should
            // have.
            free2 = memN.freeBytes
                ? (ceil2 ? Math.min(memN.freeBytes, ceil2) : memN.freeBytes)
                : 0;
            if (free2 && fits(free2)) {
                waited = { waited: true, waitedMs: Date.now() - t0, unloaded: names,
                           freeBytes: free2 };
                note(`memory came back after ${Math.round(waited.waitedMs / 1000)}s — ` +
                     `${gbOf(free2)} free, loading ${s.model}`);
                return waited;
            }
            // One line every ten seconds, not one every poll: a progress report
            // that scrolls thirty-six times is noise, and noise is how a real
            // one gets missed.
            if (Date.now() - lastNote >= 10_000) {
                lastNote = Date.now();
                note(`waiting for ${names.join(", ")} to leave memory on ${s.label} — ` +
                     (free2 ? `${gbOf(free2)} free of the ` +
                              `${gbOf(needBytes + headroomFor(free2))} ${s.model} needs`
                            : "its free memory cannot be read at the moment") +
                     `, ${Math.round((Date.now() - t0) / 1000)}s`);
            }
        }
        throw new ToolError(
            `${s.model} cannot be loaded onto ${s.label} yet. ${held()}; it was asked ` +
            `to unload and after ${Math.round(UNLOAD_WAIT_MS / 1000)}s the machine ` +
            (free2
                ? `still reports only ${gbOf(free2)} free, against the ${gbOf(needBytes)} ` +
                  `this load needs plus ${gbOf(headroomFor(free2))} the rest of the ` +
                  `machine has to keep`
                : `still will not say how much memory it has free`) +
            `. Nothing was sent — a second load on top of the first is what took this ` +
            `machine down.`);
    }

    /* ---- refused, with the numbers that were actually measured ---- */
    const age = mem.freeAt ? Math.max(0, Math.round((Date.now() - mem.freeAt) / 1000)) : null;
    throw new ToolError(
        `${s.model} does not fit on ${s.label} right now: it is ${gbOf(sizeBytes)} on ` +
        `disk and loading it needs about ${gbOf(needBytes)}, but ${s.label} reports ` +
        `${gbOf(freeBytes)} actually free` +
        (mem.freeFrom ? ` (${mem.freeFrom}${age !== null ? `, ${age}s ago` : ""})` : "") +
        (mem.totalBytes ? `, of ${gbOf(mem.totalBytes)} total` : "") +
        (residentBytes ? `, ${held()}` : "") +
        `, and ${gbOf(headroomFor(freeBytes))} of that has to stay free or the machine ` +
        `stops answering rather than slowing down. Nothing was sent. Free memory on ` +
        `the node, or pick a smaller build.`);
}

/* DOES THIS SERVING DOCUMENT reasoning_effort? Answered from the provider's
 * OWN capability tags captured at link/refresh time (DeepInfra publishes the
 * literal tag "reasoning_effort" per model). Three honest states:
 *   tags known, tag present  -> send it
 *   tags known, tag absent   -> never send it — the provider said not to
 *   tags unknown (host publishes none) -> send it; the strip-and-retry net
 *                                         catches a serving that rejects it
 */
/* WOULD THIS SERVER REJECT AN UNKNOWN FIELD? That is a question about the
 * WIRE, not about who owns the machine. Ollama rejects unknown body fields,
 * and a pasted LAN Ollama or a rented Ollama box does exactly the same as the
 * operator's own — but isNodeEndpoint answers "is this hardware yours", which
 * is a different question that happens to correlate. The shape recorded at
 * probe time is the honest signal. */
/** Ollama specifically — the only serving with an `options` block. */
function isOllamaShape(ep) {
    return !!(ep && ep.shape === "ollama");
}

function isStrictBodyShape(ep) {
    return !!(ep && (ep.shape === "ollama" || isNodeEndpoint(ep)));
}

/*
 * DOES THIS SERVING TAKE A tools ARRAY?
 *
 * Three sources, in order of authority: a serving that has already REFUSED
 * one (remembered below, so it is asked once and never again), the provider's
 * own published capability (DeepInfra tags 147 of its 360 models "tools"), and
 * otherwise yes — try it, because the only way to find out about a node is to
 * ask, and the refusal path is cheap and remembered.
 */
const toolsRefused = new Set();          // "<endpointId>|<model>"

function toolsSupported(s) {
    if (!s || !s.model) return false;
    if (toolsRefused.has(`${s.id}|${s.model}`)) return false;
    const can = modelCan(s, "tools");
    return can === false ? false : true;
}

/** Forget what a serving refused — its catalogue changed, so ask again.
 *  Without this a model upgraded on the node (or re-pulled with tool support)
 *  stayed marked as refusing for the life of the process. */
function clearToolsRefused(endpointId) {
    for (const k of [...toolsRefused]) {
        if (k.startsWith(String(endpointId) + "|")) toolsRefused.delete(k);
    }
}

/** Remember a serving that rejected the tools array, so it is asked once. */
function rememberToolsRefused(s) {
    if (s && s.id && s.model) toolsRefused.add(`${s.id}|${s.model}`);
}

/** A mode switch changed what a node SERVES — write the new truth directly.
 *  Used by the Spark-mode switch: the recipe defines the model and window, so
 *  the store reflects it immediately instead of waiting on a probe. */
function setEndpointModels(endpointId, records) {
    const store = readStore();
    const r = store.endpoints[String(endpointId)];
    if (!r) return false;
    r.models = records;
    r.allModels = records.slice();
    writeStore(store);
    return true;
}

function effortSupported(s) {
    // OLLAMA rejects unknown body fields, so it never gets an optional one. But
    // a llama.cpp or vLLM node is NOT strict this way — measured, both answer 200
    // to reasoning_effort — so lumping every NODE in here silently suppressed the
    // operator's own effort setting on their own driver. Only Ollama gates.
    if (isOllamaShape(s)) return false;
    const rec = modelRecordFor(s);
    // TAGS ARE ONLY AN ANSWER WHERE THE HOST SPEAKS THIS VOCABULARY. Treating
    // any tag list as an authoritative declaration would silently suppress the
    // field on a host that tags its models for some unrelated purpose. The
    // capability vocabulary is DeepInfra's documented one; a list that shows
    // none of it is not a statement about reasoning_effort at all.
    if (!rec || !Array.isArray(rec.tags) || !rec.tags.length) return true;
    const known = ["chat", "reasoning", "reasoning_effort", "vision", "vlm",
                   "prompt_cache", "embed", "image-gen", "tts", "stt", "video-gen"];
    const speaks = rec.tags.some(t => known.includes(String(t).toLowerCase()));
    if (!speaks) return true;
    return rec.tags.includes("reasoning_effort");
}

/*
 * THE PROVIDER'S ERROR, IN A SENTENCE — not its JSON.
 *
 * OpenAI-compatible hosts do not agree on one error shape. DeepInfra alone
 * emits four: {"error":{message,type,param,code}}, {"detail":"..."} for auth,
 * {"detail":{"error":...}} for a missing model, and FastAPI's validation
 * array {"detail":[{loc,msg,type}]}. The old path printed the raw body, so
 * the operator read literal JSON at the one moment something had gone wrong.
 *
 * 429 gets its own reading because the two meanings are different actions:
 * capacity (wait) versus the documented fail_fast "engine_overloaded" (the
 * model is busy right now; nothing was billed).
 */
function explainProviderError(status, body, label) {
    let j = null;
    try { j = JSON.parse(body); } catch { /* not JSON — the raw text is all there is */ }
    let msg = "";
    if (j) {
        const d = j.detail;
        if (typeof d === "string") msg = d;
        else if (Array.isArray(d)) {
            msg = d.map(x => x && (x.msg || x.message)).filter(Boolean).join("; ");
        } else if (d && typeof d === "object") {
            msg = (d.error && (d.error.message || d.error)) || d.message || "";
            if (typeof msg === "object") msg = JSON.stringify(msg).slice(0, 200);
        }
        if (!msg && j.error) {
            msg = typeof j.error === "string" ? j.error
                : (j.error.message || j.error.code || j.error.type || "");
        }
        if (!msg && typeof j.message === "string") msg = j.message;
    }
    if (!msg) msg = String(body || "").trim().slice(0, 300);
    const code = j && ((j.error && j.error.code) || j.code);
    if (status === 429) {
        return String(code) === "engine_overloaded"
            ? `${label} is busy right now (engine_overloaded) — nothing was ` +
              `billed. Try again, or pick another model.`
            : `${label} is rate limiting this request` + (msg ? `: ${msg}` : "") +
              ". Wait a moment and try again — its limit is per model, so " +
              "another model may answer immediately.";
    }
    if (status === 401 || status === 403) {
        return `${label} rejected the key` + (msg ? `: ${msg}` : "") +
            ". Paste it again on the endpoint card.";
    }
    if (status === 422) {
        return `${label} refused the request shape` + (msg ? `: ${msg}` : "") + ".";
    }
    if (status === 404) {
        return `${label} has no such model` + (msg ? `: ${msg}` : "") + ".";
    }
    return `${label} returned ${status}` + (msg ? `: ${msg}` : "") + ".";
}

/** The stored sheet for the model a selection names, if the endpoint has one. */
function modelRecordFor(s) {
    if (!s || !s.model) return null;
    const list = Array.isArray(s.models) && s.models.length ? s.models : null;
    if (!list) return null;
    return list.find(m => m && m.id === s.model) || null;
}

/*
 * WHAT THIS MODEL CAN DO, ACCORDING TO THE PROVIDER — never inferred from its
 * name. Three honest answers, because "we were not told" is not "no":
 *   true   the provider published the capability
 *   false  the provider published its list and this is not on it
 *   null   nothing published; the caller decides what to assume
 *
 * Two vocabularies are merged because DeepInfra serves two: the OpenAI list's
 * metadata.tags (chat, vision, reasoning, reasoning_effort, prompt_cache,
 * embed, image-gen, tts, stt, video-gen) and /models/list's feature tags
 * (tools, json, structured-output, multimodal, ocr, can-disable-reasoning).
 */
const CAPABILITY_TAGS = {
    tools: ["tools"],
    structuredOutput: ["structured-output", "structured_output", "json"],
    vision: ["vision", "vlm", "multimodal"],
    reasoning: ["reasoning"],
    reasoningEffort: ["reasoning_effort"],
    promptCache: ["prompt_cache"],
    chat: ["chat"],
    ocr: ["ocr"]
};
/* WHICH SHEET CARRIES WHICH CAPABILITY. The two vocabularies are not
 * interchangeable: /v1/openai/models publishes the capability TAGS (chat,
 * vision, reasoning, reasoning_effort, prompt_cache) and /models/list
 * publishes the FEATURE tags (tools, structured-output, json, multimodal,
 * ocr). Merging them and answering from whichever happened to be present made
 * "tools" read as FALSE for every model whose features had not been captured
 * — a confident no, on no evidence, silently disabling native tool calling. */
const CAPABILITY_SOURCE = {
    tools: "features", structuredOutput: "features", ocr: "features",
    chat: "tags", vision: "both", reasoning: "both",
    reasoningEffort: "tags", promptCache: "tags"
};
function modelCan(s, capability) {
    const rec = modelRecordFor(s);
    if (!rec) return null;
    const want = CAPABILITY_TAGS[capability];
    if (!want) return null;
    const src = CAPABILITY_SOURCE[capability] || "both";
    const tags = Array.isArray(rec.tags) ? rec.tags : null;
    const feats = Array.isArray(rec.features) ? rec.features : null;
    const pool = [];
    if (src === "tags" || src === "both") { if (tags) pool.push(...tags); }
    if (src === "features" || src === "both") { if (feats) pool.push(...feats); }
    // the sheet that would carry this answer was never captured: unknown, not no
    const havesheet = (src === "tags" && tags) || (src === "features" && feats)
        || (src === "both" && (tags || feats));
    if (!havesheet || !pool.length) return null;
    const all = pool.map(t => String(t).toLowerCase());
    return want.some(w => all.includes(w));
}

/**
 * Retired by the provider — with somewhere to go.
 *
 * `replaced_by` is set on maybe a third of DeepInfra's retired models, and it
 * was the only successor this reported. So a model whose entry has none read
 * as a dead end, and the user was told their model was gone with no way
 * forward — about a FAMILY that is very much alive:
 *
 *   google/gemini-1.5-flash-8b   retired, no replaced_by
 *   google/gemini-2.5-flash      live
 *   google/gemini-3.5-flash      live
 *   google/gemini-3.1-flash-lite live
 *
 * A model still listed as available on the provider's own model library page,
 * yet reported as gone — correct on the user's side, and the answer that named
 * only the exact retired id was the stale one.
 *
 * When the provider names a successor, that wins. Otherwise the live models
 * sharing this one's publisher and family stem are offered, newest first —
 * from the catalogue that was just fetched, never from memory.
 */
function modelRetirement(s) {
    const rec = modelRecordFor(s);
    if (!rec || !rec.deprecated) return null;
    const out = { at: rec.deprecated, replacedBy: rec.replacedBy || null, siblings: [] };
    if (out.replacedBy) return out;
    try {
        const id = String(rec.id || rec.model || s.model || "");
        const slash = id.indexOf("/");
        const publisher = slash > 0 ? id.slice(0, slash) : "";
        const rest = slash > 0 ? id.slice(slash + 1) : id;
        // "gemini-1.5-flash-8b" -> stem "gemini", trait "flash"
        const parts = rest.split("-").filter(Boolean);
        const stem = (parts[0] || "").toLowerCase();
        const traits = new Set(parts.slice(1)
            .filter(p => !/^[0-9.]+$/.test(p) && !/^\d+b$/i.test(p))
            .map(p => p.toLowerCase()));
        if (!stem) return out;
        // the endpoint's OWN captured sheet — the same rows modelRecordFor
        // reads, so a suggestion can never name a model this endpoint does
        // not actually serve
        const sheet = Array.isArray(s.models) ? s.models : [];
        const live = sheet.filter(m => {
            if (!m || m.deprecated) return false;
            const mid = String(m.id || "");
            if (mid === id) return false;
            if (publisher && !mid.startsWith(publisher + "/")) return false;
            const tail = mid.slice(mid.indexOf("/") + 1).toLowerCase();
            if (!tail.startsWith(stem)) return false;
            // a trait the operator was clearly relying on — "flash", "mini",
            // "pro" — is respected when the retired id carried one
            if (traits.size && ![...traits].some(t => tail.includes(t))) return false;
            return true;
        }).map(m => String(m.id));
        // newest-looking last-in-name first: 3.5 before 2.5 before 1.5
        const verOf = (x) => {
            const v = /(\d+(?:\.\d+)?)/.exec(x.slice(x.indexOf("/") + 1));
            return v ? parseFloat(v[1]) : 0;
        };
        out.siblings = live.sort((a, b2) => verOf(b2) - verOf(a)).slice(0, 4);
    } catch { /* a suggestion is a courtesy; never break the report for it */ }
    return out;
}

// async, because the egress gate may AWAIT a blocking secret-egress prompt
// before a byte is sent. Its send-and-stream body still returns a Promise, which
// an async function flattens; callers (sendFitting) already await it.
async function streamChatOnce(messages, opts = {}) {
    // `let`, because timeoutMs is resolved below once the endpoint is known —
    // a machine of the user's own gets more first-token patience
    let {
        onReasoning = () => {}, onOutput = () => {}, onReclassify = () => {},
        onNote = () => {},
        cancelToken = { cancelled: false },
        maxTokens = 2048, temperature = 0.2, timeoutMs = null
    } = opts;

    // THE SESSION'S OWN SELECTION WINS. resolveSelection hands this in per
    // turn; absent means the old behavior — the global role — so every
    // existing caller (escalation, tests, the reasoner) is untouched.
    const s = opts.selection || selectedFor(opts.role || "driver");
    if (!s) throw new ToolError(`no cloud model is assigned to the ${opts.role || "driver"} role`);
    requireNetwork();
    const pre = PRESETS.find(p => p.id === s.preset);
    const needsKey = pre ? pre.needsKey : !isLocalHost(new URL(s.baseUrl).hostname);
    const key = getKey(s.id);
    if (needsKey && !key) throw new ToolError(`${s.label} needs an API key — paste one in settings`);

    /* HOW BIG A WINDOW TO ASK FOR — the conversation's, not the model's.
     *
     * Sending the ARCHITECTURAL maximum was the obvious fix and the wrong one.
     * R1-70B publishes 163,840, and on a Spark node the weights already hold
     * ~40 GB of 128 GB; a KV cache for 163k tokens on an 80-layer 70B is tens
     * of gigabytes more. Ollama would allocate it for the word "hello", and a
     * box that starts swapping is slower than the 4,096 default we were trying
     * to escape. Fixing a truncation by causing a stall is not fixing it.
     *
     * So: ask for what THIS request needs — the prompt, plus room for the
     * reply, plus a margin — rounded up to a 4k step so a growing conversation
     * reuses the same allocation for a while instead of resizing every turn,
     * and never past what the model can do. Long conversations still get a big
     * window; short ones cost nothing.
     */
    const windowNeeded = (() => {
        const chars = messages.reduce((t, m) => t + String(m.content || "").length, 0);
        const est = Math.ceil(chars / 3.6) + Math.max(512, maxTokens) + 1024;
        const stepped = Math.ceil(est / 4096) * 4096;
        const ceiling = Math.round(opts.numCtx) || 0;
        if (!ceiling) return 0;
        return Math.max(4096, Math.min(stepped, ceiling));
    })();

    // REASONING EFFORT — for ALL modes, not just API — computed BEFORE the
    // body because max_tokens depends on whether it is being sent.
    //   API / rented GPU: sends reasoning_effort in the body.
    //   Local nodes (Ollama): maps to temperature (router.js).
    //   Local (llama.cpp): handled in engine.js via the same session field.
    // The session's effortLevel (0-4) controls this.
    // EFFORT_OPENROUTER_ONLY: "max"/"xhigh" are OpenRouter's enum; DeepInfra
    // and OpenCode canonical is low|medium|high (openrouter.ai/docs/use-cases/
    // reasoning-tokens vs docs.deepinfra.com/chat/overview). Clamp off OpenRouter.
    // effortSupported answers both halves: a serving that rejects unknown
    // fields (Ollama wire shape) and a model whose published tags exclude it.
    const EFFORT_API = [undefined, "low", "medium", "high", "max"];
    const _effRaw = opts.session && typeof opts.session.effortLevel === "number"
        ? EFFORT_API[opts.session.effortLevel] : undefined;
    const _isOR = /openrouter\.ai/i.test(String(s.baseUrl || ""));
    const effortWord = (_effRaw === "max" && !_isOR) ? "high" : _effRaw;
    const effortOut = !!(effortWord && !opts.stripEffort && effortSupported(s));
    // REASONING NEEDS HEADROOM. On hosted reasoning models the cap covers the
    // hidden reasoning FIRST, then visible output — measured on the operator's
    // own accounts: gpt-5.x-codex under a small cap returns an EMPTY completion
    // (reasoning ate the whole budget). When effort is being sent to a hosted
    // endpoint, floor the cap so the visible answer survives the thinking.
    // A cap is a ceiling on billing, not a target — this does not spend 8k,
    // it ALLOWS the model to finish. (openrouter.ai/docs/use-cases/reasoning-tokens)
    const REASONING_FLOOR = 8192;
    // THE NODE IS EXACTLY WHERE THE FLOOR WAS NEEDED, AND IT WAS SKIPPED.
    // This was `effortOut && !s.localNode` — floored a hosted reasoner but
    // never the user's own node, which is precisely the machine running
    // gpt-oss-120b. gpt-oss reasons by default (medium) EVEN WHEN no
    // reasoning_effort is sent, so effortOut is false there and a 2k-4k cap
    // was consumed inside the chain of thought, returning empty visible
    // content — the "spent its whole reply thinking" flood in the node logs.
    // max_tokens is n_predict, a generation CEILING, not a preallocation: KV
    // is governed by num_ctx / the server's -c, so flooring it costs no memory,
    // llama.cpp still truncates at the remaining window, and the model still
    // stops at its own EOS. So floor for a node too, regardless of effortOut.
    const capTokens = ((effortOut && !s.localNode) || s.localNode)
        ? Math.max(maxTokens, REASONING_FLOOR) : maxTokens;

    let body = JSON.stringify({
        model: s.model, messages, stream: true,
        max_tokens: capTokens, temperature,
        ...(effortOut ? { reasoning_effort: effortWord } : {}),
        // ASK THE NODE TO COUNT. An Ollama stream sends no usage block unless
        // asked, so every node turn was booked as `attempt-unbilled 0/0` — a
        // real answer recorded as if nothing happened, which is also exactly
        // the row shape a masked failure wears. Asked for on the operator's
        // own machines only: hosted providers already count unasked, and a
        // strict one rejecting an unknown field would kill a paid call over
        // bookkeeping it was already doing.
        ...(isStrictBodyShape(s) ? { stream_options: { include_usage: true } } : {}),
        /* TELL OLLAMA HOW BIG THE WINDOW IS, OR IT PICKS ONE.
         *
         * Ollama serves with num_ctx from its own configuration — 4,096 by
         * default — no matter what the model supports. .lcl sized every prompt
         * to the model's ARCHITECTURAL window (163,840 for R1-70B, or a 32k
         * assumption when nothing published one) and sent it to the
         * OpenAI-compatible route, which has no field for the window. Ollama
         * then silently dropped everything past its own default.
         *
         * That is why a 70B on a capable node answered as though it had seen
         * almost nothing: it HAD seen almost nothing. `options` is Ollama's
         * own field and is only ever sent to an Ollama-shaped serving, and the
         * number is windowNeeded above — this conversation's size, not the
         * model's maximum, for the memory reason argued there.
         */
        ...(isOllamaShape(s) && windowNeeded > 0
            ? { options: { num_ctx: windowNeeded } } : {}),
        /* NATIVE TOOL CALLING, where the model was trained for it.
         *
         * The text protocol (tools described in the system prompt, a fenced
         * JSON call expected back) is what a REASONING model quietly ignores:
         * measured on the operator's repository, deepseek-r1:70b wrote "1.
         * First, I'll list all files:" six times, called nothing, and then
         * invented the results. Every OpenAI-compatible host takes a tools
         * array instead, and the model answers with a structured call that
         * cannot be confused with prose.
         *
         * Sent only when the caller asked for it AND nothing has recorded this
         * serving refusing it — see the retry in streamChat, which remembers.
         */
        ...(Array.isArray(opts.tools) && opts.tools.length && !opts.noTools
            && toolsSupported(s)
            ? { tools: opts.tools, tool_choice: "auto" } : {})
    });
    // what we are about to send, in characters — used after the call to learn
    // this model's real characters-per-token from the provider's own count
    const promptChars = messages.reduce((n, m) => n + String(m.content || "").length, 0);

    // THE EGRESS GATE, over the whole payload — but a gate that REDACTS, not
    // one that detonates. This used to be assertNoLeak, a hard throw: the
    // model read a repo that contained a real key, the key rode into the
    // prompt, and the WHOLE TURN died — taking fifty successful tool reads
    // with it, because a failed turn persists nothing. The product's standing
    // rule is the design: read freely, never expose, tell the user.
    // So the secret leaves the payload, a placeholder marks where it was, the
    // model is told why, and the work continues.
    let redactedNote = null;
    let secretsSent = null;              // reported to the caller, never the value
    const dest = destinationOf(s);
    // THE SESSION MAY LIFT THIS, AND ONLY THE SESSION.
    //
    // A per-session grant exists so a user never has to edit .lcl's own logic
    // just to do something minor the default restriction was getting in the way
    // of.
    //
    // A standing global switch would be worn permanently and forgotten; this
    // is per session, defaults off, and never inferred from anything the model
    // said. It arrives as opts.allowSecrets from the session record.
    const allowSecrets = opts.allowSecrets === true;
    {
        if (allowSecrets) {
            // SHARED, AND A SECRET IS ABOUT TO LEAVE. The toggle being on is a
            // STANDING GRANT, not a licence to send silently. The design is to
            // PROMPT at the moment it actually happens, and block until the user
            // answers: prompt first, and hold until the prompt is
            // acknowledged. When an asker is wired we ask and act on the
            // verdict; a broken asker fails CLOSED (redact, never send on a
            // broken prompt); a headless path with no asker lets the standing
            // grant stand and sends, which is also what the toggle's tests assert.
            const found = secretGuard.inspect(body);
            if (found.blocked) {
                let action = "send";
                if (typeof opts.approveSecretEgress === "function") {
                    try {
                        const verdict = await opts.approveSecretEgress({
                            reasons: found.reasons.slice(0, 3), destination: dest });
                        action = (verdict && verdict.action) || "redact";
                    } catch { action = "redact"; }
                }
                if (action === "cancel") {
                    const err = new Error(
                        `send cancelled: a secret was about to leave to ${dest.label}`);
                    err.code = "SECRET_EGRESS_CANCELLED";
                    throw err;
                } else if (action === "redact") {
                    const clean = secretGuard.redactKnown(secretGuard.redact(body));
                    if (clean !== body) {
                        redactedNote = `a secret was held back and redacted — ${dest.label} ` +
                            "received a placeholder, never the value";
                        body = clean;
                    }
                    secretGuard.assertNoLeak(body, `this request to ${dest.label}`);
                } else {
                    // SEND — counted and named, with the destination, so "did it
                    // leave?" has an answer afterwards. The REASONS, never the
                    // value: the log must not become the second place it lives.
                    secretsSent = { reasons: found.reasons.slice(0, 3), destination: dest };
                    redactedNote = "this session allowed a secret to be sent to " +
                        `${dest.label}` +
                        (dest.owned ? " — your own hardware" : " — a third party");
                }
            }
        } else {
            // shape-based first, then the remembered store — a bare value quoted
            // mid-prompt has no shape, and only the store knows it
            const clean = secretGuard.redactKnown(secretGuard.redact(body));
            if (clean !== body) {
                redactedNote = 'a secret (API key or credential) was found in this ' +
                    'conversation and REDACTED before sending — ' +
                    (dest.owned
                        ? `${dest.label} received a placeholder, never the value`
                        : `${dest.label} received a placeholder, never the value`);
                body = clean;
            }
            // if the inspector still sees a leak after redaction, the old hard
            // refusal is the right answer — never send what cannot be cleaned
            secretGuard.assertNoLeak(body, `this request to ${dest.label}`);
        }
    }

    // THE DOOR, WHEN THE ROAD IS CLOSED. A node's direct address dies under a
    // full-tunnel VPN; its door is plain HTTPS and survives. The door proxies
    // paths verbatim, so only the host changes — the path is always the direct
    // endpoint's. The door token is a transport credential, never the API key.
    const doorToken = s.relayUrl ? getKey(s.id + "::door") : null;
    const hasDoor = !!(s.relayUrl && doorToken);

    const mkTarget = (viaDoor) => {
        const u = new URL(viaDoor ? s.relayUrl : s.baseUrl);
        const isHttps = u.protocol === "https:";
        return {
            viaDoor,
            lib: isHttps ? https : http,
            host: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            // THE DOOR IS RESOLVED THE WAY THE INTERNET RESOLVES IT.
            //
            // With Tailscale running locally, MagicDNS answers the door's
            // funnel name with the node's PRIVATE tailnet address, so the one
            // route built to survive a full-tunnel VPN was being dialled
            // straight back into the tunnel. Measured: EACCES to 100.64.0.1
            // while ordinary internet worked perfectly.
            lookup: viaDoor ? publicDns.lookup : lookupOffThreadPool,
            path: new URL(s.baseUrl).pathname.replace(/\/+$/, "")
                + apiPrefixOf(s) + "/chat/completions",
            auth: viaDoor ? `Bearer ${doorToken}` : (key ? `Bearer ${key}` : null)
        };
    };

    // A MACHINE OF YOUR OWN GETS TIME TO LOAD. Five minutes of silence is
    // generous for a hosted API and nothing at all for a 100 GB model coming
    // off someone's own disk — mistral-large q6_K measured past it. The
    // operator's node gets fifteen minutes of first-token patience; a paid
    // endpoint keeps five, because there a long silence really does mean
    // something is wrong. Stop works throughout either way.
    if (timeoutMs == null) timeoutMs = isNodeEndpoint(s) ? 900_000 : 300_000;

    // A CALL MUST START ANSWERING, OR RESOLVE — NEVER HANG OPEN-ENDED.
    //
    // timeoutMs above is the whole-call inactivity leash (15 min on a node, so a
    // model loading off disk is never cut). But a node that took the request and
    // then goes SILENT forever used to sit blank for the full 15 minutes with no
    // answer and no error — measured live: a 70k-token prompt on gpt-oss-120b sat
    // ~12 min and was killed by hand. That is not usable for handing real work to
    // the box. So the leash is split: until the FIRST token arrives the call has
    // firstTokenMs (6 min on a node — generous for a cold load + a normal prefill,
    // but bounded so a dead call fails in minutes, not fifteen); the instant the
    // model starts answering, markFirstToken relaxes the socket back to the full
    // timeoutMs so slow GENERATION is never cut. A first-token stall then fails
    // with a coded, actionable reason (below), not an open-ended hang. Hosted
    // endpoints are unchanged — their first-token budget stays the whole timeout.
    const firstTokenMs = opts.firstTokenMs != null ? Number(opts.firstTokenMs)
        : (isNodeEndpoint(s) ? 360_000 : timeoutMs);

    return new Promise((resolve, reject) => {
        let settled = false;
        // whatever the caller had on the token before this turn borrowed it
        const priorAbort = cancelToken.abort;
        const done = (fn, arg) => {
            if (settled) return;
            settled = true;
            cancelToken.abort = priorAbort;      // the socket is gone; stop pointing at it
            // EVERY failed call leaves a line, however it died. The two
            // response-path sites keep their richer records and stamp
            // apiErrRecorded so nothing writes twice; a stop by the
            // operator's own hand is not an API error.
            if (fn === reject && arg && !arg.apiErrRecorded && !cancelToken.cancelled) {
                recordApiError({ endpoint: s.label, endpointId: s.id, model: s.model,
                    kind: arg.failKind || (arg.midStream ? "dropped-midstream" : "transport"),
                    status: Number(arg.status) || 0,
                    providerError: String((arg && arg.message) || arg).slice(0, 800),
                    ...requestShape(messages, opts) });
            }
            fn(arg);
        };
        let output = "", reasoning = "", usage = null, buf = "";
        // WHY THE MODEL STOPPED. "length" means the answer was CUT at the token
        // cap — the local engine has always reported it (engine.js) and the
        // hosted path never read it, so a truncated reply reached the
        // transcript, and the agent loop, dressed as a complete one.
        let finishReason = null;
        const toolCalls = [];      // native calls, assembled from their fragments

        // FIRST-TOKEN TELEMETRY. A big prompt on a local node prefills for a
        // long time emitting NOTHING — no reasoning, no output — so the chat
        // looks frozen and finished while the model is actually reading the
        // context. Measured live on the operator's node: a 64,668-token prompt
        // sat ~7 minutes with a blank chat and only the Stop button to show for
        // it. firstTokenAt marks when the silence ends; socketUp marks when the
        // request is answered (vs still connecting) — used by the first-token
        // stall timeout below, not by any note stream.
        let firstTokenAt = 0, socketUp = false, activeReq = null;
        const markFirstToken = () => {
            if (firstTokenAt) return;
            firstTokenAt = Date.now();
            // the model is answering — relax from the first-token budget to the
            // full inactivity leash so slow token-by-token generation is never cut
            if (activeReq) { try { activeReq.setTimeout(timeoutMs); } catch { /* socket gone */ } }
        };

        const splitter = createThinkSplitter({
            onReasoning: (t) => { markFirstToken(); reasoning += t; onReasoning(t); },
            onOutput: (t) => { markFirstToken(); output += t; onOutput(t); },
            onReclassify: (t) => {
                output = output.slice(0, output.length - t.length);
                reasoning = t + reasoning;
                onReclassify(t);
            }
        });

        // THE WAIT IS SHOWN BY THE LIVE STATUS BUBBLE, NOT A NOTE STREAM. The
        // renderer already draws one in-place status line for the in-flight turn
        // — the "waiting for the model" phase with a ticking elapsed counter
        // (app.js startProgress) — which is the clean, contained wait indicator.
        // An earlier heartbeat here ALSO pushed an onNote every few seconds, and
        // the renderer records each note as a durable row: it stacked terminal-
        // style lines on top of the live bubble and replayed them on re-render.
        // Removed. firstTokenAt / the first-token stall timeout below still stand
        // on their own; they never needed the note stream.

        // ONE RECORD PER CALL TO A MACHINE THE USER OWNS, closed out
        // however it ends. Not for endpoints belonging to a company — those
        // already have a cost ledger, and their capacity is not the operator's
        // problem. This exists so "did this app do something to my machine, and
        // when" has an answer.
        const isNode = isNodeEndpoint(s);
        const t0 = Date.now();
        let lastRoad = "direct", logged = false;
        const logCall = (outcome, extra) => {
            // CONTRACT K4, LEARNED WHERE IT IS ACTUALLY KNOWN. Every turn dials
            // the machine; the picker does not. So the verdict is recorded on
            // the way past, for EVERY endpoint — a hosted provider that is down
            // is as unofferable as a node that is switched off — while the call
            // log below stays what it always was, a record of the operator's
            // own hardware only.
            // "empty" is a REACHED machine that answered badly — the model
            // failed, the endpoint did not. Marking it offline greyed every
            // other model on that host out of the picker over one bad serving.
            if (outcome === "ok" || outcome === "stopped"
                || outcome === "dropped-midstream" || outcome === "empty") {
                markEndpointOnline(s.id);
            } else if (outcome === "unreachable" || outcome === "timeout" || outcome === "error") {
                markEndpointOffline(s.id, (extra && extra.code)
                    ? `last call failed: ${extra.code}` : "did not answer the last call");
            }
            if (logged || !isNode) return;
            logged = true;
            recordNodeCall({
                endpoint: s.label, endpointId: s.id, model: s.model,
                road: lastRoad, ms: Date.now() - t0, outcome, ...(extra || {})
            });
        };

        const attempt = (target) => {
        lastRoad = target.viaDoor ? "door" : "direct";
        const headers = {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Accept: "text/event-stream"
        };
        if (target.auth) headers.Authorization = target.auth;

        // THE LEASH IS ON GETTING THERE, NOT ON BEING ANSWERED.
        //
        // This was `timeout: leash` on the whole request. Node's `timeout` is
        // SOCKET INACTIVITY, and an OpenAI-compatible server sends nothing at
        // all until generation starts — Ollama loads the weights first. So a
        // model that takes a while to come off disk looked exactly like a dead
        // route. A 123B at q6_K is about 100 GB; it cannot load in six seconds,
        // and it was being cut off at six every single time.
        //
        // Worse than the cut: on timeout the code falls to the OTHER ROAD, and
        // the door and the direct address are two roads to ONE machine. So a
        // second chat request landed on a server already loading a 100 GB
        // model, and the server allocated a second runner for it. On a box with
        // 128 GB of unified memory that is how you take the whole machine down,
        // from a client that only meant to check whether a route was alive.
        //
        // A dead route fails to CONNECT. A slow model connects immediately and
        // then thinks. Those are distinguishable, so distinguish them: the short
        // leash covers connection only, and the moment the socket is up the full
        // inactivity timeout takes over.
        const wantsProbe = (!target.viaDoor && hasDoor);
        let connected = false;
        // THE LEASH BELONGS TO THIS ATTEMPT, SO IT IS DECLARED WITH IT.
        //
        // This used to sit below tryOther, and the only two places that ever
        // cleared it were "the socket connected" and "the request timed out".
        // The ABANDONMENT path was not one of them — and abandonment is the
        // whole reason the door exists. Measured against a stub door
        // answering at 12s, direct address refused instantly:
        //
        //   [  225] door: request received /v1/chat/completions
        //   [ 6228] REJECTED: spark could not be reached directly
        //   [ 6230] open door connections: 1
        //
        // Six seconds after handing off, the dead direct attempt's timer fired,
        // saw its own `connected` false and the SHARED `settled` false, and
        // rejected the entire turn while the door's request was still in
        // flight. The door socket was never destroyed, so the node kept loading
        // for a turn that had already failed; done() had put cancelToken.abort
        // back, so Stop could no longer reach that socket either; and the call
        // log got a line saying a road was unreachable when it had been reached.
        // Hoisted here so tryOther can always reach it.
        let probeTimer = null;
        const clearProbe = () => { if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; } };

        const req = target.lib.request({
            host: target.host,
            port: target.port,
            path: target.path,
            lookup: target.lookup,
            // NO CONNECTION POOLING. Node 19+ turns keep-alive on by default, so
            // the door socket would stay open after a turn ends — leaving the
            // node loading a runner for a turn already done and past Stop's reach
            // (the exact leak described above). A fresh connection per turn ties
            // the socket's lifetime to the turn's; a streamed LLM turn dwarfs the
            // connect cost, so it is free.
            agent: false,
            // START with the first-token budget; markFirstToken relaxes it to the
            // full leash the moment a token arrives, so a stall that never answers
            // resolves in firstTokenMs while real generation keeps the long leash.
            method: "POST", headers, timeout: firstTokenMs
        }, (res) => {
            connected = true;
            socketUp = true;                     // the request is answered; now it's prefill/generation, not connecting
            if (res.statusCode !== 200) {
                let err = "";
                res.on("data", c => { if (err.length < 2000) err += c; });
                res.on("end", () => {
                    // a door that answers 401/403/502 is as dead as one that
                    // refuses the socket — fall back rather than surface its
                    // error as if the model had rejected the request
                    if (target.viaDoor && tryOther()) return;
                    // AUTO-PRUNE DEAD MODELS. DeepInfra's /models endpoint
                    // still lists models it has deprecated (gemini-1.5-flash,
                    // nano-banana-2) even though calling them 404s. So a
                    // refresh brings them right back and the picker keeps
                    // showing dead models. When the provider says "model not
                    // found" or "invalid model", remove it from the endpoint's
                    // stored list so it stops appearing — the picker heals
                    // itself as dead models are encountered.
                    try {
                        // ONLY when the provider actually says the model is
                        // gone. A 500 is a server or REQUEST error — pruning on
                        // it deleted working models from the endpoint's catalog
                        // whenever OUR body broke the call (reasoning_effort on
                        // a serving that rejects it) — a broken request schema on
                        // our side is not the same as the endpoint not existing.
                        // ...and the upstream-definitive retirement sentences —
                        // measured across multiple accounts: OpenCode's catalog carries NO
                        // deprecation flags, so call-time errors are the ONLY
                        // way to learn a model is dead there. Every string here
                        // is a statement about the MODEL, not about our request
                        // shape — a 500/timeout/"provider returned error" stays
                        // un-pruned, per the lesson above.
                        if (res.statusCode === 404
                            || /model_not_found|invalid model|does not exist/i.test(err)
                            || /endpoint is unavailable|model is unavailable|has been deprecated|only available hosted in china/i.test(err)) {
                            pruneModelFromEndpoint(s.id, s.model);
                        }
                    } catch { /* never fail a call over bookkeeping */ }
                    const httpErr = new ToolError(
                        explainProviderError(res.statusCode, scrub(err, key), s.label));
                    // the STATUS rides on the error, so the strip-and-retry
                    // decides on a number instead of pattern-matching a
                    // sentence that is free to be reworded
                    httpErr.status = res.statusCode;
                    httpErr.apiErrRecorded = true;
                    recordApiError({ endpoint: s.label, endpointId: s.id, model: s.model,
                        kind: "http-" + res.statusCode, status: res.statusCode,
                        providerError: scrub(err, key).slice(0, 800), ...requestShape(messages, opts) });
                    done(reject, httpErr);
                });
                return;
            }
            res.setEncoding("utf8");
            // EVERYTHING RECEIVED, KEPT WHOLE. The line parser below consumes
            // SSE frames — but a server that ignores `stream: true` answers
            // with ONE plain JSON completion, which has no "data:" lines, so
            // every byte fell through the parser and a 200 resolved with
            // output "" as if the model had answered silence. Measured on the
            // operator's own store: google/gemini-1.5-flash-8b on DeepInfra,
            // four turns, ~734 ms each, $0 booked, all four persisted empty.
            // ...and kept only while it might still be NEEDED: the moment a
            // frame produces real output there is nothing to re-read, so the
            // buffer is dropped rather than shadowing a whole long answer in
            // memory for the entire stream.
            let rawAll = "";
            res.on("data", (chunk) => {
                if (cancelToken.cancelled) { req.destroy(); return; }
                if (output || reasoning) rawAll = "";
                else if (rawAll.length < 4_000_000) rawAll += chunk;
                buf += chunk;
                let nl;
                while ((nl = buf.indexOf("\n")) !== -1) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line.startsWith("data:")) continue;
                    const payload = line.slice(5).trim();
                    if (payload === "[DONE]") continue;
                    let j;
                    try { j = JSON.parse(payload); } catch { continue; }
                    if (j.usage) usage = j.usage;
                    const ch0 = j.choices && j.choices[0];
                    if (ch0 && ch0.finish_reason) finishReason = ch0.finish_reason;
                    const d = ch0 && ch0.delta;
                    if (!d) continue;
                    // REASONING IS DETECTED FROM THE WIRE, NOT GUESSED FROM THE
                    // HOSTNAME.
                    //
                    // The endpoint's declared field is honoured first, but it was
                    // the ONLY signal, and it is set by testing whether the host
                    // is deepseek.com. So the same DeepSeek R1 and V4 weights
                    // served from api.deepinfra.com — the host this product
                    // actually recommends, because it is US-hosted — came back
                    // with reasoningField null, and every token of chain of
                    // thought was dropped on the floor: never shown, and worse,
                    // never separated from the answer.
                    //
                    // The frame itself says which field it used. Any of these
                    // three is unambiguous — no OpenAI-compatible host puts
                    // ordinary output in them — so whichever one shows up is
                    // adopted for the rest of the stream.
                    let rf = s.reasoningField;
                    if (!rf || typeof d[rf] !== "string") {
                        for (const cand of ["reasoning_content", "reasoning", "thinking"]) {
                            if (typeof d[cand] === "string" && d[cand]) { rf = cand; break; }
                        }
                    }
                    if (rf && typeof d[rf] === "string" && d[rf]) {
                        reasoning += d[rf]; onReasoning(d[rf]);
                    }
                    // TOOL CALLS ARRIVE IN FRAGMENTS, indexed: the name in one
                    // frame, the arguments a character at a time across many.
                    if (Array.isArray(d.tool_calls)) {
                        for (const tc of d.tool_calls) {
                            // INDEX IS OPTIONAL ON THE WIRE. Defaulting a
                            // missing one to 0 collapsed every parallel call
                            // into a single slot, concatenating one call's
                            // arguments onto another's and producing JSON that
                            // parses to nonsense. A frame with no index that
                            // carries a NEW id opens its own slot; a fragment
                            // continuing the current call has neither.
                            let i = Number.isInteger(tc.index) ? tc.index : -1;
                            if (i < 0) {
                                if (tc.id) {
                                    const at = toolCalls.findIndex(x => x && x.id === tc.id);
                                    i = at >= 0 ? at : toolCalls.length;
                                } else {
                                    i = Math.max(0, toolCalls.length - 1);
                                }
                            }
                            const slot = toolCalls[i] || (toolCalls[i] = { id: "", name: "", args: "" });
                            if (tc.id) slot.id = tc.id;
                            if (tc.function && tc.function.name) slot.name = tc.function.name;
                            if (tc.function && typeof tc.function.arguments === "string") {
                                slot.args += tc.function.arguments;
                            }
                        }
                    }
                    if (typeof d.content === "string" && d.content) splitter.push(d.content);
                }
            });
            res.on("end", () => {
                splitter.end();
                // A NON-STREAM ANSWER IS STILL AN ANSWER. If the SSE parser
                // produced nothing, read the whole body as one plain JSON
                // completion — choices[0].message — before judging the call.
                let statedError = null;
                if (!output && !reasoning && rawAll.trim()) {
                    try {
                        const j = JSON.parse(rawAll);
                        const c0 = j.choices && j.choices[0];
                        const m = c0 && c0.message;
                        if (c0 && c0.finish_reason) finishReason = c0.finish_reason;
                        if (m && Array.isArray(m.tool_calls)) {
                            m.tool_calls.forEach((tc, i) => {
                                toolCalls[i] = { id: tc.id || "",
                                    name: (tc.function && tc.function.name) || "",
                                    args: (tc.function && tc.function.arguments) || "" };
                            });
                        }
                        if (j.usage) usage = j.usage;
                        // A 200 CARRYING AN ERROR OBJECT HAS ALREADY SAID WHY.
                        // Reporting "sent no content" over the provider's own
                        // sentence throws away the one useful fact in the body.
                        const e = j.error || (j.choices && j.choices[0]
                                              && j.choices[0].error);
                        if (e) {
                            statedError = typeof e === "string" ? e
                                : (e.message || e.type || JSON.stringify(e).slice(0, 300));
                        }
                        if (m) {
                            for (const cand of ["reasoning_content", "reasoning", "thinking"]) {
                                if (typeof m[cand] === "string" && m[cand]) {
                                    reasoning += m[cand]; onReasoning(m[cand]); break;
                                }
                            }
                            // THROUGH THE SPLITTER, exactly like the streamed
                            // path. An R1-class model writes its chain of
                            // thought inline in <think> tags with no separate
                            // field; emitting content raw here would put that
                            // reasoning in the ANSWER, where the agent loop
                            // parses tool calls out of it — the precise
                            // failure createThinkSplitter exists to prevent.
                            if (typeof m.content === "string" && m.content) {
                                splitter.push(m.content);
                                splitter.end();
                            }
                        }
                    } catch { /* not JSON either — falls to the empty check */ }
                }
                // SILENCE IS A FAILURE, NOT AN ANSWER. A 200 that delivered no
                // content and no reasoning must reject like any other dead
                // call — resolving it let four empty replies persist as real
                // assistant messages with no error anywhere. A stop mid-turn
                // is the user's own hand and keeps resolving.
                if (!output && !reasoning && !toolCalls.filter(t => t && t.name).length
                    && !cancelToken.cancelled) {
                    // THE MACHINE ANSWERED. Marking it offline here inverted
                    // CONTRACT K4 — one empty reply from one model greyed
                    // EVERY model on that endpoint out of the picker, on the
                    // strength of a round trip that demonstrably worked.
                    markEndpointOnline(s.id);
                    logCall("empty", { code: "empty-200" });
                    // AND IT MAY HAVE BILLED. The provider often sends a usage
                    // block with an empty completion; dropping it lost a real
                    // charge from the ledger and denied the estimator the
                    // token counts it had already been given.
                    let emptyCost = null;
                    if (usage && usage.prompt_tokens > 0) {
                        try { tokenCost.learnRatio(s.model, promptChars, usage.prompt_tokens); }
                        catch { /* never fail over a forecast */ }
                        try { tokenCost.learnRateFromActual(s.model, usage); }
                        catch { /* never fail over a rate update */ }
                        try {
                            emptyCost = tokenCost.actualCost(s.model, usage, null,
                                { localNode: isNodeEndpoint(s) });
                        } catch { emptyCost = null; }
                    }
                    // ...and if the provider's own catalogue says this model
                    // is retired, that is very likely the whole answer. Say it
                    // here rather than leaving the operator to wonder.
                    let why = "";
                    try {
                        const gone = modelRetirement(s);
                        if (gone) {
                            why = ` ${s.label} lists this model as RETIRED` +
                                (gone.replacedBy ? `, replaced by ${gone.replacedBy}` : "") +
                                " — that is the usual reason for an empty answer." +
                                // the live ones, by name, on the path where the
                                // operator actually meets this
                                (!gone.replacedBy && (gone.siblings || []).length
                                    ? ` Still live on this endpoint: ` +
                                      `${gone.siblings.join(", ")}.`
                                    : "");
                        }
                    } catch { /* the plain sentence is still true */ }
                    const err = new ToolError(statedError
                        ? `${s.label} answered 200 but the body carried an ` +
                          `error for ${s.model}: ${String(statedError).slice(0, 300)}`
                        : `${s.label} answered 200 but sent no content for ` +
                          `${s.model} — the call "succeeded" and returned ` +
                          `nothing. Treated as a failure so silence is never ` +
                          `shown as an answer.` + why);
                    // carried so the caller can still book what was spent on a
                    // turn that produced nothing
                    err.usage = usage || null;
                    err.cost = emptyCost;
                    err.emptyAnswer = true;
                    err.apiErrRecorded = true;
                    recordApiError({ endpoint: s.label, endpointId: s.id, model: s.model,
                        kind: "empty-200", status: 200,
                        providerError: statedError ? String(statedError).slice(0, 800) : "(200 OK but no content and no reasoning)",
                        ...requestShape(messages, opts) });
                    // A DOOR THAT ANSWERS EMPTY IS AS DEAD AS ONE THAT 502s.
                    // The non-200 path already falls back to the direct road;
                    // this one did not, so a relay returning a bare 200 killed
                    // the turn with a perfectly good direct route unused.
                    if (target.viaDoor && tryOther()) return;
                    done(reject, err);
                    return;
                }
                logCall("ok", { chars: output.length });
                // TEACH THE ESTIMATOR. The provider just told us exactly how many
                // tokens the prompt was; we know how many characters we sent. The
                // ratio between them is this model's real characters-per-token,
                // which is what makes the live counter in the composer converge on
                // the truth instead of staying a heuristic forever.
                /* DID THE SERVING ACTUALLY READ WHAT WE SENT?
                 *
                 * Ollama serves with its own num_ctx and silently discards
                 * everything past it. Nothing said so: the request left with
                 * 30,000 tokens of repository in it, the model answered as
                 * though it had seen a fragment, and the operator was left to
                 * conclude the model was stupid. The provider's OWN count is
                 * the evidence — if it read far less than we sent, the window
                 * cut it, and that is worth saying out loud with the fix.
                 */
                if (usage && usage.prompt_tokens > 0 && promptChars > 20_000) {
                    const sentApprox = promptChars / 3.6;
                    if (usage.prompt_tokens < sentApprox * 0.6) {
                        try {
                            if (typeof onNote === "function") {
                                onNote(`${s.label} read only ${usage.prompt_tokens.toLocaleString()} ` +
                                    `tokens of the ~${Math.round(sentApprox).toLocaleString()} sent — ` +
                                    `its context window is smaller than this conversation. ` +
                                    (isOllamaShape(s)
                                        ? "Raise it on the machine: OLLAMA_CONTEXT_LENGTH=131072 " +
                                          "(or PARAMETER num_ctx in the Modelfile), then restart Ollama."
                                        : "Pick a model with a larger window, or shorten the input."));
                            }
                        } catch { }
                    }
                }
                if (usage && usage.prompt_tokens > 0) {
                    try { tokenCost.learnRatio(s.model, promptChars, usage.prompt_tokens); }
                    catch { /* a forecast is never worth failing a call over */ }
                    // SELF-HEALING RATES. DeepInfra (confirmed) returns
                    // `estimated_cost` per call — a real dollar figure. Back-
                    // derive the implied per-token rate from it so the rate
                    // table corrects itself as the provider's prices are
                    // observed, instead of drifting from the shipped snapshot.
                    try { tokenCost.learnRateFromActual(s.model, usage); }
                    catch { /* never fail a call over a rate update */ }
                }
                /* A NODE COSTS $0 EVEN WHEN IT REPORTS NO TOKEN COUNTS.
                 *
                 * This read `usage ? actualCost(...) : null`, and the comment
                 * beside it claimed a node's dollars were "a certain $0, not an
                 * unknown" — while the code returned exactly the unknown. It
                 * matters because OLLAMA SENDS NO usage BLOCK AT ALL. Measured
                 * against a live Spark node:
                 *
                 *   localNode: true   usage: null   cost: null
                 *
                 * so every call to an owned machine came back with no cost
                 * object, the "$0 · your own hardware" line could not render,
                 * and the surfaces fell through to a generic path that shows a
                 * figure for a call that was never billed. Owned hardware is
                 * free whether or not the server counted the tokens, so the $0
                 * is stated from the FACT of it being an owned node. */
                const isNode = isNodeEndpoint(s);
                const costOut = usage
                    ? tokenCost.actualCost(s.model, usage, null, { localNode: isNode })
                    : (isNode ? tokenCost.freeCost() : null);
                done(resolve, { output, reasoning, usage, finishReason,
                                toolCalls: toolCalls.filter(t => t && t.name),
                                truncated: finishReason === "length",
                                redacted: !!redactedNote,
                                redactedNote, secretsSent, destination: dest,
                                cost: costOut,
                                stopped: !!cancelToken.cancelled,
                                localNode: isNode,
                                model: s.model, endpoint: s.label });
            });
            res.on("error", (e) => {
                splitter.end();
                // THE ANSWER DIED HALFWAY, AND THAT IS THE LINE WORTH READING.
                //
                // The header above promises one record per call "closed out
                // however it ends", and this was one of the two ends that left
                // nothing at all. Measured against a local stub, reading
                // node-calls.jsonl either side of a turn whose socket was cut
                // mid-answer: 0 lines added. Named apart from a plain "error"
                // because it is a different event — the machine was reached,
                // answered, and then the road went out from under it — and the
                // chars already delivered say how far it got.
                //
                // AND IT ASKS WHO KILLED IT FIRST. Pressing Stop after the
                // first token destroys the socket, and Node delivers that to
                // the RESPONSE as an abort before the request ever hears about
                // it — measured, a stopped turn reached this handler and the
                // cancelled branch below never ran. Logging "dropped-midstream"
                // there would file the user's own deliberate act under
                // "the road went out", which is the opposite of what the log is
                // for. Same two names, decided by who actually stopped it.
                logCall(cancelToken.cancelled ? "stopped" : "dropped-midstream",
                        { chars: output.length });
                // A socket that dies mid-stream is NOT the same as a failed call:
                // there is real output in hand. Hand it back with the reason, and
                // let askCloudModel decide whether to continue from it.
                done(reject, Object.assign(
                    new ToolError(scrub(e.message, key)),
                    { partial: output, partialReasoning: reasoning, midStream: true }));
            });
        });

        // MAY THIS FAILURE FALL THROUGH TO THE OTHER ROUTE?
        //
        // Only before any reply arrived — a mid-stream break has partial
        // output worth returning rather than re-asking. `retried` is the
        // guard that makes this fire ONCE per attempt: req.destroy() in the
        // timeout handler synthesises a trailing ECONNRESET, so without it a
        // timeout starts two concurrent attempts that share the splitter,
        // the output buffers and `buf` — interleaving two replies into one
        // corrupt stream.
        let retried = false;
        const tryOther = () => {
            // THIS ATTEMPT IS BEING ABANDONED, SO ITS LEASH GOES WITH IT.
            //
            // At the TOP, before any early return, so it covers every route out
            // of this attempt — a refused socket, a socket denied by a kill
            // switch, an inactivity timeout, a door answering 401 — and every
            // one added later. Clearing it only at the two call sites that
            // happened to be known is what let a dead attempt kill a live one.
            clearProbe();
            if (retried || settled) return false;
            if (output || reasoning || usage) return false;
            // door -> direct is a real fallback too: a door that has gone
            // stale (funnel down, node re-imaged) must not pin chat to a
            // dead route until the app restarts.
            const next = target.viaDoor ? false : true;
            if (next && !hasDoor) return false;
            if (!next && target.triedDirect) return false;
            retried = true;
            // remember for a while, not forever — see DOOR_FIRST_TTL_MS
            if (next) doorFirst.set(s.id, Date.now());
            else doorFirst.delete(s.id);        // the door failed; stop preferring it
            buf = "";
            attempt({ ...mkTarget(next), triedDirect: target.triedDirect || !target.viaDoor });
            return true;
        };

        // STOP HAS TO WORK WHILE NOTHING IS ARRIVING.
        //
        // Cancellation was checked in exactly one place: inside res.on("data").
        // So it only took effect when the server was already sending. A model
        // still loading sends nothing at all — a 123B at q6_K is ~100 GB off
        // disk — so during the entire load, which is precisely when someone
        // reaches for the stop button, the check never ran and the request
        // could not be aborted: a message sent to the node sat for 122 seconds,
        // a stop request did nothing, and the running model was stuck with no
        // way to interrupt it.
        //
        // The token now carries a hook straight to this socket, so stop kills
        // it immediately whether or not a single byte has arrived.
        // The hook points at whichever socket is in flight — attempt() can run
        // twice, direct then door, and the later one supersedes. done() puts
        // the token back the way it found it, so a finished turn's hook can
        // never reach into a later one's socket.
        activeReq = req;   // so markFirstToken can relax this attempt's leash on first token
        cancelToken.abort = () => { try { req.destroy(); } catch { /* already gone */ } };
        // and if stop was pressed before the socket even opened, do not wait
        if (cancelToken.cancelled) { try { req.destroy(); } catch { /* fine */ } }

        // THE CONNECT LEASH. A blackholing VPN accepts the packet and drops it,
        // so a dead road shows up as a socket that never finishes connecting.
        // That is what the short leash was ever for, and it is now the only
        // thing it covers: once the socket is up, the route is proven and the
        // full inactivity timeout governs — however long the model takes.
        req.on("socket", (sock) => {
            const up = () => {
                connected = true;
                clearProbe();
            };
            if (!sock.connecting) up();
            else { sock.once("connect", up); sock.once("secureConnect", up); }
            if (wantsProbe) {
                probeTimer = setTimeout(() => {
                    probeTimer = null;
                    if (connected || settled) return;
                    // nothing reached the server: no model was asked for, so
                    // trying the other road cannot double up on it
                    req.destroy();
                    if (tryOther()) return;
                    logCall("unreachable", { phase: "connect" });
                    splitter.end();
                    done(reject, new ToolError(
                        `${s.label} could not be reached directly`));
                }, DIRECT_PROBE_MS);
                if (probeTimer.unref) probeTimer.unref();
            }
        });

        req.on("timeout", () => {
            req.destroy();
            clearProbe();
            // ONLY FALL TO THE OTHER ROAD IF NOTHING WAS EVER DELIVERED.
            //
            // The door and the direct address are two roads to ONE machine. A
            // request that connected has been handed to the server, and if that
            // server is loading a large model it is still loading it — sending
            // the same prompt down the other road makes it allocate a SECOND
            // runner beside the first. That is a client-side timeout turning
            // into an out-of-memory on the user's own hardware.
            if (!connected && tryOther()) return;
            if (retried) return;          // the other route is already in flight
            // WHICH LEASH FIRED? Before the first token it is the first-token
            // budget (a STALL — the box took the request and never began
            // answering); after, it is the full inactivity leash (silence
            // mid-generation). Name it honestly and code it so the failure is
            // actionable instead of an open-ended hang the operator has to guess at.
            const stalled = connected && !firstTokenAt;
            const waitedMs = stalled ? firstTokenMs : timeoutMs;
            logCall(stalled ? "stalled-no-first-token"
                            : (connected ? "silent-after-connect" : "timeout"),
                    { waitedMs, gotOutput: !!output });
            splitter.end();
            done(reject, Object.assign(new ToolError(
                stalled
                    ? `${s.label} took the request but never started answering in ` +
                      `${Math.round(waitedMs / 1000)}s. ` +
                      (isNodeEndpoint(s)
                        ? "On your own node this usually means the prompt is very large " +
                          "for the current Spark mode/model — switch to a lighter mode " +
                          "(Swarm or Balanced) or a smaller/quantized model, then retry."
                        : "The endpoint is not responding; try again or another model.")
                    : connected
                        ? `${s.label} accepted the request but sent nothing for ` +
                          `${Math.round(waitedMs / 1000)}s — if it is loading a large ` +
                          `model, give it longer rather than retrying`
                        : "the request timed out"),
                { partial: output, partialReasoning: reasoning, midStream: !!output,
                  failKind: stalled ? "no-first-token" : undefined }));
        });
        req.on("error", (e) => {
            if (cancelToken.cancelled) {
                splitter.end();
                clearProbe();
                // THE OPERATOR PRESSED STOP, AND THAT IS A FACT ABOUT THE
                // MACHINE. The other end of this file's promise — one record
                // per call, however it ends — and the second of the two
                // terminal paths that recorded nothing at all. Measured: a
                // stopped turn added 0 lines to node-calls.jsonl, which is
                // precisely the event someone would open the log to explain
                // ("why did my node go quiet at 14:03"). `stopped` is kept
                // distinct from a timeout or a dropped stream because the
                // cause is a person, not the network, and the chars already
                // delivered say what the node had done by then.
                logCall("stopped", { chars: output.length });
                return done(resolve, { output, reasoning, usage, cost: null, stopped: true,
                                       model: s.model, endpoint: s.label });
            }
            // EACCES/EPERM belong here, and their absence would have made the
            // door useless on the machine it was built for: a VPN kill switch
            // does not refuse or drop the packet, it denies the SOCKET, and
            // Windows reports that as EACCES. Measured on the reporting
            // machine — spark:22 and spark:11434 both EACCES while ordinary
            // HTTPS was fine. Without this the road never counts as closed
            // and the door is never tried.
            const conn = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|EAI_AGAIN|ENOTFOUND|EACCES|EPERM/
                .test(String((e && e.code) || e.message || ""));
            if (conn && tryOther()) return;
            if (retried) return;          // trailing error from the abandoned socket
            logCall("error", { code: String((e && e.code) || "") });
            done(reject, new ToolError(scrub(e.message, key)));
        });
        req.write(body);
        req.end();
        };
        // FIT FIRST, THEN FIRE. The preflight refuses with MEASURED numbers when
        // a cold load would take the machine past what it can survive, waits for
        // a resident model to actually leave before a second one is asked for,
        // and — for a build large enough to kill a box — refuses rather than
        // proceeding blind. `onNote` carries the wait out to whoever is watching.
        nodePreflight(s, { onNote: typeof opts.onNote === "function" ? opts.onNote : null,
                           cancelToken })
            .then((pre) => {
                // A WAIT IS AN EVENT ON THE OPERATOR'S MACHINE, so it goes in the
                // same log as every other one. This is the line that answers
                // "why did that turn take ninety seconds to start".
                if (pre && pre.waited && isNode) {
                    recordNodeCall({ endpoint: s.label, endpointId: s.id, model: s.model,
                                     road: lastRoad, ms: pre.waitedMs,
                                     outcome: "waited-for-unload",
                                     unloaded: pre.unloaded,
                                     freeBytes: pre.freeBytes });
                }
                if (!settled) attempt(mkTarget(hasDoor && preferDoor(s.id)));
            })
            .catch(err => {
                // STOPPED DURING THE PREFLIGHT IS A STOP, NOT A REFUSAL. It is
                // the user's own act, it belongs under that name in the
                // call log, and the turn resolves the way every other stopped
                // turn does rather than surfacing as an error they did not cause.
                if (cancelToken.cancelled) {
                    logCall("stopped", { chars: 0 });
                    return done(resolve, { output: "", reasoning: "", usage: null,
                                           cost: null, stopped: true,
                                           model: s.model, endpoint: s.label });
                }
                // THE REASON GOES ON DISK WITH THE REFUSAL. Eight preflight
                // refusals were the only trace of eight rerouted turns, and
                // every one read `refused-preflight` and nothing else — the
                // generated sentence that would have explained everything was
                // consumed as a routing hint and discarded. The sentence is
                // the record; an outcome code alone is not.
                logCall("refused-preflight",
                        { reason: String((err && err.message) || err).slice(0, 300) });
                // a local preflight refusal is not a provider failure — name it
                try { err.failKind = "refused-preflight"; } catch { /* frozen err */ }
                done(reject, err);
            });
    });
}

/** USD for a completed call, when the model's rates are known. */
function priceOf(sel, usage = {}) {
    const m = (sel.models || []).find(x => x.id === sel.model);
    if (!m || !(m.inputPerM > 0)) return null;
    const inTok = usage.prompt_tokens || 0, outTok = usage.completion_tokens || 0;
    return { usd: (inTok / 1e6) * m.inputPerM + (outTok / 1e6) * m.outputPerM,
             inputTokens: inTok, outputTokens: outTok };
}

/* THE WINDOW THE DONUT SHOWS IS THE WINDOW THE SERVER IS ACTUALLY RUNNING.
 *
 * "so on the local node, the context window is not linking up properly, to the
 *  model selected."
 *
 * It never was linked: a node model whose host published no window got
 * LOCAL_ASSUMED_CONTEXT — a flat 32,768 — and the panel presented the
 * assumption as fact. Both engines will SAY their real number when asked:
 *   llama.cpp   GET /props            -> default_generation_settings.n_ctx,
 *               the serving window itself (measured live on a Spark node)
 *   vLLM        GET <prefix>/models   -> data[].max_model_len, fixed at launch
 * Best-effort: a probe that fails leaves the assumption in place, marked as
 * assumed, which is what it honestly is.
 */
async function measureNodeWindows(epId) {
    const store = readStore();
    const rec = store.endpoints[String(epId || "")];
    if (!rec || !rec.localNode || !Array.isArray(rec.models) || !rec.models.length) return null;
    const probe = { id: epId, baseUrl: rec.baseUrl, relayUrl: rec.relayUrl || null };
    const windows = new Map();          // model id -> real window
    let serverWide = 0;                 // llama.cpp: one window for the process
    try {
        const r = await request(probe, "/props", { timeoutMs: 3500, fromRoot: true });
        if (r.status >= 200 && r.status < 300) {
            const j = JSON.parse(r.body);
            const n = Number(j && j.default_generation_settings
                && j.default_generation_settings.n_ctx);
            if (n > 0) serverWide = n;
        }
    } catch { /* not llama.cpp — the next shape may answer */ }
    if (!serverWide) {
        try {
            const r = await request(probe, (rec.apiPrefix || "/v1") + "/models",
                                    { timeoutMs: 3500, fromRoot: true });
            if (r.status >= 200 && r.status < 300) {
                const j = JSON.parse(r.body);
                for (const m of (Array.isArray(j.data) ? j.data : [])) {
                    const w = Number(m && m.max_model_len);
                    if (m && m.id && w > 0) windows.set(String(m.id), w);
                }
            }
        } catch { /* nothing answered; the assumption stays, marked assumed */ }
    }
    if (!serverWide && !windows.size) return null;
    let changed = 0;
    for (const m of rec.models) {
        const w = serverWide || windows.get(String(m.id)) || 0;
        if (w > 0 && m.contextLength !== w) {
            m.contextLength = w;
            delete m.contextAssumed;
            changed++;
        }
    }
    if (changed) writeStore(store);
    return { changed, serverWide: serverWide || null, perModel: windows.size };
}

/* -------------------------------------------------------------- the tool */

async function askCloudModel(_root, { question, system } = {}, ctx = {}) {
    if (typeof question !== "string" || !question.trim()) {
        throw new ToolError('ask_cloud_model needs {"question": "..."}');
    }
    if (!available()) {
        throw new ToolError(selected()
            ? "that endpoint needs an API key — paste one in settings"
            : "no cloud model is linked — add one in the capability panel");
    }
    const s = selected();
    const messages = [];
    if (system) messages.push({ role: "system", content: String(system).slice(0, 8000) });
    messages.push({ role: "user", content: question.slice(0, 32_000) });

    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    const cancelToken = ctx.cancelToken || { cancelled: false };
    onNote(`asking ${s.model} on ${s.label}`);

    /* A DROPPED CONNECTION IS NOT A FAILED TASK.
     *
     * The operator's rule: a running task must not simply stop. For a local model
     * there is nothing to be done — the process is on this machine and its state
     * died with it. For an API model there is, and this is the one real advantage
     * of the remote path: when a socket dies at 80%, the 80% is already in hand.
     *
     * So on a mid-stream failure it reconnects and asks the model to CONTINUE from
     * what already arrived, rather than throwing the work away and starting over.
     * Only a genuine refusal — no key, endpoint gone, secret in the prompt — ends
     * the task, because retrying those would just burn money on the same error.
     */
    const MAX_ATTEMPTS = 3;
    let answer = "", reasoningChars = 0, usage = null, cost = null;
    let onOwnedNode = false;   // did the escalation run on a machine the user owns?
    let resumed = 0, lastErr = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (cancelToken.cancelled) break;
        // On a resume, hand back what we have and ask for the remainder. The
        // model sees its own partial reply as an assistant turn, which is the
        // shape every chat API understands as "keep going".
        const turn = answer
            ? messages.concat([{ role: "assistant", content: answer },
                               { role: "user", content:
                                   "Continue exactly where that stopped. Do not repeat any of it." }])
            : messages;
        try {
            const r = await streamChat(turn, {
                cancelToken,
                onReasoning: (t) => { reasoningChars += t.length; }
            });
            answer += r.output;
            usage = r.usage || usage;
            cost = r.cost || cost;
            if (r.localNode) onOwnedNode = true;
            if (r.stopped) {
                // a stopped escalation still spent whatever it spent — record it
                recordEscalation(ctx.sessionId, ctx.sessionTitle,
                    { model: s.model, endpoint: s.label, usage, cost, localNode: onOwnedNode }, ctx.onSpend);
                return { stopped: true, answer, resumed };
            }
            break;                                  // completed
        } catch (e) {
            lastErr = e;
            // Only a mid-stream death is worth resuming. Anything else is a
            // refusal that will refuse again.
            if (!e.midStream || attempt === MAX_ATTEMPTS || cancelToken.cancelled) {
                if (!answer) throw e;               // nothing salvageable
                break;                             // keep the partial, report it
            }
            if (e.partial) answer += e.partial;
            resumed++;
            onNote(`connection dropped after ${answer.length} characters — resuming`);
            await new Promise(r => setTimeout(r, 400 * attempt));   // brief backoff
        }
    }

    // THE ESCALATION REACHES THE LEDGER. A local model spending the operator's
    // money through ask_cloud_model is exactly the row the ledger exists for,
    // and it was never written — recordEscalation had no caller. It no-ops when
    // the endpoint returned no usage, so no fabricated rows.
    recordEscalation(ctx.sessionId, ctx.sessionTitle,
        { model: s.model, endpoint: s.label, usage, cost, localNode: onOwnedNode }, ctx.onSpend);

    return {
        answer, reasoningChars,
        model: s.model, endpoint: s.label,
        costUsd: cost && cost.usd !== null ? Number(cost.usd.toFixed(5)) : null,
        tokens: usage || null,
        // stated, never hidden: a resumed answer has a seam in it and the reader
        // is entitled to know rather than wondering why a sentence reads oddly
        resumed: resumed || undefined,
        incomplete: lastErr && answer ? String(lastErr.message).slice(0, 120) : undefined
    };
}

/**
 * ask_reasoner — the driver escalating something it cannot work out itself.
 *
 * This is the whole point of having two roles. V3 runs the loop because it calls
 * tools reliably and costs little; when it meets a problem that needs actual
 * reasoning it hands that ONE question here, pays reasoning rates for it alone,
 * and carries on driving with the answer.
 *
 * Deliberately narrow: a question and optional context in, an answer out. It
 * cannot call tools, cannot see the workspace, and does not continue the loop.
 * That keeps the expensive model on the expensive part.
 */
async function askReasoner(_root, { question, context } = {}, ctx = {}) {
    if (typeof question !== "string" || !question.trim()) {
        throw new ToolError('ask_reasoner needs {"question": "..."}');
    }
    // THE SESSION'S OWN REASONER FIRST: a "Hard reasoning" assignment in
    // this conversation's task map names who answers hard problems; the global
    // reasoner role is the fallback for sessions with no plan. Only an
    // assignment that RESOLVES is honoured — never a quiet substitute.
    let planSel = null;
    const a = ctx.session && ctx.session.taskModels && ctx.session.taskModels.reasoning;
    if (a && a.model && a.endpointId) {
        try {
            const rr = resolveSelection({ modelSel: { endpointId: a.endpointId, model: a.model } });
            if (rr && rr.sel && rr.source === "session") planSel = rr.sel;
        } catch { /* unresolvable plan = fall through to the global role */ }
    }
    if (!planSel && !usableFor("reasoner")) {
        throw new ToolError("no reasoning model is assigned — set one in " +
            "Session › Model Orchestration (Hard reasoning) or in Preferred model");
    }
    const r = planSel || selectedFor("reasoner");
    /* This tool now SURVIVES escalation-off when the session's reasoning
     * assignment is a free node — so a paid target must be refused here, or
     * surviving becomes a spend path with both switches off. */
    if (!isNodeEndpoint(r) && paths.readSettings().allowEscalation !== true) {
        throw new ToolError("the reasoning model is a PAID endpoint and " +
            "escalation is off — assign a model on your own machine as Hard " +
            "reasoning, or turn escalation on");
    }
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote(`escalating to ${r.model} on ${r.label}` +
        (planSel ? " — this conversation's Hard-reasoning assignment" : ""));

    const messages = [{
        role: "system",
        content: "You are being consulted on one hard problem by another model that " +
                 "is doing the work. Answer the question directly and completely. " +
                 "Do not ask for more information; reason from what you are given."
    }];
    if (context) messages.push({ role: "user", content: String(context).slice(0, 24_000) });
    messages.push({ role: "user", content: question.slice(0, 24_000) });

    let reasoningChars = 0;
    const out = await streamChat(messages, {
        role: "reasoner",
        selection: planSel || undefined,   // the session's assignment drives
        cancelToken: ctx.cancelToken || { cancelled: false },
        maxTokens: 3072,
        onReasoning: (t) => { reasoningChars += t.length; }
    });
    // the reasoner spends reasoning rates — record it, same as ask_cloud_model
    recordEscalation(ctx.sessionId, ctx.sessionTitle,
        { model: out.model, endpoint: out.endpoint, usage: out.usage, cost: out.cost,
          localNode: out.localNode }, ctx.onSpend);
    if (out.stopped) return { stopped: true, answer: out.output };
    return {
        answer: out.output,
        reasoningChars,
        model: out.model, endpoint: out.endpoint,
        costUsd: out.cost && out.cost.usd !== null ? Number(out.cost.usd.toFixed(5)) : null,
        tokens: out.usage || null
    };
}

/* THE FLEET, REACHABLE — the other half of the toggle.
 *
 * Symptom: a session with vLLM agents assigned was told the model knew about
 * the fleet but could not access it.
 *
 * Both halves of that were exact. It KNEW because orchestrationBlock
 * put the assignment in the system prompt. It COULD NOT ACCESS because nothing
 * executed the `agentic` assignment: ask_cloud_model targets the app-wide
 * driver and never reads the session map, and the escalation gate deletes the
 * handoff tools whenever paid escalation is off — which it always is for a
 * node, because a node is free and never enters escalateTo at all. The money
 * gate starved a free machine.
 *
 * Same shape as askReasoner, one cap over: resolve the session's `agentic`
 * assignment, stream against THAT endpoint. No PAID fallback, ever — when
 * nothing is assigned, the only machine discovery may reach is a FREE fleet
 * seat the operator owns (see the discovery block in askFleet). And it takes
 * MANY tasks, because many-at-once is what a batching server is FOR: one
 * call, up to eight independent streams, answered concurrently.
 */

/**
 * What a fleet seat is actually serving, asked of the server itself: one
 * ~2s GET of its own /models (vLLM and llama.cpp answer data[]/models[] —
 * the one road that cannot be about another machine; see nodePreflight).
 * Silence is NOT an offline verdict: nodePreflight marks offline only when
 * BOTH of its roads stay quiet, and this probe walks one. A quiet answer
 * here just means the caller falls through to the honest refusal.
 */
async function fleetServedModel(ep, timeoutMs = 2000) {
    try {
        const r = await request(ep, apiPrefixOf(ep) + "/models",
                                { timeoutMs, fromRoot: true });
        if (r.status < 200 || r.status >= 300) return null;
        const j = JSON.parse(r.body);
        const list = Array.isArray(j.data) ? j.data
                   : Array.isArray(j.models) ? j.models : [];
        const m = list.find(x => x && (x.id || x.name || x.model));
        return m ? String(m.id || m.name || m.model) : null;
    } catch { return null; }
}

const FLEET_MAX_TASKS = 8;
async function askFleet(_root, { task, tasks, context } = {}, ctx = {}) {
    const list = Array.isArray(tasks) ? tasks.filter(t => typeof t === "string" && t.trim())
               : (typeof task === "string" && task.trim()) ? [task] : [];
    if (!list.length) {
        throw new ToolError('ask_fleet needs {"task": "..."} or {"tasks": ["...", ...]}');
    }
    if (list.length > FLEET_MAX_TASKS) {
        throw new ToolError(`ask_fleet runs at most ${FLEET_MAX_TASKS} tasks in one call — ` +
            `got ${list.length}. Split the batch.`);
    }
    const a = ctx.session && ctx.session.taskModels && ctx.session.taskModels.agentic;
    let sel = null;
    if (a && a.model && a.endpointId) {
        try {
            const rr = resolveSelection({ modelSel: { endpointId: a.endpointId, model: a.model } });
            if (rr && rr.sel && rr.source === "session") sel = rr.sel;
        } catch { /* fall through to the plain refusal below */ }
    }
    /* NO ASSIGNMENT IS NOT A DEAD END WHEN A FREE FLEET IS ALIVE. Discovery
     * runs ONLY when this conversation never assigned a fleet at all — a
     * BROKEN assignment keeps the refusal below, because silently running
     * on a machine the user did not pick is the exact lie resolveSelection
     * exists to end. Scoped to machines the operator OWNS (localNode, never
     * rented, nodeRole "fleet"): a paid endpoint can never be discovered,
     * so this path cannot spend. Continuous batching makes many sessions
     * on one fleet the DESIGN, not a conflict. */
    let discovered = null;
    let probedFree = false;
    if (!sel && !(a && a.model && a.endpointId)) {
        const fep = freeFleetEndpoint();
        if (fep && endpointIsFreeNode(fep.id)) {      // re-checked at run time
            probedFree = true;
            const ep = endpoints().find(e => e.id === fep.id);
            const served = ep ? await fleetServedModel(ep, 2000) : null;
            if (served) {
                markEndpointOnline(ep.id);            // K4: from a real answer
                try {
                    const rr = resolveSelection({ modelSel:
                        { endpointId: ep.id, model: served } });
                    if (rr && rr.sel && rr.source === "session") {
                        sel = rr.sel;
                        discovered = { cap: "agentic", endpointId: ep.id,
                                       endpointLabel: ep.label, model: served };
                    }
                } catch { /* fall to the refusal */ }
            }
            // a silent /models writes NO offline verdict — one quiet road
            // is not "that machine is off" (nodePreflight needs both silent
            // before it says so); this path just refuses, honestly
        }
    }
    if (!sel) {
        throw new ToolError("no agent fleet is assigned to this conversation — " +
            "press \u25B6 on the fleet row under the machine in the model picker, " +
            "or assign one under Session \u203A Model Orchestration" +
            (probedFree ? " (no free fleet on your own machines answered just now)" : ""));
    }
    /* THE MONEY GUARD LIVES HERE NOW, NOT ONLY ON THE TOOL'S EXISTENCE.
     * This tool survives escalation-off precisely because a node is free — so
     * it must refuse a paid target itself, or surviving becomes a spend path. */
    if (!isNodeEndpoint(sel) && paths.readSettings().allowEscalation !== true) {
        throw new ToolError("this conversation's fleet is a PAID endpoint and " +
            "escalation is off — assign the fleet on your own machine, or turn " +
            "escalation on");
    }
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    const cancelToken = ctx.cancelToken || { cancelled: false };
    if (discovered) {
        onNote(`no fleet was assigned to this conversation — found ${sel.model} on ` +
               `${sel.label}, a FREE machine you own; running there now. Press ` +
               `\u25B6 on its fleet row in the model picker to keep it for ` +
               `this session.`);
    }
    onNote(`running ${list.length} task${list.length === 1 ? "" : "s"} on ` +
           `${sel.model} at ${sel.label} — in parallel, which is what the fleet is for`);
    const runOne = async (t, i) => {
        const messages = [{
            role: "system",
            content: "You are one agent in a parallel fleet. Do exactly the task " +
                     "you are given, completely and directly, and return the work " +
                     "itself — no preamble, no questions."
        }];
        if (context) messages.push({ role: "user", content: String(context).slice(0, 16_000) });
        messages.push({ role: "user", content: String(t).slice(0, 24_000) });
        try {
            const out = await streamChat(messages, {
                selection: sel, cancelToken, maxTokens: 4096
            });
            recordEscalation(ctx.sessionId, ctx.sessionTitle,
                { model: out.model, endpoint: out.endpoint, usage: out.usage, cost: out.cost,
                  localNode: out.localNode },
                ctx.onSpend);
            return { task: i + 1, ok: true, answer: out.output,
                     stopped: out.stopped || undefined };
        } catch (e) {
            // ONE FAILED STREAM DOES NOT SINK THE BATCH — the other seven
            // answers are already work done, and throwing them away to report
            // one error would be the installer-timeout lie all over again
            return { task: i + 1, ok: false, error: String(e.message || e).slice(0, 300) };
        }
    };
    const results = await Promise.all(list.map(runOne));
    return { fleet: sel.model + " on " + sel.label,
             done: results.filter(r => r.ok).length,
             failed: results.filter(r => !r.ok).length,
             results,
             // the discovery, riding run.result up through runTurn and the
             // orchestrator to main, where the renderer makes it the strip
             fleetOffer: discovered || undefined };
}

const FLEET_ENTRY = {
    run: askFleet,
    help: 'ask_fleet {"tasks": ["...", "..."]} — run up to 8 INDEPENDENT tasks ' +
          'in parallel on this conversation\'s assigned agent fleet (a batching ' +
          'server like vLLM answers them concurrently, so 8 tasks cost little ' +
          'more time than 1). Use it to fan work out: many files, many drafts, ' +
          'many questions. One task is fine too: {"task": "..."}. Free when the ' +
          'fleet is on a machine the operator owns.'
};

const REASONER_ENTRY = {
    run: askReasoner,
    help: 'ask_reasoner {"question": "...", "context": "optional"} — hand ONE hard ' +
          'problem to the reasoning model. Use it when you genuinely cannot work ' +
          'something out: a design trade-off, a subtle bug, a physics or control ' +
          'question. It costs more per token than you do, so ask once and ask well.'
};

const ASK_ENTRY = {
    run: askCloudModel,
    help: 'ask_cloud_model {"question": "..."} — hand one question to the linked ' +
          'cloud or remote model. Leaves this machine and may cost money; use it ' +
          'only when the local model genuinely cannot do the job.'
};


/* ------------------------------------------------------------- ONE BUTTON */

/**
 * connect(text) — paste anything, press one button, done.
 *
 * The panel this replaces had seven controls: a provider dropdown, a URL field,
 * a key field, Link, Find models, Test, and a separate model picker. Seven
 * decisions to answer one question — "use that server." Every one of them was
 * something the app could work out for itself.
 *
 * So: one field. Paste a URL, or a key, or both, in either order, with or
 * without a scheme, copied straight out of a provider's docs. This function
 * does the rest:
 *
 *   1. pulls the URL and the key out of whatever was pasted
 *   2. normalises the URL — adds https, strips the /v1/chat/completions tail
 *      people paste from documentation
 *   3. probes it: OpenAI-style /v1/models first, then Ollama's native /api/tags
 *      — and asks /api/tags either way, because an Ollama answers both and
 *      whether it IS one decides whether a key is even a question
 *   4. if it answers 401, says "that needs a key" instead of a status code
 *   5. lists the models, picks a sensible default, and SELECTS it
 *
 * One call, and the thing is connected and in use. No preset list, because a
 * preset list is a promise that only the listed providers work — and the whole
 * point is that any server anywhere works.
 */

// A key is a long opaque token. Providers prefix them differently (sk-, sk-or-,
// hf_, gsk_, r8_, key-) and some use a bare hex or base64 blob, so shape is the
// only reliable signal: no spaces, long enough that it cannot be a word.
function looksLikeKey(tok) {
    const t = String(tok || "").trim();
    if (t.length < 16 || /\s/.test(t)) return false;
    if (/^https?:\/\//i.test(t)) return false;
    if (/^(sk|sk-or|sk-ant|hf|gsk|r8|key|api|pk|tok)[-_]/i.test(t)) return true;
    // a bare token: mostly base64/hex alphabet and not a hostname
    return /^[A-Za-z0-9_\-.=+/]{24,}$/.test(t) && !/\.[a-z]{2,}$/i.test(t);
}

function looksLikeUrl(tok) {
    const t = String(tok || "").trim();
    if (!t || looksLikeKey(t)) return false;
    if (/^https?:\/\//i.test(t)) return true;
    // host[:port][/path] with a dot, or a bare host:port (localhost:11434)
    return /^[a-z0-9][a-z0-9.\-]*(\.[a-z]{2,}|:\d{2,5})(\/\S*)?$/i.test(t);
}

/** Turn whatever was pasted into a clean base URL we can talk to. */
function normaliseBase(raw) {
    let s = String(raw || "").trim().replace(/^[<("']|[>)"',.]$/g, "");
    if (!/^https?:\/\//i.test(s)) {
        // a private address or a bare host:port is almost certainly a local
        // server, so do not force https onto something that cannot serve it
        const host = s.split("/")[0].split(":")[0];
        s = (isLocalHost(host) ? "http://" : "https://") + s;
    }
    let u;
    try { u = new URL(s); } catch { throw new ToolError(`that does not look like a server address: ${raw}`); }
    // People paste the full endpoint out of documentation. Keep the origin and
    // any real base path, drop the API tail.
    // Strip only the ENDPOINT tail people paste out of documentation. What is
    // left is the base, whatever shape it has.
    //
    // The previous version also stripped a trailing /v1 or /api, which broke
    // DeepInfra outright: its base is https://api.deepinfra.com/v1/openai, and
    // the request path was then built as base + "/v1/chat/completions" giving
    // .../v1/openai/v1/chat/completions. Verified against the live host. The
    // prefix is discovered by probing now (see probe), not assumed, so there is
    // nothing to strip here beyond the endpoint itself.
    u.pathname = u.pathname
        .replace(/\/+$/, "")
        // the endpoint tail people paste out of documentation
        .replace(/\/(chat\/completions|completions|messages|embeddings)$/i, "")
        // ...and a version segment ONLY when it is the last one. Stripping /v1
        // unconditionally destroyed DeepInfra, whose base is genuinely
        // /v1/openai — the request path became /v1/openai/v1/chat/completions
        // and returned 404 on every call. Verified against the live host.
        .replace(/\/(v1|api)$/i, "")
        .replace(/\/+$/, "");
    u.search = ""; u.hash = "";
    return u.toString().replace(/\/+$/, "");
}

/**
 * Which model should it use by default?
 *
 * A broad host serves a lot of things that are not chat models. DeepInfra's
 * live catalogue is 174 entries: chat, code, roleplay finetunes, embedders,
 * TTS, image, moderation. The first version of this scored on parameter count
 * and picked `Sao10K/L3.1-70B-Euryale-v2.2` — a roleplay finetune — purely
 * because "70B" appears in the name. Measured against the real list, which is
 * why the exclusions below are specific rather than hand-wavy.
 *
 * Hard exclusions first, then family, then size only as a tie-break.
 */
/**
 * Which of a host's models should drive, before the user has chosen.
 *
 * `catalogue` is the metadata the host published about each model, when it
 * published any. Judging a model by the characters in its name is guesswork —
 * it is how a roleplay finetune once won out of 174 entries because "70B"
 * appeared in its id — so where the host describes what a model IS, that
 * outranks anything inferred from the name.
 */
function pickDefaultModel(ids, catalogue = null) {
    const meta = new Map();
    for (const e of catalogue || []) if (e && e.id) meta.set(e.id, e);

    const score = (id) => {
        const info = meta.get(id);
        // ONE definition of "can this hold a conversation", shared with the
        // picker's filter. Two regexes drifted apart on the first attempt and
        // an image model came back as the default from a catalogue where every
        // entry had already been rejected as non-chat.
        if (!isChatCapable(id, catalogue)) return -1000;
        // A RETIRED MODEL IS NEVER THE DEFAULT. The provider publishes the
        // retirement (138 of DeepInfra's 360 carry a `deprecated` stamp) and
        // a retired serving is exactly the kind that answers a clean 200 with
        // nothing in it. Still selectable by hand — the picker says so — but
        // never the one the app reaches for on the operator's behalf.
        if (info && info.deprecated) return -900;
        // an agent needs TOOL CALLING. Where the provider says a model has
        // none, it is a poor default for a workbench whose whole loop is
        // tools, even though it can hold a conversation.
        if (info && Array.isArray(info.features)
            && info.features.length && !info.features.includes("tools")) {
            return -200;
        }
        if (info && info.description
            && /\b(roleplay|role-play|companion|uncensored|nsfw)\b/.test(info.description.toLowerCase())) {
            return -500;
        }
        const s = String(id).toLowerCase();
        // not a chat model at all, whatever the rest of the name says
        if (/embed|rerank|whisper|tts|stt|voice|bge|clip|sdxl|flux|stable-diffusion|guard|moderat|nsfw|rank/.test(s)) {
            return -1000;
        }
        // real models, wrong job
        if (/euryale|lumimaid|mythomax|noromaid|uncensored|abliterat|dolphin|erotic|roleplay/.test(s)) {
            return -500;
        }
        let n = 0;
        if (/base(?!line)/.test(s)) n -= 40;
        // current flagship families
        if (/deepseek/.test(s)) n += 60;
        if (/v4/.test(s)) n += 45;
        else if (/v3\.[2-9]/.test(s)) n += 25;
        if (/-pro\b|\/pro\b/.test(s)) n += 20;
        if (/qwen3|kimi-k2|glm-[45]|llama-?4/.test(s)) n += 35;
        if (/reason|think|r1\b|o1\b|qwq/.test(s)) n += 25;
        if (/instruct|chat|-it\b/.test(s)) n += 15;
        if (/coder|code/.test(s)) n += 10;
        // size breaks ties; it does not decide the winner
        if (/\d{3}b/.test(s)) n += 8;
        else if (/70b|72b|65b/.test(s)) n += 5;
        if (/flash|mini|tiny|small|1\.5b|\b3b\b/.test(s)) n -= 12;

        // A LONG CONTEXT IS THE ONE THING THIS PRODUCT ACTUALLY NEEDS.
        // The default model drives an agent loop over a linked repo: it reads
        // files, holds tool output, and iterates. A 4k window cannot do that
        // whatever its name promises, and a 1M window can. Published fact, so
        // it is weighted like one — above every naming heuristic above.
        if (info && info.contextLength) {
            if (info.contextLength >= 400_000) n += 50;
            else if (info.contextLength >= 128_000) n += 35;
            else if (info.contextLength >= 60_000) n += 15;
            else if (info.contextLength < 16_000) n -= 40;
        }
        return n;
    };
    const ranked = ids.slice().sort((a, b) => score(b) - score(a));
    // NOTHING here can hold a conversation. Returning the least-bad TTS model
    // would select it, and the first message would fail in a way nobody could
    // read. Say so instead.
    if (!ranked.length || score(ranked[0]) <= -1000) return null;
    return ranked[0];
}

/**
 * Can this model hold a conversation?
 *
 * A catalogue this size is mostly not chat models. Measured against DeepInfra's
 * live list: 174 entries, of which around 40 are embedding, rerank, speech,
 * image or classifier models. They have no business in a CHAT picker — pick one
 * and the session fails on its first message with a provider error nobody can
 * act on.
 *
 * The host publishes no type field (measured: all 174 entries have none), so
 * there are only two signals, and BOTH ARE USED, because graded against each
 * other on the real catalogue each one misses what the other catches:
 *
 *   description only  passed FLUX.1-Kontext, whisper-large-v3, Qwen3-ASR and
 *                     clip-ViT — their blurbs describe what they do without
 *                     ever using a disqualifying word
 *   name only         passed intfloat/e5-*, chatterbox-turbo, HiggsAudio and
 *                     Bria-3.2 — nothing in those names says embedder or TTS
 *
 * Either alone agreed with the truth on 152 of 174. A model is offered only if
 * NEITHER signal disqualifies it, which is the conservative direction: hiding a
 * usable model costs a user one puzzled moment, offering a broken one costs
 * them a failed session and a support question.
 */
const NON_CHAT_NAME_RE = new RegExp([
    // embeddings and rerankers
    "(^|[/_-])(embed|embedding|embeddings|rerank|reranker)([/_-]|$)",
    "embed-|-embed|(^|/)bge-|(^|/)gte-|(^|/)e5-|-e5-|jina-|nomic-embed|mxbai",
    "arctic-embed|instructor-|sentence-transformers|all-minilm|paraphrase-",
    "text2vec|-vec-|(^|/)vec-|colbert|splade",
    // speech, in either direction
    "(^|[/_-])(tts|stt|asr)([/_-]|$)|whisper|parakeet|canary|wav2vec",
    "chatterbox|kokoro|(^|[/_-])bark([/_-]|$)|xtts|orpheus|voicedesign",
    "higgsaudio|-audio|audio-|speech|dia-tts",
    // images and video
    "flux|sdxl|stable-diffusion|(^|[/_-])sd3|playground-v|kandinsky|pixart",
    "(^|/)fibo|-image$|-image-|image-\\d|wan-?video|ltx-video|hunyuan-video",
    "(^|/)bria|seedream|seedance|(^|[/_-])veo|sora|runway|-video$|video-\\d",
    "nano-banana|gemini-3.1-flash-image|imagen|parti|dall-?e",
    // the universal generation suffixes: text-to-video, text-to-image,
    // image-to-video, text-to-audio. Every host in this space uses them, and
    // they are the only thing distinguishing e.g. Wan2.6-T2V from Wan2.6-T2I.
    "(^|[/_.-])(t2v|t2i|t2a|i2v|v2v|i2i)([/_.-]|$)",
    "pixverse|(^|/)wan[0-9-]|wan-ai|(^|/)cosmos|(^|/)csm-|voxtral|(^|/)ltx",
    // safety classifiers: they answer, but not conversationally
    "guard|moderat|-safety|prompt-?shield",
    // multimodal encoders
    "(^|[/_-])clip([/_-]|$)|siglip|(^|[/_-])vit-"
].join("|"), "i");

const NON_CHAT_DESC_RE =
    /\b(embedding|embeddings|re-?rank|reranker|text-to-speech|speech-to-text|transcri|automatic speech|speech recognition|image generation|text-to-image|image editing|diffusion|rectified flow|voice clon|video generation)\b/;

function isChatCapable(id, catalogue = null) {
    const info = (catalogue || []).find(e => e && e.id === id);
    // OPENROUTER ':batch' IS A BATCH-API-ONLY VARIANT, not a chat endpoint —
    // POST /api/v1/chat/completions rejects it (openrouter.ai/docs/batch-quickstart).
    // The id suffix is the only signal; :free/:nitro/:online/:thinking are fine.
    if (String(id).endsWith(":batch")) return false;
    // RETIRED AT THE PROVIDER. DeepInfra stamps `deprecated` (a unix time, 138 of
    // 361 retired) and OpenRouter carries expiration_date; a dead model that still
    // reads type=text-generation was being LISTED, only deprioritized as the pick.
    if (info && info.deprecated) return false;
    // A verdict recorded at link time, when the host's description was in hand.
    // Downstream callers (the picker in main.js) hold only an id, so without
    // this they would be re-deriving from the weaker of the two signals.
    if (info && typeof info.chat === "boolean") return info.chat;

    // THE PROVIDER'S OWN ANSWER BEATS EVERY HEURISTIC BELOW IT. DeepInfra
    // publishes `type` per model — text-generation / embeddings / text-to-image
    // / text-to-speech / automatic-speech-recognition / text-to-video /
    // reranker — and a capability tag list where "chat" is a literal member.
    // Both were already in hand and the guesswork ran anyway; a name regex
    // deciding what a host has stated outright is how an embedder called
    // text2vec-base-chinese ends up in a chat picker.
    if (info && typeof info.type === "string" && info.type) {
        return info.type === "text-generation";
    }
    if (info && Array.isArray(info.tags) && info.tags.length) {
        const t = info.tags.map(x => String(x).toLowerCase());
        if (t.includes("chat")) return true;
        if (t.some(x => ["embed", "image-gen", "tts", "stt", "video-gen"].includes(x))) {
            return false;
        }
    }

    // THE PROVIDER'S MODALITY VERDICT, where published (OpenRouter's
    // architecture.output_modalities): a model that outputs text chats, one
    // that outputs only images/audio does not. Classifiers (llama-guard,
    // moderation) publish ["text"] too, so the name carve-out runs first —
    // a safety model never rides modality into chat.
    if (info && Array.isArray(info.outputModalities) && info.outputModalities.length
        && !/guard|moderat|safety|shield/i.test(String(id))) {
        return info.outputModalities.map(x => String(x).toLowerCase()).includes("text");
    }

    if (NON_CHAT_NAME_RE.test(String(id))) return false;
    const d = (info && info.description || "").toLowerCase();
    if (d && NON_CHAT_DESC_RE.test(d)) return false;

    // A PUBLISHED WINDOW THIS SMALL IS NOT A CHAT MODEL.
    //
    // The strongest of the three signals, because it is a number the host
    // published rather than a word anyone chose. Embedding models declare 512
    // or 1024; no conversational model ships with less than 4k. This is what
    // catches the ones whose names give nothing away — text2vec-base-chinese
    // reads like a chat model and declares a 1,024-token window.
    if (info && info.contextLength && info.contextLength < 4096) return false;

    return true;
}

/**
 * How big is this model, on whatever signal the host gave us?
 *
 * Answers ONE question — which of these is cheapest to poke — and is never used
 * to decide which model to USE. A parameter count parsed out of a name is not
 * exact and does not need to be: mistral-large:123b against qwen3:4b is the
 * comparison that matters, and it is the comparison that was missing when the
 * key check picked the 100 GB one.
 *
 * The largest number in a name wins, deliberately. "Qwen3.5-397B-A17B" is a
 * 397B model with 17B active and "yarn-mistral-7b-128k" ends in a context
 * window, not a size — reading the smaller number in either case would send the
 * ping to something far bigger than it thought.
 */
function paramCount(text) {
    const s = String(text || "").toLowerCase();
    const unit = { k: 1e-6, m: 1e-3, b: 1, t: 1e3 };
    let best = 0;
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([kmbt])(?![a-z0-9])/g)) {
        const n = parseFloat(m[1]) * unit[m[2]];
        if (n > 0 && n < 100_000 && n > best) best = n;      // 100T is not a model
    }
    return best;
}

function sizeRank(id, info = {}) {
    const p = paramCount(info.parameterSize) || paramCount(id);
    if (p) return p;
    // Ollama publishes bytes on disk. Quantisation makes that only roughly
    // proportional to parameters, but a smallest-of comparison needs only
    // "roughly" — and both scales land in the same order of magnitude, so the
    // two signals stay comparable when a catalogue mixes them.
    if (Number(info.sizeBytes) > 0) return Number(info.sizeBytes) / 1e9;
    return Infinity;                       // unknown sorts last, never first
}

/** The smallest of these models, or the first when nothing declares a size. */
function smallestModel(ids, catalogue = null) {
    const meta = new Map((catalogue || []).map(e => [e.id, e]));
    let best = null, bestRank = Infinity;
    for (const id of ids || []) {
        const r = sizeRank(id, meta.get(id) || {});
        if (best === null || r < bestRank) { best = id; bestRank = r; }
    }
    return best;
}

/**
 * What window does Ollama say this model has?
 *
 * /api/show reads the manifest — it does NOT load the model, which is the whole
 * reason it is worth asking and a chat completion is not. One request, for the
 * one model about to be selected; the rest of a catalogue is not worth a round
 * trip each.
 */
async function ollamaContextLength(baseUrl, model) {
    try {
        const r = await request({ id: "__show", baseUrl }, "/api/show", {
            method: "POST",
            // `model` is the current field, `name` the one older builds read
            body: JSON.stringify({ model, name: model }),
            timeoutMs: 10_000
        });
        if (r.status !== 200) return 0;
        const info = (JSON.parse(r.body) || {}).model_info || {};
        // the key is architecture-prefixed: llama.context_length, qwen3.context_length
        for (const [k, v] of Object.entries(info)) {
            if (/\.context_length$/.test(k) && Number(v) > 0) return Number(v);
        }
    } catch { /* an older build, or not Ollama at all — the default covers it */ }
    return 0;
}

/**
 * The model records an endpoint stores, from what the probe found.
 *
 * `assumeContext` is the window to state for a model the host published none
 * for. It exists because router.limits() reads contextLength off the selected
 * model and, finding nothing, drops to REMOTE_FLOOR — the deliberately
 * conservative shape meant for a host we know nothing about. Applied to the
 * machine on your own network that is simply wrong, and it is what Ollama's
 * /v1/models produces every time: bare ids, no metadata of any kind.
 */
function modelRecords(chatIds, catalogue, { assumeContext = 0, reportedFor = null, reported = 0 } = {}) {
    const byId = new Map((catalogue || []).map(e => [e.id, e]));
    return chatIds.map(id => {
        const info = byId.get(id) || {};
        const asked = (reportedFor && id === reportedFor) ? Number(reported) || 0 : 0;
        return {
            id, label: id,
            // carried so the picker can show what a model can hold and the
            // agent loop can size itself to it, rather than assuming
            contextLength: info.contextLength || asked || assumeContext || null,
            // SAID OUT LOUD. A budget built on a guess is a different thing from
            // one built on a number the host published, and blending them would
            // make the assumption impossible to spot later.
            contextAssumed: (!info.contextLength && !asked && assumeContext) ? true : undefined,
            maxTokens: info.maxTokens || null,
            // WHAT IT WEIGHS, when the host said (Ollama's /api/tags does).
            // The probe always captured this and this map always dropped it —
            // so the picker offered a 100.6 GB model on a 130.66 GB machine
            // as if it were an option, and the guard's permanent refusal was
            // discoverable only by sending and being refused, forever.
            sizeBytes: Number(info.sizeBytes) > 0 ? Number(info.sizeBytes) : undefined,
            // the provider's published capability tags, when it publishes any
            // (DeepInfra does) — the request builder reads these per model
            tags: Array.isArray(info.tags) && info.tags.length ? info.tags : undefined,
            // ...and the provider's own richer sheet where it serves one.
            // `features` carries tool-calling and structured-output support;
            // `deprecated` is why a model that looks fine answers silence.
            features: Array.isArray(info.features) && info.features.length
                ? info.features : undefined,
            type: info.type || undefined,
            deprecated: info.deprecated || undefined,
            replacedBy: info.replacedBy || undefined,
            mmlu: info.mmlu || undefined,
            // DECIDED HERE, WHERE THE DESCRIPTION EXISTS. Downstream callers
            // (the picker in main.js) only have an id, and judging "is this a
            // chat model" from an id alone is guesswork that misses families
            // nobody thought to list — chatterbox is TTS and multilingual-e5 is
            // an embedder, and neither name says so. Everything here already
            // passed the filter, so this is true by construction; it is recorded
            // so it stays true without re-deriving it.
            chat: true
        };
    });
}

/**
 * COULD THIS MODEL EVER LOAD ON THAT MACHINE — best case, everything free?
 *
 * The exact arithmetic nodePreflight refuses with, asked statically: need =
 * size × LOAD_OVERHEAD, headroom = max(NODE_SYS_RESERVE, 18% of what is
 * free), best possible free = the machine's total. mistral-large q6_K
 * (100.59 GB) on a 130.66 GB node needs ~135 GB by this rule — unsatisfiable
 * by arithmetic, so every send refuses in half a second, forever. A picker
 * that knows this offers the fact instead of the trap. Unknown sizes return
 * true: this marks certainties, it does not guess.
 */
function canEverFitNode(sizeBytes, totalBytes) {
    if (!(Number(sizeBytes) > 0) || !(Number(totalBytes) > 0)) return true;
    const bestFree = Number(totalBytes);
    const need = Number(sizeBytes) * LOAD_OVERHEAD;
    const headroom = Math.max(NODE_SYS_RESERVE, bestFree * NODE_HEADROOM_FRACTION);
    return need + headroom <= bestFree;
}

/**
 * Probe a base URL. Returns { shape, models } or throws something a person can
 * act on. Tries the OpenAI shape first because almost everything speaks it,
 * then Ollama's native API for an un-proxied Ollama.
 *
 * WHAT THE HOST IS, NOT WHICH DOOR OPENED FIRST. The ladder finds a working
 * path; it does not identify the server, and treating the two as the same thing
 * is what misclassified the Ollama node on the mesh (see the /api/tags hint
 * below).
 */
/*
 * WHAT THE PROVIDER PUBLISHES ABOUT ITS OWN MODELS, beyond the OpenAI list.
 *
 * DeepInfra serves /models/list at its origin: 360 entries carrying `type`
 * (text-generation / text-to-image / embeddings / text-to-speech /
 * automatic-speech-recognition / text-to-video / reranker), feature tags
 * (tools, json, structured-output, reasoning, multimodal, ocr,
 * can-disable-reasoning), `deprecated` (a unix stamp) and `replaced_by`.
 *
 * Measured against the live surface on 11 Aug 2026, and it is not a detail:
 * 138 of those 360 models are DEPRECATED and 213 do NOT support tool calling.
 * .lcl offered all of them as equal choices — which is how the operator came
 * to pick google/gemini-1.5-flash-8b, deprecated since June with no
 * replacement, and get four silent answers out of it.
 *
 * One unauthenticated call, at link and refresh. A host that does not serve
 * it simply gets nothing extra: the whole layer is additive.
 */
async function providerModelMeta(baseUrl, key) {
    const ep = { id: "__probe", baseUrl };
    if (key) memoryKeys.set("__probe", key);
    try {
        // BEST EFFORT, ON A SHORT LEASH. This is an EXTRA on top of the model
        // list, not part of it: if it is slow or missing the refresh must not
        // notice. Six seconds against a sheet that measures ~400 ms.
        const r = await request(ep, "/models/list", { timeoutMs: 6_000, fromRoot: true });
        if (r.status !== 200 || r.truncated) return null;
        const rows = JSON.parse(r.body);
        if (!Array.isArray(rows) || !rows.length) return null;
        const out = new Map();
        for (const m of rows) {
            const id = m && m.model_name;
            if (!id) continue;
            const tags = Array.isArray(m.tags) ? m.tags.filter(t => typeof t === "string") : [];
            out.set(String(id), {
                type: typeof m.type === "string" ? m.type : null,
                features: tags.slice(0, 24),
                // a unix stamp, not a boolean, in the wire form
                deprecated: Number(m.deprecated) > 0 ? Number(m.deprecated) : null,
                replacedBy: typeof m.replaced_by === "string" ? m.replaced_by : null,
                quantization: typeof m.quantization === "string" ? m.quantization : null,
                mmlu: Number(m.mmlu) > 0 ? Number(m.mmlu) : null
            });
        }
        return out.size ? out : null;
    } catch { return null; }
    finally { /* the probe key is cleared by the caller that set it */ }
}

/*
 * `known` is what a RE-probe already has on record: the prefix the host
 * answered on last time, and its wire shape. Discovery is for a NEW address —
 * re-running it on every refresh means walking a ladder of routes that are
 * known to 404, and paying a timeout for each of them if the network is
 * unwell. Measured: a refresh failed after 20,006 ms with "the endpoint did
 * not respond", having spent the entire budget on an Ollama sniff and a
 * /v1/models rung that the endpoint has never answered — the documented route
 * it DOES answer was never reached.
 */
async function probe(baseUrl, key, known = null) {
    const ep = { id: "__probe", baseUrl };
    if (key) memoryKeys.set("__probe", key);
    try {
        // OLLAMA ANSWERS BOTH SURFACES, AND THE LADDER ASKS THE WRONG ONE FIRST.
        //
        // Measured against a Spark node reached over a mesh VPN: Ollama serves
        // /v1/models AND /api/tags. The ladder below tries /v1/models first, so
        // it answered, the node was recorded as shape "openai", and connect()
        // then ran verifyKey against it — a real chat completion, to prove an
        // API key that a machine on your own network does not have and does not
        // want. It published no prices either, so the ping had no cheap model to
        // fall back to and used the default pick: mistral-large:123b, 100 GB off
        // disk. Clicking "Link models" spun a busy cursor, timed out, and put
        // nothing in the picker.
        //
        // /api/tags is Ollama's own endpoint and nothing else serves it, so
        // asking it once is a POSITIVE identification that does not depend on
        // ladder order. Failure here is not failure to connect — the ladder
        // still decides that — so nothing thrown by this is fatal.
        // set when the host answered the catalogue only after the key was
        // dropped — the list is real, the credential is not
        let keyRejected = false;
        let ollama = known && known.shape ? known.shape === "ollama" : false;
        // ...and it is only ASKED when the answer is not already on record. A
        // re-probe of a host already identified as OpenAI-shaped spent eight
        // seconds of its budget re-asking a question it answered at link time.
        if (!known || !known.shape) {
            try {
                const tags = await request(ep, "/api/tags", { timeoutMs: 8_000 });
                if (tags.status === 200 && !tags.truncated) {
                    ollama = Array.isArray((JSON.parse(tags.body) || {}).models);
                }
            } catch { /* not an Ollama, or unreachable — the ladder reports which */ }
        }

        // ASK, DO NOT ASSUME. Hosts root their OpenAI surface differently:
        // DeepSeek at /v1, DeepInfra at /v1/openai (so its models list is
        // /v1/openai/models and its chat is /v1/openai/chat/completions),
        // llama.cpp and vLLM at /v1, Ollama natively at /api. Hardcoding /v1
        // built a doubled path for DeepInfra and produced a 404 the user would
        // have had no way to diagnose. Whichever prefix answers is recorded on
        // the endpoint and used for every later call.
        // KEEP WHAT THE HOST TELLS US ABOUT EACH MODEL.
        //
        // This used to be `.map(m => m.id)` — every field but the name thrown
        // away. Measured against the live DeepInfra catalogue, each of its 174
        // entries carries a metadata block:
        //
        //   context_length  1048576      (V4-Pro: a 1M-token window)
        //   max_tokens      1048576
        //   pricing         { input_tokens: 1.3, output_tokens: 2.6, … }
        //   description     "…MoE model with 1.6T total parameters…"
        //
        // Discarding it meant the app had to guess all three: rates came from a
        // shipped table that goes stale the moment a provider reprices, the
        // context window was assumed, and the default-model picker had nothing
        // to judge on but the characters in the name — which is how it once
        // chose a roleplay finetune out of 174 models because "70B" appeared in
        // its id. The host already knows. Ask it once, at link time.
        const openaiPluck = (j) => (j.data || []).map(m => {
            const id = m.id || m.name;
            if (!id) return null;
            // TWO PUBLISHED SHAPES, ONE PLUCK. DeepInfra nests everything under
            // m.metadata; OpenRouter publishes description, context_length,
            // architecture.output_modalities, top_provider.max_completion_tokens
            // and pricing at the TOP level — reading only metadata dropped every
            // OpenRouter price and window on the floor ("the rate table is not
            // up to date"). Metadata first, then top level, per field.
            const md = m.metadata || {};
            const price = md.pricing || m.pricing || {};
            const top = m.top_provider || {};
            // per MILLION tokens, the unit the rest of the app uses. DeepInfra
            // quotes per-million numbers (input_tokens/output_tokens); OpenRouter
            // quotes per-TOKEN strings (prompt/completion), converted here —
            // both under the same plausibility gate, because a host off by 1e6
            // would read $2,600 for one message.
            let rate = null;
            if (typeof price.input_tokens === "number"
                && typeof price.output_tokens === "number"
                && price.input_tokens < 10_000 && price.output_tokens < 10_000) {
                rate = { in: price.input_tokens, out: price.output_tokens };
            } else if (price.prompt !== undefined && price.completion !== undefined) {
                const pin = Number(price.prompt) * 1e6;
                const pout = Number(price.completion) * 1e6;
                if (Number.isFinite(pin) && Number.isFinite(pout)
                    && pin >= 0 && pout >= 0 && pin < 10_000 && pout < 10_000) {
                    rate = { in: pin, out: pout };
                }
            }
            // OpenRouter publishes expiration_date (retirement date) rather than
            // DeepInfra`s deprecated stamp; fold it into the same field so an
            // expiring OpenRouter id drops like a retired DeepInfra one.
            const _exp = m.expiration_date ? Date.parse(m.expiration_date) : 0;
            return {
                id,
                rate,
                deprecated: _exp > 0 && _exp <= Date.now() ? Math.floor(_exp / 1000) : undefined,
                contextLength: Number(md.context_length) || Number(m.context_length)
                    || Number(top.context_length) || null,
                maxTokens: Number(md.max_tokens) || Number(top.max_completion_tokens) || null,
                // the provider's own modality verdict, when published
                outputModalities: (m.architecture && Array.isArray(m.architecture.output_modalities))
                    ? m.architecture.output_modalities.filter(x => typeof x === "string").slice(0, 8)
                    : undefined,
                // THE HOST'S OWN CAPABILITY SIGNAL. DeepInfra's documented
                // per-model schema surface is metadata.tags — a model that
                // supports reasoning_effort carries the literal tag
                // "reasoning_effort" (docs.deepinfra.com, confirmed against
                // the live listing). Kept so the request builder can consult
                // the provider's published word instead of assuming.
                tags: Array.isArray(md.tags)
                    ? md.tags.filter(t => typeof t === "string").slice(0, 24)
                    : undefined,
                description: typeof md.description === "string"
                    ? md.description.slice(0, 400)
                    : typeof m.description === "string" ? m.description.slice(0, 400) : ""
            };
        }).filter(Boolean);

        // Ollama's native list — the only place a size is published: `size` is
        // bytes on disk and `details.parameter_size` is the count. Both are kept
        // because they are the ONLY way to tell 123B from 4B on a host that
        // prices nothing, and picking the wrong one of those to poke is a
        // hundred gigabytes of loading.
        const tagsPluck = (j) => (j.models || [])
            .map(m => ({ id: m.name || m.model,
                         sizeBytes: Number(m.size) || null,
                         parameterSize: (m.details && m.details.parameter_size) || "" }))
            .filter(m => m.id)
            .map(m => ({ ...m, rate: null, contextLength: null,
                         maxTokens: null, description: "" }));

        // THE ROUTE THIS HOST ALREADY ANSWERED GOES FIRST. For DeepInfra that
        // is the documented one — base https://api.deepinfra.com/v1/openai
        // with an empty prefix, so GET /v1/openai/models — and putting it at
        // the head of the ladder turns a refresh into one round trip instead
        // of three, two of which are known 404s for this host.
        const head = [];
        if (known && known.shape === "ollama") {
            head.push(["/api/tags", "ollama", tagsPluck]);
        } else if (known && typeof known.prefix === "string") {
            head.push([known.prefix + "/models", "openai", openaiPluck]);
        }
        for (const [urlPath, ladderShape, pluck] of [
            ...head,
            ["/v1/models", "openai", openaiPluck],
            // OpenRouter lists models at /api/v1/models — the docs hostname
            // pasted bare reached none of the rungs above; apiPrefix derives
            // to /api/v1 so chat lands on /api/v1/chat/completions
            ["/api/v1/models", "openai", openaiPluck],
            ["/models", "openai", openaiPluck],
            ["/openai/models", "openai", openaiPluck],
            ["/v1/openai/models", "openai", openaiPluck],
            // The native list is the only place a size is published: `size` is
            // bytes on disk and `details.parameter_size` is the count. Both are
            // kept because they are the ONLY way to tell 123B from 4B on a host
            // that prices nothing — and picking the wrong one of those to poke
            // is a hundred gigabytes of loading.
            ["/api/tags", "ollama", tagsPluck]
        ]) {
            let r;
            // A RE-PROBE IS ON A SHORTER LEASH THAN A DISCOVERY. Discovery is
            // a one-off against an unknown address and can afford to wait; a
            // refresh is a button the operator is watching, on a route this
            // host has already answered. Twelve seconds a rung is how one
            // click spent twenty of them and reported a reachable host as
            // unreachable.
            const rungMs = known ? 7_000 : 12_000;
            try { r = await request(ep, urlPath, { timeoutMs: rungMs }); }
            catch (e) {
                // NAME THE FAILURE AS THE NETWORK'S, because that is what it
                // is: the request never completed. Saying only "did not
                // respond" reads as a broken endpoint and sends the user
                // looking at the provider — a log showed this after 20s
                // while a VPN was blocking, with the node unreachable in
                // the same minute. The stored model list is untouched.
                const host = new URL(baseUrl).host;
                const why = scrub(e.message, key);
                throw new ToolError(
                    `could not reach ${host}: ${why}. Nothing was changed — the ` +
                    `model list you already have is still there. This is the ` +
                    `network between this machine and ${host}, not the endpoint ` +
                    `itself: check a VPN or firewall, then try again.`);
            }
            // A REJECTED KEY MUST NOT BLIND THE APP TO WHAT THE HOST SERVES.
            //
            // Measured against the live host: /v1/openai/models answers 200
            // with NO Authorization header and 401 with a rejected one. So a
            // stale key turned a public catalogue into a dead end — refreshing
            // the model list failed outright instead of listing the models and
            // saying the key is the problem. Ask again unauthenticated; if the
            // host answers, carry on and flag the key.
            if ((r.status === 401 || r.status === 403) && key) {
                const held = memoryKeys.get("__probe");
                memoryKeys.delete("__probe");
                let anon = null;
                try { anon = await request(ep, urlPath, { timeoutMs: 12_000 }); }
                catch { anon = null; }
                finally { if (held !== undefined) memoryKeys.set("__probe", held); }
                if (anon && anon.status === 200) { r = anon; keyRejected = true; }
            }
            if (r.status === 401 || r.status === 403) {
                throw new ToolError(key
                    ? `${new URL(baseUrl).host} rejected that key`
                    : `${new URL(baseUrl).host} needs an API key — paste it in with the address`);
            }
            if (r.status === 200) {
                // A truncated body is a DIFFERENT failure from a wrong shape,
                // and saying so is the whole point of tracking it.
                if (r.truncated) {
                    throw new ToolError(
                        `${new URL(baseUrl).host} sent a model list larger than ` +
                        "2 MB, which is more than this can read. That is not a " +
                        "normal catalogue — check the address is the API base " +
                        "and not a web page.");
                }
                let j; try { j = JSON.parse(r.body); } catch { continue; }
                const entries = pluck(j).filter(Boolean);
                // AN EMPTY CATALOGUE FROM A HOST THAT ANSWERED IS AN ANSWER.
                // "First rung whose pluck yields entries wins" meant a host
                // whose models were deliberately REMOVED (the operator culled
                // all ten Ollama pagers) could never say so — every refresh
                // fell off the ladder, the probe failed, and the store served
                // the ghost list forever. A parsed 200 with zero models from a
                // recognisable surface updates the store to zero.
                if (!entries.length && j && (Array.isArray(j.models) || Array.isArray(j.data))) {
                    const apiPrefix = ladderShape === "ollama"
                        ? "/v1" : urlPath.replace(/\/models$/, "");
                    return { shape: (ollama || ladderShape === "ollama") ? "ollama" : ladderShape,
                             models: [], catalogue: [], keyRejected, apiPrefix };
                }
                if (entries.length) {
                    // The prefix that worked, minus the endpoint we probed with
                    // — EXCEPT for the native tags list, which is not an OpenAI
                    // surface at all. Ollama's chat lives at
                    // /v1/chat/completions; /api/chat/completions is a 404 on
                    // every version of it, so recording "/api" here linked an
                    // endpoint that could list models and never answer one.
                    const apiPrefix = ladderShape === "ollama"
                        ? "/v1"
                        : urlPath.replace(/\/models$/, "");
                    // the provider's own richer sheet, merged in where it
                    // publishes one (type / tools / deprecated / replaced_by)
                    if (ladderShape !== "ollama") {
                        try {
                            const meta = await providerModelMeta(baseUrl, key);
                            if (meta) {
                                for (const e of entries) {
                                    const extra = meta.get(e.id);
                                    if (extra) Object.assign(e, extra);
                                }
                            }
                        } catch { /* additive only — never fails a link */ }
                    }
                    return {
                        // what the host IS. /api/tags answering is Ollama
                        // whichever rung of the ladder produced the catalogue.
                        shape: (ollama || ladderShape === "ollama") ? "ollama" : ladderShape,
                        // `models` stays a plain array of id strings: every
                        // existing caller — the picker, selectModel, the tests —
                        // reads it that way, and quietly changing its element
                        // type would break all of them at once.
                        models: entries.map(e => e.id),
                        // the rest rides alongside, keyed by id
                        catalogue: entries,
                        keyRejected,
                        apiPrefix
                    };
                }
            }
        }
        throw new ToolError(
            `${new URL(baseUrl).host} answered, but not with a model list — is it an ` +
            "OpenAI-compatible or Ollama server?");
    } finally {
        memoryKeys.delete("__probe");
    }
}

/**
 * Does this key actually WORK? One token, the cheapest possible call.
 *
 * The models list is PUBLIC on several hosts — DeepInfra's returns 200 with no
 * Authorization header at all. Probing it therefore proves the host is reachable
 * and proves NOTHING about the key. That gap let the literal placeholder
 * "sk-yourkey" connect successfully and report "no key needed", which is exactly
 * the failure a person cannot debug: the app said yes and the first real message
 * said no. Measured against the live host:
 *
 *     GET  /v1/openai/models                      no key  -> 200
 *     POST /v1/openai/chat/completions             no key  -> 422
 *     POST /v1/openai/chat/completions        fake key     -> 401
 *
 * So connecting now spends one token to find out.
 *
 * ONE token. The cap below is the contract, not a default: every caller picks
 * the cheapest or smallest model it can find precisely because this call is
 * billed and, on a self-hosted node, paid for in load time. Raising it buys
 * nothing — the status code is the entire answer.
 */
async function verifyKey(ep, model) {
    const body = JSON.stringify({
        model, messages: [{ role: "user", content: "hi" }], max_tokens: 1
    });
    let r;
    try {
        r = await request(ep, apiPrefixOf(ep) + "/chat/completions",
                          { method: "POST", body, timeoutMs: 25_000 });
    } catch (e) {
        return { ok: false, why: scrub(e.message) };
    }
    if (r.status === 200) return { ok: true };
    if (r.status === 401 || r.status === 403) {
        return { ok: false, needsKey: true,
                 why: getKey(ep.id)
                     ? "that key was rejected — check it was copied whole, and that it is an "
                       + "API token rather than an SSH key"
                     : "this endpoint needs an API key" };
    }
    if (r.status === 422 && !getKey(ep.id)) {
        return { ok: false, needsKey: true, why: "this endpoint needs an API key" };
    }
    // 404 on a model id, a rate limit, a maintenance window: reachable and
    // authenticated enough to complain specifically, so do not block the link
    return { ok: true, warn: `${r.status}: ${scrub(r.body).slice(0, 140)}` };
}

/**
 * THE ONE CALL. Paste anything; end up connected and in use.
 *
 * @param opts.node  the node record this address belongs to, when the link came
 *                   from the Nodes panel rather than a pasted address. Two
 *                   things follow from it and neither can be recovered later:
 *                   the endpoint is marked as the user's own hardware, and it
 *                   gets its OWN id instead of sharing the "custom" slot with
 *                   every pasted API endpoint — which would otherwise mean
 *                   linking the Spark overwrote a linked DeepInfra (label, URL
 *                   and all) while its encrypted key stayed behind under the
 *                   same id, ready to be sent to the node over plain http.
 * @returns {{ok:true, endpoint, model, models, shape, keyState}}
 */
async function connect(pasted, opts = {}) {
    const node = (opts && opts.node) || null;
    // THE FOURTH TIER GETS A PRODUCER.
    //
    // `rented` was read in five places and written in exactly one — linkEndpoint
    // — and the only caller of linkEndpoint a person can reach by clicking is
    // this function, which never passed it. So ep.rented was false for every
    // endpoint that could actually exist: the rented short-circuit in
    // isNodeEndpoint never fired, destinationOf never reached its rented branch,
    // the GPU tier never rendered, and the 900s/300s patience split never
    // differed. An operator who rents an A100 by the hour and pastes its address
    // into Connections got an ordinary API endpoint whose secrets card named a
    // hostname instead of saying "a rented machine, not yours".
    //
    // `rented` is forwarded as the plain boolean the Connect box states, because
    // the checkbox is right there beside the address and an unticked box is an
    // answer. `provider` is forwarded only when it says something: a blank field
    // is "no opinion", and wiping a known provider off a relink would lose the
    // one word the permission card names the owner with.
    const rented = !!(opts && opts.rented);
    const provider = (opts && opts.provider) ? String(opts.provider).trim().slice(0, 60) : "";
    requireNetwork();
    const text = String(pasted || "").trim();
    if (!text) throw new ToolError("paste a server address, and an API key if it needs one");

    // SSH KEY MATERIAL IS NOT AN API KEY — and the "paste both together"
    // coaching below would have the operator pair it with an address, store
    // it and transmit it as a Bearer header. Refuse it by name first.
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
        || /(^|\s)(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+)(\s|$)/.test(text)
        || /\bAAAA(B3NzaC1|C3NzaC1|E2VjZHNh)/.test(text)) {
        throw new ToolError("that is an SSH key, not an API key — SSH keys open " +
            "shells, not model APIs, and pasting one here would send it to a web " +
            "server. Use the provider's API key from its dashboard instead " +
            "(OpenRouter keys start with sk-or-v1-).");
    }
    const tokens = text.split(/[\s,;]+/).filter(Boolean);
    const key = tokens.find(looksLikeKey) || null;
    let urlTok = tokens.find(looksLikeUrl) || null;
    // A KEY THAT NAMES ITS OWN HOME NEEDS NO ADDRESS. Provider key prefixes are
    // published and stable — an sk-or-v1- key IS an OpenRouter key, and telling
    // the operator "no server address" for one (measured: that is exactly how
    // the OpenRouter add failed) is the app refusing information it has.
    const KEY_HOME = [
        [/^sk-or-v1-/, "https://openrouter.ai/api/v1"],   // the documented OpenRouter prefix
    ];
    if (!urlTok && key) {
        const home = KEY_HOME.find(([re]) => re.test(key));
        if (home) urlTok = home[1];
    }
    if (!urlTok) {
        throw new ToolError(key
            ? "that looks like a key but there is no server address with it — paste both " +
              "together, e.g.  api.deepinfra.com sk-yourkey"
            : `no server address in "${text.slice(0, 40)}"`);
    }

    const baseUrl = normaliseBase(urlTok);
    const host = new URL(baseUrl).hostname;
    if (new URL(baseUrl).protocol === "http:" && !isLocalHost(host)) {
        throw new ToolError(
            `${host} is on the internet, so plain http would send your key and prompts ` +
            "in the clear — use https://" + host);
    }

    const found = await probe(baseUrl, key);
    const model = pickDefaultModel(found.models, found.catalogue);
    // (chatIds is computed below; pickDefaultModel already rejects
    //  non-chat models via the same description test)

    // ADOPT THE HOST'S OWN PRICES.
    //
    // The rate table shipped with the app is a snapshot: correct the day it was
    // written, wrong the day a provider reprices, and absent entirely for the
    // other 160 models in a catalogue this size. The endpoint publishes its
    // real numbers, so a rate learned here is both current and complete, and
    // the user override still wins over it (tokenCost.setRate marks a rate as
    // user-set and learnFromCatalogue never overwrites one of those).
    let priced = 0;
    if (tokenCost.learnRates) {
        priced += tokenCost.learnRates((found.catalogue || [])
            .filter(e => e && e.rate)
            .map(e => ({ id: e.id, in: e.rate.in, out: e.rate.out })));
    }

    // Reasoning arrives in one of two shapes and the endpoint does not announce
    // which. Most hosts serving an R1 distill emit literal <think> tags inside
    // content, which thinkStream handles. DeepSeek's OWN api puts it in a
    // separate `reasoning_content` field instead — so if that is not declared
    // here, the entire chain of thought is dropped on the floor for the one
    // provider most likely to be used for reasoning. Keyed off the host because
    // that is the only signal available before the first token.
    // A HINT, NOT THE ONLY SIGNAL. Hosts known to use the separate field are
    // declared here so the very first frame is handled correctly, but
    // streamChat also sniffs the field off the wire — otherwise the same
    // DeepSeek weights served from DeepInfra (which is the host this product
    // steers people to, being US-hosted) would have their entire chain of
    // thought discarded because the hostname did not match.
    const reasoningField =
        /(^|\.)(deepseek\.com|deepinfra\.com|fireworks\.ai|together\.(xyz|ai))$/i.test(host)
            ? "reasoning_content" : null;

    // CHAT MODELS ONLY IN THE PICKER.
    //
    // 41 of DeepInfra's 174 are embedding, rerank, speech, transcription or
    // image models. Listing them beside the chat models means the picker offers
    // choices that cannot possibly work, and the user finds out by selecting one
    // and watching the first message fail. Everything discovered is still
    // recorded on the endpoint — `allModels` — so nothing is silently lost.
    const chatIds = found.models.filter(id => isChatCapable(id, found.catalogue));
    const skipped = found.models.length - chatIds.length;

    // ASK THE NODE WHAT ITS WINDOW IS, ONCE. /api/show reads the manifest and
    // does not load anything, so it costs a round trip and no RAM — worth it for
    // the model about to be selected, because that is the one router.limits()
    // sizes the agent loop from. Everything else takes the stated assumption.
    const local = isLocalHost(host);
    const reported = (local && found.shape === "ollama" && model)
        ? await ollamaContextLength(baseUrl, model) : 0;

    // EVERY PASTE GETS ITS OWN SLOT, KEYED BY ITS ADDRESS.
    //
    // Every pasted endpoint used to arrive as preset "custom" with no id, and
    // linkEndpoint derives the id from the preset when none is given — so one
    // "custom" record was shared by whatever was linked most recently. For a
    // node that meant the next message could send DeepInfra's key to the node
    // over plain http (fixed first, with node-<host> ids). But the API half
    // was just as broken, and the panel's "Add another" made it a promise:
    // adding GO silently REPLACED DeepInfra; a failed GO add ran the
    // unlink-on-bad-key path against the shared record and destroyed the
    // working endpoint; and a new host could inherit the previous provider's
    // encrypted key. Per-address slots end all three, and migrateSharedSlot
    // carries an old install's "custom" record to its per-host id the first
    // time that address is re-linked.
    const epId = endpointIdFor(baseUrl, host, !!node);
    // heal older stores on the way past: the shared "custom" slot, and the
    // host-only id this address wore before ids carried their path
    migrateSharedSlot(epId, baseUrl, ["custom", node ? `node-${host}` : `api-${host}`]);
    // A PASTED ADDRESS THAT IS A KNOWN PRODUCT IS THAT PRODUCT. Filing it as
    // "custom" threw away the name AND the plan — see presetForBase. A node
    // always keeps the user's own name for it.
    const known = node ? null : presetForBase(baseUrl);
    // a freshly linked known product gets its published prices immediately —
    // the wire carries none, so without this the first turn is unpriced
    if (known) { try { seedPresetRates(known); } catch { } }
    const ep = linkEndpoint({
        id: epId,
        preset: known ? known.id : "custom",
        // the ENGINE names this endpoint; the node names the folder it sits in
        label: (opts && opts.label) || (node && node.name)
            || (known && known.label) || host,
        providerFamily: node ? "node-" + (node.id || host) : undefined,
        providerFamilyLabel: node ? ((node.name) || host) : undefined,
        shape: found.shape || null,
        baseUrl, key: key || undefined,
        models: modelRecords(chatIds, found.catalogue, {
            assumeContext: local ? LOCAL_ASSUMED_CONTEXT : 0,
            reportedFor: model, reported
        }),
        allModels: found.models,
        reasoningField,
        apiPrefix: found.apiPrefix,
        // undefined, not false, on a pasted link: a relink of something else
        // must not demote a node, and only the Nodes panel can promote one.
        localNode: node ? true : undefined,
        // straight off the recipe table — see nodeStacks.ROLES
        nodeRole: (opts && opts.role) || undefined,
        nodeStack: (opts && opts.stack) || undefined,
        // the subscription plan the Connect box's preset declared, if any.
        // Coerced through || so BOTH undefined and null mean "no opinion" —
        // the renderer sends null on an ordinary paste, and treating that as
        // an explicit strip silently turned the GO meter off on every key
        // rotation done without clicking the chip. "none" is the one explicit
        // CLEAR: the Zen chip sends it so per-token linking genuinely removes
        // a GO plan instead of silently keeping the meter armed (once-GO-
        // always-GO was the reviewed lie).
        // ...AND THE ADDRESS ITSELF CAN DECLARE ONE. GO is metered in its
        // plan's dollar windows and that meter is armed by this field; pasted
        // as an ordinary address it arrived with no plan, so the window meter
        // never appeared and the rate table read empty. The caller still wins
        // — an explicit "none" strips it, an explicit plan overrides — but a
        // silent paste of a known product now gets that product's terms.
        plan: opts.plan === "none" ? null
            : (opts.plan || (known && known.plan) || undefined),
        // memBytes: THE MACHINE'S OWN SIZE, CARRIED RATHER THAN ASSUMED.
        // nodePreflight sizes a cold load against this and refuses only what
        // cannot fit; with nothing here it fails open and the turn proceeds.
        // main.js measures it off the node's /proc/meminfo — the same
        // physTotalBytes the dashboard already reports — and puts it on the
        // node record. Never defaulted to a number here: a size nobody measured
        // is worse than no size at all.
        node: node ? { id: node.id, name: node.name || host, host: node.host || host,
                       port: node.port || null,
                       // the THIRD trim of a node record, found because the
                       // first two were fixed and the guard still could not
                       // see which server the door proxies — a field dropped
                       // on any hop is dropped, however many hops carry it
                       doorBackendPort: Number(node.doorBackendPort) > 0
                           ? Number(node.doorBackendPort) : null,
                       memBytes: Number(node.memBytes) > 0 ? Number(node.memBytes) : null }
                   : undefined,
        rented,
        provider: provider || undefined
    });

    /* the REAL windows, asked of the engine itself: llama.cpp /props, vLLM
       max_model_len — so the donut stops presenting a 32k assumption as fact */
    if (node) { try { await measureNodeWindows(epId); } catch { /* assumption stays, marked */ } }

    // THE SAME BOX, LISTED TWICE. A node linked before it had an id of its own
    // is sitting in the shared "custom" slot pointing at this very address, and
    // leaving it there means every model on the node appears twice in the
    // picker with no way to tell which row is real. Only ever removes a record
    // that is the same address, is not the one just written, and holds no key —
    // a key is a thing the user typed and is never collateral.
    if (node) {
        for (const other of endpoints()) {
            if (other.id !== ep.id && other.baseUrl === baseUrl && !other.hasKey
                && !other.keyEncrypted) {
                unlinkEndpoint(other.id);
            }
        }
    }

    // PROVE THE KEY BEFORE CLAIMING SUCCESS. Reaching the catalogue is not the
    // same as being able to use it, and saying "connected" on the strength of a
    // public endpoint is how a placeholder key got accepted.
    //
    // BUT NOT ON A LOCAL NODE, WHERE THERE IS NO KEY TO PROVE. verifyKey is a
    // real chat completion; against a hosted provider that is one token well
    // spent, and against your own hardware it makes the node LOAD A MODEL to
    // answer it. On the DGX Spark that meant pulling mistral-large:123b — 100 GB
    // — off disk to check a credential that does not exist and is not wanted:
    // busy cursor, timeout, nothing in the picker. A local server that does want
    // a key still says so on the first message, which is a sentence the user can
    // read; a link that never completes is not.
    let verified = false;
    if (found.shape !== "ollama" && !local) {
        // Verify against the CHEAPEST chat model the host prices, not the
        // default pick. The ping is one token, but the default pick is by
        // design the flagship — so the very first thing the app did with a
        // fresh key was call the most expensive model on the account. The
        // user noticed, and they were right to: on DeepInfra this moves the
        // ping from V4-Pro to V4-Flash at a fourteenth of the rate.
        const priceable = (found.catalogue || [])
            .filter(e => e.rate && chatIds.includes(e.id))
            .sort((a, b) => (a.rate.in + a.rate.out) - (b.rate.in + b.rate.out));
        // With NOTHING priced there is no cheapest, and falling back to the
        // default pick fell back to the largest thing on the host — the exact
        // wrong direction for a call whose only job is to see a status code.
        // Smallest by any size the host declared, or in its name.
        const pingModel = (priceable[0] && priceable[0].id)
            || smallestModel(chatIds, found.catalogue) || model;
        const v = await verifyKey({ ...ep, id: ep.id }, pingModel);
        if (!v.ok) {
            unlinkEndpoint(ep.id);          // do not leave a broken link behind
            throw new ToolError(v.why);
        }
        if (v.warn) found.warn = v.warn;
        verified = true;
    }

    // the drawing model, seeded from what the host publishes (28 DeepInfra
    // models carry the image-gen tag) so the image path has a target the
    // moment the capability probe says the route exists
    try {
        const img = pickImageModel(found.catalogue);
        if (img) setImageModel(ep.id, img);
    } catch { /* image generation stays unavailable, nothing else breaks */ }

    // LINKING IS NOT CHOOSING. This used to selectModel() the ping model into
    // the GLOBAL driver role — so connecting an endpoint silently made a paid
    // API model the default every new conversation drives, without the
    // operator ever picking a default. "you still have Qwen3.7 Max loading as
    // the default model." A link makes models AVAILABLE; the global roles are
    // set only by the operator, in Model Orchestration.

    return {
        ok: true, endpoint: { id: ep.id, label: ep.label, baseUrl: ep.baseUrl,
                              hasKey: ep.hasKey },
        model, models: chatIds, allModels: found.models, shape: found.shape,
        keyState: ep.keyState,
        // stated plainly so the UI has one line to show and nothing to compute
        summary: `connected to ${host} — ${chatIds.length} chat model` +
                 `${chatIds.length === 1 ? "" : "s"}` +
                 (skipped ? ` (${skipped} embedding/speech/image models hidden)` : "") +
                 `, using ${model || "none"}` +
                 (priced ? ` — ${priced} priced from the endpoint` : "") +
                 // only claimed when it actually happened: the line existed to
                 // stop the app saying yes about an unproven key, and saying it
                 // after skipping the check would be the same lie in reverse
                 (key && verified ? " — key verified with a live call" : "")
    };
}

/** Record an escalation (a local model spending money) in the ledger. */
function recordEscalation(sessionId, sessionTitle, r, onSpend) {
    try {
        if (!r || !r.usage) return;
        const usd = (r.cost && r.cost.usd) || 0;
        require("./ledger").record({
            sessionId, sessionTitle,
            model: r.model, endpoint: r.endpoint,
            inputTokens: r.usage.prompt_tokens,
            outputTokens: r.usage.completion_tokens,
            usd,
            via: "local-escalation",
            // an escalation that ran on a machine the operator OWNS is genuinely
            // free and belongs in the "hardware earned back" node totals — not
            // metered as paid usage. Dropping this flag hid every owned-node
            // fleet/reasoner call from the node dashboard.
            localNode: r.localNode ? true : undefined
        });
        // THE TURN HAS TO KNOW WHAT ITS TOOLS SPENT. This money left the
        // machine from inside runTool, so it never touched the turn's own
        // `turnUsd` — which meant an Ancient Knowledge round could escalate
        // repeatedly and the AK budget, computed from turnUsd, never moved.
        if (usd > 0 && typeof onSpend === "function") onSpend(usd);
    } catch { /* bookkeeping never breaks a call */ }
}

/**
 * The last N calls this app made to a machine of the user's own, newest
 * first. A log nobody can read is not telemetry, it is a landfill.
 */
function recentNodeCalls(limit = 200) {
    try {
        const lines = fs.readFileSync(nodeLogPath(), "utf8").split(/\r?\n/).filter(Boolean);
        return lines.slice(-Math.max(1, limit))
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean).reverse();
    } catch { return []; }
}

/**
 * THE SAME RULE THE LOCAL ENGINE NEEDS, ON THE ROAD TO SOMEBODY ELSE'S MACHINE.
 *
 * A node or a vendor refuses an over-long prompt exactly the way llama.cpp does,
 * and this path had NO handling for it whatsoever — cloudModels read
 * context_length out of model metadata and then never looked at the error.
 * MEASURED against a real model behind a real HTTP endpoint, the shape a node
 * serves:
 *
 *   bench-node returned 400: request (6432 tokens) exceeds the available
 *   context size (2048 tokens), try increasing it
 *
 * ...thrown, so the turn died and the session was finished for good. The local
 * side at least detected it. This side did not, which is why a conversation on
 * the user's own node stopped answering and a fresh one worked.
 */
function streamChat(messages, opts = {}) {
    // AN OPTIONAL FIELD NEVER KILLS A CALL. reasoning_effort is an enhancement
    // some servings accept (GLM, o-series) and others 400/422/500 on — and a
    // failure it caused used to surface as "this model is broken" (and, worse,
    // 500s pruned the model from the catalog). One retry with the field
    // stripped separates "your request shape" from "the model is down".
    const attempt = (stripEffort) => contextFit.sendFitting(messages,
        (msgs) => streamChatOnce(msgs, { ...opts, stripEffort }),
        { cancelToken: opts.cancelToken });
    // the retry only exists where the field was actually SENT: a hosted
    // endpoint with effort set. On a node the body never carried it, so a
    // retry would re-send byte-identical bytes (re-triggering a failing load
    // on the user's own machine) under a false "rejected reasoning_effort"
    // note — mirror the body builder's own gate.
    const effortWasSent = (() => {
        if (!opts.session || typeof opts.session.effortLevel !== "number"
            || opts.session.effortLevel <= 0) return false;
        try {
            const sel = opts.selection || selectedFor(opts.role || "driver");
            // mirror the body builder EXACTLY — effortSupported is now the one
            // gate (wire shape + the model's own published tags), so there is
            // nothing to strip where it already said no
            return !!sel && effortSupported(sel);
        } catch { return false; }
    })();
    // Did the request ACTUALLY carry a tools array? The catch below may only
    // blame tools for a failure when tools were on the wire.
    const toolsSent = (() => {
        if (!Array.isArray(opts.tools) || !opts.tools.length || opts.noTools) return false;
        try {
            const sel = opts.selection || selectedFor(opts.role || "driver");
            return !!sel && toolsSupported(sel);
        } catch { return false; }
    })();
    // ONE CATCH, BOTH RECOVERIES. The tools fallback used to live inside the
    // effort retry, which returns early when no reasoning effort was sent — so
    // a serving that refused a tools array only recovered on turns that also
    // happened to carry reasoning_effort. Every other turn died on the 400.
    return attempt(false).catch((e) => {
        const msg = String((e && e.message) || e);
        // an empty 200 is the QUIET form of the same rejection — some servings
        // swallow a request with a field they do not support and answer
        // nothing at all instead of erroring. One retry without the field
        // separates "your request shape" from "the model is down" either way.
        // THE STATUS, NOT THE SENTENCE. This matched on the wording of the
        // error text, which is exactly the thing a better error message is
        // free to change — and did. The status rides on the error now.
        const status = Number(e && e.status) || 0;
        const emptyAnswer = !!(e && e.emptyAnswer);
        /* A SERVING THAT WILL NOT TAKE TOOLS SAYS SO, ONCE.
         *
         * Ollama answers "does not support tools" for a model without them,
         * and hosted providers 400 the same way. Rather than let that kill a
         * turn, the call is repeated in the text protocol and the refusal is
         * remembered so it is never sent again for that model. */
        /* ...AND A REFUSAL OF THE TOOLS ARRAY HAS TO SAY SO.
         *
         * A bare 400 is not evidence about tools: a context overflow, a bad
         * parameter, a rejected reasoning_effort all arrive as 400, and the
         * first cut of this branch claimed every one of them. It marked the
         * model as tools-refusing FOR THE LIFE OF THE PROCESS, told the
         * operator something false, re-sent the same reasoning_effort that
         * had just been rejected, and returned before the effort recovery
         * below could run. /tool/i over the whole message was no better — it
         * matches the model id and the endpoint label, so a 429 from a
         * tool-calling model disabled its own tool calling.
         *
         * The provider says this plainly when it means it, so that is what is
         * matched — and only when tools were actually sent. */
        const toolsWereSent = Array.isArray(opts.tools) && opts.tools.length
            && !opts.noTools && toolsSent;
        const saysTools = /does not support tools|tool[ _]?(calling|choice|use) (is )?(not|un)supported|no support for tools|tools are not supported|unknown field:? *.?tools|unsupported parameter:? *.?tools|invalid.{0,20}tools/i
            .test(String((e && e.message) || ""));
        if (toolsWereSent && saysTools
            && !(opts.cancelToken && opts.cancelToken.cancelled)) {
            try {
                const sel = opts.selection || selectedFor(opts.role || "driver");
                if (sel) rememberToolsRefused(sel);
                if (typeof opts.onNote === "function") {
                    opts.onNote("that model does not take a tools array — " +
                                "falling back to the text protocol");
                }
            } catch { }
            // ...and the fallback keeps every OTHER recovery: it is the same
            // wrapper, minus the tools, so an effort rejection on the retry is
            // still caught rather than ending the turn.
            return streamChat(messages, { ...opts, noTools: true });
        }
        const shapeRejected = status === 400 || status === 422 || status === 500;
        if (effortWasSent && (shapeRejected || emptyAnswer)
            && !(opts.cancelToken && opts.cancelToken.cancelled)) {
            try { if (typeof opts.onNote === "function") {
                opts.onNote(emptyAnswer
                    ? "that serving answered empty — retrying without reasoning_effort"
                    : "that serving rejected reasoning_effort — retrying without it");
            } } catch { }
            return attempt(true);
        }
        throw e;
    });
}

module.exports = {
    recordEscalation, recentNodeCalls, nodeLogPath, isRentedEndpoint,
    PRESETS, endpoints, linkEndpoint, unlinkEndpoint,
    config, selectModel, selected, available,
    putKey, clearKey, hasKey: (id) => !!getKey(id),
    /**
     * AN AUTHENTICATED POST, WITHOUT HANDING OUT THE KEY.
     *
     * The tool-fallback path needs to call a linked endpoint's image route.
     * It could have been given a key getter; it is given this instead, so the
     * credential never leaves this module — the same reason `hasKey` above is
     * a boolean and not the key. Errors come back scrubbed of it.
     */
    authedPostJson: async (ep, urlPath, bodyObj, timeoutMs = 180_000) => {
        const res = await request(ep, urlPath,
            { method: "POST", body: JSON.stringify(bodyObj), timeoutMs });
        if (res.status < 200 || res.status >= 300) {
            throw new ToolError(`the endpoint refused (HTTP ${res.status}): ` +
                                scrub(String(res.body || "").slice(0, 300), getKey(ep.id)));
        }
        try { return JSON.parse(res.body); }
        catch { throw new ToolError("the endpoint did not answer with JSON"); }
    },
    // the door token, decrypted, for the node-monitoring fallbacks in main —
    // deliberately narrow: only ::door entries, never an API key
    getDoorToken: (endpointId) => getKey(endpointId + "::door"),
    discoverModels, testEndpoint, streamChat, priceOf, scrub, isLocalHost,
    // WHERE THIS ENDPOINT ROOTS ITS OPENAI SURFACE. Exported because callers
    // outside this file build routes too — imageRemote hardcoded "/v1/...",
    // which doubles the path on a host whose base already carries one
    // (DeepInfra: /v1/openai) and 404s every time.
    apiPrefixOf,
    // what a machine turned out to be able to do beyond chat — probed without
    // generating anything, so the tool-fallback chain can prefer the
    // operator's own hardware over a paid endpoint
    probeImageCapability, setCapability,
    // THE FIT CHECK, ASKABLE ON ITS OWN. streamChat runs it before every node
    // turn, but a guard whose only entry point is a live chat request can only
    // be tested by regex over this file — which is how it came to size every
    // machine against a hardcoded 128 GB for as long as it existed. Exported so
    // a suite can hand it a node record and read the real verdict, and so
    // main.js can name it without naming something that is not there.
    nodePreflight, FLEET_ENTRY, endpointIsFreeNode, freeFleetEndpoint,
    measureNodeWindows,
    // the same fit arithmetic, asked statically with the machine empty — the
    // picker's "this can never load there" verdict comes from here, so the
    // row and the runtime guard cannot disagree
    canEverFitNode,
    // CONTRACT K1. main.js calls this once at startup with a function that
    // resolves a node id against the localNodes registry — the ONE place a
    // node's size and free memory are kept current. Without it the guard is
    // reading a link-time snapshot, which is how it came to proceed for a
    // 100 GB model on a record that simply had no size on it.
    setNodeMemResolver,
    // CONTRACT K4. The picker asks these; it never dials anything itself.
    endpointHealth, markEndpointOffline, markEndpointOnline, checkEndpointReachable,
    // exported so a suite can prove the guard's shape against real numbers
    // rather than against the sentence it happens to print
    NODE_SYS_RESERVE, NODE_HEADROOM_FRACTION, NODE_LARGE_BYTES, MEM_FRESH_MS,
    isNodeEndpoint, selectedIsNode, setNodeRelay, LOCAL_ASSUMED_CONTEXT,
    preferDoor, noteDoorFirst, noteDirectAlive,
    resolveSelection, usableSelection,
    destinationOf, destinationFor,
    askCloudModel, ASK_ENTRY,
    askReasoner, REASONER_ENTRY,
    selectedFor, usableFor, hasReasoner, ROLES,
    connect, normaliseBase, endpointIdFor, setEndpointRenameHook,
    toolsSupported, rememberToolsRefused, clearToolsRefused, isOllamaShape,
    // exported so a suite can prove it survives a starved thread pool — the
    // failure that made a reachable endpoint report "DNS never resolved"
    lookupOffThreadPool,
    pickImageModel, setImageModel,
    effortSupported, modelCan, modelRetirement, setEndpointModels,
    // exported so the suite can prove Zen and GO are told apart
    presetForBase, healKnownPresets,
    // exported so the suite reads the SHIPPED table, not a copy
    OPENCODE_RATES, seedPresetRates,
    modelRecordFor, providerModelMeta, pickDefaultModel, isChatCapable, smallestModel,
    refreshEndpointCatalogue, endpointIsStale, looksLikeKey, looksLikeUrl,
    encryptionAvailable: () => !!safeStorage(),
    // reasoning effort API values per slider level (0-4): undefined, low, medium, high, max
    EFFORT_API: [undefined, "low", "medium", "high", "max"]
};
