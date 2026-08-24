/* The maintenance window's bridge. Six calls, nothing else — this window may
 * uninstall or repair and must be able to do nothing more. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("maint", {
    mode:      () => ipcRenderer.invoke("maint:mode"),
    paths:     () => ipcRenderer.invoke("maint:paths"),
    uninstall: (opts) => ipcRenderer.invoke("maint:uninstall", opts),
    repair:    () => ipcRenderer.invoke("maint:repair"),
    cancel:    () => ipcRenderer.invoke("maint:cancel"),
    minimise:  () => ipcRenderer.invoke("maint:minimise")
});
