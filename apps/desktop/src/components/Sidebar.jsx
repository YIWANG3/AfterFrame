import { useState, useRef, useEffect, Fragment } from "react";
import { useTranslation } from "react-i18next";
import api from "../api";
import { Images, Clock, Star, Link, FolderPlus, Folder, Trash2, Pencil, Cannabis, Settings as SettingsIcon, Sparkles, UsersRound, Image as ImageIcon, List, Compass } from "lucide-react";
import { DesktopHint } from "./DesktopOnly";
import { baseName, formatTimestamp, navItems, localFileUrl } from "../utils/format";

const FOLDER_VIEW_KEY = "sidebar.folderView"; // "list" | "covers"

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
  onAnnotateCollection,
  onAddToCollection,
  onOpenStickerBrowser,
  onOpenPeople,
  onOpenDiscover,
  onOpenSettings,
  stickerMode = false,
  peopleMode = false,
  discoverMode = false,
}) {
  const { t } = useTranslation("nav");
  const { t: tc } = useTranslation("common");
  const browse = navItems(summary);
  const rootSummary = [];
  if (Number(summary?.image_assets ?? 0)) rootSummary.push(t("sidebar.assetsCount", { count: summary.image_assets }));
  if (summary?.updated_at) rootSummary.push(t("sidebar.updated", { time: formatTimestamp(summary.updated_at) }));

  const [creatingFolder, setCreatingFolder] = useState(false);
  // Folder list view: plain rows, or rows with a cover thumbnail (demo C's library list).
  const [folderView, setFolderView] = useState(() => {
    try { return localStorage.getItem(FOLDER_VIEW_KEY) === "covers" ? "covers" : "list"; } catch { return "list"; }
  });
  const toggleFolderView = () => {
    setFolderView((v) => {
      const next = v === "covers" ? "list" : "covers";
      try { localStorage.setItem(FOLDER_VIEW_KEY, next); } catch { /* private mode */ }
      return next;
    });
  };
  // Covers: the sidecar's collection rows carry no cover, so fetch each
  // folder's first asset lazily (only in covers view), keyed by id + count so
  // a folder that gains/loses photos refreshes its cover.
  const [covers, setCovers] = useState({});
  const manualCollections = (collections || []).filter((c) => c.kind === "manual");
  const coverKey = manualCollections.map((c) => `${c.collection_id}:${c.item_count || 0}`).join("|");
  useEffect(() => {
    if (folderView !== "covers") return undefined;
    let cancelled = false;
    const stale = manualCollections.filter((c) => covers[c.collection_id]?.count !== (c.item_count || 0));
    if (!stale.length) return undefined;
    (async () => {
      const next = {};
      await Promise.all(stale.map(async (c) => {
        let path = null;
        if ((c.item_count || 0) > 0) {
          try {
            const rows = await api.browseCollection(c.collection_id, { limit: 1, offset: 0 });
            const first = Array.isArray(rows) ? rows[0] : rows?.items?.[0];
            path = first?.preview_path || first?.image_path || null;
          } catch { path = null; }
        }
        next[c.collection_id] = { path, count: c.item_count || 0 };
      }));
      if (!cancelled) setCovers((prev) => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderView, coverKey]);
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
        <div className="text-[13px] font-semibold tracking-[0.01em] text-text">
          {info?.catalogPath ? baseName(info.catalogPath) : t("sidebar.noCatalog")}
        </div>
        <div className="mt-1 text-[11px] text-muted2">
          {!info?.catalogPath
            ? t("sidebar.noCatalogHint")
            : rootSummary.length ? rootSummary.join(" · ") : t("sidebar.noAssets")}
        </div>
      </div>

      <nav className="flex-1 space-y-4">
        <div className="space-y-1">
          {browse.map((item, idx) => {
            const Icon = ICON_MAP[item.icon];
            const discoverButton = idx === 0 && onOpenDiscover ? (
              <button
                key="discover"
                type="button"
                onClick={() => onOpenDiscover()}
                className={[
                  "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors",
                  discoverMode ? "bg-selected text-text" : "text-muted hover:bg-hover/70 hover:text-text",
                ].join(" ")}
              >
                <span className="flex items-center gap-2.5">
                  <Compass className={`h-4 w-4 stroke-[1.6] ${discoverMode ? "text-accent" : ""}`} />
                  <span className="text-[13px]">{t("sidebar.discover")}</span>
                </span>
              </button>
            ) : null;
            const active = !activeCollectionId && !stickerMode && !peopleMode && !discoverMode && item.key === status;
            return (
              <Fragment key={item.key}>
              <button
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
                  <span className="text-[13px]">{t(`browse.${item.key}`, item.label)}</span>
                </span>
                <span className={`text-[11px] tabular-nums ${active ? "text-accent" : "text-muted2"}`}>{item.count}</span>
              </button>
              {discoverButton}
              </Fragment>
            );
          })}
          <button
            type="button"
            title={!api.can("stickerExtract") ? tc("desktop.hint") : undefined}
            onClick={api.can("stickerExtract") ? (e) => { e.currentTarget.blur(); onOpenStickerBrowser?.(); } : undefined}
            className={[
              "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left outline-none transition-colors focus:outline-none focus-visible:outline-none",
              !api.can("stickerExtract")
                ? "cursor-default text-muted2"
                : stickerMode
                  ? "bg-selected text-text"
                  : "text-muted hover:bg-hover/70 hover:text-text",
            ].join(" ")}
          >
            <span className="flex items-center gap-2.5">
              <Cannabis className={`h-4 w-4 stroke-[1.6] ${stickerMode ? "text-accent" : ""}`} />
              <span className="text-[13px]">{t("sidebar.stickers")}</span>
            </span>
          </button>
          <button
            type="button"
            title={!api.can("people") ? tc("desktop.hint") : undefined}
            onClick={api.can("people") ? (e) => { e.currentTarget.blur(); onOpenPeople?.(); } : undefined}
            className={[
              "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left outline-none transition-colors focus:outline-none focus-visible:outline-none",
              !api.can("people")
                ? "cursor-default text-muted2"
                : peopleMode
                  ? "bg-selected text-text"
                  : "text-muted hover:bg-hover/70 hover:text-text",
            ].join(" ")}
          >
            <span className="flex items-center gap-2.5">
              <UsersRound className={`h-4 w-4 stroke-[1.6] ${peopleMode ? "text-accent" : ""}`} />
              <span className="text-[13px]">{t("sidebar.people")}</span>
            </span>
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between px-2.5 pb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{t("sidebar.folders")}</span>
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                className="rounded-md p-0.5 text-muted2 transition-colors hover:bg-hover hover:text-text"
                title={folderView === "covers" ? t("sidebar.viewList") : t("sidebar.viewCovers")}
                onClick={toggleFolderView}
              >
                {folderView === "covers" ? <List className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                className="rounded-md p-0.5 text-muted2 transition-colors hover:bg-hover hover:text-text"
                title={t("sidebar.newFolder")}
                onClick={() => setCreatingFolder(true)}
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </span>
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
                  {folderView === "covers" ? (
                    <span className="flex min-w-0 items-center gap-2.5">
                      {covers[col.collection_id]?.path ? (
                        <img
                          src={localFileUrl(covers[col.collection_id].path)}
                          alt=""
                          draggable={false}
                          className="h-10 w-10 shrink-0 rounded-[8px] object-cover"
                        />
                      ) : (
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-[var(--fill-2)]">
                          <Folder className="h-4 w-4 stroke-[1.6] text-muted2" />
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-[13px]">{col.name}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted2">{t("sidebar.folderMeta", { count: col.item_count || 0 })}</span>
                      </span>
                    </span>
                  ) : (
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Folder className={`h-4 w-4 shrink-0 stroke-[1.6] ${active ? "text-accent" : ""}`} />
                      <span className="min-w-0 truncate text-[13px]">{col.name}</span>
                    </span>
                  )}
                  <span className="flex shrink-0 items-center gap-1">
                    {folderView !== "covers" && (
                      <span className={`text-[11px] tabular-nums ${active ? "text-accent" : "text-muted2"}`}>
                        {col.item_count || 0}
                      </span>
                    )}
                    <span className="hidden gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        className="rounded-md p-0.5 text-muted2 hover:text-text"
                        title={t("sidebar.annotateFolder")}
                        onClick={(e) => { e.stopPropagation(); onAnnotateCollection?.(col.collection_id); }}
                      >
                        <Sparkles className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-0.5 text-muted2 hover:text-text"
                        title={t("sidebar.rename")}
                        onClick={(e) => { e.stopPropagation(); setEditingId(col.collection_id); }}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-0.5 text-muted2 hover:text-red-400"
                        title={t("sidebar.delete")}
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
              <div className="px-2.5 py-2 text-[11px] text-muted2">{t("sidebar.noFolders")}</div>
            )}
          </div>
        </div>
      </nav>

      {/* Bottom: Settings — global, always accessible */}
      <div className="mt-2 border-t border-border/40 pt-2">
        <DesktopHint />
        <button
          type="button"
          onClick={() => onOpenSettings?.()}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-muted transition-colors hover:bg-hover/70 hover:text-text"
          title={t("sidebar.settingsTip")}
        >
          <SettingsIcon className="h-4 w-4 stroke-[1.6]" />
          <span className="text-[13px]">{t("sidebar.settings")}</span>
        </button>
      </div>
    </aside>
  );
}
