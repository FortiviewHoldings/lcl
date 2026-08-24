"use strict";
/**
 * PERMISSIONS BELONG TO A SESSION, AND ONLY A HUMAN GRANTS THEM.
 *
 * WHO: the operator, in the UI. Not a model, not a heuristic, not a global
 * setting worn permanently and forgotten.
 * WHAT: secrets to the model, unattended script runs, a required sandbox, and
 * a per-session write mode.
 * WHY, verbatim: "so that way, the user has no reason to edit the logic in
 * .lcl, just because of something minor that they want to be able to do, that
 * we are restricting."
 *
 * These run against the real modules with electron stubbed to a temp folder,
 * so nothing in the user's own app data is read or written.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/* ------------------------------------------------------- electron stub ---- */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-perms-"));
const electronStub = {
    app: { isPackaged: true, getPath: () => DATA, getVersion: () => "1.0.0-test",
           getName: () => ".lcl", getAppPath: () => path.join(__dirname, ".."),
           on: () => {}, once: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {}, on: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
};
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return __filename;
    return origResolve.call(this, request, ...rest);
};
require.cache[__filename] = { id: __filename, filename: __filename,
                              loaded: true, exports: electronStub };

const perms = require("../.lcl.engine/core/sessionPerms");
const policy = require("../.lcl.engine/core/policyBridge");
const sandbox = require("../.lcl.engine/core/sandbox");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
    console.log((ok ? "PASS" : "FAIL") + " | " + name + (ok ? "" : "  " + (detail || "")));
    ok ? pass++ : fail++;
};

/* ---- the strict end is the default, always ---- */
{
    const d = perms.forSession({});
    check("a session with no permissions grants nothing",
        d.secrets === false && d.autoRun === false && d.requireIsolation === false);
    check("write mode defaults to inheriting the app setting", d.writeMode === null);
    check("a session record with junk in perms still grants nothing",
        (() => { const p = perms.forSession({ perms: { secrets: "yes", autoRun: 1,
                                                       writeMode: "whatever" } });
                 return p.secrets === false && p.autoRun === false
                     && p.writeMode === null; })());
    check("permissions are never granted by omission",
        perms.forSession({ perms: null }).secrets === false &&
        perms.forSession(null).autoRun === false);
    // §6d: agent mode is ON by default — Ancient Knowledge and raised reasoning
    // assume it. An UNSET session inherits the default; only an explicit false
    // turns it off. (The old `=== true` read made the default flip inert.)
    check("AGENT MODE IS ON BY DEFAULT — an unset session inherits it, an " +
          "explicit false turns it off, and the default is not inert",
        perms.DEFAULTS.agentMode === true
        && perms.forSession({}).agentMode === true
        && perms.forSession({ perms: {} }).agentMode === true
        && perms.forSession({ perms: { agentMode: false } }).agentMode === false);
}

/* ---- setting them ---- */
{
    const r = perms.set({}, "secrets", true);
    check("granting a known permission works", r.ok === true && r.perms.secrets === true);
    check("an unknown permission is refused, not quietly stored",
        !!perms.set({}, "rm-rf-everything", true).error);
    check("write mode accepts only the two real values",
        perms.set({}, "writeMode", "confirm").perms.writeMode === "confirm" &&
        perms.set({}, "writeMode", "sideways").perms.writeMode === null);
    check("anyGranted reports only the permissions that widen power",
        perms.anyGranted({ perms: { secrets: true } }) === true &&
        perms.anyGranted({ perms: { requireIsolation: true } }) === false);
}

/* ---- the catalog drives every surface, so none can drift ---- */
{
    const keys = perms.CATALOG.map(c => c.key).sort();
    check("the catalog covers exactly the eight per-session switches — the " +
          "four permissions plus self-review, which is a MODE this conversation " +
          "can be put into rather than something it does by habit, plus " +
          "tailoring, which decides whether a profile of the operator may " +
          "travel to a paid endpoint at all, plus agentMode, the opt-in that " +
          "lets a paid API model run multi-step agent plans the way local and a " +
          "node do, plus askRemote — the leave-machine gate, which was the last " +
          "APP-WIDE switch in the product and is this conversation's own now",
        JSON.stringify(keys) === JSON.stringify(
            ["agentMode", "askRemote", "autoRun", "requireIsolation", "secrets",
             "tailoring", "writeMode"]), keys);
    check("every entry carries text a person can act on",
        perms.CATALOG.every(c => c.title && (c.choices || (c.on && c.off))));
    check("the credentials switch is marked destination-aware",
        perms.CATALOG.find(c => c.key === "secrets").destinationAware === true);
}

/* ---- the kernel must REBUILD when the session's write mode changes ---- */
{
    const id = "11111111-1111-1111-1111-111111111111";
    const k1 = policy.forSession({ id, repoPath: null });
    const k2 = policy.forSession({ id, repoPath: null, perms: { writeMode: "confirm" } });
    check("changing the session's write mode rebuilds its kernel", k1 !== k2);
    check("...and the new kernel actually carries the stricter mode",
        String(k2.writeMode) === "confirm", String(k2.writeMode));
    const k3 = policy.forSession({ id, repoPath: null, perms: { writeMode: "confirm" } });
    check("an unchanged session still reuses its cached kernel", k2 === k3);
}

/* ---- the sandbox tells the truth about itself, and names the upgrade ---- */
{
    const iso = sandbox.isolation();
    check("isolation reports a kind and whether it is a real boundary",
        typeof iso.kind === "string" && typeof iso.strong === "boolean");
    check("when there is no boundary it says so AND names how to get one",
        iso.strong ? true : (!!iso.offer && !!iso.offer.how && !!iso.offer.why),
        JSON.stringify(iso));
    check("it never claims strength it does not have",
        iso.strong === (iso.kind !== "none"));
}

/* ---- the engine reads the permission, and the wiring is not decorative ---- */
{
    const agentSrc = fs.readFileSync(
        path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("the credentials permission is passed to the model call",
        /allowSecrets: sessionPerms\.forSession\(session\)\.secrets/.test(agentSrc));
    check("unattended running is gated on the session permission",
        /sessionPerms\.forSession\(session\)\.autoRun/.test(agentSrc));
    // the auto-run branch is reachable ONLY after `if (!staged.ok)` has
    // already rejected anything the inspector refused — the permission skips
    // the click, never the check
    check("unattended running still goes through the script inspection first",
        agentSrc.indexOf("if (!staged.ok)") <
            agentSrc.indexOf("sessionPerms.forSession(session).autoRun"));
    check("a session may refuse to run scripts without a real sandbox",
        /const strict = sessionPerms\.forSession\(session\)\.requireIsolation/.test(agentSrc) &&
        /const staged = \(strict && !iso\.strong\)/.test(agentSrc));
    check("refusing one script does not abandon the rest of the turn",
        !/reason: "no isolation boundary available" \}, steps\);\s*\n\s*break;/.test(agentSrc));
}


/* ---- the UI, the IPC and the notification all reach ONE mechanism ---- */
{
    const mainSrc = fs.readFileSync(
        path.join(__dirname, "..", "app", "main.js"), "utf8");
    const appSrc = fs.readFileSync(
        path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    const preSrc = fs.readFileSync(
        path.join(__dirname, "..", "app", "preload.js"), "utf8");
    const htmlSrc = fs.readFileSync(
        path.join(__dirname, "..", "app", "renderer", "index.html"), "utf8");
    const cssSrc = fs.readFileSync(
        path.join(__dirname, "..", "app", "renderer", "styles.css"), "utf8");

    check("reading and changing permissions are separate ipc calls",
        /ipcMain\.handle\("lcl:sessionPerms"/.test(mainSrc) &&
        /ipcMain\.handle\("lcl:setSessionPerm"/.test(mainSrc));
    check("both are exposed on the preload bridge",
        /sessionPerms: \(id\) =>/.test(preSrc) &&
        /setSessionPerm: \(id, key, value\) =>/.test(preSrc));
    check("the read call reports the DESTINATION, so the switch can name it — " +
          "and it is THIS SESSION's destination, because 'may this conversation " +
          "send secrets' is a question about the machine it actually talks to",
        /const d = cloudModels\.resolveSelection\(s\);/.test(mainSrc) &&
        /destination = d\.sel \? cloudModels\.destinationOf\(d\.sel\) : null;/.test(mainSrc));
    check("changing a permission is written to the audit log",
        /kind: "session-permission"/.test(mainSrc));
    check("changing a permission drops the cached kernel so it takes effect now",
        /policyBridge\.drop\(s\.id\)/.test(mainSrc));

    // A CONTROL MUST BE REACHABLE BEFORE IT HAS BEEN USED.
    //
    // First build put the permissions control in a chip that was hidden until
    // a permission had been granted — so the way to grant one was invisible
    // until you already had. Caught from a screenshot before install.
    check("the permissions control is a button beside the other session controls",
        /id="session-perms-btn"/.test(htmlSrc) &&
        /\$\("session-perms-btn"\)\.addEventListener\("click", \(\) => openSessionPerms\(\)\)/
            .test(appSrc));
    check("that button is ALWAYS present — never hidden behind the state it creates",
        !/id="session-perms-btn"[^>]*class="[^"]*hidden/.test(htmlSrc));
    check("the readout beside it is a readout, not a second control",
        /<span id="composer-perms"><\/span>/.test(htmlSrc));
    check("the button itself shows when it is holding a permission",
        /#session-perms-btn\.granted \{/.test(cssSrc) &&
        /btn\.classList\.add\("granted"\)/.test(appSrc));

    // WORDING. "when i see send credentials, i think username and password...
    // credentials is not the correct term to use."
    check("the secrets switch is not called 'credentials'",
        !/Send credentials/.test(appSrc) &&
        !/title: "Send credentials/.test(
            fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core",
                                      "sessionPerms.js"), "utf8")));
    check("it names what it really covers — keys, tokens, passwords",
        /an API key, an access token, /.test(
            fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core",
                                      "sessionPerms.js"), "utf8")));
    check("and states what it does NOT cover, in the UI",
        /does not detect personal information/.test(
            fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core",
                                      "sessionPerms.js"), "utf8")) &&
        /perm-limit/.test(appSrc) && /\.perm-limit \{/.test(cssSrc));

    check("the sheet exists and is reachable from the menu and the chip",
        /async function openSessionPerms\(\)/.test(appSrc) &&
        /"session-perms": \(\) => openSessionPerms\(\)/.test(appSrc) &&
        /data-action="session-perms"/.test(htmlSrc));
    check("the readout is drawn from the session's real permissions",
        /async function paintPermChip\(\)/.test(appSrc) &&
        /window\.lcl\.sessionPerms\(active\.id\)/.test(appSrc));
    check("a failed change flips the switch back rather than lying",
        /box\.checked = !box\.checked;/.test(appSrc));
    check("every element the sheet draws is styled",
        /\.perm-row \{/.test(cssSrc) && /\.perm-dest \{/.test(cssSrc) &&
        /#composer-perms \{/.test(cssSrc) && /\.perm-title \{/.test(cssSrc) &&
        /\.perm-sub \{/.test(cssSrc));

    /* the notification button must be the SAME path as the in-app card */
    check("approve and reject are named functions, not inline handlers",
        /async function approveToolById\(id\)/.test(mainSrc) &&
        /function rejectToolById\(id\)/.test(mainSrc));
    check("the ipc handlers delegate to those functions",
        /ipcMain\.handle\("lcl:approveTool", async \(_e, id\) => approveToolById\(id\)\)/.test(mainSrc) &&
        /ipcMain\.handle\("lcl:rejectTool", guard\(\(_e, id\) => rejectToolById\(id\)\)\)/.test(mainSrc));
    check("the notification buttons delegate to the SAME functions",
        /async function approveFromNotification\(id\) \{ return approveToolById\(id\); \}/.test(mainSrc) &&
        /async function rejectFromNotification\(id\) \{ return rejectToolById\(id\); \}/.test(mainSrc));
    check("the notification carries the approval id, so it can act on THIS one",
        /approvalId: \(info\.detail && info\.detail\.approvalId\) \|\| null/.test(mainSrc) &&
        /approvalId: staged\.id/.test(
            fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8")));
    check("acting from a notification is recorded",
        /kind: "notification-action"/.test(mainSrc));

    /* sessions grouped under their workspace */
    check("sessions are grouped by the folder they belong to, as a SUBGROUP " +
          "under one 'Workspaces' section rather than a flat run of headings — " +
          "every folder used to be a full-weight heading at the same level as " +
          "'Today', which read as unrelated sections and, at a heading's worth " +
          "of padding each, made a handful of sessions fill the whole column",
        /const byWorkspace = new Map\(\)/.test(appSrc) &&
        /groupHead\(folderName\(repoPath\), repoPath, "sub"\)/.test(appSrc) &&
        /groupHead\(workspaces\.length === 1 \? "Workspace" : "Workspaces", null\)/.test(appSrc));
    check("unlinked sessions keep their by-age grouping underneath",
        /if \(workspaces\.length\) groupHead\("No workspace", null\)/.test(appSrc));
    check("the folder heading carries the full path on hover",
        /if \(full\) head\.title = full;/.test(appSrc));
    check("the sidebar group heading is brighter than the rows it stands over",
        /\.session-group \{[^}]*color: var\(--text\)/.test(cssSrc) &&
        /\.session-group \{[^}]*border-bottom: 1px solid var\(--line-strong\)/.test(cssSrc));
    check("a long folder name cannot widen the sidebar",
        /\.session-group \{[^}]*text-overflow: ellipsis/.test(cssSrc));

}

check("AK IMPLIES THE REVIEW — enabling Ancient Knowledge turns check-its-work on with no separate dial",
    perms.selfReviewOn({ ancientKnowledge: true, id: "x" }, false) === true
    && perms.selfReviewOn({ id: "y" }, false) === false);
check("...and the setting is no longer an exposed catalog item",
    !perms.CATALOG.some(i => i.key === "selfReview"));

try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${pass}/${pass + fail} session-perms checks passed`);
process.exit(fail ? 1 : 0);
