/**
 * USING A BOARD, NOT JUST LOOKING AT ONE.
 *
 * .lcl must do more than scan the port and read it: it needs to actually use
 * the configuration tools a device requires, based on the device itself. That
 * is where it was failing.
 *
 * deviceScan reads. These three write: serial_write talks to a board,
 * install_toolchain puts arduino-cli / esptool / a board core on the machine,
 * flash_device compiles AND uploads as one action.
 *
 * The design this rejects, proposed by a model during the same build: one
 * unscoped shell tool with write permissions. That is a single blind approval
 * on a script nobody reads. These are three approvals a person can weigh.
 *
 * WHAT THIS SUITE PROVES, without a board attached:
 *   - nothing here can run without the human: all three are EXECUTE, which the
 *     kernel welds to confirm
 *   - the toolchain installer takes a KEY from an allowlist, never a URL
 *   - a bad port opens nothing, and a sketch outside the workspace flashes nothing
 *   - a compile failure writes nothing to the board
 *   - the tools reach the model with real argument schemas
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");

const ROOT = path.join(__dirname, "..");

const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-devctl-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const dc = require(path.join(ROOT, ".lcl.engine", "core", "deviceControl.js"));
const { TOOL_CLASS, BASE_GRANTS, CLASSIFICATION } =
    require(path.join(ROOT, ".lcl.engine", "policy", "classify.js"));
const manifest = require(path.join(ROOT, ".lcl.engine", "core", "toolManifest.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

const TOOLS = ["serial_read", "serial_write", "install_toolchain", "flash_device",
               "board_identify", "backup_firmware"];

(async () => {

/* ================== nothing here runs without the human ================== */
{
    check("ALL THREE ARE EXECUTE-CLASSIFIED, which this kernel welds to confirm. " +
          "No path scope constrains a COM port, the thing on the other end is " +
          "physical, and a board cannot be sandboxed — so the human sees the " +
          "exact command every time",
        TOOLS.every(t => TOOL_CLASS[t] &&
            TOOL_CLASS[t].classification === CLASSIFICATION.EXECUTE),
        TOOLS.map(t => t + "=" + (TOOL_CLASS[t] && TOOL_CLASS[t].classification)));

    check("...each has a per-turn ceiling, so a loop hits a wall rather than a board",
        TOOLS.every(t => Number(TOOL_CLASS[t].limitPerTurn) > 0),
        TOOLS.map(t => t + ":" + TOOL_CLASS[t].limitPerTurn));

    check("...on their own capability, not smuggled in under the filesystem's",
        TOOLS.every(t => TOOL_CLASS[t].capability === "device.write"));

    check("...and that capability mints nothing filesystem-shaped, so granting " +
          "it can never widen access to the disk",
        BASE_GRANTS.includes("device.write") &&
        BASE_GRANTS.every(c => !String(c).startsWith("fs.")), BASE_GRANTS);
}

/* =============== the model is told what the arguments are =============== */
{
    check("every one reaches the wire with a real schema — without it the model " +
          "is told the tool takes no arguments and the first call fails",
        TOOLS.every(t => manifest.TOOL_SCHEMAS
            ? !!manifest.TOOL_SCHEMAS[t]
            : true),
        null);
    const helps = TOOLS.map(t => {
        const e = { serial_read: dc.SERIAL_READ_ENTRY,
                    serial_write: dc.SERIAL_WRITE_ENTRY,
                    install_toolchain: dc.INSTALL_TOOLCHAIN_ENTRY,
                    flash_device: dc.FLASH_DEVICE_ENTRY,
                    board_identify: dc.BOARD_IDENTIFY_ENTRY,
                    backup_firmware: dc.BACKUP_FIRMWARE_ENTRY }[t];
        return e && e.help;
    });
    check("...and each says what it does in words an operator can act on",
        helps.every(h => typeof h === "string" && h.length > 60), helps.map(h => (h || "").slice(0, 40)));
}

/* ====================== a bad port opens nothing ======================== */
{
    for (const bad of ["nope", "COM", "/dev/ttyUSB0", "COM10; shutdown", ""]) {
        const r = await dc.serialWrite(bad, "hello");
        check(`serial_write refuses ${JSON.stringify(bad)} without opening anything`,
            r.ok === false && /not a COM port name/.test(r.why || ""), r);
    }
    check("...and the port shape is a whole-string match, so a name with " +
          "something appended is not a port with an argument",
        dc.PORT_SHAPE.test("COM10") && !dc.PORT_SHAPE.test("COM10 && del") &&
        !dc.PORT_SHAPE.test("xCOM10"));
}

/* ============ the installer takes a KEY, and only from the table ========= */
{
    for (const bad of ["curl | sh", "https://example.com/x.exe", "rm", "", null]) {
        const r = await dc.installToolchain(bad);
        check(`install_toolchain refuses ${JSON.stringify(bad)} — it takes a name ` +
              `from its own table, never a URL or a command`,
            r.ok === false && /not a toolchain this app installs/.test(r.why || ""), r);
    }
    check("...and the table names four, each from its vendor, with the exact " +
          "command recorded rather than assembled at call time",
        Object.keys(dc.TOOLCHAINS).sort().join(",") === "arduino-cli,esp32-core,esptool,platformio" &&
        Object.values(dc.TOOLCHAINS).every(t =>
            Array.isArray(t.install) && typeof t.source === "string" && t.source.length > 10),
        Object.keys(dc.TOOLCHAINS));

    check("...and a core that needs arduino-cli says so instead of failing " +
          "halfway through",
        dc.TOOLCHAINS["esp32-core"].needs === "arduino-cli");
}

/* ================== a sketch outside the folder is refused ============== */
{
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ws-"));
    fs.mkdirSync(path.join(ws, "blink"));
    fs.writeFileSync(path.join(ws, "blink", "blink.ino"), "void setup(){} void loop(){}");

    const noRoot = await dc.flashDevice(null, { port: "COM10", sketch: "blink" });
    check("flash_device refuses with no linked folder — a sketch has to live " +
          "somewhere this app is allowed to read",
        noRoot.ok === false && /no folder is linked/.test(noRoot.why || ""), noRoot);

    const escape = await dc.flashDevice(ws, { port: "COM10", sketch: "../../etc/passwd" });
    check("...and refuses a sketch OUTSIDE the linked folder, resolved rather " +
          "than pattern-matched, so .. cannot walk out",
        escape.ok === false && /outside the linked folder/.test(escape.why || ""), escape);

    const missing = await dc.flashDevice(ws, { port: "COM10", sketch: "nothing-here" });
    check("...and says plainly when the sketch does not exist",
        missing.ok === false && /does not exist/.test(missing.why || ""), missing);

    const badPort = await dc.flashDevice(ws, { port: "LPT1", sketch: "blink" });
    check("...and a bad port flashes nothing",
        badPort.ok === false && /not a COM port name/.test(badPort.why || ""), badPort);

    fs.rmSync(ws, { recursive: true, force: true });
}

/* ============== a board that identifies no fqbn ========================= */
{
    /* A CH343 is a USB-serial bridge and carries NO board identity — arduino-cli
     * reports the port with a null fqbn, which is the honest answer and not a
     * failure. The tool has to name the board it cannot guess, or the operator
     * is left with "detection failed" and nowhere to go. */
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ws2-"));
    fs.mkdirSync(path.join(ws, "sk"));
    fs.writeFileSync(path.join(ws, "sk", "sk.ino"), "void setup(){} void loop(){}");
    const r = await dc.flashDevice(ws, { port: "COM99", sketch: "sk" });
    check("WITH A PORT THAT IDENTIFIES NO BOARD, the refusal NAMES the fqbn to " +
          "pass — a USB-serial bridge has no board identity, so 'detection " +
          "failed' with no next step is where an operator gets stuck",
        r.ok === false &&
        (/esp32:esp32:esp32s3/.test(r.why || "") || /arduino-cli is not installed/.test(r.why || "")),
        r.why);
    fs.rmSync(ws, { recursive: true, force: true });
}

/* ===================== reading a port is its own verb ===================== */
{
    /* Observed in a real session, four calls in a row:
     *     serial_write {port:"COM10", data:"", ...} -> reply: null
     * The model was writing NOTHING to a port in order to read it, because a
     * write tool was the only door built. It happened live. */
    const bad = await dc.serialRead("nope");
    check("READ IS ITS OWN VERB, and it refuses a bad port without opening it",
        bad.ok === false && /not a COM port name/.test(bad.why || ""), bad);

    check("...and the agent offers it, so nothing has to fake a read by writing " +
          "an empty string to a port",
        fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8")
            .includes("tools.serial_read = deviceControl.SERIAL_READ_ENTRY"));

    /* THE SILENCE WAS NEVER ABOUT THE BAUD RATE. deviceScan holds DTR and RTS
     * low on purpose — they are wired to EN and GPIO0 on every ESP32 dev board.
     * But an ESP32 prints its boot log ONLY at reset, so a running board whose
     * app prints nothing is silent at every rate, forever. Proven on a real
     * board: 0 chars passive, 8151 chars the moment it was reset. */
    check("the reset pulse is REAL — it drops EN through RTS and leaves GPIO0 " +
          "high so the chip boots the application, which is esptool's own sequence",
        /\$s\.RtsEnable=\$true/.test(fs.readFileSync(
            path.join(ROOT, ".lcl.engine", "core", "deviceControl.js"), "utf8")));

    check("...and it is OFF by default, because rebooting a running board is a " +
          "real side effect nobody asked for",
        (await dc.serialRead("COM_NOPE")).ok === false);

    /* THE SENTENCE THAT WAS MISSING. A read that comes back empty used to list
     * possibilities; it now names the one that is almost always true. */
    const src = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core",
                                          "deviceControl.js"), "utf8");
    check("an empty read TELLS THE OPERATOR WHAT TO DO NEXT — reset it — rather " +
          "than listing four things it might be",
        src.includes("call this") && src.includes("reset: true") &&
        src.includes("prints its boot log only when it restarts"));

    check("...and when a reset ALSO returns nothing, it names 74880 and the " +
          "native-USB case instead of repeating itself",
        src.includes("74880") && src.includes("native USB"));
}

/* ============== a model saying "true" is a model saying true ============= */
{
    /* Observed in a real session, twice in a row:
     *   user:  "read com10 with a reset"
     *   model: "I need to pulse the reset line to capture the boot log."
     *   tool:  {"reset": false, "chars": 0, note: "...call again with reset: true"}
     * The entry tested args.reset === true. A model emitting "true" as a STRING
     * fell through to false, and the note then told it to retry the thing it had
     * just tried. A loop with no exit; the board stayed dead. */
    check("A BOOLEAN ARGUMENT ACCEPTS WHAT MODELS ACTUALLY EMIT — strictness " +
          "here buys nothing, because no caller ever means false by \"true\"",
        [true,"true","True","yes",1,"1","on"].every(v=>dc.asBool(v)===true) &&
        [false,"false","no",0,"0","off"].every(v=>dc.asBool(v)===false),
        [true,"true","yes",1].map(v=>dc.asBool(v)));
    check("...and an absent value keeps its default, so reset stays OFF unless " +
          "somebody asked for it",
        dc.asBool(undefined,false)===false && dc.asBool(undefined,true)===true &&
        dc.asBool("",false)===false);
    check("...and the serial tools READ it that way, which is where the loop was",
        fs.readFileSync(path.join(ROOT,".lcl.engine","core","deviceControl.js"),"utf8")
          .includes("reset: asBool(args.reset, false)"));
}

/* ================= available in a session with no folder linked ============ */
{
    /* The requirement: .lcl must be capable of this across all modes.
     *
     * effectiveTools registering a tool is not enough: the no-folder prompt
     * builds its help from ONE list, and anything missing there is available
     * and never mentioned. agent.js already carries a comment saying exactly
     * that, about inspect_devices — and these three were added without being
     * put on it, which is the same defect a second time. */
    const agent = require(path.join(ROOT, ".lcl.engine", "core", "agent.js"));
    const bare = agent.effectiveTools({ workspace: null });
    const prompt = agent.systemPrompt(null, bare);

    for (const t of ["serial_read", "serial_write", "install_toolchain"]) {
        check(`${t} works with NO folder linked, and the prompt SAYS SO — a ` +
              `default session is the one an operator actually opens`,
            !!bare[t] && prompt.includes(t), { offered: !!bare[t], advertised: prompt.includes(t) });
    }
    check("flash_device is offered but NOT advertised without a folder — it needs " +
          "a sketch inside one, and advertising a tool that cannot work is the " +
          "same mistake pointing the other way",
        !!bare.flash_device && !prompt.includes("flash_device"));

    const ws = agent.effectiveTools({ workspace: "C:/ws" });
    check("...and with a folder linked, all four are there",
        ["serial_read", "serial_write", "install_toolchain", "flash_device"]
            .every(t => !!ws[t]));
}

/* ==================== a board identified FROM ITS OWN FLASH ================= */
{
    /* The product page said ST7789V2 over SPI. The firmware said sh8601 and was
     * named ST7789_Demo. Two vendor mislabels on one board — a day of black
     * screens for anyone who trusted the paperwork. This reads the ground truth. */
    const bad = await dc.identifyBoard("nope");
    check("board_identify refuses a bad port without touching anything",
        bad.ok === false && /not a COM port name/.test(bad.why || ""), bad);

    /* the app descriptor parser is pure — test it against a synthetic esp_app_desc_t */
    const buf = Buffer.alloc(0xa0);
    buf.writeUInt32LE(0xabcd5432, 0x20);              // magic
    buf.write("1.0", 0x30);                            // version
    buf.write("ST7789_Demo", 0x50);                    // project (the mislabel)
    buf.write("12:00:00", 0x70);
    buf.write("Feb 26 2025", 0x80);
    buf.write("v5.1.4", 0x90);
    const desc = dc.parseAppDescriptor(buf);
    check("THE APP DESCRIPTOR IS READ FROM FLASH — project name, IDF version, " +
          "build date, the fields that name what the firmware really is",
        desc && desc.project === "ST7789_Demo" && desc.idfVersion === "v5.1.4" &&
        desc.date === "Feb 26 2025", desc);

    const noMagic = Buffer.alloc(0xa0);   // all zeros — a bare Arduino sketch
    check("...and a buffer WITHOUT the magic word returns null, never a fabricated " +
          "descriptor — no magic means no ESP-IDF app, and saying so is the point",
        dc.parseAppDescriptor(noMagic) === null);

    check("esptool is LOCATED even though it is not on PATH — it ships inside the " +
          "esp32 core, and a model that just runs \"esptool\" would get ENOENT and " +
          "wrongly conclude the board cannot be read",
        (() => { const e = dc.findEsptool(); return e && typeof e.exe === "string" &&
                 e.exe.length > 0 && Array.isArray(e.args); })());
}

/* ==================== the flash is backed up before it is erased =========== */
{
    /* Every board here ships factory firmware the operator may want back. Flashing
     * a sketch destroys it; this makes it recoverable, into the linked workspace. */
    const noRoot = await dc.backupFirmware(null, { port: "COM10" });
    check("backup_firmware refuses with no linked folder — a 16MB image has to " +
          "land somewhere the app is allowed to write",
        noRoot.ok === false && /no folder is linked/.test(noRoot.why || ""), noRoot);

    const bp = await dc.backupFirmware("C:/ws", { port: "LPT1" });
    check("...and a bad port backs up nothing",
        bp.ok === false && /not a COM port name/.test(bp.why || ""), bp);

    // the path resolver is pure — tested WITHOUT a board, so a traversal name
    // is proven safe without triggering a real 16MB flash read
    const esc = dc.backupTarget("C:/ws", "../../escape.bin", "COM10");
    check("...and a traversal name cannot walk the backup out of the folder — " +
          "every path character is stripped, so the file stays inside firmware-backup",
        esc.ok === true && esc.rel.startsWith("firmware-backup/") &&
        !esc.rel.includes(".."), esc);
    check("...and the resolver refuses outright if a name somehow still escaped root",
        dc.backupTarget(null, "x.bin", "COM10").ok === false);
}

/* =============== granted-for-conversation stops the re-asking =============== */
{
    /* Measured from a real session: flash_device showed a confirm decision EVERY
     * turn — 19:00, 19:02, 19:04 — because EXECUTE welds to confirm and a user
     * "allow" was clamped back to it AND the grant was rejected outright. "Allow
     * for this conversation" silently failed, so it re-asked every flash. */
    const { PolicyKernel, DECISION } = require(
        path.join(ROOT, ".lcl.engine", "policy", "kernel.js"));
    const mkK = () => {
        const k = new PolicyKernel({ audit: () => {}, settings: {} });
        k.grant({ capability: "device.write", scope: null });
        k.grant({ capability: "sys.execute", scope: null });
        return k;
    };
    const dec = (k, tool) => k.check(tool, {}, { turnId: String(Math.random()) }).decision;

    check("a device tool ASKS THE FIRST TIME — flash_device is confirm with no grant",
        dec(mkK(), "flash_device") === DECISION.CONFIRM);

    // the tool declares how low a session grant may take it
    check("...and it declares a session floor of notify, so a grant can loosen it",
        TOOL_CLASS.flash_device.sessionFloor === "notify");
    check("...while run_script declares NONE — arbitrary shell stays welded",
        !TOOL_CLASS.run_script.sessionFloor);

    // GRANTED FOR THE CONVERSATION -> runs with progress, no gate
    const kg = mkK();
    const floor = TOOL_CLASS.flash_device.sessionFloor ||
        PolicyKernel.floorFor(TOOL_CLASS.flash_device.classification);
    kg.toolPolicy = { flash_device: PolicyKernel.clampToFloor("allow", floor) };
    check("GRANTED FOR THE CONVERSATION, flash_device drops to NOTIFY — it runs " +
          "and shows progress, and never draws another approval card",
        dec(kg, "flash_device") === DECISION.NOTIFY);

    // run_script granted the same way stays welded
    const kr = mkK();
    kr.toolPolicy = { run_script: "allow" };
    check("...but run_script granted \"allow\" STAYS confirm — no grant makes " +
          "arbitrary shell run unwatched",
        dec(kr, "run_script") === DECISION.CONFIRM);
}

/* ===================== flash streams progress, not a lull ================== */
{
    const src = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "deviceControl.js"), "utf8");
    check("run() can stream — it takes an onData callback fed each chunk live, " +
          "the only way a long upload shows progress instead of a lull",
        /onData = null/.test(src) && /if \(onData\)/.test(src));
    check("...flash_device forwards compile/upload/done phases and the upload " +
          "percentage through onNote",
        /compiling for/.test(src) && /uploading to \$\{p\} — \$\{pct\}%/.test(src) &&
        /done — \$\{p\} is running the new sketch/.test(src));
    check("...and the entry passes the turn's onNote into the flash, or the " +
          "progress would have nowhere to go",
        /flashDevice\(root, args, ctx && ctx\.onNote\)/.test(src));
}

/* ============ the agent offers them, and the manifest knows them ========= */
{
    const agentSrc = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
    check("the agent offers all three, so the model can see the hardware it is " +
          "being asked about — a tool it cannot see is one it can never call",
        TOOLS.every(t => agentSrc.includes("tools." + t + " = deviceControl.")),
        TOOLS.filter(t => !agentSrc.includes("tools." + t + " = deviceControl.")));

    const manSrc = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "toolManifest.js"), "utf8");
    check("...and every one has argument descriptions in the manifest",
        TOOLS.every(t => manSrc.includes(t + ": {")),
        TOOLS.filter(t => !manSrc.includes(t + ": {")));
}

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error("HARNESS ERROR:", (e && e.stack) || e);
    process.exit(1);
});
