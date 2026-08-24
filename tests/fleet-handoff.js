/**
 * "IT SAY IT KNOWS ABOUT IT, BUT CAN NOT ACCESS IT."
 *
 * Both halves of his sentence were exact, and this suite pins the repair of
 * each. The session's fleet toggle wrote `taskModels.agentic`, and
 * orchestrationBlock put the assignment in the system prompt — that is the
 * KNOWING. But nothing executed it: ask_cloud_model targets the app-wide
 * driver and never reads the session map, and the escalation money-gate
 * deletes the handoff tools whenever paid escalation is off — which it always
 * is for a node, because a node is free and never enters escalateTo. The money
 * gate starved a free machine. That is the NOT-ACCESSING.
 *
 * And the donut: "the context window is not linking up properly, to the model
 * selected" — a node model whose host published no window got a flat 32,768
 * assumption presented as fact, while llama.cpp's /props and vLLM's
 * max_model_len would both have SAID their real number if asked.
 *
 * PROVEN, NOT ASSERTED: a live SSE server, the real linkEndpoint, the real
 * askFleet, the real measureNodeWindows. The concurrency check measures
 * overlapping in-flight requests — a fleet tool that runs its tasks one after
 * another is a slower ask_cloud_model wearing a new name.
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

/* the same isolation every node suite uses — nothing touches the real store */
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
    if (r === "electron") return __filename;
    return _resolve.call(this, r, ...a);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-fleet-"));
process.env.LCL_DATA_DIR = DATA;
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };
const pathsMod = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));
pathsMod.writeSettings({ networkEnabled: true });
const cloud = require(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"));

const listen = (srv) => new Promise(r =>
    srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

(async () => {
    /* ------------------------------------------------ the fleet, answering */
    let inflight = 0, maxInflight = 0, served = 0;
    const fleet = http.createServer((req, res) => {
        if (req.url.endsWith("/models")) {
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ data: [
                { id: "gpt-oss", max_model_len: 131072 }] }));
        }
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
            inflight++; maxInflight = Math.max(maxInflight, inflight);
            // answer AFTER a beat, so parallel requests demonstrably overlap
            setTimeout(() => {
                served++;
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write("data: " + JSON.stringify({ choices: [
                    { delta: { content: "fleet-answer-" + served } }] }) + "\n\n");
                res.write("data: " + JSON.stringify({ choices: [{ delta: {} }],
                    usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "\n\n");
                res.write("data: [DONE]\n\n");
                res.end();
                inflight--;
            }, 150);
        });
    });
    const fp = await listen(fleet);

    cloud.linkEndpoint({
        id: "node-fleet-test", label: "spark · vLLM",
        baseUrl: `http://127.0.0.1:${fp}/v1`, apiPrefix: "/v1",
        localNode: true, nodeRole: "fleet",
        models: [{ id: "gpt-oss" }],
        node: { id: "n1", host: "127.0.0.1" }
    });

    const ctx = (over) => ({ session: { taskModels: { agentic: {
        model: "gpt-oss", endpointId: "node-fleet-test" } } }, ...over });
    const run = (args, c) => cloud.FLEET_ENTRY.run(null, args, c === undefined ? ctx() : c);
    const refusal = async (args, c) => {
        try { await run(args, c); return null; } catch (e) { return String(e.message || e); }
    };

    /* -------------- no assignment DISCOVERS the free fleet — and says so */
    {
        const notes = [];
        const r = await run({ task: "find me" }, { session: { taskModels: {} },
            sessionId: "disc-ledger", sessionTitle: "discovery",
            onNote: (n) => notes.push(String(n)) });
        check("WITH NO FLEET ASSIGNED AND A FREE FLEET SEAT ALIVE, THE TOOL " +
              "RUNS THERE — the dead end ('knows about it, can not access it') " +
              "is now a discovery scoped to machines the operator OWNS",
            r && r.done === 1 && r.results[0].ok &&
            /fleet-answer-/.test(r.results[0].answer), r);
        check("...and the reply carries the offer the renderer turns into the " +
              "keep-this-fleet strip — the same shape the ▶ row writes",
            r && r.fleetOffer && r.fleetOffer.cap === "agentic" &&
            r.fleetOffer.endpointId === "node-fleet-test" &&
            r.fleetOffer.model === "gpt-oss" &&
            /vLLM/.test(r.fleetOffer.endpointLabel || ""), r && r.fleetOffer);
        check("...and the note says WHAT ran WHERE, that the machine is FREE " +
              "and owned, and that ▶ keeps it — the run is explained, not " +
              "narrated after the fact by a surprised operator",
            notes.some(n => /FREE machine you own/.test(n) && /▶/.test(n)
                         && /gpt-oss/.test(n) && /vLLM/.test(n)), notes);
        const ledger = require(path.join(ROOT, ".lcl.engine", "core", "ledger.js"));
        const rows = ledger.readAll().filter(x => !x.kind && x.sessionId === "disc-ledger");
        check("...and the ledger holds the run against the DISCOVERED endpoint " +
              "— usd 0, via local-escalation: an audit row, not a bill",
            rows.length === 1 && rows[0].via === "local-escalation" &&
            /vLLM/.test(String(rows[0].endpoint || "")) && (rows[0].usd || 0) === 0,
            rows);
    }

    /* -------- a BROKEN assignment still refuses — never a silent switch */
    {
        const why = await refusal({ task: "x" }, { session: { taskModels: {
            agentic: { model: "gpt-oss", endpointId: "ghost-endpoint" } } } });
        check("AN ASSIGNED FLEET WHOSE ENDPOINT IS GONE REFUSES, even while a " +
              "free fleet sits there live — the user PICKED a machine, and " +
              "silently substituting another is the lie resolveSelection ends. " +
              "The refusal still names the row that assigns one",
            !!why && /fleet row|▶/.test(why) && /Model Orchestration/.test(why) &&
            !/answered just now/.test(why), why);
    }

    /* ------------------------------------------------------- one task runs */
    {
        const r = await run({ task: "do the thing" });
        check("ONE TASK REACHES THE ASSIGNED FLEET AND COMES BACK ANSWERED — " +
              "this is the 'can not access it' repaired, against a live server",
            r && r.done === 1 && r.results[0].ok &&
            /fleet-answer-/.test(r.results[0].answer), r);
        check("...and the reply names where the work ran, so the operator can " +
              "see the fleet earning its keep",
            /gpt-oss/.test(r.fleet) && /vLLM/.test(r.fleet), r.fleet);
    }

    /* ------------------------------------------- many tasks, AT THE SAME TIME */
    {
        maxInflight = 0;
        const r = await run({ tasks: ["a", "b", "c", "d"] });
        check("FOUR TASKS ALL ANSWER — one call, four independent streams",
            r && r.done === 4 && r.failed === 0, r && { done: r.done, failed: r.failed });
        check("...CONCURRENTLY, measured as overlapping in-flight requests on " +
              "the server itself. Sequential would be a slower ask_cloud_model " +
              "wearing a new name — batching is the entire reason vLLM exists",
            maxInflight >= 3, { maxInflight });
    }

    /* ------------------------------------------------------- the batch cap */
    {
        const why = await refusal({ tasks: Array.from({ length: 9 }, (_, i) => "t" + i) });
        check("nine tasks is refused with the cap named — an unbounded fan-out " +
              "is a memory bill the machine pays",
            !!why && /8/.test(why), why);
    }

    /* -------------------------------------- a PAID fleet needs the two yeses */
    {
        cloud.linkEndpoint({
            id: "paid-fleet", label: "some API",
            baseUrl: `http://127.0.0.1:${fp}/v1`, apiPrefix: "/v1",
            models: [{ id: "gpt-oss" }]
        });
        const why = await refusal({ task: "x" }, { session: { taskModels: {
            agentic: { model: "gpt-oss", endpointId: "paid-fleet" } } } });
        check("A PAID ENDPOINT ASSIGNED AS THE FLEET IS REFUSED while escalation " +
              "is off. The tool survives the money gate BECAUSE a node is free — " +
              "so the tool itself must hold the line on paid targets, or " +
              "surviving becomes a spend path",
            !!why && /PAID|escalation/i.test(why), why);
    }

    /* ============== THE DISCOVERY MONEY GATE IS STRUCTURAL ============== */
    {
        const agent = require(path.join(ROOT, ".lcl.engine", "core", "agent.js"));
        // the store now holds node-fleet-test (free, fleet seat) and paid-fleet
        // (no localNode) — add a RENTED lookalike, live on the SAME mock
        cloud.linkEndpoint({
            id: "rented-fleet", label: "rented · vLLM",
            baseUrl: `http://127.0.0.1:${fp}/v1`, apiPrefix: "/v1",
            localNode: true, rented: true, nodeRole: "fleet",
            models: [{ id: "gpt-oss" }],
            node: { id: "r1", host: "127.0.0.1" }
        });
        const found = cloud.freeFleetEndpoint();
        check("freeFleetEndpoint RETURNS ONLY THE OWNED FREE FLEET SEAT — a " +
              "paid endpoint and a rented lookalike are both live on the same " +
              "mock and neither is ever discovered: the gate is structural, " +
              "not a string comparison downstream",
            !!found && found.id === "node-fleet-test", found);
        check("...and the agent OFFERS ask_fleet to an UNASSIGNED session " +
              "while that seat exists — the tool the model could never see",
            !!agent.effectiveTools({ session: { taskModels: {} } }).ask_fleet);

        // demote the one free fleet seat: no discovery target remains
        cloud.linkEndpoint({
            id: "node-fleet-test", label: "spark · vLLM",
            baseUrl: `http://127.0.0.1:${fp}/v1`, apiPrefix: "/v1",
            localNode: true, nodeRole: "chat",
            models: [{ id: "gpt-oss" }],
            node: { id: "n1", host: "127.0.0.1" }
        });
        check("...with the free seat demoted to chat, nothing is discovered",
            cloud.freeFleetEndpoint() === null);
        const why = await refusal({ task: "x" }, { session: { taskModels: {} } });
        check("...and the unassigned ask REFUSES with the row-naming text even " +
              "though a paid and a rented fleet both sit there live — " +
              "never-auto-spend held by shape, not by luck",
            !!why && /fleet row|▶/.test(why) && /Model Orchestration/.test(why), why);
        check("...and the agent WITHDRAWS ask_fleet from unassigned sessions " +
              "again — offered-when-free, deleted-when-none",
            !agent.effectiveTools({ session: { taskModels: {} } }).ask_fleet);

        // put the fleet seat back for everything below
        cloud.linkEndpoint({
            id: "node-fleet-test", label: "spark · vLLM",
            baseUrl: `http://127.0.0.1:${fp}/v1`, apiPrefix: "/v1",
            localNode: true, nodeRole: "fleet",
            models: [{ id: "gpt-oss" }],
            node: { id: "n1", host: "127.0.0.1" }
        });
    }

    /* ----------------------- the free-node exemption, pinned in the agent */
    {
        const agentSrc = fs.readFileSync(
            path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
        check("the agent OFFERS ask_fleet when this session assigned one — OR " +
              "when a free fleet seat is linked at all, so an unassigned " +
              "session can reach the machine it owns",
            /planFleet/.test(agentSrc) && /tools\.ask_fleet = cloudModels\.FLEET_ENTRY/.test(agentSrc) &&
            agentSrc.includes("if (all || planFleet || cloudModels.freeFleetEndpoint()) {"));
        check("...and the escalation money-gate deletes ask_fleet ONLY when " +
              "neither an assigned free node nor a linked free fleet seat " +
              "exists — askFleet discovers only FREE seats and refuses paid, " +
              "so surviving here still cannot spend",
            /endpointIsFreeNode/.test(agentSrc) &&
            agentSrc.includes('if (!freeNode("agentic") && !cloudModels.freeFleetEndpoint()) delete tools.ask_fleet;') &&
            agentSrc.includes('if (!freeNode("reasoning")) delete tools.ask_reasoner;'));
        check("...and the system prompt names ask_fleet for agent work instead of " +
              "gesturing at 'whatever handoff tool is available'",
            /ask_fleet/.test(agentSrc) && /IN PARALLEL/.test(agentSrc));
        check("...while ask_cloud_model, which targets the PAID driver, still " +
              "dies with escalation off — the exemption is for free machines, " +
              "not a hole",
            /delete tools\.ask_cloud_model;/.test(agentSrc));
    }

    /* =================== the donut: the window the server actually runs =================== */

    /* llama.cpp: /props says n_ctx — the serving window itself */
    {
        const llama = http.createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/props") {
                return res.end(JSON.stringify({
                    default_generation_settings: { n_ctx: 262144 } }));
            }
            res.statusCode = 404; res.end("{}");
        });
        const lp = await listen(llama);
        cloud.linkEndpoint({
            id: "node-llama-test", label: "spark · llama.cpp",
            baseUrl: `http://127.0.0.1:${lp}/v1`, apiPrefix: "/v1",
            localNode: true, nodeRole: "chat",
            models: [{ id: "big-model", contextLength: 32768, contextAssumed: true }],
            node: { id: "n1", host: "127.0.0.1" }
        });
        const r = await cloud.measureNodeWindows("node-llama-test");
        const rec = cloud.endpoints().find(e => e.id === "node-llama-test");
        const m = rec && rec.models.find(x => x.id === "big-model");
        check("LLAMA.CPP'S REAL WINDOW REPLACES THE 32k ASSUMPTION — /props says " +
              "the n_ctx the server is actually running, and the donut stops " +
              "presenting a guess as fact",
            r && r.serverWide === 262144 && m && m.contextLength === 262144, { r, m });
        check("...and the record stops claiming the number was assumed, because " +
              "it no longer is",
            m && !m.contextAssumed, m);
        await new Promise(r2 => llama.close(r2));
    }

    /* vLLM: max_model_len rides its own model list */
    {
        const r = await cloud.measureNodeWindows("node-fleet-test");
        const rec = cloud.endpoints().find(e => e.id === "node-fleet-test");
        const m = rec && rec.models.find(x => x.id === "gpt-oss");
        check("vLLM'S WINDOW COMES FROM ITS OWN max_model_len — fixed at launch, " +
              "reported by the server, never assumed",
            r && m && m.contextLength === 131072, { r, m });
    }

    /* a server that answers neither shape leaves the assumption IN PLACE */
    {
        const mute = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
        const mp = await listen(mute);
        cloud.linkEndpoint({
            id: "node-mute-test", label: "mystery",
            baseUrl: `http://127.0.0.1:${mp}/v1`, apiPrefix: "/v1",
            localNode: true,
            models: [{ id: "m", contextLength: 32768, contextAssumed: true }],
            node: { id: "n1", host: "127.0.0.1" }
        });
        const r = await cloud.measureNodeWindows("node-mute-test");
        const rec = cloud.endpoints().find(e => e.id === "node-mute-test");
        const m = rec && rec.models.find(x => x.id === "m");
        check("a server that will not say keeps its ASSUMED marking — an honest " +
              "guess beats a confident fabrication, in that order",
            r === null && m && m.contextLength === 32768 && m.contextAssumed === true, { r, m });
        await new Promise(r2 => mute.close(r2));
    }

    /* connect() runs the probe for nodes, so it heals on every (re)link */
    {
        const cm = fs.readFileSync(
            path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"), "utf8");
        check("connect() measures windows on every node link, so the fix reaches " +
              "his Spark on the next refresh rather than requiring a ritual",
            /if \(node\) \{ try \{ await measureNodeWindows\(epId\); \}/.test(cm));
        check("...and connect()'s own node trim carries doorBackendPort — the " +
              "THIRD trim site, found because the first two were fixed and the " +
              "guard still could not see which server the door proxies",
            /doorBackendPort: Number\(node\.doorBackendPort\) > 0/.test(cm));
    }

    /* ================= the measurement has to SURVIVE the next poll ================= */
    {
        /* "i restarted .lcl ... this is not complete. it shows 32k."
         *
         * His store held 262144 at 07:18 and 32768 (ASSUMED) again at 07:25. The
         * app overwrote it: every catalogue refresh calls linkEndpoint with a
         * freshly built models array, and modelRecords fills contextLength from
         * the flat assumption for any model whose host publishes no window. So
         * the measurement was destroyed by the next poll — healing it faster
         * would only have lost the same race more often.
         *
         * This is that exact sequence, in order, against the real functions. */
        const before = await cloud.measureNodeWindows("node-fleet-test");
        const measured = cloud.endpoints().find(e => e.id === "node-fleet-test")
            .models.find(m => m.id === "gpt-oss").contextLength;
        check("the window is measured off the engine first",
            before && measured === 131072, { before, measured });

        // THE REFRESH: the same call the nodes poll makes, carrying the same
        // flat assumption modelRecords produces for a host that publishes none
        cloud.linkEndpoint({
            id: "node-fleet-test", label: "spark · vLLM",
            baseUrl: `http://127.0.0.1:${fp}/v1`, apiPrefix: "/v1",
            localNode: true, nodeRole: "fleet",
            models: [{ id: "gpt-oss", contextLength: 32768, contextAssumed: true }],
            node: { id: "n1", host: "127.0.0.1" }
        });
        const after = cloud.endpoints().find(e => e.id === "node-fleet-test")
            .models.find(m => m.id === "gpt-oss");

        check("A MEASURED WINDOW SURVIVES THE REFRESH THAT USED TO DESTROY IT. " +
              "This file already carries localNode, rented, nodeRole and plan " +
              "through a relink for the same reason — a poll must not quietly " +
              "unlearn something the app went and measured",
            after.contextLength === 131072, after);
        check("...and it stops calling itself assumed, because it is not",
            !after.contextAssumed, after);

        /* THE ONE CASE WHERE THE NEW NUMBER WINS: a host that starts publishing
         * a real window is newer truth than anything stored. Keeping the old
         * figure there would be the same sin in the opposite direction. */
        cloud.linkEndpoint({
            id: "node-fleet-test", label: "spark · vLLM",
            baseUrl: `http://127.0.0.1:${fp}/v1`, apiPrefix: "/v1",
            localNode: true, nodeRole: "fleet",
            models: [{ id: "gpt-oss", contextLength: 200000 }],
            node: { id: "n1", host: "127.0.0.1" }
        });
        const republished = cloud.endpoints().find(e => e.id === "node-fleet-test")
            .models.find(m => m.id === "gpt-oss");
        check("...but a host that PUBLISHES a real window overwrites the stored " +
              "one — measured-beats-assumed is a rule about evidence, not a lock",
            republished.contextLength === 200000, republished);

        /* AN ASSUMPTION NEVER OUTRANKS ANYTHING, including a later assumption.
         * Caught by mutation: letting assumed values survive too passed every
         * check above, and would pin a stale guess from an old build forever. */
        cloud.linkEndpoint({ id: "assume-test", label: "guessy",
            baseUrl: `http://127.0.0.1:${fp}/v1`, apiPrefix: "/v1", localNode: true,
            models: [{ id: "g", contextLength: 32768, contextAssumed: true }],
            node: { id: "n1", host: "127.0.0.1" } });
        cloud.linkEndpoint({ id: "assume-test", label: "guessy",
            baseUrl: `http://127.0.0.1:${fp}/v1`, apiPrefix: "/v1", localNode: true,
            models: [{ id: "g", contextLength: 16384, contextAssumed: true }],
            node: { id: "n1", host: "127.0.0.1" } });
        const guess = cloud.endpoints().find(e => e.id === "assume-test")
            .models.find(m => m.id === "g");
        check("...and an ASSUMED value is never pinned — only a measurement earns " +
              "the right to survive a refresh, or a stale guess from an old build " +
              "outlives every correction",
            guess.contextLength === 16384 && guess.contextAssumed === true, guess);

        /* THE SECOND WRITER. keepMeasuredWindows went into linkEndpoint, and
         * refreshEndpointCatalogue writes the store DIRECTLY — so a measured
         * window survived one launch and the next catalogue heal threw it away.
         * Found by simulating two launches back to back against his real store,
         * not by reading either function. Both writers must merge. */
        {
            const cmSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core",
                "cloudModels.js"), "utf8");
            // literal split, not a regex: three separate assertions tonight were
            // written as patterns whose backslashes were eaten before they hit
            // disk, and each one silently changed meaning
            const writers = cmSrc.split("keepMeasuredWindows(").length - 1;
            check("EVERY WRITER OF THE MODEL LIST MERGES MEASURED WINDOWS — there " +
                  "are two (linkEndpoint and refreshEndpointCatalogue) and fixing " +
                  "one let the other undo it on the next launch",
                writers >= 3, { callsIncludingDefinition: writers });
            check("...specifically the catalogue refresh, which is the path that " +
                  "provably runs at every launch",
                cmSrc.includes("models: keepMeasuredWindows(models, (store.endpoints[ep.id] || {}).models)"));
        }

        // put it back so the checks below see the measured figure
        cloud.linkEndpoint({
            id: "node-fleet-test", label: "spark · vLLM",
            baseUrl: `http://127.0.0.1:${fp}/v1`, apiPrefix: "/v1",
            localNode: true, nodeRole: "fleet",
            models: [{ id: "gpt-oss" }],
            node: { id: "n1", host: "127.0.0.1" }
        });
        await cloud.measureNodeWindows("node-fleet-test");
    }

    /* ============ what the stale window ACTUALLY cost, measured through router ========= */
    {
        /* Read out of his own session store, hours after llama.cpp was measured
         * over ssh at "n_ctx": 262144:
         *
         *     node-...-30000  unsloth/Qwen3.6-35B-A3B  ctx=32768 (ASSUMED)
         *
         * router.limits() derives the OUTPUT budget, the HISTORY window and
         * maxSteps from that one number — so a stale figure is not cosmetic. It
         * produced three symptoms it was reported as unrelated: a 32k donut, a
         * conversation that forgot itself mid-thread, and "the model spent its
         * whole reply thinking and never produced the answer" — three times in
         * one session, because 32768/4 is the 8k budget this codebase already
         * records a reasoning model burning entirely inside its own head. */
        const router = require(path.join(ROOT, ".lcl.engine", "core", "router.js"));
        const selWith = (ctx) => ({
            id: "node-fleet-test", label: "spark · llama.cpp",
            baseUrl: "http://127.0.0.1:1/v1", localNode: true,
            node: { id: "n1", host: "127.0.0.1" },
            model: "m", models: [{ id: "m", contextLength: ctx }]
        });
        const stale = router.limits(selWith(32768));
        const real = router.limits(selWith(262144));

        check("ONE STALE NUMBER STARVED THE OUTPUT BUDGET: at the assumed 32k a " +
              "reply gets 8k of room, which is the exact budget this codebase " +
              "already records a reasoning model spending entirely on thinking",
            stale.maxTokens <= 8192 && real.maxTokens >= stale.maxTokens * 2,
            { stale: stale.maxTokens, real: real.maxTokens });

        check("...and it trimmed the conversation: the history window at the real " +
              "262k is far larger than at the assumed 32k, which is why a live " +
              "session answered \"I don't have context for what the previous " +
              "response was supposed to cover\"",
            real.historyWindow > stale.historyWindow,
            { stale: stale.historyWindow, real: real.historyWindow });

        check("...and tool output was capped against the same wrong figure",
            real.toolResultCap >= stale.toolResultCap,
            { stale: stale.toolResultCap, real: real.toolResultCap });

        check("...and the basis line quotes the window it actually used, so the " +
              "number is auditable rather than folklore",
            /262k/.test(real.basis) && /33k/.test(stale.basis),
            { stale: stale.basis, real: real.basis });
    }

    /* ================= and it heals without a ritual ================= */
    {
        const main = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
        check("THE WINDOW IS RE-READ ON THE ORDINARY NODES REFRESH, not only on a " +
              "re-link. measureNodeWindows existed and ran solely inside connect() " +
              "— a fix that needs a ritual to take effect is a fix the operator " +
              "does not have",
            /async function healNodeWindows/.test(main) &&
            /await healNodeWindows\(n\);/.test(main));
        check("...at the same cadence the model list is kept fresh, because a " +
              "server restarted with a different --ctx-size serves a different " +
              "window and a stale one silently truncates the conversation",
            main.indexOf("await healNodeWindows(n);") >
            main.indexOf("await syncNodeModels(n, serving);"));
        check("...across EVERY endpoint the node owns — llama.cpp, vLLM and " +
              "Ollama each publish their own window",
            /for \(const ep of nodeEndpointsOf\(n\)\)/.test(main));
    }

    await new Promise(r => fleet.close(r));
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 8 }); }
    catch { /* held */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error("HARNESS ERROR:", (e && e.stack) || e);
    process.exit(1);
});
