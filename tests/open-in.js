/**
 * OPEN IN — the workspace card launches the folder in Explorer, VS Code, or an
 * app the operator adds through the OS picker and .lcl remembers.
 *
 * "Open in Explorer, i want that to be Open In, and be a drop down menu that has
 * options like File Explorer, VS Code, and Other, where it will launch the app
 * selector to add one to the list of options." Plus: all three card buttons
 * must read as interactive — "Unlink is the only button that actually has any
 * onhover css".
 *
 * Static wiring test: it pins the IPC contract (preload ↔ main) and the renderer
 * hooks without launching Electron, so the feature cannot silently unwire.
 */
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..", "app");
const main = fs.readFileSync(path.join(R, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(R, "preload.js"), "utf8");
const appjs = fs.readFileSync(path.join(R, "renderer", "app.js"), "utf8");
const html = fs.readFileSync(path.join(R, "renderer", "index.html"), "utf8");
const css = fs.readFileSync(path.join(R, "renderer", "styles.css"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 160) : ""); }
}

/* ---- main: the four handlers + VS Code detection ---- */
for (const h of ["lcl:listOpeners", "lcl:openWith", "lcl:pickOpenerApp", "lcl:removeOpener"]) {
    check(`main handles ${h}`, main.includes(`ipcMain.handle("${h}"`), h);
}
check("main detects VS Code by PATH then default install",
    /function detectVSCode\(\)/.test(main) && /code\.cmd/.test(main));
check("openWith runs a batch shim through the shell (code.cmd) and an exe plainly",
    /shell: true/.test(main) && /spawn\(appPath, \[folder\]/.test(main));
check("custom openers persist under a settings key, capped",
    /OPENERS_KEY = "openWithApps"/.test(main) && /\.slice\(-12\)/.test(main));
check("pickOpenerApp uses an openFile dialog and stores {name, path}",
    /showOpenDialog[\s\S]{0,200}openFile/.test(main) && /name, path: appPath/.test(main));

/* ---- preload: the contract is exposed ---- */
for (const m of ["listOpeners", "openWith", "pickOpenerApp", "removeOpener"]) {
    check(`preload exposes ${m}`, new RegExp(m + ":\\s*\\(").test(preload), m);
}

/* ---- renderer: the dropdown is wired to the card button ---- */
check("index.html: ws-open is a menu trigger labelled Open In",
    /id="ws-open"[\s\S]{0,160}aria-haspopup="menu"/.test(html) && /Open In/.test(html));
check("app.js: the Open In menu is built and populated from listOpeners",
    /function openOpenInMenu\(/.test(appjs) && /window\.lcl\.listOpeners\(\)/.test(appjs));
check("app.js: choosing a row launches openWith on the linked folder",
    /window\.lcl\.openWith\(op\.id, folder\)/.test(appjs) || /window\.lcl\.openWith\(/.test(appjs));
check("app.js: \"Other…\" runs the app picker and adds it to the list",
    /window\.lcl\.pickOpenerApp\(\)/.test(appjs) && /Other/.test(appjs));
check("app.js: a custom opener can be removed from the list",
    /window\.lcl\.removeOpener\(/.test(appjs));
check("app.js: ws-open no longer just reveals the folder (it opens the menu)",
    /openOpenInMenu\(\$\("ws-open"\)\)/.test(appjs));

/* ---- css: all three card buttons read as interactive ---- */
check("css: the two neutral card actions get a clear (non-red) hover",
    /#ws-actions button\.ghost:hover:not\(:disabled\):not\(\.danger-text\)/.test(css));
check("css: Unlink keeps its distinct danger hover",
    /#ws-actions button\.ghost\.danger-text:hover/.test(css));
check("css: the Open In trigger shows an open state",
    /#ws-open\[aria-expanded="true"\]/.test(css));

console.log(`\n${pass}/${pass + fail} open-in checks passed`);
process.exit(fail ? 1 : 0);
