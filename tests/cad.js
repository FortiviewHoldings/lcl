/**
 * CAD — "build me a 3D model" produces a validated file.
 *
 * Live checks run REAL FreeCAD when installed and verify against closed-form
 * geometry a human can check: a 60x40x20 box minus a d16 cylinder through it
 * has volume 60*40*20 - pi*64*20. A mocked kernel would prove nothing — the
 * whole point is that the numbers come from the geometry kernel.
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

const cad = require(__dirname + "/../.lcl.engine/core/cad.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}
const close = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;

(async () => {
    /* ---- the script generator refuses bad input before FreeCAD sees it ---- */
    for (const [spec, why] of [
        [{ shape: "dodecahedron", size: 10 }, "unknown shape"],
        [{ shape: "box", length: -5, width: 10, height: 10 }, "negative dimension"],
        [{ shape: "box", length: 1e9, width: 10, height: 10 }, "absurd dimension"],
        [{ shape: "cylinder", d: "12; import os", h: 10 }, "stringly injection in a number"],
        [{ parts: Array.from({ length: 25 }, () => ({ shape: "box", size: 5 })) }, "too many parts"]
    ]) {
        let threw = false;
        try { cad.buildScript(spec, "C:/tmp/x.step", "step"); } catch { threw = true; }
        check(`refused: ${why}`, threw);
    }

    // the generated script is assembled from vetted NUMBERS — a hostile string
    // in any numeric field can never reach FreeCAD's interpreter
    const script = cad.buildScript(
        { shape: "cylinder", d: 50, h: 120 }, "C:/tmp/out.step", "step");
    check("the script carries only numeric values for dimensions",
        /Radius, .*Height = 25, 120/.test(script), script.slice(0, 300));
    check("the validation contract is in every script",
        /isValid\(\)/.test(script) && /Volume > 0/.test(script) && /isNull\(\)/.test(script));
    check("nothing exports unless validation passed",
        script.indexOf("if ok:") < script.indexOf("Import.export"));

    if (!cad.available()) {
        console.log("\n-- FreeCAD not on this machine: live kernel checks skipped --");
        console.log(`\n${pass}/${pass + fail} cad checks passed`);
        process.exit(fail ? 1 : 0);
    }

    /* ---- live: a box with a hole, versus the closed form ---- */
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-cad-ws-"));
    const r = await cad.buildModel(WS, {
        path: "bracket.step",
        parts: [
            { shape: "box", length: 60, width: 40, height: 20 },
            { op: "cut", shape: "cylinder", d: 16, h: 50, at: [30, 20, -5] }
        ]
    });
    check("the build succeeds", r.ok === true, r);
    const expected = 60 * 40 * 20 - Math.PI * 8 * 8 * 20;   // 48000 - 4021.24
    check("volume matches the closed form (box minus bore)",
        close(r.volume_mm3, expected, 0.5), { got: r.volume_mm3, expected });
    check("the bounding box is the box's envelope",
        r.bbox_mm && close(r.bbox_mm[0], 60, 0.01) && close(r.bbox_mm[1], 40, 0.01)
        && close(r.bbox_mm[2], 20, 0.01), r.bbox_mm);
    check("a real STEP file landed in the workspace",
        fs.existsSync(path.join(WS, "bracket.step")) && r.file_bytes > 2000, r.file_bytes);
    check("exactly one solid", r.solids === 1);

    /* ---- single-shape shorthand + STL ---- */
    const s = await cad.buildModel(WS, { shape: "sphere", d: 30, format: "stl", path: "ball.stl" });
    check("the shorthand form works", s.ok === true, s);
    check("sphere volume is (4/3)πr³",
        close(s.volume_mm3, (4 / 3) * Math.PI * 15 ** 3, 20), s.volume_mm3);
    check("STL export goes through the mesh path",
        fs.existsSync(path.join(WS, "ball.stl")) && s.file_bytes > 2000);

    /* ---- a cut that consumes EVERYTHING is a caught failure ---- */
    const gone = await cad.buildModel(WS, {
        path: "gone.step",
        parts: [
            { shape: "box", size: 10 },
            { op: "cut", shape: "box", size: 50, at: [-20, -20, -20] }
        ]
    });
    check("a cut that consumes the whole part fails validation, not silently",
        gone.ok === false && /no solid|invalid|error/i.test(gone.error), gone.error);
    check("the failed build leaves no file behind",
        !fs.existsSync(path.join(WS, "gone.step")));

    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} cad checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
