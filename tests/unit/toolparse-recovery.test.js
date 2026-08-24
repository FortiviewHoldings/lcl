// Regression tests built from REAL captured Qwen2.5-Coder failures.
const { extractToolCall } = require("C:\\.lcl\\.lcl.engine\\core\\toolParse.js");
const KNOWN = ["list_files", "read_file", "write_file", "search_files"];

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, "-", detail); }
}

// SAMPLE 1: the file content contains its own ```bash fence, which truncated
// the tool block and left an unterminated JSON string.
const s1 = '```tool\n{"tool": "write_file", "args": {"path": "README.md", "content": "# Local AI Assistant Capabilities\\n\\n## Overview\\nThis is a local AI assistant.\\n\\n## Usage\\nFor example:\\n\\n```bash\\ncall write_file path=C:\\\\test\\\\example.txt content=Hello, World!\\n```"})\n```';
let r = extractToolCall(s1, KNOWN);
check("S1 nested ``` fence inside content is recovered",
      r.call && !r.call.parseError && r.call.tool === "write_file"
      && r.call.args.path === "README.md"
      && r.call.args.content.includes("Local AI Assistant Capabilities"),
      JSON.stringify(r.call).slice(0, 200));
check("S1 recovered content keeps the nested fence text",
      r.call && r.call.args.content.includes("bash"), (r.call && r.call.args.content || "").slice(0, 80));

// SAMPLE 4: content quotes the tool help verbatim -> unescaped double quotes.
const s4 = '```tool\n{"tool": "write_file", "args": {"path": "readme.md", "content": "# LCL AI Assistant\\n\\nI am a local AI assistant.\\n\\nAvailable tools:\\n- write_file {"path": "notes.md", "content": "the full file text"} \u2014 create or overwrite a text file"}}\n```';
r = extractToolCall(s4, KNOWN);
check("S4 unescaped quotes inside content are recovered",
      r.call && !r.call.parseError && r.call.args.path === "readme.md"
      && r.call.args.content.includes("LCL AI Assistant"),
      JSON.stringify(r.call).slice(0, 200));
check("S4 content survives past the unescaped quotes",
      r.call && r.call.args.content.includes("Available tools"),
      (r.call && r.call.args.content || "").slice(0, 120));

// SAMPLE 2: content string never closed before }}
const s2 = '```tool\n{"tool": "write_file", "args": {"path": "README.md", "content": "# Capabilities of .lcl\\n\\nA local AI assistant. The tools include `write_file`. `# Notes\\n\\nFirst line.}}\n```';
r = extractToolCall(s2, KNOWN);
check("S2 unterminated content string is recovered",
      r.call && !r.call.parseError && r.call.args.content.includes("Capabilities of .lcl"),
      JSON.stringify(r.call).slice(0, 200));

// SAMPLE 3 (was already valid) must NOT regress or be marked recovered
const s3 = '```tool\n{"tool": "write_file", "args": {"path": "README.md", "content": "# Capabilities\\n\\nI can read and write files."}}\n```';
r = extractToolCall(s3, KNOWN);
check("S3 valid JSON still parses strictly",
      r.call && !r.call.parseError && !r.call.recovered
      && r.call.args.content === "# Capabilities\n\nI can read and write files.",
      JSON.stringify(r.call));

// escapes must be applied, not left literal
check("escape sequences are unescaped in recovered content",
      (() => {
          const t = '```tool\n{"tool":"write_file","args":{"path":"a.md","content":"line1\\nline2\\ttabbed \\"quoted\\" back\\\\slash {"oops"}"}}\n```';
          const x = extractToolCall(t, KNOWN);
          return x.call && x.call.args.content.includes("\n") && x.call.args.content.includes("\t");
      })());

// Unknown tools: the PARSER's job is extraction, the KERNEL's job is
// authorisation. A fenced block naming an unknown tool is still extracted here
// and then denied by the policy kernel (see tests/unit/policy.test.js). What
// must NOT happen is the loose recovery path inventing a call for one.
const bad = '{"tool": "launch_missiles", "args": {"path": "x", "content": "boom}}';
r = extractToolCall(bad, KNOWN);
check("loose recovery refuses unknown tools", r.call === null, JSON.stringify(r.call));

// safety: ordinary prose containing the word content must not become a call
r = extractToolCall("Here is some content: a file has a path and content.", KNOWN);
check("prose is not mistaken for a tool call", r.call === null, JSON.stringify(r.call));

// ---- envelope inference: model emits args with no {tool, args} wrapper ----
// This is the real Qwen output captured when asked to use run_script.
const noEnvelope = '```tool\n{\n  "purpose": "Create a file and write to it.",\n' +
  '  "language": "powershell",\n' +
  '  "script": "New-Item -Path \'C:/temp/x.txt\' -ItemType File -Value \'ready\'",\n' +
  '  "rollback": "Remove-Item -Path \'C:/temp/x.txt\'"\n}\n```';
r = extractToolCall(noEnvelope, ["run_script", "write_file", "search_files", "read_file"]);
check("envelope-less run_script call is inferred",
      r.call && !r.call.parseError && r.call.tool === "run_script"
      && r.call.args.script.includes("New-Item")
      && r.call.args.rollback.includes("Remove-Item"),
      JSON.stringify(r.call).slice(0, 200));

r = extractToolCall('```tool\n{"path": "a.md", "content": "hello"}\n```',
                    ["write_file", "read_file"]);
check("envelope-less write_file is inferred from content",
      r.call && r.call.tool === "write_file" && r.call.args.content === "hello",
      JSON.stringify(r.call));

// ambiguous: both read_file and list_files take only `path`, so refuse to guess
r = extractToolCall('```tool\n{"path": "src"}\n```', ["read_file", "list_files"]);
check("ambiguous bare args are NOT guessed",
      !r.call || r.call.tool === undefined || !!r.call.parseError,
      JSON.stringify(r.call));

// a proper envelope must still win untouched
r = extractToolCall('```tool\n{"tool":"read_file","args":{"path":"a.txt"}}\n```',
                    ["read_file", "run_script"]);
check("explicit envelope is not overridden by inference",
      r.call && r.call.tool === "read_file" && r.call.args.path === "a.txt",
      JSON.stringify(r.call));

// inference must respect knownTools
r = extractToolCall('```tool\n{"script": "whoami"}\n```', ["write_file"]);
check("inference refuses a tool not in knownTools",
      !r.call || r.call.tool !== "run_script", JSON.stringify(r.call));

console.log(`\n${pass}/${pass + fail} loose-extraction tests passed`);
process.exit(fail ? 1 : 0);
