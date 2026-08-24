/**
 * The task ledger — "the app must never lose sight of running work".
 *
 * The load-bearing property is the RECOVERY INVARIANT: a task marked "running"
 * in a freshly started process is a lie, because nothing can have been running
 * before the process existed. Anything found in that state died with a previous
 * run and must be reclassified as interrupted — turning a job that silently
 * vanished into a visible fact.
 *
 * Also checked: cancellation actually trips the token a worker polls, a
 * cancelled index leaves consistent state, and the ledger never throws in a way
 * that could break the work it is only supposed to observe.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-tasks-"));
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const tasks = require(__dirname + "/../.lcl.engine/core/tasks.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}
const ledgerFile = () => path.join(DATA, "data", "tasks.json");

(async () => {
    // ---- start / progress / finish ----
    const { id, cancelToken } = tasks.start({ kind: "index", title: "Indexing darkroom notes" });
    check("start returns an id and a live cancel token",
        !!id && cancelToken && cancelToken.cancelled === false);
    check("a started task is listed as running",
        tasks.list()[0].status === "running", tasks.list()[0]);
    check("a start is written to disk immediately", fs.existsSync(ledgerFile()));

    tasks.progress(id, "reading page_004.png");
    check("progress updates the row's detail",
        tasks.list()[0].detail === "reading page_004.png");

    check("active() sees the running task", tasks.active().length === 1);
    check("the task reports elapsed time",
        typeof tasks.list()[0].elapsedMs === "number" && tasks.list()[0].elapsedMs >= 0);

    tasks.finish(id, "done", "1651 files · 3787 passages");
    const done = tasks.list()[0];
    check("finish records the outcome and an end time",
        done.status === "done" && !!done.endedAt && /3787/.test(done.detail), done);
    check("a finished task is no longer active", tasks.active().length === 0);
    check("a finished task's token is released", done.live === false);

    // ---- cancellation: the point is that a WORKER can observe it ----
    const b = tasks.start({ kind: "index", title: "Indexing again" });
    const res = tasks.cancel(b.id);
    check("cancel reports the task is stopping",
        res.ok && res.status === "cancelling", res);
    check("cancel TRIPS the token the worker polls",
        b.cancelToken.cancelled === true);
    check("the row shows as cancelling until the worker confirms",
        tasks.list()[0].status === "cancelling");
    tasks.finish(b.id, "cancelled", "stopped at 412 files");
    check("the worker's confirmation settles it as cancelled",
        tasks.list()[0].status === "cancelled");

    check("cancelling an unknown task is refused, not thrown",
        tasks.cancel("nope").ok === false);
    check("cancelling an already-finished task is refused",
        tasks.cancel(b.id).ok === false);

    // ---- THE RECOVERY INVARIANT ----
    // simulate a crash: a task left "running" on disk, then a fresh process
    const c = tasks.start({ kind: "index", title: "Killed mid-run" });
    check("the crashed task is on disk as running",
        JSON.parse(fs.readFileSync(ledgerFile(), "utf8")).tasks
            .find(t => t.id === c.id).status === "running");

    tasks._reset();                      // as if the app had been restarted
    const after = tasks.list().find(t => t.id === c.id);
    check("a 'running' task from a dead process becomes INTERRUPTED",
        after && after.status === "interrupted", after);
    check("the interrupted task explains itself to the user",
        after && /stopped before this finished/i.test(after.note || ""), after && after.note);
    check("the interrupted task is stamped with an end time", !!after.endedAt);
    check("recovery is persisted, not just in memory",
        JSON.parse(fs.readFileSync(ledgerFile(), "utf8")).tasks
            .find(t => t.id === c.id).status === "interrupted");
    check("an interrupted task is not reported as active",
        !tasks.active().some(t => t.id === c.id));
    check("an interrupted task cannot be 'stopped' (its process is gone)",
        tasks.cancel(c.id).ok === false || tasks.list().find(t => t.id === c.id).status === "interrupted");

    // finished rows clear; running ones never do
    const live = tasks.start({ kind: "index", title: "Still going" });
    const cleared = tasks.clearFinished();
    check("clearFinished removes completed rows", cleared.cleared > 0, cleared);
    check("clearFinished never removes a running task",
        tasks.list().some(t => t.id === live.id && t.status === "running"));

    // shutdown: every live token trips so workers stop at a safe point
    const n = tasks.cancelAll();
    check("cancelAll trips live tokens for a clean shutdown",
        n > 0 && live.cancelToken.cancelled === true, { n });

    // ---- the ledger must never break the work it observes ----
    check("progress on an unknown id is a no-op, not a throw",
        (() => { try { tasks.progress("ghost", "x"); return true; } catch { return false; } })());
    check("finish on an unknown id is a no-op, not a throw",
        (() => { try { return tasks.finish("ghost", "done") === null; } catch { return false; } })());

    // a corrupt ledger must degrade to "no history", never crash the app
    // --- real progress rides in meta: n/total survive updates AND restarts ---
    {
        const t = tasks.start({ kind: "index", title: "progress carrier" });
        tasks.progress(t.id, "working through files", { n: 12, total: 300 });
        tasks.progress(t.id, undefined, { n: 150, total: 300 });
        const row = tasks.list().find(x => x.id === t.id);
        check("progress meta carries n/total", row.meta.n === 150 && row.meta.total === 300);
        check("a meta-only update keeps the last detail",
            row.detail === "working through files", row.detail);
        tasks.finish(t.id, "done");
        const done = tasks.list().find(x => x.id === t.id);
        check("finished rows keep their final progress numbers",
            done.meta.n === 150 && done.meta.total === 300);
    }

    fs.writeFileSync(ledgerFile(), "{ this is not json", "utf8");
    tasks._reset();
    check("a corrupt ledger file degrades to an empty history",
        Array.isArray(tasks.list()) && tasks.list().length === 0);
    const recovered = tasks.start({ kind: "index", title: "after corruption" });
    check("the ledger keeps working after corruption", !!recovered.id && tasks.list().length === 1);

    // the ledger is bounded so it cannot grow without limit
    for (let i = 0; i < tasks.MAX_TASKS + 40; i++) {
        const t = tasks.start({ kind: "x", title: "t" + i });
        tasks.finish(t.id, "done");
    }
    const size = JSON.parse(fs.readFileSync(ledgerFile(), "utf8")).tasks.length;
    check("the ledger is capped and does not grow unbounded",
        size <= tasks.MAX_TASKS, { size, cap: tasks.MAX_TASKS });

    fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} task-ledger checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
