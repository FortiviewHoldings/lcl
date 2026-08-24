/**
 * A PERSON READS THE DOCUMENT. A MODEL READS THE EXTRACTION.
 *
 * Reported from a real install: the knowledge viewer was unreadable — the
 * document came out with missing characters and letters and mangled
 * formatting, looking as though text had been stripped out of the PDFs.
 *
 * The diagnosis was not that the extraction was bad. It was that the extraction
 * was being SHOWN. pdf.js returns a page as positioned text items; joining them
 * back into prose is lossy by nature, and it is meant to be — it exists so
 * retrieval can find a passage and the model can be handed one. It was never a
 * reading surface, and using it as one made a working feature look broken.
 *
 * The requirement: show the real document — a rendered PDF when it is one, or
 * markdown rendered as markdown, whichever reads better. Extracted text should
 * not appear on any human-facing surface; it stays available for search and
 * for grounding the model when a document is added to the session.
 *
 * So: a PDF is rendered as a PDF in Chromium's own viewer, markdown is rendered
 * as markdown, and no human-facing surface shows extracted text while the
 * document itself is on disk.
 *
 * MEASURED, NOT ASSUMED: the frame-src decision below came from running four
 * candidate policies in a real Electron window with this app's exact settings
 * (sandbox:true, contextIsolation:true) and counting rendered pixels —
 * 'none' blocked it at 10k dark pixels, 'self' rendered the page at 592k.
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

const ROOT = path.join(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const viewerSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "viewer.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "index.html"), "utf8");
const vHtmlSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "viewer.html"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");
const vCssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "viewer.css"), "utf8");

/* ------------------------------------------------ the reader returns a document */
check("THE ONE READER ANSWERS 'pdf' FOR A PDF — it used to fall through to the " +
      "binary branch, which is why a PDF offered its extracted text instead of " +
      "itself",
    (() => {
        const i = mainSrc.indexOf("function readFileForViewer");
        const body = mainSrc.slice(i, i + 2200);
        return /ext === "\.pdf"/.test(body) && /kind: "pdf"/.test(body);
    })());

check("...and hands back a file URL rather than the bytes, so a 100 MB " +
      "reference book costs nothing over IPC and streams like any local file",
    /pathToFileURL\(full\)\.href/.test(mainSrc));

check("...and the pdf branch is decided BEFORE the binary check, or a PDF is " +
      "still classed as an undrawable blob",
    (() => {
        const i = mainSrc.indexOf("function readFileForViewer");
        const body = mainSrc.slice(i, i + 2200);
        return body.indexOf('kind: "pdf"') < body.indexOf("isProbablyBinary");
    })());

/* ------------------------------------------------------------ every surface */
for (const [where, src] of [
    ["the knowledge document modal", appSrc],
    ["the pop-out viewer window", viewerSrc]
]) {
    check(`${where} renders a pdf as a pdf`,
        /res\.kind === "pdf"/.test(src) && /fr\.src = res\.fileUrl/.test(src));
}

/* THE TWO SHELVES BECAME ONE PANEL (a design contract), so these follow the
 * guarantee to where it now lives. `showDocument` and the shelf's own reader
 * are gone; `openKnowledgeDoc` is the single entry point and `paintKnowledgeDoc`
 * is the single painter. Nothing here relaxes: the same three properties are
 * asserted against the surface that replaced the old one. */
check("the knowledge panel opens the REAL document, instead of paging through " +
      "its extraction",
    /async function openKnowledgeDoc\(doc, lib\)/.test(appSrc) &&
    /window\.lcl\.openKnowledgeDoc\(doc\.id\)/.test(appSrc) &&
    /function paintKnowledgeDoc\(res, doc\)/.test(appSrc));

// INVERTED, DELIBERATELY. The old rule was "fall back to the extraction for the
// built-in corpus, because the extraction is all that ships". The requirement
// since is that extracted text is never shown anywhere, and the design contract
// makes it binding — extracted text backs search and is never shown as a
// document. So a
// built-in whose source was never downloaded must offer the FETCH and say search
// still works, which is strictly more than the extraction ever told anyone.
check("...and a BUILT-IN document whose source was never downloaded is NOT " +
      "answered with its extraction — it gets the fetch, and the fact that " +
      "search still works. 'not on disk' was the whole of the old answer",
    /function paintNeedsFetch\(/.test(appSrc) &&
    /needsFetch: true/.test(appSrc) &&
    /searchBacked/.test(appSrc) &&
    // and the painter has no extraction path left to fall into
    !/findFirstText\(/.test(appSrc));

check("NO SURFACE OFFERS THE EXTRACTED TEXT AS A CONSOLATION PRIZE any more",
    !/The knowledge reader can page through its/.test(appSrc) &&
    !/no text layer to show\. The knowledge reader/.test(appSrc));

/* ------------------------------------------------- the policy that allows it */
check("THE MAIN WINDOW ALLOWS A SAME-ORIGIN FRAME — without frame-src it " +
      "inherited default-src 'none' and Chromium refused the PDF outright " +
      "(measured: ERR_BLOCKED_BY_CSP, frame-src blocked file)",
    /frame-src 'self'/.test(htmlSrc));

check("...as does the pop-out window, which allowed data: frames only",
    /frame-src 'self' data:/.test(vHtmlSrc));

check("...and the policy is not loosened any further than that: no wildcard, " +
      "no remote origin, nothing that could frame something off the network",
    (() => {
        const m = /frame-src ([^;"]*)/.exec(htmlSrc);
        const v = (m && m[1]) || "";
        return !/\*/.test(v) && !/https?:/.test(v);
    })(), (/frame-src ([^;"]*)/.exec(htmlSrc) || [])[1]);

/* --------------------------------------------------------------- it is sized */
check("the document frame is given real reading room, not a strip",
    /\.kdoc-pdf \{/.test(cssSrc) && /height: min\(78vh, 1100px\)/.test(cssSrc));
check("...and fills the pop-out window, which exists only to show one document",
    /\.kdoc-pdf \{/.test(vCssSrc) && /calc\(100vh/.test(vCssSrc));
check("...and fills the knowledge panel's reading pane",
    /\.kb-view \.kb-pdf \{[^}]*height:/.test(cssSrc));

/* -------------------------------------------- the extraction still does its job */
check("THE EXTRACTION IS UNTOUCHED — it exists for retrieval and for grounding " +
      "the model, and removing it to fix a reading surface would have deleted " +
      "the feature instead of fixing it",
    (() => {
        const k = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "knowledge.js"), "utf8");
        return /groundingBlock/.test(k) && /PASSAGE_CHARS/.test(k);
    })());
check("...and the search path still reads it",
    /lcl:readKnowledgeDoc/.test(mainSrc));

console.log(`\n${pass}/${pass + fail} document-viewing checks passed`);
process.exit(fail ? 1 : 0);
