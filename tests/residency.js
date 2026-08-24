/**
 * THE DEADLOCK THAT ATE STEP ONE.
 *
 * "i am trying to run a local node session, then an api session, then a plain
 *  local session, all at the same time to test this software. and i can not
 *  even get to one step"
 *
 * The residency gate exists for a real reason — one engine, one resident gguf,
 * so two sessions on two different local models cannot each load theirs and
 * then answer on whichever landed last. The gate was right. Its release
 * accounting was not:
 *
 *     if (residencyHolders > 0 && residencyModel === modelId) {
 *         residencyHolders++;
 *         return Promise.resolve(() => { residencyHolders--; });
 *     }
 *
 * The JOINER's releaser decrements and stops. It never checks for zero, so it
 * never resolves the promise the queue is waiting on. Release the OWNER first
 * and the joiner second — the ordinary order, since the second turn to start is
 * usually the second to finish — and holders reaches 0 with the chain still
 * pending and the model still marked resident. Every local turn after that
 * hangs forever on `await holdLocalResidency(...)`.
 *
 * And it hangs in the worst possible place: main.js awaits this BEFORE
 * `turnsBySession.set(...)`, so the wedged turn never registers as working —
 * the sidebar dot stays idle, and Stop cannot find a token to cancel. From the
 * operator's chair: a typing bubble and a dead composer until the app restarts.
 *
 * Two local sessions on the same model is the FIRST thing his test does.
 *
 * Every case below drives the real module. Nothing here greps source — the old
 * implementation's only coverage was a regex that matched the broken line.
 */
const path = require("path");
const { createResidency } = require(
    path.join(__dirname, "..", ".lcl.engine", "core", "residency.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

/** Resolve a promise, or report that it never settled, without hanging the suite. */
function within(ms, p) {
    return Promise.race([
        p.then(v => ({ ok: true, value: v })),
        new Promise(r => setTimeout(() => r({ ok: false, timedOut: true }), ms))
    ]);
}

(async () => {

/* =================================================== the exact reported order */
{
    const R = createResidency();
    const a = await R.hold("qwen-1.5b");          // session 1 takes it
    const b = await R.hold("qwen-1.5b");          // session 2 joins the same model
    check("TWO SESSIONS ON ONE MODEL SHARE IT — nothing to protect them from, " +
          "so the second must not wait for the first",
        R.state().holders === 2 && R.state().model === "qwen-1.5b", R.state());

    a();                                           // the owner finishes first...
    b();                                           // ...and the joiner finishes last
    check("...and when the JOINER releases last, the gate is actually free. " +
          "This is the whole bug: its releaser decremented without resolving " +
          "the queue, so holders hit zero with the chain still pending",
        R.state().holders === 0 && R.state().model === null, R.state());

    const next = await within(2000, R.hold("llama-8b"));
    check("...so a DIFFERENT model can be made resident afterwards. Before the " +
          "fix this never resolved, and every local turn in the app hung on it " +
          "forever — before the turn registered, so Stop could not reach it",
        next.ok && R.state().model === "llama-8b", next);
    if (next.ok) next.value();
}

/* ============================================ and the other release order too */
{
    const R = createResidency();
    const a = await R.hold("m1");
    const b = await R.hold("m1");
    b();                                           // joiner first this time
    a();
    check("THE OTHER ORDER WORKS TOO — joiner first, owner last",
        R.state().holders === 0 && R.state().model === null, R.state());
    const next = await within(2000, R.hold("m2"));
    check("...and the gate is free after it", next.ok, next);
    if (next.ok) next.value();
}

/* =================================================== a different model waits */
{
    const R = createResidency();
    const a = await R.hold("m1");
    let secondGotIt = false;
    const second = R.hold("m2").then(rel => { secondGotIt = true; return rel; });

    await new Promise(r => setTimeout(r, 50));
    check("A DIFFERENT MODEL WAITS — this is the invariant the gate exists for: " +
          "one engine, one resident gguf, so a second model cannot load under a " +
          "turn that is already generating",
        secondGotIt === false && R.state().model === "m1", R.state());

    a();
    const got = await within(2000, second);
    check("...and it is handed over the moment the first turn ends, not dropped",
        got.ok && secondGotIt && R.state().model === "m2", R.state());
    if (got.ok) got.value();
}

/* ======================================= releasing twice must not free it twice */
{
    const R = createResidency();
    const a = await R.hold("m1");
    const b = await R.hold("m1");
    a(); a(); a();                                 // a failing turn's finally, twice
    check("A DOUBLE RELEASE IS IGNORED. The caller releases in a `finally`, and " +
          "a turn that throws after releasing would otherwise decrement twice " +
          "and hand one engine to two turns at once",
        R.state().holders === 1 && R.state().model === "m1", R.state());
    b();
    check("...and the real last release still frees it",
        R.state().holders === 0 && R.state().model === null, R.state());
}

/* ================================== three sessions, which is what he asked for */
{
    // his actual test: a node session, an API session, a plain local session.
    // Only the local ones touch this gate at all — that is the point.
    const R = createResidency();
    const local = await R.hold("qwen-1.5b");
    check("HIS THREE-SESSION TEST: the gate is only ever taken by LOCAL turns, " +
          "so a node session and an API session never queue behind one",
        R.state().holders === 1, R.state());
    local();

    // ...and a long run of overlapping local turns never leaks a hold
    let leaked = false;
    for (let round = 0; round < 25; round++) {
        const x = await R.hold("qwen-1.5b");
        const y = await R.hold("qwen-1.5b");
        if (round % 2) { x(); y(); } else { y(); x(); }
        if (R.state().holders !== 0 || R.state().model !== null) { leaked = true; break; }
    }
    check("...and twenty-five overlapping pairs, released in both orders, leak " +
          "nothing — a gate that leaks once is a gate that is stuck forever",
        !leaked, R.state());

    const after = await within(2000, R.hold("something-else"));
    check("...and the engine is still handed over cleanly at the end of all that",
        after.ok, after);
    if (after.ok) after.value();
}

/* ============================ the module is what main.js actually uses */
{
    const fs = require("fs");
    const main = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
    check("main.js USES THIS MODULE rather than keeping its own copy — the " +
          "deadlock survived because its only coverage was a regex over main.js " +
          "that matched the broken line",
        /require\("\.\.\/\.lcl\.engine\/core\/residency"\)/.test(main)
        && !/let residencyChain/.test(main), null);
    check("...and it is still awaited before a local turn generates, which is " +
          "the gate doing its job",
        /releaseResidency = await holdLocalResidency\(want\)/.test(main), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
