/**
 * THE FREE-API CATALOG — the engine knows where the answers live.
 *
 * A 4B model does not carry the fact that a compound's molecular weight is at
 * pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/<x>/property/... — it will
 * invent a plausible URL instead. The catalog is the engine supplying that
 * knowledge: every entry keyless, terms-checked for commercial use, and
 * carrying a REAL example URL.
 *
 * What must hold: the ranking actually answers engineering questions (the
 * first version put OpenTopoData top for "convert psi to kPa", because
 * "opentopodata" contains the substring "to"), no entry needs a key, and
 * every example is a well-formed https URL. Live reachability is checked
 * only when LCL_NET_TESTS=1 — the suite must pass offline.
 */
const path = require("path");
const https = require("https");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => require("os").tmpdir() },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const cat = require(__dirname + "/../.lcl.engine/core/apiCatalog.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 180) : ""); }
}

/* ---- shape: every entry is usable and free ---- */
check("the catalog is not empty", cat.CATALOG.length >= 20, cat.CATALOG.length);
for (const e of cat.CATALOG) {
    if (!/^https:\/\/[^\s]+$/.test(e.example)) {
        check(`"${e.name}" has a well-formed https example`, false, e.example);
    }
    if (/api[_-]?key|apikey|token=|\bkey=/i.test(e.example)) {
        check(`"${e.name}" needs no key in its example`, false, e.example);
    }
}
check("every example is a well-formed keyless https URL",
    cat.CATALOG.every(e => /^https:\/\/[^\s]+$/.test(e.example)
        && !/api[_-]?key|apikey|token=|\bkey=/i.test(e.example)));
check("every entry carries a topic and a description",
    cat.CATALOG.every(e => e.topic && e.what && e.what.length > 10));
check("topics() lists them", cat.topics().length >= 10, cat.topics());

/* ---- ranking: the questions an engineer actually asks ---- */
const RANK = [
    ["molecular weight of toluene", /PubChem/],
    ["convert psi to kPa", /UCUM/],
    ["fundamental physical constants", /CODATA/],
    ["recent earthquakes", /Earthquake/],
    ["geomagnetic k index", /SWPC/],
    ["tide predictions", /CO-OPS|Tides/],
    ["currency exchange rate", /Frankfurter/],
    ["arxiv preprint", /arXiv/]
];
for (const [q, want] of RANK) {
    const top = (cat.findApi(q, 1)[0] || {}).name || "";
    check(`"${q}" -> ${want.source}`, want.test(top), top);
}
check("filler words do not decide the ranking",
    !/OpenTopoData/.test((cat.findApi("convert psi to kPa", 1)[0] || {}).name || ""));
check("an unmatched query returns nothing rather than noise",
    cat.findApi("zzzz nonexistent subject qqq").length === 0);
check("an empty query returns the head of the catalog",
    cat.findApi("").length > 0);

/* ---- the tool surface ---- */
(async () => {
    const r = await cat.FIND_ENTRY.run(null, { query: "chemistry" });
    check("find_api returns apis with examples",
        Array.isArray(r.apis) && r.apis.length > 0 && /^https:/.test(r.apis[0].example));
    check("find_api tells the model how to use the result", /http_fetch/.test(r.note));
    let threw = false;
    try { await cat.FIND_ENTRY.run(null, { query: "qqqq zzzz nothing" }); } catch { threw = true; }
    check("find_api errors helpfully when nothing matches", threw);

    /* ---- live reachability: opt-in, never in the default suite ---- */
    if (process.env.LCL_NET_TESTS === "1") {
        console.log("\n-- live probes --");
        const probe = (u) => new Promise(res => {
            const q = https.get(u, { headers: { "User-Agent": "lcl-tests/1.0" }, timeout: 15000 },
                s => { s.resume(); res(s.statusCode); });
            q.on("error", () => res(0));
            q.on("timeout", () => { q.destroy(); res(0); });
        });
        for (const name of ["PubChem PUG REST", "NLM UCUM Web Service",
                            "USGS Earthquake Catalog", "Frankfurter"]) {
            const e = cat.CATALOG.find(x => x.name === name);
            if (!e) continue;
            check(`live: ${name} answers`, (await probe(e.example)) === 200);
        }
    } else {
        console.log("\n-- live probes skipped (set LCL_NET_TESTS=1 to run them) --");
    }

    console.log(`\n${pass}/${pass + fail} api-catalog checks passed`);
    process.exit(fail ? 1 : 0);
})();
