import { useState, useRef, useEffect, Fragment } from "react";
import { useTranslation } from "react-i18next";
import api from "../api";
import { Images, Clock, Star, Link, FolderPlus, Folder, Trash2, Pencil, Cannabis, Sparkles, UsersRound, Image as ImageIcon, List, Compass, Search, ArrowUpDown, Check, X } from "lucide-react";
import { DesktopHint, LOCKED_HINT_KEY } from "./DesktopOnly";
import { baseName, browseCount, formatTimestamp, navItems, localFileUrl } from "../utils/format";
import SmartCollections from "./SmartCollections";
import InlineEdit from "./InlineEdit";
import { FOLDER_SORTS, canReorderFolders, visibleFolders } from "./folderList";

const FOLDER_VIEW_KEY = "sidebar.folderView"; // "list" | "covers"
const FOLDER_SORT_KEY = "sidebar.folderSort"; // one of FOLDER_SORTS

function FolderSortMenu({ sort, onChange }) {
  const { t } = useTranslation("nav");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const handleDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const handleKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative flex">
      <button
        type="button"
        className={`rounded-md p-0.5 transition-colors hover:bg-hover hover:text-text ${sort === "custom" ? "text-muted2" : "text-accent"}`}
        title={t("sidebar.sortFolders")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ArrowUpDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div data-testid="folder-sort-menu" className="absolute right-0 top-full z-[101] mt-1.5 min-w-[140px] rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay">
          {FOLDER_SORTS.map((value) => (
            <button
              key={value}
              type="button"
              className={[
                "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] normal-case tracking-normal transition-colors hover:bg-hover",
                sort === value ? "text-text" : "text-muted",
              ].join(" ")}
              onClick={() => { onChange(value); setOpen(false); }}
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {sort === value && <Check className="h-3 w-3 text-accent" />}
              </span>
              {t(`sidebar.folderSort.${value}`)}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

const ICON_MAP = { Archive: Images, Clock, Star, Link };


export default function Sidebar({
  info,
  summary,
  status,
  setStatus,
  collections,
  activeCollectionId,
  activeSmartCollectionId,
  onOpenSmartCollection,
  onEditSmartCollection,
  onSnapshotSmartCollection,
  onSelectCollection,
  onCreateCollection,
  onReorderCollections,
  reorderingCollections = false,
  onRenameCollection,
  onDeleteCollection,
  onAnnotateCollection,
  onAddToCollection,
  onOpenStickerBrowser,
  onOpenPeople,
  onOpenDiscover,
  stickerMode = false,
  peopleMode = false,
  discoverMode = false,
}) {
  const { t, i18n } = useTranslation("nav");
  const { t: tc } = useTranslation("common");
  const browse = navItems(summary);
  const rootSummary = [];
  if (browseCount(summary)) rootSummary.push(t("sidebar.assetsCount", { count: browseCount(summary) }));
  if (summary?.updated_at) rootSummary.push(t("sidebar.updated", { time: formatTimestamp(summary.updated_at, { zoneless: "utc" }) }));

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
  const [folderSort, setFolderSort] = useState(() => {
    try {
      const saved = localStorage.getItem(FOLDER_SORT_KEY);
      return FOLDER_SORTS.includes(saved) ? saved : "custom";
    } catch { return "custom"; }
  });
  const changeFolderSort = (next) => {
    setFolderSort(next);
    try { localStorage.setItem(FOLDER_SORT_KEY, next); } catch { /* private mode */ }
  };
  const [searchingFolders, setSearchingFolders] = useState(false);
  const [folderQuery, setFolderQuery] = useState("");
  const closeFolderSearch = () => { setSearchingFolders(false); setFolderQuery(""); };
  const shownFolders = visibleFolders(collections, { sort: folderSort, query: folderQuery, locale: i18n.language });
  // Dragging sets the custom order, so it needs that order on screen, whole.
  const reorderable = canReorderFolders({ sort: folderSort, query: folderQuery }) && !reorderingCollections;
  const reorderTitle = folderSort !== "custom"
    ? t("sidebar.reorderNeedsCustom")
    : folderQuery.trim() ? t("sidebar.reorderNeedsNoSearch") : t("sidebar.reorderHint");
  // A new folder goes on top of the custom order; under another sort it lands
  // wherever that puts it, so scroll it into view once the list has it.
  const [revealFolderId, setRevealFolderId] = useState(null);
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
  const [draggingFolderId, setDraggingFolderId] = useState(null);
  const [folderInsertion, setFolderInsertion] = useState(null);
  const folderScrollRef = useRef(null);
  const folderScrollSpeed = useRef(0);
  useEffect(() => {
    if (!revealFolderId) return;
    const row = [...(folderScrollRef.current?.querySelectorAll("[data-collection-id]") || [])]
      .find((el) => el.dataset.collectionId === revealFolderId);
    if (!row) return;
    row.scrollIntoView?.({ block: "nearest" });
    setRevealFolderId(null);
  }, [revealFolderId, collections]);
  useEffect(() => {
    if (!draggingFolderId) return undefined;
    let frame;
    const scroll = () => {
      if (folderScrollRef.current) folderScrollRef.current.scrollTop += folderScrollSpeed.current;
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => { cancelAnimationFrame(frame); folderScrollSpeed.current = 0; };
  }, [draggingFolderId]);

  function endFolderDrag() {
    setDraggingFolderId(null);
    setFolderInsertion(null);
    folderScrollSpeed.current = 0;
  }

  function folderDestination(event, id) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { id, after: event.clientY >= rect.top + rect.height / 2 };
  }

  function moveFolder(sourceId, targetId, after) {
    if (sourceId === targetId || !reorderable) return;
    const original = manualCollections.map((c) => c.collection_id);
    if (!original.includes(sourceId) || !original.includes(targetId)) return;
    const ordered = original.filter((id) => id !== sourceId);
    ordered.splice(ordered.indexOf(targetId) + (after ? 1 : 0), 0, sourceId);
    if (ordered.some((id, index) => id !== original[index])) void onReorderCollections?.(ordered);
  }


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
    <aside
      className="relative flex h-full min-h-0 flex-col overflow-hidden border-r border-border/40 bg-chrome px-3 py-3"
    >
      <div className="mb-5 shrink-0 px-1">
        <div className="text-[13px] font-semibold tracking-[0.01em] text-text">
          {api.capabilities.web ? t("sidebar.webLibrary") : info?.catalogPath ? baseName(info.catalogPath) : t("sidebar.noCatalog")}
        </div>
        <div className="mt-1 text-[11px] text-muted2">
          {!info?.catalogPath
            ? t(api.capabilities.web ? "sidebar.webWelcomeHint" : "sidebar.noCatalogHint")
            : rootSummary.length ? rootSummary.join(" · ") : t("sidebar.noAssets")}
        </div>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="shrink-0 space-y-1">
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
            const active = !activeCollectionId && !activeSmartCollectionId && !stickerMode && !peopleMode && !discoverMode && item.key === status;
            return (
              <Fragment key={item.key}>
              <button
                type="button"
                onClick={() => setStatus(item.key)}
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
            title={!api.can("stickerExtract") ? tc(LOCKED_HINT_KEY) : undefined}
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
            title={!api.can("people") ? tc(LOCKED_HINT_KEY) : undefined}
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

        <SmartCollections
          collections={collections}
          activeId={stickerMode || peopleMode || discoverMode ? null : activeSmartCollectionId}
          view={folderView}
          onOpen={onOpenSmartCollection}
          onEditRules={onEditSmartCollection}
          onRename={onRenameCollection}
          onDelete={onDeleteCollection}
          onSnapshot={onSnapshotSmartCollection}
        />

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between px-2.5 pb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{t("sidebar.folders")}</span>
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                className={`rounded-md p-0.5 transition-colors hover:bg-hover hover:text-text ${searchingFolders ? "text-text" : "text-muted2"}`}
                title={t("sidebar.searchFolders")}
                aria-pressed={searchingFolders}
                onClick={() => (searchingFolders ? closeFolderSearch() : setSearchingFolders(true))}
              >
                <Search className="h-3.5 w-3.5" />
              </button>
              <FolderSortMenu sort={folderSort} onChange={changeFolderSort} />
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
                onClick={() => {
                  // The field opens on top of the list: show it, and let no
                  // search hide the folder it makes.
                  closeFolderSearch();
                  setCreatingFolder(true);
                  if (folderScrollRef.current) folderScrollRef.current.scrollTop = 0;
                }}
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>

          {searchingFolders && (
            <div className="relative mx-2.5 mb-1.5 shrink-0">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted2" />
              <input
                autoFocus
                value={folderQuery}
                onChange={(e) => setFolderQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") closeFolderSearch(); }}
                placeholder={t("sidebar.searchFolders")}
                aria-label={t("sidebar.searchFolders")}
                className="h-7 w-full rounded-md border border-border/70 bg-app pl-6 pr-6 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
              />
              {folderQuery && (
                <button
                  type="button"
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted2 hover:text-text"
                  title={t("sidebar.clearFolderSearch")}
                  onClick={() => setFolderQuery("")}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}

          <div
            ref={folderScrollRef}
            data-testid="sidebar-folder-scroll"
            onDragOver={(event) => {
              if (!draggingFolderId) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              folderScrollSpeed.current = event.clientY < rect.top + 32 ? -7 : event.clientY > rect.bottom - 32 ? 7 : 0;
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                folderScrollSpeed.current = 0;
                setFolderInsertion(null);
              }
            }}
            className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain pb-2"
          >
            {creatingFolder && (
              <div className="px-2.5 py-0.5">
                <InlineEdit
                  initial=""
                  onConfirm={async (name) => {
                    const created = await onCreateCollection?.(name);
                    setCreatingFolder(false);
                    if (created?.collection_id) setRevealFolderId(created.collection_id);
                  }}
                  onCancel={() => setCreatingFolder(false)}
                />
              </div>
            )}

            {shownFolders.map((col) => {
              const active = activeCollectionId === col.collection_id;
              if (editingId === col.collection_id) {
                const editor = (
                  <InlineEdit
                    initial={col.name}
                    onConfirm={async (name) => {
                      await onRenameCollection?.(col.collection_id, name);
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                );
                // Covers view: the row keeps its shape (cover, meta line) and
                // only the name turns into a field, so nothing jumps.
                if (folderView === "covers") {
                  return (
                    <div key={col.collection_id} className={`flex w-full items-center rounded-md px-2.5 py-1.5 ${active ? "bg-selected" : ""}`}>
                      <span className="flex min-w-0 flex-1 items-center gap-2.5">
                        {covers[col.collection_id]?.path ? (
                          <img src={localFileUrl(covers[col.collection_id].path)} alt="" draggable={false} className="h-10 w-10 shrink-0 rounded-[8px] object-cover" />
                        ) : (
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-[var(--fill-2)]">
                            <Folder className="h-4 w-4 stroke-[1.6] text-muted2" />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          {editor}
                          <span className="mt-0.5 block truncate text-[11px] text-muted2">{t("sidebar.folderMeta", { count: col.item_count || 0 })}</span>
                        </span>
                      </span>
                    </div>
                  );
                }
                return (
                  <div key={col.collection_id} className="px-2.5 py-0.5">
                    {editor}
                  </div>
                );
              }
              return (
                <div
                  key={col.collection_id}
                  role="button"
                  tabIndex={0}
                  data-collection-id={col.collection_id}
                  data-folder-insertion={folderInsertion?.id === col.collection_id ? (folderInsertion.after ? "after" : "before") : undefined}
                  draggable={reorderable}
                  title={reorderTitle}
                  onDragStart={(event) => {
                    if (event.target.closest("button, input") || !reorderable) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData("application/x-afterframe-folder", col.collection_id);
                    event.dataTransfer.effectAllowed = "move";
                    setDropTargetId(null);
                    setDraggingFolderId(col.collection_id);
                  }}
                  onDragEnd={endFolderDrag}
                  onClick={() => onSelectCollection?.(col.collection_id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter") onSelectCollection?.(col.collection_id);
                    if (reorderable && event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                      event.preventDefault();
                      const index = manualCollections.findIndex((c) => c.collection_id === col.collection_id);
                      const after = event.key === "ArrowDown";
                      const neighbor = manualCollections[index + (after ? 1 : -1)];
                      if (neighbor) moveFolder(col.collection_id, neighbor.collection_id, after);
                    }
                  }}
                  onDragOver={(event) => {
                    if (draggingFolderId) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setFolderInsertion(draggingFolderId === col.collection_id ? null : folderDestination(event, col.collection_id));
                      return;
                    }
                    if (!readDraggedAssetIds(event).length) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    if (dropTargetId !== col.collection_id) {
                      setDropTargetId(col.collection_id);
                    }
                  }}
                  onDragEnter={(event) => {
                    if (draggingFolderId) { event.preventDefault(); return; }
                    if (!readDraggedAssetIds(event).length) return;
                    event.preventDefault();
                    setDropTargetId(col.collection_id);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      setFolderInsertion((current) => current?.id === col.collection_id ? null : current);
                      setDropTargetId((current) => (current === col.collection_id ? null : current));
                    }
                  }}
                  onDrop={async (event) => {
                    if (draggingFolderId) {
                      event.preventDefault();
                      event.stopPropagation();
                      const destination = folderDestination(event, col.collection_id);
                      moveFolder(draggingFolderId, destination.id, destination.after);
                      endFolderDrag();
                      return;
                    }
                    const assetIds = readDraggedAssetIds(event);
                    event.preventDefault();
                    setDropTargetId(null);
                    window.__mediaWorkspaceDraggingAssetId = null;
                    window.__mediaWorkspaceDraggingAssetIds = null;
                    if (!assetIds.length) return;
                    await onAddToCollection?.(col.collection_id, assetIds);
                  }}
                  className={[
                    "sidebar-folder-row group relative flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors",
                    draggingFolderId === col.collection_id ? "opacity-50" : "",
                    dropTargetId === col.collection_id && !active
                      ? "bg-hover text-text ring-1 ring-inset ring-accent/45"
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

            {!manualCollections.length && !creatingFolder && (
              <div className="px-2.5 py-2 text-[11px] text-muted2">{t("sidebar.noFolders")}</div>
            )}
            {manualCollections.length > 0 && !shownFolders.length && folderQuery.trim() && (
              <div className="px-2.5 py-2 text-[11px] text-muted2">{t("sidebar.noFolderMatches", { query: folderQuery.trim() })}</div>
            )}
          </div>
        </div>
      </nav>

      {api.capabilities.web && <div className="shrink-0 pt-2"><DesktopHint /></div>}
    </aside>
  );
}
