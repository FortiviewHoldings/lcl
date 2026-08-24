/**
 * SPICE — the circuit gets SOLVED, not described.
 *
 * These run REAL ngspice (bundled inside KiCad) when it is present, because a
 * mocked solver would prove nothing: the whole value is that the numbers come
 * from the real simulator. Validated against closed-form answers a human can
 * check by hand. Skips cleanly on machines without KiCad.
 */
const os = require("os");

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
const fs = require("fs");
const path = require("path");
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const spice = require(__dirname + "/../.lcl.engine/core/spice.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}
const close = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;

(async () => {
    /* ---- netlist hygiene: pure functions, always run ---- */
    let refused = false;
    try { spice.vetNetlist(".control\nshell del *\n.endc"); } catch { refused = true; }
    check(".control blocks are refused (they can run arbitrary commands)", refused);
    refused = false;
    try { spice.vetNetlist(""); } catch { refused = true; }
    check("an empty netlist is refused", refused);
    check("an ordinary netlist passes the vet",
        !!spice.vetNetlist("V1 in 0 DC 10\nR1 in out 1k"));

    if (!spice.available()) {
        console.log("\n-- live solver checks skipped: KiCad/ngspice not on this machine --");
        console.log(`\n${pass}/${pass + fail} spice checks passed`);
        process.exit(fail ? 1 : 0);
    }

    /* ---- DC operating point: v = 10 * 3k/(1k+3k) = 7.5 exactly ---- */
    const op = await spice.simulate({
        netlist: "divider\nV1 in 0 DC 10\nR1 in out 1k\nR2 out 0 3k",
        analysis: { type: "op" }, probes: ["v(out)", "v(in)"]
    });
    check("the divider solves", op.ok === true, op);
    check("v(out) is exactly 7.5 (closed form: 10 * 3k/4k)",
        close(op.op_point && op.op_point["v(out)"], 7.5, 1e-9), op.op_point);
    check("v(in) is the source voltage", close(op.op_point && op.op_point["v(in)"], 10, 1e-9));

    /* ---- probes filter the result ---- */
    check("unprobed nodes are not returned",
        !op.op_point || !("v(1)" in op.op_point));

    /* ---- transient: an RC charges to ~63.2% at t = tau ---- */
    // R=1k, C=1u -> tau = 1ms. Step 5V at t=0 via PULSE.
    const tr = await spice.simulate({
        netlist: "rc\nV1 in 0 PULSE(0 5 0 1u 1u 1 2)\nR1 in out 1k\nC1 out 0 1u",
        analysis: { type: "tran", args: "10u 3m" }, probes: ["v(out)", "time"]
    });
    check("the transient runs", tr.ok === true && !!tr.vectors, tr.ok);
    if (tr.ok && tr.vectors && tr.vectors["v(out)"] && tr.vectors.time) {
        const t = tr.vectors.time, v = tr.vectors["v(out)"];
        // find the sample nearest tau = 1ms
        let k = 0;
        for (let i = 0; i < t.length; i++) if (Math.abs(t[i] - 1e-3) < Math.abs(t[k] - 1e-3)) k = i;
        check("v(tau) is ~63.2% of the step (RC physics, not prose)",
            close(v[k], 5 * 0.632, 0.1), { at: t[k], v: v[k] });
        // at t = 3ms = 3tau: v = 5(1 - e^-3) = 4.7509. The first version of this
        // check expected "fully charged" and FAILED — the simulator was right
        // and the test was wrong, which is exactly the property worth having.
        check("v(3*tau) matches the closed form 5(1 - e^-3)",
            close(v[v.length - 1], 5 * (1 - Math.exp(-3)), 0.05), v[v.length - 1]);
    }

    /* ---- failure is a result, not a throw ---- */
    const bad = await spice.simulate({
        netlist: "broken\nR1 a b 1k",          // floating, no source, no ground path
        analysis: { type: "op" }
    });
    check("an unsolvable circuit reports failure with the solver's words",
        bad.ok === false && typeof bad.error === "string", bad);

    const badAnalysis = await spice.simulate({
        netlist: "x\nV1 a 0 DC 1\nR1 a 0 1k",
        analysis: { type: "tran" }             // tran with no args
    }).catch(e => ({ threw: true, msg: e.message }));
    check("a malformed analysis is refused with guidance",
        badAnalysis.threw && /needs args/.test(badAnalysis.msg), badAnalysis);

    /* ---- the model cannot smuggle its own analysis line ---- */
    const smuggle = await spice.simulate({
        netlist: "y\nV1 a 0 DC 2\nR1 a 0 1k\n.tran 1u 1m",   // stripped, replaced by op
        analysis: { type: "op" }, probes: ["v(a)"]
    });
    check("analysis lines in the netlist are stripped — the args decide",
        smuggle.ok && smuggle.op_point && close(smuggle.op_point["v(a)"], 2, 1e-9), smuggle);

    console.log(`\n${pass}/${pass + fail} spice checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
