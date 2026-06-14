import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

/* ─── ConfirmDialog ───────────────────────────────────────────
   App-styled replacement for the native confirm dialog. Promise-
   driven via App's requestConfirm(): renders only while a request
   is pending. Enter confirms, Esc / backdrop click cancels. The
   Cancel button is focused by default so a stray Enter on a
   destructive action doesn't fire the dangerous path. */

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
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    cancelRef.current?.focus();
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel?.(); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onConfirm?.(); }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[13000] flex items-center justify-center bg-app/80 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
    >
      <div className="w-[400px] max-w-[90vw] rounded-xl border border-border bg-chrome p-6 shadow-overlay">
        <div className="flex flex-col items-center text-center">
          <div className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full ${danger ? "bg-red-500/15 text-red-400" : "bg-accent/15 text-accent"}`}>
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h2 className="text-[15px] font-semibold text-text">{title}</h2>
          {message && <p className="mt-2 text-[13px] text-muted">{message}</p>}
          {detail && <p className="mt-1.5 text-[12px] leading-relaxed text-muted2">{detail}</p>}
        </div>
        <div className="mt-6 flex gap-2.5">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border border-border bg-transparent px-4 py-2 text-[13px] font-medium text-text transition-colors hover:bg-hover"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`flex-1 rounded-lg px-4 py-2 text-[13px] font-medium text-white transition-colors ${danger ? "bg-red-600 hover:bg-red-500" : "bg-accent hover:bg-accent/90"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
