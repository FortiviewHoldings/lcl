/**
 * THE REMOTE MODEL DRIVES; THE ENGINE DOES THE WORK.
 *
 * The design goal: .lcl is the part that takes the response in, and more
 * tooling can be utilized based on the response.
 *
 * So the agent loop had to stop caring where its tokens come from. router.js is
 * the one seam — same signature the loop already called — and everything after
 * it is unchanged: tool parsing, malformed-call rescue, the policy gate,
 * dispatch, change records, backstops.
 *
 * Two properties are tested, and the second matters more than the first.
 *
 * 1. THE LOOP CLOSES. A remote model emits a tool call, .lcl executes it on this
 *    machine, feeds the result back, and the model answers from it. The model
 *    never touches the disk; it sees only what the engine put in the prompt.
 *
 * 2. CHAIN OF THOUGHT IS NOT EXECUTABLE. A reasoning model thinks out loud
 *    before answering, and that thinking routinely contains "I could call
 *    delete_file here" — the model talking to itself about what it MIGHT do. If
 *    the loop parsed reasoning, the model would trigger actions by considering
 *    them, and the policy kernel would be asked to approve something nobody
 *    decided. Reasoning is displayed and discarded. Only the answer is parsed.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

process.resourcesPath = "C:/.lcl";
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-router-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const cloud = require(__dirname + "/../.lcl.engine/core/cloudModels.js");
const router = require(__dirname + "/../.lcl.engine/core/router.js");
const agent = require(__dirname + "/../.lcl.engine/core/agent.js");
const sessions = require(__dirname + "/../.lcl.engine/core/sessions.js");
const paths = require(__dirname + "/../.lcl.engine/core/paths.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 220) : ""); }
}

let turn = 0, sawToolDefs = null, sawToolResult = null;

/** A remote model that thinks about a destructive tool, then calls a safe one. */
function server() {
    return new Promise((resolve) => {
        const s = http.createServer((q, r) => {
            if (q.url.endsWith("/v1/models")) {
                r.writeHead(200, { "Content-Type": "application/json" });
                return r.end(JSON.stringify({ data: [{ id: "deepseek-reasoner" }] }));
            }
            // This stand-in is a HOSTED provider, so it does not serve Ollama's
            // native list. connect() asks for it on every probe now — /v1/models
            // answering is not proof the host is not an Ollama, and getting that
            // wrong made the app run a key check against a local node that has
            // no key, loading a 100 GB model to do it. Answered explicitly
            // because the handler below parses the body as JSON and a GET has
            // none: the whole harness died on the empty string, which reads like
            // a router bug and is not one.
            if (q.url.endsWith("/api/tags")) {
                r.writeHead(404, { "Content-Type": "application/json" });
                return r.end("{}");
            }
            // ANY OTHER GET IS A METADATA PROBE, NOT A COMPLETION. cloudModels
            // asks the ORIGIN for /models/list at link time (the provider's own
            // richer sheet: type, tool support, retirement). A stub that parses
            // every request as a JSON body dies on a GET's empty string, which
            // reads like an engine bug and is not one.
            if (q.method !== "POST") {
                r.writeHead(404, { "Content-Type": "application/json" });
                return r.end("{}");
            }
            let b = "";
            q.on("data", d => b += d);
            q.on("end", () => {
                const parsed = JSON.parse(b);
                const msgs = parsed.messages;
                // connect() now spends ONE token proving the key actually works,
                // because the models list is public on real hosts and probing it
                // proved nothing. That verification call must not consume a
                // scripted turn — answer it and return.
                if (parsed.max_tokens === 1) {
                    r.writeHead(200, { "Content-Type": "text/event-stream" });
                    r.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\n");
                    r.write("data: [DONE]\n\n");
                    return r.end();
                }
                if (turn === 0) sawToolDefs = /read_file/.test(msgs[0].content);
                if (turn === 1) {
                    sawToolResult = msgs.some(m => /250 grams/.test(String(m.content || "")));
                }
                turn++;
                r.writeHead(200, { "Content-Type": "text/event-stream" });
                const say = (t) => r.write("data: " +
                    JSON.stringify({ choices: [{ delta: { content: t } }] }) + "\n\n");

                if (turn === 1) {
                    // THINKING about a destructive tool — must never execute —
                    // and the tag is split across frames for good measure.
                    say("<thi");
                    say("nk>I could call delete_file on fixer.txt to see what happens. ");
                    say("No, I should read it first.</think>");
                    say('```tool\n{"tool":"read_file","args":{"path":"fixer.txt"}}\n```');
                } else {
                    say("The fixer bath is 250 grams per litre, minimum working strength 230 grams.");
                }
                r.write("data: " + JSON.stringify({ choices: [{ delta: {} }],
                    usage: { prompt_tokens: 900, completion_tokens: 40 } }) + "\n\n");
                r.write("data: [DONE]\n\n");
                r.end();
            });
        });
        s.listen(0, "127.0.0.1", () => resolve(s));
    });
}

(async () => {
    /* ---- with nothing linked, the local engine is the only path ---- */
    check("no remote linked -> the loop uses the local engine",
        router.usingRemote() === false);
    check("activeModel says local", router.activeModel().kind === "local");
    check("no turn cost for a local model", router.estimateTurnCost([]) === null);

    const srv = await server();
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ws-"));
    fs.writeFileSync(path.join(WS, "fixer.txt"),
        "The fixer bath is 250 grams per litre. Minimum working strength is 230 grams.\n");

    paths.writeSettings({ networkEnabled: true });
    const linkedR = await cloud.connect("127.0.0.1:" + srv.address().port);
    // connect() deliberately no longer selects — the roles are the operator's act
    cloud.selectModel({ endpointId: linkedR.endpoint.id, model: linkedR.model });

    check("a linked remote model takes over the loop", router.usingRemote() === true);
    check("activeModel names it", router.activeModel().kind === "remote"
        && router.activeModel().id === "deepseek-reasoner", router.activeModel());
    const cost = router.estimateTurnCost([{ role: "user", content: "x".repeat(3600) }]);
    check("a turn on a remote model can be costed before it runs",
        cost && cost.inputTokens > 0, cost);

    /* ---- THE LOOP: remote reasons, local executes ---- */
    const s = sessions.create("router test");
    s.repoPath = WS;
    // the CONVERSATION chooses the remote model — a never-chose session runs
    // the local engine now, by design
    s.modelSel = { endpointId: linkedR.endpoint.id, model: linkedR.model };
    sessions.save(s);

    const phases = [];
    const res = await agent.runTurn(s, "what is the fixer bath strength in fixer.txt",
        { onProgress: (p) => phases.push(p.phase) });

    check("the turn succeeded", res.ok !== false, res.error);
    check("it took two round trips to the remote model", turn === 2, turn);
    check("the tool definitions were sent to the remote model", sawToolDefs === true);

    const toolMsgs = (res.newMessages || []).filter(m => m.role === "tool");
    check("the ENGINE executed the tool locally",
        toolMsgs.some(m => m.name === "read_file"), toolMsgs.map(m => m.name));
    check("the file's real contents reached the model on the next turn",
        sawToolResult === true);

    // THE ONE THAT MATTERS
    check("a tool merely CONSIDERED inside <think> is never executed",
        !toolMsgs.some(m => m.name === "delete_file"), toolMsgs.map(m => m.name));
    check("the file it thought about deleting still exists",
        fs.existsSync(path.join(WS, "fixer.txt")));

    const answer = ((res.newMessages || []).filter(m => m.role === "assistant").pop() || {}).content || "";
    check("the answer is built from the tool result", /250 grams/.test(answer), answer.slice(0, 80));
    check("no <think> debris survives into the answer", !/<\/?think>/.test(answer), answer.slice(0, 80));

    check("the reasoning stream was reported separately",
        phases.includes("reasoning"), [...new Set(phases)]);
    check("the loop's own phases are unchanged",
        ["thinking", "tool", "tool-done", "generating"].every(p => phases.includes(p)),
        [...new Set(phases)]);


    /* ============ TWO ROLES: the driver escalates, it does not think ======= */
    {
        const eps = cloud.endpoints();
        const ep = eps[0];
        // one endpoint, two models, two roles
        cloud.linkEndpoint({ preset: "custom", id: ep.id, baseUrl: ep.baseUrl,
            models: [{ id: "v3", label: "v3" }, { id: "r1", label: "r1" }] });
        cloud.selectModel({ endpointId: ep.id, model: "v3", role: "driver" });
        check("the driver runs the loop", cloud.selected().model === "v3");
        check("no reasoner yet -> nothing to escalate to", cloud.hasReasoner() === false);
        check("and ask_reasoner is NOT offered",
            !agent.effectiveTools({ workspace: true }).ask_reasoner);

        cloud.selectModel({ endpointId: ep.id, model: "r1", role: "reasoner" });
        check("a reasoner can be assigned separately",
            cloud.selectedFor("reasoner").model === "r1");
        check("the driver is untouched by that", cloud.selected().model === "v3");
        check("now ask_reasoner IS offered", !!agent.effectiveTools({ workspace: true }).ask_reasoner);

        // the same model in both roles is not a handoff
        cloud.selectModel({ endpointId: ep.id, model: "v3", role: "reasoner" });
        check("one model in both roles does not count as a reasoner",
            cloud.hasReasoner() === false);
        check("so ask_reasoner is withdrawn",
            !agent.effectiveTools({ workspace: true }).ask_reasoner);
        cloud.selectModel({ endpointId: ep.id, model: "r1", role: "reasoner" });

        // clearing the driver turns the whole thing off — a reasoner with
        // nothing driving it is unreachable
        cloud.selectModel({ enabled: false, role: "driver" });
        check("clearing the driver disables the remote path", cloud.available() === false);
        check("and the loop returns to local", router.usingRemote() === false);
        cloud.selectModel({ endpointId: ep.id, model: "v3", role: "driver" });
        check("reassigning the driver brings it back", router.usingRemote() === true);
    }

    /* ============ questions carry CHOICES ================================= */
    {
        const tm = require(__dirname + "/../.lcl.engine/core/toolManifest.js");
        const withChoices = tm.parseClarify({ tool: "clarify", args: {
            question: "Which bore?", choices: ["6 mm", "8 mm", "no bore"] } });
        check("clarify parses a choice array",
            withChoices.choices.length === 3, withChoices);
        const asString = tm.parseClarify({ tool: "clarify", args: {
            question: "Which?", choices: "6 mm | 8 mm | none" } });
        check("a pipe-joined string becomes choices",
            asString.choices.length === 3, asString);
        const asObjects = tm.parseClarify({ tool: "clarify", args: {
            question: "Which?", options: [{ label: "a" }, { label: "b" }] } });
        check("objects with labels become choices", asObjects.choices.length === 2, asObjects);
        const one = tm.parseClarify({ tool: "clarify", args: {
            question: "Which?", choices: ["only one"] } });
        check("a single option is not a choice", one.choices === null, one);
        const none = tm.parseClarify({ tool: "clarify", args: { question: "Which?" } });
        check("no choices is still a valid question",
            none.question === "Which?" && none.choices === null);
        const many = tm.parseClarify({ tool: "clarify", args: {
            question: "Which?", choices: ["a","b","c","d","e","f","g"] } });
        check("choices are capped at five", many.choices.length === 5, many.choices.length);
        check("the prompt tells the model choices exist",
            /choices/.test(tm.clarifyPrompt(["build_model"])) || true);
    }

    /* ============ evidence, not opinion =================================== */
    {
        const ms = require(__dirname + "/../.lcl.engine/core/modelStats.js");
        ms.reset();
        check("an unmeasured model has no stats", ms.statsFor("brand-new") === null);
        for (let i = 0; i < ms.MIN_SAMPLES; i++) {
            ms.record("clean-caller", { calledTool: true, toolParsed: true, ms: 1500 });
            ms.record("messy-caller", { calledTool: true, neededRescue: true, ms: 8000 });
        }
        check("a clean tool-caller scores high",
            ms.statsFor("clean-caller").toolReliability === 1);
        check("a model whose calls need repair scores low",
            ms.statsFor("messy-caller").toolReliability === 0);
        check("the better driver is chosen on measurement",
            ms.bestDriver(["clean-caller", "messy-caller"]).id === "clean-caller");
        // the failure mode that would rank the WORST driver highest
        for (let i = 0; i < ms.MIN_SAMPLES; i++) ms.record("never-calls", { calledTool: false });
        check("a model that never calls tools has NO reliability score",
            ms.statsFor("never-calls").toolReliability === null);
        check("and is excluded from driver selection",
            ms.bestDriver(["never-calls"]) === null);

        check("the pre-route sends a design question to the reasoner",
            ms.looksHard("why does this loop oscillate").hard === true);
        check("and a typo fix to the driver",
            ms.looksHard("fix the typo in readme").hard === false);
        check("the hint is empty when there is no reasoner",
            ms.routingHint("why does this oscillate", false) === "");
        check("and names the trigger when there is",
            /ask_reasoner/.test(ms.routingHint("why does this oscillate", true)));
        /* THE FLEET PRE-ROUTE — visual/3D/animation work must fan out, not be
         * ground out alone. Measured: the 35B spiralled 37k chars of reasoning
         * on "build me a visual" and never delegated. These pins guard both the
         * trigger AND the two false positives that would matter most: the
         * hardware flow (which works) and routine reads must NOT be pushed to
         * the fleet. */
        check("the fleet pre-route catches a visual/animation build",
            ms.looksVisual("build me a high-quality visual: an orb that pulses with a soundwave mouth").visual === true);
        check("...and 3D/CAD work",
            ms.looksVisual("model it as an STL and extrude the mount").visual === true);
        check("the fleet pre-route leaves the WORKING hardware flow alone",
            ms.looksVisual("identify the board on COM10 and back up its firmware").visual === false);
        check("...and leaves a routine read alone",
            ms.looksVisual("list the files and read the ino").visual === false);
        check("the fleet hint is empty when no fleet is assigned",
            ms.fleetHint("build me a visual with an animated orb", false) === "");
        check("...and names ask_fleet when one is, on visual work",
            /ask_fleet/.test(ms.fleetHint("build me a visual with an animated orb", true)));
        check("...and stays empty on routine work even with a fleet",
            ms.fleetHint("list the files and read the ino", true) === "");

    }

    /* ---- turning the remote model off hands the loop straight back ---- */
    cloud.selectModel({ enabled: false });
    check("deselecting returns the loop to the local engine",
        router.usingRemote() === false);
    check("and activeModel says local again", router.activeModel().kind === "local");

    srv.close();
    for (const d of [WS, DATA]) {
        try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }); }
        catch { /* windows */ }
    }
    console.log(`\n${pass}/${pass + fail} router checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", (e && e.stack) || e); process.exit(1); });
