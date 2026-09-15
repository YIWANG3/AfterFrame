// Seamless split UI on the canvas: dim scrims around the covered region, the
// N-1 panel dividers with panel numbers inside, four aspect-locked corner
// handles, and a move surface over the region. Same visual language as
// CropOverlay (which owns crop; this owns the split region).

import { panelBoundaries } from "../splitMath";

const HANDLE_LENGTH = 24;
const HANDLE_THICKNESS = 3;

const HANDLE_SPECS = [
  { key: "nw", type: "corner", style: { left: -1, top: -1 }, cursor: "nwse-resize" },
  { key: "ne", type: "corner", style: { right: -1, top: -1, transform: "scaleX(-1)" }, cursor: "nesw-resize" },
  { key: "sw", type: "corner", style: { left: -1, bottom: -1, transform: "scaleY(-1)" }, cursor: "nesw-resize" },
  { key: "se", type: "corner", style: { right: -1, bottom: -1, transform: "scale(-1,-1)" }, cursor: "nwse-resize" },
  // Edge handles only make sense when the aspect is free (like CropOverlay).
  { key: "n", type: "edge-x", style: { left: "50%", top: -1, transform: "translateX(-50%)" }, cursor: "ns-resize" },
  { key: "s", type: "edge-x", style: { left: "50%", bottom: -1, transform: "translateX(-50%) scaleY(-1)" }, cursor: "ns-resize" },
  { key: "w", type: "edge-y", style: { left: -1, top: "50%", transform: "translateY(-50%)" }, cursor: "ew-resize" },
  { key: "e", type: "edge-y", style: { right: -1, top: "50%", transform: "translateY(-50%) scaleX(-1)" }, cursor: "ew-resize" },
];

function HandleVisual({ type }) {
  if (type === "corner") {
    return (
      <>
        <div className="absolute left-0 top-0 bg-white" style={{ width: `${HANDLE_LENGTH}px`, height: `${HANDLE_THICKNESS}px` }} />
        <div className="absolute left-0 top-0 bg-white" style={{ width: `${HANDLE_THICKNESS}px`, height: `${HANDLE_LENGTH}px` }} />
      </>
    );
  }
  if (type === "edge-x") {
    return <div className="absolute left-1/2 top-0 -translate-x-1/2 bg-white" style={{ width: `${HANDLE_LENGTH}px`, height: `${HANDLE_THICKNESS}px` }} />;
  }
  return <div className="absolute left-0 top-1/2 -translate-y-1/2 bg-white" style={{ width: `${HANDLE_THICKNESS}px`, height: `${HANDLE_LENGTH}px` }} />;
}

export default function SplitOverlay({ rect, count, freeAspect = false, viewportSize, onBeginResize, onBeginMove }) {
  if (!rect || !count) return null;
  const bounds = panelBoundaries(rect.width, count);
  const top = Math.max(0, rect.y);
  const sideHeight = Math.min(rect.height, viewportSize.height - top);
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 10 }} data-testid="split-overlay">
      {/* Dim scrims around the region */}
      <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: `${top}px`, backgroundColor: "var(--crop-scrim)" }} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: `${Math.max(0, viewportSize.height - rect.y - rect.height)}px`, backgroundColor: "var(--crop-scrim)" }} />
      <div className="pointer-events-none absolute" style={{ left: 0, top: `${top}px`, width: `${Math.max(0, rect.x)}px`, height: `${sideHeight}px`, backgroundColor: "var(--crop-scrim)" }} />
      <div className="pointer-events-none absolute" style={{ right: 0, top: `${top}px`, width: `${Math.max(0, viewportSize.width - rect.x - rect.width)}px`, height: `${sideHeight}px`, backgroundColor: "var(--crop-scrim)" }} />

      <div
        className="pointer-events-none absolute"
        data-testid="split-region"
        style={{
          left: `${rect.x}px`,
          top: `${rect.y}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          border: "1.5px solid rgba(255,255,255,0.9)",
        }}
      >
        {/* Move surface: the whole region drags, handles sit above it */}
        <div
          className="pointer-events-auto absolute inset-0"
          style={{ cursor: "move", touchAction: "none" }}
          onPointerDown={onBeginMove}
        />

        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="pointer-events-none absolute inset-y-0" style={{ left: `${bounds[i]}px`, width: `${bounds[i + 1] - bounds[i]}px` }}>
            {i > 0 ? (
              <div className="absolute inset-y-0 left-0" style={{ width: "1px", borderLeft: "1px dashed rgba(255,255,255,0.85)" }} />
            ) : null}
            <div
              className="absolute left-2 top-2 rounded-full px-1.5 text-[10px] font-semibold tabular-nums text-white"
              style={{ backgroundColor: "rgba(0,0,0,0.65)", lineHeight: "16px" }}
            >
              {i + 1}
            </div>
          </div>
        ))}

        {HANDLE_SPECS.filter((handle) => freeAspect || handle.type === "corner").map((handle) => (
          <div
            key={handle.key}
            className="pointer-events-auto absolute"
            data-testid={`split-handle-${handle.key}`}
            style={{
              ...handle.style,
              zIndex: 20,
              width: `${HANDLE_LENGTH}px`,
              height: `${HANDLE_LENGTH}px`,
              cursor: handle.cursor,
              touchAction: "none",
            }}
            onPointerDown={(event) => onBeginResize(handle.key, event)}
          >
            <HandleVisual type={handle.type} />
          </div>
        ))}
      </div>
    </div>
  );
}
