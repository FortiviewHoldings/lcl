/**
 * The default-model ladder — anchored on a real failure.
 *
 * Every session in a real install ran on the bundled 1.5B coder while a
 * downloaded 4B (and a 9B) sat unused in data/models, because findModel()
 * named only the registry's default role. The user's verdict on the output:
 * "i could never replace you with that." The ladder makes the default the
 * BEST model on this machine, with the bundled floor as the last rung.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
// Packaged-mode stub with a throwaway data dir: the dev repo's live
// data/settings.json holds a real saved modelPath, and an explicit user
// choice CORRECTLY beats the ladder — so the test must run without one.
// resourcesPath points at the repo so the bundled models dir is the real
// engine/models fleet.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ladder-"));
process.resourcesPath = path.join(__dirname, "..");
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const paths = require(__dirname + "/../.lcl.engine/core/paths.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}

/* ---- ladderEntries is pure: feed it synthetic registries ---- */
const synth = {
    models: [
        { id: "big", file: "big.gguf", kvBytesPerToken: 1 },
        { id: "mid", file: "mid.gguf", kvBytesPerToken: 1 },
        { id: "floor", file: "floor.gguf", kvBytesPerToken: 1 }
    ],
    preferred: ["big", "mid", "floor"],
    roles: { default: "mid" }
};
check("ladder preserves preferred order",
    paths.ladderEntries(synth).map(e => e.id).join(",") === "big,mid,floor");
check("roles.default is appended without duplicating a rung",
    paths.ladderEntries(synth).filter(e => e.id === "mid").length === 1);
check("an id with no registry entry is skipped, not a crash",
    paths.ladderEntries({ ...synth, preferred: ["ghost", "big"] })
        .map(e => e.id).join(",") === "big,mid");
check("an entry without a file is skipped",
    paths.ladderEntries({
        models: [{ id: "nofile" }, { id: "ok", file: "ok.gguf" }],
        preferred: ["nofile", "ok"], roles: {}
    }).map(e => e.id).join(",") === "ok");
check("empty registry yields an empty ladder, not a crash",
    paths.ladderEntries({}).length === 0);

/* ---- the REAL registry, on the dev machine where every model is on disk:
       the default must be the 4B generalist, and never again the 1.5B ---- */
const real = paths.modelRegistry();
const realLadder = paths.ladderEntries(real);
check("real registry: first rung is the 4B generalist",
    realLadder[0] && realLadder[0].id === "qwen3-4b-instruct-2507",
    realLadder[0] && realLadder[0].id);

const found = paths.findModel();
check("findModel() on a machine with the full fleet picks the ladder's head",
    !!found && path.basename(found) === "qwen3-4b-instruct-2507-q4_k_m.gguf",
    found && path.basename(found));

/* ---- retired models must not be reachable through the ladder ---- */
for (const id of ["phi-3-mini-4k-q4", "glm-4-9b-0414-iq3m"]) {
    check(`retired "${id}" is not a ladder rung`,
        !realLadder.some(e => e.id === id));
}
// GLM-9B stays a deliberate pick (flagship), never a silent default
check("the flagship is not on the default ladder",
    !realLadder.some(e => e.id === (real.roles || {}).flagship));
check("the flagship role still resolves",
    (real.models || []).some(m => m.id === (real.roles || {}).flagship));

console.log(`\n${pass}/${pass + fail} model-ladder checks passed`);
process.exit(fail ? 1 : 0);
