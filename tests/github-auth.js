/**
 * GITHUB, THE SECURE WAY — sign in with the browser OAuth the machine already
 * has (Git Credential Manager), clone on the real machine so credentials apply,
 * and NEVER ask for a password.
 *
 * From the operator's session logs: "Provide username/password" met "I can't
 * supply credentials" — a dead-end. And "clone this repo" spiralled into fetch/
 * web-search instead of a clone. This pins the fix: two first-class tools plus
 * the corrections that route the model to them.
 *
 * Static wiring test — it does NOT trigger a real login (no network, no OAuth).
 */
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..");
const mod = fs.readFileSync(path.join(R, ".lcl.engine", "core", "githubAuth.js"), "utf8");
const agentSrc = fs.readFileSync(path.join(R, ".lcl.engine", "core", "agent.js"), "utf8");
const classify = fs.readFileSync(path.join(R, ".lcl.engine", "policy", "classify.js"), "utf8");
const caps = fs.readFileSync(path.join(R, ".lcl.engine", "core", "capabilities.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 160) : ""); }
}

/* ---- the module: real behaviour is loadable and shaped right ---- */
const gh = require(path.join(R, ".lcl.engine", "core", "githubAuth.js"));
for (const fn of ["findGit", "findGCM", "status", "signIn", "cloneRepo"]) {
    check(`githubAuth exports ${fn}`, typeof gh[fn] === "function");
}
check("exposes the two tool entries", !!gh.GITHUB_SIGNIN_ENTRY && !!gh.GIT_CLONE_ENTRY
    && typeof gh.GITHUB_SIGNIN_ENTRY.run === "function" && typeof gh.GIT_CLONE_ENTRY.run === "function");
check("status() never throws and reports installed/accounts", (() => {
    try { const s = gh.status(); return s && typeof s === "object" && "installed" in s && Array.isArray(s.accounts); }
    catch { return false; }
})());
check("sign-in spawns GCM's github login (browser OAuth)",
    /spawn\(gcm, \["github", "login"\]/.test(mod));
check("clone validates the url is a repo and refuses an occupied folder",
    /\^\(https:\\\/\\\/\|git@\|ssh:\\\/\\\//.test(mod) && /already exists in the workspace/.test(mod));
check("clone maps an auth failure to 'sign in first', not a password ask",
    /github_sign_in first/.test(mod) && /authentication/i.test(mod));
check("BUILD not PUSH — the module spawns clone, never a push command",
    /\["clone"/.test(mod) && !/git\s+push/i.test(mod) && !/["\[]\s*push["\],]/.test(mod));

/* ---- agent: registered, gated, and budget-safe ---- */
check("both tools are registered behind the network switch",
    /tools\.github_sign_in = githubAuth\.GITHUB_SIGNIN_ENTRY/.test(agentSrc)
    && /tools\.git_clone = githubAuth\.GIT_CLONE_ENTRY/.test(agentSrc));
check("git_clone needs a linked workspace; sign-in does not",
    /if \(hasWorkspace\) tools\.git_clone = /.test(agentSrc));
check("github_sign_in stays callable but OUT of the always-on prompt (token budget)",
    /\.filter\(\(\[name\]\) => !\[[^\]]*"github_sign_in"[^\]]*\]\.includes\(name\)\)/.test(agentSrc));

/* ---- the corrections route the model to the tools ---- */
check("the password dead-end routes to github_sign_in",
    /offered credentials — use the secure GitHub sign-in/.test(agentSrc)
    && /github_sign_in\\", \\"args\\": \{\}\}/.test(agentSrc)
    && /accept: \(t\) => t === "github_sign_in"/.test(agentSrc));
check("the clone-verify interceptor prefers git_clone when present",
    /tools\.git_clone \? \{[\s\S]{0,700}accept: \(t\) => t === "git_clone"/.test(agentSrc));
check("a refused clone is routed to git_clone, not a script, when the tool exists",
    /isClone && tools\.git_clone/.test(agentSrc));
check("the password dead-end scans the WHOLE thread for GitHub context (not just the last few user turns)",
    /const ghSignal = /.test(agentSrc)
    && /working\.some\(w => w && ghSignal\(w\.content\)\)/.test(agentSrc));
check("writing a clone script is redirected to git_clone",
    /wrote a clone script instead of using git_clone/.test(agentSrc)
    && /\["write_file", "read_file", "edit_file"\]\.includes\(String\(call\.tool\)\)/.test(agentSrc)
    && /\\bclone\\b\|git\\s\+clone/.test(agentSrc));

/* ---- policy + capability ---- */
check("classify: both tools are EXECUTE under the vcs.git capability",
    /github_sign_in: \{ capability: "vcs\.git", classification: CLASSIFICATION\.EXECUTE/.test(classify)
    && /git_clone:\s*\{ capability: "vcs\.git", classification: CLASSIFICATION\.EXECUTE/.test(classify));
check("capabilities: vcs.git has a label and an order slot",
    /"vcs\.git": "GitHub & version control"/.test(caps) && /"vcs\.git"/.test(caps.split("CAP_ORDER")[1] || ""));
check("policy: vcs.git is BASE-GRANTED so EXECUTE shows an approval card instead of a hard DENY",
    /const BASE_GRANTS = \[[^\]]*"vcs\.git"[^\]]*\]/.test(classify));

console.log(`\n${pass}/${pass + fail} github-auth checks passed`);
process.exit(fail ? 1 : 0);
