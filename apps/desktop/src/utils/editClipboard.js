// The copied edits, app-wide: written by the editor ("Copy edits"), read by the
// gallery context menu ("Paste edits"). Kept in localStorage so a copy survives
// closing the editor and relaunching, like a real clipboard would.
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "afterframe-edit-clipboard";
const listeners = new Set();
let current = read();

function read() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function getEditClipboard() {
  return current;
}

export function setEditClipboard(clipboard) {
  current = clipboard || null;
  try {
    if (current) localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage full or unavailable: the in-memory copy still works */ }
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditClipboard() {
  return useSyncExternalStore(subscribe, getEditClipboard);
}
