/* Like preload-stub, but the terminal methods are REAL — they talk to a live
 * powershell in the harness main process — so the terminal can be driven and
 * measured for real. Everything else is the permissive stub. */
const { ipcRenderer } = require("electron");

const real = new Set([
    "terminalStart", "terminalWrite", "terminalResize", "terminalKill", "terminalList"
]);

function def() {
    return { ok: true, models: [], sessions: [], items: [], list: [], entries: [],
             devices: [], files: [], text: "", error: null };
}

const lcl = new Proxy({}, {
    get(_t, key) {
        if (typeof key !== "string") return undefined;
        if (key === "onTerminalData") return (cb) => ipcRenderer.on("lcl:terminalData", (_e, id, chunk) => cb(id, chunk));
        if (key === "onTerminalExit") return (cb) => ipcRenderer.on("lcl:terminalExit", (_e, id, code) => cb(id, code));
        if (real.has(key)) return (...a) => ipcRenderer.invoke("lcl:" + key, ...a);
        return (...a) => {
            if (/^on[A-Z]/.test(key)) return () => {};
            return Promise.resolve(def());
        };
    },
    has() { return true; }
});
window.lcl = lcl;
window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
