/**
 * NODE RELAY (the door) — static contract.
 *
 * The live door is proven by node-door.js against the real script. THIS suite
 * pins the wiring around it: every fallback site exists, the token never
 * touches disk in plaintext, the failover only fires when nothing has
 * streamed, and the setup script provisions everything the adoption pass
 * later reads. These are the seams that silently rot when one side changes.
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 200) : ""); }
}

const ROOT = path.join(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const cloudSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const preloadSrc = fs.readFileSync(path.join(ROOT, "app", "preload.js"), "utf8");
const doorPy = fs.readFileSync(path.join(ROOT, "tools", "node-door", "lcl-door.py"), "utf8");

// ---- the door script itself ----
check("door script ships under tools (extraResources carries *.py)",
    fs.existsSync(path.join(ROOT, "tools", "node-door", "lcl-door.py")));
check("door binds loopback only — funnel is the sole way in",
    /ThreadingHTTPServer\(\("127\.0\.0\.1"/.test(doorPy));
check("door strips the bearer token before proxying to the model server",
    /"authorization"/.test(doorPy) && /continue/.test(doorPy));
check("door refuses to start with an empty token",
    /empty token file/.test(doorPy));
check("door uses stdlib only (no pip installs on the node)",
    !/^\s*(import|from)\s+(requests|flask|aiohttp|fastapi)/m.test(doorPy));

// ---- provisioning ----
check("door setup stages the script over scp, not a pasted one-liner",
    /scpArgs/.test(mainSrc) && /lcl-door\.py/.test(mainSrc));
check("token is generated ON the node from /dev/urandom, never sent to it",
    /urandom/.test(mainSrc) && /token/.test(mainSrc));
check("setup publishes through tailscale funnel",
    /tailscale funnel --bg/.test(mainSrc));
check("setup records the public url for the adoption pass",
    /public\.json/.test(mainSrc));
check("systemd unit restarts the door on failure",
    /Restart=always/.test(mainSrc));

// ---- adoption ----
check("adoption proves the door answers from THIS machine before storing",
    /adoptNodeDoor/.test(mainSrc) && /\/lcl\/ping/.test(mainSrc));
check("adoption stores the token through the OS-encrypted key store",
    /putKey\(nodeEndpointId\(n\) \+ "::door"/.test(mainSrc));
check("adoption runs opportunistically from the nodes refresh",
    /ssh === "ok" && !n\.relayUrl/.test(mainSrc));
check("the plaintext token is never written into settings",
    !/relayToken/.test(mainSrc));

// ---- monitoring fallbacks ----
check("nodeStats falls back to the door before reporting unreachable",
    /doorFetch\(n, "\/lcl\/stats"\)/.test(mainSrc));
/* nodeStats no longer names the route itself. Its ordering — /proc/meminfo,
 * then the door, then the serving port — moved into nodeMemory.js so it could
 * be driven against a real machine in a test, which is the only reason the
 * gauge stopped shipping broken. The door is still asked; the ask now crosses a
 * seam, so this follows it across rather than counting a literal that used to
 * appear twice in one file. */
check("nodeDash asks the door directly, and nodeStats asks it through the " +
      "module that owns the route order — same door, same route",
    /doorFetch\(n, "\/lcl\/stats"/.test(mainSrc) &&
    /door: \(route\) => doorFetch\(n, route\)/.test(mainSrc) &&
    /io\.door\("\/lcl\/stats"\)/.test(
        fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "nodeMemory.js"), "utf8")));
check("nodes probe asks the door when everything direct is dead",
    /doorFetch\(n, "\/lcl\/ping"/.test(mainSrc));
check("door-derived stats are marked so the UI can say so",
    /via: "door"/.test(mainSrc));

// ---- chat failover ----
check("cloudModels stores the relay as transport, baseUrl stays the identity",
    /relayUrl: v\.relayUrl \|\| null/.test(cloudSrc));
check("streamChat reads the door token from the encrypted store",
    /getKey\(s\.id \+ "::door"\)/.test(cloudSrc));
check("failover fires only before anything streamed (partials are returned, not retried)",
    /if \(output \|\| reasoning \|\| usage\) return false/.test(cloudSrc));
check("a failed direct road makes later calls go door-first (no repeated dead connects)",
    /doorFirst\.set\(s\.id, Date\.now\(\)\)/.test(cloudSrc) && /preferDoor\(s\.id\)/.test(cloudSrc));

// AUTO-REVERT. The reason the direct road closed is temporary by nature —
// the VPN goes off, the laptop comes home — so preferring the door must be
// a lease, not a verdict.
check("door-first preference EXPIRES, so chat returns to the direct path on " +
      "its own once the VPN is off (no restart, no setting)",
    /DOOR_FIRST_TTL_MS/.test(cloudSrc) &&
    /Date\.now\(\) - at > DOOR_FIRST_TTL_MS/.test(cloudSrc));
check("a blackholing VPN does not cost the OS connect timeout: the direct " +
      "attempt gets a short leash when a door exists",
    /DIRECT_PROBE_MS/.test(cloudSrc) &&
    /const wantsProbe = \(!target\.viaDoor && hasDoor\);/.test(cloudSrc));
check("THE LEASH COVERS CONNECTING, NOT ANSWERING. It was the whole request's " +
      "inactivity timeout, and an OpenAI-compatible server sends nothing at all " +
      "until generation starts — so a large model coming off disk looked exactly " +
      "like a dead route, and was cut off at six seconds every time",
    /req\.on\("socket"/.test(cloudSrc) &&
    /sock\.once\("connect", up\)/.test(cloudSrc) &&
    /if \(probeTimer\) \{ clearTimeout\(probeTimer\); probeTimer = null; \}/.test(cloudSrc));
check("monitoring always tries direct first — no stickiness at all in the " +
      "gauge and dashboard paths",
    /const r = await sshBatch\(n\.user \|\| null, n\.host,[\s\S]{0,400}if \(!r\.ok\)[\s\S]{0,200}doorFetch/.test(mainSrc));
check("timeout failover exists — a blackholing VPN DROPS, it does not refuse — " +
      "but ONLY when nothing ever reached the server. The door and the direct " +
      "address are two roads to ONE machine, so falling over after the request " +
      "had landed put a second chat on a host already loading a huge model, and " +
      "the host allocated a second runner for it",
    /req\.on\("timeout"[\s\S]{0,900}if \(!connected && tryOther\(\)\) return;/.test(cloudSrc));
check("the door path is the DIRECT endpoint's path (door proxies verbatim)",
    /new URL\(s\.baseUrl\)\.pathname[\s\S]{0,80}chat\/completions/.test(cloudSrc));
check("setNodeRelay is exported for main's adoption pass",
    /setNodeRelay/.test(cloudSrc.slice(cloudSrc.indexOf("module.exports"))));
check("getDoorToken is the only decrypted-token export, scoped to ::door",
    /getDoorToken: \(endpointId\) => getKey\(endpointId \+ "::door"\)/.test(cloudSrc));

// ---- surfaces ----
check("preload exposes nodeDoorSetup", /nodeDoorSetup/.test(preloadSrc));
check("Connections offers remote-access setup, with the timing in the label",
    /Set up while on this network/.test(appSrc));
check("a relay-only node reads as WORKING, not broken",
    /reachable through remote access/.test(appSrc));
check("sidebar gauge says when numbers arrive over the relay",
    /via remote access/.test(appSrc));
check("the VPN note promises the fix, not homework — and specifically does " +
      "NOT ask the user to reconfigure their VPN, which for the reporting " +
      "user was not even possible: they cannot work without it",
    // NOTE: match text that lives inside ONE string literal — these messages
    // are built by concatenation, so a phrase spanning a `" +` never matches.
    // The promise used to be stated three times (row meta, banner, sidebar
    // tooltip). It lives ONCE now, in the banner said up front for the whole
    // pane.
    // The promise itself was then the problem — it made it sound like
    // .lcl would do this automatically, without any user direction or
    // engagement. It cannot: publishing needs the machine reachable and, once,
    // its password. So the note now points at the control instead of promising
    // an outcome, and must still never hand the user VPN homework.
    !/\.lcl does that /.test(appSrc) &&
    /from this row, the next time you are on its network/.test(appSrc) &&
    !/split.?tunnel/i.test(appSrc) && !/exclude Tailscale/i.test(appSrc) &&
    !/allow LAN traffic/i.test(appSrc));

// ---- findings from the adversarial review of this feature; each one is a
//      defect that shipped in the first cut and must not come back ----

check("REVIEW: the setup script is uploaded and run BY NAME — cmd.exe truncates " +
      "a multi-line script passed as an ssh argument, so the install could never work",
    /setup\.sh/.test(mainSrc) && /sh ~\/\.config\/lcl-door\/setup\.sh/.test(mainSrc));
check("REVIEW: no multi-line heredoc is passed through cmd.exe start",
    !/sshArgs\.push\([^)]*<<UNIT/.test(mainSrc));

check("REVIEW: adoption binds the relay host to the node's OWN tailnet name — " +
      "a forgeable 200/ok ping proves nothing",
    /DNSName/.test(mainSrc) &&
    /urlHost === selfName \|\| urlHost\.endsWith/.test(mainSrc));
check("REVIEW: a rejected door is audited", /node-door-rejected/.test(mainSrc));

check("REVIEW: door traffic respects the network kill-switch (a Funnel URL is " +
      "a PUBLIC host, so reaching it is egress)",
    /function networkAllowed/.test(mainSrc) &&
    /if \(!networkAllowed\(\)\) return resolve\(null\)/.test(mainSrc) &&
    /if \(!networkAllowed\(\)\) return false/.test(mainSrc));

check("REVIEW: the endpoint id is DERIVED, not concatenated — connect() " +
      "lowercases it, so a capital in a hostname filed the token unreachably",
    /function nodeEndpointId/.test(mainSrc) &&
    !/"node-" \+ n\.host \+ "::door"/.test(mainSrc) &&
    !/setNodeRelay\("node-" \+ n\.host/.test(mainSrc));

check("REVIEW: removing a node revokes its door — key, relay, and the funnel " +
      "on the node itself",
    /node-door-revoked/.test(mainSrc) && /clearKey\(nodeEndpointId/.test(mainSrc) &&
    /funnel[^\n]*off/.test(mainSrc));

check("REVIEW: failover fires ONCE per attempt — req.destroy() synthesises a " +
      "trailing ECONNRESET that would start a second concurrent stream",
    /let retried = false/.test(cloudSrc) &&
    /if \(retried \|\| settled\) return false/.test(cloudSrc) &&
    /if \(retried\) return;/.test(cloudSrc));

check("REVIEW: the fallback is bidirectional — a stale door must fall back to " +
      "direct, not pin chat to a dead route until restart",
    /doorFirst\.delete\(s\.id\)/.test(cloudSrc) && /triedDirect/.test(cloudSrc));

check("REVIEW: a door answering 401/403/502 falls back too, rather than " +
      "surfacing its error as the model's",
    /target\.viaDoor && tryOther\(\)/.test(cloudSrc));

check("REVIEW: the door's backend port is configurable — a llama.cpp / vLLM / " +
      "TRT node does not serve on 11434",
    /LCL_DOOR_BACKEND=" \+ backendUrl/.test(mainSrc) && /backendPort/.test(mainSrc) &&
    /nodeDoorSetup\(id, port\)/.test(appSrc));

check("REVIEW: the door allowlists inference + read-only routes and refuses " +
      "Ollama's admin surface",
    (() => {
        // ANCHORED ON THE ASSIGNMENT, NOT ANY MENTION. This sliced from the
        // first occurrence of the bare word, so the moment a comment elsewhere
        // referred to ALLOWED_EXACT the slice swallowed the security note that
        // NAMES /api/pull precisely to say it is refused — and the check failed
        // on the strength of its own documentation.
        const i = doorPy.indexOf("ALLOWED_EXACT = {");
        if (i < 0 || !/def path_allowed/.test(doorPy)) return false;
        const list = doorPy.slice(i, doorPy.indexOf("}", i));
        return /\/v1\/chat\/completions/.test(list)
            && !/api\/(pull|push|create|delete)/.test(list);
    })());
check("REVIEW: token comparison is constant time on a public endpoint",
    /hmac\.compare_digest/.test(doorPy));
check("REVIEW: refused attempts are logged (silence hides credential stuffing)",
    /sys\.stderr\.write\("lcl-door/.test(doorPy));
check("REVIEW: streaming uses read1 — read() blocks until the buffer fills, " +
      "turning token-by-token SSE into one blob at the end",
    /read1\(16384\)/.test(doorPy));

// ---- the VPN reading, and the failover trigger it exposed ----
//
// Reported: the app kept locking onto a VPN — even switched off and
// refreshed, once it was seen it locked in. Measured: the
// the VPN TUN adapter was Up while the ONLY default route was Wi-Fi, and
// connections to the tailnet returned EACCES while public HTTPS was OPEN.
// So adapter presence is not evidence, and EACCES is.
check("REVIEW: an adapter alone never declares a VPN active — only an " +
      "observed block does",
    /async function blockDiagnosis\(blocked, reached\)/.test(mainSrc) &&
    // the adapter is only consulted AFTER a block has been observed
    mainSrc.indexOf("const a = await vpnAdapter(true);") >
        mainSrc.indexOf("if (blocked) lastBlockAt = Date.now();"));
// THE VERDICT MUST NOT STROBE.
//
// Reported: the block warning went away after a few seconds, then came back
// after a few seconds. A socket a kill switch holds sometimes TIMES OUT
// instead of returning EACCES, so a cycle of timeouts read as "nothing is
// blocking" and the banner blinked on the same machine, same VPN.
check("a block verdict is remembered briefly instead of recomputed from zero",
    /const BLOCK_STICKY_MS = 45_000/.test(mainSrc) &&
    /Date\.now\(\) - lastBlockAt > BLOCK_STICKY_MS/.test(mainSrc));
check("but one genuine success clears it immediately, not after a delay",
    /if \(reached\) \{ lastBlockAt = 0; return \{ active: false \}; \}/.test(mainSrc));
/* THIS COUNTED CALL SITES, WHICH IS NOT THE RULE.
 *
 * It required exactly four `await blockDiagnosis(` and exactly two of each
 * known argument shape — so adding a FIFTH honest caller broke it, and
 * swapping one existing caller's arguments for a lie would not have. A census
 * passes for the wrong reason in both directions.
 *
 * The rule is about the SECOND argument. `reached: true` clears a sticky block
 * instantly, so a caller that asserts it without having measured it turns the
 * kill-switch warning off on the strength of nothing. No call site may pass a
 * bare `true` there; it has to come from something observed. `blocked: true`
 * is allowed as a literal only where a failure was just classified — which is
 * the install path, whose ternary is what makes it evidence rather than a
 * guess. */
const bdCalls = (() => {
    const out = [];
    const NEEDLE = "await blockDiagnosis(";      // the definition has no await
    let i = -1;
    while ((i = mainSrc.indexOf(NEEDLE, i + 1)) >= 0) {
        let d = 1, j = i + NEEDLE.length;
        for (; j < mainSrc.length && d > 0; j++) {
            if (mainSrc[j] === "(") d++;
            else if (mainSrc[j] === ")") d--;
        }
        const inner = mainSrc.slice(i + NEEDLE.length, j - 1);
        // split on the TOP-LEVEL comma only
        let depth = 0, cut = -1;
        for (let k = 0; k < inner.length; k++) {
            if (inner[k] === "(") depth++;
            else if (inner[k] === ")") depth--;
            else if (inner[k] === "," && depth === 0) { cut = k; break; }
        }
        if (cut < 0) { out.push([inner.trim()]); continue; }
        out.push([inner.slice(0, cut).trim(), inner.slice(cut + 1).trim()]);
    }
    return out;
})();
check("every caller reports whether anything was actually reached",
    // a FLOOR, not a census: adding an honest caller must never break this,
    // but a surface that stops reporting the verdict must
    bdCalls.length >= 4
    && (mainSrc.match(/vpn: await blockDiagnosis\(/g) || []).length >= 4
    && bdCalls.every(a => a[1] !== "true")
    && bdCalls.every(a => a[0] !== "true" || /why === "blocked" \? await blockDiagnosis\(true, false\)/
        .test(mainSrc))
    // an ssh "ok" counts as reached only when it was MEASURED this tick — a
    // governor-held verdict from before a kill switch engaged is not proof
    && /\(n\.sshFresh && n\.ssh === "ok"\) \|\| n\.doorOk/.test(mainSrc),
    bdCalls);

// LINKING IS NOT A CHORE. If the only reason for adding a node is to run
// models, there should be no separate "link models" button — but the models
// must never be allowed to go stale.
check("a serving node's models are linked without being asked",
    /async function syncNodeModels\(n, serving\)/.test(mainSrc) &&
    /await syncNodeModels\(n, serving\)/.test(mainSrc));
check("and re-read whenever the node's own count stops matching",
    /if \(linked && \(!offered \|\| offered === linked\)\) return false;/.test(mainSrc) &&
    /kind: linked \? "node-models-refreshed" : "node-models-linked"/.test(mainSrc));
check("the re-read is floored so a broken node is not hammered",
    /if \(Date\.now\(\) - last < 30_000\) return false;/.test(mainSrc));
check("the Link models button is gone from the row",
    !/innerText = "Link models"/.test(appSrc));
check("REVIEW: the probe carries WHY it failed, not just that it did",
    /BLOCKED_CODES/.test(mainSrc) &&
    /err: String\(\(e && e\.code\) \|\| "ERROR"\)/.test(mainSrc));
check("REVIEW: EACCES/EPERM count as a closed road for chat failover — a " +
      "kill switch denies the socket rather than refusing the connection",
    /EACCES\|EPERM/.test(cloudSrc));
check("REVIEW: an unattributable block says so instead of naming the last " +
      "VPN it ever saw",
    /Something on this machine/.test(appSrc));

// ---- NOTHING PUBLISHES TO THE INTERNET UNASKED ----
//
// These checks once demanded the OPPOSITE: that remote access install itself
// the moment a node was reachable. A security review confirmed what that
// means — a background timer exposing a node's inference API to the public
// internet with no user action at all. That stays forbidden.
//
// What is now allowed is narrower and was forced by the field: a user
// pressed Finish while the machine was NOT reachable, because the VPN that
// blocks it is one they cannot work without (it has to stay on to use the
// network at all). Requiring them to be watching when a window opens
// meant zero attempts in a day. So a press ARMS the instruction and the
// watchdog carries out that instruction — for that node, from that press,
// while it is fresh, and never on its own initiative.
//
// The old check passed on a function NAME that no longer exists, which would
// have let this change through silently. It asserts the actual rule now.
check("SECURITY: the timer never publishes on its own initiative",
    !/async function autoInstallDoor/.test(mainSrc) &&
    /if \(n\.finishArmed && Date\.now\(\) - n\.finishArmed < ARM_TTL_MS\)/.test(mainSrc));
check("SECURITY: only an explicit press can arm it",
    /ipcMain\.handle\("lcl:nodeArmFinish"/.test(mainSrc) &&
    /rec\.finishArmed = Date\.now\(\)/.test(mainSrc) &&
    (mainSrc.match(/finishArmed = Date\.now\(\)/g) || []).length === 1);
check("SECURITY: an armed instruction expires rather than lingering forever",
    /const ARM_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/.test(mainSrc));
check("SECURITY: an armed run still requires a pinned host and permitted egress",
    /if \(!networkAllowed\(\)\) return;/.test(mainSrc) &&
    /if \(!hostIsPinned\(n\.host\)\) continue;/.test(mainSrc) &&
    mainSrc.indexOf("if (!hostIsPinned(n.host)) continue;") >
        mainSrc.indexOf("if (n.finishArmed && Date.now()"));
check("SECURITY: arming and every armed run are recorded in the audit log",
    /kind: "node-door-armed"/.test(mainSrc) &&
    /kind: "node-door-armed-run"/.test(mainSrc));
check("the instruction is cleared once carried out, so it cannot re-fire — " +
      "on EVERY success path: watchdog publish, inline finish, ACTIVATION and " +
      "ADOPTION (one armed press once drove 41 full re-runs; review " +
      "found adoption as the fourth path, the only one not clearing it)",
    (mainSrc.match(/delete rec2?\.finishArmed/g) || []).length === 4 &&
    /delete rec\.finishArmed;[\s\S]{0,200}paths\.writeSettings/.test(
        (/async function activatePendingRelay[\s\S]*?\n\}/.exec(mainSrc) || [""])[0]) &&
    /delete rec\.finishArmed;[\s\S]{0,200}paths\.writeSettings/.test(
        (/async function adoptNodeDoor[\s\S]*?\n\}/.exec(mainSrc) || [""])[0]));
check("SECURITY: the watchdog only adopts, and only for a pinned host",
    /if \(!hostIsPinned\(n\.host\)\) continue;[\s\S]{0,200}await adoptNodeDoor\(n\.id\)/.test(mainSrc));
check("SECURITY: the nodes refresh also adopts only, and only when pinned",
    /ssh === "ok" && !n\.relayUrl && hostIsPinned\(n\.host\)/.test(mainSrc) &&
    /\.then\(\(\) => adoptNodeDoor\(n\.id\)\)/.test(mainSrc));
check("SECURITY: 'ssh exited 0' is never treated as proof of identity — every " +
      "ssh and scp uses a pinned known_hosts with strict checking",
    (mainSrc.match(/UserKnownHostsFile=\$\{knownHostsFile\(\)\}/g) || []).length >= 3);

// accept-new IS allowed in exactly one place and under exactly one condition.
//
// Windows ships OpenSSH 9.5, whose ssh-keyscan cannot negotiate a key exchange
// with a current sshd ("choose_kex: unsupported KEX method sntrup761x25519"),
// so reading a fingerprint at all now means asking regular ssh for it. That
// needs accept-new — but pointed at a THROWAWAY file which is read and then
// deleted. Nothing is trusted from it: the key still reaches the real
// known_hosts only after a person confirms the fingerprint on screen. The rule
// being enforced is therefore not "never accept-new" but "accept-new never
// touches the file that grants trust".
{
    const code = mainSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const uses = (code.match(/StrictHostKeyChecking=accept-new/g) || []).length;
    check("SECURITY: accept-new is used once, and never against the real known_hosts",
        uses === 1 && !/accept-new[\s\S]{0,240}UserKnownHostsFile=\$\{knownHostsFile\(\)\}/.test(code),
        { uses });
    check("SECURITY: the throwaway host-key file is deleted after it is read",
        /const tmpKh = [\s\S]{0,900}?fs\.unlinkSync\(tmpKh\)/.test(code));
    check("SECURITY: pinning records the fingerprint the user confirmed, " +
          "not whatever answers the second scan",
        /nodePinHostKey["'], guard\(async \(_e, host, expect\)/.test(code) &&
        /got\.some\(\(g, i\) => g !== want\[i\]\)/.test(code) &&
        /nodePinHostKey\(\s*state\.host, key\.prints\.map/.test(appSrc));
}
// THE ESCAPE HATCH MAY NOT BE BEHIND THE LOCKED DOOR.
//
// From the field, behind the VPN: remote access had
// been set up and Funnel approved, and the app still could not reach the
// machine — because learning the route required SSH, and SSH was the exact
// thing the VPN kill switch was blocking. The route is now remembered while
// the app is still ON the machine's network, and activated later with one
// HTTPS request that works from any network.
check("the setup script reports the route even when the funnel is not live yet",
    /LCL-DOOR-NAME=/.test(mainSrc) && /LCL-DOOR-TOKEN=/.test(mainSrc));
check("the route is stored at provision time, on the machine's own network",
    /rec\.relayPending = `https:\/\/\$\{selfName\.toLowerCase\(\)\}`/.test(mainSrc) &&
    /kind: "node-door-route-stored"/.test(mainSrc));
check("activating a remembered route uses NO ssh — one https request",
    /async function activatePendingRelay\(nodeId\)/.test(mainSrc) &&
    !/sshBatch|spawn\("ssh"/.test(
        (/async function activatePendingRelay[\s\S]*?\n\}/.exec(mainSrc) || [""])[0]));
check("the refresh and the watchdog both try a remembered route first",
    /if \(!p\.relayUrl && p\.relayPending\)/.test(mainSrc) &&
    /if \(n\.relayPending\) \{[\s\S]{0,160}activatePendingRelay/.test(mainSrc));
check("the watchdog tries the route BEFORE the local port check that would skip it",
    mainSrc.indexOf("if (n.relayPending) {") <
        mainSrc.indexOf("if (!await tcpOpen(n.host, 22, 3000)) continue;"));
check("activation still proves the door answers before trusting the route",
    /\/lcl\/ping/.test(
        (/async function activatePendingRelay[\s\S]*?\n\}\n/.exec(mainSrc) || [""])[0]));

// A BLOCKED SOCKET IS NOT A REFUSED LOGIN.
//
// Windows reports a VPN kill switch as
//   ssh: connect to host <ip> port 22: Permission denied
// and matching the bare words "Permission denied" told the user their
// node had rejected them. A real refusal comes from the far end and names
// the methods it tried.
check("an auth verdict requires ssh to have actually reached the far end",
    /const reachedSshd = !\/connect to host\/i\.test\(n\.ssh\)/.test(appSrc) &&
    /permission denied \\\(/.test(appSrc));

check("SECURITY: the password terminal refuses to open for an unconfirmed host",
    /if \(!hostIsPinned\(host\)\) \{[\s\S]{0,200}identity has not been confirmed/.test(mainSrc));
// comments stripped: both of these words survive in the commentary that
// records WHY they were removed, and that history is worth keeping
const mainCode = mainSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
check("SECURITY: and it no longer disables publickey auth to force a password",
    !/PubkeyAuthentication=no/.test(mainCode) &&
    /PreferredAuthentications=publickey,password/.test(mainCode));
check("SECURITY: a fingerprint is shown and confirmed by a human before pinning",
    /lcl:nodeHostKey/.test(mainSrc) && /lcl:nodePinHostKey/.test(mainSrc) &&
    /Fingerprints match/.test(appSrc) &&
    /ssh-keygen -lf \/etc\/ssh\/ssh_host_ed25519_key\.pub/.test(mainSrc));
check("SECURITY: a reverse-DNS name is validated and never becomes a trust signal",
    /nameFrom = "reverse-dns"/.test(mainSrc) &&
    /raw\.length <= 63/.test(mainSrc));
check("SECURITY: the door token never reaches a command line on the node",
    !/Bearer \$TOK/.test(mainCode) &&          // was: curl -H "... $TOK"
    /curl -s -m 5 -K /.test(mainCode) &&        // reads the header from a file
    /rm -f .{0,4}\$D\/\.curlrc/.test(mainCode) &&
    /umask 077/.test(mainCode));
check("SECURITY: the door ends the connection on every refusal, so an unread " +
      "body cannot be parsed as the next request",
    (doorPy.match(/self\.close_connection = True/g) || []).length >= 2 &&
    /Transfer-Encoding/.test(doorPy) && /MAX_BODY/.test(doorPy));
check("SECURITY: a non-ASCII Authorization header cannot kill the handler thread",
    /compare_digest\(h\.encode\(/.test(doorPy));
check("REVIEW: both install paths share one implementation",
    /async function provisionDoor/.test(mainSrc) &&
    /return provisionDoor\(n, Number\(port\)/.test(mainSrc));
check("REVIEW: an automatic install tells the user it happened",
    /lcl:nodeDoorReady/.test(mainSrc) && /onNodeDoorReady/.test(appSrc));


// THE PASSWORD STEP IS THE APP'S JOB, NOT THE USER'S HOMEWORK.
//
// Measured on the test machine, with Funnel already
// approved account-wide and the door already running:
//   $ tailscale funnel --bg 8347
//   Access denied: serve config denied
//   To not require root, use 'sudo tailscale set --operator=$USER' once.
// Sudo there wants a password, so every unattended attempt died in silence and
// days were lost to it. This is all supposed to be driven from within the app,
// not by pasting commands. The app opens the terminal itself; the
// password goes to the user's own machine over SSH and .lcl never sees it.
check("the setup script recognises the operator refusal by name",
    /serve config denied/.test(mainSrc) && /LCL-NEEDS-OPERATOR/.test(mainSrc));
check("it comes back as a STATE the UI can act on, not an error string",
    /needsPassword: true/.test(mainSrc));
check("there is a handler that opens the terminal for that one password",
    /ipcMain\.handle\("lcl:nodeFunnelGrant"/.test(mainSrc) &&
    /sudo tailscale set --operator=\$USER/.test(mainSrc));
check("it sets the operator AND publishes in the same visible run",
    /tailscale funnel --bg \$\{p\}/.test(mainSrc));
check("SECURITY: it refuses for a machine whose identity was never confirmed",
    /nodeFunnelGrant[\s\S]{0,500}?if \(!hostIsPinned\(n\.host\)\)/.test(mainSrc));
check("the wizard offers a BUTTON for it, never a command to copy",
    /res\.needsPassword/.test(appSrc) &&
    /Open the password prompt/.test(appSrc) &&
    /window\.lcl\.nodeFunnelGrant/.test(appSrc));
check("no user-facing text tells the user to run something themselves",
    !/run this command/i.test(appSrc) && !/paste this/i.test(appSrc));

check("the ROW's finish button carries the password step through too — it " +
      "reported 'saved' and dropped it, which was the whole failure",
    /r && r\.needsPassword/.test(appSrc) &&
    /window\.lcl\.nodeFunnelGrant\(n\.id, port\)/.test(appSrc));

// EVERY cloudModels CALL IN main.js MUST ACTUALLY BE EXPORTED.
//
// activatePendingRelay called cloudModels.getKey(...), which is NOT exported —
// getDoorToken is the only decrypted-token export. So it threw on every run,
// the throw was swallowed by its own catch, and the route sat in relayPending
// forever while the door answered 401 from the public internet. Measured:
// zero activation events, token stored, network on, door
// live. A silent catch turned a typo into hours of debugging.
{
    const exp = cloudSrc.slice(cloudSrc.indexOf("module.exports"));
    const exported = new Set((exp.match(/([A-Za-z_$][\w$]*)\s*[,:}]/g) || [])
        .map(s => s.replace(/[\s,:}]/g, "")));
    const used = [...new Set((mainSrc.match(/cloudModels\.([A-Za-z_$][\w$]*)/g) || [])
        .map(s => s.split(".")[1]))];
    const missing = used.filter(u => !exported.has(u));
    check("main.js never calls a cloudModels function that does not exist",
        missing.length === 0, missing.join(", "));
    check("the door token is read through the ONE export that decrypts it, " +
          "and never through the unexported getKey",
        /cloudModels\.getDoorToken\(/.test(mainSrc) &&
        !/cloudModels\.getKey\(/.test(mainSrc));
    check("...and every reader goes through ONE helper, because the id the " +
          "token is stored under moved once already and five call sites did " +
          "not move with it",
        /function doorTokenOf\(n\)/.test(mainSrc) &&
        (mainSrc.match(/cloudModels\.getDoorToken\(/g) || []).length === 1 &&
        (mainSrc.match(/doorTokenOf\(n\)/g) || []).length >= 5);
    check("...and that helper tries the machine's own key AND each of its " +
          "engines, so a store written either way still opens the door",
        /const tryIds = \[nodeEndpointId\(n\)\]/.test(mainSrc) &&
        /for \(const e of nodeEndpointsOf\(n\)\) tryIds\.push\(e\.id\)/.test(mainSrc));
}

// A WORKING RELAY MUST NOT READ AS "NO MODEL SERVER".
//
// Every serving probe dials the node's DIRECT address, which is precisely what
// a full-tunnel VPN blocks. Reported from a restricted network: the row
// said "Next: Install the model server on it" for a node serving ten models,
// while the dashboard directly beside it streamed live memory from that same
// machine over that same relay.
check("the serving probe falls back to the door when the direct road is shut",
    /if \(!serving\.length && n\.relayUrl\)/.test(mainSrc) &&
    /doorFetch\(n, "\/v1\/models"/.test(mainSrc));
check("what it learns that way is marked as coming through the relay",
    /via: "door"/.test(mainSrc));

/* =====================================================================
 * LIVE — because a regex cannot watch a timer fire.
 *
 * Everything above this line reads cloudModels.js as TEXT, and that is
 * exactly how the door came to be killed by the road it replaces. The
 * check on line ~97 matched the clearTimeout line and passed happily
 * while, at runtime, the abandoned direct attempt's leash was reaching
 * across into the door's turn and rejecting it six seconds in. So these
 * stand up real sockets on loopback and read what actually happens.
 *
 * Nothing here leaves the machine: the stubs bind 127.0.0.1, the door's
 * public-DNS resolver is replaced with one that answers loopback, and
 * the data directory is a throwaway.
 * =================================================================== */
const os = require("os");
const http = require("http");

const Module = require("module");
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
    if (r === "electron") return __filename;
    return _resolve.call(this, r, ...a);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-node-relay-"));
// paths.dataDir() ignores an electron stub in development and writes into the
// repo's own data/ folder; this is the switch that makes the isolation real.
process.env.LCL_DATA_DIR = DATA;
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

const pathsMod = require(path.join(ROOT, ".lcl.engine", "core", "paths.js"));
pathsMod.writeSettings({ networkEnabled: true });
// the door is a loopback stub here; resolve it the way a door resolves,
// without a DNS-over-HTTPS request actually going out
const publicDns = require(path.join(ROOT, ".lcl.engine", "core", "publicDns.js"));
publicDns.lookup = (host, opts, cb) =>
    (typeof opts === "function" ? opts : cb)(null, "127.0.0.1", 4);
const cloud = require(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"));

const CALL_LOG = path.join(DATA, "node-calls.jsonl");
const callLines = () => (fs.existsSync(CALL_LOG)
    ? fs.readFileSync(CALL_LOG, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : []);
const listen = (srv) => new Promise((res) => srv.listen(0, "127.0.0.1",
    () => res(srv.address().port)));
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {

/* ---------------------------------------------------------------------
 * 1. THE DOOR SURVIVES THE ROAD IT REPLACED
 *
 * MEASURED against this exact setup, before the fix:
 *   [  225] door: request received /v1/chat/completions
 *   [ 6228] REJECTED: spark could not be reached directly
 *   [ 6230] open door connections: 1
 * and with the direct attempt's leash cleared on abandonment:
 *   [12180] door: answered
 *   [12203] RESOLVED: "developer"
 * The door was always working. The abandoned attempt's timer is what
 * killed it, and it leaked the door's socket on the way out — so the
 * node kept generating for a turn that had already failed, and Stop
 * could no longer reach it because done() had restored cancelToken.abort.
 * ------------------------------------------------------------------- */
{
    // past DIRECT_PROBE_MS (6s) by a margin, so a leash that still fires
    // has time to do its damage before the door answers
    const DOOR_ANSWER_MS = 8000;
    const liveSockets = new Set();
    let doorHits = 0;

    const door = http.createServer((req, res) => {
        doorHits++;
        setTimeout(() => {
            if (res.writableEnded || res.destroyed) return;
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write('data: {"choices":[{"delta":{"content":"developer"}}]}\n\n');
            res.write("data: [DONE]\n\n");
            res.end();
        }, DOOR_ANSWER_MS);
    });
    door.on("connection", (s) => { liveSockets.add(s); s.on("close", () => liveSockets.delete(s)); });

    // a port nothing listens on: the direct road refuses instantly, which is
    // the ECONNREFUSED/EACCES shape a VPN kill switch produces
    const spare = http.createServer(() => {});
    const deadPort = await listen(spare);
    await new Promise((res) => spare.close(res));
    const doorPort = await listen(door);

    cloud.linkEndpoint({
        id: "relay-live", label: "darkroom node",
        baseUrl: `http://127.0.0.1:${deadPort}`,
        localNode: true,
        node: { id: "n-live", name: "darkroom node", host: "127.0.0.1", port: deadPort },
        models: [{ id: "m1" }]
    });
    cloud.setNodeRelay("relay-live", `http://127.0.0.1:${doorPort}`, "door-token");
    const sel = { ...cloud.endpoints().find(e => e.id === "relay-live"), model: "m1" };

    const t0 = Date.now();
    let out = null, err = null;
    try {
        out = await cloud.streamChat([{ role: "user", content: "mix the developer" }],
            { selection: sel, timeoutMs: 60_000 });
    } catch (e) { err = e; }
    const took = Date.now() - t0;

    check("LIVE: an abandoned direct attempt does not kill the door's turn — its " +
          "connect leash is cleared when the attempt is abandoned, not only when " +
          "it connects or times out, so the 6s timer of a road that ECONNREFUSED " +
          "cannot reject a door request that is still in flight",
        !err && out && out.output === "developer",
        err ? err.message : JSON.stringify(out && out.output));
    check("LIVE: ...and the turn really did outlive the leash rather than being " +
          "answered before it could fire",
        took > 7000, { tookMs: took });
    check("LIVE: ...and the door's socket is not left open behind a failed turn " +
          "(it was: the node went on loading for a turn already rejected, and " +
          "Stop could no longer reach that socket)",
        (await wait(400), liveSockets.size === 0),
        { doorHits, open: liveSockets.size });
    check("LIVE: ...and the call log says the door answered, not that a road " +
          "which WAS reached was unreachable",
        (() => {
            const l = callLines();
            const last = l[l.length - 1];
            return l.length === 1 && last.outcome === "ok" && last.road === "door";
        })(), callLines());

    await new Promise((res) => door.close(res));
    fs.writeFileSync(CALL_LOG, "");
}

/* ---------------------------------------------------------------------
 * 2. ONE RECORD PER CALL, HOWEVER IT ENDS
 *
 * The header over logCall promises exactly that, and two of the five
 * terminal paths wrote nothing: the socket dying with the answer half
 * delivered, and the user pressing Stop. MEASURED before the fix,
 * reading node-calls.jsonl either side of each turn: clean answer 1 line,
 * Stop mid-stream 0 lines, socket death 0 lines. The two events someone
 * would actually open the log to explain were the two with no trace.
 * ------------------------------------------------------------------- */
let nodePort = 0;
{
    let mode = "ok";
    const node = http.createServer((req, res) => {
        if (req.url === "/api/ps") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ models: [] }));
        }
        if (req.url === "/api/tags") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ models: [
                { name: "stop-bath", model: "stop-bath", size: 100e9 },
                { name: "fixer", model: "fixer", size: 130e9 }
            ] }));
        }
        if (mode === "hang") return;              // headers never sent: still loading
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"stop bath"}}]}\n\n');
        if (mode === "ok") { res.write("data: [DONE]\n\n"); return res.end(); }
        if (mode === "die") { setTimeout(() => res.socket.destroy(), 120); return; }
    });
    nodePort = await listen(node);

    cloud.linkEndpoint({
        id: "log-live", label: "darkroom node", baseUrl: `http://127.0.0.1:${nodePort}`,
        localNode: true,
        // MEASURED, not computed — the rebuilt load guard runs before every one
        // of these turns and wants a real free-memory reading, not a total it
        // can do arithmetic on. 240 GB genuinely free on a 256 GB machine, so a
        // 100 GB load is a fair landing and these turns are about the LOG.
        node: { id: "n-log", name: "darkroom node", host: "127.0.0.1",
                port: nodePort, memBytes: 256e9,
                availableBytes: 240e9, availableAt: Date.now() },
        models: [{ id: "stop-bath" }]
    });
    const sel = { ...cloud.endpoints().find(e => e.id === "log-live"), model: "stop-bath" };

    const turn = async (opts = {}) => {
        const before = callLines().length;
        try { await cloud.streamChat([{ role: "user", content: "hi" }],
            { selection: sel, timeoutMs: 15_000, ...opts }); } catch { /* the point */ }
        return callLines().slice(before);
    };

    mode = "ok";
    const clean = await turn();
    check("LIVE: a clean answer writes exactly one line, and says how much came back",
        clean.length === 1 && clean[0].outcome === "ok" && clean[0].chars > 0, clean);

    mode = "slow";
    const tok = { cancelled: false };
    const p = turn({ cancelToken: tok });
    await wait(300);
    tok.cancelled = true;
    if (tok.abort) tok.abort();
    const stopped = await p;
    check("LIVE: STOP MID-ANSWER IS RECORDED, and recorded as a person stopping " +
          "it rather than as the road failing — destroying the socket reaches the " +
          "RESPONSE as an abort before the request ever hears about it, so the " +
          "name is decided by who stopped it, not by which handler won the race",
        stopped.length === 1 && stopped[0].outcome === "stopped"
        && stopped[0].chars > 0, stopped);

    mode = "die";
    const dropped = await turn();
    check("LIVE: A STREAM THAT DIES MID-ANSWER IS RECORDED, under its own name, " +
          "with the characters that had already arrived — this wrote nothing at all",
        dropped.length === 1 && dropped[0].outcome === "dropped-midstream"
        && dropped[0].chars > 0, dropped);

    mode = "hang";
    const tok2 = { cancelled: false };
    const p2 = turn({ cancelToken: tok2 });
    await wait(300);
    tok2.cancelled = true;
    if (tok2.abort) tok2.abort();
    const stoppedCold = await p2;
    check("LIVE: and Stop during the LOAD — nothing delivered yet, which is the " +
          "case that was actually hit at 122 seconds — is recorded too",
        stoppedCold.length === 1 && stoppedCold[0].outcome === "stopped"
        && stoppedCold[0].chars === 0, stoppedCold);

    check("LIVE: no terminal path double-records: the `logged` flag holds even " +
          "when two handlers fire for the same dead socket",
        [clean, stopped, dropped, stoppedCold].every(l => l.length === 1));

    await new Promise((res) => node.close(res));
}

/* ---------------------------------------------------------------------
 * 3. THE LOAD GUARD MEASURES. IT DOES NOT COMPUTE, AND IT DOES NOT GUESS.
 *
 * This guard has now failed to prevent the same crash twice, in two
 * different ways, and both are pinned here against the record that
 * actually exists on disk rather than a synthetic one
 * with the convenient field already present. That substitution is the
 * whole reason the second crash happened: every previous proof used a
 * record shaped the way the code wished it were.
 *
 *   endpoint record   {"id":"node-example1","name":"spark",
 *                      "host":"100.64.0.1","port":11434}
 *   registry record   memBytes 130663002112
 *   MEASURED before   nodePreflight -> null -> PROCEEDED, 100 GB model
 *   control, memBytes present on the record -> ALSO null -> proceeded
 *                      (need 100e9 x 1.1 = 110 GB against
 *                       130.6 - 0 resident - 6 kernel = 124.6 GB)
 *
 * Both halves are pinned: K1, the number reaches the code that reads it;
 * K2, the arithmetic no longer permits the load that killed the machine.
 * ------------------------------------------------------------------- */
{
    // THE REAL RECORD, verbatim off the installed app's disk. No memBytes,
    // because there is none, because nothing ever wrote one there.
    const REAL_NODE = { id: "node-example1", name: "spark",
                        host: "100.64.0.1", port: 11434 };
    const SPARK_BYTES = 130663002112;       // what the registry really says

    let ps = { models: [] };
    let unloads = [];
    const node = http.createServer((req, res) => {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            if (req.url === "/api/ps") return res.end(JSON.stringify(ps));
            if (req.url === "/api/tags") {
                return res.end(JSON.stringify({ models: [
                    // a typical daily model, and its real weight on disk
                    { name: "mistral-large:123b", model: "mistral-large:123b", size: 100e9 },
                    { name: "developer:45b", model: "developer:45b", size: 45e9 },
                    { name: "fixer:70b", model: "fixer:70b", size: 40e9 },
                    { name: "stop-bath:4b", model: "stop-bath:4b", size: 2.6e9 }
                ] }));
            }
            if (req.url === "/api/generate") {
                unloads.push(JSON.parse(body || "{}"));
                // Ollama lets go at once. THE KERNEL DOES NOT, and that gap is
                // the state the machine was in when it died.
                setTimeout(() => { ps = { models: [] }; }, 250);
                return res.end(JSON.stringify({ done: true }));
            }
            res.end("{}");
        });
    });
    const port = await listen(node);

    // CONTRACT K1: main.js installs this at startup and it resolves against the
    // localNodes registry — the one place a node's numbers are kept current.
    let registry = {};
    cloud.setNodeMemResolver((id) => registry[id] || null);

    // shape "ollama" is what a real on-demand node carries, and the load guard
    // is FOR on-demand loaders — these fixtures (unload-and-wait, size-refuse)
    // only mean anything on Ollama. A start-time server (llama.cpp/vLLM, shape
    // "openai") has no request-triggered load and is not guarded (the
    // llama-live case below proves that side).
    const rec = (model, extra = {}) => ({
        id: "preflight-live", label: "spark", model, shape: "ollama",
        baseUrl: `http://127.0.0.1:${port}`, localNode: true,
        node: { ...REAL_NODE, host: "127.0.0.1", port, ...extra }
    });
    const verdict = async (r, opts) => {
        try { return { ok: true, value: await cloud.nodePreflight(r, opts) }; }
        catch (e) { return { ok: false, why: e.message }; }
    };

    /* ---- K1: the number lives on the registry, not on the record ---- */
    registry = {};
    ps = { models: [] };
    const noNumber = await verdict(rec("mistral-large:123b"));
    check("LIVE: CONTRACT K1 — with NOTHING anywhere saying how big the machine " +
          "is, a 100 GB load is REFUSED. This is the exact record off disk " +
          "and the exact model, and it measured `null -> PROCEEDED` twice, once " +
          "per dead machine. Failing open was the wrong default for the one job " +
          "this function has",
        !noNumber.ok && /could not be measured/.test(noNumber.why), noNumber);

    registry = { "node-example1": { totalBytes: SPARK_BYTES, availableBytes: 124e9,
                                    at: Date.now() } };
    const stillNo = await verdict(rec("mistral-large:123b"));
    check("LIVE: CONTRACT K2 — and with the registry's REAL numbers reaching it " +
          "through setNodeMemResolver, the same load is still refused. The old " +
          "sum was 130.6 total - 0 resident - 6 kernel = 124.6 GB of room against " +
          "110 GB of need, and it passed. That comment called it 'a thin margin, " +
          "run on purpose'; the margin is what took the machine down",
        !stillNo.ok && /does not fit/.test(stillNo.why), stillNo);

    check("LIVE: ...and the old arithmetic really would have passed it, so this " +
          "check is pinned to the defect and not to a coincidence",
        (100e9 * 1.1) < (SPARK_BYTES - 0 - 6e9),
        { need: 100e9 * 1.1, oldRoom: SPARK_BYTES - 6e9 });

    check("LIVE: the refusal names numbers that were MEASURED — what it weighs, " +
          "what is actually free, who said so and how long ago — and never a " +
          "number nobody measured",
        /100 GB on disk/.test(stillNo.why) && /124 GB actually free/.test(stillNo.why)
        && /131 GB total/.test(stillNo.why) && /gauge/.test(stillNo.why)
        && !/128 GB/.test(stillNo.why), stillNo.why);

    /* ---- the record is the LAST resort, never the first ---- */
    registry = {};
    const fromRecord = await verdict(rec("stop-bath:4b", { memBytes: SPARK_BYTES }));
    check("LIVE: the endpoint's own embedded copy still works when it is all " +
          "there is — it is a link-time snapshot, so it is the fallback, not the " +
          "source",
        fromRecord.ok && fromRecord.value === null, fromRecord);

    /* ---- MEASURED, not computed: a stale reading is not a reading ---- */
    registry = { "node-example1": { totalBytes: SPARK_BYTES, availableBytes: 128e9,
                                    at: Date.now() - 10 * 60_000 } };
    const stale = await verdict(rec("mistral-large:123b"));
    check("LIVE: a free-memory reading older than MEM_FRESH_MS is not a stale " +
          "measurement, it is NO measurement. A number taken while the machine " +
          "was idle, replayed against a machine that has since loaded something, " +
          "reports room that is not there — which is precisely the lie that " +
          "killed it: a model had just been stopped, so nothing looked resident " +
          "while the kernel had not handed back one page",
        !stale.ok && /could not be measured/.test(stale.why), stale);

    /* ---- fail closed is for the LARGE. the product still works ---- */
    registry = {};
    const smallBlind = await verdict(rec("stop-bath:4b"));
    check("LIVE: ...and a SMALL model with nothing measurable still proceeds. " +
          "Failing closed on everything would be an outage wearing a safety " +
          "check's clothes; a 2.6 GB load has never taken a machine down",
        smallBlind.ok && smallBlind.value === null, smallBlind);

    registry = { "node-example1": { totalBytes: SPARK_BYTES, availableBytes: 124e9,
                                    at: Date.now() } };
    const fits = await verdict(rec("developer:45b"));
    check("LIVE: and a load that genuinely fits the measured free memory goes " +
          "through — the guard refuses loads, it does not refuse the feature",
        fits.ok && fits.value === null, fits);

    /* ---- UNLOAD BEFORE LOAD, and wait for the MEMORY, not the bookkeeping ---- */
    unloads = [];
    ps = { models: [{ name: "fixer:70b", model: "fixer:70b", size: 40e9 }] };
    let free = 25e9;
    registry = { "node-example1": { totalBytes: SPARK_BYTES,
                                    get availableBytes() { return free; },
                                    get at() { return Date.now(); } } };
    setTimeout(() => { free = 70e9; }, 3000);       // the kernel hands the pages back
    const notes = [];
    const swapped = await verdict(rec("developer:45b"), { onNote: (m) => notes.push(m) });
    check("LIVE: SWITCHING MODELS UNLOADS THE FIRST AND WAITS. The old path fired " +
          "a second load on top of a resident one and let the machine arbitrate; " +
          "it cannot, and that is how a client-side decision becomes a power-button " +
          "recovery",
        swapped.ok && swapped.value && swapped.value.waited === true
        && unloads.length === 1 && unloads[0].keep_alive === 0
        && unloads[0].model === "fixer:70b",
        { swapped, unloads });

    check("LIVE: ...and it waits for the MEMORY to come back, not for /api/ps to " +
          "go quiet. Ollama reports a model gone the moment it lets go; the " +
          "kernel reclaims the pages later, and the gap between those two facts " +
          "is the state the machine was in when it died",
        swapped.ok && swapped.value.waitedMs >= 2500
        && swapped.value.freeBytes === 70e9, swapped.value);

    check("LIVE: ...and the wait is REPORTED while it happens, rather than " +
          "looking like the app hanging",
        notes.some(n => /asking it to unload/.test(n))
        && notes.some(n => /waiting for fixer:70b to leave memory/.test(n))
        && notes.some(n => /memory came back after/.test(n)), notes);

    /* ---- and STOP reaches into that wait ---- */
    ps = { models: [{ name: "fixer:70b", model: "fixer:70b", size: 40e9 }] };
    free = 25e9;                                    // and it never comes back
    {
        const tok = { cancelled: false };
        const t0 = Date.now();
        setTimeout(() => { tok.cancelled = true; }, 1200);
        const halted = await verdict(rec("developer:45b"), { cancelToken: tok });
        const took = Date.now() - t0;
        check("LIVE: STOP REACHES INTO THE UNLOAD WAIT. This function can now sit " +
              "for ninety seconds watching memory come back, and cancellation used " +
              "to be checked in exactly one place — inside the response stream, " +
              "which does not exist yet at this point. A wait nobody can interrupt " +
              "is indistinguishable from the hang that was reported",
            !halted.ok && /stopped before anything was sent/.test(halted.why)
            && took < 15_000, { halted, took });
    }

    /* ---- THE DOOR CARRIES THE GUARD TOO, or the guard goes blind under the
     *      one condition the door exists for.
     *
     * A full-tunnel VPN closes the node's direct address. Chat already fails
     * over to the door; the preflight only ever dialled direct, so under a VPN
     * it would have learned nothing — and a guard that learns nothing now
     * REFUSES a large model. That turns a VPN into an outage. Both roads, and
     * the door resolved publicly, or MagicDNS answers the funnel name with the
     * tailnet address and sends it back into the tunnel.
     * ------------------------------------------------------------------- */
    {
        let doorPs = { models: [] };
        const door = http.createServer((req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            if (req.url === "/api/ps") return res.end(JSON.stringify(doorPs));
            if (req.url === "/api/tags") {
                return res.end(JSON.stringify({ models: [
                    { name: "mistral-large:123b", model: "mistral-large:123b", size: 100e9 }
                ] }));
            }
            if (req.url === "/lcl/stats") {
                return res.end(JSON.stringify({ ok: true, at: Date.now(),
                    mem: { totalBytes: SPARK_BYTES, availableBytes: 60e9 } }));
            }
            res.end("{}");
        });
        const dport = await listen(door);
        // a port nothing listens on: the direct road refuses instantly, which is
        // the shape a VPN kill switch produces
        const spare = http.createServer(() => {});
        const deadPort = await listen(spare);
        await new Promise((res) => spare.close(res));

        cloud.linkEndpoint({
            id: "vpn-live", label: "spark", baseUrl: `http://127.0.0.1:${deadPort}`,
            localNode: true, shape: "ollama", models: [{ id: "mistral-large:123b" }],
            node: { ...REAL_NODE, host: "127.0.0.1", port: deadPort }
        });
        cloud.setNodeRelay("vpn-live", `http://127.0.0.1:${dport}`, "door-token");
        registry = {};              // NOTHING from the gauge: the road is shut
        const viaDoor = await verdict({
            ...cloud.endpoints().find(e => e.id === "vpn-live"),
            model: "mistral-large:123b" });
        check("LIVE: with the direct road refused, the guard reads /api/ps, " +
              "/api/tags AND /proc/meminfo through the DOOR, and refuses on the " +
              "numbers it measured there — 60 GB free is not 100 GB of model",
            !viaDoor.ok && /60 GB actually free/.test(viaDoor.why)
            && /remote access/.test(viaDoor.why), viaDoor);
        await new Promise((res) => door.close(res));
    }

    /* ---- a host that does not load on demand has nothing to guard ---- */
    {
        // llama.cpp, vLLM and TRT-LLM serve ONE model, loaded when the server
        // started. There is no cold load for a chat request to trigger, and a
        // guard that refused them would be an outage it invented for itself.
        const llama = http.createServer((req, res) => {
            if (/^\/v1\//.test(req.url)) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ data: [{ id: "developer:45b" }] }));
            }
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end("{}");                        // no /api/ps, no /api/tags
        });
        const lport = await listen(llama);
        registry = {};
        const served = await verdict({
            id: "llama-live", label: "bench", model: "developer:45b",
            baseUrl: `http://127.0.0.1:${lport}`, localNode: true,
            node: { id: "n-llama", name: "bench", host: "127.0.0.1", port: lport }
        });
        check("LIVE: a node that ANSWERS and does not load on demand is not " +
              "guarded — a 404 on /api/tags means the machine is there and " +
              "serves one resident model, which is the opposite conclusion from " +
              "a timeout. Collapsing the two would refuse every turn on a " +
              "llama.cpp or vLLM box",
            served.ok && served.value === null, served);
        await new Promise((res) => llama.close(res));
    }

    /* ---- CONTRACT K4 ---- */
    await new Promise((res) => node.close(res));
    registry = {};
    const deadBig = await verdict(rec("mistral-large:123b"));
    check("LIVE: CONTRACT K4 — a machine that answers nothing on either road is " +
          "not sent a large model. Nothing about it can be measured: not what it " +
          "has loaded, not what it has free, not what the model weighs",
        !deadBig.ok && /did not answer on either road/.test(deadBig.why), deadBig);

    const h = cloud.endpointHealth("preflight-live");
    check("LIVE: ...and the verdict is RECORDED, with a reason, so the picker can " +
          "grey the row without dialling anything itself. 'The picker still lists " +
          "the Spark's models while the machine is unreachable'",
        h.offline === true && !!h.offlineReason, h);

    const deadSmall = await verdict(rec("stop-bath:4b"));
    check("LIVE: ...while a 2.6 GB model still goes and is allowed to fail on its " +
          "own terms. A telemetry outage must not become a product outage, and " +
          "the chat request behind this reports the real failure in a sentence",
        deadSmall.ok && deadSmall.value === null, deadSmall);

    check("LIVE: ...and every endpoint record carries the verdict out to the " +
          "picker, so nothing downstream has to dial a machine to know",
        cloud.endpoints().every(e => "offline" in e && "offlineReason" in e),
        cloud.endpoints().map(e => e.id));

    cloud.markEndpointOnline("preflight-live");
    check("LIVE: ...and offline is not a life sentence — one answer clears it, " +
          "because a machine that was off at 09:00 is not off forever and a " +
          "greyed row that never comes back is the same lie in reverse",
        cloud.endpointHealth("preflight-live").offline === false,
        cloud.endpointHealth("preflight-live"));

    cloud.setNodeMemResolver(null);
}

/* ---------------------------------------------------------------------
 * 4. THE RENTED TIER HAS A PRODUCER
 *
 * `rented` was read in five places and written in one — linkEndpoint —
 * and the only UI-reachable caller of linkEndpoint is connect(), which
 * never passed it. So ep.rented was false for every endpoint a person
 * could actually create: the fourth tier never rendered and the secrets
 * card named a hostname where it should have said whose machine it is.
 * (rented-gpu.js is this feature's real home; these two go here because
 * that suite belongs to another pass and must not be edited from this one.)
 * ------------------------------------------------------------------- */
{
    const api = http.createServer((req, res) => {
        if (/\/v1\/models$/.test(req.url)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ data: [{ id: "developer-chat" }] }));
        }
        res.writeHead(404); res.end("{}");
    });
    const port = await listen(api);
    const addr = `127.0.0.1:${port}`;

    await cloud.connect(addr, { rented: true, provider: "SomeCloud" });
    const rentEp = cloud.endpoints().find(e => e.rented);
    check("LIVE: connect() — the one endpoint-creating path a click can reach — " +
          "produces a RENTED endpoint, so the fourth tier is no longer code no " +
          "user can get to",
        !!rentEp && cloud.isRentedEndpoint(rentEp) === true
        && cloud.isNodeEndpoint(rentEp) === false
        && /a rented machine, not yours/.test(cloud.destinationOf(rentEp).label)
        && /SomeCloud/.test(cloud.destinationOf(rentEp).label),
        rentEp && cloud.destinationOf(rentEp));

    await cloud.connect(addr);
    // pastes get per-host ids now (api-<host>) — the shared "custom" slot
    // that let one add overwrite another is gone
    const plainEp = cloud.endpoints().find(e => e.id === "api-127.0.0.1");
    check("LIVE: ...and an ordinary paste stays ordinary — the flag states what " +
          "the user ticked, it is not inferred from the address",
        !!plainEp && plainEp.rented === false, plainEp && plainEp.id);

    await cloud.connect(addr, { node: { id: "n7", name: "darkroom node",
                                        host: "127.0.0.1", port, memBytes: 137438953472 } });
    // found by the NODE it belongs to, not by a slot id — a node's engines
    // are keyed per port now, and this check is about memBytes either way
    const nodeEp = cloud.endpoints().find(e => e.node && e.node.id === "n7");
    check("LIVE: CONTRACT C3 — connect() carries memBytes onto the node record, " +
          "which is what gives nodePreflight a real number to size against",
        !!nodeEp && nodeEp.node && nodeEp.node.memBytes === 137438953472,
        nodeEp && nodeEp.node);

    await cloud.connect(addr, { node: { id: "n6", name: "darkroom node",
                                        host: "127.0.0.1", port } });
    // the SECOND connect re-links the same address as node n6, which never
    // reported a size; that record is the one this is about
    const oldEp = cloud.endpoints().find(e => e.node && e.node.id === "n6");
    check("LIVE: ...and a node that never reported one carries null, not a " +
          "borrowed figure — never fabricate a size",
        !!oldEp && oldEp.node && oldEp.node.memBytes === null, oldEp && oldEp.node);

    await new Promise((res) => api.close(res));
}

try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 6 }); } catch { /* held */ }
console.log(`\n${pass}/${pass + fail} node-relay checks passed`);
process.exit(fail ? 1 : 0);

})().catch((e) => {
    console.log("FAIL | the live section threw -", e && e.stack);
    process.exit(1);
});
