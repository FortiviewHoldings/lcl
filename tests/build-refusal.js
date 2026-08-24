/**
 * Regression: the model must never refuse — or merely NARRATE — a build task
 * it is fully equipped for.
 *
 * Reported verbatim: asked to "turn this folder into a static site to advertise
 * yourself", a 4B answered "I can't ... that would require web development
 * tools and server access, which aren't available here." A static site is just
 * files write_file creates. The second failure mode found while fixing it was
 * the model replying with a step-by-step GUIDE instead of writing anything.
 *
 * These are pure detector tests: they pin the trigger logic (including the
 * false-positive guards) without needing a model. The end-to-end proof lives
 * in scratchpad/test-buildsite.py, which drives the real 4B.
 */
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => require("os").tmpdir() },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../.lcl.engine/core/agent.js", "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 160) : ""); }
}

// Pull the three live regexes out of the build-correction branch so the test
// pins the SHIPPING patterns, not a copy that can drift.
const branch = src.slice(src.indexOf("// A BUILD request the model refused"),
                        src.indexOf("described the work instead of doing it") + 200);
const reSrc = [...branch.matchAll(/\/\\b\((?:[^/\\]|\\.)+\)\\b\/i/g)].map(m => m[0]);
check("found the build-detector regexes in agent.js", reSrc.length >= 3, reSrc.length);

const mk = (s) => new RegExp(s.slice(1, s.lastIndexOf("/")), "i");
const [subjectRe, verbRe, refusalRe] = reSrc.slice(0, 3).map(mk);
// the narration alternative is a separate literal in the same branch
const narrationRe = (() => {
    const m = branch.match(/\/\\b\(step\[- \]by\[- \]step[\s\S]*?\)\\b\/i/);
    return m ? mk(m[0]) : null;
})();
check("found the narration detector", !!narrationRe);

const triggers = (userText, reply) =>
    subjectRe.test(userText) && verbRe.test(userText) &&
    (refusalRe.test(reply) || (narrationRe && narrationRe.test(reply)));

// ---- MUST trigger: the reported failure, verbatim ----
const reported = "I can't turn a folder into a static site to advertise myself, as that " +
    "would require web development tools and server access, which aren't available here.";
check("triggers on the REPORTED refusal",
    triggers("please turn this folder into a static site to advertise yourself", reported));

check("triggers on the narration failure",
    triggers("please turn this folder into a static site to advertise yourself",
        "To turn the folder into a static site, here's a step-by-step guide: First, create index.html..."));

const otherRefusals = [
    ["build me a landing page here", "I cannot build a landing page without a web server."],
    ["create a portfolio site in this folder", "That requires hosting tools I don't have."],
    ["make a dashboard page", "You should first set up a build system — here's how."],
    ["turn this into a blog", "I'm unable to do that; it needs a static site generator."]
];
for (const [ask, reply] of otherRefusals) {
    check(`triggers: "${ask.slice(0, 32)}..."`, triggers(ask, reply), reply);
}

// ---- MUST NOT trigger: real work, real answers, unrelated talk ----
const innocent = [
    // a successful build recap (no refusal/narration words)
    ["build me a site", "Created index.html with a header, three feature cards and a footer."],
    // a genuine question about sites that is not a build request
    ["what is a static site?", "A static site is HTML and CSS served as-is, with no backend."],
    // a build request answered by actually doing it
    ["create a page about cats", "index.html now contains the cat page you asked for."],
    // discussion of an app that is not a build instruction
    ["explain how this app works", "It runs a local model and calls tools you approve."],
    // refusal language about something genuinely out of scope
    ["email this report to my boss", "I can't send email — I have no network access."]
];
for (const [ask, reply] of innocent) {
    check(`does NOT trigger: "${ask.slice(0, 34)}..."`, !triggers(ask, reply), reply);
}

// ---- the capability assertion must be in the shipping prompt ----
check("prompt asserts building is just files",
    /a static site is index\.html plus/i.test(src) &&
    /NEVER refuse a build request/i.test(src));

console.log(`\n${pass}/${pass + fail} build-refusal checks passed`);
process.exit(fail ? 1 : 0);
