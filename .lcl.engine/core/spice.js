const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ToolError } = require("./fsTools");

/**
 * SPICE — the circuit actually gets SOLVED.
 *
 * This is the capability a general chat app structurally cannot fake: asked
 * "will this divider load my ADC?", a language model produces a plausible
 * paragraph; ngspice produces the operating point. The numbers come from a
 * simulator with thirty years of use behind it, and the model's job shrinks to
 * building the netlist and reading the results — both things it is good at.
 *
 * ngspice-46 ships INSIDE the KiCad install as a shared library, and KiCad
 * bundles a Python 3.11 that can reach it over ctypes. Verified end to end on
 * this machine: a 10 V source across 1k/3k returned v(out) = 7.5 exactly. So
 * there is nothing to install — the deepest electrical tool on the machine was
 * already on it.
 *
 * Runs in a CHILD PROCESS, never in-proc: a bad netlist can hang the solver,
 * and a hung solver must be killable without taking the app down. The runner
 * script is generated fresh per call and the netlist travels via a temp file,
 * not argv, so no shell-quoting surface exists.
 */

const RUN_TIMEOUT_MS = 60_000;
const MAX_NETLIST_CHARS = 200_000;
const MAX_VECTOR_POINTS = 5000;      // enough for any plot the UI would draw

/** Find KiCad's bin dir — the one place ngspice.dll and python.exe both live. */
function kicadBin() {
    const candidates = [
        path.join(process.env.LOCALAPPDATA || "", "Programs", "KiCad", "10.0", "bin"),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "KiCad", "9.0", "bin"),
        "C:/Program Files/KiCad/10.0/bin",
        "C:/Program Files/KiCad/9.0/bin"
    ];
    for (const c of candidates) {
        if (c && fs.existsSync(path.join(c, "ngspice.dll"))
              && fs.existsSync(path.join(c, "python.exe"))) return c;
    }
    return null;
}

function available() {
    return kicadBin() !== null;
}

/**
 * The Python runner. Generated once here rather than shipped as a file so the
 * whole tool lives in one module; it reads the netlist from argv[1] (a temp
 * file) and emits ONE JSON document between sentinel markers — ngspice floods
 * stdout with banners, so markers are the only reliable framing.
 */
const RUNNER = `
import ctypes, os, sys, json, re
BIN = sys.argv[3]
os.add_dll_directory(BIN)
ng = ctypes.CDLL(os.path.join(BIN, "ngspice.dll"))

lines = []
@ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p)
def send_char(s, ident, user):
    lines.append(s.decode("utf8", "replace"))
    return 0
@ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p)
def send_stat(s, ident, user):
    return 0
@ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int, ctypes.c_bool, ctypes.c_bool, ctypes.c_int, ctypes.c_void_p)
def controlled_exit(status, immediate, quit_, ident, user):
    return 0

ng.ngSpice_Init(send_char, send_stat, controlled_exit, None, None, None, None)

with open(sys.argv[1], "r", encoding="utf8") as f:
    net = [l.rstrip("\\n") for l in f]
probes = json.loads(sys.argv[2])

arr = (ctypes.c_char_p * (len(net) + 1))(*[l.encode() for l in net], None)
rc = ng.ngSpice_Circ(arr)
result = {"loaded": rc == 0, "vectors": {}, "log": []}
if rc == 0:
    ng.ngSpice_Command(b"run")

    # pull vectors through the typed API — parsing printed text loses precision
    class VecInfo(ctypes.Structure):
        _fields_ = [("v_name", ctypes.c_char_p), ("v_type", ctypes.c_int),
                    ("v_flags", ctypes.c_short), ("v_realdata", ctypes.POINTER(ctypes.c_double)),
                    ("v_compdata", ctypes.c_void_p), ("v_length", ctypes.c_int)]
    ng.ngGet_Vec_Info.restype = ctypes.POINTER(VecInfo)
    ng.ngSpice_AllVecs.restype = ctypes.POINTER(ctypes.c_char_p)
    ng.ngSpice_CurPlot.restype = ctypes.c_char_p

    plot = ng.ngSpice_CurPlot()
    names = []
    if plot:
        av = ng.ngSpice_AllVecs(plot)
        i = 0
        while av and av[i]:
            names.append(av[i].decode())
            i += 1
    want = [p.lower() for p in probes] if probes else None
    for n in names:
        if want is not None:
            canon = n.lower()
            if canon not in want and ("v(" + canon + ")") not in want: continue
        vi = ng.ngGet_Vec_Info(n.encode())
        if not vi or not vi.contents.v_realdata: continue
        ln = min(vi.contents.v_length, ${MAX_VECTOR_POINTS})
        result["vectors"][n] = [vi.contents.v_realdata[j] for j in range(ln)]

    # keep only meaningful solver output: errors and warnings, not banners
    result["log"] = [l.strip() for l in lines
                     if re.search(r"error|warning|failed|singular|no such", l, re.I)][:20]
else:
    result["log"] = [l.strip() for l in lines][-20:]

print("LCL_JSON_START")
print(json.dumps(result))
print("LCL_JSON_END")
`;

/** Basic netlist hygiene before it reaches the solver. */
function vetNetlist(netlist) {
    const s = String(netlist || "");
    if (!s.trim()) throw new ToolError("simulate_circuit needs a netlist");
    if (s.length > MAX_NETLIST_CHARS) throw new ToolError("netlist is too large");
    // shell/file escapes have no business in a netlist; .control blocks could
    // run arbitrary ngspice commands including file writes — the analyses this
    // tool exposes are passed as structured args instead
    if (/^\s*\.(control|shell)\b/im.test(s)) {
        throw new ToolError("netlists with .control or .shell blocks are not accepted — " +
                            "pass the analysis in the analysis argument");
    }
    return s;
}

const ANALYSES = {
    op: () => ".op",
    tran: (a) => `.tran ${a}`,
    ac: (a) => `.ac ${a}`,
    dc: (a) => `.dc ${a}`,
    noise: (a) => `.noise ${a}`
};

/**
 * Run one simulation. Returns { ok, vectors, op_point, warnings } — a solver
 * failure is a RESULT with the solver's own words, not a throw, because "your
 * circuit has a singular matrix" is the answer the user needs to see.
 */
async function simulate({ netlist, analysis = { type: "op" }, probes = [] } = {}, ctx = {}) {
    const bin = kicadBin();
    if (!bin) throw new ToolError("ngspice is not available — KiCad 9/10 with its bundled runtime is required");
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};

    let net = vetNetlist(netlist);
    const kind = String((analysis && analysis.type) || "op").toLowerCase();
    const mk = ANALYSES[kind];
    if (!mk) throw new ToolError(`unknown analysis "${kind}" — use op, tran, ac, dc or noise`);
    const args = String((analysis && analysis.args) || "").trim();
    if (kind !== "op" && !args) {
        throw new ToolError(`analysis "${kind}" needs args, e.g. {"type":"tran","args":"10u 5m"}`);
    }
    // THE ANALYSIS ARGUMENT IS DECK CONTENT TOO. vetNetlist refuses .control
    // and .shell in the netlist, but this string is interpolated straight into
    // the deck a few lines below — so a newline here writes a new directive
    // line and walks around that guard entirely. An audit proved it: args of
    // "10u 1m\n.shell echo INJECTED" reached the deck as line 5, and ngspice
    // reported parsing it. A real analysis argument is numbers, units, node
    // names and separators; nothing else has any business here.
    if (/[\r\n]/.test(args)) {
        throw new ToolError("the analysis argument must be a single line — " +
            "directives belong in the netlist, not here");
    }
    if (!/^[A-Za-z0-9_.,:%()+\-*/\s]*$/.test(args)) {
        throw new ToolError(
            `that analysis argument contains characters a sweep spec never needs: ` +
            `${JSON.stringify(args.slice(0, 40))}`);
    }
    if (args.length > 200) throw new ToolError("that analysis argument is too long");
    // strip any analysis lines the model put in the netlist, then add ours —
    // one source of truth for what runs
    net = net.split(/\r?\n/).filter(l => !/^\s*\.(op|tran|ac|dc|noise)\b/i.test(l)).join("\n");
    if (!/^\s*\.end\s*$/im.test(net)) net += "\n.end";
    net = net.replace(/^\s*\.end\s*$/im, `${mk(args)}\n.end`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-spice-"));
    const netFile = path.join(dir, "circuit.cir");
    const runFile = path.join(dir, "runner.py");
    fs.writeFileSync(netFile, net, "utf8");
    fs.writeFileSync(runFile, RUNNER, "utf8");

    onNote(`solving (${kind})`);
    const out = await new Promise((resolve) => {
        execFile(path.join(bin, "python.exe"),
            [runFile, netFile, JSON.stringify(probes || []), bin],
            { timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
    });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }

    if (out.err && out.err.killed) {
        return { ok: false, error: `the solver did not finish within ${RUN_TIMEOUT_MS / 1000}s — ` +
                 "the circuit may have no DC solution or an unstable time step" };
    }
    const m = out.stdout.match(/LCL_JSON_START\s*([\s\S]*?)\s*LCL_JSON_END/);
    if (!m) {
        return { ok: false, error: "the solver produced no result",
                 detail: (out.stderr || out.stdout).slice(-500) };
    }
    let r;
    try { r = JSON.parse(m[1]); } catch { return { ok: false, error: "unreadable solver output" }; }
    if (!r.loaded) {
        return { ok: false, error: "ngspice rejected the netlist", solverLog: r.log };
    }

    // A SINGULAR MATRIX is a failed solve that ngspice soldiers through,
    // returning zeros. Zeros presented as an answer are worse than an error —
    // they look like physics. Surface it as the failure it is.
    const warnings = (r.log || []).slice(0, 8);
    if (warnings.some(w => /singular matrix/i.test(w))) {
        return { ok: false,
                 error: "the circuit has no solvable DC operating point (singular matrix) — " +
                        "check for floating nodes, a missing ground, or a missing source",
                 solverLog: warnings };
    }

    // ngspice names vectors bare ("out", "time", "v1#branch"); callers probe as
    // v(out) / i(V1). Key each result by the PROBE'S spelling where one
    // matches, so what the model asked for is what it gets back.
    const wanted = (probes || []).map(p => String(p));
    const keyFor = (name) => {
        const n = name.toLowerCase();
        for (const p of wanted) {
            const pl = p.toLowerCase();
            if (pl === n) return p;
            if (pl === `v(${n})`) return p;
            if (n.endsWith("#branch") && pl === `i(${n.slice(0, -7)})`) return p;
        }
        return name;
    };

    // .op vectors have length 1 — present them as a flat operating point
    const vectors = {};
    const op_point = {};
    for (const [name, vals] of Object.entries(r.vectors || {})) {
        if (Array.isArray(vals) && vals.length === 1) op_point[keyFor(name)] = vals[0];
        else vectors[keyFor(name)] = vals;
    }
    return {
        ok: true, analysis: kind,
        op_point: Object.keys(op_point).length ? op_point : undefined,
        vectors: Object.keys(vectors).length ? vectors : undefined,
        points: Object.values(vectors)[0] ? Object.values(vectors)[0].length : 1,
        warnings
    };
}

const TOOL_ENTRY = {
    run: async (_root, args = {}, ctx = {}) => simulate(args, ctx),
    help: 'simulate_circuit {"netlist": "V1 in 0 DC 10\\nR1 in out 1k\\nR2 out 0 3k", ' +
        '"analysis": {"type": "op"}, "probes": ["v(out)"]} — SOLVE the circuit with ' +
        'ngspice and return real numbers (op, tran, ac, dc, noise)'
};

module.exports = { available, simulate, kicadBin, vetNetlist, TOOL_ENTRY };
