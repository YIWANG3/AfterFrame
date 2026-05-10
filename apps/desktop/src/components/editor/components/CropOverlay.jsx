// Non-rotating crop UI — dimming scrims around the crop rect, the rule-of-
// thirds grid inside, and the 8 corner/edge resize handles. Owns its own
// constants and handle visuals.

const HANDLE_LENGTH = 24;
const HANDLE_THICKNESS = 3;
const EDGE_HANDLE_LENGTH = 24;

const HANDLE_SPECS = [
  { key: "nw", type: "corner", style: { left: -1, top: -1 }, cursor: "nwse-resize" },
  { key: "ne", type: "corner", style: { right: -1, top: -1, transform: "scaleX(-1)" }, cursor: "nesw-resize" },
  { key: "sw", type: "corner", style: { left: -1, bottom: -1, transform: "scaleY(-1)" }, cursor: "nesw-resize" },
  { key: "se", type: "corner", style: { right: -1, bottom: -1, transform: "scale(-1,-1)" }, cursor: "nwse-resize" },
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
    return <div className="absolute left-1/2 top-0 -translate-x-1/2 bg-white" style={{ width: `${EDGE_HANDLE_LENGTH}px`, height: `${HANDLE_THICKNESS}px` }} />;
  }
  return <div className="absolute left-0 top-1/2 -translate-y-1/2 bg-white" style={{ width: `${HANDLE_THICKNESS}px`, height: `${EDGE_HANDLE_LENGTH}px` }} />;
}

export default function CropOverlay({ cropRect, viewportSize, onBeginResize }) {
  if (!cropRect) return null;
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 10 }}>
      {/* Dim scrims around the crop rect */}
      <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: `${Math.max(0, cropRect.y)}px`, backgroundColor: "var(--crop-scrim)" }} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: `${Math.max(0, viewportSize.height - cropRect.y - cropRect.height)}px`, backgroundColor: "var(--crop-scrim)" }} />
      <div className="pointer-events-none absolute" style={{ left: 0, top: `${Math.max(0, cropRect.y)}px`, width: `${Math.max(0, cropRect.x)}px`, height: `${Math.min(cropRect.height, viewportSize.height - Math.max(0, cropRect.y))}px`, backgroundColor: "var(--crop-scrim)" }} />
      <div className="pointer-events-none absolute" style={{ right: 0, top: `${Math.max(0, cropRect.y)}px`, width: `${Math.max(0, viewportSize.width - cropRect.x - cropRect.width)}px`, height: `${Math.min(cropRect.height, viewportSize.height - Math.max(0, cropRect.y))}px`, backgroundColor: "var(--crop-scrim)" }} />

      {/* Crop frame + rule-of-thirds grid + 8 resize handles */}
      <div
        className="pointer-events-none absolute"
        style={{
          left: `${cropRect.x}px`,
          top: `${cropRect.y}px`,
          width: `${cropRect.width}px`,
          height: `${cropRect.height}px`,
          border: "1.5px solid rgba(255,255,255,0.9)",
        }}
      >
        <div className="pointer-events-none absolute inset-y-0" style={{ left: "33.333%", width: "1.5px", backgroundColor: "rgba(255,255,255,0.6)" }} />
        <div className="pointer-events-none absolute inset-y-0" style={{ left: "66.666%", width: "1.5px", backgroundColor: "rgba(255,255,255,0.6)" }} />
        <div className="pointer-events-none absolute inset-x-0" style={{ top: "33.333%", height: "1.5px", backgroundColor: "rgba(255,255,255,0.6)" }} />
        <div className="pointer-events-none absolute inset-x-0" style={{ top: "66.666%", height: "1.5px", backgroundColor: "rgba(255,255,255,0.6)" }} />

        {HANDLE_SPECS.map((handle) => (
          <div
            key={handle.key}
            className="pointer-events-auto absolute"
            style={{
              ...handle.style,
              zIndex: 20,
              width: `${HANDLE_LENGTH}px`,
              height: `${HANDLE_LENGTH}px`,
              cursor: handle.cursor,
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
