/**
 * Split a reasoning model's token stream into REASONING and OUTPUT, live.
 *
 * R1-class models emit their chain of thought inline, wrapped in literal
 * <think>...</think> tags, then the answer. Two things make this harder than a
 * regex over each chunk, and both are the reason this is its own file:
 *
 *   1. TAGS SPLIT ACROSS CHUNKS. SSE frames respect no boundary but their own.
 *      "<th" arrives, then "ink>" 40 ms later. A per-chunk regex sees neither,
 *      and every token of the reasoning block leaks into the answer pane. The
 *      parser therefore holds back any suffix that could still become a tag and
 *      re-examines it when the next chunk lands.
 *
 *   2. A HELD-BACK SUFFIX MUST STILL FLUSH. If a stream ends on "<thin" — a
 *      truncated response, a dropped connection — that text is real content and
 *      has to be emitted, not swallowed. end() releases whatever is pending.
 *
 * It is a state machine over two states and a pending buffer. No lookahead
 * beyond the longest tag, no backtracking, no allocation per token.
 */

const OPEN = "<think>";
const CLOSE = "</think>";
// The most characters that could be a partial tag at the end of a chunk.
const MAX_PARTIAL = Math.max(OPEN.length, CLOSE.length) - 1;

/**
 * How many trailing characters of `s` are a proper prefix of `tag`?
 * "abc<thi" against "<think>" -> 4. Used to decide what to hold back.
 */
function danglingPrefix(s, tag) {
    const max = Math.min(s.length, tag.length - 1);
    for (let n = max; n > 0; n--) {
        if (s.endsWith(tag.slice(0, n))) return n;
    }
    return 0;
}

/**
 * @param {object} handlers
 * @param {(text:string)=>void} handlers.onReasoning  tokens inside <think>
 * @param {(text:string)=>void} handlers.onOutput     everything else
 */
function createThinkSplitter({ onReasoning = () => {}, onOutput = () => {},
                               onReclassify = () => {} } = {}) {
    let pending = "";
    let inThink = false;
    // Some providers open the reasoning block implicitly and only ever send the
    // CLOSING tag. Tracked so a stream that starts mid-thought is still routed
    // correctly once </think> shows up.
    let sawAnyTag = false;
    let reasoningChars = 0;
    let outputChars = 0;
    // Output emitted since the last tag boundary. Only needed to support the
    // "stream began mid-thought" case below, and cleared at every boundary so
    // it never grows past one block.
    let emittedSinceBoundary = "";
    let reclassified = false;

    function emit(text, reasoning) {
        if (!text) return;
        if (reasoning) { reasoningChars += text.length; onReasoning(text); }
        else {
            outputChars += text.length;
            if (!sawAnyTag) emittedSinceBoundary += text;
            onOutput(text);
        }
    }

    function push(chunk) {
        if (chunk === null || chunk === undefined) return;
        pending += String(chunk);

        for (;;) {
            const tag = inThink ? CLOSE : OPEN;
            let at = pending.indexOf(tag);

            // A CLOSING tag while we believe we are outside one means the stream
            // began mid-thought: the provider never sent <think>, only </think>.
            // Everything before it was reasoning, and everything after is the
            // answer. Without this the whole chain of thought lands in the
            // answer pane with a stray "</think>" in the middle of it.
            if (!inThink) {
                const closeAt = pending.indexOf(CLOSE);
                if (closeAt !== -1 && (at === -1 || closeAt < at)) {
                    emit(pending.slice(0, closeAt), true);   // implicit reasoning
                    pending = pending.slice(closeAt + CLOSE.length);
                    sawAnyTag = true;
                    // Anything already sent to the output handler since the last
                    // boundary was reasoning too — we only learned that now. A
                    // streaming parser cannot un-send it, so it SAYS SO and the
                    // UI moves it. Silently leaving a chain of thought in the
                    // answer pane is the failure this exists to prevent.
                    if (!reclassified && emittedSinceBoundary) {
                        reclassified = true;
                        onReclassify(emittedSinceBoundary);
                        reasoningChars += emittedSinceBoundary.length;
                        outputChars -= emittedSinceBoundary.length;
                    }
                    emittedSinceBoundary = "";
                    continue;
                }
            }

            if (at !== -1) {
                emit(pending.slice(0, at), inThink);
                pending = pending.slice(at + tag.length);
                inThink = !inThink;
                sawAnyTag = true;
                emittedSinceBoundary = "";
                continue;
            }
            // No complete tag. Emit everything that CANNOT be the start of one,
            // and hold the rest until more arrives.
            //
            // Both tags are considered while outside a think block: a stream
            // that begins inside the reasoning (no opening tag ever sent) still
            // needs its </think> recognised, and holding back only "<think>"
            // prefixes would let "</thi" through as visible output.
            let hold = danglingPrefix(pending, tag);
            if (!inThink) hold = Math.max(hold, danglingPrefix(pending, CLOSE));
            if (hold > 0) {
                emit(pending.slice(0, pending.length - hold), inThink);
                pending = pending.slice(pending.length - hold);
            } else {
                emit(pending, inThink);
                pending = "";
            }
            return;
        }
    }

    /** Flush anything held back. Safe to call more than once. */
    function end() {
        if (pending) {
            // A partial tag at end-of-stream was never a tag. It is text.
            emit(pending, inThink);
            pending = "";
        }
        return { reasoningChars, outputChars, unterminated: inThink };
    }

    return {
        push, end,
        get inThink() { return inThink; },
        get sawAnyTag() { return sawAnyTag; },
        get reclassified() { return reclassified; },
        get stats() { return { reasoningChars, outputChars }; }
    };
}

module.exports = { createThinkSplitter, OPEN, CLOSE, MAX_PARTIAL, danglingPrefix };
