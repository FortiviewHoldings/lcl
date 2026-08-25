/**
 * THE BRIDGE, FAKED, SO THE REAL RENDERER CAN BE DRIVEN WITHOUT AN ENGINE.
 *
 * The renderer is 9,000 lines of the product nothing could test. Every suite we
 * had read app.js as TEXT — regexes over source, checking that a function was
 * defined or a string was present. That is how a model picker shipped that
 * threw a ReferenceError on its first row: twenty-five checks passed, and not
 * one of them had ever built a row.
 *
 * This loads the REAL index.html, the REAL styles.css and the REAL app.js in a
 * REAL Chromium, with `window.lcl` replaced by a stub. Anything the renderer
 * does then is genuinely done: layout is computed, listeners fire, exceptions
 * are thrown where they would be thrown. What the harness measures afterwards
 * is the live DOM, not a guess about it.
 *
 * Unknown methods resolve to a permissive shape rather than throwing, because
 * the point is to exercise the RENDERER, not to model the engine. Anything a
 * test actually depends on is pinned in FIXTURES.
 */
const { ipcRenderer } = require("electron");

/* ---------------------------------------------------------------- fixtures */
/* One model of every kind, so the picker has all four tiers to build. */
const GB = 1024 ** 3;
/* TWO ENDPOINTS OF ONE PRODUCT, plus a vendor that is on its own. This is the
   operator's actual account shape: he made one key for Zen and one for GO so
   there would be no confusion, and the picker listed them as strangers. */
const OPENCODE_ROWS = [
    { id: "anthropic/claude-sonnet", label: "claude-sonnet", remote: true,
      endpointId: "api-opencode.ai-zen-v1", endpointLabel: "OpenCode Zen", shortLabel: "Zen",
      providerFamily: "opencode", providerFamilyLabel: "OpenCode",
      params: "api", contextMax: 200000 },
    { id: "openai/gpt-5", label: "gpt-5", remote: true,
      endpointId: "api-opencode.ai-zen-go-v1", endpointLabel: "OpenCode GO", shortLabel: "GO",
      providerFamily: "opencode", providerFamilyLabel: "OpenCode",
      params: "api", contextMax: 400000 },
    { id: "qwen/qwen3-coder", label: "qwen3-coder", remote: true,
      endpointId: "api-opencode.ai-zen-go-v1", endpointLabel: "OpenCode GO", shortLabel: "GO",
      providerFamily: "opencode", providerFamilyLabel: "OpenCode",
      params: "api", contextMax: 256000 }
];

const MODELS = [
    { id: "qwen2.5-coder-1.5b-q4", label: "qwen2.5-coder-1.5b", remote: false,
      family: "qwen2.5-coder", params: "1.5B", quant: "Q4_K_M",
      installed: true, present: true, active: true, sizeBytes: 1.1e9,
      contextMax: 8192, current: true },
    { id: "glm-4-9b-0414-iq4xs", label: "glm-4-9b", remote: false,
      family: "glm-4", params: "9B", quant: "IQ4_XS",
      installed: true, present: true, sizeBytes: 5.3e9, contextMax: 16384 },
    /* The node's RESIDENT model: the box boots in deep mode, so the driver
     * endpoint serves gpt-oss-120b at its full 131k window. This is what the
     * picker reads to know which model is loaded and which mode is active. */
    { id: "unsloth/gpt-oss-120b-GGUF:F16", modelId: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b",
      remote: true, usable: true, present: true, localNode: true, isNode: true,
      endpointLabel: "spark", endpointId: "node-x", contextLength: 131072, contextMax: 131072,
      node: { id: "node-x", name: "spark", host: "100.64.0.1" } },
    /* THE FLEET ENDPOINT — same MACHINE, different endpoint + label. This row
     * existing is what exposes the hallucinated-fold defect the operator hit:
     * label-keyed grouping made it a second "machine" wearing a llama engine
     * (models + modes) that vLLM does not serve. It must land INSIDE the spark
     * fold as the agents card, and nothing else. */
    { id: "openai/gpt-oss-20b", modelId: "openai/gpt-oss-20b", label: "gpt-oss-20b",
      remote: true, usable: true, present: true, localNode: true, isNode: true,
      nodeRole: "fleet", endpointLabel: "spark · vLLM", endpointId: "node-x-8000",
      contextMax: 32768,
      node: { id: "node-x", name: "spark", host: "100.64.0.1" } },
    { id: "claude-opus-5", modelId: "anthropic/claude-opus-5", label: "claude-opus-5",
      remote: true, usable: true, present: true, hasKey: true,
      endpointLabel: "api.anthropic.com", endpointId: "api-x",
      rate: { in: 5, out: 25 }, contextMax: 200000 },
    { id: "a100-80gb", modelId: "a100-80gb", label: "A100 80GB", remote: true,
      usable: true, present: true, rented: true,
      provider: "Hourly Compute Co", endpointLabel: "gpu.example", endpointId: "gpu-x",
      rate: { in: 0, out: 0 } },

    /* CONTRACT K4 — the case the operator actually hit: the Spark was switched
     * off and its models were still listed as if they were choosable. Marked by
     * cloudModels now, and the picker has to act on the mark. */
    { id: "mistral-large:123b", modelId: "mistral-large:123b", label: "mistral-large 123B",
      remote: true, usable: true, present: true, localNode: true, isNode: true,
      endpointLabel: "spark", endpointId: "node-x",
      offline: true, offlineReason: "spark did not answer on 100.64.0.1:11434",
      sizeBytes: 100 * GB }
];

const SESSIONS = [
    // s1 is the session the harness OPENS at boot — and opening marks it read,
    // so it lands "acked" (that is the feature, not a fixture choice). s2:
    // finished in the background, never opened -> "done" (cyan, unread), and
    // its bell is muted. s3: never ran anything -> plain idle.
    { id: "s1", title: "Bench notes", updatedAt: Date.now() - 1000, messages: 4,
      notifyMuted: false, doneAt: Date.now() - 5000, readAt: Date.now() - 1000 },
    { id: "s2", title: "Fixer bath timing", updatedAt: Date.now() - 90000, messages: 12,
      notifyMuted: true, doneAt: Date.now() - 90000, readAt: 0 },
    { id: "s3", title: "A very long session title that will not fit in the row at all",
      updatedAt: Date.now() - 900000, messages: 2,
      notifyMuted: false, doneAt: 0, readAt: 0 }
];

/* CONTRACT K6 — the one knowledge API, as knowledge.js actually returns it:
 * one record per library, holding one record per SOURCE document. The built-in
 * corpus is the interesting case and the one the operator hit — an installed
 * build ships the INDEX and not the 907 MB of PDFs, so most of its documents
 * are searchable and absent at the same time, which is the state the old panel
 * flattened into "not on disk".
 *
 * Extracted text appears NOWHERE in this list, by construction. The one record
 * for it below is reachable only by asking openKnowledgeDoc for it by id, which
 * is how the refusal gets exercised. */
const KNOWLEDGE_LIBS = [
    {
        id: "builtin-knowledge", title: "Ships with .lcl",
        addedByUser: false, builtin: true, missing: false,
        sourceOnDisk: false, sourceUrl: null, root: "C:\\.lcl\\knowledge",
        docCount: 3, sourcesPresent: 1, sourcesMissing: 2, searchBackedDocs: 3,
        extractedTextFiles: 62,
        manifest: { file: "MANIFEST.md", present: true, urlsRecorded: 64 },
        docs: [
            { id: "builtin-knowledge::physics/DOE-HDBK-1010-Classical-Physics.pdf",
              libraryId: "builtin-knowledge", title: "DOE HDBK 1010 Classical Physics",
              file: "physics/DOE-HDBK-1010-Classical-Physics.pdf", ext: ".pdf",
              pages: 203, bytes: 1125657, sourceOnDisk: true,
              sourceUrl: "https://www.standards.doe.gov/DOE-HDBK-1010.pdf",
              sourceUrlKnown: true, searchBacked: true, subject: "physics" },
            { id: "builtin-knowledge::physics/CODATA-2022-paper-RevModPhys.pdf",
              libraryId: "builtin-knowledge", title: "CODATA 2022 paper RevModPhys",
              file: "physics/CODATA-2022-paper-RevModPhys.pdf", ext: ".pdf",
              pages: 71, bytes: 0, sourceOnDisk: false,
              sourceUrl: "https://physics.nist.gov/codata2022.pdf",
              sourceUrlKnown: true, searchBacked: true, subject: "physics" },
            { id: "builtin-knowledge::metrology/Uncertainty-Of-Measurement.pdf",
              libraryId: "builtin-knowledge", title: "Uncertainty Of Measurement",
              file: "metrology/Uncertainty-Of-Measurement.pdf", ext: ".pdf",
              pages: 118, bytes: 0, sourceOnDisk: false,
              sourceUrl: null, sourceUrlKnown: false, searchBacked: true,
              subject: "metrology" }
        ]
    },
    {
        id: "lib-darkroom", title: "Darkroom notes",
        addedByUser: true, builtin: false, missing: false,
        sourceOnDisk: true, sourceUrl: null, root: "D:\\reference\\darkroom",
        docCount: 2, sourcesPresent: 2, sourcesMissing: 0, searchBackedDocs: 2,
        chunks: 412, files: 2, extractedTextFiles: 0,
        docs: [
            { id: "lib-darkroom::fixer-bath-timing.md", libraryId: "lib-darkroom",
              title: "fixer bath timing", file: "fixer-bath-timing.md", ext: ".md",
              pages: null, bytes: 4210, sourceOnDisk: true, searchBacked: true,
              addedByUser: true },
            { id: "lib-darkroom::print-developer-dilution.pdf", libraryId: "lib-darkroom",
              title: "print developer dilution", file: "print-developer-dilution.pdf",
              ext: ".pdf", pages: 12, bytes: 220100, sourceOnDisk: true,
              searchBacked: true, addedByUser: true }
        ]
    }
];
const findKnowledgeDoc = (id) => {
    for (const l of KNOWLEDGE_LIBS) {
        const d = l.docs.find(x => x.id === id);
        if (d) return d;
    }
    return null;
};

const FIXTURES = {
    appInfo: () => ({ version: "1.0.0", name: ".lcl", packaged: false }),
    renderMode: () => ({ mode: "normal", motion: true }),
    // the real bridge always answers with a messages array — without this the
    // context panel's background repaints rejected with a TypeError in every
    // scene that never set its own snapshot, and nothing surfaced it until
    // the harness started judging window.__errors at the end of the run
    contextSnapshot: () => ({ ok: true, system: "", messages: [],
                              totalMessages: 0, window: 8192 }),
    modelIntel: () => require("../../.lcl.engine/core/modelIntel").catalog(),
    escalation: () => ({ ok: true, enabled: false }),
    // per-session AK settings — the stub carries a ground-rules value so the
    // scene can prove the editor renders the session's own text
    getSessionAkSettings: () => ({ ok: true, enabled: true, auditor: null,
        auditorLabel: null, rounds: 3,
        groundRules: "Treat unproven as not done.", hasWorkspace: true }),
    setSessionAkSettings: () => ({ ok: true, auditor: null, rounds: 3,
        groundRules: "", rulesFile: "ancient_knowledge.rules.md" }),
    engineStatus: () => ({ status: "ready", model: "qwen2.5-coder-1.5b",
                           kind: "local", loaded: true, loadState: null }),
    checkHealth: () => ({ status: "ok", kind: "local" }),
    /* THE PLAN WINDOW. Driven through the REAL usageWindow module against a
       row shaped exactly like the operator's: a genuine GO turn whose dollars
       are unknown because OpenCode publishes no per-token price. The fixture
       supplies the ROWS; the arithmetic under test is the shipped one. */
    /* PLAN or WORK, both through the REAL usageWindow arithmetic. The rows are
       shaped like the operator's: genuine turns whose dollars are unknown
       because OpenCode publishes no per-token price. */
    usageWindow: () => {
        const uw = require("../../.lcl.engine/core/usageWindow.js");
        const now = Date.now();
        if (window.__planMode === "work") {
            // 400k in + 100k out of 1M each -> (40% + 10%)/2 = 25%, a clear
            // token-based reading; pct mirrors what main.js computes.
            const work = { calls: 4, inputTokens: 400000, outputTokens: 100000,
                usd: 0, resetsInMs: 2 * 3600_000,
                resetsWords: uw.resetsWords(2 * 3600_000) };
            return { planless: true, work: { ...work, ...uw.workWindowPct(work) } };
        }
        if (window.__planMode === "empty") {
            return { planless: true, work: { calls: 0, inputTokens: 0,
                outputTokens: 0, usd: 0, resetsInMs: 5 * 3600_000,
                resetsWords: null } };
        }
        const rows = [
            { at: now - 3600_000, endpoint: "OpenCode GO", usd: 0,
              inputTokens: 12000, outputTokens: 800 },
            { at: now - 600_000, endpoint: "OpenCode GO", usd: 0,
              inputTokens: 9000, outputTokens: 400 }
        ];
        const d = uw.describeAll(rows, { tiers: uw.GO_TIERS });
        return { planName: "GO", endpointLabel: "OpenCode GO", shortLabel: "GO",
                 console: "https://opencode.ai/auth",
                 tightest: d.tightest || null,
                 tiers: (d.tiers || []).map(t => ({
                     ...t, resetsWords: t.active ? uw.resetsWords(t.resetsInMs) : null
                 })) };
    },
    listModels: () => ({ models: MODELS.concat(OPENCODE_ROWS) }),
    models: () => MODELS.concat(OPENCODE_ROWS),
    cloudState: () => ({ networkEnabled: true, endpoints: [
        { id: "node-x", label: "spark", localNode: true,
          node: { id: "node-x", name: "spark", host: "100.64.0.1", port: 11434,
                  memBytes: 130663002112 } },
        // DeepInfra, SELECTED — the operator state where Connect another lives.
        // Serves models so Manage Models and the Rates popup have rows to show.
        { id: "api-x", label: "api.deepinfra.com", selected: true, baseUrl: "api.deepinfra.com",
          hasKey: true, keyEncrypted: true,
          models: [{ id: "deepseek-ai/DeepSeek-V4-Pro" }, { id: "glm-5.2" }],
          allModels: [{ id: "deepseek-ai/DeepSeek-V4-Pro" }, { id: "glm-5.2" }] },
        { id: "gpu-x", label: "A100 80GB", rented: true, provider: "Hourly Compute Co",
          baseUrl: "gpu.example", models: [{ id: "llama-4-maverick" }] }
    ], behaviours: { cloudAutoApprove: false },
        // the real cloudState always carries config — the driver/reasoner
        // roles the escalation grid reads. Absent here, renderRemoteModelRow
        // threw on st.config.enabled the moment networkEnabled was true.
        config: { enabled: true, roles: {
            driver: { endpointId: "api-x", model: "deepseek-ai/DeepSeek-V4-Pro" } } } }),
    discoverCloudModels: () => ({ ok: true, models: MODELS.slice(0, 7).map(m => m.id), keyRejected: false }),
    connectCloud: () => ({ ok: true }),
    unlinkCloudEndpoint: () => ({ ok: true }),
    /* THE SHAPE THE CALLER ACTUALLY READS. This returned a bare array while
       every caller reads `r.nodes` — exactly the defect the listSessions note
       below records, in a second place. The stack installer therefore saw NO
       node, bailed with "link a node first", and the whole install path was
       untestable from the harness. */
    nodes: () => ({ ok: true, nodes: [
        { id: "node-x", name: "spark", host: "100.64.0.1",
          memBytes: 130663002112, freeBytes: 96000000000,
          // SERVING IS A LIST OF PORTS, which is what main.js returns —
          // a bare true meant paintNodes threw on (n.serving||[]).map and the
          // scene only worked when an earlier one had replaced the fixture
          reachable: true, pinned: true,
          serving: [{ port: 11434, label: "Ollama", via: null }] }
    ] }),
    // refreshSessions() reads res.sessions — returning the bare array meant the
    // list rendered empty, so the session row menu (and its readability, which
    // is one of the reported defects) could not be measured at all
    listSessions: () => ({ ok: true, sessions: SESSIONS }),
    sessions: () => SESSIONS,
    getSession: (id) => ({ id: id || "s1",
        title: (SESSIONS.find(s => s.id === id) || SESSIONS[0]).title,
        messages: [] }),
    sessionStatuses: () => ({ ok: true, statuses: {} }),
    // the real panel shape: session grants + the REAL engine catalog, so the
    // scene drives the same switch list production renders
    sessionPerms: () => {
        const sp = require("../../.lcl.engine/core/sessionPerms");
        return { ok: true, perms: sp.forSession({}), catalog: sp.CATALOG,
                 destination: null, isolation: { strong: false },
                 toolPolicy: {}, sandboxRoot: null,
                 // the leave-machine gate's state, as main.js now reports it
                 trustedEndpoints: [
                     { id: "api-api.deepinfra.com-v1-openai", label: "api.deepinfra.com" }
                 ],
                 cloudAutoApprove: false, consentNotify: true };
    },
    revokeTrustedEndpoint: () => ({ ok: true, trustedEndpoints: [] }),
    selectCloudModel: (spec) => ({ ok: true, config: { enabled: true, roles: {} },
                                   available: true, hasReasoner: false,
                                   roles: { driver: spec || null, reasoner: null } }),
    // onRemoteApprovalWithdrawn / onRemoteSendAllowed need no fixture: the
    // proxy registers any on*-shaped call as a listener, so __fire drives them
    setBehavior: () => ({ ok: true }),
    setSessionToolPolicy: () => ({ ok: true }),
    // the session bell + read stamp, mutating the fixture so a re-render
    // shows the new state exactly as the real store would
    setSessionNotify: (id, muted) => {
        const s = SESSIONS.find(x => x.id === id);
        if (s) s.notifyMuted = !!muted;
        return { id, notifyMuted: !!muted };
    },
    markSessionRead: (id) => {
        const s = SESSIONS.find(x => x.id === id);
        if (s) s.readAt = Date.now();
        return { id, readAt: Date.now() };
    },
    diag: () => ({ ok: true }),
    // the spark's llama.cpp modes, named + iconed as the app serves them, so the
    // node tier's engine fold renders in every scene (not only where injected)
    sparkModes: () => ({ ok: true, current: "deep", modes: {
        deep:     { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 131072, name: "Vast", icon: "bulb", blurb: "one conversation, the whole 131k window" },
        balanced: { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 65536,  name: "Balanced", icon: "scales", blurb: "two at a time, 65k each" },
        wide:     { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 32768,  name: "Swarm", icon: "bee", blurb: "four at a time, 32k each" },
        vast:     { model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", label: "Qwen3.6-35B", ctx: 262144, name: "Vast", icon: "bulb", blurb: "one conversation, a 262k window" },
        swarm:    { model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", label: "Qwen3.6-35B", ctx: 65536,  name: "Swarm", icon: "bee", blurb: "four light agents, 65k each" }
    }}),
    sparkMode: (_id, mode) => ({ ok: true, mode,
        model: /vast|swarm/.test(mode) ? "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL" : "unsloth/gpt-oss-120b-GGUF:F16",
        label: /vast|swarm/.test(mode) ? "Qwen3.6-35B" : "gpt-oss-120b",
        ctx: mode === "vast" ? 262144 : mode === "swarm" ? 65536 : mode === "deep" ? 131072 : mode === "balanced" ? 65536 : 32768,
        note: "model reloading on the node — allow one to five minutes" }),
    toolGroups: () => ({ ok: true, toolGroups: FIXTURES.capabilityMap().toolGroups }),
    setSessionPerm: (_id, key, value) => ({ ok: true,
        perms: { [key]: value } }),
    securityState: () => ({ networkEnabled: false, engagements: [] }),
    systemStats: () => ({ physTotalBytes: 34e9, availableBytes: 12e9, cores: 22,
                          mem: { totalBytes: 34e9, availableBytes: 12e9 } }),
    settings: () => ({ tone: "plain", networkEnabled: false }),
    capabilities: () => ({}),
    listLibraries: () => ({ libraries: [
        { id: "lib-darkroom", name: "Darkroom notes", root: "D:\\reference\\darkroom",
          files: 2, chunks: 412, builtin: false }
    ] }),
    listKnowledge: () => ([]),

    /* ---- CONTRACT K6 ---------------------------------------------------- */
    // the Download-all flow calls this once per missing-with-URL document;
    // answering ok lets the scene assert the loop's selection and its tally
    // resolves after a beat, so the scene can prove a run SURVIVES the panel
    // being closed mid-flight (the defect: close killed the batch)
    fetchKnowledgeSource: (id) => new Promise(res =>
        setTimeout(() => res({ ok: true, path: "C:\mirror\\" + String(id) }), 120)),
    knowledgeLibraries: () => (window.__harness && window.__harness.k6 === false
        ? { error: "not in this build" }        /* forces the legacy path */
        : KNOWLEDGE_LIBS),
    // the boot-time badge count: cheap in the real main (shelf + ~64 stats),
    // fixed here to match KNOWLEDGE_LIBS — 2 missing, only 1 with a URL
    knowledgeMissingCount: () => ({ missing: 2, fetchable: 1 }),
    /* The legacy pair, so the harness can drive the path a build without K6
     * takes. Shapes copied from main.js: the shelf names each built-in doc's
     * `source` (the PDF) beside its `file` (the extraction), and the extraction
     * is the one thing that must never reach the list. */
    knowledgeShelf: () => ({
        layers: { builtin: 3, added: 2 },
        subjects: [
            { name: "physics", layer: "builtin", docs: [
                { file: "text/physics/DOE-HDBK-1010-Classical-Physics.txt",
                  source: "physics/DOE-HDBK-1010-Classical-Physics.pdf",
                  title: "DOE HDBK 1010 Classical Physics", pages: 203, bytes: 512000 },
                { file: "text/physics/CODATA-2022-paper-RevModPhys.txt",
                  source: "physics/CODATA-2022-paper-RevModPhys.pdf",
                  title: "CODATA 2022 paper RevModPhys", pages: 71, bytes: 348331 }
            ] },
            { name: "metrology", layer: "builtin", docs: [
                { file: "text/metrology/Uncertainty-Of-Measurement.txt",
                  source: "metrology/Uncertainty-Of-Measurement.pdf",
                  title: "Uncertainty Of Measurement", pages: 118, bytes: 210000 }
            ] },
            { name: "Darkroom notes", layer: "added", libraryId: "lib-darkroom", docs: [
                { file: "fixer-bath-timing.md", title: "fixer bath timing", bytes: 4210 },
                { file: "print-developer-dilution.pdf",
                  title: "print developer dilution", bytes: 220100 }
            ] }
        ]
    }),

    openKnowledgeDoc: (id) => {
        /* isExtractedTextPath, in the shape the id carries it: the extraction
         * tree is `text/` at the root of the built-in corpus, so both the
         * "<lib>::text/..." and ".../text/..." forms are the same refusal. */
        if (/(^|::|\/)text\//.test(String(id))) {
            return { ok: false, id, title: "extraction", extracted: true,
                     error: "that is extracted text, not a document — it backs " +
                            "search and citation only" };
        }
        const d = findKnowledgeDoc(id);
        if (!d) return { ok: false, error: "unknown document", id };
        if (d.sourceOnDisk) {
            return { ok: true, id: d.id, libraryId: d.libraryId, title: d.title,
                     file: d.file, path: "C:\\.lcl\\knowledge\\" + d.file,
                     ext: d.ext, mime: "application/pdf", bytes: d.bytes,
                     pages: d.pages, kind: d.ext === ".pdf" ? "pdf" : "text",
                     name: d.file,
                     fileUrl: "about:blank",
                     content: d.ext === ".pdf" ? undefined : "# fixer bath timing\n\nfive minutes." };
        }
        return {
            ok: false, needsFetch: true, id: d.id, libraryId: d.libraryId,
            title: d.title, file: d.file, sourceUrl: d.sourceUrl,
            reason: d.sourceUrl
                ? "the source document is not installed — it can be downloaded"
                : "the source document is not installed, and MANIFEST.md records " +
                  "no URL for it, so it cannot be downloaded either",
            networkEnabled: false, searchBacked: d.searchBacked, pages: d.pages
        };
    },
    /* the legacy viewer call, still the one a build without K6 uses */
    viewKnowledgeFile: (libId, rel) => (/\.pdf$/i.test(String(rel))
        ? { kind: "pdf", name: rel, fileUrl: "about:blank" }
        : { kind: "text", name: rel, ext: ".md",
            content: "# " + rel + "\n\nfive minutes in the fixer." }),

    /* "What .lcl can do" — the panel the prompt's pointer button opens. Small
     * but complete: the renderer walks every one of these fields, and a missing
     * one throws inside a click handler where nothing would report it. */
    capabilityMap: () => ({
        machine: { cores: 22, totalBytes: 34e9, availableBytes: 12e9 },
        summary: { loadableNow: 2, languageModels: 3 },
        features: { networkEnabled: false, semanticSearch: true, reranker: false,
                    ocr: true, libraries: 2 },
        requirements: { rows: [
            { label: "RAM", min: 8e9, ok: 16e9, all: 64e9, bytes: true },
            { label: "Disk", min: 20e9, ok: 60e9, all: 300e9, bytes: true }
        ], formula: "model size x 1.1 plus context",
           sharedMemoryNote: "Integrated graphics share this RAM." },
        behaviors: { writeMode: "notify", groundingEnabled: true },
        models: [
            { id: "qwen2.5-coder-1.5b", installed: true, isLLM: true, fitsNow: true,
              roles: ["driver"], traits: [{ label: "code" }], sizeBytes: 1.1e9,
              needBytes: 2.2e9, contextNow: 8192, band: [], notes: "" }
        ],
        toolGroups: [
            { label: "Network", tools: [
                { name: "http_fetch", available: true, level: "confirm",
                  defaultLevel: "confirm", floor: "confirm", tone: "ask",
                  options: [{ value: "confirm", label: "ask first" },
                            { value: "deny", label: "never" }] },
                { name: "web_search", available: true, level: "confirm",
                  defaultLevel: "confirm", floor: null, tone: "ask",
                  options: [{ value: "allow", label: "run without asking" },
                            { value: "confirm", label: "ask first" },
                            { value: "deny", label: "never" }] }
            ] },
            { label: "Files", tools: [
                { name: "delete_file", available: true, level: "confirm",
                  defaultLevel: "confirm", floor: "confirm", tone: "ask",
                  options: [{ value: "confirm", label: "ask first" },
                            { value: "deny", label: "never" }] }
            ] }
        ]
    }),
    workspace: () => ({ path: null, linked: false }),
    // THE REAL SHAPE: { repoPath, entries, truncated, total }. This returned a
    // bare array, so res.entries was undefined and the explorer rendered EMPTY
    // in every scene — the panel could never have been caught not painting.
    listFiles: () => ({ repoPath: "D:\work\repo", truncated: false, total: 6,
        entries: ["ancient_knowledge.md (812 bytes)",
                  "README.md (1200 bytes)",
                  "src/index.js (3400 bytes)",
                  "src/util/parse.js (900 bytes)",
                  "src/util/format.js (450 bytes)",
                  "docs/codex/vendor/highlight.min.js (98000 bytes)"] }),
    onModelInstallProgress: (fn) => {
        window.__stackProgress = window.__stackProgress || [];
        window.__stackProgress.push(fn);
    },
    /* THE STACK INSTALL PATH, END TO END. The real one runs shell over ssh;
       this returns the same shapes so the SCENE can drive the whole flow —
       preview, confirm, run, streamed lines, wired endpoint — without a node. */
    stacks: () => {
        const S = require("../../.lcl.engine/core/nodeStacks.js");
        return { ok: true, stacks: S.STACKS.map(x => ({
            key: x.key, name: x.name, why: x.why, playbook: x.playbook,
            serves: x.serves || null, needs: x.needs || null,
            after: x.after || null, rollback: x.rollback || null,
            manual: x.manual || null, installable: S.installable(x.key)
        })) };
    },
    /* the record the renderer POLLS, advancing on each call so the scene can
       watch it move the way a real install does */
    stackProgress: () => {
        window.__pn = (window.__pn || 0) + 1;
        const n = window.__pn;
        /* THE STEP LIST, EVOLVING — the shape main.js actually returns.
         *
         * The old fixture answered with a step NAME and nothing else, so the
         * wizard's rows had no state to paint and the scene watched a panel
         * that never lit up while reporting that everything passed. A fixture
         * thinner than the contract tests the contract it invented.
         *
         * The names match nodeStacks' ollama recipe, because the rows are built
         * from the recipe and matched to progress by position. */
        const SAY = ["checking this login can install software on the node",
                     "installing ollama if it is not already there",
                     "checking it answers"];
        const mk = (states, pct, note, line) => SAY.map((say, i) => ({
            say, state: states[i],
            pct: states[i] === "running" ? (pct ?? null) : null,
            note: states[i] === "running" ? (note ?? null) : null,
            line: states[i] === "running" ? (line ?? null) : null,
            ms: states[i] === "waiting" ? null : (i + 1) * 4000
        }));
        if (n < 3) return { ok: true, running: true, run: {
            step: SAY[0], stepNo: 1, totalSteps: 3, road: "tailnet",
            steps: mk(["running", "waiting", "waiting"]),
            elapsedMs: n * 1000, lines: [], done: false } };
        // ...mid-download, which is the state the operator was blind in
        if (n < 5) return { ok: true, running: true, run: {
            step: SAY[1], stepNo: 2, totalSteps: 3, road: "tailnet",
            steps: mk(["done", "running", "waiting"], 45,
                      "30 MB/s · 1m30s left", "#### 45.2%"),
            elapsedMs: n * 1000, lines: ["curl: downloading"], done: false } };
        return { ok: true, running: false, run: {
            step: "finished — and it proved itself working", stepNo: 3,
            totalSteps: 3, road: "tailnet",
            steps: mk(["done", "done", "done"]),
            elapsedMs: 62000, lines: ["LCL-OLLAMA-UP"],
            done: true, ok: true } };
    },
    stackPreview: (key) => {
        const S = require("../../.lcl.engine/core/nodeStacks.js");
        return S.installable(key)
            ? { ok: true, steps: S.preview(key) }
            : { error: "that one is not installed by .lcl" };
    },
    stackInstall: async (spec) => {
        const send = (p) => {
            window.__seenLines = window.__seenLines || [];
            window.__seenLines.push(p.phase + ':' + (p.line||''));
            for (const fn of (window.__stackProgress || []))
                try { fn({ nodeId: spec.nodeId, ...p }); } catch { }
        };
        send({ phase: "starting" });
        send({ phase: "line", line: "LCL-STEP checking ollama is installed" });
        await new Promise(r => setTimeout(r, 60));
        send({ phase: "line", line: "LCL-STEP checking it answers" });
        // long enough for the scene to read the panel MID-RUN, which is the
        // state the operator was blind in
        // LONG ENOUGH FOR THE POLL TO ADVANCE. A stub that resolves instantly
        // lets the result overwrite the readout before it has shown a step,
        // which measures the wrong thing: real installs take minutes.
        await new Promise(r => setTimeout(r, 8000));
        send({ phase: "line", line: "LCL-OLLAMA-UP" });
        send({ phase: "done", ok: true });
        return { ok: true, after: "Registered as an endpoint on this node.",
                 wired: { baseUrl: "http://spark.local:11434/v1", models: 3 },
                 tail: ["LCL-OLLAMA-UP"] };
    },
    localModels: () => ({ ok: true, dir: "C:/Users/you/AppData/Roaming/.lcl/data/models",
        inUse: "qwen2.5-coder-1.5b-q4.gguf", models: [
        { file: "qwen2.5-coder-1.5b-q4.gguf", bytes: 1_100_000_000, mtime: 0 },
        { file: "llama-3.3-70b-q4.gguf", bytes: 42_500_000_000, mtime: 0 } ] }),
    localModelRemove: () => ({ ok: true }),
    inspectDevices: () => ({ ok: true, devices: [], notRead: "", scanError: null }),
    costToday: () => ({ spendUsd: 0, calls: 0 }),

    /* CONTRACT K5 — the terminal bridge, as preload.js exposes it. The stub
     * hands back an id and records the writes; nothing here spawns anything,
     * and the harness never touches a real shell. */
    terminalStart: () => ({ ok: true, id: "t1", shell: "cmd.exe",
        unsandboxed: true,
        notice: "This is your own shell. Commands run as you, with no sandbox and " +
                "no approval step." }),
    terminalWrite: () => ({ ok: true }),
    terminalResize: () => ({ ok: true }),
    terminalKill: () => ({ ok: true }),
    terminalList: () => ({ ok: true, shells: [] }),

    planModel: () => ({ plan: { fits: true, accelerator: "gpu", ctxSize: 8192 } }),
    estimateCost: () => ({ remote: false }),
    costForSession: () => ({ usd: 0, calls: 0, inputTokens: 0, outputTokens: 0 }),
    voiceLines: () => ({ ok: true, lines: {} })
};

/* Event subscriptions: keep the callback so a scene can fire it on demand. */
const LISTENERS = {};

/* Every call is recorded, so a test can assert what the UI actually asked for
 * rather than inferring it from what changed on screen. */
const CALLS = [];

function defaultReturn() {
    // permissive enough to survive the destructuring app.js does on results it
    // does not check, without pretending to be any particular engine answer
    return { ok: true, models: [], sessions: [], items: [], list: [], entries: [],
             devices: [], files: [], text: "", error: null };
}

const lcl = new Proxy({}, {
    get(_t, key) {
        if (typeof key !== "string") return undefined;
        if (key === "__calls") return CALLS;
        if (key === "__fire") {
            return (name, ...args) => (LISTENERS[name] || []).forEach(cb => cb(...args));
        }
        return (...args) => {
            CALLS.push({ key, args: args.filter(a => typeof a !== "function") });
            if (/^on[A-Z]/.test(key)) {           // an event subscription
                const cb = args.find(a => typeof a === "function");
                if (cb) (LISTENERS[key] = LISTENERS[key] || []).push(cb);
                return () => {};
            }
            const f = FIXTURES[key];
            const v = f ? f(...args) : defaultReturn();
            return Promise.resolve(v);
        };
    },
    has() { return true; }
});

window.lcl = lcl;
window.__harness = { CALLS, LISTENERS, FIXTURES, MODELS, SESSIONS };

/* Surface renderer exceptions to the harness process. A thrown error inside a
 * click handler is invisible from executeJavaScript, and invisible is exactly
 * how the picker defect survived. */
window.__errors = [];
window.addEventListener("error", (e) => {
    window.__errors.push(String((e.error && e.error.stack) || e.message));
});
window.addEventListener("unhandledrejection", (e) => {
    window.__errors.push("unhandled rejection: " + String((e.reason && e.reason.stack) || e.reason));
});
void ipcRenderer;
