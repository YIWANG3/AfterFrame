// Liquid Glass demo preload: the two P3 main-process hooks the redesign needs.
//  setTheme     -> nativeTheme.themeSource (vibrancy tint follows the app theme)
//  onFullscreen -> renderer collapses the hiddenInset top gutter in fullscreen
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("lg", {
  setTheme: (theme) => ipcRenderer.send("lg:theme", theme),
  onFullscreen: (cb) => ipcRenderer.on("lg:fullscreen", (_event, value) => cb(value)),
});
