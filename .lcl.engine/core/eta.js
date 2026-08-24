const fs = require("fs");
const path = require("path");
const paths = require("./paths");

/**
 * HOW LONG IS THIS GOING TO TAKE?
 *
 * The rule this file implements:
 *
 *   Give some idea of how long something will take to run, as soon as the
 *   request is submitted, without wasting memory computing it. Update it as the
 *   model runs so it becomes accurate. It can start as nothing — no indication
 *   of how long the expected task will take.
 *
 * So:
 *
 *   START AS NOTHING.  A machine that has never done this work does not know
 *   how long it takes, and a fabricated number is worse than a blank. `null`
 *   means "no idea yet" and the UI shows nothing at all.
 *
 *   ANSWER AT SUBMIT.  Once this machine HAS done the work before, the answer
 *   is available on the first tick — no warm-up, no waiting for the job to
 *   reveal itself. That is what makes the estimate useful rather than a
 *   countdown you read after you have already stopped caring.
 *
 *   BECOME ACCURATE.  History is a prior, not a verdict. The live rate of the
 *   run in progress takes over as evidence accumulates, so a cold cache, a busy
 *   machine or an unusually dense repository corrects itself within seconds
 *   instead of insisting on last week's number.
 *
 *   COST NOTHING.  One EWMA per work-kind, a few dozen bytes, written once when
 *   a run ENDS. A tick is two multiplications and no allocation. Nothing about
 *   forecasting is allowed to compete with the work being forecast.
 *
 * Everything is keyed by KIND OF UNIT, never by task: "index:file",
 * "index:page", "ocr:page", "vision:page", "generate:token". A page of scanned
 * spec and a page of source code are different work and are learned separately.
 */

// Exponential moving average: how much a new observation moves the stored rate.
// 0.3 converges in a handful of runs while surviving one weird outlier.
const EWMA_ALPHA = 0.3;

// Live rate needs a few units before it means anything — the first unit of any
// job carries model load, cache warm-up and first-page costs that do not repeat.
const MIN_LIVE_UNITS = 3;

// After this many units the live run is trusted completely and history stops
// pulling. Tuned so a 400-file index is live-driven for ~90% of its length.
const FULL_TRUST_UNITS = 40;

// Anything slower than this per unit is a stall, not a rate; do not learn it.
const SANE_MAX_MS_PER_UNIT = 30 * 60_000;

let cache = null;              // { "index:file": { msPerUnit, samples } }
let dirty = false;

function file() {
    return path.join(paths.dataDir(), "rates.json");
}

function load() {
    if (cache) return cache;
    try {
        cache = JSON.parse(fs.readFileSync(file(), "utf8"));
        if (!cache || typeof cache !== "object") cache = {};
    } catch { cache = {}; }
    return cache;
}

/** Written on completion only — never on a tick. */
function flush() {
    if (!dirty) return;
    dirty = false;
    try {
        const f = file();
        const tmp = f + ".tmp-" + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(cache), "utf8");
        fs.renameSync(tmp, f);
    } catch { /* a forecast is never worth failing a job over */ }
}

/** What this machine has learned about `kind`, or null if it has never seen it. */
function known(kind) {
    const c = load()[String(kind)];
    return c && c.msPerUnit > 0 ? c : null;
}

/** Fold a completed run's measured rate into the stored average. */
function learn(kind, units, elapsedMs) {
    if (!kind || !(units > 0) || !(elapsedMs > 0)) return;
    const msPerUnit = elapsedMs / units;
    if (msPerUnit > SANE_MAX_MS_PER_UNIT) return;
    const c = load();
    const prev = c[kind];
    c[kind] = prev && prev.msPerUnit > 0
        ? { msPerUnit: prev.msPerUnit * (1 - EWMA_ALPHA) + msPerUnit * EWMA_ALPHA,
            samples: Math.min((prev.samples || 0) + 1, 999) }
        : { msPerUnit, samples: 1 };
    dirty = true;
    flush();
}

/**
 * Start tracking one run.
 *
 * @param kind  unit kind, e.g. "index:file"
 * @param total total units if known; may be supplied later via tick()
 *
 * The returned tracker is a plain object with two live numbers on it. There is
 * no timer, no interval, and no work done between ticks.
 */
function track(kind, total = 0) {
    const startedAt = Date.now();
    const prior = known(kind);

    const t = {
        kind,
        total: total || 0,
        done: 0,
        startedAt,
        // available IMMEDIATELY when this machine has done the work before —
        // this is the "as soon as the request is submitted" number
        initialEtaMs: prior && total ? Math.round(prior.msPerUnit * total) : null,

        /**
         * Record progress. Returns the current forecast, or null while there is
         * honestly nothing to say.
         *
         * @returns {null | {etaMs, msPerUnit, basis, confidence, done, total}}
         */
        tick(done, totalNow) {
            if (totalNow > 0) t.total = totalNow;
            if (done >= 0) t.done = done;
            const remaining = t.total - t.done;
            if (!t.total || remaining <= 0) return null;

            const elapsed = Date.now() - t.startedAt;
            const live = t.done >= MIN_LIVE_UNITS && elapsed > 0
                ? elapsed / t.done
                : null;

            let msPerUnit, basis;
            if (live !== null && prior) {
                // weight the live rate in as the run proves itself
                const w = Math.min(1, t.done / FULL_TRUST_UNITS);
                msPerUnit = prior.msPerUnit * (1 - w) + live * w;
                basis = w >= 0.999 ? "live" : "blend";
            } else if (live !== null) {
                msPerUnit = live;
                basis = "live";
            } else if (prior) {
                msPerUnit = prior.msPerUnit;
                basis = "history";
            } else {
                // never done this before and not enough of it done yet:
                // SAY NOTHING. This is the blank the design calls for.
                return null;
            }

            return {
                etaMs: Math.round(msPerUnit * remaining),
                msPerUnit,
                basis,
                // 0..1 — how much of this number came from the run in progress
                confidence: live === null ? 0.25
                    : Math.min(1, 0.4 + 0.6 * (t.done / FULL_TRUST_UNITS)),
                done: t.done,
                total: t.total
            };
        },

        /** Call once when the run ends successfully, so the next one is faster to predict. */
        commit(units = t.done) {
            learn(kind, units, Date.now() - startedAt);
        }
    };
    return t;
}

/** "2m 40s", "45s", "under a second" — short enough for a progress row. */
function human(ms) {
    if (!(ms > 0)) return "";
    const s = Math.round(ms / 1000);
    if (s < 1) return "under a second";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** Everything this machine has learned — for the UI and for tests. */
function all() {
    const c = load();
    return Object.entries(c).map(([kind, v]) => ({
        kind, msPerUnit: v.msPerUnit, samples: v.samples
    })).sort((a, b) => a.kind.localeCompare(b.kind));
}

function reset() { cache = {}; dirty = true; flush(); }

module.exports = { track, known, learn, human, all, reset,
                   MIN_LIVE_UNITS, FULL_TRUST_UNITS };
