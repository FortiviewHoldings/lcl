const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const eta = require("./eta");

/**
 * A DURABLE LEDGER of long-running work.
 *
 * Indexing a library can run for an hour. Before this, that work existed only
 * as rows in a renderer Map and a Set of ids in the main process: quitting the
 * app, or crashing, erased every trace of it. You could not tell whether a job
 * had finished, been interrupted, or never started — and you could not stop
 * one once it began.
 *
 * So the ledger is written to disk as work happens, and the invariant is:
 *
 *   a task marked "running" in a FRESH process is a lie
 *
 * Nothing can be running before this process started, so on load any surviving
 * "running" row is reclassified as interrupted, stamped with when we noticed.
 * That turns the silent failure — a job that vanished — into a visible fact the
 * UI can show and the user can act on.
 *
 * Cancellation lives here too, because "see the work" and "stop the work" are
 * the same need. Tokens are per-process (a token cannot outlive its worker), so
 * they are held in memory and keyed by the same task id the ledger uses.
 */

const MAX_TASKS = 200;              // keep the ledger small and readable
const WRITE_DEBOUNCE_MS = 400;      // progress is chatty; disk is not

let cache = null;
let writeTimer = null;
let dirty = false;
// taskId -> eta tracker. In memory only: a forecast for a run that did not
// survive a restart is meaningless, and the LEARNED rates persist separately.
const trackers = new Map();

// live cancel tokens, by task id — deliberately NOT persisted
const tokens = new Map();

function file() {
    return path.join(paths.dataDir(), "tasks.json");
}

function load() {
    if (cache) return cache;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file(), "utf8")); }
    catch { raw = { tasks: [] }; }
    const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];

    // THE INVARIANT: this process just started, so nothing it did not start can
    // be running. Anything still marked running died with a previous process.
    const now = new Date().toISOString();
    let recovered = 0;
    for (const t of tasks) {
        if (t.status === "running" || t.status === "cancelling") {
            t.status = "interrupted";
            t.endedAt = t.endedAt || now;
            t.detail = t.detail || "";
            t.note = "the app stopped before this finished";
            recovered++;
        }
    }
    cache = { tasks };
    if (recovered) flush(true);
    return cache;
}

function flush(immediate = false) {
    dirty = true;
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    const doWrite = () => {
        writeTimer = null;
        if (!dirty || !cache) return;
        dirty = false;
        try {
            cache.tasks = cache.tasks.slice(-MAX_TASKS);
            // write-then-rename: a crash mid-write must not leave a truncated
            // ledger that reads as "no history at all"
            const tmp = file() + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify({ tasks: cache.tasks }), "utf8");
            fs.renameSync(tmp, file());
        } catch { /* the ledger is best-effort; never break the work it tracks */ }
    };
    if (immediate) doWrite();
    else { writeTimer = setTimeout(doWrite, WRITE_DEBOUNCE_MS); if (writeTimer.unref) writeTimer.unref(); }
}

/** Begin tracking a task. Returns { id, cancelToken } — pass the token to the
 *  worker so the user can actually stop it. */
function start({ id, kind = "task", title, detail = "", cancellable = true,
                 meta = {}, unit = null, total = 0, sessionId = null, scope = null }) {
    const db = load();
    const taskId = id || `${kind}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
    // a re-run of the same id replaces the old row rather than duplicating it
    const existing = db.tasks.findIndex(t => t.id === taskId);

    // What kind of UNIT does this task consume? "index:file" is learned
    // separately from "index:page" because they are not the same work. Falls
    // back to the task kind so any caller gets a forecast for free.
    const unitKind = unit || `${kind}:unit`;
    const tracker = eta.track(unitKind, total);
    trackers.set(taskId, tracker);

    const row = {
        id: taskId, kind, title: String(title || kind).slice(0, 120),
        detail: String(detail).slice(0, 200),
        status: "running", cancellable: !!cancellable,
        startedAt: new Date().toISOString(), endedAt: null,
        unit: unitKind,
        // The "as soon as I submit" number: present only when this machine has
        // done this kind of work before AND the size is known. Otherwise null,
        // and the UI shows nothing rather than inventing a duration.
        etaMs: tracker.initialEtaMs,
        etaBasis: tracker.initialEtaMs ? "history" : null,
        // WHO THIS WORK BELONGS TO. Without these two, hydration after a
        // restart could not tell one session's serve from another's — the
        // whole ledger painted into whatever session was open ("4 stale
        // rows, all serving the workspace"). scope "library" = app-wide.
        sessionId: sessionId || null,
        scope: scope || null,
        meta
    };
    if (existing >= 0) db.tasks[existing] = row; else db.tasks.push(row);

    const cancelToken = { cancelled: false, id: taskId };
    if (cancellable) tokens.set(taskId, cancelToken);
    flush(true);                      // a start is worth an immediate write
    return { id: taskId, cancelToken };
}

/** Progress. Debounced — this is called many times a second during indexing. */
function progress(id, detail, meta) {
    const db = load();
    const t = db.tasks.find(x => x.id === id);
    if (!t || t.status !== "running") return;
    if (detail !== undefined) t.detail = String(detail).slice(0, 200);
    if (meta) t.meta = { ...t.meta, ...meta };

    // Refine the forecast from what this run is ACTUALLY doing. Two
    // multiplications; no allocation, no timer, nothing written to disk here.
    const tr = trackers.get(id);
    if (tr && t.meta && Number.isFinite(t.meta.n)) {
        const f = tr.tick(t.meta.n, t.meta.total || 0);
        if (f) {
            t.etaMs = f.etaMs;
            t.etaBasis = f.basis;       // history | blend | live
            t.etaConfidence = f.confidence;
        }
    }
    flush();
}

/** Finish a task: "done", "failed", or "cancelled". */
function finish(id, status = "done", detail = "", meta) {
    const db = load();
    const t = db.tasks.find(x => x.id === id);
    tokens.delete(id);
    const tr = trackers.get(id);
    trackers.delete(id);
    if (!t) return null;
    t.status = status;
    t.endedAt = new Date().toISOString();
    if (detail) t.detail = String(detail).slice(0, 200);
    if (meta) t.meta = { ...t.meta, ...meta };
    t.etaMs = null;                    // finished work has no time remaining
    t.etaBasis = null;
    // Only a run that COMPLETED teaches a rate. A cancelled or failed job stopped
    // for reasons unrelated to how fast the work is, and learning from it would
    // poison every future estimate with a number that measured an interruption.
    if (status === "done" && tr) {
        const units = (meta && meta.n) || (t.meta && t.meta.n) || tr.done;
        if (units > 0) tr.commit(units);
    }
    flush(true);
    return t;
}

/**
 * Ask a task to stop. This does NOT kill anything — it trips the token the
 * worker polls, so the worker stops at a safe point and leaves consistent
 * state. A task with no live token cannot be cancelled from here (it belongs
 * to a process that is already gone).
 */
function cancel(id) {
    const db = load();
    const t = db.tasks.find(x => x.id === id);
    if (!t) return { ok: false, error: "unknown task" };
    if (t.status !== "running") return { ok: false, error: `task is already ${t.status}` };
    const token = tokens.get(id);
    if (!token) {
        // no token: it cannot still be running in THIS process
        t.status = "interrupted";
        t.endedAt = new Date().toISOString();
        t.note = "no longer running";
        flush(true);
        return { ok: true, status: "interrupted" };
    }
    token.cancelled = true;
    t.status = "cancelling";
    t.detail = "stopping…";
    flush(true);
    return { ok: true, status: "cancelling" };
}

/** Recent tasks, newest first. `activeOnly` for the panel's live section. */
function list({ activeOnly = false, limit = 50 } = {}) {
    const db = load();
    let rows = db.tasks.slice().reverse();
    if (activeOnly) rows = rows.filter(t => t.status === "running" || t.status === "cancelling");
    return rows.slice(0, limit).map(t => ({
        ...t,
        elapsedMs: (t.endedAt ? Date.parse(t.endedAt) : Date.now()) - Date.parse(t.startedAt),
        live: tokens.has(t.id)
    }));
}

/** Anything still marked running — used to warn before quitting. */
function active() {
    return list({ activeOnly: true });
}

/** Drop finished rows. Running ones are never cleared. */
function clearFinished() {
    const db = load();
    const before = db.tasks.length;
    db.tasks = db.tasks.filter(t => t.status === "running" || t.status === "cancelling");
    flush(true);
    return { cleared: before - db.tasks.length };
}

/** Trip every live token — for shutdown, so workers stop at a safe point. */
function cancelAll() {
    let n = 0;
    for (const [, token] of tokens) { token.cancelled = true; n++; }
    const db = load();
    for (const t of db.tasks) {
        if (t.status === "running") { t.status = "cancelling"; n++; }
    }
    flush(true);
    return n;
}

/** Test seam: forget in-memory state so a fresh load() re-reads the file. */
function _reset() {
    cache = null; tokens.clear(); dirty = false;
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
}

module.exports = {
    start, progress, finish, cancel, list, active, clearFinished, cancelAll,
    _reset, MAX_TASKS
};
