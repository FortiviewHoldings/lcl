/**
 * ANCIENT KNOWLEDGE IS A LOOP, AND EVERY WAY OUT OF IT HAS A NAME.
 *
 * The specification for this feature:
 *
 *   Ancient Knowledge captures all, interrogates the output against the
 *   input, and forces the model to read and respond with action. The cycle
 *   continues until the entire request has been fulfilled; once all gaps are
 *   closed, and the only intervention still possible is the user function
 *   testing, then and only then does it become the user's turn.
 *
 * Every clause is a check below, driven through the REAL runTurn with a
 * scripted router — the loop that ships is the loop that is tested. The
 * checks that matter most are the refusals: a blank auditor must never be
 * read as "all gaps closed", and a re-surfaced gap must never be read as
 * progress. Those are the two ways an auditor quietly becomes a rubber
 * stamp, which is the failure this whole feature exists to prevent.
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
// packaged mode reads process.resourcesPath (undefined under plain node);
// the repo root carries the same tools/ and knowledge/ layout, read-only
process.resourcesPath = path.join(__dirname, "..");
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ak-"));
require.cache[__filename] = { exports: {
    // isPackaged: TRUE, deliberately — in dev mode paths.dataDir() resolves
    // to the REPO's shared data/ directory, so a suite that bills a fake
    // ledger row would write it into the developer's own cost ledger and
    // read every other suite's leavings back as its own. Packaged mode
    // routes through getPath, which is this run's throwaway directory.
    app: { isPackaged: true, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false,
                   encryptString: (s) => Buffer.from(String(s)),
                   decryptString: (b) => Buffer.from(b).toString() }
} };

/* THE ROUTER IS SCRIPTED, NOT REAL. The loop's shape — who is asked what,
 * in which order, and when it stops — is the thing under test; the answers
 * are the experiment's controlled variable. Injected into the require cache
 * BEFORE agent.js loads, so the agent wires itself to this. */
const ROUTER_PATH = require.resolve(path.join(__dirname, "..", ".lcl.engine", "core", "router.js"));
const routerStub = {
    script: [],          // answers, consumed in order
    calls: [],           // every generate() observed: { messages, opts }
    generate: async (messages, maxTokens, cancelToken, onToken, opts) => {
        routerStub.calls.push({ messages, maxTokens, opts, onTokenType: typeof onToken });
        // if the caller wired a streamer, feed it one frame so streaming is
        // exercised end to end — the audit's ak-generating preview depends on it
        if (typeof onToken === "function") {
            try { onToken({ tokens: 7, elapsedMs: 900, text: "AK STREAM SAMPLE" }); }
            catch { /* the stub never breaks the loop under test */ }
        }
        const next = routerStub.script.shift();
        if (!next) return { content: "" };
        return typeof next === "function" ? next() : next;
    },
    limits: () => ({ kind: "local", label: "stub", maxSteps: 4, maxTokens: 1536,
                     historyWindow: 12, toolResultCap: 6000 }),
    resolveSelection: () => ({ sel: null }),
    usingRemote: () => false,
    activeModel: () => "stub-model"
};
require.cache[ROUTER_PATH] = { id: ROUTER_PATH, filename: ROUTER_PATH,
    loaded: true, exports: routerStub };

const ak = require(path.join(__dirname, "..", ".lcl.engine", "core", "ancientKnowledge.js"));
const agent = require(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"));
const ledger = require(path.join(__dirname, "..", ".lcl.engine", "core", "ledger.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 260) : ""); }
}

/* ------------------------------------------------ reading verdicts (unit) */
{
    const v1 = ak.parseVerdict("VERDICT: CLOSED");
    check("a CLOSED verdict parses closed", v1.status === "closed" && v1.gaps.length === 0, v1);
    const v2 = ak.parseVerdict("VERDICT: GAPS\nGAP: file X missing\nGAP: no test ran");
    check("a GAPS verdict carries its gaps",
        v2.status === "gaps" && v2.gaps.length === 2 && /file X/.test(v2.gaps[0]), v2);
    const v3 = ak.parseVerdict("VERDICT: USER-TEST\nGAP: click the new button");
    check("USER-TEST is its own verdict, with what to test",
        v3.status === "user-test" && /button/.test(v3.gaps[0]), v3);
    const v4 = ak.parseVerdict("");
    check("A BLANK AUDITOR IS 'unavailable', NEVER 'closed' — silence is not a verdict",
        v4.status === "unavailable", v4);
    const v5 = ak.parseVerdict("Audit complete — all items addressed.");
    check("the legacy single-pass sentinel is still honoured as closed",
        v5.status === "closed", v5);
    const v6 = ak.parseVerdict("You forgot to update the README with the new flag.");
    check("a free-form auditor that ignored the format is still HEARD — its text becomes a gap",
        v6.status === "gaps" && v6.freeform === true && /README/.test(v6.gaps[0]), v6);
    check("gap identity is shape, not spelling",
        ak.normGap("File X was NOT written!") === ak.normGap("file x was not written"), null);
    check("the round ceiling scales with the effort slider: 2 at Terrestrial, 6 at Multiversal",
        ak.maxRounds(0) === 2 && ak.maxRounds(4) === 6 && ak.maxRounds(undefined) === 2, null);
    // the akRounds knob (1..8) overrides the effort default — on BOTH paths
    check("the akRounds session knob overrides the effort default (clamped 1..8)",
        ak.effectiveMaxRounds({ effortLevel: 0, akRounds: 5 }) === 5
        && ak.effectiveMaxRounds({ effortLevel: 4, akRounds: 1 }) === 1
        && ak.effectiveMaxRounds({ effortLevel: 4, akRounds: 99 }) === 8, null);
    check("...and with no knob set it falls back to the effort ceiling",
        ak.effectiveMaxRounds({ effortLevel: 4 }) === 6
        && ak.effectiveMaxRounds({ effortLevel: 0 }) === 2, null);
    check("the CHAT path builds its ceiling from effectiveMaxRounds too — the knob " +
          "used to be a no-op on ordinary turns because it used maxRounds(effort)",
        (() => { const A = fs.readFileSync(require("path").join(__dirname, "..",
            ".lcl.engine", "core", "agent.js"), "utf8");
            return A.includes("ak.effectiveMaxRounds(session)")
                && !/ak\.maxRounds\(session\.effortLevel\)/.test(A); })());
}

/* ------------------------------------------------------- harness helpers */
function makeSession(extra = {}) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ak-repo-"));
    return { id: "ses-" + Math.random().toString(36).slice(2, 10),
             title: "ak test", messages: [], changes: [],
             ancientKnowledge: true, effortLevel: 0, repoPath: repo, ...extra };
}
async function turn(session, script, opts = {}) {
    routerStub.script = [...script];
    routerStub.calls = [];
    const events = [];
    const res = await agent.runTurn(session, opts.userText || "Write file X with the answer in it.", {
        selection: null,
        // report() hands ONE object: { phase, detail, step, elapsedMs }
        onProgress: (ev) => events.push({ phase: ev.phase, data: ev.detail || {} }),
        cancelToken: opts.cancelToken || { cancelled: false },
        // THE FRONT DOOR IS ISOLATED (§8b). In production, brain-on means the
        // intake runs FIRST and consumes the first scripted answer. The
        // audit-loop tests below are about the LOOP — who is asked what, when it
        // forces, when it stops — so they keep the front door OFF and their
        // scripts stay about the loop, not the brief. The intake has its own
        // dedicated tests that turn it ON with turnOpts:{ frontDoor: true } and
        // prove the full brain-on sequence composes.
        frontDoor: false,
        ...opts.turnOpts
    });
    return { res, events, calls: routerStub.calls };
}
// the audit bubbles a turn produced — the front-door BRIEF (meta.intake) is its
// own thing and is excluded here so the loop tests count only interrogations
const audits = (msgs) => msgs.filter(m => m.meta && m.meta.model === "ancient-knowledge" && !m.meta.intake);
const briefs = (msgs) => msgs.filter(m => m.meta && m.meta.intake === true);
const review = (session) => {
    const f = path.join(session.repoPath, session.akReviewFile || "ancient_knowledge.md");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
};

(async () => {

/* --------------------- THE HAPPY LOOP: gaps -> forced action -> closed --- */
{
    const s = makeSession({ effortLevel: 2 });        // maxRounds 4
    const { res, events, calls } = await turn(s, [
        { content: "I did part of it." },                                  // driver
        { content: "VERDICT: GAPS\nGAP: file X was never written" },       // audit 1
        { content: "Now file X is really written, with the answer." },     // forced driver
        { content: "VERDICT: CLOSED" }                                     // audit 2
    ]);
    check("the turn completes", res.ok === true, res);
    check("FOUR generations ran: driver, interrogation, forced response, re-interrogation",
        calls.length === 4, calls.length);
    check("the interrogation runs under the overseer system prompt",
        /Ancient Knowledge overseer/.test(calls[1].messages[0].content), null);
    check("...and interrogates OUTPUT AGAINST INPUT — both the ask and the response are in it",
        /Write file X/.test(calls[1].messages[1].content)
        && /I did part of it/.test(calls[1].messages[1].content), null);
    check("THE FORCED RESPONSE IS FORCED — the driver's next context carries the gaps and " +
        "the instruction to act, not restate",
        calls[2].messages.some(m => m.role === "user"
            && /round 1/.test(m.content) && /file X was never written/.test(m.content)
            && /DO it/.test(m.content)), null);
    check("the re-interrogation judges the NEW response",
        /really written/.test(calls[3].messages[1].content), null);
    const akMsgs = audits(res.newMessages);
    check("EVERY ROUND LANDS IN THE TRANSCRIPT — the gap it found, and then the " +
          "close. This check used to demand that a clean close print NOTHING, " +
          "which made 'audited and passed' byte-identical to 'never ran' and to " +
          "'the auditor is dead'; the feature was reported as not " +
          "working largely because of it",
        akMsgs.length === 2
        && /file X was never written/.test(akMsgs[0].content)
        && akMsgs[1].meta.verdict === "closed", akMsgs);
    check("...and each one is persisted EXACTLY ONCE (the double-persist guard: " +
          "the bubbles the session keeps are the bubbles the UI was handed, " +
          "not those plus a stored copy)",
        audits(s.messages).length === akMsgs.length,
        { stored: audits(s.messages).length, handed: akMsgs.length });
    check("the objective on the session record reads CLOSED after 2 rounds",
        s.akReview.objectives[0].status === "closed"
        && s.akReview.objectives[0].rounds === 2
        && s.akReview.objectives[0].stopped === "closed", s.akReview.objectives[0]);
    const doc = review(s);
    check("ancient_knowledge.md exists in the workspace and says so",
        !!doc && /# Ancient Knowledge/.test(doc) && /CLOSED/.test(doc)
        && doc.includes(`lcl-session:${s.id}`), (doc || "").slice(0, 120));
    check("the progress events tell the story: audit round 1 of 4, then forcing, then stopped clean",
        events.some(e => e.phase === "audit" && e.data.round === 1 && e.data.of === 4)
        && events.some(e => e.phase === "audit-done" && e.data.forcing === true)
        && events.some(e => e.phase === "audit-done" && e.data.stopped === "closed"), null);
    check("'done' is reported once, at the TRUE end of the cycle",
        events.filter(e => e.phase === "done").length === 1, null);
}

/* --------------------- THE AUDIT IS WATCHED LIVE (§7c #3 / §8b) ----------
 * The auditor's generation used to pass onToken=null — blocking, so its prose
 * only existed as a finished wall. Now it streams like the driver's reply and
 * emits an `ak-generating` preview the renderer grows live, round by round. */
{
    const s = makeSession({ effortLevel: 0 });          // ceiling 2
    const { events, calls } = await turn(s, [
        { content: "I did part of it." },                                  // driver
        { content: "VERDICT: GAPS\nGAP: file X was never written" },       // audit 1
        { content: "Now file X is really written, with the answer." },     // forced driver
        { content: "VERDICT: CLOSED" }                                     // audit 2
    ]);
    // an interrogation call is the one under the overseer system prompt
    const auditCalls = calls.filter(c =>
        /Ancient Knowledge overseer/.test(c.messages[0].content));
    check("THE AUDITOR STREAMS — every interrogation call is handed a function " +
          "onToken, never the old blocking null",
        auditCalls.length >= 1 && auditCalls.every(c => c.onTokenType === "function"),
        auditCalls.map(c => c.onTokenType));
    const akGen = events.filter(e => e.phase === "ak-generating");
    check("...and the stream reaches the UI as `ak-generating` — the auditor's " +
          "words as a rolling preview, tagged phase=ancient-knowledge with a round",
        akGen.length >= 1
        && akGen.every(e => e.data.phase === "ancient-knowledge" && e.data.round >= 1)
        && akGen.some(e => /AK STREAM SAMPLE/.test(String(e.data.preview || ""))),
        akGen.map(e => e.data));
}

/* the streaming wiring is on BOTH loops — the chat path (agent.js) and the
 * orchestrated cycle (ancientKnowledge.js) — so the auditor is visible either
 * way, not chat-path-only. */
{
    const A = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    const K = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "ancientKnowledge.js"), "utf8");
    check("both AK loops stream the auditor via an onAkStream that reports " +
          "ak-generating, wired into the audit generate (not chat-path-only)",
        /const onAkStream =/.test(A) && /report\("ak-generating"/.test(A)
        && /1024, cancelToken, onAkStream,/.test(A)
        && /const onAkStream =/.test(K) && /report\("ak-generating"/.test(K)
        && /1024, cancelToken, onAkStream,/.test(K), null);
}

/* THE RENDERER PAINTS THE AUDIT LIVE — a dedicated bubble that forms while the
 * auditor reads (mirrors the persisted .msg-ancient), grown by the ak-generating
 * preview, then torn down when the persisted wall renders. */
{
    const app = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    check("the renderer has a LIVE AK bubble — addAncientLive builds the mirror of " +
          ".msg-ancient (user side, cloned brain, effort colour); akLiveEnsure/" +
          "akLiveClear manage its one-per-turn lifecycle",
        /function addAncientLive\(\)/.test(app)
        && /"msg-ancient live"/.test(app)
        && /function akLiveEnsure\(\)/.test(app)
        && /function akLiveClear\(\)/.test(app), null);
    check("...the ak-generating stream grows the live bubble body, gated to " +
          "phase=ancient-knowledge so the self-review panel's audit never opens it",
        /case "ak-generating"/.test(app)
        && /d\.phase === "ancient-knowledge"/.test(app)
        && /renderMessageBody\(b\._body/.test(app), null);
    check("...and the live bubble is TORN DOWN on turn-resolve and on stop — the " +
          "turn-resolve teardown is viewing()-gated (both live globals together), so " +
          "a BACKGROUND turn finishing never clears the FOREGROUND session's audit",
        (app.match(/akLiveClear\(\)/g) || []).length >= 2
        && /if \(viewing\(\)\) \{ typing\.remove\(\); akLiveClear\(\); akIntakeClear\(\); \}/.test(app), null);
}

/* ═══════════════════ THE FRONT DOOR — AK RECEIVES FIRST, HANDS OFF (§8b) ═══
 * The reported failure: "it is supposed to write the request to ancient
 * knowledge and it hand off, not the user hand off straight to the model.
 * right now the model is running first, before ancient knowledge." The front
 * door reverses that — with the brain on, AK reads the request BEFORE the
 * model, states what "done" means, and hands the model those criteria. */

/* the intake reader is pure — a formatted brief parses; a rambling or empty one
 * yields null so the turn falls straight through to the model, never blocked. */
{
    const b = ak.parseBrief(
        "INTENT: Build an interactive lab from the chapter\n" +
        "DONE MEANS:\n" +
        "- Every concept in the chapter is explained\n" +
        "- Inputs and outputs can be emulated in the page\n" +
        "3. The code actually runs, not just written");
    check("parseBrief reads the intent and the acceptance criteria",
        b && /interactive lab/i.test(b.intent) && b.criteria.length === 3
        && /emulated/i.test(b.criteria[1]), b);
    check("...numbered as well as dashed bullets are read as criteria",
        b && /the code actually runs/i.test(b.criteria[2]), b && b.criteria);
    check("a brief with no criteria is null — the front door then falls through " +
          "to the model exactly as if it were off, so it can never block a turn",
        ak.parseBrief("I think you should build something nice.") === null
        && ak.parseBrief("") === null, null);
    check("duplicate criteria (same shape, different case/punctuation) collapse to one",
        (() => { const x = ak.parseBrief("DONE MEANS:\n- File X is written\n- file x is WRITTEN!");
            return x && x.criteria.length === 1; })(), null);
    const hb = ak.handoffInstruction(b);
    check("the hand-off carries the criteria to the MODEL and demands work, not restatement",
        /interactive lab/i.test(hb) && /Inputs and outputs/i.test(hb)
        && /DONE only when/i.test(hb) && /Do not restate/i.test(hb), null);
    check("the visible brief bubble is brain-marked with the load-bearing prefix",
        /^\*\*Ancient Knowledge — brief:\*\*/.test(ak.briefBubble(b)), ak.briefBubble(b).slice(0, 60));
    check("the intake prompt asks for intent + checkable done-criteria, before the model",
        /INTENT:/.test(ak.intakePrompt({ userAsk: "x" }))
        && /DONE MEANS:/.test(ak.intakePrompt({ userAsk: "x" }))
        && /BEFORE the model/.test(ak.intakePrompt({ userAsk: "x" })), null);
}

/* ═══════════ AK DRIVES VERIFICATION — it writes the test, not the model ═══
 * The measured failure: a model "verified" its web app by grepping script.js
 * for "requestAnimationFrame" and printing passed. AK must author a test that
 * EXERCISES the code and runs it, and reject a string/name-presence check. */
{
    const p = ak.verifyPrompt({ userAsk: "build a CSV parser", files: ["parse.js"], entry: "parse.js" });
    check("the verify prompt names the files, forbids a presence-check, and demands " +
          "a runnable test that asserts real behaviour",
        /parse\.js/.test(p) && /EXERCISES/.test(p)
        && /not a test/.test(p) && /LANG:/.test(p) && /TEST:/.test(p)
        && /exit non-zero/.test(p), null);

    const t1 = ak.parseVerifyTest(
        "LANG: node\nTEST:\n```js\nconst p=require('./parse.js');\n" +
        "if(p('a,b').length!==2) throw new Error('bad'); console.log('parsed 2 fields');\n```");
    check("parseVerifyTest reads the language and the fenced test program",
        t1 && t1.language === "node" && /require\('\.\/parse\.js'\)/.test(t1.code)
        && /parsed 2 fields/.test(t1.code), t1);

    const t2 = ak.parseVerifyTest("LANG: python\nTEST:\n```\nimport parse\nassert parse.run()==3\n```");
    check("...python is recognised, and an unlabelled fence still parses",
        t2 && t2.language === "python" && /assert parse\.run\(\)==3/.test(t2.code), t2);

    check("a reply with no test at all is null — unverified code stays unverified, " +
          "never laundered into 'tested'",
        ak.parseVerifyTest("I think it looks fine.") === null
        && ak.parseVerifyTest("") === null, null);

    const t3 = ak.parseVerifyTest("LANG: node\nTEST:\nconst x=require('./a.js'); if(!x) throw 'no';");
    check("...a test the model gave WITHOUT a code fence is still recovered",
        t3 && /require\('\.\/a\.js'\)/.test(t3.code), t3);
}

/* ═══════════ AK RUNS ITS OWN TEST — evidence, not the model's word ════════
 * generate + sandbox + readFile are injected, so the whole path is exercised
 * with no live model and no real box. */
{
    const src = { "parse.js": "module.exports = s => s.split(',');" };
    const readFile = (rel) => { if (!(rel in src)) throw new Error("ENOENT"); return src[rel]; };
    const genTest = async () => ({ content:
        "LANG: node\nTEST:\n```\nconst p=require('./parse.js');\n" +
        "if(p('a,b').length!==2) throw new Error('x'); console.log('ok');\n```" });
    const mkSandbox = (runResult) => {
        const written = {};
        return { _written: written, create: () => ({ id: "box-x" }),
                 write: (id, rel, content) => { written[rel] = content; },
                 runScript: async () => runResult, destroy: () => {} };
    };

    const sbPass = mkSandbox({ ok: true, output: "ok\n" });
    const pass = await ak.runVerification({ userAsk: "csv", files: ["parse.js"],
        readFile, generate: genTest, sandbox: sbPass });
    check("runVerification: a passing test reports ran+ok, and the produced file was " +
          "copied into the box at its real relative path",
        pass.ran === true && pass.ok === true
        && sbPass._written["parse.js"] === src["parse.js"], pass);

    const fail = await ak.runVerification({ userAsk: "csv", files: ["parse.js"],
        readFile, generate: genTest, sandbox: mkSandbox({ ok: false,
            output: "AssertionError: expected 2, got 0\n" }) });
    check("runVerification: a failing test is ok:false and the gap carries the REAL error, " +
          "not 'you didn't test it'",
        fail.ran === true && fail.ok === false
        && /expected 2, got 0/.test(fail.gap), fail);

    const noTest = await ak.runVerification({ userAsk: "csv", files: ["parse.js"],
        readFile, generate: async () => ({ content: "looks fine to me" }),
        sandbox: mkSandbox({ ok: true }) });
    check("runVerification: an auditor that gives no runnable test → ran:false " +
          "(caller falls back to the flag; never a silent pass)", noTest.ran === false, noTest);

    const noFiles = await ak.runVerification({ userAsk: "csv", files: [],
        readFile, generate: genTest, sandbox: mkSandbox({ ok: true }) });
    check("runVerification: no produced code → ran:false", noFiles.ran === false, noFiles);

    const broken = await ak.runVerification({ userAsk: "csv", files: ["parse.js"],
        readFile, generate: genTest,
        sandbox: { create: () => { throw new Error("no box"); } } });
    check("runVerification: a throwing sandbox is caught → ran:false, never breaks the turn",
        broken.ran === false, broken);

    const msgs = [
        { role: "tool", tool: "write_file", content: '{"written":"src/app.js","bytes":10}' },
        { role: "tool", tool: "write_file", content: '{"written":"notes.txt","bytes":3}' },
        { role: "tool", tool: "write_file", content: '{"written":"src/app.js","bytes":12}' }
    ];
    const produced = ak.producedCodeFiles(msgs);
    check("producedCodeFiles lists code files written this turn, deduped, skipping non-code",
        produced.length === 1 && produced[0] === "src/app.js", produced);

    const A = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("agent.js wires it: AK runs its OWN test and the verdict rests on the result, " +
          "with the mechanical flag only as fallback",
        /ak\.runVerification\(/.test(A) && /ak\.producedCodeFiles\(/.test(A)
        && /akVerifiedKey/.test(A)
        && /ak\.untestedLogicGap\(newMessages\)/.test(A), null);
}

/* ═══════════ CONTINUATION — the turn resumes after an approved action ═════
 * The reported bug: approve a staged script and the turn just ends. A
 * continuation re-runs the model on the transcript it already has (its approved
 * script result is the last message), writes NO new user turn, does not
 * re-brief, and reuses the request's still-open objective so the audit measures
 * the ORIGINAL ask — not the "keep going" nudge. */
{
    const s = makeSession();
    ak.openObjective(s, "Build the CSV parser");
    s.messages.push(
        { role: "user", content: "Build the CSV parser" },
        { role: "assistant", content: "Proposed a script to check it." },
        { role: "tool", name: "run_script", approved: true,
          content: "run_script finished: exit 0 (clean). Output: parsed 2 fields" });
    const before = s.akReview.objectives.length;

    const { res } = await turn(s,
        [{ content: "The parser works — CSV split into fields, verified by the run." },
         { content: "VERDICT: CLOSED" }],
        { userText: "Your approved script ran (result above). Finish the task.",
          turnOpts: { continuation: true } });

    check("a continuation writes NO new user message into the transcript",
        res.newMessages.every(m => m.role !== "user"), res.newMessages.map(m => m.role));
    check("...the model's continuation answer lands",
        res.newMessages.some(m => m.role === "assistant" && /parser works/i.test(m.content)), null);
    check("...Ancient Knowledge still audits the resumed work",
        audits(res.newMessages).length >= 1, audits(res.newMessages).length);
    check("...it REUSES the open objective (no duplicate row for one request), judged " +
          "against the ORIGINAL ask, not the continuation nudge",
        s.akReview.objectives.length === before
        && /Build the CSV parser/.test(s.akReview.objectives[0].ask), s.akReview.objectives);

    const A2 = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("agent.js: continuation writes no user turn, skips the front door, reuses the objective",
        /const continuation = opts\.continuation === true/.test(A2)
        && /&& !continuation\b/.test(A2)
        && /akMod\.currentObjective\(session\)/.test(A2), null);

    const app = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    check("renderer: approving a script CONTINUES the turn (res.continue → sendText continuation), " +
          "and sendText's continuation writes no user bubble",
        /if \(res && res\.continue\)/.test(app)
        && /\{ continuation: true \}/.test(app)
        && /function sendText\(text, session, sendOpts/.test(app)
        && /if \(!continuation\) addMessageRow\("user"/.test(app), null);
    const main = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
    check("main: lcl:chat threads continuation through to runTurn",
        /chatOpts && chatOpts\.continuation/.test(main)
        && /continuation: continueTurn/.test(main), null);
    const pre = fs.readFileSync(path.join(__dirname, "..", "app", "preload.js"), "utf8");
    check("preload: chat passes the continuation opts through",
        /chat: \(id, content, opts\) =>/.test(pre), null);
}

/* ═══════════ A SHORT PUSH RESUMES THE OPEN WORK — it is not a new request ══
 * The measured failure: a prior turn stalled on a plan, the user typed "go",
 * AK briefed on the word "go" ("done = acknowledges 'go'"), the model met that
 * by acknowledging, and AK CLOSED with nothing built. A nudge must resume the
 * open objective and be audited against the ORIGINAL ask. */
{
    const s = makeSession();
    ak.openObjective(s, "Build the CSV parser");   // a prior request, still OPEN
    s.messages.push(
        { role: "user", content: "Build the CSV parser" },
        { role: "assistant", content: "Here's my plan: I'll read the spec and write it." });
    const before = s.akReview.objectives.length;

    const { res } = await turn(s,
        [{ content: "Done — parser written; it splits a CSV row into fields." },
         { content: "VERDICT: CLOSED" }],
        { userText: "go", turnOpts: { frontDoor: true } });

    check("a trivial push ('go') does NOT open a second objective — it resumes the open one",
        s.akReview.objectives.length === before
        && /Build the CSV parser/.test(s.akReview.objectives[0].ask), s.akReview.objectives);
    check("...AK does NOT brief on the word 'go' (no intake bubble for the nudge)",
        briefs(res.newMessages).length === 0, briefs(res.newMessages).map(m => String(m.content).slice(0, 40)));
    check("...the audit still runs, measuring the resumed work not the nudge",
        audits(res.newMessages).length >= 1, audits(res.newMessages).length);

    // ...but a REAL follow-up request still gets its own brief (guard against
    // swallowing genuine new asks as "resumes")
    const s2 = makeSession();
    ak.openObjective(s2, "Build the parser");
    s2.messages.push({ role: "user", content: "Build the parser" },
                     { role: "assistant", content: "Done." });
    const { res: r2 } = await turn(s2,
        [{ content: "INTENT: add tests\nDONE MEANS:\n- unit tests exist" },
         { content: "Added tests." }, { content: "VERDICT: CLOSED" }],
        { userText: "now add unit tests for every function", turnOpts: { frontDoor: true } });
    check("a genuine follow-up request is NOT mistaken for a nudge — it still briefs",
        briefs(r2.newMessages).length >= 1, briefs(r2.newMessages).length);

    const A3 = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("agent.js: the front door resumes on a trivial push and the audit uses the resumed ask",
        /_trivialPush/.test(A3) && /akResumedAsk = _openObj\.ask/.test(A3)
        && /akResumedAsk \|\| String\(userMsg\.content\)/.test(A3), null);
}

/* THE FULL BRAIN-ON SEQUENCE COMPOSES. With the front door ON: AK is asked
 * FIRST (its brief, under the overseer prompt), the model gets the criteria in
 * its context, then the audit runs — and the objective is opened exactly ONCE
 * (the front door owns it; the audit reuses it, never a second row). */
{
    const s = makeSession({ effortLevel: 0 });                       // ceiling 2
    const { res, events, calls } = await turn(s, [
        { content: "INTENT: Write file X\nDONE MEANS:\n- File X exists\n- It holds the answer" }, // intake brief
        { content: "Done — file X is written with the answer." },    // driver
        { content: "VERDICT: CLOSED" }                               // audit
    ], { turnOpts: { frontDoor: true } });

    check("ANCIENT KNOWLEDGE IS ASKED FIRST — the very first generation is the " +
          "intake, under the overseer prompt, setting the brief before the model",
        calls.length >= 1
        && /Ancient Knowledge overseer/.test(calls[0].messages[0].content)
        && /Set the brief/.test(calls[0].messages[1].content), calls[0] && calls[0].messages[1].content.slice(0, 80));
    check("the model then builds AGAINST the brief — the criteria reach its context " +
          "as a hand-off before it answers",
        calls[1] && calls[1].messages.some(m => m.role === "user"
            && /Ancient Knowledge reviewed this request before you began/.test(m.content)
            && /File X exists/.test(m.content)), null);
    check("the user SEES AK hand off — a brain-marked brief bubble lands, before " +
          "the audit bubble, carrying the criteria",
        briefs(res.newMessages).length === 1
        && /File X exists/.test(briefs(res.newMessages)[0].content), briefs(res.newMessages));
    check("the brief is watched live — an ak-intake event streams, then ak-intake-done",
        events.some(e => e.phase === "ak-intake")
        && events.some(e => e.phase === "ak-intake-done" && e.data.criteria === 2), null);
    check("THE OBJECTIVE IS OPENED ONCE — the front door owns it and the audit " +
          "reuses that same row (no double-count of the request)",
        s.akReview.objectives.length === 1
        && s.akReview.objectives[0].rounds >= 1, s.akReview.objectives.length);
}

/* the fall-through is real, not just unit-tested: an intake with no criteria
 * produces no brief bubble and no hand-off, and the model answers anyway. */
{
    const s = makeSession({ effortLevel: 0 });
    const { res, calls } = await turn(s, [
        { content: "Sure, I can help with that!" },                  // intake: no criteria
        { content: "Here is the answer." },                         // driver
        { content: "VERDICT: CLOSED" }                              // audit
    ], { turnOpts: { frontDoor: true } });
    check("a criterion-less intake yields NO brief bubble and NO hand-off — the " +
          "model builds from the raw request, unblocked",
        briefs(res.newMessages).length === 0
        && !calls.some(c => c.messages.some(m =>
            /Ancient Knowledge reviewed this request before you began/.test(m.content))), null);
}

/* the front door is wired into the CHAT path and guarded — brain-on, not
 * stepMode, and never fatal (a thrown intake falls through to the model). */
{
    const A = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("agent.js opens the front door before the audit loop: intake generate, " +
          "parseBrief, a visible brief bubble, and a hand-off into `working`",
        /THE FRONT DOOR/.test(A)
        && /akMod\.intakePrompt\(/.test(A)
        && /akMod\.parseBrief\(/.test(A)
        && /content: akMod\.briefBubble\(brief\)/.test(A)
        && /working\.push\(\{ role: "user",\s*content: akMod\.handoffInstruction\(brief\)/.test(A), null);
    check("...guarded: brain-on and not stepMode, and the whole block is in a " +
          "try/catch so a failed intake never breaks the turn",
        /session\.ancientKnowledge === true && !opts\.stepMode/.test(A)
        && /opts\.frontDoor !== false/.test(A), null);
    check("...and it opens the objective at the front, with the audit-time open " +
          "guarded so the request is never counted twice",
        /akObjective = akMod\.openObjective\(session, frontAsk\)/.test(A)
        && /if \(!akObjective\) \{\s*akObjective = ak\.openObjective/.test(A), null);
    const app = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    check("the renderer paints the brief live in its OWN bubble (akIntakeEnsure/" +
          "akIntakeClear), settles it on ak-intake-done, and names it Ancient " +
          "Knowledge (not 'the brain')",
        /function akIntakeEnsure\(\)/.test(app)
        && /function akIntakeClear\(\)/.test(app)
        && /case "ak-intake"/.test(app)
        && /case "ak-intake-done"/.test(app)
        && !/With the brain on, every response/.test(app), null);
}

/* ------------- A BLANK AUDITOR NEVER LAUNDERS INTO "ALL GAPS CLOSED" ---- */
{
    const s = makeSession();
    const { res } = await turn(s, [
        { content: "Here is my answer." },
        { content: "" }                                    // the auditor died
    ]);
    check("a blank auditor stops the loop as review-unavailable",
        s.akReview.objectives[0].stopped === "review-unavailable", s.akReview.objectives[0]);
    check("...and the objective is NOT closed — completion was never verified",
        s.akReview.objectives[0].status === "open", s.akReview.objectives[0].status);
    check("...and the review document says the auditor did not answer",
        /did not answer|NOT verified/i.test(review(s) || ""), null);
    check("...and the driver's answer still reached the user (the audit never breaks the turn)",
        res.newMessages.some(m => m.role === "assistant" && /Here is my answer/.test(m.content)), null);
}

/* ---------------- A RE-SURFACED GAP IS NOT PROGRESS: nothing-new stops --- */
{
    const s = makeSession({ effortLevel: 4 });          // ceiling 6 — not the stopper here
    await turn(s, [
        { content: "Done, I think." },
        { content: "VERDICT: GAPS\nGAP: the config was never validated" },
        { content: "I have now validated the config." },
        { content: "VERDICT: GAPS\nGAP: The config was never validated!" }   // same gap, new coat
    ]);
    check("the same gap re-surfacing stops the loop as nothing-new — not another round",
        s.akReview.objectives[0].stopped === "nothing-new"
        && s.akReview.objectives[0].rounds === 2, s.akReview.objectives[0]);
    check("...and the review document says the gaps remain OPEN",
        /OPEN/i.test(review(s) || "") && /config was never validated/i.test(review(s) || ""), null);
}

/* ----------------------- THE ROUND CEILING HOLDS, and is named "rounds" -- */
{
    const s = makeSession({ effortLevel: 0 });          // ceiling 2
    const { calls } = await turn(s, [
        { content: "Attempt one." },
        { content: "VERDICT: GAPS\nGAP: alpha is missing" },
        { content: "Attempt two." },
        { content: "VERDICT: GAPS\nGAP: beta is missing" },   // FRESH gap — only the ceiling stops it
        { content: "should never be asked" }
    ]);
    check("at Terrestrial the cycle stops after 2 rounds even with fresh gaps",
        s.akReview.objectives[0].stopped === "rounds", s.akReview.objectives[0]);
    check("...having run exactly 4 generations — the fifth was never requested",
        calls.length === 4, calls.length);
    check("...and the document is honest that gaps remain, not that they closed",
        /round ceiling|gaps remain OPEN/i.test(review(s) || ""), null);
}

/* -------- USER-TEST: the hand-back the design calls for, by that name -- */
{
    const s = makeSession();
    const { res } = await turn(s, [
        { content: "The feature is built and wired." },
        { content: "VERDICT: USER-TEST\nGAP: press the new export button and confirm a file lands" }
    ]);
    check("a user-test verdict ends the cycle — the turn is the user's now",
        s.akReview.objectives[0].stopped === "user-test"
        && s.akReview.objectives[0].status === "user-test", s.akReview.objectives[0]);
    check("...the transcript bubble says what to test",
        audits(res.newMessages).some(m => /awaiting your function test/i.test(m.content)
            && /export button/.test(m.content)), null);
    check("...and the review document gets an 'Awaiting your function test' section",
        /Awaiting your function test/i.test(review(s) || ""), null);
}

/* ------------------------------- BUDGET: billed loops have a hard ceiling */
{
    const s = makeSession({ effortLevel: 4 });          // round ceiling 6 — budget must stop it first
    const paidAudit = (text) => ({ content: text, remote: true,
        model: "paid/auditor", endpoint: "api.example.com",
        usage: { prompt_tokens: 1000, completion_tokens: 200 }, cost: { usd: 0.30 } });
    await turn(s, [
        { content: "Attempt." },
        paidAudit("VERDICT: GAPS\nGAP: one thing is missing"),
        { content: "Another attempt." },
        paidAudit("VERDICT: GAPS\nGAP: a second, different thing is missing")
    ]);
    check("a billed cycle stops on the spend ceiling, named 'budget'",
        s.akReview.objectives[0].stopped === "budget", s.akReview.objectives[0]);
    const d = ledger.summary();
    const akRows = d.recent.filter(r => r.via === "ancient-knowledge");
    check("...and EVERY auditor call was billed to the ledger as ancient-knowledge",
        akRows.length === 2 && Math.abs(akRows[0].usd - 0.30) < 1e-9, akRows.length);
}

/* -------------------------------------------- the switch actually gates -- */
{
    // a NON-build turn isolates the AK switch from the always-on drive-to-
    // completion floor (which fires only on build turns) — the default userText
    // "Write file X…" is a build, so ask a plain question here instead.
    const s = makeSession({ ancientKnowledge: false });
    const { res, calls } = await turn(s, [{ content: "Plain answer." }],
        { userText: "What is the answer?" });
    check("with the brain OFF, exactly one generation runs and no audit exists",
        calls.length === 1 && audits(res.newMessages).length === 0
        && !s.akReview, calls.length);
}

/* ---- DRIVE TO COMPLETION — the always-on floor, independent of AK ---- */
{
    // AK OFF, a BUILD turn, the model answers with prose and touches nothing:
    // the drive steers it once, so a SECOND generation runs. It is the general
    // backstop for "asked to build, produced bland prose, nothing on disk".
    const s = makeSession({ ancientKnowledge: false });
    const { calls } = await turn(s,
        [{ content: "I have created the plan for you." },
         { content: "Done." },
         { content: "Still nothing written." }],
        { userText: "Build file X with the answer in it." });
    check("DRIVE: a build turn that keeps producing prose with nothing on disk is " +
          "steered up to the cap, then ACCEPTED — it drives AND terminates (brain OFF)",
        calls.length === 3, calls.length);   // DRIVE_MAX (2) nudges + the accepted reply

    // a genuine QUESTION is a legitimate stop — the drive must NOT badger it
    const s2 = makeSession({ ancientKnowledge: false });
    const { calls: c2 } = await turn(s2,
        [{ content: "Which file should I write it to?" }],
        { userText: "Build the thing." });
    check("DRIVE: a real question the request did not answer is left alone (one generation)",
        c2.length === 1, c2.length);

    // AK ON owns completion — the drive stands down so they never double-drive
    const s3 = makeSession({ ancientKnowledge: true });
    const { calls: c3 } = await turn(s3,
        [{ content: "I have created the plan for you." }],
        { userText: "Build file X with the answer in it." });
    check("DRIVE: with the brain ON, the drive stands down (AK owns completion)",
        !c3.some((_, i) => i > 0 && c3[i] && c3[i].driveNudge), true);
}

/* -------------------- cross-turn memory: the review rides the interrogation */
{
    const s = makeSession({ effortLevel: 0 });
    await turn(s, [
        { content: "Claimed done." },
        { content: "VERDICT: USER-TEST\nGAP: verify the export works" }
    ], { userText: "Build the export feature." });
    const { calls } = await turn(s, [
        { content: "Now about that other thing." },
        { content: "VERDICT: CLOSED" }
    ], { userText: "The export button does nothing when I press it." });
    check("the NEXT turn's interrogation carries the standing review items — a gap claimed " +
        "closed but not user-confirmed is in front of the auditor when the user reports it",
        /Standing items/.test(calls[1].messages[1].content)
        && /AWAITING USER TEST/.test(calls[1].messages[1].content), null);
    check("...and the review document now holds BOTH objectives",
        (review(s) || "").includes("1.") && (review(s) || "").includes("2."), null);
}

/* --------------- two sessions, one folder: no silent clobbering, by name -- */
{
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ak-shared-"));
    const a = makeSession(); a.repoPath = shared;
    const b = makeSession(); b.repoPath = shared;
    await turn(a, [{ content: "A's answer." }, { content: "VERDICT: CLOSED" }]);
    await turn(b, [{ content: "B's answer." }, { content: "VERDICT: CLOSED" }]);
    // ...and both live in .lcl/, the operating folder that is gitignored so a
    // tool document never rides along in the user's own repository
    check("the second session takes a suffixed review file instead of " +
          "overwriting the first, both in the repo root",
        (a.akReviewFile || "ancient_knowledge.md") === "ancient_knowledge.md"
        && b.akReviewFile && b.akReviewFile !== "ancient_knowledge.md"
        && !b.akReviewFile.includes("/")
        && fs.existsSync(path.join(shared, b.akReviewFile)), { a: a.akReviewFile, b: b.akReviewFile });
    check("...and the document is in the repo's .gitignore, so a tool document is " +
          "never pushed with the user's work",
        fs.readFileSync(path.join(shared, ".gitignore"), "utf8").includes("ancient_knowledge.md"));
    check("...and each file names its own session",
        (review(a) || "").includes(a.id) && (review(b) || "").includes(b.id), null);
}

/* ---------------- cancellation is honoured at the loop boundary, honestly -- */
{
    const s = makeSession();
    const token = { cancelled: false };
    await turn(s, [
        { content: "Answer." },
        () => { token.cancelled = true;
                return { content: "VERDICT: GAPS\nGAP: whatever" }; }
    ], { cancelToken: token });
    check("a cancel during the interrogation stops the cycle without forcing another round",
        s.akReview.objectives[0].stopped === "cancelled"
        || s.akReview.objectives[0].stopped === "review-unavailable",
        s.akReview.objectives[0]);
}

/* ======================================================================
 * REGRESSIONS — one per defect an adversarial pass confirmed against the
 * first cut of this loop. Every one of these failed before its fix.
 * ====================================================================== */

/* [1] CRITICAL — a forced round that FAILS must not erase the round that
 * already finished. The first cut reset `steps = 0` per round, which made
 * the didWork salvage guard (`steps > 0 && ...`) read false, so a round-2
 * generation error returned ok:false and main.js persisted nothing: the
 * answer, the tool results and the revert records all vanished while the
 * files stayed changed on disk. */
{
    const s = makeSession();
    const { res } = await turn(s, [
        { content: "Round one answer." },
        { content: "VERDICT: GAPS\nGAP: something is missing" },
        { error: "engine died mid-round" }               // the forced round fails
    ]);
    check("A FAILED FORCED ROUND SALVAGES the completed round — the turn does not " +
        "return ok:false and throw the finished work away",
        res.ok === true, res);
    check("...the round-1 answer is still in the transcript",
        res.newMessages.some(m => /Round one answer/.test(m.content || "")), null);
    check("...and it is PERSISTED to the session, not just returned",
        s.messages.some(m => /Round one answer/.test(m.content || "")), null);
    check("...with the failure said out loud as the machine, not as the model",
        res.newMessages.some(m => m.meta && m.meta.guard
            && /could not finish/i.test(m.content || "")), null);
    check("...and the review names the stop honestly",
        s.akReview.objectives[0].stopped === "round-failed", s.akReview.objectives[0]);
}

/* [2] MAJOR — the same, for a cancel landing inside a forced round. */
{
    const s = makeSession();
    const token = { cancelled: false };
    const { res } = await turn(s, [
        { content: "Round one answer." },
        { content: "VERDICT: GAPS\nGAP: still missing something" },
        () => { token.cancelled = true; return { content: "never used" }; }
    ], { cancelToken: token });
    check("A CANCEL INSIDE A FORCED ROUND keeps the completed round's work",
        res.ok === true
        && s.messages.some(m => /Round one answer/.test(m.content || "")), res);
    check("...and says it was stopped, not that it finished",
        s.akReview.objectives[0].stopped === "cancelled", s.akReview.objectives[0]);
}

/* [3] MAJOR — `steps` stays monotonic, so the steps===0 backstops (utility
 * re-routing, the wrong-refusal corrections) cannot re-arm on a forced round
 * and rewrite an answer that was addressing the audit. */
{
    const src = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("the forced round re-baselines the step budget instead of resetting the count",
        /stepsAtRoundStart = steps;/.test(src) && !/^\s*steps = 0;/m.test(src), null);
    check("...and the per-round cap is measured from that baseline",
        /steps - stepsAtRoundStart >= limits\.maxSteps/.test(src), null);
}

/* [5] CRITICAL — the legacy sentinel was an unanchored substring, so a reply
 * that merely CONTAINED the phrase (even negated) closed the objective and
 * threw away the GAP lines it had already collected. */
{
    const a = ak.parseVerdict("The audit completed and found three problems.\nGAP: one\nGAP: two");
    check("'audit completed' + real GAP lines is NOT closed — the gaps win",
        a.status === "gaps" && a.gaps.length === 2, a);
    const b = ak.parseVerdict("This is not an audit complete state.");
    check("a NEGATED 'audit complete' is not closed", b.status !== "closed", b);
    const c = ak.parseVerdict("Audit complete — all items addressed.");
    check("...while the genuine legacy sentinel still closes", c.status === "closed", c);
}

/* [6] MAJOR — the prompt hands the auditor a menu beginning "VERDICT: CLOSED";
 * a completion-mode model that echoes the menu before answering must not be
 * read as having closed the objective. */
{
    const echoed = ak.parseVerdict(
        "VERDICT: CLOSED\nVERDICT: USER-TEST\nVERDICT: GAPS\nGAP: <one unmet item>\n\n" +
        "VERDICT: GAPS\nGAP: the config file was never written");
    check("AN ECHOED PROMPT TEMPLATE DOES NOT CLOSE THE OBJECTIVE — the LAST " +
        "verdict is the auditor's answer, not the first line of our own menu",
        echoed.status === "gaps"
        && echoed.gaps.some(g => /config file/.test(g)), echoed);
    check("...and the template's own placeholder is not mistaken for a finding",
        !echoed.gaps.some(g => /^<.*>$/.test(g)), echoed.gaps);
    const contra = ak.parseVerdict("GAP: the tests never ran\nVERDICT: CLOSED");
    check("CLOSED CANNOT OUTRANK EVIDENCE — a reply naming gaps and saying " +
        "CLOSED is read the safe way",
        contra.status === "gaps" && contra.contradicted === true, contra);
}

/* [7] MAJOR — normGap stripped every non-Latin character, so two DIFFERENT
 * gaps in Chinese both normalised to "" and collided: round 2 read a genuinely
 * new gap as already-seen and stopped on a false `nothing-new`. */
{
    check("gaps in other scripts keep their identity",
        ak.normGap("修复登录按钮") !== ak.normGap("添加集成测试"), null);
    check("...and are not the empty string", ak.normGap("修复登录按钮").length > 0, null);
    check("Cyrillic too", ak.normGap("нет тестов") !== ak.normGap("нет документации"), null);
    const long = "src/very/deep/path/that/goes/on/and/on/and/on/for/quite/a/while/module-";
    check("long path-heavy gaps that differ only at the end stay distinct",
        ak.normGap(long + "alpha.js is missing") !== ak.normGap(long + "beta.js is missing"), null);
    check("a gap of pure punctuation still gets a stable identity",
        ak.normGap("!!!???") === ak.normGap("!!!???")
        && ak.normGap("!!!???") !== ak.normGap("***"), null);
}

/* [8] MAJOR — the reasoning slider never reached the disk, so the engine (which
 * loads the session fresh every turn) always saw effortLevel undefined: the
 * API's reasoning_effort was never sent, both temperature curves ran at their
 * defaults and AK's ceiling was always the Terrestrial 2. */
{
    const R = path.join(__dirname, "..");
    const main = fs.readFileSync(path.join(R, "app", "main.js"), "utf8");
    const pre = fs.readFileSync(path.join(R, "app", "preload.js"), "utf8");
    const app = fs.readFileSync(path.join(R, "app", "renderer", "app.js"), "utf8");
    check("THE EFFORT LEVEL IS PERSISTED: an IPC writes it to the session file",
        /ipcMain\.handle\("lcl:setSessionEffort"/.test(main)
        && /s\.effortLevel = Math\.round\(n\)/.test(main) && /sessions\.save\(s\)/.test(main), null);
    check("...the bridge exposes it", /setSessionEffort:/.test(pre), null);
    check("...and the slider calls it on change",
        /window\.lcl\.setSessionEffort\(active\.id, idx\)/.test(app), null);
    check("...and out-of-range levels are refused, not written",
        /n < 0 \|\| n > 4/.test(main), null);
}

/* [9] MAJOR — the ceiling was checked only BETWEEN rounds, so one forced round
 * could run its whole step budget of paid generations past it. */
{
    const src = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("the AK spend ceiling is also checked INSIDE a forced round",
        /akRound > 0 && akSpendNow\(\) > 0 && akSpendNow\(\) >= akBudgetUsd/.test(src), null);
    check("...and hitting it says so as the machine, with the ceiling named",
        /guardKind: "budget"/.test(src), null);
}

/* [10] MAJOR — money spent by ask_cloud_model / ask_reasoner inside a forced
 * round never touched turnUsd, so the AK budget could not see it. */
{
    const cm = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"), "utf8");
    const ag = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("escalation spend reports back to the turn",
        /function recordEscalation\(sessionId, sessionTitle, r, onSpend\)/.test(cm)
        && /typeof onSpend === "function"\) onSpend\(usd\)/.test(cm), null);
    check("...every call site threads it", (cm.match(/, ctx\.onSpend\);/g) || []).length === 3,
        (cm.match(/, ctx\.onSpend\);/g) || []).length);
    check("...and the turn adds it to its own total",
        /onSpend: \(usd\) => \{ if \(usd > 0\) turnUsd \+= usd; \}/.test(ag), null);
}

/* [11] MINOR — the ledger tagged only auditor calls as AK while the review
 * counted forced driver rounds too, so the two AK-spend surfaces disagreed. */
{
    const s = makeSession({ effortLevel: 1 });
    const paid = (t) => ({ content: t, remote: true, model: "paid/m",
        endpoint: "api.example.com",
        usage: { prompt_tokens: 100, completion_tokens: 50 }, cost: { usd: 0.001 } });
    await turn(s, [
        paid("First answer."),
        { content: "VERDICT: GAPS\nGAP: a real gap" },
        paid("Fixed it."),
        { content: "VERDICT: CLOSED" }
    ]);
    const rows = ledger.summary().recent.filter(r => r.sessionId === s.id);
    check("a FORCED round's driver spend is tagged ancient-knowledge in the ledger, " +
        "so Spend and the session review agree on what AK cost",
        rows.some(r => r.via === "ancient-knowledge" && r.model === "paid/m"), rows.map(r => r.via));
    check("...while the ordinary first answer is still the user's own turn",
        rows.some(r => r.via === "user"), rows.map(r => r.via));
}

/* [12] MINOR — the budget override existed only for tests. */
{
    const main = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
    check("the AK budget is settable in production, not a test-only knob",
        /akBudgetUsd:/.test(main) && /ancientBudgetUsd/.test(main), null);
}

/* [4] MINOR — retry generations dropped the session, so every effort mapping
 * silently fell back to defaults for them. */
{
    const src = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("retry generations carry the session, so effort still applies to them",
        !/cancelToken, null, \{ selection: sel \}\)/.test(src)
        && (src.match(/\{ selection: sel, session \}\)/g) || []).length >= 2, null);
}

/* [13] MAJOR — unlinking the workspace left the brain lit with nowhere to
 * write: audits ran and billed, and their findings went nowhere. */
{
    const app = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    const i = app.indexOf("const res = await window.lcl.unlinkRepo(active.id);");
    const blk = app.slice(i, i + 1200);
    check("UNLINKING THE WORKSPACE TURNS ANCIENT KNOWLEDGE OFF — the same " +
        "decision in reverse, and it says so",
        /active\.ancientKnowledge = false/.test(blk)
        && /setSessionAncientKnowledge\(active\.id, false\)/.test(blk)
        && /addNotice\(/.test(blk), null);
}

/* [14][15] MAJOR — the sidebar review opener re-read the global `active` across
 * two awaits (a session switch mid-await opened the wrong review), and picked
 * the first name that merely looked like a review — which in a shared folder is
 * another session's suffixed file, sorting before the plain one. */
{
    const app = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    const i = app.indexOf("async function refreshReviewDoc(");
    const blk = app.slice(i, i + 2200);
    check("the review opener works on the TURN'S session, re-checked after every await",
        /refreshReviewDoc\(newMessages, forSession\)/.test(blk)
        && /const stillViewing = \(\) => active && active\.id === ses\.id/.test(blk)
        && (blk.match(/stillViewing\(\)/g) || []).length >= 3, null);
    check("...and it is passed the turn's own session at the call site",
        /refreshReviewDoc\(newMessages, session\)/.test(app), null);
    check("...and it opens THIS session's review file, not the first lookalike",
        /ses\.akReviewFile/.test(blk) && /suffixed/.test(blk), null);
}

/* [16] MINOR — the enable gate's folder picker is refused while a turn runs. */
{
    const app = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    check("enabling mid-turn says why instead of opening a dead modal",
        /if \(!wasOn && pending && !active\.repoPath\)/.test(app), null);
}

/* ======================================================================
 * THE ADVOCATE — answering the model's question from what the user already
 * said, and folding an afterthought into the request being answered.
 *
 *   Ancient Knowledge should feel like the user's advocate — their best
 *   friend, lawyer, or partner.
 *
 * The danger being guarded is the opposite of laziness: an eager auditor
 * inventing a preference and sending the model off to build the wrong thing
 * in the user's name. So the standard is one-directional — AK may only
 * answer from words the user actually wrote, and must quote them.
 * ====================================================================== */
{
    const ok = ak.parseClarifyAnswer(
        "ANSWERED: dark theme\nSOURCE: I always want the dark theme", null);
    check("AK answers only WITH the user's own words attached",
        ok.status === "answered" && /dark theme/.test(ok.answer)
        && /always want the dark/.test(ok.source), ok);
    const noSrc = ak.parseClarifyAnswer("ANSWERED: dark theme", null);
    check("AN ANSWER WITH NO SOURCE IS NOT AN ANSWER — speaking for someone is " +
        "only defensible if you can show where they said it",
        noSrc.status === "unanswered", noSrc);
    const placeholder = ak.parseClarifyAnswer(
        "ANSWERED: dark theme\nSOURCE: <the exact words of theirs>", null);
    check("...and the prompt's own placeholder does not count as a source",
        placeholder.status === "unanswered", placeholder);
    const un = ak.parseClarifyAnswer("UNANSWERED: they never said which port", null);
    check("UNANSWERED goes to the user, with why", un.status === "unanswered"
        && /port/.test(un.why), un);
    const both = ak.parseClarifyAnswer(
        "ANSWERED: probably 8080\nSOURCE: guessing\nUNANSWERED: not actually stated", null);
    check("...and UNANSWERED wins a muddled reply — the safe reading hands the " +
        "question back", both.status === "unanswered", both);
    check("a blank auditor is 'unavailable', never an answer",
        ak.parseClarifyAnswer("", null).status === "unavailable", null);
    const invented = ak.parseClarifyAnswer(
        "ANSWERED: postgres\nSOURCE: I like databases", ["sqlite", "mysql"]);
    check("AK CANNOT INVENT AN OPTION THE MODEL NEVER OFFERED",
        invented.status === "unanswered", invented);
    const chosen = ak.parseClarifyAnswer(
        "ANSWERED: sqlite\nSOURCE: keep it a single file", ["sqlite", "mysql"]);
    check("...but it may pick one that was offered", chosen.status === "answered", chosen);
    const ev = ak.clarifyEvidence(
        { messages: [{ role: "user", content: "always use metric" },
                     { role: "assistant", content: "noted" }] },
        "convert the drawings", ["and keep the tolerances"]);
    check("the evidence pack is the user's OWN words plus this turn's ask and " +
        "any afterthoughts — assembled with no model call",
        /always use metric/.test(ev) && /convert the drawings/.test(ev)
        && /keep the tolerances/.test(ev), ev.slice(0, 200));
}

/* THE INTERCEPTION, THROUGH THE REAL runTurn. */
const CLARIFY = (q) => ({ content:
    '```tool\n{"tool": "clarify", "args": {"question": "' + q + '"}}\n```' });
{
    const s = makeSession();
    s.messages = [{ role: "user", content: "use the dark theme everywhere" }];
    const { res, calls } = await turn(s, [
        CLARIFY("Which theme should I use?"),
        { content: "ANSWERED: the dark theme\nSOURCE: use the dark theme everywhere" },
        { content: "Done — applied the dark theme." },
        { content: "VERDICT: CLOSED" }
    ], { userText: "restyle the settings page" });
    check("A QUESTION THE USER ALREADY ANSWERED NEVER REACHES THEM — the model " +
        "asked, AK answered from their own words, and the turn carried on",
        res.ok === true
        && !res.newMessages.some(m => m.meta && m.meta.clarify)
        && res.newMessages.some(m => /applied the dark theme/i.test(m.content || "")),
        res.newMessages.map(m => (m.meta && m.meta.model) || m.role));
    check("...it is SHOWN as Ancient Knowledge speaking, never as the model " +
        "answering itself, and it quotes the words it acted on",
        res.newMessages.some(m => m.meta && m.meta.clarifyAnswer
            && /Ancient Knowledge/.test(m.content)
            && /use the dark theme everywhere/.test(m.content)), null);
    check("...and the model was handed it as the user's own instruction, so it " +
        "carries the authority the question was waiting on",
        calls.some(c => c.messages.some(m => m.role === "user"
            && /answering for the user/i.test(m.content || ""))), null);
    check("...it is on the record in the session review",
        s.akReview.objectives[0].clarifies
        && s.akReview.objectives[0].clarifies.length === 1
        && /dark theme/.test(s.akReview.objectives[0].clarifies[0].answer),
        s.akReview.objectives[0].clarifies);
    check("...and the review document shows what was answered on their behalf",
        /Answered for you/.test(review(s) || "")
        && /your words/.test(review(s) || ""), null);
}

/* AND A GENUINELY NEW QUESTION STILL STOPS THE TURN. */
{
    const s = makeSession();
    const { res } = await turn(s, [
        CLARIFY("Which database should I use?"),
        { content: "UNANSWERED: they never said which database" }
    ], { userText: "build the storage layer" });
    check("A QUESTION THEY HAVE NOT ANSWERED STILL REACHES THEM — AK is an " +
        "advocate, not a substitute",
        res.newMessages.some(m => m.meta && m.meta.clarify
            && /database/i.test(m.content || "")),
        res.newMessages.map(m => (m.meta && m.meta.model) || m.role));
    check("...and no audit runs on a turn that is waiting on the human",
        !s.akReview || !s.akReview.objectives.length, s.akReview);
}

/* AN AUDITOR THAT DIES DOES NOT SWALLOW THE QUESTION. */
{
    const s = makeSession();
    const { res } = await turn(s, [
        CLARIFY("Which port?"),
        { content: "" }                       // the auditor is unavailable
    ], { userText: "start the server" });
    check("if the auditor cannot answer, the question goes to the user rather " +
        "than being quietly dropped",
        res.newMessages.some(m => m.meta && m.meta.clarify), null);
}

/* THE SAME QUESTION IS NEVER INTERCEPTED TWICE. */
{
    const src = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("a question is intercepted once, and a turn cannot spin on it",
        /akAskedQuestions\.has\(akMod\.normGap\(asked\.question\)\)/.test(src)
        && /akClarifyAnswers < AK_CLARIFY_MAX/.test(src), null);
    check("...and every interception is billed as ancient-knowledge",
        /via: "ancient-knowledge"[\s\S]{0,400}?clarify|clarify[\s\S]{0,900}?via: "ancient-knowledge"/.test(src), null);
}

/* THE AFTERTHOUGHT, FOLDED IN RATHER THAN QUEUED. */
{
    const s = makeSession();
    const { calls } = await turn(s, [
        { content: "I built the exporter." },
        { content: "VERDICT: CLOSED" }
    ], { userText: "build an exporter",
         turnOpts: { addenda: ["and make it handle CSV too"] } });
    check("AN AFTERTHOUGHT IS PART OF THE REQUEST BEING ANSWERED, not a turn " +
        "behind it — the interrogation reads it as part of the original ask",
        calls[1].messages[1].content.includes("build an exporter")
        && /CSV/.test(calls[1].messages[1].content), null);
    check("...and the objective in the review carries it, so 'done' has to " +
        "cover it too",
        /CSV/.test(s.akReview.objectives[0].ask), s.akReview.objectives[0].ask);
}

/* main's half: captured while the turn runs, cleared when it ends. */
{
    const main = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    check("a message sent into a WORKING session with AK on is captured as an " +
        "addendum instead of being refused",
        /const sessionAddenda = new Map\(\)/.test(main)
        && /live\.ancientKnowledge === true/.test(main)
        && /return \{ ok: true, addendum: true/.test(main), null);
    check("...it reaches the turn LIVE, not as a value captured before it existed",
        /get addenda\(\) \{ return sessionAddenda\.get\(id\) \|\| \[\]; \}/.test(main), null);
    check("...it is bounded, so a burst cannot grow without limit",
        /list\.length >= 10/.test(main), null);
    check("...and cleared when the turn ends, so the next message is a message",
        /sessionAddenda\.delete\(id\)/.test(main), null);
    check("WITHOUT Ancient Knowledge the old refusal stands — nothing pretends " +
        "to carry a message there is no mechanism for",
        /this session is already replying/.test(main), null);
    check("the composer stays live for it, and says what it is for",
        /active\.ancientKnowledge === true && pending/.test(app)
        && /Ancient Knowledge folds it into this request/.test(app), null);
    check("...and the renderer sends it down the addendum path, not as a turn",
        /res && res\.addendum/.test(app), null);
}
/* ============ ancient_knowledge.md IS A RUNNING TO-DO, NOT A SNAPSHOT ==== */
{
    // The specification for what this file IS:
    //
    //   Ancient Knowledge is one thing: a markdown file it creates called
    //   ancient_knowledge.md that keeps up with what is going on, so it keeps
    //   track of what needs to be done.
    //
    // `obj.gaps` was only ever the LATEST verdict's list, overwritten every
    // round — so an item that got fixed simply vanished, and the file could
    // answer neither "what is left" nor "what has been dealt with". It showed a
    // snapshot and called it a record.
    const s = makeSession();
    const o = ak.openObjective(s, "build the logbook page");
    ak.updateObjective(s, o, { verdict: { status: "gaps", raw: "",
        gaps: ["index.html was never written", "no tests ran"] }, round: 1 });
    ak.updateObjective(s, o, { verdict: { status: "gaps", raw: "",
        gaps: ["no tests ran"] }, round: 2 });

    const done = o.todo.filter(t => t.status === "done").map(t => t.text);
    const open = o.todo.filter(t => t.status === "open").map(t => t.text);
    check("AN ITEM THE AUDITOR STOPS REPORTING IS TICKED, NOT DELETED — a " +
          "to-do that forgets what it completed is a snapshot wearing a checkbox",
        done.length === 1 && /index\.html/.test(done[0]), { done, open });
    check("...and one it is still reporting stays open",
        open.length === 1 && /no tests ran/.test(open[0]), { done, open });
    check("...and nothing is ticked by the very round that raised it",
        o.todo.every(t => t.status !== "done" || t.doneAt > t.firstSeen),
        o.todo.map(t => ({ t: t.text.slice(0, 20), first: t.firstSeen, done: t.doneAt })));

    ak.updateObjective(s, o, { verdict: { status: "gaps", raw: "",
        gaps: ["No tests RAN!"] }, round: 3 });
    check("a reworded gap updates the SAME item — identity is shape, not " +
          "spelling, or the list grows a duplicate every single round",
        o.todo.length === 2, o.todo.map(t => t.text));

    ak.updateObjective(s, o, { verdict: { status: "closed", gaps: [], raw: "" },
                               round: 4, stopped: "closed" });
    check("a CLOSED verdict ticks off everything still outstanding",
        o.todo.every(t => t.status === "done"), o.todo.map(t => [t.text, t.status]));

    const s2 = makeSession();
    const o2 = ak.openObjective(s2, "build it");
    ak.updateObjective(s2, o2, { verdict: { status: "gaps", gaps: ["a thing"], raw: "" },
                                 round: 1 });
    ak.updateObjective(s2, o2, { verdict: { status: "unavailable", gaps: [], raw: "" },
                                 round: 2, stopped: "review-unavailable" });
    check("A BLANK AUDITOR TICKS NOTHING OFF. Silence is not completion here " +
          "either — the same rule that stops it being read as 'all gaps closed'",
        o2.todo[0].status === "open", o2.todo.map(t => [t.text, t.status]));
}
{
    /* ---------- and the DOCUMENT leads with it, across every request ------- */
    const s = makeSession();
    const o1 = ak.openObjective(s, "build the logbook page");
    ak.updateObjective(s, o1, { verdict: { status: "gaps", raw: "",
        gaps: ["index.html missing", "no tests ran"] }, round: 1 });
    ak.updateObjective(s, o1, { verdict: { status: "gaps", raw: "",
        gaps: ["no tests ran"] }, round: 2 });
    const o2 = ak.openObjective(s, "also add the changelog");
    ak.updateObjective(s, o2, { verdict: { status: "user-test", raw: "",
        gaps: ["click the new button"] }, round: 1, stopped: "user-test" });
    const md = ak.composeReview(s);
    const beforeTrail = md.split("## The audit trail")[0];

    check("the file is headed with the feature's own name for it",
        /# Ancient Knowledge/.test(md), md.slice(0, 90));
    check("WHAT NEEDS DOING COMES FIRST — ahead of the audit trail, because it " +
          "is the question the document exists to answer",
        md.indexOf("## What needs doing") > 0
        && md.indexOf("## What needs doing") < md.indexOf("## The audit trail"), null);
    check("...as unticked checkboxes, so it reads as a to-do",
        /### Still to do/.test(md) && /- \[ \] no tests ran/.test(beforeTrail), null);
    check("...carrying the request each item came from — a long session's list " +
          "still has to say why a line is on it",
        /from: build the logbook page/.test(beforeTrail), null);
    check("what is DONE is kept and ticked, not dropped",
        /### Done/.test(md) && /- \[x\] index\.html missing/.test(beforeTrail), null);
    check("...and what needs the USER is its own section, not mixed in with " +
          "work the model can still do",
        /### Needs you/.test(md) && /- \[ \] click the new button/.test(beforeTrail), null);
    check("THE TO-DO SPANS EVERY REQUEST IN THE SESSION, not one objective — " +
          "based on all of what was captured in the initial request and " +
          "all subsequent requests",
        /no tests ran/.test(beforeTrail) && /click the new button/.test(beforeTrail), null);
    check("the header counts what is outstanding, so the state is legible " +
          "without reading the list",
        /1 still to do . 1 awaiting your test . 1 done/.test(md),
        md.split("\n").find(l => /still to do/.test(l)));
    check("and the audit trail is still underneath it, nested properly",
        /## The audit trail/.test(md) && /#### 1\. build the logbook page/.test(md), null);
}


/* ===== TESTED, NOT ASSUMED — the loop's own mechanical gap ===== */
{
    const wrote=[{role:"tool",name:"write_file",content:JSON.stringify({written:"orb.ino",bytes:100})}];
    check("code written and never executed is flagged by the LOOP, not the auditor's opinion",
        /never executed/.test(ak.untestedLogicGap(wrote)||"") && /sandbox_test/.test(ak.untestedLogicGap(wrote)||""));
    check("...sandbox-tested code passes",
        ak.untestedLogicGap([...wrote,{role:"tool",name:"sandbox_test",content:"{}"}])===null);
    check("...a flash counts as execution (it compiled and runs on the board)",
        ak.untestedLogicGap([...wrote,{role:"tool",name:"flash_device",content:"{}"}])===null);
    check("...a markdown write never flags",
        ak.untestedLogicGap([{role:"tool",name:"write_file",content:JSON.stringify({written:"notes.md",bytes:9})}])===null);
    check("the driver wires it in: a CLOSED verdict cannot outrank untested code",
        (()=>{const A=fs.readFileSync(require("path").join(__dirname,"..",".lcl.engine","core","agent.js"),"utf8");
        return A.includes("ak.untestedLogicGap(newMessages)") && A.includes("verdict.status = \"gaps\"");})());
    // BOTH drivers wire it in. The orchestrated runCycle used to parse the verdict
    // and never apply this gap, so a multi-step build that wrote code and ran
    // nothing could close CLOSED. It now scans the build's messages here too.
    check("runCycle applies the untested-logic gap over the build's messages, so an " +
          "orchestrated build cannot close CLOSED with code that never ran",
        (()=>{const K=fs.readFileSync(require("path").join(__dirname,"..",".lcl.engine","core","ancientKnowledge.js"),"utf8");
        return /untestedLogicGap\(\[\.\.\.buildMessages, \.\.\.out\.messages\]\)/.test(K)
            && K.includes('verdict.status = "gaps"');})());
    // the orchestrator hands those messages down
    check("the orchestrator collects each step's messages and passes them to runCycle",
        (()=>{const O=fs.readFileSync(require("path").join(__dirname,"..",".lcl.engine","core","orchestrator.js"),"utf8");
        return O.includes("allMessages.push(...r.stepMessages)") && /messages: allMessages/.test(O);})());
}

/* ---- THE PRESENTATION, from the open list (7c #2), verbatim: "It must
 * read as though the USER sent it: keep the brain SVG, the title and the
 * colour, but the bubble background matches a user message. The brain's
 * colour must match the reasoning-level colour mapped to that SVG." ---- */
{
    const path2 = require("path");
    const appSrc = fs.readFileSync(path2.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    const cssSrc = fs.readFileSync(path2.join(__dirname, "..", "app", "renderer", "styles.css"), "utf8");
    check("the audit bubble WEARS THE USER MESSAGE'S GROUND — the same gradient, " +
          "frame and user-side geometry as .msg-user, sitting on the user's side",
        (() => {
            const a = /\.msg-ancient \{[^}]*\}/s.exec(cssSrc);
            return a && a[0].includes("linear-gradient(180deg, #1e1e22, #131316)")
                && a[0].includes("border: 1px solid var(--line-strong)")
                && a[0].includes("align-self: flex-end")
                && /\.msg-row\.assistant\.ancient \{ align-self: flex-end;/.test(cssSrc);
        })());
    check("...the brain SVG and title stay — cloned from the composer button, " +
          "labelled Ancient Knowledge, with the head's own rule",
        appSrc.includes('document.querySelector("#brain-btn svg")')
        && appSrc.includes('label.innerText = "Ancient Knowledge"'));
    check("...and the brain wears the SESSION'S REASONING COLOUR — the head " +
          "takes effort-N from the session's effortLevel (default 0) and the " +
          "CSS maps the SAME five colours the composer's #brain-btn wears",
        appSrc.includes('head.className = "msg-ancient-head effort-" + effortIdx')
        && /typeof active\.effortLevel === "number"\)\s*\n?\s*\? active\.effortLevel : 0/.test(appSrc)
        && [0, 1, 2, 3, 4].every(n =>
            cssSrc.includes(`.msg-ancient-head.effort-${n} {`))
        && (() => {
            // the palette MATCHES the composer brain's, colour for colour
            const pair = (sel, n) => {
                const m = new RegExp(sel.replace(/[.#]/g, "\\$&")
                    + "\\.effort-" + n + " \\{[^}]*color: (#[0-9a-f]+)", "i");
                const r = m.exec(cssSrc);
                return r && r[1].toLowerCase();
            };
            return [0, 1, 2, 3, 4].every(n =>
                pair("#brain-btn", n) && pair("#brain-btn", n) === pair(".msg-ancient-head", n));
        })());
}

console.log(`\n${pass}/${pass + fail} ancient-knowledge checks passed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL | suite crashed -", (e && e.stack) || e); process.exit(1); });
