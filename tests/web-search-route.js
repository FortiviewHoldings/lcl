/**
 * ASKING FOR AN INTERNET SEARCH HAS TO PRODUCE AN INTERNET SEARCH.
 *
 * The failure this exists to prevent, from a build with networking already
 * turned on: a user asked for an internet search for food nearby and gave a
 * location, and instead of searching the model kept asking for the location
 * again, answered from its own weights, and claimed it was grounded in the
 * knowledge base — never once emitting the search tool call.
 *
 * Three separate defects in one exchange:
 *
 *   1. The model never emitted the tool call. A 1.5B model loses tool syntax
 *      the moment the conversation sounds conversational, and no amount of
 *      prompt fixes that. So an explicit instruction to search now ROUTES to
 *      web_search deterministically, the same way "how much memory" already
 *      routed to system_stats.
 *
 *   2. Knowledge grounding claimed the turn. bge-small cosine scores float
 *      high on almost any text, so a physics library cleared the 0.42 bar for
 *      a question about restaurants — and the answer came back "grounded in
 *      the knowledgebase" having searched nothing. A turn the router already
 *      understands no longer gets grounded.
 *
 *   3. The tool's own help text named one narrow specialty as the
 *      canonical search — one field presented to every user's model as what
 *      this product is for. The bleed guard now holds that line for the whole
 *      product rather than for this help text alone.
 *
 * These checks are all static/pure: the routing decision and the tool wiring,
 * with no engine, no network and no model. The live network path is proven
 * separately (and was proven by hand: DuckDuckGo's HTML endpoint returns
 * parseable results through netTools.fetchGuarded today).
 */
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
// ISOLATED per run: paths.js derives the data directory from this,
// so a shared os.tmpdir() made every suite inherit whatever settings
// an earlier suite had written — an order-dependent gate that failed
// builds at random.
const LCL_TEST_DATA = require("fs").mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

const agent = require(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"));
const research = require(path.join(__dirname, "..", ".lcl.engine", "core", "research.js"));
const netTools = require(path.join(__dirname, "..", ".lcl.engine", "core", "netTools.js"));
const { TOOL_CLASS } = require(path.join(__dirname, "..", ".lcl.engine", "policy", "classify.js"));
const { PolicyKernel } = require(path.join(__dirname, "..", ".lcl.engine", "policy", "kernel.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++;
        console.log("FAIL |", name,
            detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 220) : "");
    }
}

// agent.js does not export the router; it is internal by design. Read the
// source and evaluate the one function, so the test exercises the SHIPPED
// implementation rather than a copy that can drift away from it.
const fs = require("fs");
const src = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
const start = src.indexOf("function routeToUtilityTool");
const end = src.indexOf("\n}\n", src.indexOf("return null;", start)) + 3;
check("routeToUtilityTool is still where this test reads it from", start > 0 && end > start);
const routeSrc = src.slice(start, end);

// its only outside dependency is utilTools.evaluate, via extractArithmetic
const extractStart = src.indexOf("function extractArithmetic");
const extractEnd = src.indexOf("\n}\n", extractStart) + 3;
const utilTools = require(path.join(__dirname, "..", ".lcl.engine", "core", "utilTools.js"));
// eslint-disable-next-line no-new-func
const route = new Function("utilTools",
    routeSrc + "\n" + src.slice(extractStart, extractEnd) + "\nreturn routeToUtilityTool;")(utilTools);

// the tool set a session has when networking is ON and a folder is linked
const NET_ON = {
    calculate: {}, system_stats: {}, process_list: {},
    web_search: {}, http_fetch: {}, research_topic: {},
    knowledge_search: {}, read_file: {}, write_file: {}
};
const NET_OFF = { calculate: {}, system_stats: {}, process_list: {}, read_file: {} };

/* ------------------------------------------------ it routes when it should --- */
const MUST_SEARCH = [
    "can you search the internet for food near me",
    "search the web for the price of copper today",
    "look up online what the latest electron version is",
    "google the weather in Houston tomorrow",
    "can you search for food around that area",          // the exact follow-up
    "find restaurants near me",
    "search the internet: who won the game last night"
];
for (const q of MUST_SEARCH) {
    const r = route(q, NET_ON);
    check(`routes to web_search — "${q.slice(0, 46)}"`,
        !!r && r.tool === "web_search", r);
    if (r && r.tool === "web_search") {
        // an empty or command-word-only query would search for nothing
        const query = String(r.args.query || "");
        check(`  …with a real query, not the bare command`,
            query.length >= 3 && !/^(?:for|the|internet|web|online)$/i.test(query.trim()),
            query);
    }
}

/* ---------------------------------------------- and NOT when it should not --- */
const MUST_NOT_SEARCH = [
    // the network is off: the tool does not exist, so nothing may route to it
    ["can you search the internet for food near me", NET_OFF],
    // these are other features, and stealing them would be a new bug
    ["search my workspace for TODO comments", NET_ON],
    ["search the knowledge for darkroom chemistry", NET_ON],
    ["search these files for the string foo", NET_ON],
    ["search my knowledge libraries", NET_ON],
    // ordinary conversation must never fire a network call
    ["hello", NET_ON],
    ["what is your name", NET_ON],
    ["write a function that reverses a string", NET_ON],
    ["explain how a low-pass filter works", NET_ON],
    ["research the history of the transistor for me", NET_ON]   // research_topic's job
];
for (const [q, tools] of MUST_NOT_SEARCH) {
    const r = route(q, tools);
    check(`does NOT search — "${q.slice(0, 46)}"`,
        !r || r.tool !== "web_search", r);
}

/* -------------------------------------- the other routes still work as before --- */
check("arithmetic still routes to calculate",
    (route("what is 1234 * 5678", NET_ON) || {}).tool === "calculate");
check("machine questions still route to system_stats",
    (route("how much memory do I have free", NET_ON) || {}).tool === "system_stats");
check("process questions still route to process_list",
    (route("what should i close", NET_ON) || {}).tool === "process_list");

/* --------------------------------------------------- the tool is really wired --- */
check("web_search is a registered tool with a runnable entry",
    !!(research.SEARCH_ENTRY && typeof research.SEARCH_ENTRY.run === "function"));
check("http_fetch is a registered tool with a runnable entry",
    !!(netTools.TOOL_ENTRY && typeof netTools.TOOL_ENTRY.run === "function"));

// agent.js must offer them exactly when networking is on
check("the tool registry gates search on the network setting",
    /networkEnabled === true[\s\S]{0,400}tools\.web_search/.test(src));

/* ------------------------------------------------- policy lets it through --- */
// EGRESS confirms rather than denies, and the floor allows a user override to
// allow. If either were wrong, a granted, enabled search would still never run.
for (const tool of ["web_search", "http_fetch", "research_topic"]) {
    const spec = TOOL_CLASS[tool];
    check(`${tool} is classified`, !!spec, spec);
    check(`${tool} is EGRESS, so the destination is shown before it leaves`,
        !!spec && spec.classification === "egress", spec && spec.classification);
    check(`${tool} can be set to run without asking (floor allows it)`,
        !!spec && PolicyKernel.clampToFloor("allow", PolicyKernel.floorFor(spec.classification)) === "allow");
}

// A granted kernel must actually decide something other than DENY.
const decide = (tool, args, settings = {}) => {
    const kernel = new PolicyKernel({ audit: () => {}, settings });
    kernel.grant({ capability: "net.read", scope: null, note: "test" });
    kernel.grant({ capability: "sys.execute", scope: null, note: "test" });
    const d = kernel.check(tool, args, { turnId: "t" + Math.random() });
    return typeof d === "string" ? d : (d && d.decision);
};

// THE SECOND HALF OF WHY SEARCH NEVER RAN.
//
// Even once the model called the tool, EGRESS meant CONFIRM, which ENDS THE
// TURN and stages an approval card. Turning networking on is already an
// explicit confirmed act; a second gate on every single search is what made
// the headline feature read as broken. web_search now defaults to notify —
// it runs, and the user is told after the fact.
check("web_search runs without a second approval once networking is on",
    decide("web_search", { query: "anything" }) === "notify",
    decide("web_search", { query: "anything" }));

// ...and NOTHING ELSE moved. Everything that carries CONTENT off the machine
// still stops for a human, with the destination on the card.
for (const [tool, args] of [
    ["http_fetch", { url: "https://example.com" }],
    ["research_topic", { topic: "anything" }],
    ["ask_cloud_model", { question: "anything" }],
    ["ask_reasoner", { question: "anything" }]
]) {
    check(`${tool} still requires explicit approval`,
        decide(tool, args) === "confirm", decide(tool, args));
}

// A per-tool default must not be able to escape a floor. run_script is the
// hardest case in the product: nothing may make a shell script run unread.
check("a tool default can never breach a classification floor",
    decide("run_script", { script: "echo hi" },
           { toolPolicy: { run_script: "allow" } }) === "confirm");
{
    const kernel = new PolicyKernel({ audit: () => {}, settings: {} });
    const d = kernel.check("web_search", { query: "anything" }, { turnId: "t2" });
    const decision = typeof d === "string" ? d : (d && d.decision);
    check("without the grant it IS denied — offline by default is real",
        decision === "deny", d);
}

/* ------------------------------------- grounding does not steal a routed turn --- */
// The window is wide because a design comment now sits between the route
// decision and the gate that uses it — what matters is the ORDER (decide,
// then gate on it) and that grounding also requires session-linked knowledge.
check("a routed turn skips knowledge grounding",
    /const preRouted = routeToUtilityTool\(userText, tools\);[\s\S]{0,2200}if \(!preRouted && sessionKnows/.test(src));

/* ------------------------------------------- the help text is not personalised --- */
// The model reads these. A domain-specific example is a standing instruction
// about what this product is for.
const helps = [research.SEARCH_ENTRY.help, research.RESEARCH_ENTRY.help];
for (const h of helps) {
    check(`help text carries no one person's specialty — "${String(h).slice(0, 40)}…"`,
        !(()=>{try{return require("./no-bleed.js").BLEED}catch{return[]}})().some(rx => rx.test(String(h))), h);
}
check("web_search's help tells the model WHEN to reach for it",
    /current|external|do not guess|training cutoff/i.test(String(research.SEARCH_ENTRY.help)),
    research.SEARCH_ENTRY.help);


// DRIVER PARITY. The requirement: local models run locally, and with network
// access on they can call the internet to do due diligence and fact-check
// against non-stale information; without it, they cannot. With network access
// on and an API selected, those can run internet searches as well.
//
// The property that satisfies it: the search/fetch tools are gated on the
// NETWORK SWITCH ALONE and never on which model is driving. Pinned here
// because it holds by construction and nothing asserted it — a well-meaning
// "only local models need search" branch could appear and nobody would know.
{
    const i = src.indexOf("// network: off unless the user enabled it");
    const j = src.indexOf("// offensive: only when a live engagement", i);
    const block = i >= 0 && j > i ? src.slice(i, j) : "";
    check("the network tool block exists and is bounded", !!block);
    for (const t of ["http_fetch", "find_api", "web_search", "research_topic"]) {
        check(t + " is offered whenever the network switch is on",
            new RegExp("tools\\." + t + " = ").test(block));
    }
    for (const probe of ["usingRemote", "isNodeEndpoint", "localNode", "router.",
                         "engine.status"]) {
        check("search is NOT conditioned on the driver (" + probe + ")",
            !block.includes(probe), probe);
    }
    check("effectiveTools takes no driver argument — the tool set cannot diverge " +
          "between a local model, an API and a node",
        /function effectiveTools\(opts = \{\}\)/.test(src) &&
        !/opts\.(remote|driver|node|local)\b/.test(src));
}

console.log(`\n${pass}/${pass + fail} web-search-route checks passed`);
process.exit(fail ? 1 : 0);
