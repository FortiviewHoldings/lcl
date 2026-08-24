/**
 * SSH CREDENTIALS follow the MACHINE, not the string.
 *
 * The bug this pins, in full: NVIDIA Sync writes one ssh_config block keyed
 * on the alias it created (ai-node-01.local) carrying the key and
 * the node's username. `ssh -F <that config> 100.64.0.1` matches NO block,
 * so ssh fell back to the WINDOWS username with no key, authentication
 * failed, and every node added by Tailscale address reported "unreachable".
 *
 * Consequence: `ssh === "ok"` was never true, so "Install remote door" could
 * not render and the door could not auto-install — on exactly the machine the
 * door exists for. Reported three times as "still no front door", through two
 * releases that each fixed something else.
 *
 * These checks run sshCreds() against a synthetic Sync config, so they prove
 * the argument construction rather than trusting a comment.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 220) : ""); }
}

// ---- a Sync config exactly like the one on the test machine ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-sshcreds-"));
const cfgFile = path.join(dir, "ssh_config");
const KEY = "C:\\Users\\you\\AppData\\Local\\NVIDIA Corporation\\Sync\\config\\nvsync.key";
// .lcl's OWN node key, the one lcl:nodeAuthorize installs on the box. null for
// the original checks (which were written before it was ever offered); set for
// the block at the end that proves it now is.
let ownKey = null;
const OWN = "C:\\lcl-data\\ssh\\lcl-node-abc123";
fs.writeFileSync(cfgFile,
    "Host ai-node-01.local\n" +
    "  ### CreatedBy: NVIDIA Sync\n" +
    "  ### UsedBy: NVIDIA Sync\n" +
    "  Hostname ai-node-01.local\n" +
    `  IdentityFile "${KEY}"\n` +
    "  Port 22\n" +
    "  User ai-node-01\n");

// ---- the functions under test, lifted from main.js so this suite needs no
//      Electron. If main.js drifts, the sourced text stops matching and the
//      final check below fails. ----
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
const grab = (name) => {
    const i = mainSrc.indexOf(`function ${name}(`);
    if (i < 0) return null;
    let depth = 0, started = false;
    for (let j = i; j < mainSrc.length; j++) {
        if (mainSrc[j] === "{") { depth++; started = true; }
        else if (mainSrc[j] === "}") { depth--; if (started && depth === 0) return mainSrc.slice(i, j + 1); }
    }
    return null;
};
const srcCreds = grab("syncCredentials"), srcSsh = grab("sshCreds");
check("syncCredentials and sshCreds exist in main.js", !!srcCreds && !!srcSsh);

let sshCreds = null;
if (srcCreds && srcSsh) {
    // eslint-disable-next-line no-new-func
    // hardenedKey() is injected as identity here: this suite proves the ARGUMENT
    // CONSTRUCTION, and the hardening itself touches the real filesystem and
    // icacls. Its behaviour is proven separately, against Windows OpenSSH.
    // lclNodeKey() is injected too: it reads .lcl's own ssh dir for the key the
    // app installed on the node, and this suite proves ARGUMENT CONSTRUCTION,
    // not directory scanning. The default here is "no key of our own", which is
    // the state every check below was originally written against.
    sshCreds = new Function("fsMod", "syncSshConfig", "hardenedKey", "lclNodeKey",
        `const fs = fsMod;\n${srcCreds}\n${srcSsh}\nreturn sshCreds;`)(
            fs, () => cfgFile, (k) => k, () => ownKey);
}

if (sshCreds) {
    // THE REPORTED CASE: node added by Tailscale IP, no username stored.
    const ip = sshCreds(null, "100.64.0.1");
    check("an address Sync does not know still gets the paired USERNAME",
        ip.target === "ai-node-01@100.64.0.1", ip);
    check("...and the paired KEY", ip.args.includes("-i") && ip.args.includes(KEY), ip.args);
    check("...with IdentitiesOnly, so the agent's other keys cannot shadow it",
        ip.args.includes("IdentitiesOnly=yes"), ip.args);
    check("...and never falls back to the bare host (the Windows username)",
        ip.target !== "100.64.0.1", ip);

    // the alias itself must NOT be rewritten — -F already handles it
    const alias = sshCreds(null, "ai-node-01.local");
    check("an address Sync DOES know is left to -F untouched",
        alias.target === "ai-node-01.local" && !alias.args.includes("-i"), alias);
    check("matching is case-insensitive",
        sshCreds(null, "AI-NODE-01.LOCAL").target === "AI-NODE-01.LOCAL");

    // an explicit username always wins
    const explicit = sshCreds("someone", "100.64.0.1");
    check("an explicitly stored username is honoured over Sync's",
        explicit.target === "someone@100.64.0.1", explicit);

    check("the Sync config is always passed with -F",
        ip.args.includes("-F") && alias.args.includes("-F"));
}

// ---- every SSH and SCP call site must go through it ----
check("sshBatch builds its target from sshCreds",
    /const creds = sshCreds\(user, host\)/.test(mainSrc) &&
    /args\.push\(creds\.target, cmd\)/.test(mainSrc));
check("no call site still concatenates user@host by hand",
    !/\$\{n\.user\}@\$\{n\.host\}/.test(mainSrc) &&
    !/n\.user \? `\$\{n\.user\}@/.test(mainSrc),
    (mainSrc.match(/n\.user \? [^\n]{0,60}/g) || []).slice(0, 3));
check("scp uses the same credentials (both transfers)",
    (mainSrc.match(/\.\.\.creds\.args\]/g) || []).length >= 2);
check("the visible-terminal ssh uses them too",
    /writeTerminalScript\(title, creds, remoteScript, host\)/.test(mainSrc) &&
    /\["ssh", "-t", \.\.\.creds\.args\.map\(q\), q\(creds\.target\)/.test(mainSrc));

// THE SPACE IN "NVIDIA Corporation". `cmd /c start "title" ssh -i <path> ...`
// re-parses every argument, so Sync's key and config paths were split, ssh got
// fragments, and the window closed instantly — clicking "Install door" or
// "Set up server" appeared to do nothing whatsoever. Reported exactly that way.
check("no ssh argv is handed to `cmd /c start` to re-parse",
    !/"start",\s*"[^"]*",\s*"ssh"/.test(mainSrc) &&
    !/\/c", "start", "\\?"\.lcl[^"]*", "ssh"/.test(mainSrc));
check("both visible terminals go through the batch-file launcher",
    (mainSrc.match(/writeTerminalScript\(/g) || []).length >= 3);
check("the batch file quotes every argument exactly once",
    /const q = \(x\) => `"\$\{String\(x\)\.replace\(\/"\/g, '""'\)\}"`;/.test(mainSrc));


// WINDOWS OPENSSH REFUSES A KEY A SECOND ACCOUNT CAN READ.
//
// Proven with the app's own binary on the test machine:
//   original key -> exit 255, "Bad permissions. Try removing permissions for
//                   user: User\\SandboxUsers ... UNPROTECTED PRIVATE KEY"
//   hardened key -> exit 0, REMOTE-OK
//
// a sandboxed dev tool's installer grants its sandbox group ReadAndExecute on
// %LOCALAPPDATA%, and that ACE inherits onto NVIDIA Sync's key. This survived
// six diagnostic passes because a shell uses GIT's ssh (MSYS, no ACL check)
// while the app spawns C:\\Windows\\System32\\OpenSSH\\ssh.exe, which enforces
// them — so every hand test passed while every app call failed.
check("the identity passed to ssh is the HARDENED copy, never the vendor's file",
    /args: \[\.\.\.args, "-i", hardenedKey\(c\.identityFile\)/.test(mainSrc));
check("hardening strips INHERITED aces — without /inheritance:r the parent's " +
      "permissions survive the copy and ssh still refuses",
    /"\/inheritance:r"/.test(mainSrc) && /"\/grant:r"/.test(mainSrc));
check("the copy lives in .lcl's own data directory, so another vendor's ACLs " +
      "cannot reach it",
    /path\.join\(paths\.dataDir\(\), "ssh"\)/.test(mainSrc));
check("the vendor's key file is never modified — only read",
    /copyFileSync\(srcKey, dst\)/.test(mainSrc) &&
    !/icacls[\s\S]{0,120}srcKey/.test(mainSrc));
check("a re-paired Sync key is picked up (staleness compared by mtime)",
    /stale = fs\.statSync\(dst\)\.mtimeMs < srcM/.test(mainSrc));
check("hardening failure degrades to the original key rather than breaking ssh",
    /return srcKey;/.test(mainSrc));

// ---- the UI must not keep accusing a VPN that is already off ----
const appSrc = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
check("Refresh repaints the block warning too, not just the node row",
    /refresh\.addEventListener\("click", \(\) => \{ paintNodes\(\); paintFound\(\); \}\)/.test(appSrc));
// SCOPED TO THE THING IT IS ABOUT. This forbade the string "Check again"
// anywhere in the renderer, which also outlawed a legitimate re-probe on the
// wizard's readiness screen after installing the model server. The rule is
// that the VPN block warning carries no button of its own — Refresh on the
// node row already repaints it — so that is what is checked.
{
    const start = appSrc.indexOf('"pref-note nd-vpn-note"');
    const end = appSrc.indexOf("found.appendChild(w)", start);
    const region = start >= 0 && end > start ? appSrc.slice(start, end) : "";
    check("the block warning does NOT carry its own button — Refresh on the node " +
          "row already repaints it, and a duplicate control is the clutter this " +
          "pass exists to remove",
        region.length > 0 && !/createElement\("button"\)/.test(region));
}

// A CONTROL THE USER IS HUNTING FOR IS NEVER HIDDEN.
// The door button was gated on ssh === "ok" while the ssh result was not
// rendered for a serving node — so it vanished for reasons invisible to
// everyone, and four releases were spent guessing at the cause.
// ONE EXPLAINED PATH TO REMOTE ACCESS.
//
// The row used to install it directly, which meant the action happened without
// the reason or — far worse — the TIMING. "Remote access can only be set up
// while you are on the machine's network" is the one fact that cannot be
// recovered later, and not stating it cost a full day. The row now carries the
// timing in its label and on the row itself, and hands off to the wizard where
// what/why/when are stated together.
// WHY BEFORE WHEN. A label naming only the timing was reported as "THAT
// DOESNT INDICATE TO ME WHY IT NEEDS TO BE DONE" — correct, because a
// constraint means nothing until you know what it buys. Every surface now
// leads with the consequence: this machine only works on its own network
// until you do this.
check("the row's control names the BENEFIT in its own label, in each of " +
      "the three states it can be in — nothing set up, half done, or a " +
      "door older than this build",
    /"Set up to use from anywhere/.test(appSrc)
    && /"Finish remote access"/.test(appSrc)
    && /"Update remote access"/.test(appSrc)
    // ...and the row offers it when the door is stale, or the update is
    // unreachable however good the label is
    && /if \(!n\.hasDoor \|\| n\.doorStale\) \{/.test(appSrc));
// ONE FACT, ONE PLACE. A control does not need a note under it explaining the
// control, plus a status line about the note, plus a warning restating the
// status; reachability was stated in four separate places.
// These checks used to demand the opposite — a row note AND a
// tooltip AND a wizard banner all carrying the window. The window now has
// exactly two homes: the state block (which the row and the wizard head both
// render), and the one sentence on the remote-access step where the
// do-or-skip decision is made.
check("the window lives in the state block, as visible text",
    /Works on this network/.test(appSrc) &&
    /cannot be set up later\b/.test(appSrc));
check("the remote-access step states what it does AND the window, in one sentence",
    /reach it from any network/.test(appSrc) &&
    /It can only be done while the machine is still reachable/.test(appSrc));
check("the old duplicate carriers are gone: no row note, no wizard banner, no door tooltip",
    !/node-window-note/.test(appSrc) &&
    !/windowNote/.test(appSrc) &&
    !/door\.title/.test(appSrc));
// THE ROW ACTS ONLY WHEN THERE IS NOTHING LEFT TO EXPLAIN.
//
// A row button that installed remote access silently is how the timing fact
// got lost for a day, so a FIRST-TIME setup still goes through the wizard,
// where what/why/when are stated together. But when the door is already on
// the machine and only publishing remains, the wizard has no question to ask
// — and the machine may be reachable for seconds, in a window the operator
// cannot choose. Then the row does it.
check("a first-time setup still goes through the wizard",
    /if \(!halfDone\) \{[\s\S]{0,200}openNodeWizard\(\{ address: n\.host/.test(appSrc));
check("an unfinished one is finished from the row, in one press",
    /await window\.lcl\.nodeArmFinish\(n\.id\)/.test(appSrc));
check("pressing it works even when the machine is not reachable yet",
    /ok: true, armed: true/.test(mainSrc) &&
    /finish this by itself the moment that /.test(mainSrc));
check("there is no second, unexplained control beside it",
    !/innerText = "Install door"/.test(appSrc) &&
    !/innerText = "Enable Funnel/.test(appSrc));

// THE WIZARD is where the action happens, and where the approval page is
// opened as part of the same step instead of as a mystery button.
check("the wizard performs the install",
    /nodeDoorSetup\(id, port\)/.test(appSrc));
check("the wizard opens Tailscale's approval page itself",
    /openExternal\(res\.funnelEnableUrl\)/.test(appSrc));
check("and says WHY that approval exists, not merely to go and click it",
    /privileged change/.test(appSrc) &&
    /once per " \+\s*\n?\s*"account, not once per machine/.test(appSrc));
check("the wizard prints a failure verbatim rather than a summary",
    /out\.innerText = \(res && \(res\.note \|\| res\.error\)\) \|\| "no response"/.test(appSrc));
check("the wizard uses the port the machine actually serves, not a constant",
    /rec\.serving\[0\]\.port/.test(appSrc));

// "do you think that translates to anything that a majority would
// understand?" — no. "ssh:" was a bare acronym fronting raw protocol output.
// The verbatim error survives (it is the searchable evidence) behind a label
// written in words.
check("the row states the ssh failure even when the node is serving",
    /node-ssh-why/.test(appSrc) &&
    /"the machine's exact answer: " \+ n\.ssh/.test(appSrc));
check("no user-facing sentence leans on the acronym SSH or the word tailnet",
    !/answers SSH/.test(appSrc) && !/your tailnet/.test(appSrc));
// LAYOUT. Verified by rendering the real stylesheet and looking at it: the
// actions block was flex-shrink:0 beside a text column with no min-width, so
// a fourth button pushed the buttons past the card edge and squeezed the name
// column into a one-word-per-line ribbon.
{
    const css = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "styles.css"), "utf8");
    check("the row's text column may shrink (min-width:0 is what permits it)",
        /\.eng-item > div:first-child \{[^}]*min-width: 0/.test(css));
    check("the row wraps instead of overflowing its dialog",
        /\.eng-item \{[^}]*flex-wrap: wrap/.test(css));
    check("the actions block wraps to its own line rather than escaping the card",
        /\.kb-actions \{[^}]*flex-wrap: wrap/.test(css));
    check("meta text breaks at word boundaries, not mid-word",
        /\.eng-item \.eng-meta \{[^}]*overflow-wrap: anywhere/.test(css) &&
        !/\.eng-item \.eng-meta \{[^}]*break-all/.test(css));
    check("no button on this row carries a sentence for a label",
        !/innerText = "Enable remote access — needs/.test(appSrc));
}

// UNCONFIRMED IS NOT UNREACHABLE.
//
// Strict host-key checking made every ssh to an unpinned machine fail, and the
// row reported that as "cannot be reached from here" — false, and it sent the
// operator hunting a network fault that did not exist while the machine sat
// there answering. Worse, it disabled the button that opens the very screen
// where confirming happens.
check("...but it is DISABLED only when the machine is genuinely not answering",
    /if \(n\.ssh && n\.ssh !== "ok" && n\.ssh !== "unconfirmed"\) \{[\s\S]{0,140}door\.disabled = true/
        .test(appSrc));
check("an unconfirmed machine keeps its button, because confirming is the fix",
    /n\.ssh !== "unconfirmed"/.test(appSrc));
check("the row distinguishes 'here and answering, unconfirmed' from 'not answering'",
    /key: "unconfirmed"/.test(appSrc) && /key: "offline"/.test(appSrc) &&
    /Needs confirming/.test(appSrc) && /Not answering/.test(appSrc));
check("main reports the distinction rather than one blanket failure",
    /ssh = up \? "unconfirmed" : "no answer on port 22"/.test(mainSrc) &&
    /if \(!hostIsPinned\(n\.host\)\) \{/.test(mainSrc));
// the state block on the same row is what explains a disabled button now —
// a tooltip restating it was one of the "four separate places"
check("a refused sign-in is its own state, not 'install a model server'",
    /key: "no-entry"/.test(appSrc) &&
    /did not accept /.test(appSrc) &&
    /node-ssh-why/.test(appSrc));
// A MACHINE ALREADY ADDED IS NOT A STRANGER.
check("the wizard lists added machines first, as yours, not as new finds",
    /Already added — finish setting up/.test(appSrc) &&
    /!addedHosts\.has\(c\.address\)/.test(appSrc));
// NO INVENTED VOCABULARY IN USER TEXT. "door" and "Funnel" are internal names;
// the user's goal is remote access and that is what every string says.
// Only PROSE counts. `s.via === "door"` compares an internal field value and
// `hasDoor` is an identifier — neither is shown to anyone. A literal that
// merely IS the word is a value; one that contains it inside a sentence is
// vocabulary the user was never given.
{
    const shown = [];
    for (const m of appSrc.matchAll(/(?:innerText|\.title|placeholder)\s*=\s*([^;]*);/g)) {
        for (const lit of m[1].match(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || []) {
            const body = lit.slice(1, -1);
            if (body.length > 6 && /\bdoor\b|funnel/i.test(body)) shown.push(body.slice(0, 70));
        }
    }
    check("no user-visible sentence uses the words door or Funnel", !shown.length, shown);
}
// The install moved from the row into the wizard, so the verbatim-failure
// requirement moved with it. Asserted on the wizard above; here we only
// require that no surface swallows a failure into a generic phrase.
check("no remote-access failure is reported as a bare generic message",
    !/innerText = "could not set up remote access"/i.test(appSrc) &&
    !/innerText = "something went wrong"/i.test(appSrc));
check("the ssh probe reports ssh's own stderr line, not the word 'unreachable'",
    /r\.err \|\| ""\)\.split\(\/\\r\?\\n\/\)\.filter\(Boolean\)\.pop\(\)/.test(mainSrc));
check("a failed door install names the exact ssh target it tried",
    /ssh to \$\{creds\.target\} failed/.test(mainSrc));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }

// A MACHINE'S STATE IS COMPUTED, NOT NARRATED.
//
// "it knew nothing about what was going on, what i needed to do or what was
// remaining for me to do." One ordered state model now answers all three, for
// every machine, on the row and at the top of every wizard screen.
check("there is one function that decides a machine's state",
    /function nodeState\(n, ctx\)/.test(appSrc));
check("every state names the next action AND why it exists",
    (appSrc.match(/\bnow: "/g) || []).length >= 5 &&
    (appSrc.match(/\bwhy: "/g) || []).length >= 5);
check("the states cover offline, unconfirmed, no server, unlinked, local-only, ready",
    /key: "offline"/.test(appSrc) && /key: "unconfirmed"/.test(appSrc) &&
    /key: "no-server"/.test(appSrc) && /key: "unlinked"/.test(appSrc) &&
    /key: "local-only"/.test(appSrc) && /key: "ready"/.test(appSrc));
check("progress is shown as done-of-total, not implied",
    /total: 4/.test(appSrc) && /st\.done \+ " of " \+ st\.total/.test(appSrc));
check("remote access is stated as OPTIONAL, needed only away from this network",
    /Optional: set up remote access/.test(appSrc) &&
    /Only needed if you use it away from this network/.test(appSrc));
check("the state block appears on the Connections row and in the wizard head",
    /info\.appendChild\(nodeStateEl\(n, \{ vpn \}\)\)/.test(appSrc) &&
    /if \(state\.node\) head\.appendChild\(nodeStateEl\(state\.node\)\)/.test(appSrc));
check("main reports whether a node's models are linked, so the state is real",
    /function nodeIsLinked\(n\)/.test(mainSrc) &&
    (mainSrc.match(/linked: nodeIsLinked\(n\)/g) || []).length >= 2);

// INSTALLED IS NOT PUBLISHED.
//
// In testing, the wizard called remote access "installed",
// showed 3 of 4 done, and skipped its own final screen — while `tailscale
// funnel status` on the node said "No serve config". A token file proves an
// install happened once; only the funnel serving proves the internet can
// reach it. A whole night and a drive to work were lost between those two.
check("readiness reports installed and published as different facts",
    /doorPublished: g\("FUNNEL"\) === "yes"/.test(mainSrc) &&
    /doorInstalled: g\("DOOR"\) === "yes"/.test(mainSrc));
check("the wizard skips its remote-access screen only when EVERY readiness " +
      "fact is true, never on one of them alone",
    (() => {
        const m = /if \(([^)]*?)\) return stepModels\(\)/.exec(appSrc);
        if (!m) return false;
        const cond = m[1];
        return /r0\.doorInstalled/.test(cond) && /r0\.doorPublished/.test(cond)
            && !/\|\|/.test(cond);          // a disjunction would skip on half of it
    })());
check("the readiness table states the half-done state in words",
    /installed, not published — one step left/.test(appSrc));
check("the node writes its public route only when the funnel actually serves",
    /if tailscale funnel status 2>\/dev\/null \| grep -q https; then/.test(mainSrc) &&
    /LCL-FUNNEL-LIVE/.test(mainSrc));
check("the Tailscale approval link is drawn IN the UI, not only in a browser",
    /gate\.innerText = res\.funnelEnableUrl/.test(appSrc) &&
    /I approved it — finish now/.test(appSrc));
check("the wizard install runs unattended so its output reaches the UI",
    /provisionDoor\(n, Number\(port\) > 0 \? Number\(port\) : 11434,\s*\n?\s*\{ unattended: true \}\)/.test(mainSrc));

// A VPN BLOCK IS NOT THE MACHINE'S FAULT.
//
// "It is answering, but refused this computer" was shown for a Spark that was
// simply unreachable through the VPN. The auth verdict now requires auth
// words in ssh's own stderr; a blocked route names the filter, not the node.
check("'cannot sign in' requires ssh to have actually reached the far end",
    /const reachedSshd = !\/connect to host\/i\.test\(n\.ssh\)/.test(appSrc) &&
    /permission denied \\\(\|authentication\|publickey\|host key/.test(appSrc));
check("a VPN-blocked machine gets its own state instead of blame",
    /key: "blocked"/.test(appSrc) &&
    /stopped on this computer, not by the/.test(appSrc));

// HALF-DONE IS ITS OWN FACT.
//
// Behind a full-tunnel VPN, after installing remote access on another network:
// the row said "...or from anywhere, once remote access is set up on its
// network" — to a user who had set it up. The door WAS on the machine;
// only publishing was missing. Telling someone to do a step they already did
// sends them hunting the wrong thing.
check("an installed-but-unpublished door is recognised from the stored record",
    /const halfDone = !!\(n && !n\.hasDoor && \(n\.relayPending \|\| n\.funnelEnableUrl\)\)/
        .test(appSrc));
check("a blocked machine with a half-done door says which half is left",
    /its address was " \+\s*\n?\s*"never published/.test(appSrc) &&
    /now: halfDone/.test(appSrc));
// A HALF-DONE SETUP IS NOT A FAULT. Reported when the models were answering
// perfectly from another city: "Next: Finish remote access now, while you are
// on its network" read as broken, and as an order to drive home — while the
// machine was reachable over the tailnet the whole time.
check("a reachable machine leads with what already works",
    /label: "Working — remote access unfinished"/.test(appSrc) &&
    /Nothing — its models are ready to use/.test(appSrc));
check("and the remaining step is stated as reachability, never as a location",
    /while it is reachable, finish remote access/.test(appSrc) &&
    !/while you are on its network\./.test(appSrc));
check("the row's own button says finish when only publishing is left",
    /door\.innerText = halfDone\s*\n?\s*\? "Finish remote access"/.test(appSrc));
check("finishing clears the unfinished-business marker",
    /delete rec\.funnelEnableUrl/.test(mainSrc));

// NO BLEED. Product text never carries names from the user's own other
// projects or infrastructure. One such hostname used to appear here as an
// example; zero is the number, and the list itself is the only place a banned
// term is allowed to be written down.
// The list lives in tests/no-bleed.js so this check cannot fall behind it.
check("no personal-stack names in product strings",
    !(()=>{try{return require("./no-bleed.js").BLEED}catch{return[]}})().some(rx => rx.test(appSrc)));

/* ============ THE KEY .lcl INSTALLED, ON THE CALLS THAT FOLLOW =============
 * `lcl:nodeAuthorize` mints lcl-node-* and appends its public half to the
 * node's authorized_keys — and then nothing ever offered it again. Its only
 * `-i` lived inside that one batch file, so every later sshBatch and scp fell
 * back to ssh's default identity search. On a machine whose default key
 * happens to be authorised that works by luck; on one where it is not, .lcl
 * authorises itself and then cannot log in, reporting a permission problem
 * rather than the key it just installed.
 * ========================================================================= */
if (srcCreds && srcSsh) {
    // FULLY SELF-CONTAINED. The checks above rewrite ssh_config as they go and
    // the suite removes its temp directory afterwards, so this block builds its
    // own config and its own instance rather than inheriting either.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ownkey-"));
    const cfg2 = path.join(dir2, "ssh_config");
    fs.writeFileSync(cfg2,
        "Host ai-node-01.local\n" +
        "  ### CreatedBy: NVIDIA Sync\n" +
        "  ### UsedBy: NVIDIA Sync\n" +
        "  Hostname ai-node-01.local\n" +
        `  IdentityFile "${KEY}"\n` +
        "  Port 22\n" +
        "  User ai-node-01\n");
    let own2 = OWN;    // .lcl has a node key of its own
    // eslint-disable-next-line no-new-func
    const sshCreds = new Function("fsMod", "syncSshConfig", "hardenedKey", "lclNodeKey",
        `const fs = fsMod;\n${srcCreds}\n${srcSsh}\nreturn sshCreds;`)(
            fs, () => cfg2, (k) => k, () => own2);

    const withUser = sshCreds("pragoptics", "100.64.0.1");
    check("OUR OWN NODE KEY IS OFFERED when a username is given — the key .lcl " +
          "installed is the key .lcl uses",
        withUser.args.includes("-i") && withUser.args.includes(OWN), withUser.args);
    check("...and it does NOT force IdentitiesOnly on that path, so a node that " +
          "accepts a different key of yours keeps working",
        !withUser.args.includes("IdentitiesOnly=yes"), withUser.args);

    const alias = sshCreds(null, "ai-node-01.local");
    check("...offered for a Sync-known alias too, alongside -F",
        alias.args.includes("-i") && alias.args.includes(OWN)
        && alias.args.includes("-F"), alias.args);

    const lent = sshCreds(null, "100.64.0.1");
    check("...and on the lend-the-vendor-key path BOTH are tried: ours first, " +
          "then the paired machine's",
        lent.args.indexOf(OWN) >= 0 && lent.args.indexOf(KEY) >= 0
        && lent.args.indexOf(OWN) < lent.args.indexOf(KEY), lent.args);
    check("...with IdentitiesOnly still pinning that branch to those two, so a " +
          "lend cannot walk the whole agent and lock the account out",
        lent.args.includes("IdentitiesOnly=yes"), lent.args);

    own2 = null;       // and with no key of our own, nothing changed at all
    const before = sshCreds(null, "100.64.0.1");
    check("WITH NO KEY OF OUR OWN THE OLD BEHAVIOUR IS EXACT — no stray -i, so " +
          "every setup that worked before this fix still works",
        before.args.filter(a => a === "-i").length === 1
        && before.args.includes(KEY), before.args);
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch { /* temp */ }
}

// mainSrc, not appSrc — the helper lives in the main process; appSrc is the
// renderer, where it would have no business being
check("the helper reads .lcl's own ssh directory rather than guessing a name",
    /function lclNodeKey\(\)/.test(mainSrc)
    && mainSrc.includes("lcl-node-") && mainSrc.includes("sshDir()"));

console.log(`\n${pass}/${pass + fail} ssh-creds checks passed`);
process.exit(fail ? 1 : 0);
