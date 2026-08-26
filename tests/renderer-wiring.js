/**
 * DOES THE RENDERER REFER TO THINGS THAT EXIST?
 *
 * app/renderer/app.js is one long script against one long HTML document, with
 * no module system and no compiler between them. Two whole classes of bug ship
 * silently out of that arrangement, and both of them have:
 *
 *   1. $("some-id") where index.html has no such id. $ returns null and the
 *      very next property access throws — but only when the user reaches that
 *      feature, which is usually after the release.
 *
 *   2. a function called and never defined. renderCapabilityPanel was called
 *      seven times and defined zero times; every click on a capability panel
 *      would have thrown.
 *
 * Also checked here because they are the same shape of mistake:
 *
 *   3. data-action="..." in the markup with no entry in menuActions — a menu
 *      item that visibly does nothing. Jump to latest was reported as exactly
 *      this ("Jump to Latest has no functionality"), and it turned out to be a
 *      real handler with nothing to scroll to, which is a different bug — but
 *      only a check like this makes that distinction cheap to establish.
 *
 *   4. var(--token) in styles.css with no declaration. --fg, --dim and --card
 *      were all used and none existed, so those rules silently did nothing.
 *
 * This is a static check on purpose. Booting Electron to find a typo is a
 * ten-minute answer to a ten-millisecond question.
 */
const fs = require("fs");
const path = require("path");

const R = path.join(__dirname, "..", "app", "renderer");
const js = fs.readFileSync(path.join(R, "app.js"), "utf8");
const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
const css = fs.readFileSync(path.join(R, "styles.css"), "utf8");

/**
 * Code only, with comments and string bodies blanked out.
 *
 * This file's comments are English prose, and English is full of "word(" once
 * you count "(to find what to close)". A first pass reported forever(), stay()
 * and refusal() as undefined functions — every one of them a word inside a
 * sentence in this file's prose. Same for identifiers quoted inside strings.
 *
 * Blanking rather than deleting, so byte offsets still line up with the source
 * and anything reported can be found by searching for it.
 */
/**
 * Is the `/` about to be read the start of a regex literal, or a divide?
 *
 * Decided by what came immediately before it, which is the same heuristic every
 * hand-written JS scanner uses: after a value (identifier, ), ], number) a
 * slash divides; after an operator, a comma, an open bracket or a keyword it
 * opens a pattern.
 */
function startsRegex(before) {
    const t = before.replace(/\s+$/, "");
    if (!t) return true;
    const last = t[t.length - 1];
    if ("([{,;=:!&|?+-*%~^<>".includes(last)) return true;
    return /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(t);
}

/**
 * Only the last token before the slash decides, so only the tail is handed to
 * startsRegex. It used to be given the WHOLE 450 KB of output on every `/` in
 * the file, and .replace(/\s+$/) over that ran the scan in five seconds. The
 * walk back over whitespace is the same one startsRegex does, so the answer is
 * identical — a blanked comment before the slash is still skipped.
 */
function sigTail(out) {
    let e = out.length;
    while (e > 0 && /\s/.test(out[e - 1])) e--;
    return out.slice(Math.max(0, e - 48), e);
}

/**
 * A TEMPLATE'S ${...} IS CODE, AND IT IS SCANNED AS CODE.
 *
 * The first cut blanked everything between backticks, which is right for the
 * literal text and wrong for the substitutions — and it broke outright on a
 * NESTED template, because the inner backtick inside ${ } closed the outer
 * literal and the rest of the sentence spilled into the scan as identifiers.
 * Measured on `${a.open} open${a.contested ? ` (${a.contested} contested)` : ""}`,
 * which reported a free variable named `contested` that is a word in a label.
 *
 * Template text is blanked; ${ } is handed back to the code scanner, so calls
 * and variable reads inside a substitution are seen. The ${ and its matching }
 * are blanked in pairs so brace counting downstream stays balanced.
 */
function codeOnly(src) {
    const n = src.length;
    let out = "", i = 0;

    const scanTemplate = () => {
        out += "`"; i++;
        while (i < n) {
            const ch = src[i];
            if (ch === "\\") { out += "  "; i += 2; continue; }
            if (ch === "`") { out += "`"; i++; return; }
            if (ch === "$" && src[i + 1] === "{") { out += "  "; i += 2; scanCode(true); continue; }
            out += ch === "\n" ? "\n" : " "; i++;
        }
    };

    function scanCode(inSubstitution) {
        let depth = 0;
        while (i < n) {
            const c = src[i], d = src[i + 1];
            if (inSubstitution && c === "}" && depth === 0) { out += " "; i++; return; }
            if (c === "{") { depth++; out += c; i++; continue; }
            if (c === "}") { depth--; out += c; i++; continue; }
            if (c === "/" && d === "/") {
                while (i < n && src[i] !== "\n") { out += " "; i++; }
                continue;
            }
            if (c === "/" && d === "*") {
                out += "  "; i += 2;
                while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
                    out += src[i] === "\n" ? "\n" : " "; i++;
                }
                out += "  "; i += 2;
                continue;
            }
            if (c === "`") { scanTemplate(); continue; }
            if (c === '"' || c === "'") {
                const q = c;
                out += q; i++;
                while (i < n && src[i] !== q) {
                    if (src[i] === "\\") { out += "  "; i += 2; continue; }
                    out += src[i] === "\n" ? "\n" : " "; i++;
                }
                out += q; i++;
                continue;
            }
            if (c === "/" && startsRegex(sigTail(out))) {
                // A regex literal is a string as far as this scan is concerned.
                // /__([^_]+)__/ in the markdown parser was being read as calls to
                // __() and _(). Character classes may contain an unescaped /.
                out += " "; i++;
                let inClass = false;
                while (i < n) {
                    const ch = src[i];
                    if (ch === "\\") { out += "  "; i += 2; continue; }
                    if (ch === "[") inClass = true;
                    else if (ch === "]") inClass = false;
                    else if (ch === "/" && !inClass) break;
                    else if (ch === "\n") break;             // unterminated: bail
                    out += " "; i++;
                }
                out += " "; i++;
                while (i < n && /[gimsuyd]/.test(src[i])) { out += " "; i++; }
                continue;
            }
            out += c; i++;
        }
    }

    scanCode(false);
    return out;
}

const code = codeOnly(js);

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++;
        console.log("FAIL |", name);
        if (detail && detail.length) {
            for (const d of detail.slice(0, 30)) console.log("     |   " + d);
            if (detail.length > 30) console.log(`     |   …and ${detail.length - 30} more`);
        }
    }
}

/* ---------------------------------------------------------------- ids ---- */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// ids the renderer creates at runtime rather than finding in the document
const CREATED_AT_RUNTIME = new Set([]);

const wanted = [...js.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]);
const missingIds = [...new Set(wanted)]
    .filter(id => !htmlIds.has(id) && !CREATED_AT_RUNTIME.has(id));
check("every $(\"id\") the renderer looks up exists in index.html",
    missingIds.length === 0, missingIds.map(i => `$("${i}") — no such id`));

/* ----------------------------------------------------------- functions ---- */
// Every identifier used in call position, minus the ones that are legitimately
// not ours: DOM/browser globals, standard library, and locals of any kind.
const defined = new Set();
for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
// destructured bindings: const { a, b } = ...
for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
        const id = part.split(":").pop().split("=")[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(id)) defined.add(id);
    }
}
// function parameters and catch bindings, so callbacks that invoke their own
// arguments (cb(), resolve(), next()) are not reported
for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
        const id = part.split("=")[0].trim().replace(/^\.\.\./, "");
        if (/^[A-Za-z_$][\w$]*$/.test(id)) defined.add(id);
    }
}
for (const m of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g)) {
    for (const part of m[1].split(",")) {
        const id = part.split("=")[0].trim().replace(/^\.\.\./, "");
        if (/^[A-Za-z_$][\w$]*$/.test(id)) defined.add(id);
    }
}
for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
// single-argument arrow params without parens:  e => ...
for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) defined.add(m[1]);

const AMBIENT = new Set([
    // language
    "Object", "Array", "String", "Number", "Boolean", "Math", "JSON", "Date",
    "Promise", "Map", "Set", "WeakMap", "RegExp", "Error", "TypeError", "Symbol",
    "BigInt", "Intl", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
    "decodeURIComponent", "encodeURI", "decodeURI", "structuredClone", "queueMicrotask",
    // DOM / browser
    "document", "window", "navigator", "location", "console", "setTimeout",
    "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
    "cancelAnimationFrame", "fetch", "alert", "confirm", "prompt", "getComputedStyle",
    "Node", "Element", "HTMLElement", "Event", "CustomEvent", "MutationObserver",
    "ResizeObserver", "IntersectionObserver", "AbortController", "Blob", "File",
    "FileReader", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "Image",
    "DOMParser", "matchMedia", "performance", "crypto", "atob", "btoa",
    "localStorage", "sessionStorage", "Audio", "Notification", "CSS",
    "Float32Array", "Int16Array", "ArrayBuffer", "DataView", "Uint8Array",
    "AudioContext", "AudioWorkletNode", "MediaRecorder",
    // ours, injected by preload
    "lcl", "require", "module", "exports", "process", "global", "globalThis",
    // the syntax highlighter, loaded as a separate <script>
    "highlight", "highlightTo", "LCL_SYNTAX"
]);

const called = new Set(
    [...code.matchAll(/(?:^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)]
        .map(m => m[1])
        // keywords that are followed by a paren but are not calls
        .filter(n => !["if", "for", "while", "switch", "catch", "return", "typeof",
                       "function", "await", "new", "delete", "void", "in", "of",
                       "do", "else", "case", "throw", "yield", "async",
                       "instanceof", "get", "set"].includes(n))
);

const undefinedCalls = [...called].filter(n => !defined.has(n) && !AMBIENT.has(n));
check("every function the renderer calls is defined in it",
    undefinedCalls.length === 0, undefinedCalls.map(n => `${n}() — called, never defined`));

/* --------------------------------- variables, SCOPE BY SCOPE ------------- */
/**
 * THE CHECK THAT WOULD HAVE CAUGHT THE DEAD PICKER.
 *
 * 25/25 passed while the model menu could not open at all: adding the GPU tier
 * renamed the row loop's `kind` to `tier` and left two `kind` reads below it, so
 * building the first row threw a ReferenceError. Everything above checks ids,
 * CALLS, markup actions and CSS tokens. Nothing checked VARIABLES, which is
 * exactly the hole a renamed loop variable falls through.
 *
 * Widening the call check to read-position identifiers does NOT work, and that
 * was measured before this was written: `defined` is file-wide and scope-blind,
 * so a `const kind` in any other function masks a free `kind` in this one. The
 * masking is the whole bug. So this brace-matches each top-level function out of
 * the source and asks a scoped question — is every name this body READS declared
 * in this body, in its own parameter list, or at file top level.
 *
 * It found a second one immediately: remoteModelSections read a `cloud` that
 * nothing declared, so every role selector in Models & API threw as it was built.
 */
{
    const RESERVED = new Set(["if", "else", "for", "while", "do", "switch", "case",
        "default", "break", "continue", "return", "function", "var", "let", "const",
        "class", "extends", "super", "this", "new", "delete", "typeof", "instanceof",
        "in", "of", "void", "throw", "try", "catch", "finally", "yield", "await",
        "async", "null", "true", "false", "undefined", "NaN", "Infinity", "static",
        "get", "set", "arguments", "debugger", "import", "export"]);

    /**
     * Every name bound by one declarator list, starting just past `const `.
     *
     * A regex that takes the first identifier after const/let/var is not enough:
     * `const WS_MIN = 240, WS_MAX_FRACTION = 0.6;` binds two, and the second was
     * reported as free. Initialisers are skipped with a bracket counter so a
     * comma inside a call or an object literal does not end the list.
     */
    const bindingNames = (src, from) => {
        const names = [];
        let i = from;
        const n = src.length;
        const ws = () => { while (i < n && /\s/.test(src[i])) i++; };
        for (;;) {
            ws();
            if (i >= n) break;
            const c = src[i];
            if (c === "{" || c === "[") {
                const close = c === "{" ? "}" : "]";
                let depth = 0;
                const start = i;
                while (i < n) {
                    if (src[i] === c) depth++;
                    else if (src[i] === close) { depth--; if (!depth) { i++; break; } }
                    i++;
                }
                for (const part of src.slice(start + 1, i - 1).split(",")) {
                    const id = part.split(":").pop().split("=")[0].trim().replace(/^\.\.\./, "");
                    if (/^[A-Za-z_$][\w$]*$/.test(id)) names.push(id);
                }
            } else if (/[A-Za-z_$]/.test(c)) {
                const mm = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
                names.push(mm[0]); i += mm[0].length;
            } else break;
            ws();
            if (src[i] === "=") {
                i++;
                let d = 0;
                while (i < n) {
                    const ch = src[i];
                    if ("([{".includes(ch)) d++;
                    else if (")]}".includes(ch)) { if (d === 0) break; d--; }
                    else if ((ch === ";" || ch === ",") && d === 0) break;
                    i++;
                }
            }
            ws();
            if (src[i] === ",") { i++; continue; }
            break;
        }
        return names;
    };

    const declaredIn = (src) => {
        const d = new Set();
        for (const mm of src.matchAll(/\b(?:const|let|var)\s+/g))
            for (const id of bindingNames(src, mm.index + mm[0].length)) d.add(id);
        for (const mm of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) d.add(mm[1]);
        for (const mm of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) d.add(mm[1]);
        for (const mm of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) d.add(mm[1]);
        for (const mm of src.matchAll(/\(([^()]*)\)\s*=>/g))
            for (const id of (mm[1].match(/[A-Za-z_$][\w$]*/g) || [])) d.add(id);
        for (const mm of src.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) d.add(mm[1]);
        for (const mm of src.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g))
            for (const id of (mm[1].match(/[A-Za-z_$][\w$]*/g) || [])) d.add(id);
        return d;
    };

    /**
     * FILE SCOPE IS DECLARATIONS ONLY — NOT PARAMETERS.
     *
     * Measured: reusing declaredIn() here made the check useless. It harvests
     * parameter lists, and `function setStatus(kind, text)` sits at column 0, so
     * `kind` landed in the file-scope set and the picker defect this whole check
     * exists to catch passed clean. A top-level function's parameters are local
     * to it; only its NAME is file scope.
     */
    const declaredAtFileScope = (line) => {
        const d = new Set();
        for (const mm of line.matchAll(/^(?:export\s+)?(?:const|let|var)\s+/g))
            for (const id of bindingNames(line, mm.index + mm[0].length)) d.add(id);
        const fn = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line);
        if (fn) d.add(fn[1]);
        const cls = /^class\s+([A-Za-z_$][\w$]*)/.exec(line);
        if (cls) d.add(cls[1]);
        return d;
    };

    // file top level: anything declared at column 0, plus the one global this
    // renderer installs with a property descriptor rather than a declaration
    const topLevel = new Set();
    for (const line of code.split("\n")) {
        if (/^\s/.test(line)) continue;
        for (const id of declaredAtFileScope(line)) topLevel.add(id);
    }
    // `pending` is a real module-scope global: Object.defineProperty(window,
    // "pending", { get() {...} }). Read from the RAW source, because the scan
    // above has blanked the string that names it.
    for (const mm of js.matchAll(/Object\.defineProperty\(\s*window\s*,\s*["']([A-Za-z_$][\w$]*)["']/g))
        topLevel.add(mm[1]);

    const bodyAfter = (src, openIdx) => {
        let depth = 0;
        for (let i = openIdx; i < src.length; i++) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") { depth--; if (!depth) return src.slice(openIdx + 1, i); }
        }
        return null;
    };

    const FN = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
    const IDENT = /[A-Za-z_$][\w$]*/g;
    const free = [];
    let scanned = 0, fn;
    while ((fn = FN.exec(code))) {
        const fname = fn[1];
        let open = fn.index + fn[0].length - 1;          // the "(" of the param list
        let depth = 0, close = open;
        for (let k = open; k < code.length; k++) {
            if (code[k] === "(") depth++;
            else if (code[k] === ")") { depth--; if (!depth) { close = k; break; } }
        }
        const params = code.slice(open + 1, close);
        const body = bodyAfter(code, code.indexOf("{", close));
        if (body == null) continue;
        scanned++;

        const known = new Set([...topLevel, ...AMBIENT, ...declaredIn(body),
            ...(params.match(/[A-Za-z_$][\w$]*/g) || []), fname]);

        const seen = new Set();
        let t;
        IDENT.lastIndex = 0;
        while ((t = IDENT.exec(body))) {
            const id = t[0];
            if (RESERVED.has(id) || known.has(id) || seen.has(id)) continue;
            let p = t.index - 1;
            // the tail of a number, not a name: 4e9, 2.5e9, 60_000
            if (p >= 0 && /[0-9]/.test(body[p])) continue;
            while (p >= 0 && /\s/.test(body[p])) p--;
            const before = p >= 0 ? body[p] : "";
            if (before === ".") continue;                     // a.b / a?.b — a property
            let q = t.index + id.length;
            while (q < body.length && /\s/.test(body[q])) q++;
            const after = body[q];
            // an object literal's own key, or a method shorthand: not a read
            if ((before === "{" || before === "," || before === ";") && after === ":") continue;
            if ((before === "{" || before === ",") && after === "(") continue;
            seen.add(id);
            free.push(`${fname}() reads ${id} — declared nowhere in it, in its ` +
                      `parameters, or at file top level`);
        }
    }

    check(`(setup) every top-level function was brace-matched out of the source ` +
          `(${scanned} of them)`, scanned > 100);
    check("EVERY VARIABLE A TOP-LEVEL FUNCTION READS IS DECLARED IN ITS OWN SCOPE — " +
          "a renamed loop variable left behind is a ReferenceError on the first " +
          "row, and the picker shipped dead exactly that way",
        free.length === 0, free);
}

/* ------------------------------------------------------- menu actions ---- */
const actionsInHtml = [...new Set(
    [...html.matchAll(/data-action="([^"]+)"/g)].map(m => m[1])
)];
// the object literal `const menuActions = { ... }`
const maStart = js.indexOf("const menuActions");
const maBody = maStart >= 0 ? js.slice(maStart, js.indexOf("\n};", maStart)) : "";
// Anchored to the start of a line at the object's own indentation. A loose
// /"key"\s*:/ also matched `c.vision ? "vision" : null` inside the About
// handler and reported a menuActions["vision"] that never existed.
const handled = new Set([...maBody.matchAll(/^ {4}"([a-z-]+)"\s*:/gm)].map(m => m[1]));

const deadActions = actionsInHtml.filter(a => !handled.has(a));
check("every menu item in the markup has a handler",
    deadActions.length === 0, deadActions.map(a => `data-action="${a}" — no entry in menuActions`));

const orphanHandlers = [...handled].filter(a => !actionsInHtml.includes(a));
check("every handler in menuActions has a menu item",
    orphanHandlers.length === 0, orphanHandlers.map(a => `menuActions["${a}"] — nothing in the markup calls it`));

/* --------------------------------------------------------- css tokens ---- */
// CSS comments stripped for the same reason the JS ones are: a note reading
// "no #titlebar-name: the badge alone identifies the app" was being read as a
// rule styling an element that does not exist.
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, " ");
const declared = new Set([...cssCode.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(m => m[1]));
const usedTokens = [...new Set([...cssCode.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]))];
// tokens with an inline fallback -- var(--x, 320px) -- are allowed to be unset
const withFallback = new Set(
    [...cssCode.matchAll(/var\((--[\w-]+)\s*,/g)].map(m => m[1])
);
const missingTokens = usedTokens.filter(t => !declared.has(t) && !withFallback.has(t));
check("every CSS variable used is declared somewhere",
    missingTokens.length === 0, missingTokens.map(t => `var(${t}) — never declared`));

/* ------------------------------------------------- ids used in styles ---- */
// A styled id that does not exist is dead CSS; harmless, but it is also how you
// find out that markup was renamed and half the rules were left behind.
const styledIds = [...new Set([...cssCode.matchAll(/#([a-z][\w-]*)/g)].map(m => m[1]))];
const HEX_LIKE = /^[0-9a-fA-F]{3,8}$/;
const danglingStyles = styledIds
    .filter(id => !HEX_LIKE.test(id))
    .filter(id => !htmlIds.has(id))
    // ids the renderer builds at runtime
    .filter(id => !new RegExp(`id\\s*=\\s*["'\`]${id}["'\`]|\\.id\\s*=\\s*["'\`]${id}["'\`]`).test(js));
/* ------------------------------------- markup ids the renderer forgot ---- */
// THE INVERSE, AND THE ONE THAT ACTUALLY SHIPS BUGS.
//
// An "Update available" card — title, subtitle, progress bar, Update and Later
// buttons — sat in the sidebar markup with 58 lines of CSS and not one
// reference in any script, in an app with no updater. It could never appear.
// The check above only asked whether styled ids EXIST in the markup, so nine
// dead elements passed it every run. This asks the question that matters: does
// the renderer ever touch this thing at all.
{
    const inert = new Set(["app", "body", "sidebar", "workspace", "titlebar",
        "titlebar-brand", "titlebar-center", "titlebar-mark", "menubar",
        "window-controls", "composer", "composer-inner", "search-wrap",
        "search-icon", "landing-content", "landing-actions",
        // a grouping div whose CHILDREN are all live and styled. That is a
        // structural wrapper, not a dead feature — the distinction this check
        // exists to draw is "does anything reference this at all", and an
        // element whose every child is wired is plainly not the update-card
        // case. Listed rather than deleted because removing a wrapper can move
        // layout in ways only the running app shows.
        "optimize-panel"]);
    const orphans = [...htmlIds]
        .filter(id => !inert.has(id))
        // referenced by $("id"), getElementById, a querySelector, or a CSS-only
        // decorative rule the renderer legitimately never reads
        .filter(id => !new RegExp(`["'\`]${id}["'\`]`).test(js))
        // "\b" inside a template literal is a BACKSPACE character, not a word
        // boundary — written that way this matched nothing and every styled id
        // looked like an orphan.
        .filter(id => !new RegExp("#" + id + "\\b").test(js))
        // an element with no id-based behaviour is fine IF it is purely
        // decorative: it must at least be styled, or it is doing nothing at all
        .filter(id => !new RegExp("#" + id + "\\b").test(cssCode));
    check("every id in the markup is either used by the renderer or styled",
        orphans.length === 0, orphans.map(i => `#${i} — in markup, never used`));
}

check("every id styled in styles.css exists in the markup",
    danglingStyles.length === 0, danglingStyles.map(i => `#${i} — styled, no such element`));

// EVERYTHING THE APP SAYS IS COPYABLE — ENFORCED, NOT REMEMBERED.
//
// The rule is global and standing. It was still broken repeatedly, because a
// new container has to be added in TWO places (the click handler's selector
// list and the cursor:copy rule) and one was added while the other was
// forgotten. Remembering is not a mechanism; this is.
{
    const jsList = (/const COPYABLE_SEL = \[([\s\S]*?)\]\.join/.exec(js) || [])[1] || "";
    const jsSel = new Set([...jsList.matchAll(/"([.#][\w-]+)"/g)].map(m => m[1]));

    const cssRule = (/\n((?:[.#][\w-]+,?\s*)+)\{\s*\n\s*cursor: copy;/.exec(cssCode) || [])[1] || "";
    const cssSel = new Set([...cssRule.matchAll(/([.#][\w-]+)/g)].map(m => m[1]));

    check("the copyable selector list exists in both the renderer and the css",
        jsSel.size > 0 && cssSel.size > 0, { js: jsSel.size, css: cssSel.size });

    const missingCss = [...jsSel].filter(s => !cssSel.has(s));
    const missingJs = [...cssSel].filter(s => !jsSel.has(s));
    check("every copyable element is styled as copyable (cursor + hover)",
        missingCss.length === 0, missingCss);
    check("every element styled copyable actually copies when clicked",
        missingJs.length === 0, missingJs);
}

// NO PILLS — ENFORCED, NOT REMEMBERED.
//
// The rule: no pill shapes — no 999px border-radius anywhere — fixed globally
// rather than only where it is noticed.
//
// Fixing it only "where you notice it" is exactly how it kept coming back, so the
// rule is a check instead of a memory. Circles (50%) and the switch track are
// not pills — a dot is a dot — so only the runaway values are caught.
{
    const strip = cssCode.replace(/\/\*[\s\S]*?\*\//g, "");   // the token comment says 999px on purpose
    const runaway = [...strip.matchAll(/border-radius:[^;]*?(\d{3,})px/g)]
        .map(m => Number(m[1])).filter(n => n >= 100);
    check("no lozenge radii anywhere in the stylesheet", runaway.length === 0, runaway);

    check("the wizard's step pills are gone from the markup and the styles",
        !/wiz-steps?\b/.test(js) && !/\.wiz-steps?\b/.test(strip));
}

// THE MICROPHONE MUST NOT KILL THE PAGE.
//
// Measured by driving the button: the trace reached
// "recording-started 48000 Hz" and the renderer process then vanished — the
// app's children were main, gpu-process, utility, utility, with no renderer at
// all. The window stayed open, painted black, and swallowed every click and
// keypress. Two causes removed: ScriptProcessorNode (deprecated, runs its
// callback on the page's own JS thread) and connecting the microphone straight
// to ctx.destination, which routes it back out through the speakers.
{
    const worklet = path.join(R, "mic-worklet.js");
    check("capture runs in an AudioWorklet, off the page's thread",
        fs.existsSync(worklet) &&
        /registerProcessor\("mic-capture"/.test(fs.readFileSync(worklet, "utf8")) &&
        /new AudioWorkletNode\(ctx, "mic-capture"\)/.test(js));
    check("the deprecated main-thread capture node is gone",
        !/createScriptProcessor/.test(js));
    check("the microphone is never routed into the speakers",
        /mute\.gain\.value = 0/.test(js) &&
        !/node\.connect\(ctx\.destination\)/.test(js));
    check("a dead renderer is reported and recovered, never left as a black window",
        (() => {
            const m = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
            return /on\("render-process-gone"/.test(m) &&
                   /kind: "renderer-gone"/.test(m) && /mainWindow\.reload\(\)/.test(m);
        })());
    check("every step of dictation is traced, so a failure names where it stopped",
        /micTrace/.test(js) && /trace\("recording-started"/.test(js) &&
        /trace\("worklet-loaded"\)/.test(js));
}

// DICTATION IS LIVE, AND IT NEVER EATS WHAT YOU TYPED.
//
// Asked for repeatedly: words appearing as you speak, not a pulsing button and
// a wait. Whisper does not stream, so the clip so far is transcribed on a
// rolling timer and the provisional text is replaced each pass — then replaced
// once more, at stop, by a transcription of the WHOLE clip, which is markedly
// more accurate than stitched partial windows.
{
    check("a rolling pass transcribes while the microphone is open",
        /st0\.liveTimer = setInterval\(/.test(js) &&
        /trace\("live-pass"/.test(js));
    check("passes never overlap and never run on a clip too short to hear",
        /st0\.liveBusy/.test(js) && /frames < st0\.rate \* 0\.5/.test(js));
    check("...and the first words arrive FAST: half a second of audio and a " +
          "sub-second timer, because 'live' that starts at three seconds reads " +
          "as waiting until you are done",
        /\}, 900\);/.test(js.slice(js.indexOf("liveTimer = setInterval"), js.indexOf("liveTimer = setInterval") + 4000)));
    check("dictation replaces ONLY its own span, never what was typed around it",
        /function setDictated\(st, text\)/.test(js) &&
        /st\.textBefore/.test(js) &&
        /cur\.startsWith\(expected\) \? cur\.slice\(expected\.length\)/.test(js));
    check("the final pass transcribes the whole clip, not the last window",
        /const wav = wavFromPcm\(st\.chunks, st\.rate\)[\s\S]{0,200}transcribeMic\(wav\)/.test(js));
    check("the rolling timer is stopped when recording stops",
        /if \(st\.liveTimer\) clearInterval\(st\.liveTimer\)/.test(js));
    check("a failed final pass drops the provisional text rather than leaving a guess",
        /setDictated\(st, ""\)/.test(js));
    check("the button says it is listening, and where the words are going",
        /Listening - words appear in the message box/.test(js));
}

/* =====================================================================
 * A DOM SMALL ENOUGH TO RUN THE RENDERER'S OWN CODE
 *
 * Static checks answer "does this name exist". They cannot answer "does
 * clicking here destroy what you are typing", and that is the shape of half the
 * defects in this file's history. There is no jsdom in this checkout and there
 * is not going to be one — so this is a few dozen lines of document: elements,
 * classes, attributes, a descendant selector, and event dispatch that BUBBLES,
 * which is the only part the session-row bug turns on.
 *
 * The code under test is lifted verbatim out of app.js — brace-matched, never
 * retyped — so a fix that is reverted in app.js is reverted in the test too.
 * codeOnly() is length-preserving, so offsets found in the blanked copy index
 * straight into the real source.
 * =================================================================== */

/** the source of a named top-level function, exactly as written */
function fnSource(name) {
    const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
    const m = re.exec(code);
    if (!m) return null;
    const open = code.indexOf("{", m.index + m[0].length);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === "{") depth++;
        else if (code[i] === "}") { depth--; if (!depth) return js.slice(m.index, i + 1); }
    }
    return null;
}

/**
 * One statement, from an anchor to its terminating semicolon at depth zero.
 * The anchor is an offset into the REAL source (that is where the string
 * literals people search for still exist); the depth counting runs over the
 * blanked copy, which is the whole point of it being length-preserving.
 */
function anchorAt(needle) {
    const i = js.indexOf(needle);
    return i;
}
function statementAt(anchor) {
    if (anchor < 0) return null;
    let d = 0;
    for (let i = anchor; i < code.length; i++) {
        const c = code[i];
        if ("([{".includes(c)) d++;
        else if (")]}".includes(c)) d--;
        else if (c === ";" && d === 0) return js.slice(anchor, i + 1);
    }
    return null;
}

function makeDom() {
    const kebab = (s) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

    class El {
        constructor(tag) {
            this.tagName = String(tag || "div").toUpperCase();
            this.children = [];
            this.parentNode = null;
            this.attrs = new Map();
            this.innerText = "";
            this.value = "";
            this.style = {};
            this.disabled = false;
            this.checked = false;
            this.contentEditable = "false";
            this.title = "";
            this.focused = false;
            this._cls = new Set();
            this._ls = new Map();
            const self = this;
            this.dataset = new Proxy({}, {
                set(t, k, v) { t[k] = v; self.attrs.set("data-" + kebab(String(k)), String(v)); return true; },
                get(t, k) { return t[k]; }
            });
            this.classList = {
                add: (...c) => c.forEach(x => x && self._cls.add(x)),
                remove: (...c) => c.forEach(x => self._cls.delete(x)),
                contains: (c) => self._cls.has(c),
                toggle: (c, on) => {
                    const want = on === undefined ? !self._cls.has(c) : !!on;
                    if (want) self._cls.add(c); else self._cls.delete(c);
                    return want;
                }
            };
        }
        get className() { return [...this._cls].join(" "); }
        set className(v) {
            this._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
        }
        get innerHTML() { return ""; }
        set innerHTML(v) {
            // the renderer only ever uses this to EMPTY a container, which is
            // the first statement of renderSessionList and the whole reason a
            // node being edited disappears mid-rename
            if (!v) { for (const c of this.children) c.parentNode = null; this.children = []; }
        }
        get offsetHeight() { return 0; }
        get offsetWidth() { return 0; }
        setAttribute(k, v) { this.attrs.set(k, String(v)); }
        getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
        removeAttribute(k) { this.attrs.delete(k); }
        getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
        replaceWith(...nodes) {
            const p = this.parentNode;
            if (!p) return;
            const i = p.children.indexOf(this);
            p.children.splice(i, 1, ...nodes);
            for (const n of nodes) n.parentNode = p;
            this.parentNode = null;
        }
        remove() {
            if (!this.parentNode) return;
            const i = this.parentNode.children.indexOf(this);
            if (i >= 0) this.parentNode.children.splice(i, 1);
            this.parentNode = null;
        }
        focus() { this.focused = true; }
        select() { this.selected = true; }
        contains(node) {
            for (let n = node; n; n = n.parentNode) if (n === this) return true;
            return false;
        }
        matches(sel) { return matchesCompound(this, sel); }
        querySelector(sel) { return (this.querySelectorAll(sel))[0] || null; }
        querySelectorAll(sel) {
            const comps = String(sel).trim().split(/\s+(?![^[]*\])/);
            const out = [];
            const walk = (node, idx) => {
                for (const c of node.children) {
                    if (matchesCompound(c, comps[idx])) {
                        if (idx === comps.length - 1) out.push(c);
                        else walk(c, idx + 1);
                    }
                    walk(c, idx);
                }
            };
            walk(this, 0);
            return [...new Set(out)];
        }
        addEventListener(type, fn, opts) {
            const rec = { fn, once: !!(opts && opts.once) };
            if (!this._ls.has(type)) this._ls.set(type, []);
            this._ls.get(type).push(rec);
            if (opts && opts.signal) {
                if (opts.signal.aborted) this.removeEventListener(type, fn);
                else opts.signal.addEventListener("abort", () => this.removeEventListener(type, fn));
            }
        }
        removeEventListener(type, fn) {
            const l = this._ls.get(type);
            if (!l) return;
            const i = l.findIndex(r => r.fn === fn);
            if (i >= 0) l.splice(i, 1);
        }
        dispatchEvent(ev) {
            ev.target = ev.target || this;
            for (let node = this; node; node = node.parentNode) {
                for (const rec of (node._ls.get(ev.type) || []).slice()) {
                    ev.currentTarget = node;
                    rec.fn.call(node, ev);
                    if (rec.once) node.removeEventListener(ev.type, rec.fn);
                }
                if (ev.bubbles === false || ev._stopped) break;
            }
            return !ev._defaulted;
        }
    }

    function matchesCompound(el, comp) {
        let rest = String(comp);
        const tag = /^[a-zA-Z][\w-]*/.exec(rest);
        if (tag) {
            if (el.tagName !== tag[0].toUpperCase()) return false;
            rest = rest.slice(tag[0].length);
        }
        const re = /(\.[\w-]+)|(#[\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
        let m;
        while ((m = re.exec(rest))) {
            if (m[1]) { if (!el.classList.contains(m[1].slice(1))) return false; }
            else if (m[2]) { if (el.getAttribute("id") !== m[2].slice(1)) return false; }
            else {
                const v = el.getAttribute(m[3]);
                if (m[4] === undefined ? v == null : v !== m[4]) return false;
            }
        }
        return true;
    }

    const document = {
        createElement: (t) => new El(t),
        createTextNode: (t) => { const e = new El("#text"); e.innerText = String(t); return e; },
        execCommand: () => true,
        body: new El("body")
    };
    const ev = (type, extra = {}) => Object.assign({
        type, bubbles: true, _stopped: false,
        preventDefault() { this._defaulted = true; },
        stopPropagation() { this._stopped = true; }
    }, extra);
    return { El, document, ev };
}

/** let every pending microtask and promise settle */
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const failures = [];
const acheck = (name, fn) => failures.push([name, fn]);

/**
 * AN UNHANDLED REJECTION IS ONE OF THE DEFECTS, NOT AN ACCIDENT OF THE HARNESS.
 *
 * copyText's old shape called navigator.clipboard.writeText(s) and threw the
 * promise away — so a rejected clipboard write had no handler anywhere. Under
 * Node that kills the process, which would take this suite down with a stack
 * trace instead of a named failure. Trapped and reported as its own check, so
 * the run stays legible and the fact is stated rather than crashed.
 */
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(String((e && e.message) || e)));

/* ---------------------------------------------------------------------
 * SESSION ROWS: rename must survive being clicked in
 * ------------------------------------------------------------------- */
{
    const renameSrc = fnSource("renameSessionRow");
    const rowClickSrc = statementAt(anchorAt('item.addEventListener("click"'));
    const menuSrc = fnSource("openSessionMenu");

    check("(setup) renameSessionRow, the row's click handler and openSessionMenu " +
          "were lifted out of app.js",
        !!renameSrc && !!rowClickSrc && !!menuSrc,
        [renameSrc ? "" : "renameSessionRow missing",
         rowClickSrc ? "" : "row click handler missing",
         menuSrc ? "" : "openSessionMenu missing"].filter(Boolean));

    const stage = () => {
        const dom = makeDom();
        const sessionListEl = new dom.El("div");
        const sessions = [{ id: "A", title: "Print run" }, { id: "B", title: "Stop bath" }];
        const pendingSessions = new Set();
        const switched = [];
        const modals = [];
        const renameCalls = [];
        const rows = {};
        for (const s of sessions) {
            const item = new dom.El("div");
            item.className = "session-item" + (s.id === "A" ? " active" : "");
            item.dataset.sessionId = s.id;
            const name = new dom.El("div");
            name.className = "session-name";
            name.innerText = s.title;
            item.appendChild(name);
            sessionListEl.appendChild(item);
            rows[s.id] = { item, name };
            // the REAL handler, verbatim, with a switchSession that does what
            // the real one does to this list: renderSessionList() wipes it
            new Function("item", "s", "switchSession", rowClickSrc)(
                item, s, (id) => { switched.push(id); sessionListEl.innerHTML = ""; });
        }
        const win = {
            lcl: {
                renameSession: (id, next) => { renameCalls.push([id, next]); return Promise.resolve({ title: next }); }
            }
        };
        // `pending` the way app.js really defines it — a getter on the global
        // that answers about the OPEN session. Reproduced rather than stubbed,
        // so the defect this test guards (`if (pending) return;` on a per-row
        // action) can be put back and actually run.
        const renameSessionRow = new Function(
            "pendingSessions", "modal", "active", "renameActiveSession", "sessionListEl",
            "sessions", "document", "window", "AbortController", "refreshSessions",
            'Object.defineProperty(globalThis, "pending", { configurable: true,\n' +
            '    get() { return !!(active && pendingSessions.has(active.id)); } });\n' +
            renameSrc + "\nreturn renameSessionRow;")(
            pendingSessions,
            (o) => { modals.push(o); return Promise.resolve(true); },
            { id: "A" },
            () => { throw new Error("renameActiveSession must not be reached for a non-active row"); },
            sessionListEl, sessions, dom.document, win, AbortController,
            async () => {});
        return { dom, sessionListEl, pendingSessions, switched, modals, renameCalls, rows,
                 renameSessionRow, menuSrc };
    };

    /* ---- FINDING 17 ---- */
    acheck("CLICKING INTO A NAME BEING RENAMED DOES NOT NAVIGATE AWAY. The " +
           "contenteditable is a DESCENDANT of the row, so one click to place the " +
           "cursor bubbled to the row handler, switched to that session and wiped " +
           "the node mid-edit — the rename lost with no message",
        async () => {
            const t = stage();
            await t.renameSessionRow("B");
            if (t.rows.B.name.contentEditable !== "true") return "the row never entered edit mode";
            t.rows.B.name.dispatchEvent(t.dom.ev("click"));
            await settle();
            if (t.switched.length) return "switchSession(" + t.switched.join(",") + ") fired from inside the edit";
            if (!t.sessionListEl.contains(t.rows.B.name)) return "the node being edited was removed from the DOM";
            if (t.rows.B.name.contentEditable !== "true") return "the edit was ended by the click";
            return null;
        });

    acheck("...and a click on a row that is NOT being edited still opens it, " +
           "because the guard is the editing state and nothing else",
        async () => {
            const t = stage();
            t.rows.B.item.dispatchEvent(t.dom.ev("click"));
            await settle();
            return t.switched.length === 1 && t.switched[0] === "B"
                ? null : "an ordinary row click no longer switches session";
        });

    /* ---- FINDING 31 ---- */
    acheck("RENAME IS GUARDED BY THE TARGET ROW, NOT BY WHATEVER IS OPEN. A turn " +
           "in flight in session A used to block renaming an idle session B — " +
           "silently, with no modal and no disabled item",
        async () => {
            const t = stage();
            t.pendingSessions.add("A");               // the OPEN session is busy
            await t.renameSessionRow("B");            // a DIFFERENT, idle row
            if (t.rows.B.name.contentEditable !== "true")
                return "renameSessionRow refused an idle row because another session was busy";
            if (t.modals.length) return "it opened a dialog instead of just renaming";
            return null;
        });

    acheck("...and when the TARGET row really is busy it SAYS SO rather than " +
           "closing the menu and doing nothing",
        async () => {
            const t = stage();
            t.pendingSessions.add("B");
            await t.renameSessionRow("B");
            if (t.rows.B.name.contentEditable === "true") return "a busy row went editable";
            if (!t.modals.length) return "refused in silence — no modal, no notice";
            return null;
        });

    acheck("...and the row menu itself HIDES both actions while that row is busy, " +
           "because `when` is finally populated — it was checked and never set, so " +
           "both items drew as live and then did nothing",
        async () => {
            const t = stage();
            const build = (busySet) => {
                const dom = makeDom();
                const menu = new Function("closeSessionMenu", "renameSessionRow", "deleteSession",
                    "pendingSessions", "document", "window",
                    "let sessionMenuEl = null;\n" + t.menuSrc +
                    "\nreturn (s, anchor) => { openSessionMenu(s, anchor); return sessionMenuEl; };")(
                    () => {}, () => {}, () => {}, busySet, dom.document,
                    { innerHeight: 800, innerWidth: 1200 });
                return menu({ id: "B" }, new dom.El("button"));
            };
            const idle = build(new Set());
            const busy = build(new Set(["B"]));
            const btns = (m) => m.children.filter(c => c.tagName === "BUTTON").length;
            const notes = (m) => m.children.filter(c => c.classList.contains("session-menu-note")).length;
            // Fork rides in this menu too, and DELIBERATELY has no busy guard:
            // the parent keeps working and the fork owns the transcript as it
            // stood. So idle offers Rename + Fork + Delete; busy offers ONLY
            // Fork — the two actions that would be refused stay hidden.
            if (btns(idle) !== 3) return "an idle row should offer Rename, Fork and Delete, saw " + btns(idle);
            if (btns(busy) !== 1) return "a busy row should offer exactly Fork, saw " + btns(busy);
            if (notes(busy) !== 1) return "a busy row's menu opens with no explanation";
            return null;
        });

    /* ---- FINDING 40 ---- */
    acheck("RENAME → ESCAPE → RENAME → ENTER FIRES ONE RENAME, NOT TWO. Escape " +
           "returns without re-rendering, so the row survives with its keydown " +
           "closure attached and the next edit added a second one",
        async () => {
            const t = stage();
            await t.renameSessionRow("B");
            t.rows.B.name.dispatchEvent(t.dom.ev("keydown", { key: "Escape" }));
            await settle();
            await t.renameSessionRow("B");
            t.rows.B.name.innerText = "developer tank";
            t.rows.B.name.dispatchEvent(t.dom.ev("keydown", { key: "Enter" }));
            await settle();
            return t.renameCalls.length === 1
                ? null
                : "renameSession was invoked " + t.renameCalls.length + " times: " +
                  JSON.stringify(t.renameCalls);
        });
}

/* ---------------------------------------------------------------------
 * THE MODAL'S COPY BUTTON: it copies everything, and it does not lie
 * ------------------------------------------------------------------- */
{
    const fallbackSrc = fnSource("copyTextFallback");
    const copySrc = fnSource("copyText");
    const onclickSrc = statementAt(anchorAt("copyBtn.onclick = "));
    check("(setup) copyText and the modal's copy handler were lifted out of app.js",
        !!fallbackSrc && !!copySrc && !!onclickSrc);

    const panel = (dom, withScope) => {
        const mk = (t, hidden) => {
            const e = new dom.El("div");
            e.innerText = t;
            if (hidden) e.classList.add("hidden");
            return e;
        };
        const els = {
            "modal-title": mk("Grant workspace access"),
            "modal-message": mk("Give .lcl access to this folder?"),
            "modal-node": mk("", true),
            "modal-detail": mk("41 readable files found."),
            "modal-path": mk("D:\\darkroom\\stop-bath"),
            "modal-scope": mk("Read files in this folder\n" +
                              "Create and overwrite files in this folder\n" +
                              "No access anywhere else on this machine", !withScope)
        };
        return (id) => els[id] || null;
    };

    /* ---- FINDING 33 ---- */
    acheck("\"COPY EVERYTHING IN THIS PANEL\" INCLUDES THE PERMISSION SCOPE. " +
           "#modal-scope is the only element in the dialog that states what is " +
           "being granted, and it was the one region the handler skipped",
        async () => {
            const dom = makeDom();
            const captured = [];
            const copyBtn = new dom.El("button");
            const onclick = new Function("$", "copyText", "copyBtn", "setTimeout",
                onclickSrc + "\nreturn copyBtn.onclick;")(
                panel(dom, true), (t) => { captured.push(t); return Promise.resolve(true); },
                copyBtn, () => {});
            onclick();
            await settle();
            if (!captured.length) return "nothing was copied at all";
            const got = captured[0];
            if (!got.includes("No access anywhere else on this machine"))
                return "the scope list is missing from the copied text:\n" + JSON.stringify(got);
            for (const must of ["Grant workspace access", "Give .lcl access to this folder?",
                                "41 readable files found.", "darkroom"])
                if (!got.includes(must)) return "the copied text dropped: " + must;
            return null;
        });

    acheck("...and a hidden region is still skipped — #modal-node is empty here " +
           "and must not leave a blank paragraph in the copy",
        async () => {
            const dom = makeDom();
            const captured = [];
            const copyBtn = new dom.El("button");
            new Function("$", "copyText", "copyBtn", "setTimeout",
                onclickSrc + "\nreturn copyBtn.onclick;")(
                panel(dom, false), (t) => { captured.push(t); return Promise.resolve(true); },
                copyBtn, () => {})();
            await settle();
            return captured[0] && !captured[0].includes("\n\n\n")
                && !captured[0].includes("No access anywhere else")
                ? null : "a hidden region leaked into the copy: " + JSON.stringify(captured[0]);
        });

    /* ---- FINDING 32 ---- */
    const clipboardRig = (writeOk, execOk) => {
        const dom = makeDom();
        const seen = { exec: [], written: null };
        dom.document.execCommand = (cmd) => {
            seen.exec.push(cmd);
            seen.written = seen.lastTa ? seen.lastTa.value : null;
            return execOk;
        };
        const realCreate = dom.document.createElement;
        dom.document.createElement = (t) => {
            const e = realCreate(t);
            if (String(t).toLowerCase() === "textarea") seen.lastTa = e;
            return e;
        };
        const nav = { clipboard: { writeText: () => writeOk ? Promise.resolve() : Promise.reject(new Error("Document is not focused")) } };
        const copyText = new Function("navigator", "document",
            fallbackSrc + "\n" + copySrc + "\nreturn copyText;")(nav, dom.document);
        const copyBtn = new dom.El("button");
        const onclick = new Function("$", "copyText", "copyBtn", "setTimeout",
            onclickSrc + "\nreturn copyBtn.onclick;")(panel(dom, true), copyText, copyBtn, () => {});
        return { seen, copyBtn, onclick };
    };

    acheck("A REJECTED CLIPBOARD WRITE REACHES THE FALLBACK AND, IF THAT FAILS " +
           "TOO, THE BUTTON SAYS SO. copyText returned true on the line after " +
           "writeText() without awaiting it, so a sync try/catch could not see " +
           "the rejection and the execCommand fallback was unreachable — the " +
           "button turned green over an unchanged clipboard",
        async () => {
            const r = clipboardRig(false, false);
            r.onclick();
            await settle();
            if (!r.seen.exec.includes("copy")) return "the fallback never ran — execCommand was not called";
            if (r.copyBtn.classList.contains("copied"))
                return "the button claims \"Copied\" after both routes failed";
            if (!r.copyBtn.classList.contains("copy-failed"))
                return "the failure is invisible — no copy-failed state";
            if (!/failed/i.test(r.copyBtn.title)) return "the tooltip still claims success: " + r.copyBtn.title;
            return null;
        });

    acheck("...and when the fallback DOES land, the panel text really is what got " +
           "written, and only then does it say Copied",
        async () => {
            const r = clipboardRig(false, true);
            r.onclick();
            await settle();
            if (!r.seen.written || !r.seen.written.includes("No access anywhere else on this machine"))
                return "the fallback wrote: " + JSON.stringify(r.seen.written);
            if (!r.copyBtn.classList.contains("copied")) return "a successful copy did not report success";
            if (r.copyBtn.classList.contains("copy-failed")) return "a successful copy reported failure";
            return null;
        });

    acheck("...and the ordinary path — the async API resolving — never touches " +
           "the fallback",
        async () => {
            const r = clipboardRig(true, true);
            r.onclick();
            await settle();
            if (r.seen.exec.length) return "execCommand ran even though writeText resolved";
            return r.copyBtn.classList.contains("copied") ? null : "a successful copy did not report success";
        });
}

/* ---------------------------------------------------------------------
 * CONTRACT C1 — a failed device probe reads as a failure
 * ------------------------------------------------------------------- */
{
    const scanSrc = statementAt(anchorAt('devBtn.addEventListener("click"'));
    check("(setup) the device-scan handler was lifted out of app.js", !!scanSrc);

    const runScan = async (res) => {
        const dom = makeDom();
        const devBtn = new dom.El("button");
        const devOut = new dom.El("div");
        new Function("devBtn", "devOut", "document", "window", scanSrc)(
            devBtn, devOut, dom.document,
            { lcl: { inspectDevices: () => Promise.resolve(res) } });
        devBtn.dispatchEvent(dom.ev("click"));
        await settle(12);
        const text = [];
        const walk = (n) => { if (n.innerText) text.push(n.innerText); n.children.forEach(walk); };
        walk(devOut);
        return { devOut, text: (devOut.innerText || "") + "\n" + text.join("\n") };
    };

    acheck("A FAILED OS PROBE IS NOT AN EMPTY BENCH. deviceScan reports scanError " +
           "when the probe itself did not run; that must be checked BEFORE the " +
           "\"Nothing on USB.\" branch, or a question nobody got to ask is painted " +
           "as a clean answer about the hardware",
        async () => {
            const r = await runScan({ devices: [], notRead: "",
                scanError: "The USB device tree could not be read: the Win32 query returned no handle." });
            if (/Nothing on USB\./.test(r.text))
                return "a failed probe reported \"Nothing on USB.\"";
            if (!/did not run/i.test(r.text)) return "the failure is not stated: " + JSON.stringify(r.text);
            if (!/Win32 query returned no handle/.test(r.text))
                return "the probe's own sentence was dropped: " + JSON.stringify(r.text);
            if (!r.devOut.querySelector(".dev-row.scan-failed"))
                return "the failure is not styled as a failure — no .scan-failed row";
            return null;
        });

    acheck("...and a probe that WORKED and found nothing still says so plainly",
        async () => {
            const r = await runScan({ devices: [], notRead: "" });
            if (!/Nothing on USB\./.test(r.text)) return "an empty successful scan lost its result";
            if (/did not run/i.test(r.text)) return "a successful scan claimed to have failed";
            return null;
        });

    acheck("...and a PARTIAL probe keeps the devices it did manage to see, under " +
           "the failure — a partial reading is still a reading",
        async () => {
            const r = await runScan({
                scanError: "One controller did not answer.",
                notRead: "",
                devices: [{ likelyBoard: true, family: "Developing-tank stirrer", vid: "1a86",
                            pid: "7523", identified: true, port: "COM7" }]
            });
            if (!/did not run/i.test(r.text)) return "the failure was dropped once devices existed";
            if (!/Developing-tank stirrer/.test(r.text)) return "the devices that WERE read were dropped";
            return null;
        });
}

/* ---------------------------------------------------------------------
 * CONTRACT C2 — the rented-GPU tier finally has a producer
 * ------------------------------------------------------------------- */
{
    const rowSrc = fnSource("renderApiSection");
    check("(setup) renderApiSection was lifted out of app.js", !!rowSrc);

    const connectBox = async () => {
        const dom = makeDom();
        const container = new dom.El("div");
        const calls = [];
        const win = {
            lcl: {
                cloudState: () => Promise.resolve({ endpoints: [], networkEnabled: true, config: {}, behaviours: {} }),
                modelIntel: () => Promise.resolve({ providers: [], models: [] }),
                connectCloud: (pasted, opts) => { calls.push([pasted, opts]); return Promise.resolve({ ok: false, error: "stub" }); },
                setBehavior: () => Promise.resolve({ ok: true })
            }
        };
        const render = new Function(
            "window", "document", "flash", "spinnerEl", "dialogFailed",
            "closeModal", "openConnections", "openProviderRates",
            "refreshModelPick", "$",
            rowSrc + "\nreturn renderApiSection;")(
            win, dom.document, () => {}, () => new dom.El("span"),
            async () => {}, () => {}, () => {}, () => {},
            async () => {}, () => new dom.El("div"));
        await render(container, () => {});
        await settle();
        return { dom, container, calls };
    };

    acheck("THE CONNECT BOX CAN DECLARE A RENTED ENDPOINT, AND THAT DECLARATION " +
           "REACHES connectCloud. The picker has had a GPU tier with no producer — " +
           "unreachable code, because nothing ever set the flag",
        async () => {
            const t = await connectBox();
            const box = t.container.querySelector(".cloud-rented-box");
            const prov = t.container.querySelector(".cloud-provider");
            const paste = t.container.querySelector(".cloud-paste");
            const btn = t.container.querySelector("button.primary");
            if (!box) return "no rented checkbox in the Connect box";
            if (!prov) return "no provider field in the Connect box";
            if (!paste || !btn) return "the Connect box lost its address field or its button";
            box.checked = true;
            box.dispatchEvent(t.dom.ev("change"));
            if (prov.disabled) return "ticking the box left the provider field disabled";
            prov.value = "Hourly Compute Co";
            paste.value = "gpu.example.test sk-key";
            btn.dispatchEvent(t.dom.ev("click"));
            await settle();
            if (!t.calls.length) return "Connect did not call connectCloud";
            const [pasted, opts] = t.calls[0];
            if (pasted !== "gpu.example.test sk-key") return "the pasted address did not arrive: " + pasted;
            if (!opts) return "connectCloud was called with no opts at all — the C2 seam is not wired";
            if (opts.rented !== true) return "opts.rented was " + JSON.stringify(opts.rented);
            if (opts.provider !== "Hourly Compute Co") return "opts.provider was " + JSON.stringify(opts.provider);
            return null;
        });

    acheck("...and an ordinary endpoint still connects, declaring itself NOT rented " +
           "rather than leaving the field undefined",
        async () => {
            const t = await connectBox();
            const paste = t.container.querySelector(".cloud-paste");
            paste.value = "192.168.1.20:11434";
            t.container.querySelector("button.primary").dispatchEvent(t.dom.ev("click"));
            await settle();
            const opts = t.calls[0] && t.calls[0][1];
            if (!opts) return "no opts forwarded";
            if (opts.rented !== false) return "opts.rented was " + JSON.stringify(opts.rented);
            if (opts.provider !== "") return "opts.provider was " + JSON.stringify(opts.provider);
            return null;
        });

    check("preload exposes connectCloud with the second argument, or nothing the " +
          "renderer sends can arrive",
        /connectCloud:\s*\(pasted,\s*opts\)\s*=>\s*ipcRenderer\.invoke\("lcl:connectCloud",\s*pasted,\s*opts\)/
            .test(fs.readFileSync(path.join(__dirname, "..", "app", "preload.js"), "utf8")));
}

/* ---------------------------------------------------------------------
 * FINDING 41 — the rename edit state is actually styled
 * ------------------------------------------------------------------- */
{
    const rule = /\.session-name\.editing\s*\{([^}]*)\}/.exec(cssCode);
    check("THE RENAME EDIT STATE HAS A HOME IN THE STYLESHEET. The class was added " +
          "by both rename paths and `grep -n editing styles.css` returned nothing — " +
          "clicking Rename changed nothing on screen at all",
        !!rule);
    const body = rule ? rule[1] : "";
    check("...and it CLIPS rather than ellipsising, so the tail of a long name is " +
          "visible while it is being typed instead of hidden behind \"…\"",
        /text-overflow:\s*clip/.test(body) && !/text-overflow:\s*ellipsis/.test(body) &&
        /overflow-x:\s*auto/.test(body), [body.replace(/\s+/g, " ").trim()]);
    check("...and it is built from the existing tokens — no hardcoded hex, no " +
          "hardcoded spacing or radius",
        /var\(--card-surface\)/.test(body) && /var\(--radius-sm\)/.test(body) &&
        /var\(--sp-1\)/.test(body) && !/#[0-9a-fA-F]{3,8}/.test(body) &&
        !/(padding|margin|border-radius|font-size):[^;]*\d+px/.test(body),
        [body.replace(/\s+/g, " ").trim()]);
    check("...and the failure state of the modal's copy button is styled too, so " +
          "\"Copy failed\" is visible and not just a tooltip",
        /#modal-copy\.copy-failed\s*\{[^}]*var\(--danger\)/.test(cssCode));
    check("...and a failed device scan is styled as a failure",
        /\.dev-row\.scan-failed\s*\{[^}]*var\(--danger\)/.test(cssCode));
    check("...and the rented-endpoint controls carry their own styling in tokens",
        /\.cloud-rented\s*\{/.test(cssCode) && /\.cloud-provider\s*\{/.test(cssCode) &&
        /\.session-menu-note\s*\{/.test(cssCode));
}


/* ---------------------------------------------------------------------
 * THIS PASS — the requested layout, checked where a static
 * read is the right tool and NOT where it is not.
 *
 * The interaction proofs for all of this live in devtools/ui-harness (scenes
 * composer, picker, space, handles, terminal, contrast, wraps, surfaces,
 * approval), because "does collapsing the sidebar widen the chat column" is a
 * question about a laid-out document and a regex cannot answer it. What is
 * checked below is the class of mistake a running DOM does NOT catch: a
 * hard-coded value that should be a token, a dead CSS fallback, a string that
 * was asked to be changed, and a path from the model into the shell.
 * ------------------------------------------------------------------- */
{
    /* ITEM 1 — the buttons are out of the input container, IN THE MARKUP.
       The harness proves where they paint; this proves the document says so,
       which is what stops someone "fixing" it back with a float. */
    const innerBlock = /<div id="composer-inner">([\s\S]*?)<\/div>\s*<div id="composer-tools">/
        .exec(html);
    check("THE MESSAGE FIELD CONTAINS THE MESSAGE FIELD. Four buttons lived inside " +
          "the rounded input, taking up space in the container where they were unwanted",
        !!innerBlock &&
        !/id="link-repo"|id="link-knowledge"|id="session-perms-btn"|id="mic-btn"/
            .test(innerBlock[1]),
        innerBlock ? innerBlock[1].replace(/\s+/g, " ").slice(0, 200) : "no #composer-tools");

    const toolsBlock = /<div id="composer-tools">([\s\S]*?)<div id="composer-hint">/.exec(html);
    check("...and all four are in the row below it, with the model picker",
        !!toolsBlock && ["link-repo", "link-knowledge", "session-perms-btn", "mic-btn",
                         "model-pick-wrap"].every(id => toolsBlock[1].includes('id="' + id + '"')));
    check("...IN THE ORDER THEY WERE IN — keeping their position",
        !!toolsBlock && (() => {
            const at = (id) => toolsBlock[1].indexOf('id="' + id + '"');
            return at("link-repo") < at("link-knowledge")
                && at("link-knowledge") < at("session-perms-btn")
                && at("session-perms-btn") < at("mic-btn");
        })());

    /* ITEM 2 — no colour left in the picker rows. */
    check("THE PICKER IS NOT MULTICOLOURED ANY MORE. Four per-kind tints on the " +
          "chips and one per tier on the headers were the clutter the tree replaced",
        !/\.model-kind\.(local|api|node|gpu)\s*\{[^}]*color:\s*#/.test(cssCode),
        "a per-kind colour rule is back in styles.css");
    check("...and the chip was not DELETED to get there — a readout is never removed " +
          "to tidy something up, only its colour was",
        /\.model-kind\s*\{/.test(cssCode) && /chip\.className = "model-kind "/.test(js));
    check("...an unreachable endpoint's rows are styled as refused, not hidden",
        /\.model-row\.offline\s*\{[^}]*opacity/.test(cssCode));

    /* ITEM 3 — the reading column is a token, and every track that used to be
       860px reads it. This is the actual fix for the UI not moving over fully
       to maximize the space. */
    check("THE READING COLUMN IS ONE TOKEN, not four copies of 860px",
        /--chat-col:/.test(cssCode) && /--chat-col-base:/.test(cssCode) &&
        !/max-width:\s*860px/.test(cssCode),
        "a hard-coded 860px column is still in styles.css");
    check("...and collapsing a panel widens it — declared per state, so the width " +
          "in each state can be read off the file and checked against the harness",
        /#body\.no-sidebar:not\(\.with-ws\)/.test(cssCode) &&
        /#body:not\(\.with-ws\)\s*\{[^}]*--chat-col/.test(cssCode));

    /* ITEM 3 — the toggles and the handles exist and are icons. */
    for (const id of ["sidebar-toggle", "workspace-toggle", "terminal-toggle", "btn-sidebar"]) {
        check(`#${id} is in the markup, is an SVG button, and carries no text label`,
            new RegExp(`id="${id}"[\\s\\S]{0,1400}?</button>`).test(html) &&
            new RegExp(`id="${id}"[\\s\\S]{0,600}?<svg`).test(html) &&
            !new RegExp(`id="${id}"[^>]*>\\s*[A-Za-z]`).test(html));
    }
    check("BOTH edge handles are the same species, and both are cards rather than " +
          "the six-pixel sliver reported as 'practically invisible'",
        /\.edge-handle\s*\{[^}]*var\(--card-surface\)/.test(cssCode) &&
        /\.edge-handle\s*\{[^}]*var\(--card-border(-hover)?\)/.test(cssCode));

    /* ...and the property that actually mattered. Pinning the token NAME let
     * the handle stay 22px wide while passing, which is what "practically
     * invisible" was. The width is the complaint, so the width is the check:
     * one spacing unit alone is a sliver, and it must be wider than that. The
     * harness measures the rendered pixels; this stops the CSS regressing back
     * on a day nobody runs Electron. */
    check("...and the resting width is more than a single spacing unit, because " +
          "22px against a dark panel edge is the thing that could not be found",
        (() => {
            const rule = (/\.edge-handle\s*\{([^}]*)\}/.exec(cssCode) || [, ""])[1];
            const w = (/width:\s*([^;]+);/.exec(rule) || [, ""])[1].trim();
            return w.length > 0 && !/^var\(--sp-\d\)$/.test(w);
        })(),
        (/\.edge-handle\s*\{[^}]*?width:\s*([^;]+);/.exec(cssCode) || [])[1]);

    /* ITEM 4 — CONTRACT K5, from the renderer side. */
    check("CONTRACT K5 — the terminal talks to main through the four named bridge " +
          "calls and nothing else",
        /window\.lcl\.terminalStart\(/.test(js) && /window\.lcl\.terminalWrite\(/.test(js) &&
        /window\.lcl\.terminalResize\(/.test(js) && /window\.lcl\.terminalKill\(/.test(js) &&
        /window\.lcl\.onTerminalData\(/.test(js));
    check("...and THE MODEL HAS NO PATH TO IT. terminalWrite is called from exactly " +
          "two places, both of them a real key or a real paste on the pane — not " +
          "from a tool result, a message, or anything the agent can reach",
        (() => {
            const sites = (js.match(/window\.lcl\.terminalWrite\(/g) || []).length;
            // the only definition of `send` in the terminal section, and the
            // handler it lives in, are both keyboard handlers
            return sites === 1 &&
                /termView\.addEventListener\("keydown"[\s\S]{0,900}?const send = \(data\) => \{ window\.lcl\.terminalWrite/
                    .test(js);
        })(), "terminalWrite is reachable from more than the keyboard");
    check("...the panel states that it is unsandboxed, in the markup, so it says so " +
          "even before main answers",
        /id="terminal-notice"[\s\S]{0,400}?unsandboxed/.test(html) &&
        /id="terminal-notice"[\s\S]{0,400}?no approval/.test(html));
    check("...and hiding the drawer does not kill the shell",
        /\$\("terminal-close"\)\.addEventListener\("click", \(\) => toggleTerminal\(false\)\)/.test(js) &&
        !/toggleTerminal[\s\S]{0,400}?terminalKill/.test(js));

    /* CONTRACT K3 — the renderer half exists and fails closed. */
    check("CONTRACT K3 — the renderer answers the approval card. Without this main " +
          "holds every remote turn for 120s and then denies it",
        /window\.lcl\.onRemoteApproval\(/.test(js) &&
        /window\.lcl\.answerRemoteApproval\(/.test(js));
    /* IT FAILS CLOSED, and the shape of that changed when the card came out of
     * a modal and into the transcript.
     *
     * The modal version relied on `(answer === "once" || answer === "always")
     * ? answer : "deny"` — Escape, the backdrop and the ✕ all landed on deny.
     * An inline card has nothing to dismiss, so the property has to be proven
     * differently: NOTHING IS SENT UNTIL AN ANSWER IS CLICKED. That holds iff
     * answerRemoteApproval is reachable from exactly one place, that place is
     * `send`, and every literal handed to `send` is one of the three verdicts
     * the contract defines. An unanswered card is then denied by main's own
     * 120-second timeout, which the card says out loud. */
    check("...and it FAILS CLOSED: answerRemoteApproval is called from exactly ONE " +
          "place, every verdict it can carry is one of the contract's three, and " +
          "none of them is reached without a click",
        (() => {
            const sites = (js.match(/window\.lcl\.answerRemoteApproval\(/g) || []).length;
            // the answers route through finish(receipt, allowed, verdict) now —
            // it prints the transcript receipt and dismisses the popup — so the
            // verdict literal is finish's third argument, not send's first
            const verdicts = [
                ...[...js.matchAll(/\bsend\("([a-z]+)"\)/g)].map(m => m[1]),
                ...[...js.matchAll(/\btrue, "([a-z]+)"\)|\bfalse, "([a-z]+)"\)/g)]
                    .map(m => m[1] || m[2])
            ].filter(Boolean);
            const legal = new Set(["once", "always", "trust", "deny"]);
            return sites === 1 && verdicts.length >= 3 &&
                verdicts.every(v => legal.has(v)) && verdicts.includes("deny");
        })(),
        "answerRemoteApproval is reachable from more than the answer buttons, or " +
        "carries a verdict main.js does not define");
    check("...and the card SAYS it is denied if it is left alone, because an inline " +
          "prompt has no Escape key to fail closed onto",
        /Leave this and it is denied/.test(js));

    /* ITEM 5 — the words and the contrast. */
    check("the old wording never comes back: a machine is ADDED, never " +
      "\"set up\", wherever that phrase still appears",
    !/Set up a machine/.test(js) && !/Set up a machine/.test(html));
    check("...and Add Local Node is gone from the global menu — a machine is " +
          "added from APIs & Connections, where the rest of its life happens",
        !/data-action="node-wizard"/.test(html) && !/"node-wizard":/.test(js));
    check("NO --card-surface IS USED AS IF IT WERE A COLOUR. It is a translucent " +
          "gradient and it is DECLARED, so `var(--card-surface, #111114)` painted a " +
          "4.5% white wash and the fallback could never apply — which is why the " +
          "session menu was see-through",
        !/var\(--card-surface,\s*[^)]+\)/.test(cssCode),
        "a var(--card-surface, fallback) is back — that fallback is dead code");
    check("...and the session menu has an opaque ground under the card effect",
        /\.session-menu\s*\{[^}]*background:\s*var\(--card-surface\),\s*#/.test(cssCode));
    check("THE COST CHIP IS INK FOR THE FLAT DARK TRANSCRIPT. The assistant " +
          "bubble is popped — the reply sits directly on the chat ground " +
          "(--bg #050505) — so .msg-cost is LIGHT ink again, measured against " +
          "that ground rather than the near-white bubble that no longer exists",
        (() => {
            const rule = /\.msg-cost\s*\{([^}]*)\}/.exec(cssCode);
            if (!rule) return false;
            const hex = /color:\s*#([0-9a-fA-F]{6})/.exec(rule[1]);
            if (!hex) return false;
            const n = parseInt(hex[1], 16);
            const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
            const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
            const L = 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
            // against the chat ground the flat reply sits on, --bg #050505
            const Lbg = 0.2126 * f(5) + 0.7152 * f(5) + 0.0722 * f(5);
            return (L + 0.05) / (Lbg + 0.05) >= 4.5;
        })(), "the cost chip would not reach 4.5:1 on the flat dark transcript");

    /* ITEM 6 — the header cannot print the word "undefined" again. */
    check("THE SESSION TITLE HAS A FALLBACK, the same one the session LIST has " +
          "always had — the header printed the string 'undefined' for any session " +
          "whose title had not been derived yet",
        /titleEl\.innerText = active \? \(active\.title \|\| "Untitled"\) : "\.lcl";/.test(js));

    /* A machine notice is not an answer. */
    check("A GUARD MESSAGE IS DRAWN AS THE APP SPEAKING, not as the model's reply — " +
          "'asked for an image of a donkey, got a refusal about closing apps to free " +
          "memory'",
        /meta\.guard/.test(js) && /"msg-guard"/.test(js) && /\.msg-guard\s*\{/.test(cssCode));

    /* =====================================================================
     * THE BAR IS SPLIT BY SCOPE.
     *
     * The harness opens each menu and reads its rows off the live DOM; these
     * are the invariants that must hold in the SOURCE, so a later edit cannot
     * quietly put a global setting back into the session menu. Scope is decided
     * by what an action WRITES, and each list below is that audit written down.
     * ===================================================================== */
    const menuOf = (name) => {
        const at = html.indexOf(`data-menu="${name}"`);
        if (at < 0) return null;
        const end = html.indexOf("</div>\n            </div>", at);
        const body = html.slice(at, end < 0 ? at + 4000 : end);
        return [...body.matchAll(/data-action="([^"]+)"/g)].map(m => m[1]);
    };
    const session = menuOf("session") || [];
    const global = menuOf("global") || [];

    check("THERE IS A SESSION MENU AND A GLOBAL MENU — global settings must not be " +
          "intermingled with session settings: a Session dropdown, then a Global one",
        session.length > 0 && global.length > 0, { session, global });

    const window_ = menuOf("window") || [];
    const you = menuOf("you") || [];

    /* Every item that writes data/sessions/<id>.json, and nothing else. API
     * FALLBACK is here now: which model THIS conversation may fall back to, and
     * whether it may pay, is a property of the conversation — API fallback
     * belongs in the session dropdown, not under global. */
    const SESSION_SCOPED = ["rename-session", "delete-session", "link-repo",
        "unlink-repo", "link-knowledge", "session-perms", "escalation",
        "ancient-knowledge", "answer-like", "scroll-bottom"];
    check("...every SESSION-SCOPED action is in the Session menu — API fallback " +
          "AND Ancient Knowledge included: rename/delete write the session record, " +
          "link/unlink write session.repoPath, link-knowledge writes " +
          "session.knowledgeIds, session-perms writes session.perms, escalation is " +
          "this conversation's fallback, ancient-knowledge is this conversation's " +
          "audit AGENT, and jump-to-latest acts on this transcript",
        SESSION_SCOPED.every(a => session.includes(a)),
        SESSION_SCOPED.filter(a => !session.includes(a)));
    check("...and NOTHING app-wide is in it",
        session.every(a => SESSION_SCOPED.includes(a)),
        session.filter(a => !SESSION_SCOPED.includes(a)));

    /* Global is now only what is genuinely app-wide: network, endpoints, models,
     * this machine. The window layout and the profile got their own menus. */
    // model-library MOVED OUT because it is a NODE tool: a model library scoped
    // to a linked node does not belong in the global dropdown. Its way in is now
    // a row under the node's own branch in the model picker — categorized where
    // it applies.
    // "Internet access" (toggle-network) LEFT the Global menu: internet is
    // a per-session decision, and linking an API turns it on automatically.
    // node-wizard left this list when the item left the menu: a machine is
    // added from APIs & Connections, which is where the rest of its life is
    // export-training LEFT Global for the Train menu: Export Training Data
    // should sit beside its own import, not in a separate location. Import and
    // export sit side by side under Train now.
    const GLOBAL_SCOPED = ["models", "default-model",
        "connections", "security", "machine", "spend",
        "focus-search"];
    check("...every GLOBAL action is in the Global menu — the endpoints, the " +
          "preferred model and this machine, all written once and read by every " +
          "session; the global internet switch is GONE",
        GLOBAL_SCOPED.every(a => global.includes(a)),
        GLOBAL_SCOPED.filter(a => !global.includes(a)));
    check("...and nothing session-scoped or window-level is in it",
        global.every(a => GLOBAL_SCOPED.includes(a)),
        global.filter(a => !GLOBAL_SCOPED.includes(a)));

    /* WINDOW AND YOU ARE THEIR OWN DROPDOWNS — Window and You are split out of
     * the global dropdown into their own dropdowns. */
    const WINDOW_SCOPED = ["toggle-sidebar", "toggle-workspace", "toggle-terminal", "toggle-motion"];
    check("WINDOW IS ITS OWN MENU, holding the panel toggles and background motion",
        window_.length > 0 && WINDOW_SCOPED.every(a => window_.includes(a)),
        { window: window_ });
    check("...and nothing but window layout is in it",
        window_.every(a => WINDOW_SCOPED.includes(a)), window_);

    // "You" became TRAIN — the menu should be called Train, not You. It holds
    // everything about
    // how .lcl learns: the profile, what it has learned (tone lives on that
    // page), and the training data going in and out as two NAMED items — the
    // import was hidden inside a page called "How it works with you", and the
    // export sat in a different menu (Global) from its own import.
    const TRAIN_SCOPED = ["profile", "learned", "import-training", "export-training"];
    const train = menuOf("train") || [];
    check("TRAIN IS ITS OWN MENU — profile, what-.lcl-has-learned, and Import + " +
          "Export Training Data as two named items side by side",
        train.length > 0 && TRAIN_SCOPED.every(a => train.includes(a))
        && !train.includes("ancient-knowledge"), { train });
    check("...and nothing but that is in it",
        train.every(a => TRAIN_SCOPED.includes(a)), train);
    check("...the You menu is GONE, the tailoring page is gone, and the export " +
          "no longer sits in Global away from its import",
        you.length === 0 && !js.includes("openTailoring")
        && !global.includes("export-training"), { you, global });

    /* CONTEXT NEVER STALE — the wiring this exposed. Every model
     * change funnels through refreshModelPick, whose tail re-derives the donut,
     * the plan ring and the cost meter; BOTH spark-mode switch paths call
     * modelSurfacesChanged (renderHeader alone repaints none of the surfaces —
     * measured); the live limit outranks the last turn's stamped window; the
     * picker's open-menu signature sees a window-only change; and the resident
     * mode highlight reads contextMax, the field the row actually carries. */
    check("every model change re-derives EVERY context surface: refreshModelPick's " +
          "tail refreshes ring + plan ring + cost meter",
        (() => {
            const i = js.indexOf("async function refreshModelPick");
            const body = js.slice(i, js.indexOf("\n}", js.indexOf("refreshCostMeter", i)) + 2);
            return /refreshContextRing\(\)/.test(body) && /refreshPlanRing\(\)/.test(body)
                && /refreshCostMeter\(\)/.test(body);
        })());
    check("...BOTH spark-mode switch paths call modelSurfacesChanged — the picker " +
          "fold and the node dashboard",
        (js.match(/modelSurfacesChanged\(\)\.catch/g) || []).length >= 2);
    check("...the donut's denominator prefers the LIVE selection's window over the " +
          "window stamped on the last turn",
        js.includes("(!lim.assumed && lim.limit) || metaWindow || lim.limit"));
    check("...the live window is captured from cloudState's limits — the branch " +
          "describeSelection left dead",
        js.includes("ses.contextLength = Number(st.limits.contextLength)"));
    check("...the picker's open-menu signature includes contextMax, so a " +
          "window-only change repaints an open menu",
        /m\.active, m\.contextMax\]\)/.test(js));
    check("...the resident-mode highlight reads contextMax — the field listModels " +
          "actually puts on the row — not the contextLength it renames away",
        js.includes("Number(drv && (drv.contextMax || drv.contextLength))"));
    check("EVERY ASYNC MODE CONTROL HAS A TRANSITIONAL STATE — the " +
          "polish standard: the clicked target answers instantly (pending), the " +
          "stale highlight drops, the model rows narrate reloading/loading/" +
          "unloading, and BOTH callers (picker fold + node dashboard) carry it",
        /let switching = null;/.test(js)
        && /st\.classList\.add\("loading"\)/.test(js)
        && /"unloading/.test(js)
        && /b\.classList\.add\("pending"\)/.test(js)
        && /\.mode-btn\.pending/.test(cssCode || require("fs").readFileSync(
               require("path").join(__dirname, "..", "app", "renderer", "styles.css"), "utf8"))
        , null);
    check("...and shrinking the window below the conversation's size raises the " +
          "one-time notice with a Compact action",
        js.includes("The context window just shrank") &&
        (() => {
            const i = js.indexOf("The context window just shrank");
            return /Compact it now/.test(js.slice(i, i + 600));
        })());

    check("'PATCH .LCL ITSELF' HAS ITS OWN DROPDOWN — and the PERMISSIONS menu is " +
          "GONE: permissions are session-scoped, under Session › Permissions, " +
          "the tools CONSOLIDATED to one slider per GROUP (no master dial, no " +
          "per-tool dropdowns) writing the SESSION's own toolPolicy through the " +
          "floor-clamped kernel path",
        (menuOf("patch") || []).includes("patch-bay") &&
        menuOf("permissions") === null &&
        html.includes(">Permissions…<span") &&
        js.includes("window.lcl.setSessionToolPolicy(sid, toolName, level)") &&
        !js.includes("perm-tool-row") && !js.includes("perm-bulk"),
        { patch: menuOf("patch"), permissions: menuOf("permissions") });
    check("THE PERMISSIONS PANEL IS OUT OF THE KNOWLEDGE MENU — it was there with " +
          "http_fetch and web_search inside it, which is granting network capability " +
          "from a dropdown about reference material",
        !(menuOf("knowledge") || []).includes("capabilities"), menuOf("knowledge"));

    /* =====================================================================
     * THE INLINE PERMISSION PROMPT.
     * ===================================================================== */
    check("THE PROMPT ASKS AT THE COMPOSER — never a modal, and no longer a " +
          "transcript card either: it floats in #perm-popup-layer directly " +
          "above the input and goes away when answered, leaving a one-line " +
          "receipt — a popup that appears near the chat input and goes away " +
          "when clicked. The layer is in the MARKUP, so it is " +
          "one element the whole app shares rather than one built per ask.",
        /function buildInlinePrompt\(/.test(js)
        && /permPopupShow\(prompt\)/.test(js)
        && !/chat\.appendChild\(prompt\)/.test(js)
        && /id="perm-popup-layer"/.test(html));
    check("...with THREE answers on a capability: only this once, allow for this " +
          "conversation, deny",
        /id: "once", label: "Only this once"/.test(js) &&
        /id: "session", label: "Allow for this conversation"/.test(js) &&
        /id: "deny", label: "Deny"/.test(js));
    check("...and the 'for this conversation' grant is SESSION SCOPED — it is held " +
          "per session id and writes NO app-wide tool policy. A session-scoped " +
          "answer that quietly edits the global policy is the defect, not the fix",
        /const sessionCapabilityGrants = new Map\(\)/.test(js) &&
        !/function grantCapabilityForSession\([\s\S]{0,600}?setToolPolicy/.test(js));
    check("...an action that cannot be undone is never covered by a standing grant",
        /const permanent = proposal\.tool === "delete_file"/.test(js) &&
        /if \(!permanent\) \{[\s\S]{0,200}?id: "session"/.test(js));
    check("THE POINTER IS BUILT AND IT IS LOUD — its own panel with a border, an " +
          "uppercase label and a real button, because 'most people just click yes " +
          "and dont read'",
        /"perm-prompt-where"/.test(js) &&
        /\.perm-prompt-where\s*\{[^}]*border:\s*1px solid var\(--attn\)/.test(cssCode) &&
        /\.perm-prompt-where-label\s*\{[^}]*text-transform:\s*uppercase/.test(cssCode));
    /* THIS CHECK USED TO ENFORCE THE REGRESSION. It pinned the exact global
       wording ("Permissions > What .lcl can do > ...") and, by extension, the
       openCapabilities() link beside it — so every time the per-session
       consolidation was reapplied, this test dragged the app-wide framing back.
       A test that holds a bug in place is worse than no test. It now enforces
       the requirement: the capability footer points at
       THIS conversation's permissions, never the global panel. */
    check("the capability footer points at SESSION permissions, not the app-wide " +
          "panel — permissions are per-conversation, and \"Allow for this " +
          "conversation\" writes the same per-session policy that sheet reads",
        (() => {
            const a = js.indexOf("Allow ${proposal.tool.replace");
            const b = js.indexOf("onAnswer:", a);
            const card = a >= 0 && b > a ? js.slice(a, b) : "";
            return /onOpen: \(\) => openSessionPerms\(\)/.test(card) &&
                   /Session\s*[›>]\s*Permissions/.test(card) &&
                   !/openCapabilities/.test(card);
        })());
    check("...and the global framing is gone everywhere — no footer claims a row " +
          "\"sets the default for every session\"",
        !/sets the default for every session/.test(js));

    /* =====================================================================
     * ONE KNOWLEDGE UI — CONTRACT K6.
     * ===================================================================== */
    check("CONTRACT K6 — the renderer asks knowledgeLibraries() and openKnowledgeDoc()",
        /window\.lcl\.knowledgeLibraries\(\)/.test(js) &&
        /window\.lcl\.openKnowledgeDoc\(doc\.id\)/.test(js));
    check("THERE IS ONE KNOWLEDGE UI, NOT TWO — the second surface (openShelf, under " +
          "'Read the knowledge…') is gone from the code and from the menu, and one " +
          "menu item opens the one panel",
        !/function openShelf\(/.test(js) && !/data-action="read-knowledge"/.test(html) &&
        (menuOf("knowledge") || []).includes("knowledge"));
    check("...EXTRACTED TEXT IS NEVER READ AS A DOCUMENT: readKnowledgeDoc, the page " +
          "reader over knowledge/text/*.txt, is not called anywhere in the renderer",
        !/window\.lcl\.readKnowledgeDoc\(/.test(js));
    check("...and a K6 refusal is FINAL — the legacy viewer is a fallback for a build " +
          "with no K6, never a second opinion on a refusal, because asking a different " +
          "bridge the same question is how a guard gets walked around",
        /if \(res === null\) \{[\s\S]{0,300}?viewKnowledgeFile/.test(js));
    check("...a source that was never downloaded is a STATE WITH AN ACTION, not the " +
          "dead end 'not on disk'",
        /function paintNeedsFetch\(/.test(js) &&
        /"Download it"/.test(js) && /still indexed/.test(js));
    check("...and the shipped corpus and the added folders are ONE list, told apart " +
          "by a tag rather than by living in two dropdowns",
        /ships with \.lcl/.test(js) && /added by you/.test(js) &&
        /\.kb-tag\.added\s*\{/.test(cssCode));

    /* ---- THE BADGE, THE ORDER, AND AN HONEST DOWNLOAD-ALL ----
     * "a badge that appears in the knowledge dropdown, prefixing the Knowledge
     * button ... when there is knowledge in the source list, that is not
     * downloaded to the machine. this would reenable the download all button,
     * if disabled but also host the newest at the top, for the source
     * knowledge, not the user added" */
    const mainKb = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
    check("KNOWLEDGE BADGE — a span prefixes the Knowledge menu label, painted " +
          "from a count cheap enough to ask at boot (never the inventory walk)",
        /id="kb-badge"/.test(html) &&
        /function kbPaintBadge\(/.test(js) &&
        /kbBadgeFromBoot\(\);/.test(js) &&
        /window\.lcl\.knowledgeMissingCount\(\)/.test(js) &&
        /\.menu-badge\s*\{/.test(cssCode) &&
        /lcl:knowledgeMissingCount/.test(mainKb));
    check("...the badge and the button both count the FETCHABLE — missing " +
          "sources WITH a recorded URL, exactly what a click will start; the " +
          "label used to promise sourcesMissing while the batch attempted only " +
          "the with-URL subset",
        /const fetchable = lib\.docs\.filter\(d => !d\.sourceOnDisk && d\.sourceUrl\)\.length;/.test(js) &&
        /"Download all \(" \+ fetchable \+ "\)"/.test(js) &&
        /fetchable/.test(mainKb));
    check("...the shipped shelf hosts the NEWEST at the top — not-yet-downloaded " +
          "sources float first (fetchable ahead of URL-less), stable within " +
          "bands, and the user's own libraries are never reordered this way",
        /a\.sourceOnDisk \? 2 : \(a\.sourceUrl \? 0 : 1\)/.test(mainKb));
    check("...and opening the panel paints a WAIT WITH A FACE — the list shows " +
          "'reading the shelf…' instead of sitting blank for the whole " +
          "inventory walk, which read as 'takes really long to open'",
        /loadingNote\("reading the shelf…"/.test(js));
}

(async () => {
    for (const [name, fn] of failures) {
        let why = null;
        try { why = await fn(); }
        catch (e) { why = "threw: " + ((e && e.stack) || e); }
        check(name, !why, why ? String(why).split("\n") : null);
    }
    await settle(4);
    check("NO PROMISE THE RENDERER MAKES IS LEFT UNHANDLED. A clipboard write " +
          "whose rejection nobody catches is not just a silent failure — it is a " +
          "dead renderer process",
        unhandled.length === 0, unhandled);
    
/* ========== A READOUT NOBODY CALLS IS A READOUT THAT DOES NOT EXIST ====== */
{
    // A build whose context panel passed every single UI check still never
    // showed the context donut in normal use.
    //
    // refreshContextRing() had exactly ONE caller — inside
    // compaction — so nothing redrew it when a turn finished, when a session
    // was opened, or at startup. It could not appear in normal use.
    //
    // The ui-harness passed throughout because IT calls the function itself. A
    // painted-pixels harness proves a thing RENDERS and says nothing about
    // whether the app ever asks it to. These check the half that was missing.
    const callsOf = (fn) => {
        const calls = (js.match(new RegExp("\\b" + fn + "\\(\\)", "g")) || []).length;
        const defs = (js.match(new RegExp("function\\s+" + fn + "\\s*\\(", "g")) || []).length;
        return calls - defs;
    };
    const renderBody = (() => {
        const start = js.indexOf("function renderMessages(");
        if (start < 0) return "";
        const end = js.indexOf("\n}", start);
        return end < 0 ? "" : js.slice(start, end);
    })();

    check("THE CONTEXT RING IS REDRAWN FROM renderMessages — the ring describes " +
          "the conversation on screen, so hanging it off the render is what " +
          "stops a future path drawing a transcript and forgetting the readout " +
          "that belongs with it",
        /refreshContextRing\(\)/.test(renderBody), renderBody.slice(-160));
    check("...so it has more callers than the single one it shipped with, " +
          "which was inside compaction and therefore unreachable until you had " +
          "already compacted",
        callsOf("refreshContextRing") >= 2, callsOf("refreshContextRing"));
    check("the context PANEL is reachable by clicking the ring, not only from " +
          "code the user cannot run",
        /contextRingWrap\.addEventListener\("click"/.test(js)
        && /openContextPanel\(\)/.test(js), null);
    check("...and clicking the ring no longer COMPACTS on the spot — that was a " +
          "permanent rewrite of the conversation on a single mis-click, with " +
          "no preview and nothing to undo it",
        !/addEventListener\("click", \(\) => compactConversation\(\)\)/.test(js), null);
}

/* ============= A CLASS THE STYLESHEET NEVER HEARD OF IS A LIE ============ */
{
    // The context panel's Compact button shipped as class="btn" — a class that
    // does not exist in styles.css — so the panel's one action rendered as
    // bare browser chrome, at the very bottom of that page.
    // The id checks above could not catch it, because the id was used;
    // the CLASS was the phantom. So: every class attribute in the markup must
    // resolve to a class the stylesheet styles or the renderer toggles.
    const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(R, "styles.css"), "utf8");
    const used = new Set();
    for (const m of html.matchAll(/class="([^"]+)"/g)) {
        for (const c of m[1].trim().split(/\s+/)) used.add(c);
    }
    const phantom = [...used].filter(c =>
        !new RegExp("\\." + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(css)
        && !js.includes(c));
    check("EVERY CLASS THE MARKUP WEARS EXISTS in the stylesheet or the " +
          "renderer — class=\"btn\" on the panel's one action button, with no " +
          ".btn anywhere, is how it rendered as bare browser chrome",
        phantom.length === 0, phantom);
}

/* ====== THE SIDEBARS: PINNED FOOTER, BOUNDED RESIZEABLE SECTIONS ========= */
{
    const css = fs.readFileSync(path.join(R, "styles.css"), "utf8");
    // left: the list scrolls, the panel does not — that is the whole footer
    // anchored on the line start: a bare indexOf("#sidebar {") matches inside
    // "#body.no-sidebar > #sidebar {" first and reads the wrong rule
    const sidebarAt = css.indexOf("\n#sidebar {");
    const sidebar = css.slice(sidebarAt, sidebarAt + 1400);
    check("THE SESSION LIST IS THE SCROLL REGION, so the machine readout is a " +
          "pinned footer in any window tall enough to hold it — the memory " +
          "readout is locked in place at the bottom of the left sidebar, not " +
          "part of the sessions container. The sidebar keeps its " +
          "own overflow-y as the short-window fallback, because the OTHER " +
          "measured failure was a footer clipped 62px past the bottom edge " +
          "with no scrollbar — pinned where physically " +
          "possible, scrollable where not, clipped never",
        /overflow-y:\s*auto/.test(sidebar), sidebar.slice(0, 200));
    const list = css.slice(css.indexOf("#session-list {"), css.indexOf("#session-list {") + 900);
    check("...the list flexes, scrolls its own overflow, and has a REAL floor — " +
          "min-height: 0 here is how the primary navigation once measured one " +
          "pixel tall",
        /flex:\s*1 1 auto/.test(list) && /overflow-y:\s*auto/.test(list)
        && /min-height:\s*1\d\dpx/.test(list), list.slice(0, 260));

    // right: the panel is MODULES — grip to pick-and-place, divider on every
    // boundary to resize. The first cut used CSS corner grips, which put the
    // resize in the opposite location from where anyone would expect it.
    // These pin the replacement.
    check("THE CORNER GRIPS ARE GONE — resize: vertical put a tiny triangle in " +
          "each section's bottom-right, and dragging it grew the section from " +
          "the wrong edge. Resizing lives on the BOUNDARY now. (A textarea " +
          "keeping its native grow handle is fine; a panel SECTION is not.)",
        (() => {
            for (const id of ["#task-panel {", "#activity-panel {",
                              "#ws-files {", "#ws-viewer {"]) {
                const i = css.indexOf(id);
                if (i >= 0 && css.slice(i, css.indexOf("}", i))
                        .includes("resize:")) return false;
            }
            return true;
        })(), null);
    check("EVERY SECTION IS A MODULE: a wrapper with a grip strip to drag it " +
          "somewhere else, and its section as the inner block",
        css.includes(".sb-mod {") && css.includes(".sb-mod-grip {")
        && css.includes(".sb-mod:has(> .sb-mod-inner.hidden)"), null);
    check("...five of them, one per function of the panel",
        ["tasks", "activity", "wscard", "files", "preview"].every(k =>
            html.includes('data-mod="' + k + '"')), null);
    check("THE HANDLES ARE THE CONTAINER'S OWN EDGES — bottom for height " +
          "(ns-resize), inner side for width (ew-resize), corner for both. " +
          "Grab the bottom, or any edge, and drag that container's height " +
          "and width",
        css.includes(".sb-h-bottom {") && css.includes("cursor: ns-resize")
        && css.includes(".sb-h-side {") && css.includes("cursor: ew-resize")
        && css.includes(".sb-h-corner {"), null);
    check("...and the drag sizes THE CARD THE OPERATOR GRABBED — the bottom " +
          "edge sets that card's own height (g.cardH), a delta on where it " +
          "started, and NOBODY ELSE MOVES ('one container affects another' " +
          "was the failure). The one shared control left is the vertical " +
          "column boundary, and every handle double-clicks back to default",
        js.includes("sbAttachHandles")
        && js.includes("gLive.cardH[sbKey(mod)] = Math.max(58,")
        && js.includes("g0.cardH + (ev.clientY - y0)")
        && js.includes("g0.colSplit + ((ev.clientX - x0) / quadSpan.w) * 100")
        && js.includes("g0.colW + wSign * (ev.clientX - x0)")
        && !js.includes("g.rowSplit") && !js.includes("gLive.rowSplit")
        && js.includes('addEventListener("dblclick", () => reset(')
        && js.includes("sbLayout(gLive);")
        && js.includes("sbSaveGrid(gLive);"), null);
    check("...EVERY EDGE AND BOTH BOTTOM CORNERS ARE LIVE — 'i want to be " +
          "able to fully drag any corner': left, right, bottom, and the two " +
          "corners all wired, in the code and in the CSS",
        ["sb-h-side", "sb-h-right", "sb-h-bottom", "sb-h-corner", "sb-h-corner-r"]
            .every(c => js.includes('"' + c + '"') && css.includes("." + c + " {")), null);
    check("...and the REJECTED DESIGN'S SAVED STATE DIES ONCE — a version " +
          "stamp clears v1's column modes, splits and order at first boot, so " +
          "stale records from a layout the operator refused cannot wreck the " +
          "default quadrant he specified",
        js.includes('localStorage.getItem("lcl-sb-v") !== "2"')
        && js.includes('localStorage.setItem("lcl-sb-v", "2");'), null);
    check("...MINIMIZED IS A CLASS AND A KEY, MOVED TOGETHER — column mode " +
          "and pop-out expand through sbSetMin, so a reload can never " +
          "resurrect a tray bar the operator left expanded",
        js.includes("function sbSetMin")
        && (js.match(/sbSetMin\(mod, false\)/g) || []).length >= 2
        && !js.includes('mod.classList.remove("sb-minimized");'), null);
    check("...and the track math holds at the edges the review broke it on: " +
          "a lone quad card gets ONE column (no dead half), columns with no " +
          "quadrant SHARE the panel instead of left-anchoring beside dead " +
          "space, and a saved column width is clamped against the LIVE panel " +
          "so a wide monitor's record cannot crush the quadrant to zero",
        js.includes('} else tracks.push("minmax(0, 1fr)");')
        && js.includes('if (!quad.length) { tracks.push("minmax(0, 1fr)"); continue; }')
        && js.includes("Math.min(Math.round(w), maxW)"), null);
    check("a task row in a narrow cell keeps its COUNT and ETA — words wrap " +
          "whole (never mid-word, never an ellipsis eating the live numbers) " +
          "and the tooltip carries the full line",
        /\.task-title \{[^}]*overflow-wrap: normal;/s.test(css)
        && js.includes("row._title.title = row._title.innerText;"), null);

    /* "you are using text labels for buttons, like clear and refresh, etc.
     * no, stop doing that it is a SPACE HOG" — panel controls are icons with
     * tooltips, never words eating a card's width. */
    check("PANEL BUTTONS ARE ICONS, NOT WORDS — Clear, Refresh and Clear-marks " +
          "carry an svg and a tooltip, and no sidebar header button spends its " +
          "card's width on a text label",
        ["task-panel-clear", "activity-clear", "ws-refresh",
         "ws-clear-marks", "machine-refresh"].every(id => {
            const i = html.indexOf('id="' + id + '"');
            if (i < 0) return false;
            const b = html.slice(i, html.indexOf("</button>", i));
            return b.includes("icon-only") && b.includes("<svg")
                && b.includes("title=") && !/>\s*(Clear|Refresh|Clear marks)\s*</.test(b);
        }), null);

    /* "this session had history of that is no longer present after the
     * patch" — the in-memory feed dies with a restart, but the transcript
     * already persists every consequential step. An empty feed rebuilds
     * itself; a feed the operator CLEARED stays cleared. */
    check("THE ACTIVITY FEED SURVIVES A RESTART — an empty feed rehydrates " +
          "from the transcript's persisted steps, a cleared one stays " +
          "cleared, and a rebuilt row shows an honest dot instead of a " +
          "fabricated timestamp",
        js.includes("function hydrateActivityFromTranscript")
        && js.includes("!activityCleared.has(active.id)")
        && js.includes("activityCleared.add(active.id);")
        && js.includes(': "·";'), null);

    /* "did not complete and prompted me for input, but the prompt never
     * appeared, it was waiting on something that it never asked me, but said
     * it was asking me" — a turn's result is applied by the sendText call
     * awaiting it, and that promise dies with a renderer reload or a dropped
     * IPC reply. The status event is the one signal that always arrives. */
    check("AN ORPHANED COMPLETION STILL LANDS — when the active session " +
          "settles (idle, failed, waiting, approval) and no live send in this " +
          "renderer owns it, paintSessionStatus refetches from disk and " +
          "repaints, so the ask can never exist only as a status line",
        (() => {
            const i = js.indexOf("function paintSessionStatus");
            if (i < 0) return false;
            const b = js.slice(i, i + 4200);
            return b.includes('["idle", "failed", "waiting", "approval"].includes(st.state)')
                && b.includes("!pendingSessions.has(sessionId)")
                && b.includes("window.lcl.getSession(sessionId)")
                && b.includes("renderMessages(active.messages);");
        })(), null);
    check("...order, splits AND per-card modes persist per machine — and the " +
          "wrapping-row era's per-card px keys have no writer left, so a " +
          "stale lcl-sb-h-* value can never shape the quadrant",
        js.includes("lcl-sb-order") && js.includes("lcl-sb-grid")
        && js.includes("lcl-sb-col-")
        && !js.includes('localStorage.setItem("lcl-sb-h-')
        && !js.includes("SB_H_KEY +") && !js.includes("SB_W_KEY +"), null);
    check("...the stack SCROLLS when the user sizes past the panel — " +
          "nothing is ever crushed to make room",
        (() => { const i = css.indexOf("#sb-mods {");
                 return css.slice(i, i + 900).includes("overflow-y: auto"); })(),
        null);
    check("...and the fixed info card gets no height handle — stretching an " +
          "info card only stretches whitespace",
        js.includes("if (!spec.fixed) {"), null);
    check("CARDS OWN THEIR SIZE, COLUMNS OWN THEIR FLOW — each quadrant " +
          "column is an INDEPENDENT flex stack (.sb-colwrap) that scrolls " +
          "past its own overflow ('the cards heights affect the cards below, " +
          "in the adjacent column' is structurally dead), an unsized card " +
          "caps near half the panel with its inner block scrolling, and a " +
          "dragged card floors at 58px legibility",
        js.includes('rows.push("minmax(0, 1fr)");')
        && js.includes("function sbWrap(")
        && js.includes("host.clientHeight * 0.48")
        && (() => { const i = css.indexOf(".sb-colwrap {");
                    const b = css.slice(i, i + 400);
                    return b.includes("flex-direction: column")
                        && b.includes("overflow-y: auto"); })()
        && /\.sb-mod-inner \{[^}]*overflow: auto;/.test(css), null);
    check("EVERY COLUMN EARNS ITS WIDTH OR IT DOES NOT EXIST — no card column " +
          "below SB_CARD_MIN_W (the 470px panel squished file names into " +
          "single-character noodles, measured): own-column cards FOLD back " +
          "into the flow (Preview last), a panel that cannot afford two " +
          "readable columns stacks one, and a saved column width is clamped " +
          "so the quadrant keeps its minimum",
        js.includes("const SB_CARD_MIN_W = 200;")
        && js.includes("fitW(quadColsFor() + cols.length) < SB_CARD_MIN_W")
        && js.includes("quad.push(cols.pop());")
        && js.includes("quadCols * SB_CARD_MIN_W"), null);
    check("...and a FILE NAME NEVER WRAPS into a vertical noodle — one line, " +
          "ellipsis, full name on the tooltip",
        /\.ws-file \.nm \{[^}]*text-overflow: ellipsis;/.test(css)
        && /\.ws-file \.nm \{[^}]*white-space: nowrap;/.test(css), null);
    check("SESSION ROWS DO NOT COMPRESS. When the list became a bounded flex " +
          "scroll region its children could still shrink, so instead of a " +
          "scrollbar the ROWS were squeezed — titles crushed, nothing " +
          "technically overflowing. Every list child keeps natural height",
        css.includes("#session-list > * { flex: 0 0 auto; }"), null);
    check("the machine dock is its own compartment: one container for the " +
          "memory bar, node readouts, load card and engine line, pinned with " +
          "margin-top auto and its own boundary rule",
        css.includes("#machine-dock {") && css.includes("margin-top: auto;")
        && html.includes('id="machine-dock"'), null);

    /* ---- THE QUADRANT DOCK (24 Aug) ----
     * "i feel like ordering is important here ... the right side bar should
     * be a quadrant, like a true hero section card would be. righ now all
     * the borders touch, i would rather them be their own containers, within
     * that sidepanel. and two columns ... 1 = Tasks 2 = Workspace
     * 3 = Activity 4 = Files ... with position 5, being Preview and it being
     * its own third column, when active." */
    check("THE DOCK IS A GRID OF CARDS. #sb-mods is display:grid with a gap, " +
          "each .sb-mod its own container — border, radius, its own ground — " +
          "instead of bands whose borders touch",
        (() => { const i = css.indexOf("#sb-mods {");
                 return css.slice(i, i + 600).includes("display: grid")
                     // real breathing room — "the borders touch" was reported
                     && css.slice(i, i + 600).includes("gap: 8px"); })()
        && (() => { const i = css.indexOf(".sb-mod {");
                 const b = css.slice(i, i + 700);
                 return b.includes("border: 1px solid var(--line)")
                     && b.includes("border-radius: var(--radius-sm)"); })(), null);
    check("...the DEFAULT ORDER is the operator's numbering — tasks, wscard, " +
          "activity, files into 1|2 over 3|4 — saved as THE COLUMNS " +
          "THEMSELVES ({c1,c2,rest}), a card already dropped in a column " +
          "KEEPS it, and a newcomer takes ITS saved slot, never 'the " +
          "emptier column' (arrival order must not reshape the quadrant)",
        js.includes('["tasks", "wscard", "activity", "files", "preview"]')
        && js.includes('{ c1: ["tasks", "activity"], c2: ["wscard", "files"] }')
        && js.includes("const slotOf = (m)")
        && js.includes("JSON.stringify({ c1, c2, rest })")
        && js.includes("if (inWrap(m)) continue;"), null);
    check("...OWN COLUMN is a real mode: a header button toggles it, the card " +
          "becomes a full-height track beside the columns (in the content " +
          "row BELOW the tray, never covering a minimized bar), the choice " +
          "persists, and Preview is born a column — 'position 5, being " +
          "Preview and it being its own third column, when active'",
        js.includes("function sbToggleCol")
        && js.includes('"sb-colbtn"')
        && js.includes("String(trayN + 1)")
        && js.includes("SB_COL_DEFAULT = { preview: true }"), null);
    check("...MINIMIZED CARDS RISE TO THE TRAY AT THE TOP of the sidebar " +
          "container — 'the cards minimize to the bottom of the page, not " +
          "the top of the sidebar container. its you being backwards' — " +
          "tray rows FIRST, then the single content row the columns fill",
        js.includes('m.style.gridColumn = "1 / -1";')
        && js.includes("String(i + 1)")
        && (() => { const i = js.indexOf("const rows = [];");
                 const b = js.slice(i, i + 300);
                 return b.indexOf('rows.push("auto")') > -1
                     && b.indexOf('rows.push("auto")') < b.indexOf('rows.push("minmax(0, 1fr)")'); })(), null);
    check("...A FLOATING CARD'S CONTROLS TELL THE TRUTH: the pop-out and " +
          "column buttons vanish while popped, and the minimize button is " +
          "the way home — 'we dont need the pop out button when popped out, " +
          "we need the minimize button to minimize the popped out window " +
          "back into the tray to its slot'",
        css.includes(".sb-mod.sb-popped > .sb-mod-head .sb-pop,")
        && css.includes(".sb-mod.sb-popped > .sb-mod-head .sb-colbtn { display: none; }")
        && (() => { const i = js.indexOf('mkBtn("sb-min"');
                 return i >= 0 && js.slice(i, i + 400)
                     .includes("sbDock(mod); return;"); })(), null);
    check("...the grip drop logic still splits on X beside a neighbor and on " +
          "Y across rows, and every mid-drag reorder RE-LAYS the grid so the " +
          "cards follow the pointer instead of freezing until release",
        js.includes("ev.clientX < r.left + r.width / 2")
        && js.includes("other.before(mod); sbLayout(); placed = true; break;")
        && js.includes("other.after(mod); sbLayout(); placed = true; break;")
        // crossing into the other column moves the card INTO that column,
        // and a column's open ground below its cards is a drop target too
        && js.includes("const cross = other.parentElement !== mod.parentElement")
        && js.includes("w.appendChild(mod); sbLayout();"), null);
    check("...and the layout pass keeps its era-crossing guards: the rAF " +
          "debounce under the sbFillSlack name every caller still speaks, " +
          "the observer stop, the zero-size bail (a collapsed panel keeps " +
          "its height), and refreshes from the panel-width drag and the " +
          "expand-after-slide",
        js.includes("function sbFillSlack")
        && js.includes("function sbLayout")
        && js.includes("if (!sbApplying) sbFillSlack();")
        && js.includes("!host.clientHeight || !host.clientWidth")
        && (() => {
            const i = js.indexOf('$("ws-resize").addEventListener');
            const t = js.indexOf("function toggleWorkspace");
            return i >= 0 && js.slice(i, i + 1200).includes("sbFillSlack()")
                && t >= 0 && js.slice(t, t + 1600).includes("sbFillSlack()");
        })(), null);
    check("POP STATE SURVIVES A RELOAD, and reordering while a section floats " +
          "keeps its dock spot — the saved order reads a placeholder as the " +
          "module it stands for",
        js.includes("if (pop) sbTogglePop(m);")
        && js.includes('el.classList.contains("sb-mod-placeholder")')
        && js.includes("? el.dataset.for : (el.dataset.mod || null)"), null);
    check("A FLOATING CARD'S GRIP IS INERT — sbGripDrag bails on sb-popped " +
          "(else the drag re-parents the floating card into the dock beside " +
          "its own placeholder), mirroring sbPopDrag's own guard",
        (() => {
            const i = js.indexOf("function sbGripDrag");
            return i >= 0 && js.slice(i, i + 600)
                .includes('if (mod.classList.contains("sb-popped")) return;');
        })(), null);
    check("THE SAVED GEOMETRY SURVIVES A RESTORE — sbSavePop refuses a 0×0 " +
          "rect (a hidden or pre-layout card), and a pop that FOUND a saved " +
          "record does not immediately re-save clamped values over it",
        js.includes("if (!r.width && !r.height) return;")
        && js.includes("if (!saved) sbSavePop(mod);"), null);
    check("HIDING A POPPED SECTION DOCKS IT FIRST — no floating orphan the " +
          "dock calls hidden",
        js.includes('if (!cb.checked && m.classList.contains("sb-popped")) sbDock(m);'),
        null);
    check("THE PANEL COLLAPSES FROM ITS OWN HEAD — 'a true hero section " +
          "that is collapsable': the chevron in #workspace-head calls " +
          "toggleWorkspace(false), and the collapse SLIDES (the body grid " +
          "animates its columns; visibility flips after; the border goes so " +
          "the closed panel is zero wide)",
        html.includes('id="ws-collapse"')
        && js.includes('$("ws-collapse").addEventListener')
        && !/#workspace\.collapsed \{[^}]*display: none/.test(css)
        && /#workspace\.collapsed \{[^}]*visibility: hidden/.test(css), null);

    /* ---- MODELS & API, REBUILT (10 Aug, night) ---- */
    check("THE ADD BOX IS A MAINSTAY of API's & Connections: ONE connectBox " +
          "builder rendered in EVERY state, so the GO chip cannot ship in " +
          "only the empty branch again — it is a mainstay button that was " +
          "hidden",
        js.includes("const connectBox = ")
        && js.includes("container.appendChild(connectBox())")
        && !js.includes('innerText = "Connect another"'), null);
    check("EVERY LINKED ENDPOINT IS A CARD with its own Test / Refresh / " +
          "Disconnect keyed on ITS id — one control row that only spoke " +
          "for the selected endpoint is gone",
        js.includes("const epCard = ")
        && js.includes("cards.appendChild(epCard(ep))")
        && js.includes("window.lcl.testCloudEndpoint(ep.id)")
        && js.includes("window.lcl.unlinkCloudEndpoint(ep.id)"), null);
    check("the pricing table reads AS a table: a labelled header row, " +
          "capped width, right-aligned tabular numerals, and locked rates " +
          "render as figures (borderless) until Edit rates arms them",
        js.includes("pref-rate-head")
        && css.includes(".pref-rate-head {")
        && /\.pref-rate-in \{[^}]*font-variant-numeric: tabular-nums/.test(css)
        && css.includes(".pref-rate-in[readonly]"), null);
    check("'using undefined on api.deepinfra.com' cannot paint again: the " +
          "in-use badge only names a model when config actually holds one",
        js.includes("&& st.config.model) badge("), null);

    /* ---- MODEL ORCHESTRATION save path (review fixes) ---- */
    check("THE PAY-FOR-API TOGGLE IS PER SESSION — it defaults from THIS " +
          "conversation's escalateTo, never the global switch (which showed " +
          "another session's state)",
        js.includes("cb.checked = !!(active.escalateTo && active.escalateTo.length)"), null);
    check("A FREE LOCAL NODE IS NEVER ARMED AS PAID — the derived fallback " +
          "allowlist filters to PAID endpoints (remote && !localNode), so a " +
          "free-only plan cannot trip the paid-fallback machinery",
        js.includes("m.remote && !m.localNode)")
        && js.includes("paidEps.has(v.endpointId)"), null);
    check("...and turning the toggle OFF clears only THIS session (escalateTo " +
          "empty), never disabling other sessions; ON arms the app-wide gate " +
          "that each session still re-gates on its own",
        js.includes("if (payOn) await window.lcl.setEscalation(true)")
        && /payOn\s*\?[\s\S]{0,200}:\s*\[\]/.test(js), null);
}


/* ============ UX CALLOUTS, PINNED ======================================== */
{
    const css = fs.readFileSync(path.join(R, "styles.css"), "utf8");
    const html = fs.readFileSync(path.join(R, "index.html"), "utf8");
    // 1. the model selector should be grouped so a provider like DeepInfra is
    //    clickable to view the models under it, not expanded all the time —
    //    there could be any number of connected APIs
    check("PROVIDERS ARE COLLAPSIBLE BRANCHES inside their tier — a vendor's " +
          "92-model catalogue opens on ITS click, not on the tier's",
        js.includes('"model-provider"')
        && js.includes("modelMenu._providers")
        && css.includes(".model-provider-body.hidden { display: none; }"), null);
    check("...closed by default except the branch answering right now — the " +
          "open/closed decision moved into the shared `fold` helper when the " +
          "picker grew a third level (mode -> product family -> endpoint), so " +
          "this pins the DECISION rather than the line it used to live on",
        js.includes('b.className = "model-provider-body" + (open ? "" : " hidden")')
        && js.includes("const open = sub.rows.some(x => x.active);"), null);
    /* THIS PIN REQUIRED THE BUG.
     *
     * It asserted `fam.label && subs.length > 1` — two distinct endpoint records
     * before a family folder would draw at all. That extra condition made the
     * whole tree contingent on the store holding two records, and
     * when two OpenCode subscriptions sat in one slot the folder silently
     * never rendered. Four builds of "it works here" against "it is exactly as
     * it was" turned on that comparison, and this test was holding it in place.
     *
     * The guarantee it was protecting — no vendor wrapped in a folder of itself
     * — is carried by fam.label, which is null for anything with no family. The
     * count never had anything to do with it. */
    check("...and a PRODUCT FAMILY folder (OpenCode over Zen and GO) opens on " +
          "the same rule, and exists because the endpoint BELONGS to a family — " +
          "not because two of them happen to be linked",
        js.includes("if (fam.label) {")
        && !js.includes("subs.length > 1")
        && js.includes('fold(fam.label, fam.rows.length, open, "model-family")'), null);
    check("...and a vendor with NO family still never gets one, because fam.label " +
          "is null for it — the distinction is the family, not the count",
        js.includes("famIdx.set(k, { label: m.providerFamilyLabel || null, rows: [] });")
        || js.includes("famIndex.set(key, { key, label: m.providerFamilyLabel || null, rows: [] });"),
        null);
    check("...and BOTH pickers do it. The chat picker keeps its own copy of the " +
          "grouping loop, which is how the family level first landed only in the " +
          "reusable one — a real change, in the picker that is rarely opened",
        (js.match(/model-family/g) || []).length >= 2
        && (js.match(/providerFamily/g) || []).length >= 2, null);
    check("...and the filter opens matching provider branches, one level down " +
          "from the tiers — a match inside a closed branch is a match nobody " +
          "sees",
        js.includes("modelMenu._providers || []"), null);

    // 2. the model library is scoped to a linked node, but it was placed in
    //    the global dropdown
    check("THE MODEL LIBRARY LIVES UNDER THE NODE'S OWN BRANCH in the picker, " +
          "and is gone from the global dropdown — a node tool categorized " +
          "where it applies",
        // renamed to "Local Models"
        js.includes("Local Models — add or remove models on this machine…")
        && !html.includes('data-action="model-library"'), null);

    // 3. adding a provider like GO to the APIs should be simple
    check("THE CONNECT BOX OFFERS PRESET CHIPS — OpenCode GO fills GO's OWN " +
          "base URL (opencode.ai/zen/go/v1, from the published docs: GO is a " +
          "separate provider with its own catalog) and Zen fills the " +
          "pay-per-token gateway at opencode.ai/zen/v1",
        js.includes('mkPreset("OpenCode GO", "https://opencode.ai/zen/go/v1"')
        && js.includes('mkPreset("OpenCode Zen", "https://opencode.ai/zen/v1"')
        && js.includes('mkPreset("DeepInfra"'), null);
    check("...and the GO chip carries plan:'go-window' through the bridge to " +
          "the endpoint record, which is what arms the meter for its sessions",
        js.includes('"go-window"') && js.includes("plan: presetPlan"), null);

    // 4. the GO controls should only be visible when a GO model is selected
    check("THE GO STRIP IS PLAN-GATED: no windowed plan on this session's " +
          "endpoint, no strip — a per-token vendor is not metered in windows",
        js.includes("u.planless") && js.includes("window.lcl.usageWindow(active ? active.id : null)"),
        null);

    // 5. smoothness — overlays enter instead of appearing
    check("EVERY OVERLAY ENTERS instead of appearing: one duration, one ease, " +
          "scrims fade and panels rise, with reduced-motion honoured",
        css.includes("@keyframes lclFadeIn") && css.includes("@keyframes lclRiseIn")
        && css.includes("animation: none;"), null);
}

/* ---- clarify "Other…" opens a REAL inline input (from the design notes) ---- */
{
    check("an 'Other…' button is offered when the model allows a free answer",
        js.includes('otherBtn.innerText = "Other…"') && js.includes("meta.offer"));
    check("...and it reveals a REAL text input inline, not a pointer at the composer",
        js.includes('inp.type = "text"') && js.includes("choice-other-input")
        && js.includes("wrap.classList.remove(\"hidden\")"));
    check("...Enter or the send arrow submits the typed answer as the reply",
        js.includes("e.key === \"Enter\"") && /const submit = \(\) => \{[\s\S]*sendMessage\(\);/.test(js));
    check("...an empty answer is refused (focus back), never sent as blank",
        /if \(!v\) \{ inp\.focus\(\); return; \}/.test(js));
    check("...and the input is actually styled (a real field, not an invisible one)",
        css.includes(".choice-other-input input") && css.includes(".choice-other-send"));
}

/* ---- the window takes the front, and the transcript shows the document ---- */
{
    const mainSrc = fs.readFileSync(path.join(R, "..", "main.js"), "utf8");
    check("a taskbar/pinned click AND the tray click share ONE hardened restore " +
          "path — second-instance calls showMainWindow, which un-skips the " +
          "taskbar, shows, and surfaces the window",
        /app\.on\("second-instance"[\s\S]{0,900}showMainWindow\(\);/.test(mainSrc)
        && /function showMainWindow\(\)[\s\S]{0,1800}setSkipTaskbar\(false\)/.test(mainSrc)
        && /tray\.on\("click", showMainWindow\)/.test(mainSrc));
    // NO ALWAYS-ON-TOP ANYWHERE. Both the synchronous z-bump AND the earlier
    // 300ms deferred pulse stranded the window topmost:
    // it sat over everything, so clicking another taskbar icon opened that app
    // BEHIND .lcl and read as "the taskbar is dead until .lcl is minimized". A
    // user-initiated tray/taskbar click already takes the foreground, so the
    // restore path is restore+show+focus and NOTHING may raise .lcl above the
    // user's other work — no setAlwaysOnTop, no moveTop, anywhere in main.
    check("the restore never pins the window — no setAlwaysOnTop or moveTop CALL " +
          "remains in main, so the window can never strand itself on top",
        !/\.setAlwaysOnTop\(/.test(mainSrc) && !/\.moveTop\(/.test(mainSrc));
    check("...and showMainWindow surfaces via restore + show + focus (user input " +
          "is allowed the foreground without any topmost hack)",
        /function showMainWindow\(\)[\s\S]{0,1800}isMinimized\(\)[\s\S]{0,200}restore\(\)/.test(mainSrc)
        && /function showMainWindow\(\)[\s\S]{0,2000}\.show\(\)[\s\S]{0,300}\.focus\(\)/.test(mainSrc));
    check("...and the tray registers click ONLY — a double-click restore double-" +
          "fired and read as a flicker",
        !/tray\.on\("double-click"/.test(mainSrc));
    check("...and first launch takes the front instead of opening behind other apps",
        /ready-to-show/.test(mainSrc)
        && /TAKE THE FRONT ON LAUNCH/.test(mainSrc));
    const agentSrc = fs.readFileSync(path.join(R, "..", "..", ".lcl.engine", "core", "agent.js"), "utf8");
    check("a write's DOCUMENT rides the tool message (msg.written), not just the receipt",
        /written: String\(call\.args\.content\)\.slice\(0, 40_000\)/.test(agentSrc));
    check("...and the chat row renders it: click a write_file row, see what was written",
        js.includes("msg.written") && js.includes("wr-written")
        && css.includes(".work-row .wr-written"));

    // THE APPROVAL DIALOG CLOSES ON ANSWER, AND NAMES THE RIGHT TOGGLE.
    // Reported: clicking "allow for this conversation" left the dialog sitting
    // open while the tool ran, instead of closing it.
    // The cause was `await doApprove()` in onAnswer, which held the card on
    // "Running…" for the whole tool run. Answer must record the decision, fire
    // the action WITHOUT awaiting, and dismiss the card.
    check("the tool-approval dialog no longer AWAITS the action before resolving — the run does not hold the dialog open",
        !/await doApprove\(\)/.test(js));
    check("...it dismisses the card on answer (closes), instead of sitting there",
        /card\.remove\(\)/.test(js) && /onAnswer:\s*\(id, st\) =>/.test(js));
    check("the dialog names the SPECIFIC capability group it grants, not a generic 'Tools' switch",
        js.includes("proposal.capabilityLabel"));
    check("...and the staged proposal carries that group + its human label from the engine",
        /capability: verdict\.capability/.test(agentSrc) && /capabilityLabel:/.test(agentSrc));
    // the 'Connected hardware' group must have a real label + order slot, or its
    // slider renders the raw id 'device.write' and sorts last
    const capSrc = fs.readFileSync(path.join(R, "..", "..", ".lcl.engine", "core", "capabilities.js"), "utf8");
    check("the device.write capability group has a human label ('Connected hardware') and an order slot",
        /"device\.write":\s*"Connected hardware"/.test(capSrc)
        && /CAP_ORDER = \[[^\]]*"device\.write"/.test(capSrc.replace(/\n/g, " ")));
}

console.log(`\n${pass}/${pass + fail} renderer wiring checks passed`);
    process.exit(fail ? 1 : 0);
})();
