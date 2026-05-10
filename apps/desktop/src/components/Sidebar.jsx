import { useState, useRef, useEffect } from "react";
import { Images, Clock, Star, Link, FolderPlus, Folder, Trash2, Pencil, Cannabis } from "lucide-react";
import { baseName, formatTimestamp, navItems } from "../utils/format";

const ICON_MAP = { Archive: Images, Clock, Star, Link };

function InlineEdit({ initial, onConfirm, onCancel }) {
  const ref = useRef(null);
  const done = useRef(false);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  function commit() {
    if (done.current) return;
    done.current = true;
    const trimmed = value.trim();
    if (trimmed && trimmed !== initial) {
      void onConfirm(trimmed);
    } else {
      onCancel();
    }
  }
  return (
    <input
      ref={ref}
      className="w-full rounded-md bg-hover px-2 py-0.5 text-[13px] text-text outline-none border border-accent/50"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); if (!done.current) { done.current = true; onCancel(); } }
      }}
    />
  );
}

export default function Sidebar({
  info,
  summary,
  status,
  setStatus,
  collections,
  activeCollectionId,
  onSelectCollection,
  onClearCollection,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onAddToCollection,
  onOpenStickerBrowser,
  stickerMode = false,
}) {
  const browse = navItems(summary);
  const rootSummary = [];
  if (Number(summary?.export_assets ?? 0)) rootSummary.push(`${summary.export_assets} assets`);
  if (summary?.updated_at) rootSummary.push(`updated ${formatTimestamp(summary.updated_at)}`);

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);

  function readDraggedAssetIds(event) {
    const raw = event.dataTransfer.getData("application/x-media-workspace-asset");
    if (raw) {
      try {
        const payload = JSON.parse(raw);
        if (Array.isArray(payload?.assetIds) && payload.assetIds.length) return payload.assetIds;
        if (payload?.assetId != null) return [payload.assetId];
      } catch {}
    }
    const plain = event.dataTransfer.getData("text/plain");
    if (plain) {
      try {
        const payload = JSON.parse(plain);
        if (Array.isArray(payload?.assetIds) && payload.assetIds.length) return payload.assetIds;
        if (payload?.assetId != null) return [payload.assetId];
      } catch {}
    }
    try {
      if (Array.isArray(window.__mediaWorkspaceDraggingAssetIds) && window.__mediaWorkspaceDraggingAssetIds.length) {
        return window.__mediaWorkspaceDraggingAssetIds;
      }
      if (window.__mediaWorkspaceDraggingAssetId != null) {
        return [window.__mediaWorkspaceDraggingAssetId];
      }
    } catch {}
    return [];
  }

  return (
    <aside className="flex h-full flex-col overflow-y-auto border-r border-border/40 bg-chrome px-3 py-3">
      <div className="mb-5 px-1">
        <div className="text-[13px] font-semibold tracking-[0.01em] text-text">{baseName(info?.catalogPath || "Untitled Catalog")}</div>
        <div className="mt-1 text-[11px] text-muted2">
          {rootSummary.length ? rootSummary.join(" · ") : "No indexed assets yet"}
        </div>
      </div>

      <nav className="flex-1 space-y-4">
        <div className="space-y-1">
          {browse.map((item) => {
            const Icon = ICON_MAP[item.icon];
            const active = !activeCollectionId && !stickerMode && item.key === status;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  onClearCollection?.({ reload: false });
                  setStatus(item.key);
                }}
                className={[
                  "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors",
                  active
                    ? "bg-selected text-text"
                    : "text-muted hover:bg-hover/70 hover:text-text",
                ].join(" ")}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className={`h-4 w-4 stroke-[1.6] ${active ? "text-accent" : ""}`} />
                  <span className="text-[13px]">{item.label}</span>
                </span>
                <span className={`text-[11px] tabular-nums ${active ? "text-accent" : "text-muted2"}`}>{item.count}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={(e) => { e.currentTarget.blur(); onOpenStickerBrowser?.(); }}
            className={[
              "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left outline-none transition-colors focus:outline-none focus-visible:outline-none",
              stickerMode
                ? "bg-selected text-text"
                : "text-muted hover:bg-hover/70 hover:text-text",
            ].join(" ")}
          >
            <span className="flex items-center gap-2.5">
              <Cannabis className={`h-4 w-4 stroke-[1.6] ${stickerMode ? "text-accent" : ""}`} />
              <span className="text-[13px]">Stickers</span>
            </span>
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between px-2.5 pb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">Folders</span>
            <button
              type="button"
              className="rounded-md p-0.5 text-muted2 transition-colors hover:bg-hover hover:text-text"
              title="New folder"
              onClick={() => setCreatingFolder(true)}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="space-y-0.5">
            {creatingFolder && (
              <div className="px-2.5 py-0.5">
                <InlineEdit
                  initial=""
                  onConfirm={async (name) => {
                    await onCreateCollection?.(name);
                    setCreatingFolder(false);
                  }}
                  onCancel={() => setCreatingFolder(false)}
                />
              </div>
            )}

            {(collections || []).filter((c) => c.kind === "manual").map((col) => {
              const active = activeCollectionId === col.collection_id;
              if (editingId === col.collection_id) {
                return (
                  <div key={col.collection_id} className="px-2.5 py-0.5">
                    <InlineEdit
                      initial={col.name}
                      onConfirm={async (name) => {
                        await onRenameCollection?.(col.collection_id, name);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                );
              }
              return (
                <div
                  key={col.collection_id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectCollection?.(col.collection_id)}
                  onKeyDown={(e) => { if (e.key === "Enter") onSelectCollection?.(col.collection_id); }}
                  onDragOver={(event) => {
                    if (!readDraggedAssetIds(event).length) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    if (dropTargetId !== col.collection_id) {
                      setDropTargetId(col.collection_id);
                    }
                  }}
                  onDragEnter={(event) => {
                    if (!readDraggedAssetIds(event).length) return;
                    event.preventDefault();
                    setDropTargetId(col.collection_id);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      setDropTargetId((current) => (current === col.collection_id ? null : current));
                    }
                  }}
                  onDrop={async (event) => {
                    const assetIds = readDraggedAssetIds(event);
                    event.preventDefault();
                    setDropTargetId(null);
                    window.__mediaWorkspaceDraggingAssetId = null;
                    window.__mediaWorkspaceDraggingAssetIds = null;
                    if (!assetIds.length) return;
                    await onAddToCollection?.(col.collection_id, assetIds);
                  }}
                  className={[
                    "group flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors",
                    dropTargetId === col.collection_id && !active
                      ? "bg-hover text-text ring-1 ring-accent/45"
                      : "",
                    active
                      ? "bg-selected text-text"
                      : "text-muted hover:bg-hover/70 hover:text-text",
                  ].join(" ")}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Folder className={`h-4 w-4 shrink-0 stroke-[1.6] ${active ? "text-accent" : ""}`} />
                    <span className="min-w-0 truncate text-[13px]">{col.name}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className={`text-[11px] tabular-nums ${active ? "text-accent" : "text-muted2"}`}>
                      {col.item_count || 0}
                    </span>
                    <span className="hidden gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        className="rounded-md p-0.5 text-muted2 hover:text-text"
                        title="Rename"
                        onClick={(e) => { e.stopPropagation(); setEditingId(col.collection_id); }}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-0.5 text-muted2 hover:text-red-400"
                        title="Delete"
                        onClick={(e) => { e.stopPropagation(); onDeleteCollection?.(col.collection_id); }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  </span>
                </div>
              );
            })}

            {!(collections || []).some((c) => c.kind === "manual") && !creatingFolder && (
              <div className="px-2.5 py-2 text-[11px] text-muted2">No folders yet</div>
            )}
          </div>
        </div>
      </nav>
    </aside>
  );
}
