import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Menu } from "lucide-react";
import api from "../api";

// Windows only: a strip across the top of the window (html.platform-win32 in
// index.css gives it its height and moves everything else below it). The
// native caption buttons — minimise, maximise with Snap Layouts, close — are
// drawn over its right end by titleBarOverlay (electron/windowChrome.js). The
// strip is the drag area (double-click maximises), and since the window has
// no menu bar, its button opens the application menu.
export default function WindowTitleBar() {
  const { t } = useTranslation("nav");
  const buttonRef = useRef(null);

  // The caption buttons' glyphs follow the app theme, which index.css keys
  // off <html data-theme>.
  useEffect(() => {
    const report = () => {
      const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      api.setTitleBarTheme(theme)?.catch?.(() => {});
    };
    report();
    const observer = new MutationObserver(report);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) api.popupAppMenu(rect.left, rect.bottom)?.catch?.(() => {});
  };

  return (
    <div className="window-titlebar" data-testid="window-titlebar">
      <button
        ref={buttonRef}
        type="button"
        className="window-titlebar-menu"
        title={t("window.menu")}
        aria-label={t("window.menu")}
        onClick={openMenu}
      >
        <Menu className="h-4 w-4" />
      </button>
      <span className="window-titlebar-title">AfterFrame</span>
    </div>
  );
}
