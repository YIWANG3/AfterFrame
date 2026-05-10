import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, Star, Trash2, FolderOpen, ChevronRight, Cannabis, Eye } from "lucide-react";
import { localFileUrl, fileName, stickerLabel } from "../utils/format";

// Sticker view that slots into the main App layout (replacing Toolbar+Gallery
// in the center pane and the Inspector on the right when active). Same chrome
// language as the photo gallery — square thumbs only, no filter/sort/display
// modes, just search.

const THUMB_MIN = 180;
const GAP = 12;

/* ─── Top toolbar — replacement for Toolbar.jsx ─────────────── */

export function StickerToolbar({ count, query, setQuery }) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/40 bg-chrome px-3 text-[12px]">
      <div className="flex items-center gap-2 text-muted2">
        <Cannabis className="h-4 w-4" />
        <span className="text-text">Stickers</span>
        <span className="text-muted3">· {count}</span>
      </div>
      <div className="relative w-[280px]">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted3" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search stickers…"
          className="h-7 w-full rounded-md border border-border/60 bg-app pl-7 pr-2 text-[12px] text-text outline-none placeholder:text-muted3 focus:border-[rgb(var(--accent-color))]"
        />
      </div>
    </div>
  );
}

/* ─── Main grid area — replacement for Gallery.jsx ───────────── */

export function StickerGallery({ stickers, query, selectedId, onSelect, onDelete, loading }) {
  const [contextMenu, setContextMenu] = useState(null);
  const filtered = useMemo(() => {
    if (!query?.trim()) return stickers;
    const q = query.trim().toLowerCase();
    return stickers.filter((s) =>
      stickerLabel(s).toLowerCase().includes(q) ||
      (s.sourcePath || "").toLowerCase().includes(q),
    );
  }, [stickers, query]);

  if (loading) {
    return <div className="grid h-full place-items-center text-[13px] text-muted">Loading…</div>;
  }
  if (filtered.length === 0) {
    return <EmptyState query={query} />;
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${THUMB_MIN}px, 1fr))`,
          gap: `${GAP}px`,
        }}
      >
        {filtered.map((s) => (
          <StickerCard
            key={s.id}
            sticker={s}
            selected={selectedId === s.id}
            onSelect={() => onSelect(s)}
            onContextMenu={(e) => {
              e.preventDefault();
              onSelect(s);
              setContextMenu({ x: e.clientX, y: e.clientY, sticker: s });
            }}
          />
        ))}
      </div>
      {contextMenu && (
        <StickerContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          sticker={contextMenu.sticker}
          onReveal={() => window.mediaWorkspace?.revealPath?.(contextMenu.sticker.path)}
          onDelete={() => onDelete?.(contextMenu.sticker)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function StickerCard({ sticker, selected, onSelect, onContextMenu }) {
  const title = stickerLabel(sticker);
  return (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/x-afterframe-sticker", JSON.stringify({
          id: sticker.id, path: sticker.path,
        }));
      }}
      className="group flex flex-col text-left focus:outline-none"
    >
      <div
        className={[
          "relative aspect-square overflow-hidden rounded-md bg-checker transition-all duration-200",
          selected
            ? "ring-2 ring-accent shadow-glow"
            : "ring-1 ring-border/40 group-hover:ring-accent/40 group-hover:shadow-card-hover",
        ].join(" ")}
      >
        <img
          src={localFileUrl(sticker.path)}
          alt=""
          className="h-full w-full object-contain p-2"
          draggable={false}
        />
        {sticker.starred && (
          <div className="absolute left-1.5 top-1.5 rounded-full bg-black/45 p-0.5">
            <Star className="h-3 w-3 fill-[rgb(225,180,105)] text-[rgb(225,180,105)]" />
          </div>
        )}
      </div>
      <div className="truncate px-0.5 pt-1.5 text-[11px] text-muted" title={title}>
        {title}
      </div>
    </button>
  );
}

function StickerContextMenu({ x, y, sticker, onReveal, onDelete, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    function handlePointerDown(e) {
      if (e.button !== 0) return;
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function handleContextMenu(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function handleKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Clamp to viewport
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    let nx = x, ny = y;
    if (x + rect.width > window.innerWidth - 8) nx = x - rect.width;
    if (y + rect.height > window.innerHeight - 8) ny = Math.max(8, y - rect.height);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[12000] min-w-[200px] rounded-md border border-border/60 bg-chrome py-1 shadow-menu"
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
    >
      <MenuItem icon={Eye} label="Reveal in Finder" onClick={() => { onReveal?.(); onClose(); }} />
      <div className="my-1 border-t border-border/40" />
      <MenuItem icon={Trash2} label="Delete sticker" onClick={() => { onDelete?.(); onClose(); }} danger />
    </div>,
    document.body,
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors",
        danger
          ? "text-[rgb(var(--error-color))] hover:bg-[rgb(var(--error-color)/0.1)]"
          : "text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function EmptyState({ query }) {
  return (
    <div className="grid h-full place-items-center px-8 py-10">
      <div className="max-w-md rounded-lg border border-dashed border-border/60 px-8 py-10 text-center">
        <div className="text-[13px] text-text">
          {query ? `No stickers match "${query}"` : "No stickers yet"}
        </div>
        <div className="mt-2 text-[12px] leading-relaxed text-muted2">
          {query
            ? "Try a different search."
            : "Open any photo in the editor → switch to the Sticker tool → Create new."}
        </div>
      </div>
    </div>
  );
}

/* ─── Right pane — replacement for Inspector.jsx ─────────────── */

export function StickerInspector({ sticker, onStar }) {
  if (!sticker) {
    return (
      <aside className="flex h-full items-center justify-center overflow-y-auto bg-chrome px-4">
        <div className="text-center">
          <div className="text-[12px] text-muted">Select a sticker</div>
        </div>
      </aside>
    );
  }
  const dimensions = sticker.width && sticker.height
    ? `${sticker.width} × ${sticker.height}`
    : "Unknown";
  const created = sticker.createdAt ? new Date(sticker.createdAt).toLocaleString() : "Unknown";

  return (
    <aside className="flex h-full flex-col overflow-hidden border-l border-border/40 bg-chrome">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="relative mb-4 flex h-[200px] items-center justify-center overflow-hidden rounded bg-checker">
          <img
            src={localFileUrl(sticker.path)}
            alt=""
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
          <span className="absolute left-2 top-2 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white">
            PNG
          </span>
        </div>

        <div className="px-0.5">
          <h2 className="truncate text-[13px] font-medium leading-tight text-text" title={stickerLabel(sticker)}>
            {stickerLabel(sticker)}
          </h2>

          <Section title="Properties">
            <DetailRow label="Starred">
              <button
                type="button"
                onClick={onStar}
                className="p-0.5"
                title={sticker.starred ? "Unstar" : "Star"}
              >
                <Star
                  className={`h-3.5 w-3.5 ${sticker.starred ? "fill-[rgb(225,180,105)] text-[rgb(225,180,105)]" : "text-muted2/40 hover:text-muted2/60"}`}
                />
              </button>
            </DetailRow>
            <DetailRow label="Dimensions">{dimensions}</DetailRow>
            <DetailRow label="Format">PNG (alpha)</DetailRow>
            <DetailRow label="Created">{created}</DetailRow>
          </Section>

          <Section title="Outline">
            <DetailRow label="Width">{sticker.outlineWidth ?? 0} px</DetailRow>
            <DetailRow label="Color">
              <div className="flex items-center gap-1.5">
                <div
                  className="h-3 w-3 rounded border border-border/60"
                  style={{ backgroundColor: sticker.outlineColor || "#ffffff" }}
                />
                <span className="font-mono text-[11px]">{(sticker.outlineColor || "#ffffff").toUpperCase()}</span>
              </div>
            </DetailRow>
          </Section>

          <Section title="Source">
            <DetailRow label="File">
              <span className="truncate" title={sticker.sourcePath}>
                {sticker.sourceLabel || fileName(sticker.sourcePath) || "—"}
              </span>
            </DetailRow>
            {sticker.sourcePath ? (
              <DetailRow label="Path">
                <button
                  type="button"
                  onClick={() => window.mediaWorkspace?.revealPath?.(sticker.sourcePath)}
                  className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-text"
                  title={sticker.sourcePath}
                >
                  <FolderOpen className="h-3 w-3" />
                  Show in Finder
                </button>
              </DetailRow>
            ) : null}
            <DetailRow label="Sticker">
              <button
                type="button"
                onClick={() => window.mediaWorkspace?.revealPath?.(sticker.path)}
                className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-text"
              >
                <FolderOpen className="h-3 w-3" />
                Show PNG
              </button>
            </DetailRow>
          </Section>

        </div>
      </div>
    </aside>
  );
}

/* ─── Hook to manage sticker state for App.jsx ────────────── */

export function useStickerView() {
  const [stickers, setStickers] = useState([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.mediaWorkspace?.stickerList) return;
    setLoading(true);
    try {
      const list = await window.mediaWorkspace.stickerList();
      setStickers(list || []);
      setSelected((sel) => sel ? list.find((s) => s.id === sel.id) || null : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleStar = useCallback(async () => {
    if (!selected) return;
    await window.mediaWorkspace.stickerToggleStar(selected.id);
    refresh();
  }, [selected, refresh]);

  const handleDelete = useCallback(async (target) => {
    const sticker = target || selected;
    if (!sticker) return;
    if (!confirm(`Delete this sticker?\n${stickerLabel(sticker)}`)) return;
    await window.mediaWorkspace.stickerDelete(sticker.id);
    setSelected((cur) => (cur?.id === sticker.id ? null : cur));
    refresh();
  }, [selected, refresh]);

  return { stickers, query, setQuery, selected, setSelected, loading, refresh, handleStar, handleDelete };
}

/* ─── Local helpers (mirroring Inspector.jsx) ──────────────── */

function DetailRow({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[12px] leading-[1.4]">
      <div className="shrink-0 text-muted">{label}</div>
      <div className="min-w-0 break-words text-right text-text">{children}</div>
    </div>
  );
}

function Section({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-4 border-t border-border/40 pt-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{title}</span>
        <ChevronRight className={`h-3 w-3 text-muted2 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}
