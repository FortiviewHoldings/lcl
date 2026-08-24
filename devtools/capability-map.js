#!/usr/bin/env node
/**
 * Generate the CAPABILITY MAP from the real sources of truth.
 *
 * Hand-written capability tables rot the moment a model or tool is added. This
 * reads engine/models/registry.json (the models) and the policy classification
 * table (the tools, with their real capability + confirmation class), computes
 * each model's actual memory requirement with the SAME arithmetic the load
 * planner uses, and emits Markdown.
 *
 *   node devtools/capability-map.js            -> print to stdout
 *   node devtools/capability-map.js --write    -> update README.md between markers
 *   node devtools/capability-map.js --json     -> machine-readable (for the About box)
 *
 * The README block lives between <!-- CAPABILITY-MAP:START --> and :END so a
 * regeneration never disturbs the prose around it.
 */
const fs = require("fs");
const path = require("path");

// capabilities.js reaches electron through paths.js; this script is plain node,
// so give it the two fields paths.js actually uses.
const Module = require("module");
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return _resolve.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => require("os").tmpdir() }
} };

const ROOT = path.join(__dirname, "..");
const registry = JSON.parse(fs.readFileSync(
    path.join(ROOT, "models", "registry.json"), "utf8").replace(/^﻿/, ""));
const capabilities = require(path.join(__dirname, "..", ".lcl.engine", "core", "capabilities.js"));
const { TOOL_CLASS, CLASSIFICATION } =
    require(path.join(ROOT, ".lcl.engine", "policy", "classify.js"));

// ---- memory arithmetic: DELEGATED to the load planner ---------------------
//
// This used to be a hand-written copy of the planner's formula, "kept
// deliberately explicit so the published numbers can be checked by hand". Two
// copies of one calculation is two things that can disagree, and they did: when
// the planner was recalibrated against live measurements, this file went on
// publishing RAM requirements from the old, 2-3x inflated constants — the exact
// same failure as the chunk-size constant that storage silently disagreed with.
// A published figure derived from different arithmetic than the gate that
// enforces it is worse than no figure.
const loadPlanner = require(path.join(ROOT, ".lcl.engine", "core", "loadPlanner.js"));
// The published "RAM to run" figure is the CPU rung, so it must use the CPU
// floor. loadPlanner.OS_FLOOR_BYTES is the GPU one (the strict, freeze-avoiding
// number) and using it here overstated every model by 0.8 GB — the same
// two-copies-of-one-constant drift this file was already rewritten once to kill.
const OS_FLOOR_BYTES = loadPlanner.OS_FLOOR_CPU_BYTES || loadPlanner.OS_FLOOR_BYTES;
const GB = 1e9;

function needFor(model, ctx) {
    const weights = model.sizeBytes + (model.mmprojBytes || 0);
    // CPU rung (offloadFraction 0) — the cheapest way any model can run, which
    // is what a "minimum RAM" figure should mean.
    const est = loadPlanner.estimate(weights, model.kvBytesPerToken || 0, ctx, 0);
    return { weights, kv: est.kvBytes, peak: est.peakBytes,
             total: est.peakBytes + OS_FLOOR_BYTES };
}

/** Largest context this model can hold on a machine with `availGB` available. */
function bestContext(model, availGB) {
    const tiers = [32768, 16384, 8192, 4096, 2048];
    for (const ctx of tiers) {
        if (ctx > (model.contextMax || 4096)) continue;
        if (needFor(model, ctx).total <= availGB * GB) return ctx;
    }
    return null;
}

const fmtGB = (b) => (b < 0.1 * GB ? Math.round(b / 1e6) + " MB" : (b / GB).toFixed(1) + " GB");

/** "9B" -> 9, "33M" -> 0.033, so a 33M embedder never outranks a 9B model. */
function paramCount(p) {
    const m = String(p || "").match(/([\d.]+)\s*([BM])?/i);
    if (!m) return 0;
    const n = parseFloat(m[1]) || 0;
    return (m[2] || "B").toUpperCase() === "M" ? n / 1000 : n;
}
const ROLE_OF = (id) => Object.entries(registry.roles || {})
    .filter(([, v]) => v === id).map(([k]) => k);

function traitStars(t = {}) {
    const keys = [["reasoning", "reason"], ["code", "code"], ["chat", "chat"],
                  ["vision", "vision"], ["imageGen", "image"], ["embedding", "embed"],
                  ["reranking", "rerank"]];
    return keys.filter(([k]) => t[k]).map(([k, label]) => `${label} ${t[k]}/5`).join(", ");
}

function modelsTable() {
    const rows = registry.models.slice()
        .sort((a, b) => paramCount(b.params) - paramCount(a.params));
    let out = "| Model | Size | Role | Good at | RAM to run | Max context here |\n";
    out += "|---|---|---|---|---|---|\n";
    for (const m of rows) {
        const roles = ROLE_OF(m.id);
        const ctx8 = bestContext(m, 8.0);
        const ctx16 = bestContext(m, 16.0);
        // an image/embedding model has no KV cache story; report simply
        const isLLM = !!m.kvBytesPerToken;
        const need = isLLM
            ? fmtGB(needFor(m, ctx16 || 4096).total)
            // no KV cache: an embedder/image model is just its weights
            : fmtGB(m.sizeBytes * loadPlanner.CPU_RESIDENT_FACTOR + OS_FLOOR_BYTES);
        out += `| \`${m.id}\` | ${fmtGB(m.sizeBytes + (m.mmprojBytes || 0))} | `
            + `${roles.length ? roles.join(", ") : "—"} | ${traitStars(m.traits) || "—"} | `
            + `${need} | ${isLLM ? (ctx8 ? ctx8.toLocaleString() + " @8GB free" : "does not fit 8GB")
                                 : "n/a"} |\n`;
    }
    return out;
}

const CLASS_NOTE = {
    [CLASSIFICATION.READ]: "runs automatically",
    [CLASSIFICATION.MUTATE]: "runs, then shows you the change (revertable)",
    [CLASSIFICATION.DESTRUCTIVE]: "**asks first**",
    [CLASSIFICATION.EXECUTE]: "**asks first**",
    [CLASSIFICATION.EGRESS]: "**asks first** (and network is off by default)",
    [CLASSIFICATION.OFFENSIVE]: "**asks first**, and only against an authorized engagement"
};

function toolsTable() {
    const groups = {};
    for (const [name, spec] of Object.entries(TOOL_CLASS)) {
        (groups[spec.capability] ||= []).push([name, spec]);
    }
    const order = ["fs.read", "fs.write", "sys.read", "sys.write", "sys.execute",
                   "device.write", "vcs.git", "media.read", "media.write", "sec.defensive",
                   "net.read", "sec.offensive"];
    const label = {
        "fs.read": "Reading your workspace", "fs.write": "Changing files",
        "sys.read": "System & utility", "sys.write": "System write",
        "sys.execute": "Running commands", "device.write": "Connected hardware",
        "vcs.git": "GitHub & version control", "media.read": "Media inspection",
        "media.write": "Media conversion", "sec.defensive": "Defensive security",
        "net.read": "Network", "sec.offensive": "Offensive security (authorized only)"
    };
    let out = "";
    const seen = new Set();
    for (const cap of order.concat(Object.keys(groups))) {
        if (seen.has(cap) || !groups[cap]) continue;
        seen.add(cap);
        out += `\n**${label[cap] || cap}** — \`${cap}\`\n\n`;
        out += "| Tool | Behaviour |\n|---|---|\n";
        for (const [name, spec] of groups[cap].sort()) {
            out += `| \`${name}\` | ${CLASS_NOTE[spec.classification] || spec.classification} |\n`;
        }
    }
    return out;
}

/**
 * Rendered from app/core/capabilities.js — the SAME function the in-app panel
 * calls. This file used to carry its own copy of the table and the wording,
 * which meant "one computation, three surfaces" was not actually true and the
 * README could drift from the app by a careless edit.
 */
function requirements() {
    const r = capabilities.requirements();
    if (!r) return "\n_No language models are registered._\n";
    const cell = (row, v) => row.bytes ? fmtGB(v) : String(v);
    let out = "\n| | Minimum | Comfortable | To run everything |\n|---|---|---|---|\n";
    for (const row of r.rows) {
        out += `| **${row.label}** | ${cell(row, row.min)} | ${cell(row, row.ok)} | ${cell(row, row.all)} |\n`;
    }
    return out + `\nHow it is calculated: ${r.formula}.\n\n**GPU note.** ${r.sharedMemoryNote}\n`;
}

const md = `<!-- generated by devtools/capability-map.js — do not edit by hand -->

### System requirements
${requirements()}

### Models
${modelsTable()}
_Context figures assume the q8 KV cache and flash attention the engine enables by
default. "Does not fit 8 GB" means the planner will refuse it and tell you how much
to free — it will not try and stall the machine._

### What it can do
${toolsTable()}
Every capability is deny-by-default. A tool marked **asks first** cannot run without a
separate, explicit approval that names the exact action — the model can only ever
*propose* it. Network access is off until you turn it on, and offensive tools stay
unavailable until you create a time-boxed engagement naming one authorized host.

### Formats it reads
| Kind | Extensions |
|---|---|
| Text & code | \`.txt .md .js .ts .py .json .yaml .xml .csv .html .css\` and similar |
| Documents | \`.pdf\` (real text extraction, page-cited) |
| Scanned pages | \`.png .jpg .jpeg .tif .webp .bmp\` via offline OCR, upscaled when low-res |
| Images (vision) | \`.png .jpg\` with a vision model loaded |
| Media | audio/video probing and conversion via bundled ffmpeg |
`;

if (process.argv.includes("--json")) {
    const llms = registry.models.filter(m => m.kvBytesPerToken);
    console.log(JSON.stringify({
        models: registry.models.map(m => ({
            id: m.id, params: m.params, sizeBytes: m.sizeBytes,
            roles: ROLE_OF(m.id), traits: m.traits,
            needBytes8k: m.kvBytesPerToken ? needFor(m, 8192).total : null,
            contextAt8GB: m.kvBytesPerToken ? bestContext(m, 8.0) : null
        })),
        toolCount: Object.keys(TOOL_CLASS).length,
        llmCount: llms.length
    }, null, 2));
} else if (process.argv.includes("--write")) {
    const readme = path.join(ROOT, "README.md");
    let text = fs.readFileSync(readme, "utf8");
    const START = "<!-- CAPABILITY-MAP:START -->";
    const END = "<!-- CAPABILITY-MAP:END -->";
    const block = `${START}\n${md}\n${END}`;
    if (text.includes(START) && text.includes(END)) {
        text = text.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
    } else {
        text = text.replace(/\n## /, `\n## Capabilities\n\n${block}\n\n## `);
    }
    fs.writeFileSync(readme, text, "utf8");
    console.log("README.md capability map updated");
} else {
    console.log(md);
}
