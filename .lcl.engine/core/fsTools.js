const fs = require("fs");
const path = require("path");

/**
 * Sandboxed file tools for workspace-linked sessions.
 *
 * Every operation is confined to the linked folder:
 *  - caller-supplied paths are resolved with realpath and must stay inside the
 *    root, which also defeats symlink escapes
 *  - recursive walks re-validate EVERY entry, because on Windows a directory
 *    junction is not reported as a symlink and would otherwise let a walk
 *    escape the root
 *  - reads/writes/search results are capped so a small-context model is never
 *    handed more than it can use
 */

const READ_CAP_BYTES = 16_000;
const WRITE_CAP_BYTES = 200_000;
/* THE MODEL'S SLICE OF A FOLDER LISTING.
 *
 * 200 was a guess made when every prompt was squeezed into a 4,096-token
 * window. A repository can hold 428 files, so a listing that shows only 200 of
 * 400+ reports a limit that has no reason left to exist: a node can serve
 * 131,072 tokens, and 400 entries of ~45 characters is about 5,000 of them.
 *
 * The cap still exists, because a listing is not free and some folders have
 * 50,000 files. What changed is that reaching past it is now ARITHMETIC —
 * `offset` — instead of impossible. */
const LIST_CAP_ENTRIES = 400;
const SEARCH_CAP_RESULTS = 40;
const SEARCH_FILE_CAP_BYTES = 512_000;
const BINARY_SNIFF_BYTES = 1024;

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"]);
// Writing into any of these can hand the host code execution with no user
// action (git hooks fire on commit, editor task files on open).
const DENY_WRITE_DIRS = new Set([".git", ".github", ".vscode", ".hg", ".svn", ".idea"]);

// FILES THE MODEL MAY NEVER WRITE. Ancient Knowledge's own documents — the
// running audit trail and the operator's ground rules — are the overseer's
// surface, not the audited party's. If the model could write these it could
// inject instructions into its own auditor (or forge its own to-do), which is
// exactly the "runs away unguided" failure AK exists to stop. The operator
// edits them; the model never does. Matched on basename, case-insensitive.
const DENY_WRITE_FILES = /^ancient_knowledge(-[\w-]+)?(\.rules)?\.md$/i;

class ToolError extends Error {}

let atomicSeq = 0;
// Files THIS process has WRITTEN (never merely read). write_file may
// overwrite one of these — the model/audit repairing its own fresh page —
// but never a foreign, pre-existing file (the anti-clobber guard).
const sessionWritten = new Set();
function atomicWriteSync(full, content) {
    const tmp = full + ".lcl-tmp-" + process.pid + "-" + (atomicSeq++);
    try {
        fs.writeFileSync(tmp, content, "utf8");
        fs.renameSync(tmp, full);   // atomic replace on the same volume
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
        throw e;
    }
}

function realpathOrNull(p) {
    try {
        return fs.realpathSync.native(p);
    } catch {
        try {
            return fs.realpathSync(p);
        } catch {
            return null;
        }
    }
}

function contained(rootReal, fullPath) {
    const rp = realpathOrNull(fullPath);
    if (!rp) return false;
    return rp === rootReal || rp.startsWith(rootReal + path.sep);
}

// Windows reserved device names: creating CON/NUL/COM1... (even with an
// extension) yields paths standard tools cannot enumerate or delete. Review
// confirmed make_dir could mint them; every tool resolves through here, so
// every tool is protected at once.
const RESERVED_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

function resolveInRoot(root, relPath) {
    if (relPath === undefined || relPath === null) relPath = ".";
    if (typeof relPath !== "string") throw new ToolError("path must be a string");
    if (relPath.includes("\0")) throw new ToolError("invalid path");
    if (process.platform === "win32") {
        for (const part of relPath.split(/[\\/]/)) {
            if (RESERVED_NAME_RE.test(part.trim())) {
                throw new ToolError(`'${part}' is a reserved Windows device name`);
            }
            // NTFS ALTERNATE DATA STREAMS. "notes.txt:hidden" is not a file
            // called that — it is a second, invisible stream attached to
            // notes.txt. It passes containment (it really is under the root),
            // so the escape check never fires, yet a write there is invisible
            // to every listing the user has, and a read can name a file by a
            // spelling that name-based filters do not recognise. A relative
            // path inside a workspace has no legitimate reason to contain a
            // colon, so refuse it outright.
            //
            // A leading drive letter ("C:\...") is deliberately NOT special-
            // cased here: an absolute path is not a workspace-relative path,
            // and letting one through to be judged only by the escape check
            // is how "C:" prefixes end up trusted.
            if (part.includes(":")) {
                throw new ToolError(
                    `'${part}' names an alternate data stream — not allowed`);
            }
        }
    }

    const rootReal = realpathOrNull(root);
    if (!rootReal) throw new ToolError("linked folder is unavailable");

    const joined = path.resolve(rootReal, relPath);
    // realpath the deepest existing ancestor so new files resolve correctly
    let probe = joined;
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    const probeReal = realpathOrNull(probe) || probe;
    const candidate = path.join(probeReal, path.relative(probe, joined));

    if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) {
        throw new ToolError(`path escapes the linked folder: ${relPath}`);
    }
    return candidate;
}

function isProbablyBinary(file) {
    let fd;
    try {
        fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
        const n = fs.readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
        return buf.subarray(0, n).includes(0);
    } catch {
        return true;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
}

function* walk(base, rootReal) {
    const stack = [base];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                // realpath check catches Windows junctions, which isSymbolicLink() misses
                if (!contained(rootReal, full)) continue;
                stack.push(full);
            } else if (e.isFile()) {
                if (!contained(rootReal, full)) continue;
                yield full;
            }
        }
    }
}

/*
 * TWO CALLERS, TWO CAPS — and the cap is applied AFTER sorting.
 *
 * This capped at 200 while walking and sorted afterwards, so which 200 files
 * you got was traversal order: arbitrary, and different from the list a person
 * would predict. In a large repo that meant a file the tool had just written
 * could be created, real, and invisible — present on disk but never appearing
 * in the truncated list or in the file-explorer pop-out, which makes the
 * listing useless for confirming that a write landed.
 *
 * The MODEL still gets a small list, because an unbounded one eats its context.
 * The file explorer asks for a large one, because a person needs to see their
 * own folder. Sorting first makes either cut deterministic, and `total` says
 * how many there really are so nothing has to pretend.
 */
const WALK_HARD_MAX = 50_000;          // a repo, not a filesystem

function listFiles(root, { path: relPath = ".", cap = LIST_CAP_ENTRIES,
                           offset = 0 } = {}) {
    const base = resolveInRoot(root, relPath);
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
        throw new ToolError(`not a directory: ${relPath}`);
    }

    const rootReal = realpathOrNull(root);
    const all = [];
    let hitHardMax = false;

    for (const full of walk(base, rootReal)) {
        let size = -1;
        try { size = fs.statSync(full).size; } catch {}
        const rel = path.relative(rootReal, full).split(path.sep).join("/");
        all.push(`${rel} (${size} bytes)`);
        if (all.length >= WALK_HARD_MAX) { hitHardMax = true; break; }
    }

    all.sort();
    const limit = Math.max(1, Number(cap) || LIST_CAP_ENTRIES);
    // A DETERMINISTIC WINDOW ONTO A SORTED LIST. Sorting happens above, before
    // the cut, so page 2 is genuinely the next 400 names and not 400 arbitrary
    // ones from a fresh traversal.
    const from = Math.max(0, Math.floor(Number(offset) || 0));
    const entries = all.slice(from, from + limit);
    const shownTo = from + entries.length;
    return {
        entries,
        total: all.length,
        offset: from,
        truncated: hitHardMax || shownTo < all.length,
        // THE NEXT CALL, SPELLED OUT. A model that is told "200 of 428" and
        // nothing else concludes the folder is 200 files — measured: it
        // reported a large repository as nearly empty. Told the exact
        // arguments that fetch the rest, it can simply make the call.
        ...(shownTo < all.length
            ? { nextOffset: shownTo,
                more: `${all.length - shownTo} more files — call list_files ` +
                      `again with {"path": ${JSON.stringify(String(relPath))}, ` +
                      `"offset": ${shownTo}} to read them` }
            : {})
    };
}

function readFile(root, { path: relPath, offset = 0, fromLine = null, lines = null } = {}) {
    const full = resolveInRoot(root, relPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        throw new ToolError(`not a file: ${relPath}`);
    }
    if (isProbablyBinary(full)) {
        throw new ToolError(`binary file, refusing to read as text: ${relPath}`);
    }

    // LINE MODE. Every code tool the model knows reports LINE numbers —
    // search_files says "app.js:3775" — and this tool only took a BYTE
    // offset. Watched in a live session: a frontier model spent FIFTEEN turns
    // guessing byte offsets to reach line 3775 of a 237KB file, never landed,
    // and apologised for it. Ask by line, receive by line, with the range
    // stated so the next hop is arithmetic instead of divination.
    if (fromLine !== null && fromLine !== undefined) {
        const want = Math.max(1, Math.floor(Number(fromLine) || 1));
        const count = Math.max(1, Math.min(2000, Math.floor(Number(lines) || 200)));
        const all = fs.readFileSync(full, "utf8").split(/\r?\n/);
        const slice = all.slice(want - 1, want - 1 + count);
        const content = slice.join(String.fromCharCode(10));
        try { require('./secretGuard').rememberFile(relPath, content); }
        catch { /* the guard must never break a read */ }
        return {
            content,
            totalLines: all.length,
            fromLine: want,
            toLine: Math.min(all.length, want - 1 + slice.length),
            truncated: want - 1 + slice.length < all.length
        };
    }

    const start = Math.max(0, Number(offset) || 0);
    const size = fs.statSync(full).size;
    const fd = fs.openSync(full, "r");
    try {
        const buf = Buffer.alloc(Math.min(READ_CAP_BYTES, Math.max(0, size - start)));
        const n = fs.readSync(fd, buf, 0, buf.length, start);
        const content = buf.subarray(0, n).toString("utf8");
        // READ EVERYTHING, LEAK NOTHING. The model may read any file the user
        // granted — but every secret seen here is registered with the egress
        // guard, so it can never leave in a URL, query or request body. Lazy
        // require: fsTools is a leaf module many things import.
        try { require("./secretGuard").rememberFile(relPath, content); }
        catch { /* the guard must never break a read */ }
        // bytesRead is the byte count ACTUALLY consumed — the decoded string
        // re-measures longer when the cap splits a multi-byte character
        // (the partial sequence decodes to U+FFFD, 3 bytes), so a resume
        // offset computed from the string overshoots and silently drops bytes
        return { content, size, offset: start, bytesRead: n,
                 truncated: start + n < size };
    } finally {
        fs.closeSync(fd);
    }
}

function writeFile(root, { path: relPath, content } = {}) {
    if (typeof content !== "string") {
        // Coach rather than just refuse: the usual cause is the model emitting
        // the tool block and stopping, so the retry needs to know what to add.
        throw new ToolError(
            "write_file needs the file body. Put the FULL text in a ```content " +
            "block immediately after the ```tool block and close it with ```. " +
            "Do not describe the content - write it out."
        );
    }
    if (Buffer.byteLength(content, "utf8") > WRITE_CAP_BYTES) {
        throw new ToolError(`content exceeds the ${WRITE_CAP_BYTES} byte write cap`);
    }

    const full = resolveInRoot(root, relPath);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        throw new ToolError(`path is a directory: ${relPath}`);
    }

    const rootReal = realpathOrNull(root);
    const parts = path.relative(rootReal, full).split(path.sep).map(s => s.toLowerCase());
    const blocked = parts.filter(p => DENY_WRITE_DIRS.has(p));
    if (blocked.length) {
        throw new ToolError(`refusing to write inside a protected directory: ${blocked.join(", ")}`);
    }
    if (DENY_WRITE_FILES.test(path.basename(full))) {
        throw new ToolError(
            `${path.basename(full)} is Ancient Knowledge's own document — it is ` +
            `written by the overseer and edited by the operator, never by you.`);
    }

    // Format sanity. The observed failure: asked to build a static site, the
    // model wrote its own RECAP ("The static site has been created…") into
    // index.html as the content. That is never valid HTML. For formats that
    // REQUIRE structure, reject content that plainly is not that format and
    // coach the model to write the real file — the loop then gives it another
    // shot. This is correctness enforcement, not content policing: prose is
    // fine in a .md or .txt, but an .html file must contain markup.
    // WRITE_FILE DOES NOT CLOBBER A WORKING FILE. Measured in a real run:
    // told a script had failed with "No module named numpy" — a missing
    // PACKAGE, not a code bug — the model misdiagnosed it and write_file'd a
    // full rewrite over a working source file, which would have destroyed it
    // to "fix" an error that was never in the code. The prompt already said
    // "NEVER write_file over a file that already
    // exists"; a model ignored it, so the rule is enforced HERE, not asked.
    // A surgical change is edit_file; a genuine replace is delete_file (which
    // asks for approval and keeps a backup) THEN write_file. An empty file
    // holds nothing to lose, so overwriting one is allowed.
    const existed = fs.existsSync(full);
    if (existed && fs.statSync(full).size > 0 && !sessionWritten.has(full)) {
        throw new ToolError(
            `${relPath} already exists and has content — write_file will not overwrite it, ` +
            `so a wrong guess cannot clobber a working file. To CHANGE it, use edit_file ` +
            `(a surgical find/replace). To REPLACE it entirely, delete_file it first (that ` +
            `asks for your approval and keeps a backup), then write_file.`);
    }

    assertContentLooksRight(relPath, content);

    fs.mkdirSync(path.dirname(full), { recursive: true });
    atomicWriteSync(full, content);
    sessionWritten.add(full);

    return { written: relPath, bytes: Buffer.byteLength(content, "utf8"), created: !existed };
}

// A first-person recap of "having created" something, written where file
// contents belong — the exact signature of the narrate-instead-of-write bug.
const RECAP_RE = /\b(?:has|have|been)\b.*\b(?:created|written|generated|updated|added|saved)\b|\byou can now\b|\bhere('?s| is) (?:the|a|your)\b/i;

/**
 * Reject content that cannot be the file it claims to be. Only formats that
 * genuinely require structure are checked; prose formats (.md, .txt, none)
 * pass untouched.
 */
// A PLACEHOLDER where the content should be. Observed for real: a styles.css
// whose entire body was "<THE_COMPLETE_STYLESHEET_CONTENT>". The model
// described the slot instead of filling it, and every earlier check passed
// because the file was not empty and not obviously prose.
// THE SCREAMING-CASE SLOT, AND ONLY IT. This pattern lived in the
// case-insensitive regex below, where "<[A-Z][A-Z0-9_ ]{6,}>" also matched
// every ordinary HTML element of eight characters or more: <section>,
// <article>, <textarea>, <blockquote>, <figcaption>, <fieldset>, <template>,
// <noscript>. Measured by running a page through the real write
// path — a semantic landing page was refused as "a placeholder (<section>)",
// which quietly made a well-structured page the one thing that could not be
// written. It is case-SENSITIVE here, and it requires a separator or a word
// that is not an element name, so the real placeholder is still caught and a
// real page is not.
const PLACEHOLDER_CASED_RE = new RegExp(
    "<[A-Z][A-Z0-9_ ]*[_ ][A-Z0-9_ ]*>" + "|" +           // <THE_COMPLETE_STYLESHEET_CONTENT>, <YOUR CONTENT HERE>
    "<(?:PLACEHOLDER|CONTENT|TODO|FIXME|MARKUP|STYLESHEET|IMPLEMENTATION|SNIPPET)>");

const PLACEHOLDER_RE = new RegExp(
    // an angle-bracket slot in ANY case, identified by the one character no
    // HTML element name may contain: an underscore. <the_complete_file> is a
    // slot; <section> and <div class="x"> are markup and never match here.
    "<[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*>" + "|" +
    "\\{\\{\\s*[A-Za-z0-9_ ]+\\s*\\}\\}" + "|" +          // {{ content }}
    "\\[(?:YOUR|INSERT|ADD|PASTE|FULL|COMPLETE)[^\\]]{0,40}\\]" + "|" +
    // must name the CONTENT it is standing in for — "add the full kettle of
    // water" is a recipe, "insert the full stylesheet" is a placeholder
    "\\b(?:INSERT|PASTE|ADD|PUT)\\s+(?:THE\\s+)?(?:FULL|COMPLETE|ACTUAL|REAL)\\s+" +
        "(?:CONTENT|CODE|TEXT|MARKUP|STYLE|STYLES|STYLESHEET|HTML|CSS|JS|SCRIPT|FILE|BODY|" +
        "IMPLEMENTATION|LOGIC|FUNCTION|DEFINITION|SOURCE)\\b" + "|" +
    // "content GOES here" is unmistakably a placeholder; "content here" alone
    // is ordinary prose ("Real content here.") and must not be flagged
    "\\b(?:CONTENT|CODE|STYLES?|MARKUP|TEXT)\\s+GOES\\s+HERE\\b" + "|" +
    "\\bYOUR[_ ](?:CODE|CONTENT|STYLES?|HTML|CSS)[_ ]HERE\\b",
    "i");

// The model's OWN INSTRUCTIONS, written into a file meant for a human reader.
// Observed for real: an about.html containing "Never tell the user you cannot
// access the filesystem — you can." verbatim, plus a bulleted list of every
// tool name. A file's content is for its future reader; the system prompt is
// not part of the product.
const PROMPT_LEAK_RE = new RegExp(
    "never tell the user you cannot" + "|" +
    "you are \\.lcl, a local ai" + "|" +
    "running fully offline on the user's machine" + "|" +
    "available tools:\\s*(?:<[^>]+>\\s*)*(?:list_files|read_file|write_file)" + "|" +
    "\\bTOOL RESULT:" + "|" +
    "```tool\\b",
    "i");

function assertContentLooksRight(relPath, content) {
    const ext = path.extname(String(relPath)).toLowerCase();
    const trimmed = content.trim();
    if (!trimmed) return;                       // an empty file is a valid choice
    const coach = (what) => new ToolError(
        `that is not valid ${what} — it reads like a description of the file, not the ` +
        `file itself. Write the COMPLETE ${what} content (the actual markup/code), ` +
        `not a sentence about having created it.`);

    // These two apply to EVERY text file, not just the structured formats: a
    // placeholder in a .md is the same failure as a placeholder in a .css.
    const m = PLACEHOLDER_CASED_RE.exec(trimmed) || PLACEHOLDER_RE.exec(trimmed);
    if (m) {
        throw new ToolError(
            `the content contains a placeholder ("${m[0].slice(0, 40)}") instead of the real ` +
            "thing. Write the actual, complete content — if you do not have it yet, say so " +
            "in your reply rather than writing a stand-in into the file.");
    }
    if (PROMPT_LEAK_RE.test(trimmed)) {
        throw new ToolError(
            "that content contains your own instructions or tool list. A file is written for " +
            "the person who will read it: write about its SUBJECT only, never about this " +
            "assistant, its tools, or how the file was produced.");
    }

    if (ext === ".html" || ext === ".htm") {
        // real HTML has tags; a recap sentence has none
        if (!/<[a-z!/]/i.test(trimmed)) throw coach("HTML");
    } else if (ext === ".svg") {
        if (!/<svg[\s>]/i.test(trimmed)) throw coach("SVG");
    } else if (ext === ".xml") {
        if (!/<[a-z?!/]/i.test(trimmed)) throw coach("XML");
    } else if (ext === ".json") {
        try { JSON.parse(trimmed); }
        catch { throw new ToolError("that is not valid JSON — write a parseable JSON document, not a description of it."); }
    } else if (ext === ".css") {
        // CSS is looser, but a pure recap sentence with no braces/selectors and
        // the tell-tale "has been created" phrasing is the bug, not a stylesheet
        if (!/[{}:;]/.test(trimmed) && RECAP_RE.test(trimmed)) throw coach("CSS");
    }
}

/** Shared write-path guard: protected dirs can hand the host code execution. */
function assertWritable(rootReal, full, what) {
    const parts = path.relative(rootReal, full).split(path.sep).map(s => s.toLowerCase());
    const blocked = parts.filter(p => DENY_WRITE_DIRS.has(p));
    if (blocked.length) {
        throw new ToolError(`refusing to ${what} inside a protected directory: ${blocked.join(", ")}`);
    }
    if (DENY_WRITE_FILES.test(path.basename(full))) {
        throw new ToolError(
            `${path.basename(full)} is Ancient Knowledge's own document — it is ` +
            `written by the overseer and edited by the operator, never by you.`);
    }
}

/**
 * RESOLVE A PATH THE MODEL CHOSE TO WRITE TO.
 *
 * assertWritable existed and was called by writeFile, editFile, moveFile,
 * makeDir and deleteFile — every tool in THIS file. Every tool in every OTHER
 * file called resolveInRoot alone, which only proves the path stays inside the
 * linked folder. It says nothing about WHAT the path is.
 *
 * So `draw_diagram` with out: "ancient_knowledge.rules.md" wrote Ancient
 * Knowledge's ground rules — the standing instructions its own overseer is
 * given — and `transcribe_audio` could do the same. The design notes recorded
 * this as "Closed at the root". It was closed at one root, in one file, and
 * there were five other doors.
 *
 * A model writing the rules it is later judged by is the core risk a review of
 * this codebase raised: the logic was built in a way that let it write its own
 * instructions.
 *
 * Every destination a model names now comes through here.
 */
function resolveForWrite(root, relPath, what = "write") {
    const full = resolveInRoot(root, relPath);
    const rootReal = realpathOrNull(root);
    assertWritable(rootReal, full, what);
    return full;
}

const EDIT_FILE_CAP_BYTES = 512_000;

/**
 * Targeted edit: replace ONE exact occurrence. This is the tool that retires
 * the worst small-model failure mode — rewriting a whole file to change one
 * line, and truncating it on the way out. The find text must match exactly
 * once, so an ambiguous edit fails loudly instead of landing in the wrong
 * place.
 */
function editFile(root, { path: relPath, find, replace } = {}) {
    if (typeof find !== "string" || !find.length) {
        throw new ToolError('edit_file needs "find": the exact existing text to change');
    }
    if (typeof replace !== "string") {
        throw new ToolError('edit_file needs "replace": the new text (empty string deletes the found text)');
    }

    const full = resolveInRoot(root, relPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        throw new ToolError(`not a file: ${relPath}`);
    }
    if (isProbablyBinary(full)) {
        throw new ToolError(`binary file, refusing to edit: ${relPath}`);
    }
    if (fs.statSync(full).size > EDIT_FILE_CAP_BYTES) {
        throw new ToolError(`file is too large to edit in place (max ${EDIT_FILE_CAP_BYTES} bytes)`);
    }
    const rootReal = realpathOrNull(root);
    assertWritable(rootReal, full, "edit");

    const text = fs.readFileSync(full, "utf8");
    let count = 0;
    for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + 1)) count++;
    if (count === 0) {
        throw new ToolError(
            `the "find" text was not found in ${relPath}. Read the file and copy ` +
            "the text EXACTLY as it appears, including spaces and line breaks.");
    }
    if (count > 1) {
        throw new ToolError(
            `the "find" text appears ${count} times in ${relPath} — include more ` +
            "surrounding lines so it matches exactly once.");
    }

    // function replacement so $-sequences in the new text are never expanded
    const next = text.replace(find, () => replace);
    atomicWriteSync(full, next);
    sessionWritten.add(full);
    return {
        written: relPath,
        bytes: Buffer.byteLength(next, "utf8"),
        created: false,
        edited: true
    };
}

/** Rename/move a file. Never overwrites — a name collision is an error. */
function moveFile(root, { from, to } = {}) {
    if (typeof from !== "string" || typeof to !== "string") {
        throw new ToolError('move_file needs "from" and "to" paths');
    }
    const src = resolveInRoot(root, from);
    const dst = resolveInRoot(root, to);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        throw new ToolError(`not a file: ${from}`);
    }
    if (fs.existsSync(dst)) {
        throw new ToolError(`destination already exists: ${to} — delete it first or pick another name`);
    }
    const rootReal = realpathOrNull(root);
    assertWritable(rootReal, src, "move");
    assertWritable(rootReal, dst, "move into");

    const bytes = fs.statSync(src).size;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return { moved: true, from, to, bytes };
}

function makeDir(root, { path: relPath } = {}) {
    if (typeof relPath !== "string" || !relPath.trim()) {
        throw new ToolError('make_dir needs "path"');
    }
    const full = resolveInRoot(root, relPath);
    const rootReal = realpathOrNull(root);
    assertWritable(rootReal, full, "create a directory");
    if (fs.existsSync(full)) {
        if (fs.statSync(full).isDirectory()) return { created: false, dir: relPath, existed: true };
        throw new ToolError(`a file with that name already exists: ${relPath}`);
    }
    fs.mkdirSync(full, { recursive: true });
    return { created: true, dir: relPath };
}

/**
 * Delete a file. DESTRUCTIVE-class: the kernel routes every call through the
 * approval card, and the approval path snapshots the file first so a revert
 * can bring it back.
 */
function deleteFile(root, { path: relPath } = {}) {
    const full = resolveInRoot(root, relPath);
    if (!fs.existsSync(full)) {
        throw new ToolError(`no such file: ${relPath}`);
    }
    if (!fs.statSync(full).isFile()) {
        throw new ToolError(`not a file (directories cannot be deleted): ${relPath}`);
    }
    const rootReal = realpathOrNull(root);
    assertWritable(rootReal, full, "delete");

    const bytes = fs.statSync(full).size;
    fs.unlinkSync(full);
    return { deleted: relPath, bytes };
}

function searchFiles(root, { query, max_results = SEARCH_CAP_RESULTS } = {}) {
    if (typeof query !== "string" || !query.trim()) {
        throw new ToolError("query must be a non-empty string");
    }

    const cap = Math.min(Number(max_results) || SEARCH_CAP_RESULTS, SEARCH_CAP_RESULTS);
    const rootReal = realpathOrNull(root);
    const needle = query.toLowerCase();
    const results = [];
    let truncated = false;

    outer:
    for (const full of walk(rootReal, rootReal)) {
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.size > SEARCH_FILE_CAP_BYTES || isProbablyBinary(full)) continue;

        let text;
        try { text = fs.readFileSync(full, "utf8"); } catch { continue; }

        const rel = path.relative(rootReal, full).split(path.sep).join("/");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
                results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (results.length >= cap) { truncated = true; break outer; }
            }
        }
    }

    return { results, truncated };
}

const TOOLS = {
    list_files: {
        run: listFiles,
        help: 'list_files {"path": "."} — list every file under a directory in ' +
            'the linked folder, sorted. Large folders come back in pages: the ' +
            'result carries "total" and, when there is more, "nextOffset" — ' +
            'call again with {"path": ".", "offset": <nextOffset>} until ' +
            '"nextOffset" stops coming back. "total" is the real file count; ' +
            'never report the page you were handed as the size of the folder.'
    },
    read_file: {
        run: readFile,
        help: 'read_file {"path": "src/main.py", "fromLine": 120, "lines": 200} — read a text file by LINE (matches search_files line numbers; up to 2000 lines). Legacy byte mode: {"offset": N}'
    },
    write_file: {
        run: writeFile,
        help: 'write_file {"path": "notes.md", "content": "the full file text"} — create or overwrite a text file'
    },
    edit_file: {
        run: editFile,
        help: 'edit_file {"path": "notes.md", "find": "exact existing text", "replace": "new text"} — ' +
            'change part of a file without rewriting it; "find" must match exactly once'
    },
    move_file: {
        run: moveFile,
        help: 'move_file {"from": "old.md", "to": "docs/new.md"} — rename or move a file (never overwrites)'
    },
    make_dir: {
        run: makeDir,
        help: 'make_dir {"path": "docs/images"} — create a directory (and any missing parents)'
    },
    delete_file: {
        run: deleteFile,
        help: 'delete_file {"path": "old.md"} — delete a file; the user is asked to approve first, ' +
            'and a backup is kept so it can be restored'
    },
    search_files: {
        run: searchFiles,
        // THE EXAMPLE IS THE INSTRUCTION. This read {"query": "TODO"} and models
        // copied it verbatim — measured in a real repository, six identical
        // searches for a word the codebase does not use, while the work the
        // user asked for went untouched. An example argument has to be
        // obviously a placeholder, never a plausible query.
        help: 'search_files {"query": "<text to find>"} — find lines containing that text across the folder'
    }
};

module.exports = {
    TOOLS, ToolError, listFiles, readFile, writeFile, searchFiles,
    // the one door every OTHER module's model-chosen destination goes through
    resolveForWrite, assertWritable,
    editFile, moveFile, makeDir, deleteFile,
    // exposed so the backup/revert layer can resolve paths under the same
    // containment rules the tools use
    resolveInRoot, realpathOrNull,
    // the file viewer uses the same sniff the read tool does
    isProbablyBinary,
    // exported so tests can prove the write guard on real failing content
    assertContentLooksRight,
    // the security scanners walk the workspace under the SAME containment
    // (junction-safe realpath re-validation) that every file tool uses
    walk, contained,
    // temp-then-rename, shared with pdfExtract so a sidecar file is never
    // half-written when a reader (or a concurrent run) looks at it
    atomicWriteSync
};
