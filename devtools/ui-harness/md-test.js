/**
 * THE MARKDOWN PREVIEWER, AGAINST REAL MARKDOWN.
 *
 * "i doubt it is a full fledged markdown previewer that can actually handle
 *  anything markdown" — correct, it was not. This runs the REAL renderMarkdown
 * out of app.js against a document using the constructs real documents use, and
 * asserts the DOM that comes back. Not "it produced something": the right
 * elements, nested the right way.
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

app.disableHardwareAcceleration();
const ROOT = path.join(__dirname, "..", "..");
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const DOC = [
    "Setext Title",
    "============",
    "",
    "## A heading with trailing hashes ##",
    "",
    "Some **bold**, some *italic*, some ~~struck~~ text and `inline code`.",
    "",
    "- top level",
    "  - nested one",
    "    - nested two",
    "- back to top",
    "",
    "1. first",
    "2. second",
    "   1. sub-numbered",
    "",
    "- [ ] an unfinished task",
    "- [x] a finished task",
    "",
    "| Column A | Column B |",
    "|----------|----------|",
    "| one      | two      |",
    "",
    "> a quote",
    "",
    "![a diagram](./diagram.png)",
    "",
    "A bare link https://example.com/page and an autolink <https://example.org>.",
    "",
    "```js",
    "const x = 1;",
    "```"
].join("\n");

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 900, height: 700, show: false,
        webPreferences: { preload: path.join(__dirname, "preload-stub.js"),
                          contextIsolation: false, nodeIntegration: true, sandbox: false }
    });
    await win.loadFile(path.join(ROOT, "app", "renderer", "index.html"));
    await wait(1200);

    const js = (s) => win.webContents.executeJavaScript(s, true);
    let pass = 0, fail = 0;
    const check = (n, c, d) => { c ? pass++ : fail++;
        console.log(`${c ? "PASS" : "FAIL"} | ${n}${c || d === undefined ? "" : "  <- " + JSON.stringify(d).slice(0, 200)}`); };

    const r = await js(`(() => {
        const el = renderMarkdown(${JSON.stringify(DOC)});
        document.body.appendChild(el);
        const q = (s) => el.querySelectorAll(s).length;
        return {
            h1: q("h1"), h2: q("h2"),
            h2text: (el.querySelector("h2") || {}).textContent || "",
            strong: q("strong"), em: q("em"), del: q("del"), code: q("code"),
            nestedUl: q("ul ul"), deepUl: q("ul ul ul"), nestedOl: q("ol ol"),
            tasks: q("input.md-task"),
            tasksChecked: [...el.querySelectorAll("input.md-task")].filter(b => b.checked).length,
            table: q("table"), th: q("th"), td: q("td"),
            quote: q("blockquote"),
            imgOrPlaceholder: q("img.md-img") + q(".md-img-missing"),
            links: q(".md-link"),
            pre: q("pre") + q("code.hljs") + q(".code-block"),
            html: el.innerHTML.length
        };
    })()`);

    check("SETEXT HEADING (Title over ===) becomes an h1, not a paragraph and a rule",
        r.h1 === 1, r);
    check("ATX heading renders, and its decorative trailing ### is not shown",
        r.h2 >= 1 && !/#/.test(r.h2text), r.h2text);
    check("bold, italic and inline code all render as their own elements",
        r.strong >= 1 && r.em >= 1 && r.code >= 1, r);
    check("STRIKETHROUGH ~~text~~ renders as <del> — it used to be literal tildes",
        r.del === 1, r);
    check("NESTED LISTS actually nest — two levels deep inside the parent list, " +
          "instead of every item flattened to the left margin",
        r.nestedUl >= 1 && r.deepUl >= 1, r);
    check("...and an ordered list nests too", r.nestedOl >= 1, r);
    check("TASK LISTS render real checkboxes, one of them checked",
        r.tasks === 2 && r.tasksChecked === 1, r);
    check("tables render with a header row and body cells",
        r.table === 1 && r.th === 2 && r.td === 2, r);
    check("blockquotes render", r.quote === 1, r);
    check("IMAGES render as an image or a marked placeholder — never as grey " +
          "link-styled alt text",
        r.imgOrPlaceholder >= 1, r);
    check("bare URLs and <autolinks> are both picked up",
        r.links >= 2, r);
    check("fenced code blocks render as code", r.pre >= 1, r);

    fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "out", "markdown.png"),
        (await win.webContents.capturePage()).toPNG());

    console.log(`\n${pass}/${pass + fail} markdown checks passed`);
    app.exit(fail ? 1 : 0);
});
