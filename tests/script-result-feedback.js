/**
 * THE MODEL SEES WHAT ITS SCRIPT DID.
 *
 * Measured (session af6477ec): the model proposed run_audio_feeder.ps1, it was
 * approved and RAN, its output streamed to the card — and the model never saw
 * any of it. The approve handler streamed to the UI and stopped; the result
 * never re-entered the conversation, so the next turn was blind and the model
 * just re-proposed the same script. "it is not thinking forward enough. i need
 * it to see the results of the scripts it is suggesting."
 *
 * The fix: lcl:approveScript appends the outcome as a role:"tool" run_script
 * message the next turn reads — exit code, WHERE it ran, and the output —
 * exactly like every other tool already does, and saves the session so a fresh
 * runTurn picks it up.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 200) : ""); }
}

// isolate the approveScript handler body
const h0 = SRC.indexOf('ipcMain.handle("lcl:approveScript"');
const h1 = SRC.indexOf('ipcMain.handle("lcl:rejectScript"');
check("the approveScript handler exists", h0 >= 0 && h1 > h0);
const body = SRC.slice(h0, h1);

check("after the run it appends a role:\"tool\" run_script result to the session",
    /role:\s*"tool",\s*name:\s*"run_script"/.test(body) && body.includes("s.messages.push({"));
check("...that carries the EXIT CODE the model needs to reason forward",
    body.includes("exit ${result.exitCode}"));
check("...and WHERE it ran, so a location surprise is visible not silent",
    body.includes("It ran in ${where}") && body.includes("result.ranIn"));
check("...and the OUTPUT, bounded so a chatty script cannot blow the context",
    body.includes("result.output") && /cap\s*=\s*\d{3,}/.test(body) && body.includes("more chars"));
check("the session is SAVED so a fresh runTurn reads the result",
    body.includes("sessions.save(s)"));
check("the staging card is stamped resolved so a re-render shows it done, " +
      "not offering live buttons for a run that already happened",
    body.includes("resolved: result.ok ? \"approved\" : \"failed\""));
check("a failure appending the result never breaks the approval (guarded)",
    /catch \(e\) \{[\s\S]*script-result-append-failed/.test(body));
check("a timed-out run is reported as a timeout, not a bare exit code",
    body.includes("TIMED OUT"));

console.log(`\n${pass}/${pass + fail} script-result-feedback checks passed`);
if (fail) process.exit(1);
