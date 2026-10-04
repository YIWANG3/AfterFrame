// The window, the application menu, fullscreen, and the queue of files macOS
// hands us through open-file (dock drop / Finder "Open With"). Extracted from
// main.js (review 2026-09-16 §2). Everything renderer-facing here is a
// webContents.send to a channel preload.js subscribes to.
//   BrowserWindow, Menu   electron
//   makeT                 i18n — the menu follows the app language
//   getLocale             current locale (main owns it; see main.js applyLocale)
//   devServerUrl          VITE_DEV_SERVER_URL in dev, undefined when packaged
//   preloadPath / indexHtml   what the window loads
//   screen, nativeTheme   electron (the window fits the work area; Windows
//                         paints its first frame in the theme's colour)
//   platform              process.platform (a parameter so tests can pick)

const { windowChromeOptions, WIN_SYMBOL_COLOR } = require("./windowChrome");

// Menu roles that only mean something on macOS; elsewhere they are omitted.
const MAC_ONLY_ROLES = new Set(["services", "hide", "hideOthers", "unhide", "zoom", "front"]);

function withoutMacOnlyItems(template) {
  return template.map((menu) => {
    const items = (menu.submenu || []).filter((item) => !MAC_ONLY_ROLES.has(item.role));
    // Drop the separators the removed items leave stacked or trailing.
    const tidy = items.filter((item, i) => item.type !== "separator"
      || (i > 0 && i < items.length - 1 && items[i - 1].type !== "separator"));
    return { ...menu, submenu: tidy };
  });
}

function createAppShell({
  BrowserWindow, Menu, makeT, getLocale, devServerUrl, preloadPath, indexHtml,
  screen, nativeTheme, platform = process.platform,
}) {
  const anyWindow = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];

  // ── external "Open With…" / dock-icon drop import ──
  // macOS fires `open-file` once per dropped file. We batch them in a 50ms
  // window then push the list to the renderer. If the window isn't ready yet
  // (cold launch via dock drop), we queue and flush after `did-finish-load`.
  let pendingExternalImports = [];
  let externalImportFlushTimer = null;
  function flushExternalImports() {
    externalImportFlushTimer = null;
    if (!pendingExternalImports.length) return;
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || !win.webContents || win.webContents.isLoading()) {
      // Try again once the window is ready.
      return;
    }
    const paths = pendingExternalImports.slice();
    pendingExternalImports = [];
    win.webContents.send("workspace:external-import", paths);
  }
  function queueExternalImport(filePath) {
    if (!filePath) return;
    pendingExternalImports.push(filePath);
    if (externalImportFlushTimer) clearTimeout(externalImportFlushTimer);
    externalImportFlushTimer = setTimeout(flushExternalImports, 50);
  }

  function createWindow() {
    // Tahoe 皮肤(macOS):去掉系统标题栏,红绿灯落进侧栏面板;Windows:原生窗口按钮盖在自绘标题条上。见 windowChrome.js
    const window = new BrowserWindow({
      ...windowChromeOptions(platform, {
        workArea: screen?.getPrimaryDisplay?.().workAreaSize,
        theme: nativeTheme?.shouldUseDarkColors === false ? "light" : "dark",
      }),
      show: true,
      webPreferences: {
        preload: preloadPath,
      },
    });
    // Window shows immediately with splash; React replaces it when ready.
    window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${sourceId}:${line} ${message}`);
    });
    window.webContents.on("did-fail-load", (_event, code, description, validatedURL) => {
      console.error(`[renderer:did-fail-load] ${code} ${description} ${validatedURL}`);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      console.error("[renderer:gone]", details);
    });
    window.webContents.on("preload-error", (_event, preloadPath_, error) => {
      console.error(`[renderer:preload-error] ${preloadPath_}`, error);
    });
    window.webContents.on("did-finish-load", () => {
      // Cold-launch via dock drop arrives before any window exists, so the
      // open-file events sit in `pendingExternalImports` until we're ready.
      if (pendingExternalImports.length) flushExternalImports();
      // vibepin overlay (dev only): ⌥A to drop a pin on any UI element, type a
      // note, Send → posts to the local daemon on :7331 → /vpin picks it up.
      // The daemon must be running (see .vibepin/ + README); harmless if it isn't.
      if (devServerUrl) {
        window.webContents.executeJavaScript(`
          (function () {
            if (document.getElementById("__vibepin_overlay")) return;
            var s = document.createElement("script");
            s.id = "__vibepin_overlay";
            s.src = "http://127.0.0.1:7331/annotate.js";
            document.body.appendChild(s);
          })();
        `).catch(() => {});
      }
    });
    for (const [evt, flag] of [["enter-full-screen", true], ["leave-full-screen", false]]) {
      window.on(evt, () => { if (!window.isDestroyed()) window.webContents.send("window:fullscreen", flag); });
    }
    if (devServerUrl) {
      window.loadURL(devServerUrl);
      return window;
    }
    window.loadFile(indexHtml);
    return window;
  }

  function sendMenuAction(action) {
    const window = anyWindow();
    if (!window) return;
    window.webContents.send("workspace:menu-action", action);
  }

  function toggleAppFullscreen(browserWindow) {
    const window = browserWindow || anyWindow();
    if (!window || window.isDestroyed()) return;
    // Native macOS fullscreen immediately bounces a transparent BrowserWindow
    // back to windowed mode. Simple fullscreen is the supported equivalent for
    // our transparent Tahoe shell; other platforms keep the native behavior.
    const next = platform === "darwin"
      ? !window.isSimpleFullScreen()
      : !window.isFullScreen();
    if (platform === "darwin") window.setSimpleFullScreen(next);
    else window.setFullScreen(next);
    window.webContents.send("window:fullscreen", next);
  }

  function buildAppMenu() {
    // We give every `role` item an explicit translated `label` so the whole menu
    // follows the app language, not the OS language. (macOS still auto-injects a
    // few items into the Edit menu — Writing Tools, AutoFill, Dictation, Emoji &
    // Symbols — which we don't create and can't relabel; those stay OS-localized,
    // exactly like every other Mac app.) The app-menu title stays the brand name.
    const t = makeT(getLocale());
    const template = [
      {
        label: "AfterFrame",
        submenu: [
          { label: t("menu.about"), role: "about" },
          { type: "separator" },
          { label: t("menu.settings"), accelerator: "CmdOrCtrl+,", click: () => sendMenuAction("app:open-settings") },
          { type: "separator" },
          { label: t("menu.scratchCatalog"), click: () => sendMenuAction("catalog:scratch") },
          { type: "separator" },
          { label: t("menu.services"), role: "services" },
          { type: "separator" },
          { label: t("menu.hide"), role: "hide" },
          { label: t("menu.hideOthers"), role: "hideOthers" },
          { label: t("menu.showAll"), role: "unhide" },
          { type: "separator" },
          { label: t("menu.quit"), role: "quit" },
        ],
      },
      {
        label: t("menu.file"),
        submenu: [
          { label: t("menu.newCatalog"), accelerator: "CmdOrCtrl+N", click: () => sendMenuAction("catalog:new") },
          { label: t("menu.openCatalog"), accelerator: "CmdOrCtrl+O", click: () => sendMenuAction("catalog:open") },
          { type: "separator" },
          { label: t("menu.import"), click: () => sendMenuAction("import:pick-export") },
          { label: t("menu.addRawSources"), click: () => sendMenuAction("import:pick-source") },
          { type: "separator" },
          { label: t("menu.runImport"), accelerator: "CmdOrCtrl+I", click: () => sendMenuAction("import:start") },
          { label: t("menu.runEnrichment"), click: () => sendMenuAction("import:enrich") },
          { label: t("menu.generatePreviews"), click: () => sendMenuAction("import:previews") },
          { type: "separator" },
          { label: t("menu.verifyFiles"), click: () => sendMenuAction("library:verify") },
        ],
      },
      {
        label: t("menu.edit"),
        submenu: [
          // Text-editing roles target the focused element natively.
          { label: t("menu.undo"), role: "undo" },
          { label: t("menu.redo"), role: "redo" },
          { type: "separator" },
          { label: t("menu.cut"), role: "cut" },
          { label: t("menu.copy"), role: "copy" },
          { label: t("menu.paste"), role: "paste" },
          { label: t("menu.pasteMatchStyle"), role: "pasteAndMatchStyle" },
          { type: "separator" },
          // Asset-level actions — the renderer acts on the current selection.
          { label: t("menu.copyPath"), click: () => sendMenuAction("edit:copy-path") },
          { label: t("menu.copyName"), click: () => sendMenuAction("edit:copy-name") },
          // No accelerator: a global ⌫ would hijack typing. The renderer owns the
          // Delete/Backspace shortcut and skips it inside text fields.
          { label: t("menu.delete"), click: () => sendMenuAction("edit:delete") },
          { type: "separator" },
          // ⌘A is routed to the renderer so it can pick text-select vs gallery
          // select-all based on focus, instead of role:"selectAll" (text only).
          { label: t("menu.selectAll"), accelerator: "CmdOrCtrl+A", click: () => sendMenuAction("edit:select-all") },
        ],
      },
      {
        label: t("menu.view"),
        submenu: [
          { label: t("menu.refresh"), accelerator: "CmdOrCtrl+R", click: () => sendMenuAction("view:refresh") },
          { label: t("menu.toggleTheme"), click: () => sendMenuAction("view:toggle-theme") },
          { type: "separator" },
          { label: t("menu.devTools"), role: "toggleDevTools", accelerator: "Alt+CommandOrControl+I" },
          { type: "separator" },
          {
            id: "toggle-fullscreen",
            label: t("menu.toggleFullscreen"),
            accelerator: platform === "darwin" ? "Ctrl+Command+F" : "F11",
            click: (_item, browserWindow) => toggleAppFullscreen(browserWindow),
          },
        ],
      },
      {
        label: t("menu.window"),
        submenu: [
          { label: t("menu.minimize"), role: "minimize" },
          { label: t("menu.zoom"), role: "zoom" },
          { type: "separator" },
          { label: t("menu.front"), role: "front" },
        ],
      },
    ];
    return Menu.buildFromTemplate(platform === "darwin" ? template : withoutMacOnlyItems(template));
  }

  const installMenu = () => Menu.setApplicationMenu(buildAppMenu());

  // Windows: the title strip's menu button (WindowTitleBar.jsx). The window
  // has no menu bar of its own (titleBarStyle "hidden"), so the application
  // menu opens as a popup under the button; its accelerators stay registered.
  function popupAppMenu(window, x, y) {
    const menu = Menu.getApplicationMenu();
    if (!menu || !window || window.isDestroyed()) return false;
    menu.popup({ window, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) });
    return true;
  }

  // Windows: the caption buttons' glyph colour follows the app theme (the
  // renderer reports it; the overlay background stays transparent).
  function setTitleBarTheme(window, theme) {
    if (platform !== "win32" || !window || window.isDestroyed() || typeof window.setTitleBarOverlay !== "function") return false;
    window.setTitleBarOverlay({ color: "#00000000", symbolColor: WIN_SYMBOL_COLOR[theme === "light" ? "light" : "dark"] });
    return true;
  }

  return {
    createWindow, buildAppMenu, installMenu, sendMenuAction, toggleAppFullscreen, queueExternalImport, flushExternalImports,
    popupAppMenu, setTitleBarTheme,
  };
}

module.exports = { createAppShell };
