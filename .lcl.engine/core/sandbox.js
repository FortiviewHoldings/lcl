const { spawn, spawnSync, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const paths = require("./paths");
const { ToolError } = require("./fsTools");

/**
 * SANDBOX — build it, prove it, then let it out.
 *
 * The goal: the model writes and RUNS code to check its own work, and nothing
 * reaches the user's real files until the checks pass.
 *
 * BE HONEST ABOUT THE STRENGTH OF THIS. Only what is IMPLEMENTED here is ever
 * claimed:
 *
 *   windows-low-il  a child at LOW INTEGRITY in a job object. Windows refuses
 *                   its writes to the user's documents - kernel-enforced, no
 *                   install, no administrator. It does NOT stop it READING,
 *                   and a few locations Windows keeps low-writable
 *                   (AppData\LocalLow, the Low temp folder, part of HKCU) stay
 *                   reachable and are outside the box.
 *   none            a disposable folder. Containment by convention only.
 *
 * Docker and WSL are DETECTED and reported as present, and nothing more:
 * running a script inside a container is not implemented, so ranking them as
 * the tier in force meant installing Docker silently replaced a boundary that
 * works with none - and stamped it "tested". Detection is a diagnostic; only
 * an implemented, canary-proven tier is claimed.
 *
 * Even the weak mode fixes two things that were genuinely wrong: run_script
 * executed approved scripts with cwd = the user's HOME directory and the FULL
 * process environment, so a script could read anything in the home tree and
 * every API key the app was launched with. Work here gets a scratch directory
 * and an environment cut down to what an interpreter needs to start.
 */

const MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_BOXES = 20;

let isolationCache = null;

/** The Windows launcher that runs a child at LOW INTEGRITY. See lowbox.ps1. */
const LOWBOX_PS1 = path.join(__dirname, "lowbox.ps1");

/** Where the compiled interop is kept, so only the first run pays the compiler. */
function binDir() {
    const dir = path.join(sandboxRoot(), "_bin");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * WHAT THIS MACHINE CAN ACTUALLY ENFORCE — detected, then PROVEN.
 *
 * The ladder, strongest first:
 *
 *   docker           a container: separate filesystem and process namespace
 *   wsl              a Linux filesystem separate from Windows
 *   windows-low-il   a child process at LOW INTEGRITY, in a job object. Windows
 *                    refuses writes from it to the user's own files, and the
 *                    refusal comes from the kernel rather than from this app's
 *                    good manners. Needs no install and no administrator.
 *   none             a disposable folder. Containment by convention only.
 *
 * The third rung is why this changed. A plain Windows machine has neither
 * Docker nor WSL, and the honest answer used to stop there — "code still runs
 * as you". Windows itself offers a boundary that was never being used.
 *
 * DETECTION IS NOT PROOF. A tier is claimed only after verify() has watched a
 * canary process try to write outside its box and be refused; until then the
 * report says so. A boundary this app merely believes in is the one thing it
 * must never sell as safety.
 */
function detectTier() {
    const probe = (cmd) => {
        try { execSync(cmd, { stdio: "pipe", timeout: 8000 }); return true; }
        catch { return false; }
    };
    // `wsl.exe` EXISTS on stock Windows 11 as a stub that reports "not
    // installed", so presence is meaningless here — only a working command
    // counts. Measured on this machine: `where wsl` finds it, `wsl --status`
    // fails.
    const present = {
        docker: probe("docker version --format 1"),
        wsl: probe("wsl --status")
    };

    // WHAT IS INSTALLED IS NOT WHAT IS USED.
    //
    // Docker and WSL were RANKED above the Windows boundary and reported as
    // the tier in force — while exec() had no container path at all and
    // plain-spawned on the host. So installing Docker, the very upgrade this
    // module recommended, silently switched the app from a boundary that
    // works to none, and stamped it "tested". Found by an adversarial review
    // that simulated a Docker machine and watched a script write into the
    // home folder at Medium integrity.
    //
    // A tier is only claimed if it is IMPLEMENTED here. Detection is kept as
    // a diagnostic — it is a true and useful fact — but it no longer decides
    // anything, and `present` says so out loud.
    if (process.platform === "win32" && fs.existsSync(LOWBOX_PS1)) {
        return { kind: "windows-low-il", present,
                 detail: "a low-integrity process in a job object — Windows refuses " +
                         "its writes to your documents, and kills the whole tree on a timeout" };
    }
    return { kind: "none", present,
             detail: "a disposable folder with a scrubbed environment — " +
                     "code still runs as you, so this is containment, not a security boundary" };
}

function upgradeOffer(kind) {
    if (kind === "windows-low-il") {
        // A REAL BOUNDARY THAT IS STILL NOT THE STRONGEST ONE. Low integrity
        // stops a script WRITING to the user's files; it does not stop it
        // READING them. Say which half is covered, and name the upgrade
        // without installing it or asking for administrator rights.
        // WHAT THIS BOUNDARY DOES NOT DO, stated where it will be read. It is
        // not a recommendation to install anything: running scripts inside a
        // container is NOT implemented, so suggesting Docker would be
        // suggesting something that buys nothing today.
        return { what: "the limits of this boundary",
                 how: "keep anything you would not want read out of the folder a " +
                      "script is pointed at",
                 why: "Windows refuses a low-integrity script's writes to your " +
                      "documents, and it does NOT stop it READING files you can read. " +
                      "A few locations Windows keeps writable at low integrity — " +
                      "AppData\\LocalLow, the Low temp folder, and part of your own " +
                      "registry — also stay writable, and are outside the box." };
    }
    return process.platform === "win32"
        ? { what: "Docker Desktop, or Windows Subsystem for Linux",
            how: "install Docker Desktop, or run `wsl --install` in a terminal you " +
                 "opened yourself as administrator",
            why: "either one turns script runs into a real boundary instead of a tidy folder" }
        : { what: "Docker",
            how: "install Docker and start its daemon",
            why: "it turns script runs into a real boundary instead of a tidy folder" };
}

/** What isolation can this machine provide? Detected once; proven by verify(). */
function isolation() {
    if (isolationCache) return isolationCache;
    const t = detectTier();
    isolationCache = {
        kind: t.kind,
        detail: t.detail,
        strong: t.kind !== "none",
        // WHAT IS INSTALLED, kept as a diagnostic and reported — it is a true
        // fact worth showing, and it decides nothing. Deleting the readout to
        // stop it deciding things would have thrown away information.
        present: t.present || { docker: false, wsl: false },
        // NOT YET PROVEN. Until a canary has been refused, this says so rather
        // than letting the word "sandbox" carry a promise nobody checked.
        verified: false,
        proof: null,
        offer: upgradeOffer(t.kind)
    };
    return isolationCache;
}

/**
 * PROVE IT. Runs a canary inside a real box that tries to write OUTSIDE, and
 * only then reports the boundary as verified. If the canary escapes — or the
 * launcher cannot run at all, which is what a locked-down PowerShell policy
 * looks like — the tier is DOWNGRADED and the reason recorded. Better to be
 * told there is no boundary than to be told there is one that is not there.
 */
async function verify({ force = false } = {}) {
    const iso = isolation();
    if (iso.verified && !force) return iso;
    if (iso.kind === "none") { iso.proof = "no boundary to verify"; return iso; }

    const box = create({ name: "verify" });
    // EVERY ROUTE OUT, NOT ONE.
    //
    // The first version probed a single path under the sandbox root, was
    // refused, and certified the boundary. Windows keeps a handful of places
    // deliberately writable at low integrity — AppData\LocalLow, the Low temp
    // folder, part of HKCU — and a script reached all three, durably, outside
    // the box and invisible to destroy() and inventory(). A canary that
    // measures one door and reports on the building is the same failure this
    // module exists to prevent, so it now tries them all and reports exactly
    // which held.
    const targets = [
        { key: "sandbox-root", p: path.join(sandboxRoot(), `_canary-${Date.now().toString(36)}.txt`) },
        { key: "documents", p: path.join(os.homedir(), `_lcl-canary-${Date.now().toString(36)}.txt`) },
        { key: "localLow", p: process.env.USERPROFILE
            ? path.join(process.env.USERPROFILE, "AppData", "LocalLow", `_lcl-canary-${Date.now().toString(36)}.txt`) : null },
        { key: "tempLow", p: process.env.TEMP
            ? path.join(process.env.TEMP, "Low", `_lcl-canary-${Date.now().toString(36)}.txt`) : null }
    ].filter(t => t.p);
    for (const t of targets) { try { fs.unlinkSync(t.p); } catch { /* absent */ } }

    try {
        if (iso.kind === "windows-low-il") {
            // A CANARY THAT NEVER RAN IS NOT A CANARY THAT WAS REFUSED. Both
            // leave no file outside the box, and treating them the same is how
            // a broken launcher would certify itself. So it proves it is alive
            // by writing INSIDE first.
            const alive = path.join(box.dir, "_lcl_alive.txt");
            const cmdFile = path.join(box.dir, "_lcl_canary.cmd");
            const lines = ["@echo off", `echo alive> "${alive}"`];
            for (const t of targets) lines.push(`echo x> "${t.p}" 2>nul`);
            fs.writeFileSync(cmdFile, lines.join("\r\n") + "\r\n", "ascii");
            const r = await exec(box.id, { command: "cmd.exe", args: ["/c", cmdFile],
                                           timeoutMs: 30_000 });
            if (!fs.existsSync(alive)) {
                throw new Error("the canary never ran inside its box" +
                    (r && r.error ? `: ${r.error}` : ""));
            }
            const reached = targets.filter(t => fs.existsSync(t.p)).map(t => t.key);
            const held = targets.filter(t => !fs.existsSync(t.p)).map(t => t.key);
            // The boundary is REAL when it stops a script reaching the user's
            // own documents. It is NOT total, and the parts it does not stop
            // are named rather than left for someone to discover.
            const stopsDocuments = !reached.includes("documents")
                                && !reached.includes("sandbox-root");
            iso.verified = stopsDocuments;
            iso.reached = reached;
            iso.held = held;
            iso.proof = stopsDocuments
                ? `a live canary was refused at ${held.join(", ")}` +
                  (reached.length
                      ? `; it COULD still write to ${reached.join(", ")}, which Windows ` +
                        `keeps writable at low integrity and which lie outside the box`
                      : "")
                : `a canary wrote to ${reached.join(", ")} — this is NOT a boundary`;
            if (!stopsDocuments) {
                iso.kind = "none";
                iso.strong = false;
                iso.detail = "a disposable folder — the stronger boundary this machine " +
                             "appeared to offer did not hold when it was tested";
                iso.offer = upgradeOffer("none");
            }
        }
    } catch (e) {
        iso.verified = false;
        iso.proof = `could not be tested: ${String((e && e.message) || e).slice(0, 140)}`;
        iso.kind = "none";                 // an untestable boundary is not a boundary
        iso.strong = false;
        iso.offer = upgradeOffer("none");
    } finally {
        for (const t of targets) { try { fs.unlinkSync(t.p); } catch { /* never written */ } }
        destroy(box.id);
    }
    return iso;
}

/* ------------------------------------------------------------------ boxes */

/**
 * WHERE THE BOXES LIVE — one consistent, findable place, chosen for a reason.
 *
 * Anything a user adds inside a box is flagged and lives somewhere consistent
 * and easy to find.
 *
 * On Windows that place must ALSO be somewhere the user has Full Control,
 * because labelling a directory Low integrity needs WRITE_OWNER — and "Modify"
 * is not enough. Measured the hard way: a data directory whose permissions are
 * inherited from the drive root (Users:RX, Authenticated Users:Modify) refuses
 * the label with access denied, the box stays at Medium, and the low-integrity
 * child then cannot write into its own workspace — every run comes back empty
 * with exit 1 and no explanation. The user's own AppData grants Full Control,
 * so that is where boxes go, under a name that is obvious when you find it.
 */
function sandboxRoot() {
    const dir = process.platform === "win32" && process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, ".lcl", "sandbox")
        : path.join(paths.dataDir(), "sandbox");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * A cut-down environment. process.env on a developer machine carries API keys,
 * tokens and credentials; handing that to code the model wrote is exactly the
 * leak this is supposed to prevent. Keep only what an interpreter needs to run.
 */
function scrubbedEnv(boxDir) {
    const keep = ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
                  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "TZ"];
    const env = {};
    for (const k of keep) {
        // Windows env names are case-insensitive; find the real key
        const real = Object.keys(process.env).find(x => x.toUpperCase() === k);
        if (real && process.env[real]) env[k] = process.env[real];
    }
    // point every temp/home path INTO the box, so a program writing to "~" or
    // the temp dir writes here rather than into the user's profile
    env.TEMP = env.TMP = env.TMPDIR = boxDir;
    env.HOME = env.USERPROFILE = boxDir;
    env.LCL_SANDBOX = "1";            // programs can detect they are being checked
    // a marker that this is NOT the user's real environment
    env.CI = "1";
    return env;
}

/**
 * THE LEDGER OF WHOSE FILE IS WHOSE.
 *
 * When working on someone else's machine, it must be possible to see what is
 * theirs and know the app's own code underneath is untouched.
 *
 * Everything this app writes into a box is recorded here. Anything found in
 * the box that is NOT in the ledger was put there by the person using it, and
 * is reported as theirs. The rule is deliberately that way round: the app can
 * only vouch for what it did itself, so it treats everything else as the
 * user's rather than guessing.
 */
/**
 * OUTSIDE THE BOX, DELIBERATELY.
 *
 * The ledger decides which files the panel presents as the user's own. It
 * used to live INSIDE the box — which is Low-labelled so the sandboxed code
 * can work there — so the very code being audited could rewrite its own
 * provenance and have the app vouch for it. It is a sibling of the box now,
 * at Medium integrity, where a low-integrity child cannot touch it.
 */
function ledgerPath(dir) {
    const root = path.dirname(dir);
    return path.join(root, `${path.basename(dir)}.ledger.json`);
}

function readLedger(dir) {
    try { return JSON.parse(fs.readFileSync(ledgerPath(dir), "utf8")); }
    catch { return { ours: [], createdAt: null, sessionId: null }; }
}

function noteOurs(dir, rel) {
    const led = readLedger(dir);
    const key = String(rel).split(path.sep).join("/");
    if (!led.ours.includes(key)) led.ours.push(key);
    try { fs.writeFileSync(ledgerPath(dir), JSON.stringify(led, null, 1)); } catch { /* scratch */ }
}

/** Every file in the box right now, relative and slash-separated. */
function snapshot(dir) {
    const out = new Set();
    const walk = (rel) => {
        const full = path.join(dir, rel);
        let st; try { st = fs.statSync(full); } catch { return; }
        if (st.isDirectory()) { for (const e of fs.readdirSync(full)) walk(path.join(rel, e)); return; }
        out.add(rel.split(path.sep).join("/"));
    };
    try { for (const e of fs.readdirSync(dir)) walk(e); } catch { /* gone */ }
    return out;
}

/**
 * A FILE A SCRIPT PRODUCED IS NOT A FILE THE USER ADDED.
 *
 * Three origins, because collapsing them would mean either accusing the
 * operator of leaving files they never touched, or hiding files they did.
 * What a run creates is recorded as the run's, by diffing the box around it.
 */
function noteProduced(dir, before) {
    const led = readLedger(dir);
    led.produced = led.produced || [];
    for (const f of snapshot(dir)) {
        if (!before.has(f) && !led.ours.includes(f) && !led.produced.includes(f)) {
            led.produced.push(f);
        }
    }
    try { fs.writeFileSync(ledgerPath(dir), JSON.stringify(led, null, 1)); } catch { /* scratch */ }
}

/**
 * Label a box LOW so a low-integrity child can actually work in it.
 *
 * Argument array, never a shell string: `(OI)(CI)Low` is full of characters
 * cmd.exe treats as syntax, so a shelled-out icacls silently fails and the box
 * stays at Medium — where the low-integrity child cannot write, and every run
 * comes back with no output and exit 1. That is exactly how this was found.
 */
function labelLow(dir) {
    if (process.platform !== "win32") return false;
    try {
        const r = spawnSync("icacls", [dir, "/setintegritylevel", "(OI)(CI)Low"],
                            { encoding: "utf8", timeout: 15_000, windowsHide: true });
        return r.status === 0;
    } catch { return false; }
}

/* EVERY BOX THIS PROCESS STILL HOLDS, not only the ones a session claimed.
 *
 * The eviction below already refused to delete a box owned by a live session,
 * for exactly the right reason. It was half the rule: a box opened WITHOUT a
 * session id — a tool run, a one-off workspace, anything not yet registered —
 * was still fair game, so opening a twenty-first box could delete the twentieth
 * while its owner was still writing to it. Measured, not theorised: under a
 * full release gate the sandbox root reaches the cap, and
 * `tests/sandbox-boundary.js` failed with ENOENT writing the user's own
 * file into a box that had been evicted three lines earlier. Standalone, with
 * an empty root, it passed — which is how a real bug hid as a flake. */
const liveBoxes = new Set();

/** Create a disposable workspace. Returns { id, dir }. */
function create({ name = "work", sessionId = null, rootDir = null } = {}) {
    // rootDir places the box under the user's own workspace instead of
    // the global collection — one folder they can see, still labelled Low
    const root = rootDir || sandboxRoot();
    if (rootDir) fs.mkdirSync(rootDir, { recursive: true });
    // keep the collection bounded — old boxes are scratch, not history
    try {
        // A BOX A LIVE SESSION OWNS IS NEVER EVICTED, and age is measured by
        // the clock rather than guessed from the name. Pruning by sorted name
        // meant the eviction order was alphabetical — and a session's box,
        // with the user's own files in it, could be deleted out from
        // under the conversation still using it.
        const owned = new Set([...bySession.values(), ...liveBoxes]);
        const boxes = fs.readdirSync(root, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name !== "_bin")
            .map(d => {
                let at = 0;
                try { at = fs.statSync(path.join(root, d.name)).birthtimeMs
                          || fs.statSync(path.join(root, d.name)).mtimeMs; } catch { at = 0; }
                return { name: d.name, at };
            })
            .filter(b => !owned.has(b.name))
            .sort((x, y) => x.at - y.at);          // oldest first
        while (boxes.length && boxes.length + owned.size >= MAX_BOXES) {
            const oldest = boxes.shift();
            fs.rmSync(path.join(root, oldest.name), { recursive: true, force: true });
            try { fs.unlinkSync(path.join(root, `${oldest.name}.ledger.json`)); }
            catch { /* never written */ }
        }
    } catch { /* first run */ }

    const id = `${String(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "work"}-${Date.now().toString(36)}`;
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    if (rootDir) boxDirOverrides.set(id, { dir, parent: rootDir });
    liveBoxes.add(id);
    // the box has to be writable BY a low-integrity child, which means the box
    // itself must be labelled Low — otherwise the boundary would also stop the
    // work it is supposed to allow
    const labelled = labelLow(dir);
    try {
        fs.writeFileSync(ledgerPath(dir), JSON.stringify(
            { ours: [], createdAt: new Date().toISOString(),
              sessionId: sessionId || null, lowLabelled: labelled }, null, 1));
    } catch { /* scratch */ }
    return { id, dir, lowLabelled: labelled };
}

/* ------------------------------------------------------ one box per session */

/**
 * A SESSION OWNS ITS SANDBOX.
 *
 * One at a time per conversation — a second box for the same session would
 * mean two answers to "where is this session's work". Several at once ACROSS
 * sessions, because two conversations doing unrelated work have no reason to
 * queue behind each other. The box is made on first use and destroyed when the
 * session lets go of it: it exists only while in use.
 */
const bySession = new Map();          // sessionId -> box id
// boxes the operator asked to live UNDER THE WORKSPACE ROOT — the id
// resolves here first, with its own containment against the parent it
// was registered under
const boxDirOverrides = new Map();    // box id -> { dir, parent }

function forSession(sessionId, { name = "session", rootDir = null } = {}) {
    // a workspace-rooted box and the global one are DIFFERENT places — the
    // key carries the root so flipping the sandbox switch never hands back
    // a box in the wrong world
    const sid = String(sessionId || "");
    const key = sid + (rootDir ? "::" + rootDir : "");
    if (!sid) return create({ name, rootDir });
    const existing = bySession.get(key);
    if (existing) {
        try { return { id: existing, dir: boxDir(existing), reused: true }; }
        catch { bySession.delete(key); }        // it was cleaned up under us
    }
    const box = create({ name, sessionId: sid, rootDir });
    bySession.set(key, box.id);
    return { ...box, reused: false };
}

/** Give up a session's box and delete it. Called when the work is done. */
function releaseSession(sessionId) {
    // a session may own one global box AND one per workspace root — all go
    const want = String(sessionId || "");
    let released = false, lastId = null;
    for (const [key, id] of [...bySession]) {
        if (key === want || key.startsWith(want + "::")) {
            bySession.delete(key);
            try { destroy(id); } catch { /* already gone */ }
            boxDirOverrides.delete(id);
            released = true; lastId = id;
        }
    }
    return { ok: true, released, id: lastId };
}

/** Which session owns which box, for the panel that shows them. */
function sessionBoxes() {
    return [...bySession.entries()].map(([sessionId, id]) => ({ sessionId, id }));
}

/**
 * WHAT IS IN THIS BOX, AND WHOSE IT IS.
 *
 * Files this app wrote are "ours"; anything else in the box was added by the
 * person at the keyboard and is flagged as theirs, with the path they can go
 * and look at. Nothing is hidden and nothing is guessed at.
 */
function inventory(id) {
    let dir;
    try { dir = boxDir(id); } catch { return { id, dir: null, files: [], userAdded: 0 }; }
    const led = readLedger(dir);
    const ours = new Set(led.ours || []);
    const produced = new Set(led.produced || []);
    const files = [];
    const walk = (rel) => {
        const full = path.join(dir, rel);
        let st;
        try { st = fs.statSync(full); } catch { return; }
        if (st.isDirectory()) {
            for (const e of fs.readdirSync(full)) walk(path.join(rel, e));
            return;
        }
        const key = rel.split(path.sep).join("/");
        files.push({ path: key, bytes: st.size,
                     modifiedAt: new Date(st.mtimeMs).toISOString(),
                     origin: ours.has(key) ? "app" : produced.has(key) ? "run" : "user" });
    };
    try { for (const e of fs.readdirSync(dir)) walk(e); } catch { /* gone */ }
    const rank = { user: 0, run: 1, app: 2 };
    files.sort((a, b) => (rank[a.origin] - rank[b.origin]) || a.path.localeCompare(b.path));
    return { id, dir, sessionId: led.sessionId || null,
             createdAt: led.createdAt || null,
             files, userAdded: files.filter(f => f.origin === "user").length };
}

function boxDir(id) {
    const o = boxDirOverrides.get(String(id || ""));
    if (o) {
        const real = fs.existsSync(o.dir) ? fs.realpathSync(o.dir) : null;
        const par = fs.existsSync(o.parent) ? fs.realpathSync(o.parent) : null;
        if (!real || !par || (real !== par && !real.startsWith(par + path.sep))) {
            throw new ToolError("unknown sandbox");
        }
        return real;
    }
    const dir = path.join(sandboxRoot(), String(id || ""));
    const real = fs.existsSync(dir) ? fs.realpathSync(dir) : null;
    const rootReal = fs.realpathSync(sandboxRoot());
    // containment: an id must never escape the sandbox root
    if (!real || (real !== rootReal && !real.startsWith(rootReal + path.sep))) {
        throw new ToolError("unknown sandbox");
    }
    return real;
}

function destroy(id) {
    liveBoxes.delete(id);
    try {
        const dir = boxDir(id);
        const led = ledgerPath(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        try { fs.unlinkSync(led); } catch { /* never written */ }
        return { ok: true };
    } catch { return { ok: false }; }
}

function list() {
    const root = sandboxRoot();
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== "_bin").map(d => d.name); }
    catch { return []; }
    return names.map(id => {
        const dir = path.join(root, id);
        let files = 0, st = null;
        try { files = fs.readdirSync(dir).length; st = fs.statSync(dir); } catch { /* gone */ }
        return { id, dir, files, createdAt: st ? new Date(st.birthtimeMs).toISOString() : null };
    }).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

/* ------------------------------------------------------------------- run */

const INTERPRETERS = {
    node: { command: process.platform === "win32" ? "node.exe" : "node", args: (f) => [f], ext: ".js" },
    python: { command: process.platform === "win32" ? "py" : "python3", args: (f) => [f], ext: ".py" },
    powershell: { command: "powershell.exe",
                  args: (f) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f],
                  ext: ".ps1" },
    bash: { command: "bash", args: (f) => [f], ext: ".sh" }
};

/**
 * Run one command inside a box. Never throws on a non-zero exit — a failing
 * check is a RESULT, and the whole point is to see it before the user does.
 */
/**
 * Run a command at LOW INTEGRITY through the Windows launcher.
 *
 * The child's own output goes to a file inside the box — the box is the only
 * place it is allowed to write, and a pipe across an integrity boundary is
 * more fragile than a redirect. The file is tailed so live output still
 * reaches the caller as it happens.
 */
function execLowIL(dir, command, args, limit, onOutput) {
    // A FILE PER RUN. One fixed name meant two runs in the same session box
    // raced on it, and a run could be shown another run's output.
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const outFile = path.join(dir, `_lcl_out-${stamp}.txt`);
    const errFile = path.join(dir, `_lcl_err-${stamp}.txt`);
    const envFile = path.join(dir, `_lcl_env-${stamp}.txt`);
    const env = scrubbedEnv(dir);
    fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"), "utf8");
    noteOurs(dir, path.basename(outFile));
    noteOurs(dir, path.basename(errFile));
    noteOurs(dir, path.basename(envFile));

    // STDERR KEPT SEPARATE, because it is a diagnostic the operator relies on.
    // PowerShell exits 0 even when a cmdlet raised a non-terminating error, so
    // merging the streams meant a half-failed script reported "Finished
    // cleanly". They are captured apart and merged for display only.
    const quoted = [command, ...args].map(a => `"${String(a)}"`).join(" ");
    const cmdline = `cmd.exe /c "${quoted} > "${outFile}" 2> "${errFile}""`;

    return new Promise((resolve) => {
        const started = Date.now();
        let sent = 0;
        const tail = setInterval(() => {
            try {
                const t = fs.readFileSync(outFile, "utf8");
                if (t.length > sent) {
                    const chunk = t.slice(sent);
                    sent = t.length;
                    if (typeof onOutput === "function") onOutput(chunk);
                }
            } catch { /* not created yet */ }
        }, 250);

        const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass", "-File", LOWBOX_PS1,
            "-Cmd", cmdline, "-Cwd", dir, "-EnvFile", envFile,
            "-TimeoutMs", String(limit), "-AsmDir", binDir()],
            { windowsHide: true });

        let verdict = "";
        ps.stdout.on("data", d => { verdict += d; });
        ps.stderr.on("data", d => { verdict += d; });
        ps.on("error", (e) => {
            if (settled) return; settled = true;
            clearInterval(tail); clearTimeout(guard);
            resolve({ ok: false, code: null, output: "", timedOut: false,
                      error: `could not start the sandbox launcher: ${e.message}` });
        });
        let settled = false;
        const finish = (extra) => {
            if (settled) return; settled = true;
            clearInterval(tail);
            clearTimeout(guard);
            let out = "", err = "";
            try { out = fs.readFileSync(outFile, "utf8"); } catch { /* nothing written */ }
            try { err = fs.readFileSync(errFile, "utf8"); } catch { /* nothing written */ }
            const stderrChars = err.length;
            let combined = out + (err ? ((out && !out.endsWith("\n")) ? "\n" : "") + err : "");
            let truncated = false;
            if (combined.length > MAX_OUTPUT) {
                combined = combined.slice(0, MAX_OUTPUT) + "\n[.lcl] output truncated\n";
                truncated = true;
            }
            if (typeof onOutput === "function" && combined.length > sent) {
                onOutput(combined.slice(sent));
            }
            const m = /LCLBOX-EXIT=(-?\d+)/.exec(verdict);
            const t = /LCLBOX-TIMEOUT=(\d)/.exec(verdict);
            const code = m ? Number(m[1]) : null;
            // the launcher reports this as its own fact; it is never inferred
            // from an exit code a script could legitimately return
            const timedOut = !!(t && t[1] === "1") || !!(extra && extra.timedOut);
            if (timedOut) combined += `\n[.lcl] stopped: exceeded ${Math.round(limit / 1000)}s\n`;
            resolve({
                ok: code === 0 && !timedOut,
                clean: code === 0 && !timedOut && stderrChars === 0,
                hadErrors: stderrChars > 0,
                stderrChars,
                code: timedOut ? null : code,
                output: combined,
                truncated,
                elapsedMs: Date.now() - started,
                timedOut,
                isolation: "windows-low-il",
                error: (extra && extra.error) || (code === null && !timedOut
                    ? `the sandbox launcher did not report a result: ${verdict.trim().slice(0, 200)}`
                    : undefined)
            });
        };

        // THE LAUNCHER ITSELF CAN HANG. The job object bounds the CHILD, but
        // nothing bounded powershell.exe - a wedged launcher left exec() never
        // settling and the tail interval running for the life of the app.
        const guard = setTimeout(() => {
            try { ps.kill(); } catch { /* already gone */ }
            try {
                if (ps.pid) spawn("taskkill", ["/pid", String(ps.pid), "/T", "/F"],
                                  { windowsHide: true });
            } catch { /* best effort */ }
            finish({ timedOut: true,
                     error: "the sandbox launcher did not return; it was stopped" });
        }, limit + 30000);

        ps.on("close", () => finish(null));
    });
}

function exec(id, { command, args = [], timeoutMs = DEFAULT_TIMEOUT_MS, onOutput } = {}) {
    const dir = boxDir(id);
    if (!command) throw new ToolError("nothing to run");
    const limit = Math.max(1000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    // what the box held BEFORE this run, so whatever appears is credited to
    // the run rather than to the person at the keyboard
    const before = snapshot(dir);
    const credit = (r) => { try { noteProduced(dir, before); } catch { /* scratch */ } return r; };

    // THE STRONGEST AVAILABLE BOUNDARY IS USED, NOT MERELY NAMED. On Windows
    // with no Docker and no WSL that is a low-integrity child; the OS refuses
    // its writes to the user's files. Everywhere else this falls through to
    // the plain spawn below, which is unchanged.
    if (isolation().kind === "windows-low-il") {
        return execLowIL(dir, command, args, limit, onOutput).then(credit);
    }

    return new Promise((resolve) => {
        let out = "";
        let truncated = false;
        const append = (chunk) => {
            if (truncated) return;
            const s = chunk.toString();
            if (out.length + s.length > MAX_OUTPUT) {
                out += s.slice(0, MAX_OUTPUT - out.length) + "\n[.lcl] output truncated\n";
                truncated = true;
            } else out += s;
            if (typeof onOutput === "function") onOutput(s);
        };

        const started = Date.now();
        let child;
        try {
            child = spawn(command, args, {
                cwd: dir,                       // NOT the user's home
                env: scrubbedEnv(dir),          // NOT the user's secrets
                windowsHide: true,
                shell: false                    // the file is the payload
            });
        } catch (e) {
            return resolve({ ok: false, code: null, output: "", timedOut: false,
                             error: `could not start ${command}: ${e.message}` });
        }

        const timer = setTimeout(() => {
            append(`\n[.lcl] stopped: exceeded ${Math.round(limit / 1000)}s\n`);
            try {
                if (process.platform === "win32" && child.pid) {
                    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
                } else child.kill("SIGKILL");
            } catch { /* already gone */ }
        }, limit);

        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("error", (e) => append(`\n[.lcl] ${e.message}\n`));
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve(credit({
                ok: code === 0,
                code,
                output: out,
                truncated,
                elapsedMs: Date.now() - started,
                timedOut: /exceeded \d+s/.test(out)
            }));
        });
    });
}

/** Write a file into a box, contained. */
function write(id, relPath, content) {
    const dir = boxDir(id);
    const full = path.resolve(dir, String(relPath || ""));
    if (full !== dir && !full.startsWith(dir + path.sep)) {
        throw new ToolError("path escapes the sandbox");
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(content ?? ""), "utf8");
    const rel = path.relative(dir, full).split(path.sep).join("/");
    noteOurs(dir, rel);          // ours, so what is NOT ours reads as the user's
    return { path: rel, bytes: Buffer.byteLength(String(content ?? "")) };
}

/** Run a script written in a supported language, inside the box. */
async function runScript(id, { language = "node", code, timeoutMs, onOutput } = {}) {
    const interp = INTERPRETERS[String(language).toLowerCase()];
    if (!interp) {
        throw new ToolError(`unsupported language "${language}" — use ${Object.keys(INTERPRETERS).join(", ")}`);
    }
    const name = `_lcl_run${interp.ext}`;
    write(id, name, code);
    return exec(id, { command: interp.command, args: interp.args(path.join(boxDir(id), name)),
                      timeoutMs, onOutput });
}

/* --------------------------------------------------------------- preflight */

/**
 * Run every check and report. ALL must pass — the point is a single honest
 * green/red, not a summary that buries one failure among four successes.
 */
async function preflight(id, checks = [], { onNote = () => {}, cancelToken = {} } = {}) {
    const results = [];
    for (const c of checks) {
        if (cancelToken.cancelled) break;
        const label = c.name || c.command;
        onNote(`checking: ${label}`);
        const r = c.code
            ? await runScript(id, { language: c.language, code: c.code, timeoutMs: c.timeoutMs })
            : await exec(id, { command: c.command, args: c.args || [], timeoutMs: c.timeoutMs });
        results.push({ name: label, ok: r.ok, code: r.code,
                       elapsedMs: r.elapsedMs, timedOut: r.timedOut,
                       output: String(r.output || "").slice(-4000) });
        onNote(`${r.ok ? "passed" : "FAILED"}: ${label}`);
    }
    const green = results.length > 0 && results.every(r => r.ok);
    return {
        green, checks: results,
        passed: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        cancelled: !!cancelToken.cancelled
    };
}

/**
 * Copy verified files out of the box into a real directory.
 *
 * Refuses unless preflight was GREEN. That is the contract the whole module
 * exists for: nothing reaches the user's files until the checks that were run
 * against it passed. The caller still owns the approval — this only enforces
 * that "proven" actually meant proven.
 */
function promote(id, destDir, { files = null, verified = false } = {}) {
    if (!verified) {
        throw new ToolError("refusing to promote: preflight has not passed");
    }
    const dir = boxDir(id);
    const destReal = fs.realpathSync(destDir);        // must already exist
    const copied = [];

    const walk = (rel) => {
        const full = path.join(dir, rel);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
            for (const e of fs.readdirSync(full)) walk(path.join(rel, e));
            return;
        }
        // NONE of the box's own bookkeeping goes into the user's folder. This
        // skipped only the runner, so a promote carried _lcl_env.txt - which
        // holds the machine's full PATH - into a real directory.
        if (path.basename(full).startsWith("_lcl_")) return;
        const target = path.resolve(destReal, rel);
        if (target !== destReal && !target.startsWith(destReal + path.sep)) return;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(full, target);
        copied.push(rel.split(path.sep).join("/"));
    };

    const list = files && files.length ? files : fs.readdirSync(dir);
    for (const f of list) {
        try { walk(f); } catch { /* skip what is not there */ }
    }
    return { copied, count: copied.length, dest: destReal };
}

/**
 * The agent-facing tool. One call: make a box, write the files, run the checks,
 * report. Promotion is NOT part of it — copying verified work into the user's
 * folder is a separate, human-approved step, because "the tests passed" and
 * "put this in my project" are different decisions.
 */
const TOOL_ENTRY = {
    run: async (_root, args = {}, ctx = {}) => {
        // files-as-JSON-string: measured — the model passed files:'{"probe.py": ...}'
        // (the object JSON-encoded) and the shape error taught it nothing. Parse it.
        if (typeof args.files === "string" && args.files.trim().startsWith("{")) {
            try { args = { ...args, files: JSON.parse(args.files) }; } catch { /* falls through */ }
        }
        if (typeof args.checks === "string" && args.checks.trim().startsWith("[")) {
            try { args = { ...args, checks: JSON.parse(args.checks) }; } catch { /* falls through */ }
        }
        let files = args.files && typeof args.files === "object" && !Array.isArray(args.files)
            ? args.files : null;
        // THE SHAPES MODELS ACTUALLY EMIT, coerced instead of refused. Measured:
        // NINE identical shape refusals in one session — the model kept passing
        // run_script's {code, language} shape and the error taught it nothing.
        // A tool that knows exactly what was meant does it.
        if (!files) {
            const code = typeof args.code === "string" ? args.code
                : typeof args.script === "string" ? args.script
                : typeof args.content === "string" ? args.content : null;
            if (code && code.trim()) {
                const lang = String(args.language || "").toLowerCase();
                const ext = /py/.test(lang) ? ".py"
                    : /(node|js)/.test(lang) ? ".js"
                    : /(powershell|ps1)/.test(lang) ? ".ps1"
                    : /(bash|sh)/.test(lang) ? ".sh" : ".js";
                files = { ["script" + ext]: code };
                if (!args.language && ext === ".js") { /* default stands */ }
                if (!Array.isArray(args.checks) || !args.checks.length) {
                    args = { ...args, language: lang || "node" };
                }
            }
        }
        // files given as {name: {content: "..."}} instead of {name: "..."}
        if (files) {
            for (const [k, v] of Object.entries(files)) {
                if (v && typeof v === "object" && typeof v.content === "string") files[k] = v.content;
            }
        }
        if (!files || !Object.keys(files).length) {
            throw new ToolError('sandbox_test needs {"files": {"name.js": "…"}, "checks": [...]} ' +
                '— or just {"code": "…", "language": "python|node"} and the file is made for you');
        }
        const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
        const box = create({ name: args.name || "check" });
        onNote(`sandbox ${box.id} (${isolation().kind})`);

        for (const [rel, content] of Object.entries(files)) write(box.id, rel, String(content));

        // with no checks given, at least prove the entry file runs — in the
        // entry file's OWN language (a node require() handed to python is a
        // guaranteed traceback, which is a failure this tool caused)
        const entry = Object.keys(files)[0];
        const entryLang = /.py$/i.test(entry) ? "python"
            : /.ps1$/i.test(entry) ? "powershell"
            : /.sh$/i.test(entry) ? "bash" : "node";
        const runsCode = entryLang === "python"
            ? `exec(open(${JSON.stringify(entry)}).read())`
            : entryLang === "powershell" ? `& .\${entry}`
            : entryLang === "bash" ? `bash ${entry}`
            : `require("./${entry}")`;
        const checks = Array.isArray(args.checks) && args.checks.length
            ? args.checks
            : [{ name: "runs", command: null, language: entryLang, code: runsCode }];

        const result = await preflight(box.id, checks,
            { onNote, cancelToken: ctx.cancelToken || {} });
        return {
            sandbox: box.id,
            isolation: isolation().kind,
            green: result.green,
            passed: result.passed,
            failed: result.failed,
            checks: result.checks.map(c => ({ name: c.name, ok: c.ok,
                output: String(c.output || "").slice(-800) })),
            note: result.green
                ? `All checks passed. The files are in sandbox "${box.id}" and can be copied out.`
                : "Checks failed — fix the code and run it again before writing anything real."
        };
    },
    help: 'sandbox_test {"files": {"solve.js": "…code…"}, "checks": [{"name": "works", ' +
        '"language": "node", "code": "…assertions…"}]} — write code to a disposable ' +
        'folder and RUN it there; nothing touches real files until the checks pass'
};

module.exports = {
    isolation, verify, create, destroy, list, boxDir, write, exec, runScript,
    preflight, promote, scrubbedEnv, sandboxRoot,
    forSession, releaseSession, sessionBoxes, inventory, labelLow,
    TOOL_ENTRY, INTERPRETERS, MAX_OUTPUT, LOWBOX_PS1
};
