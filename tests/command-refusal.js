/**
 * Regression: two node-session failures reported live against gpt-oss-120b on
 * the operator's Spark, read straight out of the session logs.
 *
 *  1. "can you clone this repository https://github.com/.../PragOptics.git"
 *     came back "I can't run git here, but I can download a ZIP" — a refusal
 *     plus a wrong workaround (the repo is private; the archive URL 404s).
 *     run_script does not execute, it PROPOSES a script the user approves, so
 *     there is nothing to refuse. A correction now forces the run_script call,
 *     the same way the image and site-build refusals are corrected.
 *
 *  2. The "spent its whole reply thinking, twice" message flooded those
 *     sessions while board_identify / backup_firmware / serve_folder calls
 *     silently vanished: the all-thinking retry ran BEFORE the native-call
 *     parse and misread a normal gpt-oss tool turn (empty content + reasoning
 *     + a structured tool_call) as an empty reply, discarding the call. The
 *     retry now only fires when there is NO pending tool call.
 *
 * Pure detector/guard tests: they pin the SHIPPING logic in agent.js without a
 * model, by slicing the live branch so a copy cannot drift from it.
 */
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../.lcl.engine/core/agent.js", "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 180) : ""); }
}

/* ---------- 1. the command-refusal correction ---------- */
const branch = src.slice(
    src.indexOf("// A COMMAND THE MODEL REFUSED INSTEAD OF PROPOSING"),
    src.indexOf('accept: (t) => t === "run_script"') + 40);
check("found the command-refusal branch in agent.js", branch.length > 200, branch.length);

// the five live regexes, in source order:
//   0 command subject (userText)   1 directive (userText)
//   2 question-negative (userText) 3 refusal (reply)  4 guide (reply)
const reSrc = [...branch.matchAll(/\/\\b\((?:[^/\\]|\\.)+\)\\b\/i/g)].map(m => m[0]);
// the FIVE trigger regexes come first, in order; the branch body may add more
// (e.g. an isClone check that routes a clone to git_clone), so allow >= 5
check("found the command-refusal trigger regexes", reSrc.length >= 5, reSrc.length);
const mk = (s) => new RegExp(s.slice(1, s.lastIndexOf("/")), "i");
const [subjectRe, directiveRe, questionRe, refusalRe, guideRe] = reSrc.map(mk);

const triggers = (userText, reply) =>
    subjectRe.test(userText) && directiveRe.test(userText) && !questionRe.test(userText) &&
    (refusalRe.test(reply) || guideRe.test(reply));

// ---- MUST trigger: the reported failure, verbatim ----
check("triggers on the REPORTED clone refusal",
    triggers("can you clone this repository https://github.com/example/sample-repo.git",
        "I can't run git here, but I can download the repository as a ZIP file and save it in the workspace."));
check("triggers on the retry phrasing",
    triggers("please try to clone it again into this folder",
        "We could download it as a ZIP instead since I can't run git."));

const mustTrigger = [
    ["can you clone the repo into this folder", "I cannot clone repositories — git isn't available here."],
    ["please install numpy and run it again", "You should install numpy yourself with pip first."],
    ["go ahead and pip install pillow", "I don't have the ability to install packages."],
    ["try again, npm install then build", "That isn't possible here; you can run npm install locally."],
    // polite refusals a strong model actually uses (the false-negative the
    // verification caught: none of the old refusal words matched these)
    ["please clone this repo for me", "I'm sorry, but accessing external Git repositories isn't something I'm set up to do right now."],
    ["can you clone this repo", "That's outside of what I can do from here."],
];
for (const [ask, reply] of mustTrigger)
    check(`triggers: "${ask.slice(0, 34)}..."`, triggers(ask, reply), reply);

// ---- MUST NOT trigger: how-to questions, real answers, unrelated talk ----
const mustNot = [
    // a how-to question deserves the prose the model wrote
    ["how do I clone this repository?", "You can run `git clone <url>` in a terminal on your machine."],
    ["what's the best way to install numpy?", "You could use pip: pip install numpy."],
    ["explain how git clone works", "git clone copies a remote repository, including its history."],
    // decision/explanation questions that contain the directive words but want
    // an ANSWER, not a forced script (the false-positives the verification caught)
    ["Should I clone this repo with SSH or HTTPS?", "You should use SSH if you have keys set up; otherwise HTTPS is fine."],
    ["Why can't I just clone this repo directly?", "You can't because it's private — here's how to authenticate first."],
    // the command actually got proposed / done (no refusal, no guide words)
    ["clone this repo", "Prepared a script that runs git clone into the workspace for your approval."],
    // unrelated request that happens to mention a tool word
    ["what does this build script do?", "It compiles the sketch and flashes it to the board."],
];
for (const [ask, reply] of mustNot)
    check(`does NOT trigger: "${ask.slice(0, 34)}..."`, !triggers(ask, reply), reply);

// a clone routes to the first-class git_clone tool (real credentials apply);
// everything else (install/build) is a run_script — never a bare write_file
check("correction routes a clone to git_clone and other commands to run_script",
    /accept: \(t\) => t === "git_clone"/.test(branch)
    && /accept: \(t\) => t === "run_script"/.test(branch));
check("correction tells the model run_script does NOT execute",
    /run_script does NOT execute/i.test(branch) && /PROPOSES a script/i.test(branch));

/* ---------- 2. the all-thinking guard against native tool calls ---------- */
const guardBlock = src.slice(
    src.indexOf("// THE ALL-THINKING REPLY"),
    src.indexOf("A TOOL CALL CUT IN HALF"));
check("all-thinking retry is guarded by a pending-call check",
    /const hasPendingCall = Array\.isArray\(result\.toolCalls\)/.test(guardBlock)
    && /result\.toolCalls\.some\(t => t && t\.name\)/.test(guardBlock));
check("the retry condition requires NO pending call",
    /reasoningSeen > 0\s*&&\s*!hasPendingCall/.test(guardBlock.replace(/\s+/g, " "))
    || /!hasPendingCall/.test(guardBlock));
// the all-thinking RETRY itself must be native-aware and cancel/error-aware,
// or a retry that answers with a native call is discarded into the canned text
check("all-thinking retry adopts a native call from the retry",
    /const directCall = Array\.isArray\(direct\.toolCalls\)/.test(guardBlock)
    && /result\.toolCalls = direct\.toolCalls/.test(guardBlock));
check("all-thinking retry does not file the canned message on cancel/error",
    /direct\.error === "cancelled"/.test(guardBlock)
    && /else if \(!direct\.error\)/.test(guardBlock));

/* ---------- 3. the correction retry is native-aware and safe ---------- */
const retryBlock = src.slice(
    src.indexOf("if (correction) {"),
    src.indexOf("// CLARIFY is a way of REPLYING"));
check("correction retry reads native tool_calls, not only text",
    /forced\.toolCalls\.filter\(t => t && t\.name\)/.test(retryBlock)
    && /native: true/.test(retryBlock));
check("correction retry rejects an empty/unparseable run_script (no no-op proposal)",
    /emptyScript/.test(retryBlock)
    && /run_script/.test(retryBlock) && /a\.script \|\| a\.command/.test(retryBlock));
check("correction retry queues the extra forced calls instead of dropping them",
    /namedForced\.length > 1/.test(retryBlock) && /NOT run/.test(retryBlock));

/* ---------- 3b. the clone-verify rabbit-hole interceptor ---------- */
// Asked to clone, gpt-oss fetched/web-searched to "verify" the repo instead of
// proposing the clone; a private repo 404s anonymously, so it declared the repo
// unreachable. This redirects a verification call to a run_script proposal, and
// recovers the git URL from history when the follow-up ("try cloning again")
// carries none.
const cvBlock = src.slice(
    src.indexOf("// THE CLONE-VERIFY RABBIT HOLE"),
    src.indexOf("if (correction) {", src.indexOf("// THE CLONE-VERIFY RABBIT HOLE")));
check("clone-verify interceptor fires on a verification tool, not on run_script",
    /\["http_fetch", "web_search", "fetch", "fetch_url", "open_url"\]\.includes\(String\(call\.tool\)\)/.test(cvBlock));
check("clone-verify interceptor recovers the git URL from recent history",
    /working\.length - 8/.test(cvBlock) && /w\.role === "user"/.test(cvBlock) && /isRepoUrl/.test(cvBlock));
check("clone-verify interceptor forces run_script with the exact URL",
    /accept: \(t\) => t === "run_script"/.test(cvBlock)
    && /git clone " \+ cloneUrl/.test(cvBlock));
check("clone-verify interceptor only fires when it did NOT already have a refusal correction",
    /!correction && call && steps === 0/.test(cvBlock));

/* ---------- 4. the node reply-floor early refusal ---------- */
const floorBlock = src.slice(
    src.indexOf("A NODE REASONER NEEDS ROOM"),
    src.indexOf("A NODE REASONER NEEDS ROOM") + 1500);
check("a node turn with too little reply room refuses early with guidance",
    /NODE_REPLY_FLOOR/.test(floorBlock)
    && /isNodeEndpoint/.test(floorBlock)
    && /come back empty/i.test(floorBlock));

console.log(`\n${pass}/${pass + fail} command-refusal checks passed`);
process.exit(fail ? 1 : 0);
