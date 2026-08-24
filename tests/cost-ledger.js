/**
 * THE MONEY HAS TO BE RIGHT, AND IT HAS TO SURVIVE HOUSEKEEPING.
 *
 * The requirement: given input and output token counts, compute cost per
 * message and total cost per session, viewable per session and then globally.
 * Sessions can be deleted, but the cost history must be kept. The presentation
 * is charts, graphs and fully readable transaction tables — not a bare list —
 * plus a specific breakdown of any local model that has called an API model.
 *
 * Every clause above is a check below. The one that matters most is deletion:
 * a ledger you can erase by tidying up is not a ledger, and the failure would
 * be invisible until the month you went looking for a number that was gone.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ledger-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    // cloudModels (required below to prove escalation recording) touches
    // safeStorage at load; a no-encryption stub is enough for this test
    safeStorage: { isEncryptionAvailable: () => false,
                   encryptString: (s) => Buffer.from(String(s)),
                   decryptString: (b) => Buffer.from(b).toString() }
} };

const ledger = require(path.join(__dirname, "..", ".lcl.engine", "core", "ledger.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++;
        console.log("FAIL |", name,
            detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 200) : "");
    }
}

/* ---------------------------------------------------- recording is exact --- */
ledger.record({ sessionId: "s1", sessionTitle: "repo read", model: "zai-org/GLM-5.2",
    endpoint: "api.deepinfra.com", inputTokens: 12000, outputTokens: 3400, usd: 0.0171 });
ledger.record({ sessionId: "s1", sessionTitle: "repo read", model: "zai-org/GLM-5.2",
    endpoint: "api.deepinfra.com", inputTokens: 800, outputTokens: 200, usd: 0.0011 });
ledger.record({ sessionId: "s2", sessionTitle: "schematic", model: "deepseek-ai/DeepSeek-V4-Pro",
    endpoint: "api.deepinfra.com", inputTokens: 5000, outputTokens: 9000, usd: 0.0299,
    via: "local-escalation" });

{
    const d = ledger.summary();
    check("every call is one row", d.calls === 3, d.calls);
    check("the total is the sum, not an estimate",
        Math.abs(d.totalUsd - 0.0481) < 1e-9, d.totalUsd);
    check("input tokens are totalled", d.totalIn === 17800, d.totalIn);
    check("output tokens are totalled", d.totalOut === 12600, d.totalOut);
}

/* ------------------------------------------------------------ per session --- */
{
    const one = ledger.forSession("s1");
    check("per-session total is right", Math.abs(one.usd - 0.0182) < 1e-9, one.usd);
    check("per-session call count is right", one.calls === 2, one.calls);
    check("per-session tokens are right",
        one.inputTokens === 12800 && one.outputTokens === 3600, one);
    check("an unknown session reports zero, never NaN",
        ledger.forSession("nope").usd === 0);
}

/* -------------------------------------------------------------- per model --- */
{
    const d = ledger.summary();
    const glm = d.models.find(m => m.model === "zai-org/GLM-5.2");
    check("per-model rows exist", d.models.length === 2, d.models.length);
    check("per-model spend is right", glm && Math.abs(glm.usd - 0.0182) < 1e-9, glm);
    check("models are ranked by spend", d.models[0].usd >= d.models[1].usd);
}

/* ------------------------------------------- LOCAL -> API escalation split --- */
{
    const d = ledger.summary();
    check("escalation spend is subtotalled separately",
        Math.abs(d.escalationUsd - 0.0299) < 1e-9, d.escalationUsd);
    check("a user-driven call is NOT counted as escalation",
        d.recent.filter(r => r.via === "user").length === 2);
    check("the transaction row records HOW it was spent",
        d.recent.some(r => r.via === "local-escalation"));
}

/* --------------------------------- DELETION MUST NOT ERASE THE SPEND -------- */
{
    ledger.markSessionDeleted("s2", "schematic");
    const d = ledger.summary();
    check("total is unchanged by deleting a session",
        Math.abs(d.totalUsd - 0.0481) < 1e-9, d.totalUsd);
    const s2 = d.sessions.find(x => x.sessionId === "s2");
    check("the deleted session still appears", !!s2);
    check("...still carries its spend", s2 && Math.abs(s2.usd - 0.0299) < 1e-9, s2 && s2.usd);
    check("...still carries its NAME", s2 && s2.title === "schematic", s2 && s2.title);
    check("...and is marked deleted", s2 && s2.deleted === true, s2 && s2.deleted);
    check("a live session is NOT marked deleted",
        d.sessions.find(x => x.sessionId === "s1").deleted === false);
}

/* --------------------------------------------------- data the charts need --- */
{
    const d = ledger.summary();
    check("per-day series exists for the bar chart", Array.isArray(d.days) && d.days.length >= 1);
    check("each day carries a date and an amount",
        d.days.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.day) && typeof x.usd === "number"), d.days[0]);
    check("the transaction table is newest-first",
        d.recent.length >= 2 && d.recent[0].at >= d.recent[1].at);
    check("transactions carry everything the table prints",
        d.recent.every(r => r.model && typeof r.inputTokens === "number"
            && typeof r.outputTokens === "number" && typeof r.usd === "number"));
}

/* -------------------------------------------------------------- robustness --- */
{
    const before = ledger.summary().calls;
    ledger.record(null);
    ledger.record({ sessionId: "x" });                       // no model
    ledger.record({ model: "m", inputTokens: -5, outputTokens: -5, usd: -1 });
    const d = ledger.summary();
    check("junk rows are refused, not stored", d.calls === before + 1, d.calls);
    check("negative amounts are clamped, never subtracted",
        d.totalUsd >= 0.0481 - 1e-9, d.totalUsd);
}

/* ------------------------------------ the app actually WIRES all of this ---- */
{
    const R = path.join(__dirname, "..");
    const agent = fs.readFileSync(path.join(R, ".lcl.engine", "core", "agent.js"), "utf8");
    const main = fs.readFileSync(path.join(R, "app", "main.js"), "utf8");
    const app = fs.readFileSync(path.join(R, "app", "renderer", "app.js"), "utf8");
    const html = fs.readFileSync(path.join(R, "app", "renderer", "index.html"), "utf8");

    check("the agent records each remote call",
        /require\("\.\/ledger"\)\.record/.test(agent));
    check("it records the PROVIDER's counts, not the estimate",
        /inputTokens: result\.usage\.prompt_tokens/.test(agent));
    check("deleting a session preserves its spend first",
        /ledger\.markSessionDeleted/.test(main));
    check("cost rides on each assistant message",
        /outTokens: result\.usage\.completion_tokens/.test(agent));
    check("the message footer prints what that reply cost",
        /class = "msg-cost"|className = "msg-cost"/.test(app));
    check("the session's running total is shown beside the composer",
        /function refreshSessionCost/.test(app) && /id="session-cost"/.test(html));
    check("the dashboard draws a per-day chart",
        /spend-chart/.test(app) && /spend-bar/.test(app));
    check("the dashboard draws a transaction table",
        /"Transactions"/.test(app));
    check("the dashboard is reachable from a menu",
        /data-action="spend"/.test(html));
}

/* ---- ESCALATION SPEND REACHES THE LEDGER --------------------------------
 * cloudModels.recordEscalation existed, was exported, and had NO caller — so a
 * local model spending real money through ask_cloud_model / ask_reasoner never
 * appeared in the one place a user goes to ask what a session cost. The
 * tools now call it (cloudModels.js), and this proves the row lands. Kept last
 * so it cannot disturb the exact-count assertions above. */
{
    const cloudModels = require(path.join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"));
    const before = ledger.forSession("esc1").calls;
    cloudModels.recordEscalation("esc1", "escalated turn", {
        model: "Qwen/Qwen3.7-Max", endpoint: "api.deepinfra.com",
        usage: { prompt_tokens: 2000, completion_tokens: 500 }, cost: { usd: 0.0125 } });
    const after = ledger.forSession("esc1");
    check("recordEscalation writes a ledger row (it had no caller before)",
        after.calls === before + 1 && Math.abs(after.usd - 0.0125) < 1e-9,
        { calls: after.calls, usd: after.usd });
    const row = ledger.summary().recent.find(r => r.sessionId === "esc1");
    check("...tagged via:local-escalation, so Spend shows it as local->API",
        row && row.via === "local-escalation", row && row.via);
    const n = ledger.forSession("esc2").calls;
    cloudModels.recordEscalation("esc2", "no usage", { model: "x", endpoint: "y", usage: null });
    check("...and records NOTHING when the endpoint reported no usage — no fabricated rows",
        ledger.forSession("esc2").calls === n, ledger.forSession("esc2").calls);

    // AN OWNED-NODE ESCALATION IS $0 AND COUNTS TOWARD THE NODE TOTALS, never
    // metered as paid usage. recordEscalation used to drop the localNode flag, so
    // a free fleet/reasoner call on the operator's own machine was invisible to
    // the "hardware earned back" node dashboard.
    const nodeBefore = ledger.summary().node.calls;
    cloudModels.recordEscalation("esc3", "owned node escalation", {
        model: "gpt-oss:120b", endpoint: "spark-node",
        usage: { prompt_tokens: 4000, completion_tokens: 900 },
        cost: { usd: 0 }, localNode: true });
    const sum = ledger.summary();
    const nodeRow = sum.recent.find(r => r.sessionId === "esc3");
    check("an owned-node escalation carries localNode and lands in the node totals",
        sum.node.calls === nodeBefore + 1 && nodeRow && nodeRow.localNode === true
        && nodeRow.via === "local-escalation" && nodeRow.usd === 0,
        { nodeCalls: sum.node.calls, row: nodeRow });
    check("...while a paid escalation is NOT counted as a node call",
        !(sum.recent.find(r => r.sessionId === "esc1") || {}).localNode);
}

console.log(`\n${pass}/${pass + fail} cost-ledger checks passed`);
process.exit(fail ? 1 : 0);
