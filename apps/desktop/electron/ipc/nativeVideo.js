// macOS draws AVPlayerLayer inside the BrowserWindow; the renderer retains
// the transport UI. Session tokens prevent a late open/close from a previous
// clip taking over the current one. Paths have the same allowlist as media://.
const fs = require("node:fs");
const path = require("node:path");

function register({ ipcMain, BrowserWindow, app, allowlist, addonPath, toggleFullscreen, platform = process.platform, loadAddon = require }) {
  let addon;
  const sessions = new Map();
  // webContents id -> its window's simple fullscreen before a player's
  // fullscreen button first changed it, until the lightbox restores it.
  const fullscreenBefore = new Map();
  const watched = new Set();
  function close(owner) {
    const session = sessions.get(owner);
    sessions.delete(owner);
    if (session?.id) addon?.close({ id: session.id });
  }
  function watch(owner, sender, window) {
    if (watched.has(owner)) return;
    watched.add(owner);
    sender.once("destroyed", () => { close(owner); fullscreenBefore.delete(owner); watched.delete(owner); });
    sender.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) { close(owner); fullscreenBefore.delete(owner); }
    });
    window.once("closed", () => close(owner));
  }
  function get(event, token) {
    if (event.senderFrame !== event.sender.mainFrame) return null;
    const session = sessions.get(event.sender.id);
    return session?.token === token ? session : null;
  }
  // Zero-sized is allowed: a collapsed surface hides the picture rather than
  // leaving it where it was.
  function bounds(window, rect) {
    const zoom = window.webContents.getZoomFactor();
    const size = window.getContentSize();
    const values = [rect?.x, rect?.y, rect?.width, rect?.height];
    if (!values.every(Number.isFinite) || rect.width < 0 || rect.height < 0) throw new Error("Invalid video bounds");
    const x = Math.max(0, Math.min(size[0], rect.x * zoom));
    const y = Math.max(0, Math.min(size[1], rect.y * zoom));
    return { x, y, width: Math.max(0, Math.min(rect.width * zoom, size[0] - x)), height: Math.max(0, Math.min(rect.height * zoom, size[1] - y)) };
  }

  ipcMain.handle("app:native-video-open", async (event, request) => {
    if (platform !== "darwin" || event.senderFrame !== event.sender.mainFrame) return null;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || typeof request?.session !== "string" || !request.session || typeof request.path !== "string") return null;
    const owner = event.sender.id;
    close(owner);
    const session = { token: request.session, id: null };
    sessions.set(owner, session);
    watch(owner, event.sender, window);
    try {
      const original = path.resolve(request.path);
      if (!(await allowlist.isAllowedMediaPathLoaded(original)) || !fs.statSync(original).isFile()) throw new Error("Video is not allowed");
      if (sessions.get(owner) !== session || window.isDestroyed()) return null;
      addon ||= loadAddon(addonPath);
      session.id = addon.open({ handle: window.getNativeWindowHandle(), path: original, bounds: bounds(window, request.bounds) });
      return { session: session.token };
    } catch (error) {
      if (sessions.get(owner) === session) close(owner);
      console.warn("[native-video] unavailable:", error.message);
      return null;
    }
  });
  ipcMain.handle("app:native-video-state", (event, token) => {
    const session = get(event, token);
    return session?.id ? addon.state({ id: session.id }) : null;
  });
  ipcMain.handle("app:native-video-command", (event, token, action, value) => {
    const session = get(event, token);
    if (!session?.id) return false;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return false;
    if (!["play", "pause", "seek", "mute", "bounds", "visible"].includes(action)) return false;
    if (action === "bounds") {
      addon.command({ id: session.id, action, bounds: bounds(window, value) });
    } else {
      if (["seek", "mute", "visible"].includes(action) && !Number.isFinite(value)) return false;
      addon.command({ id: session.id, action, value: action === "seek" ? Math.max(0, value) : value });
    }
    return true;
  });
  ipcMain.handle("app:native-video-close", (event, token) => {
    if (get(event, token)) close(event.sender.id);
    return true;
  });

  // The player's fullscreen button, either engine: the shell's simple
  // fullscreen, as in the View menu. DOM fullscreen can leave the transparent
  // window stuck, and can't hold the native picture. Not tied to a session:
  // stepping to the next clip stays fullscreen; the lightbox restores the
  // window when it closes.
  ipcMain.handle("app:video-fullscreen", (event) => {
    if (platform !== "darwin" || event.senderFrame !== event.sender.mainFrame || typeof toggleFullscreen !== "function") return false;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return false;
    const owner = event.sender.id;
    watch(owner, event.sender, window);
    if (!fullscreenBefore.has(owner)) fullscreenBefore.set(owner, window.isSimpleFullScreen());
    toggleFullscreen(window);
    return true;
  });
  ipcMain.handle("app:video-fullscreen-restore", (event) => {
    if (event.senderFrame !== event.sender.mainFrame) return false;
    const owner = event.sender.id;
    if (!fullscreenBefore.has(owner)) return false;
    const before = fullscreenBefore.get(owner);
    fullscreenBefore.delete(owner);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed() && window.isSimpleFullScreen() !== before) toggleFullscreen(window);
    return true;
  });
  app.on("before-quit", () => { for (const owner of sessions.keys()) close(owner); });
}

module.exports = { register };
