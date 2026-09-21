// A name being typed in place (new folder, rename). Enter or blur commits a
// changed, non-empty value; Escape cancels.
import { useEffect, useRef, useState } from "react";

export default function InlineEdit({ initial, onConfirm, onCancel }) {
  const ref = useRef(null);
  const done = useRef(false);
  const [value, setValue] = useState(initial);
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
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); if (!done.current) { done.current = true; onCancel(); } }
      }}
    />
  );
}
