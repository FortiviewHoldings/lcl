/**
 * The capability panel is only useful if it actually OPENS.
 *
 * Its listeners run at renderer module scope, so a single mistyped element id
 * throws during startup and takes the whole UI with it — a failure the user
 * sees as a dead window, not a missing panel. These checks bind the renderer's
 * ids, IPC names and preload surface to the markup, and verify the data the
 * panel renders is real.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "app", "renderer", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const preload = fs.readFileSync(path.join(ROOT, "app", "preload.js"), "utf8");
const mainJs = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 240) : ""); }
}

// ---- every id the panel touches must exist in the markup ----
const IDS = ["cap-scrim", "cap-panel", "cap-close", "cap-body",
             "cap-machine", "cap-models", "cap-tools"];
const missing = IDS.filter(id => !html.includes(`id="${id}"`));
check("every capability-panel element exists in index.html", missing.length === 0, missing);

// ...and every id app.js looks up in that region must be one of them
const region = appJs.slice(appJs.indexOf("openCapabilities"), appJs.indexOf("openKnowledge"));
const looked = [...region.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]);
const unknown = [...new Set(looked)].filter(id => !html.includes(`id="${id}"`));
check("app.js only looks up ids that exist", unknown.length === 0, unknown);

// ---- wiring: menu -> action -> handler -> preload -> main ----
// The Permissions MENU is gone (§6d): permissions are session-scoped under
// Session › Permissions. The capability panel itself survives — reachable
// from the command palette and the approval card's pointer — so its plumbing
// below is still asserted; what must NOT exist is a menu entry for it.
check("the capabilities menu entry is RETIRED — permissions live under Session",
    !/data-action="capabilities"/.test(html) &&
    /data-action="session-perms">Permissions…/.test(html));
check("the panel is still reachable — the command palette runs openCapabilities",
    /run: \(\) => openCapabilities\(\)/.test(appJs));
check("preload exposes capabilityMap", /capabilityMap:/.test(preload));
check("main registers the lcl:capabilityMap handler",
    /ipcMain\.handle\("lcl:capabilityMap"/.test(mainJs));
check("the renderer calls it", /window\.lcl\.capabilityMap\(\)/.test(appJs));

// ---- the panel must be closeable, or it traps the user ----
check("ESC closes the capability panel", /closeCapabilities\(\)/.test(appJs));
check("the close button is wired",
    /\$\("cap-close"\)\.addEventListener/.test(appJs));
check("clicking the scrim closes it",
    /\$\("cap-scrim"\)\.addEventListener/.test(appJs));
check("the panel is hidden by default", /id="cap-scrim" class="hidden"/.test(html));
check("styles define the scrim and its hidden state",
    /#cap-scrim\s*\{/.test(css) && /#cap-scrim\.hidden/.test(css));

// ---- the data behind it is real ----
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
const caps = require(path.join(ROOT, ".lcl.engine", "core", "capabilities.js"));

const snap = caps.snapshot({
    availBytes: 9.1e9, totalBytes: 16e9, cores: 22,
    extras: { ocr: true, reranker: true, semanticSearch: true, libraries: 1 }
});
check("snapshot reports models", Array.isArray(snap.models) && snap.models.length > 0);
check("snapshot reports tool groups",
    Array.isArray(snap.toolGroups) && snap.toolGroups.length > 0);
check("every tool carries a plain-language behaviour",
    snap.toolGroups.every(g => g.tools.every(t => typeof t.behaviour === "string" && t.behaviour)));
check("confirm-class tools are marked as asking first",
    snap.toolGroups.some(g => g.tools.some(t => t.tone === "ask" && /asks first/.test(t.behaviour))));
check("read-class tools are marked as automatic",
    snap.toolGroups.some(g => g.tools.some(t => t.tone === "auto")));

// memory realism: the same model must fit with lots of RAM and not with little.
// The tight bound is 1.5 GB — below the CPU-rung floor of even the smallest
// bundled model (weights + the 1.4 GB OS reserve), so the assertion holds for
// ANY installed model, not only a large one. (It was 3 GB, which a ~1.1 GB coder
// now clears once the memory math matches the load planner's CPU rung.)
const llm = snap.models.find(m => m.isLLM && m.installed);
if (llm) {
    const tight = caps.snapshot({ availBytes: 1.5e9, totalBytes: 16e9, cores: 22 })
        .models.find(m => m.id === llm.id);
    check("a model that fits at the machine's real free memory does not fit with 1.5 GB",
        llm.fitsNow && !tight.fitsNow, { id: llm.id, roomy: llm.fitsNow, tight: tight.fitsNow });
    check("context shrinks as available memory shrinks",
        (tight.contextNow || 0) <= (llm.contextNow || 0),
        { roomy: llm.contextNow, tight: tight.contextNow });
} else {
    console.log("     (no installed language model on this machine — fit checks skipped)");
}

check("summary counts installed vs known",
    snap.summary.known >= snap.summary.installed && snap.summary.known > 0, snap.summary);

// ---- the requirements table the user asked to SEE in the app ----
check("the snapshot carries a system-requirements table",
    !!snap.requirements && Array.isArray(snap.requirements.rows)
    && snap.requirements.rows.length > 0, snap.requirements);
check("requirements state the memory formula, so the numbers are checkable",
    /load peak/.test((snap.requirements || {}).formula || ""));
// Assert the warning is PRESENT and about the right thing — not its exact
// wording. A test that pins prose fails every time the prose improves, which
// punishes exactly the edits worth making.
const smNote = (snap.requirements || {}).sharedMemoryNote || "";
check("requirements warn about integrated-graphics memory",
    /integrated|shared/i.test(smNote) && /\b(RAM|memory)\b/i.test(smNote) && smNote.length > 40,
    smNote);
check("the panel renders the requirements table",
    html.includes('id="cap-reqs"') && appJs.includes('$("cap-reqs")'));
check("the panel shows the formula behind the numbers",
    html.includes('id="cap-formula"') && appJs.includes('$("cap-formula")'));
check("the 'free when you launch' row is derived, not hardcoded",
    snap.requirements.rows.some(r => r.bytes && typeof r.min === "number" && r.min > 0));

// ---- actionable memory: how much to free, and what freeing buys ----
const tight = caps.snapshot({ availBytes: 6.3e9, totalBytes: 16e9, cores: 22 });
const blocked = tight.models.find(m => m.isLLM && m.installed && !m.fitsNow);
if (blocked) {
    check("a model that does not fit reports HOW MUCH more memory it needs",
        blocked.shortfallBytes > 0, { id: blocked.id, short: blocked.shortfallBytes });
    check("the panel shows the shortfall rather than a dead end",
        appJs.includes("shortfallBytes") && appJs.includes("free ${fmtBig"));
    check("each model carries a memory band, so freeing memory has a visible payoff",
        Array.isArray(blocked.band) && blocked.band.length > 1, blocked.band);
    check("the band is monotonic — more memory never gives less context",
        blocked.band.every((b, i) =>
            i === 0 || (b.context || 0) >= (blocked.band[i - 1].context || 0)),
        blocked.band);
} else {
    console.log("     (every installed model fits at 6.3 GB — shortfall checks skipped)");
}
const roomy = caps.snapshot({ availBytes: 14e9, totalBytes: 16e9, cores: 22 });
const anyLLM = roomy.models.find(m => m.isLLM && m.installed);
if (anyLLM) {
    check("a model that fits reports no shortfall",
        anyLLM.fitsNow && anyLLM.shortfallBytes === 0, anyLLM.shortfallBytes);
}

// the panel and the README must not diverge: both come from this module
const tool = fs.readFileSync(path.join(ROOT, "devtools", "capability-map.js"), "utf8");
check("the README generator and the app agree on the OS floor",
    tool.includes(String(caps.OS_FLOOR_BYTES)) || tool.includes("OS_FLOOR"),
    { moduleFloor: caps.OS_FLOOR_BYTES });

console.log(`\n${pass}/${pass + fail} capability-panel checks passed`);
process.exit(fail ? 1 : 0);
