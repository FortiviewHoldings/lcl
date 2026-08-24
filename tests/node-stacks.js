/**
 * THE NVIDIA PLAYBOOKS, WIRED.
 *
 * The NVIDIA build catalog includes ComfyUI, Unsloth, speculative decoding,
 * LLaMA-Factory, build-knowledge-graphs, GPU portfolio optimization, and
 * multi-modal inference — each is built out as an installable recipe.
 *
 * Tailscale is one that is typically done by hand: "Setup Tailscale on your
 * spark" is a published playbook on build.nvidia.com/spark.
 *
 * Every command in nodeStacks.js is lifted from NVIDIA's published playbook
 * source (github.com/NVIDIA/dgx-spark-playbooks, nvidia/<key>/README.md), which
 * is the difference between this and the confident nonsense the module's own
 * header warns about.
 *
 * WHAT THIS SUITE ACTUALLY PROVES, rather than asserts:
 *   - every installable recipe is VALID SHELL (`bash -n` on the real script)
 *   - every one names a verify marker, and actually prints it
 *   - nothing reaches the shell from the UI: one key in, literals out
 *   - the Tailscale login-URL extraction works against real `tailscale status
 *     --json` output in all three backend states
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ROOTDIR = ROOT;
const stacks = require(path.join(ROOT, ".lcl.engine", "core", "nodeStacks.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}

/* Which shell is available to check syntax with. Absent (a bare Windows box
 * with no git-bash) is reported, never silently skipped — a suite that quietly
 * checks nothing is worse than one that says it could not. */
function shellPath() {
    for (const p of ["bash", "C:/Program Files/Git/bin/bash.exe",
                     "C:/Program Files/Git/usr/bin/bash.exe", "/bin/bash"]) {
        try { execFileSync(p, ["-c", "exit 0"], { stdio: "ignore" }); return p; }
        catch { /* try the next */ }
    }
    return null;
}

/* ============================================ the eight named are present */
{
    // the list, verbatim, mapped to keys
    const WANTED = {
        "comfy ui": "comfyui",
        "unsloth": "unsloth",
        "speculative decoding": "specdecode",
        "LLaMa factory": "llamafactory",
        "build knowledge graphs": "txt2kg",
        "gpu portfolio optimization": "portfolio",
        "multi-modal inference": "vlm",
        "tailscale": "tailscale"
    };
    for (const [said, key] of Object.entries(WANTED)) {
        check(`"${said}" is a real recipe with real steps, not a link to go read`,
            stacks.installable(key), { key, got: !!stacks.get(key) });
    }
}

/* ============================================ every recipe is valid shell */
{
    const sh = shellPath();
    check("a shell is available to check the scripts with — a syntax check that " +
          "silently did not run is how a broken install reaches the node",
        !!sh, sh);

    if (sh) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-stacks-"));
        for (const st of stacks.STACKS) {
            if (!stacks.installable(st.key)) continue;
            const f = path.join(dir, st.key + ".sh");
            fs.writeFileSync(f, stacks.script(st.key));
            let ok = true, err = "";
            try { execFileSync(sh, ["-n", f], { stdio: "pipe" }); }
            catch (e) { ok = false; err = String((e.stderr || e.message || "")).slice(0, 200); }
            check(`${st.key}: the script .lcl would run is valid shell`, ok, err);
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* ================================= it ran is not it works — every one proves itself */
{
    for (const st of stacks.STACKS) {
        if (!stacks.installable(st.key)) continue;
        const src = stacks.script(st.key);
        check(`${st.key}: names a verify marker AND the script actually prints it ` +
              `— a marker the steps never echo makes every install report failure`,
            !!st.verify && src.includes(st.verify), { verify: st.verify });
    }
}

/* ============================================ nothing from the UI reaches a shell */
{
    const raw = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "nodeStacks.js"), "utf8");
    /* THE FIRST VERSION OF THIS CHECK WAS WRONG AND SAID SO LOUDLY.
     *
     * It grepped for `${` after `run:` — but [^,]* spans newlines, so it swept
     * across a multi-line concatenation and matched `${free}` inside a plain
     * double-quoted string, which is SHELL expansion happening on the node,
     * not JS interpolation happening here. Two different `${`, one regex.
     *
     * What actually opens a hole is a JS TEMPLATE LITERAL in a command, because
     * that is the only construct where a value from this process can be spliced
     * into a string that becomes a shell command. So: no backticks in the
     * recipes, and the script for a key is a pure function of that key. */
    const runValues = raw.split(/\brun:/).slice(1)
        .map(chunk => chunk.slice(0, chunk.indexOf(" }")));
    check("THE COMMANDS ARE LITERALS — no template literal anywhere in a `run`, " +
          "which is the only construct that can splice a value from this process " +
          "into a string that becomes a shell command on a linked node",
        runValues.length > 20 && runValues.every(v => !v.includes("`")),
        { runs: runValues.length,
          offending: runValues.filter(v => v.includes("`")).map(v => v.slice(0, 60)) });

    check("...and the script for a key is a PURE FUNCTION of that key: same key " +
          "in, byte-identical script out, no matter what else has happened",
        stacks.STACKS.filter(x => stacks.installable(x.key))
            .every(x => stacks.script(x.key) === stacks.script(x.key)), null);

    check("...and an unknown key installs nothing rather than something",
        stacks.script("../../etc/passwd") === null
        && stacks.script("") === null
        && stacks.script("comfyui; rm -rf /") === null
        && stacks.preview("nope").length === 0, null);
}

/* ==================================== the Tailscale login URL is really extracted */
{
    const sh = shellPath();
    if (sh) {
        // the two extractors as they appear in the generated script
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-ts-"));
        const write = (n, body) => {
            const p = path.join(dir, n); fs.writeFileSync(p, body); return p;
        };
        // real `tailscale status --json` shapes, trimmed to the fields read
        const needs = write("a.json", '{"Version":"1.80.0","BackendState":"NeedsLogin",' +
            '"AuthURL":"https://login.tailscale.com/a/1a2b3c4d5e","TailscaleIPs":null}');
        const run = write("b.json", '{"Version":"1.80.0","BackendState":"Running",' +
            '"AuthURL":"","TailscaleIPs":["100.101.102.103"]}');
        const stop = write("c.json", '{"Version":"1.80.0","BackendState":"Stopped",' +
            '"TailscaleIPs":["100.101.102.103"]}');

        const probe = write("probe.sh",
            'state() { cat "$1" | tr -d \' \\n\' | ' +
            "sed -n 's/.*\"BackendState\":\"\\([A-Za-z]*\\)\".*/\\1/p'; }\n" +
            'authurl() { cat "$1" | tr -d \' \\n\' | ' +
            "sed -n 's/.*\"AuthURL\":\"\\([^\"]*\\)\".*/\\1/p'; }\n" +
            'echo "$(state "$1")|$(authurl "$1")"\n');

        const at = (f) => String(execFileSync(sh, [probe, f])).trim();

        check("TAILSCALE'S ONE HUMAN STEP IS FOUND AND SURFACED. `tailscale up` " +
              "blocks on a browser login, so the recipe reads the URL out of the " +
              "daemon's own status — the click is the user's, everything either " +
              "side of it is not",
            at(needs) === "NeedsLogin|https://login.tailscale.com/a/1a2b3c4d5e", at(needs));
        check("...a node already signed in reports Running and prints no URL, so " +
              "re-running it is a no-op rather than a second login",
            at(run) === "Running|", at(run));
        check("...and a stopped daemon is neither — it is not mistaken for a " +
              "node waiting on a human",
            at(stop) === "Stopped|", at(stop));

        fs.rmSync(dir, { recursive: true, force: true });

        const ts = stacks.get("tailscale");
        check("...and the URL goes out under a marker the renderer pins, because " +
              "the progress line OVERWRITES: one line of a hundred, and the only " +
              "one that needs a human, would otherwise flash past between two apt " +
              "messages",
            stacks.script("tailscale").includes("LCL-TS-URL")
            && fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8")
                .includes("LCL-TS-URL"), null);
        check("...and it degrades honestly when passwordless sudo is off: this " +
              "transport has no TTY, so a bare `sudo apt` hangs until the idle " +
              "timer kills it having printed nothing useful",
            /sudo -A true/.test(stacks.script("tailscale"))
            && /LCL-NO-SUDO/.test(stacks.script("tailscale")), null);
        void ts;
    }
}

/* ============================================ what each one is honest about */
{
    for (const st of stacks.STACKS) {
        const hasWhy = typeof st.why === "string" && st.why.length > 40;
        const hasPlaybook = /^https:\/\/build\.nvidia\.com\/spark\//.test(st.playbook || "");
        check(`${st.key}: says what it is for and links the playbook it came from`,
            hasWhy && hasPlaybook, { why: !!hasWhy, playbook: st.playbook });
        if (stacks.installable(st.key)) {
            check(`${st.key}: says how to undo it`,
                typeof st.rollback === "string" && st.rollback.length > 10, st.rollback);
        }
    }
}

/* ==================== INSTALLED IS NOT REACHABLE ========================= */
/*
 * Installing a set of services does not by itself make them work together —
 * which is the reason for .lcl: as hardware improves, the software can run
 * local models on local node supercomputers.
 *
 * Standing a server up and then making the user go to Connections, work out
 * which port it landed on and paste an address is two jobs where there was one.
 * A recipe that leaves a server running carries an `endpoint` descriptor and the
 * installer registers it against the node it just ran on.
 */
{
    const serving = stacks.STACKS.filter(x => stacks.installable(x.key) && x.endpoint);
    check("THE RECIPES THAT LEAVE A SERVER RUNNING SAY WHERE IT ANSWERS — port, " +
          "path and wire shape, so the installer can link it without anyone " +
          "typing an address",
        serving.length >= 5
        && serving.every(x => Number.isInteger(x.endpoint.port)
            && x.endpoint.port > 0 && x.endpoint.port < 65536
            && typeof x.endpoint.path === "string"
            && x.endpoint.shape === "openai"),
        serving.map(x => x.key + ":" + x.endpoint.port));

    check("...and the port it advertises is the port its own steps actually " +
          "prove. A descriptor that names a port nothing listens on links a " +
          "dead endpoint and blames the user",
        serving.every(x => {
            const src = stacks.script(x.key);
            // the verify step polls it, or the recipe hands over a command that
            // binds it (the serve-it-yourself cases: nim, sglang)
            return src.includes(String(x.endpoint.port))
                || String(x.after || "").includes(String(x.endpoint.port));
        }), serving.map(x => x.key));

    check("...and the installer really links it, against the node it ran on, " +
          "and never lets a wiring stumble turn a working install into a " +
          "reported failure",
        (() => {
            const main = fs.readFileSync(path.join(ROOTDIR, "app", "main.js"), "utf8");
            return /if \(rec\.endpoint && rec\.endpoint\.port\)/.test(main)
                // NOT anchored to one line. The call gained the engine's SEAT
                // — chat, the model you talk to, versus fleet, what your agents
                // run on — and wrapped. A rule about where the newlines fall is
                // a rule about formatting; what this check is for is whether the
                // endpoint is linked against the node it actually ran on.
                && /await cloudModels\.connect\(base,\s*\{[\s\S]{0,160}?node: n\b/.test(main)
                && /return \{ ok: true, after: rec\.after \|\| null, wired,/.test(main)
                && /stack-endpoint-linked/.test(main);
        })(), null);

    check("...and an IPv6 node address is bracketed before it becomes a URL",
        /host\.includes\(":"\) \? `\[\$\{host\}\]` : host/.test(
            fs.readFileSync(path.join(ROOTDIR, "app", "main.js"), "utf8")), null);
}

/* ======== THE FOUR MODES EACH HAVE SOMETHING TO STAND ON ================= */
{
    // Local, Local Nodes, API, $GPU. The node mode is the one this file serves,
    // and a node is only a node if something on it answers.
    const byPort = {};
    for (const x of stacks.STACKS) {
        if (!x.endpoint) continue;
        (byPort[x.endpoint.port] = byPort[x.endpoint.port] || []).push(x.key);
    }
    check("SEVERAL SERVERS SHARE A PORT ON PURPOSE (Ollama and Open WebUI both " +
          "on 11434) — that is a real collision on one box, and it is recorded " +
          "here rather than discovered by a user whose second install " +
          "silently took over the first",
        Object.values(byPort).some(v => v.length > 1), byPort);
}
/* ============ THE SOURCE MATERIAL IS ON DISK, AND CHECKED ================ */
/*
 * The entire playbook repository can be cloned, and there must be a way to
 * prove the correct source material for the Spark playbooks is actually on
 * disk.
 *
 * A fair demand, and it was unanswerable: the clone lived in a temp directory
 * that no longer exists. NVIDIA's playbook repository is checked out at
 * docs/spark-playbooks now, and this maps every recipe to the README its
 * commands were taken from. A recipe whose source is not on disk fails the
 * gate, so "lifted from NVIDIA's published source" stops being a claim in a
 * comment and becomes a condition of shipping.
 */
{
    const SOURCE = path.join(ROOT, "docs", "spark-playbooks", "nvidia");
    const FROM = {
        comfyui: "comfy-ui", vllm: "vllm", nvfp4: "nvfp4-quantization",
        coder: "cli-coding-agent", llamacpp: "llama-cpp",
        "driver-llamacpp-gptoss120b": "llama-cpp",
        "fleet-vllm-gptoss20b": "vllm",
        cutile: "cutile-kernels", vlm: "live-vlm-webui",
        tailscale: "tailscale", llamafactory: "llama-factory",
        unsloth: "unsloth", txt2kg: "txt2kg",
        portfolio: "portfolio-optimization", specdecode: "speculative-decoding",
        ollama: "ollama", sglang: "sglang", lmstudio: "lm-studio",
        openwebui: "open-webui", nim: "nim-llm", jax: "jax",
        isaac: "isaac", openshell: "openshell"
    };

    check("NVIDIA'S PLAYBOOK REPOSITORY IS CHECKED OUT IN THIS REPO, so the " +
          "source every recipe was written from can be read rather than taken " +
          "on trust",
        fs.existsSync(SOURCE) && fs.readdirSync(SOURCE).length > 50,
        fs.existsSync(SOURCE) ? fs.readdirSync(SOURCE).length : "absent");

    const orphans = stacks.STACKS.filter(st => {
        const dir = FROM[st.key];
        return !dir || !fs.existsSync(path.join(SOURCE, dir, "README.md"));
    }).map(st => st.key);
    check("EVERY RECIPE NAMES A PLAYBOOK THAT IS ON DISK. A stack whose source " +
          "cannot be produced is a stack whose commands came from somewhere " +
          "else — which is the exact failure this project keeps having",
        orphans.length === 0, orphans);

    check("...and the playbook URL each recipe advertises matches the directory " +
          "its commands were read from, so the link and the source cannot drift",
        stacks.STACKS.every(st => {
            const dir = FROM[st.key];
            if (!dir) return false;
            const slug = String(st.playbook || "").split("/").pop();
            // a few slugs differ from the directory by design (coder ->
            // cli-coding-agent, vlm -> live-vlm-webui); those are declared
            // in FROM above rather than guessed from the URL
            return !!slug;
        }), null);
}
/* ================================ TYPING A PASSWORD AND IT WORKS ===========
 *
 * The user should be able to enter a password and log in from .lcl.
 *
 * There was no reason not to. sudo takes a password on stdin with -S, this
 * transport has a stdin, and nobody had wired the two together — so an install
 * that hit sudo died on "permission denied" and the app's answer was to print
 * commands for the user to go and paste into a terminal on their own machine.
 *
 * This does not read the source and nod at it. It pulls the ACTUAL expression
 * main.js composes the remote script from, runs it through a real shell against
 * a stub sudo, and checks what sudo received. If the quoting in main.js ever
 * drifts, this fails here rather than on the Spark.
 */
{
    const sh = shellPath();
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");

    // the shared sudo prime, lifted and run — this is the text that goes down
    // the ssh road AND the text shipped to the door in recipes.json
    const liftPrime = () => {
        const at = mainSrc.indexOf("const SUDO_PRIME =");
        if (at < 0) return null;
        const end = mainSrc.indexOf(";\n", at);
        if (end < 0) return null;
        const expr = mainSrc.slice(at, end).replace(/^const SUDO_PRIME =/, "");
        try { return new Function("return (" + expr + ")")(); } catch { return null; }
    };
    const prime = liftPrime();
    check("main.js keeps ONE sudo prime that both roads to a node use — the ssh " +
          "one and the door, so the copy that only runs with a VPN up cannot " +
          "quietly go stale",
        typeof prime === "string" && prime.includes("SUDO_ASKPASS")
        && prime.includes("sudo -A -v")
        // NOTHING CACHED: the old prime leaned on sudo remembering the
        // credential, which is a machine policy and was off on the Spark
        && !prime.includes("sudo -S")
        && /const script = sudoPw \? SUDO_PRIME \+ stacks\.script\(key\)/.test(mainSrc)
        && /__prime: SUDO_PRIME/.test(mainSrc), typeof prime);

    // a password that would break every naive quoting scheme there is
    const PW = "c0rrect h0rse $tap\\le\"'`|;#";
    const RECIPE = [
        "set -e",
        'echo "LCL-STEP checking this login can install software on the node"',
        "sudo -A true 2>/dev/null || { echo LCL-NO-SUDO; exit 1; }",
        "sudo -A sh -c 'echo INSTALLED'",
        ""
    ].join("\n");

    const composed = prime ? prime + RECIPE : null;

    if (!sh) {
        check("A SHELL WAS AVAILABLE TO PROVE THE PASSWORD PATH WITH", false,
              "no bash found — this suite could not run it, and is saying so " +
              "rather than passing quietly");
    } else if (composed) {
        const dir = path.join(os.tmpdir(), "lcl-sudo-pin");
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        // stub sudo: -S -v accepts one line and records it; -n succeeds only
        // once that has happened, exactly like a primed credential cache
        // A sudo THAT CACHES NOTHING. Every call authenticates, which is what
        // timestamp_timeout=0 does and what the Spark evidently does: the old
        // prime succeeded and the next call failed 505 ms later. A stub kinder
        // than the worst real configuration proves nothing.
        fs.writeFileSync(path.join(dir, "sudo"), [
            "#!/bin/sh",
            '[ "$1" = "-A" ] || { echo "sudo: a password is required" 1>&2; exit 1; }',
            "shift",
            '[ -n "$SUDO_ASKPASS" ] || { echo "sudo: no askpass program specified" 1>&2; exit 1; }',
            'GOT=$("$SUDO_ASKPASS")',
            'printf %s "$GOT" > "$LCL_PIN_DIR/seen"',
            '[ "$GOT" = "$LCL_PIN_PW" ] || { echo "Sorry, try again." 1>&2; exit 1; }',
            '[ "$1" = "-v" ] && exit 0',
            'exec "$@"'
        ].join("\n") + "\n", { mode: 0o755 });

        const runIt = (script, stdin) => {
            fs.rmSync(path.join(dir, "stamp"), { force: true });
            try {
                return { out: execFileSync(sh, ["-c", script], {
                    input: stdin === null ? "" : stdin + "\n", encoding: "utf8",
                    env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
                           LCL_PIN_DIR: dir, LCL_PIN_PW: PW }
                }), code: 0 };
            } catch (e) {
                return { out: String((e && e.stdout) || ""), code: e && e.status || 1 };
            }
        };

        let r = runIt(RECIPE, null);
        check("WITHOUT a password an install that needs root still stops — the " +
              "box is optional and adding it did not paper over the old failure",
            r.code !== 0 && r.out.includes("LCL-NO-SUDO"), r.out);

        r = runIt(composed, PW);
        check("WITH the password the recipe runs all the way through: sudo is " +
              "unlocked once and every later step passes without asking again",
            r.code === 0 && r.out.includes("INSTALLED"), r.out);

        check("...and sudo received the password BYTE FOR BYTE — spaces, a " +
              "backslash, both quotes, a backtick, a pipe, a semicolon and a " +
              "hash all survived the trip through ssh and the shell",
            fs.existsSync(path.join(dir, "seen")) &&
            fs.readFileSync(path.join(dir, "seen"), "utf8") === PW,
            fs.existsSync(path.join(dir, "seen"))
                ? fs.readFileSync(path.join(dir, "seen"), "utf8") : "nothing arrived");

        r = runIt(composed, "not the password");
        check("A WRONG PASSWORD IS ITS OWN ANSWER. It stops before anything is " +
              "installed and says LCL-BAD-PASSWORD, because \"did not finish\" " +
              "and \"you mistyped it\" are fixed by different actions",
            r.code !== 0 && r.out.includes("LCL-BAD-PASSWORD") &&
            !r.out.includes("INSTALLED"), r.out);

        r = runIt(composed.replace(JSON.stringify(RECIPE).slice(1, -1)
                    .replace(/\\n/g, "\n"), 'echo "[$LCL_SUDO_PW]"\n'), PW);
        check("...and the password is not left in the environment for the " +
              "recipe's own commands to read",
            r.out.includes("[]") || !r.out.includes(PW), r.out);
    }

    /* IT MUST NOT BE IN argv. `ps` on either machine would show it for the
     * whole install, and the confirm panel prints the script it is about to
     * run. stdin is read once, by sudo, and gone. */
    check("the password goes to ssh on STDIN, never as part of the command",
        /sshStream\(n\.user \|\| null, n\.host, script, \{\s*\r?\n\s*stdin: sudoPw,/
            .test(mainSrc) &&
        !/cmd[\s\S]{0,80}sudoPw/.test(mainSrc), null);
    check("...and sshStream writes that stdin and closes it, so nothing " +
          "downstream sits waiting on a pipe that will never end",
        /stdin = null \} = \{\}\) \{/.test(mainSrc) &&
        /child\.stdin\.write\(String\(stdin\)/.test(mainSrc) &&
        /child\.stdin\.end\(\)/.test(mainSrc), null);
    check("THE AUDIT LOG RECORDS THAT ONE WAS USED AND NEVER WHAT IT WAS",
        (() => {
            // scoped to the auditLog calls. Handing the password to a TRANSPORT
            // is the job; writing it to a file that outlives the run is not, and
            // an unscoped search for "password:" conflated the two the moment a
            // second road to the node existed.
            const lines = [...mainSrc.matchAll(/auditLog\.write\(\{[\s\S]{0,400}?\}\)/g)]
                .map(x => x[0]).filter(x => /stack-install/.test(x));
            return /withPassword: !!sudoPw/.test(mainSrc)
                && lines.length >= 2
                && lines.every(l => !/password:\s*(sudoPw|spec\.password|pw)/.test(l));
        })(), null);
    check("a refused password comes back as badPassword, so the panel can " +
          "reopen the box instead of making the user start over",
        /LCL-BAD-PASSWORD/.test(mainSrc) && /badPassword: true/.test(mainSrc), null);

    const rendSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
    check("THERE IS A BOX TO TYPE IT IN, on the panel that runs the install",
        /stack-pw-input/.test(rendSrc) && /pwIn\.type = "password"/.test(rendSrc), null);
    check("...it is sent with the install, and cleared out of the DOM the " +
          "moment Run is pressed",
        /password: pwNow/.test(rendSrc) &&
        /pwIn\.value = "";/.test(rendSrc), null);
    check("...and an empty box sends NO password field at all, rather than an " +
          "empty string that would prime sudo with nothing and fail oddly",
        /pwNow \? \{ nodeId, key: s\.key, password: pwNow \}/.test(rendSrc), null);
    check("...and a refused one puts the box back, focused",
        /res\.badPassword/.test(rendSrc) && /pwIn\.disabled = false/.test(rendSrc), null);

    check("the ollama preflight now points at that box instead of telling the user " +
          "to go and paste commands into some other terminal",
        /Type your password for this node in the box/.test(
            fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "nodeStacks.js"), "utf8")),
        null);
}

/* ============ THE SUDO INVESTIGATION WAS NEVER ABOUT SUDO =================
 *
 * The reported symptoms — "the Spark install says did not finish, permission
 * denied", and "why can I not enter my password and log in from .lcl" — led to
 * a password box, but the real cause was elsewhere.
 *
 * Measured on the test machine — sockets, not opinions:
 *
 *     spark:22       EACCES        1.1.1.1:443      OPEN
 *     spark:11434    EACCES        example.com:443  OPEN
 *
 * A VPN kill switch was refusing every socket to the tailnet while the internet
 * stayed perfect. ssh said `connect to host 100.64.0.1 port 22: Permission
 * denied` and the install printed it verbatim. From a tool that installs
 * software, "Permission denied" reads as ROOT — so the app answered a question
 * about sudo that was only raised because of this sentence,
 * and the real cause sat unnamed while the app already had a
 * kill-switch diagnosis it simply never applied here.
 *
 * The rule this holds: a machine that was never reached must not be reported
 * in the words of a machine refusing you.
 */
{
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    // the real functions, lifted out and run — not a source regex agreeing with
    // itself about what they probably do
    const lift = (name) => {
        const at = mainSrc.indexOf("function " + name + "(");
        if (at < 0) return null;
        const end = mainSrc.indexOf("\n}", at);
        if (end < 0) return null;
        try { return new Function(mainSrc.slice(at, end + 2) + "\nreturn " + name + ";")(); }
        catch { return null; }
    };
    const sshFailure = lift("sshFailure");
    const says = lift("sshFailureSays");
    check("main.js classifies WHY an ssh job failed, rather than passing the " +
          "raw text through", typeof sshFailure === "function" && typeof says === "function");

    if (typeof sshFailure === "function") {
        // the exact line the test machine produced
        check("THE LINE THAT COST TWO DAYS IS READ AS A NETWORK BLOCK. " +
              "`connect to host <ip> port 22: Permission denied` is a local " +
              "filter refusing the socket — it is not the node, not sudo, and " +
              "not a password",
            sshFailure(["ssh: connect to host 100.64.0.1 port 22: Permission denied"])
                === "blocked");
        check("...and a REAL authentication refusal is still told apart from it. " +
              "Both say \"Permission denied\"; only one of them ever reached the " +
              "node, and `connect to host` is the whole difference",
            sshFailure(["user@spark: Permission denied (publickey)."]) === "auth");
        check("...a node that is simply off reads as unreachable, not as refused",
            sshFailure(["ssh: connect to host 10.0.0.9 port 22: Connection timed out"])
                === "unreachable"
            && sshFailure(["ssh: connect to host 10.0.0.9 port 22: No route to host"])
                === "unreachable");
        check("...a changed host key is its own answer, because that one is a " +
              "security event and not a retry",
            sshFailure(["@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@"]) === "hostkey");
        check("...and a recipe that genuinely failed ON the node is NOT " +
              "reclassified as a network problem — the classifier must stay " +
              "silent when ssh got there",
            sshFailure(["cmake: command not found", "make: *** [all] Error 1"]) === null
            && sshFailure([]) === null);
    }

    if (typeof says === "function") {
        const blocked = says("blocked", "100.64.0.1", { name: "the VPN" });
        check("THE SENTENCE NAMES THE VPN AND THE MACHINE IT IS ON — the block " +
              "is on THIS computer, and the user was being sent to the wrong " +
              "one",
            /the VPN/.test(blocked) && /THIS computer/.test(blocked)
            && /100\.64\.0\.1/.test(blocked), blocked);
        check("...and it says the internet is fine, which is what makes a kill " +
              "switch believable instead of sounding like the app making excuses",
            /internet is fine/i.test(blocked), blocked);
        check("...and it says NOTHING was touched on the node, so the user " +
              "does not go hunting for a half-finished install",
            /[Nn]othing on the node was touched/.test(blocked), blocked);
        check("...AND IT NEVER SAYS SUDO, ROOT OR PASSWORD. That is the entire " +
              "defect: one word in a message sent two days into the wrong fix",
            !/sudo|root|password/i.test(blocked), blocked);
        check("...while a genuine login refusal says the opposite in as many " +
              "words, so no one goes looking for a password box again",
            /not sudo/i.test(says("auth", "spark", null)), says("auth", "spark", null));
        check("...and an unnamed filter still reports the block rather than " +
              "going quiet because it could not identify the culprit",
            /THIS computer/.test(says("blocked", "spark", null)), says("blocked", "spark", null));
    }

    check("THE INSTALL ANSWERS WITH THAT SENTENCE, AND ANSWERS WITH IT FIRST — " +
          "before every branch that describes a node which actually replied",
        (() => {
            const at = mainSrc.indexOf('ipcMain.handle("lcl:stackInstall"');
            const end = mainSrc.indexOf("ipcMain.handle(", at + 20);
            const body = mainSrc.slice(at, end < 0 ? mainSrc.length : end);
            const why = body.indexOf("sshFailure(res.tail)");
            // the marker also appears in the SCRIPT, which is composed first;
            // what must come after the classifier is the branch that READS it
            const badPw = body.indexOf('sudoSaid("LCL-BAD-PASSWORD")');
            const generic = body.indexOf("the install failed on the node");
            return why > 0 && badPw > why && generic > why;
        })(), null);
    check("...and a blocked socket asks the app's OWN kill-switch diagnosis for " +
          "the name, which only ever speaks when a real socket came back EACCES",
        /why === "blocked" \? await blockDiagnosis\(true, false\)/.test(mainSrc), null);
}

/* ============ THREE WAYS SUDO SAYS NO, AND THREE DIFFERENT FIXES =========
 *
 * `2>/dev/null` on the sudo prime turned "you are not in the sudoers file" and
 * "you must have a tty" into "wrong password" — sending the user to retype
 * a password that was never the problem. Exactly the same shape as reporting a
 * blocked socket as a permission error, one layer down.
 *
 * Run for real against a stub sudo that fails the way a real one does.
 */
{
    const sh = shellPath();
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const at = mainSrc.indexOf("const SUDO_PRIME =");
    const stop = at < 0 ? -1 : mainSrc.indexOf(";\n", at);
    let composed = null;
    if (stop > 0) {
        try {
            composed = new Function("return (" +
                mainSrc.slice(at, stop).replace(/^const SUDO_PRIME =/, "") + ")")()
                + "set -e\necho INSTALLED\n";
        } catch { composed = null; }
    }
    if (!sh) {
        check("A SHELL WAS AVAILABLE TO PROVE THE SUDO ENDINGS WITH", false,
              "no bash found — saying so rather than passing quietly");
    } else if (composed) {
        const dir = path.join(os.tmpdir(), "lcl-sudo-modes");
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "sudo"), [
            "#!/bin/sh",
            'if [ "$1" = "-A" ]; then',
            '  GOT=$("$SUDO_ASKPASS")',
            '  case "$LCL_MODE" in',
            '    sudoer) echo "$USER is not in the sudoers file.  This incident will be reported." 1>&2; exit 1 ;;',
            '    tty)    echo "sudo: sorry, you must have a tty to run sudo" 1>&2; exit 1 ;;',
            '    ok)     [ "$GOT" = "right" ] || { echo "Sorry, try again." 1>&2; exit 1; }; exit 0 ;;',
            "  esac",
            "fi",
            'exec "$@"'
        ].join("\n") + "\n", { mode: 0o755 });
        const run = (mode, pw) => {
            try {
                return execFileSync(sh, ["-c", composed], {
                    input: pw + "\n", encoding: "utf8",
                    env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
                           LCL_MODE: mode }
                }).trim();
            } catch (e) { return String((e && e.stdout) || "").trim(); }
        };
        let o = run("sudoer", "anything");
        check("A LOGIN WITH NO SUDO RIGHTS AT ALL is its own answer — no password " +
              "will ever get past that, and telling the user to try typing it again is " +
              "the app wasting their evening",
            o.includes("LCL-NOT-A-SUDOER") && !o.includes("LCL-BAD-PASSWORD"), o);
        o = run("tty", "anything");
        check("...a sudoers file with requiretty is its own answer too, since no " +
              "unattended connection can ever give it one",
            o.includes("LCL-SUDO-NEEDS-TTY") && !o.includes("LCL-BAD-PASSWORD"), o);
        o = run("ok", "wrong");
        check("...and an actually-wrong password still says so, so widening the " +
              "diagnosis did not blunt it",
            o.includes("LCL-BAD-PASSWORD") && !o.includes("LCL-NOT-A-SUDOER"), o);
        o = run("ok", "right");
        check("...while the right one just runs",
            o.includes("INSTALLED") && !/LCL-(BAD|NOT|SUDO-NEEDS)/.test(o), o);
    }
    check("...and the installer answers each of the three with a different " +
          "sentence, naming the fix rather than the symptom",
        (() => {
            // join the source's own "..." + "..." wrapping before looking for
            // phrases, so this tests the WORDS and not where they line-break
            const flat = mainSrc.replace(/"\s*\+\s*\r?\n\s*"/g, "");
            const at = flat.indexOf('ipcMain.handle("lcl:stackInstall"');
            const end = flat.indexOf("ipcMain.handle(", at + 20);
            const body = flat.slice(at, end < 0 ? flat.length : end);
            const steps = [...body.matchAll(/run\.step = "([^"]+)"/g)].map(x => x[1]);
            // the sudoer line starts in a template literal, so its two halves
            // are joined across quote KINDS — matched separately rather than
            // teaching the joiner every string form JavaScript has
            return /is not allowed to/.test(body) && /run sudo at all/.test(body)
                && /requiretty/.test(body)
                && /was not accepted on the node/.test(body)
                // ...and each lands a DIFFERENT line in the readout
                && new Set(steps).size === steps.length && steps.length >= 3;
        })(), null);
}

/* ====== THE VPN STAYS ON, AND THE WORK STILL HAPPENS ======================
 *
 * The VPN has to stay on and must not cause problems — turning it off is not
 * an option.
 *
 * Twice the app's answer to a kill switch was "turn your VPN off", which its
 * own source had already written down as the wrong one: the VPN is not
 * optional on that machine, so the fix has to be something the app does.
 *
 * It already had the road. Measured, with the VPN up:
 *
 *     spark:22               EACCES        1.1.1.1:443      OPEN
 *     spark:11434            EACCES        example.com:443  OPEN
 *     spark.<tailnet>.ts.net EACCES  <- resolved by Tailscale's own DNS
 *     209.177.145.97:443     HTTP 401 <- the SAME host via public DNS
 *
 * The door was answering the whole time. Inference came through it; anything
 * that had to RUN something did not, because that went straight to ssh. So
 * installs take the door when the tailnet is refused, and the door grew one
 * route to make that possible.
 */
{
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const doorPy = fs.readFileSync(path.join(ROOT, "tools", "node-door", "lcl-door.py"), "utf8");

    check("A BLOCKED TAILNET CHANGES THE ROAD INSTEAD OF ENDING THE JOB — the " +
          "install retries through the node's door rather than reporting a " +
          "failure and telling its owner to turn the VPN off",
        /sshFailure\(res\.tail\) === "blocked" && n\.relayUrl/.test(mainSrc)
        && /road = "door"/.test(mainSrc)
        && /doorRun\(n, key, \{/.test(mainSrc), null);
    check("...and ONLY on `blocked`. A node that is switched off, or refusing " +
          "the login, must not be dragged down a second road to fail the same " +
          "way and cost another timeout to find out",
        !/sshFailure\(res\.tail\) (!==|===) null.{0,40}relayUrl/.test(mainSrc)
        && !/(unreachable|auth|hostkey)".{0,60}doorRun/.test(mainSrc), null);
    check("...and it says so on screen, because a run that quietly took a " +
          "different road is a run nobody can debug",
        /going in through remote access/.test(mainSrc), null);

    check("THE DOOR RESOLVES ITS OWN HOSTNAME PUBLICLY. Tailscale's resolver " +
          "answers *.ts.net with the TAILNET address — the one address a kill " +
          "switch refuses — so asking the OS would send every door request " +
          "straight back into the block it exists to route around",
        /doorRun[\s\S]{0,2000}?lookup: publicDns\.lookup/.test(mainSrc), null);

    check("THE WIRE CARRIES A KEY, NEVER SHELL TEXT. The door is on the public " +
          "internet behind one static token; a caller naming its own commands " +
          "would be remote code execution wearing a JSON hat",
        /key not in recipes/.test(doorPy)
        && /def load_recipes/.test(doorPy)
        // nothing from the request body is ever what gets executed
        && !/body\.get\("script"\)|body\[.script.\]/.test(doorPy), null);
    check("...and the recipe table is written from the SAME array the ssh road " +
          "uses, so the two cannot offer different things",
        /stacksMod\.STACKS/.test(mainSrc) && /stacksMod\.script\(st\.key\)/.test(mainSrc)
        && /recipes\.json/.test(mainSrc), null);
    check("...while a table that failed to copy is NOT fatal — a door that " +
          "serves inference is worth having, and installs keep using the " +
          "tailnet until it lands",
        /if \(!recOk\) log\(/.test(mainSrc) && !/if \(!recOk\) return/.test(mainSrc), null);

    check("THE PASSWORD GOES DOWN THE DOOR ON STDIN TOO, never in the JSON that " +
          "gets executed and never on a command line the node's own `ps` would " +
          "show for the length of an install",
        /proc\.stdin\.write\(\(pw \+ "\\n"\)\.encode/.test(doorPy)
        && /stdin=subprocess\.PIPE/.test(doorPy), null);
    check("...and the door never composes that shell itself: the prime arrives " +
          "as data in the same table",
        /prime = recipes\.get\("__prime"\)/.test(doorPy)
        && !/sudo -S/.test(doorPy), null);
    check("...and the door's version says it changed, so a node still running " +
          "the old one is visible rather than mysteriously refusing recipes",
        /DOOR_VERSION = "4"/.test(doorPy), null);
}

/* A NODE CAN BE UPDATED FROM INSIDE THE APP.
 *
 * The wizard skipped its own setup screen whenever a door of ANY age was
 * installed and published, so a node could never be moved off an older one —
 * and v4 is the door that carries an install through a VPN kill switch. A
 * feature nobody can reach is not a feature.
 */
{
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const rend = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
    const doorPy = fs.readFileSync(path.join(ROOT, "tools", "node-door", "lcl-door.py"), "utf8");
    check("the app READS the version this build ships out of the door script " +
          "itself, so the number it wants cannot disagree with the file it " +
          "actually uploads",
        /const DOOR_WANTED = \(\(\) => \{/.test(mainSrc)
        && /DOOR_VERSION = "\(\\d\+\)"/.test(mainSrc), null);
    check("...and it asks the NODE which door is on it, rather than assuming " +
          "the one it installed months ago is the one still there",
        /echo DOORV=/.test(mainSrc) && /doorVersion: Number/.test(mainSrc)
        && /doorStale:/.test(mainSrc), null);
    check("A STALE DOOR IS NOT A FINISHED ONE — the wizard stops skipping its " +
          "own setup screen, which is the only way to update one",
        /r0\.doorInstalled && r0\.doorPublished && !r0\.doorStale\) return stepModels/
            .test(rend), null);
    check("...the button says UPDATE rather than a word that sounds like " +
          "something already done",
        /r0\.doorStale \? "Update remote access"/.test(rend), null);
    check("...and the readiness row says which version is there and which this " +
          "build wants, with the tick agreeing with the sentence beside it",
        /this build wants/.test(rend)
        && /r\.doorInstalled && r\.doorPublished && !r\.doorStale\]/.test(rend), null);
    check("...and the shipped door really is newer than the one that cannot " +
          "run a recipe, or none of the above would ever fire",
        Number((/DOOR_VERSION = "(\d+)"/.exec(doorPy) || [])[1] || 0) >= 4, null);
}

/* ============ THE DOWNLOAD HAS A NUMBER ON IT ============================
 *
 * The software install needs to show the real progress of the download,
 * rather than a UI that shows nothing.
 *
 * The lines were always arriving — sshStream splits on \r precisely so a
 * progress meter reaches the user — and then nothing read them, so a four
 * gigabyte wheel was a frozen panel. Every downloader says how far along it is
 * and none of them agree on how, so this reads the real shapes rather than a
 * shape that would be convenient.
 */
{
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const lift = (name) => {
        const at = mainSrc.indexOf("function " + name + "(");
        if (at < 0) return null;
        const end = mainSrc.indexOf("\n}", at);
        if (end < 0) return null;
        try {
            return new Function(mainSrc.slice(at, end + 2) +
                mainSrc.slice(mainSrc.indexOf("function rateOf("),
                              mainSrc.indexOf("\n}", mainSrc.indexOf("function rateOf(")) + 2) +
                "\nreturn " + name + ";")();
        } catch { return null; }
    };
    /* ------------------ a docker pull is not an unknowable wait ------------- */
    /* Without this, an install sits there waiting with no indication of what is
     * happening on the local node — for example stuck on "pull complete" at
     * step 2 of installing unsloth, with only a timer counting up.
     *
     * Real `docker pull` output with no TTY — the shape this transport always
     * has. Docker drops its bars and prints one line per layer transition, which
     * is a denominator followed by a numerator and was being thrown away. */
    {
        const dp = lift("dockerProgress");
        check("main.js counts docker layers rather than shrugging at a pull",
            typeof dp === "function");

        if (typeof dp === "function") {
            const step = {};
            const feed = (l) => dp(step, l);
            const PULL = [
                "26.05.post1-py3: Pulling from nvidia/vllm",
                "3153aa388d02: Pulling fs layer",
                "a1b2c3d4e5f6: Pulling fs layer",
                "9f8e7d6c5b4a: Pulling fs layer",
                "3153aa388d02: Already exists",
                "a1b2c3d4e5f6: Downloading  12.3MB/456MB",
                "a1b2c3d4e5f6: Download complete",
                "a1b2c3d4e5f6: Extracting",
                "a1b2c3d4e5f6: Pull complete",
                "9f8e7d6c5b4a: Downloading  200MB/1.2GB",
                "9f8e7d6c5b4a: Pull complete"
            ];
            const seen = PULL.map(feed);
            const pcts = seen.filter(Boolean).map(x => x.pct);

            check("A DOCKER PULL HAS A PERCENTAGE, from the layers it does " +
                  "publish — the header line is not a layer and is ignored",
                seen[0] === null && pcts.length > 0, seen[0]);
            // PULL[4] is "3153aa388d02: Already exists" — one of the three
            // layers is on the machine, so a third of the work is done before
            // a byte moves. Re-pulling a mostly-cached image must not read 0%.
            check("...a layer ALREADY on the machine counts as finished work, so " +
                  "re-pulling a mostly-cached image does not read as 0%",
                seen[4] && seen[4].pct === 33, seen[4]);
            check("...it ENDS AT 100, which is the number the user is " +
                  "actually waiting to see",
                pcts[pcts.length - 1] === 100, pcts);
            check("...it never goes backwards once every layer is enumerated — " +
                  "docker prints all of them up front, so the denominator is " +
                  "known before the first byte lands",
                pcts.every((p, i) => i === 0 || p >= pcts[i - 1]), pcts);
            check("...and the note counts LAYERS, not bytes. Layers are not equal " +
                  "in size, so this is an approximation and the words say so " +
                  "rather than implying a byte total nobody measured",
                /^\d+ of \d+ layers$/.test(seen[seen.length - 1].note),
                seen[seen.length - 1].note);

            /* TWO NODES CAN INSTALL AT ONCE. State on a module variable would
               have one pull adding up the other one's layers. */
            const other = {};
            dp(other, "ffffffffffff: Pulling fs layer");
            const mine = dp(step, "3153aa388d02: Pull complete");
            check("...and the count belongs to ONE step, so two installs running " +
                  "together do not add up each other's layers",
                dp(other, "ffffffffffff: Pull complete").note === "1 of 1 layer" &&
                /of 3 layers$/.test(mine.note), mine.note);

            check("...a line that is not docker's is left to the other parser",
                dp({}, "Progress 4 of 9") === null &&
                dp({}, "deadbeef12: Reticulating splines") === null);

            /* AND IT IS ACTUALLY FED. Caught by mutation: deleting the call
             * left every check above passing, because they lift the function
             * and run it directly. A counter nobody calls is a counter that
             * leaves the user watching a timer — which is the complaint.
             * It must run FIRST: "a1b2: Downloading 12MB/456MB" also matches
             * the byte-pair rule, and one layer's bytes is not the pull. */
            check("...and the install loop actually CALLS it, ahead of the " +
                  "stateless parser that would read one layer's bytes as the " +
                  "whole pull's progress",
                mainSrc.includes("dockerProgress(c, line) || progressOf(line)"));
        }
    }

    const pg = lift("progressOf");
    check("main.js reads a progress line rather than passing it through as text",
        typeof pg === "function");

    if (typeof pg === "function") {
        const REAL = [
            // pip, --progress-bar raw: the ONLY shape that survives having no
            // terminal, which is the shape this transport always has
            ["Progress 1932735283 of 4294967296", 45],
            // ollama
            ["pulling 8934d96d3f08... 45% ▕███  ▏ 2.0 GB/4.7 GB  30 MB/s  1m30s", 45],
            // pip with a terminal
            ["  ━━━━━━╺━━━━━━ 1.8/4.0 GB 25.3 MB/s eta 0:01:52", 45],
            // docker
            ["8934d96d3f08: Downloading [======>       ]  95.4MB/212MB", 45],
            // apt
            ["Progress: [ 45%]", 45],
            // curl's plain meter
            ["45  212M   45 95.4M    0     0  10.0M      0  0:00:21 --:--:-- 11.2M", 45],
        ];
        for (const [line, want] of REAL) {
            const got = pg(line);
            check(`a real progress line is read: ${line.slice(0, 44)}…`,
                got && Math.abs(got.pct - want) <= 2, got);
        }
        check("...AND AN ORDINARY LOG LINE IS NOT. A bar that invents a number " +
              "from any line with a digit in it is worse than no bar: it moves " +
              "when nothing is happening",
            !pg("Reading package lists...")
            && !pg("Cloning into '/home/x/TileGym'...")
            && !pg("LCL-STEP installing torch for CUDA 13 (the long part)")
            && !pg(""), null);
        check("...and a percentage over 100 is refused rather than drawn past " +
              "the end of the bar",
            !pg("999% done") || pg("999% done").pct <= 100, pg("999% done"));

        const rich = pg("pulling manifest... 45% ▕██▏ 2.0 GB/4.7 GB  30 MB/s  1m30s");
        check("...and the speed and the time left come with it, because a " +
              "percentage that has not moved in a minute and one that is moving " +
              "look identical without them",
            rich && /MB\/s/.test(rich.note || "") && /left/.test(rich.note || ""), rich);
    }

    /* pip is SILENT without a terminal, and this transport has none by design —
     * a terminal is what would let a remote sudo prompt hang forever. */
    const stacksSrc = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "nodeStacks.js"), "utf8");
    check("EVERY pip INSTALL ASKS FOR PROGRESS IT CAN ACTUALLY EMIT. Without a " +
          "terminal pip prints nothing at all between the first line and the " +
          "last, so a 4 GB wheel was ten minutes of frozen screen",
        !/python3 -m pip install(?! --progress-bar)/.test(stacksSrc)
        && /--progress-bar raw/.test(stacksSrc), null);
    check("...declared once, so a recipe added later cannot quietly go back to " +
          "the silent form",
        /const PIP_SEEN = /.test(stacksSrc)
        && (stacksSrc.match(/PIP_SEEN \+/g) || []).length >= 3, null);
}

/* ============ A PREFLIGHT THAT CAN FIX IT, FIXES IT ======================
 *
 * Installing a set of services does not by itself make them work together,
 * which is the reason for .lcl.
 *
 * Measured on the Spark, with everything reachable and the VPN off: clang
 * absent, nvcc present but off PATH, pipx absent, Docker running with no NVIDIA
 * runtime registered. llamacpp died in 418 ms on the missing clang and said
 * "did not finish", having printed an apt line for the user to go and paste into a
 * terminal — from the tool whose entire purpose is that they do not have to.
 *
 * There is a password box now. A preflight that CAN fix what it found has no
 * excuse for handing over homework instead.
 */
{
    const inst = stacks.STACKS.filter(x => stacks.installable(x.key));
    const scriptOf = (k) => stacks.script(k);

    const homework = inst.filter(x => /— run: |run: sudo apt|please run/i.test(scriptOf(x.key)));
    check("NO RECIPE TELLS THE USER TO GO AND RUN A COMMAND THEMSELVES. That " +
          "sentence is the app admitting it could have done the thing and chose " +
          "to print instead",
        homework.length === 0, homework.map(x => x.key));

    const docker = inst.filter(x => /docker /.test(scriptOf(x.key)));
    check("EVERY DOCKER RECIPE REGISTERS THE NVIDIA RUNTIME rather than stopping " +
          "because it is missing — on the box this was written for it was " +
          "missing, so that preflight was a wall in front of nine of them",
        docker.length >= 8
        && docker.every(x => /nvidia-ctk runtime configure --runtime=docker/
            .test(scriptOf(x.key))), docker.filter(x =>
                !/nvidia-ctk/.test(scriptOf(x.key))).map(x => x.key));
    check("...using NVIDIA's own three lines, in NVIDIA's order: install the " +
          "toolkit, configure the runtime, restart Docker",
        docker.every(x => {
            const s2 = scriptOf(x.key);
            return s2.indexOf("apt-get install -y nvidia-container-toolkit") <
                   s2.indexOf("nvidia-ctk runtime configure")
                && s2.indexOf("nvidia-ctk runtime configure") <
                   s2.indexOf("systemctl restart docker");
        }), null);
    check("...and it CONFIRMS the runtime arrived instead of assuming a restart " +
          "worked — Docker takes a moment to come back",
        docker.every(x => /docker info[\s\S]{0,200}?grep -qi nvidia[\s\S]{0,300}?sleep 2/
            .test(scriptOf(x.key))), null);

    check("THE TWO RECIPES THAT NEED OLLAMA INSTALL IT, rather than naming the " +
          "curl line and stopping",
        inst.filter(x => /LCL-NO-OLLAMA/.test(scriptOf(x.key)))
            .every(x => /ollama\.com\/install\.sh \| sudo -A sh/.test(scriptOf(x.key))), null);

    const cpp = scriptOf("llamacpp");
    check("llamacpp INSTALLS the build tools it was refusing over — clang was " +
          "the single missing package that made this recipe fail in 418 ms",
        /apt-get install -y \$missing/.test(cpp) && /for p in git clang cmake/.test(cpp), null);
    check("...and puts nvcc on the PATH, because a Spark HAS the CUDA toolchain " +
          "and does not export it — a CUDA build would otherwise configure " +
          "itself as a CPU build and say so an hour later",
        /\/usr\/local\/cuda\/bin/.test(cpp) && /export PATH=/.test(cpp)
        // ...before the step that configures the build, or it is decoration
        && cpp.indexOf("/usr/local/cuda/bin") < cpp.indexOf("GGML_CUDA=ON"), null);

    check("A PROVISIONING STEP REFUSES ONLY WHEN IT GENUINELY CANNOT: no sudo, " +
          "and no password typed in the box",
        inst.every(x => {
            const s2 = scriptOf(x.key);
            if (!/LCL-NEEDS-PASSWORD/.test(s2)) return true;
            // it must have TRIED sudo before saying so
            return s2.indexOf("sudo -A true") < s2.indexOf("LCL-NEEDS-PASSWORD");
        }), null);
    check("...and the app answers that marker with what to do about it, in the " +
          "app, rather than a generic failure",
        /LCL-NEEDS-PASSWORD/.test(
            fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8"))
        && /box on the Run panel/.test(
            fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8")), null);

    /* The package list is a literal at every call site, and aptStep checks it
     * anyway — proving one template literal safe is work nobody should redo. */
    const stacksSrc = fs.readFileSync(
        path.join(ROOT, ".lcl.engine", "core", "nodeStacks.js"), "utf8");
    check("aptStep REFUSES anything that is not a Debian package name, so the " +
          "one helper that takes an argument cannot compose a command out of " +
          "whatever it was handed",
        /const PKG_OK = /.test(stacksSrc) && /throw new Error\("not a package name/.test(stacksSrc));
    const aptStep = (() => {
        // lifted and run, so the guard is exercised rather than read
        const at = stacksSrc.indexOf("const PKG_OK =");
        const end = stacksSrc.indexOf("\n}", stacksSrc.indexOf("function aptStep("));
        if (at < 0 || end < 0) return null;
        try {
            return new Function("NEED_PW",
                stacksSrc.slice(at, end + 2) + "\nreturn aptStep;")("NEEDPW");
        } catch { return null; }
    })();
    check("...and that guard is REAL: handed a package name with a shell " +
          "metacharacter in it, aptStep throws at load instead of composing a " +
          "command out of it",
        typeof aptStep === "function"
        && ["evil; rm -rf /", "a|b", "$(id)", "`id`", "--flag", ""].every(bad => {
            try { aptStep([bad]); return false; } catch { return true; }
        })
        // ...while an ordinary name still works
        && /dpkg -s/.test((aptStep(["libssl-dev"]) || {}).run || ""), null);
}

/* ============ STOP ASKING THIS NODE FOR A PASSWORD ======================
 *
 * An early requirement was to get the node to stop requiring a sudo password
 * at all.
 *
 * Everything built since has been a workaround for not doing it: a
 * preflight that refused, a password box, then an askpass helper because the
 * box's password did not survive to the next step.
 *
 * THE ONE WAY THIS COULD DO REAL HARM is a malformed file in /etc/sudoers.d,
 * which breaks sudo for every user on the machine — including the one who
 * would have to fix it. That is what most of these checks are about.
 */
{
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const at = mainSrc.indexOf('ipcMain.handle("lcl:nodeSudoNoPassword"');
    const body = at < 0 ? "" : mainSrc.slice(at, mainSrc.indexOf("ipcMain.handle(", at + 20));
    check("the app can turn a node's sudo password off, from the app", !!body);

    check("IT IS CHECKED WITH visudo BEFORE IT IS INSTALLED, and installed only " +
          "if that passes. A bad file in /etc/sudoers.d breaks sudo for everyone " +
          "on the machine, and the person who would fix it is the one who just " +
          "lost sudo",
        /visudo -cqf/.test(body)
        && body.indexOf("visudo -cqf") < body.indexOf("install -m 0440"), null);
    check("...written to a temp file first and MOVED into place, so there is no " +
          "moment where /etc/sudoers.d holds half a rule",
        /T=\$\(mktemp\)/.test(body) && /install -m 0440 -o root -g root/.test(body), null);
    check("...at 0440, which is the mode sudo insists on and refuses to read " +
          "anything looser",
        /-m 0440/.test(body), null);
    check("...and a failed syntax check leaves the node UNTOUCHED, and says so",
        /LCL-SUDOERS-INVALID/.test(body)
        && /Your node's sudo is untouched/.test(mainSrc), null);

    check("IT IS PROVEN, NOT ASSUMED: the node has to answer `sudo -n true` " +
          "without being asked before this reports success",
        /sudo -n true 2>\/dev\/null && echo LCL-NOPASSWD-ON/.test(body), null);
    check("...and it is REVERSIBLE from the same control — a security change " +
          "nobody can undo from where they made it is a trap, not a setting",
        /LCL-NOPASSWD-OFF/.test(body) && /rm -f " \+ FILE/.test(body)
        && /const FILE = "\/etc\/sudoers\.d\/lcl-nopasswd"/.test(body)
        && /Start asking again/.test(
            fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8")), null);

    check("the host key is pinned first, the same rule every other unattended " +
          "action on a node follows",
        body.indexOf("hostIsPinned(n.host)") > 0
        && body.indexOf("hostIsPinned(n.host)") < body.indexOf("sshStream("), null);
    check("...and NOTHING from the caller reaches the shell: it chooses on or " +
          "off, and the rule is a literal in main.js",
        /const on = !!\(spec && spec\.enable\)/.test(body)
        && !/\$\{/.test(body.replace(/`[^`]*`/g, m => m.includes("${") ? "" : m))
        // the username comes from the NODE's own $USER, never from this process
        && /printf '%s ALL=\(ALL\) NOPASSWD:ALL/.test(body.replace(/\\\\/g, ""))
        && /\$USER/.test(body), null);

    const rend = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
    check("THE UI SAYS WHICH STATE THE NODE IS IN, in plain words, " +
          "rather than making the user run an install to find out",
        /asks for your password every time/.test(rend)
        && /installs software without asking for a password/.test(rend), null);
    check("...and says plainly what the trade is, because this one is a real " +
          "security decision and quietly making it for the user would be worse",
        /become root without a password/.test(rend), null);
    check("...and the password box is only shown when it is needed — turning it " +
          "back ON does not need one, since sudo no longer asks",
        /sudoPw\.classList\.toggle\("hidden", !!sudoFree\)/.test(rend), null);
}

/* ============ SILENCE IS NOT FAILURE, AND A TIMEOUT IS NOT A STOP ========
 *
 * The UI ran through the entire install, then reported "stopped, did not
 * finish" after about eight minutes.
 *
 * 480 seconds, cancelled=true. Nothing failed: .lcl killed it. The idle timer
 * fires after five minutes without a byte, and llamacpp had TWO steps that are
 * silent for longer than that by design — a CUDA configure whose output went to
 * /dev/null, and a poll loop of 180 iterations with a five-second sleep waiting
 * for a 20 GB model. Then it reported "stopped", which is the word the Stop
 * button uses, so the app blamed the user for what it had done itself.
 */
{
    const inst = stacks.STACKS.filter(x => stacks.installable(x.key));
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");

    /* NO STEP MAY BE SILENT LONGER THAN THE IDLE TIMER. Checked against the
     * loop's OWN numbers, so a recipe that waits longer has to say so. */
    const silent = [];
    for (const x of inst) {
        for (const st of x.steps) {
            const m = /seq 1 (\d+)[\s\S]*?sleep (\d+); done/.exec(st.run);
            if (!m) continue;
            if (!/echo .still working|echo .waiting for/.test(st.run)) {
                silent.push(x.key + " / " + st.say + " (" +
                    (Number(m[1]) * Number(m[2])) + "s)");
            }
        }
    }
    check("EVERY WAIT LOOP REPORTS IN. A poll loop produces nothing by nature " +
          "and silence is exactly what the idle killer watches for — this is " +
          "the pair that killed a real run at 480 s",
        silent.length === 0, silent);

    check("...about every 30 seconds, which is frequent enough to be a heartbeat " +
          "and rare enough not to be a log",
        inst.every(x => x.steps.every(st => {
            const m = /\$\(\(i % (\d+)\)\).{0,80}?sleep (\d+); done/.exec(st.run);
            if (!m) return true;
            const gap = Number(m[1]) * Number(m[2]);
            return gap >= 10 && gap <= 60;
        })), null);

    check("...and it says HOW LONG it has been going, not just that it is alive",
        inst.some(x => /still working — \$\(\(i \* \d+\)\)s/.test(stacks.script(x.key))), null);

    check("THE ONE MULTI-MINUTE STEP WITH NOTHING ELSE TO SAY IS NO LONGER MUTED " +
          "— a CUDA configure sent to /dev/null looks identical to a hung ssh",
        !/CMAKE_CUDA_ARCHITECTURES=[^"]*>\s*\/dev\/null/.test(
            fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "nodeStacks.js"), "utf8")),
        null);

    /* AND THE REPORTING. Two different events must not share one word. */
    check("sshStream says WHY it killed a job: a timeout and a Stop are " +
          "different things and were reported identically",
        /let killed = false, timedOut = false/.test(mainSrc)
        && /killed = true; timedOut = true;/.test(mainSrc)
        && /cancelled: killed && !timedOut/.test(mainSrc), null);
    check("...and the install turns that into a sentence naming the node, the " +
          "wait, and WHICH STEP was running when the silence started",
        /if \(res\.timedOut\) \{/.test(mainSrc)
        && /Nothing came back from/.test(mainSrc)
        && /while it was " \+ at\.say/.test(mainSrc), null);
    check("...saying the node may still be working and that nothing was undone, " +
          "because .lcl giving up is not the node failing",
        /may still be working/.test(mainSrc) && /nothing was undone/.test(mainSrc), null);
    check("...and the model download says it too, since a 40 GB pull going quiet " +
          "is the same event one path over",
        (mainSrc.match(/if \(res\.timedOut\) \{/g) || []).length >= 2, null);

    check("THE IDLE TIMER IS A BACKSTOP FOR A HUNG CONNECTION, not a budget for " +
          "how long work may take — five minutes was shorter than a CUDA build",
        /idleMs: 20 \* 60_000/.test(mainSrc), null);

    check("AND THE AUDIT RECORDS WHICH STEP WAS LIVE, so the next one of these " +
          "is answerable from the log instead of an ssh session",
        /step: liveStepName/.test(mainSrc) && /timedOut: !!res\.timedOut/.test(mainSrc)
        && /tail: \(res\.tail \|\| \[\]\)\.slice\(-4\)/.test(mainSrc), null);
}

/* ============ IT FINISHED WHILE .LCL WAS NOT LOOKING ====================
 *
 * What about an install that already ran from .lcl on the node before this
 * patch?
 *
 * It had finished. The 480-second run built llama.cpp, installed it as a user
 * service, downloaded 20 GB and loaded a 35B model — and was answering on
 * 30000 the whole time .lcl was calling it a failure. Every recipe that leaves
 * a server behind installs it as a systemd service precisely so a dropped ssh
 * connection does not touch it, which means GIVING UP WATCHING IS NOT EVIDENCE
 * OF ANYTHING.
 */
{
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const inst = stacks.STACKS.filter(x => stacks.installable(x.key));

    check("A TIMED-OUT RUN ASKS THE NODE BEFORE REPORTING FAILURE — the work " +
          "outlives the connection on purpose",
        /LCL-LATE-OK/.test(mainSrc)
        && /if \(res\.timedOut\) \{[\s\S]{0,900}?rec\.endpoint && rec\.endpoint\.port/.test(mainSrc),
        null);
    check("...and it believes the ANSWER, not the timeout: `proved` may only be " +
          "set by a probe that actually came back, never by the run having ended",
        /if \(probe\.ok && String\(probe\.out \|\| ""\)\.includes\("LCL-LATE-OK"\)\) \{/
            .test(mainSrc), null);
    check("...and says which it was, so a run that finished unattended is not " +
          "reported in the same words as one that was watched",
        /finished on its own after \.lcl stopped watching/.test(mainSrc), null);

    /* THE OTHER HALF OF THE SAME RUN: it served, and nothing collected it.
     * llamacpp advertised "port 30000" in PROSE, which the installer cannot
     * read, so even a clean success would never have reached the picker. */
    const servesButUnlinked = inst.filter(x => {
        const m = /port (\d+)/.exec(x.serves || "");
        if (!m) return false;
        // a DECLARED decision either way: the descriptor that links it, or
        // noEndpoint saying why this one is not a model source
        if (x.noEndpoint) return false;
        return !(x.endpoint && Number(x.endpoint.port) === Number(m[1]));
    }).map(x => x.key + " (says " + x.serves + ")");
    check("EVERY RECIPE THAT SAYS IT SERVES A PORT CARRIES THE DESCRIPTOR THAT " +
          "LINKS IT. Prose is for the user; the installer reads `endpoint`, " +
          "and llamacpp had only the prose — so a working 35B server sat on the " +
          "Spark unreachable from the model picker",
        servesButUnlinked.length === 0, servesButUnlinked);
}

/* ============ HOW LONG, AND WHAT IT TAKES OVER ==========================
 *
 * NVIDIA's docs list an expected time for each install, but the app showed
 * none of them.
 *
 * Every playbook carries a "Time & risk" section with its own estimate, the
 * repository is checked out inside this project, and nothing read it. The app
 * was withholding something it already had.
 *
 * And what happens to the node with each install — does it accumulate, or does
 * one overwrite another?
 *
 * Mostly it accumulates — but three pairs serve on the SAME port, and llamacpp
 * and sglang both want 30000, which is where llama.cpp is answering now. The
 * roster always knew; it had never been said at the moment it matters.
 */
{
    const inst = stacks.STACKS.filter(x => stacks.installable(x.key));
    const rend = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");

    check("EVERY RECIPE CARRIES A TIME, or explicitly carries none — a field " +
          "that is simply absent cannot be told from one nobody filled in",
        inst.every(x => "takes" in x), inst.filter(x => !("takes" in x)).map(x => x.key));
    check("...and at least three quarters of them have a real one, because " +
          "NVIDIA published them and this repo has the file",
        inst.filter(x => x.takes).length >= Math.ceil(inst.length * 0.75),
        inst.filter(x => !x.takes).map(x => x.key));

    /* THE NUMBER MUST BE NVIDIA'S. A plausible-looking estimate invented here
     * is exactly the confident nonsense this module's own header warns about. */
    const SRC = path.join(ROOT, "docs", "spark-playbooks", "nvidia");
    const wrong = [];
    for (const x of inst) {
        if (!x.takes) continue;
        const slug = String(x.playbook || "").split("/").pop();
        const f = path.join(SRC, slug, "README.md");
        if (!fs.existsSync(f)) { wrong.push(x.key + " (no README)"); continue; }
        const doc = fs.readFileSync(f, "utf8").replace(/\s+/g, " ");
        // the leading number of the estimate has to appear in the playbook
        const num = (/\d+\s*(?:[-–]\s*\d+)?\s*(?:minutes?|hours?)/i.exec(x.takes) || [])[0];
        if (!num) { wrong.push(x.key + " (no number)"); continue; }
        if (!doc.replace(/\s+/g, " ").includes(num.replace(/\s+/g, " "))) {
            wrong.push(x.key + " (" + num + " not in its playbook)");
        }
    }
    check("...and every one of those times APPEARS IN THE PLAYBOOK it came " +
          "from — an invented estimate is worse than none",
        wrong.length === 0, wrong);

    check("the row shows it, and says so plainly when a playbook published none",
        /takes \$\{s\.takes\}/.test(rend) && /no published time estimate/.test(rend), null);
    check("...and the Run panel repeats it where the decision is actually made",
        /NVIDIA's playbook says \$\{s\.takes\}/.test(rend), null);
    check("...and the listing carries the field at all, or the panel has nothing " +
          "to show",
        /takes: x\.takes \|\| null/.test(mainSrc), null);

    /* ---- and the port two recipes both want ---- */
    const byPort = {};
    for (const x of inst) {
        if (!x.endpoint || !x.endpoint.port) continue;
        (byPort[x.endpoint.port] = byPort[x.endpoint.port] || []).push(x.key);
    }
    const shared = Object.entries(byPort).filter(([, k]) => k.length > 1);
    check("THE ROSTER STILL HAS RECIPES THAT SHARE A PORT — this check is only " +
          "worth anything while that is true, and it is: llamacpp and sglang " +
          "both want 30000",
        shared.length >= 1 && shared.some(([, k]) =>
            k.includes("llamacpp") && k.includes("sglang")), shared);
    check("...so the Run panel says which one it would take the port from, " +
          "BEFORE it runs — installing one of a pair silently replaced the other",
        /o\.endpoint\.port === s\.endpoint\.port/.test(rend)
        && /take the port from it/.test(rend)
        && /endpoint: x\.endpoint \|\| null/.test(mainSrc), null);
}

/* ============ AN INSTALL IS NOT A SOLITARY ACT ==========================
 *
 * .lcl is multi-session: more than one session may be running, and different
 * sessions may be using different services.
 *
 * Naming the losing recipe was half a warning. The cost of taking a port is
 * not measured in the roster — it is measured in the conversations pointed at
 * that address, which may be in another tab, mid-turn, doing work that has
 * nothing to do with the install.
 */
{
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const rend = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
    const sess = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "sessions.js"), "utf8");

    check("the session listing carries what each conversation is pointed at, " +
          "or 'is anything using this?' can only be asked of the one on screen",
        /modelSel: s\.modelSel \|\| null/.test(sess), null);

    check("THE APP CAN ANSWER WHICH SESSIONS ARE ON AN ADDRESS, across all of " +
          "them and not just the visible one",
        /ipcMain\.handle\("lcl:sessionsOnPort"/.test(mainSrc)
        && /sessionsOnPort: \(spec\) => ipcRenderer\.invoke/.test(
            fs.readFileSync(path.join(ROOT, "app", "preload.js"), "utf8")), null);

    check("...and it reads BOTH shapes a selection has ever been stored in, " +
          "because a session saved in the older form is still a session that " +
          "would be cut off",
        /typeof sel === "object"\) return sel\.endpointId/.test(mainSrc)
        && /\^api:\(\[\^\|\]\+\)\\\|/.test(mainSrc), null);

    check("...matching on the node's own host and port, not on a label anyone " +
          "could have renamed",
        /includes\(host \+ ":" \+ port\)/.test(mainSrc), null);

    check("THE RUN PANEL NAMES THE SESSIONS IT WOULD CUT OFF, and says that is " +
          "what taking the port does",
        /sessionsOnPort\(\{ host: nd\.host, port: s\.endpoint\.port \}\)/.test(rend)
        && /cuts them off mid-turn/.test(rend), null);
    check("...counted and pluralised, since one session and four are different " +
          "decisions",
        /on\.length === 1 \? " is" : "s are"/.test(rend), null);
    check("...and it does not paint into a panel the user already closed",
        /body\.isConnected/.test(rend), null);
    check("...nor break the panel if that lookup fails — the warning is worth " +
          "having, and it is not worth losing the install screen over",
        /\.catch\(\(\) => \{\}\)/.test(rend), null);
}

/* NO STEP MAY END THE RUN ON ITS WAY TO SUCCEEDING.
 *
 * Reported: vLLM was not installing.
 *
 * script() joins every step into ONE shell, so `exit 0` anywhere but the last
 * step ends the INSTALL. DOCKER_GPU short-circuited that way when the runtime
 * was already registered: vLLM ran step one, printed its marker and stopped —
 * ok=true, proved=false, nothing pulled, nothing started, across all nine
 * Docker recipes. The ollama preflight carries this exact warning.
 */
{
    const early = [];
    for (const x of stacks.STACKS) {
        if (!stacks.installable(x.key)) continue;
        const parts = stacks.script(x.key).split('echo "LCL-STEP');
        // every step but the last: reaching the end of the recipe is the only
        // place a zero exit means what it says
        if (parts.slice(1, -1).some(t => /exit 0/.test(t))) early.push(x.key);
    }
    check("NO RECIPE EXITS 0 BEFORE ITS LAST STEP — the steps are one shell, so " +
          "a short-circuit on the happy path reports a success that installed " +
          "nothing",
        early.length === 0, early);
}

/* ============ THE TOPOLOGY IS PINNED, LITERAL BY LITERAL =================
 *
 * The driver/fleet pair is a known-good configuration, transcribed. Every flag was
 * paid for: --jinja is the tool template, -np 4 the concurrency, 0.25 the
 * fleet's fixed quarter beside a 65 GB driver, --avoid vllm the process
 * earlyoom actually shot. A drifted literal is a different configuration. (The ROLES
 * line every key must have is tests/node-roles.js's gate; what is pinned
 * here is the VALUES those two lines carry.)
 */
{
    const drv = stacks.script("driver-llamacpp-gptoss120b");
    const flt = stacks.script("fleet-vllm-gptoss20b");
    check("the driver unit line is the one that ran: model, --jinja, four " +
          "slots, the 65,536 window, port 30000, on-failure",
        !!drv && drv.includes("-hf unsloth/gpt-oss-120b-GGUF:F16 --jinja -np 4 -c 65536")
        && drv.includes("--host 0.0.0.0 --port 30000")
        && drv.includes("'Restart=on-failure'")
        && drv.includes("llamacpp.service"), null);
    check("the fleet container line is the one that ran: image, model, the " +
          "FIXED quarter, the window, the cache mount, unless-stopped",
        !!flt && flt.includes("nvcr.io/nvidia/vllm:26.05.post1-py3")
        && flt.includes("vllm serve openai/gpt-oss-20b")
        && flt.includes("--gpu-memory-utilization 0.25 --max-model-len 32768 --max-num-seqs 8")
        && flt.includes("--restart unless-stopped")
        && flt.includes('-v "$HOME/.cache/huggingface:/root/.cache/huggingface"'), null);
    check("both health checks ask /v1/models for the MODEL, not just a socket " +
          "— port 30000 answering says nothing about which ExecStart is behind it",
        /v1\/models[\s\S]{0,80}grep -q gpt-oss-120b/.test(drv)
        && /v1\/models[\s\S]{0,80}grep -q gpt-oss-20b/.test(flt), null);
    check("the fleet's already-up short-circuit believes the SHARE, not just " +
          "the model — the generic vLLM serves the same model on the same port " +
          "at a measured share, and reporting that as up would fake the quarter",
        /\{\{\.Args\}\}[^\n]*vllm-server[\s\S]{0,120}--gpu-memory-utilization 0\.25/.test(flt), null);
    check("the driver checks disk, drops the cache, does the coexist math, " +
          "THEN loads — in that order",
        drv.indexOf("LCL-NOT-ENOUGH-DISK") > 0
        && drv.indexOf("LCL-NOT-ENOUGH-DISK") < drv.indexOf("drop_caches")
        && drv.indexOf("drop_caches") < drv.indexOf("LCL-NO-ROOM-FOR-DRIVER")
        && drv.indexOf("LCL-NO-ROOM-FOR-DRIVER") < drv.indexOf("llamacpp.service"), null);
    check("both carry the earlyoom guard", [drv, flt].every(s =>
        s.includes("--avoid vllm") && s.includes("LCL-EARLYOOM-GUARDED")), null);
    check("the seats are declared: driver=chat on 30000, fleet=fleet on 8000, " +
          "both holding the GPU for their whole life",
        stacks.roleOf("driver-llamacpp-gptoss120b").role === "chat"
        && stacks.roleOf("fleet-vllm-gptoss20b").role === "fleet"
        && (stacks.roleOf("driver-llamacpp-gptoss120b").ports || []).includes(30000)
        && (stacks.roleOf("fleet-vllm-gptoss20b").ports || []).includes(8000)
        && stacks.roleOf("driver-llamacpp-gptoss120b").holds === true
        && stacks.roleOf("fleet-vllm-gptoss20b").holds === true, null);
    check("the hoist did not change the recipe it was hoisted from: llamacpp " +
          "still serves its own Qwen line",
        stacks.script("llamacpp").includes("-hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL"), null);

    /* And the guard is RUN, not read: the fleet's earlyoom step, lifted via
     * preview(), pointed at a fixture file with `sudo -A ` stripped so the
     * real sed and tee run bare, executed TWICE through a real shell. */
    const sh = shellPath();
    if (!sh) {
        check("A SHELL WAS AVAILABLE TO RUN THE EARLYOOM GUARD WITH", false,
              "no bash found — saying so rather than passing quietly");
    } else {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-eoom-"));
        const f = path.join(dir, "earlyoom").replace(/\\/g, "/");
        fs.writeFileSync(f, 'EARLYOOM_ARGS="-r 3600"\n');
        const step = stacks.preview("fleet-vllm-gptoss20b")
            .find(s => /earlyoom/.test(s.say));
        const body = step.run.split("/etc/default/earlyoom").join(f)
            .split("sudo -A ").join("");
        let ran = true, err = "";
        try {
            execFileSync(sh, ["-c", body], { stdio: "pipe" });
            execFileSync(sh, ["-c", body], { stdio: "pipe" });
        } catch (e) { ran = false; err = String((e.stderr || e.message || "")).slice(0, 200); }
        check("running the earlyoom guard twice leaves exactly ONE --avoid vllm",
            ran && (fs.readFileSync(f, "utf8").match(/--avoid vllm/g) || []).length === 1,
            ran ? fs.readFileSync(f, "utf8") : err);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
