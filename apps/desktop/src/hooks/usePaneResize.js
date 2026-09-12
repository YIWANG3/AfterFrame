import { useCallback } from "react";
import { clamp } from "../utils/format";

export default function usePaneResize(setter, min, max) {
  return useCallback(
    (event) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.dataset.dragging = "true";
      const startX = event.clientX;
      const startValue = Number(event.currentTarget.dataset.value || 0);
      function handleMove(moveEvent) {
        const delta = moveEvent.clientX - startX;
        setter(clamp(startValue + delta, min, max));
      }
      function handleUp() {
        delete handle.dataset.dragging;
        window.removeEventListener("blur", handleUp);
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      }
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
      window.addEventListener("blur", handleUp);
    },
    [setter, min, max],
  );
}
