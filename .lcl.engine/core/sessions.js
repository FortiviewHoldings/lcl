const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const paths = require("./paths");

/**
 * File-backed session store: one JSON file per session, so sessions survive
 * restarts with no database.
 */

const ID_RE = /^[0-9a-f-]{1,40}$/;

function fileFor(id) {
    if (typeof id !== "string" || !ID_RE.test(id)) {
        throw new Error("invalid session id");
    }
    return path.join(paths.sessionsDir(), `${id}.json`);
}

function create(title = "") {
    const session = {
        id: crypto.randomUUID(),
        title: (title || "New session").slice(0, 120),
        createdAt: Date.now() / 1000,
        updatedAt: Date.now() / 1000,
        repoPath: null,
        messages: []
    };
    save(session);
    return session;
}

function save(session) {
    session.updatedAt = Date.now() / 1000;
    const target = fileFor(session.id);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 1), "utf8");
    fs.renameSync(tmp, target);
}

function load(id) {
    try {
        return JSON.parse(fs.readFileSync(fileFor(id), "utf8"));
    } catch {
        return null;
    }
}

function remove(id) {
    try {
        fs.unlinkSync(fileFor(id));
        return true;
    } catch {
        return false;
    }
}

function list() {
    let names = [];
    try {
        names = fs.readdirSync(paths.sessionsDir());
    } catch {
        return [];
    }

    const out = [];
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
            const s = JSON.parse(fs.readFileSync(path.join(paths.sessionsDir(), name), "utf8"));
            out.push({
                id: s.id,
                title: s.title || "Untitled",
                repoPath: s.repoPath || null,
                updatedAt: s.updatedAt || 0,
                // WHICH ENDPOINT THIS CONVERSATION IS POINTED AT. .lcl runs
                // many sessions at once, so "is anything using this?" is a
                // question about all of them, not about the one on screen.
                modelSel: s.modelSel || null,
                messageCount: (s.messages || []).length,
                // the sidebar reads ONLY this projection, so per-session flags
                // must ride it: the bell (notifyMuted) and the read/acknowledged
                // split (doneAt vs readAt) the status dot derives from
                notifyMuted: !!s.notifyMuted,
                doneAt: s.doneAt || 0,
                readAt: s.readAt || 0,
                // an unread failure still matters after a restart — the tray
                // reads this off the projection instead of opening every file
                lastErrorAt: (s.lastError && s.lastError.at) || 0
            });
        } catch {
            // skip unreadable/corrupt session files
        }
    }

    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
}

/*
 * AN ENDPOINT ID CHANGED, AND EVERY CONVERSATION THAT NAMED IT MUST FOLLOW.
 *
 * Endpoint ids are keyed on the address, so healing an old shared slot (or
 * splitting one host into two providers, as Zen and GO are) renames them. A
 * session references an endpoint in four places; leaving any of them behind
 * silently drops that conversation onto the local engine, or points a task
 * assignment at nothing. Returns how many files were touched.
 */
function repointEndpoint(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return 0;
    let names = [];
    try { names = fs.readdirSync(paths.sessionsDir()); } catch { return 0; }
    let touched = 0;
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        let s;
        try { s = JSON.parse(fs.readFileSync(path.join(paths.sessionsDir(), name), "utf8")); }
        catch { continue; }
        let hit = false;
        if (s.modelSel && typeof s.modelSel === "object" && s.modelSel.endpointId === fromId) {
            s.modelSel = { ...s.modelSel, endpointId: toId }; hit = true;
        }
        // the pre-structured scalar form: "api:<endpointId>|<model>"
        if (typeof s.modelSel === "string" && s.modelSel.startsWith("api:" + fromId + "|")) {
            s.modelSel = "api:" + toId + "|" + s.modelSel.slice(("api:" + fromId + "|").length);
            hit = true;
        }
        if (s.taskModels && typeof s.taskModels === "object") {
            for (const k of Object.keys(s.taskModels)) {
                const v = s.taskModels[k];
                if (v && v.endpointId === fromId) {
                    s.taskModels[k] = { ...v, endpointId: toId }; hit = true;
                }
            }
        }
        if (s.akAuditor && typeof s.akAuditor === "object"
            && s.akAuditor.endpointId === fromId) {
            s.akAuditor = { ...s.akAuditor, endpointId: toId }; hit = true;
        }
        // ...but main.js only ever WRITES the scalar form ("api:<epId>|<model>"),
        // so the object branch above never fired and a renamed endpoint
        // silently unhooked the session's AK auditor. Same rewrite modelSel gets.
        if (typeof s.akAuditor === "string" && s.akAuditor.startsWith("api:" + fromId + "|")) {
            s.akAuditor = "api:" + toId + "|" + s.akAuditor.slice(("api:" + fromId + "|").length);
            hit = true;
        }
        if (Array.isArray(s.trustedEndpoints) && s.trustedEndpoints.includes(fromId)) {
            s.trustedEndpoints = [...new Set(s.trustedEndpoints
                .map(x => (x === fromId ? toId : x)))];
            hit = true;
        }
        if (hit) { try { save(s); touched++; } catch { /* one bad file is not fatal */ } }
    }
    return touched;
}

module.exports = { create, save, load, remove, list, repointEndpoint };
