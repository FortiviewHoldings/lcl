/**
 * ONE MACHINE, TWO SEATS: THE MODEL YOU TALK TO, AND THE FLEET YOUR AGENTS RUN ON.
 *
 * The requirement: rather than giving vLLM its own item in the model picker,
 * when a local node has it available, expose it as a session-based toggle. The
 * local node model running on llama.cpp can hold the larger context and act as
 * the orchestrator, invoking agents that run on vLLM — one engine on the node
 * directing the other tools available there.
 *
 * The picker was wrong. Twenty-one recipes were sorted into
 * two bins — endpoint or no endpoint — so vLLM, which exists to serve twenty
 * streams at once, arrived in the model picker as one more thing to chat with,
 * beside llama.cpp, which exists to serve one with the biggest window. That is
 * not a choice anyone should be asked to make. The right answer is both, at
 * once, with one orchestrating and the other doing the parallel work.
 *
 * WHAT THIS SUITE PROVES:
 *   - every recipe declares which seat it sits in, and none can be added without
 *   - a fleet engine is NEVER offered as the model to talk to
 *   - the seat survives the whole trip: recipe table → endpoint record → picker
 *   - the toggle writes a key THE ENGINE ALREADY UNDERSTANDS, so it is an
 *     arrangement the session model is actually told about, not a decoration
 *   - the app can say what a new install would be competing with for memory,
 *     BEFORE the several-GB download rather than after the ValueError
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const stacks = require(path.join(ROOT, ".lcl.engine", "core", "nodeStacks.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 300) : ""); }
}
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

/* ======================================================= every recipe has a seat */
{
    const missing = stacks.STACKS.filter(s => !stacks.ROLES[s.key]).map(s => s.key);
    check("EVERY RECIPE DECLARES WHICH SEAT IT SITS IN — a recipe with no role " +
          "falls back to 'toolkit', which would quietly put a server in the " +
          "bin marked 'nothing resident, safe beside anything'",
        missing.length === 0, missing);

    const KNOWN = ["chat", "fleet", "service", "toolkit", "infra"];
    const odd = Object.entries(stacks.ROLES)
        .filter(([, v]) => !KNOWN.includes(v.role)).map(([k]) => k);
    check("...and every seat is one of the five the UI knows how to draw",
        odd.length === 0, odd);

    const orphan = Object.keys(stacks.ROLES).filter(k => !stacks.get(k));
    check("...and the table names no recipe that does not exist", orphan.length === 0, orphan);
}

/* ============================== an OpenAI endpoint is a chat seat or a fleet seat */
{
    const bad = stacks.STACKS
        .filter(s => s.endpoint && s.endpoint.port)
        .filter(s => !["chat", "fleet"].includes(stacks.roleOf(s.key).role))
        .map(s => s.key);
    check("a recipe that leaves an OpenAI-shaped server behind is a chat seat or " +
          "a fleet seat and nothing else — those are the two things the picker " +
          "and the agent loop know what to do with",
        bad.length === 0, bad);

    check("llama.cpp is the chat seat: one stream, the biggest window, the model " +
          "the operator talks to", stacks.roleOf("llamacpp").role === "chat");
    check("vLLM is the fleet: many streams, and never the model to talk to",
        stacks.roleOf("vllm").role === "fleet");
    check("...and so is every other batching server, for the same reason",
        ["sglang", "specdecode", "nim"].every(k => stacks.roleOf(k).role === "fleet"),
        ["sglang", "specdecode", "nim"].map(k => k + "=" + stacks.roleOf(k).role));
}

/* ================================= what a new install would be competing with */
{
    /* Installing additional engines on a node already near full memory usage
     * with vLLM running risks crashing it, so the app must warn first. */
    const c = stacks.contendersFor("vllm", ["llamacpp", "ollama", "nvfp4", "jax"]);
    check("A SERVER THAT HOLDS MEMORY IS TOLD WHAT ELSE HOLDS MEMORY on that " +
          "machine — three engines cannot share 121 GiB, and the app has had " +
          "the table to say so all along",
        c.length === 2 && c.map(x => x.key).sort().join(",") === "llamacpp,ollama", c);

    check("...and a toolkit contends with nothing: no daemon, nothing resident, " +
          "safe to install beside anything",
        stacks.contendersFor("jax", ["llamacpp", "vllm", "ollama"]).length === 0);

    check("...and nothing contends with a toolkit either — the warning belongs " +
          "to installs that will actually fight for the GPU",
        stacks.contendersFor("nvfp4", ["llamacpp", "vllm"]).length === 0);

    const holders = Object.entries(stacks.ROLES).filter(([, v]) => v.holds).map(([k]) => k);
    check("...and every chat and fleet engine is marked as holding memory, " +
          "because that is exactly what they do for their whole life",
        stacks.ofRole("chat").concat(stacks.ofRole("fleet"))
            .every(s => holders.includes(s.key)),
        holders);
}

/* ================================ what is on a machine: ASKED, NOT REMEMBERED */
{
    /* The device list must resolve what is actually installed on a node.
     *
     * A record of .lcl's own installs would know nothing about what was put
     * there by hand, and would go stale the moment something stopped. The
     * machine already knows: an open port is a server that is running. */
    const ports = stacks.knownPorts();
    check("EVERY RECIPE THAT LEAVES SOMETHING LISTENING DECLARES ITS PORT, so a " +
          "node can be asked what is on it instead of a list being remembered " +
          "for it",
        stacks.STACKS.every(st => Array.isArray(stacks.roleOf(st.key).ports)),
        stacks.STACKS.filter(st => !Array.isArray(stacks.roleOf(st.key).ports))
            .map(st => st.key));

    check("...and a recipe that serves an OpenAI endpoint declares THAT port, so " +
          "the two halves cannot drift apart",
        stacks.STACKS.filter(st => st.endpoint && st.endpoint.port)
            .every(st => (stacks.roleOf(st.key).ports || [])
                .includes(st.endpoint.port)),
        stacks.STACKS.filter(st => st.endpoint && st.endpoint.port)
            .filter(st => !(stacks.roleOf(st.key).ports || []).includes(st.endpoint.port))
            .map(st => st.key));

    check("...and a toolkit declares NO port, because it leaves no daemon behind",
        stacks.ofRole("toolkit").every(st => (stacks.roleOf(st.key).ports || []).length === 0),
        stacks.ofRole("toolkit").map(st => st.key + ":" + stacks.roleOf(st.key).ports));

    /* A node, as it actually answered over ssh: 30000, 8000 and 11434 open. */
    const here = stacks.presentFrom([30000, 8000, 11434, 8347]);
    const keys = here.map(x => x.key);
    check("A NODE READ FROM ITS OWN OPEN PORTS: llama.cpp, vLLM and Ollama are " +
          "all found, from nothing but the ports that answered",
        ["llamacpp", "vllm", "ollama"].every(k => keys.includes(k)), keys);
    check("...and the door's own port is not mistaken for a playbook",
        !keys.includes("tailscale") && here.every(x => !x.ports.includes(8347)), keys);
    check("...and every one of them is marked as holding memory, which is what " +
          "makes a fourth engine a bad idea rather than a preference",
        here.filter(x => ["llamacpp", "vllm", "ollama"].includes(x.key))
            .every(x => x.holds === true), here.map(x => x.key + ":" + x.holds));

    /* THE AMBIGUITY IS DELIBERATE AND MUST STAY VISIBLE.
     * 8000 is vLLM, spec-decode AND NIM; 30000 is llama.cpp AND SGLang. An open
     * port cannot say which of them it is, and picking a favourite would put a
     * confident wrong name on a device card. For the question that matters —
     * will a new install fight this one for memory — it makes no difference. */
    check("AN AMBIGUOUS PORT RETURNS EVERY CANDIDATE rather than guessing: 8000 " +
          "is vLLM, spec-decode and NIM, and a card that names one of them with " +
          "confidence is a card that is sometimes simply wrong",
        ["vllm", "specdecode", "nim"].every(k => keys.includes(k)), keys);

    check("...nothing listening means nothing found — an empty answer is an " +
          "answer, not a reason to fall back on a remembered list",
        stacks.presentFrom([]).length === 0 && stacks.presentFrom(null).length === 0);

    check("...and the ports it looks for are the ports the table declares, so " +
          "adding a recipe does not need a second list updated by hand",
        ports.includes(30000) && ports.includes(8000) && ports.includes(8188) &&
        ports.length >= 10, ports);
}

/* ====================== the device list finally resolves what is on the device */
{
    const main = read("app", "main.js");
    const app = read("app", "renderer", "app.js");

    check("the stack list carries each recipe's PORTS and whether it holds " +
          "memory, so the panel can answer both questions from one payload",
        /ports: s\.roleOf\(x\.key\)\.ports/.test(main) &&
          /holds: !!s\.roleOf\(x\.key\)\.holds/.test(main));

    /* the device list must resolve what is installed even for a hand-installed playbook */
    check("A SERVICE CAN SHOW AS INSTALLED. The row marked it from " +
          "endpoint.port alone, and ComfyUI on 8188 has no OpenAI endpoint — so " +
          "it never showed as installed however long it had been running",
        app.includes("(s.ports && s.ports.length ? s.ports"), null);

    check("...and the memory warning is drawn from the SAME open ports, so it " +
          "arrives before the several-GB download rather than after the crash",
        /const holdersHere = \(\) =>/.test(app) &&
          app.includes("THIS MACHINE IS ALREADY SERVING"), null);

    check("...naming ONE engine per port. 8000 is vLLM, spec-decode and NIM, and " +
          "listing all three would invent two engines that are not present",
        app.includes("byPort") && /byPort\.set\(p, o\)/.test(app), null);

    check("...and it never warns about the recipe already running there — a row " +
          "that says INSTALLED and NO ROOM at once is telling on itself",
        app.includes("const rivals = onNow ? [] :"), null);

    check("...and it is styled with the ink this app already uses for attention",
        read("app", "renderer", "styles.css").includes(".stack-contended"), null);

    check("a node can also be ASKED directly, for the case where the serving " +
          "list is not populated yet — and \"could not ask\" is a different " +
          "answer from \"nothing is running\"",
        main.includes("lcl:nodePresent") && /reached: false/.test(main) &&
          read("app", "preload.js").includes("nodePresent"), null);
}

/* ============================================== the seat survives the whole trip */
{
    const main = read("app", "main.js");
    check("the installer tells the endpoint which seat it is — without this the " +
          "picker has one bin for two different jobs, which is how vLLM ended " +
          "up beside llama.cpp as a thing to chat with",
        /roleOf\(key\)/.test(main) && /role: kind\.role/.test(main));
    check("...and the picker row carries it, so the UI can tell them apart " +
          "without re-deriving it from a port number",
        /nodeRole: ep\.nodeRole/.test(main));

    const cm = read(".lcl.engine", "core", "cloudModels.js");
    check("...the endpoint record STORES it, and carries it through a relink — " +
          "a catalogue refresh must not restamp an engine's seat",
        /nodeRole: nodeRole !== undefined/.test(cm) && /prev\.nodeRole/.test(cm));
    check("...and hands it back out again", /nodeRole: v\.nodeRole/.test(cm));
}

/* ================================================ the fleet is not a thing to pick */
{
    const app = read("app", "renderer", "app.js");
    const tiers = app.match(/label: "Local Nodes"[\s\S]{0,600}?\},/g) || [];
    check("BOTH PICKERS EXCLUDE THE FLEET from the models you can select. There " +
          "are two copies of this tier list and fixing one is how a rule ends up " +
          "true in the picker nobody opens",
        tiers.length === 2 && tiers.every(t => /nodeRole !== "fleet"/.test(t)),
        tiers.length);

    check("...and it is offered under the machine instead, as a row of its own",
        /appendFleetRows/.test(app) && /model-fleet-row/.test(app));

    check("...PER SESSION. .lcl is multi-session and two conversations on one " +
          "machine may want different arrangements, so this writes the session's " +
          "own map and never an app-wide setting",
        /setSessionTaskModels\(active\.id, map\)/.test(app));

    const css = read("app", "renderer", "styles.css");
    check("...and it is styled in the existing token system rather than with " +
          "invented colours", /\.model-fleet-row \{/.test(css)
        && /var\(--line-strong\)/.test(css) && /var\(--bg-raise\)/.test(css));
}

/* ============================ THE TOGGLE IS AN ARRANGEMENT, NOT A DECORATION */
{
    /* The whole point: assigning the fleet has to reach the model that is
     * orchestrating. It writes `agentic` — which the engine already turns into
     * a standing instruction in the session's own system prompt. A toggle that
     * wrote a key nothing reads would look identical in the UI and do nothing. */
    const app = read("app", "renderer", "app.js");
    const agent = read(".lcl.engine", "core", "agent.js");
    check("THE FLEET ROW WRITES `agentic`, and the engine already knows that " +
          "word — it becomes a standing instruction in this session's own " +
          "system prompt to route multi-step agent work there",
        /map\.agentic = \{/.test(app) && /agentic: "multi-step agent work"/.test(agent));
    check("...through the orchestration block that reads the session's map, so " +
          "the model doing the orchestrating is TOLD what it has to work with",
        /function orchestrationBlock/.test(agent) && /session\.taskModels/.test(agent));
    check("...and turning it off removes the assignment rather than leaving a " +
          "dead endpoint in the map for the prompt to keep advertising",
        /delete map\.agentic/.test(app));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
