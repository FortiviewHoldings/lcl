const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const loadPlanner = require("./loadPlanner");

/**
 * THE CAPABILITY MAP — one computation, three surfaces.
 *
 * What this app can do is a question with a real answer: which models are on
 * this disk, how much memory each actually needs, which tools exist and which
 * of them can act without asking. That answer is derived here, once, from the
 * registry and the policy classification table, and consumed by the in-app
 * panel, the About box and the README generator. A hand-maintained copy in any
 * of those three would be wrong within a week.
 *
 * The memory arithmetic deliberately mirrors app/core/loadPlanner.js. A
 * published "needs 9 GB" that disagrees with the planner's refusal is worse
 * than publishing nothing, so tests/capability-map.js holds them together.
 */

// Published memory numbers must be computed with the SAME arithmetic the load
// planner actually enforces, or the README says "needs 9 GB" while the gate
// refuses at a different figure. These are the planner's OWN constants, delegated
// rather than copied — the previous copy (2.2 GB floor, x1.1 peak) had silently
// drifted from the planner's recalibration (1.4 GB CPU floor, x1.0 resident) and
// was overstating the required free memory on every model.
const OS_FLOOR_BYTES = loadPlanner.OS_FLOOR_CPU_BYTES;   // the CPU rung's floor (1.4 GB)
const CPU_LOAD_PEAK = loadPlanner.CPU_RESIDENT_FACTOR;   // 1.0 — CPU weights are resident once
const KV_QUANT_FACTOR = 0.5;      // q8_0 KV cache halves the fp16 figure (matches the planner)
const GB = 1e9;
const CTX_TIERS = [32768, 16384, 8192, 4096, 2048];
// Free-memory levels the panel reports a model's context against. Chosen to
// straddle the range a 16 GB machine actually sees in daily use, so the answer
// to "should I close something?" is visible rather than guessed at.
const BAND_GB = [4, 6, 8, 10, 12];

function needFor(model, ctx) {
    const weights = (model.sizeBytes || 0) + (model.mmprojBytes || 0);
    // the CPU rung (offloadFraction 0) — the cheapest way any model can run,
    // which is what a "minimum RAM" figure should mean. Delegated to the planner's
    // own estimate so this surface, the panel, and the capability-map generator
    // never disagree about what a number means.
    const est = loadPlanner.estimate(weights, model.kvBytesPerToken || 0, ctx, 0);
    return est.peakBytes + OS_FLOOR_BYTES;
}

/** Largest context this model can hold with `availBytes` free. */
function bestContext(model, availBytes) {
    if (!model.kvBytesPerToken) return null;
    for (const ctx of CTX_TIERS) {
        if (ctx > (model.contextMax || 4096)) continue;
        if (needFor(model, ctx) <= availBytes) return ctx;
    }
    return null;
}

/** "9B" -> 9, "33M" -> 0.033, so a small encoder never outranks a 9B model. */
function paramCount(p) {
    const m = String(p || "").match(/([\d.]+)\s*([BM])?/i);
    if (!m) return 0;
    const n = parseFloat(m[1]) || 0;
    return (m[2] || "B").toUpperCase() === "M" ? n / 1000 : n;
}

function modelDirs() {
    const dirs = [];
    try { dirs.push(paths.bundledModelsDir()); } catch { /* not resolvable */ }
    try { dirs.push(paths.modelsDir()); } catch { /* not resolvable */ }
    return dirs;
}

function isInstalled(model, dirs) {
    if (!model.file) return false;
    return dirs.some(d => {
        try { return fs.existsSync(path.join(d, model.file)); } catch { return false; }
    });
}

const TRAIT_LABEL = {
    reasoning: "reasoning", code: "code", chat: "chat", vision: "vision",
    imageGen: "images", embedding: "embedding", reranking: "reranking",
    toolCalling: "tools", longContext: "long context", speed: "speed"
};

/**
 * The models table. `availBytes` is the memory to judge fit against — pass the
 * machine's real availability so the panel says what will load RIGHT NOW, not
 * what would load on an empty machine.
 */
function models(availBytes) {
    const registry = paths.modelRegistry();
    const roles = registry.roles || {};
    const dirs = modelDirs();
    const rolesOf = (id) => Object.entries(roles).filter(([, v]) => v === id).map(([k]) => k);

    return (registry.models || [])
        .map(m => {
            const installed = isInstalled(m, dirs);
            const isLLM = !!m.kvBytesPerToken;
            const ctxNow = isLLM ? bestContext(m, availBytes) : null;
            const need = isLLM ? needFor(m, 8192)
                               : (m.sizeBytes || 0) * CPU_LOAD_PEAK + OS_FLOOR_BYTES;
            return {
                id: m.id,
                family: m.family,
                params: m.params,
                quant: m.quant,
                license: m.license,
                sizeBytes: (m.sizeBytes || 0) + (m.mmprojBytes || 0),
                roles: rolesOf(m.id),
                kind: m.role || (m.vision ? "vision" : "chat"),
                traits: Object.entries(m.traits || {})
                    .filter(([, v]) => v >= 4)
                    .map(([k, v]) => ({ key: k, label: TRAIT_LABEL[k] || k, value: v })),
                installed,
                isLLM,
                // what it needs at a useful context, and what it can do right now
                needBytes: need,
                contextNow: ctxNow,
                contextMax: m.contextMax || null,
                fitsNow: isLLM ? ctxNow !== null : need <= availBytes,
                // How much MORE memory would be needed to run it. "needs 8.9 GB"
                // is a fact; "close 0.4 GB of something" is an instruction, and
                // the second is what a user can act on.
                shortfallBytes: Math.max(0, need - availBytes),
                // What this model would give at other memory levels. Answers
                // "is it worth freeing memory, and how much?" — which a single
                // fits/does-not-fit verdict cannot.
                band: isLLM ? BAND_GB.map(gb => ({
                    freeGB: gb, context: bestContext(m, gb * GB)
                })) : null,
                notes: m.notes || ""
            };
        })
        .sort((a, b) => {
            // installed first, then by capability
            if (a.installed !== b.installed) return a.installed ? -1 : 1;
            return paramCount(b.params) - paramCount(a.params);
        });
}

const CLASS_BEHAVIOUR = {
    read: { label: "runs automatically", tone: "auto" },
    mutate: { label: "runs, then shows the change (revertable)", tone: "auto" },
    destructive: { label: "asks first", tone: "ask" },
    execute: { label: "asks first", tone: "ask" },
    egress: { label: "asks first — network is off by default", tone: "ask" },
    offensive: { label: "asks first — authorized engagement only", tone: "ask" }
};

const CAP_LABEL = {
    "fs.read": "Reading your workspace",
    "fs.write": "Changing files",
    "sys.read": "System & utility",
    "sys.write": "System write",
    "sys.execute": "Running commands",
    "device.write": "Connected hardware",
    "vcs.git": "GitHub & version control",
    "media.read": "Media inspection",
    "media.write": "Media conversion",
    "sec.defensive": "Defensive security",
    "net.read": "Network",
    "sec.offensive": "Offensive security"
};
const CAP_ORDER = ["fs.read", "fs.write", "sys.read", "sys.write", "sys.execute",
                   "device.write", "vcs.git", "media.read", "media.write", "sec.defensive",
                   "net.read", "sec.offensive"];

// what each level MEANS, in the user's terms — shown on the selectors
const LEVEL_LABEL = {
    allow: "runs automatically",
    notify: "runs, shows the change",
    confirm: "asks first",
    deny: "never runs"
};
const LEVEL_ORDER = ["allow", "notify", "confirm", "deny"];

/** Tools grouped by capability, each with what it does WITHOUT asking. */
function tools(availableNames) {
    let TOOL_CLASS, PolicyKernel;
    try {
        ({ TOOL_CLASS } = require("../policy/classify.js"));
        ({ PolicyKernel } = require("../policy/kernel.js"));
    } catch { return []; }

    const overrides = (paths.readSettings().toolPolicy) || {};
    const writeMode = paths.readSettings().writeMode === "confirm" ? "confirm" : "notify";

    // the decision the kernel would take with no override — mirrors decide()
    const defaultFor = (c) => {
        switch (c) {
            case "read": return "allow";
            case "mutate": return writeMode;
            default: return "confirm";
        }
    };

    const live = availableNames ? new Set(availableNames) : null;
    const groups = new Map();
    for (const [name, spec] of Object.entries(TOOL_CLASS)) {
        const cap = spec.capability || "other";
        if (!groups.has(cap)) groups.set(cap, []);
        const floor = PolicyKernel.floorFor(spec.classification);
        const def = defaultFor(spec.classification);
        const effective = overrides[name]
            ? PolicyKernel.clampToFloor(overrides[name], floor) || def
            : def;
        groups.get(cap).push({
            name,
            classification: spec.classification,
            behaviour: LEVEL_LABEL[effective] || effective,
            tone: (effective === "allow" || effective === "notify") ? "auto"
                : effective === "deny" ? "deny" : "ask",
            perTurn: spec.limitPerTurn || null,
            available: live ? live.has(name) : true,
            // the permission dial
            level: effective,
            defaultLevel: def,
            overridden: !!overrides[name],
            floor,
            // which levels this tool may be SET to (at or above its floor)
            options: LEVEL_ORDER.filter(l =>
                PolicyKernel.clampToFloor(l, floor) === l)
                .map(l => ({ value: l, label: LEVEL_LABEL[l] }))
        });
    }
    const ordered = CAP_ORDER.filter(c => groups.has(c))
        .concat([...groups.keys()].filter(c => !CAP_ORDER.includes(c)));
    return ordered.map(cap => ({
        capability: cap,
        label: CAP_LABEL[cap] || cap,
        tools: groups.get(cap).sort((a, b) => a.name.localeCompare(b.name))
    }));
}

/**
 * System requirements, DERIVED from what is actually in the registry rather
 * than written down once and left to rot. The "minimum" row is the smallest
 * language model's real requirement; "to run everything" is the largest one's.
 * If a bigger model is added tomorrow, this table says so by itself.
 */
function requirements() {
    const registry = paths.modelRegistry();
    const llms = (registry.models || []).filter(m => m.kvBytesPerToken);
    if (!llms.length) return null;
    const bySize = llms.slice().sort((a, b) => a.sizeBytes - b.sizeBytes);
    const smallest = bySize[0];
    const biggest = bySize[bySize.length - 1];
    // a mid-tier model is what most people should actually aim at
    const mid = bySize[Math.floor(bySize.length / 2)];

    return {
        rows: [
            { label: "RAM in the machine", min: "8 GB", ok: "16 GB", all: "32 GB" },
            { label: "Free when you launch",
              min: needFor(smallest, 4096), ok: needFor(mid, 8192), all: needFor(biggest, 8192),
              bytes: true },
            { label: "Disk for models", min: 6e9, ok: 25e9, all: 60e9, bytes: true },
            { label: "CPU", min: "any x64", ok: "8 cores", all: "16+ cores" },
            { label: "GPU", min: "not required", ok: "optional", all: "optional" },
            { label: "Network", min: "never required", ok: "never required", all: "never required" },
            { label: "Largest model", min: smallest.id, ok: mid.id, all: biggest.id }
        ],
        osFloorBytes: OS_FLOOR_BYTES,
        loadPeak: CPU_LOAD_PEAK,
        // the reasoning, so the numbers are checkable rather than trusted
        formula: `weights at the CPU load peak (x${CPU_LOAD_PEAK}) + KV cache at q8 + ` +
                 `compute buffers + ${(OS_FLOOR_BYTES / GB).toFixed(1)} GB kept for the ` +
                 `operating system (offloading to an integrated GPU needs more, not less)`,
        sharedMemoryNote:
            "On integrated graphics, GPU memory is the same physical RAM, so offloading " +
            "copies the weights twice and needs more, not less. These models run on CPU here."
    };
}

/** Everything the panel needs, in one call. */
function snapshot({ availBytes, totalBytes, cores, toolNames, extras = {} } = {}) {
    const avail = availBytes || 0;
    const list = models(avail);
    const installed = list.filter(m => m.installed);
    return {
        machine: {
            cores: cores || 0,
            totalBytes: totalBytes || 0,
            availableBytes: avail,
            osFloorBytes: OS_FLOOR_BYTES
        },
        models: list,
        summary: {
            installed: installed.length,
            known: list.length,
            languageModels: installed.filter(m => m.isLLM).length,
            loadableNow: installed.filter(m => m.isLLM && m.fitsNow).length,
            biggestNow: (installed.filter(m => m.isLLM && m.fitsNow)
                .sort((a, b) => paramCount(b.params) - paramCount(a.params))[0] || {}).id || null
        },
        toolGroups: tools(toolNames),
        behaviors: (() => {
            const st = paths.readSettings();
            return {
                writeMode: st.writeMode === "confirm" ? "confirm" : "notify",
                groundingEnabled: st.groundingEnabled !== false,
                networkEnabled: st.networkEnabled === true
            };
        })(),
        requirements: requirements(),
        // features the app knows about itself (vision/ocr/etc), supplied by main
        features: extras
    };
}

module.exports = {
    snapshot, models, tools, requirements, needFor, bestContext, paramCount,
    OS_FLOOR_BYTES, CPU_LOAD_PEAK, KV_QUANT_FACTOR,
    CAP_LABEL, CAP_ORDER   // permission group labels — the approval dialog names the exact group
};
