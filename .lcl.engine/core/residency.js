/**
 * THE ONE RESIDENT MODEL, HELD FOR THE LENGTH OF A TURN.
 *
 * A queue that orders generations does not order RESIDENCY: two sessions on
 * two different local models would each load theirs and then answer on
 * whichever landed last. So a turn that named a specific local model takes
 * this gate and holds it until the turn ends. Turns wanting the SAME model
 * share it freely — there is nothing to protect them from — and a turn wanting
 * a different one waits, which is the same physics that already makes local
 * generations queue.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES IN ITS OWN FILE.
 *
 * It used to sit in the middle of main.js, where the only thing that could
 * test it was a regex over the source. It had a deadlock in it, and the regex
 * happily matched the exact expression that deadlocked:
 *
 *     if (residencyHolders > 0 && residencyModel === modelId) {
 *         residencyHolders++;
 *         return Promise.resolve(() => { residencyHolders--; });   // <-- here
 *     }
 *
 * The JOINER's releaser only decrements. It never checks for zero and never
 * resolves the promise the queue is waiting on. So whenever the joining
 * session finished LAST — the ordinary case, since the second turn to start is
 * usually the second to end — holders went to 0, `release()` was never called,
 * `residencyChain` stayed pending forever and `residencyModel` stayed set.
 * From that moment every local turn in the app hung on `await
 * holdLocalResidency(...)`, which sits BEFORE the turn registers itself, so
 * the session never showed as working and Stop could not find it either: a
 * dead composer and a spinner until the app was restarted.
 *
 * The operator's first test is two local sessions on the same model. It bricked
 * on step one, every time.
 *
 * In a module, the fix is provable by running it rather than by grepping for
 * it — see tests/residency.js, which drives the real acquire/release orders.
 * ---------------------------------------------------------------------------
 */

function createResidency() {
    let chain = Promise.resolve();
    let model = null;          // what the current holders are using
    let holders = 0;
    let releaseChain = null;   // resolves `chain` when the LAST holder leaves

    /**
     * A releaser for one holder.
     *
     * Idempotent, because the caller releases in a `finally` and a turn that
     * fails after already releasing would otherwise decrement twice and hand
     * the gate to two turns at once. Every holder gets its own; they all close
     * over the same `releaseChain`, which is the half the old joiner lacked.
     */
    function releaser() {
        const rel = () => {
            if (rel.done) return;
            rel.done = true;
            holders--;
            if (holders <= 0) {
                holders = 0;
                model = null;
                const r = releaseChain;
                releaseChain = null;
                if (r) r();
            }
        };
        return rel;
    }

    function hold(modelId) {
        // already held for this exact model: join it rather than serialising
        // conversations that are not in conflict
        if (holders > 0 && model === modelId) {
            holders++;
            return Promise.resolve(releaser());
        }
        let release;
        const mine = new Promise((resolve) => { release = resolve; });
        const wait = chain.then(() => {
            model = modelId;
            holders = 1;
            releaseChain = release;
            return releaser();
        });
        chain = chain.then(() => mine).catch(() => {});
        return wait;
    }

    /** What is resident and how many turns are on it — for tests and status. */
    function state() { return { model, holders }; }

    return { hold, state };
}

/* The app has exactly one engine, so it has exactly one of these. */
const shared = createResidency();

module.exports = {
    createResidency,
    holdLocalResidency: shared.hold,
    residencyState: shared.state
};
