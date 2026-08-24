/**
 * PER-TOOL PERMISSIONS — the user's dial, with welded floors.
 *
 * The ask: every "asks first" in the capability panel becomes a selector the
 * user can set. The security property that must survive: two classes can
 * NEVER be loosened past confirm — EXECUTE (scripts) and OFFENSIVE — and an
 * override can never resurrect a tool the grant checks already denied.
 */
const os = require("os");
const fs = require("fs");
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
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const { PolicyKernel, DECISION } = require(__dirname + "/../.lcl.engine/policy/kernel.js");
const { CLASSIFICATION } = require(__dirname + "/../.lcl.engine/policy/classify.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 240) : ""); }
}

/* ============ the tool list and the policy gate must agree about a workspace ==== */
{
    /* From a live session with no folder linked:
     *
     *     read_file  ->  DENIED by policy: capability 'fs.read' is not granted
     *
     * The system prompt said "No folder is linked right now"; the TOOL LIST said
     * otherwise, because the file tools sat in the base TOOLS constant and were
     * handed out unconditionally. The model believes the list, so it burned a
     * turn on a tool the kernel is built to refuse — and the operator read a red
     * DENIED line that looks like a broken app rather than an unlinked folder. */
    const agent = require(__dirname + "/../.lcl.engine/core/agent.js");
    const { TOOL_CLASS, BASE_GRANTS } =
        require(__dirname + "/../.lcl.engine/policy/classify.js");

    const bare = agent.effectiveTools({ workspace: null });
    const withWs = agent.effectiveTools({ workspace: "C:/ws" });

    check("read_file is NOT offered with no folder linked — the exact tool that " +
          "was offered and then denied in a live session",
        !bare.read_file && !!withWs.read_file,
        { bare: !!bare.read_file, withWs: !!withWs.read_file });

    /* THE RULE, not the instance: anything needing an fs.* capability is exactly
     * what a workspace grants, so nothing needing one may be offered without. */
    const offeredButUngrantable = Object.keys(bare).filter(name => {
        const spec = TOOL_CLASS[name];
        return spec && typeof spec.capability === "string"
            && spec.capability.startsWith("fs.");
    });
    check("NO TOOL IS OFFERED THAT THE KERNEL WILL ALWAYS REFUSE. Every fs.* tool " +
          "needs a capability only a linked folder mints, so offering one without " +
          "a folder is advertising a guaranteed denial",
        offeredButUngrantable.length === 0, offeredButUngrantable);

    check("...and every tool that IS offered bare has a classification — an " +
          "unclassified tool is denied by default, which is the same trap in " +
          "another costume",
        Object.keys(bare).every(n => !!TOOL_CLASS[n]),
        Object.keys(bare).filter(n => !TOOL_CLASS[n]));

    check("...with a folder linked, the file tools come back — the gate is about " +
          "the workspace, not about disabling half the app",
        !!withWs.write_file && !!withWs.list_files && !!withWs.search_files,
        Object.keys(withWs).length);

    /* the approval path resolves staged tools through the everything-list, and a
     * staged read_file whose session later lost its folder must still RESOLVE so
     * it can be refused properly rather than dying as "tool is not available" */
    const everything = agent.effectiveTools({ all: true });
    check("...and {all:true} still holds them, because the approval path resolves " +
          "staged tools through that list and a missing entry there is a " +
          "different bug wearing this one's clothes",
        !!everything.read_file && !!everything.write_file);

    check("...the set is DERIVED from the policy table, so a file tool added " +
          "later is covered the day it is classified rather than the day someone " +
          "remembers a second hand-kept list",
        /WORKSPACE_ONLY_TOOLS = Object\.entries\(TOOL_CLASS\)/.test(
            fs.readFileSync(__dirname + "/../.lcl.engine/core/agent.js", "utf8")));

    check("...and BASE_GRANTS mints nothing filesystem-shaped, which is what " +
          "makes a folder the only door to the disk",
        BASE_GRANTS.every(c => !String(c).startsWith("fs.")), BASE_GRANTS);

    /* ===== THE ATTACHMENT EXCEPTION — the live failure this rule caused =====
     *
     * "can you extract the text from this pdf" — a PDF attached to a session
     * with NO linked folder — was answered with "I don't have a PDF reader in
     * this session". read_pdf was installed and healthy; the sweep above had
     * deleted it for want of a folder, and the kernel had no grant to honour
     * anyway. But an attachment read never touches the folder: it re-roots
     * through @attachments/ into the session's own staging dir. So with an
     * attachment staged, the READERS come back — and only the readers. */
    /* THE WIRE SHAPE, straight from the failing session's own log: by turn
     * time main has DRAINED stagedAttachments into the message, so the field
     * is [] and the attachment lives on messages[].attachments. The first fix
     * tested the staged shape — a runtime that never exists at tool-build
     * time — and passed while the live turn failed on two installs running
     * the "fixed" build. Every shape an attachment can wear is pinned now. */
    const pdfAtt = { id: "a1", name: "Chapter 1.pdf", kind: "pdf",
                     staged: true, stagedName: "a1-Chapter 1.pdf" };
    const pdfSession = { id: "att-test", repoPath: null,
        stagedAttachments: [],
        messages: [{ role: "user", content: "can you extract the text from this pdf",
                     attachments: [pdfAtt] }] };
    const withAtt = agent.effectiveTools({ workspace: null, session: pdfSession });
    check("THE DRAINED SHAPE COUNTS: attachments already moved onto the message " +
          "(stagedAttachments []) still unlock the readers — the exact runtime " +
          "state the live session log recorded when it failed",
        !!withAtt.read_pdf, Object.keys(withAtt).filter(n => /read/.test(n)));
    check("...this turn's OWN attachments count too (opts.attachments, as " +
          "runTurn now passes them)",
        !!agent.effectiveTools({ workspace: null, session: { id: "x", repoPath: null },
                                 attachments: [pdfAtt] }).read_pdf);
    check("...and the still-staged pre-send shape keeps working",
        !!agent.effectiveTools({ workspace: null,
            session: { id: "y", repoPath: null, stagedAttachments: [pdfAtt] } }).read_pdf);
    check("...runTurn actually passes its attachments into the tool gate — the " +
          "wire, pinned at the call site, so the gate can never again read a " +
          "field that is empty by the time it runs",
        /effectiveTools\(\{\s*workspace: !!root, session,\s*\n?\s*attachments: opts\.attachments/.test(
            fs.readFileSync(__dirname + "/../.lcl.engine/core/agent.js", "utf8")));
    check("A STAGED PDF WITH NO FOLDER STILL GETS read_pdf — the exact live " +
          "failure: the reader was swept out of the offer for want of a folder " +
          "the read never needed",
        !!withAtt.read_pdf && !!withAtt.read_file,
        { read_pdf: !!withAtt.read_pdf, read_file: !!withAtt.read_file });
    check("...and only the READERS return — write_file, list_files and " +
          "search_files stay folder-gated",
        !withAtt.write_file && !withAtt.list_files && !withAtt.search_files,
        Object.keys(withAtt).filter(n => /^(write_file|list_files|search_files)$/.test(n)));
    check("...while a bare session with NO attachments still offers no fs.* " +
          "tool at all — the original rule stands where its premise is true",
        !agent.effectiveTools({ workspace: null }).read_pdf);

    /* the kernel side of the same exception: the grant and the resolution */
    const policyBridge = require(__dirname + "/../.lcl.engine/core/policyBridge.js");
    const attAllow = policyBridge.check(pdfSession, "read_pdf",
        { path: "@attachments/a1-Chapter 1.pdf" }, { turnId: "t1" });
    check("THE KERNEL HONOURS IT: read_pdf on @attachments/ in a no-folder " +
          "session is ALLOWED — the staging dir is granted read regardless of " +
          "any workspace",
        attAllow && attAllow.decision === "allow", attAllow && attAllow.reason);
    const attDeny = policyBridge.check(pdfSession, "read_file",
        { path: "C:\\Windows\\win.ini" }, { turnId: "t1" });
    check("...and a PLAIN path in the same session is still refused — the " +
          "attachment grant opens the staging dir and nothing else",
        attDeny && attDeny.decision !== "allow", attDeny && attDeny.decision);
    policyBridge.drop(pdfSession.id);

    /* the two follow-on failures from the SAME live session, pinned in source */
    const agentSrc = fs.readFileSync(__dirname + "/../.lcl.engine/core/agent.js", "utf8");
    check("a re-rooted attachment result re-prefixes its path refs (file/note) " +
          "so the model's follow-up call keeps @attachments/ — it reused the " +
          "bare name from the result and got DENIED, live, twice",
        /if \(attReroot && result && typeof result === "object"\)/.test(agentSrc)
        && /result\.file = ATT_PREFIX \+ attReroot/.test(agentSrc));
    check("a scope-DENY on a bare attachment path TEACHES the @attachments/ " +
          "retry and forbids asking for a workspace — the model invented " +
          "'link a workspace folder' at the operator when left to guess",
        /Attached files are read by their @attachments\//.test(agentSrc)
        && /Do NOT ask the user to link a[\s\S]{0,40}workspace/.test(agentSrc));
}

const mkKernel = (toolPolicy) => {
    const k = new PolicyKernel({ audit: () => {}, settings: { toolPolicy } });
    k.grant({ capability: "fs.read", scope: "C:/ws" });
    k.grant({ capability: "fs.write", scope: "C:/ws" });
    k.grant({ capability: "sys.read" });
    k.grant({ capability: "sys.execute" });
    return k;
};
const decide = (k, tool, args = { path: "a.txt" }) =>
    k.check(tool, args, { root: "C:/ws" }).decision;

/* ---- the floors, straight from the static helpers ---- */
check("EXECUTE floors at confirm",
    PolicyKernel.floorFor(CLASSIFICATION.EXECUTE) === DECISION.CONFIRM);
check("OFFENSIVE floors at confirm",
    PolicyKernel.floorFor(CLASSIFICATION.OFFENSIVE) === DECISION.CONFIRM);
check("READ floors at allow (fully user-settable)",
    PolicyKernel.floorFor(CLASSIFICATION.READ) === DECISION.ALLOW);
check("clamping holds a too-loose wish at the floor",
    PolicyKernel.clampToFloor("allow", DECISION.CONFIRM) === "confirm");
check("tightening past the floor is always legal",
    PolicyKernel.clampToFloor("deny", DECISION.CONFIRM) === "deny");
check("a nonsense level clamps to null, not to something runnable",
    PolicyKernel.clampToFloor("sudo", DECISION.ALLOW) === null);

/* ---- defaults unchanged with no overrides ---- */
{
    const k = mkKernel({});
    check("read_file defaults to allow", decide(k, "read_file") === DECISION.ALLOW);
    check("write_file defaults to notify", decide(k, "write_file") === DECISION.NOTIFY);
    check("delete_file defaults to confirm", decide(k, "delete_file") === DECISION.CONFIRM);
    check("run_script defaults to confirm", decide(k, "run_script", {}) === DECISION.CONFIRM);
}

/* ---- the user's dial works ---- */
{
    const k = mkKernel({ read_file: "confirm", write_file: "confirm", delete_file: "notify" });
    check("a READ tool can be tightened to confirm", decide(k, "read_file") === DECISION.CONFIRM);
    check("a MUTATE tool can be tightened to confirm", decide(k, "write_file") === DECISION.CONFIRM);
    check("a DESTRUCTIVE tool can be loosened to notify (delete is revertable here)",
        decide(k, "delete_file") === DECISION.NOTIFY);
}
{
    const k = mkKernel({ read_file: "deny" });
    check("any tool can be turned off entirely", decide(k, "read_file") === DECISION.DENY);
}

/* ---- THE WELDED FLOORS ---- */
{
    const k = mkKernel({ run_script: "allow", sandbox_test: "allow" });
    check("run_script set to allow STILL asks — the floor holds",
        decide(k, "run_script", {}) === DECISION.CONFIRM);
    check("sandbox_test set to allow STILL asks — same floor",
        decide(k, "sandbox_test", {}) === DECISION.CONFIRM);
    const audit = [];
    const k2 = new PolicyKernel({ audit: (r) => audit.push(r), settings: { toolPolicy: { run_script: "allow" } } });
    k2.grant({ capability: "sys.execute" });
    k2.check("run_script", {}, {});
    check("the audit trail records the wish AND the floor that held it",
        audit.some(r => /held at the confirm floor/.test(r.reason || "")),
        audit.map(r => r.reason));
}

/* ---- overrides never resurrect a denied tool ---- */
{
    const k = new PolicyKernel({ audit: () => {}, settings: { toolPolicy: { port_scan: "allow" } } });
    // no engagement grant at all
    check("an override cannot conjure a capability the session lacks",
        k.check("port_scan", {}, {}).decision === DECISION.DENY);
    const k3 = mkKernel({ nonexistent_tool: "allow" });
    check("an override for an unclassified tool is still a deny",
        k3.check("nonexistent_tool", {}, {}).decision === DECISION.DENY);
}

/* ---- the wiring: settings -> bridge -> UI -> back ---- */
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
check("setToolPolicy is a guarded IPC handler and the only writer",
    /lcl:setToolPolicy/.test(mainSrc) && /applyToolPolicy\(next\)/.test(mainSrc));
check("the handler refuses a below-floor wish with the floor named",
    /cannot be looser than/.test(mainSrc));
check("every change is audited",
    /kind: "tool-policy"/.test(mainSrc));
check("behavior toggles have one validated writer too",
    /lcl:setBehavior/.test(mainSrc) && /unknown behavior setting/.test(mainSrc));

const bridgeSrc = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "policyBridge.js"), "utf8");
check("live kernels receive policy changes immediately",
    /function applyToolPolicy/.test(bridgeSrc) && /kernel\.toolPolicy =/.test(bridgeSrc));

const capSrc = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "capabilities.js"), "utf8");
check("the capability map exposes level, floor and legal options per tool",
    /defaultLevel/.test(capSrc) && /options: LEVEL_ORDER\.filter/.test(capSrc));

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
// PER-SESSION, not global. Permissions are session-scoped (the operator's
// standing rule: "all permissions are supposed to be session specific"); the
// capability panel's per-tool selector writes THIS conversation's policy via
// setSessionToolPolicy. The global lcl:setToolPolicy handler still exists in
// main (asserted above) for app-wide defaults like cloudAutoApprove, but the
// panel no longer writes it — that global write was the consolidation stray.
check("the panel renders a per-tool selector that writes the SESSION's policy",
    /cap-level/.test(appSrc) && /setSessionToolPolicy\(active\.id, tool\.name/.test(appSrc));
check("a change confirms visually and reverts on failure",
    /save-failed/.test(appSrc) && /sel\.value = tool\.level/.test(appSrc));
check("behavior rows exist for writes and grounding (the global network row " +
      "was retired in §6d — internet is per-session and auto-enables on link)",
    /writeMode/.test(appSrc) && /groundingEnabled/.test(appSrc)
    && !/behaviorRow\("Network access"/.test(appSrc));

/* ---- grounding toggle actually gates the agent ---- */
const agentSrc = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
check("groundingEnabled=false switches automatic grounding off",
    /groundingEnabled !== false/.test(agentSrc));

console.log(`\n${pass}/${pass + fail} tool-policy checks passed`);
process.exit(fail ? 1 : 0);
