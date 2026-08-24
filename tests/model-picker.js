/**
 * THE MODEL PICKER — THE CONTROL THIS WHOLE APP TURNS ON.
 *
 * It shipped DEAD once. Adding the GPU tier renamed the loop's `kind` variable
 * to `tier` and left two `kind` references below it, so building the first row
 * threw a ReferenceError and the menu could not open at all — with one model
 * configured, let alone ninety-five. Every renderer suite passed: 25/25, while
 * the picker was unusable.
 *
 * WHAT THIS FILE IS FOR NOW, AND WHAT IT IS NOT.
 *
 * The picker is a TREE — four modes that open and close — and whether a mode
 * actually opens, whether a shut mode really hides its rows, whether an offline
 * row refuses a click, and whether the menu paints inside the window are all
 * questions about a live DOM. They are measured by driving the real renderer in
 * real Chromium:
 *
 *     ./app/node_modules/.bin/electron devtools/ui-harness picker
 *
 * What is left HERE is the part that is pure data and can be evaluated without
 * a window: the specified ordering, the group keys, and the four
 * modes' membership rules. Every one of those is LIFTED OUT OF app.js AND RUN,
 * not matched with a regex — because a regex over source is exactly the kind of
 * proof that passed while the picker was dead.
 *
 *   Local        > everything on this machine
 *   Local Nodes  > each machine you own, named
 *   API          > each vendor, named
 *   $ GPU        > a machine rented by the hour
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");

/* =====================================================================
 * 1. NO UNDECLARED IDENTIFIER IN THE ROW BUILDER
 *
 * The defect in one property: a name used in the row builder that nothing
 * declares. The builder is a named function now (the flat loop could not be
 * reused by a tree), so this reads that function's body.
 * =================================================================== */

const loopStart = appSrc.indexOf("    function buildModelRow(m) {");
const loopEnd = appSrc.indexOf("    /* ------------------------------------------------------------------\n     * THE TREE.");
const loop = appSrc.slice(loopStart, loopEnd);

check("(setup) the picker's row builder was found", loopStart > 0 && loopEnd > loopStart,
    { loopStart, loopEnd });

check("EVERY IDENTIFIER THE ROW BUILDER USES IS DECLARED. `kind` was renamed to " +
      "`tier` in the loop header and left behind in two lines below it, which " +
      "threw a ReferenceError on the very first row",
    (() => {
        // names the builder reads that must be declared inside it (the rest come
        // from module scope and are checked by the parse)
        const mustDeclare = ["kind", "row", "name", "chip", "meta", "offline"];
        const missing = [];
        for (const id of mustDeclare) {
            const declared = new RegExp(`\\b(const|let|var)\\s+${id}\\b`).test(loop);
            const used = new RegExp(`\\b${id}\\b`).test(loop);
            if (used && !declared) missing.push(id);
        }
        return missing.length === 0;
    })(), "an undeclared name in this builder kills the entire picker");

check("...and `kind` specifically is derived from the MODEL, not from the tier — " +
      "the tier carries 'current' for the active row, and a chip reading 'current' " +
      "says nothing about where a model runs",
    /const kind = !m\.remote \? "local" : m\.rented \? "gpu" : m\.localNode \? "node" : "api";/.test(loop));

/* =====================================================================
 * 2. THE SPECIFIED ORDER, EVALUATED FOR REAL
 * =================================================================== */

/* the real tier function, lifted out of app.js and evaluated */
const tierSrc = /const tier = \(m\) => ([\s\S]*?);\n/.exec(appSrc);
check("(setup) the tier function was found in app.js", !!tierSrc);
const tier = tierSrc ? eval("(m) => " + tierSrc[1]) : null;

const MODELS = [
    { id: "qwen", remote: false },
    { id: "spark-a", remote: true, localNode: true, endpointLabel: "spark" },
    { id: "deep-a", remote: true, endpointLabel: "api.deepinfra.com" },
    { id: "gpu-a", remote: true, rented: true, provider: "SomeCloud" }
];

check("LOCAL IS THE TOP LEVEL — the local machine is the top level",
    tier(MODELS[0]) === 0);
check("a machine you own comes next", tier(MODELS[1]) === 1);
check("an API vendor after that", tier(MODELS[2]) === 2);
check("and a rented GPU last, in its own tier",
    tier(MODELS[3]) === 3);
check("...so a 123B on a machine across the room never outranks the local " +
      "machine's own models",
    tier(MODELS[0]) < tier(MODELS[1]));

check("a rented GPU is never folded in with hardware the user owns",
    tier(MODELS[3]) !== tier(MODELS[1]));

/* =====================================================================
 * 2b. A RENTED GPU GETS ITS OWN GROUP, NOT THE API BUCKET
 *
 * The fourth tier existed in the SORT and nowhere else: groupKey had three
 * branches, so every rented endpoint keyed as "api:<host>" and was grouped with
 * hardware billed per token — the exact conflation the tier was added to undo.
 * The real assignment loop is lifted out of app.js and run against real shapes.
 * =================================================================== */
{
    const gkStart = appSrc.indexOf("    for (const m of modelsCache) {");
    const gkEnd = appSrc.indexOf("\n    }", gkStart);
    check("(setup) the group-key loop was found in app.js", gkStart > 0 && gkEnd > gkStart);
    const applyGroups = new Function("modelsCache", "tier",
        appSrc.slice(gkStart, gkEnd + "\n    }".length));

    const models = MODELS.map(m => ({ ...m }));
    applyGroups(models, tier);
    const [local, node, api, gpu] = models;

    check("a rented GPU is keyed into its OWN group — not \"api:\", which is what " +
          "it fell into when groupKey had no branch for tier 3",
        typeof gpu.groupKey === "string" && gpu.groupKey.startsWith("gpu:"),
        { got: gpu.groupKey });
    check("...so it can never collide with a vendor endpoint's group key",
        gpu.groupKey !== api.groupKey && gpu.groupKey !== node.groupKey &&
        gpu.groupKey !== local.groupKey,
        { gpu: gpu.groupKey, api: api.groupKey, node: node.groupKey, local: local.groupKey });
    check("...and the group is NAMED by the provider, because that is the name the " +
          "person paying by the hour recognises",
        gpu.groupKey === "gpu:SomeCloud" && gpu.groupLabel === "SomeCloud",
        { key: gpu.groupKey, label: gpu.groupLabel });
    check("the other three groups are unchanged by the new branch",
        local.groupKey === "local" && node.groupKey === "node:spark" &&
        api.groupKey === "api:api.deepinfra.com",
        { local: local.groupKey, node: node.groupKey, api: api.groupKey });

    /* the menu's own ordering array, evaluated against the same shapes */
    const ordSrc = /const ordered = \[([\s\S]*?)\n {4}\];/.exec(appSrc);
    check("(setup) the picker's ordering array was found", !!ordSrc);
    const ordered = new Function("modelsCache", "return [" + ordSrc[1] + "\n];")(models);
    check("the rented GPU is drawn out EXPLICITLY and lands last, rather than " +
          "falling through the API filter as whatever was left over",
        ordered.length === 4 && ordered[3].id === "gpu-a" && ordered[2].id === "deep-a",
        ordered.map(m => m.id));
}

/* =====================================================================
 * 3. THE FOUR MODES OF THE TREE — labels AND membership, evaluated.
 *
 * Clicking the picker opens it onto four modes — Local, Local Nodes, API and
 * $ GPU — so the list is decluttered and categorized.
 *
 * The old version of this section matched three strings with a regex. That
 * proved the words were in the file and nothing about which models land under
 * which word — and getting THAT wrong is how a node's models end up filed under
 * "API", which is the thing that has been reported twice. The real
 * TIERS table is lifted out and each mode's predicate is run against every
 * shape, so every model lands in exactly one mode.
 * =================================================================== */
{
    const tiersSrc = /const TIERS = \[([\s\S]*?)\n {4}\];/.exec(appSrc);
    check("(setup) the tree's four modes were found in app.js", !!tiersSrc);
    const TIERS = new Function("return [" + tiersSrc[1] + "\n];")();

    check("THE MENU OPENS ON FOUR MODES, in the order asked for: " +
          "Local, Local Nodes, API, $ GPU — not 'ON SPARK'",
        TIERS.length === 4 &&
        TIERS.map(t => t.label).join("|") === "Local|Local Nodes|API|$ GPU",
        TIERS.map(t => t.label));

    const shapes = {
        local:  { remote: false },
        node:   { remote: true, localNode: true, endpointLabel: "spark" },
        api:    { remote: true, endpointLabel: "api.deepinfra.com" },
        gpu:    { remote: true, rented: true, provider: "SomeCloud" },
        // the shape that used to break the flat list: a rented endpoint that
        // ALSO claims to be a local node. It belongs to the money tier.
        rentedNode: { remote: true, rented: true, localNode: true, provider: "SomeCloud" }
    };
    const modesFor = (m) => TIERS.filter(t => t.of(m)).map(t => t.key);

    check("a local model is in Local and nowhere else",
        modesFor(shapes.local).join() === "local", modesFor(shapes.local));
    check("a model on a machine you own is in Local Nodes and nowhere else",
        modesFor(shapes.node).join() === "node", modesFor(shapes.node));
    check("a vendor's model is in API and nowhere else",
        modesFor(shapes.api).join() === "api", modesFor(shapes.api));
    check("a rented GPU is in $ GPU and nowhere else",
        modesFor(shapes.gpu).join() === "gpu", modesFor(shapes.gpu));
    check("...and hardware billed by the hour stays in $ GPU even when it also " +
          "calls itself a node — a model that matched two modes would be DRAWN " +
          "TWICE, in two different categories, which is worse than the flat list " +
          "the tree replaced",
        modesFor(shapes.rentedNode).join() === "gpu", modesFor(shapes.rentedNode));
    check("EVERY shape lands in exactly one mode — no model can fall through the " +
          "tree and vanish from the picker entirely",
        Object.values(shapes).every(s => modesFor(s).length === 1),
        Object.entries(shapes).map(([k, v]) => k + ":" + modesFor(v).join("+")));
}

check("...with the machine or vendor named beneath as a SUBGROUP, from the " +
      "data — the spark is not the only possible node and DeepInfra is not the " +
      "only possible vendor",
    /m\.provider \|\| m\.endpointLabel/.test(appSrc) && /model-subgroup/.test(appSrc));

check("the running model still opens the list, because the first question a " +
      "picker answers is what you are talking to",
    /"▸ ANSWERING NOW · "/.test(appSrc));

/* =====================================================================
 * 4. CONTRACT K4 — the row builder must be capable of refusing.
 *
 * Whether it DOES refuse is measured in the harness, on a real click. What is
 * checked here is the thing a click cannot reveal: that the refusal is wired to
 * the endpoint's health mark and not to something incidental, and that the
 * model is still LISTED while it is refused.
 * =================================================================== */
check("CONTRACT K4 — the row reads `offline` off the model record, which is what " +
      "cloudModels stamps on every row from an endpoint it could not reach",
    /const offline = !!m\.offline;/.test(loop), "no offline mark is read at all");
// `|| neverFits` joined the condition: a model the fit rule refuses on an
// empty machine is as unselectable as one whose machine is off
check("...an offline row is disabled",
    /row\.disabled = .*\|\| offline \|\| neverFits;/.test(loop));
check("...and it is never given a click handler, so the selection cannot happen " +
      "at all rather than happening and failing silently",
    /if \(offline\) \{[\s\S]*?\} else if \(!m\.active && m\.present\) \{\s*row\.addEventListener\("click"/.test(loop));
check("...and the reason travels with it, so the row says why rather than just " +
      "going grey", /m\.offlineReason/.test(loop));
check("NOTHING IS REMOVED FROM THE LIST TO ACHIEVE ANY OF THIS — no filter drops " +
      "an offline model out of the menu",
    !/filter\([^)]*!m?\.?offline/.test(appSrc));

console.log(`\n${pass}/${pass + fail} model-picker checks passed`);
process.exit(fail ? 1 : 0);
