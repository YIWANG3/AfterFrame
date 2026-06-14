import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

/* ─── ConfirmDialog ───────────────────────────────────────────
   App-styled, presentational confirm dialog. Usually driven via
   the global confirm() helper (see confirm.jsx) so any component
   can request a confirmation without prop drilling. Esc cancels;
   no button is auto-focused (a destructive default would be a
   foot-gun) so there's no stray focus ring. */

export default function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel?.(); }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[13000] flex items-center justify-center bg-app/70 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
    >
      <div className="w-[320px] max-w-[90vw] rounded-xl border border-border bg-chrome p-5 shadow-overlay">
        <div className="flex flex-col items-center text-center">
          <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-full ${danger ? "bg-red-500/15 text-red-400" : "bg-accent/15 text-accent"}`}>
            <AlertTriangle className="h-[18px] w-[18px]" />
          </div>
          <h2 className="text-[13.5px] font-semibold text-text">{title}</h2>
          {message && <p className="mt-1.5 text-[12.5px] leading-snug text-muted">{message}</p>}
          {detail && <p className="mt-1 text-[11.5px] leading-relaxed text-muted2">{detail}</p>}
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border border-border bg-transparent px-3 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:bg-hover focus:outline-none"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`flex-1 rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors focus:outline-none ${danger ? "bg-red-600 hover:bg-red-500" : "bg-accent hover:bg-accent/90"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
