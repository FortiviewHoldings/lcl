/**
 * HOW MUCH MEMORY DOES THAT MACHINE HAVE, AND WHAT IS ON IT.
 *
 * Pulled out of main.js because it could not be tested there, and it is the
 * readout that kept shipping broken: "i see no ram utilization for the spark in
 * the sidebar", twice, after two rounds of me proving the arithmetic in
 * isolation and never proving the thing that actually runs.
 *
 * THREE WAYS TO LEARN IT, in order of how much they tell you:
 *
 *   1. /proc/meminfo over SSH — the truth, including what everything ELSE on
 *      the machine is using. Needs a login.
 *   2. The door's /lcl/stats — the same numbers over the relay. Needs a token.
 *   3. The serving port. Ollama's /api/ps says what IT has resident; the node's
 *      total size is already on record from when it was added. Needs nothing
 *      but the port that is already answering, which is why it is the one that
 *      works on a node with no SSH user and no stats door — the operator's
 *      Spark, exactly.
 *
 * Route 3 is a floor, not the truth: it cannot see memory used by anything
 * other than the model server, so it reports the most optimistic honest number
 * and SAYS which route it came from. A gauge that quietly means two different
 * things is worse than one that names its source.
 *
 * The readers are injected so this can be driven against a real machine in a
 * test without dragging Electron, ssh credentials or the relay in with it.
 */

const GB = 1e9;

/** Colour band for the bar. The thresholds are the ones the sidebar uses. */
function levelFor(availableBytes) {
    if (availableBytes < 12 * GB) return "critical";
    if (availableBytes < 30 * GB) return "low";
    return "ok";
}

function parseMeminfo(text) {
    const total = Number((/MemTotal:\s+(\d+)/.exec(text) || [])[1] || 0) * 1024;
    const avail = Number((/MemAvailable:\s+(\d+)/.exec(text) || [])[1] || 0) * 1024;
    return { total, avail };
}

/** Ollama's /api/ps payload -> the shape the sidebar draws. */
function residentFrom(models) {
    const list = Array.isArray(models) ? models : [];
    return {
        bytes: list.reduce((a, m) => a + (Number(m.size) || 0), 0),
        loaded: list.map(m => ({
            name: m.name,
            sizeBytes: Number(m.size) || 0,
            until: m.expires_at || m.until || null
        }))
    };
}

/**
 * @param node  the stored record: { id, host, user, relayUrl, memBytes }
 * @param io    { ssh(cmd), door(route), ollamaPs(host, port), knownMem(id) }
 *              each may be absent or may resolve null — that is the normal case
 * @returns { ok, physTotalBytes, availableBytes, level, loaded, via, floor }
 *          or { ok:false, error }
 */
async function readNodeMemory(node, io = {}) {
    const n = node || {};
    const port = Number(n.port) || 11434;

    /* 1. SSH — the whole truth when there is a login. */
    if (typeof io.ssh === "function") {
        let r = null;
        try { r = await io.ssh(
            "grep -E 'MemTotal|MemAvailable' /proc/meminfo; " +
            "echo ---; curl -s -m 2 http://127.0.0.1:" + port + "/api/ps 2>/dev/null || true"); }
        catch { r = null; }
        if (r && r.ok) {
            const { total, avail } = parseMeminfo(String(r.out || ""));
            // ok:true with unparseable output is NOT a reading. This branch used
            // to fall through with total = 0, and a zero total is what the
            // sidebar treats as "no gauge" — so a half-working ssh hid the row
            // and never reached the fallbacks below.
            if (total > 0) {
                let loaded = [];
                try { loaded = residentFrom(JSON.parse(String(r.out).split("---")[1] || "{}").models).loaded; }
                catch { /* server not up yet; the gauge still works */ }
                return { ok: true, via: "ssh", floor: false,
                         physTotalBytes: total, availableBytes: avail,
                         level: levelFor(avail), loaded };
            }
        }
    }

    /* 2. The door — the same numbers over the relay. */
    if (typeof io.door === "function") {
        let d = null;
        try { d = await io.door("/lcl/stats"); } catch { d = null; }
        if (d && d.mem && Number(d.mem.totalBytes) > 0) {
            const avail = Number(d.mem.availableBytes) || 0;
            return { ok: true, via: "door", floor: false,
                     physTotalBytes: Number(d.mem.totalBytes), availableBytes: avail,
                     level: levelFor(avail),
                     loaded: (d.models || []).map(m => ({
                         name: m.name, sizeBytes: m.sizeBytes || 0, until: m.until || null })) };
        }
    }

    /* 3. The serving port plus the size already on record. */
    const known = Number(n.memBytes) > 0
        ? Number(n.memBytes)
        : (typeof io.knownMem === "function" ? Number(io.knownMem(n.id)) || 0 : 0);
    if (known > 0 && typeof io.ollamaPs === "function") {
        let ps = null;
        try { ps = await io.ollamaPs(n.host, port); } catch { ps = null; }
        if (ps && ps.ok) {
            const res = residentFrom(ps.models);
            const avail = Math.max(0, known - res.bytes);
            return { ok: true, via: "serving port", floor: true,
                     physTotalBytes: known, availableBytes: avail,
                     level: levelFor(avail), loaded: res.loaded };
        }
    }

    return { ok: false, error: "no memory reading available" };
}

module.exports = { readNodeMemory, levelFor, parseMeminfo, residentFrom };
