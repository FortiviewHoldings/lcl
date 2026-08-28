/**
 * A RENTED GPU IS THE FOURTH MODE — AND IT IS NOT YOURS.
 *
 * A rented GPU is not hardware the user owns; it is somebody else's machine,
 * and the secrets permission must say so in those words. It must never inherit
 * the `your-machine` treatment just because it has a node's shape.
 *
 * That is the whole risk in this feature. A rented box arrives with a node's
 * exact shape — an address, a model list, an OpenAI surface, often a relay —
 * and node-ness is what suppresses the cost meter, softens the secrets warning
 * to "your own hardware", and grants long first-token patience because the
 * operator's own disk is slow. Inheriting any of those for a machine somebody
 * else administers is a lie told three different ways.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
    if (r === "electron") return __filename;
    return orig.call(this, r, ...a);
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-rented-"));
// THE STUB IS NOT ENOUGH. paths.dataDir() ignores it in development and
// writes into the repo's own data/ folder, so this suite was editing the
// working endpoint store — eight fixture endpoints were found sitting in
// it. This is the switch that makes the isolation real.
process.env.LCL_DATA_DIR = DATA;
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

const ROOT = path.join(__dirname, "..");
const cloud = require(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"));
const router = require(path.join(ROOT, ".lcl.engine", "core", "router.js"));
const cloudSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "cloudModels.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");

/* three endpoints of the three kinds that can be confused */
cloud.linkEndpoint({ id: "spark", label: "spark", baseUrl: "http://100.64.0.1:11434",
                     localNode: true, node: { id: "n1", name: "spark" } });
cloud.linkEndpoint({ id: "rent", label: "A100 x1", baseUrl: "https://gpu.example.com",
                     rented: true, provider: "SomeCloud" });
cloud.linkEndpoint({ id: "api", label: "api.example.com",
                     baseUrl: "https://api.example.com/v1" });
const eps = cloud.endpoints();
const ep = (id) => eps.find(e => e.id === id);

/* =====================================================================
 * 1. IT IS NOT A MACHINE YOU OWN
 * =================================================================== */

check("A RENTED GPU IS NOT A NODE. isNodeEndpoint is what suppresses the cost " +
      "meter and softens the secrets warning; a rented box must never satisfy it",
    cloud.isNodeEndpoint(ep("rent")) === false &&
    cloud.isNodeEndpoint(ep("spark")) === true);

check("...and the check is FIRST in that function, so no other signal — a " +
      "node-shaped address, a relay, a model list — can win it back",
    (() => {
        const i = cloudSrc.indexOf("function isNodeEndpoint");
        const body = cloudSrc.slice(i, i + 900);
        return body.indexOf("ep.rented") < body.indexOf("ep.localNode");
    })());

check("destinationOf classifies it THIRD-PARTY, not your-machine",
    cloud.destinationOf(ep("rent")).kind === "third-party" &&
    cloud.destinationOf(ep("rent")).owned === false);

check("...and says so IN THOSE WORDS, where the permission UI will read it — " +
      "'a rented machine, not yours', naming the provider",
    /a rented machine, not yours/.test(cloud.destinationOf(ep("rent")).label) &&
    /SomeCloud/.test(cloud.destinationOf(ep("rent")).label));

check("...while a machine the operator does own still reads as theirs",
    cloud.destinationOf(ep("spark")).owned === true &&
    /your machine/.test(cloud.destinationOf(ep("spark")).label));

/* =====================================================================
 * 2. THE MONEY IS REAL
 * =================================================================== */

check("COST IS ATTRIBUTED. A node's dollars are a certain $0 because the " +
      "operator pays the power bill; a rented GPU is billed and must not " +
      "inherit that free ride — the flag that decides it is isNodeEndpoint, " +
      "which answers false for a rented box and true for a node",
    cloud.isNodeEndpoint(ep("rent")) === false &&
    cloud.isNodeEndpoint(ep("spark")) === true);

/* THE FREE RIDE IS GATED ON THAT FLAG, AND ONLY ON IT.
 *
 * A node now reports $0 even when the server sent no token counts (Ollama sends
 * none), which is a second door into "this cost nothing". This pins that the
 * door is shut for a rented machine: the $0 is reached only when isNode is
 * true. Asserted on the decision, not on the spelling of one line — the old
 * check pinned the literal `localNode: isNodeEndpoint(s)` and failed the moment
 * that expression was lifted into a variable, while the behaviour was correct
 * the whole time. */
check("...and the no-usage $0 path is reachable ONLY for a node, never for a " +
      "rented GPU that reports no token counts either",
    /const isNode = isNodeEndpoint\(s\)/.test(cloudSrc) &&
    /isNode \? tokenCost\.freeCost\(\) : null/.test(cloudSrc) &&
    /localNode: isNode/.test(cloudSrc));

check("...and first-token patience is not extended to it either: fifteen " +
      "minutes exists because the user's own disk is slow loading a 100 GB " +
      "model, not as a general licence for a remote box to be silent",
    /isNodeEndpoint\(s\) \? 900_000 : 300_000/.test(cloudSrc) &&
    cloud.isNodeEndpoint(ep("rent")) === false);

/* =====================================================================
 * 3. SAME LIST, NO SPECIAL SCREEN
 * =================================================================== */

check("it appears in the SAME model list as everything else — where a model " +
      "runs is an implementation detail, so there is no separate screen",
    /rented: !!ep\.rented/.test(mainSrc) && /provider: ep\.provider/.test(mainSrc));

// THE PICKER IS A DROPDOWN TREE NOW, not a flat coloured list, so the mode a
// rented GPU lands in is a row in a TIERS table rather than a ternary on a
// label string. The assertion follows the structure; it does not relax.
// Asserted as an ORDERED list of four, because "Local, Local Nodes, API, GPU"
// is a sequence — a GPU tier that exists but sorts above the user's own
// hardware is the conflation this check was written to catch.
check("...in its own tier of the one picker: Local, Local Nodes, API, GPU",
    /m\.rented \? 3/.test(appSrc) && (() => {
        const table = (appSrc.match(/const TIERS = \[[\s\S]*?\n\s*\];/) || [""])[0];
        const keys = [...table.matchAll(/key:\s*"([a-z]+)"/g)].map(m => m[1]);
        const labels = [...table.matchAll(/label:\s*"([^"]+)"/g)].map(m => m[1]);
        return keys.join(",") === "local,node,api,gpu" &&
               /GPU/.test(labels[3] || "") &&
               // and the GPU tier selects on `rented`, not on "remote and not a node"
               /key:\s*"gpu"[\s\S]*?m\.rented/.test(table);
    })());

check("...never folded in with hardware the operator owns",
    /: m\.rented \? "gpu"/.test(appSrc));

check("...with the provider named as its subgroup, dynamically — this is not " +
      "the only company that rents GPUs",
    /m\.provider \|\| m\.endpointLabel/.test(appSrc));

/* =====================================================================
 * 4. IT OBEYS EVERYTHING ELSE
 * =================================================================== */

check("it runs WIDE like any remote service rather than queueing behind the " +
      "local engine — that queue exists because one machine holds one model",
    router.usingRemote({ id: "rent" }) === true);

check("the per-session permissions govern it unchanged: it is remote, so the " +
      "tailoring gate treats it as somewhere a profile must not go by default — " +
      "and the owned-node exemption must NOT leak to a rented box",
    (() => {
        // BEHAVIOURAL, not a grep for implementation text: prove where the
        // profile actually goes. The gate exempts hardware the operator OWNS
        // (a node) from needing per-session permission; a rented GPU is somebody
        // else's machine and must stay gated exactly like a plain API.
        const agent = require(path.join(ROOT, ".lcl.engine", "core", "agent.js"));
        const plain = { id: "s", perms: {} };
        const granted = { id: "s", perms: { tailoring: true } };
        const rentedSel = { id: "rent", model: "x", baseUrl: "https://gpu.example.com", rented: true };
        const apiSel = { id: "api", model: "x", baseUrl: "https://api.example.com/v1" };
        const ownNode = { id: "spark", model: "x", baseUrl: "http://100.64.0.1:11434",
                          localNode: true, node: { id: "n1" } };
        return agent.profileWithheldFrom(plain, rentedSel) === true      // rented third party: withheld
            && agent.profileWithheldFrom(plain, apiSel) === true         // plain API: withheld
            && agent.profileWithheldFrom(plain, ownNode) === false       // operator's own node: rides
            && agent.profileWithheldFrom(granted, rentedSel) === false;  // once granted, it rides
    })());

check("the flag survives a relink, so refreshing a catalogue cannot quietly " +
      "reclassify somebody else's hardware as the user's own",
    (() => {
        // a catalogue refresh: same endpoint, new model list, and NOTHING said
        // about ownership — the flag must survive on its own
        cloud.linkEndpoint({ id: "rent", baseUrl: "https://gpu.example.com",
                             models: [{ id: "x" }] });
        return cloud.isRentedEndpoint(cloud.endpoints().find(e => e.id === "rent")) === true;
    })());

check("NOTHING IS RENTED, STARTED OR STOPPED ON THE OPERATOR'S BEHALF — " +
      "spending money is never a default, so no provisioning code exists",
    !/\bprovision|\bspin.?up|\brent\(|startInstance|createInstance/i.test(
        cloudSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));

try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 6 }); } catch { /* held */ }
console.log(`\n${pass}/${pass + fail} rented-gpu checks passed`);
process.exit(fail ? 1 : 0);
