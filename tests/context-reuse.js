/**
 * A LONG SESSION MUST NOT PAY FOR ITS WHOLE HISTORY ON EVERY TURN.
 *
 * llama-server reuses its KV cache only for a matching PREFIX. That single fact
 * decides whether a local session stays usable as it grows:
 *
 *   - APPEND to the conversation  -> prefix intact  -> only new tokens read
 *   - DROP the oldest messages    -> prefix changed -> the whole window re-read
 *
 * Measured on the operator's machine (1.5B q4, ngl 99, ctx 16384):
 *
 *     cold, 7,329 tokens ................. 19,811 ms to first token
 *     append, prefix intact .................. 284 ms   (1.4% of cold)
 *     oldest dropped, 6,467 tokens ........ 17,005 ms   (86% of cold — on FEWER
 *                                                        tokens than the cold run)
 *
 * fitToWindow used to trim to "just fits". Every turn adds a question and an
 * answer, so every turn had to drop about two more messages than the turn
 * before, so the prefix moved EVERY TURN and the cache was never reused once a
 * session outgrew its window. On the 4B this operator runs (~47 tok/s measured)
 * that is over two minutes of silence before every single reply — in exactly
 * the long, productive sessions worth having.
 *
 * The fix is to QUANTIZE the boundary. Overshooting to a smaller token target
 * is not enough and was tried first: keeping a constant-sized tail of a history
 * that grows by two messages a turn still slides the starting message by two
 * every turn, and a prefix that slides by two is as useless to the cache as one
 * that slides by twenty (measured: the boundary still moved on all 15 trimmed
 * turns). Rounding the DROP COUNT up to a fixed grid pins the boundary instead —
 * it holds for several turns, then jumps a whole step, and every turn in between
 * is a pure append.
 *
 * This suite does not measure milliseconds. It asserts the PROPERTY that makes
 * those milliseconds possible: across consecutive turns, the kept prefix stops
 * moving.
 *
 * It also keeps the guarantees the old behaviour had: the system contract and
 * the message just typed are never candidates, and a hopeless prompt is still
 * refused here with numbers rather than by the engine with a shrug.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
process.resourcesPath = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ctxreuse-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

const agent = require(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

const SYSTEM = { role: "system", content: "S".repeat(3000) };
const turn = (n) => ([
    { role: "user", content: `question ${n}: ` + "q".repeat(900) },
    { role: "assistant", content: `answer ${n}: ` + "a".repeat(900) }
]);
const WINDOW = 8192, REPLY = 1024;
const fit = (msgs) => agent.fitToWindow(msgs, { window: WINDOW, replyTokens: REPLY });

/* ------------ THE PROPERTY: the kept boundary stops moving every turn ------ */
{
    // grow a session turn by turn, well past the window, recording which
    // original message each turn's request starts from
    const history = [SYSTEM];
    const firstKeptAt = [];
    const droppedAt = [];
    for (let n = 1; n <= 24; n++) {
        history.push(...turn(n));
        const f = fit([...history, { role: "user", content: "the question just typed" }]);
        droppedAt.push(f.droppedMessages);
        // identity, not index: which original message survived as the first
        // one after the system contract
        firstKeptAt.push(history.indexOf(f.messages[1]));
    }

    const trimmedTurns = droppedAt.filter(d => d > 0).length;
    check("(setup) this session really does outgrow its window — otherwise the " +
          "suite proves nothing", trimmedTurns >= 8, { trimmedTurns, droppedAt });

    // how many times did the prefix MOVE while trimming was in force?
    let moves = 0, trims = 0;
    for (let i = 1; i < firstKeptAt.length; i++) {
        if (droppedAt[i] === 0) continue;
        trims++;
        if (firstKeptAt[i] !== firstKeptAt[i - 1]) moves++;
    }
    check("THE PREFIX HOLDS STILL FOR SEVERAL TURNS AT A TIME. Trimming to " +
          "'just fits' moved it on EVERY turn, so llama-server could never " +
          "reuse a single cached token once a session outgrew its window — " +
          "measured at 86% of a cold read, every reply, forever",
        moves < trims * 0.6, { moves, trims, firstKeptAt });
    check("...and it does still move eventually — a boundary that never moved " +
          "would mean the window was never really enforced",
        moves > 0, { moves, firstKeptAt });

    // the shape that matters: runs of consecutive turns sharing one boundary
    let longestRun = 1, run = 1;
    for (let i = 1; i < firstKeptAt.length; i++) {
        if (firstKeptAt[i] === firstKeptAt[i - 1]) { run++; longestRun = Math.max(longestRun, run); }
        else run = 1;
    }
    check("...long enough to be worth having: several consecutive turns append " +
          "into the same prefix before the next re-read",
        longestRun >= 3, { longestRun, firstKeptAt });
}

/* ------------- a boundary JUMP leaves room to append into ---------------- */
{
    // Headroom is not uniform, and should not be: it is largest right after the
    // boundary jumps and smallest just before the next jump. That is the shape
    // of the mechanism, so the check measures it AT A JUMP rather than at an
    // arbitrary session length — an earlier version of this check sampled one
    // length, landed just before a jump, and failed a working implementation.
    const history = [SYSTEM];
    let prevFirst = null, headroomAtJump = null, everFits = true;
    for (let n = 1; n <= 24; n++) {
        history.push(...turn(n));
        const f = fit([...history, { role: "user", content: "just typed" }]);
        if (!f.fits) everFits = false;
        if (f.promptTokens + f.replyTokens > WINDOW) everFits = false;
        const first = history.indexOf(f.messages[1]);
        if (f.droppedMessages > 0 && prevFirst !== null && first !== prevFirst
            && headroomAtJump === null) {
            headroomAtJump = WINDOW - (f.promptTokens + f.replyTokens);
        }
        prevFirst = first;
    }
    const oneTurn = 600;   // this fixture's question+answer, in budget tokens
    check("WHEN THE BOUNDARY JUMPS IT LEAVES ROOM TO APPEND INTO — that room is " +
          "the cache reuse. A jump that landed exactly on 'it fits' would have " +
          "to jump again on the very next turn",
        headroomAtJump !== null && headroomAtJump > oneTurn * 2,
        { headroomAtJump, needPerTurn: oneTurn });
    check("...and no turn along the way ever exceeded the window",
        everFits, null);
}

/* ------------- an untrimmed prompt is NOT overshot: no history is lost ---- */
{
    const small = [SYSTEM, ...turn(1), { role: "user", content: "just typed" }];
    const f = fit(small);
    check("A SESSION THAT FITS LOSES NOTHING. The quantizing applies only when a " +
          "trim was already unavoidable; it must never volunteer to throw away " +
          "history that would have fitted",
        f.droppedMessages === 0 && f.messages.length === small.length, f);
}

/* ------------------------ the old guarantees still hold ------------------- */
{
    const history = [SYSTEM];
    for (let n = 1; n <= 20; n++) history.push(...turn(n));
    const typed = { role: "user", content: "the question just typed" };
    const f = fit([...history, typed]);
    check("the system contract is never a candidate — dropping it takes every " +
          "tool's help text with it",
        f.messages[0] === SYSTEM, null);
    check("...and neither is the message just typed",
        f.messages[f.messages.length - 1] === typed, null);
    check("...and what left is REPORTED, not dropped silently",
        f.droppedMessages > 0, f.droppedMessages);

    const hopeless = agent.fitToWindow(
        [{ role: "system", content: "S".repeat(40000) }, { role: "user", content: "hi" }],
        { window: WINDOW, replyTokens: REPLY });
    check("a prompt that cannot fit even with no history is still refused HERE, " +
          "with numbers, rather than by the engine with 'invalid response'",
        hopeless.fits === false, hopeless);

    const unknown = agent.fitToWindow([...history, typed], { window: null, replyTokens: REPLY });
    check("an unknown window is still never a reason to refuse a turn that " +
          "would have worked",
        unknown.fits === true && unknown.messages.length === history.length + 1, null);
}

/* ========== ANCIENT KNOWLEDGE IS ITS OWN CONTEXT, NOT THIS ONE ========== */
{
    // The operator's words: "ancient knowledge is its own context, not part of
    // this context. it becomes part of the total context yes, but its the audit
    // trail document."
    //
    // Its audits were ordinary assistant messages, so every one of them was fed
    // back into the model's window on every subsequent turn. On a local model
    // that window is twelve MESSAGES, so a turn that audited twice spent a
    // sixth of everything the model could see on the auditor discussing the
    // work rather than on the work — compounding, and invisible.
    const convo = [
        { role: "user", content: "build me the page" },
        { role: "assistant", content: "Built it." },
        { role: "assistant", content: "**Ancient Knowledge Audit:** gaps found:\n- no file",
          meta: { model: "ancient-knowledge", audit: true, round: 1, verdict: "gaps" } },
        { role: "assistant", content: "Now really built." },
        { role: "assistant", content: "**Ancient Knowledge Audit:** nothing left open.",
          meta: { model: "ancient-knowledge", audit: true, round: 2, verdict: "closed" } },
        { role: "user", content: "now add the footer" }
    ];
    const built = agent.buildModelMessages("SYSTEM", convo, { historyWindow: 12 });
    const texts = built.map(m => String(m.content));

    check("THE AUDIT DOES NOT EAT THE MODEL'S WINDOW — no Ancient Knowledge " +
          "bubble is fed back to the model",
        !texts.some(t => /Ancient Knowledge Audit/.test(t)), texts);
    check("...and the real conversation survives intact around it",
        texts.some(t => /build me the page/.test(t))
        && texts.some(t => /Now really built/.test(t))
        && texts.some(t => /now add the footer/.test(t)), texts);
    check("...so the window carries the WORK, not the commentary about it",
        built.length === 1 + 4, built.length);

    // the filter is by meta, not by prose — a user who types the words must not
    // have their own message deleted from the model's view
    const impostor = agent.buildModelMessages("SYSTEM", [
        { role: "user", content: "what does the Ancient Knowledge Audit line mean?" },
        { role: "assistant", content: "It is the auditor speaking." }
    ], { historyWindow: 12 });
    check("the filter reads META, not prose — asking ABOUT the audit is a real " +
          "message and must reach the model",
        impostor.some(m => /what does the Ancient Knowledge Audit line mean/
            .test(String(m.content))), impostor.map(m => m.content));

    // and the historyWindow is spent on real messages, not consumed by audits
    // that were filtered afterwards
    const noisy = [];
    for (let i = 1; i <= 10; i++) {
        noisy.push({ role: "user", content: `real question ${i}` });
        noisy.push({ role: "assistant", content: `real answer ${i}` });
        noisy.push({ role: "assistant", content: `audit ${i}`,
                     meta: { model: "ancient-knowledge", audit: true } });
    }
    const win = agent.buildModelMessages("SYSTEM", noisy, { historyWindow: 6 });
    const realKept = win.filter(m => /real (question|answer)/.test(String(m.content))).length;
    check("THE WINDOW IS SPENT ON REAL MESSAGES. Filtering after the slice would " +
          "have let audits consume window slots and then vanish, leaving the " +
          "model with a third less conversation than it was budgeted",
        realKept === 6, { realKept, total: win.length - 1 });
}

/* -------------------- the constant is documented where it lives ----------- */
{
    const src = fs.readFileSync(
        path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("the trim grid is a named constant, not a magic number buried in a loop",
        /TRIM_STEP_MESSAGES\s*=\s*\d+/.test(src), null);
    check("...and the code says WHY, with the measurement that justifies it — a " +
          "future reader will otherwise 'fix' it back to just-fits",
        /prefix/i.test(src) && /19,811|17,005|284 ms/.test(src), null);
}

console.log(`\n${pass}/${pass + fail} context-reuse checks passed`);
process.exit(fail ? 1 : 0);
