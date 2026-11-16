// A field that saves when it loses focus (a description, a folder name)
// shouldn't save when the user only switched to another app mid-sentence: the
// draft waits, and the caret is back in it when they return.
import { useEffect } from "react";

// The blur came from the window losing focus, not from a click or Tab inside
// the page: the page has lost focus, or still counts the field as focused.
export function blurLeftWindow(event) {
  if (typeof document === "undefined") return false;
  return !document.hasFocus() || document.activeElement === event.currentTarget;
}

// Back in the window, focus goes back to the field. Chromium usually keeps it
// there, but a window that was hidden and shown again (macOS does that for
// BrowserWindow.blur()) comes back with focus on the page's first button.
export function useRefocusOnWindowReturn(ref, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const onFocus = () => {
      const field = ref.current;
      if (field && field.isConnected && document.activeElement !== field) field.focus({ preventScroll: true });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ref, active]);
}
