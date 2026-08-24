"use strict";
/**
 * WHAT IS ON THE END OF THAT CABLE.
 *
 * "I want to connect one of my devices — a microcontroller, an ESP32, a
 *  Raspberry Pi, whatever it is — plug it in, tell the app it is connected, and
 *  have it see the device and read the device logic, then give me a detailed
 *  response that makes me comfortable."
 *
 * Someone who builds hardware should not have to describe their own board to
 * the machine it is plugged into. Windows already knows the USB vendor and
 * product identifiers of everything attached; this reads them, names what it
 * can from those numbers, and — where a read is safe and standard — asks the
 * board itself.
 *
 * THREE RULES THIS MODULE IS BUILT AROUND.
 *
 * 1. READING IS THE DEFAULT AND THE LIMIT. Nothing here writes, flashes,
 *    resets or reboots anything. There is no code path that can: no write, no
 *    DTR/RTS toggling (which is how an ESP32 is put into bootloader mode), no
 *    baud change on a port someone else opened. A board that is mid-run stays
 *    mid-run. Anything that changes a device is a separate, deliberate,
 *    confirmed action and it is not in this file.
 *
 * 2. IT SAYS WHEN IT DOES NOT KNOW. A VID/PID pair that is not in the table
 *    below comes back as unidentified WITH ITS NUMBERS, so the operator can
 *    look it up. It never guesses a family from a coincidence, and it never
 *    describes a chip generically to look knowledgeable — an answer that could
 *    have been written without the board attached is worth nothing to someone
 *    who builds hardware.
 *
 * 3. IT NEVER NEEDS THE NETWORK. Identification is a local table and the OS's
 *    own device tree. A board on a bench with no internet is the normal case.
 *
 * WHAT "READ THE DEVICE LOGIC" HONESTLY MEANS. There is no universal way to
 * read a program off a running board — that is a per-chip, per-bootloader,
 * often write-triggered operation (esptool resets into the ROM loader; a JTAG
 * dump needs a probe). What IS safe and standard is: what the OS reports about
 * the device, and what the device says about itself on its own serial line if
 * it is already talking. Both are done here. The distinction is reported to
 * the operator rather than blurred, because "I read your firmware" would be a
 * lie and this product does not tell those.
 */

const { spawn } = require("child_process");

/* ------------------------------------------------------------------ table --
 * USB vendor/product identifiers, from the public USB ID repository and the
 * vendors' own published numbers. Deliberately generic: it names silicon, not
 * anybody's product.
 */
const VENDORS = {
    "0403": "FTDI",
    "10c4": "Silicon Labs",
    "1a86": "QinHeng (CH340/CH9102)",
    "2341": "Arduino",
    "2a03": "Arduino (org)",
    "303a": "Espressif",
    "2e8a": "Raspberry Pi",
    "1366": "SEGGER",
    "0483": "STMicroelectronics",
    "1d50": "OpenMoko (community)",
    "239a": "Adafruit",
    "16c0": "Van Ooijen (Teensy)",
    "04d8": "Microchip",
    "0d28": "ARM mbed",
    "1fc9": "NXP",
    "0451": "Texas Instruments",
    "1b4f": "SparkFun"
};

/**
 * Specific pairs worth naming exactly. A USB-serial BRIDGE is called what it
 * is — an FT232 says nothing about the board behind it, and pretending
 * otherwise is the guess this module refuses to make.
 */
const PRODUCTS = {
    "303a:1001": { family: "Espressif ESP32-S2/S3 (native USB)", kind: "mcu" },
    "303a:0002": { family: "Espressif ESP32-S2", kind: "mcu" },
    "303a:1000": { family: "Espressif USB JTAG/serial debug unit", kind: "debug" },
    "2e8a:0003": { family: "Raspberry Pi RP2040 (BOOTSEL mass storage)", kind: "mcu-bootloader" },
    "2e8a:000a": { family: "Raspberry Pi RP2040 (CDC serial)", kind: "mcu" },
    "2e8a:0005": { family: "Raspberry Pi Pico (MicroPython CDC)", kind: "mcu" },
    "1a86:7523": { family: "CH340 USB-serial bridge", kind: "bridge" },
    "1a86:55d4": { family: "CH9102 USB-serial bridge", kind: "bridge" },
    "10c4:ea60": { family: "CP2102 USB-serial bridge", kind: "bridge" },
    "0403:6001": { family: "FT232R USB-serial bridge", kind: "bridge" },
    "0403:6014": { family: "FT232H USB-serial/FIFO bridge", kind: "bridge" },
    "2341:0043": { family: "Arduino Uno R3", kind: "mcu" },
    "2341:0042": { family: "Arduino Mega 2560", kind: "mcu" },
    "239a:80f4": { family: "Adafruit CircuitPython board (CDC)", kind: "mcu" },
    "16c0:0483": { family: "Teensy (serial)", kind: "mcu" },
    "0d28:0204": { family: "ARM mbed / DAPLink debug probe", kind: "debug" },
    "1366:0105": { family: "SEGGER J-Link debug probe", kind: "debug" },
    "0483:374b": { family: "ST-LINK/V2-1 debug probe", kind: "debug" }
};

/**
 * Windows quotes VID/PID inside the device instance path.
 *
 * Two separators, because two enumerators write it differently: a USB device
 * reads USB\VID_303A&PID_1001\..., while an FTDI bridge on the D2XX driver
 * reads FTDIBUS\VID_0403+PID_6001+A50285BI\0000. The "+" alternative only ever
 * fires on the NON-USB enumerators, which is why the query below must not
 * pre-filter the device tree down to instance paths beginning "USB".
 */
const ID_RE = /VID_([0-9A-Fa-f]{4})[&+]PID_([0-9A-Fa-f]{4})/;

/** A serial port as Windows spells it inside a device's friendly name. */
const PORT_IN_NAME_RE = /\((COM\d+)\)/;

/** How much of a talking board's output is carried back. Characters, not bytes. */
const MAX_CHARS = 4000;

/**
 * The passive-listen window, in milliseconds, as the shell can actually honour
 * it. Below the floor the port is opened and closed faster than a driver hands
 * over its first buffer; above the ceiling one silent port stalls a whole scan.
 */
const WINDOW_MIN_MS = 500;
const WINDOW_MAX_MS = 8000;

/**
 * The window a listen will ACTUALLY hold, from the window it was asked for.
 *
 * One function, called once, because the numbers used to disagree: the shell
 * was given the clamped figure while the reported duration and the silence note
 * echoed the raw argument, so a 0 ms request held the port for half a second
 * and then printed "nothing arrived in 0 ms" — an impossible sentence, and an
 * under-report of how long an exclusive open was held.
 */
function listenWindowMs(ms) {
    return Math.min(WINDOW_MAX_MS, Math.max(WINDOW_MIN_MS, Math.round(Number(ms) || 0)));
}

/** The line the shell prints when the port could not be opened at all. */
const OPEN_FAIL = "__LCL_OPENFAIL__";

/**
 * WHICH SHELL THE PROBE RUNS. Held in an object rather than inlined so the
 * suite can point it at a name that is not on PATH and prove what happens when
 * the probe cannot run — the failure this module used to report as an empty
 * bench. It is not a setting: nothing in the product writes to it.
 */
const PROBE_SHELL = { exe: "powershell.exe" };

/**
 * Run a shell probe and report WHAT HAPPENED, not just what it printed.
 *
 * The earlier version resolved a bare string, so every failure — the shell
 * missing from PATH, an execution policy or application-control rule blocking
 * it, a timeout, an error written to stderr — arrived as "" and was
 * indistinguishable from a genuinely empty answer. That is how a machine with
 * thirteen USB devices reported "Nothing on USB." with ok: true.
 *
 * Resolves { out, err, code, ran, timedOut }:
 *   ran       the child process actually started
 *   code      its exit status, or null if it was killed or never started
 *   err       everything it wrote to stderr (an error there can accompany a
 *             zero exit status, so the code alone is not enough)
 *   timedOut  the window elapsed and the child was killed
 */
function ps(command, timeoutMs = 9000) {
    return new Promise((resolve) => {
        let out = "", err = "", done = false, timedOut = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        let child;
        try {
            child = spawn(PROBE_SHELL.exe,
                ["-NoProfile", "-NonInteractive", "-Command", command],
                { windowsHide: true });
        } catch (e) {
            return finish({ out: "", err: String((e && e.message) || e),
                            code: null, ran: false, timedOut: false });
        }
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill(); } catch {}
            finish({ out, err, code: null, ran: true, timedOut: true });
        }, timeoutMs);
        child.stdout.on("data", d => { out += d; });
        child.stderr.on("data", d => { err += d; });
        child.on("error", (e) => {
            clearTimeout(timer);
            finish({ out: "", err: String((e && e.message) || e),
                     code: null, ran: false, timedOut: false });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            finish({ out, err, code: typeof code === "number" ? code : null,
                     ran: true, timedOut });
        });
    });
}

/** The first line of whatever the shell complained about, for a one-line report. */
function firstLine(s) {
    return String(s || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] || "";
}

/**
 * Every USB serial/COM device Windows can see, with its identifiers.
 *
 * Win32_PnPEntity is read-only by construction — it is the OS's own device
 * inventory. Nothing is opened, claimed or configured.
 *
 * Resolves { devices, scanError, scanNote }. scanError is a plain sentence when
 * the OS PROBE ITSELF failed and is null when it worked; an empty list with no
 * scanError means the machine really has nothing attached, which is a different
 * fact and must never be printed for the first case.
 *
 * THE QUERY IS SCOPED BY DEVICE CLASS, NOT BY INSTANCE PATH. An earlier version
 * added `-and $_.PNPDeviceID -like 'USB*'`, which silently removed every serial
 * port a non-USB enumerator owns — measured on the development laptop, two
 * PNPClass='Ports' devices with real COM numbers were dropped, so the panel
 * offered COM6 and COM7 in one line and said "none with a port" three lines
 * below. PNPClass already scopes this; the instance prefix does not need to.
 */
async function scan() {
    const probe = await ps(
        "Get-CimInstance Win32_PnPEntity | " +
        "Where-Object { $_.PNPClass -in @('Ports','USB','MEDIA','HIDClass') " +
        // Payload trim only. This predicate is DELIBERATELY LOOSER than the row
        // filter below — it must never drop a row the JS side would have kept.
        "-and ($_.PNPDeviceID -match 'VID' -or $_.Name -match '\\(COM\\d+\\)') } | " +
        "Select-Object Name,Manufacturer,PNPDeviceID,Status,Service | ConvertTo-Json -Compress -Depth 3"
    );

    let rows = null, parseFailed = false;
    const raw = String(probe.out || "").trim();
    if (raw) {
        try {
            const j = JSON.parse(raw);
            rows = Array.isArray(j) ? j : [j];
        } catch { parseFailed = true; }
    }

    // WHY THE LIST IS EMPTY, WHEN IT IS EMPTY. Each branch is a different fact
    // about the machine and only the last one means "nothing is plugged in".
    let scanError = null, scanNote = null;
    const complaint = firstLine(probe.err);
    if (!probe.ran) {
        scanError = `The device probe could not be started — ${PROBE_SHELL.exe} ` +
            `did not run${complaint ? ` (${complaint})` : ""}. Nothing was read ` +
            `from the device tree, so this is not a list of what is attached.`;
    } else if (probe.timedOut) {
        scanError = "The device probe was still running when its time ran out and " +
            "was stopped. Nothing was read from the device tree, so this is not a " +
            "list of what is attached.";
    } else if (parseFailed) {
        scanError = "The device probe answered with something that is not a device " +
            `list${complaint ? `, and reported: ${complaint}` : ""}. Nothing could be ` +
            "read from it, so this is not a list of what is attached.";
    } else if (rows === null && (probe.code !== 0 || complaint)) {
        scanError = "The device probe printed nothing and failed" +
            (probe.code !== 0 ? ` (exit status ${probe.code})` : "") +
            `${complaint ? `: ${complaint}` : ""}. Nothing was read from the device ` +
            "tree, so this is not a list of what is attached.";
    } else if (rows !== null && (probe.code !== 0 || complaint)) {
        // The list came back AND the shell complained. The devices below are
        // real, so this is not a failed probe — but it may be a partial one and
        // saying so costs nothing.
        scanNote = "The device probe returned a list but also reported: " +
            `${complaint || `exit status ${probe.code}`}. The list may be incomplete.`;
    }
    if (scanError) return { devices: [], scanError, scanNote: null };

    const devices = [];
    for (const r of (rows || []).filter(Boolean)) {
        const m = ID_RE.exec(String(r.PNPDeviceID || ""));
        const port = (PORT_IN_NAME_RE.exec(String(r.Name || "")) || [])[1] || null;
        // No USB identity AND no serial port: nothing here anyone could act on.
        // A row with a COM number but no VID/PID is KEPT — a Bluetooth or
        // motherboard serial port is still a port somebody can talk to, and
        // dropping it is how the port list and the device list came to disagree.
        if (!m && !port) continue;
        const vid = m ? m[1].toLowerCase() : null;
        const pid = m ? m[2].toLowerCase() : null;
        const known = (vid && PRODUCTS[`${vid}:${pid}`]) || null;
        // the instance tail is the device's own serial number when it has one
        const tail = String(r.PNPDeviceID || "").split("\\").pop() || "";
        devices.push({
            port,
            name: String(r.Name || "").trim(),
            manufacturer: String(r.Manufacturer || "").trim() || null,
            vid, pid,
            vendor: (vid && VENDORS[vid]) || null,
            family: known ? known.family : null,
            kind: known ? known.kind : null,
            serial: /^[A-Za-z0-9_-]{4,}$/.test(tail) && !tail.includes("&") ? tail : null,
            status: String(r.Status || "").trim() || null,
            // THE HONEST FIELD. Absent from the table means unidentified, and
            // it is reported with the numbers rather than as a shrug.
            identified: !!known,
            note: known ? null
                : vid ? `not in the identification table — vendor ${vid}, product ${pid}`
                : "this port reports no USB vendor or product number — it is not a " +
                  "USB device, so there is nothing to look up"
        });
    }
    // A REAL MACHINE HAS A LOT OF USB ON IT. Measured on the development
    // laptop: thirteen devices, all of them hubs, a webcam, Bluetooth and
    // Intel controllers. A board plugged into that must not arrive as row
    // fourteen. So everything found is KEPT — nothing is deleted to tidy the
    // list — and the ones that could plausibly be a board you are working on
    // are marked and sorted first: it has a serial port, or it is silicon this
    // table recognises.
    for (const d of devices) {
        d.likelyBoard = !!(d.port || d.identified);
    }
    const rank = (d) => !d.likelyBoard ? 9
        : d.kind === "mcu" ? 0 : d.kind === "mcu-bootloader" ? 1
        : d.kind === "debug" ? 2 : d.kind === "bridge" ? 3 : 4;
    devices.sort((a, b) => rank(a) - rank(b));
    return { devices, scanError: null, scanNote };
}

/**
 * LISTEN to a port that is already talking. Passive by construction.
 *
 * A board that prints a banner or a telemetry line says more about what it is
 * running than any identifier can. This opens the port at a common baud and
 * READS — it never writes a probe byte, never toggles DTR/RTS (the ESP32 reset
 * line), and never reconfigures anything. A silent board yields nothing, which
 * is the correct answer for a board that is not talking, not a failure.
 *
 * Windows' own serial support does the read; there is no native dependency,
 * which matters because this must work on an offline bench machine.
 */
/**
 * WHY AN OPEN FAILED, in the words Windows used.
 *
 * One marker used to stand for every possible failure, and the caller turned it
 * into a specific factual claim: "open in another program — nothing was read,
 * and nothing was interrupted". Measured, that sentence was printed for a port
 * that does not exist, and for a shell locked down so hard the serial class
 * could not be constructed at all. Both times nothing had ever touched the port.
 *
 * Two shapes are measurable and they are not the same fact:
 *   System.UnauthorizedAccessException  "Access to the port 'COM7' is denied."
 *   System.IO.IOException               "The port 'COM99' does not exist."
 * Only the first is another program holding the line.
 */
function openFailureFrom(port, markerLine) {
    const parts = String(markerLine || "").split("|");
    const exception = (parts[1] || "").trim();
    const message = parts.slice(2).join("|").trim();
    const busy = /UnauthorizedAccess/i.test(exception) ||
                 /access to the port .* is denied/i.test(message);
    if (busy) {
        return { busy: true, exception, message,
                 error: `${port} is open in another program — nothing was read, and ` +
                        `nothing was interrupted` };
    }
    return { busy: false, exception, message,
             error: message
                 ? `${port} could not be opened: ${message}`
                 : `${port} could not be opened, and no reason came back` };
}

/**
 * WHAT CAME OFF THE LINE, counted honestly.
 *
 * SLICE ONCE, then count what is actually being handed back. The cap used to be
 * a loop pre-condition, so a single read could append a whole driver buffer past
 * it; the count was then taken from the untruncated string while the text was
 * cut, and a caller told it had 8192 of something received 4000 of it with no
 * marker that anything had been dropped. The counts are CHARACTERS, after
 * carriage returns are removed — not bytes on the wire — and the names say so.
 */
function readResult(port, baud, heldMs, raw) {
    const full = String(raw || "").replace(/\r/g, "").trim();
    const text = full.slice(0, MAX_CHARS);
    const truncated = full.length > text.length;
    const notes = [];
    // said explicitly, because silence and failure look identical otherwise
    if (!text) {
        notes.push(`nothing arrived in ${heldMs} ms at ${baud} baud. The board may be ` +
                   `idle, may use a different baud rate, or may not print at all — this ` +
                   `is a passive listen, so it was never asked to say anything.`);
    }
    if (truncated) {
        notes.push(`Cut at ${MAX_CHARS} characters: ${full.length} arrived and the ` +
                   `first ${text.length} of them are what you see.`);
    }
    return {
        ok: true, port, baud, listenedMs: heldMs,
        chars: text.length,             // what `text` actually contains
        charsReceived: full.length,     // what arrived, before anything was cut
        truncated,
        text,
        note: notes.length ? notes.join(" ") : null
    };
}

async function listen(port, { ms = 2500, baud = 115200 } = {}) {
    if (!/^COM\d+$/i.test(String(port || ""))) {
        return { ok: false, error: "not a serial port name" };
    }
    // ONE normalisation, here, at the top: the shell window, the timeout,
    // listenedMs and the silence note all describe the same number after this.
    const heldMs = listenWindowMs(ms);
    const cmd =
        // EVERY step of the open is inside the try, including constructing the
        // port object: on a machine with language modes locked down that
        // construction is itself denied, and leaving it outside meant the
        // failure was attributed to a port nothing had opened.
        "try { " +
        `  $p = New-Object System.IO.Ports.SerialPort '${port}',${baud},None,8,One; ` +
        // read-only: no handshake lines are asserted, so nothing resets
        "  $p.DtrEnable = $false; $p.RtsEnable = $false; " +
        "  $p.ReadTimeout = 400; " +
        "  $p.Open() " +
        "} catch { " +
        "  $err = $_; $t = ''; $m = ''; " +
        "  try { $x = $err.Exception; if ($x.InnerException) { $x = $x.InnerException }; " +
        "        $t = $x.GetType().FullName; $m = [string]$x.Message } catch {} ; " +
        "  if (-not $m) { try { $m = [string]$err } catch {} } ; " +
        `  Write-Output ('${OPEN_FAIL}|' + $t + '|' + ($m -replace '\\s+',' ')); exit }; ` +
        "$sb = New-Object System.Text.StringBuilder; " +
        `$end = (Get-Date).AddMilliseconds(${heldMs}); ` +
        `while ((Get-Date) -lt $end -and $sb.Length -lt ${MAX_CHARS}) { ` +
        "  try { $null = $sb.Append($p.ReadExisting()) } catch {} ; Start-Sleep -Milliseconds 120 } ; " +
        "$p.Close(); Write-Output $sb.ToString()";
    // Room for the shell to start and for a driver to answer, on top of the
    // window itself. Measured: a Bluetooth serial link took 6.5 s to open.
    const probe = await ps(cmd, Math.min(20000, heldMs + 8000));

    if (!probe.ran) {
        const complaint = firstLine(probe.err);
        return { ok: false, port, baud, listenedMs: 0, probeFailed: true,
                 error: `${port} was never opened — ${PROBE_SHELL.exe} did not run` +
                        `${complaint ? ` (${complaint})` : ""}. Nothing was read, and ` +
                        `nothing was interrupted.` };
    }
    if (probe.timedOut) {
        return { ok: false, port, baud, listenedMs: null, probeFailed: true,
                 error: `The read on ${port} was still running when its time ran out ` +
                        `and was stopped, so how long the port was held is not known.` };
    }
    const raw = String(probe.out || "");
    // The marker is the FIRST thing written and the shell exits straight after,
    // so it starts its line. Matched that way rather than anywhere-in-the-text,
    // so a board printing the marker in its own banner cannot fake a failure.
    const failLine = raw.split(/\r?\n/).find(l => l.trim().startsWith(OPEN_FAIL));
    if (failLine) {
        const f = openFailureFrom(port, failLine);
        return { ok: false, port, baud, listenedMs: 0, busy: f.busy,
                 exception: f.exception || null, reason: f.message || null,
                 error: f.error };
    }
    const complaint = firstLine(probe.err);
    const shellTrouble = probe.code !== 0 || !!complaint;
    const result = readResult(port, baud, heldMs, raw);
    if (shellTrouble && !result.chars) {
        // Nothing came back AND the shell complained: that is a failed read, and
        // calling it silence would put an idle board and a broken probe in the
        // same sentence.
        return { ok: false, port, baud, listenedMs: null, probeFailed: true,
                 reason: complaint || null,
                 error: `The read on ${port} failed` +
                        (probe.code !== 0 ? ` (exit status ${probe.code})` : "") +
                        `${complaint ? `: ${complaint}` : ""}.` };
    }
    if (shellTrouble) {
        // Text DID arrive. It is kept — a partial read is still a read — with
        // the complaint attached rather than thrown away.
        result.shellTrouble = complaint || `exit status ${probe.code}`;
        const warn = `The shell also reported: ${result.shellTrouble}. What was ` +
            `read may be incomplete.`;
        result.note = result.note ? `${result.note} ${warn}` : warn;
    }
    return result;
}

/**
 * One call: what is attached, and what the talkative ones are saying.
 *
 * `port` LIMITS THE LISTEN to a single COM port. Every port found is still
 * listed — nothing is hidden — but only the named one is opened. That matters
 * because an open here is exclusive: on a bench with four boards, an unscoped
 * call holds four ports in sequence and every other program's attempt on them
 * fails for the duration. A port name that is not COMn opens nothing at all.
 */
/* THE RATES A BOARD ACTUALLY TALKS AT, TRIED IN ORDER.
 *
 * "it also can not read com10"
 * and, from the model itself, correctly: "The serial listener only works at
 * 115200 baud. I've tried that on COM10 three times now and received nothing."
 *
 * It was right, and that was the bug: listen() has taken a `baud` argument all
 * along and the TOOL never passed one, so every read was 115200 and a board at
 * any other rate read as silence. The model could see the wall and had no door.
 *
 * 115200 first because it is the common case and the one already proven; then
 * 74880, which is what an ESP32 prints its BOOT ROM messages at and is exactly
 * the rate an operator staring at an ESP32-S3 needs; then the classics. A port
 * that answers stops the ladder — nothing is gained by opening it four more
 * times, and each open can reset the board.
 */
const BAUD_LADDER = [115200, 74880, 9600, 57600, 38400, 921600];

async function inspect({ listenMs = 2000, port = null, baud = null } = {}) {
    const wanted = port === null || port === undefined || String(port).trim() === ""
        ? null : String(port).trim();
    const scoped = wanted !== null;
    const scopeUsable = scoped && /^COM\d+$/i.test(wanted);
    const { devices, scanError, scanNote } = await scan();

    const listenedPorts = [];
    for (const d of devices) {
        if (!d.port) continue;
        if (d.kind === "debug") continue;                  // a probe's port is not the board
        if (scoped && (!scopeUsable || d.port.toUpperCase() !== wanted.toUpperCase())) continue;
        /* ASKED FOR A RATE: honour it exactly and report that rate. Asked for
           nothing: walk the ladder until something arrives. Silence at six
           rates is a real finding; silence at one was an artefact. */
        /* THE LADDER IS FOR ONE PORT, NEVER FOR ALL OF THEM.
           Measured after adding it: an unscoped scan went from ~3s to 20.3s,
           because six rates times every serial port is six times the work for
           a question nobody asked. The model calling this got nothing back at
           all — a read-only tool made useless by making it thorough.
           Scoped to a port, walking rates is exactly right: that is the "why
           is my board silent" case. Unscoped, one rate and move on. */
        const rates = Number(baud) > 0 ? [Number(baud)]
                    : (scoped ? BAUD_LADDER : [BAUD_LADDER[0]]);
        let heard = null;
        for (const rate of rates) {
            heard = await listen(d.port, { ms: listenMs, baud: rate });
            // stop on the first rate that yields BYTES, or on a port that
            // cannot be opened at all — retrying a busy port five more times
            // just holds up the scan with the same answer
            if ((heard && heard.ok && heard.chars > 0) || (heard && heard.probeFailed)) break;
            if (heard && heard.ok === false && !heard.probeFailed) break;
        }
        if (heard && rates.length > 1 && heard.ok && !(heard.chars > 0)) {
            heard.triedBauds = rates;
        }
        listenedPorts.push(d.port);
        d.serialRead = heard.ok
            ? { listenedMs: heard.listenedMs, chars: heard.chars,
                charsReceived: heard.charsReceived,
                truncated: heard.truncated, text: heard.text, note: heard.note }
            : { error: heard.error, busy: !!heard.busy,
                probeFailed: !!heard.probeFailed, reason: heard.reason || null };
    }

    const scopeNote = !scoped ? null
        : scopeUsable
            ? `Only ${wanted.toUpperCase()} was listened to; every other port was left alone.`
            : `"${wanted}" is not a COM port name, so no port was opened at all.`;

    return {
        devices,
        // CONTRACT: a sentence when the OS probe itself failed, null when it
        // worked. An empty device list with this set is NOT an empty bench.
        scanError: scanError || null,
        scanNote: scanNote || null,
        listenedPorts,
        listenScope: scopeNote,
        // WHAT WAS NOT DONE, stated with what was. The operator builds
        // hardware and would notice the difference immediately.
        readingsTaken: scanError
            // the tree was NOT read, so nothing here may say that it was
            ? "Nothing was read. The probe that lists this machine's devices did " +
              "not work, and no serial port was opened."
            : "USB identifiers from the OS device tree, and a passive " +
              "listen on any serial port that was free" +
              (scoped ? `, limited to ${scopeUsable ? wanted.toUpperCase() : "nothing"}` : "") +
              (listenedPorts.length ? `. Ports held open, one at a time: ${listenedPorts.join(", ")}`
                                    : ". No port was opened."),
        notRead: "Firmware was NOT read. Pulling a program off a running board is " +
            "chip-specific and normally requires resetting it into a bootloader or " +
            "attaching a debug probe — both of which change the device, so neither " +
            "happens without you asking for it by name."
    };
}

/* ------------------------------------------------------------------ tool --- */
const TOOL_ENTRY = {
    run: async (_root, args = {}) => {
        const ms = Math.min(6000, Math.max(0, Number(args.listen_ms) || 2000));
        // inspect() holds the shape check (/^COM\d+$/i); anything else opens
        // no port and is reported back rather than silently widened to all.
        const raw = typeof args.port === "string" ? args.port.trim() : "";
        // a rate the caller names is used as given; absent, inspect walks the
        // ladder — see BAUD_LADDER
        const rate = Number(args.baud) > 0 ? Number(args.baud) : null;
        return inspect({ listenMs: ms, port: raw || null, baud: rate });
    },
    help: 'inspect_devices {port?, listen_ms?, baud?} — list USB/serial hardware ' +
          'with vendor and product ids, and passively read any serial port already ' +
          'printing. port limits the read to one port; listen_ms is how long. ' +
          'baud sets the rate (without it, common rates are tried). ' +
          'Read-only: it never writes to, resets or flashes a device.'
};

module.exports = {
    scan, listen, inspect, openFailureFrom, readResult, listenWindowMs,
    VENDORS, PRODUCTS, TOOL_ENTRY, PROBE_SHELL, MAX_CHARS, BAUD_LADDER,
    WINDOW_MIN_MS, WINDOW_MAX_MS
};
