// Drag divider between the MapDrawer and the Gallery. Pointer drags resize
// with transitions off (the parent passes onResizingChange); arrow keys nudge
// for keyboard access; double-click restores the default height.
export default function MapResizeHandle({ mapHeight, onHeightChange, onResizingChange, minHeight, maxHeight, defaultHeight, label }) {
  const clamp = (value) => Math.min(maxHeight, Math.max(minHeight, Math.round(value)));

  function handlePointerDown(event) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = mapHeight;
    onResizingChange?.(true);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    function handleMove(moveEvent) {
      onHeightChange(clamp(startHeight + (moveEvent.clientY - startY)));
    }
    function handleUp(upEvent) {
      target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener("pointermove", handleMove);
      target.removeEventListener("pointerup", handleUp);
      onResizingChange?.(false);
    }
    target.addEventListener("pointermove", handleMove);
    target.addEventListener("pointerup", handleUp);
  }

  function handleKeyDown(event) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onHeightChange(clamp(mapHeight + (event.key === "ArrowDown" ? 24 : -24)));
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={mapHeight}
      aria-valuemin={minHeight}
      aria-valuemax={maxHeight}
      tabIndex={0}
      data-testid="map-resize-handle"
      className="group flex h-full cursor-row-resize items-center justify-center outline-none"
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => onHeightChange(clamp(defaultHeight))}
    >
      <div className="h-[3px] w-10 rounded-full bg-border/70 transition-colors group-hover:bg-accent/70 group-focus-visible:bg-accent" />
    </div>
  );
}
