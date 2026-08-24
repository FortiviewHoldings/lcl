/**
 * FORK A SESSION — a new conversation that begins where this one was.
 *
 * The goal: compaction and "forking into N linked sessions". The
 * semantics are opencode's (packages/opencode/src/session/session.ts,
 * Session.fork), ported by shape:
 *
 *   - the fork copies the messages UP TO a chosen point (or all of them),
 *   - its title says what it is: "<title> (fork #N)", and forking a fork
 *     increments N rather than nesting parentheses,
 *   - it stays linked to its parent (`forkedFrom`), so the relationship is a
 *     recorded fact rather than something remembered.
 *
 * What is deliberately NOT copied, and why — this is where a fork quietly
 * corrupts things if done by spread operator:
 *
 *   akReviewFile   The parent's ancient_knowledge.md name is PERSISTED on the
 *                  session. A fork sharing the parent's workspace would write
 *                  into the parent's review file — two sessions, one audit
 *                  document, silently interleaved. Dropped, so the fork
 *                  derives its own name (the marker check in reviewFileName
 *                  gives it a suffixed file in a shared folder).
 *   akReview       The audit record of turns the fork will never run. The
 *                  history it shares with the parent is already in the copied
 *                  messages; the fork's own auditing starts at zero.
 *   changes        Filtered to the records the KEPT messages actually carry.
 *                  Copying all of them would let a fork made from message 10
 *                  revert an edit from message 40 of a conversation it does
 *                  not contain.
 *
 * Pure: takes a session object, returns a new one. No fs, no electron — the
 * caller persists it. Testable in plain node.
 */

const crypto = require("crypto");

/** "<title> (fork #N)" — forking a fork counts up instead of nesting. */
function forkedTitle(title) {
    const t = String(title || "").trim() || "Session";
    const m = /^(.+) \(fork #(\d+)\)$/.exec(t);
    if (m) return `${m[1]} (fork #${Number(m[2]) + 1})`;
    return `${t} (fork #1)`;
}

/**
 * @param original     the session object as loaded from disk
 * @param messageIndex copy messages BEFORE this index; omit for all of them
 * @returns a new, unsaved session object
 */
function fork(original, messageIndex) {
    if (!original || !Array.isArray(original.messages)) {
        throw new Error("fork needs a session with messages");
    }
    const n = original.messages.length;
    const cut = Number.isInteger(messageIndex) && messageIndex >= 0
        ? Math.min(messageIndex, n) : n;
    // structuredClone, so the fork can never share a mutable object with the
    // parent — a message edited in one appearing in the other is the kind of
    // defect nobody traces for a week
    const messages = structuredClone(original.messages.slice(0, cut));

    // only the change records the kept messages actually carry
    const keptIds = new Set(messages
        .filter(m => m && m.change && m.change.id)
        .map(m => m.change.id));
    const changes = structuredClone((original.changes || [])
        .filter(c => c && keptIds.has(c.id)));

    return {
        id: crypto.randomUUID(),
        title: forkedTitle(original.title),
        createdAt: Date.now(),
        messages,
        changes,
        // the conversation's SETTINGS carry over — model choice, permissions,
        // effort, the brain, the workspace. They are what make the fork a
        // continuation rather than a fresh start.
        ...(original.repoPath ? { repoPath: original.repoPath } : {}),
        ...(original.perms ? { perms: structuredClone(original.perms) } : {}),
        ...(original.modelId ? { modelId: original.modelId } : {}),
        ...(original.endpointId ? { endpointId: original.endpointId } : {}),
        ...(original.effortLevel !== undefined ? { effortLevel: original.effortLevel } : {}),
        ...(original.ancientKnowledge !== undefined
            ? { ancientKnowledge: original.ancientKnowledge } : {}),
        // the link, recorded — not inferred from the title
        forkedFrom: {
            id: original.id,
            title: original.title || "",
            messageIndex: cut,
            at: Date.now()
        }
    };
}

module.exports = { fork, forkedTitle };
