import { useEffect, useRef } from "react";

// Closes a menu or popover from outside: a pointer press or a right-click
// anywhere `refs` (one ref or several — a panel and the button that toggles
// it) does not contain, and Escape unless `escape` is false. Listens only
// while `enabled`.
//
// The click or contextmenu event that opened the popover is still bubbling
// towards `document` when it mounts (React flushes the discrete update and
// this effect synchronously), so a listener attached now would receive it and
// close the popover 0.2 ms after opening it (#70). Events older than the
// listener are ignored.
//
// `onClose` and `refs` are read through refs: callers pass an inline closure
// or an inline `[panelRef, buttonRef]` array and the listeners are not
// re-attached (nor the opened-at stamp reset) on every render.
export default function useDismiss(refs, onClose, { escape = true, enabled = true } = {}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const refsRef = useRef(refs);
  refsRef.current = refs;
  useEffect(() => {
    if (!enabled) return undefined;
    const openedAt = performance.now();
    const inside = (target) => {
      const list = Array.isArray(refsRef.current) ? refsRef.current : [refsRef.current];
      return list.some((ref) => ref?.current?.contains(target));
    };
    const outside = (e) => {
      if (e.timeStamp <= openedAt) return;
      if (!inside(e.target)) onCloseRef.current?.(e);
    };
    const key = (e) => {
      if (e.key === "Escape") onCloseRef.current?.(e);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("contextmenu", outside);
    if (escape) document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("contextmenu", outside);
      if (escape) document.removeEventListener("keydown", key);
    };
  }, [enabled, escape]);
}
