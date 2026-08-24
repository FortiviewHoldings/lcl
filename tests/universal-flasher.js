/**
 * ONE FLASH TOOL, THREE ENGINES — arduino, platformio, uf2.
 *
 * flash_device grew from one path (arduino-cli) into a router: an explicit
 * {tool}, a .uf2 file, or a platformio.ini decides which engine runs. DFU was
 * deliberately CUT from this build — nothing on the bench enumerates as DFU,
 * and written-not-proven is not a thing this repo ships. The router makes it
 * a pure append the day that board exists.
 *
 * WHAT THIS SUITE PROVES, without a board, a bootloader drive, or a spawn:
 *   - the auto-detection matrix, pinned on the PURE functions
 *     (resolveFlashToolFromArgs, findPioProject) — flashDevice itself is only
 *     driven through paths that refuse before anything can run
 *   - every refusal names the missing piece and the next step
 *   - the toolchain allowlist grew platformio and ONLY platformio, still
 *     key-not-URL, and the installer's verdict comes from the tool answering
 *   - the progress contract: one etaTicker, honest percents, measured uf2 bytes
 *   - the learned store speaks tool-prefixed keys and still reads legacy ones
 */
const path = require("path");
const fs = require("fs");
// the learned store must start EMPTY — the real data dir accumulates keys
// across runs and the EMA blend then fails the round-trip pins
process.env.LCL_DATA_DIR = fs.mkdtempSync(require("path").join(require("os").tmpdir(), "lcl-uf-"));
const os = require("os");
const Module = require("module");

const ROOT = path.join(__dirname, "..");

const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-uniflash-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const dc = require(path.join(ROOT, ".lcl.engine", "core", "deviceControl.js"));
const manifest = require(path.join(ROOT, ".lcl.engine", "core", "toolManifest.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

(async () => {

/* =============== the auto-detection matrix, on PURE functions ============= */
{
    const pick = (args) => dc.resolveFlashToolFromArgs(args);

    check("THE SUPPORTED SET IS EXACTLY arduino, platformio, uf2 — DFU is cut " +
          "until a DFU board is on the bench to prove it against",
        Array.isArray(dc.FLASH_TOOLS) &&
        dc.FLASH_TOOLS.slice().sort().join(",") === "arduino,platformio,uf2",
        dc.FLASH_TOOLS);

    check("an explicit tool is taken as given, case- and whitespace-forgiving",
        pick({ tool: "arduino" }) === "arduino" &&
        pick({ tool: "platformio" }) === "platformio" &&
        pick({ tool: "  UF2 " }) === "uf2");

    check("EXPLICIT WINS over a file hint — a caller who names a tool has " +
          "decided, and a .uf2 lying in the arguments does not overrule them",
        pick({ tool: "arduino", file: "fw.uf2" }) === "arduino");

    check("a .uf2 file means uf2, case-insensitively",
        pick({ file: "fw.uf2" }) === "uf2" && pick({ file: "FW.UF2" }) === "uf2" &&
        pick({ file: " build/out.Uf2 " }) === "uf2");

    check("a .bin is NOT a uf2 hint — only the format the bootloader takes",
        pick({ file: "fw.bin" }) === null);

    check("no signal means null — the FILESYSTEM decides later (platformio.ini " +
          "means platformio, else arduino), after the scope checks",
        pick({}) === null && pick({ port: "COM10", sketch: "blink" }) === null);

    const dfu = pick({ tool: "dfu" });
    check("dfu is REFUSED, and the refusal names the supported set — the cut " +
          "is enforced, not just absent",
        dfu && typeof dfu === "object" && /arduino, platformio, uf2/.test(dfu.why || ""), dfu);

    const nonsense = pick({ tool: "avrdude-yolo" });
    check("...and so is any other name, same sentence, naming all three",
        nonsense && typeof nonsense === "object" &&
        /arduino, platformio, uf2/.test(nonsense.why || ""), nonsense);
}

/* ============= platformio.ini detection walks up, and stops ============== */
{
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-uf-ws-"));
    fs.mkdirSync(path.join(ws, "proj", "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "proj", "platformio.ini"),
        "[env:esp32dev]\nplatform = espressif32\n");
    fs.writeFileSync(path.join(ws, "proj", "src", "main.cpp"), "int main(){return 0;}\n");

    check("findPioProject finds the ini in the named folder itself",
        dc.findPioProject(path.join(ws, "proj"), ws) === path.join(ws, "proj"));

    check("...and WALKS UP from src/ to the folder that holds platformio.ini — " +
          "pio builds the project, not the file you pointed at",
        dc.findPioProject(path.join(ws, "proj", "src"), ws) === path.join(ws, "proj"));

    fs.mkdirSync(path.join(ws, "bare"));
    check("...and a folder with no ini above it returns null — that sketch " +
          "belongs to arduino-cli",
        dc.findPioProject(path.join(ws, "bare"), ws) === null);

    /* an ini ABOVE the workspace must never be found: detection reading
     * outside the linked folder would be a scope leak in a trench coat */
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-uf-outer-"));
    const inner = path.join(outer, "linked");
    fs.mkdirSync(path.join(inner, "sk"), { recursive: true });
    fs.writeFileSync(path.join(outer, "platformio.ini"), "[env:x]\n");
    check("...and the walk STOPS at the workspace boundary — an ini outside " +
          "the linked folder is invisible on purpose",
        dc.findPioProject(path.join(inner, "sk"), inner) === null);

    const wsRootIni = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-uf-rooti-"));
    fs.mkdirSync(path.join(wsRootIni, "deep", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(wsRootIni, "platformio.ini"), "[env:x]\n");
    check("...and an ini AT the workspace root is found from deep inside it",
        dc.findPioProject(path.join(wsRootIni, "deep", "deeper"), wsRootIni) === wsRootIni);

    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outer, { recursive: true, force: true });
    fs.rmSync(wsRootIni, { recursive: true, force: true });
}

/* ========== refusals: every one lands before anything can run ============ */
{
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-uf-ref-"));
    fs.mkdirSync(path.join(ws, "sk"));
    fs.writeFileSync(path.join(ws, "sk", "sk.ino"), "void setup(){} void loop(){}");
    fs.writeFileSync(path.join(ws, "fw.uf2"), Buffer.alloc(512));
    fs.writeFileSync(path.join(ws, "fw.bin"), Buffer.alloc(512));

    const badTool = await dc.flashDevice(ws, { tool: "dfu", file: "fw.uf2" });
    check("flashDevice refuses an unsupported tool naming the three it drives",
        badTool.ok === false && /arduino, platformio, uf2/.test(badTool.why || ""), badTool);

    const noFile = await dc.flashDevice(ws, { tool: "uf2" });
    check("uf2 without a file NAMES the argument — {\"file\"} — not a shrug",
        noFile.ok === false && /\{"file"/.test(noFile.why || ""), noFile);

    const noRoot = await dc.flashDevice(null, { tool: "uf2", file: "fw.uf2" });
    check("uf2 with no linked folder refuses in the house phrasing",
        noRoot.ok === false && /no folder is linked/.test(noRoot.why || ""), noRoot);

    const escape = await dc.flashDevice(ws, { tool: "uf2", file: "../../escape.uf2" });
    check("...and a file OUTSIDE the linked folder is refused, resolved not " +
          "pattern-matched, so .. cannot walk out",
        escape.ok === false && /outside the linked folder/.test(escape.why || ""), escape);

    const gone = await dc.flashDevice(ws, { tool: "uf2", file: "missing.uf2" });
    check("...and a missing file is said plainly",
        gone.ok === false && /does not exist/.test(gone.why || ""), gone);

    const wrongFmt = await dc.flashDevice(ws, { tool: "uf2", file: "fw.bin" });
    check("...and a non-.uf2 file is refused BEFORE any drive is enumerated — " +
          "a UF2 bootloader takes only its own format",
        wrongFmt.ok === false && /\.uf2/.test(wrongFmt.why || ""), wrongFmt);

    const noPort = await dc.flashDevice(ws, { sketch: "sk" });
    check("the serial paths without a port NAME the missing argument instead " +
          "of calling undefined not-a-COM-port",
        noPort.ok === false && /\{"port"/.test(noPort.why || ""), noPort);

    const lpt = await dc.flashDevice(ws, { tool: "platformio", port: "LPT1", sketch: "sk" });
    check("a bad port flashes nothing on the platformio path too — the port " +
          "gate sits ahead of every serial tool",
        lpt.ok === false && /not a COM port name/.test(lpt.why || ""), lpt);

    const noIni = await dc.flashDevice(ws, { tool: "platformio", port: "COM10", sketch: "sk" });
    check("explicit platformio with NO platformio.ini refuses naming the ini " +
          "AND the arduino alternative — a next step, not a dead end",
        noIni.ok === false && /platformio\.ini/.test(noIni.why || "") &&
        /arduino/.test(noIni.why || ""), noIni);

    fs.rmSync(ws, { recursive: true, force: true });
}

/* ================ uf2 drive choice, decided in a pure head ================ */
{
    const info = "UF2 Bootloader v3.0\nModel: Raspberry Pi RP2\nBoard-ID: RPI-RP2\n";
    const parsed = dc.parseUf2Info(info);
    check("INFO_UF2.TXT is parsed verbatim — Model and Board-ID exactly as the " +
          "bootloader wrote them",
        parsed.model === "Raspberry Pi RP2" && parsed.boardId === "RPI-RP2", parsed);

    check("...and a file without those lines yields nulls, never inventions",
        dc.parseUf2Info("hello").model === null && dc.parseUf2Info("").boardId === null);

    const none = dc.chooseUf2Drive([], null);
    check("ZERO drives refuses and TEACHES the bootloader gesture — BOOTSEL / " +
          "double-tap reset — instead of reporting a bare absence",
        none.ok === false && /BOOTSEL/.test(none.why) && /double-tap/.test(none.why), none);

    const one = dc.chooseUf2Drive([{ drive: "E:", model: "RP2" }], null);
    check("exactly one drive is chosen without ceremony",
        one.ok === true && one.drive.drive === "E:", one);

    const many = dc.chooseUf2Drive(
        [{ drive: "E:", model: "RP2" }, { drive: "F:", model: "Feather" }], null);
    check("SEVERAL drives refuse, list what was found, and name the argument " +
          "that picks one",
        many.ok === false && /E:/.test(many.why) && /F:/.test(many.why) &&
        /\{"drive"/.test(many.why), many);

    check("a drive argument is matched against the DETECTED list, forgiving " +
          "case and a trailing slash or missing colon",
        dc.chooseUf2Drive([{ drive: "E:" }], "e").ok === true &&
        dc.chooseUf2Drive([{ drive: "E:" }], "E:\\").ok === true);

    const rawPath = dc.chooseUf2Drive([{ drive: "E:" }], "C:\\Windows");
    check("...and NEVER taken as a raw path — an undetected target is refused, " +
          "the same allowlist spirit as PORT_SHAPE",
        rawPath.ok === false && /not a UF2 bootloader drive/.test(rawPath.why), rawPath);

    const wrongDrive = dc.chooseUf2Drive([{ drive: "E:" }], "F:");
    check("...including a well-formed letter that simply is not mounted, with " +
          "the detected list in the refusal",
        wrongDrive.ok === false && /detected: E:/.test(wrongDrive.why), wrongDrive);
}

/* ============ the allowlist grew platformio, and ONLY platformio ========== */
{
    check("the table now names four — arduino-cli, esp32-core, esptool, " +
          "platformio — and nothing else; dfu-util is deliberately NOT here",
        Object.keys(dc.TOOLCHAINS).sort().join(",") ===
            "arduino-cli,esp32-core,esptool,platformio",
        Object.keys(dc.TOOLCHAINS));

    check("every entry still records an exact command and a named vendor source",
        Object.values(dc.TOOLCHAINS).every(t =>
            Array.isArray(t.install) && typeof t.source === "string" && t.source.length > 10));

    check("platformio's source names PyPI and the vendor — a key into a table, " +
          "never a URL in an argument",
        /PyPI/.test(dc.TOOLCHAINS.platformio.source) &&
        /PlatformIO Labs/.test(dc.TOOLCHAINS.platformio.source),
        dc.TOOLCHAINS.platformio.source);

    check("...and its install command is pip upgrading the named package",
        dc.TOOLCHAINS.platformio.install[0] === "pip" &&
        dc.TOOLCHAINS.platformio.install[1].includes("platformio"));

    check("platformio declares a FINDER — pip drops the pio shim off PATH, and " +
          "the probe has to look where it actually lands, before AND after install",
        typeof dc.TOOLCHAINS.platformio.find === "function");

    const src = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "deviceControl.js"), "utf8");
    check("...and for finder entries the installer's verdict is the TOOL " +
          "answering its probe, never the package manager exiting 0",
        /const installedOk = spec\.find \? !!after\.present : \(!!after\.present \|\| r\.ok\);/.test(src));

    const r = await dc.installToolchain("dfu-util");
    check("install_toolchain refuses dfu-util — cut means cut, the table is " +
          "the whole truth",
        r.ok === false && /not a toolchain this app installs/.test(r.why || ""), r);

    check("findPio returns {exe, args} in the findEsptool house shape",
        (() => { const f = dc.findPio(); return f && typeof f.exe === "string" &&
                 f.exe.length > 0 && Array.isArray(f.args); })());
}

/* ============ the progress contract, pinned at the source ================= */
{
    const src = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "deviceControl.js"), "utf8");

    check("ONE etaTicker owns elapsed-over-learned — defined once, used by " +
          "both build paths",
        src.split("function etaTicker(say, label, knownMs, t0)").length === 2 &&
        /etaTicker\(say, "compiling", knownMs, compileT0\)/.test(src) &&
        /etaTicker\(say, "building", knownMs, t0\)/.test(src));

    check("the pio first-build note is honest and carries the same " +
          "pct/etaMs-or-indeterminate extra as arduino's",
        /first build of this project, no estimate yet; timing it/.test(src) &&
        src.split("knownMs ? { pct: 0, etaMs: knownMs } : { indeterminate: true }").length === 3);

    check("pio milestones are pio's OWN stage lines, forwarded on change — " +
          "never a percent it did not print",
        /\(Processing\|Compiling\|Linking\|Building\|Retrieving\|Checking\)/.test(src) &&
        /m\[1\] !== stage/.test(src));

    check("the pio upload forwards a real percent, one note per whole percent",
        /say\(`uploading — \$\{pct\}%`, \{ pct \}\)/.test(src) &&
        /pct !== lastPct/.test(src));

    check("the uf2 percent is MEASURED — bytes written over bytes in the file",
        /Math\.round\(\(written \/ size\) \* 100\)/.test(src));

    check("uf2 success is the drive DETACHING, watched not assumed — and a " +
          "copy without a detach is said honestly, never claimed as a flash",
        /INFO_UF2\.TXT/.test(src) && /did not detach/.test(src) &&
        /rejected this UF2 family/.test(src));

    check("the platformio learned key is tool-prefixed and broader than a bare " +
          "fqbn — the env when named, the project folder when not",
        /"platformio:" \+ \(env \|\| path\.basename\(projDir\)\)/.test(src));
}

/* =============== the learned store: new keys, old keys honored ============ */
{
    dc.rememberMs("platformio:esp32dev", 8000);
    check("rememberMs round-trips a tool-prefixed key",
        dc.learnedMs("platformio:esp32dev") === 8000);

    dc.rememberMs("platformio:esp32dev", 4000);
    check("...and a second sample is EMA-blended (0.4 old / 0.6 new), the same " +
          "curve the arduino path always used",
        dc.learnedMs("platformio:esp32dev") === Math.round(8000 * 0.4 + 4000 * 0.6));

    /* a legacy store wrote BARE fqbn keys — hand-write one and prove the
     * arduino wrapper still reads it, so nobody's durations vanish on update */
    dc.rememberMs("esp32:esp32:esp32s3", 5000);
    check("learnedCompileMs still reads a legacy bare-fqbn key",
        dc.learnedCompileMs("esp32:esp32:esp32s3") === 5000);

    dc.rememberCompileMs("esp32:esp32:esp32s3", 9000);
    check("...while rememberCompileMs writes the arduino:-prefixed key, which " +
          "then wins over the legacy one",
        dc.learnedMs("arduino:esp32:esp32:esp32s3") === 9000 &&
        dc.learnedCompileMs("esp32:esp32:esp32s3") === 9000);
}

/* ================ the manifest tells the schema-readers ================== */
{
    const fd = manifest.ARG_DETAIL.flash_device;
    const names = fd.args.map(a => a.name);

    check("flash_device's manifest gained tool, file, env and drive",
        ["tool", "file", "env", "drive"].every(n => names.includes(n)), names);

    check("...and carries NO dfu, vid, pid or address argument — the cut is total",
        !names.some(n => ["dfu", "vid", "pid", "address"].includes(n)), names);

    const toolArg = fd.args.find(a => a.name === "tool");
    check("the tool argument documents exactly arduino | platformio | uf2, " +
          "plus the auto rules",
        /arduino \| platformio \| uf2/.test(toolArg.description) &&
        /omit for auto/.test(toolArg.description), toolArg && toolArg.description);

    check("port and sketch dropped to optional in the SCHEMA — a uf2 call must " +
          "be able to omit them; the runtime refuses per-tool, naming the piece",
        fd.args.find(a => a.name === "port").required === false &&
        fd.args.find(a => a.name === "sketch").required === false);

    const schema = manifest.openAiSchemas(["flash_device"], {})[0];
    check("...so a schema-constrained host no longer FORCES port+sketch onto a " +
          "uf2 call",
        schema.function.parameters.required.length === 0,
        schema.function.parameters.required);

    const it = manifest.ARG_DETAIL.install_toolchain.args[0];
    check("install_toolchain's manifest names platformio in the allowlist " +
          "sentence, still \"no other value is accepted\"",
        /platformio/.test(it.description) && /no other value is accepted/.test(it.description),
        it.description);

    const helps = [dc.INSTALL_TOOLCHAIN_ENTRY.help, dc.FLASH_DEVICE_ENTRY.help];
    check("both entry help strings teach the new paths, still substantial",
        helps.every(h => typeof h === "string" && h.length > 60) &&
        /platformio/.test(helps[0]) && /uf2/.test(helps[1]) && /platformio/.test(helps[1]),
        helps.map(h => (h || "").slice(0, 40)));
}

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error("HARNESS ERROR:", (e && e.stack) || e);
    process.exit(1);
});
