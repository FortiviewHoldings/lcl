const fs = require("fs");
const path = require("path");
const paths = require("./paths");

/**
 * THE MONEY LEDGER — every paid call, kept forever.
 *
 * The composer's cost meter is an ESTIMATE made before a message is sent. This
 * is the opposite: the provider's own reported token counts after the fact,
 * one row per call, appended and never rewritten. The two are different
 * instruments and the app was only ever showing the first — "we have a cost
 * estimator at the bottom, that is not tied to the real token count im seeing
 * in the response."
 *
 * DELETED SESSIONS KEEP THEIR ROWS. A ledger you can erase by tidying up is
 * not a ledger. Deleting a session removes the transcript; the spend stays,
 * with the session's name and a deleted marker, because "what did I spend last
 * month" must survive housekeeping.
 *
 * ESCALATIONS ARE MARKED. When a local model calls out to a paid endpoint
 * through ask_cloud_model, that row carries via:"local-escalation" — money
 * spent by a model rather than by the user directly, which is exactly the
 * breakdown that was asked for by name.
 *
 * Append-only JSONL: one line per call. A crash mid-write costs the last line,
 * never the file.
 */

function file() { return path.join(paths.dataDir(), "cost-ledger.jsonl"); }

/**
 * Record one completed remote call.
 * @param {object} e
 * @param {string} e.sessionId
 * @param {string} e.sessionTitle   captured at spend time, so a rename or a
 *                                  delete cannot orphan the row
 * @param {string} e.model
 * @param {string} e.endpoint
 * @param {number} e.inputTokens    the PROVIDER's number, not an estimate
 * @param {number} e.outputTokens
 * @param {number} e.usd
 * @param {string} [e.via]          "user" | "local-escalation"
 * @param {boolean} [e.localNode]   the tokens came from the user's own machine
 */
function record(e) {
    if (!e || !e.model) return null;
    const row = {
        at: Date.now(),
        sessionId: e.sessionId || null,
        sessionTitle: e.sessionTitle || null,
        model: String(e.model),
        endpoint: e.endpoint || null,
        inputTokens: Math.max(0, Number(e.inputTokens) || 0),
        outputTokens: Math.max(0, Number(e.outputTokens) || 0),
        usd: Math.max(0, Number(e.usd) || 0),
        via: e.via || "user",
        // WHY THIS ROW IS $0. Two different facts land on the same zero: a
        // provider whose rate we could not look up, and a machine the user
        // owns. Only the second is genuinely free, and a ledger that cannot
        // tell them apart cannot answer "how much of this work cost nothing
        // because I bought the hardware" — which is the entire question a
        // person asks after buying a 128 GB box to avoid API bills.
        localNode: e.localNode ? true : undefined,
        // WHY THIS MODEL, WHEN THE SESSION PICKED ANOTHER ONE. A fallback's
        // row used to be indistinguishable from an ordinary call to that
        // model — which made it the perfect disguise: eight reroutes off a
        // refused node model billed here as unremarkable Qwen turns, and the
        // refused model left no row at all. A row that exists because
        // something else failed now names what failed and why.
        fellBackFrom: e.fellBackFrom || undefined,
        fallbackReason: e.fallbackReason ? String(e.fallbackReason).slice(0, 200) : undefined,
        // WHAT THE INPUT WAS MADE OF. Without this, a 20,000-token "hello" is
        // unexplainable and therefore untrustworthy; with it, the drill-down
        // can show that the message was 2 tokens and the standing context was
        // the rest.
        composition: e.composition || null
    };
    try {
        fs.appendFileSync(file(), JSON.stringify(row) + "\n", "utf8");
    } catch { /* a ledger write must never fail a turn the user already paid for */ }
    return row;
}

function readAll() {
    try {
        return fs.readFileSync(file(), "utf8")
            .split("\n").filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
    } catch { return []; }
}

/** Mark a session deleted WITHOUT losing its spend. */
function markSessionDeleted(sessionId, title) {
    if (!sessionId) return;
    try {
        fs.appendFileSync(file(), JSON.stringify({
            at: Date.now(), kind: "session-deleted",
            sessionId, sessionTitle: title || null
        }) + "\n", "utf8");
    } catch { /* nothing to do */ }
}

/**
 * Everything the UI needs, computed once: totals, per-session, per-model,
 * per-day, and the escalation subtotal.
 */
function summary() {
    const rows = readAll();
    const deleted = new Set(rows.filter(r => r.kind === "session-deleted")
        .map(r => r.sessionId));
    const spend = rows.filter(r => !r.kind);

    const bySession = new Map();
    const byModel = new Map();
    const byDay = new Map();
    let totalUsd = 0, totalIn = 0, totalOut = 0, escalationUsd = 0;
    // Work done on the user's own node: real tokens, certain $0. Counted so the
    // dashboard can show what the hardware earned back rather than silently
    // folding it into a total that reads as "nothing happened".
    let nodeCalls = 0, nodeIn = 0, nodeOut = 0;

    for (const r of spend) {
        totalUsd += r.usd; totalIn += r.inputTokens; totalOut += r.outputTokens;
        if (r.via === "local-escalation") escalationUsd += r.usd;
        if (r.localNode) {
            nodeCalls++; nodeIn += r.inputTokens; nodeOut += r.outputTokens;
        }

        const sk = r.sessionId || "(none)";
        const sEnt = bySession.get(sk) || {
            sessionId: r.sessionId, title: r.sessionTitle,
            usd: 0, calls: 0, inputTokens: 0, outputTokens: 0,
            models: new Set(), firstAt: r.at, lastAt: r.at
        };
        sEnt.usd += r.usd; sEnt.calls++;
        sEnt.inputTokens += r.inputTokens; sEnt.outputTokens += r.outputTokens;
        sEnt.models.add(r.model);
        sEnt.title = r.sessionTitle || sEnt.title;
        sEnt.firstAt = Math.min(sEnt.firstAt, r.at);
        sEnt.lastAt = Math.max(sEnt.lastAt, r.at);
        bySession.set(sk, sEnt);

        const mEnt = byModel.get(r.model) || {
            model: r.model, endpoint: r.endpoint, usd: 0, calls: 0,
            inputTokens: 0, outputTokens: 0
        };
        mEnt.usd += r.usd; mEnt.calls++;
        mEnt.inputTokens += r.inputTokens; mEnt.outputTokens += r.outputTokens;
        byModel.set(r.model, mEnt);

        const day = new Date(r.at).toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) || 0) + r.usd);
    }

    // Average prompt composition, so the dashboard can say where input tokens
    // actually go across the whole history.
    let cSys = 0, cHist = 0, cMsg = 0, cN = 0;
    for (const r of spend) {
        if (!r.composition) continue;
        cSys += r.composition.estSystemTokens || 0;
        cHist += r.composition.estHistoryTokens || 0;
        cMsg += r.composition.estMessageTokens || 0;
        cN++;
    }
    const composition = cN ? {
        samples: cN,
        systemTokens: Math.round(cSys / cN),
        historyTokens: Math.round(cHist / cN),
        messageTokens: Math.round(cMsg / cN)
    } : null;

    return {
        composition,
        totalUsd, totalIn, totalOut, calls: spend.length, escalationUsd,
        node: { calls: nodeCalls, inputTokens: nodeIn, outputTokens: nodeOut, usd: 0 },
        sessions: [...bySession.values()]
            .map(x => ({ ...x, models: [...x.models], deleted: deleted.has(x.sessionId) }))
            .sort((a, b) => b.usd - a.usd),
        models: [...byModel.values()].sort((a, b) => b.usd - a.usd),
        days: [...byDay.entries()].map(([day, usd]) => ({ day, usd }))
            .sort((a, b) => a.day.localeCompare(b.day)),
        // newest first, capped — the full file is always on disk
        recent: spend.slice(-300).reverse()
    };
}

/** One session's spend, for the per-session readout. */
function forSession(sessionId) {
    let usd = 0, calls = 0, inputTokens = 0, outputTokens = 0;
    for (const r of readAll()) {
        if (r.kind || r.sessionId !== sessionId) continue;
        usd += r.usd; calls++;
        inputTokens += r.inputTokens; outputTokens += r.outputTokens;
    }
    return { usd, calls, inputTokens, outputTokens };
}

module.exports = { record, summary, forSession, markSessionDeleted, readAll, file };
