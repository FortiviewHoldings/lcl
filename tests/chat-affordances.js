/**
 * LAUNCH FROM THE CHAT. "the ability to launch from the chat does not exist" —
 * when the model serves a folder, the chat now shows a one-click "Open the
 * served site" (liveness-checked so a dead post-restart port explains itself),
 * and a file it created carries a labelled "Open" that opens it in the
 * workspace panel. "continue working locally and serve it all without leaving
 * .lcl."
 *
 * Static wiring test — no Electron, no live server.
 */
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..", "app");
const appjs = fs.readFileSync(path.join(R, "renderer", "app.js"), "utf8");
const css = fs.readFileSync(path.join(R, "renderer", "styles.css"), "utf8");
const main = fs.readFileSync(path.join(R, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(R, "preload.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 160) : ""); }
}

/* ---- the served-site buttons ---- */
check("serve_folder results get a primary 'Launch in Workspace' button (embeds in the sidebar)",
    /msg\.name === "serve_folder" && !msg\.failed/.test(appjs)
    && /Launch in Workspace/.test(appjs)
    && /launch\.className = "primary"/.test(appjs)
    && /launchServedInWorkspace\(hit\.url\)/.test(appjs));
check("...and a secondary 'Open in browser' for a full external tab",
    /Open in browser/.test(appjs) && /window\.lcl\.openExternal\(hit\.url\)/.test(appjs));
check("launchServedInWorkspace renders a loopback iframe in the workspace preview pane",
    /function launchServedInWorkspace\(url\)/.test(appjs)
    && /class = "ws-served-frame"|className = "ws-served-frame"/.test(appjs)
    && /frame\.src = url/.test(appjs));
check("the CSP allows a loopback frame so the embed can load",
    /frame-src 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/.test(
        require("fs").readFileSync(require("path").join(R, "renderer", "index.html"), "utf8")));
check("the button parses the url out of the serve result safely",
    /raw\.startsWith\("\{"\)/.test(appjs) && /JSON\.parse\(raw\)/.test(appjs) && /\.url/.test(appjs));
check("the button checks the server is LIVE before opening (dead ports explain themselves)",
    /window\.lcl\.listServers\(\)/.test(appjs)
    && /window\.lcl\.openExternal\(hit\.url\)/.test(appjs)
    && /Nothing is being served right now/i.test(appjs));

/* ---- the listServers bridge ---- */
check("main exposes lcl:listServers from serve.listServers()",
    /ipcMain\.handle\("lcl:listServers"/.test(main) && /serve\.listServers\(\)/.test(main));
check("preload bridges listServers", /listServers:\s*\(\) =>/.test(preload));

/* ---- open a created file in the workspace ---- */
check("a file change chip has a labelled 'Open' that opens it in the workspace",
    /chip-openbtn/.test(appjs)
    && /openFileViewer\(change\.path\)/.test(appjs)
    && /toggleWorkspace\(true\)/.test(appjs));
check("the served-site button sits OUTSIDE the expandable row (no accidental toggle)",
    /e\.stopPropagation\(\)/.test(appjs.slice(appjs.indexOf("Open in browser") - 200, appjs.indexOf("Open in browser") + 700)));

/* ---- styling exists ---- */
check("css styles the serve-open row and the chip Open button",
    /\.serve-open-row/.test(css) && /\.serve-open-url/.test(css) && /\.chip-openbtn/.test(css));

console.log(`\n${pass}/${pass + fail} chat-affordance checks passed`);
process.exit(fail ? 1 : 0);
