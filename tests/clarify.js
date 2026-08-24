/**
 * "I can do that, but I need constraints."
 *
 * The user described the behaviour they want in one sentence, and it is the
 * whole point of the manifest: a model handed an underspecified job should
 * neither refuse ("I cannot create 3D models") nor guess and produce confident
 * nonsense. It should ask ONE question and offer something concrete.
 *
 * That only works if asking is a LEGAL MOVE — a thing the model can emit and
 * the agent understands — rather than an error path. These checks pin that.
 */
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
// ISOLATED per run: paths.js derives the data directory from this,
// so a shared os.tmpdir() made every suite inherit whatever settings
// an earlier suite had written — an order-dependent gate that failed
// builds at random.
const fs = require("fs");
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const tm = require(__dirname + "/../.lcl.engine/core/toolManifest.js");
const agent = require(__dirname + "/../.lcl.engine/core/agent.js");
const { extractToolCall } = require(__dirname + "/../.lcl.engine/core/toolParse.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}

/* ---- the clarify action is understood ---- */
const parsed = tm.parseClarify({
    tool: "clarify",
    args: { question: "What overall dimensions?", offer: "a 20 mm cube" }
});
check("a clarify emission is recognised", !!parsed && /dimensions/.test(parsed.question), parsed);
check("the concrete offer is carried through", parsed.offer === "a 20 mm cube");

check("a clarify with no question is not valid",
    tm.parseClarify({ tool: "clarify", args: { offer: "a cube" } }) === null);
check("an ordinary tool call is not mistaken for a clarify",
    tm.parseClarify({ tool: "write_file", args: { path: "a.txt" } }) === null);
check("alternative arg names are accepted (models improvise)",
    !!tm.parseClarify({ tool: "clarify", args: { ask: "how big?", default: "20mm" } }));

/* ---- what the user actually sees ---- */
const shown = tm.renderClarify(parsed);
check("the question is asked plainly", /What overall dimensions\?/.test(shown), shown);
check("the offer is phrased so one word answers it",
    /just say go/i.test(shown) && /20 mm cube/.test(shown), shown);
const bare = tm.renderClarify({ question: "Which board revision?", offer: null });
check("with no offer, it is just the question", bare === "Which board revision?", bare);

/* ---- the model must be TOLD it can ask ---- */
const prompt = tm.clarifyPrompt(["build_model", "write_file", "read_file"]);
check("the prompt teaches the clarify block", /"tool": "clarify"/.test(prompt));
check("the prompt forbids refusing work the tools support",
    /never 'I cannot'|never "I cannot"/i.test(prompt), prompt.slice(0, 200));
check("the prompt says ask ONE question", /ask one question/i.test(prompt));
check("the prompt lists a concrete default for the relevant tool",
    /20 mm cube/.test(prompt));
check("tools that need no constraints add nothing to the prompt",
    tm.clarifyPrompt(["read_file", "list_files"]) === "");

/* ---- the parser must not discard it ---- */
const emitted = '```tool\n{"tool": "clarify", "args": {"question": "How big?", "offer": "a 20 mm cube"}}\n```';
const known = [...Object.keys(agent.effectiveTools({ all: true })), "run_script", "clarify"];
const ex = extractToolCall(emitted, known);
check("the tool parser accepts a clarify block",
    ex.call && ex.call.tool === "clarify", ex.call);
check("and the agent would route it as a question",
    !!tm.parseClarify(ex.call));

/* ---- clarify is NOT a tool: it must never be executable ---- */
const tools = agent.effectiveTools({ all: true });
check("clarify is absent from the tool registry", !tools.clarify);
let classified = null;
try { ({ TOOL_CLASS: classified } = require(__dirname + "/../.lcl.engine/policy/classify.js")); }
catch { /* ignore */ }
check("clarify has no capability classification, because it does nothing",
    !classified || !classified.clarify);

/* ---- the manifest must not promise what it cannot describe ---- */
const audit = tm.auditManifest(Object.keys(tools));
check("every tool offered a default can also describe its arguments",
    audit.ok, audit.problems);

/* ---- richer help only where arguments are the hard part ---- */
const rich = tm.helpFor("build_model", "fallback");
check("a tool with argument detail gets a richer help line",
    /shape/.test(rich) && /dimensions/.test(rich), rich);
check("an ordinary tool keeps its existing help line",
    tm.helpFor("read_file", "read_file {\"path\": \"a.txt\"} — read a file")
        === "read_file {\"path\": \"a.txt\"} — read a file");

/* ---- and it reaches the real system prompt ---- */
const sys = agent.systemPrompt("C:/tmp/ws", tools);
check("the assembled system prompt carries the clarify instruction",
    /"tool": "clarify"/.test(sys));
check("the assembled prompt still lists the ordinary tools",
    /write_file/.test(sys) && /read_file/.test(sys));

console.log(`\n${pass}/${pass + fail} clarify checks passed`);
process.exit(fail ? 1 : 0);
