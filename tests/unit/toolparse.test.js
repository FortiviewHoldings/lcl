const path = require("path");
const { extractToolCall } = require(path.join(__dirname, "..", "..", ".lcl.engine", "core", "toolParse.js"));

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, "-", detail); }
}

// A: the user's actual bug — literal newlines inside the JSON string
const caseA = '```tool\n' +
  '{"tool": "write_file", "args": {"path": "readme.md", "content": "## AI Assistant Capabilities\n' +
  '\nAs an AI assistant running fully offline on this machine, I can:\n- read files\n- write files\n"}}\n' +
  '```';
let r = extractToolCall(caseA);
check("A literal newlines in JSON string repaired",
      r.call && !r.call.parseError && r.call.tool === "write_file"
      && r.call.args.content.includes("AI Assistant Capabilities")
      && r.call.args.content.includes("\n"),
      JSON.stringify(r.call));

// B: truncated mid-string (hit token cap)
const caseB = '```tool\n{"tool":"write_file","args":{"path":"readme.md","content":"# Title\\n\\nSome long text that just stops\n```';
r = extractToolCall(caseB);
check("B truncated JSON string closed",
      r.call && !r.call.parseError && r.call.args.path === "readme.md",
      JSON.stringify(r.call));

// C: trailing comma
r = extractToolCall('```tool\n{"tool":"write_file","args":{"path":"a.md","content":"hi",}}\n```');
check("C trailing comma repaired", r.call && !r.call.parseError && r.call.args.content === "hi",
      JSON.stringify(r.call));

// D: already-valid JSON still works and is NOT marked repaired
r = extractToolCall('```tool\n{"tool":"write_file","args":{"path":"a.md","content":"line1\\nline2"}}\n```');
check("D valid JSON unaffected",
      r.call && !r.call.parseError && r.call.args.content === "line1\nline2" && r.call.repaired === false,
      JSON.stringify(r.call));

// E: sidecar content fence — the escaping-free path
const caseE = '```tool\n{"tool": "write_file", "args": {"path": "readme.md"}}\n```\n' +
  '```content\n## Capabilities\n\n- read "files"\n- write files\n\tindented\n```';
r = extractToolCall(caseE);
check("E sidecar content fence used verbatim",
      r.call && r.call.args.path === "readme.md"
      && r.call.args.content === '## Capabilities\n\n- read "files"\n- write files\n\tindented',
      JSON.stringify(r.call));

// F: sidecar overrides a mangled inline content
const caseF = '```tool\n{"tool":"write_file","args":{"path":"x.md","content":"BROKEN'
  + '\nstill broken"}}\n```\n```content\nGOOD BODY\n```';
r = extractToolCall(caseF);
check("F sidecar wins over inline content",
      r.call && r.call.args.content === "GOOD BODY", JSON.stringify(r.call));

// G: unterminated sidecar fence flagged as truncated
const caseG = '```tool\n{"tool":"write_file","args":{"path":"x.md"}}\n```\n```content\npartial body that never closes';
r = extractToolCall(caseG);
check("G unterminated sidecar flagged truncated",
      r.call && r.call.truncated === true && r.call.args.content.startsWith("partial body"),
      JSON.stringify(r.call));

// H: no tool block at all -> plain reply
r = extractToolCall("Just a normal answer with no tools.");
check("H plain reply has no call", r.call === null && r.cleaned === "Just a normal answer with no tools.");

// I: content fence stripped from the visible reply
r = extractToolCall("Writing that now.\n" + caseE);
check("I fences removed from visible text",
      !r.cleaned.includes("```") && r.cleaned.includes("Writing that now"), JSON.stringify(r.cleaned));

// J: read_file style call with no content still fine
r = extractToolCall('```tool\n{"tool":"read_file","args":{"path":"a.txt","offset":0}}\n```');
check("J non-write tool unaffected",
      r.call && r.call.tool === "read_file" && r.call.args.offset === 0, JSON.stringify(r.call));

// K: single quotes / smart quotes should NOT silently produce wrong data
r = extractToolCall("```tool\n{'tool':'write_file'}\n```");
check("K unrepairable input reports parseError", r.call && !!r.call.parseError, JSON.stringify(r.call));

// ---- unfenced tool calls: the real-world failure that broke file editing ----
const KNOWN = ["list_files", "read_file", "write_file", "search_files"];

// L: the exact output observed from Phi-3 — bare JSON, then prose
const caseL = '{"tool": "write_file", "args": {"path": "create_file_instruction.md"}}\n\n'
  + 'Yes, I can help you create files by writing content to them.';
r = extractToolCall(caseL, KNOWN);
check("L unfenced JSON + prose is recovered",
      r.call && !r.call.parseError && r.call.tool === "write_file"
      && r.call.unfenced === true && r.call.args.path === "create_file_instruction.md",
      JSON.stringify(r.call));
check("L prose survives as the visible reply",
      r.cleaned.includes("Yes, I can help") && !r.cleaned.includes('"tool"'),
      JSON.stringify(r.cleaned));

// M: unfenced call plus a sidecar content fence
const caseM = 'Writing it now.\n{"tool":"write_file","args":{"path":"a.md"}}\n```content\n# Hi\n\nbody\n```';
r = extractToolCall(caseM, KNOWN);
check("M unfenced call still picks up the content fence",
      r.call && r.call.args.content === "# Hi\n\nbody" && r.call.args.path === "a.md",
      JSON.stringify(r.call));

// N: unfenced with literal newlines inside the string (needs repair too)
const caseN = '{"tool":"write_file","args":{"path":"n.md","content":"line1\nline2"}}';
r = extractToolCall(caseN, KNOWN);
check("N unfenced + literal newlines repaired",
      r.call && !r.call.parseError && r.call.args.content === "line1\nline2",
      JSON.stringify(r.call));

// O: ordinary JSON the user asked about must NOT be hijacked
const caseO = 'Here is a package.json snippet:\n{"name":"demo","version":"1.0.0"}';
r = extractToolCall(caseO, KNOWN);
check("O unrelated JSON is not treated as a tool call", r.call === null, JSON.stringify(r.call));

// P: JSON with a "tool" key but an UNKNOWN tool name must not fire
const caseP = '{"tool":"launch_missiles","args":{}}';
r = extractToolCall(caseP, KNOWN);
check("P unknown tool name is ignored", r.call === null, JSON.stringify(r.call));

// Q: without knownTools the bare path stays off (back-compat)
r = extractToolCall(caseL);
check("Q bare recovery is opt-in via knownTools", r.call === null, JSON.stringify(r.call));

// R: a fenced call still wins when both are present
const caseR = '{"tool":"read_file","args":{"path":"decoy.txt"}}\n'
  + '```tool\n{"tool":"write_file","args":{"path":"real.md","content":"x"}}\n```';
r = extractToolCall(caseR, KNOWN);
check("R fenced block takes precedence over bare JSON",
      r.call && r.call.tool === "write_file" && r.call.args.path === "real.md" && !r.call.unfenced,
      JSON.stringify(r.call));

console.log(`\n${pass}/${pass + fail} tool-parse tests passed`);
process.exit(fail ? 1 : 0);
