const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const paths = require("./paths");

/**
 * Engagements — the authorization gate for offensive security tools.
 *
 * An offensive tool (port_scan, fuzz_target, exploit_validate) can only touch a
 * target that is named in a LIVE engagement. An engagement is created ONLY by
 * an explicit user action (the settings UI → IPC), never by a model and never
 * from config a model can write. Creating one requires:
 *   - a single target host (no CIDR ranges, no wildcards — no mass targeting)
 *   - an explicit authorization affirmation ("I am authorized to test this")
 *   - an expiry (engagements are time-boxed; an expired one grants nothing)
 *
 * This is what turns "runs offensive tools" into "runs authorized penetration
 * testing": the software will not act against a target the user has not
 * personally, affirmatively, and temporarily authorized. Every creation and
 * revocation is written to the same append-only audit log as tool decisions.
 */

const MAX_HOURS = 24 * 7;            // an engagement cannot outlive a week
const DEFAULT_HOURS = 8;

function store() {
    return path.join(paths.dataDir(), "engagements.json");
}

function load() {
    try {
        const raw = fs.readFileSync(store(), "utf8").replace(/^﻿/, "");
        const j = JSON.parse(raw);
        return Array.isArray(j.engagements) ? j.engagements : [];
    } catch {
        return [];
    }
}

function save(list) {
    fs.writeFileSync(store(), JSON.stringify({ engagements: list }, null, 2), "utf8");
}

/**
 * A target is a single host or host:port. Explicitly NOT a CIDR range, a
 * wildcard, or a URL with a path — one host at a time, so an engagement can
 * never authorise scanning a network.
 */
function normalizeTarget(input) {
    let t = String(input || "").trim().toLowerCase();
    if (!t) throw new Error("a target host is required");
    // reject mass-targeting shapes on the RAW input, BEFORE any path stripping —
    // otherwise splitting "10.0.0.0/24" on "/" hides the CIDR suffix and the
    // guard never fires (found by a test).
    const afterScheme = t.replace(/^[a-z]+:\/\//, "");
    if (/[*]/.test(afterScheme)) throw new Error("wildcards are not allowed — name ONE host");
    if (/\/\d{1,2}(?:$|[?#])/.test(afterScheme)) throw new Error("CIDR ranges are not allowed — name ONE host");
    // now strip any path/query if the user pasted a URL
    t = afterScheme.split(/[/?#]/)[0];
    // Extract the host for the identity check (tools may still target a port).
    // IPv6 itself contains colons, so splitting on the first colon would turn
    // "2001:db8::1" into the meaningless host "2001". Handle the three shapes:
    //   [2001:db8::1]:443  -> bracketed IPv6 with an optional :port
    //   2001:db8::1        -> a BARE IPv6 literal (2+ colons), kept whole
    //   host:443 / 10.0.0.5:443 -> hostname or IPv4, drop the :port
    let host;
    const braced = t.match(/^\[([0-9a-f:]+)\](?::\d+)?$/i);
    if (braced) {
        host = braced[1];
    } else if ((t.match(/:/g) || []).length >= 2) {
        host = t;                                  // bare IPv6 literal
    } else {
        host = t.split(":")[0];                    // hostname or IPv4 + optional :port
    }
    if (!host) throw new Error("could not read a host from the target");
    // an IPv4 literal is fine (a single host)
    if (/^\d+(\.\d+){3}$/.test(host)) return host;
    // an IPv6 literal (bracketed or bare) is fine: hex groups joined by colons,
    // "::" compression allowed, and at least two colons to be IPv6 at all
    if (host.includes(":")) {
        if (/^[0-9a-f:]+$/i.test(host) && (host.match(/:/g) || []).length >= 2) return host;
        throw new Error("that does not look like a single host");
    }
    if (!/^[a-z0-9.-]+$/.test(host)) throw new Error("that does not look like a single hostname");
    return host;
}

/**
 * Create an engagement. `authorized` MUST be true — the caller (the settings
 * UI) collects an explicit affirmation. This function refuses without it.
 */
function create({ target, authorized, hours, note } = {}, audit = () => {}) {
    if (authorized !== true) {
        throw new Error("an engagement requires explicit authorization to test the target");
    }
    const host = normalizeTarget(target);
    const h = Math.max(1, Math.min(Number(hours) || DEFAULT_HOURS, MAX_HOURS));
    const now = Date.now();
    const engagement = {
        id: "eng-" + crypto.randomBytes(6).toString("hex"),
        target: host,
        note: String(note || "").slice(0, 300),
        createdAt: now,
        expiresAt: now + h * 3600_000,
        authorized: true
    };
    const list = load().filter(e => e.expiresAt > now);   // drop expired while here
    list.push(engagement);
    save(list);
    audit({ kind: "engagement-created", target: host, id: engagement.id,
            expiresAt: engagement.expiresAt, at: now });
    return engagement;
}

function revoke(id, audit = () => {}) {
    const list = load();
    const before = list.length;
    const kept = list.filter(e => e.id !== id);
    save(kept);
    if (kept.length < before) audit({ kind: "engagement-revoked", id, at: Date.now() });
    return before - kept.length;
}

/** Live engagements only (expired ones are silently dropped). */
function list() {
    const now = Date.now();
    const live = load().filter(e => e.expiresAt > now);
    if (live.length !== load().length) save(live);    // prune on read
    return live;
}

/** The live engagement authorising this target, or null. */
function activeFor(target) {
    let host;
    try { host = normalizeTarget(target); } catch { return null; }
    const now = Date.now();
    return list().find(e => e.target === host && e.expiresAt > now) || null;
}

/** Any live engagement at all — drives whether sec.offensive is granted. */
function anyActive() {
    return list().length > 0;
}

module.exports = { create, revoke, list, activeFor, anyActive, normalizeTarget };
