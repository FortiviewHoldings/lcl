/**
 * WHAT IS ON THE END OF THAT CABLE.
 *
 * "I want to connect one of my devices — a microcontroller, an ESP32, a
 *  Raspberry Pi, whatever it is — plug it in, tell the app it is connected, and
 *  have it see the device and read the device logic, then give me a detailed
 *  response that makes me comfortable."
 *
 * The properties that make that trustworthy rather than merely impressive:
 *   - it READS and only reads; there is no path from here to a changed board
 *   - it says when it cannot identify something, WITH the numbers
 *   - it says when the PROBE ITSELF failed, instead of printing an empty bench
 *   - it is honest that firmware was not read, because it was not
 *   - it needs no network
 *   - it extends the serial readout that already existed instead of starting
 *     a second inventory beside it
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// The engine's prompt builder reaches for electron; stand in for it so the
// no-folder system prompt can be BUILT here rather than grepped for. Must run
// before agent.js is required.
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return origResolve.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

const ROOT = path.join(__dirname, "..");
const R = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const devSrc = R(".lcl.engine", "core", "deviceScan.js");
const clsSrc = R(".lcl.engine", "policy", "classify.js");
const agentSrc = R(".lcl.engine", "core", "agent.js");
const mainSrc = R("app", "main.js");
const preSrc = R("app", "preload.js");
const appSrc = R("app", "renderer", "app.js");
const cssSrc = R("app", "renderer", "styles.css");

// The module WITHOUT its commentary, for checks about what the code does. The
// comments quote the defects they replaced verbatim, which is worth keeping and
// would otherwise satisfy a search for the defect itself.
const devCode = devSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const deviceScan = require(path.join(ROOT, ".lcl.engine", "core", "deviceScan.js"));
const agent = require(path.join(ROOT, ".lcl.engine", "core", "agent.js"));

/** The real serial ports Windows will name, straight from the OS. */
function realPortNames() {
    return new Promise((resolve) => {
        let out = "";
        let child;
        try {
            child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
                "[System.IO.Ports.SerialPort]::GetPortNames() | ConvertTo-Json -Compress"],
                { windowsHide: true });
        } catch { return resolve([]); }
        child.stdout.on("data", d => out += d);
        child.on("error", () => resolve([]));
        child.on("close", () => {
            try {
                const j = JSON.parse(out.trim() || "[]");
                resolve((Array.isArray(j) ? j : [j]).map(String));
            } catch { resolve([]); }
        });
    });
}

/* =====================================================================
 * 1. READ-ONLY IS STRUCTURAL, NOT A PROMISE
 * =================================================================== */

check("THERE IS NO WRITE PATH AT ALL. Not 'it does not write' — it CANNOT: no " +
      "Write, no WriteLine, no flash, no reset, no reboot anywhere in the module",
    !/\.Write\b|WriteLine|\bflash\b|Reset\(|reboot/i.test(
        devSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));

check("...and it never asserts a handshake line. DTR and RTS are how an ESP32 " +
      "is dropped into its bootloader — toggling them mid-run resets somebody's " +
      "board, so both are explicitly held low and never set true",
    /DtrEnable = \$false/.test(devSrc) && /RtsEnable = \$false/.test(devSrc) &&
    !/DtrEnable = \$true|RtsEnable = \$true/.test(devSrc));

check("...and a port another program already holds is LEFT ALONE, reported, " +
      "not prised open — no second attempt, no force, no exclusivity override",
    /is open in another program/.test(devSrc) &&
    !/ExclusiveAccess|\$p\.Open\(\)[\s\S]{0,80}\$p\.Open\(\)/.test(devSrc));

check("the tool is classified READ — a tool absent from that table is denied " +
      "by the kernel, so the failure mode of forgetting is 'it does not work'",
    /inspect_devices: \{ capability: "sys\.read", classification: CLASSIFICATION\.READ/.test(clsSrc));

/* =====================================================================
 * 2. IT SAYS WHEN IT DOES NOT KNOW
 * =================================================================== */

check("an unrecognised device is reported as unidentified WITH ITS NUMBERS, so " +
      "it can be looked up — never guessed at from a coincidence",
    /identified: !!known/.test(devSrc) &&
    /not in the identification table — vendor \$\{vid\}, product \$\{pid\}/.test(devSrc));

check("a USB-serial BRIDGE is named as a bridge, because an FT232 says nothing " +
      "about the board behind it and claiming otherwise is the guess this " +
      "module exists to refuse",
    /kind: "bridge"/.test(devSrc) &&
    /USB-serial bridge/.test(devSrc));

check("silence on a port is reported as silence, with the reason it might be " +
      "silent — a passive listen never asked the board to say anything",
    /nothing arrived in \$\{heldMs\} ms at \$\{baud\} baud/.test(devSrc) &&
    /passive listen/.test(devSrc));

/* =====================================================================
 * 3. IT IS HONEST ABOUT WHAT "READ THE LOGIC" MEANS
 * =================================================================== */

check("FIRMWARE IS NOT CLAIMED. Pulling a program off a running board needs a " +
      "bootloader reset or a debug probe — both change the device — so the " +
      "answer states plainly that it was not read and why",
    /Firmware was NOT read/.test(devSrc) &&
    /requires resetting it into a bootloader or/.test(devSrc));

check("...and what WAS read is stated beside it, so the two are never blurred",
    /readingsTaken/.test(devSrc) && /USB identifiers from the OS device tree/.test(devSrc));

check("the operator sees that distinction in the panel, not only in the tool",
    /res\.notRead/.test(appSrc));

/* =====================================================================
 * 4. IT EXTENDS WHAT EXISTED
 * =================================================================== */

check("it extends the serial readout already in Connections rather than " +
      "starting a second inventory beside it",
    appSrc.indexOf("listComPorts") > 0 &&
    appSrc.indexOf("inspectDevices") > appSrc.indexOf("listComPorts"));

check("scanning is an explicit action, not a poll — a bench is not something " +
      "to probe every few seconds while a board is mid-flash",
    /Scan for devices/.test(appSrc) && !/setInterval\([^)]*inspectDevices/.test(appSrc));

check("nothing found is deleted to tidy the list: the uninteresting devices are " +
      "kept behind one line and can be shown",
    /likelyBoard/.test(devSrc) && /other USB device/.test(appSrc));

check("it is wired end to end — engine module, IPC, preload, renderer",
    /lcl:inspectDevices/.test(mainSrc) && /inspectDevices:/.test(preSrc) &&
    /window\.lcl\.inspectDevices/.test(appSrc) &&
    /deviceScan\.inspect/.test(mainSrc));

/* SCOPING A READ TO ONE PORT IS WIRED ALL THE WAY TO A CONTROL.
 *
 * A serial port is exclusive on Windows: while this app holds one, another
 * program's attempt on it fails. An unscoped scan opens every ported device in
 * turn, so a bench of four boards at the ceiling is roughly twenty-four seconds
 * of sharing violations for anything else reconnecting. The engine took a port
 * option and the IPC boundary validated it — and for a while nothing could
 * send one, which is a capability that exists only in the tests. */
check("A NAMED PORT REACHES THE ENGINE FROM A CONTROL THE OPERATOR CAN CLICK — " +
      "engine option, validated at the IPC boundary, and a per-row button that " +
      "actually sends it",
    /port\b/.test(devSrc) && /\^COM\\d\+\$/i.test(mainSrc) &&
    /inspectDevices\(\s*\n?\s*\{ listenMs: 4000, port: d\.port \}\)/.test(appSrc) &&
    /Listen to " \+ d\.port \+ " only/.test(appSrc));

check("...and the scoped read is styled in the existing token system rather " +
      "than with invented values",
    /\.dev-listen \{/.test(cssSrc) &&
    /var\(--sp-1\)/.test(cssSrc.slice(cssSrc.indexOf(".dev-listen {"),
                                     cssSrc.indexOf(".dev-listen {") + 240)) &&
    !/#[0-9a-f]{3,6}/i.test(cssSrc.slice(cssSrc.indexOf(".dev-listen {"),
                                         cssSrc.indexOf(".dev-listen {") + 240)));

check("the tool is offered to the model, with help text that says it is read-only",
    /tools\.inspect_devices = deviceScan\.TOOL_ENTRY/.test(agentSrc) &&
    /never writes to, resets or/.test(devSrc));

check("styled in the existing token system, not with invented values",
    /\.dev-row \{/.test(cssSrc) &&
    /var\(--radius-sm\)/.test(cssSrc.slice(cssSrc.indexOf(".dev-row {"),
                                           cssSrc.indexOf(".dev-row {") + 400)) &&
    /var\(--card-surface/.test(cssSrc.slice(cssSrc.indexOf(".dev-row {"),
                                            cssSrc.indexOf(".dev-row {") + 400)));

/* =====================================================================
 * 5. NO NETWORK, AND NOTHING OF HIS IN IT
 * =================================================================== */

check("NO NETWORK IS REQUIRED OR USED. A board on a bench with no internet is " +
      "the normal case for someone who builds hardware",
    !/https?:|fetch\(|require\("(net|http|https)"\)/.test(devSrc));

check("the identification table names SILICON, never a product of the " +
      "operator's — every entry is a public USB ID",
    !(()=>{try{return require("./no-bleed.js").BLEED}catch{return[]}})().some(rx => rx.test(devSrc)));

/* =====================================================================
 * 6. A FAILED PROBE IS NOT AN EMPTY BENCH
 *
 * The worst failure this module had: the shell missing, blocked by an
 * application-control policy, or stripped from PATH produced "" — which became
 * zero rows, an empty device list, ok: true, and the panel printing
 * "Nothing on USB." on a machine with thirteen devices attached. No error
 * surfaced anywhere on that path.
 * =================================================================== */

check("the probe reports WHAT HAPPENED, not just what it printed — stderr is " +
      "captured and the exit status is kept, because a shell can write a hard " +
      "error and still exit zero",
    /child\.stderr\.on\("data"/.test(devSrc) &&
    /ran: false/.test(devSrc) && /timedOut/.test(devSrc) &&
    /code: typeof code === "number"/.test(devSrc));

check("the query is scoped BY DEVICE CLASS, not by instance path — the " +
      "'USB*' prefilter dropped every serial port a non-USB enumerator owns",
    !/PNPDeviceID -like 'USB\*'/.test(devCode) &&
    /PNPClass -in @\('Ports','USB','MEDIA','HIDClass'\)/.test(devCode));

check("the offered tool can be scoped to ONE port, and says so in its help — an " +
      "unscoped call takes an exclusive open on every port it finds",
    /inspect_devices \{port\?, listen_ms\?, baud\?\}/.test(devSrc) &&
    /args\.port/.test(devSrc));

/* THE RATE IS THE CALLER'S TO CHOOSE, AND SILENCE HAS TO MEAN SILENCE.
 *
 * listen() has taken a `baud` argument since it was written and the TOOL never
 * passed one, so every read on every port was 115200. A board at any other rate
 * read as an empty bench. From a live session, the model saying so exactly:
 * "The serial listener only works at 115200 baud. I've tried that on COM10
 * three times now and received nothing." It was right, and it had no door. */
check("A RATE CAN BE ASKED FOR, and the tool says so — the model could see the " +
      "115200 wall and had no way through it",
    /baud sets the rate/.test(devSrc) && /args\.baud/.test(devSrc));

check("...and with NO rate named it walks a ladder, so \"nothing arrived\" means " +
      "the board is silent rather than that one guess was wrong",
    Array.isArray(deviceScan.BAUD_LADDER) && deviceScan.BAUD_LADDER.length >= 4 &&
    deviceScan.BAUD_LADDER[0] === 115200,
    deviceScan.BAUD_LADDER);

/* CAUGHT BY MUTATION, NOT BY READING: with the ladder built and the help
 * text updated, deleting `baud: rate` from the listen call left all checks
 * passing — the tool would advertise a rate, compute a rate, and then open
 * every port at 115200 exactly as before. A ladder whose value is dropped one
 * line later is the same silence with more steps. */
/* AND THE LADDER IS FOR ONE PORT, NEVER FOR ALL OF THEM.
 *
 * "it has the write command, but it is oblivious and can no longer detect
 *  anything connected to the machine as hardware"
 *
 * Measured: adding the ladder took an unscoped scan from ~3s to 20.3s, because
 * six rates times every serial port is six times the work for a question nobody
 * asked. The scan still WORKED — 22 devices, COM10 identified — it just took so
 * long the call came back with nothing. A read-only tool made useless by making
 * it thorough. Scoped to a port the ladder is exactly right; unscoped it is a
 * timeout wearing a feature-s clothes. */
check("AN UNSCOPED SCAN USES ONE RATE — walking six on every port is how a " +
      "working scan became a timeout and the model saw no hardware at all",
    devSrc.includes("(scoped ? BAUD_LADDER : [BAUD_LADDER[0]])"));

check("THE RATE ACTUALLY REACHES THE PORT — the whole defect was that listen() " +
      "has always taken a baud and the caller never passed one",
    // a LITERAL substring, not a regex: this exact assertion was first written
    // as a pattern whose backslashes were eaten on the way to disk, leaving
    // `{ ms: listenMs, baud: rate }` as a character class that matched nothing
    devSrc.includes("listen(d.port, { ms: listenMs, baud: rate })"));

check("...and 74880 is ON that ladder — it is the rate an ESP32 prints its boot " +
      "ROM at, which is exactly what someone staring at a silent ESP32-S3 needs " +
      "to see",
    (deviceScan.BAUD_LADDER || []).includes(74880), deviceScan.BAUD_LADDER);

check("...and the ladder STOPS on the first rate that yields bytes — each open " +
      "can reset a board, so re-opening a port that already answered is a side " +
      "effect with nothing to gain",
    /if \(\(heard && heard\.ok && heard\.chars > 0\)/.test(devSrc));

check("the listen window is normalised ONCE, so the shell window, the timeout, " +
      "the reported duration and the silence note are all the same number",
    deviceScan.listenWindowMs(0) === deviceScan.WINDOW_MIN_MS &&
    deviceScan.listenWindowMs(99999) === deviceScan.WINDOW_MAX_MS &&
    deviceScan.listenWindowMs(2500) === 2500 &&
    /listenedMs: heldMs/.test(devSrc),
    [deviceScan.listenWindowMs(0), deviceScan.listenWindowMs(99999)]);

check("a truncated read SAYS it was truncated, and the count describes what was " +
      "actually handed back — with the full figure kept beside it",
    (() => {
        const r = deviceScan.readResult("COM4", 115200, 2000, "X".repeat(8192) + "\r\n");
        return r.chars === deviceScan.MAX_CHARS && r.text.length === r.chars &&
               r.charsReceived === 8192 && r.truncated === true &&
               /Cut at 4000 characters: 8192 arrived/.test(r.note || "");
    })(),
    deviceScan.readResult("COM4", 115200, 2000, "X".repeat(8192)).note);

check("...and an untruncated read carries the same fields without the flag, so " +
      "a caller never has to guess whether anything was cut",
    (() => {
        const r = deviceScan.readResult("COM4", 115200, 2000, "banner v1.2\r\n");
        return r.chars === 11 && r.charsReceived === 11 && r.truncated === false &&
               r.note === null && r.text === "banner v1.2";
    })(),
    deviceScan.readResult("COM4", 115200, 2000, "banner v1.2\r\n"));

check("...and the flag is mirrored one level up, so serialRead carries it too",
    /truncated: heard\.truncated/.test(devSrc));

check("A PORT THAT DOES NOT EXIST IS NOT 'OPEN IN ANOTHER PROGRAM'. Only the " +
      "access-denied shape means another process holds the line; every other " +
      "failure comes back with the reason Windows actually gave",
    (() => {
        // both strings measured from a real open on this machine: one against a
        // port held by a second process, one against a port that is not there
        const busy = deviceScan.openFailureFrom("COM7",
            "__LCL_OPENFAIL__|System.UnauthorizedAccessException|Access to the port 'COM7' is denied.");
        const gone = deviceScan.openFailureFrom("COM99",
            "__LCL_OPENFAIL__|System.IO.IOException|The port 'COM99' does not exist.");
        return busy.busy === true &&
               /is open in another program/.test(busy.error) &&
               gone.busy === false &&
               !/open in another program|nothing was interrupted/.test(gone.error) &&
               /The port 'COM99' does not exist\./.test(gone.error);
    })(),
    deviceScan.openFailureFrom("COM99",
        "__LCL_OPENFAIL__|System.IO.IOException|The port 'COM99' does not exist."));

check("...and the open failure carries the real exception, because the port " +
      "object is now built INSIDE the try — a locked-down shell that cannot " +
      "construct it was blamed on a port nothing had touched",
    /^\s*"try \{ "/m.test(devSrc) &&
    /New-Object System\.IO\.Ports\.SerialPort/.test(devSrc) &&
    devSrc.indexOf('"try { "') < devSrc.indexOf("New-Object System.IO.Ports.SerialPort") &&
    /GetType\(\)\.FullName/.test(devSrc));

check("inspect_devices is advertised in a session with NO LINKED FOLDER — the " +
      "default state. A real prompt is built here, not grepped for: the tool " +
      "was registered unconditionally and mentioned nowhere, so 'what is on my " +
      "USB port?' was answered in prose",
    (() => {
        const tools = agent.effectiveTools({ workspace: false });
        const sys = agent.systemPrompt(null, tools);
        return typeof sys === "string" && sys.includes("inspect_devices");
    })(),
    agent.systemPrompt(null, agent.effectiveTools({ workspace: false })).length);

/* =====================================================================
 * 7. IT ACTUALLY RUNS
 * =================================================================== */

(async () => {
    const t0 = Date.now();
    let out = null, threw = null;
    try { out = await deviceScan.inspect({ listenMs: 0 }); }
    catch (e) { threw = e; }
    check("inspect() runs on this machine and returns a shaped answer",
        !threw && out && Array.isArray(out.devices), threw ? String(threw.message) : null);
    if (out) {
        check("...with every device carrying its identifiers and an honest " +
              "identified flag",
            out.devices.every(d => typeof d.identified === "boolean" &&
                                   (d.vid === null || /^[0-9a-f]{4}$/.test(d.vid)) &&
                                   (d.pid === null || /^[0-9a-f]{4}$/.test(d.pid))),
            out.devices.slice(0, 2));
        check("...and an unidentified one carries the note that says to look it up",
            out.devices.filter(d => !d.identified && d.vid)
                       .every(d => /vendor .*product/.test(d.note || "")),
            out.devices.filter(d => !d.identified && d.vid).slice(0, 1));
        check("...and it answers in a few seconds, not minutes",
            Date.now() - t0 < 40000, Date.now() - t0);
        // FINDING 24, live: this call asks for 0 ms and the shell floors it at
        // WINDOW_MIN_MS, so a port really is held for half a second. Echoing the
        // raw argument back under-reported an EXCLUSIVE open, and printed
        // "nothing arrived in 0 ms" — a duration that cannot happen.
        const held = out.devices.filter(d => d.serialRead &&
                                             typeof d.serialRead.chars === "number");
        check("...and a port it did open reports the window it ACTUALLY held, " +
              "never the raw argument — this call asked for 0 ms",
            /const heldMs = listenWindowMs\(ms\);/.test(devCode) &&
            held.every(d => d.serialRead.listenedMs === deviceScan.listenWindowMs(0) &&
                            typeof d.serialRead.truncated === "boolean" &&
                            (!d.serialRead.note ||
                             d.serialRead.note.includes(`${d.serialRead.listenedMs} ms`))),
            held.map(d => ({ port: d.port, listenedMs: d.serialRead.listenedMs,
                             note: (d.serialRead.note || "").slice(0, 60) })));
    }

    // FINDING 23, live: the two readouts sat in the same modal disagreeing —
    // "Serial ports: COM6, COM7" three lines above "13 devices, none with a port".
    const names = await realPortNames();
    const live = await deviceScan.scan();
    check("EVERY SERIAL PORT WINDOWS NAMES APPEARS AS SOME DEVICE'S PORT. The " +
          "port list and the device list are the same machine and must not " +
          "disagree in the same window",
        Array.isArray(live.devices) &&
        names.every(n => live.devices.some(d => (d.port || "").toUpperCase() === n.toUpperCase())),
        { osPorts: names, scanPorts: live.devices.filter(d => d.port).map(d => d.port) });

    // FINDING 42a: this check used to read `typeof deviceScan.scan === "function"`,
    // which no amount of breakage could fail. It asserts the LIVE result now.
    check("...proven against this machine's real device tree, not a fixture: a " +
          "non-empty list whose USB entries carry well-formed four-hex numbers",
        live.scanError === null && Array.isArray(live.devices) && live.devices.length > 0 &&
        live.devices.some(d => /^[0-9a-f]{4}$/.test(d.vid || "") &&
                               /^[0-9a-f]{4}$/.test(d.pid || "")) &&
        live.devices.every(d => (d.vid === null && d.port) ||
                                (/^[0-9a-f]{4}$/.test(d.vid || "") &&
                                 /^[0-9a-f]{4}$/.test(d.pid || ""))),
        { count: live.devices.length, scanError: live.scanError,
          sample: live.devices.slice(0, 2) });

    check("a bad port name is refused rather than handed to the shell",
        (await deviceScan.listen("COM1; Remove-Item C:\\")).ok === false);

    // FINDING 9, live: this exact call used to answer "COM99 is open in another
    // program — nothing was read, and nothing was interrupted".
    const ghost = await deviceScan.listen("COM99", { ms: 0 });
    check("a port that does not exist is reported as not existing — not as busy, " +
          "and with no claim about a process holding it or an interruption that " +
          "never happened",
        ghost.ok === false && ghost.busy !== true &&
        !/open in another program|nothing was interrupted/.test(ghost.error || "") &&
        /does not exist/i.test(ghost.error || ""),
        ghost);

    // FINDING 25, live: one call used to take an exclusive open on every port it
    // found, with nothing able to scope it.
    const scoped = await deviceScan.inspect({ listenMs: 0, port: "COM_NONE" });
    check("inspect() can be scoped to one port, and a name that is not a port " +
          "opens NOTHING — every other port on the bench is left alone",
        Array.isArray(scoped.listenedPorts) && scoped.listenedPorts.length === 0 &&
        scoped.devices.every(d => !d.serialRead) &&
        /no port was opened/i.test(scoped.listenScope || ""),
        { listened: scoped.listenedPorts, scope: scoped.listenScope });

    // FINDING 1, live: the whole point. Stub the probe to a name that is not on
    // PATH — the same shape as the shell being absent, blocked by application
    // control, or stripped from the environment.
    const realExe = deviceScan.PROBE_SHELL.exe;
    let blind = null, deaf = null;
    try {
        deviceScan.PROBE_SHELL.exe = "powershell_absent_for_this_check.exe";
        blind = await deviceScan.inspect({ listenMs: 0 });
        deaf = await deviceScan.listen("COM1", { ms: 0 });
    } finally {
        deviceScan.PROBE_SHELL.exe = realExe;
    }
    check("A PROBE THAT COULD NOT RUN IS AN ERROR, NOT AN EMPTY BENCH. With the " +
          "shell unreachable, inspect() surfaces scanError instead of quietly " +
          "reporting nothing attached",
        blind && Array.isArray(blind.devices) && blind.devices.length === 0 &&
        typeof blind.scanError === "string" && blind.scanError.length > 20,
        blind && { devices: blind.devices.length, scanError: blind.scanError });

    check("...and readingsTaken does NOT claim the device tree was read when it " +
          "was not — the sentence beside the empty list is the one thing that " +
          "makes the empty list readable",
        blind && !/USB identifiers from the OS device tree/.test(blind.readingsTaken || "") &&
        /Nothing was read/.test(blind.readingsTaken || ""),
        blind && blind.readingsTaken);

    check("...and a listen on a dead probe reports the failed probe, not silence " +
          "on the line",
        deaf && deaf.ok === false && deaf.probeFailed === true &&
        /did not run/.test(deaf.error || ""),
        deaf);

    check("...and the very next real call works, so nothing was left broken",
        (await deviceScan.scan()).scanError === null);

    console.log(`\n${pass}/${pass + fail} device-recognition checks passed`);
    process.exit(fail ? 1 : 0);
})();
