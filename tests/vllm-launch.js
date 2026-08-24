/**
 * THE 641 RESTARTS.
 *
 * "so it is working right now on vllm install again, and been waiting on step
 *  4. can you look. without interupting."
 *
 * It had been waiting on step 4 for hours, and this is what was underneath:
 *
 *   restarts=641  exit=0
 *   ValueError: Free memory on device cuda:0 (85.92/121.69 GiB) on startup is
 *   less than desired GPU memory utilization (0.92, 111.95 GiB). Decrease GPU
 *   memory utilization or reduce GPU memory used by other processes.
 *
 * Two separate failures, and this suite pins both.
 *
 *   1. NVIDIA's playbook line is `vllm serve <model>` and nothing more, because
 *      it is written for a machine where vLLM is the only thing running. vLLM
 *      takes 0.9 of TOTAL memory by default and REFUSES TO START unless that
 *      much is free right now. Ollama and llama.cpp were holding 36 GB. Three
 *      engines cannot each assume they own the box, so the share is MEASURED.
 *
 *   2. Nothing ever looked at the restart count, so a container that could
 *      never start was indistinguishable from one still loading a model — and
 *      the wizard sat out its full fifteen minutes to say "not up". The wait
 *      step reads RestartCount now, prints what the container actually said,
 *      and where the reason is a KV cache that does not fit, relaunches once
 *      with the largest window that does.
 *
 * WHAT THIS SUITE PROVES, rather than asserts: it RUNS the two steps out of
 * nodeStacks.js in a real shell against stub `nvidia-smi`, `docker` and `curl`,
 * and reads what they were asked to do. A string check on the recipe would pass
 * against shell that never runs; this fails if the logic is wrong.
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
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 400) : ""); }
}

function shellPath() {
    for (const p of ["bash", "C:/Program Files/Git/bin/bash.exe",
                     "C:/Program Files/Git/usr/bin/bash.exe", "/bin/bash"]) {
        try { execFileSync(p, ["-c", "exit 0"], { stdio: "ignore" }); return p; }
        catch { /* try the next */ }
    }
    return null;
}
const SH = shellPath();
check("a shell is available to actually run the launch steps in — a suite that " +
      "silently could not run is worse than one that says so", !!SH, SH);

/* The steps are found by what they DO, never by index: a step added ahead of
 * these must not quietly point this suite at the wrong shell. */
const steps = stacks.preview("vllm");
const startStep = steps.find(s => /lcl-vllm-util/.test(s.run) && /docker run/.test(s.run));
const waitStep = steps.find(s => /RestartCount/.test(s.run));
check("the vLLM recipe still has a step that measures memory before it launches",
    !!startStep, steps.map(s => s.say));
check("...and a wait step that reads the container's restart count rather than " +
      "polling a dead container for fifteen minutes", !!waitStep, steps.map(s => s.say));

const STUBS = {
    "nvidia-smi":
        "#!/bin/sh\n" +
        "case \"$*\" in\n" +
        "  *memory.free*) [ -n \"$SIM_FREE\" ] && echo \"$SIM_FREE\" ;;\n" +
        "  *memory.total*) [ -n \"$SIM_TOT\" ] && echo \"$SIM_TOT\" ;;\n" +
        "esac\n" +
        "exit 0\n",
    "docker":
        "#!/bin/sh\n" +
        "cmd=\"$1\"; shift\n" +
        "case \"$cmd\" in\n" +
        "  run) echo \"$*\" >> \"$SIMDIR/runs.log\"; echo simulated-container-id ;;\n" +
        "  rm) echo \"$*\" >> \"$SIMDIR/rm.log\" ;;\n" +
        "  inspect)\n" +
        "      if grep -q -- --max-model-len \"$SIMDIR/runs.log\" 2>/dev/null; then echo 0;\n" +
        "      else echo \"${SIM_RESTARTS:-0}\"; fi ;;\n" +
        "  logs) printf '%s\\n' \"$SIM_LOG\" ;;\n" +
        "  info) echo ' Runtimes: nvidia runc' ;;\n" +
        "esac\n" +
        "exit 0\n",
    "curl":
        "#!/bin/sh\n" +
        "n=$(cat \"$SIMDIR/curl.n\" 2>/dev/null || echo 0)\n" +
        "n=$((n + 1)); echo \"$n\" > \"$SIMDIR/curl.n\"\n" +
        "if [ \"$SIM_HEALTH\" = needs-window ]; then\n" +
        "  grep -q -- --max-model-len \"$SIMDIR/runs.log\" 2>/dev/null && exit 0\n" +
        "  exit 7\n" +
        "fi\n" +
        "if [ \"$SIM_HEALTH\" = never ]; then exit 7; fi\n" +
        "if [ \"$n\" -gt \"${SIM_HEALTH:-0}\" ]; then exit 0; fi\n" +
        "exit 7\n",
    /* the system's own accounting of the same pool. Two figures for one pool is
     * only a problem when they disagree, and then the optimistic one is the one
     * that gets a container killed. */
    "free":
        "#!/bin/sh\n" +
        "echo '              total        used        free      shared  buff/cache   available'\n" +
        "echo \"Mem: ${SIM_STOT:-0} 0 0 0 0 ${SIM_SFREE:-0}\"\n" +
        "echo 'Swap: 0 0 0'\n",
    /* every real sleep in the wait loop is ten seconds, and the point of the
     * fix is that a doomed container is given up on in seconds rather than
     * fifteen minutes — so the COUNT is what gets asserted, not the clock */
    "sleep": "#!/bin/sh\nexit 0\n"
};

/** Run the named steps in one shell, exactly as `script()` joins them. */
function run(name, opts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-vllm-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const [f, body] of Object.entries(STUBS)) {
        fs.writeFileSync(path.join(bin, f), body);
        fs.chmodSync(path.join(bin, f), 0o755);
    }
    // Force the stub bin dir to the FRONT of PATH *inside* the shell. On Windows,
    // Git bash prepends its own /usr/bin at startup — and that DOES carry a real
    // curl.exe and sleep.exe — so those two stubs, passed only via env.PATH, were
    // shadowed: the real curl failed the health probe (the "already up" check
    // launched instead of skipping) and a real `sleep 10` x up to 90 iterations
    // ran ~900s and hung the suite past the gate's 600s kill. Prepending here, in
    // the running shell, wins over /usr/bin. toMsys turns a Windows path (C:\x)
    // into the /c/x form bash needs in PATH; on POSIX it is a no-op, so the Linux
    // behaviour is unchanged. docker/nvidia-smi/free are not in /usr/bin, which is
    // why those stubs worked even before this and the measurement printed.
    const toMsys = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => "/" + d.toLowerCase());
    const script = 'export PATH="' + toMsys(bin) + ':$PATH"\nset -e\n'
        + (opts.steps || []).map(s => s.run).join("\n") + "\n";
    const file = path.join(dir, "run.sh");
    fs.writeFileSync(file, script);

    const env = Object.assign({}, process.env, {
        PATH: bin + path.delimiter + process.env.PATH,
        SIMDIR: dir.replace(/\\/g, "/"),
        SIM_FREE: opts.free === undefined ? "" : String(opts.free),
        SIM_TOT: opts.total === undefined ? "" : String(opts.total),
        // roomy by default, so a scenario that says nothing about the system
        // pool is testing the nvidia figure and only the nvidia figure
        SIM_SFREE: String(opts.sysFree === undefined ? 200000 : opts.sysFree),
        SIM_STOT: String(opts.sysTotal === undefined ? 200000 : opts.sysTotal),
        SIM_RESTARTS: String(opts.restarts || 0),
        SIM_LOG: opts.log || "",
        SIM_HEALTH: String(opts.health === undefined ? "never" : opts.health)
    });
    let out = "", code = 0;
    try { out = execFileSync(SH, [file], { env, encoding: "utf8", stdio: "pipe" }); }
    catch (e) { code = e.status === undefined ? -1 : e.status;
                out = String(e.stdout || "") + String(e.stderr || ""); }
    const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); }
                          catch { return ""; } };
    const r = { out, code, runs: read("runs.log").trim(), rms: read("rm.log").trim(),
                polls: Number(read("curl.n").trim() || 0) };
    fs.rmSync(dir, { recursive: true, force: true });
    return r;
}

/* The Spark's own numbers, in the state that broke: 85.92 GiB free of 121.69,
 * because Ollama and llama.cpp already had theirs. MiB, as nvidia-smi reports. */
const SPARK_FREE = 87982, SPARK_TOT = 124610;

function utilOf(runs) {
    const m = /--gpu-memory-utilization (\S+)/.exec(runs);
    return m ? Number(m[1]) : null;
}

if (SH && startStep && waitStep) {

/* ===================================================== it asks for what is there */
{
    const r = run("sized", { steps: [startStep], free: SPARK_FREE, total: SPARK_TOT });
    const util = utilOf(r.runs);
    check("THE LAUNCH IS SIZED FROM A MEASUREMENT, NOT A DEFAULT — vLLM is told " +
          "a share, and the recipe never launches without one",
        r.code === 0 && util !== null, { code: r.code, runs: r.runs });
    /* the arithmetic, against his own numbers: 0.9 of TOTAL was 111.95 GiB of an
     * 85.92 GiB opening, which is the ValueError verbatim */
    check("...and the share it asks for FITS IN WHAT IS FREE, which is the whole " +
          "failure: the default asked for 111.95 GiB of an 85.92 GiB opening",
        util !== null && util * SPARK_TOT <= SPARK_FREE,
        { util, wants: util === null ? null : Math.round(util * SPARK_TOT), free: SPARK_FREE });
    /* 8 GiB was measured insufficient: vLLM sized itself, the operator CHATTED
     * with llama.cpp beside it, the KV cache grew into the last 8 GiB and the
     * machine thrashed until the power button. The reserve exists for the live
     * growth of the OTHER engines, not just the OS. */
    check("...and it leaves REAL headroom — a live chat model's KV cache grows, " +
          "and the margin that survives that growth is the margin that counts",
        util !== null && util * SPARK_TOT <= SPARK_FREE - 14000,
        { util, free: SPARK_FREE });
    check("...and it takes a real share of the box, not a timid sliver",
        util !== null && util >= 0.5, util);
    check("...and it says the measurement out loud, so the operator can see WHY " +
          "that number and not another one",
        r.out.includes(String(SPARK_FREE)) && r.out.includes(String(SPARK_TOT)), r.out.slice(0, 400));
}

/* ============================================ a full box is still a legal launch */
{
    const r = run("clamp", { steps: [startStep], free: 124000, total: SPARK_TOT });
    const util = utilOf(r.runs);
    check("an empty machine gets 0.90 and not more — the last tenth is what the " +
          "CUDA context, the API server and the rest of the OS live in",
        util !== null && util <= 0.90 && util >= 0.85, { util, runs: r.runs });
}

/* ================================================ no room is said, not discovered */
{
    const r = run("noroom", { steps: [startStep], free: 20000, total: SPARK_TOT });
    check("WHEN THERE IS GENUINELY NO ROOM IT SAYS SO AND STOPS, rather than " +
          "starting a container that will crash-loop until someone reads a log",
        r.code !== 0 && /LCL-VLLM-NO-ROOM/.test(r.out), { code: r.code, out: r.out.slice(0, 300) });
    check("...and nothing was launched", r.runs === "", r.runs);
    check("...and it names what is free and what to free up, because " +
          "\"no room\" with no numbers is not something anyone can act on",
        /20000/.test(r.out) && /Ollama/.test(r.out), r.out.slice(0, 400));
}

/* ============================ a machine with no nvidia-smi still gets a measurement */
{
    const r = run("fallback", { steps: [startStep], free: undefined, total: undefined,
                                sysFree: 90000, sysTotal: SPARK_TOT });
    const util = utilOf(r.runs);
    check("with no figure from nvidia-smi it falls back to the system pool — on " +
          "a Spark that IS the GPU pool — and never launches unmeasured",
        util !== null && util * SPARK_TOT <= 90000 - 4096,
        { util, code: r.code, out: r.out.slice(0, 300) });
}

/* ============================== two figures for one pool, and the smaller one wins */
{
    /* If unified-memory accounting ever makes nvidia-smi report a nearly empty
     * board while the system knows 36 GB of it is spoken for, the optimistic
     * figure is the one that ends in a ValueError and 641 restarts. */
    // 50000, not 40000: with the 16 GiB reserve a 40 GB opening is now below
    // the 20% floor and correctly refuses — which is its own scenario below,
    // not this one. This one is about which of two figures gets BELIEVED.
    const r = run("disagree", { steps: [startStep], free: 120000, total: SPARK_TOT,
                                sysFree: 50000, sysTotal: SPARK_TOT });
    const util = utilOf(r.runs);
    check("WHERE THE TWO MEASUREMENTS DISAGREE, THE PESSIMISTIC ONE WINS — the " +
          "optimistic figure is the one that gets the container killed",
        util !== null && util * SPARK_TOT <= 50000, { util, runs: r.runs });
}

/* ====================================================== already serving is left alone */
{
    const r = run("already", { steps: [startStep], free: SPARK_FREE, total: SPARK_TOT, health: 0 });
    check("a vLLM that is already answering is NOT torn down and relaunched — " +
          "re-running an install must not evict a model someone is using",
        r.code === 0 && r.runs === "" && /LCL-VLLM-ALREADY-UP/.test(r.out),
        { code: r.code, runs: r.runs, out: r.out.slice(0, 200) });
}

/* =========================================================== the crash loop, seen */
{
    const r = run("crashloop", {
        steps: [waitStep], restarts: 5, health: "never",
        log: "(EngineCore pid=253) ValueError: Free memory on device cuda:0 " +
             "(85.92/121.69 GiB) on startup is less than desired GPU memory " +
             "utilization (0.92, 111.95 GiB).\n" +
             "(APIServer pid=1) RuntimeError: Engine core initialization failed."
    });
    check("A CONTAINER THAT CANNOT START IS GIVEN UP ON, not polled for fifteen " +
          "minutes — 641 restarts looked exactly like a model still loading",
        r.code !== 0 && /LCL-VLLM-CRASHLOOP/.test(r.out), { code: r.code, out: r.out.slice(0, 300) });
    check("...in seconds, not in ninety polls", r.polls < 10, r.polls);
    check("...and it prints what the container actually said, so the reason is on " +
          "the screen instead of behind a docker logs the operator has no terminal for",
        /Free memory on device/.test(r.out), r.out.slice(0, 500));
    check("...and it says how many times it restarted, which is the fact that " +
          "distinguishes \"not started yet\" from \"never going to\"",
        /restarted 5 times/.test(r.out), r.out.slice(0, 300));
    check("...and the loop is STOPPED rather than left burning cycles on a " +
          "machine the operator has walked away from",
        /vllm-server/.test(r.rms), r.rms);
}

/* ========================================= the second trap, and it fixes itself once */
{
    const r = run("kvcache", {
        steps: [waitStep], restarts: 4, health: "needs-window",
        log: "ValueError: The model's max seq len (131072) is larger than the " +
             "maximum number of tokens that can be stored in KV cache (65536). " +
             "Try increasing gpu_memory_utilization or decreasing max_model_len."
    });
    check("THE OTHER LAUNCH-TIME TRAP FIXES ITSELF: a window too big for the KV " +
          "cache relaunches at the largest window that fits, and comes up",
        r.code === 0 && /LCL-VLLM-UP/.test(r.out), { code: r.code, out: r.out.slice(0, 400) });
    check("...at the number the container itself reported, not one this app " +
          "picked — 65536 is read out of the error, never guessed",
        /--max-model-len 65536/.test(r.runs), r.runs);
    check("...and the memory share it measured is carried into the relaunch",
        /--gpu-memory-utilization 0\.\d+ --max-model-len/.test(r.runs), r.runs);
    check("...once. A retry that retries forever is the crash loop again",
        (r.runs.match(/--max-model-len/g) || []).length === 1, r.runs);
}

/* ============================================ and the ordinary case still passes */
{
    const r = run("healthy", { steps: [waitStep], health: 2 });
    check("a container that comes up after a couple of polls is reported up",
        r.code === 0 && /LCL-VLLM-UP/.test(r.out), { code: r.code, out: r.out.slice(0, 200) });
    check("...and nothing was torn down on the way", r.rms === "", r.rms);
}

/* =================================================== the flag can never go missing */
{
    const src = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "nodeStacks.js"), "utf8");
    // the recipe LINES, not the comment above them that quotes the playbook
    const serves = src.match(/"vllm serve[^\n]*/g) || [];
    check("EVERY `vllm serve` IN THE TABLE CARRIES A MEASURED SHARE. The default " +
          "is 0.9 of a box that already has two other engines on it, and this is " +
          "the line that must never be copied out of a playbook unchanged",
        serves.length > 0 && serves.every(l => /--gpu-memory-utilization/.test(l) ||
            /VLLM_MODEL \+ " --gpu-memory-utilization/.test(l)),
        serves);
}

}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
