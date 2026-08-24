"use strict";
/**
 * THE PATCH BAY — the app's own code, modifiable with the app's own tools.
 *
 * "let the models in .lcl — regardless of where they live, local, API or Spark
 *  — review the .lcl logic and patch it. So the user can modify their software
 *  with the tools the software was designed to use."
 *
 * And the scope, stated by the operator and honoured here:
 *
 * "I do not especially want the app rewriting itself unattended. I want a user
 *  to be able to modify their own copy, safely, without having to tunnel around
 *  a restriction to do something minor."
 *
 * Every guardrail below came out of an adversarial pass and survived a reviewer
 * whose only job was to break it. They are not defence in depth for its own
 * sake; each one closes a specific way the previous design was defeated.
 *
 * 1. A COPY, NOT THE ORIGINAL. A patch session's workspace is a `git worktree`
 *    under the app's user-data directory, never inside the repo. Every rail the
 *    app already has then applies with no new code: path containment, the
 *    policy kernel's scope check, change chips, per-file snapshots.
 *
 * 2. THE COPY LEAVES THE PRIVATE THINGS BEHIND. A worktree materialises only
 *    TRACKED files. Sessions, keys, downloaded models and the knowledge index
 *    are git-ignored, so they are structurally absent — not hidden, absent.
 *
 * 3. SCOPE IS AN ALLOWLIST, WRITTEN DOWN BEFORE THE MODEL RUNS. A denylist was
 *    defeated in review by a six-line edit to agent.js around the code that
 *    acts on the policy verdict: the rulebook was protected, the line that
 *    obeys it was not. An allowlist has no such hole — anything unlisted is
 *    simply not in scope.
 *
 * 4. A WELDED SET NO SCOPE CAN INCLUDE. The kernel, the loop that obeys it,
 *    the guards, and the tests. Listed once, below, and intersected out of
 *    every scope no matter how it was requested.
 *
 * 5. REVIEW EXECUTES NOTHING. "Prove it works by running the tests" died in
 *    review: a model-authored test is code with the same reach as the patch it
 *    accompanies, and tests/ipc-approval.js loads app/main.js.
 *
 * 6. NO APPLY. The operator reads the diff and lands it themselves with one
 *    `git merge --ff-only`. That deletes the bricked-app problem rather than
 *    mitigating it. Review commits first, so what lands is exactly what was
 *    read.
 *
 * 7. SIZE CAPS, A SECRET SCAN OVER ADDED LINES, and refusal of any added line
 *    under app/renderer/** that reaches for a privileged bridge call.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths");
// the SHAPE detector lives here, not on secretGuard — reaching for the
// wrong module made this scan silently do nothing, caught by its own test
const securityTools = require("./securityTools");
const { ToolError } = require("./fsTools");

/**
 * WELDED. No scope may include these, however the scope was written.
 *
 * The first four are the kernel and the code that obeys it — protecting the
 * rulebook while leaving the line that reads it editable is precisely the hole
 * the review found. The guards are here because a patch that edits the secret
 * scanner defeats the secret scan on the same turn. `tests/**` is welded whole
 * because a model-authored test is executable code with the reach of anything
 * else in this repo, and because a suite that can be edited stops being
 * evidence.
 */
const WELDED = [
    ".lcl.engine/policy/",
    ".lcl.engine/core/agent.js",
    ".lcl.engine/core/policyBridge.js",
    ".lcl.engine/core/fsTools.js",
    ".lcl.engine/core/secretGuard.js",
    // THE DETECTOR THE SCAN ACTUALLY CALLS. secretGuard.js was welded and
    // securityTools.js was not, yet review()'s secret scan calls
    // securityTools.looksLikeSecret. Measured before this line existed:
    // isWelded(".lcl.engine/core/securityTools.js") false, and a patch
    // replacing the whole module with
    // `module.exports = { looksLikeSecret: () => ({ found: false }) }`
    // reviewed ok:true committed:true. Welding the wrong file is the same as
    // welding nothing.
    ".lcl.engine/core/securityTools.js",
    ".lcl.engine/core/scriptRunner.js",
    ".lcl.engine/core/sandbox.js",
    ".lcl.engine/core/backups.js",
    ".lcl.engine/core/paths.js",
    ".lcl.engine/core/patchBay.js",     // itself: a scope that could edit this is no scope
    "app/main.js",
    "app/preload.js",
    "tests/",
    /* THE RULEBOOK PROTECTED, THE LINE THAT OBEYS IT NOT.
     *
     * This module argues at the top that an allowlist cannot have that hole.
     * It had it, four ways over, and a review the operator commissioned found
     * them. The worst was not subtle: app/main.js is welded, and the file that
     * NAMES app/main.js as the main process was not. Repoint "main" and the
     * welded file is simply never loaded — every guard in it bypassed without
     * one welded byte being touched.
     *
     * The rest are single points of failure for a whole guarantee: sessionPerms
     * is the one gate for write mode, unattended execution, secrets and
     * isolation; engagements is the authorization gate for the offensive tools;
     * release.js is the runner that decides whether the welded tests/ ever get
     * to fail anything. None of the four has a legitimate reason to appear in
     * a self-patch. */
    "app/package.json",
    "package.json",
    ".lcl.engine/core/sessionPerms.js",
    ".lcl.engine/core/engagements.js",
    // THE ENFORCEMENT, not just the store. engagements.js holds the engagement
    // records; offensiveTools.js is where requireEngagement() re-matches each
    // call's target against the authorized host before any offensive tool runs.
    // Welding the store while leaving the enforcement editable is the
    // securityTools.js hole one layer down — a patch could drop the host
    // re-match (or requireEngagement itself) and the review would not flag it.
    ".lcl.engine/core/offensiveTools.js",
    "devtools/release.js"
];

const MAX_FILES = 40;
const MAX_ADDED_LINES = 1500;
const MAX_DIFF_BYTES = 400_000;

/** Privileged bridge reaches. An added renderer line doing this is refused. */
/* `window.lcl` in DOT notation only was the whole check, so `window["lcl"]`
 * walked straight through — and so did `window['lcl']` and a space before the
 * bracket. Both notations reach the same bridge. */
const BRIDGE_REACH =
    /\bwindow\s*\.\s*lcl\b|\bwindow\s*\[\s*["']lcl["']\s*\]|\bipcRenderer\b|\bcontextBridge\b|\brequire\s*\(/;

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * MATCHED THE WAY THE FILESYSTEM MATCHES. This runs on a case-insensitive
 * volume — measured, core.ignorecase true — so a case-sensitive weld check was
 * a weld in name only. Measured before this fold: isWelded("Tests/thing.js"),
 * ("App/main.js"), ("app/Main.js"), (".LCL.engine/policy/classify.js") and
 * (".lcl.engine/Core/agent.js") all false, and open(["Tests/"]) returned
 * ok:true where open(["tests/"]) correctly returned ok:false — a session that
 * reported success and could then never commit anything.
 *
 * The fold lives INSIDE the matchers. norm() and every string handed back are
 * untouched, so a scope still displays in the case the operator typed it.
 */
const fold = (p) => norm(p).toLowerCase();

function isWelded(rel) {
    const r = fold(rel);
    return WELDED.some(w => {
        const lw = w.toLowerCase();
        return lw.endsWith("/") ? r.startsWith(lw) : r === lw;
    });
}

function git(repo, args, opts = {}) {
    const r = spawnSync("git", args, {
        cwd: repo, encoding: "utf8", windowsHide: true,
        maxBuffer: 32 * 1024 * 1024, ...opts
    });
    return { ok: r.status === 0, out: String(r.stdout || ""), err: String(r.stderr || ""),
             code: r.status };
}

/** Is this machine able to run a patch session at all? */
function available(repo) {
    const root = repo || paths.resourceRoot();
    const g = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
    if (g.status !== 0) {
        return { ok: false, reason: "git is not installed on this machine" };
    }
    const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || !/true/.test(inside.out)) {
        return { ok: false, reason: "this copy of the app has no source repository — " +
                 "an installed build ships compiled, without git or sources" };
    }
    return { ok: true, repo: root };
}

/**
 * Resolve a requested scope into the allowlist that will actually apply.
 *
 * Written down BEFORE the model runs, returned so it can be shown, and with
 * the welded set removed no matter how the request was phrased.
 */
function resolveScope(requested) {
    const asked = (Array.isArray(requested) ? requested : [requested])
        .filter(Boolean).map(norm);
    const allowed = [], refused = [];
    for (const a of asked) {
        // a scope entry may not climb out of the repo, and may not be the repo
        if (a.includes("..") || a === "" || a === "/" || a === ".") {
            refused.push({ entry: a, why: "not a path inside the repository" });
            continue;
        }
        if (isWelded(a)) {
            refused.push({ entry: a, why: "welded — the kernel, the loop that obeys it, " +
                                          "the guards, and the tests are never in scope" });
            continue;
        }
        allowed.push(a);
    }
    return { allowed, refused, welded: WELDED.slice() };
}

/** Does a changed path fall inside the resolved allowlist? */
function inScope(rel, allowed) {
    const r = fold(rel);                          // case-folded for the same reason
    if (isWelded(r)) return false;
    return (allowed || []).some(entry => {
        const a = fold(entry);
        return a.endsWith("/") ? r.startsWith(a) : (r === a || r.startsWith(a + "/"));
    });
}

/** Is `child` at or beneath `parent`? Case-folded, because the volume is. */
function isInside(child, parent) {
    const c = path.resolve(child).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const p = path.resolve(parent).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    return c === p || c.startsWith(p + "/");
}

/**
 * Open a patch session: a worktree of the repo on a fresh branch, placed under
 * the app's user-data directory and never inside the repo itself.
 */
function open(sessionId, requestedScope, { repo = null } = {}) {
    const av = available(repo);
    if (!av.ok) return { ok: false, error: av.reason };
    const root = av.repo;

    const scope = resolveScope(requestedScope);
    if (!scope.allowed.length) {
        return { ok: false, error: "nothing is in scope once the welded set is removed",
                 scope };
    }

    const id = `patch-${String(sessionId || "s").replace(/[^\w-]/g, "")}-${Date.now().toString(36)}`;
    // paths.patchBayRoot(), NOT paths.dataDir(). Unpackaged, dataDir() is the
    // checkout's own data/ folder, so every worktree landed INSIDE the repo the
    // session was meant to be a copy of.
    const dir = path.join(paths.patchBayRoot(), id);

    // AND THE GUARANTEE IS ENFORCED, NOT MERELY DOCUMENTED. "never inside the
    // repo" was a sentence in a comment and in the operator's window; nothing
    // checked it, and for the whole life of the feature it was false. If the
    // resolved location is under the repository for any reason — a relocated
    // user-data dir, a checkout that contains it — refuse rather than nest.
    if (isInside(dir, root)) {
        return { ok: false, error: "the working copy would land inside the repository " +
                 `itself (${dir}), and a patch session is a copy that lives outside it — ` +
                 "refusing rather than nesting", scope };
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });

    const head = git(root, ["rev-parse", "HEAD"]);
    if (!head.ok) return { ok: false, error: "could not read the repository head" };
    const base = head.out.trim();

    // A WORKTREE MATERIALISES ONLY TRACKED FILES. Sessions, keys, models and
    // the knowledge index are git-ignored, so they never exist in this copy.
    const add = git(root, ["worktree", "add", "-b", id, dir, base]);
    if (!add.ok) return { ok: false, error: "could not create the working copy: " + add.err.trim() };

    const rec = { id, dir, branch: id, base, repo: root, scope, openedAt: Date.now() };
    try {
        fs.writeFileSync(path.join(path.dirname(dir), id + ".json"),
                         JSON.stringify(rec, null, 2));
    } catch { /* the worktree is the record; this is a convenience */ }
    return { ok: true, ...rec };
}

/**
 * Read what changed, judge it, and — if it passes — COMMIT it so what the
 * operator reads is exactly what they can land.
 *
 * Nothing here executes anything from the working copy.
 */
function review(session) {
    const { dir, repo, base, scope } = session || {};
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: "no such patch session" };

    // A SESSION WITHOUT A SCOPE IS NOT JUDGEABLE. Reading scope.allowed off an
    // absent scope threw a TypeError out of review() — measured:
    // "TypeError: Cannot read properties of undefined (reading 'allowed')" —
    // so the caller got an exception instead of a refusal, with the changes
    // left staged.
    const allowed = scope && Array.isArray(scope.allowed) ? scope.allowed : null;
    if (!allowed) {
        return { ok: false, committed: false, files: [], problems: [], addedTotal: 0,
                 error: "this patch session has no recorded scope, so nothing can be " +
                        "judged against it — open the session again" };
    }

    git(dir, ["add", "-A"]);
    // --no-renames: numstat's rename detection emits ONE field, "src => dst",
    // and every judgement below then ran against that concatenation — which
    // starts with the SOURCE path, in scope by construction, while the
    // DESTINATION was never examined. Measured before this flag:
    // "0\t0\tapp/renderer/app.js => .lcl.engine/policy/pwn.js" reviewed
    // ok:true committed:true and landed R100 into the policy kernel.
    const stat = git(dir, ["diff", "--cached", "--numstat", "--no-renames", "--text"]);
    if (!stat.ok) return { ok: false, error: "could not read the changes" };

    const files = [];
    let numstatAdded = 0;
    for (const line of stat.out.split(/\r?\n/).filter(Boolean)) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (!m) continue;
        const added = m[1] === "-" ? 0 : Number(m[1]);
        const removed = m[2] === "-" ? 0 : Number(m[2]);
        const file = norm(m[3]);
        numstatAdded += added;
        files.push({ file, added, removed, binary: m[1] === "-" });
    }

    // NOTHING CHANGED IS NOT A PASS. This used to fall through the whole
    // judgement, commit nothing, and hand back the SESSION'S BASE as `sha` with
    // neither an error nor a problems array — measured
    // {"ok":false,"committed":false,"files":[],"sha":"bf8bb5c5…"}, so a caller
    // reading rv.problems.some(…) threw and a window printing rv.sha showed a
    // commit id for a patch that does not exist.
    if (!files.length) {
        return { ok: false, committed: false, files: [], problems: [], addedTotal: 0,
                 base, branch: session.branch, diff: "",
                 error: "nothing in this working copy has changed yet, so there is no " +
                        "patch to review" };
    }

    const problems = [];
    // ---- scope, welded set, and size
    for (const f of files) {
        if (isWelded(f.file)) {
            problems.push({ file: f.file, why: "welded: this file can never be patched here" });
        } else if (!inScope(f.file, allowed)) {
            problems.push({ file: f.file, why: "outside the scope agreed before the run" });
        }
        // A .gitattributes RECONFIGURES THE VERY DIFF EVERY JUDGEMENT BELOW
        // READS. Marking files -diff makes numstat emit "-\t-" and turns the
        // textual diff into "Binary files … differ" with no + lines at all, so
        // the secret scan and the renderer-bridge refusal have nothing to
        // iterate over. Measured before this refusal: an in-scope
        // app/renderer/.gitattributes containing "* -diff" plus an app.js
        // carrying a literal sk-ant-api03-… key, a window.lcl call and a bare
        // require( reviewed ok:true committed:true addedTotal:0
        // with no problems, and the diff handed back was, in full,
        // "Binary files a/app/renderer/app.js and b/app/renderer/app.js differ".
        // It is in scope by the letter and it blinds the guards, so it is
        // refused by name.
        if (path.posix.basename(fold(f.file)) === ".gitattributes") {
            problems.push({ file: f.file, why: "a .gitattributes reconfigures how git " +
                "renders the very diff this review is judged from, so it can never be " +
                "part of a patch reviewed here — land it by hand if you mean it" });
        }
    }
    if (files.length > MAX_FILES) {
        problems.push({ why: `${files.length} files changed; the cap is ${MAX_FILES}` });
    }

    // --text for the same reason: it restores a real textual diff even when an
    // attributes file already in the repo says otherwise. It does NOT restore
    // numstat (measured: still "-\t-" under --text), which is why the added
    // count below is taken from the parsed diff rather than from numstat.
    const diff = git(dir, ["diff", "--cached", "--unified=3", "--no-renames", "--text"]);
    const diffText = diff.out || "";
    if (diffText.length > MAX_DIFF_BYTES) {
        problems.push({ why: `the diff is ${diffText.length} bytes; the cap is ${MAX_DIFF_BYTES}` });
    }

    // ---- ADDED LINES ONLY. What was already in the repo is not this patch's
    // doing, and flagging it would bury the thing that is.
    const addedLines = [];
    const removedLines = [];
    const binaryInDiff = new Set();
    let currentFile = null;
    for (const line of diffText.split(/\r?\n/)) {
        const hm = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        if (hm) { currentFile = norm(hm[2]); continue; }
        if (line === "+++ /dev/null") { currentFile = null; continue; }
        const fm = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fm) { currentFile = norm(fm[1]); continue; }
        // the belt-and-braces case: --text did not take, so git still refuses
        // to render this file. No + lines means nothing for the scans to read.
        if (/^Binary files .* differ$/.test(line) && currentFile) {
            binaryInDiff.add(currentFile);
            continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
            addedLines.push({ file: currentFile, text: line.slice(1) });
        }
        // ...AND WHAT WAS TAKEN OUT. The scans read added lines only, on the
        // reasoning that what was already in the repo is not this patch's
        // doing. True of most lines and false of exactly the dangerous ones: a
        // patch whose entire content is the DELETION of a guard call adds
        // nothing, so it was never examined at all. Removals are not refused
        // here — refactors move guards legitimately — they are SURFACED, which
        // is what a review is for.
        if (line.startsWith("-") && !line.startsWith("---")) {
            removedLines.push({ file: currentFile, text: line.slice(1) });
        }
    }

    // COUNTED FROM THE DIFF, NOT FROM NUMSTAT. numstat reports "-" for anything
    // git calls binary — including everything an in-scope attributes file marks
    // -diff — so addedTotal was 0 and MAX_ADDED_LINES was inert for exactly the
    // patches that most needed capping. numstatAdded is kept as a readout so
    // the two can be compared.
    const addedTotal = addedLines.length;
    if (addedTotal > MAX_ADDED_LINES) {
        problems.push({ why: `${addedTotal} lines added; the cap is ${MAX_ADDED_LINES}` });
    }

    // ---- CONTENT NEITHER SCAN NOR THE OPERATOR CAN READ IS REFUSED.
    // Measured before this: a 3 MB app/renderer/blob.bin with
    // sk-ant-api03-CCCC… embedded at offset 10 reviewed ok:true, added 0,
    // problems undefined. MAX_ADDED_LINES saw 0 because numstat said "-", and
    // MAX_DIFF_BYTES saw one "Binary files … differ" line whatever the file
    // weighed. Both promised guards were inert for the one file type the
    // operator cannot check by eye either.
    const NUL = String.fromCharCode(0);   // a literal NUL, kept OUT of this source
    const unreadable = new Set(binaryInDiff);
    for (const { file, text } of addedLines) {
        if (file && text.includes(NUL)) unreadable.add(file);
    }
    for (const f of files) {
        if (unreadable.has(f.file)) {
            problems.push({ file: f.file, why: "binary content — the secret scan cannot " +
                "read it, the size caps cannot measure it and you cannot review it by " +
                "eye, so it is refused rather than waved through" });
        }
    }

    /* THE GUARD CALLS THIS PATCH TAKES AWAY.
     *
     * Named for what they are, not matched loosely: each of these is the point
     * where a specific promise in this app is actually kept. A patch that
     * removes one and does not put it back is either a refactor the operator
     * should see, or the thing the whole patch was for. Both deserve the same
     * line in the review. */
    const GUARD_CALLS = [
        "assertWritable", "resolveForWrite", "resolveInRoot",
        "looksLikeSecret", "redact", "rememberFile",
        "isWelded", "requireNetwork", "hostIsPinned",
        "policy.check", "sessionPerms.forSession", "auditLog.write",
        "holdLocalResidency", "StrictHostKeyChecking", "BatchMode"
    ];
    {
        const addedText = addedLines.map(l => l.text).join("\n");
        const removedByFile = new Map();
        for (const { file, text } of removedLines) {
            for (const g of GUARD_CALLS) {
                if (!text.includes(g)) continue;
                // put back somewhere in the same patch: a move, not a removal
                if (addedText.includes(g)) continue;
                const key = (file || "?") + "\u0000" + g;
                if (removedByFile.has(key)) continue;
                removedByFile.set(key, true);
                problems.push({ file: file || undefined,
                    why: `this patch REMOVES a call to \`${g}\` and does not add ` +
                         `one back anywhere in the diff — read that hunk before ` +
                         `you take it` });
            }
        }
    }

    let detectorThrew = false;
    for (const { file, text } of addedLines) {
        // a credential written INTO the source is a leak that outlives the turn
        let looksSecret = null;
        try { looksSecret = securityTools.looksLikeSecret(text); }
        catch {
            // FAIL CLOSED. This used to set looksSecret = null, so any throw
            // out of the detector made the secret scan pass SILENTLY — a guard
            // reporting all-clear precisely when it had not run. Recorded once:
            // a detector that throws throws on every line, and 1500 identical
            // entries would bury every other problem.
            if (!detectorThrew) {
                detectorThrew = true;
                problems.push({ file, why: "the secret detector threw; refusing rather " +
                                           "than passing unscanned" });
            }
            looksSecret = null;
        }
        if (looksSecret && looksSecret.found) {
            // looksLikeSecret returns `kinds`, an ARRAY. Reading .kind meant the
            // fallback won on every single hit and the operator was told
            // something matched but never WHICH pattern — an AWS key id and a
            // high-entropy value assigned to authToken read identically.
            const kinds = Array.isArray(looksSecret.kinds)
                ? looksSecret.kinds.filter(Boolean) : [];
            const what = kinds.length ? kinds.join(", ")
                       : (looksSecret.kind || looksSecret.label || "secret");
            problems.push({ file, why: `an added line looks like a credential (${what})` });
        }
        // THE RENDERER IS NOT PRIVILEGED, AND MUST NOT BECOME SO. An added
        // renderer line reaching for the bridge is how a patch grows itself a
        // capability the policy kernel never granted.
        if (file && fold(file).startsWith("app/renderer/") && BRIDGE_REACH.test(text)) {
            problems.push({ file, why: "an added renderer line reaches for a privileged " +
                                       "bridge call (window.lcl / ipcRenderer / require)" });
        }
    }

    if (problems.length) {
        git(dir, ["reset"]);                     // leave the working copy as it was
        return { ok: false, files, addedTotal, numstatAdded, problems, committed: false,
                 diff: diffText.slice(0, MAX_DIFF_BYTES) };
    }

    // COMMIT FIRST, so what the operator reads is exactly what they land.
    const msg = `patch-bay: ${files.length} file${files.length === 1 ? "" : "s"}, ` +
                `+${addedTotal}`;
    const c = git(dir, ["-c", "user.name=.lcl patch bay",
                        "-c", "user.email=patch-bay@localhost",
                        "commit", "-m", msg]);
    const sha = git(dir, ["rev-parse", "HEAD"]).out.trim();

    return {
        ok: c.ok, committed: c.ok, files, addedTotal, numstatAdded,
        branch: session.branch, sha, base,
        diff: diffText.slice(0, MAX_DIFF_BYTES),
        // NOT AN APPLY. The operator's own hands, one command, fast-forward
        // only — so a patch can never rewrite history or land something other
        // than what was reviewed.
        howToLand: `git -C "${repo}" merge --ff-only ${session.branch}`,
        note: "Nothing has been applied. The line above is yours to run, or not."
    };
}

/** Discard a patch session and its working copy. Never touches the repo. */
function discard(session) {
    if (!session || !session.dir) return { ok: false, error: "no such patch session" };
    const r = git(session.repo, ["worktree", "remove", "--force", session.dir]);
    if (!r.ok) { try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch {} }
    git(session.repo, ["branch", "-D", session.branch]);
    try { fs.rmSync(path.join(path.dirname(session.dir), session.id + ".json"), { force: true }); }
    catch { /* gone */ }
    return { ok: true };
}

module.exports = {
    available, open, review, discard, resolveScope, inScope, isWelded,
    WELDED, MAX_FILES, MAX_ADDED_LINES, MAX_DIFF_BYTES
};
