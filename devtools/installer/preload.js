/* The installer's bridge. Five calls and one event — deliberately tiny, because
 * this window runs before anything has been installed and should be able to do
 * nothing except install. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lclSetup", {
    defaultDir:  () => ipcRenderer.invoke("setup:defaultDir"),
    pickFolder:  (cur) => ipcRenderer.invoke("setup:pickFolder", cur),
    isUpgrade:   (dir) => ipcRenderer.invoke("setup:isUpgrade", dir),
    install:     (dir) => ipcRenderer.invoke("setup:install", dir),
    finish:      (run) => ipcRenderer.invoke("setup:finish", !!run),
    minimise:    () => ipcRenderer.invoke("setup:minimise"),
    quit:        () => ipcRenderer.invoke("setup:quit"),
    onProgress:  (cb) => ipcRenderer.on("setup:progress", (_e, p) => cb(p))
});
