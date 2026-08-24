"use strict";
/*
 * The shipped model-capability catalog: providers with base URLs, models with
 * editorial capability scores and rates. Informational and overridable — it
 * feeds the provider chips, Manage Models, and the offer layer. Data lives in
 * modelIntel.data.js so packaging needs no extra globs.
 */

let DATA = { asOf: null, note: "", providers: [], models: [] };
try { DATA = require("./modelIntel.data.js"); } catch { /* ship empty */ }

function catalog() {
    return {
        asOf: DATA.asOf || null,
        note: DATA.note || "",
        providers: Array.isArray(DATA.providers) ? DATA.providers : [],
        models: Array.isArray(DATA.models) ? DATA.models : []
    };
}

/* Case-insensitive match, EXACT id first, then tail (provider prefixes vary
 * between the catalog and what an endpoint serves). Exact-first matters
 * because tails collide — openrouter/z-ai/glm-5.2 and ollama/glm-5.2 share the
 * tail "glm-5.2", and a bare tail match would hand a hosted price to a free
 * local copy. */
function intelFor(modelId) {
    if (!modelId) return null;
    const bare = String(modelId).toLowerCase();
    // Ollama servings carry a ":tag" (glm-5.2:latest) the catalog never does —
    // stripped on BOTH sides so a tagged node model still resolves to its twin
    const detag = (x) => x.split(":")[0];
    const tail = detag(bare.split("/").pop());
    const models = catalog().models;
    for (const m of models) {
        if (String(m.id).toLowerCase() === bare) return m;
    }
    for (const m of models) {
        if (detag(String(m.id).toLowerCase().split("/").pop()) === tail) return m;
    }
    return null;
}

function capsFor(modelId) {
    const m = intelFor(modelId);
    return (m && m.caps) || null;
}

module.exports = { catalog, intelFor, capsFor };
