const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const paths = require("./paths");

/**
 * Machine resource inventory: memory AND compute.
 *
 * Memory alone was never the whole picture. Choosing between "a 1.5B model on
 * the GPU" and "a 7B model on the CPU" is a compute decision, so the same
 * inventory that feeds the machine view is what the router will consult when
 * it picks an engine and model. One source of truth, so the panel can never
 * drift from what the orchestrator actually decides on.
 *
 * Everything here is MEASURED. A device that exists but has no usable runtime
 * is reported as such rather than counted as capacity — an NPU with no
 * OpenVINO installed is not compute we can spend.
 */

const KB = 1024;
let gpuCache = null;          // probing spawns a process; cache it
let gpuCacheAt = 0;
const GPU_CACHE_MS = 60_000;

/* ------------------------------------------------------------------ memory */

function memory() {
    const info = process.getSystemMemoryInfo();      // KB

    const physTotal = (info.total || 0) * KB;
    const available = (info.free || 0) * KB;         // Windows "Available"
    const commitLimit = (info.swapTotal || 0) * KB;
    const commitFree = (info.swapFree || 0) * KB;
    // NOT `commitLimit && commitFree`: commitFree === 0 is full commit
    // exhaustion — the old truthiness test read it as "no data" and reported
    // zero pressure at the exact moment allocations start failing.
    const commitUsed = commitLimit ? Math.max(0, commitLimit - commitFree) : 0;

    // The commit limit is physical RAM plus the page file, and the page file
    // lives on disk. Surfacing the difference stops the limit from reading as
    // usable fast memory.
    const pagefileBytes = Math.max(0, commitLimit - physTotal);

    const availRatio = physTotal ? available / physTotal : 1;
    const commitRatio = commitLimit ? commitUsed / commitLimit : 0;

    let level = "ok";
    if (available < 1.0e9 || commitRatio >= 0.92) level = "critical";
    else if (available < 2.5e9 || commitRatio >= 0.80) level = "low";

    return {
        physTotalBytes: physTotal,
        availableBytes: available,
        physUsedBytes: physTotal - available,
        commitLimitBytes: commitLimit,
        commitUsedBytes: commitUsed,
        commitFreeBytes: commitFree,
        pagefileBytes,
        availRatio,
        commitRatio,
        level
    };
}

/* ------------------------------------------------------------------- cpu */

/**
 * os.cpus() reports tick counters that are CUMULATIVE SINCE BOOT. Reading them
 * once and computing 1 - idle/total therefore yields the machine's lifetime
 * average utilisation, not its current load — on a laptop up for three days
 * that number sits near the long-run mean and barely moves no matter what is
 * running. The machine panel and system_stats both showed it as "% busy", which
 * is why a 4B model saturating eight threads looked like an idle machine.
 *
 * Current load needs two samples and a delta. The baseline is primed at require
 * time and advanced on each call, so the UI's poll loop gets "busy since you
 * last asked" for free — no child process, no blocking sleep.
 */
const MIN_SAMPLE_MS = 200;
function ticks() {
    const list = os.cpus() || [];
    let idle = 0, total = 0;
    for (const c of list) {
        for (const k of Object.keys(c.times)) total += c.times[k];
        idle += c.times.idle;
    }
    return { list, idle, total, at: Date.now() };
}
let baseline = ticks();
let lastRatio = null;

function cpu() {
    const now = ticks();
    const model = now.list.length ? now.list[0].model.trim() : "unknown";
    const sinceBoot = now.total ? 1 - now.idle / now.total : 0;

    const dTotal = now.total - baseline.total;
    const dIdle = now.idle - baseline.idle;
    const elapsed = now.at - baseline.at;

    let busyRatio, sampleMs = elapsed;
    if (elapsed >= MIN_SAMPLE_MS && dTotal > 0) {
        busyRatio = Math.min(1, Math.max(0, 1 - dIdle / dTotal));
        lastRatio = busyRatio;
        baseline = now;                 // advance only on a usable sample
    } else if (lastRatio !== null) {
        busyRatio = lastRatio;          // two calls inside one window: hold, don't divide by noise
        sampleMs = 0;
    } else {
        busyRatio = sinceBoot;          // first call within 200 ms of startup
        sampleMs = 0;
    }

    return {
        model,
        threads: now.list.length,
        // the EXACT count the engine launches llama.cpp with (engine.js): one
        // per core bar one, clamped to [2, 8]. This used to report floor(N/2)
        // clamped [1, 8], which disagreed with the engine for every core count
        // below 16 — the panel understated the threads actually in use.
        threadsUsed: Math.max(2, Math.min(8, now.list.length - 1)),
        busyRatio,
        // kept and labelled, because it is a real number — just a different one
        busyRatioSinceBoot: sinceBoot,
        // 0 means "this reading was carried over", which is what an honest
        // instrument says instead of inventing a fresh value
        sampleMs,
        arch: process.arch,
        platform: process.platform
    };
}

/**
 * A genuine load reading for one-shot callers. cpu()'s delta is against the
 * previous call, which is right for a poll loop and wrong for a panel opened
 * once an hour after startup — there the "delta" spans the whole hour and
 * averages current load away again. This takes its own short window instead.
 */
async function cpuSampled(ms = 250) {
    const a = ticks();
    await new Promise(r => setTimeout(r, Math.max(50, ms)));
    const b = ticks();
    const dTotal = b.total - a.total, dIdle = b.idle - a.idle;
    const base = cpu();                 // model/threads/lifetime average
    if (dTotal <= 0) return base;
    const busyRatio = Math.min(1, Math.max(0, 1 - dIdle / dTotal));
    lastRatio = busyRatio;
    baseline = b;
    return { ...base, busyRatio, sampleMs: b.at - a.at };
}

/* ------------------------------------------------------------------- gpu */

/**
 * Ask the actual engine binary what devices it can use. This is the only
 * honest source: Windows reports 2 GB "dedicated" for an Arc iGPU while Vulkan
 * reports ~9 GB addressable, and the number that matters is the one the
 * inference runtime will actually get.
 */
function probeGpu() {
    return new Promise((resolve) => {
        if (gpuCache && Date.now() - gpuCacheAt < GPU_CACHE_MS) return resolve(gpuCache);

        const build = paths.selectBuild("llama.cpp");
        if (!build || !fs.existsSync(build.binary)) {
            return resolve({ devices: [], accelerator: null, probed: false,
                             note: "engine binary not found" });
        }

        execFile(build.binary, ["--list-devices"], {
            cwd: path.dirname(build.binary),
            timeout: 15_000,
            windowsHide: true
        }, (err, stdout) => {
            const devices = [];
            for (const line of String(stdout || "").split("\n")) {
                // e.g. "  Vulkan0: Intel(R) Arc(TM) Graphics (9113 MiB, 8402 MiB free)"
                const m = /^\s*(\w+?\d*):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/.exec(line);
                if (m) {
                    devices.push({
                        id: m[1],
                        name: m[2],
                        totalBytes: Number(m[3]) * 1024 * 1024,
                        freeBytes: Number(m[4]) * 1024 * 1024
                    });
                }
            }
            gpuCache = {
                devices,
                accelerator: build.accelerator,
                buildId: build.id,
                probed: true,
                note: devices.length ? null
                    : "no accelerated device found; running on CPU",
                error: err ? String(err.message || err).slice(0, 120) : null
            };
            gpuCacheAt = Date.now();
            resolve(gpuCache);
        });
    });
}

/* ------------------------------------------------------------------- npu */

/**
 * Presence is not capability. The NPU is real silicon, but without a runtime
 * that targets it (OpenVINO) nothing can dispatch work there, so it is
 * reported as present-but-unusable rather than as spare capacity.
 */
function npu() {
    if (process.platform !== "win32") {
        return { present: false, usable: false, reason: "not probed on this platform" };
    }

    // The device shows up in the driver store; checking the filesystem avoids
    // spawning WMI on every poll.
    const driverHints = [
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "DriverStore", "FileRepository")
    ];
    let present = false;
    for (const dir of driverHints) {
        try {
            present = fs.readdirSync(dir).some(n => /intcaudiobus|npu|intel.*ai.?boost/i.test(n));
            if (present) break;
        } catch { /* unreadable */ }
    }

    const openvino = [
        "C:\\Program Files (x86)\\Intel\\openvino",
        "C:\\Program Files\\Intel\\openvino"
    ].some(p => { try { return fs.existsSync(p); } catch { return false; } });

    return {
        present,
        usable: present && openvino,
        runtime: openvino ? "openvino" : null,
        reason: !present ? "no NPU detected"
            : openvino ? null
            : "NPU present but no OpenVINO runtime installed, so nothing can dispatch to it"
    };
}

/* ---------------------------------------------------------------- summary */

async function inventory() {
    // the GPU probe spawns the engine binary and takes far longer than 250 ms,
    // so the CPU sample is free — it runs inside that wait
    const [gpu, c] = await Promise.all([probeGpu(), cpuSampled()]);
    const mem = memory();
    const n = npu();

    const modelPath = paths.findModel();
    let modelBytes = 0;
    if (modelPath) {
        try { modelBytes = fs.statSync(modelPath).size; } catch { /* gone */ }
    }

    return {
        memory: mem,
        cpu: c,
        gpu,
        npu: n,
        model: {
            path: modelPath,
            bytes: modelBytes,
            info: paths.describeModel(modelPath)
        },
        // what the router will care about: can another model of this size fit
        headroomForAnotherModel: mem.availableBytes - modelBytes > 1.5e9
    };
}

module.exports = { inventory, memory, cpu, cpuSampled, probeGpu, npu };
