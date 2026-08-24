/**
 * REDLINING — the paper-to-KiCad loop's deterministic half.
 *
 * The vision capture is judged by a human against the original drawing; what
 * MUST be machine-verified is everything after it: edit ops applied exactly
 * (a dictated fuse size is ground truth), all-or-nothing batches, the rebuild
 * regenerating a real ERC-checkable schematic with the revision table on the
 * sheet, and the symbol map resolving every component type it promises.
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

const redline = require(__dirname + "/../.lcl.engine/core/redline.js");
const sch = require(__dirname + "/../.lcl.engine/core/schematic.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}
const throws = (fn, re) => {
    try { fn(); return false; } catch (e) { return !re || re.test(String(e.message)); }
};

function freshCapture() {
    return {
        version: 1, source: "panel.png", title: "Pump panel",
        capturedAt: "2026-07-28T00:00:00Z",
        components: [
            { ref: "F1", type: "fuse", value: "5A", confidence: 0.9, symbol: "Device:Fuse" },
            { ref: "K1", type: "relay", value: null, confidence: 0.8, symbol: "Relay:Relay_DPDT" },
            { ref: "R1", type: "resistor", value: "250", confidence: 0.95, symbol: "Device:R" }
        ],
        nets: [
            { name: "L1", pins: ["F1.2", "R1.1"], confidence: 0.9 },
            { pins: ["R1.2", "K1.A1"], confidence: 0.7 }
        ],
        uncertainties: [], revisions: []
    };
}

(async () => {
    /* ---- extractJson: model output is never trusted to be clean ---- */
    check("plain JSON array parses",
        Array.isArray(redline.extractJson('[{"ref":"F1"}]')));
    check("fenced JSON parses",
        redline.extractJson('Here:\n```json\n{"a":1}\n```\ndone').a === 1);
    check("JSON with trailing prose parses",
        redline.extractJson('[{"a":1}] — that is everything I can see.')[0].a === 1);
    check("nested braces inside strings survive",
        redline.extractJson('{"s":"a{b}c","n":2}').n === 2);
    check("no JSON at all returns null",
        redline.extractJson("I cannot read this drawing.") === null);

    /* ---- edit ops, each against a fresh capture ---- */
    {
        const c = freshCapture();
        redline.applyEdit(c, { op: "set_value", ref: "F1", value: "10A" });
        check("set_value changes the value", c.components[0].value === "10A");
        check("a dictated value becomes ground truth (confidence 1)",
            c.components[0].confidence === 1);
    }
    {
        const c = freshCapture();
        redline.applyEdit(c, { op: "connect", pins: ["F1.1", "K1.A2"], name: "JMP1" });
        check("connect adds a named net",
            c.nets.some(n => n.name === "JMP1" && n.pins.join() === "F1.1,K1.A2"));
        check("connect refuses an unknown component",
            throws(() => redline.applyEdit(freshCapture(),
                { op: "connect", pins: ["F1.1", "ZZ9.1"] }), /no component "ZZ9"/));
    }
    {
        const c = freshCapture();
        redline.applyEdit(c, { op: "add", ref: "K2", type: "relay", value: "9-pin" });
        check("add appends the component with its mapped symbol",
            c.components.some(x => x.ref === "K2" && x.symbol.includes(":")));
        check("add refuses a duplicate ref",
            throws(() => redline.applyEdit(c, { op: "add", ref: "F1", type: "fuse" }),
                /already exists/));
    }
    {
        const c = freshCapture();
        redline.applyEdit(c, { op: "remove", ref: "R1" });
        check("remove drops the component", !c.components.some(x => x.ref === "R1"));
        check("remove prunes nets that lost their second endpoint",
            !c.nets.some(n => n.pins.some(p => p.startsWith("R1."))) && c.nets.length === 0,
            c.nets);
    }
    {
        const c = freshCapture();
        redline.applyEdit(c, { op: "disconnect", pin: "K1.A1" });
        check("disconnect removes the pin and prunes the dead net",
            !c.nets.some(n => n.pins.includes("K1.A1")));
        check("disconnecting an unconnected pin is an error, not a no-op",
            throws(() => redline.applyEdit(freshCapture(),
                { op: "disconnect", pin: "K1.A7" }), /not connected/));
    }
    check("an unknown op names the legal ones",
        throws(() => redline.applyEdit(freshCapture(), { op: "explode" }),
            /unknown edit op/));
    check("set_value without a value is refused",
        throws(() => redline.applyEdit(freshCapture(),
            { op: "set_value", ref: "F1" }), /needs a value/));

    /* ---- describeEdit reads like a redline log line ---- */
    check("describeEdit: set_value", /F2.*10A/.test(
        redline.describeEdit({ op: "set_value", ref: "F2", value: "10A" })));
    check("describeEdit: connect reads as a jumper",
        /jumper/.test(redline.describeEdit({ op: "connect", pins: ["TB1.4", "TB1.7"] })));

    /* ---- buildSchematic texts guardrails (no KiCad needed) ---- */
    check("texts must be an array",
        throws(() => sch.buildSchematic({
            components: [{ ref: "R1", symbol: "Device:R" }], texts: "nope" }),
            /texts must be an array/));

    /* ---- with the real KiCad: symbol map, rebuild, revision table ---- */
    if (!sch.available()) {
        console.log("\n-- KiCad not installed: symbol map + rebuild checks skipped --");
    } else {
        for (const t of ["fuse", "relay", "resistor", "capacitor", "terminal",
                         "switch", "lamp", "transformer", "diode", "coil", "other"]) {
            let libId = null, err = null;
            try { libId = redline.symbolForType(t); } catch (e) { err = e.message; }
            check(`type "${t}" maps to a real library symbol`,
                !!libId && libId.includes(":"), err || libId);
        }

        const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-redline-"));
        const capture = freshCapture();
        capture.revisions.push({
            at: "2026-07-28T12:00:00Z",
            summary: "F1: value → 10A", edits: [{ op: "set_value", ref: "F1", value: "10A" }]
        });
        const built = await redline.rebuild(ROOT, capture, {});
        const schFile = path.join(ROOT, "panel.kicad_sch");
        check("rebuild writes the schematic next to the source name",
            fs.existsSync(schFile), built);
        const text = fs.readFileSync(schFile, "utf8");
        check("the revision table is ON the sheet",
            text.includes("REV 1 (2026-07-28): F1: value") && text.includes("(text"));
        check("ERC actually ran and reported", typeof built.erc === "string", built.erc);
        check("kicad parses what rebuild wrote",
            (() => { try { sch.parseSexpr(text); return true; } catch { return false; } })());

        /* full redline flow against files on disk */
        fs.writeFileSync(path.join(ROOT, "panel.capture.json"),
            JSON.stringify(freshCapture(), null, 2));
        const r = await redline.redlineDrawing(ROOT, {
            path: "panel.png",
            edits: [
                { op: "set_value", ref: "F1", value: "10A" },
                { op: "connect", pins: ["F1.1", "K1.A2"], name: "JMP1" }
            ]
        }, {});
        check("redline applies and reports each edit in order",
            r.applied.length === 2 && /F1/.test(r.applied[0]) && /jumper/.test(r.applied[1]),
            r.applied);
        check("the revision number advances", r.revision === 1);
        const saved = JSON.parse(fs.readFileSync(path.join(ROOT, "panel.capture.json"), "utf8"));
        check("the capture on disk carries the revision", saved.revisions.length === 1);
        check("a failing batch changes NOTHING on disk", await (async () => {
            try {
                await redline.redlineDrawing(ROOT, { path: "panel.png",
                    edits: [{ op: "set_value", ref: "F1", value: "15A" },
                            { op: "remove", ref: "NOPE" }] }, {});
                return false;
            } catch {
                const again = JSON.parse(fs.readFileSync(path.join(ROOT, "panel.capture.json"), "utf8"));
                return again.components[0].value === "10A" && again.revisions.length === 1;
            }
        })());

        fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    }

    console.log(`\n${pass}/${pass + fail} redline checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
