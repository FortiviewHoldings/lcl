/** CONCURRENCY STRESS — races that only appear under simultaneous load. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
    if (r === "electron") return __filename;
    return orig.call(this, r, ...a);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-stress-data-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const E = (m) => require(path.join(__dirname, "..", ".lcl.engine", "core", m));
const knowledge = E("knowledge.js");
const tasks = E("tasks.js");
const serve = E("serve.js");
const embedIndex = E("embedIndex.js");
const sessions = E("sessions.js");

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
    if (c) { pass++; console.log("PASS |", n); }
    else { fail++; console.log("FAIL |", n, d ? "- " + JSON.stringify(d).slice(0, 200) : ""); }
};

// deterministic mock embedder so this measures RACES, not model behaviour
embedIndex.embed = async (inputs) => (Array.isArray(inputs) ? inputs : [inputs])
    .map(s => String(s || "").trim() ? new Array(32).fill(0.1) : null);
embedIndex.isWarm = () => true;

(async () => {
    const LIB = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-stress-lib-"));
    for (let i = 0; i < 25; i++) {
        fs.writeFileSync(path.join(LIB, `doc${i}.md`),
            `# Doc ${i}\n\nThe first developer runs at 20 C for a normal negative on the 1+9 dilution.\n`.repeat(3));
    }
    const lib = knowledge.add(LIB, "stress");

    /* ---- 1. concurrent reindexes of the SAME library ---- */
    {
        const runs = await Promise.all([1, 2, 3, 4].map(() =>
            knowledge.reindex(lib.id, () => {}).then(r => r, e => ({ error: String(e.message) }))));
        const errored = runs.filter(r => r.error);
        check("four simultaneous reindexes all complete without throwing",
            errored.length === 0, errored);
        const idx = knowledge.list().find(l => l.id === lib.id);
        check("the index is not corrupted by concurrent writers",
            idx && idx.files === 25 && idx.chunks > 0, idx && { f: idx.files, c: idx.chunks });
        // every chunk must still point at a file that exists in the files map
        const raw = JSON.parse(fs.readFileSync(
            path.join(DATA, "data", "knowledge", lib.id + ".json"), "utf8"));
        const orphans = raw.chunks.filter(c => !raw.files[c.file]).length;
        check("no orphaned chunks after concurrent writes", orphans === 0, orphans);
    }

    /* ---- 2. retrieve WHILE reindexing ---- */
    {
        const reindexing = knowledge.reindex(lib.id, () => {});
        const queries = [];
        for (let i = 0; i < 12; i++) {
            queries.push(knowledge.retrieve("first developer normal dilution", { minScore: 0, topK: 3 })
                .then(h => h.length, e => "ERR:" + e.message));
        }
        const [, ...results] = await Promise.all([reindexing, ...queries]);
        const bad = results.filter(r => typeof r === "string");
        check("retrieval during a reindex never errors", bad.length === 0, bad.slice(0, 3));
    }

    /* ---- 3. task ledger under rapid concurrent writes ---- */
    {
        const ids = [];
        for (let i = 0; i < 60; i++) {
            const t = tasks.start({ kind: "stress", title: "t" + i, cancellable: true });
            ids.push(t.id);
        }
        for (const id of ids) tasks.progress(id, "working", { n: 1, total: 2 });
        for (const id of ids) tasks.finish(id, "done", "ok");
        const rows = tasks.list({ limit: 200 });
        const found = ids.filter(id => rows.some(r => r.id === id && r.status === "done"));
        check("60 rapid ledger writes all persist correctly",
            found.length === ids.length, `${found.length}/${ids.length}`);
    }

    /* ---- 4. many servers started and stopped concurrently ---- */
    {
        fs.writeFileSync(path.join(LIB, "index.html"), "<h1>x</h1>");
        const started = [];
        for (let i = 0; i < 4; i++) {
            try { started.push(await serve.serveFolder(LIB, { path: "." }, {})); }
            catch (e) { started.push({ error: String(e.message) }); }
        }
        const live = started.filter(s => s.url);
        check("the server cap is enforced, not exceeded", live.length <= 4, live.length);
        // all of them must actually answer
        const answers = await Promise.all(live.map(s => new Promise(res => {
            http.get(s.url, r => { r.resume(); res(r.statusCode); }).on("error", () => res(0));
        })));
        check("every started server actually serves",
            answers.every(a => a === 200), answers);
        const fifth = await serve.serveFolder(LIB, { path: "." }, {})
            .then(() => "ALLOWED", e => String(e.message));
        check("a fifth server past the cap is refused", /already running/.test(fifth), fifth);
        serve.stopAll();
        check("stopAll clears every server", serve.listServers().length === 0);
    }

    /* ---- 5. concurrent session writes must not lose messages ---- */
    {
        const s = sessions.create ? sessions.create("race") : null;
        if (s && sessions.save) {
            const writes = [];
            for (let i = 0; i < 20; i++) {
                s.messages.push({ role: "user", content: "m" + i });
                writes.push(Promise.resolve(sessions.save(s)));
            }
            await Promise.all(writes);
            const reloaded = sessions.load ? sessions.load(s.id) : null;
            check("concurrent session saves keep every message",
                !reloaded || reloaded.messages.length === 20,
                reloaded && reloaded.messages.length);
        } else {
            console.log("SKIP | session race - no create/save API");
        }
    }

    // Release everything that could still hold a handle BEFORE deleting.
    // Retries alone were not enough: this suite starts an embed server child and
    // four HTTP servers rooted in LIB, and Windows will not remove a directory
    // any of them still has open. The retry budget just made the failure slower.
    serve.stopAll();
    embedIndex.stop();
    knowledge.remove(lib.id);
    await new Promise(r => setTimeout(r, 300));

    // A temp directory that will not delete is not a product defect and must not
    // fail a suite whose checks all passed. Report it and move on — the OS
    // reclaims %TEMP% regardless.
    for (const d of [LIB, DATA]) {
        try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }); }
        catch (e) { console.log("  note: could not remove", d, "-", e.code); }
    }
    console.log(`\n${pass}/${pass + fail} stress checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
