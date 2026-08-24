/**
 * COMPACTION — REDUCING THE CONTEXT, WHICH IS THE ONLY REASON IT EXISTS.
 *
 * The operator, on what it is for:
 *
 *   "the whole point of compacting is for reducing the context, and yes it is
 *    a manual command"
 *
 * What used to happen instead, and why none of it reduced anything:
 *
 *  1. The renderer sent the summarisation request through `sendText` — an
 *     ORDINARY CHAT TURN. So a wall of text beginning "Please summarize this
 *     conversation so far…" followed by the entire transcript was recorded as
 *     a message the OPERATOR had supposedly typed. It is sitting at index 22
 *     of his own session file. Compaction's first act was to make the
 *     conversation longer.
 *
 *  2. It then reassigned `active.messages` in the RENDERER. Nothing carries a
 *     message list back to the main process — there is no such IPC — and
 *     lcl:chat reloads the session from disk at the start of every turn. So the
 *     full history went straight back to the model on the next message. The
 *     transcript looked compacted; the request was not. The one measurable
 *     thing compaction is supposed to do, it did not do.
 *
 *  3. It identified the summary by taking the last message 500 ms after the
 *     turn resolved. A turn that ended on a tool result silently compacted
 *     nothing.
 *
 * So compaction moves here, beside the session it edits, and follows the rule
 * Ancient Knowledge already follows: THE SUMMARISER RUNS IN ITS OWN CONTEXT.
 * It is not a turn. It never appears as something the operator said. It reads
 * the head of the conversation, replaces that head with one summary message,
 * and the session is SAVED by the caller — which is what finally makes the next
 * request smaller.
 *
 * Nothing is destroyed silently: the messages removed from the session are
 * returned, so a caller can archive them, and the summary is marked
 * `meta.compaction` so the transcript shows where the seam is.
 *
 * Testable in plain node: `plan` and `apply` do the whole job with no engine,
 * and only `run` needs a router.
 */

const SYSTEM =
    "You compact a conversation so work can continue with less context. " +
    "You are given the OLDER part of a conversation between an operator and an " +
    "AI agent. Write a summary that lets the agent carry on as if it still " +
    "remembered all of it.\n\n" +
    "KEEP, in this order of priority:\n" +
    "1. What the operator ASKED FOR — every standing requirement, in their own " +
    "terms, including anything they repeated or insisted on.\n" +
    "2. Decisions made and the reason for each.\n" +
    "3. Files created or changed, by path, and what is in them.\n" +
    "4. What was tried and did NOT work, so it is not tried again.\n" +
    "5. Anything still open.\n\n" +
    "DROP: pleasantries, restated plans, tool output that has served its " +
    "purpose, and your own commentary.\n\n" +
    "Write prose and short lists. Do not address the operator. Do not " +
    "introduce the summary — start with the content.";

/** How many trailing turns stay verbatim. Recent exchanges are the ones the
 *  next message actually depends on, so they are never summarised. */
const KEEP_TAIL_TURNS = 4;
/** Below this there is nothing worth summarising and the operator is told so
 *  rather than being charged for a model call that shortens nothing. */
const MIN_HEAD_MESSAGES = 4;
/** A tool result longer than this is pruned in place before anything else —
 *  the cheapest context there is to reclaim, and free. */
const TOOL_RESULT_CAP = 2000;

/**
 * Decide what would be compacted, without doing it. Pure.
 * @returns {{head, tail, prunable, reason}} — reason is set when there is
 *          nothing worth doing, and is operator-facing.
 */
function plan(messages, { keepTailTurns = KEEP_TAIL_TURNS } = {}) {
    const msgs = Array.isArray(messages) ? messages : [];
    const prunable = msgs.filter(m =>
        m && m.role === "tool" && typeof m.content === "string"
        && m.content.length > TOOL_RESULT_CAP && !(m.meta && m.meta.compacted));

    let turnsFound = 0, tailStart = msgs.length;
    for (let i = msgs.length - 1; i >= 0 && turnsFound < keepTailTurns; i--) {
        if (msgs[i].role === "user") turnsFound++;
        tailStart = i;
    }
    const head = msgs.slice(0, tailStart);
    const tail = msgs.slice(tailStart);
    if (head.length < MIN_HEAD_MESSAGES) {
        return { head, tail, prunable,
                 reason: prunable.length
                     ? `nothing old enough to summarise yet — pruned ${prunable.length} ` +
                       `long tool result${prunable.length === 1 ? "" : "s"} instead`
                     : "this conversation is still short enough that compacting it " +
                       "would not free anything" };
    }
    return { head, tail, prunable, reason: null };
}

/** Prune long tool results in place. Free context, no model call. */
function pruneToolResults(prunable) {
    let n = 0;
    for (const m of prunable || []) {
        m.content = String(m.content).slice(0, 200) + " … [compacted — old tool result]";
        m.meta = { ...(m.meta || {}), compacted: true };
        n++;
    }
    return n;
}

/**
 * The transcript handed to the summariser. Roles are named plainly, and the
 * AUDIT IS LEFT OUT: ancient_knowledge.md is its own record of what is open, so
 * summarising the auditor's commentary would spend the operator's context
 * twice on the same information.
 */
function transcriptOf(head, { perMessage = 1000 } = {}) {
    return head
        .filter(m => !(m && m.meta
                       && (m.meta.model === "ancient-knowledge" || m.meta.audit === true)))
        .map(m => {
            const role = m.role === "assistant" ? "Assistant"
                : m.role === "user" ? "Operator" : "Tool";
            const content = typeof m.content === "string"
                ? m.content : JSON.stringify(m.content);
            return `[${role}]: ${String(content).slice(0, perMessage)}`;
        }).join("\n\n");
}

function userPrompt(head, instructions) {
    return (instructions
        ? `Compact the conversation below, paying particular attention to: ` +
          `${instructions}\n\n`
        : ``) + `CONVERSATION:\n${transcriptOf(head)}`;
}

/**
 * Replace the head with one summary message. Mutates `session.messages` and
 * returns what was removed so the caller can archive it. The summary carries
 * `meta.compaction` so the transcript can show the seam.
 */
function apply(session, { summary, head, tail }) {
    const summaryMsg = {
        role: "assistant",
        content: String(summary || "").trim(),
        meta: { compaction: true, replaced: head.length, at: Date.now() }
    };
    session.messages = [summaryMsg, ...tail];
    return { removed: head, summaryMsg };
}

/**
 * Do it. `generate` is injected (router.generate) so this module stays
 * engine-free for its own tests.
 *
 * @returns {{ok, reason?, pruned, replaced, summaryMsg?, removed?}}
 */
async function run(session, {
    generate, instructions = "", selection, cancelToken = { cancelled: false },
    keepTailTurns = KEEP_TAIL_TURNS, maxTokens = 1200
} = {}) {
    const p = plan(session.messages, { keepTailTurns });
    const pruned = pruneToolResults(p.prunable);
    if (p.reason) return { ok: false, reason: p.reason, pruned, replaced: 0 };
    if (typeof generate !== "function") {
        return { ok: false, reason: "no summariser available", pruned, replaced: 0 };
    }

    let res = null;
    try {
        res = await generate(
            [{ role: "system", content: SYSTEM },
             { role: "user", content: userPrompt(p.head, instructions) }],
            maxTokens, cancelToken, null, { selection, session });
    } catch (err) {
        return { ok: false, pruned, replaced: 0,
                 reason: `the summariser failed: ${String((err && err.message) || err).slice(0, 120)}` };
    }
    if (cancelToken.cancelled) {
        return { ok: false, reason: "cancelled", pruned, replaced: 0 };
    }
    const summary = String((res && res.content) || "").trim();
    // A BLANK SUMMARISER MUST NOT EAT THE CONVERSATION. Replacing the head with
    // an empty message would delete the history and give nothing back — the
    // same class of mistake as laundering a dead auditor into "all gaps closed".
    if (summary.length < 40) {
        return { ok: false, pruned, replaced: 0,
                 reason: "the summariser returned nothing usable — nothing was " +
                         "removed from this conversation" };
    }

    const { removed, summaryMsg } = apply(session, {
        summary, head: p.head, tail: p.tail });
    return { ok: true, pruned, replaced: removed.length, summaryMsg, removed,
             usage: res && res.usage, cost: res && res.cost,
             model: res && res.model, endpoint: res && res.endpoint,
             remote: !!(res && res.remote), localNode: !!(res && res.localNode) };
}

module.exports = {
    SYSTEM, KEEP_TAIL_TURNS, MIN_HEAD_MESSAGES, TOOL_RESULT_CAP,
    plan, pruneToolResults, transcriptOf, userPrompt, apply, run
};
