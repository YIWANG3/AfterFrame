// A mouse click does not leave keyboard focus behind (docs/focus-design.md).
//
// Chromium focuses a button when it is clicked, unlike macOS controls, Safari
// and Firefox, and the focus outlives the click: the next key press turns on
// :focus-visible (a ring around whatever was clicked last), Space or Enter
// presses that button again, and :focus-within keeps hover-only controls up.
//
//  1. A button-like control the pointer focused gives the focus up once the
//     click has been handled. A control focused from the keyboard keeps it,
//     so Tab users stay where they are; [data-keep-focus] opts a control out.
//  2. Anything else the pointer focuses (list rows that read arrow keys while
//     focused, text fields) keeps the focus, marked [data-pointer-focus] until
//     it loses it. index.css draws no focus ring on a marked element.
//
// Imported for its side effect by both entries (main.jsx, web-main.jsx).

export const BUTTON_LIKE = [
  "button",
  "a[href]",
  "summary",
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="range"]',
  'input[type="color"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
].join(", ");

export const POINTER_FOCUS_ATTR = "data-pointer-focus";

let pressed = false;
// The first element focused while the pointer was down: the one the browser
// focused on mousedown, not one a handler focused afterwards.
let pressFocused = null;

function release() {
  pressed = false;
  pressFocused = null;
}

document.addEventListener("pointerdown", () => {
  pressed = true;
  pressFocused = null;
}, true);

document.addEventListener("focusin", (event) => {
  if (!pressed || !(event.target instanceof Element)) return;
  event.target.setAttribute(POINTER_FOCUS_ATTR, "");
  pressFocused ??= event.target;
}, true);

document.addEventListener("focusout", (event) => {
  if (event.target instanceof Element) event.target.removeAttribute(POINTER_FOCUS_ATTR);
}, true);

document.addEventListener("pointerup", (event) => {
  // A click on a <label> focuses its checkbox during the click that follows,
  // after the pointer is already up.
  const label = event.target instanceof Element ? event.target.closest("label") : null;
  const control = pressFocused ?? label?.control ?? null;
  release();
  if (!(control instanceof Element) || !control.matches(BUTTON_LIKE) || control.closest("[data-keep-focus]")) return;
  // The click is dispatched after pointerup in the same task: let it and its
  // handlers run first. A handler that moved the focus on purpose (opened a
  // field or a menu) keeps it, and nothing sees a focusout mid-click.
  setTimeout(() => {
    if (document.activeElement === control) control.blur();
  }, 0);
}, true);

document.addEventListener("pointercancel", release, true);
document.addEventListener("dragstart", release, true);
window.addEventListener("blur", release);
