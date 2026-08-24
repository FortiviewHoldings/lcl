/**
 * THE KNOWLEDGE PANEL — is the shipped shelf the focal point, and does an HTML
 * document render as a PAGE rather than as its own source code?
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

app.disableHardwareAcceleration();
const ROOT = path.join(__dirname, "..", "..");
const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1300, height: 850, show: false,
        webPreferences: { preload: path.join(__dirname, "preload-stub.js"),
                          contextIsolation: false, nodeIntegration: true, sandbox: false }
    });
    await win.loadFile(path.join(ROOT, "app", "renderer", "index.html"));
    await wait(1200);
    const js = (s) => win.webContents.executeJavaScript(s, true);

    let pass = 0, fail = 0;
    const check = (n, c, d) => { c ? pass++ : fail++;
        console.log(`${c ? "PASS" : "FAIL"} | ${n}${c || d === undefined ? "" : "  <- " + JSON.stringify(d).slice(0, 220)}`); };

    await js(`openKnowledge()`);
    await wait(1500);

    const s = await js(`(() => {
        const groups = [...document.querySelectorAll(".kb-group")];
        const shipped = groups.find(g => (g.querySelector(".kb-tag") || {}).textContent === "ships with .lcl");
        return {
            groups: groups.length,
            hasShipped: !!shipped,
            shippedOpen: shipped ? shipped.classList.contains("open") : null,
            shippedExpanded: shipped ? (shipped.querySelector(".kb-group-toggle") || {}).getAttribute?.("aria-expanded") : null,
            shippedDocsVisible: shipped ? shipped.querySelectorAll(".kb-doc").length : 0,
            addBtnIsGhost: (document.getElementById("kb-add") || {}).className || ""
        };
    })()`);

    check("the knowledge panel lists libraries", s.groups > 0, s);
    check("THE SHIPPED SHELF IS EXPANDED ON OPEN — it is the focal point, not a " +
          "collapsed row next to a folder button",
        s.hasShipped && s.shippedOpen === true && s.shippedExpanded === "true", s);
    check("...and its documents are visible without a click", s.shippedDocsVisible > 0, s);
    check("the add-a-folder button stays a quiet ghost, not the primary action",
        /ghost/.test(s.addBtnIsGhost) && !/primary/.test(s.addBtnIsGhost), s.addBtnIsGhost);

    /* HTML rendering: drive paintKnowledgeDoc directly with an html payload */
    const h = await js(`(() => {
        paintKnowledgeDoc({ kind: "text", name: "page.html", ext: ".html",
            content: "<h1>Hello</h1><p>A <b>real</b> page.</p>" },
            { title: "page.html", file: "page.html" });
        const v = document.getElementById("kb-view");
        const fr = v.querySelector("iframe.kb-html");
        return {
            iframe: !!fr,
            sandboxed: fr ? fr.getAttribute("sandbox") === "" : null,
            usesSrcdoc: fr ? (fr.srcdoc || "").includes("<h1>Hello</h1>") : null,
            hasSourceToggle: !!v.querySelector(".kb-html-toggle") || !!document.querySelector(".kb-html-toggle"),
            notJustCode: !!fr
        };
    })()`);

    check("AN HTML DOCUMENT RENDERS AS A PAGE — there was no branch for .html at " +
          "all, so it drew as syntax-highlighted markup",
        h.iframe === true, h);
    check("...in a sandboxed frame with no scripts and no same-origin, so the " +
          "offline promise holds",
        h.sandboxed === true, h);
    check("...showing the actual document", h.usesSrcdoc === true, h);
    check("...with a way to see the source when that is what you want",
        h.hasSourceToggle === true, h);

    fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "out", "knowledge.png"),
        (await win.webContents.capturePage()).toPNG());

    console.log(`\n${pass}/${pass + fail} knowledge checks passed`);
    app.exit(fail ? 1 : 0);
});
