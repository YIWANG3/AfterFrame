import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Context menu for face-correction actions. `items`: [{key, icon, label, onClick}].
export default function FaceMenu({ position, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    function down(e) { if (!ref.current?.contains(e.target)) onClose(); }
    function key(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);
  const left = Math.min(position.x, window.innerWidth - 228);
  const top = Math.min(position.y, window.innerHeight - items.length * 30 - 16);
  return createPortal(
    <div ref={ref} className="fixed z-[12000] w-[220px] rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay" style={{ left, top }}>
      {items.map(({ key, icon: Icon, label, onClick }) => (
        <button
          key={key}
          type="button"
          onClick={() => { onClose(); onClick(); }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] text-text transition hover:bg-hover"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted2" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
