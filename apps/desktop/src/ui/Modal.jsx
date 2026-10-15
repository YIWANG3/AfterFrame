import { useEffect } from "react";
import { createPortal } from "react-dom";
import cx from "./cx";
import { Z } from "./zIndex";

// Shared overlay shell: fixed backdrop + centered card + Escape/backdrop
// close + named z-index. Replaces the hand-rolled `fixed inset-0` shells,
// each of which wired its own Escape listener and invented its own z number.
//
//   z          key into the Z ladder (default "overlayTop") or a number
//   backdrop   "dim" (black/45 + slight blur) | "app" (app-tinted: settings,
//              confirm, dialogs) | "none" (the child paints the whole screen)
//   escape     true: Escape closes (bubbling, on document) | "capture": the
//              listener runs first, on window, for a shell that must win over
//              the view below (confirm, compare) | false: the caller owns Escape
//   portal     render into document.body, so the shell is compared with the
//              body-portaled popovers rather than with its parent's layer
//   card       false to render children bare (caller draws its own surface)
//   size       the card's dimensions, replacing the default — Tailwind orders
//              arbitrary values alphabetically, so a `max-w-[360px]` appended
//              to the default `max-w-[380px]` would lose
//   className  extra classes on the card (layout, padding)
//   cardProps  attributes on the card (role, aria-label, data-* hooks)
//   ...rest    attributes on the root (ref, tabIndex, data-top-layer, key handlers)
const BACKDROPS = {
  dim: "bg-black/45 backdrop-blur-[2px]",
  app: "bg-app/80 backdrop-blur-sm",
  none: "",
};

export default function Modal({
  onClose,
  z = "overlayTop",
  backdrop = "dim",
  escape = true,
  portal = false,
  card = true,
  size = "w-full max-w-[380px]",
  className = "",
  rootClassName = "",
  cardProps,
  children,
  ...rest
}) {
  useEffect(() => {
    if (!escape) return undefined;
    const capture = escape === "capture";
    const target = capture ? window : document;
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose?.();
      }
    }
    target.addEventListener("keydown", onKey, capture);
    return () => target.removeEventListener("keydown", onKey, capture);
  }, [onClose, escape]);

  const zIndex = typeof z === "number" ? z : Z[z] ?? Z.overlayTop;
  const node = (
    <div
      {...rest}
      className={cx("fixed inset-0 flex items-center justify-center px-5", BACKDROPS[backdrop] ?? BACKDROPS.dim, rootClassName)}
      style={{ zIndex }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      {card ? (
        <div
          {...cardProps}
          className={cx(size, "overflow-hidden rounded-xl border border-border/60 bg-chrome shadow-overlay", className)}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
  return portal ? createPortal(node, document.body) : node;
}
