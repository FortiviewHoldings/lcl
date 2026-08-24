"use strict";
/**
 * THE DOOR MUST NOT BE RESOLVED BY MAGICDNS.
 *
 * Measured on the test machine, behind a full-tunnel VPN:
 *
 *   node -e "https.get('https://spark.tailXXXX.ts.net/lcl/ping')"
 *   -> ERROR EACCES connect EACCES 100.64.0.1:443
 *
 * The door's Funnel name resolved to the node's PRIVATE tailnet address,
 * because Tailscale runs on that machine and MagicDNS answers first. So the one
 * route designed to survive a full-tunnel VPN was being dialled straight back
 * into the tunnel the VPN blocks — remote access could not have worked there
 * however correctly it was set up.
 *
 * These checks are offline and deterministic; the network-dependent half is
 * proven by hand against the real host.
 */
const fs = require("fs");
const path = require("path");
const pdns = require("../.lcl.engine/core/publicDns");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
    console.log((ok ? "PASS" : "FAIL") + " | " + name + (ok ? "" : "  " + (detail || "")));
    ok ? pass++ : fail++;
};

// ---- the classifier that decides what may be dialled ----
for (const ip of ["100.64.0.1", "100.64.0.1", "100.127.255.254"]) {
    check(`tailnet address is refused: ${ip}`, pdns.isPrivateNet(ip) === true);
}
for (const ip of ["10.0.0.5", "172.16.4.9", "192.168.1.50", "127.0.0.1", "169.254.1.1"]) {
    check(`private/local address is refused: ${ip}`, pdns.isPrivateNet(ip) === true);
}
for (const ip of ["8.8.8.8", "38.101.151.15", "100.128.0.1", "99.255.255.255", "172.32.0.1"]) {
    check(`public address is allowed: ${ip}`, pdns.isPrivateNet(ip) === false);
}
check("a malformed address is refused rather than dialled",
    pdns.isPrivateNet("not.an.ip") === true && pdns.isPrivateNet("1.2.3") === true &&
    pdns.isPrivateNet("999.1.1.1") === true);

// ---- every door request routes through it ----
const main = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
const cloud = fs.readFileSync(
    path.join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"), "utf8");

check("main.js resolves the door publicly EVERYWHERE it dials one",
    (() => {
        const dials = [];
        const re = /require\("https"\)\.(request|get)\(|https\.(request|get)\(/g;
        let m;
        while ((m = re.exec(main))) {
            const win = main.slice(m.index, m.index + 700);
            // only the ones that are talking to a door
            if (!/relayUrl|\/lcl\//.test(win)) continue;
            dials.push(/lookup: publicDns\.lookup/.test(win));
        }
        return dials.length >= 3 && dials.every(Boolean);
    })());
// ...and the DIRECT road now gets the pool-free resolver rather than nothing.
// Node's dns.lookup is getaddrinfo on libuv's four-thread pool, and four hung
// lookups starve name resolution for the whole process — measured at 22,006 ms
// for a host that answers in 11 ms on an idle process, which is what made a
// reachable endpoint report "DNS never resolved". The door keeps PUBLIC DNS,
// which is a different requirement: it must not be answered by MagicDNS.
check("the chat transport resolves the door publicly, and the direct road off " +
      "the thread pool — never the plain OS resolver",
    /lookup: viaDoor \? publicDns\.lookup : lookupOffThreadPool/.test(cloud) &&
    /lookup: target\.lookup/.test(cloud));
check("both modules import it",
    /require\("\.\.\/\.lcl\.engine\/core\/publicDns"\)/.test(main) &&
    /require\("\.\/publicDns"\)/.test(cloud));
check("the public address is warmed while still on the node's own network",
    /await publicDns\.publicAddress\(selfName\.toLowerCase\(\)\)/.test(main));

// ---- it must never silently fall back to the address that caused the bug ----
const src = fs.readFileSync(
    path.join(__dirname, "..", ".lcl.engine", "core", "publicDns.js"), "utf8");
check("a private answer from the system resolver is an ERROR, not a fallback",
    /code = "ELCLNOTPUBLIC"/.test(src) &&
    /if \(isPrivateNet\(addr\)\) \{/.test(src));
check("resolution happens over HTTPS, which is what survives a kill switch",
    /cloudflare-dns\.com/.test(src) && /dns\.google/.test(src) &&
    !/setServers/.test(src));
check("a name that does not exist publicly is reported as NOT PUBLISHED",
    /nxdomain: true/.test(src) &&
    /installed but not published/.test(src));
check("answers are cached so every message does not re-resolve",
    /TTL_MS/.test(src) && /cache\.set\(host/.test(src));

// A RESOLVER HICCUP IS NOT A LOST MACHINE.
//
// Reported mid-turn on a restricted network: the chat failed with "only
// resolves to a private address here" against a funnel that was live and had
// resolved minutes before. Some networks throttle DNS-over-HTTPS; when that
// happens the system resolver answers with MagicDNS's private address and the
// route dies. A Tailscale ingress address is stable, so the last one that
// actually worked is remembered and used.
check("a working public address is remembered across restarts",
    /function remember\(host, ip\)/.test(src) &&
    /public-dns\.json/.test(src));
check("the remembered answer is used when every resolver fails",
    /const kept = remembered\(host\)/.test(src) &&
    /return \{ ip: kept, stale: true \}/.test(src));
check("a remembered answer is NEVER used when the name genuinely does not exist",
    /if \(kept && !sawNx\)/.test(src));
check("nothing private can ever be remembered",
    /if \(!f \|\| isPrivateNet\(ip\)\) return;/.test(src) &&
    /\(ip && !isPrivateNet\(ip\)\) \? ip : null/.test(src));

console.log(`\n${pass}/${pass + fail} public-dns checks passed`);
process.exit(fail ? 1 : 0);
