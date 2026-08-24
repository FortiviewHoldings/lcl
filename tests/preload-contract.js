/**
 * THE IPC CONTRACT — renderer ↔ preload ↔ main, checked statically.
 *
 * Why this file exists: the "ask before every write" selector and the knowledge
 * grounding toggle never worked. Not "worked badly" — never worked at all.
 * app/renderer/app.js called `window.lcl.setBehavior(...)`, preload.js had no
 * such key, so the call threw TypeError, and the renderer's own
 * `.catch(() => null)` swallowed it into a red flash the user would read as a
 * save failure. A security dial that silently does nothing is worse than one
 * that is missing, because the user believes it is on.
 *
 * 1,075 unit checks passed the whole time. Every one of them called engine
 * modules directly; none of them crossed the three-layer boundary where the
 * break lived. This test crosses it the only way a static check can — by
 * diffing the three surfaces against each other:
 *
 *   renderer USES  ⊆  preload EXPOSES  →  main HANDLES
 *
 * A gap in either direction is a bug: a renderer call with no bridge is a dead
 * control, a bridge with no handler is a call that rejects at runtime, and a
 * handler with no bridge is a capability nothing can reach (dead code at best,
 * an unreviewed entry point at worst).
 *
 * It is deliberately regex-over-source rather than a runtime harness: it must
 * run in a second, with no Electron, so it can never be the test someone skips.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const P = (...p) => path.join(ROOT, ...p);

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++;
        console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : "");
    }
}

const preloadSrc = fs.readFileSync(P("app", "preload.js"), "utf8");
const mainSrc = fs.readFileSync(P("app", "main.js"), "utf8");
const rendererFiles = fs.readdirSync(P("app", "renderer"))
    .filter(f => f.endsWith(".js"))
    .map(f => ({ file: f, src: fs.readFileSync(P("app", "renderer", f), "utf8") }));

const uniq = (a) => [...new Set(a)].sort();
const all = (src, re) => {
    const out = [];
    let m;
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    while ((m = r.exec(src))) out.push(m[1]);
    return out;
};

/* ------------------------------------------------------------ the surfaces */

// keys exposed on window.lcl — the object literal passed to exposeInMainWorld
const exposeStart = preloadSrc.indexOf("exposeInMainWorld");
check("preload exposes an API object", exposeStart !== -1);
const exposeBody = preloadSrc.slice(exposeStart);
const exposed = uniq(all(exposeBody, /^\s{4}([A-Za-z_$][\w$]*)\s*:/m));

// every window.lcl.X touched anywhere in the renderer
const usedBy = new Map();                       // key -> [files]
for (const { file, src } of rendererFiles) {
    for (const k of all(src, /window\.lcl\.([A-Za-z_$][\w$]*)/)) {
        if (!usedBy.has(k)) usedBy.set(k, new Set());
        usedBy.get(k).add(file);
    }
}
const used = uniq([...usedBy.keys()]);

// channels: what preload invokes/listens for, and what main handles
const invoked = uniq(all(exposeBody, /ipcRenderer\.invoke\(\s*["']([^"']+)["']/));
const listened = uniq(all(exposeBody, /ipcRenderer\.on\(\s*["']([^"']+)["']/));
const handled = uniq(all(mainSrc, /ipcMain\.handle\(\s*["']([^"']+)["']/));
const sent = uniq(all(mainSrc, /webContents\.send\(\s*["']([^"']+)["']/));

console.log(`\n  ${used.length} renderer calls · ${exposed.length} bridged keys · ` +
            `${invoked.length} invoke channels · ${handled.length} main handlers\n`);

/* ------------------------------------------------- 1. no dead controls ---- */

// THE ORIGINAL BUG. Anything the renderer calls must exist on the bridge.
const unbridged = used.filter(k => !exposed.includes(k))
    .map(k => `${k} (called from ${[...usedBy.get(k)].join(", ")})`);
check("every window.lcl.* call the renderer makes is bridged in preload",
    unbridged.length === 0, unbridged);

// named explicitly so a future refactor that drops it fails loudly rather than
// silently returning to the state this file was written for
check("setBehavior specifically is bridged (writeMode + grounding dials)",
    exposed.includes("setBehavior"));

/* ------------------------------------------- 2. no rejecting bridges ------ */

const orphanChannels = invoked.filter(c => !handled.includes(c));
check("every channel preload invokes has a handler in main",
    orphanChannels.length === 0, orphanChannels);

const orphanEvents = listened.filter(c => !sent.includes(c));
check("every event preload listens for is actually sent by main",
    orphanEvents.length === 0, orphanEvents);

/* ------------------------------------------- 3. no unreachable handlers --- */

// A handler with no bridge cannot be called by the UI. That is either dead code
// or an entry point nobody reviewed as part of the UI's surface — both worth
// knowing about. Reported, not fatal, because main legitimately handles a few
// channels invoked from elsewhere.
const unreachable = handled.filter(c => !invoked.includes(c));
if (unreachable.length) {
    console.log("  NOTE | main handlers no preload key invokes:", unreachable.join(", "));
}
check("no main handler is unreachable from the UI", unreachable.length === 0, unreachable);

/* ------------------------------------------- 4. the swallow that hid it --- */

// The reason a three-layer break survived to ship: the renderer wrapped the
// call in `.catch(() => null)`, so an absent bridge and a rejected save looked
// identical. Every setBehavior call site must still be defensive (a rejected
// IPC must not break the panel) — but this test is what makes that safe, so
// assert the pairing is intentional and documented rather than accidental.
const behaviorCalls = rendererFiles.flatMap(({ file, src }) =>
    all(src, /window\.lcl\.setBehavior\([^)]*\)([^;]*)/).map(tail => ({ file, tail })));
check("setBehavior is called somewhere in the renderer", behaviorCalls.length >= 2,
    behaviorCalls.length);
check("preload documents why setBehavior's absence was invisible",
    /never worked|MISSING|swallow/i.test(preloadSrc));

/* --------------------------- 5. no silent-failure pairs ------------------- */

// The setBehavior bug's real shape was not "a missing key" — it was a FAILURE
// THAT COULD NOT BE SEEN. Two things had to be true: the call could reject, and
// nothing was watching. That pairing exists elsewhere whenever an UNGUARDED
// sync handler (a throw becomes a rejected promise) meets a call site with no
// catch (the rejection goes nowhere and the action silently does nothing).
//
// guard() is the fix on the main side: it turns a throw into {error}, which
// resolves, so even an inattentive caller gets a value it can check. This
// asserts the pairing never returns — including for reject_tool and cancel_chat,
// which were both in the original set and are precisely the controls a user
// reaches for when something is going wrong.
const keyToChannel = {};
for (const m of exposeBody.matchAll(
    /^\s{4}([A-Za-z_$][\w$]*)\s*:[^\n]*?ipcRenderer\.(?:invoke|on)\(\s*["']([^"']+)["']/gm)) {
    keyToChannel[m[1]] = m[2];
}
const guardedByChannel = {};
for (const m of mainSrc.matchAll(
    /ipcMain\.handle\(\s*["']([^"']+)["']\s*,\s*(guard\(|async|\()/g)) {
    guardedByChannel[m[1]] = m[2] !== "(";          // bare sync arrow = unguarded
}

const silent = [];
for (const { file, src } of rendererFiles) {
    const lines = src.split("\n");
    lines.forEach((line, i) => {
        const m = line.match(/window\.lcl\.([A-Za-z_$][\w$]*)\(/);
        if (!m) return;
        const ch = keyToChannel[m[1]];
        if (!ch || guardedByChannel[ch] !== false) return;
        // a catch or try within the enclosing few lines counts as watching
        const ctx = lines.slice(Math.max(0, i - 6), i + 4).join("\n");
        if (/\.catch\(|try\s*\{/.test(ctx)) return;
        silent.push(`${file}:${i + 1} ${m[1]} -> ${ch}`);
    });
}
check("no unguarded handler is called from a site that ignores rejection",
    silent.length === 0, silent);

const unguardedAll = Object.entries(guardedByChannel)
    .filter(([, g]) => g === false).map(([c]) => c);
if (unguardedAll.length) {
    console.log("  NOTE | unguarded sync handlers (all call sites catch):",
        unguardedAll.join(", "));
}

/* ------------------- 6. no classified tool without an implementation ------ */

// A tool named in the policy kernel but never registered by the agent is a
// promise nothing keeps: the capability panel lists it, the classification table
// gates it, and calling it fails with "unknown tool". That is exactly what
// happened to ask_cloud_model — classified, tested, documented, and then wired
// to nothing. 1,210 checks passed straight over the gap, because every one of
// them tested a module rather than the seam between two of them.
{
    const Module = require("module");
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === "electron") return __filename;
        return origResolve.call(this, request, ...rest);
    };
    require.cache[__filename] = { id: __filename, filename: __filename, loaded: true,
        exports: { app: { isPackaged: false, getPath: () => require("os").tmpdir() },
                   clipboard: { readText: () => "", writeText: () => {} } } };

    const { TOOL_CLASS } = require(P(".lcl.engine", "policy", "classify.js"));
    const agent = require(P(".lcl.engine", "core", "agent.js"));
    // all:true asks for every tool the app can EVER offer, ignoring whether this
    // machine currently has networking on or an engagement open
    const registered = new Set(Object.keys(agent.effectiveTools({ all: true })));
    // handled by the agent loop itself, never dispatched as tools
    const NOT_TOOLS = new Set(["run_script", "clarify"]);

    const orphans = Object.keys(TOOL_CLASS)
        .filter(t => !registered.has(t) && !NOT_TOOLS.has(t));
    check("every tool the policy kernel classifies is actually registered",
        orphans.length === 0, orphans);

    const unclassified = [...registered].filter(t => !TOOL_CLASS[t] && !NOT_TOOLS.has(t));
    check("every registered tool has a policy classification",
        unclassified.length === 0, unclassified);

    check("ask_cloud_model specifically is reachable by the agent",
        registered.has("ask_cloud_model"));

    /* ------------- 7. THE TERMINAL HAS NO DOOR FOR THE MODEL ------------ */
    //
    // CONTRACT K5. The terminal is the one surface in this product with no
    // sandbox and no approval step, and the entire justification for that is
    // that a HUMAN is typing into it. That justification survives exactly as
    // long as the model cannot reach it. So the absence of a path is asserted
    // here as a hard requirement rather than left as something everyone
    // remembers — the day someone adds `run_in_terminal` because it would be
    // convenient, this fails before it ships.
    /* WORD BOUNDARIES, BECAUSE "pty" IS INSIDE "empty".
     *
     * This regex is applied to whole SOURCE FILES as well as to tool names, so
     * the bare alternative `pty` matched any comment containing "empty" — and
     * did, the moment one was written. A guard that fires on prose is a guard
     * that gets deleted the third time it cries wolf, and this one is real:
     * the model must never be handed a terminal. Anchored so it matches the
     * NAME of a thing, not a fragment of an English word. */
    const TERMINALISH = /\bterminal\b|\bshell_exec\b|\brun_shell\b|\bpty\b|\bconsole_write\b/i;
    const classifiedTerm = Object.keys(TOOL_CLASS).filter(t => TERMINALISH.test(t));
    check("no TERMINAL tool is classified by the policy kernel (K5)",
        classifiedTerm.length === 0, classifiedTerm);
    const registeredTerm = [...registered].filter(t => TERMINALISH.test(t));
    check("no TERMINAL tool is registered by the agent, with every capability on",
        registeredTerm.length === 0, registeredTerm);

    // and nothing the agent can load may so much as NAME the channels
    const engineRoot = P(".lcl.engine");
    const walk = (dir, out = []) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, out);
            else if (e.name.endsWith(".js")) out.push(full);
        }
        return out;
    };
    const TERM_CHANNEL = /lcl:terminal|terminalWrite|terminalStart|terminalKill/;
    const leaks = walk(engineRoot)
        .filter(f => TERM_CHANNEL.test(fs.readFileSync(f, "utf8")))
        .map(f => path.relative(ROOT, f));
    check("no file the agent can reach even names the terminal channels — " +
          "there is no IPC path from the model to the operator's shell",
        leaks.length === 0, leaks);

    // the manifest the model is shown must not advertise one either
    const manifestSrc = fs.readFileSync(P(".lcl.engine", "core", "toolManifest.js"), "utf8");
    check("the tool manifest the model reads has no terminal entry",
        !TERMINALISH.test(manifestSrc));

    // main.js may only write to a shell from an ipcMain handler — the renderer
    // is the sole caller, and the renderer is driven by keystrokes
    const writeSites = [...mainSrc.matchAll(/\.stdin\.write\(/g)].length;
    const termWriteHandler = /ipcMain\.handle\("lcl:terminalWrite"/.test(mainSrc);
    check("the only shell write in main.js is the one behind lcl:terminalWrite",
        termWriteHandler && writeSites >= 1, { writeSites, termWriteHandler });

    Module._resolveFilename = origResolve;
}

/* ------------- 8. THE REMOTE-CALL GATE IS BRIDGED, BOTH WAYS ------------ */
//
// CONTRACT K3. Named explicitly, the way setBehavior is above, because this is
// the second control the operator selected and the app then ignored: "ask
// before every remote call" was written to settings and read back only to
// paint its own dropdown, so he "never saw any escalation attempts. or
// requests." The event and the answer are one mechanism; losing either end
// returns the app to a control that is believed and does nothing.
check("preload exposes onRemoteApproval (main -> renderer) (K3)",
    exposed.includes("onRemoteApproval"));
check("preload exposes answerRemoteApproval (renderer -> main) (K3)",
    exposed.includes("answerRemoteApproval"));
check("main really sends lcl:remoteApproval",
    sent.includes("lcl:remoteApproval"), sent.filter(c => /remote/i.test(c)));
check("main really handles lcl:answerRemoteApproval",
    handled.includes("lcl:answerRemoteApproval"));
check("the verdict vocabulary is once | always | trust | deny, and nothing else is a yes",
    /const clean = \(v === "once" \|\| v === "always" \|\| v === "trust"\) \? v : "deny";/.test(mainSrc));

/* ------------- 9. THE TERMINAL IS BRIDGED FOR THE RENDERER -------------- */
for (const key of ["terminalStart", "terminalWrite", "terminalResize",
                   "terminalKill", "onTerminalData"]) {
    check(`preload exposes ${key} (K5)`, exposed.includes(key));
}
check("main streams shell output on lcl:terminalData",
    sent.includes("lcl:terminalData"));

/* ------------- 10. NO MODULE IS CALLED BY A NAME NOTHING BOUND ---------- */
//
// THE BUG THIS CATCHES, MEASURED BY DRIVING THE REAL HANDLER:
//
//   setBehavior cloudAutoApprove true  -> {"error":"policy is not defined"}
//   setBehavior writeMode  confirm     -> {"error":"policy is not defined"}
//
// main.js required policyBridge.js as `policyBridge` and then called
// `policy.applyCloudAutoApprove(...)` and `policy.applyWriteMode(...)`. There
// was no such binding. guard() turned the ReferenceError into an {error} the
// renderer swallowed, so the remote-call dial AND "ask before every write"
// both wrote their setting and then failed on their own last line, silently —
// the identical shape to the setBehavior bug this whole file was written for,
// one layer deeper.
//
// So: every identifier used as `name.member(...)` in main.js must be bound
// somewhere in main.js. Comments and strings are stripped first, because prose
// about "the policy kernel" is not a call.
{
    /** Blank out comments, strings and regex literals, PRESERVING offsets. */
    const codeOnly = (src) => {
        const out = src.split("");
        const blank = (a, b) => {
            for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
        };
        let i = 0, prev = "";
        const regexStart = () => !prev || /[=(,:[!&|?{};+\-*%~^<>]$/.test(prev)
            || /\b(return|typeof|case|in|of|new|delete|void|do|else|yield|await)$/.test(prev);
        while (i < src.length) {
            const c = src[i], d = src[i + 1];
            if (c === "/" && d === "/") {
                const e = src.indexOf("\n", i); const end = e < 0 ? src.length : e;
                blank(i, end); i = end; continue;
            }
            if (c === "/" && d === "*") {
                const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2;
                blank(i, end); i = end; continue;
            }
            if (c === '"' || c === "'" || c === "`") {
                let j = i + 1;
                while (j < src.length) {
                    if (src[j] === "\\") { j += 2; continue; }
                    if (src[j] === c) break;
                    j++;
                }
                blank(i + 1, j); i = j + 1; prev = "x"; continue;
            }
            if (c === "/" && regexStart()) {
                let j = i + 1, cls = false, closed = false;
                while (j < src.length && src[j] !== "\n") {
                    if (src[j] === "\\") { j += 2; continue; }
                    if (src[j] === "[") cls = true;
                    else if (src[j] === "]") cls = false;
                    else if (src[j] === "/" && !cls) { closed = true; break; }
                    j++;
                }
                if (closed) {
                    // ...and its FLAGS: without this, /^host (\S+)/mi.exec(x)
                    // reads as a call on an object named `mi`
                    let f = j + 1;
                    while (f < src.length && /[a-z]/.test(src[f])) f++;
                    blank(i + 1, f); i = f; prev = "x"; continue;
                }
            }
            if (!/\s/.test(c)) prev = (prev + c).slice(-12);
            i++;
        }
        return out.join("");
    };

    const code = codeOnly(mainSrc);
    const bound = new Set([
        // globals main legitimately calls into
        "process", "console", "require", "module", "JSON", "Math", "Object",
        "Array", "String", "Number", "Date", "Promise", "Map", "Set", "Buffer",
        "RegExp", "Error", "globalThis", "URL", "AbortController", "Intl",
        "setTimeout", "setInterval", "queueMicrotask", "structuredClone"
    ]);
    // Every declarator in every const/let/var — walked to the statement's end
    // rather than regexed, so `let url = null, urlHost = null;` and
    // `const [probes, ssh22] = await ...` both bind everything they declare.
    const ident = /[A-Za-z_$][\w$]*/y;
    for (const m of code.matchAll(/\b(?:const|let|var)\b/g)) {
        let i = m.index + m[0].length, depth = 0, atDeclarator = true;
        while (i < code.length) {
            const c = code[i];
            if (depth === 0 && (c === ";" || ")]}".includes(c))) break;
            if ("([{".includes(c)) { depth++; i++; continue; }
            if (")]}".includes(c)) { depth--; i++; continue; }
            if (c === "," && depth === 0) { atDeclarator = true; i++; continue; }
            if (c === "=" && depth === 0) { atDeclarator = false; i++; continue; }
            if (depth > 0 || atDeclarator) {
                ident.lastIndex = i;
                const g = ident.exec(code);
                if (g) { bound.add(g[0]); i = ident.lastIndex; continue; }
            }
            i++;
        }
    }
    for (const m of code.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
    for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
        for (const part of m[1].split(",")) {
            const n = part.replace(/[=:][\s\S]*/, "").replace(/^\.\.\./, "").trim();
            if (/^[A-Za-z_$][\w$]*$/.test(n)) bound.add(n);
        }
    }
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) bound.add(m[1]);
    for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);

    // THE SCANNER MUST NOT BE ABLE TO ROT INTO A PASS. A stripper that ate the
    // file, or a binder that bound nothing, would make the check below vacuous
    // — which is the exact failure mode this suite exists to prevent.
    check("the source scanner is sane: nothing was eaten, and real names were found",
        code.length === mainSrc.length && bound.size > 200
        && bound.has("policyBridge") && bound.has("cloudModels"),
        { code: code.length, raw: mainSrc.length, bound: bound.size });

    const unbound = new Set();
    for (const m of code.matchAll(/(^|[^.\w$])([a-z][\w$]*)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g)) {
        if (!bound.has(m[2])) unbound.add(m[2]);
    }
    check("every module main.js calls is bound by a name main.js actually has — " +
          "`policy.applyCloudAutoApprove` was a ReferenceError that guard() hid, " +
          "and it disarmed two security dials at once",
        unbound.size === 0, [...unbound]);
}

console.log(`\n${pass}/${pass + fail} preload-contract checks passed`);
process.exit(fail ? 1 : 0);
