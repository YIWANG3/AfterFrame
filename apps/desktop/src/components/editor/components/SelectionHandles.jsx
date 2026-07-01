// Shared selection chrome for on-canvas editing: a dashed bounding box, 8
// resize handles, and a rotate handle. Presentational only — the parent wires
// onResizeStart / onRotateStart to its own drag math. Extracted verbatim from
// TextCanvas so text layers and frame elements share ONE handle UI.

const HANDLE_SIZE = 7;
const ROT_HANDLE_DIST = 28;
const ROT_HANDLE_RADIUS = 5;
const ACCENT = "rgb(210, 160, 90)";

export default function SelectionHandles({ onResizeStart, onRotateStart }) {
  const pad = 8;
  // Map percentage positions to account for the pad offset so handles sit on the dashed border
  const mapPos = (pct) => {
    if (pct === "0%") return `-${pad}px`;
    if (pct === "50%") return `calc(50% - 0px)`;
    if (pct === "100%") return `calc(100% + ${pad}px)`;
    return pct;
  };
  const handleStyle = (x, y, cursor) => ({
    position: "absolute",
    left: `calc(${mapPos(x)} - ${HANDLE_SIZE / 2}px)`,
    top: `calc(${mapPos(y)} - ${HANDLE_SIZE / 2}px)`,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    backgroundColor: ACCENT,
    border: "1.5px solid #fff",
    cursor: `${cursor}-resize`,
    zIndex: 3,
  });

  return (
    <>
      <div style={{ position: "absolute", inset: `-${pad}px`, border: `1.5px dashed ${ACCENT}`, pointerEvents: "none" }} />
      {[
        ["0%", "0%", "nwse"], ["50%", "0%", "ns"], ["100%", "0%", "nesw"],
        ["0%", "50%", "ew"], ["100%", "50%", "ew"],
        ["0%", "100%", "nesw"], ["50%", "100%", "ns"], ["100%", "100%", "nwse"],
      ].map(([x, y, cursor], i) => (
        <div key={i} style={handleStyle(x, y, cursor)} onPointerDown={(e) => onResizeStart(e)} />
      ))}
      <div style={{ position: "absolute", left: "50%", top: `-${pad}px`, width: 1.5, height: ROT_HANDLE_DIST, backgroundColor: ACCENT, opacity: 0.5, transform: "translate(-50%, -100%)", pointerEvents: "none" }} />
      <div
        style={{ position: "absolute", left: "50%", top: `-${pad + ROT_HANDLE_DIST}px`, width: ROT_HANDLE_RADIUS * 2, height: ROT_HANDLE_RADIUS * 2, borderRadius: "50%", backgroundColor: ACCENT, border: "1.5px solid #fff", transform: "translate(-50%, -50%)", cursor: "grab" }}
        onPointerDown={(e) => onRotateStart(e)}
      />
    </>
  );
}
