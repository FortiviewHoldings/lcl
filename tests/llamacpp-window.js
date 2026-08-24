/**
 * THE CONTEXT WINDOW WAS WHATEVER LLAMA.CPP FELT LIKE.
 *
 * "the context window when i click the donut still says 32k for this model ...
 *  and i want a million context window, is that possible on the spark, for a
 *  local node. i want the most optimal"
 *
 * THE FIRST ANSWER WAS WRONG AND THE MACHINE SAID SO. The 32k was never
 * llama.cpp — it was .lcl's own LOCAL_ASSUMED_CONTEXT, shown as fact because
 * nothing asked the server. Measured over ssh on his Spark, with an ExecStart
 * carrying NO --ctx-size at all: `"n_ctx": 262144`. With no flag, llama.cpp
 * takes the model's full TRAINED context.
 *
 * So a ladder that picks a number can only take window AWAY. At the moment it
 * was written his box had 17 GB free, which would have chosen 32768 and cut him
 * from 256k to 32k while calling itself a fix. It is a SAFETY FLOOR now: with
 * room, no flag at all; when memory is too tight to start, it caps AND SAYS SO.
 *
 * PROVEN, NOT ASSERTED: the two steps run in a real shell against stub `free`,
 * `nvidia-smi` and `systemctl`, and the suite reads the unit file that lands on
 * disk. A recipe can be perfectly valid shell and still write `--ctx-size` with
 * nothing after it.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const stacks = require(path.join(ROOT, ".lcl.engine", "core", "nodeStacks.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

function shellPath() {
    for (const p of ["bash", "C:/Program Files/Git/bin/bash.exe",
                     "C:/Program Files/Git/usr/bin/bash.exe", "/bin/bash"]) {
        try { execFileSync(p, ["-c", "exit 0"], { stdio: "ignore" }); return p; }
        catch { /* next */ }
    }
    return null;
}
const SH = shellPath();
check("a shell is available to actually run the steps in", !!SH, SH);

const steps = stacks.preview("llamacpp");
const measure = steps.find(s => /LCL_CTXFLAG=/.test(s.run) && /free -m/.test(s.run));
const unit = steps.find(s => /Description=llama.cpp server/.test(s.run));
check("the recipe measures before it writes the unit", !!measure, steps.map(s => s.say));
check("...and the unit step is still there to write", !!unit, steps.map(s => s.say));

const STUBS = {
    "nvidia-smi":
        "#!/bin/sh\n" +
        "case \"$*\" in *memory.free*) [ -n \"$SIM_NFREE\" ] && echo \"$SIM_NFREE\" ;; esac\n" +
        "exit 0\n",
    "free":
        "#!/bin/sh\n" +
        "echo '              total        used        free      shared  buff/cache   available'\n" +
        "echo \"Mem: 124610 0 0 0 0 ${SIM_SFREE:-0}\"\n",
    // the unit is written and enabled; enabling it is not what this measures
    "systemctl": "#!/bin/sh\nexit 0\n"
};

function run(opts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ctx-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const [f, body] of Object.entries(STUBS)) {
        fs.writeFileSync(path.join(bin, f), body);
        fs.chmodSync(path.join(bin, f), 0o755);
    }
    const file = path.join(dir, "run.sh");
    fs.writeFileSync(file, "set -e\n" + measure.run + "\n" + unit.run + "\n");
    const env = Object.assign({}, process.env, {
        PATH: bin + path.delimiter + process.env.PATH,
        HOME: dir.replace(/\\/g, "/"),
        SIM_SFREE: String(opts.sysFree === undefined ? "" : opts.sysFree),
        SIM_NFREE: String(opts.gpuFree === undefined ? "" : opts.gpuFree)
    });
    let out = "", code = 0;
    try { out = execFileSync(SH, [file], { env, encoding: "utf8", stdio: "pipe" }); }
    catch (e) { code = e.status === undefined ? -1 : e.status;
                out = String(e.stdout || "") + String(e.stderr || ""); }
    let svc = "";
    try { svc = fs.readFileSync(
        path.join(dir, ".config", "systemd", "user", "llamacpp.service"), "utf8"); }
    catch { svc = ""; }
    fs.rmSync(dir, { recursive: true, force: true });
    return { out, code, svc, ctx: (/--ctx-size (\S+)/.exec(svc) || [])[1] || null };
}

if (SH && measure && unit) {
    /* ---- room: NO FLAG, and the model keeps its own trained window ---- */
    {
        const r = run({ sysFree: 100000, gpuFree: 100000 });
        check("WITH ROOM, NO --ctx-size IS PASSED AT ALL — llama.cpp then takes " +
              "the model's full trained context, measured at 262,144 on his Spark " +
              "from a unit carrying no flag. Naming a number here could only take " +
              "window away",
            r.code === 0 && r.ctx === null, { code: r.code, ctx: r.ctx, svc: r.svc.slice(0, 200) });
        check("...and it says so, naming the figure it measured, so the operator " +
              "knows the window was a decision and not an oversight",
            /100000 MiB free/.test(r.out) && /262,144/.test(r.out), r.out.slice(0, 260));
    }

    /* ---- his Spark AS IT STOOD: 17 GB free, three engines up ---- */
    {
        /* THE REGRESSION THIS SUITE EXISTS TO CATCH. The first version of this
         * step read 17 GB free and chose 32768 — cutting a live 256k window to
         * an eighth while reporting success. A cap is only ever a last resort to
         * let the server START, and it must announce itself as one. */
        const r = run({ sysFree: 17077, gpuFree: 17077 });
        check("ON A GENUINELY TIGHT MACHINE IT CAPS — but only to let the server " +
              "start at all",
            r.ctx === "32768", r.ctx);
        check("...and it SAYS it capped, and why, and how to get the window back. " +
              "A guard that silently downgrades what it was asked to protect is " +
              "worse than no guard",
            /CAPPING/.test(r.out) && /safety cap/.test(r.out) &&
            /free memory/i.test(r.out), r.out.slice(0, 300));
    }

    /* ---- a moderately busy machine still keeps its full window ---- */
    {
        const r = run({ sysFree: 45000, gpuFree: 45000 });
        check("45 GB free is NOT tight — no cap, no flag, full window. The old " +
              "ladder cut this case to 65,536 for no measured reason",
            r.ctx === null, r.ctx);
    }

    /* ---- the two readings disagree: the pessimistic one still wins ---- */
    {
        const r = run({ sysFree: 17000, gpuFree: 100000 });
        check("...and where the two readings of the same pool disagree, the " +
              "SMALLER still decides — same rule as the vLLM share, same reason",
            r.ctx === "32768", r.ctx);
    }

    /* ---- nothing measurable caps, because unknown is not room ---- */
    {
        const r = run({});
        check("WITH NOTHING MEASURABLE IT CAPS. Unknown free memory is not " +
              "evidence of room, and a server that will not start is worse than " +
              "a small window",
            r.code === 0 && r.ctx === "32768", { code: r.code, ctx: r.ctx });
    }

    /* ---- and the rest of the unit survived the edit ---- */
    {
        const r = run({ sysFree: 17077, gpuFree: 17077 });
        check("...the unit is otherwise intact: same binary, same model, same " +
              "host and port. Splicing a flag into a printf argument is exactly " +
              "where a quote goes missing and the ExecStart silently truncates",
            /llama-server/.test(r.svc) && /--host 0\.0\.0\.0/.test(r.svc) &&
            /--port 30000/.test(r.svc) &&
            /unsloth\/Qwen3\.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL/.test(r.svc), r.svc.slice(0, 300));
        check("...and ExecStart is ONE line — a stray newline from the splice would " +
              "give systemd a unit it parses without the flag",
            (r.svc.split("\n").filter(l => l.startsWith("ExecStart=")).length) === 1,
            r.svc.split("\n").filter(l => l.startsWith("ExecStart=")));
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
