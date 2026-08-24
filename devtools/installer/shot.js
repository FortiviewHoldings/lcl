/* Render the installer window and photograph every page. Nothing is installed;
 * this exists so the look can be judged before any install logic is written. */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

app.disableHardwareAcceleration();
const OUT = path.join(__dirname, "shots");
const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 720, height: 500, show: false,
        frame: false, transparent: false, backgroundColor: "#050505", resizable: false,
        webPreferences: { contextIsolation: false, nodeIntegration: true }
    });
    await win.loadFile(path.join(__dirname, "ui.html"));
    await wait(700);
    fs.mkdirSync(OUT, { recursive: true });

    for (const [n, name] of [[0, "1-welcome"], [1, "2-where"], [2, "3-installing"], [3, "4-done"]]) {
        await win.webContents.executeJavaScript(`show(${n})`);
        await wait(450);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT, name + ".png"), img.toPNG());
        console.log("shot", name);
    }
    app.exit(0);
});
