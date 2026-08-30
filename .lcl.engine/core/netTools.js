const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const { URL } = require("url");
const { ToolError } = require("./fsTools");
const secretGuard = require("./secretGuard");

/**
 * http_fetch — the ONE tool that reaches the network.
 *
 * .lcl's identity is "fully local", so the net.read capability is granted
 * nowhere by default: this tool exists but the policy kernel denies it unless
 * the user has explicitly turned networking on. That is deliberate — the tool
 * being implemented does not make it reachable.
 *
 * When it IS enabled, the danger is SSRF: a model (or attacker-controlled file
 * content that talks the model into a fetch) reaching internal services, the
 * loopback interface, or a cloud metadata endpoint. Every one of those is
 * blocked here, at resolution time, on the ORIGINAL request and after EVERY
 * redirect — because a public hostname can resolve to a private address, and a
 * redirect can jump from a public host to 169.254.169.254.
 */

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/** Is this resolved IP address one we must never connect to? */
function isBlockedAddress(ip) {
    if (net.isIPv4(ip)) {
        const p = ip.split(".").map(Number);
        if (p[0] === 127) return "loopback";                    // 127/8
        if (p[0] === 10) return "private";                      // 10/8
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return "private"; // 172.16/12
        if (p[0] === 192 && p[1] === 168) return "private";     // 192.168/16
        if (p[0] === 169 && p[1] === 254) return "link-local/metadata"; // 169.254/16
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return "carrier-grade NAT"; // 100.64/10
        if (p[0] === 0) return "reserved";
        if (p[0] >= 224) return "multicast/reserved";
        return null;
    }
    if (net.isIPv6(ip)) {
        const a = ip.toLowerCase();
        if (a === "::1") return "loopback";
        if (a.startsWith("fe80")) return "link-local";
        if (a.startsWith("fc") || a.startsWith("fd")) return "unique-local";
        // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4
        const m = /::ffff:(\d+\.\d+\.\d+\.\d+)/.exec(a);
        if (m) return isBlockedAddress(m[1]);
        if (a === "::") return "reserved";
    }
    return null;
}

/**
 * Resolve a hostname, refuse if ANY resolved address is internal, and RETURN
 * the vetted address. The caller connects to THIS address — closing the
 * DNS-rebinding gap where the validation lookup and the socket's own lookup
 * could return different answers (attacker DNS: public on check, loopback on
 * connect). Check and connect must use the same IP.
 */
async function assertPublicHost(hostname) {
    // a bare IP literal is checked directly
    if (net.isIP(hostname)) {
        const why = isBlockedAddress(hostname);
        if (why) throw new ToolError(`refusing to fetch a ${why} address (${hostname})`);
        return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
    }
    if (/^(?:localhost|.*\.local|.*\.internal|.*\.localdomain)$/i.test(hostname)) {
        throw new ToolError(`refusing to fetch an internal hostname (${hostname})`);
    }
    let records;
    try {
        records = await dns.lookup(hostname, { all: true });
    } catch {
        throw new ToolError(`could not resolve ${hostname}`);
    }
    for (const r of records) {
        const why = isBlockedAddress(r.address);
        if (why) throw new ToolError(
            `${hostname} resolves to a ${why} address (${r.address}) — refusing`);
    }
    if (!records.length) throw new ToolError(`could not resolve ${hostname}`);
    // pin the FIRST vetted address; the connection uses exactly this
    return { address: records[0].address, family: records[0].family };
}

function requestOnce(urlStr, pinnedIp) {
    return new Promise((resolve, reject) => {
        let url;
        try { url = new URL(urlStr); } catch { return reject(new ToolError("invalid URL")); }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return reject(new ToolError("only http and https URLs are allowed"));
        }
        // credentials-in-URL are a common SSRF/exfil vector
        if (url.username || url.password) {
            return reject(new ToolError("URLs with embedded credentials are not allowed"));
        }
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(url, {
            method: "GET",
            timeout: TIMEOUT_MS,
            // NO CONNECTION POOLING. Node 19+ keep-alive would let a later fetch
            // to the same host reuse a socket and skip the pinned lookup below —
            // the guard must connect every request to the address vetted for
            // THAT request, not one vetted earlier.
            agent: false,
            // A BROWSER USER-AGENT, BECAUSE VENDOR DOCS REFUSE ANYTHING ELSE.
            // Measured: waveshare.com/wiki returned 403 to "lcl-local-agent/1.0"
            // and 200 to a normal Chrome string — so a model asked to "find the
            // literature for this board" could not read the one page that had it.
            // No cookies, no ambient auth; only the client string changes, which
            // is what a public GET is entitled to send. Accept-Language and a
            // real Accept round it out so a WAF sees a browser, not a scraper.
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                    "AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/126.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9," +
                    "application/pdf,image/*,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9"
            },
            // CONNECT TO THE VALIDATED IP. The custom lookup hands the socket
            // exactly the address assertPublicHost vetted, so a rebinding DNS
            // cannot swap in an internal address between check and connect. The
            // Host header and TLS SNI stay the original hostname (Node derives
            // them from url), so virtual hosts and cert validation still work.
            lookup: (host, opts, cb) => {
                const fam = net.isIPv6(pinnedIp) ? 6 : 4;
                // re-verify at the last moment — defence in depth
                if (isBlockedAddress(pinnedIp)) return cb(new ToolError("blocked address"));
                // Node 19+/24 calls this with { all: true } and reads
                // addresses[0].address — answer the array form when asked.
                if (opts && opts.all) return cb(null, [{ address: pinnedIp, family: fam }]);
                cb(null, pinnedIp, fam);
            }
        }, (res) => {
            const status = res.statusCode || 0;
            const loc = res.headers.location;
            if (status >= 300 && status < 400 && loc) {
                res.resume();   // drain
                return resolve({ redirect: new URL(loc, url).toString(), status });
            }
            let data = Buffer.alloc(0);
            let over = false;
            res.on("data", (c) => {
                if (over) return;
                data = Buffer.concat([data, c]);
                if (data.length > MAX_BYTES) { over = true; req.destroy(); }
            });
            res.on("end", () => {
                const capped = data.subarray(0, MAX_BYTES);
                resolve({
                    status,
                    contentType: res.headers["content-type"] || "",
                    body: capped.toString("utf8"),
                    // the bytes as received — a PDF is not text, and decoding it
                    // as utf8 destroys it. Callers that can parse binary need this.
                    raw: capped,
                    truncated: over,
                    bytes: data.length
                });
            });
        });
        req.on("timeout", () => req.destroy(new ToolError(`request timed out after ${TIMEOUT_MS / 1000}s`)));
        req.on("error", (e) => reject(e instanceof ToolError ? e : new ToolError(`fetch failed: ${e.message}`)));
        req.end();
    });
}

/**
 * The guarded fetch itself: scheme check, host validation and IP PINNING on
 * every hop, redirect following, size cap. Both the agent-facing http_fetch and
 * the research harvester go through here, so neither can bypass the SSRF
 * protections by taking its own path to the network.
 */
async function fetchGuarded(url, onNote = () => {}) {
    let current = String(url || "").trim();
    if (!current) throw new ToolError("no URL given");
    // EGRESS GATE. A URL is outbound data: a secret in a path, query string or
    // fragment leaves the machine the moment this connects. Refuse before DNS.
    try { secretGuard.assertNoLeak(current, "this URL"); }
    catch (e) { throw new ToolError(e.message); }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let parsed;
        try { parsed = new URL(current); } catch { throw new ToolError("invalid URL"); }
        // scheme first — before any DNS work — so file:/ftp:/etc. give the
        // honest "only http and https" error, not a resolution failure
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new ToolError("only http and https URLs are allowed");
        }
        // re-validate AND re-pin on EVERY hop — a redirect can target internal
        // space, and each hop connects to its own freshly-vetted address
        const pin = await assertPublicHost(parsed.hostname);
        onNote(hop === 0 ? `fetching ${parsed.hostname}` : `following redirect to ${parsed.hostname}`);

        const res = await requestOnce(current, pin.address);
        if (res.redirect) {
            if (hop === MAX_REDIRECTS) throw new ToolError("too many redirects");
            current = res.redirect;
            continue;
        }
        return { ...res, url: current };
    }
    throw new ToolError("too many redirects");
}

async function httpFetch(_root, { url } = {}, ctx = {}) {
    if (typeof url !== "string" || !url.trim()) {
        throw new ToolError('http_fetch needs {"url": "https://…"}');
    }
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    const res = await fetchGuarded(url, onNote);

    // text only — this is a reading tool, not a downloader
    const ct = res.contentType.toLowerCase();
    const textish = !ct || /text|json|xml|html|javascript|csv|yaml|markdown/.test(ct);
    return {
        url: res.url,
        status: res.status,
        contentType: res.contentType,
        bytes: res.bytes,
        truncated: res.truncated,
        body: textish ? res.body
            : `(non-text content: ${res.contentType}, ${res.bytes} bytes — not shown)`
    };
}

const TOOL_ENTRY = {
    run: httpFetch,
    help: 'http_fetch {"url": "https://example.com"} — fetch a public web page or API (text only; internal/loopback addresses are blocked; OFF unless networking is enabled in settings)'
};

module.exports = { httpFetch, fetchGuarded, isBlockedAddress, assertPublicHost, TOOL_ENTRY };
