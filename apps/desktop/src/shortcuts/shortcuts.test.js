import { describe, expect, it } from "vitest";
import {
  SHORTCUT_ACTIONS,
  FIXED_SHORTCUTS,
  bindingProblem,
  bindingsFor,
  defaultBindings,
  eventBinding,
  findConflicts,
  formatBinding,
  matchBinding,
  menuAccelerator,
  normalizeBinding,
  sanitizeOverrides,
  toAccelerator,
} from "../../shared/shortcuts.mjs";

const key = (code, mods = {}) => ({ code, key: "", ...mods });

describe("shortcut bindings", () => {
  it("every default and fixed key is already in normal form", () => {
    for (const platform of ["darwin", "win32"]) {
      for (const action of SHORTCUT_ACTIONS) {
        for (const binding of defaultBindings(action, platform)) {
          expect(normalizeBinding(binding), `${action.id} ${binding}`).toBe(binding);
          expect(bindingProblem(binding, action.id, platform), `${action.id} ${binding}`).toBeNull();
        }
      }
      for (const fixed of FIXED_SHORTCUTS) {
        for (const binding of fixed.keys) expect(normalizeBinding(binding)).toBe(binding);
      }
    }
  });

  it("no two defaults collide", () => {
    for (const platform of ["darwin", "win32"]) {
      for (const action of SHORTCUT_ACTIONS) {
        for (const binding of defaultBindings(action, platform)) {
          expect(findConflicts(binding, action.id, {}, platform), `${action.id} ${binding}`).toEqual([]);
        }
      }
    }
  });

  it("reads a keydown as modifiers plus the physical key", () => {
    expect(eventBinding(key("KeyP"), "darwin")).toBe("KeyP");
    expect(eventBinding(key("KeyP", { metaKey: true }), "darwin")).toBe("Mod+KeyP");
    expect(eventBinding(key("KeyP", { ctrlKey: true }), "win32")).toBe("Mod+KeyP");
    // ⌃ is its own modifier on a Mac; the Windows key is not one at all.
    expect(eventBinding(key("KeyF", { metaKey: true, ctrlKey: true }), "darwin")).toBe("Mod+Ctrl+KeyF");
    expect(eventBinding(key("KeyP", { metaKey: true }), "win32")).toBe("KeyP");
    // Shift changes the character, not the code.
    expect(eventBinding({ code: "Digit3", key: "#", shiftKey: true }, "darwin")).toBe("Shift+Digit3");
    // The number pad rates like the top row.
    expect(eventBinding(key("Numpad4"), "darwin")).toBe("Digit4");
    // A lone modifier and an input method mid-composition are not shortcuts.
    expect(eventBinding({ code: "ShiftLeft", key: "Shift", shiftKey: true }, "darwin")).toBeNull();
    expect(eventBinding({ code: "ShiftLeft", key: "Shift", shiftKey: true }, "darwin", { partial: true })).toBe("Shift+");
    expect(eventBinding({ code: "KeyP", key: "Process" }, "darwin")).toBeNull();
    expect(eventBinding({ code: "KeyP", key: "p", isComposing: true }, "darwin")).toBeNull();
    // No code (some synthetic events): fall back to the key.
    expect(eventBinding({ code: "", key: "x" }, "darwin")).toBe("KeyX");
    expect(eventBinding({ code: "", key: " " }, "darwin")).toBe("Space");
  });

  it("labels keys the platform's way", () => {
    expect(formatBinding("Mod+Shift+KeyP", "darwin")).toBe("⇧⌘P");
    expect(formatBinding("Mod+Shift+KeyP", "win32")).toBe("Ctrl+Shift+P");
    expect(formatBinding("Mod+Backspace", "darwin")).toBe("⌘⌫");
    expect(formatBinding("Mod+Enter", "win32")).toBe("Ctrl+Enter");
    expect(formatBinding("Digit0", "darwin")).toBe("0");
    expect(formatBinding("Space", "darwin", { Space: "空格" })).toBe("空格");
    expect(formatBinding("Mod+Shift+", "darwin")).toBe("⇧⌘");
  });

  it("turns bindings into Electron accelerators", () => {
    expect(toAccelerator("Mod+Comma")).toBe("CmdOrCtrl+,");
    expect(toAccelerator("Mod+Ctrl+KeyF")).toBe("CmdOrCtrl+Ctrl+F");
    expect(toAccelerator("F11")).toBe("F11");
    expect(toAccelerator("Mod+Shift+Digit1")).toBe("CmdOrCtrl+Shift+1");
    expect(menuAccelerator("app:open-settings", {}, "darwin")).toBe("CmdOrCtrl+,");
    expect(menuAccelerator("app:open-settings", { "app.settings": ["Mod+Shift+KeyS"] }, "darwin")).toBe("CmdOrCtrl+Shift+S");
    // Unbound: the menu item shows no keys.
    expect(menuAccelerator("app:open-settings", { "app.settings": [] }, "darwin")).toBeUndefined();
  });

  it("refuses system keys and bare letters for menu items", () => {
    expect(bindingProblem("Mod+KeyC", "flag.pick", "darwin")).toBe("reserved");
    expect(bindingProblem("Escape", "flag.pick", "darwin")).toBe("reserved");
    expect(bindingProblem("ArrowLeft", "rating.1", "darwin")).toBe("reserved");
    // Undo is the editor's, so the editor's own Save can't take it…
    expect(bindingProblem("Mod+KeyZ", "editor.save", "darwin")).toBe("reserved");
    expect(bindingProblem("KeyN", "catalog.new", "darwin")).toBe("needsModifier");
    expect(bindingProblem("KeyK", "app.settings", "darwin")).toBe("needsModifier");
    expect(bindingProblem("F5", "view.refresh", "darwin")).toBeNull();
    expect(bindingProblem("Mod+", "flag.pick", "darwin")).toBe("modifierOnly");
  });

  it("finds the action a key belongs to, Shift adding 'and go to the next'", () => {
    const scopes = ["global", "library", "gallery"];
    expect(matchBinding("KeyP", scopes, {}, "darwin")).toEqual({ id: "flag.pick", advance: false });
    expect(matchBinding("Shift+KeyP", scopes, {}, "darwin")).toEqual({ id: "flag.pick", advance: true });
    expect(matchBinding("Shift+Digit3", scopes, {}, "darwin")).toEqual({ id: "rating.3", advance: true });
    // Proof is the lightbox's alone.
    expect(matchBinding("Mod+KeyP", scopes, {}, "darwin")).toBeNull();
    expect(matchBinding("Mod+KeyP", ["global", "library", "lightbox"], {}, "darwin")).toEqual({ id: "lightbox.proof", advance: false });
    // Shift doesn't make a non-advancing action advance.
    expect(matchBinding("Shift+KeyE", scopes, {}, "darwin")).toBeNull();
    // A rebound action answers to its new key only.
    const overrides = { "flag.pick": ["KeyK"] };
    expect(matchBinding("KeyK", scopes, overrides, "darwin")).toEqual({ id: "flag.pick", advance: false });
    expect(matchBinding("KeyP", scopes, overrides, "darwin")).toBeNull();
  });

  it("finds conflicts across scopes that can be live together", () => {
    expect(findConflicts("KeyX", "flag.pick", {}, "darwin")).toEqual(["flag.reject"]);
    // Shift+X is "reject and go to the next".
    expect(findConflicts("Shift+KeyX", "photo.edit", {}, "darwin")).toEqual(["flag.reject"]);
    // The editor's keys and the grid's don't meet.
    expect(findConflicts("KeyP", "editor.save", {}, "darwin")).toEqual([]);
    // A global key meets everything.
    expect(findConflicts("KeyP", "app.shortcuts", {}, "darwin")).toEqual(["flag.pick"]);
  });

  it("keeps only valid overrides, and an empty list means no keys", () => {
    const clean = sanitizeOverrides({
      "flag.pick": ["Shift+Mod+KeyK", "Mod+KeyK", "Mod+KeyC", "nonsense"],
      "rating.1": [],
      "made.up": ["KeyQ"],
      "catalog.new": ["KeyN"],
    }, "darwin");
    expect(clean).toEqual({ "flag.pick": ["Mod+Shift+KeyK", "Mod+KeyK"], "rating.1": [], "catalog.new": [] });
    expect(bindingsFor("rating.1", clean, "darwin")).toEqual([]);
    expect(bindingsFor("rating.2", clean, "darwin")).toEqual(["Digit2"]);
    expect(sanitizeOverrides(null, "darwin")).toEqual({});
    expect(sanitizeOverrides(["KeyP"], "darwin")).toEqual({});
  });
});
