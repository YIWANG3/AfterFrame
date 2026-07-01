// The bordered, glassy container that houses the active tool's panel on the
// right side of the editor, with a title/badge header. Wraps whatever panel the
// parent renders as children. Extracted from EditorOverlay (Phase 4).

export default function PanelChrome({ panelMeta, width, children }) {
  return (
    <div
      className="pointer-events-auto overflow-hidden rounded-xl border border-border/60 bg-chrome/95 shadow-overlay backdrop-blur-xl"
      style={{ width: `${width}px` }}
      data-editor-wheel-scope="panel"
    >
      <div className="flex h-6 items-center justify-between border-b border-border/60 bg-panel2 px-3">
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[rgb(var(--accent-color)/0.72)]">{panelMeta.title}</div>
        {panelMeta.badge ? (
          <div className="rounded-full bg-[rgb(var(--accent-color)/0.10)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[rgb(var(--accent-color))]">
            {panelMeta.badge}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
