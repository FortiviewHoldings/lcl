/**
 * GITHUB AS A CONNECTED ACCOUNT (APIs & Connections). "make that a global under
 * apis and connections, as a connected account... when I sign in, it should
 * already be acting." Connecting is the consent: it flips the vcs.git tools to
 * notify globally so cloning/sign-in stop drawing a confirm card every time;
 * disconnecting re-arms the gate. Sign-in state is read honestly (accounts).
 */
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(R, "app", "main.js"), "utf8");
const preload = fs.readFileSync(path.join(R, "app", "preload.js"), "utf8");
const appjs = fs.readFileSync(path.join(R, "app", "renderer", "app.js"), "utf8");
const css = fs.readFileSync(path.join(R, "app", "renderer", "styles.css"), "utf8");
const gh = require(path.join(R, ".lcl.engine", "core", "githubAuth.js"));

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 160) : ""); }
}

/* ---- engine ---- */
check("githubAuth exports logout", typeof gh.logout === "function");
check("logout never throws and reports accounts", (() => {
    try { const r = gh.logout("nobody@example"); return r && typeof r.ok === "boolean" && Array.isArray(r.accounts); }
    catch { return false; }
})());

/* ---- main IPC ---- */
for (const h of ["lcl:githubStatus", "lcl:githubConnect", "lcl:githubDisconnect"]) {
    check(`main handles ${h}`, main.includes(`ipcMain.handle("${h}"`), h);
}
check("connecting does NOT mint an app-wide grant (permissions stay per-session)",
    /githubConnect"[^]*?githubAuth\.signIn\(\)/.test(main) && !/setGitToolsAllowed/.test(main));
check("no global tool-policy write hides in the github handlers",
    !/toolPolicy/.test(main.slice(main.indexOf("lcl:githubStatus"), main.indexOf("lcl:githubDisconnect") + 200)));

/* ---- preload ---- */
for (const m of ["githubStatus", "githubConnect", "githubDisconnect"]) {
    check(`preload bridges ${m}`, new RegExp(m + ":\\s*\\(").test(preload), m);
}

/* ---- renderer ---- */
check("APIs & Connections shows a Connected accounts section with a GitHub card",
    /head\("Connected accounts"\)/.test(appjs) && /renderGithubAccount\(/.test(appjs));
check("the card reads real status and offers Connect / Disconnect",
    /window\.lcl\.githubStatus\(\)/.test(appjs)
    && /window\.lcl\.githubConnect\(\)/.test(appjs)
    && /window\.lcl\.githubDisconnect\(/.test(appjs));
check("the card shows the signed-in account and the no-password promise",
    /Signed in as/.test(appjs) && /no password is entered here/i.test(appjs));
check("css styles the connected-account state pill (on/off)",
    /\.conn-account-state\.on/.test(css) && /\.conn-account-state\.off/.test(css));

console.log(`\n${pass}/${pass + fail} github-connection checks passed`);
process.exit(fail ? 1 : 0);
