/**
 * AN APPROVED SCRIPT CAN ACTUALLY DO ITS JOB.
 *
 * Measured (Grok session): every approved run_script executed in the session's
 * EMPTY sandbox box at Low integrity — `Set-Location hologram_first_light`
 * failed (workspace not in the box), and the retry against the real folder
 * died EPERM (the kernel refuses write-up from low IL). An approved script
 * that can neither see nor write the workspace makes approval meaningless —
 * "the terminal is bogus".
 *
 * The box stays the DEFAULT. A proposal that declares workspace:true — or
 * provably references the linked folder — runs with cwd = the workspace at
 * the user's own file permissions, and the card SAYS so before the click.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-swt-"));
process.env.LCL_DATA_DIR = DATA;
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };
const sr = require(path.join(ROOT, ".lcl.engine", "core", "scriptRunner.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 200) : ""); }
}

(async () => {
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-swtws-"));
    fs.mkdirSync(path.join(WS, "sub"), { recursive: true });
    fs.writeFileSync(path.join(WS, "sub", "input.txt"), "NASA");

    /* ---- the measured failure, end to end ---- */
    const prop = sr.propose({
        script: 'Set-Location sub\n$x = Get-Content input.txt\n' +
                'Set-Content -Path output.h -Value ("HEADER from " + $x) -Encoding utf8',
        language: "powershell", purpose: "regression", rollback: "delete output.h",
        sessionId: "swt", workspace: true, repoPath: WS
    });
    check("a declared workspace script stages as runsIn workspace with the dir recorded",
        prop.ok && prop.proposal.runsIn === "workspace" && prop.proposal.workspaceDir === WS, prop.error);
    check("...and the payload the CARD reads carries runsIn (truth before the click)",
        prop.proposal.declaredWorkspace === true);
    const run = await sr.approve(prop.proposal.id);
    check("the approved run executes IN the workspace and says so honestly",
        run.ok === true && run.isolation === "workspace" && run.ranIn === WS,
        JSON.stringify({ ok: run.ok, iso: run.isolation }).slice(0, 120));
    check("THE FILE IT WROTE IS REALLY IN THE REAL FOLDER — the exact write that died EPERM",
        fs.existsSync(path.join(WS, "sub", "output.h"))
        && /HEADER from NASA/.test(fs.readFileSync(path.join(WS, "sub", "output.h"), "utf8")));

    /* ---- guardrails ---- */
    const refuse = sr.propose({ script: "echo hi", language: "powershell", purpose: "x",
        rollback: "none", sessionId: "swt", workspace: true, repoPath: null });
    check("workspace wanted with no folder linked refuses honestly at propose time",
        refuse.ok === false && /link a folder/.test(refuse.error), refuse.error);

    const det = sr.propose({ script: 'Get-ChildItem "' + WS + '"', language: "powershell",
        purpose: "x", rollback: "none", sessionId: "swt", repoPath: WS });
    check("a script that NAMES the folder is detected and staged to run there, marked detected",
        det.ok && det.proposal.runsIn === "workspace" && det.proposal.detectedWorkspace === true);

    const plain = sr.propose({ script: 'Write-Output "hello"', language: "powershell",
        purpose: "x", rollback: "none", sessionId: "swt", repoPath: WS });
    check("a plain script stays SANDBOXED — the box is still the default",
        plain.ok && plain.proposal.runsIn === "sandbox");

    /* ---- THE FOUR QUADRANTS — the operator's rule, live ----
     * "the sandbox switch should be the only limiter to where the script
     *  runs" — destination is a pure function of (workspace, switch). */
    const q1 = sr.propose({ script: "Write-Output ok", language: "powershell", purpose: "q",
        rollback: "n", sessionId: "quad", repoPath: WS, sandboxOn: false });
    check("switch OFF + workspace -> runs in the WORKSPACE root",
        q1.ok && q1.proposal.runsIn === "workspace" && q1.proposal.workspaceDir === WS);
    const q2 = sr.propose({ script: "Write-Output ok", language: "powershell", purpose: "q",
        rollback: "n", sessionId: "quad", repoPath: null, sandboxOn: false });
    check("switch OFF + no workspace -> the safe scratch",
        q2.ok && q2.proposal.runsIn === "scratch");
    const q3 = sr.propose({ script: "Write-Output ok", language: "powershell", purpose: "q",
        rollback: "n", sessionId: "quad3", repoPath: WS, sandboxOn: true });
    check("switch ON + workspace -> the box, rooted UNDER the workspace",
        q3.ok && q3.proposal.runsIn === "sandbox" && q3.proposal.workspaceDir === WS);
    const q3r = await sr.approve(q3.proposal.id);
    check("...and the box really lives at <ws>\\.lcl-sandbox",
        q3r.ok === true && fs.existsSync(path.join(WS, ".lcl-sandbox")));
    const q4 = sr.propose({ script: "Write-Output ok", language: "powershell", purpose: "q",
        rollback: "n", sessionId: "quad4", repoPath: null, sandboxOn: true });
    check("switch ON + no workspace -> the global box collection",
        q4.ok && q4.proposal.runsIn === "sandbox" && q4.proposal.workspaceDir === null);
    sr.dropSession("quad"); sr.dropSession("quad3"); sr.dropSession("quad4");

    /* ---- session independence ---- */
    sr.dropSession("swt");
    check("dropSession clears ALL of a session's proposals, completed ones included",
        sr.get(prop.proposal.id) == null && sr.get(plain.proposal.id) == null);

    /* ---- source pins: the levers that must not silently loosen ---- */
    const AG = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
    check("autoRun waives the click ONLY for a genuinely contained run — a proposal " +
          "that runs in the SANDBOX and on a machine whose isolation is actually strong. " +
          "The old `!== \"workspace\"` guard also auto-ran a boundary-less scratch run " +
          "(no folder, sandbox off) that executes as the user with isolation:none.",
        AG.includes('staged.proposal.runsIn === "sandbox"')
        && AG.includes("sandbox.isolation().strong")
        && !AG.includes('staged.proposal.runsIn !== "workspace"'));
    check("THE SANDBOX SWITCH IS THE ONLY LEVER — agent passes it, workspace rides in every mode",
        AG.includes("sandboxOn: strict === true") && AG.includes("repoPath: root || null"));
    check("run_script accepts BOTH arg names — the native schema says code, the text protocol says script",
        AG.includes('typeof call.args.script === "string" ? call.args.script') && AG.includes(": call.args.code"));
    const RD = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
    check("the card states WHERE it runs, in truthful words (not sandboxed / can still read)",
        RD.includes("It is not sandboxed: it can change") && RD.includes("it can still read files you can read"));
    check("...and the approve button names the act: Run in my folder",
        RD.includes('"Run in my folder"'));
    check("the workspace snapshot is invalidated the moment a mutating tool lands",
        AG.includes("snapCache.at = 0;"));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
