// Scrollbars are hidden until the element actually scrolls: index.css keys the
// thumb off `data-scrolling`, which we drop again 700ms after the last event.
// Imported for its side effect by both entries (main.jsx, web-main.jsx).
const idleTimers = new WeakMap();
document.addEventListener(
  "scroll",
  (event) => {
    const el = event.target;
    if (!(el instanceof Element)) return;
    el.setAttribute("data-scrolling", "");
    clearTimeout(idleTimers.get(el));
    idleTimers.set(el, setTimeout(() => el.removeAttribute("data-scrolling"), 700));
  },
  true,
);
