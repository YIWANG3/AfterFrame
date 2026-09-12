// The bordered, glassy container that houses the active tool's panel on the
// right side of the editor. Wraps whatever panel the parent renders as
// children. Extracted from EditorOverlay (Phase 4). The title header was
// dropped in the Tahoe skin: the tool rail already says which panel is open.

export default function PanelChrome({ width, children }) {
  return (
    <div
      className="pointer-events-auto overflow-hidden rounded-xl border border-border/60 bg-chrome/95 shadow-overlay backdrop-blur-xl"
      style={{ width: `${width}px` }}
      data-editor-wheel-scope="panel"
    >
      {children}
    </div>
  );
}
