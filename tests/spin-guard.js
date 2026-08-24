/**
 * THE MODEL DOES NOT GET TO GRIND FOREVER WHILE THE AUDITOR WAITS.
 *
 * This suite is a replay of a real failure, taken from the user's own
 * session record (`what can you do`, objective 1, `stopped: "cancelled"`,
 * 43 minutes elapsed), not from a hypothesis:
 *
 *   msg 83   Ancient Knowledge round 1: gaps. Forces a response.
 *   msg 86   The model writes a confident summary — "Created `index.html`
 *            File ... Used `write_file` ... Successfully created" — having
 *            called no such tool. A fabrication.
 *   msg 87   Ancient Knowledge round 2 catches it exactly: "No evidence of
 *            file creation for `index.html` or image generation for
 *            `sunset.png`; changes not reflected in files." The auditor works.
 *   msg 89   The forced round generates sunset.png for real. 426,918 bytes.
 *   msg 90-119  The model then calls `list_files` FIFTEEN times in a row with
 *            identical arguments, gets the identical three-entry result every
 *            time, writes the identical paragraph promising to create
 *            index.html, and never calls write_file. index.html never exists.
 *   msg 120  The operator presses Stop.
 *
 * In the operator's words: "the model did not actually do what it said ...
 * ancient knowledge did not continue to audit and respond, it just stopped ...
 * the model ran away unguided".
 *
 * The mechanism: the step loop's only bound was `maxSteps` (64 on a node), and
 * Ancient Knowledge cannot audit again until that loop RETURNS. So a model
 * spinning inside a forced round silences the auditor completely — the exact
 * inversion of what the feature is for.
 *
 * A spin is defined narrowly on purpose: same tool, same arguments, same
 * output, AND no file changed in between. The checks below prove it catches
 * the real case, prove it does NOT fire on legitimate repetition, and prove
 * the loop hands back to the auditor with the truth on the record rather than
 * with the model's fabricated summary.
 */
const os = require("os");
const path = require("path");
const fs = require("fs");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
process.resourcesPath = path.join(__dirname, "..");
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-spin-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false,
                   encryptString: (s) => Buffer.from(String(s)),
                   decryptString: (b) => Buffer.from(b).toString() }
} };

const CORE = path.join(__dirname, "..", ".lcl.engine", "core");
const ROUTER_PATH = require.resolve(path.join(CORE, "router.js"));
const routerStub = {
    reply: () => ({ content: "" }), calls: [], audits: [],
    generate: async (messages, maxTokens, cancelToken, onToken, opts) => {
        routerStub.calls.push({ messages, opts });
        const sys = String((messages[0] && messages[0].content) || "");
        if (/Ancient Knowledge overseer/.test(sys)) {
            const n = routerStub.audits.shift();
            return { content: n === undefined ? "" : n };
        }
        return routerStub.reply(routerStub.calls.length, messages);
    },
    // 64 is the real node budget — the one the fifteen calls sailed through
    limits: () => ({ kind: "remote", label: "stub-node", maxSteps: 64,
                     maxTokens: 4096, historyWindow: 24, toolResultCap: 6000 }),
    resolveSelection: () => ({ sel: null }),
    usingRemote: () => false,
    activeModel: () => "stub-model"
};
require.cache[ROUTER_PATH] = { id: ROUTER_PATH, filename: ROUTER_PATH,
    loaded: true, exports: routerStub };

const ak = require(path.join(CORE, "ancientKnowledge.js"));
const agent = require(path.join(CORE, "agent.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

function makeSession(extra = {}) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-spin-repo-"));
    return { id: "ses-" + Math.random().toString(36).slice(2, 10),
             title: "spin", messages: [], changes: [],
             effortLevel: 0, repoPath: repo, ...extra };
}
const toolCalls = (msgs) => msgs.filter(m => m.role === "tool");

/* The exact paragraph the model repeated, verbatim in shape: prose promising
 * the work, plus a list_files call that changes nothing. */
const SPIN_REPLY = () => ({ content:
    "To create a simple HTML page and generate an image using the available " +
    "tools:\n1. **Create `index.html` File:**\n2. **Generate an Image:**\n" +
    "3. **Verify Files (Optional):**\n" +
    '```tool\n{"tool":"list_files","args":{"path":"."}}\n```' });

(async () => {

/* ============ THE REPLAY: fifteen identical calls become four ============ */
{
    const s = makeSession();
    routerStub.calls = [];
    routerStub.reply = SPIN_REPLY;
    const events = [];
    const res = await agent.runTurn(s, "what can you do", {
        selection: null, cancelToken: { cancelled: false },
        onProgress: (ev) => events.push({ phase: ev.phase, d: ev.detail || {} })
    });

    check("the turn still completes — a spin is stopped, not crashed",
        res.ok === true, res && res.error);
    const tools = toolCalls(res.newMessages);
    check("THE SPIN IS CUT SHORT. Fifteen identical list_files calls got through " +
          "before, because the only bound was maxSteps=64 on a node",
        tools.length <= 4, tools.length);
    check("...and it is cut short by the SPIN guard, not by the step ceiling — " +
          "the ceiling was never the thing that would have saved this turn",
        !res.newMessages.some(m => m.meta && m.meta.stoppedAtLimit),
        res.newMessages.filter(m => m.meta && m.meta.stoppedAtLimit).length);
    check("the model is corrected ONCE before the loop is ended — models often " +
          "break out when told plainly, and one nudge is cheaper than a turn",
        events.some(e => e.phase === "spin-warned"),
        events.map(e => e.phase));
    check("...and the correction names the tool it must stop calling, not a " +
          "vague 'try something else' — vagueness is what produced the loop",
        routerStub.calls.some(c => c.messages.some(m =>
            m.role === "user" && /Do not call `list_files` again/.test(m.content))),
        null);
    check("the loop then ENDS, and says so",
        events.some(e => e.phase === "spin-stopped"), events.map(e => e.phase));

    const stuck = res.newMessages.find(m => m.meta && m.meta.spin);
    check("THE TURN ADMITS THE SPIN IN THE MODEL'S PLACE. The transcript ended " +
          "on a fabricated 'Successfully created' summary before; the last word " +
          "now is what actually happened",
        !!stuck && /called `list_files`/.test(stuck.content)
        && /changed nothing/.test(stuck.content), stuck && stuck.content);
    check("...and it names the repeat count, so the operator can see the shape " +
          "of it without reading the whole transcript",
        !!stuck && stuck.meta.spin.repeats >= 4 && stuck.meta.spin.tool === "list_files",
        stuck && stuck.meta.spin);
    check("...and that admission is the LAST assistant message, which is what " +
          "Ancient Knowledge interrogates — the auditor is handed the truth " +
          "instead of a fabrication to see through",
        (() => {
            const last = [...res.newMessages].reverse()
                .find(m => m.role === "assistant");
            return last && last.meta && last.meta.spin;
        })(), null);
}

/* ================= AND THE AUDITOR GETS ITS TURN BACK =================== */
{
    const s = makeSession({ ancientKnowledge: true, effortLevel: 1 }); // 3 rounds
    routerStub.calls = [];
    routerStub.audits = ["VERDICT: GAPS\nGAP: index.html was never written",
                         "VERDICT: GAPS\nGAP: index.html is still not there"];
    routerStub.reply = SPIN_REPLY;
    const res = await agent.runTurn(s, "make me an index.html", {
        selection: null, cancelToken: { cancelled: false } });

    const audits = res.newMessages.filter(
        m => m.meta && m.meta.model === "ancient-knowledge");
    check("ANCIENT KNOWLEDGE STILL AUDITS AFTER A SPIN. It could not before: " +
          "the auditor only gets control when the step loop returns, and a " +
          "spinning model never let it return",
        audits.length >= 1, audits.length);
    check("...and it audits MORE THAN ONCE — the operator's session died with " +
          "round 2 as the last thing that ever happened",
        audits.length >= 2, audits.map(m => m.meta.round));
    check("THE FORCED ROUND AFTER A SPIN FORBIDS THE TOOL BY NAME. Re-forcing " +
          "with the same generic 'do it now' is an invitation to grind the " +
          "same call another fifteen times",
        routerStub.calls.some(c => c.messages.some(m =>
            m.role === "user" && /Ancient Knowledge audit/.test(String(m.content))
            && /Do NOT call `list_files` again/.test(String(m.content)))),
        null);
    check("...and it demands the tool that does the work on the FIRST step",
        routerStub.calls.some(c => c.messages.some(m =>
            m.role === "user" && /performs the work/.test(String(m.content))
            && /FIRST step/.test(String(m.content)))), null);
}

/* ============== IT DOES NOT FIRE ON LEGITIMATE REPETITION =============== */
{
    // Same tool, DIFFERENT arguments — a model walking a directory tree, or
    // reading a large file in slices, must not be accused of spinning.
    const s = makeSession();
    let n = 0;
    routerStub.calls = [];
    routerStub.reply = () => {
        n++;
        if (n > 6) return { content: "Done reading." };
        return { content: `Reading part ${n}.\n` +
            '```tool\n{"tool":"list_files","args":{"path":"sub' + n + '"}}\n```' };
    };
    const res = await agent.runTurn(s, "walk the tree", {
        selection: null, cancelToken: { cancelled: false } });
    check("SAME TOOL WITH DIFFERENT ARGUMENTS IS NOT A SPIN — a guard that " +
          "cannot tell walking a tree from grinding one directory would make " +
          "the agent useless on any real repo",
        toolCalls(res.newMessages).length >= 5
        && !res.newMessages.some(m => m.meta && m.meta.spin),
        toolCalls(res.newMessages).length);
}
{
    // Same tool, same arguments, but the workspace CHANGED in between — the
    // "read it back after writing it" pattern, which is good behaviour.
    const s = makeSession();
    let n = 0;
    routerStub.calls = [];
    routerStub.reply = () => {
        n++;
        if (n > 6) return { content: "All written." };
        // alternate: write a DIFFERENT file, then list the same directory
        return n % 2
            ? { content: 'Writing.\n```tool\n{"tool":"write_file","args":' +
                  `{"path":"f${n}.txt","content":"hello ${n}"}}\n\`\`\`` }
            : { content: 'Verifying.\n```tool\n{"tool":"list_files","args":{"path":"."}}\n```' };
    };
    const res = await agent.runTurn(s, "write three files, verifying each", {
        selection: null, cancelToken: { cancelled: false } });
    check("A REPEATED CALL WITH REAL WORK BETWEEN IT IS NOT A SPIN — writing a " +
          "file then listing the folder to verify is the behaviour we want, " +
          "and the guard only fires when NOTHING changed",
        !res.newMessages.some(m => m.meta && m.meta.spin)
        && res.changes.length >= 2,
        { spun: res.newMessages.filter(m => m.meta && m.meta.spin).length,
          changes: res.changes.length });
}

/* ============ THE USER'S OWN FILE NAME SURVIVES THE RENAME ========== */
{
    // A persisted session may still carry `akReviewFile: "SESSION-REVIEW.md"`
    // — a stored field, so renaming the default alone would never reach a
    // conversation that predates the rename.
    const s = makeSession({ ancientKnowledge: true,
                            akReviewFile: "SESSION-REVIEW.md" });
    fs.writeFileSync(path.join(s.repoPath, "SESSION-REVIEW.md"),
                     "# Session Review\nold content\n");
    const name = ak.reviewFileName(s);
    check("A SESSION THAT PREDATES THE RENAME IS MIGRATED, not left writing the " +
          "old name forever — the operator explicitly named this file " +
          "ancient_knowledge.md, and the name is part of the feature",
        name === "ancient_knowledge.md"
        && s.akReviewFile === "ancient_knowledge.md",
        { name, stored: s.akReviewFile });
    check("...and the existing file is RENAMED, not abandoned beside the new " +
          "one — two divergent reviews in one folder is worse than either",
        fs.existsSync(path.join(s.repoPath, "ancient_knowledge.md"))
        && !fs.existsSync(path.join(s.repoPath, "SESSION-REVIEW.md")),
        fs.readdirSync(s.repoPath));
    check("...and its contents came across",
        /old content/.test(fs.readFileSync(
            path.join(s.repoPath, "ancient_knowledge.md"), "utf8")), null);

    // a suffixed legacy name keeps its suffix, so two sessions sharing a
    // folder do not collide on the way through the migration
    const s2 = makeSession({ akReviewFile: "SESSION-REVIEW-abc12345.md" });
    check("a per-session legacy name keeps its suffix through the migration",
        ak.reviewFileName(s2) === "ancient_knowledge-abc12345.md",
        s2.akReviewFile);
}

console.log(`\n${pass}/${pass + fail} spin-guard checks passed`);
process.exit(fail ? 1 : 0);
})();
