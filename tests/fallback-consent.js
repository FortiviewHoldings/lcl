/**
 * THE FALLBACK THAT SPENT MONEY NOBODY AGREED TO.
 *
 * Measured in testing: eight turns approved as
 * "mistral-large on spark, $0" were preflight-refused in ~0.5s and silently
 * re-run on Qwen/Qwen3.7-Max at api.deepinfra.com — $0.380545 billed, every
 * reply stamped with the refused model's name, the session's OWN fallback
 * list EMPTY the whole time. "api fallback is not turned on." It was not.
 * Three layers each held half an excuse: the router read an empty allowlist
 * as no opinion, the agent never passed the list at all, and nothing anywhere
 * re-asked consent when the destination changed.
 *
 * Every check in here is one sentence of that incident, made impossible.
 */
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-fbc-"));
process.env.LCL_DATA_DIR = DATA;
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

const ROOT = path.join(__dirname, "..");
const paths = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));
const cloud = require(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"));
const router = require(path.join(ROOT, ".lcl.engine", "core", "router.js"));
const ledger = require(path.join(ROOT, ".lcl.engine", "core", "ledger.js"));
const agentSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
const routerSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "router.js"), "utf8");
const orchSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");

(async () => {

    /* =================================================================
     * 1. THE SESSION LIST IS THE SWITCH, AND EMPTY MEANS NEVER
     * =============================================================== */

    // .invalid is the reserved cannot-resolve TLD: a dial is an instant local
    // NXDOMAIN, so nothing in this suite ever reaches a real network — while
    // the host still counts as a THIRD PARTY (not localhost, not owned),
    // which is the case the consent rules exist for
    cloud.linkEndpoint({ id: "paid", label: "api.example.com",
                         baseUrl: "https://api.example.invalid",
                         models: [{ id: "big/Frontier", chat: true }] });
    cloud.putKey("paid", "sk-test-fallback-consent");
    cloud.selectModel({ endpointId: "paid", model: "big/Frontier" });
    paths.writeSettings({ allowEscalation: true, networkEnabled: true });

    const failedSpark = { id: "node-x", label: "spark",
                          model: "mistral-large:123b-instruct-2411-q6_K" };

    check("THE EXACT CASE: escalateTo [] — panel opened, nothing ticked — is " +
          "\"never\", not \"no opinion\", even with the global switch armed",
        router.resolveFallback({ escalateTo: [] }, failedSpark) === null);

    check("...and a session that never opened the panel (no list at all) gets " +
          "no fallback either — consent is given, not defaulted",
        router.resolveFallback({}, failedSpark) === null);

    check("...and a model that is not on the ticked list is never chosen, even " +
          "though it is the configured global driver",
        router.resolveFallback({ escalateTo: ["some/OtherModel"] }, failedSpark) === null);

    check("...while the model the conversation DID tick resolves",
        (() => { const r = router.resolveFallback(
            { escalateTo: ["big/Frontier"] }, failedSpark);
            return r && r.model === "big/Frontier"; })());

    paths.writeSettings({ allowEscalation: false });
    check("...and the global switch off still beats a ticked list — both yeses, " +
          "exactly as the dialog promises",
        router.resolveFallback({ escalateTo: ["big/Frontier"] }, failedSpark) === null);
    paths.writeSettings({ allowEscalation: true });

    /* =================================================================
     * 2. NO HOOK IS A NO — the reroute that never asks never runs
     * =============================================================== */

    // a dead local port: connection refused in milliseconds, no real traffic
    const deadSel = { id: "deadnode", label: "deadnode", model: "big/Frontier",
                      baseUrl: "http://127.0.0.1:9", localNode: true,
                      node: { id: "n-dead", name: "deadnode", host: "127.0.0.1" } };
    cloud.linkEndpoint({ id: "deadnode", label: "deadnode", baseUrl: "http://127.0.0.1:9",
                         localNode: true, node: { id: "n-dead", name: "deadnode", host: "127.0.0.1" },
                         models: [{ id: "big/Frontier", chat: true }] });
    // linkEndpoint auto-selects what it just linked — put the DRIVER back on
    // the paid endpoint, because "the global driver is a paid API while the
    // session runs a node model" is the exact configuration of the incident
    cloud.selectModel({ endpointId: "paid", model: "big/Frontier" });

    const genOnce = (opts) => router.generate(
        [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
        64, { cancelled: false }, () => {}, opts);

    {
        // fallback target "paid" is a third party (dest not owned): with NO
        // approveRemote hook the router must refuse to reroute — measured
        // before this existed: it rerouted and billed, eight times
        const r = await genOnce({ selection: cloud.endpoints().find(e => e.id === "deadnode") && { ...cloud.endpoints().find(e => e.id === "deadnode"), model: "big/Frontier" },
                                  escalateTo: ["big/Frontier"] });
        check("A PAID DESTINATION IS NEVER DIALLED ON AN ABSENT HOOK. The failed " +
              "turn comes back as a failure carrying fallbackDeclined, not as a " +
              "silent answer from somebody else's hardware",
            r && r.error && r.fallbackDeclined === true && !r.fellBackFrom,
            r && { error: String(r.error).slice(0, 80), declined: r.fallbackDeclined });
        check("...and it NAMES what it did not ask about",
            r && /big\/Frontier on api\.example\.com/.test(String(r.fallbackNotAsked || "")),
            r && r.fallbackNotAsked);
    }

    {
        // hook present and says NO: same outcome, and the hook saw the truth
        let seen = null;
        const r = await genOnce({ selection: { ...cloud.endpoints().find(e => e.id === "deadnode"), model: "big/Frontier" },
                                  escalateTo: ["big/Frontier"],
                                  approveRemote: async (q) => { seen = q; return false; } });
        check("THE HOOK IS ASKED WITH THE REAL DESTINATION, THE REASON, AND WHAT " +
              "FAILED — the exact three facts the eight silent reroutes withheld",
            seen && seen.model === "big/Frontier" && /api\.example\.com/.test(seen.endpoint || "")
              && typeof seen.reason === "string" && seen.reason.length > 0
              && /deadnode/.test(String(seen.fellBackFrom || ""))
              && seen.selection && seen.selection.baseUrl,
            seen && { model: seen.model, endpoint: seen.endpoint, from: seen.fellBackFrom });
        check("...and a NO keeps the refusal as the answer — nothing re-runs",
            r && r.error && r.fallbackDeclined === true);
    }

    {
        // hook says YES: the reroute really runs (against another dead port —
        // we assert the attempt, not the answer) and the caller's refit
        // callback is invoked for the actual target
        let refitFor = null;
        const r = await genOnce({ selection: { ...cloud.endpoints().find(e => e.id === "deadnode"), model: "big/Frontier" },
                                  escalateTo: ["big/Frontier"],
                                  approveRemote: async () => true,
                                  refitFor: (to) => { refitFor = to.label;
                                      return { messages: [{ role: "user", content: "hi" }],
                                               replyTokens: 32 }; } });
        check("A YES actually re-runs the turn — the second attempt is recorded " +
              "on the failure it also had (both roads dead here, by design)",
            r && r.fallbackTried && /big\/Frontier/.test(r.fallbackTried), r && r.fallbackTried);
        check("...and the substitute was REBUILT for itself: refitFor was called " +
              "with the fallback target, not skipped and not handed the failed " +
              "model's prompt",
            refitFor === "api.example.com", refitFor);
    }

    /* =================================================================
     * 3. THE WIRE ASKS NODES TO COUNT — and only nodes
     * =============================================================== */

    const bodies = [];
    const srv = http.createServer((req, res) => {
        let b = "";
        req.on("data", c => b += c);
        req.on("end", () => {
            if (/\/api\/(tags|ps)$/.test(req.url)) {
                res.setHeader("Content-Type", "application/json");
                return res.end(JSON.stringify({ models: [] }));
            }
            bodies.push({ url: req.url, body: (() => { try { return JSON.parse(b); } catch { return null; } })() });
            res.setHeader("Content-Type", "text/event-stream");
            res.write('data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    cloud.linkEndpoint({ id: "mocknode", label: "mocknode",
                         baseUrl: `http://127.0.0.1:${port}`, localNode: true,
                         node: { id: "n-mock", name: "mocknode", host: "127.0.0.1",
                                 port, memBytes: 130e9 },
                         models: [{ id: "tiny:1b", chat: true }] });
    cloud.linkEndpoint({ id: "mockapi", label: "mockapi",
                         baseUrl: `http://127.0.0.1:${port}`,
                         models: [{ id: "tiny:1b", chat: true }] });

    try {
        await cloud.streamChat([{ role: "user", content: "hi" }], {
            selection: { ...cloud.endpoints().find(e => e.id === "mocknode"), model: "tiny:1b" },
            maxTokens: 16, cancelToken: { cancelled: false } });
    } catch (e) { check("node mock stream survived", false, String(e.message)); }
    try {
        await cloud.streamChat([{ role: "user", content: "hi" }], {
            selection: { ...cloud.endpoints().find(e => e.id === "mockapi"), model: "tiny:1b" },
            maxTokens: 16, cancelToken: { cancelled: false } });
    } catch (e) { check("api mock stream survived", false, String(e.message)); }
    srv.close();

    const nodeBody = bodies[0] && bodies[0].body;
    const apiBody = bodies[1] && bodies[1].body;
    check("A NODE STREAM ASKS FOR ITS USAGE BLOCK — stream_options.include_usage " +
          "rides the request, so a node turn stops booking as `attempt-unbilled " +
          "0/0`, the exact row shape the masked reroutes hid behind",
        nodeBody && nodeBody.stream_options && nodeBody.stream_options.include_usage === true,
        nodeBody && Object.keys(nodeBody));
    check("...and a hosted endpoint's request is UNTOUCHED — a strict provider " +
          "must never lose a paid call over bookkeeping it already does unasked",
        apiBody && !("stream_options" in apiBody), apiBody && Object.keys(apiBody));

    /* =================================================================
     * 4. THE LEDGER SAYS WHY, THE BUBBLE SAYS WHO
     * =============================================================== */

    const row = ledger.record({ sessionId: "s1", model: "big/Frontier",
        endpoint: "api.example.com", inputTokens: 10, outputTokens: 5, usd: 0.01,
        fellBackFrom: "mistral-large on spark",
        fallbackReason: "does not fit" });
    check("A FALLBACK'S LEDGER ROW NAMES WHAT FAILED AND WHY — it is no longer " +
          "a perfect disguise as an ordinary call to that model",
        row && row.fellBackFrom === "mistral-large on spark"
           && row.fallbackReason === "does not fit");
    check("...and the row really landed on disk with both fields",
        (() => { const all = ledger.readAll ? ledger.readAll() : null;
            // readAll may not be exported; read the file directly
            const f = fs.readFileSync(path.join(DATA, "cost-ledger.jsonl"), "utf8");
            return /fellBackFrom/.test(f) && /does not fit/.test(f); })());

    check("the agent writes those fields from the result that actually fell back",
        /fellBackFrom: result\.fellBackFrom/.test(agentSrc) &&
        /fallbackReason: result\.fallbackReason/.test(agentSrc));

    check("THE BUBBLE WEARS THE ANSWERER'S NAME — for an API turn the name is " +
          "result.model (the fallback answerer), and for a NODE turn it is what " +
          "the server SERVES from the healed store — never the request echo " +
          "(llama.cpp echoes the requested id; a stale session naming Qwen got " +
          "gpt-oss answers wearing a Qwen label)",
        /return \(result\.remote && result\.model\) \|\| modelName;/.test(agentSrc)
        && /if \(sel && sel\.localNode\)/.test(agentSrc)
        && /const served = m0 && \(m0\.id \|\| m0\);/.test(agentSrc));

    check("...and a reply that moved carries the fact on its face: the renderer " +
          "draws the banner ABOVE the text, amber, with the reason",
        /meta\.fellBackFrom/.test(appSrc) && /msg-fallback/.test(appSrc) &&
        /bubble\.prepend\(fb\)/.test(appSrc) && /\.msg-fallback/.test(cssSrc));

    check("the refused model still gets its OWN attempt row even though the " +
          "fallback billed mid-turn — the count-based backstop alone was blind " +
          "to exactly this",
        /result\.fellBack\)/.test(mainSrc) &&
        /refused-fell-back/.test(mainSrc) &&
        /kind: "fallback-fired"/.test(mainSrc));

    check("the preflight refusal REASON is persisted with the refusal — " +
          "`refused-preflight` alone was the only trace eight times",
        /logCall\("refused-preflight",\s*\{ reason:/.test(
            fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"), "utf8")));

    /* =================================================================
     * 5. THE WIRING — every hop of the consent chain exists
     * =============================================================== */

    check("agent passes the session's OWN list into the router on every turn",
        /escalateTo: Array\.isArray\(session\.escalateTo\) \? session\.escalateTo : \[\]/.test(agentSrc));

    check("agent passes the approval hook through, and the router's note stream " +
          "lands in the progress feed instead of a no-op",
        /approveRemote: typeof opts\.approveFallback === "function"/.test(agentSrc) &&
        /onNote: \(note\) => report\("correcting", \{ reason: note \}/.test(agentSrc));

    check("agent rebuilds the substitute's prompt: refitFor re-derives the " +
          "system prompt (identity line included) and the window for the target",
        /refitFor: \(target\) => \{/.test(agentSrc) &&
        /systemPrompt\(root, tools, target\)/.test(agentSrc) &&
        /LIMITS\(target\)/.test(agentSrc));

    check("main hands the SAME K3 ask to both the chat turn and the " +
          "orchestrator's step turns",
        /approveFallback = async \(q\)/.test(mainSrc) &&
        /planGoal: goal, approveFallback/.test(mainSrc) &&
        /approveFallback: opts\.approveFallback/.test(orchSrc));

    check("the fallback ask names itself to the card: fallback flag, reason, " +
          "and what fell back, merged into the approval request",
        /fallback: true,/.test(mainSrc) && /fellBackFrom: q\.fellBackFrom/.test(mainSrc));

    // The app-wide `always` is gone from EVERY card now, not just this one:
    // "for the millionth time, all the permissions are session specific,
    // nothing is app wide." So the fallback card's special case is no longer
    // special — no card can widen a grant past the conversation it was raised
    // in, and the assertion is simply that the answer does not exist.
    check("the card leads with what refused, and no card anywhere offers an " +
          "app-wide `always` — disarming the gate for conversations that do " +
          "not exist yet is not a lever any card may pull",
        /const isFallback = r\.fallback === true/.test(appSrc) &&
        /Your first choice refused/.test(appSrc) &&
        !/id: "always"/.test(appSrc));

    check("the turn lock is set immediately before the try that releases it — " +
          "a throw between the two no longer wedges the session until restart",
        /turnsBySession\.set\(id, cancelToken\);\s*\n\s*try \{/.test(mainSrc));

    /* =================================================================
     * 6. A SEND THAT CAN NEVER SUCCEED IS SAID UP FRONT
     * =============================================================== */

    check("MISTRAL'S OWN NUMBERS: 100.59 GB on a 130.66 GB machine can never " +
          "pass the guard's fit rule, and the static check says so",
        cloud.canEverFitNode(100_586_289_450, 130_663_002_112) === false);

    check("...while every model that has actually run on that machine passes: " +
          "gemma3 17.6 GB, command-a 67.1 GB",
        cloud.canEverFitNode(17_600_000_000, 130_663_002_112) === true &&
        cloud.canEverFitNode(67_100_000_000, 130_663_002_112) === true);

    check("...and unknown sizes are never marked — it flags certainties only",
        cloud.canEverFitNode(0, 130e9) === true && cloud.canEverFitNode(50e9, 0) === true);

    check("the picker list computes the verdict from the guard's own arithmetic",
        /neverFits: !!\(onNode && ep\.node/.test(mainSrc) &&
        /cloudModels\.canEverFitNode\(m\.sizeBytes, ep\.node\.memBytes\)/.test(mainSrc));

    check("...and the row refuses the click with the reason on it, styled " +
          "distinct from offline because it heals differently",
        /never-fits/.test(appSrc) && /neverFits/.test(appSrc) &&
        /\.model-row\.never-fits/.test(cssSrc) &&
        /Cannot load on \$\{m\.endpointLabel\}/.test(appSrc));

    check("model records now KEEP the size the probe always captured",
        /sizeBytes: Number\(info\.sizeBytes\) > 0 \? Number\(info\.sizeBytes\) : undefined/.test(
            fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"), "utf8")));

    check("a node endpoint stored without sizes counts as stale, so one " +
          "auto-heal refresh brings the verdict to records linked before this",
        cloud.endpointIsStale({ localNode: true,
            models: [{ id: "m", contextLength: 32768 }] }) === true &&
        cloud.endpointIsStale({ localNode: true,
            models: [{ id: "m", contextLength: 32768, sizeBytes: 5e9 }] }) === false);

    /* =================================================================
     * 7. THE DIALOGS SAY WHAT IS TRUE
     * =============================================================== */

    check("Model Orchestration's fallback is a single 'Pay for API on behalf' " +
          "toggle with a toast (§6d) — the per-model pay-LIST is gone, and a paid " +
          "fallback still asks first",
        /Pay for API on behalf/.test(appSrc) &&
        /a paid fallback still asks you first/.test(appSrc) &&
        !/none ticked = never/.test(appSrc));

    check("...and it carries the intelligent half: a per-task model assignment " +
          "the session follows and Ancient Knowledge reads",
        /Use these models for these tasks/.test(appSrc) &&
        /setSessionTaskModels/.test(appSrc));

    check("API's & Connections opens by saying what it IS — wiring, keys, rates — " +
          "and points at the CURRENT session page for routing, not a deleted menu",
        /This page is the wiring/.test(appSrc) &&
        /Session › Model Orchestration/.test(appSrc) &&
        !/Session › API fallback/.test(appSrc) && /pref-purpose/.test(cssSrc));

    /* ---- A FREE MACHINE THE OPERATOR OWNS ARMS WITHOUT PAYMENT CONSENT ----
     * escalateTo is the PAID allowlist; deriving fallback reachability from it
     * silently excluded every local node — "its supposed to be all the
     * available models period, not just api." An owned free node (localNode,
     * not rented) resolves as the preferred fallback with an EMPTY paid list;
     * a paid preferred still requires its tick; offline still refuses. */
    {
        const free = { id: "node-1", baseUrl: "http://10.0.0.2:30000", model: "gpt-oss-120b",
                       localNode: true, rented: false };
        const r1 = router.resolveFallback({ escalateTo: [], preferred: free }, null);
        check("an owned free node arms as fallback with an EMPTY paid allowlist",
            !!r1 && r1.model === "gpt-oss-120b");
        const paid = { id: "api-1", baseUrl: "https://api.x.ai", model: "grok-5" };
        const r2 = router.resolveFallback({ escalateTo: [], preferred: paid }, null);
        check("...a PAID preferred with no tick still fails closed", r2 === null);
        const off = { ...free, offline: true };
        const r3 = router.resolveFallback({ escalateTo: [], preferred: off }, null);
        check("...and an offline node never arms (K4)", r3 === null);
    }

    /* =================================================================
     * 4. API→LOCAL — a remote failure falls to the FREE local engine
     *    instead of dropping the turn. "its supposed to be all the
     *    available models period", and the most available is the one on
     *    the disk. Only from a remote failure, only when a model exists,
     *    and free (no approval ceremony — this machine is owned).
     * =============================================================== */
    {
        const engine = require(path.join(ROOT, ".lcl.engine", "core", "engine.js"));
        const origFind = paths.findModel;
        const origGen = engine.generate;
        paths.findModel = () => "/fake/on-disk.gguf";     // a local model IS present
        engine.generate = async () => ({ content: "answered locally",
            usage: { prompt_tokens: 5, completion_tokens: 3 } });
        try {
            // deadnode selection fails (connection refused), NO paid fallback allowed
            const r = await genOnce({
                selection: { ...cloud.endpoints().find(e => e.id === "deadnode"), model: "big/Frontier" },
                escalateTo: [] });
            check("A REMOTE FAILURE FALLS TO THE FREE LOCAL ENGINE when no paid " +
                  "fallback is allowed — the turn is ANSWERED on this machine, not dropped",
                r && !r.error && r.content === "answered locally"
                && /big\/Frontier/.test(String(r.fellBackFrom || "")),
                r && { err: r.error, content: r.content, from: r.fellBackFrom });
            check("...free, no approval ceremony — local is owned and costs nothing",
                r && r.fallbackDeclined !== true, r && r.fallbackDeclined);
            // and with NO local model on disk, it does NOT invent one — the
            // remote failure is reported honestly rather than hanging on a
            // model that is not there
            paths.findModel = () => null;
            const r2 = await genOnce({
                selection: { ...cloud.endpoints().find(e => e.id === "deadnode"), model: "big/Frontier" },
                escalateTo: [] });
            check("...but with NO local model on disk, the failure is reported, " +
                  "never a fabricated local answer",
                r2 && r2.error && r2.content !== "answered locally", r2 && r2.error && String(r2.error).slice(0, 60));
        } finally { paths.findModel = origFind; engine.generate = origGen; }
    }

    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 6 }); } catch { /* held */ }
    console.log(`\n${pass}/${pass + fail} fallback-consent checks passed`);
    process.exit(fail ? 1 : 0);
})();
