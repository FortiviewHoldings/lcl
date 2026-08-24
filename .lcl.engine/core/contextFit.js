/**
 * A CONVERSATION THAT OUTGREW THE WINDOW MUST STILL ANSWER.
 *
 * This is one rule that two completely separate paths need, and neither had:
 *
 *   local  — engine.js  -> bundled llama.cpp on this machine
 *   remote — cloudModels.js -> a node of the user's own, or an API vendor
 *
 * MEASURED, both with a real model rather than a stub:
 *   local   engine HTTP 400: request (43714 tokens) exceeds the available
 *           context size (16384 tokens)            ...returned in 129 ms
 *   remote  bench-node returned 400: request (6432 tokens) exceeds the
 *           available context size (2048 tokens)   ...thrown
 *
 * In both cases a session answered happily until the day its history crossed
 * the window, and was dead from then on, while a brand-new session on the same
 * model replied fine. That is the reported failure: the context of the other
 * sessions is what kills the service, while a session with no context yet can
 * work.
 *
 * The remedy is the ordinary one every chat program needs: WHEN THE PROMPT DOES
 * NOT FIT, DROP THE OLDEST TURNS AND TRY AGAIN. Two rules keep it safe, and one
 * keeps it fast:
 *   - a leading system message is never dropped; it is the instructions.
 *   - the newest exchange is never dropped; it is what was just asked.
 *   - aim well INSIDE the window rather than at its edge. A prompt trimmed to
 *     just-fit still has to be read before the first token appears — measured
 *     at 282 s for a near-full 16k window on this CPU against 110 s for a half
 *     one — and a prompt filling the window leaves no room for the reply.
 *
 * It lives in its own file so the two paths cannot drift, because they already
 * did once: the local side got a detector that returned an error nobody read,
 * and the remote side never got one at all.
 */

/* llama.cpp says exactly how many tokens it was handed and how many it had room
 * for, on both the OpenAI surface and the slot surface. A MEASURED token count
 * beats any estimate made on this side of the wire, so the numbers are lifted
 * out when they are there and the caller re-fits against the engine's own
 * arithmetic. Ollama and the vendors reuse these phrasings. */
const CTX_OVERFLOW_RE =
    /exceeds? the available context size|larger than the max context size|exceed_context_size|context[_ ]length[_ ]exceeded|maximum context length/i;

/** Does this error text mean "the prompt did not fit"? Numbers when present. */
function overflowFrom(text) {
    const s = String(text || "");
    if (!CTX_OVERFLOW_RE.test(s)) return null;
    // "request (6432 tokens) exceeds the available context size (2048 tokens)"
    const pair = /\((\d+)\s*tokens?\)[^()]*\((\d+)\s*tokens?\)/.exec(s);
    // some builds report it as JSON fields instead of prose
    const np = /"?n_prompt_tokens"?\s*[:=]\s*(\d+)/.exec(s);
    const nc = /"?n_ctx"?\s*[:=]\s*(\d+)/.exec(s);
    return {
        promptTokens: pair ? Number(pair[1]) : (np ? Number(np[1]) : null),
        windowTokens: pair ? Number(pair[2]) : (nc ? Number(nc[1]) : null),
        message: s.slice(0, 300)
    };
}

const MIN_KEEP_TURNS = 2;      // the last exchange always survives
const TARGET_FILL = 0.5;       // land near half the window, not against its wall

/**
 * Shed the oldest turns. Returns null when there is nothing left to shed, so a
 * caller can report honestly instead of looping.
 */
function trimForWindow(messages, overflow) {
    const head = (messages[0] && messages[0].role === "system") ? [messages[0]] : [];
    const body = messages.slice(head.length);
    if (body.length <= MIN_KEEP_TURNS) return null;

    const over = overflow && overflow.promptTokens && overflow.windowTokens
        ? overflow.promptTokens / overflow.windowTokens
        : 2;                                   // no numbers: halve and re-ask
    const keepFrac = Math.min(0.9, TARGET_FILL / Math.max(1.05, over));
    let keep = Math.max(MIN_KEEP_TURNS, Math.floor(body.length * keepFrac));
    if (keep >= body.length) keep = body.length - 1;

    return { messages: [...head, ...body.slice(body.length - keep)],
             dropped: body.length - keep };
}

const MAX_PASSES = 6;          // each pass sheds a real fraction, so this converges

/**
 * Run `send(messages)` and re-fit if the far side says the prompt was too big.
 *
 * `send` resolves a result and may also THROW — the local path returns
 * { error } and the remote path throws a ToolError, and both shapes have to be
 * handled here or one of them silently keeps the bug.
 *
 * `isOverflow(resultOrError)` lets each caller say how its own failures look.
 * Returns whatever `send` returned, with `dropped` and `trimmed` attached when
 * anything had to go, so the interface can SAY that earlier messages were left
 * out rather than quietly losing the start of a conversation.
 */
async function sendFitting(messages, send, { isOverflow, cancelToken } = {}) {
    const detect = isOverflow || ((x) => overflowFrom(x && (x.error || x.message)));
    let attempt = messages;
    let dropped = 0;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        let result, thrown = null;
        try { result = await send(attempt); }
        catch (e) { thrown = e; }

        const over = thrown ? detect(thrown) : detect(result);
        if (!over) {
            if (thrown) throw thrown;
            return dropped ? { ...result, dropped, trimmed: true } : result;
        }
        if (cancelToken && cancelToken.cancelled) {
            if (thrown) throw thrown;
            return result;
        }
        const t = trimForWindow(attempt, over);
        if (!t) {                       // even one exchange will not fit
            if (thrown) throw thrown;
            return result;
        }
        attempt = t.messages;
        dropped += t.dropped;
    }
    const e = new Error("this turn will not fit in the model's context window " +
                        "even after dropping earlier messages");
    e.dropped = dropped;
    throw e;
}

module.exports = {
    CTX_OVERFLOW_RE, overflowFrom, trimForWindow, sendFitting,
    MIN_KEEP_TURNS, TARGET_FILL, MAX_PASSES
};
