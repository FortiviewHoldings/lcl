/**
 * TALKING TO A BOARD, NOT JUST LOOKING AT ONE.
 *
 * The requirement: .lcl must do more than scan a port and read it — it needs to
 * actually use the configuration tools a given device requires. That is where
 * the read-only approach fell short.
 *
 * deviceScan reads. It lists what is plugged in and listens to whatever a board
 * is already printing, and that is where it stops — so an ESP32-S3 on COM10 was
 * a thing the app could NAME and nothing more.
 *
 * The obvious answer is a general shell tool, and it is the wrong one. A model
 * asked for "direct command execution with write permissions" during this very
 * build; that trades every scoped approval for one blind rubber stamp on a
 * forty-line script nobody reads. These three do the same work with the
 * approvals pointed at decisions a person can actually make:
 *
 *   serial_write       send bytes to a port, at a rate you choose
 *   install_toolchain  put arduino-cli / esptool / a board core on this machine
 *   flash_device       COMPILE AND UPLOAD as one unit, both shown before either runs
 *
 * flash_device is deliberately one call rather than two. "Approve compiling" is
 * not a decision anyone can weigh; "here is the sketch, here is the board, here
 * is the port, flash it" is.
 *
 * EVERY tool here is classified EXECUTE, which this app welds to confirm — the
 * human sees the exact command before anything runs, and the model never holds
 * something executable. Nothing in this file runs on its own.
 */
const { spawn } = require("child_process");
const path = require("path");
const paths = require("./paths");
const fs = require("fs");

const SHELL = { exe: "powershell.exe" };

/* Long enough for a core install over a slow line; short enough that a wedged
   toolchain does not look like a hung app. Compile and upload get their own. */
const RUN_TIMEOUT_MS = 300_000;
const SERIAL_TIMEOUT_MS = 20_000;

/** A port name this file will act on. Anything else opens nothing. */
const PORT_SHAPE = /^COM\d{1,3}$/i;

/* The rates a board actually talks at, same ladder deviceScan reads with, so a
   write and a read cannot disagree about what "default" means. */
const DEFAULT_BAUD = 115200;

/* A MODEL SAYING "true" IS A MODEL SAYING TRUE.
 *
 * Seen in a session, twice in a row:
 *
 *   user:   "read com10 with a reset"
 *   model:  "I need to pulse the reset line to capture the boot log."
 *   tool:   {"reset": false, "chars": 0, note: "...call again with reset: true"}
 *
 * The entry tested `args.reset === true`. A model that emits "true" as a STRING
 * — which small models do constantly, and which the JSON schema cannot force —
 * fell through to false, and the note then told it to do the thing it had just
 * tried. A loop with no exit, and from the user's side the board simply stayed dead.
 *
 * Strictness here buys nothing: there is no case where "true" means false. */
function asBool(v, dflt = false) {
    if (v === undefined || v === null || v === "") return dflt;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    const t = String(v).trim().toLowerCase();
    if (["true", "yes", "y", "1", "on"].includes(t)) return true;
    if (["false", "no", "n", "0", "off"].includes(t)) return false;
    return dflt;
}


/**
 * Run a command and report WHAT HAPPENED, never just what it printed.
 *
 * The failure that matters is "the tool is not installed", and it arrives as
 * ENOENT rather than as output — reporting "" there would read as a command
 * that ran and said nothing, which is how a missing toolchain becomes a
 * mystery instead of an instruction.
 */
function run(exe, args, { timeoutMs = RUN_TIMEOUT_MS, cwd = undefined, onData = null } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(exe, args, { cwd, windowsHide: true });
        } catch (e) {
            return resolve({ ok: false, started: false, code: null, out: "", err: "",
                             why: `${exe} could not be started — ${e.message}` });
        }
        let out = "", err = "", done = false;
        const finish = (r) => { if (!done) { done = true; resolve(r); } };
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* already gone */ }
            finish({ ok: false, started: true, timedOut: true, code: null, out, err,
                     why: `${exe} did not finish within ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs);
        // onData sees each chunk live — the only way a long compile/upload can
        // show progress instead of a lull. Wrapped so a bad callback never kills
        // the run it is only observing.
        const feed = (chunk) => { if (onData) { try { onData(chunk); } catch { /* observer only */ } } };
        child.stdout.on("data", d => { const c = d.toString(); out += c; feed(c); });
        child.stderr.on("data", d => { const c = d.toString(); err += c; feed(c); });
        child.on("error", (e) => {
            clearTimeout(timer);
            finish({ ok: false, started: false, code: null, out, err,
                     why: e.code === "ENOENT"
                        ? `${exe} is not installed on this machine, or not on PATH`
                        : `${exe} could not be started — ${e.message}` });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            finish({ ok: code === 0, started: true, code, out, err,
                     why: code === 0 ? null : `${exe} exited ${code}` });
        });
    });
}

/** Is a command-line tool present, and which version? */
async function toolVersion(exe, args = ["version"]) {
    const r = await run(exe, args, { timeoutMs: 20_000 });
    if (!r.started) return { present: false, why: r.why };
    const text = (r.out + " " + r.err).trim();
    return { present: r.ok, version: text.split(/\r?\n/)[0] || null,
             why: r.ok ? null : r.why };
}

/* ------------------------------------------------------------ serial write */

/**
 * Write to a serial port and, optionally, read what comes back.
 *
 * The read is the point. A board that answers a command is a board you can
 * develop against; writing blind and hoping is what a terminal is for.
 */
async function serialWrite(port, data, { baud = DEFAULT_BAUD, newline = true,
                                         readMs = 1500 } = {}) {
    if (!PORT_SHAPE.test(String(port || "").trim())) {
        return { ok: false, why: `"${port}" is not a COM port name, so nothing was opened` };
    }
    const p = String(port).trim().toUpperCase();
    const payload = String(data === undefined || data === null ? "" : data);
    // single-quoted PowerShell literal: the only escape inside one is ''
    const lit = payload.replace(/'/g, "''");
    const wait = Math.min(15_000, Math.max(0, Number(readMs) || 0));
    const writeCall = newline ? "WriteLine" : "Write";
    const script =
        "$ErrorActionPreference='Stop'; " +
        `try { $s = New-Object System.IO.Ports.SerialPort '${p}',${Number(baud) || DEFAULT_BAUD},None,8,One; ` +
        "$s.ReadTimeout=500; $s.WriteTimeout=2000; $s.Open(); " +
        `$s.${writeCall}('${lit}'); ` +
        (wait > 0
            ? `Start-Sleep -Milliseconds ${wait}; $b=''; ` +
              "try { $b = $s.ReadExisting() } catch { }; " +
              "Write-Output ('---REPLY---' + $b); "
            : "Write-Output '---REPLY---'; ") +
        "$s.Close() } catch { Write-Output ('---ERROR---' + $_.Exception.Message) }";
    const r = await run(SHELL.exe, ["-NoProfile", "-NonInteractive", "-Command", script],
                        { timeoutMs: SERIAL_TIMEOUT_MS });
    const text = (r.out || "") + (r.err || "");
    const errAt = text.indexOf("---ERROR---");
    if (errAt >= 0) {
        const why = text.slice(errAt + 11).trim();
        return { ok: false, port: p, baud: Number(baud) || DEFAULT_BAUD, wrote: payload,
                 why: /access.*denied|being used/i.test(why)
                    ? `${p} is open in something else — close the serial monitor and try again`
                    : why };
    }
    if (!r.started) return { ok: false, port: p, why: r.why };
    const at = text.indexOf("---REPLY---");
    const reply = at >= 0 ? text.slice(at + 11).trim() : "";
    return {
        ok: true, port: p, baud: Number(baud) || DEFAULT_BAUD,
        wrote: payload, newline: !!newline,
        reply: reply || null,
        note: reply
            ? null
            : `nothing came back in ${wait} ms — the board may not answer this, may ` +
              `print at a different rate, or may need a reset`
    };
}

/* ------------------------------------------------------------ serial read */

/**
 * READ A PORT — and, if asked, RESET THE BOARD FIRST.
 *
 * From a session, four calls in a row:
 *   serial_write {port:"COM10", data:"", ...} -> reply: null
 *
 * The model was writing NOTHING to a port in order to read it, because a write
 * tool was the only door built. "Read COM10 at this rate" had nowhere to
 * go except inspect_devices, which scans the whole machine to answer a question
 * about one port.
 *
 * And the silence underneath it was never about the baud rate. deviceScan holds
 * DtrEnable and RtsEnable FALSE on purpose — correct for a read-only scanner,
 * because those two lines are wired to EN and GPIO0 on every ESP32 dev board and
 * toggling them reboots somebody's hardware. But an ESP32 prints its boot log
 * ONLY at reset. A board that is already running, whose sketch prints nothing,
 * is silent at every rate, forever. Six baud rates could not have found it.
 *
 * So the reset lives HERE, in the module where every tool is EXECUTE-classified
 * and the operator sees the action before it happens. reset defaults to FALSE —
 * rebooting a board mid-run is a real side effect — and the note tells the
 * caller it is the next thing to try, which is the sentence that was missing.
 *
 * The pulse is esptool's own: RTS asserted drops EN (reset held), DTR left low
 * so GPIO0 stays high and the chip boots the application rather than the
 * bootloader. Release RTS and it runs.
 */
async function serialRead(port, { baud = DEFAULT_BAUD, ms = 3000, reset = false } = {}) {
    const p = String(port || "").trim().toUpperCase();
    if (!PORT_SHAPE.test(p)) {
        return { ok: false, why: `"${port}" is not a COM port name, so nothing was opened` };
    }
    const rate = Number(baud) > 0 ? Number(baud) : DEFAULT_BAUD;
    const wait = Math.min(30_000, Math.max(250, Number(ms) || 3000));
    const resetPulse = reset
        ? "$s.DtrEnable=$false; $s.RtsEnable=$true; Start-Sleep -Milliseconds 120; " +
          "$s.RtsEnable=$false; Start-Sleep -Milliseconds 60; "
        : "$s.DtrEnable=$false; $s.RtsEnable=$false; ";
    const script =
        "$ErrorActionPreference='Stop'; " +
        `try { $s = New-Object System.IO.Ports.SerialPort '${p}',${rate},None,8,One; ` +
        "$s.ReadTimeout=500; $s.Open(); " +
        resetPulse +
        `$sw=[System.Diagnostics.Stopwatch]::StartNew(); $acc=''; ` +
        `while ($sw.ElapsedMilliseconds -lt ${wait}) { ` +
        "  try { $acc += $s.ReadExisting() } catch { }; Start-Sleep -Milliseconds 50 }; " +
        "Write-Output ('---DATA---' + $acc); $s.Close() } " +
        "catch { Write-Output ('---ERROR---' + $_.Exception.Message) }";
    const r = await run(SHELL.exe, ["-NoProfile", "-NonInteractive", "-Command", script],
                        { timeoutMs: wait + 15_000 });
    const text = (r.out || "") + (r.err || "");
    const errAt = text.indexOf("---ERROR---");
    if (errAt >= 0) {
        const why = text.slice(errAt + 11).trim();
        return { ok: false, port: p, baud: rate,
                 why: /access.*denied|being used/i.test(why)
                    ? `${p} is open in another program — close the serial monitor and try again`
                    : why };
    }
    if (!r.started) return { ok: false, port: p, why: r.why };
    const at = text.indexOf("---DATA---");
    const got = at >= 0 ? text.slice(at + 10) : "";
    const clean = got.replace(/\r/g, "").trim();
    return {
        ok: true, port: p, baud: rate, listenedMs: wait, reset: !!reset,
        chars: clean.length,
        data: clean ? clean.slice(-4000) : null,
        note: clean ? null
            : (reset
                ? `the board was reset and still said nothing at ${rate} baud. An ESP32 ` +
                  `prints its ROM boot log at 74880 — try that rate next. If it is silent ` +
                  `there too, nothing on the board writes to this UART: it may print over ` +
                  `native USB instead, or have no serial output at all.`
                : `nothing arrived in ${wait} ms at ${rate} baud, and the board was NOT ` +
                  `reset. An ESP32 prints its boot log only when it restarts — call this ` +
                  `again with reset: true to pulse the reset line and capture it.`)
    };
}

/* --------------------------------------------------------- the toolchains */

/**
 * WHAT EACH TOOL IS, WHERE IT COMES FROM, AND THE EXACT COMMAND.
 *
 * Named sources only. "Install the thing that flashes boards" is precisely the
 * request that should never be satisfied by whatever a model decides to
 * download, so the table is the allowlist and the tool takes a key, not a URL.
 */
const TOOLCHAINS = {
    "arduino-cli": {
        what: "Arduino CLI — compiles and uploads sketches for almost every board, " +
              "including ESP32. No IDE needed.",
        probe: ["arduino-cli", ["version"]],
        install: ["winget", ["install", "--id", "ArduinoSA.CLI", "-e",
                             "--accept-package-agreements", "--accept-source-agreements"]],
        source: "winget package ArduinoSA.CLI (Arduino SA, the vendor)"
    },
    esptool: {
        what: "esptool — Espressif's own flasher. Reads chip IDs, erases and writes " +
              "flash directly. The lower-level path when a sketch is not involved.",
        probe: ["esptool", ["version"]],
        install: ["pip", ["install", "--upgrade", "esptool"]],
        source: "PyPI package esptool (Espressif Systems, the vendor)"
    },
    "esp32-core": {
        what: "The ESP32 board support package for Arduino CLI — the definitions " +
              "that make an ESP32-S3 a target it knows how to build for.",
        probe: ["arduino-cli", ["core", "list"]],
        install: ["arduino-cli", ["core", "install", "esp32:esp32"]],
        source: "Arduino CLI core index, published by Espressif",
        needs: "arduino-cli"
    },
    platformio: {
        what: "PlatformIO Core — one build-and-upload tool that covers STM32, AVR, " +
              "RP2040, nRF52, Teensy and ESP boards. The path when a project " +
              "carries a platformio.ini.",
        probe: ["pio", ["--version"]],
        find: () => findPio(),
        install: ["pip", ["install", "--upgrade", "platformio"]],
        source: "PyPI package platformio (PlatformIO Labs, the vendor)"
    }
};

async function installToolchain(which) {
    const key = String(which || "").trim().toLowerCase();
    const spec = TOOLCHAINS[key];
    if (!spec) {
        return { ok: false,
                 why: `"${which}" is not a toolchain this app installs. ` +
                      `Choose one of: ${Object.keys(TOOLCHAINS).join(", ")}` };
    }
    if (spec.needs) {
        const dep = await toolVersion(...TOOLCHAINS[spec.needs].probe);
        if (!dep.present) {
            return { ok: false, needs: spec.needs,
                     why: `${key} needs ${spec.needs} first — install that, then this` };
        }
    }
    // a tool can live OFF PATH — pip drops the pio shim into Python's Scripts
    // dir. When the entry declares a finder, probe what a caller would actually
    // run, before AND after, so an existing install is seen and a fresh one is
    // verified where it landed.
    const probeOf = () => {
        if (!spec.find) return spec.probe;
        const f = spec.find();
        return [f.exe, [...f.args, ...spec.probe[1]]];
    };
    const before = await toolVersion(...probeOf());
    if (before.present && key !== "esp32-core") {
        return { ok: true, already: true, tool: key, version: before.version,
                 note: `${key} is already installed — nothing was changed` };
    }
    const [exe, args] = spec.install;
    const r = await run(exe, args);
    const after = await toolVersion(...probeOf());
    // for an entry with a finder the verdict comes from the TOOL answering its
    // probe, never from the package manager exiting 0 — pip reporting success
    // while pio is unreachable is a reported success and a dead feature
    const installedOk = spec.find ? !!after.present : (!!after.present || r.ok);
    return {
        ok: installedOk,
        tool: key, source: spec.source,
        ran: `${exe} ${args.join(" ")}`,
        version: after.version || null,
        output: ((r.out || "") + (r.err || "")).trim().slice(-2000) || null,
        why: installedOk ? null
            : (spec.find && r.ok
                ? `${key} installed but does not answer its version probe — the shim ` +
                  `may be somewhere this app does not look; open a fresh terminal or reinstall`
                : (r.why || `${key} did not install; the output above is what it said`))
    };
}

/* ------------------------------------------------------- compile and flash */

/** Ask arduino-cli what is plugged in, and what board it thinks it is. */
async function detectBoard(port) {
    const r = await run("arduino-cli", ["board", "list", "--format", "json"],
                        { timeoutMs: 60_000 });
    if (!r.started) return { ok: false, why: r.why };
    let list = [];
    try {
        const j = JSON.parse(r.out || "{}");
        list = Array.isArray(j) ? j : (j.detected_ports || j.ports || []);
    } catch { return { ok: false, why: "arduino-cli board list did not return JSON" }; }
    const rows = list.map(entry => {
        const p = entry.port || entry;
        const boards = entry.matching_boards || entry.boards || [];
        return { port: (p.address || p.port || "").toUpperCase(),
                 protocol: p.protocol || null,
                 label: (p.properties && p.properties.pid)
                     ? `${p.properties.vid || ""}:${p.properties.pid}` : null,
                 fqbn: (boards[0] && boards[0].fqbn) || null,
                 name: (boards[0] && boards[0].name) || null };
    });
    const want = String(port || "").trim().toUpperCase();
    return { ok: true, ports: rows,
             match: want ? rows.find(x => x.port === want) || null : null };
}

/**
 * COMPILE, THEN UPLOAD — one call, because that is one decision.
 *
 * A compile that succeeds and an upload that is approved separately is two
 * prompts for one intention, and the first of them is unanswerable: nobody can
 * weigh "may I run a compiler". The pair is shown together and runs together.
 */
/* HOW LONG A COMPILE TAKES ON THIS MACHINE, remembered per board. "it took
 * several minutes and it did not let me know what was going on" — the honest
 * answer to "how much longer?" is last time's duration, said as a percent of
 * the whole. First build has no history: elapsed seconds, never a fake percent. */
function compileTimesPath() {
    const dir = path.join(paths.dataDir(), "learned");
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    return path.join(dir, "compile-times.json");
}
/* Keys are `${tool}:${target}` — "arduino:esp32:esp32:esp32s3",
 * "platformio:esp32dev" — one store for every tool that builds. The arduino
 * wrappers still read the bare-fqbn keys older installs wrote, so nobody's
 * learned durations vanish on update. */
function learnedMs(key) {
    try { return Number(JSON.parse(fs.readFileSync(compileTimesPath(), "utf8"))[key]) || 0; }
    catch { return 0; }
}
function rememberMs(key, ms) {
    try {
        let all = {};
        try { all = JSON.parse(fs.readFileSync(compileTimesPath(), "utf8")) || {}; } catch { /* fresh */ }
        // a light EMA so one cold-cache outlier does not own the estimate
        all[key] = all[key] ? Math.round(all[key] * 0.4 + ms * 0.6) : ms;
        fs.writeFileSync(compileTimesPath(), JSON.stringify(all));
    } catch { /* an estimate is a courtesy */ }
}
function learnedCompileMs(fqbn) { return learnedMs("arduino:" + fqbn) || learnedMs(fqbn); }
function rememberCompileMs(fqbn, ms) { rememberMs("arduino:" + fqbn, ms); }

/* The elapsed-over-learned ticker, shared by every build path: a real percent
 * capped at 95 when history exists, an honest elapsed-seconds line when it
 * does not. Never a fake percent. */
function etaTicker(say, label, knownMs, t0) {
    const ticker = setInterval(() => {
        const el = Date.now() - t0;
        if (knownMs) {
            const pct = Math.min(95, Math.round((el / knownMs) * 100));
            const left = Math.max(0, Math.round((knownMs - el) / 1000));
            say(`${label} — ${pct}% of ~${Math.round(knownMs / 1000)}s (about ${left}s left)`,
                { pct, etaMs: Math.max(0, knownMs - el) });
        } else {
            say(`${label} — ${Math.round(el / 1000)}s in, still working`, { indeterminate: true });
        }
    }, 4000);
    if (ticker.unref) ticker.unref();
    return ticker;
}

async function flashDevice(root, args = {}, onNote = null) {
    // WHICH TOOL, from the arguments alone — pure, so the whole detection
    // matrix is provable without a board. null means "the filesystem decides,
    // after the scope checks", which keeps every refusal below in its order.
    const sel = resolveFlashToolFromArgs(args);
    if (sel && sel.why) return { ok: false, why: sel.why };
    if (sel === "uf2") return flashUf2(root, args, onNote); // a bootloader drive, not a COM port
    const { port, sketch, fqbn = null, board = null } = args;
    const p = String(port || "").trim().toUpperCase();
    if (!p) {
        return { ok: false,
                 why: 'flash_device needs {"port": "COM10"} for the arduino and platformio ' +
                      'paths — only uf2 (a .uf2 file copied to a bootloader drive) works without one' };
    }
    if (!PORT_SHAPE.test(p)) {
        return { ok: false, why: `"${port}" is not a COM port name, so nothing was flashed` };
    }
    if (!sketch || typeof sketch !== "string") {
        return { ok: false, why: 'flash_device needs {"sketch": "..."} — a folder or .ino inside the linked workspace' };
    }
    if (!root) {
        return { ok: false, why: "no folder is linked to this conversation, and a sketch has to live somewhere this app can read" };
    }
    // resolve INSIDE the workspace: a sketch path is a file path, and file paths
    // are exactly what scope checks exist for
    const full = path.resolve(root, sketch);
    if (!full.toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
        return { ok: false, why: `${sketch} is outside the linked folder` };
    }
    if (!fs.existsSync(full)) return { ok: false, why: `${sketch} does not exist` };
    // arduino-cli builds a SKETCH FOLDER; a bare .ino is addressed by its folder
    const sketchPath = fs.statSync(full).isDirectory() ? full : path.dirname(full);

    // a platformio.ini at the sketch or above it (stopping at the workspace
    // boundary) makes this a PlatformIO project — unless a tool was named
    const tool = sel || (findPioProject(sketchPath, root) ? "platformio" : "arduino");
    if (tool === "platformio") return flashPio(root, sketchPath, { ...args, port: p }, onNote);

    const cli = await toolVersion("arduino-cli", ["version"]);
    if (!cli.present) {
        return { ok: false, needs: "arduino-cli",
                 why: "arduino-cli is not installed — install_toolchain {\"tool\":\"arduino-cli\"} first" };
    }

    let target = fqbn;
    let detected = null;
    if (!target) {
        const d = await detectBoard(p);
        detected = d.ok ? d.match : null;
        target = (detected && detected.fqbn) || null;
    }
    if (!target && board) target = String(board);
    if (!target) {
        return { ok: false, port: p, detected,
                 why: `nothing on ${p} identified itself as a known board, and no fqbn was given. ` +
                      `For a Waveshare ESP32-S3 that is usually esp32:esp32:esp32s3 — ` +
                      `pass it as {"fqbn": "..."} once and it is used exactly as given` };
    }

    const say = typeof onNote === "function" ? onNote : () => {};
    // "how much longer, what is the total we are out of the whole" — a ticker
    // every few seconds with elapsed time, and when this board has compiled
    // before, the percent of last time's total. detail.pct rides the note so
    // the UI can draw a real bar.
    const knownMs = learnedCompileMs(target);
    const compileT0 = Date.now();
    say(knownMs
        ? `compiling for ${target} — took ~${Math.round(knownMs / 1000)}s last time`
        : `compiling for ${target} — first build on this board, no estimate yet; timing it`,
        knownMs ? { pct: 0, etaMs: knownMs } : { indeterminate: true });
    const ticker = etaTicker(say, "compiling", knownMs, compileT0);
    let compile;
    try {
        compile = await run("arduino-cli",
            ["compile", "--fqbn", target, sketchPath], { timeoutMs: RUN_TIMEOUT_MS });
    } finally { clearInterval(ticker); }
    if (compile.ok) rememberCompileMs(target, Date.now() - compileT0);
    if (!compile.ok) {
        return { ok: false, stage: "compile", port: p, fqbn: target,
                 sketch: path.relative(root, sketchPath) || ".",
                 output: ((compile.out || "") + (compile.err || "")).trim().slice(-4000),
                 why: compile.why || "the sketch did not compile — nothing was written to the board" };
    }
    say(`compiled. uploading to ${p}…`);
    // esptool (under arduino-cli) prints "Writing at 0x... ( NN %)" — forward the
    // percentage so the UI draws a bar. Only announce each whole percent once, or
    // a hundred notes an upload floods the transcript.
    let lastPct = -1;
    const upload = await run("arduino-cli",
        ["upload", "-p", p, "--fqbn", target, sketchPath],
        { timeoutMs: RUN_TIMEOUT_MS, onData: (chunk) => {
            const m = /(\d{1,3})(?:\.\d+)?\s*%/.exec(chunk);
            if (m) {
                const pct = Math.min(100, Number(m[1]));
                if (pct !== lastPct) { lastPct = pct; say(`uploading to ${p} — ${pct}%`, { pct }); }
            }
        } });
    if (upload.ok) say(`done — ${p} is running the new sketch`);
    return {
        ok: !!upload.ok, stage: upload.ok ? "done" : "upload",
        port: p, fqbn: target, detectedAs: (detected && detected.name) || null,
        sketch: path.relative(root, sketchPath) || ".",
        compiled: true,
        output: ((upload.out || "") + (upload.err || "")).trim().slice(-4000),
        why: upload.ok ? null
            : (upload.why || `the sketch compiled but did not upload to ${p}`) +
              ". A board that will not take an upload usually needs its BOOT button " +
              "held while it resets, or the port is open in another program."
    };
}

/* ------------------------------- which tool flashes, and the two new legs */

/** The flash tools this app drives. DFU is deliberately ABSENT until a DFU
 *  board is on the bench to prove it against — the {tool} router makes it a
 *  pure append that day, and written-not-proven is not a thing this repo
 *  ships. */
const FLASH_TOOLS = ["arduino", "platformio", "uf2"];

/**
 * WHICH TOOL, FROM THE ARGUMENTS ALONE. Pure on purpose: the auto-detection
 * matrix is proven in tests without a board, a drive, or a spawn. An explicit
 * tool wins; a .uf2 file names uf2; null means the filesystem decides later
 * (a platformio.ini above the sketch → platformio, else arduino).
 */
function resolveFlashToolFromArgs(args = {}) {
    const t = String(args.tool || "").trim().toLowerCase();
    if (t) {
        return FLASH_TOOLS.includes(t) ? t
            : { why: `"${args.tool}" is not a flash tool this app drives. ` +
                     `Choose one of: ${FLASH_TOOLS.join(", ")}` };
    }
    if (/\.uf2$/i.test(String(args.file || "").trim())) return "uf2";
    return null;
}

/**
 * THE DIRECTORY THAT HOLDS platformio.ini — the sketch's own folder first,
 * then parents, stopping at the workspace boundary so detection can never
 * read an ini outside the linked folder. Returns the project dir, or null.
 */
function findPioProject(startDir, root) {
    if (!startDir || !root) return null;
    let dir = path.resolve(startDir);
    const stop = path.resolve(root).toLowerCase();
    while (dir.toLowerCase().startsWith(stop)) {
        try { if (fs.existsSync(path.join(dir, "platformio.ini"))) return dir; } catch { /* unreadable */ }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}

/**
 * FIND pio, WHICH IS OFTEN NOT ON PATH — pip drops the shim into Python's
 * Scripts dir and PlatformIO's own installer uses a private penv. Same house
 * pattern as findEsptool: PATH first, then the places it actually lands, then
 * the bare name so run() reports an honest "not installed".
 */
function findPio() {
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
    for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            const p = path.join(dir, "pio" + ext);
            try { if (fs.existsSync(p)) return { exe: p, args: [] }; } catch { /* unreadable dir */ }
        }
    }
    const home = process.env.USERPROFILE || process.env.HOME || "";
    for (const p of [path.join(home, ".platformio", "penv", "Scripts", "pio.exe"),
                     path.join(home, ".platformio", "penv", "bin", "pio")]) {
        try { if (fs.existsSync(p)) return { exe: p, args: [] }; } catch { /* not installed here */ }
    }
    const shim = process.platform === "win32" ? "pio.exe" : "pio";
    for (const scriptsRoot of [path.join(home, "AppData", "Local", "Programs", "Python"),
                               path.join(home, "AppData", "Roaming", "Python")]) {
        try {
            for (const ver of fs.readdirSync(scriptsRoot)) {
                const p = path.join(scriptsRoot, ver, "Scripts", shim);
                if (fs.existsSync(p)) return { exe: p, args: [] };
            }
        } catch { /* not installed here */ }
    }
    return { exe: shim, args: [] };
}

/**
 * BUILD AND UPLOAD A PLATFORMIO PROJECT — the platformio.ini path. pio prints
 * no overall compile percent, so the bar is elapsed-over-learned (etaTicker)
 * and the MILESTONES are pio's own stage lines, forwarded verbatim — never an
 * invented number. The upload leg gets real percents: esptool, avrdude and
 * friends all print "NN%" under pio.
 */
async function flashPio(root, sketchPath, args, onNote) {
    const say = typeof onNote === "function" ? onNote : () => {};
    const projDir = findPioProject(sketchPath, root);
    if (!projDir) {
        return { ok: false, tool: "platformio",
                 why: `no platformio.ini above ${args.sketch} — this is not a PlatformIO ` +
                      `project. For an .ino sketch leave tool out or pass {"tool": "arduino"}` };
    }
    const pio = findPio();
    const present = await toolVersion(pio.exe, [...pio.args, "--version"]);
    if (!present.present) {
        return { ok: false, needs: "platformio", tool: "platformio",
                 why: 'platformio is not installed — install_toolchain {"tool": "platformio"} first' };
    }
    const p = String(args.port || "").trim().toUpperCase();
    const env = String(args.env || "").trim() || null;
    const key = "platformio:" + (env || path.basename(projDir));
    const knownMs = learnedMs(key);
    const t0 = Date.now();
    say(knownMs
        ? `building with platformio — took ~${Math.round(knownMs / 1000)}s last time`
        : `building with platformio — first build of this project, no estimate yet; timing it`,
        knownMs ? { pct: 0, etaMs: knownMs } : { indeterminate: true });
    let stage = "";
    const ticker = etaTicker(say, "building", knownMs, t0);
    let build;
    try {
        build = await run(pio.exe, [...pio.args, "run", "-d", projDir, ...(env ? ["-e", env] : [])],
            { timeoutMs: RUN_TIMEOUT_MS, onData: (chunk) => {
                // pio's own stage lines are the real milestones — forward each
                // stage change once, never a percent it did not print
                const m = /^(Processing|Compiling|Linking|Building|Retrieving|Checking)\b.*/m.exec(chunk);
                if (m && m[1] !== stage) { stage = m[1]; say(`building — ${m[0].trim().slice(0, 80)}`); }
            } });
    } finally { clearInterval(ticker); }
    if (build.ok) rememberMs(key, Date.now() - t0);
    if (!build.ok) {
        return { ok: false, stage: "compile", tool: "platformio",
                 project: path.relative(root, projDir) || ".", env,
                 output: ((build.out || "") + (build.err || "")).trim().slice(-4000),
                 why: build.why || "the project did not build — nothing was written to the board" };
    }
    say(`built. uploading to ${p}…`);
    let lastPct = -1;
    const upload = await run(pio.exe,
        [...pio.args, "run", "-d", projDir, ...(env ? ["-e", env] : []),
         "-t", "upload", "--upload-port", p],
        { timeoutMs: RUN_TIMEOUT_MS, onData: (chunk) => {
            const m = /(\d{1,3})(?:\.\d+)?\s*%/.exec(chunk);
            if (m) {
                const pct = Math.min(100, Number(m[1]));
                if (pct !== lastPct) { lastPct = pct; say(`uploading — ${pct}%`, { pct }); }
            }
        } });
    if (upload.ok) say(`done — ${p} is running the new firmware`);
    return {
        ok: !!upload.ok, stage: upload.ok ? "done" : "upload", tool: "platformio",
        port: p, project: path.relative(root, projDir) || ".", env,
        compiled: true,
        output: ((upload.out || "") + (upload.err || "")).trim().slice(-4000),
        why: upload.ok ? null
            : (upload.why || `the project built but did not upload to ${p}`) +
              ". A board that will not take an upload usually needs its BOOT button " +
              "held while it resets, or the port is open in another program."
    };
}

/* ------------------------------------------------------------- UF2 drop */

/** Pull Model: and Board-ID: out of an INFO_UF2.TXT. Pure — the parse is
 *  provable without a drive, and the fields are reported verbatim. */
function parseUf2Info(text) {
    const t = String(text || "");
    const model = (/Model:[ \t]*([^\r\n]+)/.exec(t) || [])[1];
    const boardId = (/Board-ID:[ \t]*([^\r\n]+)/.exec(t) || [])[1];
    return { model: model ? model.trim() : null, boardId: boardId ? boardId.trim() : null };
}

/**
 * PICK THE DRIVE. Pure — zero, one, many, and the caller's choice are all
 * decided here, against the DETECTED list only: a drive argument chooses
 * between found bootloaders and is never taken as a raw path to write to —
 * the same allowlist spirit as PORT_SHAPE.
 */
function chooseUf2Drive(drives, wanted) {
    const list = Array.isArray(drives) ? drives : [];
    let want = String(wanted || "").trim().toUpperCase().replace(/[\\/]+$/, "");
    if (/^[A-Z]$/.test(want)) want += ":";
    if (want) {
        const hit = list.find(d => d && d.drive === want);
        return hit ? { ok: true, drive: hit }
            : { ok: false,
                why: `"${wanted}" is not a UF2 bootloader drive on this machine` +
                     (list.length
                        ? ` — detected: ${list.map(d => d.drive).join(", ")}`
                        : " — none are mounted") };
    }
    if (list.length === 0) {
        return { ok: false,
                 why: "no UF2 bootloader drive is mounted — hold BOOTSEL (or double-tap " +
                      "reset) while plugging the board in, then call this again" };
    }
    if (list.length > 1) {
        return { ok: false,
                 why: `${list.length} UF2 bootloader drives are mounted (` +
                      list.map(d => d.drive + (d.model ? " " + d.model : "")).join("; ") +
                      `) — pass {"drive": "${list[0].drive}"} to choose one` };
    }
    return { ok: true, drive: list[0] };
}

/**
 * THE DRIVES A UF2 BOOTLOADER MOUNTS. DriveType=2 is removable; INFO_UF2.TXT
 * at the root is the definitive marker (wmic is deprecated on Windows 11 —
 * CIM is the supported door). Model and Board-ID come back verbatim.
 */
async function listUf2Drives() {
    const r = await run(SHELL.exe, ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | ForEach-Object { $_.DeviceID }"],
        { timeoutMs: 20_000 });
    const drives = [];
    for (const id of (r.out || "").split(/\r?\n/).map(s => s.trim()).filter(s => /^[A-Z]:$/i.test(s))) {
        try {
            const info = fs.readFileSync(path.join(id.toUpperCase() + "\\", "INFO_UF2.TXT"), "utf8");
            drives.push({ drive: id.toUpperCase(), ...parseUf2Info(info) });
        } catch { /* removable, but not a UF2 bootloader */ }
    }
    return drives;
}

/**
 * COPY A .uf2 TO A BOOTLOADER DRIVE. Every number here is measured: the
 * percent is bytes written over bytes in the file, and success is the drive
 * DETACHING — a UF2 bootloader accepts a file by rebooting out of
 * mass-storage. A copy that completes without a detach is said honestly,
 * never claimed as a flash.
 */
async function flashUf2(root, args, onNote) {
    const say = typeof onNote === "function" ? onNote : () => {};
    if (!args.file || typeof args.file !== "string") {
        return { ok: false, tool: "uf2",
                 why: 'uf2 needs {"file": "..."} — a .uf2 firmware file inside the linked workspace' };
    }
    if (!root) {
        return { ok: false, tool: "uf2",
                 why: "no folder is linked to this conversation, and a firmware file has to " +
                      "live somewhere this app can read" };
    }
    const full = path.resolve(root, args.file);
    if (!full.toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
        return { ok: false, tool: "uf2", why: `${args.file} is outside the linked folder` };
    }
    if (!fs.existsSync(full)) return { ok: false, tool: "uf2", why: `${args.file} does not exist` };
    if (!/\.uf2$/i.test(full)) {
        return { ok: false, tool: "uf2",
                 why: `${args.file} is not a .uf2 file — a UF2 bootloader takes only its own format` };
    }
    const drives = await listUf2Drives();
    const pick = chooseUf2Drive(drives, args.drive);
    if (!pick.ok) return { ok: false, tool: "uf2", why: pick.why };
    const drive = pick.drive;
    const size = fs.statSync(full).size || 1;
    say(`copying ${path.basename(full)} (${Math.round(size / 1024)}KB) to ${drive.drive}` +
        (drive.model ? ` — ${drive.model}` : ""), { pct: 0 });
    const dest = path.join(drive.drive + "\\", path.basename(full));
    let written = 0, lastPct = -1;
    try {
        await new Promise((resolve, reject) => {
            const src = fs.createReadStream(full, { highWaterMark: 64 * 1024 });
            const out = fs.createWriteStream(dest);
            src.on("data", (chunk) => {
                written += chunk.length;
                // a REAL percent: bytes on the wire over bytes in the file
                const pct = Math.round((written / size) * 100);
                if (pct !== lastPct) { lastPct = pct; say(`copying to ${drive.drive} — ${pct}%`, { pct }); }
            });
            src.on("error", reject);
            out.on("error", reject);
            out.on("close", resolve);
            src.pipe(out);
        });
    } catch (e) {
        return { ok: false, tool: "uf2", drive: drive.drive, bytes: written,
                 why: `the copy failed at ${Math.round((written / size) * 100)}% — ${e.message}. ` +
                      "A bootloader drive that vanishes mid-copy usually rebooted early; " +
                      "re-enter the bootloader and call this again" };
    }
    // the bootloader ACCEPTS a UF2 by rebooting out of mass-storage — watch
    // the marker file disappear rather than assuming
    const marker = path.join(drive.drive + "\\", "INFO_UF2.TXT");
    let detached = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try { fs.accessSync(marker); } catch { detached = true; break; }
        await new Promise(res => setTimeout(res, 500));
    }
    if (detached) say(`done — ${drive.drive} detached; the board rebooted into the new firmware`);
    return {
        ok: detached, tool: "uf2", stage: detached ? "done" : "copied",
        drive: drive.drive, model: drive.model || null, boardId: drive.boardId || null,
        file: path.relative(root, full).replace(/\\/g, "/"), bytes: written,
        detached,
        note: detached
            ? "the drive detached — the bootloader accepted the file and the board rebooted"
            : null,
        why: detached ? null
            : "the copy completed but the drive did not detach — the bootloader may have " +
              "rejected this UF2 family; check the board's family ID against the file"
    };
}

/* ------------------------------------------------------------------ tools */

const SERIAL_WRITE_ENTRY = {
    run: async (_root, args = {}) => serialWrite(args.port, args.data, {
        baud: args.baud, newline: asBool(args.newline, true), readMs: args.read_ms
    }),
    help: 'serial_write {port, data, baud?, newline?, read_ms?} — send text to a ' +
          'serial device (COM10) and read its reply, for a board that takes ' +
          'commands (AT, a REPL, a firmware menu).'
};

const SERIAL_READ_ENTRY = {
    run: async (_root, args = {}) => serialRead(args.port, {
        baud: args.baud, ms: args.ms, reset: asBool(args.reset, false)
    }),
    help: 'serial_read {port, baud?, ms?, reset?} — listen to one serial port ' +
          '(COM10) and return what it says. reset:true pulses reset first, so an ' +
          'ESP32 (74880 baud) prints its boot log. This is "what is this board ' +
          'saying"; inspect_devices is "what is plugged in".'
};

const INSTALL_TOOLCHAIN_ENTRY = {
    run: async (_root, args = {}) => installToolchain(args.tool),
    help: 'install_toolchain {tool} — install a board toolchain on THIS machine: ' +
          '"arduino-cli", "esp32-core" (needs arduino-cli), "esptool", or ' +
          '"platformio". Only these four, from their vendors, never an arbitrary URL.'
};

const FLASH_DEVICE_ENTRY = {
    run: async (root, args = {}, ctx = {}) => flashDevice(root, args, ctx && ctx.onNote),
    help: 'flash_device {port?, sketch?, tool?, fqbn?, file?, env?, drive?} — ' +
          'compile and upload firmware in one action. Paths: arduino (sketch ' +
          '.ino/folder + port; fqbn auto-detected), platformio (auto when a ' +
          'platformio.ini is present; env picks the environment), uf2 (file .uf2 ' +
          'copied to a mounted bootloader drive; no port). Omit tool to auto-detect. ' +
          'On a build failure nothing is written to the board.'
};

/* ============================================ what the board says it IS === */

/**
 * FIND esptool, WHICH IS NOT ON PATH — it ships INSIDE the ESP32 Arduino core.
 *
 * When .lcl installs the esp32 core (install_toolchain), esptool lands under
 * the Arduino package tree, versioned. A model that just runs "esptool" gets
 * ENOENT and concludes the board cannot be read. This looks where it actually
 * is, on Windows and on a Linux node both, then falls back to a pip install.
 */
function findEsptool() {
    // 1. straight on PATH
    // 2. bundled with the arduino-cli esp32 core (the common case here)
    // 3. python module
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const roots = [
        path.join(home, "AppData", "Local", "Arduino15", "packages", "esp32",
                  "tools", "esptool_py"),
        path.join(home, ".arduino15", "packages", "esp32", "tools", "esptool_py")
    ];
    for (const root of roots) {
        try {
            for (const ver of fs.readdirSync(root)) {
                for (const name of ["esptool.exe", "esptool", "esptool.py"]) {
                    const p = path.join(root, ver, name);
                    if (fs.existsSync(p)) return { exe: p, args: [] };
                }
            }
        } catch { /* not installed here */ }
    }
    return { exe: process.platform === "win32" ? "esptool.exe" : "esptool", args: [] };
}

/** The ESP-IDF app descriptor lives 0x20 into the app partition (0x10000). */
function parseAppDescriptor(buf) {
    // magic 0xabcd5432 marks a real esp_app_desc_t; without it this is not an
    // ESP-IDF app (a bare Arduino sketch has no descriptor) and we say so
    if (!buf || buf.length < 0xa0) return null;
    if (buf.readUInt32LE(0x20) !== 0xabcd5432) return null;
    const str = (off, len) => buf.slice(off, off + len)
        .toString("latin1").replace(/\u0000.*$/s, "").trim();
    return {
        version: str(0x30, 32),
        project: str(0x50, 32),
        time: str(0x70, 16),
        date: str(0x80, 16),
        idfVersion: str(0x90, 32)
    };
}

/* Driver / sensor / radio tokens worth surfacing from a boot log, and the one
   that matters most: the DISPLAY controller, because that is what a sketch has
   to target and what vendors mislabel. */
const IDENTITY_PATTERNS = [
    { key: "display", re: /\b(st77\d\d\w*|sh8601|gc9\w+|ili9\w+|co5300|nv3041\w*|ssd13\d\d)\b/i },
    { key: "imu",     re: /\b(qmi8658|mpu6050|mpu9250|bmi\d\d\d|icm\d\d\d\d\d|lsm6\w+)\b/i },
    { key: "radio",   re: /\b(BLE_INIT|GATTC?_DEMO|esp_wifi|wifi:|Bluetooth MAC|phy_init)\b/i },
    { key: "audio",   re: /\b(es8311|es7210|max98357|i2s|pdm)\b/i }
];

/**
 * IDENTIFY A BOARD FROM THE HARDWARE ITSELF, not from a product page.
 *
 * One board's product page said ST7789V2 over SPI. Its own firmware said
 * sh8601 and its project was literally named ST7789_Demo — two vendor mislabels
 * on one device. Trusting either would have burned a day of black screens. The
 * board does not lie: the app descriptor in flash and the boot log on the wire
 * are the ground truth, and where they DISAGREE with each other this says so.
 */
async function identifyBoard(port) {
    const p = String(port || "").trim().toUpperCase();
    if (!PORT_SHAPE.test(p)) {
        return { ok: false, why: `"${port}" is not a COM port name` };
    }
    const et = findEsptool();
    const out = { ok: true, port: p, chip: null, flashSize: null,
                  app: null, bootLog: {}, warnings: [] };

    // 1. the app descriptor, which also makes esptool print the chip on connect
    const tmp = path.join(require("os").tmpdir(),
        "lcl-appdesc-" + p + "-" + process.pid + ".bin");
    const rd = await run(et.exe,
        [...et.args, "--port", p, "--baud", "460800", "read-flash",
         "0x10000", "0x120", tmp], { timeoutMs: 90_000 });
    // esptool v5 prints "Chip type: ESP32-S3"; older prints "Chip is ..."
    const blob = (rd.out || "") + (rd.err || "");
    const chipM = /Chip (?:is|type:)\s+(ESP32[\w-]*)/i.exec(blob);
    if (chipM) out.chip = chipM[1];
    // Features names the radios and PSRAM — exactly what decides whether a board
    // can be a wifi/ble voice node, so surface it verbatim
    const featM = /Features:\s+([^\r\n]+)/i.exec(blob);
    if (featM) out.features = featM[1].trim();
    const flashM = /(?:Flash size|Detected flash size):\s+(\d+\s?\w?B)/i.exec(blob) ||
        /PSRAM (\d+\s?\wB)/i.exec(out.features || "");
    if (flashM) out.flashSize = flashM[1];
    if (!rd.started) {
        return { ok: false, port: p,
                 why: "esptool could not run: " + (rd.why || "unknown") +
                      ". Install the esp32 core first (install_toolchain esp32-core), " +
                      "or close whatever holds " + p + "." };
    }
    try {
        if (fs.existsSync(tmp)) {
            out.app = parseAppDescriptor(fs.readFileSync(tmp));
            fs.unlinkSync(tmp);
        }
    } catch { /* descriptor unreadable; the boot log still identifies it */ }

    // 2. the boot log — reset and listen, then pull the identity lines out
    const log = await serialRead(p, { ms: 5000, reset: true });
    const clean = (log.data || "").replace(/\u001b\[[0-9;]*m/g, "");
    for (const pat of IDENTITY_PATTERNS) {
        const m = pat.re.exec(clean);
        if (m) out.bootLog[pat.key] = m[0];
    }
    // the BLE MAC is a genuine unique id — worth returning verbatim
    const mac = /Bluetooth MAC: ([0-9a-f:]{17})/i.exec(clean);
    if (mac) out.bootLog.bleMac = mac[1];
    out.bootLogSample = clean.split("\n")
        .filter(l => l.trim() && !/^\s*$/.test(l)).slice(0, 24).join("\n").slice(0, 3000);

    // 3. THE MISLABEL DETECTOR. If the app project name carries a display-driver
    //    token and the boot log names a DIFFERENT one, the paperwork is wrong —
    //    which is exactly that case. Say it loudly; it decides which sketch works.
    const nameDriver = out.app && IDENTITY_PATTERNS[0].re.exec(out.app.project || "");
    if (nameDriver && out.bootLog.display &&
        nameDriver[0].toLowerCase() !== out.bootLog.display.toLowerCase()) {
        out.warnings.push(
            `MISLABEL: the firmware project is named "${out.app.project}" ` +
            `(implies ${nameDriver[0]}) but the running driver is ` +
            `${out.bootLog.display}. Trust the boot log — ${out.bootLog.display} ` +
            "is what the display actually is.");
    }
    if (out.app && /demo|test|factory/i.test(out.app.project) && out.bootLog.display) {
        out.note = `factory firmware (${out.app.project}) — flashing your own ` +
            "sketch replaces it. Back it up first with backup_firmware if you " +
            "want it recoverable.";
    }
    return out;
}

/**
 * COPY THE WHOLE FLASH TO A FILE, before a flash_device overwrites it.
 *
 * Every board here ships factory firmware the operator may want back — the
 * AMOLED demo, an IMU calibration, a BLE stack. read-flash is non-destructive
 * and the file goes in the linked workspace, scoped like every other write.
 */
/** Where a backup file lands, and whether the name is safe — no board involved. */
function backupTarget(root, name, port) {
    if (!root) return { ok: false, why: "no folder is linked — a backup has to be written somewhere this app can read" };
    // strip every path character: a name can never become a directory traversal
    const fname = (String(name || "").replace(/[^\w.-]/g, "").replace(/\.\.+/g, ".")
                   || ("firmware-backup-" + String(port || "dev") + ".bin"));
    const dir = path.join(root, "firmware-backup");
    const full = path.join(dir, fname);
    if (!path.resolve(full).toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
        return { ok: false, why: "the backup path escapes the linked folder" };
    }
    return { ok: true, dir, full, rel: path.relative(root, full).replace(/\\/g, "/") };
}

async function backupFirmware(root, { port, sizeBytes = 0, name = null } = {}) {
    const p = String(port || "").trim().toUpperCase();
    if (!PORT_SHAPE.test(p)) return { ok: false, why: `"${port}" is not a COM port name` };
    if (!root) return { ok: false, why: "no folder is linked — a backup has to be written somewhere this app can read" };
    const tgt = backupTarget(root, name, p);
    if (!tgt.ok) return tgt;
    const { dir, full } = tgt;
    const et = findEsptool();
    let size = Number(sizeBytes) > 0 ? Number(sizeBytes) : 16 * 1024 * 1024;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const r = await run(et.exe,
        [...et.args, "--port", p, "--baud", "921600", "read-flash",
         "0x0", "0x" + size.toString(16), full], { timeoutMs: 900_000 });
    if (!r.ok && !fs.existsSync(full)) {
        return { ok: false, port: p, why: r.why || "read-flash did not complete" };
    }
    let bytes = 0; try { bytes = fs.statSync(full).size; } catch { /* */ }
    return { ok: bytes > 0, port: p,
             file: path.relative(root, full).replace(/\\/g, "/"),
             bytes, mb: Math.round(bytes / 1048576),
             note: bytes > 0
                ? "full flash saved — flash your own sketch freely; restore with " +
                  "esptool write-flash 0x0 " + path.relative(root, full).replace(/\\/g, "/")
                : "nothing was written" };
}

const BOARD_IDENTIFY_ENTRY = {
    run: async (_root, args = {}) => identifyBoard(args.port),
    help: 'board_identify {port} — read what a board ACTUALLY is from its flash ' +
          'and boot log (chip, flash size, ESP-IDF app descriptor, named ' +
          'peripherals) and flag vendor mislabels. Needs esptool. Non-destructive, ' +
          'but RESETS the board to read it.'
};

const BACKUP_FIRMWARE_ENTRY = {
    run: async (root, args = {}) => backupFirmware(root, args),
    help: 'backup_firmware {port, sizeBytes?, name?} — copy a board\'s ENTIRE flash ' +
          'to a file in the workspace BEFORE you overwrite it, so factory firmware ' +
          'stays recoverable. Defaults to 16MB. Non-destructive read.'
};

module.exports = {
    serialWrite, installToolchain, flashDevice, detectBoard, toolVersion, run,
    TOOLCHAINS, PORT_SHAPE, DEFAULT_BAUD, SHELL,
    serialRead, asBool, identifyBoard, backupFirmware, backupTarget, findEsptool, parseAppDescriptor,
    resolveFlashToolFromArgs, findPioProject, findPio, FLASH_TOOLS, flashPio, flashUf2,
    parseUf2Info, chooseUf2Drive, listUf2Drives,
    learnedMs, rememberMs, learnedCompileMs, rememberCompileMs, etaTicker,
    SERIAL_WRITE_ENTRY, SERIAL_READ_ENTRY, INSTALL_TOOLCHAIN_ENTRY, FLASH_DEVICE_ENTRY,
    BOARD_IDENTIFY_ENTRY, BACKUP_FIRMWARE_ENTRY
};
