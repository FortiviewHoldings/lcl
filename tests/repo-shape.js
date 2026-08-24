/**
 * YOUR CODE AS CONTEXT, WITHOUT YOUR CUSTOMERS IN IT.
 *
 * "Prove the filter against real bytes the way tests/secret-wire.js proves the
 *  existing guard — not by asserting that a function was called."
 *
 * So this builds a repository that contains exactly the things that must never
 * survive — a real-shaped API key, a customer name, a project codename, a
 * distinctive phrase, a relative import naming a private module, a directory
 * whose company name hides behind a dot, a private-registry dependency and a
 * git+ssh dependency — surveys it, and searches the ENTIRE serialised output
 * for each one. Not "the filter ran". The bytes, or it did not happen.
 *
 * The second half proves the NUMBERS, because the numbers are what is left
 * after the names are taken away: fan-out and the test ratio measured against
 * a tree whose real directory names are deliberately non-generic, truncation
 * that must announce itself, and a withheld block that calls prose prose.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

const ROOT = path.join(__dirname, "..");
const shape = require(path.join(ROOT, ".lcl.engine", "core", "repoShape.js"));

/* Temp repositories, all cleaned up at the end even if a check throws. */
const MADE = [];
function mkrepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-shape-"));
    MADE.push(root);
    return {
        root,
        w(rel, body) {
            const f = path.join(root, rel);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, body);
        }
    };
}
/* Built rather than written literally so the URL scheme is assembled, not typed. */
const NPM_TARBALL_HOST = "https:" + "//registry.npmjs.org";
const PY_HOST = "https:" + "//files.pythonhosted.org";
const PRIVATE_HOST = "https:" + "//npm.registry.internal.example";

/* ---- a repository seeded with things that must not leak ------------- */
const REPO0 = mkrepo();
const REPO = REPO0.root;
const w = REPO0.w;
const SECRETS = {
    key: "sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
    customer: "Wintermute Diagnostics",
    codename: "Bluefin",
    phrase: "the usual settlement cadence for tier-two accounts",
    privateDir: "bluefin-billing",
    privateModule: "wintermute-adapter",
    // FINDING 7: a company name that hides behind a dot. The old filter tested
    // the stem, sliced the suffix off, and then returned the segment WITH the
    // suffix — so every one of these walked out verbatim.
    dottedDir: "core.wintermute",
    dottedDirNested: "services.acmecorp",
    // FINDINGS 8 + 18: "it is in the manifest" is not evidence of publicness.
    privateScopedDep: "@wintermute-internal/billing-sdk",
    privatePlainDep: "acme-private-telemetry",
    gitDep: "bluefin-tools"
};
w("package.json", JSON.stringify({
    name: "thing",
    dependencies: {
        express: "^4",
        lodash: "^4",
        [SECRETS.privateScopedDep]: "^2",
        [SECRETS.privatePlainDep]: "^1",
        [SECRETS.gitDep]: "git+ssh://git@example.com/bluefin/tools.git#v1"
    }
}, null, 2));
/* A lockfile that proves express and lodash came from the public registry, and
   proves nothing of the kind about the other three. */
w("package-lock.json", JSON.stringify({
    name: "thing", lockfileVersion: 3,
    packages: {
        "": { name: "thing" },
        "node_modules/express": {
            version: "4.18.2",
            resolved: NPM_TARBALL_HOST + "/express/-/express-4.18.2.tgz"
        },
        "node_modules/lodash": {
            version: "4.17.21",
            resolved: NPM_TARBALL_HOST + "/lodash/-/lodash-4.17.21.tgz"
        },
        ["node_modules/" + SECRETS.privateScopedDep]: {
            version: "2.0.1",
            resolved: PRIVATE_HOST + "/" + SECRETS.privateScopedDep + "/-/billing-sdk-2.0.1.tgz"
        },
        ["node_modules/" + SECRETS.privatePlainDep]: {
            version: "1.4.0",
            resolved: PRIVATE_HOST + "/" + SECRETS.privatePlainDep + "/-/telemetry-1.4.0.tgz"
        },
        ["node_modules/" + SECRETS.gitDep]: {
            version: "0.9.0",
            resolved: "git+ssh://git@example.com/bluefin/tools.git#deadbeef"
        }
    }
}, null, 2));
w("src/index.js",
    `const express = require("express");\n` +
    `const adapter = require("../${SECRETS.privateDir}/${SECRETS.privateModule}");\n` +
    `const billing = require("${SECRETS.privateScopedDep}");\n` +
    `const telemetry = require("${SECRETS.privatePlainDep}");\n` +
    `const tools = require("${SECRETS.gitDep}");\n` +
    `// ${SECRETS.phrase}\n` +
    `const API_KEY = "${SECRETS.key}";\n` +
    `function chargeCustomer() { return "${SECRETS.customer}"; }\n` +
    `class ${SECRETS.codename}Engine {}\n` +
    `module.exports = { chargeCustomer };\n`);
w(`${SECRETS.privateDir}/${SECRETS.privateModule}.js`,
    `// ${SECRETS.customer} only\nmodule.exports = {};\n`);
/* FINDING 7 fixture: dotted directory segments, one of them nested. */
w(`${SECRETS.dottedDir}/api.js`, `module.exports = {};\n`);
w(`${SECRETS.dottedDirNested}/client/index.js`, `module.exports = {};\n`);
w("src/utils/text.js", `const _ = require("lodash");\nfunction slug(s){return s;}\nmodule.exports={slug};\n`);
w("tests/index.test.js", `require("../src/index.js");\n`);
w("node_modules/express/index.js", "// must never be walked\n");

const out = shape.survey(REPO);
check("(setup) the survey ran over the seeded repository",
    out.ok && Array.isArray(out.files) && out.files.length > 0, out.error);

const serialised = JSON.stringify(out);

/* =====================================================================
 * 1. THE BYTES. Every planted identifier, searched for in the whole output.
 * =================================================================== */

for (const [what, value] of Object.entries(SECRETS)) {
    check(`NOT IN THE OUTPUT — ${what}: the exact bytes appear nowhere in the ` +
          `entire serialised survey`,
        !serialised.includes(value), value.slice(0, 28) + "…");
}

check("...and not in any casing or fragment either — the company tokens " +
      "themselves are swept for, so a leak cannot hide behind a lowercase " +
      "path segment or a scope prefix",
    !/wintermute|acmecorp|bluefin|acme-private/i.test(serialised),
    (serialised.match(/.{0,40}(wintermute|acmecorp|bluefin|acme-private).{0,40}/i) || [])[0]);

check("...nor does any file CONTENT at all — no identifiers, no strings, no " +
      "comments, because contents are read and discarded rather than stored",
    !/chargeCustomer|API_KEY|Engine \{|slug/.test(serialised));

check("...and a private path segment is generalised rather than carried: the " +
      "directory that named a customer is gone from every stored path",
    out.files.every(f => !f.path.includes(SECRETS.privateDir)) &&
    out.files.some(f => /(^|\/)dir(\/|$)|(^|\/)file\./.test(f.path)),
    out.files.map(f => f.path).slice(0, 8));

/* ---- FINDING 7, at the unit level as well as in the bytes ------------ */

check("FINDING 7 — THE EXTENSION IS PART OF THE NAME. The allowlist used to " +
      "be applied to the stem alone and the original segment handed back with " +
      "its suffix glued on, so <common-word>.<anything> survived verbatim. " +
      "Every word, dots included, must be an allowlisted word or a known " +
      "source extension",
    ["core.wintermute", "services.acmecorp", "api.acme", "src.bluefin",
     "lib.acmecorp", "core.dektol", "tests.bluefin"]
        .every(s => shape.safeSegment(s) === null),
    ["core.wintermute", "services.acmecorp", "api.acme", "src.bluefin",
     "lib.acmecorp"].map(s => [s, shape.safeSegment(s)]));

check("...while the ordinary names a repository is actually made of still " +
      "survive, because a filter that redacts everything says nothing. " +
      "package.json is in this list rather than the one above: the dotted-word " +
      "rule is there to stop core.<company>, and it was also swallowing the " +
      "single most generic filename in software",
    ["index.js", "index.test.js", "text.js", "main.py", "styles.css",
     "src", "tests", "api.js", "package.json", "package-lock.json"]
        .every(s => shape.safeSegment(s) === s),
    ["index.js", "index.test.js", "text.js", "main.py", "styles.css",
     "src", "tests", "api.js", "package.json", "package-lock.json"]
        .map(s => [s, shape.safeSegment(s)]));

check("...and the dotted directories in the seeded repository came out as " +
      "'dir', not as themselves",
    out.files.some(f => f.path === "dir/api.js") &&
    out.files.some(f => f.path === "dir/client/index.js"),
    out.files.map(f => f.path));

/* =====================================================================
 * 2. AND IT KEPT SOMETHING WORTH HAVING
 * =================================================================== */

check("the SHAPE survived: file count, languages, sizes and line counts",
    out.summary.fileCount > 0 && out.summary.byLanguage.javascript > 0 &&
    out.summary.totalLines > 0, out.summary);

check("PUBLIC dependencies are kept — they say how this person builds and " +
      "identify nobody",
    out.summary.publicDependencies.some(d => d.name === "express") &&
    out.summary.publicDependencies.some(d => d.name === "lodash"),
    out.summary.publicDependencies);

check("...while a RELATIVE import is never kept, because '../bluefin-billing/…' " +
      "identifies the project as surely as a customer record does",
    !out.summary.publicDependencies.some(d => /\.\.|bluefin|wintermute/i.test(d.name)));

/* ---- FINDINGS 8 + 18 ------------------------------------------------- */

check("FINDINGS 8 + 18 — 'IT IS IN THE MANIFEST' IS NOT EVIDENCE OF " +
      "PUBLICNESS. A private-registry package, a scoped internal SDK and a " +
      "git+ssh specifier all sit in dependencies next to express, and all " +
      "three used to be published under a field named publicDependencies. " +
      "Only names the lockfile proves came from the public registry survive",
    out.summary.publicDependencies.length === 2 &&
    out.summary.publicDependencies.every(d => d.name === "express" || d.name === "lodash"),
    out.summary.publicDependencies);

check("...and the three that were dropped are COUNTED, not deleted — the " +
      "operator sees that the exclusion happened",
    out.withheld.dependencies === 3, out.withheld);

check("...and the gate that did it is testable on its own: a version range " +
      "passes, anything pointing at a place does not",
    ["^4", "~1.2.3", ">=1.0.0 <2.0.0", "1.x", "*", "latest"].every(shape.isPlainRange) &&
    ["git+ssh://git@example.com/x.git", "file:../local", "link:../local",
     "workspace:*", "portal:../local", "npm:@scope/name@1", "user/repo",
     "github:user/repo", "https:" + "//example.com/x.tgz", ""]
        .every(v => !shape.isPlainRange(v)),
    ["^4", "file:../local", "workspace:*"].map(v => [v, shape.isPlainRange(v)]));

check("definition COUNTS are kept, never the names",
    out.files.some(f => typeof f.functions === "number" && typeof f.exports === "number") &&
    !/"functions":\s*"/.test(serialised));

check("THE LAYERING SURVIVES AS NUMBERS. The name filter generalises nearly " +
      "every path — measured on this app's own engine, all 68 of them — which " +
      "is correct and leaves a tree of 'dir/file.js'. Depth, fan-out and size " +
      "spread describe how somebody builds without naming anything they built",
    (() => {
        const q = out.summary;
        return q.depth && typeof q.depth.max === "number" &&
               q.fanOut && typeof q.fanOut.widest === "number" &&
               q.sizeSpread && typeof q.sizeSpread.medianLines === "number";
    })(), out.summary.depth);

check("...and those numbers are numbers — every value in them, so nothing from " +
      "the repository can ride along inside a 'statistic'. The manifest block " +
      "is in this sweep because manifest DISCOVERY now walks the tree, and a " +
      "manifest's directory is a real path name",
    [out.summary.depth, out.summary.fanOut, out.summary.sizeSpread,
     out.summary.manifests]
        .every(o => o && Object.values(o).every(v => typeof v === "number")),
    [out.summary.depth, out.summary.fanOut, out.summary.sizeSpread,
     out.summary.manifests]);

check("the test-to-source ratio survives — that is a real fact about how " +
      "somebody works",
    typeof out.summary.testRatio === "number" && out.summary.testRatio > 0,
    out.summary.testRatio);

check("build output is never walked at all",
    !serialised.includes("node_modules") && out.withheld.skippedDirs > 0);

/* =====================================================================
 * 3. THE OPERATOR CAN SEE WHAT WAS WITHHELD, AND WHAT THE RULE IS
 * =================================================================== */

check("what was withheld is COUNTED and reported, so the operator reviews the " +
      "exclusions rather than trusting them",
    out.withheld && typeof out.withheld.paths === "number" && out.withheld.paths > 0,
    out.withheld);

check("every exclusion has its own counter — paths, build directories, real " +
      "binaries, non-source text, oversized files, unprovable dependencies, " +
      "truncation and unwalked directories",
    ["paths", "skippedDirs", "binaries", "nonSourceText", "oversized",
     "dependencies", "truncated", "unwalkedDirs"]
        .every(k => typeof out.withheld[k] === "number"), out.withheld);

check("the rule is stated in the output itself, every time, so the claim can " +
      "be checked rather than believed",
    /file tree, language, byte size/.test(out.stores) &&
    /file contents, identifiers, comments/.test(out.neverStores));

check("...and the stated rule matches what the code now actually does: the " +
      "dependency promise names the lockfile proof, and the refusal list " +
      "names unprovable dependency names alongside unprovable path segments",
    /manifest and lockfile prove/.test(out.stores) &&
    /not provably generic/.test(out.neverStores) &&
    /not provably public/.test(out.neverStores),
    [out.stores, out.neverStores]);

/* =====================================================================
 * 4. THE HONEST LIMIT IS WRITTEN DOWN
 * =================================================================== */

check("THE WIDE FILTER IS REFUSED IN WRITING. A credential has a shape; a " +
      "customer's name is a name. The module says so rather than shipping a " +
      "language classifier nobody could stake a privacy promise on",
    (() => {
        const src = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "repoShape.js"), "utf8");
        return /cannot make it trustworthy/.test(src) &&
               /a leak with a good\s*\n?\s*\*?\s*reputation/.test(src);
    })());

check("nothing here reaches the network — this is a local survey",
    (() => {
        const src = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "repoShape.js"), "utf8");
        return !/https?:|fetch\(|require\("(net|http|https)"\)/.test(src);
    })());

/* =====================================================================
 * 5. IT IS REACHABLE, AND IT STORES NOTHING BY ITSELF
 * =================================================================== */
{
    const main = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const pre = fs.readFileSync(path.join(ROOT, "app", "preload.js"), "utf8");
    const app = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "app", "renderer", "index.html"), "utf8");
    check("THE SURVEY IS WIRED END TO END — module, IPC, preload, menu, panel. " +
          "The first cut was a module nothing could call",
        /core\/repoShape/.test(main) &&
        /lcl:surveyRepoShape/.test(main) && /surveyRepoShape:/.test(pre) &&
        /window\.lcl\.surveyRepoShape/.test(app) &&
        /data-action="code-shape"/.test(html) &&
        /"code-shape": \(\) => openCodeShape/.test(app));
    check("the operator sees the EXCLUSIONS and a SAMPLE before anything is " +
          "kept — and this screen keeps nothing at all",
        /WITHHELD/.test(app) && /shape-sample/.test(app) &&
        /Nothing is stored by this screen/.test(app));
    check("...and a whole drive is refused rather than surveyed",
        /refusing to survey a whole drive/.test(main));

    /* EVERY COUNTER REACHES THE SCREEN. The withheld block is the operator's
     * audit surface: they are asked to review the exclusions rather than trust
     * them, which only works if the panel shows all of them. Four counters were
     * added to the module in one pass and shown in none — a truncated survey
     * read exactly like a complete one. This check fails the moment a fifth is
     * counted and not surfaced. */
    const panel = (/WITHHELD[\s\S]{0,1600}?shape-sample/.exec(app) || [""])[0];
    const counters = Object.keys(out.withheld);
    check("EVERY WITHHELD COUNTER THE SURVEY PRODUCES IS SHOWN IN THE PANEL — " +
          "an exclusion the operator cannot see is not an audit surface, it is " +
          "a shorter list that looks like the whole one",
        counters.length > 0 &&
        counters.every(k => new RegExp("\\b" + k + "\\b").test(panel)),
        counters.filter(k => !new RegExp("\\b" + k + "\\b").test(panel)));

    check("...and a PARTIAL survey says so in words, because every number above " +
          "it then describes only the part that was walked",
        /THIS SURVEY IS PARTIAL/.test(app));
}

/* =====================================================================
 * 6. FINDING 22 — THE IMPORT REGEX MUST CAPTURE A SPECIFIER, NOT A BINDING
 *
 * `import <ident>` means a module name in Python and a LOCAL VARIABLE NAME in
 * JavaScript. Pointed at ESM it captured whatever the file happened to call
 * its default import, and that token then walked through the manifest check —
 * so a file importing nothing but relative paths reported express and lodash.
 * =================================================================== */
{
    const r = mkrepo();
    r.w("package.json", JSON.stringify({
        name: "esm", dependencies: { express: "^4", lodash: "^4", requests: "^1" }
    }, null, 2));
    r.w("package-lock.json", JSON.stringify({
        name: "esm", lockfileVersion: 3,
        packages: {
            "node_modules/express": { version: "4.18.2", resolved: NPM_TARBALL_HOST + "/express/-/express-4.18.2.tgz" },
            "node_modules/lodash": { version: "4.17.21", resolved: NPM_TARBALL_HOST + "/lodash/-/lodash-4.17.21.tgz" }
        }
    }, null, 2));
    /* Bindings named after real dependencies; specifiers that are all relative. */
    r.w("main.js",
        `import express from "../wintermute-adapter/index.js";\n` +
        `import lodash from "./local/thing.js";\n` +
        `export default 1;\n`);
    const esm = shape.survey(r.root);
    const esmSer = JSON.stringify(esm);
    const mainFile = esm.files.find(f => f.path === "main.js");

    check("FINDING 22 — an ESM file whose default-import BINDINGS are named " +
          "after manifest dependencies but whose specifiers are all relative " +
          "reports no imports at all. The binding is the file's choice of " +
          "variable name; it is not a package",
        mainFile && Array.isArray(mainFile.imports) && mainFile.imports.length === 0,
        mainFile && mainFile.imports);

    check("...so publicDependencies is empty for it, instead of claiming this " +
          "person reaches for express and lodash on the strength of two " +
          "variable names",
        esm.summary.publicDependencies.length === 0, esm.summary.publicDependencies);

    check("...and the private module the relative import actually pointed at " +
          "is nowhere in the output",
        !/wintermute/i.test(esmSer));
}

{
    /* The Python side of the same regex still works, because that is the
       language it was written for. Deleting it would have been the easy fix
       and the wrong one. */
    const r = mkrepo();
    r.w("requirements.txt", "requests==2.31.0\n# a comment\n-e ./local-pkg\n");
    r.w("poetry.lock",
        `[[package]]\nname = "requests"\nversion = "2.31.0"\n` +
        `url = "${PY_HOST}/packages/70/8e/requests-2.31.0-py3-none-any.whl"\n`);
    r.w("src/main.py", "import requests\nimport os.path\nfrom requests import Session\n");
    const py = shape.survey(r.root);
    check("...while PYTHON imports still resolve, because the pattern is " +
          "correct for the language it was written for — applied to .py only",
        py.summary.publicDependencies.some(d => d.name === "requests"),
        py.summary.publicDependencies);
}

/* =====================================================================
 * 7. FINDING 20 — FAN-OUT AND TEST RATIO MUST COUNT REAL DIRECTORIES
 *
 * Every filtered directory is spelled "dir", so aggregating over the STORED
 * path merges all of them into one bucket: five directories reported as one,
 * and a tests directory whose name was generalised reported as no tests at
 * all. The counters run inside the walk on the real names; only integers
 * leave.
 * =================================================================== */
{
    const r = mkrepo();
    r.w("package.json", JSON.stringify({ name: "darkroom" }, null, 2));
    for (const f of ["f1.js", "f2.js", "f3.js"]) r.w("stop-bath/" + f, "module.exports={};\n");
    for (const f of ["f1.js", "f2.js"]) r.w("fixer-vault/" + f, "module.exports={};\n");
    r.w("dektol/f1.js", "module.exports={};\n");
    r.w("print-washer/rinse/f1.js", "module.exports={};\n");
    /* The tests directory has to carry a NON-GENERIC name for this fixture to
       mean anything: the point is that the test ratio survives the name being
       redacted. "unit-tests" is now legitimately generic vocabulary, so the
       darkroom word does the work instead. */
    for (const f of ["f1.js", "f2.js"]) r.w("dektol-tests/" + f, "module.exports={};\n");

    const d = shape.survey(r.root);
    const paths = d.files.map(f => f.path);

    check("(setup) every one of those directory names is non-generic, so the " +
          "stored tree really is nothing but dir/file.js",
        d.summary.fileCount === 10 &&
        paths.every(p => /^(package\.json|dir\/file\.js|dir\/dir\/file\.js)$/.test(p)),
        paths);

    check("FINDING 20 — FAN-OUT COUNTS THE DIRECTORIES THAT EXIST. Six real " +
          "directories hold files (root, stop-bath, fixer-vault, dektol, " +
          "print-washer/rinse, dektol-tests); the widest holds three. Computed " +
          "off the stored path this collapsed to 3 buckets with a widest of 8",
        d.summary.fanOut.directories === 6 &&
        d.summary.fanOut.widest === 3 &&
        d.summary.fanOut.mean === 1.67, d.summary.fanOut);

    check("...and the test ratio sees a tests directory whose NAME was " +
          "generalised: 2 of 10 files, not the 0 the redacted path reported",
        d.summary.testRatio === 0.2, d.summary.testRatio);

    check("...and none of those real directory names rode out inside the " +
          "numbers — only counts are emitted",
        !/stop-bath|fixer-vault|dektol|print-washer/i.test(JSON.stringify(d)));
}

/* =====================================================================
 * 8. FINDING 21 — TRUNCATION IS NEVER SILENT
 *
 * The cap used to stop the walk and say nothing: fileCount 5 out of 25, every
 * summary figure computed over an arbitrary prefix, and not one counter to
 * show it happened.
 * =================================================================== */
{
    const r = mkrepo();
    r.w("package.json", JSON.stringify({ name: "capped" }, null, 2));
    for (let i = 0; i < 25; i++) r.w(`src/f${i}.js`, "module.exports={};\n");

    const cut = shape.survey(r.root, { maxFiles: 3 });
    check("FINDING 21 — a survey stopped by maxFiles REPORTS the truncation. " +
          "26 files exist, 3 were surveyed, and the 23 the cap dropped are " +
          "counted rather than vanishing",
        cut.summary.fileCount === 3 && cut.withheld.truncated === 23 &&
        cut.summary.fileCount + cut.withheld.truncated === 26,
        { fileCount: cut.summary.fileCount, withheld: cut.withheld });

    check("...and directories the cap never opened are counted separately, so " +
          "the two ways a walk can be cut short are distinguishable",
        typeof cut.withheld.unwalkedDirs === "number" && cut.withheld.unwalkedDirs === 0,
        cut.withheld);

    const whole = shape.survey(r.root);
    check("...while an untruncated survey reports zero of both, so the counter " +
          "is a signal and not decoration",
        whole.summary.fileCount === 26 && whole.withheld.truncated === 0 &&
        whole.withheld.unwalkedDirs === 0,
        { fileCount: whole.summary.fileCount, withheld: whole.withheld });
}

/* =====================================================================
 * 9. FINDING 37 — PROSE IS NOT A BINARY
 *
 * withheld.binaries counted every file that was not a known language, so a
 * directory of notes, spreadsheets and configuration was reported to the
 * operator as five binaries. The bucket is split, not renamed.
 * =================================================================== */
{
    const r = mkrepo();
    r.w("notes.txt", "developing times for the tank\n");
    r.w("data.csv", "dilution,minutes\n1:31,9.5\n");
    r.w("conf.xml", "<agitation cycle=\"60\"/>\n");
    r.w("logo.svg", "<svg width=\"1\" height=\"1\"></svg>\n");
    fs.writeFileSync(path.join(r.root, "scan.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));

    const mix = shape.survey(r.root);
    check("FINDING 37 — one real binary and four plain-text files are reported " +
          "as one binary and four non-source text files. Calling a .txt, a " +
          ".csv, an .xml and an .svg 'binaries' misdescribes the repository in " +
          "the user's own audit surface",
        mix.withheld.binaries === 1 && mix.withheld.nonSourceText === 4 &&
        mix.summary.fileCount === 0,
        { withheld: mix.withheld, fileCount: mix.summary.fileCount });

    check("...and the original counter is still there under its original name, " +
          "counting the thing it claims to count",
        typeof mix.withheld.binaries === "number" &&
        shape.BINARY_EXT.has(".png") && !shape.BINARY_EXT.has(".txt"));
}

/* =====================================================================
 * 10. THE SURVEY OVER-REDACTED TO USELESSNESS
 *
 * Measured on the user's own tree: 583 of 583 path names generalised, and
 * every sample row read `file.md` or `tests/file.js`. The privacy half of the
 * job was done and the other half — telling him anything at all — was not. The
 * vocabulary is now several hundred trade words wide, with a plural rule and a
 * two-word concatenation rule.
 *
 * Every one of those is a new way to be wrong, so this section is the proof
 * that none of them opened a door. The byte searches in section 1 already run
 * against the widened filter; these press on the widening specifically.
 * =================================================================== */
{
    /* A codename placed in every form the three new rules could exploit. */
    const g = mkrepo();
    const CODE = "bluefin", CUST = "wintermute";
    g.w("package.json", JSON.stringify({ name: "wide" }, null, 2));
    g.w(`data-${CODE}/index.js`, "module.exports={};\n");          // dash, bad word second
    g.w(`${CODE}-services/index.js`, "module.exports={};\n");      // dash, bad word first
    g.w(`core.${CODE}/index.js`, "module.exports={};\n");          // dot
    g.w(`api_${CUST}/index.js`, "module.exports={};\n");           // underscore
    g.w(`${CODE}s/index.js`, "module.exports={};\n");              // pluralised codename
    g.w(`data${CODE}/index.js`, "module.exports={};\n");           // concatenated, good+bad
    g.w(`${CODE}data/index.js`, "module.exports={};\n");           // concatenated, bad+good
    g.w(`${CUST}service/index.js`, "module.exports={};\n");        // concatenated, bad+good
    g.w(`service${CUST}/index.js`, "module.exports={};\n");        // concatenated, good+bad
    g.w(`src/${CODE}.js`, "module.exports={};\n");                 // bare, as a file
    g.w(`src/${CODE}-adapter.js`, "module.exports={};\n");         // file, dash
    g.w(`src/utils/${CUST}es.js`, "module.exports={};\n");         // -es plural
    const wide = shape.survey(g.root);
    const wideSer = JSON.stringify(wide);

    check("THE WIDENED VOCABULARY DID NOT OPEN A LEAK. A codename and a " +
          "customer name are planted in twelve shapes chosen to attack the " +
          "three new rules — dashed either way round, dotted, underscored, " +
          "pluralised with -s and with -es, and concatenated to a trade word " +
          "on both sides. Neither token appears anywhere in the output",
        !/bluefin|wintermute/i.test(wideSer),
        (wideSer.match(/.{0,50}(bluefin|wintermute).{0,50}/i) || [])[0]);

    check("...and each of those twelve segments is refused at the unit level, " +
          "so the reason is the filter and not an accident of the walk",
        [`data-${CODE}`, `${CODE}-services`, `core.${CODE}`, `api_${CUST}`,
         `${CODE}s`, `data${CODE}`, `${CODE}data`, `${CUST}service`,
         `service${CUST}`, `${CODE}.js`, `${CODE}-adapter.js`, `${CUST}es.js`]
            .every(s => shape.safeSegment(s) === null),
        [`data${CODE}`, `${CODE}s`, `${CUST}service`]
            .map(s => [s, shape.safeSegment(s)]));

    check("...while the tree it was hiding in came back readable: the paths " +
          "built only from trade words kept their real names",
        wide.files.some(f => f.path === "src/file.js") &&
        wide.files.some(f => f.path === "package.json") &&
        wide.files.some(f => f.path === "dir/index.js"),
        wide.files.map(f => f.path));
}

{
    /* THE WIDENING IS REAL, not a comment claiming to have happened. A tree of
       twenty ordinary engineering names used to come back as twenty `file.js`. */
    const n = mkrepo();
    const ORDINARY = [
        "src/index.js", "src/server/router.js", "src/server/middleware/auth.js",
        "src/client/renderer.js", "src/client/components/toolbar.js",
        "lib/utils/text.js", "lib/utils/date.js", "lib/scheduler.js",
        "lib/migrations/index.js", "core/engine.js", "core/runtime.js",
        "core/sandbox.js", "backend/session-store.js", "backend/knowledge.js",
        "devtools/harness.js", "devtools/build-installer.js",
        "tests/integration/http-client.js", "tests/unit/parser.js",
        "docs/reference.md", "config/defaults.json"
    ];
    for (const p of ORDINARY) n.w(p, "module.exports={};\n");
    const ord = shape.survey(n.root);
    const kept = ord.files.filter(f => !/(^|\/)(dir|file)(\/|\.|$)/.test(f.path));

    check("A REPOSITORY MADE OF ORDINARY NAMES NOW READS AS ITSELF. Twenty " +
          "paths built from nothing but trade vocabulary; under the seventy-" +
          "word list nineteen of them came back as 'dir/file.js' and the " +
          "survey conveyed nothing. All twenty survive",
        kept.length === ORDINARY.length && ord.withheld.paths === 0,
        { kept: kept.length, of: ORDINARY.length,
          generalised: ord.files.filter(f => /(^|\/)(dir|file)(\/|\.|$)/.test(f.path))
                          .map(f => f.path) });

    check("...and the layering came with it, which is the whole point: the " +
          "stored tree has real directory names at real depths instead of a " +
          "flat list of 'dir'",
        ord.files.some(f => f.path === "src/server/middleware/auth.js") &&
        ord.files.some(f => f.path === "tests/integration/http-client.js"),
        ord.files.map(f => f.path).slice(0, 6));
}

check("THE VOCABULARY ITSELF IS HYGIENIC — every word in it is lowercase " +
      "letters and digits starting with a letter, at least two characters. A " +
      "content hash, a date, a mixed-case proper noun or an empty string " +
      "cannot have been pasted in among four hundred additions unnoticed",
    [...shape.COMMON].every(w => /^[a-z][a-z0-9]*$/.test(w) && w.length >= 2),
    [...shape.COMMON].filter(w => !/^[a-z][a-z0-9]*$/.test(w) || w.length < 2));

check("...and it holds none of the planted tokens, nor any word containing " +
      "one, which is the direct check that widening did not simply admit the " +
      "thing the byte search is looking for",
    [...shape.COMMON].every(w =>
        !/wintermute|acmecorp|bluefin|acme|dektol|darkroom/i.test(w)),
    [...shape.COMMON].filter(w => /wintermute|acmecorp|bluefin|acme|dektol|darkroom/i.test(w)));

check("THE PLURAL RULE CANNOT ADMIT A WORD THE LIST DOES NOT ALREADY HOLD. " +
      "'sessions' is 'session' and is kept; a codename with an s on the end " +
      "is still a codename",
    shape.commonWord("sessions") && shape.commonWord("runtimes") &&
    shape.commonWord("handlers") && !shape.commonWord("bluefins") &&
    !shape.commonWord("wintermutes") && !shape.commonWord("dektols"),
    ["sessions", "bluefins", "wintermutes"].map(w => [w, shape.commonWord(w)]));

check("THE CONCATENATION RULE NEEDS BOTH HALVES ALLOWLISTED AND FOUR " +
      "CHARACTERS EACH. 'devtools' and 'filesystem' are two trade words with " +
      "the dash left out; 'semindex', 'wintermute' and 'acmecorp' are not, " +
      "and the four-character floor is what stops a three-letter fragment " +
      "acting as universal glue",
    shape.compoundWord("filesystem") && shape.compoundWord("toolparse") &&
    shape.compoundWord("datastore") &&
    !shape.compoundWord("semindex") && !shape.compoundWord("wintermute") &&
    !shape.compoundWord("acmecorp") && !shape.compoundWord("bluefindata"),
    ["filesystem", "semindex", "wintermute", "acmecorp"]
        .map(w => [w, shape.compoundWord(w)]));

check("A CONTENT HASH IS NOT A NAME AND IS STILL GENERALISED, so a " +
      "content-addressed store does not publish its addresses",
    ["40749fa5de5d3f00", "a854a72b50a1f16e.json", "deadbeefcafe1234",
     "622f2bf7209ce36d.ps1", "2026-08-06", "v20260806"]
        .every(s => shape.safeSegment(s) === null),
    ["40749fa5de5d3f00", "a854a72b50a1f16e.json", "2026-08-06"]
        .map(s => [s, shape.safeSegment(s)]));

{
    /* ...and at the walk, not only at the unit, because that is where it
       matters: a content-addressed store is most of the operator's tree. */
    const h = mkrepo();
    h.w("data/knowledge/40749fa5de5d3f00.json", "{}\n");
    h.w("data/scripts/622f2bf7209ce36d.ps1", "Write-Output 1\n");
    h.w("data/index/a854a72b50a1f16e.json", "{}\n");
    h.w("src/index.js", "module.exports={};\n");
    const hs = shape.survey(h.root);
    check("...and no stored PATH carries a hash run either — the address is " +
          "gone from the tree, not merely from a unit test",
        !hs.files.some(f => /[0-9a-f]{8,}/i.test(f.path)) &&
        hs.files.some(f => f.path === "src/index.js") &&
        hs.files.filter(f => /file\.(json|ps1)$/.test(f.path)).length === 3,
        hs.files.map(f => f.path));
}

{
    /* THE FREQUENCY RULE, MEASURED AND REFUSED. "A word used by forty files is
       structural vocabulary, not a customer" — except that this is what forty
       files named after a customer look like, and no counting rule inside one
       tree can tell the two apart. Twelve independent naming decisions across
       five directories, which is more corroboration than most real trade words
       get, and the name still has to go. This check is the pin: anyone who
       later adds a frequency gate has to make this fail first. */
    const f = mkrepo();
    const CUST = "wintermute";
    f.w("package.json", JSON.stringify({ name: "many" }, null, 2));
    f.w(`src/${CUST}-adapter.js`, "module.exports={};\n");
    f.w(`src/${CUST}-routes.js`, "module.exports={};\n");
    f.w(`src/${CUST}-config.json`, "{}\n");
    f.w(`lib/${CUST}-client.js`, "module.exports={};\n");
    f.w(`lib/${CUST}-schema.json`, "{}\n");
    f.w(`tests/${CUST}.test.js`, "module.exports={};\n");
    f.w(`tests/${CUST}-integration.test.js`, "module.exports={};\n");
    f.w(`services/${CUST}/index.js`, "module.exports={};\n");
    f.w(`services/${CUST}-sync/index.js`, "module.exports={};\n");
    f.w(`docs/${CUST}.md`, "# notes\n");
    f.w(`docs/${CUST}-migration.md`, "# notes\n");
    f.w(`config/${CUST}.yml`, "a: 1\n");
    const many = shape.survey(f.root);
    const manySer = JSON.stringify(many);

    check("FREQUENCY IS NOT EVIDENCE. One customer name, twelve independent " +
          "naming decisions, five directories — more corroboration than a real " +
          "trade word usually gets — and it is still generalised everywhere. " +
          "A word this author uses often and a word every author uses often " +
          "look identical inside one tree; the difference lives in the other " +
          "repositories, which is what the allowlist is",
        !new RegExp(CUST, "i").test(manySer) &&
        many.withheld.paths === 12,
        { leak: (manySer.match(new RegExp(".{0,40}" + CUST + ".{0,40}", "i")) || [])[0],
          generalised: many.withheld.paths });

    check("...and the directories around it still read as themselves, so the " +
          "refusal costs the operator the name and nothing else",
        ["src/file.js", "lib/file.js", "tests/file.js", "docs/file.md",
         "config/file.yml"].every(p => many.files.some(f2 => f2.path === p)) &&
        many.files.some(f2 => f2.path === "services/dir/index.js"),
        many.files.map(f2 => f2.path));
}

/* =====================================================================
 * 11. "MEDIAN FILE 1 LINES" FOR A TREE AVERAGING NINETY-SIX
 *
 * The median was arithmetically right and descriptively false: 338 of 587
 * surveyed files really did hold one line, because 329 of them were shards of
 * a generated index — about 24 kB of JSON each, all on one line. A statistic
 * about how a person writes code was being answered by a program. Underneath
 * it, every line count in the survey was one too high, because splitting on
 * newlines counts the empty string after the last one.
 * =================================================================== */

check("A FILE THAT ENDS IN A NEWLINE DOES NOT HAVE AN EXTRA LINE IN IT. " +
      "Splitting says it does, and that put every line count in the survey " +
      "one over and inflated totalLines by one per file",
    shape.countLines("") === 0 && shape.countLines("a") === 1 &&
    shape.countLines("a\n") === 1 && shape.countLines("a\nb") === 2 &&
    shape.countLines("a\nb\n") === 2 && shape.countLines("a\r\nb\r\n") === 2 &&
    shape.countLines("\n") === 1 && shape.countLines("a\n\n") === 2,
    ["", "a", "a\n", "a\nb\n", "\n"].map(t => [JSON.stringify(t), shape.countLines(t)]));

{
    const m = mkrepo();
    /* Ten files a person wrote, a hundred lines each. */
    for (let i = 0; i < 10; i++) {
        m.w(`src/module${i}.js`, "// line\n".repeat(100));
    }
    /* Twenty shards a program wrote: one line, twenty-four kilobytes. */
    for (let i = 0; i < 20; i++) {
        m.w(`data/shard${i}.json`, JSON.stringify({ v: "x".repeat(24000) }));
    }
    const g = shape.survey(m.root);
    const raw = g.files.map(f => f.lines || 0).sort((a, b) => a - b);
    const rawMedian = raw[Math.floor(raw.length / 2)];

    check("THE MEDIAN DESCRIBES WHAT A PERSON WROTE. Ten hand-written " +
          "hundred-line modules and twenty single-line generated shards: the " +
          "median file is 100 lines, not the 1 that the whole population " +
          "reports and that the operator was shown",
        g.summary.sizeSpread.medianLines === 100 && rawMedian === 1,
        { reported: g.summary.sizeSpread, medianOverEverything: rawMedian });

    check("...and the shards are COUNTED rather than dropped, so the operator " +
          "can see the size of the population the statistic set aside",
        g.summary.sizeSpread.authoredFiles === 10 &&
        g.summary.sizeSpread.generatedFiles === 20,
        g.summary.sizeSpread);

    check("NOTHING WAS DELETED TO GET THAT NUMBER. All thirty files are still " +
          "walked, still counted in fileCount, still in byLanguage and still " +
          "in totalBytes and totalLines — one statistic changed its " +
          "population, no readout lost a file",
        g.summary.fileCount === 30 &&
        g.summary.byLanguage.javascript === 10 && g.summary.byLanguage.json === 20 &&
        g.summary.totalLines === 10 * 100 + 20 &&
        g.summary.totalBytes > 20 * 24000,
        { fileCount: g.summary.fileCount, byLanguage: g.summary.byLanguage,
          totalLines: g.summary.totalLines });

    check("...and every file carries the mark that says which population it " +
          "was in, rather than the split being invisible",
        g.files.filter(f => f.generated).length === 20 &&
        g.files.filter(f => !f.generated).length === 10 &&
        g.files.every(f => typeof f.generated === "boolean"),
        g.files.filter(f => f.generated).length);

    check("...and the line counts underneath are exact: a hundred '// line\\n' " +
          "lines is a hundred, not a hundred and one",
        g.files.filter(f => !f.generated).every(f => f.lines === 100),
        g.files.filter(f => !f.generated).map(f => f.lines));
}

{
    /* The discriminator is bytes per line, not the extension: a minified
       JavaScript bundle checked into a repository is the same problem. */
    const b = mkrepo();
    b.w("src/hand-written.js", "const a = 1;\n".repeat(50));
    b.w("src/index.js", "var x=" + JSON.stringify("y".repeat(30000)) + ";\n");
    const bo = shape.survey(b.root);

    check("THE TEST IS BYTES PER LINE, NOT THE FILE EXTENSION. A minified " +
          "JavaScript bundle is as generated as a JSON shard, and picking on " +
          "one language would have left the other in the median",
        bo.files.find(f => f.path === "src/index.js").generated === true &&
        bo.files.find(f => f.path === "src/file.js").generated === false &&
        bo.summary.sizeSpread.medianLines === 50,
        bo.files.map(f => [f.path, f.lines, f.generated]));

    check("...and ordinary prose and source sit well under the line: the " +
          "threshold is on a plateau, not a cliff edge",
        !shape.looksGenerated(4000, 100) && !shape.looksGenerated(39000, 100) &&
        shape.looksGenerated(40000, 100) && shape.looksGenerated(24815, 1) &&
        !shape.looksGenerated(24815, 0),
        shape.GENERATED_BYTES_PER_LINE);
}

/* =====================================================================
 * 12. "NO MANIFEST" FOR A TREE HOLDING app/package.json
 *
 * Discovery read the root directory and stopped. The operator's tree keeps its
 * application one level down, so the survey told him "public packages kept:
 * none — no manifest" while a hundred and fifty kilobytes of lockfile sat in
 * app/. Every dependency fact the survey exists to report was missing.
 * =================================================================== */
{
    const d = mkrepo();
    /* No root manifest at all — the manifest and its lockfile are one level
       down, in a directory whose name is a codename. */
    d.w("app/package.json", JSON.stringify({
        name: "inner",
        dependencies: { express: "^4" },
        devDependencies: { lodash: "^4", [SECRETS.privatePlainDep]: "^1" }
    }, null, 2));
    d.w("app/package-lock.json", JSON.stringify({
        name: "inner", lockfileVersion: 3,
        packages: {
            "node_modules/express": { version: "4.18.2", resolved: NPM_TARBALL_HOST + "/express/-/express-4.18.2.tgz" },
            "node_modules/lodash": { version: "4.17.21", resolved: NPM_TARBALL_HOST + "/lodash/-/lodash-4.17.21.tgz" }
        }
    }, null, 2));
    d.w("app/src/index.js", `const express = require("express");\nmodule.exports={};\n`);
    d.w(`${SECRETS.dottedDir}/index.js`, `const _ = require("lodash");\nmodule.exports={};\n`);
    /* A dependency's own manifest, which must never be mistaken for the
       project's — this is what the build-directory skip is protecting. */
    d.w("app/node_modules/leftpad/package.json",
        JSON.stringify({ name: "leftpad", dependencies: { [SECRETS.gitDep]: "^9" } }, null, 2));

    const nested = shape.survey(d.root);
    const nestedSer = JSON.stringify(nested);

    check("MANIFEST DISCOVERY SEARCHES THE TREE. A project whose package.json " +
          "and lockfile sit one directory down reported 'no manifest' and " +
          "published no dependency at all. Both are found, and the packages " +
          "the lockfile proves public come back",
        nested.summary.publicDependencies.some(x => x.name === "express") &&
        nested.summary.publicDependencies.some(x => x.name === "lodash"),
        nested.summary.publicDependencies);

    check("...and the operator is told how many manifests and lockfiles were " +
          "found, as counts, so 'none' can be read as 'none found' rather " +
          "than guessed at",
        nested.summary.manifests.found === 1 && nested.summary.manifests.lockfiles === 1,
        nested.summary.manifests);

    check("...and a dependency's OWN manifest inside node_modules is not the " +
          "project's. The depth search skips build directories exactly as the " +
          "file walk does, or every transitive package would be declared here",
        !nestedSer.includes(SECRETS.gitDep) &&
        nested.summary.publicDependencies.length === 2,
        nested.summary.publicDependencies);

    check("...and the two gates still hold at depth: the private-registry " +
          "package in the nested manifest is counted as withheld, never named",
        nested.withheld.dependencies === 1 &&
        !/acme-private|wintermute|acmecorp/i.test(nestedSer),
        nested.withheld);

    check("...and the manifest's own DIRECTORY NAME never rides out with the " +
          "discovery. Finding a file somewhere is not permission to say where",
        !/acmecorp|wintermute/i.test(nestedSer) &&
        nested.files.some(f => f.path === "dir/index.js"),
        nested.files.map(f => f.path));

    check("...and the search is bounded rather than unbounded — findManifestDirs " +
          "reports the directories it found, and a manifest buried below the " +
          "depth limit is simply not found instead of the walk running away",
        (() => {
            const deep = mkrepo();
            deep.w("a/b/c/d/e/package.json", JSON.stringify({ name: "deep" }));
            const found = shape.findManifestDirs(deep.root, { maxDepth: 3 });
            const wide = shape.findManifestDirs(deep.root, { maxDepth: 6 });
            return found.manifests.length === 0 && wide.manifests.length === 1;
        })());
}

for (const dir of MADE) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6 }); } catch { /* held */ }
}
console.log(`\n${pass}/${pass + fail} repo-shape checks passed`);
process.exit(fail ? 1 : 0);
