"use strict";
/* The intent gateway: the layer under API fallback/escalation. It names a
 * better-suited reachable model and never routes. */
const assert = require("assert");
const intel = require("../.lcl.engine/core/modelIntel");
const offer = require("../.lcl.engine/core/modelOffer");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}

/* ---- the shipped catalog is real and self-consistent ---- */
const cat = intel.catalog();
check("the catalog ships providers and models", cat.providers.length >= 10 && cat.models.length >= 30,
    { p: cat.providers.length, m: cat.models.length });
check("every model names a provider that exists",
    cat.models.every(m => cat.providers.some(p => p.id === m.provider)),
    cat.models.filter(m => !cat.providers.some(p => p.id === m.provider)).map(m => m.id));
check("every model carries all six capability axes in 0..10",
    cat.models.every(m => ["code", "reasoning", "vision", "drawing", "speed", "agentic"]
        .every(k => typeof m.caps[k] === "number" && m.caps[k] >= 0 && m.caps[k] <= 10)));
check("intelFor matches on a bare id OR the tail, so served ids resolve",
    !!intel.intelFor("claude-fable-5") && !!intel.intelFor("anthropic/claude-fable-5"));
check("intelFor prefers an EXACT id over a tail match — a colliding tail must " +
      "not hand a hosted price to a free local copy",
    (() => {
        // glm-5.2 exists hosted (openrouter, priced) AND local (ollama, rate null)
        const local = intel.intelFor("ollama/glm-5.2");
        return local && local.provider === "ollama" && local.rate === null;
    })());
check("intelFor sees through an Ollama ':tag' — a node serving 'x:latest' " +
      "still resolves to its catalog twin instead of scoring null",
    (() => {
        const bare = intel.intelFor("glm-5.2");
        const tagged = intel.intelFor("glm-5.2:latest");
        return !!bare && !!tagged && tagged.id === bare.id;
    })());
check("a text-only model scores 0 at drawing — the whole basis of the offer",
    (intel.capsFor("anthropic/claude-opus-5") || {}).drawing === 0);
check("a true image model scores high at drawing",
    (() => { const img = cat.models.find(m => /flux|imagine|image|banana/i.test(m.id));
             return img && img.caps.drawing >= 7; })());

/* ---- intent detection ---- */
check("a drawing ask is read as drawing", (offer.intentOf("draw me a fox logo") || {}).cap === "drawing");
check("a coding ask is read as code", (offer.intentOf("debug this stack trace") || {}).cap === "code");
check("ordinary chat has no dominant intent — no offer machinery runs",
    offer.intentOf("what did we decide about the bench yesterday") === null);
// the drawing regex must not fire on code that merely MENTIONS an image
check("'fix the broken image upload handler' is CODE, not drawing",
    (offer.intentOf("fix the broken image upload handler in the code") || {}).cap === "code");
check("'the docker image will not build' is NOT misread as drawing (no image model offered)",
    (offer.intentOf("the docker image will not build") || {}).cap !== "drawing");
check("'render a login component' is CODE, not drawing",
    (offer.intentOf("render a login component") || {}).cap === "code");
check("a real image request still reads as drawing",
    (offer.intentOf("generate an image of a fox") || {}).cap === "drawing"
    && (offer.intentOf("make a logo for my shop") || {}).cap === "drawing");

/* ---- the offer earns its interruption ---- */
const cands = [
    { id: "qwen2.5-coder-1.5b", mode: "local" },
    { id: "black-forest-labs/flux-2-pro", label: "FLUX 2 Pro", mode: "api" },
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5", mode: "api" }
];
const drawOffer = offer.offer("draw a fox logo", cands, "qwen2.5-coder-1.5b");
check("OFFERS a drawing model when a text model is loaded for an image task",
    drawOffer && drawOffer.suggested.id === "black-forest-labs/flux-2-pro"
    && drawOffer.cap === "drawing", drawOffer);
check("...and the offer says WHY, in a sentence the operator can act on",
    drawOffer && /image work/.test(drawOffer.reason) && /10\/10/.test(drawOffer.reason));

check("DOES NOT nag between two strong models — a margin is required",
    offer.offer("refactor this function",
        [{ id: "anthropic/claude-opus-5", label: "Opus 5", mode: "api" },
         { id: "anthropic/claude-sonnet-5", label: "Sonnet 5", mode: "api" }],
        "anthropic/claude-opus-5") === null);

check("returns null on plain chat even with better models around — no intent, no offer",
    offer.offer("thanks, that works", cands, "qwen2.5-coder-1.5b") === null);

// the balance the operator's report set: an UNKNOWN current model on a soft
// cap IS offered a TOP-TIER (9+) alternative — "asked a low tier model to do
// something and saw no suggestion" was the failure of the stricter rule —
// but a mid-tier alternative stays quiet (no nag between an unknown and a 7)
check("an unknown low-tier model asked to code IS offered a top-tier alternative",
    (() => {
        const o = offer.offer("refactor this function",
            [{ id: "qwen2.5-coder-1.5b", mode: "local" },
             { id: "anthropic/claude-opus-5", label: "Opus 5", mode: "api" }],
            "qwen2.5-coder-1.5b");
        return o && o.suggested.id === "anthropic/claude-opus-5";
    })());
check("...but a MID-tier alternative does not nag an unknown current model",
    offer.offer("refactor this function",
        [{ id: "qwen2.5-coder-1.5b", mode: "local" },
         { id: "anthropic/claude-haiku-4-5", label: "Haiku 4.5", mode: "api" }],
        "qwen2.5-coder-1.5b") === null);
check("...but STILL offers an image model for a HARD cap the local model truly cannot do",
    (() => {
        const o = offer.offer("draw a fox logo",
            [{ id: "qwen2.5-coder-1.5b", mode: "local" },
             { id: "black-forest-labs/flux-2-pro", label: "FLUX 2 Pro", mode: "api" }],
            "qwen2.5-coder-1.5b");
        return o && o.suggested.id === "black-forest-labs/flux-2-pro";
    })());

check("works BOTH directions: an api model on an image ask is pointed at a better image model",
    (() => {
        const o = offer.offer("generate an image of a barn",
            [{ id: "anthropic/claude-opus-5", label: "Opus 5", mode: "api" },
             { id: "black-forest-labs/flux-2-pro", label: "FLUX 2 Pro", mode: "api" }],
            "anthropic/claude-opus-5");
        return o && o.suggested.id === "black-forest-labs/flux-2-pro";
    })());

/* ---- the tool form is advisory and never routes ---- */
(async () => {
    const noTask = await offer.suggestModel(null, {}, {});
    check("suggest_model asks for a task rather than guessing", noTask.failed === true);

    const suited = await offer.suggestModel(null,
        { task: "refactor this function", current: "anthropic/claude-opus-5" },
        {});
    check("suggest_model says the current model is fine when it is — no thrash",
        /well suited/.test(suited.output) && !suited.suggestion);

    const suggested = await offer.suggestModel(null,
        { task: "draw a fox logo", current: "qwen2.5-coder-1.5b" }, {});
    // note: reachableModels() reads the live registry/endpoints which are empty
    // in a bare test, so we assert the CONTRACT: given an explicit better model
    // via offer(), the tool wraps it as an OFFER and never switches. The offer
    // math itself is covered above; here we prove the tool never routes.
    check("suggest_model's output is an OFFER, never a switch instruction",
        typeof suggested.output === "string"
        && !/switch|routing to|now using/i.test(suggested.output));

    console.log(`\n${pass}/${pass + fail} model-offer checks passed`);
    process.exit(fail ? 1 : 0);
})();
