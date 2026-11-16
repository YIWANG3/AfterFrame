// A name being typed in place (new folder, rename). Enter or blur commits a
// changed, non-empty value; Escape cancels. Switching to another app is not a
// blur here: the field stays open with what was typed.
import { useEffect, useRef, useState } from "react";
import { blurLeftWindow, useRefocusOnWindowReturn } from "../hooks/useWindowSwitch";

export default function InlineEdit({ initial, onConfirm, onCancel, placeholder }) {
  const ref = useRef(null);
  const done = useRef(false);
  const [value, setValue] = useState(initial);
  useRefocusOnWindowReturn(ref);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  function commit() {
    if (done.current) return;
    done.current = true;
    const trimmed = value.trim();
    if (trimmed && trimmed !== initial) {
      void onConfirm(trimmed);
    } else {
      onCancel();
    }
  }
  return (
    <input
      ref={ref}
      className="w-full rounded-md bg-hover px-2 py-0.5 text-[13px] text-text outline-none border border-accent/50"
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => { if (!blurLeftWindow(e)) commit(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); if (!done.current) { done.current = true; onCancel(); } }
      }}
    />
  );
}
