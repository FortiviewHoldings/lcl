/**
 * Parser safety: the recovery passes must rescue REAL calls without ever
 * executing DISPLAY content. Every case here is anchored on a failure the
 * adversarial review reproduced against the live module.
 */
const { extractToolCall, scrubToolEchoes } =
    require(__dirname + "/../.lcl.engine/core/toolParse.js");

const KNOWN = ["list_files", "read_file", "write_file", "edit_file", "move_file",
               "make_dir", "delete_file", "search_files", "run_script", "generate_image"];

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 160) : ""); }
}

// 1. REVIEW REPRO: a fenced documentation example must NOT execute
const doc1 = 'To rename a file, the agent issues:\n\n```\nmove_file {"from": "old.md", "to": "new.md"}\n```\n\nIt never overwrites.';
check("fenced move_file example is display, not a call",
    extractToolCall(doc1, KNOWN).call === null, extractToolCall(doc1, KNOWN).call);

// 2. REVIEW REPRO: a ```json fence with bare unique-arg content must NOT infer
const doc2 = 'The config format looks like:\n```json\n{"from": "a.md", "to": "b.md"}\n```';
check("json fence with from/to is not inferred into move_file",
    extractToolCall(doc2, KNOWN).call === null, extractToolCall(doc2, KNOWN).call);

const doc3 = 'Example:\n```json\n{"path": "x.md", "find": "a", "replace": "b"}\n```';
check("json fence with find/replace is not inferred into edit_file",
    extractToolCall(doc3, KNOWN).call === null, extractToolCall(doc3, KNOWN).call);

// 3. A ```tool fence with bare args IS still inferred (that is its purpose)
const real1 = '```tool\n{"path": "x.md", "find": "a", "replace": "b"}\n```';
const r1 = extractToolCall(real1, KNOWN);
check("tool fence with bare edit args is inferred",
    r1.call && r1.call.tool === "edit_file", r1.call);

// 4. Explicit envelope in a json fence still works (models mislabel constantly)
const real2 = '```json\n{"tool": "delete_file", "args": {"path": "old.md"}}\n```';
const r2 = extractToolCall(real2, KNOWN);
check("json fence with explicit envelope still parses",
    r2.call && r2.call.tool === "delete_file", r2.call);

// 5. Unfenced name-prefixed call is rescued (observed live from the 1.5B)
const real3 = 'edit_file {"path": "notes.md", "find": "Tuesday", "replace": "Thursday"}';
const r3 = extractToolCall(real3, KNOWN);
check("unfenced name-prefixed call rescued",
    r3.call && r3.call.tool === "edit_file" && r3.call.args.find === "Tuesday", r3.call);

// 6. ...but the same shape INSIDE a fence stays display
const doc4 = 'Here is the syntax:\n```\nedit_file {"path": "notes.md", "find": "a", "replace": "b"}\n```\nThat is all.';
check("fenced name-prefixed shape is not executed",
    extractToolCall(doc4, KNOWN).call === null, extractToolCall(doc4, KNOWN).call);

// 7. Name-prefixed echo in a recap is scrubbed from display
const echo = 'Done — the date is fixed.\nedit_file {"path": "notes.md", "find": "Tue", "replace": "Thu"}';
const s7 = scrubToolEchoes(echo, KNOWN, { afterTool: true });
check("unfenced name-prefixed echo scrubbed", !s7.includes("edit_file {"), s7);
check("recap prose survives the scrub", s7.includes("date is fixed"), s7);

// 8. A fenced example survives the scrub (it is content the user asked for)
const s8 = scrubToolEchoes(doc4, KNOWN, { afterTool: true });
check("fenced example survives scrub", s8.includes('edit_file {"path"'), s8);

// 9. Prose mentioning tool names without JSON is untouched
const prose = "I used edit_file to change the date and move_file to relocate the draft.";
check("prose naming tools untouched",
    scrubToolEchoes(prose, KNOWN, { afterTool: true }) === prose);

console.log(`\n${pass}/${pass + fail} parser-safety checks passed`);
process.exit(fail ? 1 : 0);
