/**
 * TASK HORIZON — the engineering answer to a measured failure.
 *
 * The operator, comparing a real .lcl build session against a frontier
 * model's output on the same ask: "i need .lcl, to be closer to what you
 * produced ... it is nowhere near the level of work i need, or at the speed
 * i need." The session forensics named the mechanisms, and every one is a
 * check in this suite:
 *
 *   1. extract_pdf ran THREE times concurrently on the same PDF; the
 *      interleaved writes left full.txt with 61 page markers for 26 pages.
 *      -> per-sidecar mutex + atomic temp-then-rename writes (pdfExtract).
 *   2. Identical tool calls repeated across parallel step-turns.
 *      -> in-flight coalescing for read-class tools (agent.runTool).
 *   3. The builder read the same first 16KB of its source SEVEN times and
 *      never paged deeper; index.md and meta.json were never opened.
 *      -> read-range tracking with a paging nudge (agent.runTool), the
 *         document map delivered INLINE as a digest (docTools), field order
 *         chosen to survive result caps, and an `offset` arg in the native
 *         read_file schema (toolManifest).
 *   4. The artifact loaded Chart.js from a CDN in an offline-first product,
 *      the reply named files that did not exist, and no critique left any
 *      trace. -> the deterministic post-check gate (main.js: offline lint +
 *      phantom-path check — a prose-claims grep was built, adversarially
 *      reviewed, and KILLED as a false accuser), rendered as the app's own
 *      caveat (app.js + styles.css); the per-step critic's verdict persisted
 *      as a "verify" step, including honest "passed unexamined"
 *      (orchestrator.js + selfAudit.js); the plan text persisted in meta
 *      (orchestrator.js). Fabrication-in-prose stays with the model-graded
 *      reviews (self-audit, AK) — and the runtime's own notes are excluded
 *      from training export so node models never learn the gate's voice.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// isolate dataDir and shim electron BEFORE agent.js loads (same rig as
// attachments.js) — suite writes must never land in the real settings/ledger
const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lcl-th-data-")));
process.env.LCL_DATA_DIR = DATA;
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return origResolve.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
} };
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });

const pdfExtract = require(path.join(ROOT, ".lcl.engine", "core", "pdfExtract.js"));
const docTools = require(path.join(ROOT, ".lcl.engine", "core", "docTools.js"));
const fsTools = require(path.join(ROOT, ".lcl.engine", "core", "fsTools.js"));
const agent = require(path.join(ROOT, ".lcl.engine", "core", "agent.js"));

const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");
const orchSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "orchestrator.js"), "utf8");
const auditSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "selfAudit.js"), "utf8");
const pdfxSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "pdfExtract.js"), "utf8");
const manifestSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "toolManifest.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + String(detail).slice(0, 200) : ""); }
}

/* ---- fixture builders: valid PDFs built in-test (same scheme as pdf-extract.js) */
function buildPdf(objs) {
    let pdf = Buffer.from("%PDF-1.4\n", "latin1");
    const offsets = [];
    for (let i = 1; i < objs.length; i++) {
        offsets[i] = pdf.length;
        pdf = Buffer.concat([pdf, Buffer.from(`${i} 0 obj\n${objs[i]}\nendobj\n`, "latin1")]);
    }
    const xrefAt = pdf.length;
    let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    xref += `trailer\n<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF`;
    return Buffer.concat([pdf, Buffer.from(xref, "latin1")]);
}
function textPdf() {
    const c1 = "BT /F1 24 Tf 72 700 Td (Alpha page one.) Tj ET";
    const c2 = "BT /F1 14 Tf 72 700 Td (Beta page two.) Tj ET";
    const objs = [];
    objs[1] = "<</Type/Catalog/Pages 2 0 R>>";
    objs[2] = "<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>";
    objs[3] = "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>";
    objs[4] = `<</Length ${c1.length}>>\nstream\n${c1}\nendstream`;
    objs[5] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
    objs[6] = "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 7 0 R/Resources<</Font<</F1 5 0 R>>>>>>";
    objs[7] = `<</Length ${c2.length}>>\nstream\n${c2}\nendstream`;
    return buildPdf(objs);
}
const countMarkers = (txt) => (txt.match(/--- page \d+/g) || []).length;

(async () => {

    /* ================= 1. EXTRACTION ATOMICITY — the triple-run corruption == */
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-th-"));
        const pdf = path.join(dir, "doc.pdf"); fs.writeFileSync(pdf, textPdf());
        const out = path.join(dir, "doc.extract");

        // the observed failure, reproduced: THREE concurrent full extractions
        // of the same PDF into the same sidecar. Serialized + replace-on-rerun,
        // full.txt must hold exactly one marker per page, in order.
        await Promise.all([
            pdfExtract.extract(pdf, { outDir: out }),
            pdfExtract.extract(pdf, { outDir: out }),
            pdfExtract.extract(pdf, { outDir: out }),
        ]);
        const full = fs.readFileSync(path.join(out, "text", "full.txt"), "utf8");
        check("3 concurrent extracts of a 2-page PDF leave EXACTLY 2 page markers (was: 61 markers for 26 pages)",
            countMarkers(full) === 2, `markers=${countMarkers(full)}`);
        check("...pages in order, text intact",
            full.indexOf("Alpha page one.") > -1 && full.indexOf("Beta page two.") > full.indexOf("Alpha page one."),
            full.slice(0, 120));
        check("...no half-written temp files left in the sidecar",
            !fs.readdirSync(path.join(out, "text")).some(f => f.includes(".lcl-tmp-")));
        check("...meta.json is valid JSON after the pile-up",
            (() => { try { JSON.parse(fs.readFileSync(path.join(out, "meta.json"), "utf8")); return true; } catch { return false; } })());

        // paged continuation still appends: window 1 then window 2
        const out2 = path.join(dir, "paged.extract");
        await pdfExtract.extract(pdf, { outDir: out2, pageEnd: 1 });
        await pdfExtract.extract(pdf, { outDir: out2, pageStart: 2 });
        const paged = fs.readFileSync(path.join(out2, "text", "full.txt"), "utf8");
        check("paged extraction (1 then 2) accumulates both pages exactly once",
            countMarkers(paged) === 2 && paged.includes("Alpha page one.") && paged.includes("Beta page two."),
            `markers=${countMarkers(paged)}`);

        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    }
    {
        // NTFS treats "DOC.extract" and "doc.extract" as ONE directory — a
        // case-variant spelling must take the SAME lock (reviewed defect)
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-th-"));
        const pdf = path.join(dir, "case.pdf"); fs.writeFileSync(pdf, textPdf());
        const out = path.join(dir, "case.extract");
        const variant = path.join(dir, "CASE.EXTRACT");
        await Promise.all([
            pdfExtract.extract(pdf, { outDir: out }),
            pdfExtract.extract(pdf, { outDir: variant }),
        ]);
        const full = fs.readFileSync(path.join(out, "text", "full.txt"), "utf8");
        check("case-variant sidecar spellings serialize on the SAME lock (NTFS is case-insensitive)",
            countMarkers(full) === 2, `markers=${countMarkers(full)}`);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    }
    check("pdfExtract serializes per sidecar (withSidecarLock wraps extract)",
        /withSidecarLock\(key/.test(pdfxSrc) && /key = key\.toLowerCase\(\)/.test(pdfxSrc));
    check("docTools derives the sidecar basename from the CANONICAL path, never the model's spelling",
        /path\.basename\(full, path\.extname\(full\)\)/.test(fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "docTools.js"), "utf8")));
    check("pdfExtract writes full.txt atomically — the per-page append into the live file is GONE",
        !/appendFileSync\(fullTxt/.test(pdfxSrc) && /atomicWriteSync\(fullTxt/.test(pdfxSrc));
    check("meta.json and index.md are temp-then-rename too",
        /atomicWriteSync\(path\.join\(dirs\.root, "meta\.json"\)/.test(pdfxSrc)
        && /atomicWriteSync\(path\.join\(root, "index\.md"\)/.test(pdfxSrc));
    check("fsTools exports the one atomic writer both modules share",
        typeof fsTools.atomicWriteSync === "function");

    /* ================= 2. THE MAP RIDES THE RESULT — extract_pdf digest ===== */
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-th-"));
        fs.writeFileSync(path.join(dir, "doc.pdf"), textPdf());
        const res = await docTools.extractPdf(dir, { path: "doc.pdf" });
        check("extract_pdf returns a digest naming the document and its extent",
            typeof res.digest === "string" && /2 page\(s\)/.test(res.digest), res.digest);
        check("...with a per-page inventory line for every page",
            /p1: \d+/.test(res.digest) && /p2: \d+/.test(res.digest), res.digest);
        const json = JSON.stringify(res);
        check("field order is survival order: digest and note come BEFORE the 3000-char sample",
            json.indexOf('"digest"') > -1 && json.indexOf('"digest"') < json.indexOf('"text"')
            && json.indexOf('"note"') < json.indexOf('"text"'));
        check("the note teaches PAGING, not re-reading",
            /page FORWARD/.test(res.note) && /fromLine/.test(res.note), res.note);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    }

    /* ================= 3. NO DUPLICATE WORK — coalescing + the re-read nudge = */
    {
        // two identical concurrent read-class calls run the tool ONCE
        let invocations = 0, release;
        const gate = new Promise(r => { release = r; });
        const tools = { read_file: { run: () => { invocations++; return gate; } } };
        const ctx = () => ({ sessionId: "th-co", toolResultCap: 999999 });
        const pA = agent.runTool(tools, "C:/th-root", "read_file", { path: "a.txt" }, ctx());
        const pB = agent.runTool(tools, "C:/th-root", "read_file", { path: "a.txt" }, ctx());
        await new Promise(r => setTimeout(r, 25));
        release({ content: "hello", size: 5, offset: 0, truncated: false });
        const [ra, rb] = await Promise.all([pA, pB]);
        check("two identical concurrent read_file calls invoke the tool ONCE",
            invocations === 1, `invocations=${invocations}`);
        check("...the joiner carries the coalesced marker; the first caller does not",
            JSON.parse(rb.output).coalesced === true && JSON.parse(ra.output).coalesced === undefined);

        // in-flight only, never a cache: a call AFTER settle runs fresh
        tools.read_file.run = () => { invocations++; return { content: "hello", size: 5, offset: 0, truncated: false }; };
        await agent.runTool(tools, "C:/th-root", "read_file", { path: "a.txt" }, ctx());
        check("an identical call AFTER the first settles runs fresh (dedup, not cache)",
            invocations === 2, `invocations=${invocations}`);

        // different args never coalesce
        let slowCount = 0;
        const slow = { read_file: { run: () => { slowCount++; return new Promise(r => setTimeout(() => r({ content: "x", size: 1, offset: 0, truncated: false }), 15)); } } };
        await Promise.all([
            agent.runTool(slow, "C:/th-root", "read_file", { path: "a.txt", fromLine: 1 }, ctx()),
            agent.runTool(slow, "C:/th-root", "read_file", { path: "a.txt", fromLine: 400 }, ctx()),
        ]);
        check("different args never coalesce", slowCount === 2, `slowCount=${slowCount}`);

        // DIFFERENT SESSIONS never coalesce — the join runs under the first
        // caller's ctx (cancel, selection, progress), so sharing across
        // sessions would bleed one session's Stop into another (reviewed defect)
        let xCount = 0;
        const xs = { read_file: { run: () => { xCount++; return new Promise(r => setTimeout(() => r({ content: "x", size: 1, offset: 0, truncated: false }), 15)); } } };
        await Promise.all([
            agent.runTool(xs, "C:/th-root", "read_file", { path: "a.txt" }, { sessionId: "sess-A", toolResultCap: 999999 }),
            agent.runTool(xs, "C:/th-root", "read_file", { path: "a.txt" }, { sessionId: "sess-B", toolResultCap: 999999 }),
        ]);
        check("identical calls from DIFFERENT sessions never coalesce (no cancel/selection bleed)",
            xCount === 2, `xCount=${xCount}`);
    }
    {
        // THE SEVEN-READS FAILURE: an exact repeat gets the paging nudge
        const stub = { read_file: { run: () => ({ content: "0123456789", fromLine: 1, toLine: 200, totalLines: 500, truncated: true }) } };
        const ctx = { sessionId: "th-nudge", toolResultCap: 999999 };
        const r1 = await agent.runTool(stub, "C:/th-root2", "read_file", { path: "big.txt" }, ctx);
        const r2 = await agent.runTool(stub, "C:/th-root2", "read_file", { path: "big.txt" }, ctx);
        check("the first read of a slice carries no nudge", !/already read exactly this slice/.test(r1.output));
        check("an EXACT repeat is told so, with the file's real extent",
            /already read exactly this slice/.test(r2.output) && /500 lines/.test(r2.output), r2.output.slice(0, 300));
        check("...and handed the literal next call that advances",
            // the nudge lives inside the JSON-stringified result, so its
            // quotes arrive escaped — accept both forms
            /fromLine\\?": 201/.test(r2.output), r2.output.slice(0, 300));

        // a repeat that already returned the WHOLE file says exactly that
        const whole = { read_file: { run: () => ({ content: "hi", size: 2, offset: 0, truncated: false }) } };
        await agent.runTool(whole, "C:/th-root2", "read_file", { path: "small.txt" }, ctx);
        const w2 = await agent.runTool(whole, "C:/th-root2", "read_file", { path: "small.txt" }, ctx);
        check("re-reading a fully-returned file says you already hold everything",
            /WHOLE file/.test(w2.output), w2.output.slice(0, 300));

        // a write clears the file's remembered ranges — the model re-reading
        // its own rewrite is correct behavior, not a repeat
        const wtools = { write_file: { run: () => ({ written: "big.txt" }) } };
        await agent.runTool(wtools, "C:/th-root2", "write_file", { path: "big.txt", content: "new" }, ctx);
        const r3 = await agent.runTool(stub, "C:/th-root2", "read_file", { path: "big.txt" }, ctx);
        check("a write through the dispatcher clears the path's read history",
            !/already read exactly this slice/.test(r3.output), r3.output.slice(0, 300));

        // move_file carries {from, to} — the clear must fire for those too
        // (a rename onto a read path used to leave the stale history live)
        await agent.runTool(stub, "C:/th-root2", "read_file", { path: "big.txt" }, ctx); // seen=1 again
        const mtools = { move_file: { run: () => ({ moved: true }) } };
        await agent.runTool(mtools, "C:/th-root2", "move_file", { from: "other.txt", to: "big.txt" }, ctx);
        const r4 = await agent.runTool(stub, "C:/th-root2", "read_file", { path: "big.txt" }, ctx);
        check("move_file clears the DESTINATION path's read history (args are from/to, not path)",
            !/already read exactly this slice/.test(r4.output), r4.output.slice(0, 300));

        // the same file spelled "./big.txt" or "big\\txt" is the same key —
        // a write under a spelling variant must still clear the history
        await agent.runTool(stub, "C:/th-root2", "read_file", { path: "big.txt" }, ctx);
        await agent.runTool(wtools, "C:/th-root2", "write_file", { path: "./big.txt", content: "x" }, ctx);
        const r5 = await agent.runTool(stub, "C:/th-root2", "read_file", { path: "big.txt" }, ctx);
        check("path spelling variants (./x, backslashes) share one read-history key",
            !/already read exactly this slice/.test(r5.output), r5.output.slice(0, 300));

        // a coalesced joiner's "read" was free — it must not advance the
        // counter (two parallel FIRST reads are not a repeat)
        let jrel; const jgate = new Promise(r => { jrel = r; });
        const jtools = { read_file: { run: () => jgate } };
        const jctx = { sessionId: "th-join", toolResultCap: 999999 };
        const j1 = agent.runTool(jtools, "C:/th-root3", "read_file", { path: "j.txt" }, jctx);
        const j2 = agent.runTool(jtools, "C:/th-root3", "read_file", { path: "j.txt" }, jctx);
        await new Promise(r => setTimeout(r, 20));
        jrel({ content: "j", fromLine: 1, toLine: 200, totalLines: 500, truncated: true });
        await Promise.all([j1, j2]);
        jtools.read_file.run = () => ({ content: "j", fromLine: 1, toLine: 200, totalLines: 500, truncated: true });
        const j3 = await agent.runTool(jtools, "C:/th-root3", "read_file", { path: "j.txt" }, jctx);
        check("a coalesced joiner does not advance the repeat counter",
            /this slice 1 time\(s\)/.test(j3.output), j3.output.slice(0, 300));

        // the byte-mode resume offset uses the byte count fsTools ACTUALLY
        // consumed, not the re-measured decoded string (U+FFFD inflation)
        const btools = { read_file: { run: () => ({ content: "aaaa", size: 100, offset: 0, bytesRead: 7, truncated: true }) } };
        const bctx = { sessionId: "th-bytes", toolResultCap: 999999 };
        await agent.runTool(btools, "C:/th-root4", "read_file", { path: "b.bin.txt" }, bctx);
        const b2 = await agent.runTool(btools, "C:/th-root4", "read_file", { path: "b.bin.txt" }, bctx);
        check("the byte-mode nudge resumes at bytesRead, never the decoded string length",
            /offset\\?": 7/.test(b2.output), b2.output.slice(0, 300));
    }
    {
        // fsTools reports the bytes it actually consumed
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-th-"));
        fs.writeFileSync(path.join(dir, "n.txt"), "hello");
        const r = fsTools.readFile(dir, { path: "n.txt" });
        check("readFile returns bytesRead (the true resume base for a byte-mode continuation)",
            r.bytesRead === 5 && r.size === 5, JSON.stringify(r));
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    }
    {
        // THE FLOOR HOLDS ON EVERY DISPATCH SITE. The approval path runs
        // entry.run directly (main.js's second dispatch site) — it must clear
        // the SAME read history the agent loop clears.
        const stub = { read_file: { run: () => ({ content: "z", fromLine: 1, toLine: 200, totalLines: 500, truncated: true }) } };
        const ctx = { sessionId: "th-appr", toolResultCap: 999999 };
        await agent.runTool(stub, "C:/th-root5", "read_file", { path: "z.txt" }, ctx);
        check("clearReadHistory is exported for the second dispatch site",
            typeof agent.clearReadHistory === "function");
        agent.clearReadHistory("th-appr", "C:/th-root5", ["./z.txt"]);   // approval-path spelling variant
        const z2 = await agent.runTool(stub, "C:/th-root5", "read_file", { path: "z.txt" }, ctx);
        check("an approved write's clear makes the next read fresh (spelling-normalized)",
            !/already read exactly this slice/.test(z2.output), z2.output.slice(0, 300));
    }
    {
        const appr = mainSrc.slice(mainSrc.indexOf("THE SECOND DISPATCH SITE"),
                                   mainSrc.indexOf("function expireApprovalsFor"));
        check("the approval path clears read history AND post-checks the approved artifact",
            /agent\.clearReadHistory\(s\.id, s\.repoPath/.test(appr)
            && /postCheckTurn\(s, \{ changes: \[change\], newMessages: \[\] \}\)/.test(appr)
            && /approval: true/.test(appr));
    }
    check("the native read_file schema now advertises the byte-offset page argument",
        (() => { const seg = manifestSrc.slice(manifestSrc.indexOf("read_file: {"), manifestSrc.indexOf("write_file: {"));
                 return /name: "offset"/.test(seg); })());

    /* ================= 4. THE DURABLE VERIFY RECORD ========================= */
    check("\"verify\" is a durable step phase (STEP_KEEP)", agent.STEP_KEEP.has("verify"));
    check("the orchestrator records every critique verdict as a verify step",
        /onProgress\(\{ phase: "verify", detail: \{/.test(orchSrc));
    check("...including the honest 'passed unexamined' case",
        /passed unexamined/.test(orchSrc));
    check("critiqueStep names WHY it passed without looking (model-error / cancelled / critic-failed / no-text-artifact)",
        /skipped: cancelToken\.cancelled \? "cancelled" : "model-error"/.test(auditSrc)
        && /skipped: "critic-failed"/.test(auditSrc)
        && /skipped: "no-text-artifact"/.test(auditSrc));
    check("the renderer draws the verify verdict in step replay",
        /case "verify":/.test(appSrc) && /verify — /.test(appSrc));

    /* ================= 5. THE PLAN IS PERSISTED ============================= */
    check("the orchestrator persists the plan TEXT into the summary meta, capped",
        /plan: steps\.map\(st => \(\{ n: st\.n, title: String\(st\.title\)\.slice\(0, 80\)/.test(orchSrc)
        && /action: String\(st\.action\)\.slice\(0, 240\)/.test(orchSrc));

    /* ================= 6. THE NO-FICTION GATE (post-check) ================== */
    {
        const helper = mainSrc.slice(mainSrc.indexOf("============================================================== POST-CHECK"),
                                     mainSrc.indexOf("function setSessionStatus"));
        check("postCheckTurn exists as the deterministic turn-end gate", /function postCheckTurn\(s, result\)/.test(helper));
        check("kill switch: settings.postCheck === false, default ON",
            /readSettings\(\)\.postCheck === false\) return null/.test(helper));
        check("it runs ONLY on turns that wrote files (a chat answer has no artifacts to lint)",
            /if \(!written\.length\) return null/.test(helper));
        // THE PROSE-CLAIMS CHECK IS DELIBERATELY ABSENT. It was built,
        // adversarially reviewed, and killed: it accused honest replies
        // deterministically while plain-prose fabrication never matched its
        // regexes. This gate asserts only what disk can prove.
        check("there is NO prose-claims term grep (reviewed and killed as a false accuser)",
            !/\[A-Z\]\[A-Z0-9\]\{2,9\}/.test(helper) && !/POST_CHECK_STOP/.test(helper)
            && /deliberately NO prose-claims check/.test(helper));
        check("the gate examines the MODEL's reply, never the auditors' or orchestrator's own messages",
            /POST_CHECK_MACHINE/.test(helper) && /"ancient-knowledge"/.test(helper)
            && /"orchestrator"/.test(helper));
        check("file check: PATH-LIKE names only — bare prose words assert nothing checkable",
            /not exist in the workspace/.test(helper) && /!rel\.includes\("\/"\)/.test(helper));
        check("...domain-shaped tokens and files deleted this turn are exempt",
            /\[\\w-\]\+\\\.\[a-z\]\{2,4\}\\\//.test(helper) && /deleted\.has\(rel\)/.test(helper));
        check("...and a turn waiting on an approval is not second-guessed about its future outputs",
            /const staged = \(\(result && result\.pendingApprovals\)/.test(helper)
            && /if \(!staged && finalText\)/.test(helper));
        check("offline lint: load-bearing network references, protocol-relative included",
            helper.includes("(?:https?:)?") && /@import/.test(helper)
            && /will not work offline/.test(helper));
        check("...covering the dynamic-loader, WebSocket and XHR forms the first cut missed",
            helper.includes("new WebSocket") && helper.includes("\\.open\\(")
            && helper.includes("dynamic loader injection"));
        check("...localhost is THIS machine, never an offline violation",
            /POST_CHECK_LOCAL_HOST/.test(helper) && /127\\\.0\\\.0\\\.1/.test(helper));
        check("...a <link> that loads nothing (rel=canonical) does not flag",
            /stylesheet\|icon\|preload/.test(helper));
        check("...big files are linted by their HEAD, not exempted by a size skip",
            /postCheckHeadOf/.test(helper) && /POST_CHECK_READ_CAP/.test(helper)
            && !/POST_CHECK_MAX_BYTES/.test(helper));
        check("an <a href> link is deliberately NOT flagged (links still work offline)",
            !/<a\[/.test(helper));
    }
    check("training export never teaches a node model to speak in the gate's voice",
        /m\.meta\.model === "post-check" \|\| m\.meta\.postCheck/.test(
            fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "trainingExport.js"), "utf8")));
    {
        const gateAt = mainSrc.indexOf("const post = postCheckTurn(s, result)");
        check("the gate runs at the convergence point of BOTH paths (orchestrated and chat)",
            gateAt > -1 && mainSrc.slice(gateAt - 600, gateAt).includes("unbilled"));
        check("...BEFORE approvals/status close the turn out",
            gateAt > -1 && gateAt < mainSrc.indexOf("pendingToolApprovals.set(p.id, p); staged++;"));
        const wiring = mainSrc.slice(gateAt, gateAt + 900);
        check("findings ride the transcript as the app's own message AND the returned delta",
            /model: "post-check"/.test(wiring) && /s\.messages\.push\(pcMsg\)/.test(wiring)
            && /result\.newMessages = \[\.\.\.\(result\.newMessages \|\| \[\]\), pcMsg\]/.test(wiring));
        check("every finding set lands in the audit trail", /kind: "post-check"/.test(wiring));
        check("the check can never sink a finished turn",
            /never becomes the failure/.test(wiring));
    }
    check("renderer: the post-check message is drawn as the app's caveat, not an assistant reply",
        /meta\.model === "post-check"/.test(appSrc) && /msg-postcheck/.test(appSrc)
        && /Copy these findings/.test(appSrc));
    check("styles: the post-check bubble wears the caution stripe on the assistant side",
        /\.msg-postcheck \{/.test(cssSrc) && /border-left: 2px solid var\(--attn\)/.test(cssSrc)
        && /\.msg-postcheck-head \{/.test(cssSrc));

    console.log(`\n${pass}/${pass + fail} task-horizon checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(1); });
