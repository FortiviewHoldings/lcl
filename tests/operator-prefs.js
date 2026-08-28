/**
 * OPERATOR PREFERENCES — the imported memory, wired into answers.
 *
 * The purpose of importing training data is for the model to apply the user's
 * stated presentation preferences at inference — which was not happening.
 *
 * Measured: Import Training Data staged the memory for a FUTURE LoRA and
 * nothing at inference read it. These tests pin the wire that closes that:
 * feedback and user notes distilled into a prompt block, frontmatter
 * description first, bounded, and gated to remote models exactly like
 * tailoring. Plus the two prompt defects found in the same session: the
 * effort slider clobbering answerLike with a UI joke, and effort itself
 * having no honest voice.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-prefs-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => LCL_TEST_DATA }
} };

const paths = require(__dirname + "/../.lcl.engine/core/paths.js");
const prefs = require(__dirname + "/../.lcl.engine/core/operatorPrefs.js");
const agent = require(__dirname + "/../.lcl.engine/core/agent.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}

// ---- fixture: a staged import the shape trainingSync actually writes ----
const T = path.join(paths.dataDir(), "training", "test-memory");
fs.mkdirSync(T, { recursive: true });
fs.writeFileSync(path.join(T, "feedback_short_chat.md"),
    "---\nname: feedback-short-chat\ndescription: Chat replies must be sparse; " +
    "substance goes in markdown files\nmetadata: \n  type: feedback\n---\n\nbody prose\n");
fs.writeFileSync(path.join(T, "user_role.md"),
    "---\nname: user-role\ndescription: \"Backend web developer; retro dark theme\"\n---\n\nbody\n");
fs.writeFileSync(path.join(T, "feedback_no_frontmatter.md"),
    "# Verbatim over paraphrase\n\n- Quote requested content word for word\n- Never compress lists\n");
fs.writeFileSync(path.join(T, "project_secret_thing.md"),
    "---\nname: project-secret\ndescription: CONFIDENTIAL project detail that must not ride prompts\n---\n\nbody\n");

prefs.reset();
const block = prefs.promptBlock();

check("the block exists and announces itself as the user's own preferences",
    /OPERATOR PREFERENCES/.test(block), block.slice(0, 80));
check("a frontmatter note is distilled through its description line",
    /sparse; substance goes in markdown files/.test(block), block);
check("...with quotes stripped from a quoted description",
    /Backend web developer; retro dark theme/.test(block));
check("a no-frontmatter note falls back to its title + rule bullets",
    /Verbatim over paraphrase: Quote requested content word for word/.test(block));
check("user_* notes lead the block (who they are frames the feedback)",
    block.indexOf("user role") < block.indexOf("feedback") || block.indexOf("Backend") < block.indexOf("sparse"));
check("project_* notes NEVER ride the prompt — recall material is not a preference",
    !/CONFIDENTIAL/.test(block) && !/project secret/.test(block), block);
check("the block is bounded", block.length <= prefs.MAX_BLOCK_CHARS + 400, block.length);

// ---- the privacy gate mirrors tailoring exactly ----
const localSession = { id: "s1", perms: {} };
check("a LOCAL turn always carries the preferences",
    /OPERATOR PREFERENCES/.test(agent.prefsBlockFor(localSession, null)));
const remoteSel = { id: "ep1", baseUrl: "https://api.example.com/v1", model: "m" };
check("a REMOTE turn without the tailoring permission carries NOTHING — a " +
      "profile of the operator does not reach a third party un-granted",
    agent.prefsBlockFor(localSession, remoteSel) === "");
check("...and WITH the permission it rides, same as the learned profile",
    /OPERATOR PREFERENCES/.test(
        agent.prefsBlockFor({ id: "s2", perms: { tailoring: true } }, remoteSel)));

// ---- BUT the operator's OWN node is not a third party ----
// Measured: a session driven on the operator's Spark got NONE of their imported
// standards, because a node reached over HTTP was gated like an API. It is
// their hardware; sending their standards there is the whole point.
const nodeSel = { id: "n1", baseUrl: "http://100.79.28.63:8000/v1",
                  model: "gpt-oss-120b", localNode: true };
check("the operator's OWN node carries the preferences WITHOUT the tailoring " +
      "permission — standards on hardware you own are not a leak",
    /OPERATOR PREFERENCES/.test(agent.prefsBlockFor(localSession, nodeSel)));
const nodeSel2 = { id: "n2", baseUrl: "http://10.0.0.9:8000/v1", model: "m",
                   node: { id: "n-abc", name: "fleet" } };
check("...a node identified by node.id (no localNode flag) is owned too, not third-party",
    /OPERATOR PREFERENCES/.test(agent.prefsBlockFor(localSession, nodeSel2)));
check("...yet a genuine third-party API is STILL withheld un-granted (the gate stands)",
    agent.prefsBlockFor(localSession, remoteSel) === "");

// ---- staleness: an edited note reaches the next build ----
prefs.reset();
fs.writeFileSync(path.join(T, "feedback_short_chat.md"),
    "---\nname: feedback-short-chat\ndescription: UPDATED preference text\n---\n\nbody\n");
check("an edited note reaches the block after reset (mtime-stamped cache)",
    /UPDATED preference text/.test(prefs.promptBlock()));

// ---- #3: TYPE decides, not the filename; #2: the rule is not gutted to one line ----
prefs.reset();
// a rule the operator wrote under a NON-standard name, declared by frontmatter
fs.writeFileSync(path.join(T, "cameron-comm-style.md"),
    "---\nname: cameron-comm-style\ndescription: One closing summary per turn; no running commentary\n" +
    "metadata:\n  type: feedback\n---\n\n- **No running commentary.** Do not narrate between tasks\n");
// looks like a standard, but declared project → recall material, stays OUT
fs.writeFileSync(path.join(T, "drawing-standard.md"),
    "---\nname: drawing-standard\ndescription: OMNI-NNN numbering and the shared KiCad title block\n" +
    "metadata:\n  type: project\n---\n\nbody\n");
// a rich feedback note whose actionable specific lives in a How-to-apply line
fs.writeFileSync(path.join(T, "feedback_fix_callers.md"),
    "---\nname: feedback_fix_callers\ndescription: Fixing logic in one spot is forbidden — fix every caller\n" +
    "metadata:\n  type: feedback\n---\n\nStory prose that is NOT the rule and must not ride.\n" +
    "**Why:** point fixes turn every patch into whack-a-mole.\n" +
    "**How to apply:** map every reader of the value and fix them all in the same pass\n");
const block2 = prefs.promptBlock({ maxBlockChars: 9000 });

check("#3 a rule under a NON-feedback_ filename RIDES because its type is feedback",
    /One closing summary per turn/.test(block2), block2);
check("#3 a note declared type:project stays OUT even with standards-shaped content",
    !/OMNI-NNN/.test(block2) && !/KiCad/.test(block2), block2);
check("#2 the actionable specific rides as a second line, VERBATIM (not gutted to the headline)",
    /map every reader of the value and fix them all in the same pass/.test(block2), block2);
check("#2 war-story prose is NOT mistaken for the rule",
    !/whack-a-mole/.test(block2) && !/Story prose that is NOT/.test(block2), block2);

// ---- the block is window-scaled, and the budget-keyed cache does not bleed ----
prefs.reset();
const wide = prefs.promptBlock({ maxBlockChars: 9000 });
const tight = prefs.promptBlock({ maxBlockChars: 300 });   // SAME install, no reset
check("a wide budget carries more of the operator's rules than a tight one",
    wide.length > tight.length
    && (wide.match(/\n- /g) || []).length > (tight.match(/\n- /g) || []).length,
    { wide: wide.length, tight: tight.length });
check("the budget-keyed cache returns the right size per budget (no cross-budget bleed)",
    wide !== tight);

/* ---- the effort slider must never clobber the persona again ---- */
const rendererSrc = fs.readFileSync(__dirname + "/../app/renderer/app.js", "utf8");
check("the effort slider's change handler no longer writes answerLike — the " +
      "Kardashev joke rode every prompt as a standing attitude order",
    !/setSessionAnswerLike\(active\.id, instruction\)/.test(rendererSrc)
    && /NEVER through answerLike/.test(rendererSrc));
check("slider residue in existing sessions is ignored, not obeyed",
    agent.answerLikeBlock({ answerLike:
        "Reasoning effort: Multiversal (Kardashev V). Pulls flawless code " +
        "from an alternate reality where your project has zero legacy tech debt." }) === "");
check("...while a real persona still speaks",
    /direct, no overpromising/.test(agent.answerLikeBlock({ answerLike: "direct, no overpromising" })));

/* ---- effort has its own honest voice now ---- */
check("effortBlock speaks plainly per level and stays silent at default",
    agent.effortBlock({ effortLevel: 0 }) === ""
    && /maximum — take the time to be thorough/.test(agent.effortBlock({ effortLevel: 4 }))
    && /modest/.test(agent.effortBlock({ effortLevel: 1 })));
const agentSrc = fs.readFileSync(__dirname + "/../.lcl.engine/core/agent.js", "utf8");
check("...and it is joined into BOTH prompt assemblies, beside answerLike",
    (agentSrc.match(/\+ effortBlock\(session\)/g) || []).length >= 2);
check("...as is the preferences block, beside tailoring",
    (agentSrc.match(/\+ prefsBlockFor\(session, (sel|target)\)/g) || []).length >= 2);
check("tailoring and preferences share ONE owned-node gate (they can't drift), " +
      "and it exempts the operator's node via isNodeEndpoint",
    /function profileWithheldFrom\(session, sel\)/.test(agentSrc)
    && /cloudModels\.isNodeEndpoint\(sel\)/.test(agentSrc)
    && (agentSrc.match(/profileWithheldFrom\(session, sel\)/g) || []).length >= 2);
check("prefsBlockFor scales the standards budget to the model's context window",
    /LIMITS\(sel\)/.test(agentSrc) && /maxBlockChars: budget/.test(agentSrc)
    && /win >= 100_?000/.test(agentSrc));

fs.rmSync(LCL_TEST_DATA, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
console.log(`\n${pass}/${pass + fail} operator-prefs checks passed`);
process.exit(fail ? 1 : 0);
