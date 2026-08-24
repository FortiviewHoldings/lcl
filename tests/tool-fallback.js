/**
 * WHEN A TOOL CANNOT RUN HERE, TRY THE MACHINES THAT CAN — AND ONLY THEN.
 *
 * The specification: a tool fallback chain — a local tool fails (not enough
 * RAM) -> try a local node -> try an API. Image generation specifically:
 * stable-diffusion.cpp on the local machine -> on a linked node -> a paid
 * image API.
 *
 * The whole risk of this feature is one line: which failures are worth
 * carrying somewhere else. Get it wrong in the generous direction and a bad
 * argument is retried on a paid endpoint, spending money to
 * reproduce the same error. So the classifier is checked against the
 * sentences .lcl's OWN guards really produce — quoted from the source, not
 * invented for the test — and the paid tier is checked against every gate
 * that must hold it back.
 */
const os = require("os");
const path = require("path");
const fs = require("fs");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
process.resourcesPath = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-toolfb-"));
require.cache[__filename] = { exports: {
    // isolated: this suite writes settings and a ledger row
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false,
                   encryptString: (s) => Buffer.from(String(s)),
                   decryptString: (b) => Buffer.from(b).toString() }
} };

const tf = require(path.join(__dirname, "..", ".lcl.engine", "core", "toolFallback.js"));
const paths = require(path.join(__dirname, "..", ".lcl.engine", "core", "paths.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++;
        console.log("FAIL |", name,
            detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 260) : "");
    }
}

/* ============================================================ the classifier */
/* The CAPACITY sentences, quoted from the app's own guards. If one of these
 * stops matching, a real out-of-memory failure silently stops falling back. */
{
    const REAL_CAPACITY = [
        // imageGen.js preflight refusal, verbatim shape
        "ERROR: not enough free memory to render safely: image generation peaks near " +
        "4.3 GB and 2.7 GB is available. Close about 2.8 GB of other apps",
        // imageGen.js mid-render guard trip
        "ERROR: image generation stopped to protect the machine: available memory " +
        "fell below 1.2 GB mid-render. Free some memory and try again.",
        // engine.js memory preflight
        "ERROR: Not enough free memory. Even running entirely on the CPU this model " +
        "needs about 3.1 GB — mostly the model weights at 2.5 GB",
        "ERROR: image generation timed out after 10 minutes",
        "ERROR: image generation is not installed on this machine",
        "ERROR: could not start a shell — the runtime is missing",
        "ERROR: connect ECONNREFUSED 127.0.0.1:8080",
        "ERROR: Error: socket hang up"
    ];
    for (const msg of REAL_CAPACITY) {
        const v = tf.classifyFailure(msg);
        check(`CAPACITY: "${msg.slice(9, 52)}…" is worth trying elsewhere`,
            v.retryable === true, v);
    }
}

/* The PERMANENT ones. Every single one of these retried on a paid endpoint
 * would spend money to produce the identical error. */
{
    const REAL_PERMANENT = [
        "ERROR: unknown tool 'draw_picture'. Available: read_file, write_file",
        "ERROR: args must be a JSON object",
        'ERROR: generate_image needs args: {"prompt": "what to draw"}',
        "ERROR: ENOENT: no such file or directory, open 'notes.md'",
        "ERROR: EACCES: permission denied, open 'C:/Windows/system32/x'",
        "ERROR: that path escapes the workspace folder",
        "ERROR: refused by policy: delete_file is not permitted",
        "ERROR: cancelled",
        "ERROR: rejected by the user: the write_file call was not run",
        "ERROR: prompt is too long (max 2000 characters)",   // 'invalid'-class
        "ERROR: a credential was found in this request and it was not sent"
    ];
    for (const msg of REAL_PERMANENT) {
        const v = tf.classifyFailure(msg);
        check(`PERMANENT: "${msg.slice(7, 46)}…" is NEVER retried elsewhere`,
            v.retryable === false, v);
    }
    check("...and an unrecognised failure defaults to STAYING PUT — the safe " +
          "default is not to spend",
        tf.classifyFailure("ERROR: something nobody has seen before").retryable === false,
        null);
    check("...and an empty failure is not retryable either",
        tf.classifyFailure("").retryable === false, null);
    check("every refusal carries a REASON, because 'it just failed' is the " +
          "answer this app exists not to give",
        !!tf.classifyFailure("ERROR: unknown tool 'x'").why
        && !!tf.classifyFailure("ERROR: not enough free memory").why, null);
}

/* A PERMANENT failure that also contains a capacity-sounding word must still
 * be permanent — the request list is checked FIRST, deliberately. */
{
    const v = tf.classifyFailure(
        "ERROR: ENOENT: no such file or directory, open 'out-of-memory-notes.md'");
    check("a filename that merely mentions memory does not make a missing file " +
          "into a capacity problem", v.retryable === false, v);
}

/* ================================================================ the tiers */
{
    check("a tool with NO fallback declaration never reroutes — which is every " +
          "file tool, correctly: 'write this file' means write it HERE",
        tf.tiersFor({ run: () => {} }).length === 0, null);
    const entry = { run: () => {}, fallback: { node: () => {}, api: () => {} } };
    check("a tool that declares tiers gets them in order: node before API — a " +
          "machine you own is tried before a paid endpoint",
        tf.tiersFor(entry).map(t => t.kind).join(",") === "node,api", null);
    check("...and a tool declaring only one tier gets only that one",
        tf.tiersFor({ fallback: { api: () => {} } }).map(t => t.kind).join(",") === "api", null);
}

/* ================================================== the chain, driven for real */
const ctxWith = (session, approve) => ({
    session, root: DATA, approveFallback: approve,
    sessionId: "s1", sessionTitle: "t"
});
const OOM = "ERROR: not enough free memory to render safely: peaks near 4.3 GB";

(async () => {

/* the node tier is hardware the user owns: NO gates, no approval */
{
    let called = 0;
    const entry = { fallback: { node: async () => { called++; return { ok: true, where: "spark", result: { written: "a.png" } }; } } };
    const r = await tf.attempt({ entry, name: "generate_image", args: {},
                                 ctx: ctxWith({ escalateTo: [] }), localError: OOM });
    check("A NODE IS TRIED WITHOUT AN APPROVAL AND WITHOUT THE ALLOWLIST — asking " +
          "consent to use hardware you already own is how people learn to click yes",
        r.ok === true && called === 1 && r.kind === "node", r);
    check("...and the result says WHERE it really ran, so a picture rendered " +
          "elsewhere never arrives looking like one rendered here",
        r.where === "spark" && r.fellBackFrom === "this machine", r);
}

/* a PERMANENT failure never reaches any tier at all */
{
    let called = 0;
    const entry = { fallback: { node: async () => { called++; return { ok: true }; },
                                api: async () => { called++; return { ok: true }; } } };
    const r = await tf.attempt({ entry, name: "generate_image", args: {},
                                 ctx: ctxWith({ escalateTo: ["m"] }),
                                 localError: "ERROR: args must be a JSON object" });
    check("A BAD ARGUMENT NEVER TOUCHES ANOTHER MACHINE — not the node, not the " +
          "API, no request made at all",
        r.ok === false && called === 0, { r, called });
    check("...and it says why it did not travel", /request itself/.test(r.reason), r.reason);
}

/* ---- the paid tier, and every gate that holds it back ---- */
{
    const paidEntry = (spy) => ({ fallback: { api: async () => { spy.hit++; return { ok: true, where: "api", result: {} }; } } });

    // GATE 1: the app-wide switch
    paths.writeSettings({ allowEscalation: false });
    let spy = { hit: 0 };
    let r = await tf.attempt({ entry: paidEntry(spy), name: "generate_image", args: {},
        ctx: ctxWith({ escalateTo: ["m"] }, async () => true), localError: OOM });
    check("GATE 1 — with API fallback switched off app-wide, nothing is paid for",
        r.ok === false && spy.hit === 0
        && /switched off app-wide/.test(JSON.stringify(r.tried)), r);

    // GATE 2: the per-session allowlist, and it FAILS CLOSED
    paths.writeSettings({ allowEscalation: true });
    spy = { hit: 0 };
    r = await tf.attempt({ entry: paidEntry(spy), name: "generate_image", args: {},
        ctx: ctxWith({ escalateTo: [] }, async () => true), localError: OOM });
    check("GATE 2 FAILS CLOSED — an EMPTY allowlist means 'no, never', not 'no " +
          "preference'. This is the inversion that once turned an " +
          "explicit 'none of them' into 'any of them'",
        r.ok === false && spy.hit === 0
        && /no models ticked/.test(JSON.stringify(r.tried)), r);
    spy = { hit: 0 };
    r = await tf.attempt({ entry: paidEntry(spy), name: "generate_image", args: {},
        ctx: ctxWith({}, async () => true), localError: OOM });
    check("...and a session with no allowlist AT ALL is the same answer",
        r.ok === false && spy.hit === 0, r);

    // GATE 3 is inside the provider (the K3 card); with the gates open the
    // tier is reached and it is the provider's job to ask
    spy = { hit: 0 };
    r = await tf.attempt({ entry: paidEntry(spy), name: "generate_image", args: {},
        ctx: ctxWith({ escalateTo: ["m"] }, async () => true), localError: OOM });
    check("with both gates open the paid tier is REACHED — and the card it must " +
          "raise is the provider's own job",
        r.ok === true && spy.hit === 1, r);
}

/* node first, API only if the node could not */
{
    const order = [];
    const entry = { fallback: {
        node: async () => { order.push("node"); return { ok: false, skipped: "no image route" }; },
        api: async () => { order.push("api"); return { ok: true, where: "api", result: {} }; }
    } };
    paths.writeSettings({ allowEscalation: true });
    const r = await tf.attempt({ entry, name: "generate_image", args: {},
        ctx: ctxWith({ escalateTo: ["m"] }, async () => true), localError: OOM });
    check("THE ORDER IS DELIBERATE: a machine you own is asked first, and the " +
          "paid endpoint only because the node could not",
        order.join(",") === "node,api" && r.ok === true && r.kind === "api", { order, r });
}

/* a tier that THROWS is just a tier that did not work */
{
    const entry = { fallback: {
        node: async () => { throw new Error("spark is unplugged"); },
        api: async () => ({ ok: true, where: "api", result: {} })
    } };
    const r = await tf.attempt({ entry, name: "generate_image", args: {},
        ctx: ctxWith({ escalateTo: ["m"] }, async () => true), localError: OOM });
    check("a tier that throws does not end the chain — the next one is tried",
        r.ok === true && r.kind === "api", r);
    check("...and what went wrong with it is remembered, not swallowed",
        /unplugged/.test(JSON.stringify(r.tried)), r.tried);
}

/* when nothing works, the ORIGINAL failure survives */
{
    const entry = { fallback: { api: async () => ({ ok: false, skipped: "no image endpoint linked" }) } };
    const r = await tf.attempt({ entry, name: "generate_image", args: {},
        ctx: ctxWith({ escalateTo: ["m"] }, async () => true), localError: OOM });
    check("when no machine could run it, the answer is still NO — never a " +
          "half-success", r.ok === false, r);
    const note = tf.explain(r.tried, r.reason);
    check("...and the model is told what was tried, so 'it failed' is never the " +
          "whole story", /api/.test(note) && /no image endpoint linked/.test(note), note);
}

/* ============================== the wiring: runTool actually calls the chain */
{
    const src = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("runTool routes a FAILURE through the chain, so every tool that " +
          "declares tiers gets them with no per-tool wiring",
        /require\("\.\/toolFallback"\)/.test(src)
        && /tf\.attempt\(\{ entry, name, args, ctx, localError: msg \}\)/.test(src), null);
    check("...a successful reroute returns as a SUCCESS the model can use, " +
          "carrying where it ran",
        /fellBackTo: alt\.where/.test(src) && /failed: false/.test(src), null);
    check("...and a failed reroute leaves the ORIGINAL error as the answer — a " +
          "different, more confusing error would be worse than the one that " +
          "actually stopped the work",
        /return \{ output: msg \+ tf\.explain/.test(src), null);
    check("the tool context carries what the tiers need: the workspace, the " +
          "session that governs paying, and the one approval hook",
        /root,\n\s+session,\n\s+approveFallback: opts\.approveFallback/.test(src), null);
}

/* the image tool declares its tiers, and the remote providers keep the contract */
{
    const ig = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "imageGen.js"), "utf8");
    const ir = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "imageRemote.js"), "utf8");
    const cm = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"), "utf8");
    check("generate_image declares node and api tiers",
        /fallback: \{[\s\S]{0,200}?node:[\s\S]{0,120}?api:/.test(ig), null);
    check("THE REMOTE TIERS RETURN THE SAME SHAPE THE LOCAL ONE DOES — written, " +
          "bytes, created, seconds, width, height — so nothing downstream needs " +
          "to know which machine drew it. THREE paths now: the node's ComfyUI, " +
          "a node speaking the OpenAI shape, and a paid endpoint",
        /written: out\.rel, bytes, created: !out\.existed/.test(ir)
        && (ir.match(/written: out\.rel/g) || []).length === 3, null);
    check("...the file is root-contained, exactly like a local write",
        /resolveInRoot/.test(ir), null);
    check("...and what comes back is verified to BE an image before it is " +
          "written under a .png name",
        /0x89 && buf\[1\] === 0x50/.test(ir) && /0xFF && buf\[1\] === 0xD8/.test(ir), null);
    check("THE PROMPT IS CHECKED FOR SECRETS BEFORE IT LEAVES — a prompt is user " +
          "text, and user text is exactly where a pasted key ends up",
        /secretGuard\.assertNoLeak\(prompt/.test(ir), null);
    check("...the network switch is honoured", /networkEnabled !== true/.test(ir), null);
    check("...no approval hook means NO, the same rule the router applies",
        /if \(!approve\) return \{ ok: false/.test(ir), null);
    check("...paid images are billed to the ledger with their own via",
        /via: "tool-fallback"/.test(ir), null);
    check("THE API KEY NEVER LEAVES cloudModels — the provider was given an " +
          "authenticated POST rather than a key getter",
        /authedPostJson/.test(cm) && !/getKey/.test(ir), null);
    check("...and when no node can draw it says so usefully, naming the playbook " +
          "that fixes it rather than shrugging",
        /no linked node is running ComfyUI \(port 8188\)/.test(ir)
        && /ComfyUI playbook/.test(ir), null);
}

/* ================ THE SECOND DISPATCH SITE, AND THE EGRESS ESCAPE ============
 * Two holes an adversarial read of this design found before it shipped. Both
 * are the kind that would only ever be discovered in use.
 * ========================================================================== */
{
    const main = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
    const ir = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "imageRemote.js"), "utf8");

    // HOLE 1: an APPROVED tool runs in main.js via entry.run, not through
    // agent.runTool — so without this, saying yes to a tool was the way to
    // LOSE its fallback, which is the opposite of what an approval means.
    check("A HUMAN-APPROVED TOOL FALLS BACK TOO — main's own dispatch site runs " +
          "the same chain, so approving a tool is not the way to lose it",
        /require\("\.\.\/\.lcl\.engine\/core\/toolFallback"\)/.test(main)
        && /tf\.attempt\(\{ entry, name: p\.tool, args: p\.args/.test(main), null);
    check("...with the same context the agent loop supplies: the workspace, the " +
          "session that governs paying, and a real approval card",
        /root: s\.repoPath/.test(main) && /session: s,/.test(main)
        && /approveFallback: async \(q\) =>/.test(main)
        && /askRemoteApproval\(s, target/.test(main), null);
    check("...and a reroute from there is written to the audit log, naming where " +
          "it actually ran",
        /kind: "tool-fallback", tool: p\.tool[\s\S]{0,80}?ranOn: alt\.where/.test(main), null);

    // HOLE 2: generate_image is classified MUTATE (a file written here).
    // Sending the prompt to a third party is EGRESS — a different
    // classification with a different floor. Inheriting the local approval
    // into it would let "write a picture to my disk" authorise "send my words
    // to a company".
    check("THE LOCAL VERDICT DOES NOT TRAVEL — egress is asked FRESH of the " +
          "kernel, because agreeing to a file being written here is not " +
          "agreeing to your words leaving the machine",
        /policyBridge/.test(ir) && /policy\.check\(session, "ask_cloud_model"/.test(ir), null);
    check("...and a session that denies egress stops the reroute dead, before " +
          "any card is raised",
        /verdict\.decision === policy\.DECISION\.DENY/.test(ir)
        && /does not allow anything[\s\S]{0,90}leave the machine/.test(ir), null);
    check("...while an unreadable policy is NOT read as permission",
        /an unreadable policy is not permission/.test(ir), null);
    check("the classification really is what this claims: generate_image is " +
          "MUTATE and ask_cloud_model is EGRESS",
        (() => {
            const cl = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine",
                "policy", "classify.js"), "utf8");
            return /generate_image: \{[^}]*CLASSIFICATION\.MUTATE/.test(cl)
                && /ask_cloud_model: \{[^}]*CLASSIFICATION\.EGRESS/.test(cl);
        })(), null);
}

/* EACH TIER IS ATTEMPTED AT MOST ONCE — a three-leg chain must not become
 * three times the work, three times the latency, or three counted calls. */
{
    let n = 0;
    const entry = { fallback: {
        node: async () => { n++; return { ok: false, skipped: "no" }; },
        api: async () => { n++; return { ok: false, skipped: "no" }; }
    } };
    const r = await tf.attempt({ entry, name: "generate_image", args: {},
        ctx: ctxWith({ escalateTo: ["m"] }, async () => true), localError: OOM });
    check("each tier is asked exactly once — no retry storm behind one tool call",
        n === 2 && r.ok === false && r.tried.length === 2, { n, tried: r.tried });
}

/* A CAPABILITY THIS MACHINE LACKS IS NOT ONE THE APP LACKS. generate_image was
 * registered only when the LOCAL renderer existed, so on a laptop without it
 * the model was never told images were possible — and a tool the model cannot
 * see is one it can never call, which made the remote tiers unreachable. */
{
    const src = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("the image tool is offered when a workspace is linked AND this machine can " +
          "draw OR somewhere linked can — otherwise the fallback chain could never be " +
          "reached (and a no-folder session was offered a tool that always failed, " +
          "since every tier writes the PNG into the linked folder)",
        /if \(hasWorkspace && \(imageGen\.available\(\) \|\| remoteImagePossible\(\)\)\)/.test(src), null);
    check("...and with nothing linked it stays hidden, exactly as before",
        /function remoteImagePossible\(\)/.test(src)
        && /catch \{ return false; \}/.test(src), null);
}

/* ================= IMAGES ON A LINKED NODE ==================================
 * An open-weight image model can run on a linked node for image generation
 * when the node has the bandwidth for it.
 *
 * The node leg stops being theoretical the moment the box can draw. Three
 * things have to be true: the door forwards the route, .lcl can tell the
 * machine can draw, and the chain prefers it over anything that costs money.
 * ========================================================================== */
{
    const door = fs.readFileSync(path.join(__dirname, "..", "tools", "node-door", "lcl-door.py"), "utf8");
    const cm = fs.readFileSync(path.join(__dirname, "..", ".lcl.engine", "core", "cloudModels.js"), "utf8");

    check("THE DOOR FORWARDS IMAGE GENERATION, so the node leg is reachable at all",
        /"\/v1\/images\/generations"/.test(door)
        && /ALLOWED_EXACT = \{[\s\S]*?\/v1\/images\/generations[\s\S]*?\}/.test(door), null);
    check("...and ONLY that image verb — nothing that pulls, creates or deletes " +
          "what is installed on the box goes through the door",
        (() => {
            // the ALLOWLIST itself, not the security comment above it, which
            // NAMES those routes precisely to say they are refused
            const i = door.indexOf("ALLOWED_EXACT = {");
            const block = door.slice(i, door.indexOf("}", i));
            return /\/v1\/images\/generations/.test(block)
                && !/\/api\/(pull|push|create|delete)/.test(block);
        })(), null);
    check("...and the door announces its version, so a stale door on the box " +
          "is visible rather than mysterious",
        (() => {
            const m = /DOOR_VERSION = "(\d+)"/.exec(door);
            return !!m && Number(m[1]) >= 3;   // 3 is when /v1/images arrived
        })(), null);

    check("CAN IT DRAW? ASKED WITHOUT DRAWING — an empty POST distinguishes " +
          "'no such route' (404/405) from 'route exists, bad body' (400/422), " +
          "so nothing is generated and nothing is spent to find out",
        /async function probeImageCapability/.test(cm)
        && /r\.status === 400 \|\| r\.status === 422/.test(cm), null);
    check("...an unproven capability is NO, because the chain must never be " +
          "sent to a machine that cannot answer",
        /catch \{ return false; \}/.test(cm), null);
    check("...and what it learns is remembered on the endpoint",
        /function setCapability\(endpointId, name, on\)/.test(cm)
        && /rec\.capabilities = \[\.\.\.set\]/.test(cm), null);
    check("...probed while .lcl is already talking to the machine, not as a " +
          "separate chore the operator has to remember",
        /setCapability\(endpointId, "image", await probeImageCapability\(ep\)\)/.test(cm), null);

    // and the chain really does prefer the node once it says it can draw
    const order = [];
    const entry = { fallback: {
        node: async () => { order.push("node"); return { ok: true, where: "spark", result: {} }; },
        api: async () => { order.push("api"); return { ok: true, where: "api", result: {} }; }
    } };
    paths.writeSettings({ allowEscalation: true });
    const r = await tf.attempt({ entry, name: "generate_image", args: {},
        ctx: ctxWith({ escalateTo: ["m"] }, async () => true), localError: OOM });
    check("A NODE THAT CAN DRAW IS USED INSTEAD OF A PAID ENDPOINT — the money " +
          "tier is never even asked",
        order.join(",") === "node" && r.where === "spark", { order, r });
}

console.log(`\n${pass}/${pass + fail} tool-fallback checks passed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL | suite crashed -", (e && e.stack) || e); process.exit(1); });
