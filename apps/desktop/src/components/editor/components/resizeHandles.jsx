// The eight resize handles a rectangle on the stage wears (the crop box, the
// split region): where each sits, what cursor it shows, and the white L /
// bar drawn inside it.

export const HANDLE_LENGTH = 24;
const HANDLE_THICKNESS = 3;

export const HANDLE_SPECS = [
  { key: "nw", type: "corner", style: { left: -1, top: -1 }, cursor: "nwse-resize" },
  { key: "ne", type: "corner", style: { right: -1, top: -1, transform: "scaleX(-1)" }, cursor: "nesw-resize" },
  { key: "sw", type: "corner", style: { left: -1, bottom: -1, transform: "scaleY(-1)" }, cursor: "nesw-resize" },
  { key: "se", type: "corner", style: { right: -1, bottom: -1, transform: "scale(-1,-1)" }, cursor: "nwse-resize" },
  { key: "n", type: "edge-x", style: { left: "50%", top: -1, transform: "translateX(-50%)" }, cursor: "ns-resize" },
  { key: "s", type: "edge-x", style: { left: "50%", bottom: -1, transform: "translateX(-50%) scaleY(-1)" }, cursor: "ns-resize" },
  { key: "w", type: "edge-y", style: { left: -1, top: "50%", transform: "translateY(-50%)" }, cursor: "ew-resize" },
  { key: "e", type: "edge-y", style: { right: -1, top: "50%", transform: "translateY(-50%) scaleX(-1)" }, cursor: "ew-resize" },
];

export function HandleVisual({ type }) {
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
