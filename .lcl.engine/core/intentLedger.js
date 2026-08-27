/**
 * THE INTENT LEDGER — Tier 2 of Ancient Knowledge's pseudo-context (PROJECT.md
 * §8). Cameron: "you are losing context, models lose context, and the ancient
 * knowledge, and honestly core functionality should not."
 *
 * The durable, flat, per-session record of intent + criteria + status that
 * survives when the hot model window is compacted. The controller reads it and
 * distills a FOCUSED slice back into the window; completed goals archive out of
 * the live front so each turn is more focused than the last.
 *
 * TWO FILES PER SESSION, both flat JSONL:
 *   <id>.jsonl          — the LIVE ledger (append-only; the recent front)
 *   <id>.archive.jsonl  — compacted-out records (append-only; NEVER deleted)
 * compact() moves whole GOALS from live to archive by a temp-then-rename
 * rewrite of the live file — so "compacted, not lost" is literally true: the
 * live file shrinks, the archive keeps everything, retrieve() reads both.
 *
 * GOAL-SCOPED IDS. A session hosts many goals across turns. A criterion's id is
 * scoped to its GOAL (goalId:source:key), so goal B's "step:1" never collides
 * with goal A's — the review caught the un-scoped version reporting a fresh
 * goal as already complete. Within a goal the id is still stable and derived
 * (idempotent re-record, clean diffs — the mod-preservation discipline).
 *
 * summarize() is GOAL-SCOPED too: it returns the CURRENT goal's front (the
 * latest intent and its criteria), never a merge of every goal — "a small,
 * current, honest picture of the build."
 */
const fs = require("fs");
const path = require("path");

const SCHEMA = 2;                       // bump only with a migration + a test
const KINDS = new Set(["intent", "criterion", "status", "note", "compaction"]);
const STATES = new Set(["open", "done", "failed", "partial"]);
const MAX_TEXT = 2000;
const MAX_LIVE_FRONT = 200;
const LIVE_LINE_CAP = 4000;             // auto-compact the live file past this

function liveFile(dir, sessionId) {
    const safe = String(sessionId || "").replace(/[^\w-]/g, "_") || "_";
    return path.join(dir, safe + ".jsonl");
}
function archiveFile(dir, sessionId) {
    const safe = String(sessionId || "").replace(/[^\w-]/g, "_") || "_";
    return path.join(dir, safe + ".archive.jsonl");
}
// kept for the old name some callers/tests use
function ledgerFile(dir, sessionId) { return liveFile(dir, sessionId); }

function clip(s) { return String(s == null ? "" : s).slice(0, MAX_TEXT); }

/** stable, GOAL-SCOPED id — the same criterion in the same goal re-records to
 *  the same id (idempotent); a different goal gets a different namespace. */
function criterionId(goalId, source, key) {
    return String(goalId || "g0") + ":" + String(source || "src") + ":" + String(key);
}

function rowOf(record, at) {
    const row = { v: SCHEMA, t: Number.isFinite(at) ? at : Date.now(), kind: record.kind };
    if (record.goal) row.goal = String(record.goal);
    if (record.id) row.id = String(record.id);
    if (record.text !== undefined) row.text = clip(record.text);
    if (record.source) row.source = String(record.source);
    if (record.ref) row.ref = String(record.ref);
    if (record.state) row.state = STATES.has(record.state) ? record.state : "open";
    if (record.evidence !== undefined) row.evidence = clip(record.evidence);
    if (Array.isArray(record.goals)) row.goals = record.goals.map(String);
    return row;
}

/** Append ONE record to the live ledger. Triggers an auto-compaction when the
 *  live file has grown past LIVE_LINE_CAP, so growth is bounded without ever
 *  losing history (old goals move to the archive). */
function append(dir, sessionId, record, at) {
    if (!dir || !sessionId || !record || !KINDS.has(record.kind)) return null;
    fs.mkdirSync(dir, { recursive: true });
    const row = rowOf(record, at);
    const f = liveFile(dir, sessionId);
    fs.appendFileSync(f, JSON.stringify(row) + "\n", "utf8");
    if (record.kind === "intent") maybeAutoCompact(dir, sessionId);
    return row;
}

function recordIntent(dir, sessionId, goalId, text, at) {
    return append(dir, sessionId, { kind: "intent", goal: goalId, text }, at);
}
function recordCriterion(dir, sessionId, goalId, source, key, text, at) {
    return append(dir, sessionId,
        { kind: "criterion", goal: goalId, id: criterionId(goalId, source, key),
          source, text }, at);
}
function recordStatus(dir, sessionId, criterionRef, state, evidence, at) {
    return append(dir, sessionId,
        { kind: "status", ref: criterionRef, state, evidence }, at);
}

function parseLines(body) {
    const out = [];
    for (const line of String(body || "").split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try { const r = JSON.parse(s); if (r && KINDS.has(r.kind)) out.push(r); }
        catch { /* a torn line is skipped, the rest stands */ }
    }
    return out;
}
function readFileRows(f) {
    try { return parseLines(fs.readFileSync(f, "utf8")); } catch { return []; }
}

/** The LIVE ledger, in order. */
function read(dir, sessionId) { return readFileRows(liveFile(dir, sessionId)); }
/** Live + archive together — the whole history. */
function readAll(dir, sessionId) {
    return [...readFileRows(archiveFile(dir, sessionId)),
            ...readFileRows(liveFile(dir, sessionId))];
}

/** the goal id of the LATEST intent record in a row list (the current goal) */
function latestGoal(rows) {
    let g = null;
    for (const r of rows) if (r.kind === "intent" && r.goal) g = r.goal;
    return g;
}

/**
 * THE FOCUSED SLICE — the CURRENT goal only. Latest intent, that goal's OPEN
 * and DONE criteria (deduped by stable id, statuses applied in order), the
 * material topics as a separate `scope` (informational — they have no reliable
 * automatic status; that judgement is the model-graded review's job), and how
 * many prior goals have been archived out.
 */
function summarize(dir, sessionId) {
    const live = read(dir, sessionId);
    const goal = latestGoal(live);
    let intent = "";
    const crit = new Map();             // id -> {id,text,source,state,evidence}
    for (const r of live) {
        if (r.kind === "intent" && r.goal === goal) intent = r.text || intent;
        else if (r.kind === "criterion" && r.goal === goal && r.id) {
            if (!crit.has(r.id)) crit.set(r.id, { id: r.id, text: r.text || "",
                                                  source: r.source || "", state: "open" });
            else if (r.text) crit.get(r.id).text = r.text;
        } else if (r.kind === "status" && r.ref && crit.has(r.ref)) {
            const c = crit.get(r.ref);
            c.state = STATES.has(r.state) ? r.state : c.state;
            if (r.evidence !== undefined) c.evidence = r.evidence;
        }
    }
    const all = [...crit.values()];
    // material topics are scope, not trackable open/done work
    const scope = all.filter(c => c.source === "cov");
    const work = all.filter(c => c.source !== "cov");
    const archivedGoals = new Set();
    for (const r of readFileRows(archiveFile(dir, sessionId)))
        if (r.kind === "intent" && r.goal) archivedGoals.add(r.goal);
    return {
        goal,
        intent,
        open: work.filter(c => c.state !== "done").slice(0, MAX_LIVE_FRONT),
        done: work.filter(c => c.state === "done"),
        scope: scope.map(c => ({ id: c.id, text: c.text })),
        archivedCount: archivedGoals.size,
        total: all.length
    };
}

/**
 * COMPACT — move whole GOALS out of the live file into the archive, by a
 * temp-then-rename rewrite of the live file. Keeps the most recent `keep`
 * goals live (default 1 — just the current goal); everything older is appended
 * to the archive first, THEN the live file is atomically replaced. Nothing is
 * ever lost: retrieve()/readAll() read the archive too.
 */
function compact(dir, sessionId, keep = 1) {
    const live = read(dir, sessionId);
    if (!live.length) return null;
    // the ordered list of goal ids as they appear
    const order = [];
    for (const r of live) if (r.kind === "intent" && r.goal && !order.includes(r.goal)) order.push(r.goal);
    if (order.length <= keep) return null;      // nothing old enough to archive
    const keepGoals = new Set(order.slice(-keep));
    const keepRows = [], archiveRows = [];
    for (const r of live) {
        // a record with no goal (or belonging to a kept goal) stays live;
        // status rows reference a criterion id whose goal prefix we can read
        const g = r.goal || goalOfRef(r);
        if (!g || keepGoals.has(g)) keepRows.push(r); else archiveRows.push(r);
    }
    if (!archiveRows.length) return null;
    // archive FIRST (append is safe), then atomically replace the live file
    fs.appendFileSync(archiveFile(dir, sessionId),
        archiveRows.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const f = liveFile(dir, sessionId);
    const tmp = f + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, keepRows.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
    fs.renameSync(tmp, f);
    // a marker of what was archived, for auditing
    fs.appendFileSync(f, JSON.stringify(rowOf(
        { kind: "compaction", goals: [...new Set(archiveRows.map(r => r.goal || goalOfRef(r)).filter(Boolean))] })) + "\n", "utf8");
    return { archived: archiveRows.length, keptGoals: [...keepGoals] };
}
/** a status row's goal, read from the goal prefix of the criterion it refs */
function goalOfRef(r) {
    if (r.kind !== "status" || !r.ref) return null;
    const i = String(r.ref).indexOf(":");
    return i > 0 ? String(r.ref).slice(0, i) : null;
}

function maybeAutoCompact(dir, sessionId) {
    try {
        const f = liveFile(dir, sessionId);
        const lines = fs.readFileSync(f, "utf8").split("\n").length;
        if (lines > LIVE_LINE_CAP) compact(dir, sessionId, 1);
    } catch { /* best-effort; growth guard, never fatal */ }
}

/** RETRIEVE criteria by id from the WHOLE history (live + archive). */
function retrieve(dir, sessionId, ids) {
    const want = new Set((ids || []).map(String));
    const rows = readAll(dir, sessionId);
    const crit = new Map();
    for (const r of rows) {
        if (r.kind === "criterion" && r.id && (!want.size || want.has(r.id))) {
            if (!crit.has(r.id)) crit.set(r.id, { id: r.id, text: r.text || "",
                                                  source: r.source || "", state: "open" });
            else if (r.text) crit.get(r.id).text = r.text;
        }
        if (r.kind === "status" && r.ref && crit.has(r.ref)) {
            crit.get(r.ref).state = r.state;
            if (r.evidence !== undefined) crit.get(r.ref).evidence = r.evidence;
        }
    }
    return [...crit.values()];
}

module.exports = {
    SCHEMA, KINDS, STATES, criterionId, ledgerFile, liveFile, archiveFile,
    append, recordIntent, recordCriterion, recordStatus,
    read, readAll, summarize, compact, retrieve, latestGoal
};
