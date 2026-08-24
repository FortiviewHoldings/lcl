/**
 * IN-CHAT MARKDOWN RENDERS, FOR REAL. Reported: replies came back as raw
 * markdown (backticks, #, pipes, [text](url)). The renderer handled headings/
 * bold/italic/code/lists but NOT links, bare URLs, tables, or __underscore__
 * emphasis, and one throwing construct could leave the whole reply raw.
 *
 * This drives the ACTUAL syntax.js against a tiny DOM stub and asserts the
 * output is real structure — links become <a class="md-link"> with the right
 * href, tables become <table>, __bold__ becomes <strong> — and that no markdown
 * punctuation survives as literal text. (Also verified visually in the browser.)
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 200) : ""); }
}

/* ---- a DOM stub just big enough for syntax.js ---- */
function mkNode(tag) {
    return {
        tag, kids: [], attrs: {}, _cls: "", text: null,
        appendChild(c) { this.kids.push(c); return c; },
        prepend(c) { this.kids.unshift(c); return c; },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        set className(v) { this._cls = v; }, get className() { return this._cls; },
        set textContent(v) { this.text = String(v); this.kids = []; },
        set innerText(v) { this.text = String(v); },
        set title(v) { this.attrs.title = String(v); }, get title() { return this.attrs.title || ""; },
        set innerHTML(v) { if (v === "") this.kids = []; }, get innerHTML() { return ""; },
        querySelectorAll() { return []; }, querySelector() { return null; },
        addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }
    };
}
global.document = {
    createElement: (t) => mkNode(t),
    createTextNode: (t) => ({ tag: "#text", text: String(t), kids: [] }),
    createElementNS: (_ns, t) => mkNode(t)
};
global.window = {};
global.navigator = { clipboard: { writeText() { return Promise.resolve(); } } };

// run syntax.js (an IIFE that sets window.lclSyntax) against the stub
eval(fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "syntax.js"), "utf8"));
check("syntax.js exposes renderMessageBody", !!(global.window.lclSyntax && global.window.lclSyntax.renderMessageBody));

const sample = [
    "# Heading",
    "Some **bold** and *italic* and `code` and __also bold__.",
    "A [path link](C:/Users/x/preview.gif) and https://github.com/o/r.git",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |"
].join("\n");

const root = mkNode("div");
global.window.lclSyntax.renderMessageBody(root, sample, { markdown: true });

const links = [], tds = [];
let tables = 0, strongs = 0, ems = 0, codes = 0, headings = 0, rawText = "";
(function walk(n) {
    if (!n) return;
    if (n.tag === "a" && /md-link/.test(n._cls || "")) links.push(n.attrs["data-href"]);
    if (n.tag === "table") tables++;
    if (n.tag === "strong") strongs++;
    if (n.tag === "em") ems++;
    if (n.tag === "code") codes++;
    if (/^md-h/.test(n._cls || "")) headings++;
    if (n.tag === "td") tds.push(n);
    if (n.tag === "#text") rawText += n.text;
    (n.kids || []).forEach(walk);
})(root);

check("markdown link becomes an <a class=md-link> with the exact path href",
    links.includes("C:/Users/x/preview.gif"), links);
check("a bare URL is auto-linked", links.includes("https://github.com/o/r.git"), links);
check("a GitHub-style table becomes a real <table> with cells", tables === 1 && tds.length === 2, { tables, cells: tds.length });
check("__underscore__ AND **asterisk** bold both render (two <strong>)", strongs >= 2, strongs);
check("italic and inline code still render", ems >= 1 && codes >= 1, { ems, codes });
check("the heading renders as a heading, not raw #", headings === 1, headings);
check("NO markdown punctuation survives as literal text",
    !/[#`|]/.test(rawText) && !rawText.includes("](") && !rawText.includes("__"), JSON.stringify(rawText));

/* ---- a throwing construct never leaves raw markup (try/catch fallback) ---- */
const src = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "syntax.js"), "utf8");
check("renderMessageBody has a try/catch fallback so one bad construct can't dump raw",
    /function renderMessageBody\(container, text, opts\) \{\s*try \{/.test(src)
    && /renderMessageBodyInner/.test(src));

/* ---- app.js wires clickable/copiable link behaviour ---- */
const appjs = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
check("app.js opens URL links and copies path links",
    /closest\("a\.md-link"\)/.test(appjs) && /openExternal\(href\)/.test(appjs) && /copyToClipboard\(href\)/.test(appjs));

console.log(`\n${pass}/${pass + fail} markdown-render checks passed`);
process.exit(fail ? 1 : 0);
