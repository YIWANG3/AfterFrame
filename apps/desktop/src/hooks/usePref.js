// useState that remembers (utils/prefs.js): it starts from the stored value,
// if its check accepts it, and every set writes the new value back. Nothing
// is written until the user changes something, so the default stays the
// app's to change.

import { useCallback, useRef, useState } from "react";
import { clearPref, readPref, writePref } from "../utils/prefs";

export function usePref(key, fallback, check) {
  const [value, setValue] = useState(() => readPref(key, fallback, check));
  // The latest value for a functional set; only `set`/`reset` change it.
  const latest = useRef(value);
  const set = useCallback((next) => {
    const resolved = typeof next === "function" ? next(latest.current) : next;
    latest.current = resolved;
    setValue(resolved);
    writePref(key, resolved);
  }, [key]);
  const reset = useCallback(() => {
    latest.current = fallback;
    setValue(fallback);
    clearPref(key);
  }, [key, fallback]);
  return [value, set, reset];
}
