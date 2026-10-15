// Editor shortcuts must not steal keys from text fields and the layer
// editor. Range sliders (the crop zoom, a LUT's strength) take no text, so
// they don't swallow shortcuts — otherwise Esc with a slider focused never
// reaches the close handler and only leaves the slider showing its focus
// ring. App.jsx keeps the same function for the global shortcuts.
export function shouldIgnoreKey(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  if (tagName === "INPUT" && target.type === "range") return false;
  return target.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}
