import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

// Shared toast infra. Rendered once at the App root, fed by `pushToast` returned
// from `useToasts`. Pass `pushToast` down to anywhere that wants to surface a
// transient message — saves, errors, background-job completions, etc.

let _seq = 0;

export function useToasts() {
  const [toasts, setToasts] = useState([]);

  const dismissToast = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((toast) => {
    const id = ++_seq;
    const ttl = toast.ttl ?? 20_000;
    setToasts((list) => [...list, { id, ...toast }]);
    if (ttl > 0) {
      setTimeout(() => {
        setToasts((list) => list.filter((t) => t.id !== id));
      }, ttl);
    }
    return id;
  }, []);

  return { toasts, pushToast, dismissToast };
}

export default function ToastStack({ toasts, onDismiss }) {
  if (!toasts?.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[20000] flex flex-col-reverse gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }) {
  const [entered, setEntered] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      ref={ref}
      className={[
        "pointer-events-auto w-[340px] rounded-xl border border-border/60 bg-chrome/95 p-3 shadow-overlay backdrop-blur-xl transition-all duration-200",
        entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      ].join(" ")}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {toast.title && (
            <div className="text-[12px] font-medium text-text">{toast.title}</div>
          )}
          {toast.message && (
            <div className="mt-0.5 truncate text-[11px] text-muted2" title={toast.message}>
              {toast.message}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted2 transition-colors hover:bg-hover hover:text-text"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {toast.actions?.length ? (
        <div className="mt-2 flex gap-2">
          {toast.actions.map((action, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                action.onClick?.();
                if (action.dismissOnClick !== false) onDismiss();
              }}
              className={[
                "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                action.primary
                  ? "bg-[rgb(var(--accent-color))] text-[rgb(var(--accent-fg))] hover:opacity-90"
                  : "border border-border/60 bg-app text-text hover:border-border hover:bg-hover",
              ].join(" ")}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
