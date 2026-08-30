"use strict";
/**
 * PUBLIC-DNS RESOLUTION FOR THE DOOR — the fix for a route that was quietly
 * being sent back down the road it exists to avoid.
 *
 * A node's door is reached at its Tailscale Funnel name, e.g.
 * spark.tailXXXX.ts.net. On the public internet that name belongs to
 * Tailscale's ingress. But on a machine where Tailscale is RUNNING, MagicDNS
 * answers first and returns the node's PRIVATE tailnet address (100.64.0.0/10).
 *
 * So the "internet route" resolved to 100.64.0.1 and the connection went
 * straight back into the tailnet — the exact path a full-tunnel VPN blocks.
 * Measured on the test machine: connect EACCES 100.64.0.1:443, with a
 * perfectly ordinary internet connection sitting right there. Remote access
 * could never have worked on that machine no matter how correctly it was set
 * up, and this is why.
 *
 * The door is by definition the internet path, so its name is resolved the way
 * the internet resolves it: over DNS-over-HTTPS (port 443, which is exactly
 * what survives when a kill switch is on), never through the system resolver.
 * Only the hostname leaves the machine, and only to resolve a name a
 * linked node published publicly.
 *
 * A tailnet answer is REFUSED rather than used — see isPrivateNet. Falling
 * back to it would recreate the bug silently.
 */
const https = require("https");
const dns = require("dns");

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();                       // host -> { ip, at }

const RESOLVERS = [
    { host: "cloudflare-dns.com", path: "/dns-query?type=A&name=" },
    { host: "dns.google", path: "/resolve?type=A&name=" }
];

/** tailnet CGNAT, RFC1918, loopback and link-local — never the public door. */
function isPrivateNet(ip) {
    const p = String(ip).split(".").map(Number);
    if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;      // tailnet
    if (p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    return false;
}

function askResolver(r, host, timeoutMs) {
    return new Promise((resolve) => {
        const req = https.get(
            `https://${r.host}${r.path}${encodeURIComponent(host)}`,
            { headers: { accept: "application/dns-json" }, timeout: timeoutMs },
            (res) => {
                let b = "";
                res.on("data", (c) => { if (b.length < 64_000) b += c; });
                res.on("end", () => {
                    try {
                        const j = JSON.parse(b);
                        // NXDOMAIN (3) is a real answer and worth distinguishing:
                        // it means the funnel was never published, which is a
                        // different problem from an unreachable one.
                        if (j.Status === 3) return resolve({ nxdomain: true });
                        const a = (j.Answer || [])
                            .filter(x => x.type === 1 && !isPrivateNet(x.data))
                            .map(x => x.data);
                        resolve(a.length ? { ip: a[0] } : {});
                    } catch { resolve({}); }
                });
            });
        req.on("timeout", () => { req.destroy(); resolve({}); });
        req.on("error", () => resolve({}));
    });
}

/**
 * The host's PUBLIC address. Returns { ip } , { nxdomain: true } when the name
 * does not exist publicly, or {} when nothing could be learned.
 */
async function publicAddress(host, timeoutMs = 8000) {
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < TTL_MS) return { ip: hit.ip };

    let sawNx = false;
    for (const r of RESOLVERS) {
        const res = await askResolver(r, host, timeoutMs);
        if (res.ip) {
            cache.set(host, { ip: res.ip, at: Date.now() });
            remember(host, res.ip);
            return { ip: res.ip };
        }
        if (res.nxdomain) sawNx = true;
    }
    // A RESOLVER HICCUP MUST NOT LOOK LIKE A LOST MACHINE.
    //
    // Some networks block or throttle DNS-over-HTTPS. When that happens the
    // lookup falls through to the system resolver, MagicDNS answers with the
    // node's private tailnet address, and the request dies with "only
    // resolves to a private address here" — observed mid-turn,
    // against a funnel that was live and had resolved minutes earlier. A
    // Tailscale ingress address is stable, so the last one that WORKED is a
    // far better answer than failing.
    const kept = remembered(host);
    if (kept && !sawNx) {
        cache.set(host, { ip: kept, at: Date.now() });
        return { ip: kept, stale: true };
    }
    return sawNx ? { nxdomain: true } : {};
}

/* The last address that actually worked, kept across restarts. Only ever a
   public IP — isPrivateNet has already refused anything else. */
function storeFile() {
    try {
        const paths = require("./paths");
        return require("path").join(paths.dataDir(), "public-dns.json");
    } catch { return null; }
}
function remembered(host) {
    try {
        const f = storeFile();
        if (!f) return null;
        const j = JSON.parse(require("fs").readFileSync(f, "utf8"));
        const ip = j && j[host];
        return (ip && !isPrivateNet(ip)) ? ip : null;
    } catch { return null; }
}
function remember(host, ip) {
    try {
        const f = storeFile();
        if (!f || isPrivateNet(ip)) return;
        let j = {};
        try { j = JSON.parse(require("fs").readFileSync(f, "utf8")) || {}; } catch { j = {}; }
        if (j[host] === ip) return;
        j[host] = ip;
        require("fs").writeFileSync(f, JSON.stringify(j), "utf8");
    } catch { /* a cache that cannot be written is not an error */ }
}

/**
 * A drop-in `lookup` for http/https options. Node calls it with the hostname;
 * it answers with the PUBLIC address, so TLS still sees the real hostname for
 * SNI and certificate checking while the socket goes to the internet.
 *
 * If no public address can be learned, the request fails rather than silently
 * falling back to the tailnet address the system resolver would give — that
 * fallback is the bug this module exists to remove.
 */
function lookup(hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : (options || {});
    // Node 19+/24 calls a custom lookup with { all: true } and then reads
    // addresses[0].address — a scalar (addr, family) callback becomes "Invalid
    // IP address: undefined", and every door/funnel request throws. Answer the
    // array form when asked, scalar otherwise, so it works on every Node.
    const ok = (ip, fam) => opts.all
        ? cb(null, [{ address: ip, family: fam }]) : cb(null, ip, fam);
    publicAddress(hostname).then((r) => {
        if (r.ip) return ok(r.ip, 4);
        // let a name with no MagicDNS shadow resolve normally: a door on a
        // plain public host is legitimate and must keep working
        dns.lookup(hostname, { family: 4 }, (err, addr, fam) => {
            if (err) return cb(err);
            if (isPrivateNet(addr)) {
                const e = new Error(
                    r.nxdomain
                        ? `${hostname} has no public address — remote access is ` +
                          "installed but not published"
                        : `${hostname} only resolves to a private address here`);
                e.code = "ELCLNOTPUBLIC";
                return cb(e);
            }
            ok(addr, fam);
        });
    }).catch((e) => cb(e));
}

module.exports = { publicAddress, lookup, isPrivateNet };
