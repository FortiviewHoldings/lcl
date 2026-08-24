const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const machine = require("./machine");
const { resolveInRoot, ToolError } = require("./fsTools");

/**
 * Local text-to-image via stable-diffusion.cpp.
 *
 * Deliberately per-invocation: sd-cli loads the model, renders one image, and
 * exits. Nothing stays resident, so the 7B chat model and image generation
 * never hold memory at the same time — on a 15.6 GB machine that is the
 * difference between "works" and "pages itself to death".
 *
 * Security posture mirrors the file tools:
 *  - output paths go through resolveInRoot, so images land inside the linked
 *    workspace and nowhere else
 *  - the prompt is passed as ONE argv entry to spawn() with no shell, so no
 *    prompt content can become a flag or a command
 *  - dimensions/steps are clamped server-side; the model's args are requests,
 *    not commands
 */

const GEN_TIMEOUT_MS = 10 * 60_000;
const MAX_PROMPT_CHARS = 1500;
// Peak estimate is DERIVED from the model file, not a constant: the q8
// incident showed a hardcoded 4.4e9 understating a 4.18 GB model's real draw
// (>5.5 GB — the watchdog killed the render). weights x 1.15 + 1 GB of
// activations tracks that observation and scales down with the q4_K model.
function imagePeakBytes(modelPath) {
    try { return Math.round(fs.statSync(modelPath).size * 1.15 + 1.0e9); }
    catch { return 5.8e9; }              // unsizeable: assume the worst known
}
// Renders are transient (~20-40s) and watchdog-backed, so the preflight floor
// is softer than the LLM's 2.2 GB: a killed render costs a retry, not a
// resident engine. The watchdog floor below is the hard line either way.
const IMAGE_FLOOR_BYTES = 1.6e9;
const GUARD_FLOOR_BYTES = 1.15e9;
const GUARD_INTERVAL_MS = 750;
// SDXL-Turbo is a 1-4 step distilled model trained at 512. Anything past 4
// steps burns time for nothing; cfg must stay 1.0 (guidance is distilled in).
const TURBO_STEPS_MAX = 4;
const TURBO_CFG = 1.0;

function runtimeBuild() {
    return paths.selectBuild("stable-diffusion.cpp");
}

function modelFile() {
    const registry = paths.modelRegistry();
    const roleId = registry.roles && registry.roles.image;
    // The role pointer is preferred but must never be a single point of
    // failure: a registry edit that renamed the entry id but not the role
    // silently disabled image generation app-wide ("image": "sdxl-turbo-q8"
    // pointing at nothing). Any image-role entry that is actually on disk
    // keeps the capability alive.
    const entries = (registry.models || []).filter(m =>
        m.file && (m.id === roleId || m.role === "image"));
    entries.sort((a, b) => (a.id === roleId ? -1 : 0) - (b.id === roleId ? -1 : 0));
    for (const entry of entries) {
        const candidates = [
            path.join(paths.bundledModelsDir(), entry.file),
            path.join(paths.modelsDir(), entry.file)
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
    }
    return null;
}

/** Both halves must exist for the tool to be offered to the model at all. */
function available() {
    return !!(runtimeBuild() && modelFile());
}

function clampDim(v, fallback) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return fallback;
    // ggml wants multiples of 64; snap rather than reject
    return Math.max(256, Math.min(1024, Math.round(n / 64) * 64));
}

function defaultRelPath() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `images/gen-${stamp}.png`;
}

/** Map sd-cli's log lines to phases a person can follow. */
function progressNote(line) {
    if (/loading model/i.test(line)) return "loading SDXL-Turbo (~4 GB)";
    if (/get_learned_condition/i.test(line)) return "prompt encoded — denoising";
    if (/sampling completed/i.test(line)) return "denoised — decoding image";
    if (/decode_first_stage completed/i.test(line)) return "image decoded — saving";
    const step = /(?:^|[^\d])(\d+)\/(\d+)\s*(?:steps|$)/.exec(line);
    if (step) return `denoising step ${step[1]}/${step[2]}`;
    return null;
}

/**
 * Tool entry point. Same (root, args, ctx) shape as the file tools, but async.
 * Returns { written, bytes, created, seconds, width, height } so the change
 * chip and revert path work exactly like write_file's.
 */
async function generate(root, args = {}, ctx = {}) {
    const build = runtimeBuild();
    const model = modelFile();
    if (!build || !model) {
        throw new ToolError("image generation is not installed on this machine");
    }

    const prompt = String(args.prompt || "").trim();
    if (!prompt) {
        throw new ToolError('generate_image needs args: {"prompt": "what to draw"}');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
        throw new ToolError(`prompt is too long (max ${MAX_PROMPT_CHARS} characters)`);
    }

    let relPath = typeof args.path === "string" && args.path.trim()
        ? args.path.trim()
        : defaultRelPath();
    if (!/\.png$/i.test(relPath)) relPath += ".png";

    let outPath = resolveInRoot(root, relPath);   // throws on escape attempts
    let existed = fs.existsSync(outPath);
    // NEVER SILENTLY OVERWRITE. Measured: the model rendered onto the user's
    // own reallycoolblackhole.png (created:false) and then DENIED changing it.
    // A name collision diverts to a fresh -2/-3 name and SAYS SO in the result;
    // replacing a file now takes an explicit {"overwrite": true}.
    let preserved = null;
    if (existed && args.overwrite !== true) {
        const stem = relPath.replace(/\.png$/i, "");
        for (let n = 2; n < 1000; n++) {
            const cand = `${stem}-${n}.png`;
            const candFull = resolveInRoot(root, cand);
            if (!fs.existsSync(candFull)) {
                preserved = relPath; relPath = cand;
                outPath = candFull; existed = false;
                break;
            }
        }
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const width = clampDim(args.width, 512);
    const height = clampDim(args.height, 512);
    const steps = Math.max(1, Math.min(TURBO_STEPS_MAX, Number(args.steps) || 4));
    const seed = Number.isFinite(Number(args.seed)) ? String(Math.trunc(Number(args.seed))) : "-1";

    const cliArgs = [
        "-m", model,
        "-p", prompt,
        "-o", outPath,
        "-W", String(width),
        "-H", String(height),
        "--steps", String(steps),
        "--cfg-scale", String(TURBO_CFG),
        "--seed", seed,
        // Peak-memory reducers, both supported by the bundled build. The VAE
        // decode is the spike that pushed a render below the guard floor on a
        // 15.6 GB machine ("turkey incident", 2026-07-27) — tiling processes
        // it piecewise, and flash attention shrinks the diffusion buffers.
        "--vae-tiling",
        "--diffusion-fa"
    ];
    if (typeof args.negative === "string" && args.negative.trim()) {
        cliArgs.push("-n", args.negative.trim().slice(0, 500));
    }

    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    const cancelToken = ctx.cancelToken || { cancelled: false };
    const startedAt = Date.now();

    // Preflight, same rule as loading an LLM: the peak must fit in AVAILABLE
    // physical memory with the OS floor intact. The agent has already unloaded
    // the chat model at this point; if the room still is not there, other
    // applications have it, and the honest answer is a refusal with numbers.
    const mem = machine.memory();
    const peak = imagePeakBytes(model);
    if (mem.availableBytes < peak + IMAGE_FLOOR_BYTES) {
        const gb = (n) => (n / 1e9).toFixed(1);
        throw new ToolError(
            `not enough free memory to render safely: image generation peaks near ` +
            `${gb(peak)} GB and ${gb(mem.availableBytes)} GB is available. Close ` +
            `about ${gb(peak + IMAGE_FLOOR_BYTES - mem.availableBytes)} GB of ` +
            `other apps — the RAM panel's optimiser can do this — and try again.`);
    }

    return new Promise((resolve, reject) => {
        const child = spawn(build.binary, cliArgs, {
            cwd: path.dirname(build.binary),
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });

        let lastLines = [];
        const consume = (chunk) => {
            for (const line of String(chunk).split(/\r?\n/)) {
                if (!line.trim()) continue;
                lastLines.push(line.trim());
                if (lastLines.length > 12) lastLines.shift();
                const note = progressNote(line);
                if (note) onNote(note);
            }
        };
        child.stdout.on("data", consume);
        child.stderr.on("data", consume);

        const kill = () => {
            try {
                if (process.platform === "win32") {
                    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
                } else {
                    child.kill("SIGKILL");
                }
            } catch { /* already gone */ }
        };

        const timeout = setTimeout(() => {
            kill();
            reject(new ToolError("image generation timed out after 10 minutes"));
        }, GEN_TIMEOUT_MS);

        const cancelWatch = setInterval(() => {
            if (cancelToken.cancelled) {
                kill();
            }
        }, 400);

        // The anti-freeze watchdog, keyed to THIS process. The engine's own
        // guard dies with the llama child, so nothing else is watching while
        // sd-cli loads, denoises and decodes.
        let guardTripped = false;
        const guard = setInterval(() => {
            if (machine.memory().availableBytes < GUARD_FLOOR_BYTES) {
                guardTripped = true;
                kill();
            }
        }, GUARD_INTERVAL_MS);

        child.on("error", (err) => {
            clearTimeout(timeout);
            clearInterval(cancelWatch);
            clearInterval(guard);
            reject(new ToolError(`could not start the image engine: ${err.message}`));
        });

        child.on("close", (code) => {
            clearTimeout(timeout);
            clearInterval(cancelWatch);
            clearInterval(guard);

            if (guardTripped) {
                if (!existed) { try { fs.rmSync(outPath, { force: true }); } catch {} }
                reject(new ToolError(
                    "image generation stopped to protect the machine: available " +
                    "memory fell below 1.2 GB mid-render. Free some memory and try again."));
                return;
            }
            if (cancelToken.cancelled) {
                // don't leave a half-written file behind a cancel
                if (!existed) { try { fs.rmSync(outPath, { force: true }); } catch {} }
                reject(new ToolError("cancelled"));
                return;
            }
            if (code !== 0 || !fs.existsSync(outPath)) {
                const detail = lastLines.slice(-4).join(" | ").slice(0, 400);
                reject(new ToolError(
                    `image generation failed (exit ${code})${detail ? `: ${detail}` : ""}`));
                return;
            }

            const bytes = fs.statSync(outPath).size;
            resolve({
                written: relPath.split(path.sep).join("/"),
                bytes,
                created: !existed,
                seconds: Math.round((Date.now() - startedAt) / 100) / 10,
                width, height,
                // the truth travels IN the result, whatever the model claims
                note: preserved ? `"${preserved}" already existed and was preserved — ` +
                    `saved to "${relPath.split(path.sep).join("/")}" instead. ` +
                    `Pass {"overwrite": true} to replace a file.` : undefined
            });
        });
    });
}

const TOOL_ENTRY = {
    run: generate,
    help: 'generate_image {"prompt": "a lighthouse at dusk, photographic"} — ' +
        'render a PNG from a text prompt with the local Stable Diffusion engine ' +
        '(~25s; optional: "path", "width", "height" up to 1024, "negative", "overwrite": true to replace an existing file — otherwise a collision saves to name-2.png and says so)',
    /**
     * WHERE ELSE THIS CAN RUN when this machine has not got the memory.
     *
     * Declaring the tiers here — rather than the fallback module knowing about
     * image generation — is what keeps the chain general: any tool that can
     * genuinely run somewhere else adds this key, and every tool without it
     * (which is every file tool, correctly) never reroutes at all. "Write this
     * file" means write it HERE.
     *
     * The tiers are required lazily so a machine with no network stack in play
     * pays nothing for their existence.
     */
    fallback: {
        capability: "image",
        node: (a) => require("./imageRemote").viaNode(a),
        api: (a) => require("./imageRemote").viaApi(a)
    }
};

module.exports = { available, generate, TOOL_ENTRY, modelFile, runtimeBuild };
