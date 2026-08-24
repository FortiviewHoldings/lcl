/**
 * REVERTING A WRITE MUST NEVER DELETE A FILE IT DID NOT CREATE.
 *
 * The instrument writers (edit_pdf, edit_image, draw_diagram, export_schematic)
 * report their artefact under `out`. describeChange hard-coded kind:"created"
 * for all four, so reverting an `out` that OVERWROTE a pre-existing file DELETED
 * it — silent data loss on the very feature meant to protect data, even though a
 * snapshot had been taken.
 *
 * The fix: describeChange is told whether the snapshot target pre-existed and
 * whether the snapshot is of the exact file written, and returns:
 *   - "created"  only for a genuinely new output   -> revert deletes it
 *   - "modified" for an overwrite we snapshotted    -> revert RESTORES it
 *   - "modified" with no backupId when the snapshot is of a DIFFERENT file
 *     (export_schematic snapshots the input, output derived) -> revert REFUSES
 *     rather than deleting a file we hold no snapshot of.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---- mock electron so paths.js resolves a throwaway data dir ----
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-revert-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => LCL_TEST_DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const agent = require(__dirname + "/../.lcl.engine/core/agent.js");
const backups = require(__dirname + "/../.lcl.engine/core/backups.js");
const { resolveInRoot } = require(__dirname + "/../.lcl.engine/core/fsTools.js");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 200) : ""); }
}

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lcl-revert-ws-")));
const SID = "revsess";

// meta the agent/main compute before a mutating call
function metaFor(tool, args) {
    const backupTarget = agent.backupTargetOf(tool, args);
    let backupTargetResolved = null, backupTargetExisted = false;
    if (backupTarget) {
        try {
            backupTargetResolved = resolveInRoot(WS, backupTarget);
            backupTargetExisted = fs.existsSync(backupTargetResolved)
                && fs.statSync(backupTargetResolved).isFile();
        } catch { /* unresolvable */ }
    }
    const backupId = backupTarget ? backups.snapshot(SID, WS, backupTarget) : null;
    return { backupTarget, backupId, meta: { root: WS, backupTargetResolved, backupTargetExisted } };
}

/* ---- A. OVERWRITE of a pre-existing file -> revert RESTORES, never deletes ---- */
{
    const rel = "diagram.svg";
    fs.writeFileSync(path.join(WS, rel), "OLD CONTENT");
    const args = { dot: "digraph{a->b}", out: rel };
    const { backupId, meta } = metaFor("draw_diagram", args);
    check("an overwrite of an existing out file was snapshotted (backupId present)",
        !!backupId);
    // the tool now overwrites the file
    fs.writeFileSync(path.join(WS, rel), "NEW CONTENT");
    const change = agent.describeChange("draw_diagram", { out: rel, bytes: 11 }, backupId, meta);
    check("describeChange marks an overwrite as MODIFIED (was hard-coded 'created')",
        change && change.kind === "modified" && change.backupId === backupId, change);
    const r = backups.revert(SID, WS, change);
    check("reverting the overwrite RESTORES the prior contents (no data loss)",
        r.ok && fs.readFileSync(path.join(WS, rel), "utf8") === "OLD CONTENT", r);
}

/* ---- B. a genuinely NEW output file -> revert DELETES it ---- */
{
    const rel = "fresh.svg";
    const args = { dot: "digraph{x->y}", out: rel };
    const { backupId, meta } = metaFor("draw_diagram", args);   // file does not exist yet
    check("a new out file has no snapshot (nothing pre-existed)", backupId === null);
    fs.writeFileSync(path.join(WS, rel), "BRAND NEW");
    const change = agent.describeChange("draw_diagram", { out: rel }, backupId, meta);
    check("describeChange marks a genuinely new file as CREATED",
        change && change.kind === "created", change);
    const r = backups.revert(SID, WS, change);
    check("reverting a created file deletes it",
        r.ok && !fs.existsSync(path.join(WS, rel)), r);
}

/* ---- C. snapshot is of a DIFFERENT file (export_schematic) -> revert REFUSES,
 *        never deletes the output and never restores the wrong content ---- */
{
    // export_schematic takes `path` (the .kicad_sch) and derives the output; its
    // backup therefore targets the INPUT, not the SVG that gets written.
    fs.writeFileSync(path.join(WS, "sheet.kicad_sch"), "SCHEMATIC SOURCE");
    fs.writeFileSync(path.join(WS, "sheet.svg"), "OLD SVG EXPORT");   // pre-existing output
    const args = { path: "sheet.kicad_sch", format: "svg" };
    const { backupId, meta } = metaFor("export_schematic", args);
    check("export_schematic's snapshot targets the INPUT schematic, not the output",
        meta.backupTargetResolved === resolveInRoot(WS, "sheet.kicad_sch"));
    // the render overwrites the pre-existing sheet.svg
    fs.writeFileSync(path.join(WS, "sheet.svg"), "NEW SVG EXPORT");
    const change = agent.describeChange("export_schematic", { out: "sheet.svg" }, backupId, meta);
    check("with no snapshot OF THE OUTPUT, the change is modified with NO backupId",
        change && change.kind === "modified" && change.backupId === null, change);
    const r = backups.revert(SID, WS, change);
    check("reverting REFUSES rather than deleting a file we hold no snapshot of",
        r.ok === false, r);
    check("...and the output is left intact — never deleted, never overwritten with " +
          "the input schematic's contents",
        fs.readFileSync(path.join(WS, "sheet.svg"), "utf8") === "NEW SVG EXPORT");
}

fs.rmSync(WS, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
fs.rmSync(LCL_TEST_DATA, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
console.log(`\n${pass}/${pass + fail} revert-overwrite checks passed`);
process.exit(fail ? 1 : 0);
