/**
 * THE PATCH BAY — driven against a THROWAWAY GIT REPOSITORY in a temp folder,
 * never against C:\.lcl itself.
 *
 * Every guardrail here came out of an adversarial pass. This suite tries to
 * defeat each one the way that reviewer did, rather than asserting the code
 * contains the right words.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/* ---------------------------------------------------------------------
 * TWO SEPARATE TEMP DIRECTORIES, ON PURPOSE.
 *
 * USER_DATA stands in for Electron's userData — what paths.patchBayRoot()
 * reads. STORE is the app's data store, pointed here through LCL_DATA_DIR —
 * what paths.dataDir() reads.
 *
 * They are DIFFERENT folders because the assertion below has to be able to
 * tell them apart. When the worktree came off dataDir() this suite drove the
 * module with a tmpdir repo and then compared the data dir against that
 * unrelated folder, so "never inside the repository" was structurally
 * incapable of failing while the real configuration put every worktree at
 * C:\.lcl\data\patch-bay — inside the repo.
 *
 * LCL_DATA_DIR is also why this suite no longer writes into the operator's
 * live store. Before it was set, running these checks left a patch-bay/ folder
 * in C:\.lcl\data. It is set BEFORE any core module is required, because
 * paths.js reads it on the way through.
 * ------------------------------------------------------------------- */
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
    if (r === "electron") return __filename;
    return orig.call(this, r, ...a);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-pb-data-"));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-pb-store-"));
process.env.LCL_DATA_DIR = STORE;
let USER_DATA = DATA;                     // one test re-points this deliberately
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => USER_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

const ROOT = path.join(__dirname, "..");
const pb = require(path.join(ROOT, ".lcl.engine", "core", "patchBay.js"));
const paths = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

/** Same containment question the module asks, asked independently here. */
function inside(child, parent) {
    const c = path.resolve(child).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const p = path.resolve(parent).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    return c === p || c.startsWith(p + "/");
}

/* ---- a throwaway repository that LOOKS like this one ---------------- */
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-pb-repo-"));
function seed() {
    git(REPO, ["init", "-q", "-b", "main"]);
    git(REPO, ["config", "user.email", "t@localhost"]);
    git(REPO, ["config", "user.name", "t"]);
    const w = (rel, body) => {
        const f = path.join(REPO, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, body);
    };
    w("app/renderer/app.js", "// renderer\nfunction paint() {}\n");
    w("app/renderer/styles.css", ".a { color: red; }\n");
    w("app/main.js", "// main process\n");
    w(".lcl.engine/core/agent.js", "// the loop\n");
    w(".lcl.engine/core/knowledge.js", "// knowledge\n");
    w(".lcl.engine/core/securityTools.js", "// the detector the scan calls\n");
    w(".lcl.engine/policy/classify.js", "// the rulebook\n");
    w("tests/thing.js", "// a suite\n");
    // the private things, git-ignored exactly as in the real repo
    w(".gitignore", "data/\nmodels/\n");
    w("data/sessions.json", '{"secret":"this must never be materialised"}');
    w("models/big.gguf", "PRETEND WEIGHTS");
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "seed"]);
}
seed();

const gitOk = git(REPO, ["rev-parse", "HEAD"]).status === 0;
check("(setup) a throwaway repository exists to drive this against", gitOk);
if (!gitOk) { console.log("\n0/1 patch-bay checks passed (git unavailable)"); process.exit(1); }

check("(setup) THIS SUITE DOES NOT WRITE INTO THE OPERATOR'S LIVE STORE. Both " +
      "the data dir and the patch-bay root resolve outside the checkout, or " +
      "these checks are quietly editing the app they are testing",
    !inside(paths.dataDir(), paths.resourceRoot()) &&
    !inside(paths.patchBayRoot(), paths.resourceRoot()) &&
    inside(paths.dataDir(), STORE) && inside(paths.patchBayRoot(), DATA),
    { dataDir: paths.dataDir(), patchBayRoot: paths.patchBayRoot(),
      resourceRoot: paths.resourceRoot() });

/* =====================================================================
 * 1. THE WELDED SET — no scope can include it, however it is written
 * =================================================================== */

for (const w of [".lcl.engine/policy/classify.js", ".lcl.engine/core/agent.js",
                 "app/main.js", "app/preload.js", "tests/thing.js",
                 ".lcl.engine/core/patchBay.js"]) {
    check(`welded: ${w} can never be in scope`, pb.isWelded(w), w);
}

/* THE DETECTOR THE SCAN ACTUALLY CALLS. secretGuard.js was on the list and
 * securityTools.js was not, while review()'s secret scan calls
 * securityTools.looksLikeSecret — so the guard the operator was promised was
 * welded to the wrong file. */
check("welded: .lcl.engine/core/securityTools.js — the module review() actually " +
      "calls for the secret scan, not merely the one named secretGuard",
    pb.isWelded(".lcl.engine/core/securityTools.js"));

/* MATCHED THE WAY THE FILESYSTEM MATCHES. core.ignorecase is true here, so a
 * case-sensitive weld was a weld in name only: every one of these read false,
 * and open(["Tests/"]) returned ok:true where open(["tests/"]) returned
 * ok:false — a session that reported success and could never commit. */
for (const w of ["Tests/thing.js", "App/main.js", "app/Main.js",
                 ".LCL.engine/policy/classify.js", ".lcl.engine/Core/agent.js",
                 ".lcl.engine/Core/securityTools.js"]) {
    check(`welded in ANY CASE, because the filesystem is: ${w}`, pb.isWelded(w), w);
}

check("...and asking for it by name is REFUSED with a reason, not ignored",
    (() => {
        const s = pb.resolveScope([".lcl.engine/policy/", "app/renderer/"]);
        return s.allowed.length === 1 && s.refused.length === 1 &&
               /welded/.test(s.refused[0].why);
    })());
check("...and asking for it in a DIFFERENT CASE is refused just the same, rather " +
      "than opening a session that can never commit anything",
    (() => {
        const s = pb.resolveScope(["Tests/", "App/main.js", ".lcl.engine/Core/agent.js"]);
        const up = pb.open("s1case", ["Tests/"], { repo: REPO });
        if (up.ok) pb.discard(up);
        return s.allowed.length === 0 && s.refused.length === 3 &&
               s.refused.every(r => /welded/.test(r.why)) && up.ok === false;
    })());
check("...and a scope that climbs out of the repository is refused",
    pb.resolveScope(["../../windows"]).allowed.length === 0);
check("...and a scope of nothing but welded paths opens no session at all",
    (() => {
        const r = pb.open("s1", ["tests/"], { repo: REPO });
        return r.ok === false && /welded/.test(JSON.stringify(r.scope));
    })());
check("THE PATCH BAY WELDS ITSELF. A scope that could edit this module is no " +
      "scope at all",
    pb.isWelded(".lcl.engine/core/patchBay.js"));

/* =====================================================================
 * 2. A COPY, AND THE PRIVATE THINGS ARE STRUCTURALLY ABSENT
 * =================================================================== */

const sess = pb.open("s2", ["app/renderer/"], { repo: REPO });
check("a patch session opens as a git worktree on its own branch",
    sess.ok && fs.existsSync(sess.dir) && sess.branch && sess.base, sess.error);

/* THE ASSERTION POINTED AT THE REAL CONFIGURATION.
 *
 * The old form compared sess.dir against the injected tmpdir REPO, which the
 * data dir could never be inside, so it passed while the shipped arrangement
 * put every worktree at <checkout>/data/patch-bay. These three clauses are the
 * guarantee as stated: under the patch-bay root, outside this checkout, and
 * outside the repository being patched. */
check("...placed under the app's patch-bay root and NEVER inside a repository — " +
      "not the one being patched, and not this checkout either",
    sess.ok && inside(sess.dir, paths.patchBayRoot()) &&
    !inside(sess.dir, paths.resourceRoot()) &&
    !inside(sess.dir, REPO),
    sess.ok ? { dir: sess.dir, patchBayRoot: paths.patchBayRoot(),
                resourceRoot: paths.resourceRoot() } : null);

/* AND THE GUARANTEE IS ENFORCED, NOT MERELY DOCUMENTED. Point the user-data
 * dir at a folder that IS a repository and open() must refuse rather than
 * nest — the case that was live in production for the whole life of this
 * feature. */
check("...and if the working copy WOULD land inside the repository, open() " +
      "refuses instead of nesting — the promise is checked, not just printed",
    (() => {
        const NEST = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-pb-nest-"));
        git(NEST, ["init", "-q", "-b", "main"]);
        const before = USER_DATA;
        USER_DATA = NEST;                        // patchBayRoot() -> NEST/patch-bay
        const r = pb.open("nested", ["app/renderer/"], { repo: NEST });
        USER_DATA = before;
        try { fs.rmSync(NEST, { recursive: true, force: true, maxRetries: 6 }); } catch {}
        return r.ok === false && /inside the repository/.test(r.error || "");
    })());

check("THE PRIVATE THINGS ARE NOT HIDDEN, THEY ARE ABSENT. A worktree " +
      "materialises only tracked files, so ignored sessions, keys and models " +
      "do not exist in the copy at all",
    sess.ok && !fs.existsSync(path.join(sess.dir, "data")) &&
               !fs.existsSync(path.join(sess.dir, "models")));
check("...while the tracked source IS there, or there is nothing to patch",
    sess.ok && fs.existsSync(path.join(sess.dir, "app", "renderer", "app.js")));

/* =====================================================================
 * 3. REVIEW JUDGES, AND ONLY COMMITS WHAT PASSES
 * =================================================================== */

const edit = (rel, body) => {
    const f = path.join(sess.dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
};
const restore = (rel, body) => fs.writeFileSync(path.join(sess.dir, rel), body);

/* an in-scope, clean change */
edit("app/renderer/styles.css", ".a { color: blue; }\n.b { margin: 0; }\n");
let rv = pb.review(sess);
check("an in-scope change passes review and is COMMITTED, so what is read is " +
      "exactly what can be landed",
    rv.ok && rv.committed && rv.sha && rv.files.some(f => f.file === "app/renderer/styles.css"),
    rv.problems || rv.error);
check("...and review hands back the diff itself, not a summary of it",
    rv.ok && /color: blue/.test(rv.diff || ""));
check("NOTHING IS APPLIED. The operator lands it themselves, fast-forward only",
    rv.ok && /merge --ff-only/.test(rv.howToLand || "") &&
    /Nothing has been applied/.test(rv.note || ""));

/* out of scope */
edit(".lcl.engine/core/knowledge.js", "// touched\n");
rv = pb.review(sess);
check("a change OUTSIDE the agreed scope fails review and is not committed",
    !rv.ok && !rv.committed &&
    rv.problems.some(p => /outside the scope/.test(p.why)), rv.problems);
restore(".lcl.engine/core/knowledge.js", "// knowledge\n");

/* the review's own bypass: edit the welded loop */
edit(".lcl.engine/core/agent.js", "// the loop, rewritten\n");
rv = pb.review(sess);
check("THE ATTACK THAT DEFEATED THE FIRST DESIGN: editing the loop that OBEYS " +
      "the policy, rather than the policy itself, is refused",
    !rv.ok && rv.problems.some(p => /welded/.test(p.why)), rv.problems);
restore(".lcl.engine/core/agent.js", "// the loop\n");

/* a credential written into the source */
edit("app/renderer/app.js",
     '// renderer\nconst k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\n');
rv = pb.review(sess);
/* AND THE FINDING NAMES WHICH PATTERN MATCHED. looksLikeSecret returns `kinds`,
 * an array; the finding read `.kind`, so the fallback won on every hit and the
 * operator was told something matched but never whether it was an AWS key id
 * or a high-entropy value assigned to authToken. The assertion is pinned to
 * the pattern name so that regression cannot pass as "credential". */
check("a credential written INTO the source is caught on the ADDED lines, and the " +
      "finding NAMES the pattern that matched",
    !rv.ok && rv.problems.some(p =>
        /an added line looks like a credential \(OpenAI \/ Anthropic key\)/.test(p.why)),
    rv.problems);
restore("app/renderer/app.js", "// renderer\nfunction paint() {}\n");

/* the renderer growing itself a capability */
edit("app/renderer/app.js", "// renderer\nwindow.lcl.chooseModel();\n");
rv = pb.review(sess);
check("an added RENDERER line reaching for a privileged bridge call is refused " +
      "— that is how a patch grows a capability the kernel never granted",
    !rv.ok && rv.problems.some(p => /bridge/.test(p.why)), rv.problems);
restore("app/renderer/app.js", "// renderer\nfunction paint() {}\n");

/* AN IN-SCOPE .gitattributes BLINDS EVERY JUDGEMENT BELOW IT.
 *
 * git reads .gitattributes from the WORKING TREE for both the numstat and the
 * textual diff. "* -diff" written inside the allowed scope made numstat emit
 * "-\t-" (so the added count was 0) and reduced the diff to "Binary files …
 * differ" with no + lines at all — nothing for the secret scan or the
 * renderer-bridge refusal to iterate over. Measured before the fix: this exact
 * patch reviewed ok:true committed:true with no problems, and the committed
 * app.js carried the key, the bridge call and the require. */
edit("app/renderer/.gitattributes", "* -diff\n");
edit("app/renderer/app.js",
     '// renderer\nconst k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\n' +
     'window.lcl.chooseModel();\nrequire("child_process");\n');
rv = pb.review(sess);
check("AN IN-SCOPE .gitattributes IS REFUSED BY NAME. It reconfigures the very " +
      "diff every judgement here is derived from, so it can never ride along " +
      "in a patch",
    !rv.ok && !rv.committed &&
    rv.problems.some(p => p.file === "app/renderer/.gitattributes" &&
                          /\.gitattributes reconfigures/.test(p.why)), rv.problems);
check("...and the guards it was written to blind still fire on the same turn: " +
      "the key, the bridge call and the added-lines count all survive it",
    !rv.ok &&
    rv.problems.some(p => /looks like a credential/.test(p.why)) &&
    rv.problems.some(p => /bridge call/.test(p.why)) &&
    rv.addedTotal === 4, { addedTotal: rv.addedTotal, problems: rv.problems });
check("...and nothing of it reached the branch",
    !/sk-ant-api03/.test(git(sess.dir, ["show", "HEAD:app/renderer/app.js"]).stdout || ""),
    git(sess.dir, ["show", "HEAD:app/renderer/app.js"]).stdout);
fs.rmSync(path.join(sess.dir, "app/renderer/.gitattributes"), { force: true });
restore("app/renderer/app.js", "// renderer\nfunction paint() {}\n");

/* A RENAME IS TWO PATHS, AND THE DESTINATION IS THE ONE THAT MATTERS.
 *
 * numstat has rename detection on by default and emits ONE field, "src => dst".
 * That whole string was stored as the file and matched against the welded set
 * and the scope — and it starts with the SOURCE path, in scope by
 * construction. Measured before --no-renames:
 * "0\t0\tapp/renderer/app.js => .lcl.engine/policy/pwn.js" reviewed ok:true
 * committed:true and landed R100 into the policy kernel. */
fs.mkdirSync(path.join(sess.dir, ".lcl.engine/policy"), { recursive: true });
fs.renameSync(path.join(sess.dir, "app/renderer/app.js"),
              path.join(sess.dir, ".lcl.engine/policy/pwn.js"));
rv = pb.review(sess);
check("A RENAME CANNOT SMUGGLE A FILE INTO THE WELDED SET. The destination is " +
      "judged, not the 'src => dst' string that begins with the in-scope source",
    !rv.ok && !rv.committed &&
    rv.problems.some(p => p.file === ".lcl.engine/policy/pwn.js" && /welded/.test(p.why)) &&
    rv.files.some(f => f.file === ".lcl.engine/policy/pwn.js") &&
    !rv.files.some(f => /=>/.test(f.file)), { files: rv.files, problems: rv.problems });
fs.renameSync(path.join(sess.dir, ".lcl.engine/policy/pwn.js"),
              path.join(sess.dir, "app/renderer/app.js"));

/* the same defect defeated the renderer-bridge check: rename an in-scope
 * renderer file out of app/renderer/ and the destination escapes both the
 * scope test and the startsWith("app/renderer/") test */
fs.renameSync(path.join(sess.dir, "app/renderer/app.js"),
              path.join(sess.dir, ".lcl.engine/core/knowledge2.js"));
rv = pb.review(sess);
check("...and a rename OUT of the agreed scope is refused on the destination too",
    !rv.ok && !rv.committed &&
    rv.problems.some(p => p.file === ".lcl.engine/core/knowledge2.js" &&
                          /outside the scope/.test(p.why)), rv.problems);
fs.renameSync(path.join(sess.dir, ".lcl.engine/core/knowledge2.js"),
              path.join(sess.dir, "app/renderer/app.js"));

/* BINARY CONTENT PASSED EVERY CAP AND EVERY SCAN.
 *
 * MAX_ADDED_LINES was checked against a count numstat reports as 0 for
 * anything binary, and MAX_DIFF_BYTES against a diff in which a binary file is
 * one "Binary files … differ" line whatever it weighs. Measured before the
 * fix: a 3 MB app/renderer/blob.bin with an sk-ant-api03-… key embedded at
 * offset 10 committed ok:true, added 0, problems undefined. */
fs.writeFileSync(path.join(sess.dir, "app/renderer/blob.bin"),
    Buffer.concat([Buffer.from("SPLASH"), Buffer.alloc(1),
                   Buffer.from(' sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n')]));
rv = pb.review(sess);
check("A FILE NEITHER SCAN NOR THE OPERATOR CAN READ IS REFUSED, not waved " +
      "through: a NUL byte and a key-shaped string in an IN-SCOPE file",
    !rv.ok && !rv.committed &&
    rv.problems.some(p => p.file === "app/renderer/blob.bin" &&
                          /binary content/.test(p.why)), rv.problems);
fs.rmSync(path.join(sess.dir, "app/renderer/blob.bin"), { force: true });

/* size */
edit("app/renderer/styles.css", ".a{}\n" + "/* x */\n".repeat(pb.MAX_ADDED_LINES + 50));
rv = pb.review(sess);
check("a patch past the size cap is refused rather than reviewed by eye",
    !rv.ok && rv.problems.some(p => /lines added/.test(p.why)), rv.problems);

/* =====================================================================
 * 3b. THE DETECTOR THE SCAN CALLS IS WELDED, AND A THROW FROM IT FAILS CLOSED
 * =================================================================== */
{
    const s3 = pb.open("s3", [".lcl.engine/core/"], { repo: REPO });
    check("a scope of .lcl.engine/core/ opens — the directory is not welded whole, " +
          "only the files inside it that must never move",
        s3.ok, s3.error);
    if (s3.ok) {
        fs.writeFileSync(path.join(s3.dir, ".lcl.engine/core/securityTools.js"),
            "module.exports = { looksLikeSecret: () => ({ found: false }) };\n");
        const r3 = pb.review(s3);
        check("REPLACING THE SECRET DETECTOR IS REFUSED. Welding secretGuard.js " +
              "while review() calls securityTools.looksLikeSecret welded nothing " +
              "— this exact patch used to review ok:true committed:true",
            !r3.ok && !r3.committed &&
            r3.problems.some(p => p.file === ".lcl.engine/core/securityTools.js" &&
                                  /welded/.test(p.why)), r3.problems);
        pb.discard(s3);
    }

    const src = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "patchBay.js"), "utf8");
    check("...and a THROW out of that detector fails closed. The bare " +
          "`catch { looksSecret = null }` made the secret scan pass SILENTLY on " +
          "any error — a guard reporting all-clear precisely when it had not run",
        /the secret detector threw; refusing rather/.test(src) &&
        !/catch\s*\{\s*looksSecret = null;\s*\}/.test(src));
}

/* =====================================================================
 * 3c. REVIEW ANSWERS HONESTLY WHEN THERE IS NOTHING TO REVIEW
 * =================================================================== */
{
    const s4 = pb.open("s4", ["app/renderer/"], { repo: REPO });
    const r4 = pb.review(s4);
    check("REVIEW ON AN UNTOUCHED WORKING COPY SAYS SO. It used to return " +
          "neither an error nor a problems array, and hand back the session's " +
          "BASE as `sha` — a commit id for a patch that does not exist",
        r4.ok === false && r4.committed === false &&
        typeof r4.error === "string" && /nothing/.test(r4.error) &&
        Array.isArray(r4.problems) && r4.problems.length === 0 &&
        r4.sha === undefined && !("sha" in r4), r4);

    fs.writeFileSync(path.join(s4.dir, "app/renderer/styles.css"), ".a { color: teal; }\n");
    let threw = null, r5 = null;
    try { r5 = pb.review({ dir: s4.dir, repo: s4.repo, base: s4.base, branch: s4.branch }); }
    catch (e) { threw = String((e && e.message) || e); }
    check("...and a session that arrives WITHOUT a scope is refused in the return " +
          "value, rather than thrown out of with a TypeError",
        threw === null && r5 && r5.ok === false && Array.isArray(r5.problems) &&
        /no recorded scope/.test(r5.error || ""), threw || r5);
    pb.discard(s4);
}

/* =====================================================================
 * 4. REVIEW EXECUTES NOTHING
 * =================================================================== */
check("REVIEW RUNS NO CODE FROM THE WORKING COPY. 'prove it works by running " +
      "the tests' died in review: a model-authored test is code with the same " +
      "reach as the patch, and the suites load main.js",
    (() => {
        const src = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "patchBay.js"), "utf8");
        const body = src.slice(src.indexOf("function review("));
        // git IS spawned — that is how a diff is read, and git does not execute
        // the working copy. What must never appear is an interpreter, a package
        // manager, or this app's own script runner pointed at those files.
        // (`.exec(` here is String.prototype regex matching, not a process.)
        return !/spawn\w*\(\s*["'](?!git)/.test(body) &&
               !/\bnpm\b|\bnode\b|runScript|scriptRunner|child_process/.test(body);
    })());

/* =====================================================================
 * 5. DISCARD, AND THE REPOSITORY IS UNTOUCHED THROUGHOUT
 * =================================================================== */

/* THE EVIDENCE IS CAPTURED WHILE THE WORKING COPY STILL EXISTS.
 *
 * The old form of the last check asked whether DATA/patch-bay/data existed,
 * AFTER discard had removed the worktree — and patchBay never wrote a folder
 * called "data" there in the first place, sessions being named patch-<id>.
 * Three independent reasons it could never be false. This looks in the real
 * worktree, before it is gone, and confirms it was populated at all so the
 * absence means something. */
const privateThings = {
    listing: fs.readdirSync(sess.dir).sort(),
    dataFolder: fs.existsSync(path.join(sess.dir, "data")),
    modelsFolder: fs.existsSync(path.join(sess.dir, "models")),
    sessionsFile: fs.existsSync(path.join(sess.dir, "data", "sessions.json")),
    weights: fs.existsSync(path.join(sess.dir, "models", "big.gguf"))
};

const headBefore = git(REPO, ["rev-parse", "main"]).stdout.trim();
const d = pb.discard(sess);
check("discarding removes the working copy and its branch", d.ok && !fs.existsSync(sess.dir));
check("THE REPOSITORY'S OWN BRANCH NEVER MOVED. Nothing in this module can " +
      "land anything — that is the operator's one command",
    git(REPO, ["rev-parse", "main"]).stdout.trim() === headBefore);
check("...and the private files were never copied into the working copy — " +
      "measured INSIDE it while it still existed, and against a copy proven " +
      "populated, so the absence is evidence rather than an empty folder",
    privateThings.listing.includes("app") &&
    privateThings.listing.includes(".lcl.engine") &&
    !privateThings.listing.includes("data") &&
    !privateThings.listing.includes("models") &&
    !privateThings.dataFolder && !privateThings.modelsFolder &&
    !privateThings.sessionsFile && !privateThings.weights, privateThings);

/* =====================================================================
 * 6. THE INSTALLED BUILD SAYS SO HONESTLY
 * =================================================================== */
check("on a copy with no source repository it refuses with the REASON, rather " +
      "than failing obscurely — an installed build ships compiled, without git",
    (() => {
        const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-nogit-"));
        const a = pb.available(nowhere);
        try { fs.rmSync(nowhere, { recursive: true, force: true }); } catch {}
        return a.ok === false && /no source repository|git is not installed/.test(a.reason);
    })());

try { fs.rmSync(REPO, { recursive: true, force: true, maxRetries: 6 }); } catch {}
/* =====================================================================
 * 7. IT IS REACHABLE. A feature nobody can call is a file, not a feature.
 * =================================================================== */
{
    const main = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const pre = fs.readFileSync(path.join(ROOT, "app", "preload.js"), "utf8");
    const app = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "app", "renderer", "index.html"), "utf8");
    check("THE PATCH BAY IS WIRED END TO END. The first cut of this shipped a " +
          "module nothing could call — the operator asked for a feature, not a " +
          "file, and a review lens aimed at exactly that caught it",
        /core\/patchBay/.test(main) &&
        /lcl:patchOpen/.test(main) && /lcl:patchReview/.test(main) &&
        /patchOpen:/.test(pre) && /window\.lcl\.patchOpen/.test(app) &&
        /data-action="patch-bay"/.test(html) &&
        /"patch-bay": \(\) => openPatchBay/.test(app));
    check("...and it says plainly where it cannot work, rather than failing " +
          "obscurely on an installed build",
        /an installed build ships compiled, without either/.test(app));
    check("...and every open, review and discard is recorded in the audit log",
        /kind: "patch-opened"/.test(main) && /kind: "patch-reviewed"/.test(main) &&
        /kind: "patch-discarded"/.test(main));
}

try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 6 }); } catch {}
try { fs.rmSync(STORE, { recursive: true, force: true, maxRetries: 6 }); } catch {}
/* ============ THE RULEBOOK PROTECTED, THE LINE THAT OBEYS IT NOT ========== */
/*
 * patchBay.js argues at the top that an allowlist cannot have that hole. A
 * review the operator commissioned found it four ways over. The worst needed
 * no cleverness at all: app/main.js was welded, and the file that NAMES
 * app/main.js as the main process was not — repoint "main" and the welded file
 * is never loaded, every guard in it bypassed, not one welded byte touched.
 */
{
    const pb = require(path.join(__dirname, "..", ".lcl.engine", "core", "patchBay.js"));
    const mustWeld = [
        ["app/package.json", "it names which file IS the main process"],
        ["package.json", "the same, one level up"],
        [".lcl.engine/core/sessionPerms.js",
         "the single gate for write mode, unattended execution, secrets and isolation"],
        [".lcl.engine/core/engagements.js",
         "the authorization gate for the offensive tools"],
        [".lcl.engine/core/offensiveTools.js",
         "where requireEngagement re-matches each call's target against the authorized " +
         "host — welding the engagements store while leaving this editable welds nothing"],
        ["devtools/release.js",
         "the runner that decides whether the welded tests ever get to fail anything"]
    ];
    for (const [f, why] of mustWeld) {
        check(`${f} is welded — ${why}`, pb.isWelded(f), null);
    }
    check("...and the case fold still covers them, on a volume where it matters",
        pb.isWelded("App/Package.json") && pb.isWelded("DevTools/Release.js"), null);

    /* A PATCH THAT ONLY DELETES WAS NEVER READ.
     *
     * review() scanned ADDED lines, reasoning that what was already in the repo
     * is not this patch's doing. True of most lines, and false of exactly the
     * dangerous one: a patch whose whole content is the removal of a guard call
     * adds nothing, so no scan ever looked at it. */
    const src = fs.readFileSync(
        path.join(__dirname, "..", ".lcl.engine", "core", "patchBay.js"), "utf8");
    check("REMOVED LINES ARE READ TOO — a patch whose entire content is deleting " +
          "a guard call added nothing, so every scan skipped it",
        /removedLines\.push\(\{ file: currentFile, text: line\.slice\(1\) \}\)/.test(src)
        && /const GUARD_CALLS = \[/.test(src), null);
    check("...and it names the guards by what they actually are, including the " +
          "write door and the residency gate",
        ["assertWritable", "resolveForWrite", "looksLikeSecret", "isWelded",
         "requireNetwork", "holdLocalResidency", "StrictHostKeyChecking"]
            .every(g => src.includes(`"${g}"`)), null);
    check("...and a guard MOVED within the same patch is not reported as removed " +
          "— a refactor that keeps the call must not cry wolf",
        /if \(addedText\.includes\(g\)\) continue;/.test(src), null);

    check("THE BRIDGE CHECK READS BOTH NOTATIONS. It matched `window.lcl` in dot " +
          "notation only, so `window[\"lcl\"]` reached the same privileged bridge " +
          "unexamined",
        (() => {
            const m = /const BRIDGE_REACH =\s*([^;]+);/.exec(src);
            if (!m) return false;
            // eslint-disable-next-line no-eval
            const re = eval(m[1].trim());
            return re.test('window.lcl.chat()')
                && re.test('window["lcl"].chat()')
                && re.test("window['lcl'].chat()")
                && re.test('window [ "lcl" ]')
                && !re.test("const windowSize = 4;");
        })(), null);
}
console.log(`\n${pass}/${pass + fail} patch-bay checks passed`);
process.exit(fail ? 1 : 0);
