/**
 * Policy kernel tests.
 *
 * The point of the kernel is that security does NOT depend on the model
 * behaving. These tests therefore assume a hostile caller: unknown tools,
 * ungranted capabilities, paths that escape scope, and runaway loops.
 */
const path = require("path");
const { PolicyKernel, DECISION } = require("../../.lcl.engine/policy/kernel");
const { CLASSIFICATION, WORKSPACE_GRANTS } = require("../../.lcl.engine/policy/classify");

let pass = 0, fail = 0;
const records = [];
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, "-", detail); }
}

const ROOT = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
const OUTSIDE = process.platform === "win32" ? "C:\\Users\\me\\.ssh\\id_rsa" : "/home/me/.ssh/id_rsa";

function freshKernel(opts = {}) {
    records.length = 0;
    const k = new PolicyKernel({ audit: r => records.push(r), settings: opts.settings || {} });
    if (opts.workspace !== false) {
        for (const cap of WORKSPACE_GRANTS) k.grant({ capability: cap, scope: ROOT });
    }
    k.grant({ capability: "sys.read", scope: null });
    return k;
}

// --- deny by default ---
let k = freshKernel();
let v = k.check("rm_rf_everything", {}, { sessionId: "s1" });
check("unknown tool is denied", v.decision === DECISION.DENY, v.decision);
check("unknown tool denial is audited",
      records.some(r => r.decision === DECISION.DENY && r.tool === "rm_rf_everything"));

// --- ungranted capability ---
k = freshKernel({ workspace: false });
v = k.check("read_file", { path: "a.txt" }, { sessionId: "s1", resolvedPath: path.join(ROOT, "a.txt") });
check("no workspace grant -> fs.read denied", v.decision === DECISION.DENY, v.decision);

// --- reads allowed in scope ---
k = freshKernel();
v = k.check("read_file", { path: "a.txt" }, { sessionId: "s1", resolvedPath: path.join(ROOT, "a.txt") });
check("in-scope read is allowed", v.decision === DECISION.ALLOW, v.decision);
check("read is classified read", v.classification === CLASSIFICATION.READ);

// --- scope escape ---
v = k.check("read_file", { path: "../../.ssh/id_rsa" }, { sessionId: "s1", resolvedPath: OUTSIDE });
check("path outside the grant is denied", v.decision === DECISION.DENY, v.decision);
check("denial names the scope", /scope/i.test(v.reason), v.reason);

// --- writes NOTIFY by default (by design) ---
v = k.check("write_file", { path: "notes.md" }, { sessionId: "s1", resolvedPath: path.join(ROOT, "notes.md") });
check("in-scope write notifies rather than blocking", v.decision === DECISION.NOTIFY, v.decision);

// --- but writes can be tightened to confirm ---
const strict = new PolicyKernel({ audit: () => {}, settings: { writeMode: "confirm" } });
for (const cap of WORKSPACE_GRANTS) strict.grant({ capability: cap, scope: ROOT });
v = strict.check("write_file", { path: "notes.md" }, { resolvedPath: path.join(ROOT, "notes.md") });
check("writeMode=confirm makes writes ask", v.decision === DECISION.CONFIRM, v.decision);

// --- destructive always confirms even inside scope ---
k = freshKernel();
v = k.check("delete_file", { path: "notes.md" }, { sessionId: "s1", resolvedPath: path.join(ROOT, "notes.md") });
check("destructive always requires confirmation", v.decision === DECISION.CONFIRM, v.decision);

// --- offensive tooling is engagement-gated ---
k = freshKernel();
v = k.check("port_scan", { target: "10.0.0.1" }, { sessionId: "s1" });
check("offensive tool denied without an engagement", v.decision === DECISION.DENY, v.decision);

k.grant({ capability: "sec.offensive", scope: "10.0.0.0/24",
          expiresAt: Date.now() + 3600e3, note: "authorised test" });
v = k.check("port_scan", { target: "10.0.0.1" }, { sessionId: "s1" });
check("offensive tool inside an engagement still requires confirmation",
      v.decision === DECISION.CONFIRM, v.decision);

// --- expiry ---
k = freshKernel();
k.grant({ capability: "sec.offensive", scope: "10.0.0.0/24", expiresAt: Date.now() - 1000 });
v = k.check("port_scan", { target: "10.0.0.1" }, { sessionId: "s1" });
check("expired engagement grant does not apply", v.decision === DECISION.DENY, v.decision);

// --- egress off by default ---
k = freshKernel();
v = k.check("http_fetch", { url: "https://example.com" }, { sessionId: "s1" });
check("network egress denied by default (fully-local promise)",
      v.decision === DECISION.DENY, v.decision);

// --- blast radius ---
k = freshKernel();
let lastWrite;
for (let i = 0; i < 12; i++) {
    lastWrite = k.check("write_file", { path: `f${i}.md` },
        { sessionId: "s1", turnId: "t1", resolvedPath: path.join(ROOT, `f${i}.md`) });
}
check("runaway write loop hits the per-turn cap", lastWrite.decision === DECISION.DENY, lastWrite.decision);
k.resetCounters();
v = k.check("write_file", { path: "after.md" },
    { sessionId: "s1", turnId: "t2", resolvedPath: path.join(ROOT, "after.md") });
check("cap resets on the next turn", v.decision === DECISION.NOTIFY, v.decision);

// --- revocation ---
k = freshKernel();
k.revoke("fs.write", ROOT);
v = k.check("write_file", { path: "a.md" }, { sessionId: "s1", resolvedPath: path.join(ROOT, "a.md") });
check("revoked capability stops working", v.decision === DECISION.DENY, v.decision);

// --- machine view is read-only: no kill tool exists at all ---
k = freshKernel();
v = k.check("kill_process", { pid: 1234 }, { sessionId: "s1" });
check("there is no process-kill tool to grant", v.decision === DECISION.DENY, v.decision);

// --- audit carries the congruence trail ---
k = freshKernel();
k.check("write_file", { path: "a.md" },
    { sessionId: "s9", modelId: "qwen2.5-coder-1.5b-q4", engineId: "llama.cpp",
      resolvedPath: path.join(ROOT, "a.md") });
const w = records.find(r => r.tool === "write_file");
check("audit records which model and engine asked",
      w && w.modelId === "qwen2.5-coder-1.5b-q4" && w.engineId === "llama.cpp",
      JSON.stringify(w));

// --- capabilities drive what the model is told about ---
k = freshKernel();
const caps = k.liveCapabilities();
check("granted capabilities are enumerable for prompt construction",
      caps.includes("fs.read") && caps.includes("fs.write") && !caps.includes("sec.offensive"),
      JSON.stringify(caps));

console.log(`\n${pass}/${pass + fail} policy tests passed`);
process.exit(fail ? 1 : 0);
