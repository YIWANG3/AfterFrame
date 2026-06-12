import { useEffect } from "react";
import cx from "./cx";
import { Z } from "./zIndex";

// Shared overlay shell: fixed backdrop + centered card + Escape/backdrop
// close + named z-index. Replaces 8 hand-rolled `fixed inset-0` shells, each
// of which wired its own Escape listener and invented its own z number.
//
//   z         key into the Z ladder (default "overlayTop") or a number
//   backdrop  "dim" (black/45 + slight blur) | "app" (app-tinted, settings style)
//   card      false to render children bare (caller draws its own surface)
export default function Modal({
  onClose,
  z = "overlayTop",
  backdrop = "dim",
  card = true,
  className = "",
  children,
}) {
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose?.();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const zIndex = typeof z === "number" ? z : Z[z] ?? Z.overlayTop;
  return (
    <div
      className={cx(
        "fixed inset-0 flex items-center justify-center px-5",
        backdrop === "app" ? "bg-app/80 backdrop-blur-sm" : "bg-black/45 backdrop-blur-[2px]",
      )}
      style={{ zIndex }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      {card ? (
        <div className={cx("w-full max-w-[380px] overflow-hidden rounded-xl border border-border/60 bg-chrome shadow-overlay", className)}>
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
