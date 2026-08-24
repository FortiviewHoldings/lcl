/**
 * THE FILE PANEL TRACKS THE DEVICE, NOT THE TURN.
 *
 * Measured from a real session: the model wrote the sketch and flashed it to
 * the board MID-TURN, but the workspace file panel only refreshed at turn end
 * (on res.changes). A long turn meant "it updates the device but not the
 * workspace" — the panel sat stale for minutes. The fix refreshes the panel
 * the moment a file-writing tool finishes, in the VIEWED session only.
 *
 * This pins the two things that would actually regress: the set of tools that
 * count as file-writing (a device-only tool must NOT be in it), and the guard
 * that keeps a background session from refreshing the viewed panel.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 200) : ""); }
}

/* ---- evaluate the ACTUAL set literal, not a grep of it ---- */
let SETMEMBERS = null;
{
    const key = "const FILE_WRITING_TOOLS = new Set(";
    const i = SRC.indexOf(key);
    check("the live-refresh set exists in the renderer", i >= 0);
    if (i >= 0) {
        const start = SRC.indexOf("[", i);
        const end = SRC.indexOf("]", start);
        try { SETMEMBERS = JSON.parse(SRC.slice(start, end + 1)); }
        catch (e) { check("the set literal is valid JSON we can evaluate", false, e.message); }
    }
}

if (SETMEMBERS) {
    const has = (t) => SETMEMBERS.includes(t);
    check("write_file counts as file-writing", has("write_file"));
    check("edit_file counts as file-writing", has("edit_file"));
    check("the generative tools that produce files count too",
        has("build_model") && has("generate_image") && has("export_schematic"));
    // THE POINT: a tool that changes the DEVICE, not a workspace file, must not
    // be in here — flashing is not a file write, and read-only tools are not one
    // either. Refreshing on those would be wrong or wasteful.
    check("flash_device is NOT file-writing (it changes the board, not the folder)", !has("flash_device"));
    check("serial_read / board_identify / read_file are NOT file-writing",
        !has("serial_read") && !has("board_identify") && !has("read_file"));
}

/* ---- the guard: viewed-session-only, success-only, on tool-done ---- */
check("the refresh only fires on a tool-done that DID NOT fail",
    SRC.includes('info.phase === "tool-done" && !d0.failed'));
check("...and only for the session actually on screen (no cross-session refresh)",
    SRC.includes("info.sessionId === active.id"));
check("...and only for a file-writing tool",
    SRC.includes("FILE_WRITING_TOOLS.has(d0.tool)"));
check("...calling the coalesced scheduler",
    SRC.includes("scheduleWsLiveRefresh()"));

/* ---- the scheduler coalesces and re-reads both the list and the open file ---- */
check("the scheduler coalesces a burst of writes (a single timer guard)",
    SRC.includes("if (wsLiveRefreshTimer) return;"));
check("it reloads the file list",
    /scheduleWsLiveRefresh[\s\S]{0,400}loadWorkspaceFiles\(\)/.test(SRC));
check("and re-reads the open viewer so its CONTENT updates, not just the list",
    /scheduleWsLiveRefresh[\s\S]{0,400}openFileViewer\(viewerPath\)/.test(SRC));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
