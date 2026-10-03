// BrowserWindow options for the app window, per platform. Pure, so the macOS
// shell can be pinned by a test while the Windows one changes.
//
// macOS: the Tahoe skin. No system title bar; the traffic lights sit inside
// the sidebar panel; the window is transparent and the renderer clips itself
// to a 26px rounded rect (index.css, html.electron #root), which is where the
// shadow comes from.
//
// Windows: an opaque window whose native caption buttons (minimise, maximise
// with Snap Layouts, close) are drawn over the renderer's own title strip via
// titleBarOverlay (WindowTitleBar.jsx, html.platform-win32 in index.css).
// A transparent window on Windows has no caption buttons and can't be resized
// or snapped, and Windows 11 rounds an opaque window's corners itself.

const WIN_TITLEBAR_HEIGHT = 36;
const PREFERRED_SIZE = { width: 1440, height: 920 };
const MIN_SIZE = { width: 1080, height: 720 };

// Caption-button glyph colours; the overlay itself stays transparent so the
// strip behind it shows through. Kept in step with --text-color in index.css.
const WIN_SYMBOL_COLOR = { dark: "#f2f2f2", light: "#1d1d1f" };
// --app-bg: what Windows paints before the first frame and while resizing.
const WIN_BACKGROUND = { dark: "#060607", light: "#f4f4f5" };

// Never larger than the display's work area (a 1366x768 laptop, or 1920x1080
// at 150% scaling: 1280x672 once the taskbar is out): a window taller than the
// work area hides its bottom behind the taskbar and can't be shrunk to fit.
function sizeFor(workArea) {
  const fit = (want, have) => (Number.isFinite(have) && have > 0 ? Math.min(want, have) : want);
  return {
    width: fit(PREFERRED_SIZE.width, workArea?.width),
    height: fit(PREFERRED_SIZE.height, workArea?.height),
    minWidth: fit(MIN_SIZE.width, workArea?.width),
    minHeight: fit(MIN_SIZE.height, workArea?.height),
  };
}

function windowChromeOptions(platform, { workArea, theme = "dark" } = {}) {
  const size = sizeFor(workArea);
  if (platform === "darwin") {
    return {
      ...size,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 16 },
      // Tahoe gives a titlebar-only window the small (~16pt) corner; the large
      // 26pt corner is reserved for windows with an NSToolbar, which Electron
      // cannot create. So the window is transparent and the renderer clips
      // itself to a 26px rounded rect; macOS derives the shadow from the alpha.
      transparent: true,
      backgroundColor: "#00000000",
    };
  }
  if (platform === "win32") {
    const mode = theme === "light" ? "light" : "dark";
    return {
      ...size,
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#00000000", symbolColor: WIN_SYMBOL_COLOR[mode], height: WIN_TITLEBAR_HEIGHT },
      backgroundColor: WIN_BACKGROUND[mode],
    };
  }
  // Linux: the native frame and menu bar.
  return size;
}

module.exports = { windowChromeOptions, WIN_TITLEBAR_HEIGHT, WIN_SYMBOL_COLOR, MIN_SIZE, PREFERRED_SIZE };
