const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Resolve on-disk locations for both dev (running from the repo) and packaged
 * (installed app, where engine binaries live under resources/).
 */

function isPackaged() {
    return app.isPackaged;
}

// engine/ and data/ live next to the app in dev, under resources/ when packaged.
// app/ is one level shallower than the old ui/electron, hence two dots.
function resourceRoot() {
    return isPackaged()
        ? process.resourcesPath
        : path.join(__dirname, "..", "..");
}

function runtimesRoot() {
    return path.join(resourceRoot(), "runtimes");
}

/** engine/runtimes/<id>/ — one runtime, many platform+backend builds beneath. */
function runtimeDir(runtimeId = "llama.cpp") {
    return path.join(runtimesRoot(), runtimeId);
}

function readManifest(runtimeId = "llama.cpp") {
    try {
        const raw = fs.readFileSync(path.join(runtimeDir(runtimeId), "engine.json"), "utf8")
            .replace(/^﻿/, "");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Pick the best build for this machine: first manifest entry matching platform
 * and arch whose binary actually exists. Ordering in engine.json is the
 * preference order, so a Vulkan or Metal build wins over CPU once present.
 */
function selectBuild(runtimeId = "llama.cpp") {
    const manifest = readManifest(runtimeId);
    if (!manifest || !Array.isArray(manifest.builds)) return null;

    for (const build of manifest.builds) {
        if (build.platform && build.platform !== process.platform) continue;
        if (build.arch && build.arch !== process.arch) continue;

        const binary = path.join(runtimeDir(runtimeId), build.dir, build.binary);
        if (fs.existsSync(binary)) return { ...build, binary, runtimeId, manifest };
    }
    return null;
}

function engineDir(runtimeId = "llama.cpp") {
    const build = selectBuild(runtimeId);
    return build ? path.dirname(build.binary) : runtimeDir(runtimeId);
}

function engineBinary(runtimeId = "llama.cpp") {
    const build = selectBuild(runtimeId);
    if (build) return build.binary;
    // fall back to the expected build path so the error names a real location
    return path.join(runtimeDir(runtimeId),
        process.platform === "win32" ? "win-x64\\llama-server.exe" : "mac-arm64/llama-server");
}

/** tools/ — third-party instruments (ffmpeg, tesseract). Not the engine. */
function toolsRoot() {
    return path.join(resourceRoot(), "tools");
}

/** models/ — flat and shared. A model is not owned by a runtime. */
function bundledModelsDir() {
    return path.join(resourceRoot(), "models");
}

function modelRegistry() {
    try {
        const raw = fs.readFileSync(path.join(bundledModelsDir(), "registry.json"), "utf8")
            .replace(/^﻿/, "");
        return JSON.parse(raw);
    } catch {
        return { models: [], roles: {} };
    }
}

/**
 * Writable app data. In dev we keep using the repo's data/ dir so existing
 * sessions carry over; installed builds use the per-user appData dir because
 * Program Files is not writable.
 */
function dataDir() {
    // A TEST MUST BE ABLE TO NOT TOUCH THE REAL STORE.
    //
    // In development this resolves to the repo's own data/ folder, and it does
    // so REGARDLESS of the electron stub a suite installs — so every test that
    // wrote through here quietly edited the working store. Measured: eight
    // fixture endpoints ("alpha", "rentgpu", "api.example.com") sitting in
    // data/cloud-endpoints.json, and earlier the same mechanism left a tone
    // and a fake driver in settings.json between runs.
    //
    // Honoured only when NOT packaged, so a shipped app cannot be pointed at a
    // different data directory by whatever set an environment variable.
    if (!isPackaged() && process.env.LCL_DATA_DIR) {
        const dir = process.env.LCL_DATA_DIR;
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }
    const dir = isPackaged()
        ? path.join(app.getPath("userData"), "data")
        : path.join(resourceRoot(), "data");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function sessionsDir() {
    const dir = path.join(dataDir(), "sessions");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Tier-2 intent ledgers — the durable, flat, per-session record of intent,
 *  criteria and status (intentLedger.js). On the user's own machine, their IP. */
function intentDir() {
    const dir = path.join(dataDir(), "intent");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Where a patch session's working copy lives — OUTSIDE the checkout, always.
 *
 * The patch bay's headline guarantee, printed in its own comments and in the
 * window the operator reads, is that a session is a copy placed "never inside
 * the repo". dataDir() cannot keep that promise: unpackaged it resolves to the
 * checkout's OWN data/ folder. Measured before this existed, on this machine:
 * resourceRoot C:\.lcl, dataDir C:\.lcl\data, worktree
 * C:\.lcl\data\patch-bay\patch-s-abc — inside the repository, which git
 * permits and nothing refused. And since the patch bay refuses to run on a
 * packaged build by design, that was the ONLY reachable path in production.
 *
 * userData is per-user and sits outside any checkout in dev AND packaged.
 *
 * LCL_DATA_DIR is deliberately NOT consulted here. A suite pointing the data
 * store at a temp folder must not be able to move this guarantee's goalposts —
 * that is exactly how the old assertion became incapable of failing.
 */
function patchBayRoot() {
    let base = null;
    try {
        if (app && typeof app.getPath === "function") base = app.getPath("userData");
    } catch {
        base = null;                             // Electron absent or headless
    }
    if (!base) base = path.join(os.tmpdir(), "lcl-patch-bay");
    const dir = path.join(base, "patch-bay");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function settingsFile() {
    return path.join(dataDir(), "settings.json");
}

function readSettings() {
    try {
        // strip a UTF-8 BOM: editors and PowerShell write one, and JSON.parse
        // rejects it, which would silently look like "no settings at all"
        const raw = fs.readFileSync(settingsFile(), "utf8").replace(/^﻿/, "");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeSettings(patch) {
    const next = { ...readSettings(), ...patch };
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), "utf8");
    return next;
}

/**
 * Find a GGUF model. Order: explicit user choice, bundled models dir,
 * per-user models dir. Returns null when the app needs to ask the user.
 */
/**
 * A saved choice must not be able to brick the app.
 *
 * If the remembered model is one WE know is not generative — an embedder, a
 * reranker, an image model — honouring it produces an engine that loads and
 * then answers nothing, with no obvious way back: the picker no longer offers
 * it, so the user cannot un-choose it. So we refuse it here and fall through to
 * the default.
 *
 * A model we do NOT recognise is honoured, because the user can point the app
 * at any GGUF they like and we have no basis to overrule that.
 */
function isUsableChatModel(modelPath) {
    const entry = describeModel(modelPath);
    if (!entry) return true;                     // unknown file: the user's call
    if (["embedding", "reranker", "image"].includes(entry.role)) return false;
    return !!entry.kvBytesPerToken;              // encoders have no KV cache
}

/**
 * The default-model ladder: registry.preferred (best first), then the default
 * role as a backstop. Returns entries, best first, deduplicated. Pure — pulled
 * out of findModel so a test can hand it a synthetic registry.
 */
function ladderEntries(registry) {
    const ids = [...(registry.preferred || [])];
    if (registry.roles && registry.roles.default) ids.push(registry.roles.default);
    const out = [];
    for (const id of ids) {
        if (out.some(e => e.id === id)) continue;
        const entry = (registry.models || []).find(m => m.id === id);
        if (entry && entry.file) out.push(entry);
    }
    return out;
}

function findModel() {
    const settings = readSettings();
    const chosen = settings.modelPath;
    if (chosen && fs.existsSync(chosen) && isUsableChatModel(chosen)) return chosen;

    const candidates = [
        bundledModelsDir(),
        path.join(dataDir(), "models")
    ];

    // THE PREFERRED-MODEL PAGE FINALLY DECIDES SOMETHING. settings.preferredModel
    // (written by lcl:setPreferredModel, shown as the picker's "preferred"
    // badge) was consumed by NOTHING on the load path — the page promised "the
    // local model a new conversation starts on" and the ladder below ignored
    // it. It outranks the registry ladder; a preference for a model not on
    // disk falls through rather than blocking.
    const pref = settings.preferredModel;
    if (pref) {
        const entry = (modelRegistry().models || []).find(m => m.id === pref);
        if (entry && entry.file) {
            for (const dir of candidates) {
                const p = path.join(dir, entry.file);
                if (fs.existsSync(p) && isUsableChatModel(p)) return p;
            }
        }
    }

    // Walk the preference ladder and name the FIRST model that is actually on
    // this machine. Naming only the bundled default was how every session
    // without an explicit pick ran on the 1.5B floor while a downloaded 4B sat
    // unused on disk. Fit is not judged here — engine.start() plans against
    // live memory and degrades with a visible note — so this states the want
    // and the planner keeps it honest.
    for (const entry of ladderEntries(modelRegistry())) {
        for (const dir of candidates) {
            const p = path.join(dir, entry.file);
            if (fs.existsSync(p) && isUsableChatModel(p)) return p;
        }
    }

    for (const dir of candidates) {
        let names = [];
        try {
            names = fs.readdirSync(dir);
        } catch {
            continue;
        }
        const gguf = names.filter(n => n.toLowerCase().endsWith(".gguf")).sort();
        if (gguf.length) return path.join(dir, gguf[0]);
    }

    return null;
}

/** Registry entry for a model file on disk, if we know about it. */
function describeModel(modelPath) {
    if (!modelPath) return null;
    const base = path.basename(modelPath).toLowerCase();
    return (modelRegistry().models || []).find(m => (m.file || "").toLowerCase() === base) || null;
}

function modelsDir() {
    const dir = path.join(dataDir(), "models");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

module.exports = {
    isPackaged,
    resourceRoot,
    runtimesRoot,
    toolsRoot,
    runtimeDir,
    readManifest,
    selectBuild,
    engineDir,
    engineBinary,
    bundledModelsDir,
    modelRegistry,
    describeModel,
    dataDir,
    sessionsDir,
    intentDir,
    patchBayRoot,
    modelsDir,
    readSettings,
    writeSettings,
    findModel,
    ladderEntries,
    isUsableChatModel
};
