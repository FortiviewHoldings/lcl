/**
 * The pop-out viewer window's whole brain.
 *
 * Which file to show arrives in the query string, written by openFileWindow in
 * main. Content arrives through the same lcl:viewFile IPC the in-panel viewer
 * uses — root-contained to the session's linked folder, size-capped, binary-
 * detected. This window adds nothing to what the panel could already reach; it
 * only gives it its own OS frame:
 *
 *     "i would also like to be able to open in a new window. and that be a
 *      framed pop out, fully sizeable in this ui"
 */
const params = new URLSearchParams(location.search);
const sessionId = params.get("session") || "";
const relPath = params.get("rel") || "";

const $ = (id) => document.getElementById(id);

function note(text) {
    const el = document.createElement("div");
    el.className = "ws-note";
    el.innerText = text;
    return el;
}

function fmtBytes(n) {
    return n < 1024 ? `${n} B`
        : n < 1048576 ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
}

async function render() {
    const body = $("v-body");
    $("v-name").innerText = relPath || "?";
    $("v-name").title = relPath;
    body.innerHTML = "";
    body.appendChild(note("reading…"));

    let res = null;
    try { res = await window.lcl.viewFile(sessionId, relPath); }
    catch (e) { res = { error: String(e && e.message || e) }; }
    body.innerHTML = "";

    if (!res || res.error) {
        body.appendChild(note((res && res.error) || "could not read file"));
        return;
    }

    document.title = res.name + " — .lcl";
    $("v-size").innerText = fmtBytes(res.size);

    if (res.kind === "pdf") {
        // the document itself, in Chromium's own viewer — never its extraction
        const fr = document.createElement("iframe");
        fr.className = "kdoc-pdf";
        fr.src = res.fileUrl;
        body.appendChild(fr);
    } else if (res.kind === "image") {
        const img = document.createElement("img");
        img.className = "viewer-image";
        img.src = res.dataUri;
        img.alt = res.name;
        body.appendChild(img);
    } else if (res.kind === "binary") {
        body.appendChild(note("binary file — no preview"));
    } else if (/\.(html?|svg)$/i.test(res.name)) {
        // RENDER it — "you have the open in new window, for something like a
        // .html or something that can be rendered." A page popped out into its
        // own window should look like the page, with the source one click away.
        //
        // The iframe is sandboxed with NO grants: scripts, forms, popups and
        // same-origin access are all off, so this renders markup and styles
        // and cannot run anything. The window's CSP additionally has no
        // network sources, so a page referencing remote assets shows gaps
        // rather than phoning out.
        const bar = document.createElement("div");
        bar.className = "viewer-modebar";
        const src = document.createElement("button");
        src.className = "ghost small";
        src.innerText = "View source";
        bar.appendChild(src);
        body.appendChild(bar);

        const frame = document.createElement("iframe");
        frame.className = "viewer-frame";
        frame.setAttribute("sandbox", "");
        frame.src = "data:" + (/\.svg$/i.test(res.name) ? "image/svg+xml" : "text/html")
            + ";charset=utf-8," + encodeURIComponent(res.content);
        body.appendChild(frame);

        let showingSource = false;
        src.addEventListener("click", () => {
            showingSource = !showingSource;
            src.innerText = showingSource ? "View rendered" : "View source";
            frame.classList.toggle("hidden", showingSource);
            let pre = body.querySelector(".viewer-src");
            if (showingSource && !pre) {
                pre = window.lclSyntax
                    ? window.lclSyntax.codeBlock(res.content, res.ext ? res.ext.slice(1) : "")
                    : document.createElement("pre");
                if (!window.lclSyntax) pre.innerText = res.content;
                pre.classList.add("viewer-src");
                body.appendChild(pre);
            } else if (pre) {
                pre.classList.toggle("hidden", !showingSource);
            }
        });
    } else {
        const lang = res.ext ? res.ext.slice(1) : "";
        if (window.lclSyntax) {
            body.appendChild(window.lclSyntax.codeBlock(res.content, lang));
        } else {
            const pre = document.createElement("pre");
            pre.innerText = res.content;
            body.appendChild(pre);
        }
    }

    if (res.truncated) {
        body.appendChild(note("preview truncated — file is larger than 2 MB"));
    }
}

$("v-refresh").addEventListener("click", render);
render();
