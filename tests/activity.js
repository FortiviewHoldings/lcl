/**
 * ACTIVITY FEED — the right sidebar's durable record.
 *
 * The complaint: the sidebar was featureless, and the live bubble's step log
 * dies with every re-render. The feed keeps every consequential step per
 * session — which tool, what it was given, what came back — survives session
 * switches, and records for sessions the user is NOT currently viewing.
 * Wiring checks, since the behaviour is renderer-side.
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 220) : ""); }
}

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "index.html"), "utf8");
const cssSrc = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "styles.css"), "utf8");

check("the panel exists in the workspace sidebar",
    htmlSrc.includes('id="activity-panel"') && htmlSrc.includes('id="activity-list"'));
check("activity is stored PER SESSION",
    /sessionActivity = new Map\(\)/.test(appSrc));
check("events are recorded for sessions the user is NOT viewing",
    /recordActivity\(info\.sessionId/.test(appSrc)
    && appSrc.indexOf("recordActivity(info.sessionId") < appSrc.indexOf("info.sessionId !== active.id || !liveBubble"));
check("switching sessions renders THAT session's feed",
    /renderActivity\(\);\s+\/\/ this session's own durable feed/.test(appSrc));
check("the feed is capped so it cannot grow without bound",
    /ACTIVITY_CAP/.test(appSrc) && /splice\(0, log\.length - ACTIVITY_CAP\)/.test(appSrc));
check("tool calls, results, denials, clarifies and grounding are all recorded",
    ['case "tool":', 'case "tool-done":', 'case "denied":', 'case "clarify":', 'case "grounding":']
        .every(c => appSrc.includes(c)));
check("rows with detail expand on click (an action), others do not",
    /expandable/.test(appSrc) && /classList\.toggle\("hidden"\)/.test(appSrc));
check("hover styling exists ONLY on the clickable rows",
    /\.act-row\.expandable:hover/.test(cssSrc) && !/\.act-row:hover\s*\{/.test(cssSrc));
check("the user can clear the feed, with a real button",
    htmlSrc.includes('id="activity-clear"') && /activity-clear"\)\.addEventListener/.test(appSrc));

console.log(`\n${pass}/${pass + fail} activity checks passed`);
process.exit(fail ? 1 : 0);
