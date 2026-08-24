/**
 * PROBE GOVERNOR — the storm, replayed against the fix.
 *
 * Measured from the app's own audit log, before this existed:
 *   2,109 node-ssh-probe events in one day, median gap 5.0 seconds — an
 *   ssh.exe spawned by a dialog poll at an answer that had not changed; and
 *   41 node-door-armed-run / 41 node-door-route-stored events in half an
 *   hour, one press of Finish re-provisioning an already-provisioned machine
 *   every 40 seconds.
 *
 * This suite extracts the REAL governor and watchdog code from app/main.js,
 * replays those two days against a fake clock, and pins the counts. It also
 * proves the other half of the contract: backing off never slows down
 * noticing a road that came BACK — recovery is one poll tick, measured here
 * against a real local listener with real sockets.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 300) : ""); }
}

// the gate must never stall on this suite
setTimeout(() => {
    console.log(`\n${pass}/${pass + fail + 1} node-probe-governor checks passed (TIMED OUT)`);
    process.exit(1);
}, 60000).unref();

const ROOT = path.join(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const cloudSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");
const preloadSrc = fs.readFileSync(path.join(ROOT, "app", "preload.js"), "utf8");

/** Brace-matching extractor (same pattern as ssh-creds.js). */
const grab = (name) => {
    // async declarations must keep their `async` keyword or the extracted
    // body's awaits are a SyntaxError
    const a = mainSrc.indexOf(`async function ${name}(`);
    const i = a >= 0 ? a : mainSrc.indexOf(`function ${name}(`);
    if (i < 0) return null;
    let depth = 0, started = false;
    for (let j = i; j < mainSrc.length; j++) {
        if (mainSrc[j] === "{") { depth++; started = true; }
        else if (mainSrc[j] === "}") { depth--; if (started && depth === 0) return mainSrc.slice(i, j + 1); }
    }
    return null;
};
const grabConst = (name) => (new RegExp(`const ${name} = [^;]+;`).exec(mainSrc) || [null])[0];

/* ------------------------------------------------- the governor, extracted */
const srcGov = ["PROBE_HOLD_MIN_MS", "PROBE_HOLD_MAX_MS"].map(grabConst).join("\n")
    + "\nconst probeGov = new Map();\n"
    + [grab("govFor"), grab("govShouldProbe"), grab("govRecord")].join("\n");
check("governor functions exist in main.js and extract cleanly",
    /govFor/.test(srcGov) && /govShouldProbe/.test(srcGov) && /govRecord/.test(srcGov));

const gov = new Function(srcGov +
    "\nreturn { govFor, govShouldProbe, govRecord, probeGov };")();

// A DAY BEHIND THE KILL SWITCH. EACCES means local software refused the
// socket — ssh through the same filter cannot answer differently, so after
// the one confirming probe on the way in, the day is carried by the port
// probes alone.
{
    const g = gov.govFor("blocked-day");
    let probes = 0;
    for (let t = 0; t < 6480; t++) {                 // 9 h of 5 s ticks
        const now = t * 5000;
        if (gov.govShouldProbe(g, "blocked", now)) {
            probes++;
            gov.govRecord(g, "blocked", "ssh: connect to host 203.0.113.10 port 22: Permission denied", now);
        }
    }
    check("a road refused by local software is probed ONCE, not 2,109 times " +
          "(9 h of 5 s polls behind a kill switch -> 1 ssh spawn)",
        probes === 1, { probes });
}

// A DAY OF SILENCE (machine asleep / blackholed). Backing off is not going
// quiet: the interval doubles to a ceiling and keeps checking all day.
{
    const g = gov.govFor("down-day");
    let probes = 0;
    for (let t = 0; t < 6480; t++) {
        const now = t * 5000;
        if (gov.govShouldProbe(g, "down", now)) {
            probes++;
            gov.govRecord(g, "down", "timed out", now);
        }
    }
    console.log(`  note: simulated silent day = ${probes} ssh probes; the log measured 2,109`);
    check("a silent road backs off to the ceiling instead of every 5 s " +
          "(9 h -> between 20 and 80 probes, was 2,109)",
        probes >= 20 && probes <= 80, { probes });
    check("...but never goes quiet: it still re-checks all day",
        probes >= 20, { probes });
}

// RECOVERY IS ONE POLL TICK. The class change open<-blocked is seen by the
// port probes at poll cadence, and the governor must let the expensive tier
// run on that very tick — no backoff window to ride out, no restart, no click.
{
    const g = gov.govFor("recovery");
    let now = 0;
    gov.govShouldProbe(g, "blocked", now);
    gov.govRecord(g, "blocked", "ssh: connect to host 203.0.113.10 port 22: Permission denied", now);
    for (let t = 1; t < 1000; t++) {                  // 83 min blocked
        now = t * 5000;
        if (gov.govShouldProbe(g, "blocked", now)) {
            gov.govRecord(g, "blocked", "ssh: connect to host 203.0.113.10 port 22: Permission denied", now);
        }
    }
    check("the VPN goes off -> the very next poll tick may probe (no waiting " +
          "out a backoff window)",
        gov.govShouldProbe(g, "open", now + 5000) === true);
    check("an hour of held blocked ticks never re-probed",
        g.probedAt === 0, { probedAt: g.probedAt });
}

// AN OUTCOME CHANGE RESETS THE HOLD; AN IDENTICAL ONE STRETCHES IT.
{
    const g = gov.govFor("reset");
    gov.govRecord(g, "down", "timed out", 0);
    gov.govRecord(g, "down", "timed out", 10000);
    const stretched = g.holdMs;
    gov.govRecord(g, "down", "ssh: connect refused", 20000);
    check("an identical outcome stretches the hold; a changed one resets it",
        stretched > 10000 && g.holdMs === 10000, { stretched, after: g.holdMs });
    const g2 = gov.govFor("ceiling");
    for (let i = 0; i < 20; i++) gov.govRecord(g2, "down", "timed out", i * 1000);
    check("the hold has a sane ceiling (10 minutes), not unbounded growth",
        g2.holdMs === 600000, { holdMs: g2.holdMs });
}

// FLAP DAMPING: a road going quiet respects a floor, so ok<->timeout flapping
// cannot re-create the storm; a road coming back never waits on it.
{
    const g = gov.govFor("flap");
    gov.govRecord(g, "open", "ok", 100000);
    check("open -> down within the floor is held (flap cannot storm)",
        gov.govShouldProbe(g, "down", 101000) === false);
    const g2 = gov.govFor("flap-back");
    gov.govRecord(g2, "down", "timed out", 100000);
    check("down -> open is probed at once regardless of any hold",
        gov.govShouldProbe(g2, "open", 101000) === true);
}

// THE SSH-LAYER SENTINEL: a change visible only on port 22 still moves the
// class — a machine whose sshd dies (or revives) while the model ports stay
// put must not hide behind a held verdict for the whole ceiling.
{
    const g = gov.govFor("sshd-dies");
    gov.govRecord(g, "refused/22-open", "ok", 0);
    check("sshd dying moves the composite class and is probed at once",
        gov.govShouldProbe(g, "refused/22-closed", 1000) === true);
    const g2 = gov.govFor("sshd-back");
    gov.govRecord(g2, "down/22-closed", "timed out", 0);
    check("sshd coming back is probed within the floor, not the ceiling",
        gov.govShouldProbe(g2, "down/22-open", 11000) === true &&
        gov.govShouldProbe(g2, "down/22-open", 1000) === false);
    const g3 = gov.govFor("blocked-composite");
    gov.govRecord(g3, "blocked/22-closed",
        "ssh: connect to host 203.0.113.10 port 22: Permission denied", 0);
    check("the blocked short-circuit still holds on the composite class",
        gov.govShouldProbe(g3, "blocked/22-closed", 50000) === false);
}

/* ------------------------------------ the armed watchdog, replayed 30 min */
{
    const srcArm = ["ARM_RETRY_MIN_MS", "ARM_RETRY_MAX_MS"].map(grabConst).join("\n")
        + "\nconst armGov = new Map();\n"
        + [grab("armDue"), grab("armRecord"), grab("armReset")].join("\n");
    check("arm governor functions exist and extract cleanly",
        /armDue/.test(srcArm) && /armRecord/.test(srcArm) && /armReset/.test(srcArm));

    const srcTick = grab("doorWatchTick");
    check("doorWatchTick extracts cleanly", !!srcTick && srcTick.length > 500);

    const T0 = 1_785_904_812_487;                     // the armedAt the log measured
    let fakeNow = T0;
    const FakeDate = { now: () => fakeNow };
    const state = {
        nodes: [{ id: "n1", name: "field-laptop", host: "203.0.113.10",
                  finishArmed: T0, relayPending: "https://node.example.ts.net",
                  serving: [{ port: 11434 }] }],
        provisionCalls: 0, activationTries: 0, audit: [],
        activationAnswers: false, provisionPublishes: false
    };
    const harness = new Function(
        "Date", "readNodes", "inFlightDoor", "networkAllowed",
        "activatePendingRelay", "tcpOpen", "ARM_TTL_MS", "auditLog",
        "provisionDoor", "paths", "NODES_KEY", "Notification",
        "hostIsPinned", "adoptDue", "adoptRecord", "adoptNodeDoor",
        srcArm + "\n" + srcTick + "\nreturn { doorWatchTick, armReset };");
    const wired = harness(
        FakeDate,
        () => state.nodes,
        new Set(),
        () => true,
        async (id) => {
            state.activationTries++;
            if (!state.activationAnswers) return false;
            const rec = state.nodes.find(x => x.id === id);
            rec.relayUrl = rec.relayPending;           // what the real one does
            delete rec.relayPending;
            delete rec.finishArmed;
            return true;
        },
        async () => true,
        7 * 24 * 60 * 60 * 1000,
        { write: (e) => state.audit.push(e) },
        async () => { state.provisionCalls++;
                      return state.provisionPublishes
                          ? { ok: true, published: true }
                          : { ok: true, published: false }; },
        { writeSettings: () => {} },
        "localNodes",
        { isSupported: () => false },
        () => true,
        () => true, () => {}, async () => false);

    (async () => {
        // phase 1: the measured half hour — armed, provisioned, waiting on the
        // funnel approval. 90 ticks at 20 s.
        for (let t = 0; t < 90; t++) { fakeNow = T0 + t * 20000; await wired.doorWatchTick(); }
        const phase1 = state.provisionCalls;
        console.log(`  note: replayed the measured half hour = ${phase1} provisioning runs; the log measured 41`);
        check("one armed press provisions on a stretching schedule, not every " +
              "40 s (30 min -> at most 8 full runs, was 41)",
            phase1 >= 3 && phase1 <= 8, { phase1 });
        check("every full run is still recorded in the audit log (backoff " +
              "reduces the runs, not the record)",
            state.audit.filter(e => e.kind === "node-door-armed-run").length === phase1);
        check("the cheap activation check still runs on every tick — the " +
              "moment the route answers is never missed",
            state.activationTries === 90, { tries: state.activationTries });

        // phase 2: the operator opens the approval page (armReset), and the
        // funnel comes live: the next full run publishes and the instruction
        // clears.
        state.provisionPublishes = true;
        wired.armReset();
        fakeNow += 20000;
        await wired.doorWatchTick();
        check("opening the approval page lets the armed run retry at once " +
              "instead of riding out its backoff",
            state.provisionCalls === phase1 + 1, { calls: state.provisionCalls });
        check("a published run clears the armed instruction",
            state.nodes[0].finishArmed === undefined);

        // phase 3: provisioned and satisfied — the watchdog does nothing more.
        const after = state.provisionCalls;
        state.nodes[0].relayUrl = "https://node.example.ts.net";
        for (let t = 0; t < 30; t++) { fakeNow += 20000; await wired.doorWatchTick(); }
        check("a machine already set up is not set up again — zero runs after " +
              "success",
            state.provisionCalls === after, { calls: state.provisionCalls });

        // phase 4: a route that answers ends an armed press with ONE request.
        const s2 = state;
        s2.nodes.length = 0;
        s2.nodes.push({ id: "n2", name: "field-laptop", host: "203.0.113.11",
                        finishArmed: fakeNow, relayPending: "https://node2.example.ts.net" });
        s2.activationAnswers = true;
        const beforeCalls = s2.provisionCalls;
        fakeNow += 20000;
        await wired.doorWatchTick();
        check("when the stored route answers, the armed press is satisfied by " +
              "the one HTTPS check — no provisioning at all",
            s2.provisionCalls === beforeCalls && s2.nodes[0].relayUrl
                && s2.nodes[0].finishArmed === undefined);

        await liveRecovery();
    })().catch(e => {
        check("watchdog replay completed", false, String(e && e.stack || e));
        summary();
    });
}

/* -------- recovery against a REAL listener: backing off is not slower ---- */
async function liveRecovery() {
    const srcProbe = grab("probeNodePort");
    // probeNodePort resolves off libuv's thread pool now — a dead ".local"
    // name costs ~20 s of getaddrinfo per lookup and the socket timeout cannot
    // cancel it — so the extracted copy needs that resolver in scope, exactly
    // as main.js has it.
    const cloudModels = require(require("path")
        .join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"));
    const probeNodePort = new Function("require", "cloudModels",
        srcProbe + "\nreturn probeNodePort;")(require, cloudModels);
    const PORT = 18761;

    // road down: nothing listening
    const down = await probeNodePort("127.0.0.1", PORT, 800);
    check("a dead road reports WHY (connection refused carries its code)",
        !down.up && /ECONNREFUSED/.test(String(down.err || "")), down);

    // road comes back mid-poll: the next tick must see it
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    });
    await new Promise(r => server.listen(PORT, "127.0.0.1", r));
    const t0 = Date.now();
    const up = await probeNodePort("127.0.0.1", PORT, 800);
    const ms = Date.now() - t0;
    server.close();
    check("the first poll tick after the road returns sees it up — measured " +
          "with a real socket, so recovery = one poll interval, same as before " +
          "the governor existed",
        up.up === true && ms < 800, { ms, up: up.up });
    console.log(`  note: road-returned detection took ${ms} ms on the first tick`);

    staticPins();
    summary();
}

/* ------------------------------------------------------------ static pins */
function staticPins() {
    check("the 5 s poll consults the governor before any ssh spawn",
        /if \(g\.busy \|\| \(!force && !govShouldProbe\(g, roadCls, Date\.now\(\)\)\)\)/.test(mainSrc));
    check("an in-flight probe blocks a second spawn from an overlapping call " +
          "(the poll does not await its previous pass)",
        /g\.busy = true;/.test(mainSrc) &&
        /finally \{ g\.busy = false; \}/.test(mainSrc));
    check("the road class carries an ssh-layer sentinel (port 22 socket), so " +
          "a dead or revived sshd moves the class instead of hiding behind a " +
          "held verdict for the whole ceiling",
        /tcpOpen\(n\.host, 22, leash\)/.test(mainSrc) &&
        /\+ \(ssh22 \? "\/22-open" : "\/22-closed"\)/.test(mainSrc) &&
        /cls\.startsWith\("blocked"\)/.test(mainSrc));
    check("only an ssh verdict measured THIS tick counts as 'reached' for the " +
          "block diagnosis — a held one cannot clear the sticky verdict",
        /sshFresh = true;/.test(mainSrc) &&
        /\(n\.sshFresh && n\.ssh === "ok"\) \|\| n\.doorOk/.test(mainSrc));
    check("a removed node takes its governor state with it",
        /probeGov\.delete\(id\); adoptGov\.delete\(id\); armGov\.delete\(id\); lastSync\.delete\(id\);/.test(mainSrc));
    check("held counts survive a quit — the pending hold is flushed to the " +
          "audit log so the ledger stays whole across restarts",
        /function flushProbeGov/.test(mainSrc) &&
        /kind: "node-probe-hold-flush"/.test(mainSrc) &&
        /flushProbeGov\(\);[\s\S]{0,80}stopEverything\(\);/.test(mainSrc));
    check("the watchdog re-checks the in-flight guard after its awaits — the " +
          "5 s poll can enter that window",
        /if \(!armDue\(n\) \|\| inFlightDoor\.has\(n\.id\)\) continue;/.test(mainSrc) &&
        /if \(!adoptDue\(n\.id\) \|\| inFlightDoor\.has\(n\.id\)\) continue;/.test(mainSrc));
    check("adoption — the fourth success path — also clears the armed press " +
          "and the stale route markers",
        /delete rec\.finishArmed;[\s\S]{0,200}paths\.writeSettings/.test(
            (/async function adoptNodeDoor[\s\S]*?\n\}/.exec(mainSrc) || [""])[0]));
    check("a held tick serves the last measured verdict instead of spawning",
        /g\.held\+\+;\s*\n\s*ssh = g\.ssh;/.test(mainSrc));
    check("the audit line is written on OUTCOME CHANGE and carries the count " +
          "of identical observations it stands for",
        /if \(changed\) \{[\s\S]{0,700}kind: "node-ssh-probe"[\s\S]{0,300}held: g\.held/.test(mainSrc));
    check("a road blocked by local software is never re-spawned at while the " +
          "block holds",
        /if \(cls\.startsWith\("blocked"\)\) return false/.test(mainSrc));
    check("a manual Refresh bypasses the hold — 'check again NOW' means now",
        /nodes: \(force\) => ipcRenderer\.invoke\("lcl:nodes", !!force\)/.test(preloadSrc) &&
        /window\.lcl\.nodes\(!quiet\)/.test(appSrc));

    check("the monitor reads the SAME door-first map chat uses — one " +
          "mechanism, not a second one beside it",
        /cloudModels\.preferDoor\(epId\)/.test(mainSrc) &&
        /cloudModels\.noteDirectAlive\(epId\)/.test(mainSrc) &&
        /cloudModels\.noteDoorFirst\(epId\)/.test(mainSrc) &&
        !/doorFirst\s*=\s*new Map/.test(mainSrc));
    check("cloudModels exports the shared preference, monitor-writable",
        /function noteDoorFirst\(id\) \{ doorFirst\.set\(id, Date\.now\(\)\); \}/.test(cloudSrc) &&
        /function noteDirectAlive\(id\) \{ doorFirst\.delete\(id\); \}/.test(cloudSrc) &&
        /preferDoor, noteDoorFirst, noteDirectAlive/.test(
            cloudSrc.slice(cloudSrc.indexOf("module.exports"))));
    check("while the relay is the road in use, direct dials get a short leash " +
          "(the DIRECT_PROBE_MS thinking, applied to monitoring) — but a " +
          "manual Refresh gets the FULL leash, so the ratchet always has a key",
        /doorPreferred && !force \? 1200 : 2500/.test(mainSrc));

    check("the row states WHICH road is in use, not just that a relay exists",
        /const route = direct \? "direct" : \(doorServing \|\| doorOk\) \? "relay" : null;/.test(mainSrc) &&
        /via\.className = "node-route " \+ n\.route;/.test(appSrc) &&
        /n\.route === "relay" \? "via remote access" : "direct"/.test(appSrc));
    check("the route readout is styled in the existing token system",
        /\.node-route \{[\s\S]{0,300}var\(--fs-micro\)/.test(cssSrc) &&
        /\.node-route\.direct\s+\{/.test(cssSrc) && /\.node-route\.relay\s+\{/.test(cssSrc) &&
        /\.node-state-lead \{/.test(cssSrc));
    check("a route change repaints the quiet poll (route and via are in the " +
          "repaint signature)",
        /\[x\.port, x\.via \|\| null\]/.test(appSrc) &&
        /n\.doorOk, n\.route \|\| null\]/.test(appSrc));

    check("the armed watchdog gates full provisioning behind the schedule",
        /if \(!armDue\(n\) \|\| inFlightDoor\.has\(n\.id\)\) continue;/.test(mainSrc) &&
        /armRecord\(n\);/.test(mainSrc));
    check("opening the funnel-approval page resets the armed backoff",
        /kind: "opened-funnel-gate"[\s\S]{0,300}armReset\(\);/.test(mainSrc));
    check("an identical route is not stored (or logged) again",
        /rec\.relayPending === `https:\/\/\$\{selfName\.toLowerCase\(\)\}`/.test(mainSrc) &&
        /doorTokenOf\(n\) === tok/.test(mainSrc));
    check("a re-observed funnel gate is only news when it changes",
        /rec\.funnelEnableUrl !== gate/.test(mainSrc));
    check("pressing Finish tries the one-request activation before any " +
          "provisioning",
        mainSrc.indexOf("n.relayPending && await activatePendingRelay(id)") <
            mainSrc.indexOf("rec.finishArmed = Date.now()") &&
        /n\.relayPending && await activatePendingRelay\(id\)/.test(mainSrc));
    check("resolving a host's effective name is cached against the ssh_config " +
          "mtime — not one silent ssh -G spawn per 5 s tick",
        /const effHostCache = new Map\(\)/.test(mainSrc) &&
        /c\.cfgM === cfgM && Date\.now\(\) - c\.at < EFF_HOST_TTL_MS/.test(mainSrc));
    check("adoption failures back off too (per node, doubling, ceilinged)",
        /function adoptDue\(id/.test(mainSrc) && /function adoptRecord\(id, ok/.test(mainSrc) &&
        /if \(!adoptDue\(n\.id\) \|\| inFlightDoor\.has\(n\.id\)\) continue;/.test(mainSrc) &&
        /\(force \|\| adoptDue\(n\.id\)\)/.test(mainSrc));
}

// THE ROOT: a start-time server has no request-triggered load to guard.
// llama.cpp/vLLM (shape openai) load one model at boot; the guard is for
// Ollama on-demand only. This is the regression the operator hit — newer
// llama.cpp answers /api/tags, which USED to be Ollama-only, so the guard
// misread it and refused a 120B it was actively serving.
{
    const src = require("fs").readFileSync(
        require("path").join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"), "utf8");
    check("nodePreflight returns immediately for a non-Ollama (start-time) node — "
        + "a llama.cpp/vLLM chat request triggers no load, so there is nothing to guard",
        src.includes("if (!isOllamaShape(s)) return null;"));
}

function summary() {
    console.log(`\n${pass}/${pass + fail} node-probe-governor checks passed`);
    process.exit(fail ? 1 : 0);
}
