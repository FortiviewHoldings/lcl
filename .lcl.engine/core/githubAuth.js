"use strict";
/**
 * GITHUB, THE WAY THE MACHINE ALREADY DOES IT.
 *
 * The requirement: do the GitHub login securely, in chat, via the OAuth
 * container that opens, reusing the tooling that already exists. A machine may
 * have no `gh` CLI but DOES have Git with Git Credential Manager configured
 * (`credential.helper=manager`) — the Microsoft-native browser-OAuth path. So
 * .lcl never asks for a password and never handles a token: it launches GCM's
 * own sign-in (the browser "container" that opens), the user authorises there,
 * GCM stores the token in Windows Credential Manager, and every git operation
 * after that just works.
 *
 * These tools run IN THE MAIN PROCESS (the engine is in-process), i.e. the real
 * user session with full PATH and env — NOT the run_script sandbox, whose
 * scrubbed env cannot see git or reach the credential store. That is the whole
 * reason clone/sign-in are first-class here instead of proposed scripts.
 *
 * BUILD, NEVER PUSH: this module clones and signs in. It deliberately has no
 * push/deploy — the user pushes by hand until they say otherwise.
 */
const { spawn, spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ToolError, resolveInRoot } = require("./fsTools");

const WIN = process.platform === "win32";

function firstExisting(paths) {
    for (const p of paths) { try { if (p && fs.existsSync(p)) return p; } catch { /* skip */ } }
    return null;
}

function onPath(name) {
    try {
        const out = execFileSync(WIN ? "where" : "which", [name],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const hit = String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
        return hit && fs.existsSync(hit) ? hit : null;
    } catch { return null; }
}

function findGit() {
    return onPath("git") || firstExisting([
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files\\Git\\bin\\git.exe",
        "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        "/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"
    ]);
}

/** Git Credential Manager ships beside git; look there first, then PATH. */
function findGCM() {
    const git = findGit();
    if (git) {
        const gitRoot = path.dirname(path.dirname(git));   // …/Git
        const found = firstExisting([
            path.join(gitRoot, "mingw64", "bin", "git-credential-manager.exe"),
            path.join(gitRoot, "mingw64", "libexec", "git-core", "git-credential-manager.exe"),
            path.join(gitRoot, "usr", "bin", "git-credential-manager")
        ]);
        if (found) return found;
    }
    return onPath("git-credential-manager") || onPath("git-credential-manager-core");
}

/** Which GitHub accounts are already signed in — safe, reads nothing secret. */
function status() {
    const git = findGit();
    const gcm = findGCM();
    if (!git) return { installed: false, git: false, gcm: false, accounts: [],
        note: "Git is not installed on this machine." };
    if (!gcm) return { installed: false, git: true, gcm: false, accounts: [],
        note: "Git Credential Manager was not found (it ships with Git for Windows)." };
    let accounts = [];
    try {
        const r = spawnSync(gcm, ["github", "list"], { encoding: "utf8", timeout: 15000 });
        accounts = String(r.stdout || "").split(/\r?\n/).map(s => s.trim())
            .filter(Boolean).filter(a => !/^no( known)? /i.test(a) && !/accounts?:/i.test(a));
    } catch { /* leave empty */ }
    return { installed: true, git: true, gcm: true, accounts };
}

/** Remove a signed-in GitHub account (or all of them). Never throws to callers. */
function logout(account) {
    const gcm = findGCM();
    if (!gcm) return { ok: false, note: "Git Credential Manager was not found." };
    const targets = account ? [String(account)] : (status().accounts || []);
    if (!targets.length) return { ok: true, accounts: [], note: "No GitHub account was signed in." };
    for (const a of targets) {
        try { spawnSync(gcm, ["github", "logout", a], { encoding: "utf8", timeout: 15000 }); }
        catch { /* best effort */ }
    }
    const now = status().accounts || [];
    return { ok: true, accounts: now, note: now.length ? "Signed out." : "Signed out of GitHub." };
}

/**
 * Open GCM's GitHub sign-in. GCM launches its own browser OAuth and exits when
 * the operator finishes; we wait, then re-read the account list to confirm.
 * If it runs long we return `pending` rather than hang the turn — the window is
 * still open for them to finish.
 */
function signIn() {
    const gcm = findGCM();
    if (!gcm) throw new ToolError(
        "Git Credential Manager was not found. Install Git for Windows (it includes it), then try again.");
    // OUTCOME BY FACT, NOT BY EXIT CODE. GCM's window exits -1 (4294967295) when
    // the user closes it, and can exit non-zero even after a successful add, so
    // the exit code alone lied ("resolved as signed in" when the user had just
    // closed it). Decide from whether a GitHub account actually APPEARED.
    const before = new Set(status().accounts || []);
    const outcome = () => {
        const now = status().accounts || [];
        const added = now.filter(a => !before.has(a));
        if (added.length) return { ok: true, state: "success", accounts: now,
            note: "Signed in to GitHub as " + added.join(", ") + "." };
        if (now.length) return { ok: true, state: "already", accounts: now,
            note: "Already signed in to GitHub as " + now.join(", ") + "." };
        return null;   // nothing added and nothing present → not signed in
    };
    return new Promise((resolve) => {
        let ps;
        try { ps = spawn(gcm, ["github", "login"], { stdio: "ignore", windowsHide: false }); }
        catch (e) { return resolve({ ok: false, state: "failed", error: String((e && e.message) || e) }); }
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => finish(outcome() || { ok: false, state: "pending",
            note: "The GitHub sign-in window is still open — finish it in your browser, then tell me to continue." }), 240000);
        if (timer.unref) timer.unref();
        ps.on("error", (e) => finish({ ok: false, state: "failed", error: String((e && e.message) || e) }));
        ps.on("exit", (code) => finish(outcome() || { ok: false, state: "closed", code,
            note: code === 0
                ? "The sign-in finished but no GitHub account was added — nothing was signed in."
                : "You closed the GitHub sign-in before it completed. Say the word and I'll reopen it." }));
    });
}

/**
 * Clone a repo into the linked workspace using the machine's own git — so GCM
 * supplies the credentials and a PRIVATE repo pops the browser sign-in on its
 * own if you are not signed in yet.
 */
function cloneRepo(root, args = {}) {
    const git = findGit();
    if (!git) throw new ToolError("Git is not installed on this machine.");
    if (!root) throw new ToolError("Link a workspace folder first — the repo clones into it.");
    const url = String(args.url || args.repo || "").trim();
    if (!/^(https:\/\/|git@|ssh:\/\/)/i.test(url)) {
        throw new ToolError('Give the repository URL, e.g. {"url": "https://github.com/owner/repo.git"}');
    }
    const name = String(args.dir || url.replace(/\.git$/i, "").split(/[\/:]/).pop() || "repo")
        .replace(/[^\w.-]/g, "").slice(0, 80) || "repo";
    const dest = resolveInRoot(root, name);
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
        throw new ToolError(`"${name}" already exists in the workspace and is not empty.`);
    }
    return new Promise((resolve) => {
        let ps;
        try {
            ps = spawn(git, ["clone", "--progress", url, dest],
                { stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) { return resolve({ ok: false, error: String((e && e.message) || e) }); }
        let out = "";
        const grab = (d) => { out += d; if (out.length > 20000) out = out.slice(-20000); };
        ps.stdout.on("data", grab);
        ps.stderr.on("data", grab);           // git clone writes progress to stderr
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => { try { ps.kill(); } catch { /* gone */ }
            finish({ ok: false, error: "The clone took longer than 5 minutes and was stopped.",
                     output: out.slice(-1500) }); }, 300000);
        if (timer.unref) timer.unref();
        ps.on("error", (e) => finish({ ok: false, error: String((e && e.message) || e) }));
        ps.on("exit", (code) => {
            if (code === 0) return finish({ ok: true, folder: name, note: `Cloned into ${name}/.` });
            const authIssue = /authentication|could not read Username|terminal prompts disabled|403|401|repository .* not found|Permission denied/i.test(out);
            finish({ ok: false, code, output: out.slice(-1500),
                error: authIssue
                    ? "The clone could not authenticate. Sign in with github_sign_in first, then clone again."
                    : "git clone failed — see the output." });
        });
    });
}

const GITHUB_SIGNIN_ENTRY = {
    run: () => signIn(),
    help: 'github_sign_in {} — secure GitHub browser sign-in (OAuth, no password). ' +
        'Use before a private repo; never ask for a username/password/token.'
};

const GIT_CLONE_ENTRY = {
    run: (root, args) => cloneRepo(root, args),
    help: 'git_clone {"url":"…"} — clone a repo into the workspace using the machine\'s git.'
};

module.exports = {
    findGit, findGCM, status, signIn, logout, cloneRepo,
    GITHUB_SIGNIN_ENTRY, GIT_CLONE_ENTRY
};
