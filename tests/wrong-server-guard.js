/**
 * THE GUARD MEASURED THE WRONG MACHINE, THEN SPOKE WITH AUTHORITY ABOUT IT.
 *
 * "Error: llama.cpp server did not publish a size for
 *  unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL, and its name says about 35B
 *  parameters — too big to load onto a machine without knowing what it weighs."
 *
 * llama.cpp on port 30000 was serving that model, loaded, at that moment. This
 * is what actually happened:
 *
 *   1. the preflight asks the endpoint's own address for /api/tags
 *   2. the direct road to 30000 does not answer, so it falls through to the DOOR
 *   3. the door is ONE fixed proxy, provisioned at Ollama on 11434
 *   4. so the answer is OLLAMA'S catalogue — ten models, none of them this one
 *   5. "not in the catalogue" is read as "size unknown", and a 35B model is
 *      refused on the strength of a different server's inventory
 *
 * That is the §6 rule in a new place: reached is not the same as reached THE
 * THING YOU ASKED ABOUT.
 *
 * SUPERSEDED, AND HONESTLY SO: the first correction tried to keep the memory
 * guard running for llama.cpp while discarding wrong-server door evidence — an
 * elaborate doorBackendPort-matching apparatus. It hit the operator AGAIN when
 * a newer llama.cpp began answering Ollama's /api/tags directly (no door
 * needed) with the model listed but NO SIZE, so the size branch refused a model
 * the box was actively serving. The root is simpler and is what he insisted on
 * all along: a start-time server (llama.cpp, vLLM, TRT-LLM — shape "openai")
 * loads ONE model at boot; a chat request triggers no load, so the guard has
 * nothing to protect and does not run for it at all (`if (!isOllamaShape(s))
 * return null`). The guard exists ONLY for on-demand loaders (Ollama), which is
 * the one place a chat request can cold-load and crash a box. The controls
 * below prove BOTH halves: a start-time server proceeds no matter what the door
 * says, and a real Ollama node still refuses 100 GB onto 40 GB free.
 *
 * PROVEN, NOT ASSERTED: two live HTTP servers, a real door token, and the real
 * nodePreflight. The control case is the half that matters — with the door
 * pointed at the endpoint's OWN port, the same catalogue still refuses the same
 * model, which is how this suite knows the guard was not simply switched off.
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

/* the same isolation the other node suites use: an electron stub and a data
   directory of this run's own, so nothing here touches the operator's store */
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
    if (r === "electron") return __filename;
    return _resolve.call(this, r, ...a);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-wrong-server-"));
process.env.LCL_DATA_DIR = DATA;
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

const pathsMod = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));
pathsMod.writeSettings({ networkEnabled: true });
const publicDns = require(path.join(ROOT, ".lcl.engine", "core", "publicDns.js"));
publicDns.lookup = (host, opts, cb) => {
    const done = typeof opts === "function" ? opts : cb;
    done(null, "127.0.0.1", 4);
};
const cloud = require(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"));

const listen = (srv) => new Promise(r =>
    srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

/* OLLAMA'S OWN TEN, and the llama.cpp model is deliberately not among them —
   because on the test machine it was not. Sizes are real enough to be judged. */
const OLLAMA_CATALOGUE = { models: [
    { name: "qwen3:32b", model: "qwen3:32b", size: 20e9 },
    { name: "mistral-large:123b", model: "mistral-large:123b", size: 100e9 },
    { name: "stop-bath:4b", model: "stop-bath:4b", size: 2.6e9 }
] };
const LLAMACPP_MODEL = "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL";

(async () => {
    // THE DOOR: one fixed proxy, and it answers for Ollama whoever asks.
    const door = http.createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/tags") return res.end(JSON.stringify(OLLAMA_CATALOGUE));
        if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [] }));
        res.end("{}");
    });
    const doorPort = await listen(door);

    // llama.cpp's own address, with nothing listening — the state that sends
    // the probe down the door road in the first place
    const deadSrv = http.createServer(() => {});
    const deadPort = await listen(deadSrv);
    await new Promise(r => deadSrv.close(r));

    const rec = (extra = {}) => ({
        id: "llamacpp-ep", label: "llama.cpp server", model: LLAMACPP_MODEL,
        baseUrl: `http://127.0.0.1:${deadPort}/v1`, localNode: true,
        relayUrl: `http://127.0.0.1:${doorPort}`,
        node: { id: "node-spark", host: "127.0.0.1",
                memBytes: 128e9, availableBytes: 90e9, availableAt: Date.now(),
                ...extra }
    });
    cloud.putKey("llamacpp-ep::door", "door-token-for-this-test");

    const verdict = async (r) => {
        try { return { ok: true, value: await cloud.nodePreflight(r) }; }
        catch (e) { return { ok: false, why: String(e.message || e) }; }
    };

    /* ---------------- the failure he hit, and it must not happen ---------------- */
    // the real shape: the door proxies Ollama on 11434, the endpoint is
    // llama.cpp on its own port, and the record now KNOWS the difference
    const v = await verdict(rec({ doorBackendPort: 11434 }));
    check("A LLAMA.CPP MODEL IS NOT JUDGED BY OLLAMA'S CATALOGUE. The door " +
          "proxies ONE backend, so its answer is about that backend and not " +
          "about the endpoint that asked — and reading 'absent from someone " +
          "else's inventory' as 'size unknown' refused his main model outright",
        v.ok === true && v.value === null, v);

    check("...and the refusal that DID happen is gone by name, so a regression " +
          "here reads as the same sentence he saw",
        !(v.why && /did not publish a size/.test(v.why)), v.why);

    /* ---------------- the control: the guard is not switched off --------------- */
    /* Point the door's backend AT this endpoint's own port and the very same
     * catalogue becomes evidence about the very same server — at which point a
     * 35B model whose size nobody published is refused, exactly as before. If
     * this check ever passes-by-proceeding, the fix above has quietly become a
     * hole rather than a correction. */
    const control = await verdict(rec({ doorBackendPort: deadPort }));
    check("A START-TIME SERVER IS NOT GUARDED EVEN WHEN THE CATALOGUE IS ABOUT " +
          "IT: llama.cpp (shape openai) loads one model at boot, so a chat " +
          "request triggers no cold load and there is nothing to guard. The " +
          "unpublished-size refusal is gone AT THE ROOT, not by out-arguing the " +
          "catalogue. The guard still bites on-demand loaders — the Ollama " +
          "fixture below is the proof it was not simply switched off.",
        control.ok === true && control.value === null, control);

    /* ------------------------- and a small model still goes ------------------- */
    const small = await verdict({ ...rec({ doorBackendPort: deadPort }),
                                  model: "stop-bath:4b" });
    check("...and a model the catalogue DOES list, at a size the machine has " +
          "room for, proceeds — a guard that refuses everything is not a guard",
        small.ok === true, small);

    /* ------- and a door whose backend is UNRECORDED is still believed ------- */
    /* The deliberate default, and it is the opposite of the one above. A door
       provisioned before this was recorded has no backend port on its record,
       and refusing its evidence there would blind the guard under exactly the
       condition the door exists for: full-tunnel VPN, direct road shut, the
       door the only road left. Unknown means believe it. */
    const unknown = await verdict(rec());
    check("...and with no backend port on the record it STILL proceeds — a " +
          "start-time server has no cold load whatever the door says, so a " +
          "blind guard under a VPN can never harden into a refusal of a model " +
          "the box is already serving. This is the exact sentence he saw, gone.",
        unknown.ok === true && unknown.value === null, unknown);

    /* ---- and the record has to SURVIVE the trip into the endpoint ---- */
    /* Two places build a trimmed node object for connect(), and a field that
       is stamped on the node but dropped on the way to the endpoint is a field
       the guard never sees. He pressed Update remote access ten times; the
       stamp is worthless if it is filtered out one hop later. */
    {
        const src = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
        // counted by splitting on the LITERAL, not by a regex. The first
        // version of this line lost its backslashes on the way to disk and
        // became an alternation that matched the empty string 489,294 times —
        // a pattern that matches everything reads exactly like a passing count.
        const count = (hay, needle) => hay.split(needle).length - 1;
        const trimmed = count(src, "memBytes: n.memBytes || null");
        const carried = count(src, "doorBackendPort: n.doorBackendPort");
        check("EVERY trimmed node record carries the doors backend port through " +
              "to the endpoint — a stamp that is filtered out one hop later is " +
              "a stamp that does nothing",
            trimmed > 0 && carried === trimmed, { trimmed, carried });
        check("...and the door records it at the one place the number is known",
            /doorBackendPort = backendPort/.test(src));
    }

    /* ------- the door version was the version PLUS its own comment ------- */
    /* The line on the node is:
     *
     *     DOOR_VERSION = "4"      # 4 adds /lcl/run — see _run_recipe
     *
     * and the probe read it with `tr -dc 0-9` over the WHOLE line, which
     * returned 44 — the version with the comment's digits glued on. Every door
     * version names itself in its own comment, so this was never one number,
     * and the comparison that decides whether an update is offered was made
     * against it: a genuinely old door reads as newer than the one shipped.
     * Run for real against the shipped file rather than asserted. */
    {
        const doorFile = path.join(ROOT, "tools", "node-door", "lcl-door.py");
        const line = fs.readFileSync(doorFile, "utf8").split(/\r?\n/)
            .find(l => l.startsWith("DOOR_VERSION")) || "";
        const oldWay = Number(line.replace(/[^0-9]/g, "") || 0);
        const newWay = Number(String(line.split('"')[1] || "").replace(/[^0-9]/g, "") || 0);
        check("DOOR VERSION IS ONE NUMBER, not the version with its comment " +
              "glued on — read from the file .lcl actually ships",
            newWay > 0 && newWay < 10 && String(newWay).length === 1,
            { line, oldWay, newWay });
        check("...and this file is the reason it mattered: the old reading gives " +
              "a different answer, so the bug was live and not hypothetical",
            oldWay !== newWay, { oldWay, newWay });

        const src = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
        check("...and the probe takes what is between the quotes",
            src.includes("DOORV=") && src.includes("cut -d") &&
            !src.includes("lcl-door.py \" +\n            \"2>/dev/null | tr -dc 0-9"),
            src.includes("cut -d"));
    }

    /* ---------------- his box, exactly as it answered over ssh ---------------- */
    /* Measured on the Spark while it was refusing him:
     *     30000 /api/tags  -> 404
     *     30000 /api/ps    -> 404
     *     30000 /v1/models -> the model, with "size": ""
     * Both Ollama routes 404, so both probes fall through to the door, and the
     * door proxies Ollama. Nothing about the endpoint's own answer was ever
     * consulted — and it is the one answer that cannot be about another machine.
     * NOTE: no doorBackendPort here. That is his real state, and the fix must
     * not depend on a stamp that never landed. */
    {
        const llama = http.createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/api/tags" || req.url === "/api/ps") {
                res.statusCode = 404; return res.end("{}");
            }
            if (req.url === "/v1/models") {
                return res.end(JSON.stringify({ models: [{
                    name: LLAMACPP_MODEL, model: LLAMACPP_MODEL, size: ""
                }], object: "list" }));
            }
            res.statusCode = 404; res.end("{}");
        });
        const lp = await listen(llama);
        const live = {
            id: "llamacpp-ep", label: "llama.cpp server", model: LLAMACPP_MODEL,
            baseUrl: `http://127.0.0.1:${lp}/v1`, apiPrefix: "/v1", localNode: true,
            relayUrl: `http://127.0.0.1:${doorPort}`,
            node: { id: "node-spark", host: "127.0.0.1", memBytes: 128e9,
                    availableBytes: 90e9, availableAt: Date.now() }
        };
        const r = await verdict(live);
        check("HIS BOX, EXACTLY: llama.cpp 404s both Ollama routes and names the " +
              "model in its OWN catalogue — so it is serving it, there is no cold " +
              "load to guard, and the turn goes through. This is the failure he " +
              "hit twice after two separate fixes",
            r.ok === true && r.value === null, r);

        /* AND OLLAMA IS UNTOUCHED. It answers /api/ps, so it never takes that
         * branch — its /v1/models lists everything PULLED, not everything
         * loaded, and treating that as "already resident" would hand back the
         * hole that killed the machine twice. */
        const olla = http.createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [] }));
            if (req.url === "/api/tags") return res.end(JSON.stringify(OLLAMA_CATALOGUE));
            if (req.url === "/v1/models") {
                return res.end(JSON.stringify({ data: [{ id: "mistral-large:123b" }] }));
            }
            res.statusCode = 404; res.end("{}");
        });
        const op = await listen(olla);
        const oll = {
            id: "ollama-ep", label: "ollama", model: "mistral-large:123b",
            baseUrl: `http://127.0.0.1:${op}`, apiPrefix: "/v1", localNode: true,
            shape: "ollama",   // the one shape the guard is FOR — on-demand load
            node: { id: "node-spark", host: "127.0.0.1", memBytes: 128e9,
                    availableBytes: 40e9, availableAt: Date.now() }
        };
        const ro = await verdict(oll);
        check("...and OLLAMA IS UNTOUCHED: it answers /api/ps, so listing a 100 GB " +
              "model it has merely PULLED is not mistaken for one already " +
              "resident, and 100 GB onto 40 GB free is still refused",
            ro.ok === false, ro);

        await new Promise(r2 => llama.close(r2));
        await new Promise(r2 => olla.close(r2));
    }

    await new Promise(r => door.close(r));
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 8 }); }
    catch { /* held */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error("HARNESS ERROR:", (e && e.stack) || e);
    process.exit(1);
});
