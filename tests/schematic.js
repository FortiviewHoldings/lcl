/**
 * SCHEMATICS — a real .kicad_sch, judged by KiCad's own rules checker.
 *
 * The oracle here is ERC, not eyeballs: connectivity in this format is
 * GEOMETRIC (a wire endpoint must land exactly on a pin end, on the 1.27 mm
 * grid, with symbol-space Y up and sheet-space Y down), and the only honest
 * proof the transforms are right is KiCad agreeing every pin is connected.
 * These tests run the real kicad-cli when present and skip cleanly otherwise.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
// ISOLATED per run: paths.js derives the data directory from this,
// so a shared os.tmpdir() made every suite inherit whatever settings
// an earlier suite had written — an order-dependent gate that failed
// builds at random.
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const sch = require(__dirname + "/../.lcl.engine/core/schematic.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}

(async () => {
    /* ---- s-expression round trip ---- */
    const node = sch.parseSexpr('(a (b "two words") (c 1 2))');
    check("s-expressions parse", node[0] === "a" && node[1][0] === "b");
    check("quoted strings survive with spaces",
        node[1][1].str === "two words");
    const printed = sch.printSexpr(node);
    const again = sch.parseSexpr(printed);
    check("print -> parse round-trips", JSON.stringify(again) === JSON.stringify(node));

    /* ---- pin transforms: symbol Y-up to sheet Y-down ---- */
    const pin = { x: 0, y: 3.81 };                       // above the anchor, symbol space
    const p0 = sch.pinAt(pin, 100, 100, 0);
    check("Y flips from symbol space to sheet space (pin ABOVE anchor -> smaller sheet y)",
        p0.x === 100 && p0.y === 96.19, p0);
    const p90 = sch.pinAt(pin, 100, 100, 90);
    check("rotation 90 lands where KiCad puts it", p90.x === 96.19 && p90.y === 100, p90);
    const p180 = sch.pinAt(pin, 100, 100, 180);
    check("rotation 180 mirrors both", p180.x === 100 && p180.y === 103.81, p180);

    /* ---- argument validation speaks the caller's language ---- */
    for (const [args, why] of [
        [{ components: [] }, "no components"],
        [{ components: [{ symbol: "Device:R" }] }, "missing ref"],
        [{ components: [{ ref: "R1", symbol: "Device:R" }, { ref: "R1", symbol: "Device:R" }] }, "duplicate ref"],
        [{ components: [{ ref: "R1", symbol: "Device:R" }], nets: [{ pins: ["R9.1", "R1.1"] }] }, "unknown component"],
        [{ components: [{ ref: "R1", symbol: "Device:R" }], nets: [{ pins: ["R1.7", "R1.1"] }] }, "unknown pin"]
    ]) {
        let threw = false;
        try { sch.buildSchematic(args); } catch { threw = true; }
        check(`refused: ${why}`, threw);
    }

    if (!sch.available()) {
        console.log("\n-- KiCad not on this machine: generation checks against real libraries skipped --");
        console.log(`\n${pass}/${pass + fail} schematic checks passed`);
        process.exit(fail ? 1 : 0);
    }

    /* ---- the stock libraries and extends flattening ---- */
    const r = sch.getSymbol("Device:R");
    check("Device:R resolves with two pins", r.pins.length === 2, r.pins);
    check("pins carry connection geometry",
        r.pins.every(p => typeof p.x === "number" && typeof p.y === "number"));
    // R_Small extends R in the stock library — the flattening path
    const rs = sch.getSymbol("Device:R_Small");
    check("an `extends` symbol flattens to its parent's pins", rs.pins.length === 2, rs.pins);
    const embedded = sch.printSexpr(rs.sexpr);
    check("the flattened symbol is renamed throughout (inner units too)",
        embedded.includes("Device:R_Small") && !/"R_0_1"/.test(embedded));
    check("no dangling extends survives into the embed", !/extends/.test(embedded));

    check("symbol search finds parts by fragment",
        sch.searchSymbols("opamp", 10).length > 0);

    /* ---- generate a COMPLETE circuit and let ERC judge it ---- */
    const text = sch.buildSchematic({
        title: "divider loop",
        components: [
            { ref: "R1", symbol: "Device:R", value: "1k" },
            { ref: "R2", symbol: "Device:R", value: "3k" }
        ],
        nets: [
            { name: "MID", pins: ["R1.2", "R2.1"] },
            { name: "RET", pins: ["R1.1", "R2.2"] }   // close the loop: no floating pins
        ]
    });
    check("output is a kicad_sch document", /^\(kicad_sch/.test(text));
    check("symbols are embedded, so the file stands alone",
        /lib_symbols/.test(text) && /"Device:R"/.test(text));
    check("everything electrical sits on the 1.27 mm grid",
        (() => {
            const xs = [...text.matchAll(/\(xy ([\d.]+) ([\d.]+)\)/g)]
                .flatMap(m => [+m[1], +m[2]]);
            return xs.length > 0 && xs.every(v => Math.abs(v / 1.27 - Math.round(v / 1.27)) < 1e-6);
        })());

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-sch-"));
    const f = path.join(dir, "div.kicad_sch");
    fs.writeFileSync(f, text, "utf8");

    const erc = await sch.checkSchematic(f);
    check("KiCad's ERC parses the generated file at all",
        typeof erc.errors === "number", erc);
    check("ERC finds ZERO errors — every pin really connects",
        erc.ok === true && erc.errors === 0, erc.violations);

    /* ---- a deliberately broken net is CAUGHT, proving ERC is a real oracle */
    const broken = sch.buildSchematic({
        components: [
            { ref: "R1", symbol: "Device:R", value: "1k" },
            { ref: "R2", symbol: "Device:R", value: "3k" }
        ],
        nets: [{ name: "MID", pins: ["R1.2", "R2.1"] }]   // outer pins floating
    });
    const f2 = path.join(dir, "broken.kicad_sch");
    fs.writeFileSync(f2, broken, "utf8");
    const erc2 = await sch.checkSchematic(f2);
    check("floating pins are reported as errors",
        erc2.ok === false && erc2.errors > 0,
        { errors: erc2.errors });

    /* ---- export renders something real ---- */
    const svg = await sch.exportSchematic(f, "svg", dir);
    check("SVG export produces a real file", svg.ok && svg.bytes > 2000, svg);
    const net = await sch.exportSchematic(f, "netlist", path.join(dir, "div.net"));
    check("netlist export carries the named nets",
        net.ok && /MID|RET/.test(fs.readFileSync(net.file, "utf8")), net);

    /* ---- a three-pin net gets a trunk and a junction ---- */
    const star = sch.buildSchematic({
        components: [
            { ref: "R1", symbol: "Device:R" },
            { ref: "R2", symbol: "Device:R" },
            { ref: "R3", symbol: "Device:R" }
        ],
        nets: [
            { name: "COM", pins: ["R1.2", "R2.2", "R3.2"] },
            { name: "TOP", pins: ["R1.1", "R2.1", "R3.1"] }
        ]
    });
    const f3 = path.join(dir, "star.kicad_sch");
    fs.writeFileSync(f3, star, "utf8");
    check("a 3+ pin net drops a junction where wires meet mid-span",
        /\(junction/.test(star));
    const erc3 = await sch.checkSchematic(f3);
    check("the three-way nets are ERC-clean too", erc3.ok === true, erc3.violations);

    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} schematic checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
