/**
 * Registry integrity: every claim the registry makes must hold.
 *
 * Exists because renaming an entry id ("sdxl-turbo-q8" -> "sdxl-turbo-q4")
 * without updating roles.image silently disabled image generation app-wide —
 * the dangling pointer resolved to nothing and imageGen.available() went
 * false with no error anywhere. This file makes that class of edit fail
 * loudly before it ships.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, "models", "registry.json"), "utf8"));

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + detail : ""); }
}

const models = registry.models || [];
const ids = new Set(models.map(m => m.id));

// 1. every role points at an entry that exists
for (const [role, id] of Object.entries(registry.roles || {})) {
    check(`role "${role}" resolves to a real entry`, ids.has(id), `dangles: ${id}`);
}

// 2. ids are unique
check("entry ids are unique", ids.size === models.length);

// 3. entries marked present actually exist in the dev models dir
for (const m of models) {
    if (!m.present) continue;
    const p = path.join(ROOT, "models", m.file);
    check(`present entry "${m.id}" is on disk`, fs.existsSync(p), m.file);

    // 4. and its recorded size matches reality (planner plans from this)
    if (fs.existsSync(p) && m.sizeBytes) {
        const real = fs.statSync(p).size;
        check(`"${m.id}" sizeBytes matches disk`, real === m.sizeBytes,
            `registry ${m.sizeBytes} vs disk ${real}`);
    }
}

// 5. every llama chat model the planner can load has KV geometry.
// Encoder models (embedding, reranking) have no KV cache by construction —
// they read a whole sequence in one pass and emit a vector or a score — so
// they are exempt rather than carrying a meaningless zero.
const ENCODER_ROLES = new Set(["embedding", "reranker"]);
for (const m of models) {
    if (m.runtime !== "llama.cpp" || ENCODER_ROLES.has(m.role)) continue;
    check(`"${m.id}" carries kvBytesPerToken for the planner`,
        Number.isFinite(m.kvBytesPerToken) && m.kvBytesPerToken > 0);
}

// 6. Only GENERATIVE models may be offered as the chat model.
//
// Selecting an encoder as the chat engine produces a session that answers
// nothing — and once selected the picker no longer lists it, so the user cannot
// un-choose it. That happened for real: the picker filtered on
// `role !== "embedding"`, a reranker was added later with a different role,
// and it sailed straight in.
//
// The predicate is deliberately belt-and-braces: a known non-chat role OR the
// absence of a KV cache disqualifies a model. The second half means the next
// encoder added to this registry is excluded by construction, without anyone
// remembering to extend a list.
const NON_CHAT_ROLES = new Set(["embedding", "reranker", "image"]);
const isChat = (m) => !NON_CHAT_ROLES.has(m.role) && !!m.kvBytesPerToken;

for (const m of models) {
    if (m.runtime !== "llama.cpp") continue;
    if (NON_CHAT_ROLES.has(m.role)) {
        check(`"${m.id}" (${m.role}) is NOT offered as a chat model`, !isChat(m));
    } else {
        check(`"${m.id}" is generative, so offering it as a chat model is safe`,
            isChat(m), { role: m.role, kv: m.kvBytesPerToken });
    }
}

// every declared role must point at a model that exists
for (const [role, id] of Object.entries(registry.roles || {})) {
    const target = models.find(m => m.id === id);
    check(`role "${role}" points at a real model`, !!target, { role, id });
    if (target && !NON_CHAT_ROLES.has(role) && role !== "default") continue;
}

// the chat-capable roles must name chat-capable models
for (const role of ["default", "code", "code-heavy", "critic", "flagship"]) {
    const id = (registry.roles || {})[role];
    if (!id) continue;
    const target = models.find(m => m.id === id);
    check(`role "${role}" names a model that can actually converse`,
        target && isChat(target), { role, id });
}

// 7. the preferred ladder: every rung resolves to a chat-capable model, and
// the LAST rung is the bundled floor — the one model every install ships with
// (builder-config's extraResources filter names exactly that file), so a
// bundle-only install always resolves a default instead of booting modelless.
const ladder = registry.preferred || [];
check("a preferred ladder exists", Array.isArray(ladder) && ladder.length > 0);
for (const id of ladder) {
    const m = models.find(x => x.id === id);
    check(`ladder rung "${id}" resolves to a chat-capable model`, m && isChat(m));
}
check("the ladder ends at the bundled floor",
    ladder[ladder.length - 1] === "qwen2.5-coder-1.5b-q4", ladder[ladder.length - 1]);
check("the ladder's first rung is stronger than the floor",
    ladder.length > 1 && ladder[0] !== "qwen2.5-coder-1.5b-q4");
// a reasoning distill thinks out loud before every answer; it must be chosen,
// never defaulted into
for (const id of ladder) {
    const m = models.find(x => x.id === id) || {};
    check(`ladder rung "${id}" is not a reasoning distill`, !m.reasoningModel);
}

console.log(`\n${pass}/${pass + fail} registry integrity checks passed`);
process.exit(fail ? 1 : 0);
