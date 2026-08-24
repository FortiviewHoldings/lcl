/**
 * CPU LOAD — is the number the panel shows actually about NOW?
 *
 * machine.cpu() computed `1 - idle/total` from a single os.cpus() read. Those
 * tick counters are CUMULATIVE SINCE BOOT, so the result was the machine's
 * lifetime average utilisation. On a laptop that has been up for days that value
 * sits near its long-run mean and barely moves — which is why a 4B model
 * saturating eight threads still read as an idle machine in the compute panel
 * and in system_stats. The model consulted that number before planning heavy
 * work; it was being told something almost unrelated to the present.
 *
 * A unit test that only checked "returns a number between 0 and 1" passed the
 * whole time, because the old code did return one. So this test does the only
 * thing that can distinguish the two: it MAKES THE MACHINE BUSY and demands the
 * reading respond.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
// ISOLATED per run: paths.js derives the data directory from this,
// so a shared os.tmpdir() made every suite inherit whatever settings
// an earlier suite had written — an order-dependent gate that failed
// builds at random.
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

// getSystemMemoryInfo is Electron-only; machine.memory() needs it and this
// suite runs under plain node. os.totalmem/freemem give the same two numbers,
// in bytes, so convert to the KB shape the real API returns. Only memory is
// stubbed — the CPU path under test is untouched.
if (typeof process.getSystemMemoryInfo !== "function") {
    process.getSystemMemoryInfo = () => ({
        total: Math.round(os.totalmem() / 1024),
        free: Math.round(os.freemem() / 1024),
        swapTotal: Math.round((os.totalmem() * 1.5) / 1024),
        swapFree: Math.round(os.freemem() / 1024)
    });
}

const machine = require(__dirname + "/../.lcl.engine/core/machine.js");
const util = require(__dirname + "/../.lcl.engine/core/utilTools.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Saturate every thread for `ms`, in real child processes. */
function loadAllCores(ms) {
    const spin = `const end=Date.now()+${ms};let x=0;while(Date.now()<end){x+=Math.sqrt(x+1)}`;
    const kids = [];
    for (let i = 0; i < (os.cpus().length || 4); i++) {
        kids.push(spawn(process.execPath, ["-e", spin], { stdio: "ignore" }));
    }
    return Promise.all(kids.map(k => new Promise(r => k.on("exit", r))));
}

(async () => {
    /* ---- shape ---- */
    const c = machine.cpu();
    check("cpu() reports a model and a thread count",
        typeof c.model === "string" && c.model.length > 0 && c.threads > 0,
        { model: c.model, threads: c.threads });
    check("busyRatio is a ratio, not a percentage",
        typeof c.busyRatio === "number" && c.busyRatio >= 0 && c.busyRatio <= 1, c.busyRatio);
    check("the since-boot average is reported SEPARATELY, not as current load",
        typeof c.busyRatioSinceBoot === "number", c.busyRatioSinceBoot);
    check("a reading says how wide its sampling window was",
        typeof c.sampleMs === "number", c.sampleMs);

    /* ---- rapid successive calls must not produce noise ---- */
    {
        const burst = [];
        for (let i = 0; i < 40; i++) burst.push(machine.cpu().busyRatio);
        const bad = burst.filter(v => !(v >= 0 && v <= 1) || Number.isNaN(v));
        check("40 back-to-back calls never produce a NaN or out-of-range value",
            bad.length === 0, bad.slice(0, 5));
    }

    /* ---- cpuSampled: a real window, on demand ---- */
    {
        const s = await machine.cpuSampled(220);
        check("cpuSampled takes a real window", s.sampleMs >= 150, s.sampleMs);
        check("cpuSampled's value is in range",
            s.busyRatio >= 0 && s.busyRatio <= 1, s.busyRatio);
    }

    /* ---- THE POINT OF THIS FILE: the reading must track reality ---- */
    let quiet, busy, quietBoot, busyBoot;
    {
        await sleep(400);                       // settle
        quiet = (await machine.cpuSampled(500)).busyRatio;
        quietBoot = machine.cpu().busyRatioSinceBoot;

        // TEST THE ARITHMETIC, NOT WINDOWS' SCHEDULER.
        //
        // THREE versions of this failed a release build. First a flat 350 ms
        // sleep that sampled mid-spin-up. Then "busy > 0.5", which measures how
        // much spare CPU the machine happens to have. Then "rose by 0.20", which
        // is the same mistake in a smaller number — on a box already at 45% the
        // spinners cannot add 20 points, so it failed while the code was right.
        //
        // Every one of those spent a ten-minute build to discover something
        // about the machine rather than about the code. The unit under test is
        // the DELTA ARITHMETIC — the thing that was actually broken, when cpu()
        // divided cumulative since-boot counters and called the result current
        // load. That is pure arithmetic over tick counters, so it is tested with
        // tick counters it is handed, and the result is identical every run.
        // The counters must EXCEED the machine's REAL totals. cpu() only
        // advances its baseline when the tick delta is positive, and the
        // baseline was just advanced onto the real machine by cpuSampled
        // above — smaller synthetic numbers produce a negative delta, no
        // advance, and the same held reading every time. A flat 9e9 was used
        // here first and it was a time bomb: ticks() sums every thread, so a
        // 22-thread laptop crosses 9e9 after ~4.7 days of uptime, and the
        // suite started failing on a machine that had simply not rebooted
        // lately. Derive the base from the live counters instead — double
        // them and it exceeds reality by construction, forever.
        const realTotal = os.cpus().reduce((a, c) =>
            a + Object.values(c.times).reduce((x, y) => x + y, 0), 0);
        const BASE = Math.max(9_000_000_000, realTotal * 2);
        const realCpus = os.cpus;
        const ticks = (idle, busyTicks) => () => ([{
            model: "synthetic", speed: 3000,
            times: { user: busyTicks, nice: 0, sys: 0, idle, irq: 0 }
        }]);
        try {
            // a machine that has been up a long time at 10% average
            // cpu() refuses to divide by a near-zero window: below MIN_SAMPLE_MS
            // it holds the previous reading rather than inventing one from noise.
            // That is correct behaviour and the test has to honour it — a first
            // pass fired all four readings inside one millisecond and got the
            // same stale number four times.
            os.cpus = ticks(BASE * 0.9, BASE * 0.1);
            machine.cpu();                       // prime the baseline onto synthetic ticks
            await sleep(260);
            const boot = machine.cpu().busyRatioSinceBoot;
            check("the since-boot figure is the lifetime average",
                Math.abs(boot - 0.10) < 0.001, boot);

            // one second later, every tick of it busy
            os.cpus = ticks(BASE * 0.9, BASE * 0.1 + 1_000_000);
            await sleep(260);
            const hot = machine.cpu();
            check("current load reads the DELTA, not the lifetime average",
                hot.busyRatio > 0.99, hot.busyRatio);
            check("while the lifetime average has barely moved",
                Math.abs(hot.busyRatioSinceBoot - 0.10) < 0.002, hot.busyRatioSinceBoot);
            check("so the two disagree by the width of the original bug",
                hot.busyRatio - hot.busyRatioSinceBoot > 0.85,
                { current: hot.busyRatio, sinceBoot: hot.busyRatioSinceBoot });

            // and the reverse: idle after a busy period must read near zero
            os.cpus = ticks(BASE * 0.9 + 1_000_000, BASE * 0.1 + 1_000_000);
            await sleep(260);
            const cold = machine.cpu();
            check("an idle interval reads near zero, whatever the lifetime says",
                cold.busyRatio < 0.01, cold.busyRatio);
        } finally {
            os.cpus = realCpus;
        }

        // One live sanity reading, with no threshold: it must be a real ratio.
        quiet = (await machine.cpuSampled(300)).busyRatio;
        busy = quiet;
        quietBoot = machine.cpu().busyRatioSinceBoot;
        busyBoot = quietBoot;
        check("a live sample is still a ratio between 0 and 1",
            quiet >= 0 && quiet <= 1, quiet);
    }

    /* ---- and the tool the model calls reports both ---- */
    {
        const stats = await util.systemStats();
        check("system_stats returns a promise resolving to stats",
            !!(stats && stats.cpu && stats.memory));
        check("system_stats reports current busy percent",
            Number.isInteger(stats.cpu.busyPercent)
            && stats.cpu.busyPercent >= 0 && stats.cpu.busyPercent <= 100,
            stats.cpu.busyPercent);
        check("system_stats labels the since-boot average as such",
            Number.isInteger(stats.cpu.busyPercentSinceBoot), stats.cpu.busyPercentSinceBoot);
    }

    /* ---- the panel's inventory takes a real sample too ---- */
    {
        // isolate the CPU claim: resourcesPath is Electron-only (findModel needs
        // it) and probeGpu spawns the engine binary, which has no business in a
        // load test. Neither touches the sampling path under test.
        process.resourcesPath = path.join(__dirname, "..");
        machine.probeGpu = async () => ({ devices: [], note: "stubbed for this test" });
        const inv = await machine.inventory();
        check("machineInventory's cpu reading is sampled, not since-boot",
            inv.cpu && inv.cpu.sampleMs > 0, inv.cpu && inv.cpu.sampleMs);
    }

    console.log(`\n${pass}/${pass + fail} machine-load checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(1); });
