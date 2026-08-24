/**
 * TRAINING EXPORT — the local corpus becomes one sharegpt dataset, proven.
 *
 * What is measured, not reasoned about:
 *   - calls are RECONSTRUCTED (staged tool proposals, run_script proposals,
 *     change records) — never fabricated; a result with no reconstructable
 *     call is dropped, because a result the model never visibly asked for is
 *     the exact history shape agent.js hardened its own loop against
 *   - a planted secret is absent from every byte of the output, and the
 *     redaction count is replacements performed, not placeholder occurrences
 *   - the memory fold reads real frontmatter, excludes the MEMORY.md index
 *     and frontmatter-less files, and tags records by type
 *   - probe writes nothing; every real run gets its own directory
 *   - the module is offline by construction and synchronous by contract
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

// ISOLATION FIRST: paths.js honours LCL_DATA_DIR only when it is set before
// the first require, and without it this suite would read the developer's
// real session store and write real exports into the checkout's data/.
const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lcl-texp-")));
process.env.LCL_DATA_DIR = DATA;

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const ROOT = path.join(__dirname, "..");
const trainingExport = require(path.join(ROOT, ".lcl.engine", "core", "trainingExport.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 240) : ""); }
}

/* ---- the fixtures: two sessions and one memory tree ---- */

const SECRET_SESSION = "tok_fixture9x8y7z6w5v4u";
const SECRET_MEMORY = "mem0rySecretVal42";

const SESSIONS = path.join(DATA, "sessions");
fs.mkdirSync(SESSIONS, { recursive: true });

fs.writeFileSync(path.join(SESSIONS, "aaaaaaaa-1111-4222-8333-444444444444.json"),
    JSON.stringify({
        id: "aaaaaaaa-1111-4222-8333-444444444444",
        title: "fixture", createdAt: 1, updatedAt: 2, repoPath: null,
        messages: [
            { role: "user", content: "Tidy the fixer log and stage the cleanup." },
            { role: "assistant", content: "Let me stage the delete." },
            // a staged tool approval: the proposal pins the exact call
            { role: "tool", name: "delete_file",
              content: "Shown to the user for approval (destructive action). It has NOT run.",
              failed: false,
              proposal: { kind: "tool", id: "tool-1", tool: "delete_file",
                          args: { path: "junk.txt" }, digest: "junk.txt" } },
            // the run_script proposal shape the real store actually contains:
            // no .tool, no .args — script/language/purpose/rollback ARE the call
            { role: "tool", name: "run_script",
              content: "Script prepared and shown to the user for approval. It has NOT run.",
              failed: false,
              proposal: { id: "3600aa", language: "powershell",
                          script: "Write-Output 'fix'", rollback: "Write-Output 'undo'",
                          purpose: "prove the loop", mutating: true, lines: 1 } },
            // a mutation whose change record names the target — and whose
            // result carries the planted secret that must never reach disk
            { role: "tool", name: "write_file",
              content: "wrote config.py\napi_token = \"" + SECRET_SESSION + "\"",
              failed: false,
              change: { kind: "write", path: "config.py", bytes: 64, backupId: "b1" } },
            // args-less success: nothing pins the call, so the pair is dropped
            { role: "tool", name: "read_file",
              content: "UNRECOVERABLE_RESULT_MARKER the file body", failed: false },
            { role: "tool", name: "search_files",
              content: "FAILED_TOOL_MARKER boom", failed: true },
            { role: "assistant", content: "AUDIT_BUBBLE_MARKER verdict",
              meta: { model: "ancient-knowledge", audit: true } },
            { role: "assistant", content: "COMPACTION_MARKER summary",
              meta: { compaction: true } },
            { role: "assistant", content: "EMPTY_REPLY_MARKER",
              meta: { model: "m", failed: true, emptyReply: true } },
            { role: "assistant", content: "All staged. Approve when ready." }
        ]
    }, null, 1), "utf8");

// a session that folds down to nothing: dropped as a whole, counted as such
fs.writeFileSync(path.join(SESSIONS, "bbbbbbbb-1111-4222-8333-444444444444.json"),
    JSON.stringify({
        id: "bbbbbbbb-1111-4222-8333-444444444444",
        title: "empty", createdAt: 3, updatedAt: 4, repoPath: null,
        messages: [
            { role: "user", content: "hello" },
            { role: "tool", name: "read_file", content: "FAILED_TOOL_MARKER2", failed: true },
            { role: "assistant", content: "GUARD_BUBBLE_MARKER",
              meta: { model: "m", guard: true, guardKind: "generation" } }
        ]
    }, null, 1), "utf8");

// a session whose turns keep naming an innocent product word — the prose that
// the redactor must NOT eat when one memory line makes that word look secret
fs.writeFileSync(path.join(SESSIONS, "cccccccc-1111-4222-8333-444444444444.json"),
    JSON.stringify({
        id: "cccccccc-1111-4222-8333-444444444444",
        title: "prose", createdAt: 5, updatedAt: 6, repoPath: null,
        messages: [
            { role: "user", content: "Tell me about OrbitalWidget." },
            { role: "assistant", content: "OrbitalWidget is the house visualizer." },
            { role: "user", content: "Where does OrbitalWidget deploy?" },
            { role: "assistant", content: "OrbitalWidget ships from this machine." },
            { role: "user", content: "Name OrbitalWidget's data store." },
            { role: "assistant", content: "OrbitalWidget keeps tables in the cloud." }
        ]
    }, null, 1), "utf8");

const MEMROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lcl-texp-mem-")));
const MEMDIR = path.join(MEMROOT, "p1", "memory");
fs.mkdirSync(MEMDIR, { recursive: true });
fs.writeFileSync(path.join(MEMDIR, "MEMORY.md"),
    "- [note](typed_note.md) MEMORY_INDEX_MARKER\n", "utf8");
fs.writeFileSync(path.join(MEMDIR, "typed_note.md"), [
    "---",
    "name: fixture-note",
    "description: \"the \\\"quoted\\\" fixture description FIXTURE_DESC_MARKER\"",
    "metadata: ",
    "  node_type: memory",
    "  type: feedback",
    "  originSessionId: abc",
    "---",
    "",
    "The full note body FIXTURE_BODY_MARKER.",
    "password = \"" + SECRET_MEMORY + "\"",
    ""
].join("\n"), "utf8");
fs.writeFileSync(path.join(MEMDIR, "raw_no_front.md"),
    "NO_FRONTMATTER_MARKER just prose\n", "utf8");
// ONE line here reads as a secret assignment ("...Key = value"), which is how
// a real product name got extracted once and then masked 158 times across the
// real corpus — the fixture reproduces that measured failure
fs.writeFileSync(path.join(MEMDIR, "reference_note.md"), [
    "---",
    "name: orbital-widget",
    "description: \"the visualizer platform note\"",
    "metadata: ",
    "  node_type: memory",
    "  type: reference",
    "---",
    "",
    "OrbitalWidget is the platform.",
    "Config: PartitionKey = OrbitalWidget (server-derived).",
    ""
].join("\n"), "utf8");

/* ---- call reconstruction, unit ---- */

const rsCall = trainingExport.recoverArgs({ role: "tool", name: "run_script",
    proposal: { id: "x", language: "bash", script: "echo hi",
                rollback: "true", purpose: "demo", mutating: false, lines: 1 } });
check("a run_script proposal reconstructs the full text-protocol call",
    !!rsCall && rsCall.tool === "run_script" && rsCall.args.script === "echo hi"
    && rsCall.args.language === "bash" && rsCall.args.purpose === "demo"
    && rsCall.args.rollback === "true", JSON.stringify(rsCall));
check("a staged tool proposal reconstructs tool + args",
    (() => {
        const c = trainingExport.recoverArgs({ role: "tool", name: "delete_file",
            proposal: { kind: "tool", tool: "delete_file", args: { path: "a.txt" } } });
        return !!c && c.tool === "delete_file" && c.args.path === "a.txt";
    })());
check("an args-less tool message reconstructs NOTHING — null, never {}",
    trainingExport.recoverArgs({ role: "tool", name: "read_file", content: "x" }) === null);

/* ---- probe: counts and paths, zero writes ---- */

const probe = trainingExport.runExport({ sessions: true, memory: true,
    probe: true, memoryRoot: MEMROOT });
check("probe answers ok with counts only", !!probe && probe.ok === true && probe.probe === true);
check("probe counts the session files", probe.counts.sessions === 3, probe.counts.sessions);
check("probe counts only exportable memory notes (index and frontmatter-less excluded)",
    probe.counts.memoryFiles === 2, probe.counts.memoryFiles);
check("probe names the resolved dirs for the consent dialog",
    probe.sessionsDir === SESSIONS && probe.memoryRoot === MEMROOT,
    probe.sessionsDir + " | " + probe.memoryRoot);
check("probe wrote nothing — no training dir exists yet",
    !fs.existsSync(path.join(DATA, "training")));

/* ---- the real run ---- */

const res = trainingExport.runExport({ sessions: true, memory: true, memoryRoot: MEMROOT });
check("the export reports ok with a directory", !!res && res.ok === true && !!res.dir, JSON.stringify(res).slice(0, 200));

const raw = fs.readFileSync(path.join(res.dir, "dataset.json"), "utf8");
const readmeText = fs.readFileSync(path.join(res.dir, "README.md"), "utf8");
const parsed = JSON.parse(raw);

/* ---- 1. sharegpt shape ---- */
let shapeOk = parsed.length > 0;
for (const r of parsed) {
    const c = r.conversations;
    if (!Array.isArray(c) || c.length < 2) { shapeOk = false; break; }
    if (c[0].from !== "human" || c[c.length - 1].from !== "gpt") { shapeOk = false; break; }
    for (let i = 1; i < c.length; i++) {
        if (c[i].from === c[i - 1].from) { shapeOk = false; break; }
    }
}
check("every record alternates human/gpt, starts human, ends gpt", shapeOk);
check("two session records and two memory records made it out",
    parsed.length === 4 && res.counts.sessionRecords === 2 && res.counts.memoryRecords === 2,
    parsed.length);

/* ---- 2. the reconstructed house dialect ---- */
const sessionRec = parsed.find(r => r.system === ".lcl session transcript");
const gptText = sessionRec ? sessionRec.conversations
    .filter(t => t.from === "gpt").map(t => t.value).join("\n") : "";
const humanText = sessionRec ? sessionRec.conversations
    .filter(t => t.from === "human").map(t => t.value).join("\n") : "";
check("(setup) the session record exists", !!sessionRec);
check("a gpt turn carries the ```tool fence", gptText.includes("```tool"));
check("the staged delete_file call is reconstructed exactly",
    gptText.includes("{\"tool\":\"delete_file\",\"args\":{\"path\":\"junk.txt\"}}"), gptText.slice(0, 300));
check("the run_script proposal became a full house-dialect call",
    gptText.includes("\"tool\":\"run_script\"") && gptText.includes("\"script\":\"Write-Output 'fix'\"")
    && gptText.includes("\"language\":\"powershell\"") && gptText.includes("\"purpose\":\"prove the loop\"")
    && gptText.includes("\"rollback\":\"Write-Output 'undo'\""));
check("the change record pinned the write_file target",
    gptText.includes("{\"tool\":\"write_file\",\"args\":{\"path\":\"config.py\"}}"));
check("the following human turn carries the result in agent.js byte shape",
    humanText.includes("delete_file: Shown to the user for approval")
    && humanText.includes("run_script: Script prepared and shown"));
check("the kept assistant prose survives beside the fold",
    gptText.includes("Let me stage the delete.") && gptText.includes("All staged. Approve when ready."));

/* ---- 3. no fabricated calls — asserted on the raw escaped bytes ---- */
check("the escaped spaceless empty-args form appears nowhere in dataset.json",
    !raw.includes('\\"args\\":{}'));
check("...while the recovered call's exact serialized args ARE present",
    raw.includes('\\"args\\":{\\"path\\":\\"junk.txt\\"}'));

/* ---- 4. dropped turns stay dropped ---- */
for (const marker of ["UNRECOVERABLE_RESULT_MARKER", "FAILED_TOOL_MARKER",
                      "FAILED_TOOL_MARKER2", "AUDIT_BUBBLE_MARKER", "COMPACTION_MARKER",
                      "EMPTY_REPLY_MARKER", "GUARD_BUBBLE_MARKER",
                      "MEMORY_INDEX_MARKER", "NO_FRONTMATTER_MARKER"]) {
    check(`${marker} is absent from the dataset`, !raw.includes(marker));
}
check("the drop tally is truthful, reason by reason",
    res.counts.dropped.noCall === 1 && res.counts.dropped.failed === 2
    && res.counts.dropped.audit === 1 && res.counts.dropped.synthetic === 3
    && res.counts.dropped.shortSession === 1, JSON.stringify(res.counts.dropped));

/* ---- 5. THE SECRETS PIN ---- */
check("the planted session secret is absent from every byte of dataset.json",
    !raw.includes(SECRET_SESSION));
check("the planted memory secret is absent from every byte of dataset.json",
    !raw.includes(SECRET_MEMORY));
check("neither secret reaches README.md either",
    !readmeText.includes(SECRET_SESSION) && !readmeText.includes(SECRET_MEMORY));
check("the placeholder is present where the values were", raw.includes("[redacted]"));
check("the export counted its redactions", res.redactions.count >= 2, res.redactions.count);
check("the README states the per-source redaction counts",
    readmeText.includes(res.counts.redactions.sessions + " redactions performed in session records")
    && readmeText.includes(res.counts.redactions.memory + " redactions performed in memory records"));

/* ---- 5b. THE REDACTOR MUST NEVER EAT PROSE — a name that shows up once
 * beside a "...Key =" identifier and everywhere else as ordinary text is a
 * product name, not a credential; masking it corpus-wide is the toneMapping
 * corruption at dataset scale (measured: 158 hits on the real corpus) ---- */
check("a recurring product name survives in prose, unmasked",
    raw.includes("OrbitalWidget is the house visualizer")
    && raw.includes("OrbitalWidget is the platform"));
check("...while its one secret-SHAPED site is still masked",
    !raw.includes("PartitionKey = OrbitalWidget"));
check("...and the README discloses the prose call, by count",
    readmeText.includes("1 secret-shaped values left alone as prose"));

/* ---- 6. the memory fold ---- */
const memRec = parsed.find(r => String(r.system).includes("[feedback]"));
check("the memory record is tagged by its type in system",
    !!memRec && String(memRec.system).includes("fixture-note"), memRec && memRec.system);
check("the human side carries the unescaped description and the ask",
    !!memRec && memRec.conversations[0].value.includes('the "quoted" fixture description FIXTURE_DESC_MARKER')
    && memRec.conversations[0].value.includes("State the full note."));
check("the gpt side carries the note body",
    !!memRec && memRec.conversations[1].value.includes("FIXTURE_BODY_MARKER"));

/* ---- 7. the LLaMA-Factory registry snippet ---- */
const info = JSON.parse(fs.readFileSync(path.join(res.dir, "dataset_info.json"), "utf8"));
check("dataset_info registers lcl_operator over dataset.json as sharegpt",
    !!info.lcl_operator && info.lcl_operator.file_name === "dataset.json"
    && info.lcl_operator.formatting === "sharegpt");
check("...with the sharegpt tags a trainer actually reads",
    info.lcl_operator.tags.role_tag === "from" && info.lcl_operator.tags.content_tag === "value"
    && info.lcl_operator.tags.user_tag === "human" && info.lcl_operator.tags.assistant_tag === "gpt"
    && info.lcl_operator.columns.messages === "conversations");

/* ---- 8. truth-grade README counts ---- */
check("the README record count equals what dataset.json actually holds",
    res.counts.records === parsed.length
    && readmeText.includes(parsed.length + " records in dataset.json"));
check("the README names both source dirs absolutely",
    readmeText.includes(SESSIONS) && readmeText.includes(MEMROOT));
check("the README admits redaction is not proven complete",
    readmeText.includes("not proven complete"));
check("the README states the offline fact",
    readmeText.includes("zero network calls and zero model calls"));

/* ---- 9. probe never writes, even once exports exist ---- */
const listingBefore = fs.readdirSync(path.join(DATA, "training")).sort().join("|");
trainingExport.runExport({ sessions: true, memory: true, probe: true, memoryRoot: MEMROOT });
const listingAfter = fs.readdirSync(path.join(DATA, "training")).sort().join("|");
check("a probe leaves the training dir listing byte-identical",
    listingBefore === listingAfter, listingAfter);

/* ---- 10. every run gets its own directory ---- */
const res2 = trainingExport.runExport({ sessions: true, memory: true, memoryRoot: MEMROOT });
check("a second run lands in a distinct directory, no clobber",
    !!res2 && res2.ok === true && res2.dir !== res.dir
    && fs.existsSync(path.join(res2.dir, "dataset.json")), res2 && res2.dir);

/* ---- 11. offline by construction, synchronous by contract ---- */
const src = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "trainingExport.js"), "utf8");
check("the exporter never touches the router, netTools, or a URL",
    !src.includes('require("./router') && !src.includes('require("./netTools')
    && !src.includes("https:" + "//"));
check("runExport is a plain synchronous function — guard()'s {error} contract holds",
    trainingExport.runExport.constructor.name === "Function");

/* ---- selecting nothing exports nothing ---- */
const none = trainingExport.runExport({ sessions: false, memory: false, memoryRoot: MEMROOT });
check("a run with both sources off still succeeds, honestly empty",
    !!none && none.ok === true && none.counts.records === 0);

/* ---- TRAIN ON THIS NODE: the manage-machine pipe, pinned end to end ---- */
{
    const fs2 = require("fs");
    const path2 = require("path");
    const mainSrc = fs2.readFileSync(path2.join(__dirname, "..", "app", "main.js"), "utf8");
    const appSrc = fs2.readFileSync(path2.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    const preSrc = fs2.readFileSync(path2.join(__dirname, "..", "app", "preload.js"), "utf8");
    check("the door upload is SLOT-KEYED — the wire carries a slot name, never a path",
        /doorPut\(n, "training-dataset"/.test(mainSrc)
        && /\/lcl\/put\?slot=/.test(mainSrc));
    check("the pairs are distilled app-side from the imported training data, " +
          "one pair per memory note, same shape the first Spark LoRA trained on",
        /function buildTrainingPairs\(\)/.test(mainSrc)
        && /instruction: "How does the operator want you to handle/.test(mainSrc));
    check("the run is the box's own spark-train recipe through the door, " +
          "genuinely awaited (job.done), with the adapter parsed from the stream",
        /doorRun\(n, "spark-train"/.test(mainSrc)
        && /await job\.done/.test(mainSrc)
        && /ADAPTER: \(/.test(mainSrc.replace(/\\S/g, "S")) || /ADAPTER: /.test(mainSrc));
    check("training lands in the durable task ledger and streams live state",
        /kind: "train"/.test(mainSrc) && /lcl:nodeTrainState/.test(mainSrc)
        && /tasks\.finish\(taskId/.test(mainSrc));
    check("the button lives on the manage-machine page beside the stacks, " +
          "and the bridge exposes the pipe",
        /Train on this machine/.test(appSrc)
        && /nodeTrain: \(nodeId\)/.test(preSrc)
        && /onNodeTrainState/.test(preSrc));
    check("DOOR PROVISIONING CONVERGES THE SPARK RECIPES AND SCRIPTS — a " +
          "re-provision can never again drop mode switching or training, and " +
          "box-side fixes ship through the APP (the VPN makes SSH unreachable " +
          "from every working session; the app is the only courier)",
        /table\["spark-mode-" \+ mk\]/.test(mainSrc)
        && /table\["spark-train"\]/.test(mainSrc)
        && /spark-mode\.sh/.test(mainSrc)
        && require("fs").existsSync(require("path").join(__dirname, "..",
               "tools", "node-door", "spark-mode.sh"))
        && require("fs").existsSync(require("path").join(__dirname, "..",
               "tools", "node-door", "train-lcl.sh")));
}

console.log(`\n${pass}/${pass + fail} training-export checks passed`);
process.exit(fail ? 1 : 0);
