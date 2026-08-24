const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const paths = require("./paths");
const sandbox = require("./sandbox");
const { inspect } = require("../policy/scriptGuard");

/**
 * Script execution, split deliberately into two phases that CANNOT be collapsed:
 *
 *   propose(...)  the model asks. The script is inspected, stored, and returned
 *                 for display. Nothing runs.
 *   approve(id)   the human says yes, referencing a proposal by id. Only this
 *                 executes, and only once.
 *
 * The split is the safety property. There is no function that takes script text
 * and runs it, so no amount of model creativity, prompt injection, or future
 * refactoring inside the agent loop can produce an unapproved execution — the
 * agent never holds anything executable, only an id.
 */

const MAX_OUTPUT_CHARS = 20000;
const DEFAULT_TIMEOUT_MS = 120_000;

const proposals = new Map();   // id -> { ...proposal, state }

function scriptsDir() {
    const dir = path.join(paths.dataDir(), "scripts");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function interpreterFor(language) {
    // A PYTHON SCRIPT IS NOT A POWERSHELL SCRIPT. This used to return the
    // platform shell for EVERY language, so python/node source was written to
    // _lcl_script.ps1 and parsed by powershell.exe — "Missing expression
    // after ','", exit 1, every single time, until the operator ran scripts
    // BY HAND in a real terminal. The sandbox has had per-language
    // interpreters all along (sandbox.js INTERPRETERS); the real runner now
    // matches it. A language with no interpreter here is refused honestly by
    // propose() rather than mangled.
    const lang = String(language || "").toLowerCase();
    const win = process.platform === "win32";
    if (/^py(thon)?3?$/.test(lang)) return {
        language: "python", ext: ".py",
        command: win ? "py" : "python3", args: (file) => [file]
    };
    if (/^(node|js|javascript)$/.test(lang)) return {
        language: "node", ext: ".js",
        command: win ? "node.exe" : "node", args: (file) => [file]
    };
    if (win) {
        if (lang === "bash" || lang === "sh") return null;   // not available by default
        return {
            language: "powershell",
            ext: ".ps1",
            command: "powershell.exe",
            args: (file) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file]
        };
    }
    return {
        language: "bash",
        ext: ".sh",
        command: "/bin/bash",
        args: (file) => [file]
    };
}

/**
 * Phase 1. Validate and stage a script. Never executes.
 * Returns { ok:true, proposal } or { ok:false, error, ruleId }.
 */
function propose({ script, language, purpose, rollback, sessionId, modelId, engineId,
                   workspace = false, repoPath = null, sandboxOn = undefined }) {
    const interp = interpreterFor(language);
    if (!interp) {
        return { ok: false, error: `no interpreter available for '${language}' on ${process.platform}` };
    }

    const verdict = inspect(script, { language: interp.language, rollback });
    if (!verdict.allowed) {
        return {
            ok: false,
            error: `refused: ${verdict.why}` + (verdict.evidence ? ` — matched: ${verdict.evidence}` : ""),
            ruleId: verdict.ruleId,
            evidence: verdict.evidence
        };
    }

    // WHERE IT RUNS IS DECIDED HERE, so the card can say it and the click can
    // mean it. Declared beats detected; detection requires the folder to be
    // named as a whole path segment (".lcl" appearing inside prose must not
    // stage a run in the real folder).
    // THE OPERATOR'S RULE, WHEN THE CALLER KNOWS THE SWITCH: where a script
    // runs is a pure function of the session — sandbox on = the box (under
    // the workspace root when one is linked); sandbox off = the workspace
    // root when linked, the safe scratch when not. Never inferred from the
    // script's text, never stale.
    const runsInForced = sandboxOn === true ? "sandbox"
        : sandboxOn === false ? (repoPath ? "workspace" : "scratch")
        : null;
    let detected = false;
    if (!runsInForced && repoPath) {
        const base = path.basename(repoPath);
        const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const seg = new RegExp("(^|[\\\\/\\s\"\u0027])" + esc(base) + "($|[\\\\/\\s\"\u0027])");
        detected = String(script).includes(repoPath) || seg.test(String(script));
    }
    const wantsWorkspace = runsInForced ? runsInForced === "workspace"
        : (workspace === true || detected);
    if (!runsInForced && wantsWorkspace && !repoPath) {
        return { ok: false, error: "this script works on the linked folder and this " +
            "session has none — link a folder, then propose it again" };
    }
    const id = crypto.randomBytes(8).toString("hex");
    const proposal = {
        id,
        script: String(script),
        rollback: rollback ? String(rollback) : null,
        purpose: purpose ? String(purpose).slice(0, 500) : "",
        language: interp.language,
        mutating: verdict.mutating,
        lines: verdict.lines,
        chars: verdict.chars,
        sessionId, modelId, engineId,
        runsIn: runsInForced || (wantsWorkspace ? "workspace" : "sandbox"),
        // in forced mode the dir rides along even for the sandbox, so the
        // box can live under the workspace root
        workspaceDir: runsInForced ? (repoPath || null)
            : (wantsWorkspace ? repoPath : null),
        declaredWorkspace: workspace === true,
        detectedWorkspace: detected,
        createdAt: Date.now(),
        state: "pending"
    };
    proposals.set(id, proposal);

    // hand back everything the UI needs to render it for a human to read
    return {
        ok: true,
        proposal: {
            id, language: proposal.language, script: proposal.script,
            rollback: proposal.rollback, purpose: proposal.purpose,
            mutating: proposal.mutating, lines: proposal.lines,
            runsIn: proposal.runsIn, workspaceDir: proposal.workspaceDir,
            declaredWorkspace: proposal.declaredWorkspace,
            detectedWorkspace: proposal.detectedWorkspace
        }
    };
}

/**
 * Phase 2. Execute a previously proposed script. Requires the id, so this can
 * only be reached from a UI action the user took after seeing the script.
 */
/**
 * THE BOUNDARY IS THE DEFAULT, NOT THE EXCEPTION.
 *
 * "Running as me with my permission level is not acceptable as the default."
 *
 * An approved script used to be spawned with cwd = the user's HOME and
 * env = process.env: their whole home tree, and every API key the app was
 * launched with. It now runs inside the SESSION'S OWN BOX, behind the
 * strongest boundary the machine can actually enforce — on a plain Windows
 * machine that is a low-integrity child whose writes to the user's files the
 * kernel refuses. Falling back to the old behaviour is a decision, not an
 * accident: it happens only where no boundary exists at all, and the result
 * says which one ran.
 */
async function approveInBox(p, { timeoutMs, onOutput }) {
    const iso = sandbox.isolation();
    const box = sandbox.forSession(p.sessionId || `script-${p.id}`, {
        name: "script",
        // sandbox ON with a workspace linked: the box lives where the operator
        // can see it — under the workspace root, per session
        rootDir: p.workspaceDir ? path.join(p.workspaceDir, ".lcl-sandbox") : null
    });
    const interp = interpreterFor(p.language);
    const name = `_lcl_script${interp.ext}`;
    sandbox.write(box.id, name, p.script);
    const file = path.join(box.dir || sandbox.boxDir(box.id), name);
    // the same text that ran, kept next to the audit trail as before
    const kept = path.join(scriptsDir(), `${p.id}${interp.ext}`);
    try { fs.writeFileSync(kept, p.script, "utf8"); } catch { /* audit copy */ }
    const r = await sandbox.exec(box.id, {
        command: interp.command, args: interp.args(file), timeoutMs, onOutput
    });
    return { r, kept, iso, boxId: box.id };
}

function approve(id, { timeoutMs = DEFAULT_TIMEOUT_MS, onOutput, inSandbox = true, cancelToken } = {}) {
    return new Promise(async (resolve) => {
        const p = proposals.get(id);
        if (!p) return resolve({ ok: false, error: "no such script proposal" });
        if (p.state !== "pending") {
            return resolve({ ok: false, error: `proposal already ${p.state}` });
        }
        p.state = "running";

        // THE OPERATOR'S FOLDER, BECAUSE THE CARD SAID SO AND THEY CLICKED.
        // In the box a workspace script can neither see the linked folder (cwd
        // is the box) nor write it (the kernel refuses write-up from low IL) —
        // measured: Set-Location failed, the retry died EPERM. The box stays
        // the DEFAULT; this branch exists only for a proposal whose card said
        // "runs in your linked folder with your file permissions".
        const workspaceRun = p.runsIn === "workspace" && !!p.workspaceDir
            && fs.existsSync(p.workspaceDir);
        const scratchRun = p.runsIn === "scratch";
        // INSIDE THE BOUNDARY unless there is genuinely none to be had.
        if (!workspaceRun && !scratchRun && inSandbox && sandbox.isolation().strong) {
            try {
                const { r, kept, iso, boxId } = await approveInBox(p, { timeoutMs, onOutput });
                p.state = r.timedOut ? "failed"
                    : r.ok && !r.hadErrors ? "completed"
                    : r.ok ? "completed-with-errors" : "failed";
                p.exitCode = r.code;
                p.finishedAt = Date.now();
                return resolve({
                    ok: !!r.ok,
                    // THE STDERR DIAGNOSTIC SURVIVES THE SANDBOX. PowerShell
                    // exits 0 even when a cmdlet raised a non-terminating
                    // error, so an exit code alone is a misleading success
                    // signal — which is exactly why this path reported stderr
                    // separately. Merging the streams would have made a
                    // half-failed script report "Finished cleanly".
                    clean: !!r.clean,
                    hadErrors: !!r.hadErrors,
                    stderrChars: r.stderrChars || 0,
                    exitCode: r.code,
                    output: r.output || "",
                    truncated: !!r.truncated,
                    durationMs: p.finishedAt - p.createdAt,
                    scriptFile: kept,
                    rollback: p.rollback,
                    // WHERE IT RAN, said out loud: an approval that quietly
                    // fell out of the sandbox would be the worst kind of quiet
                    isolation: iso.kind,
                    isolationVerified: !!iso.verified,
                    sandboxId: boxId,
                    timedOut: !!r.timedOut
                });
            } catch (e) {
                p.state = "failed";
                return resolve({ ok: false, isolation: sandbox.isolation().kind,
                                 error: `the sandbox refused to run it: ${String(e && e.message || e)}` });
            }
        }

        const interp = interpreterFor(p.language);
        // a WORKSPACE run puts the transient script file IN the workspace, so
        // $PSScriptRoot and relative paths mean what the model meant — measured:
        // a launcher did Set-Location $PSScriptRoot while the file lived in
        // data/scripts, and the run re-rooted itself there ("feeder not found")
        const file = workspaceRun
            ? path.join(p.workspaceDir, `.lcl-script-${p.id}${interp.ext}`)
            : path.join(scriptsDir(), `${p.id}${interp.ext}`);
        fs.writeFileSync(file, p.script, "utf8");
        // the audit copy stays in the trail either way
        if (workspaceRun) {
            try { fs.writeFileSync(path.join(scriptsDir(), `${p.id}${interp.ext}`), p.script, "utf8"); }
            catch { /* audit copy */ }
        }

        let out = "";
        let truncated = false;
        let stderrChars = 0;
        const append = (chunk, isErr) => {
            if (isErr) stderrChars += String(chunk).length;
            if (out.length >= MAX_OUTPUT_CHARS) { truncated = true; return; }
            const s = String(chunk);
            out += s;
            if (out.length > MAX_OUTPUT_CHARS) {
                out = out.slice(0, MAX_OUTPUT_CHARS);
                truncated = true;
            }
            if (typeof onOutput === "function") onOutput(s);
        };

        // NO BOUNDARY EXISTS ON THIS MACHINE. This is the honest fallback,
        // and it is the old behaviour: the script runs as the user. It is
        // reached only when sandbox.isolation() reports none at all, and the
        // result carries isolation:"none" so nothing downstream can imply
        // otherwise. cwd is the box-less scratch dir rather than the user's
        // home, and the environment is still scrubbed of their keys.
        const scratch = workspaceRun
            ? fs.mkdtempSync(path.join(sandbox.sandboxRoot(), "wsrun-"))
            : sandbox.sandboxRoot();
        const child = spawn(interp.command, interp.args(file), {
            cwd: workspaceRun ? p.workspaceDir : scratch,
            windowsHide: true,
            // no shell: the file is the payload, so nothing is re-interpreted
            shell: false,
            env: sandbox.scrubbedEnv(scratch)
        });

        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* already gone */ }
            append(`\n[.lcl] stopped: exceeded ${Math.round(timeoutMs / 1000)}s\n`);
        }, timeoutMs);
        // STOP REACHES A RUNNING SCRIPT. The approval holds a cancel token in
        // approvalsRunning now; a Stop flips it and this watcher kills the
        // child — before this, a running script was the one action Stop
        // could not touch.
        const cancelWatch = cancelToken ? setInterval(() => {
            if (cancelToken.cancelled) {
                clearInterval(cancelWatch);
                try { child.kill(); } catch { /* already gone */ }
                append("\n[.lcl] stopped by you\n");
            }
        }, 300) : null;
        if (cancelWatch) child.on("close", () => clearInterval(cancelWatch));

        child.stdout.on("data", (d) => append(d, false));
        child.stderr.on("data", (d) => append(d, true));
        child.on("error", (err) => {
            clearTimeout(timer);
            p.state = "failed";
            resolve({ ok: false, error: String(err.message || err), output: out });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            // PowerShell exits 0 even when a cmdlet raised a non-terminating
            // error, so exit code alone is a misleading success signal. Report
            // stderr separately and let the user judge — silently calling a
            // half-failed script "Finished" is exactly the wrong behaviour for
            // something that just changed their machine.
            const hadErrors = stderrChars > 0;
            p.state = code === 0 && !hadErrors ? "completed"
                : code === 0 ? "completed-with-errors" : "failed";
            p.exitCode = code;
            p.finishedAt = Date.now();
            resolve({
                ok: code === 0,
                clean: code === 0 && !hadErrors,
                hadErrors,
                stderrChars,
                exitCode: code,
                output: out,
                truncated,
                durationMs: p.finishedAt - p.createdAt,
                scriptFile: file,
                rollback: p.rollback,
                isolation: workspaceRun ? "workspace" : "none",
                ranIn: workspaceRun ? p.workspaceDir : scratch,
                // the transient copy leaves the workspace; the audit copy stays,
                // and the scratch HOME goes with it — one wsrun- dir per approved
                // run was quietly filling the sandbox root forever
                ...(workspaceRun ? (() => {
                    try { fs.unlinkSync(file); } catch { /* open */ }
                    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* open */ }
                    return {};
                })() : {}),
                isolationVerified: false
            });
        });
    });
}

function reject(id) {
    const p = proposals.get(id);
    if (!p) return { ok: false, error: "no such script proposal" };
    p.state = "rejected";
    return { ok: true, id };
}

function get(id) {
    return proposals.get(id) || null;
}

/** Drop proposals for a session that is going away. */
function dropSession(sessionId) {
    // ALL of a dead session's proposals go, not only the pending ones —
    // completed rows grew for process lifetime, and a deleted session's
    // pending script stayed approvable forever, resurrecting its box
    for (const [id, p] of proposals) {
        if (p.sessionId === sessionId) proposals.delete(id);
    }
}

module.exports = { propose, approve, reject, get, dropSession, MAX_OUTPUT_CHARS };
