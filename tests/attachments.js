/**
 * CHAT ATTACHMENTS — the staged-file seam, proven end to end.
 *
 * What is measured, not reasoned about:
 *   - the appendix the model reads: inline text, honest truncation, honest
 *     "could not be read", pointers for image/pdf, name-only for binary, and
 *     the TRUE reason a no-workspace session cannot open an image (the folder
 *     is missing, not the model's eyes)
 *   - runTool's "@attachments/" re-root: reads go through the SAME
 *     resolveInRoot with the staging dir as root, writes refuse, escapes die
 *   - policyBridge/kernel audit honesty: the decision row records the REAL
 *     staged path, never a fictional <repo>/@attachments/…, and the carve-out
 *     is reads-only — a write aimed at the staging dir is DENIED
 *   - runTurn persists the operator's text EXACTLY, with the attachment list
 *     beside it, while the model-facing copy carries the appendix
 *   - source pins for the main-process seams a unit test cannot reach
 *     (stageOne containment, failed-turn chip survival, delete cleanup)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lcl-att-")));
process.env.LCL_DATA_DIR = DATA;
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });

const agent = require(path.join(ROOT, ".lcl.engine", "core", "agent.js"));
const engine = require(path.join(ROOT, ".lcl.engine", "core", "engine.js"));
const policyBridge = require(path.join(ROOT, ".lcl.engine", "core", "policyBridge.js"));
const { DECISION } = policyBridge;

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 240) : ""); }
}
setTimeout(() => {
    console.log(`\n${pass}/${pass + fail + 1} attachment checks passed (TIMED OUT)`);
    process.exit(1);
}, 60000).unref();

(async () => {
    /* ---- the stage: a workspace and a per-session staging dir ---- */
    const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lcl-attws-")));
    fs.writeFileSync(path.join(WS, "notes.txt"), "the fixer bath is at 24 C");
    fs.writeFileSync(path.join(WS, "big.txt"), "x".repeat(9000));
    const SID = "s-att";
    const ATT = path.join(DATA, "attachments", SID);
    fs.mkdirSync(ATT, { recursive: true });
    fs.writeFileSync(path.join(ATT, "a1-hello.txt"), "the staged truth");
    fs.writeFileSync(path.join(DATA, "secret.txt"), "NEVER-THIS");

    const att = (over) => ({ id: "a0", name: "notes.txt", rel: "notes.txt",
        path: path.join(WS, "notes.txt"), bytes: 25, kind: "text", staged: false,
        readPath: path.join(WS, "notes.txt"), ...over });

    /* ================================================ 1. THE APPENDIX ---- */
    {
        const ap = agent.attachmentAppendix([att()], { read_file: {} }, true);
        check("a text attachment is inlined, named by its workspace rel",
            ap.includes("the fixer bath is at 24 C") && ap.includes("notes.txt"), ap.slice(0, 200));
        check("...inside the framed block the model can recognise",
            ap.includes("--- FILES THE OPERATOR ATTACHED TO THIS MESSAGE (1) ---")
            && ap.includes("--- END OF ATTACHMENTS ---"));

        const big = agent.attachmentAppendix(
            [att({ name: "big.txt", rel: "big.txt", bytes: 9000,
                   readPath: path.join(WS, "big.txt") })], { read_file: {} }, true);
        check("an over-cap text file states the truncation honestly",
            big.includes("first 8000 of 9000 chars"), big.slice(0, 200));
        check("...and points at read_file for the rest",
            big.includes('read_file {"path": "big.txt"}'));

        const gone = agent.attachmentAppendix(
            [att({ readPath: path.join(WS, "vanished.txt") })], { read_file: {} }, true);
        check("a file that cannot be read SAYS so with the reason class — " +
              "a vanished file must never read as an empty file",
            /could not be read \(ENOENT\)/.test(gone), gone.slice(0, 200));

        const img = (tools, hasWs) => agent.attachmentAppendix(
            [att({ name: "p.png", rel: null, kind: "image", staged: true,
                   stagedName: "a2-p.png", readPath: path.join(ATT, "a2-p.png") })],
            tools, hasWs);
        check("an image with vision live points at read_image with the @attachments ref",
            img({ read_image: {} }, true).includes('read_image {"path": "@attachments/a2-p.png"}'));
        check("an image with only OCR points at read_image_text",
            img({ read_image_text: {} }, true).includes("read_image_text"));
        check("no vision IN a workspace: the model's limit is stated",
            img({}, true).includes("this model cannot view images"));
        const noWs = img({}, false);
        check("NO WORKSPACE is NOT blamed for an attachment — a folder never " +
              "unlocks image reading (that is the model, or OCR), and the note " +
              "says a workspace is not required so the model stops asking for one",
            noWs.includes("workspace is NOT required") && !noWs.includes("no folder is linked"),
            noWs);

        const pdf = agent.attachmentAppendix(
            [att({ name: "d.pdf", rel: "d.pdf", kind: "pdf" })], { read_pdf: {} }, true);
        check("a PDF points at read_pdf", pdf.includes('read_pdf {"path": "d.pdf"}'));
        const pdfNoWs = agent.attachmentAppendix(
            [att({ name: "d.pdf", rel: null, kind: "pdf", staged: true, stagedName: "a3-d.pdf" })], {}, false);
        check("...and the pdf line does not blame the workspace either",
            pdfNoWs.includes("no PDF reader") && pdfNoWs.includes("workspace is NOT required"),
            pdfNoWs);

        const bin = agent.attachmentAppendix(
            [att({ name: "fw.bin", rel: "fw.bin", kind: "binary", bytes: 4096 })], {}, true);
        check("a binary is name and size only — no body, no pretend pointer",
            bin.includes("fw.bin") && bin.includes("binary, contents not readable")
            && !bin.includes("call "), bin);

        const four = agent.attachmentAppendix(
            [1, 2, 3, 4].map(i => att({ id: "a" + i, name: `big${i}.txt`, rel: `big${i}.txt`,
                bytes: 9000, readPath: path.join(WS, "big.txt") })), { read_file: {} }, true);
        check("the whole appendix is bounded — four 9k files stay near the 24k budget",
            four.length < 30000, four.length);
    }

    /* ====================================== 2. runTool's @attachments ---- */
    {
        const tools = agent.effectiveTools({ workspace: true });
        const ctx = { attachRoot: ATT, toolResultCap: 100000 };
        const rd = await agent.runTool(tools, WS, "read_file",
            { path: "@attachments/a1-hello.txt" }, ctx);
        check("read_file re-roots @attachments/ into the staging dir and reads the copy",
            rd.failed === false && rd.output.includes("the staged truth"), rd.output);

        const wr = await agent.runTool(tools, WS, "write_file",
            { path: "@attachments/a1-hello.txt", content: "poison" }, ctx);
        check("write_file REFUSES the prefix — attachments allow reading and " +
              "in-place converting (media_transform/transcribe for scans and " +
              "voice notes), never writing",
            wr.failed === true && /only reading and converting/.test(wr.output), wr.output);
        check("...and the staged copy is untouched",
            fs.readFileSync(path.join(ATT, "a1-hello.txt"), "utf8") === "the staged truth");

        const esc = await agent.runTool(tools, WS, "read_file",
            { path: "@attachments/../../secret.txt" }, ctx);
        check("an escaping @attachments path dies in the SAME resolveInRoot every tool uses",
            esc.failed === true && !esc.output.includes("NEVER-THIS"), esc.output);

        const bare = await agent.runTool(tools, WS, "read_file",
            { path: "@attachments/a1-hello.txt" }, { toolResultCap: 100000 });
        check("without ctx.attachRoot the prefix is NOT a door — it resolves " +
              "nowhere in the workspace and fails honestly",
            bare.failed === true && !bare.output.includes("the staged truth"), bare.output);
    }

    /* ====================== 3. policy audit honesty (the verdict fix) ---- */
    {
        const session = { id: SID, repoPath: WS };
        const v = policyBridge.check(session, "read_file",
            { path: "@attachments/a1-hello.txt" }, {});
        check("a staged read is ALLOWED through the kernel's scope carve-out",
            v.decision === DECISION.ALLOW, v.decision + " " + v.reason);
        check("...and the audit row records the RE-ROOTED REAL path, not " +
              "a fictional <repo>/@attachments/…",
            v.record && typeof v.record.path === "string"
            && v.record.path.endsWith("a1-hello.txt")
            && v.record.path.includes(path.join("attachments", SID))
            && !v.record.path.includes("@attachments")
            && !v.record.path.startsWith(WS), v.record && v.record.path);

        const w = policyBridge.check(session, "write_file",
            { path: "@attachments/a1-hello.txt", content: "x" }, {});
        check("a WRITE aimed at the staging dir is DENIED — the carve-out is reads-only",
            w.decision === DECISION.DENY && /scope/i.test(w.reason), w.decision + " " + w.reason);

        const e = policyBridge.check(session, "read_file",
            { path: "@attachments/../../evil.txt" }, {});
        check("an escaping @attachments read is DENIED at the kernel too",
            e.decision === DECISION.DENY, e.decision + " " + e.reason);

        const plain = policyBridge.check(session, "read_file", { path: "notes.txt" }, {});
        check("an ordinary in-workspace read is untouched by any of this",
            plain.decision === DECISION.ALLOW, plain.decision);
    }

    /* ================== 4. runTurn: transcript truth vs model truth ---- */
    {
        const realGen = engine.generate;
        const realWindow = engine.contextWindow;
        engine.contextWindow = () => 32768;
        const calls = [];
        engine.generate = async (msgs) => { calls.push(msgs); return { content: "I read it." }; };

        const atts = [
            att({ id: "at1" }),
            att({ id: "at2", name: "p.png", rel: null, kind: "image", staged: true,
                  stagedName: "a2-p.png", bytes: 10, path: "C:\\somewhere\\p.png",
                  readPath: path.join(ATT, "a2-p.png") })
        ];
        const session = { id: SID, repoPath: WS, messages: [] };
        const r = await agent.runTurn(session, "what does the note say?",
            { selection: null, onProgress: () => {}, attachments: atts, attachRoot: ATT });
        const um = (r.newMessages || [])[0];
        check("the turn ran", r.ok === true, r.error);
        check("the persisted user message is EXACTLY the operator's text",
            um && um.role === "user" && um.content === "what does the note say?",
            um && um.content);
        check("...carrying the attachment list beside it for the UI's chips",
            um && Array.isArray(um.attachments) && um.attachments.length === 2
            && um.attachments[0].name === "notes.txt" && um.attachments[1].kind === "image",
            um && JSON.stringify(um.attachments || []).slice(0, 200));
        const modelSaw = calls.some(msgs => (msgs || []).some(m => m && m.role === "user"
            && String(m.content).includes("what does the note say?")
            && String(m.content).includes("FILES THE OPERATOR ATTACHED")
            && String(m.content).includes("the fixer bath is at 24 C")
            && String(m.content).includes("@attachments/a2-p.png")));
        check("the MODEL-facing copy carried the appendix: typed text + inline " +
              "note + the staged image ref", modelSaw,
            JSON.stringify((calls[0] || []).map(m => m.role)));
        check("...but the appendix never entered the transcript",
            !(r.newMessages || []).some(m => String(m.content || "").includes("FILES THE OPERATOR ATTACHED")));

        engine.generate = realGen;
        engine.contextWindow = realWindow;
    }

    /* ============ 5. source pins for the main-process seams -------------- */
    {
        const MAIN = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
        const APP = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
        const PB = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "policyBridge.js"), "utf8");
        const KR = fs.readFileSync(path.join(ROOT, ".lcl.engine", "policy", "kernel.js"), "utf8");

        check("stageOne resolves an explorer {rel} through resolveInRoot — an " +
              "escaping rel is refused, never quietly copied out",
            MAIN.includes("fsTools.resolveInRoot(s.repoPath, String(ref.rel))"));

        const iVanish = MAIN.indexOf("the linked folder no longer exists — it has been unlinked");
        const iAtts = MAIN.indexOf("const atts = Array.isArray(s.stagedAttachments)");
        const iRoute = MAIN.indexOf("const taskRoute = resolveTaskRoute(s, text);");
        check("chips are consumed BELOW the vanished-folder early save — the one " +
              "path that saves before failing must not persist an emptied list",
            iVanish !== -1 && iAtts !== -1 && iRoute !== -1 && iVanish < iAtts && iAtts < iRoute,
            JSON.stringify({ iVanish, iAtts, iRoute }));

        check("an attachment turn runs the plain agent loop, not the step machine",
            MAIN.includes("&& atts.length === 0;"));
        check("the end-of-turn merge keeps files staged DURING the turn, minus consumed",
            MAIN.includes("s.stagedAttachments = cur.stagedAttachments.filter(a => !consumed.has(a.id));"));
        check("runTurn is handed the attachments AND the staging root every turn",
            MAIN.includes("attachments: atts, attachRoot: attachmentsDirFor(s.id),"));

        const iDel = MAIN.indexOf('ipcMain.handle("lcl:deleteSession"');
        const iClean = MAIN.indexOf('fs.rmSync(path.join(paths.dataDir(), "attachments", String(id)),');
        const iRet = MAIN.indexOf("return { deleted: id };");
        check("deleting a session deletes its staging dir — no disk leak on delete",
            iDel !== -1 && iClean !== -1 && iRet !== -1 && iDel < iClean && iClean < iRet,
            JSON.stringify({ iDel, iClean, iRet }));

        check("the policy bridge's carve-out is READ tools only, by name",
            PB.includes("if (ATT_READ_TOOLS.has(tool)) attachScope = attachRoot;"));
        check("the kernel accepts the carve-out only when the resolved path is " +
              "really inside the staging scope",
            KR.includes("!(ctx.attachScope && PolicyKernel.withinScope(ctx.attachScope, ctx.resolvedPath))"));

        check("a mid-turn question re-add carries its chips (switchSession)",
            APP.includes("attachments: sentAtts")
            && APP.includes('addMessageRow("user", q.text, active.messages.length, undefined, q.attachments);'));
    }

    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* held */ }
    console.log(`\n${pass}/${pass + fail} attachment checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error("HARNESS ERROR:", e && e.stack || e);
    process.exit(1);
});
