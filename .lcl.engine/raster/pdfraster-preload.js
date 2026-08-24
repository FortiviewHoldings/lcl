const { contextBridge, ipcRenderer } = require("electron");

/**
 * Bridge for the hidden PDF raster window — nothing here touches the user's
 * session. Main names the job channel in the page URL's hash
 * (pdfraster:<webContentsId>), the page subscribes to exactly that channel,
 * and answers on channel+":reply" — so two concurrent raster windows can
 * never cross their wires.
 */
contextBridge.exposeInMainWorld("raster", {
    listen: (channel, cb) => ipcRenderer.on(String(channel), (_e, msg) => cb(msg)),
    reply: (channel, msg) => ipcRenderer.send(String(channel) + ":reply", msg)
});
