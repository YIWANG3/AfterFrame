// Liquid Glass demo shell — standalone Electron entry reusing apps/desktop's
// electron install. Purely a visual prototype: hiddenInset title bar +
// native under-window vibrancy + transparent background, so the finalized
// gallery mock gets REAL desktop-behind-the-window glass (the P3 hypothesis).
//
// Run from apps/desktop:  npx electron lg-demo-electron/main.js
const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 16 },
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    // LG_TRANSPARENT=1:和真 app 一样的透明窗(没有系统圆角,圆角由页面自己画)
    ...(process.env.LG_TRANSPARENT ? { transparent: true, vibrancy: undefined } : {}),
    // LG_POS="x,y":把窗口开到指定显示器上(排查不同缩放比例下的合成差异)
    ...(process.env.LG_POS ? (([x, y]) => ({ x, y }))(process.env.LG_POS.split(",").map(Number)) : {}),
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "preload.js") },
  });
  // Fullscreen hides the traffic lights; tell the page to drop its top gutter.
  win.on("enter-full-screen", () => win.webContents.send("lg:fullscreen", true));
  win.on("leave-full-screen", () => win.webContents.send("lg:fullscreen", false));
  // 第二个参数可指定页面:npx electron lg-demo-electron/main.js music.html
  // 页面参数可带 #hash 预设风格:music2.html#print
  const arg = process.argv.slice(2).find((a) => a.includes(".html")) || "index.html";
  const [page, hash] = arg.split("#");
  win.loadFile(path.join(__dirname, page), hash ? { hash } : undefined);
}

// under-window vibrancy takes its light/dark from nativeTheme, not from the
// page's data-theme: keep the two in sync or a dark UI gets a light frosted pane.
ipcMain.on("lg:theme", (_event, theme) => {
  nativeTheme.themeSource = ["dark", "light", "system"].includes(theme) ? theme : "system";
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
