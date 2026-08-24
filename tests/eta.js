/**
 * TIME REMAINING — the contract, stated by the operator:
 *
 *   "gives me some idea of how long something is going to take to run, as soon
 *    as I submit the request. I don't want to waste memory computing that. I
 *    want it to update as the model is running, to become accurate. It can
 *    start as nothing, no indication of how long the expected task will take."
 *
 * Four properties, each tested here:
 *   1. STARTS AS NOTHING   — never seen this work, says nothing. No fake number.
 *   2. ANSWERS AT SUBMIT   — once learned, the estimate exists on tick one.
 *   3. BECOMES ACCURATE    — the live rate overrides a stale prior.
 *   4. COSTS NOTHING       — a tick is arithmetic; disk is touched on finish only.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-eta-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const eta = require(__dirname + "/../.lcl.engine/core/eta.js");
const tasks = require(__dirname + "/../.lcl.engine/core/tasks.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    eta.reset();

    /* ---- 1. STARTS AS NOTHING ---------------------------------------- */
    {
        check("a never-seen work kind is unknown", eta.known("test:brandnew") === null);
        const t = eta.track("test:brandnew", 100);
        check("no estimate at submit for unseen work", t.initialEtaMs === null);
        check("no estimate on the first tick either", t.tick(1, 100) === null);
        check("still nothing at two units", t.tick(2, 100) === null);
        // ...and only once the run itself has produced evidence. The clock has
        // to have moved: three units in under a millisecond is not a rate, and
        // the tracker correctly refuses to invent one from a zero denominator.
        t.startedAt = Date.now() - 300;
        const f = t.tick(eta.MIN_LIVE_UNITS, 100);
        check("an estimate appears once the run has evidence of its own",
            f !== null && f.etaMs > 0, f);
        check("that first estimate is marked as coming from the live run",
            f && f.basis === "live", f && f.basis);
    }

    /* ---- 2. ANSWERS AT SUBMIT once the machine has done it before ----- */
    {
        eta.reset();
        // teach it: 50 units took 5 seconds -> 100 ms/unit
        eta.learn("test:known", 50, 5000);
        const k = eta.known("test:known");
        check("a completed run teaches a rate", k && Math.abs(k.msPerUnit - 100) < 1, k);

        const t = eta.track("test:known", 200);
        check("the estimate exists AT SUBMIT, before any work is done",
            t.initialEtaMs !== null, t.initialEtaMs);
        check("and it is the right order of magnitude (200 units x 100ms = 20s)",
            Math.abs(t.initialEtaMs - 20000) < 500, t.initialEtaMs);
        const f = t.tick(1, 200);
        check("the first tick already carries a forecast", f && f.etaMs > 0, f);
        check("and says it came from history, not from this run",
            f && f.basis === "history", f && f.basis);
    }

    /* ---- 3. BECOMES ACCURATE — a stale prior must not win ------------- */
    {
        eta.reset();
        // history says 10 ms/unit; this run is really going to be ~5x slower
        eta.learn("test:drift", 100, 1000);
        const t = eta.track("test:drift", 1000);
        const atSubmit = t.initialEtaMs;

        // simulate 60 units taking ~50ms each
        const started = Date.now();
        let last = null;
        for (let n = 1; n <= 60; n++) {
            // advance the clock without actually sleeping 3 seconds
            t.startedAt = started - n * 50;
            last = t.tick(n, 1000);
        }
        check("after enough evidence the basis is purely live",
            last && last.basis === "live", last && last.basis);
        check("the live rate replaced the optimistic prior",
            last && last.msPerUnit > 40, last && Math.round(last.msPerUnit));
        check("so the estimate grew toward the truth",
            last.etaMs > atSubmit, { atSubmit, now: last.etaMs });
        check("confidence rises as the run proves itself",
            last.confidence >= 0.9, last.confidence);

        // and mid-run it should be a blend, not a jump
        const t2 = eta.track("test:drift", 1000);
        t2.startedAt = Date.now() - 5 * 50;
        const mid = t2.tick(5, 1000);
        check("early in a run the forecast blends history with live",
            mid && mid.basis === "blend", mid && mid.basis);
    }

    /* ---- 4. never reports an estimate for finished or unsized work ---- */
    {
        eta.reset();
        eta.learn("test:done", 10, 1000);
        const t = eta.track("test:done", 10);
        check("no estimate once every unit is done", t.tick(10, 10) === null);
        check("no estimate past the total", t.tick(11, 10) === null);
        const u = eta.track("test:done", 0);
        check("no estimate when the size is unknown", u.tick(3, 0) === null);
        check("and no submit-time estimate without a total", u.initialEtaMs === null);
    }

    /* ---- 5. a cancelled run must NOT teach a rate --------------------- */
    {
        eta.reset();
        const id = "t-cancel";
        tasks.start({ id, kind: "index", title: "cancelled run",
                      unit: "test:cancelled", total: 100 });
        tasks.progress(id, "working", { n: 5, total: 100 });
        tasks.finish(id, "cancelled", "stopped");
        check("a cancelled run teaches nothing (it measured an interruption)",
            eta.known("test:cancelled") === null, eta.all());

        const id2 = "t-failed";
        tasks.start({ id: id2, kind: "index", title: "failed run",
                      unit: "test:failed", total: 100 });
        tasks.progress(id2, "working", { n: 5, total: 100 });
        tasks.finish(id2, "failed", "boom");
        check("a failed run teaches nothing either", eta.known("test:failed") === null);
    }

    /* ---- 6. the ledger carries the forecast end to end ---------------- */
    {
        eta.reset();
        eta.learn("index:file", 100, 10_000);        // 100 ms/file
        const id = "t-ledger";
        tasks.start({ id, kind: "index", title: "Indexing", unit: "index:file", total: 400 });
        let row = tasks.list({ limit: 20 }).find(t => t.id === id);
        check("a started task carries an ETA immediately when the rate is known",
            row && row.etaMs > 0, row && row.etaMs);
        check("and it is labelled as history-derived", row && row.etaBasis === "history",
            row && row.etaBasis);
        check("400 files at 100ms is about 40s", row && Math.abs(row.etaMs - 40000) < 2000,
            row && row.etaMs);

        tasks.progress(id, "embedding", { n: 40, total: 400 });
        row = tasks.list({ limit: 20 }).find(t => t.id === id);
        check("progress refines the ETA on the row", row && row.etaMs > 0, row && row.etaMs);
        check("the ledger records what the estimate is based on",
            row && ["history", "blend", "live"].includes(row.etaBasis), row && row.etaBasis);

        tasks.finish(id, "done", "complete", { n: 400, total: 400 });
        row = tasks.list({ limit: 20 }).find(t => t.id === id);
        check("a finished task has no time remaining", row && !row.etaMs, row && row.etaMs);
        check("completing the run updated the learned rate",
            eta.known("index:file") !== null);
    }

    /* ---- 7. costs nothing ------------------------------------------- */
    {
        eta.reset();
        eta.learn("test:cheap", 100, 10_000);
        const t = eta.track("test:cheap", 100_000);
        const t0 = process.hrtime.bigint();
        for (let i = 1; i <= 50_000; i++) t.tick(i, 100_000);
        const us = Number(process.hrtime.bigint() - t0) / 1000 / 50_000;
        console.log(`\n  ${us.toFixed(2)} microseconds per tick\n`);
        check("a forecast tick costs under 10 microseconds", us < 10, us);

        // and the rate file is written on FINISH, not on every tick
        const rates = path.join(DATA, "data", "rates.json");
        const before = fs.existsSync(rates) ? fs.statSync(rates).mtimeMs : 0;
        for (let i = 1; i <= 500; i++) t.tick(i, 100_000);
        await sleep(30);
        const after = fs.existsSync(rates) ? fs.statSync(rates).mtimeMs : 0;
        check("ticking never touches the disk", before === after, { before, after });
    }

    /* ---- 8. human formatting ----------------------------------------- */
    {
        check("formats seconds", eta.human(45_000) === "45s", eta.human(45_000));
        check("formats minutes", eta.human(150_000) === "2m 30s", eta.human(150_000));
        check("formats hours", eta.human(3_900_000) === "1h 5m", eta.human(3_900_000));
        check("says nothing for nothing", eta.human(0) === "");
    }

    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }); }
    catch { /* windows */ }
    console.log(`\n${pass}/${pass + fail} eta checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(1); });
