import { useState, useRef, useEffect, Fragment } from "react";
import useDismiss from "../ui/useDismiss";
import { useTranslation } from "react-i18next";
import api from "../api";
import { Images, Clock, Star, Copy, FolderPlus, FolderCog, Folder, Trash2, Pencil, Sparkles, UsersRound, Image as ImageIcon, List, Compass, Search, ArrowUpDown, Check, ChevronDown, ChevronRight, X, Tags } from "lucide-react";
import { DesktopHint, LOCKED_HINT_KEY } from "./DesktopOnly";
import { baseName, browseCount, formatTimestamp, navItems, localFileUrl } from "../utils/format";
import SmartCollections from "./SmartCollections";
import InlineEdit from "./InlineEdit";
import { SectionHeading, useSectionOpen } from "./SidebarSection";
import { shortcutLabel, useShortcuts } from "../shortcuts/store";
import { FOLDER_SORTS, canReorderFolders } from "./folderList";
import { ancestorIds, canDropInto, descendantIds, parentIdOf, siblingIds, visibleTreeRows } from "./folderTree";
import { confirm } from "./confirm";
import { Z } from "../ui";
// The feature modules' library views (manifest `sidebarView`), listed below the browse rows.
import { sidebarViews } from "../../features/index.js";

const FOLDER_VIEW_KEY = "sidebar.folderView"; // "list" | "covers"
const FOLDER_SORT_KEY = "sidebar.folderSort"; // one of FOLDER_SORTS
// Which folders are open to show the folders under them, per catalog.
const FOLDER_EXPANDED_KEY = "sidebar.folderExpanded";
// Dragging a folder over a closed one opens it after this long.
const HOVER_EXPAND_MS = 600;

function readExpanded(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
  } catch { return new Set(); }
}
function writeExpanded(key, ids) {
  try { localStorage.setItem(key, JSON.stringify([...ids])); } catch { /* private mode */ }
}

function FolderSortMenu({ sort, onChange }) {
  const { t } = useTranslation("nav");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(ref, () => setOpen(false), { enabled: open });
  return (
    <span ref={ref} className="relative flex">
      <button
        type="button"
        className={`rounded p-0.5 transition-colors hover:bg-hover hover:text-text ${sort === "custom" ? "text-muted2" : "text-accent"}`}
        title={t("sidebar.sortFolders")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ArrowUpDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div data-testid="folder-sort-menu" className="absolute right-0 top-full mt-1.5 min-w-[140px] rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay" style={{ zIndex: Z.dropdown }}>
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

const ICON_MAP = { Archive: Images, Clock, Star, Copy };


export default function Sidebar({
  info,
  summary,
  status,
  setStatus,
  collections,
  activeCollectionId,
  activeSmartCollectionId,
  similarTo = null,
  onOpenSmartCollection,
  onEditSmartCollection,
  onSnapshotSmartCollection,
  onSelectCollection,
  // (name, parentId): parentId makes the folder inside that folder.
  onCreateCollection,
  // (collectionId, parentId): into that folder, or to the top level with null.
  onMoveCollection,
  // (collectionIds, parentId): the order of one level.
  onReorderCollections,
  reorderingCollections = false,
  onRenameCollection,
  onDeleteCollection,
  onAnnotateCollection,
  onAddToCollection,
  // The folder the B key adds to (hooks/targetFolder.js): marked with its key.
  targetFolderId = null,
  onOpenView,
  onOpenPeople,
  onOpenDiscover,
  onOpenFolders,
  onOpenTags,
  // The view App is showing: "assets", "people", … or a feature view's id.
  activeView = "assets",
  peopleMode = false,
  discoverMode = false,
  foldersMode = false,
  tagsMode = false,
}) {
  const { t, i18n } = useTranslation("nav");
  const { t: tc } = useTranslation("common");
  useShortcuts();
  const targetKey = shortcutLabel("folder.addToTarget");
  const browse = navItems(summary);
  const featureViewMode = sidebarViews.some((view) => view.id === activeView);
  const rootSummary = [];
  if (browseCount(summary)) rootSummary.push(t("sidebar.assetsCount", { count: browseCount(summary) }));
  if (summary?.updated_at) rootSummary.push(t("sidebar.updated", { time: formatTimestamp(summary.updated_at, { zoneless: "utc" }) }));

  const [creatingFolder, setCreatingFolder] = useState(false);
  // The folder a new subfolder is being named under (its field sits below its row).
  const [creatingUnder, setCreatingUnder] = useState(null);
  const [foldersOpen, toggleFolders, showFolders] = useSectionOpen("folders");
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
  // Covers: the newest photo added to the folder, which the collection rows
  // carry (cover_preview_paths, db/collections.py collection_stats).
  const coverOf = (c) => c.cover_preview_paths?.[0] || null;
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
  // The tree: which folders are open, remembered per catalog.
  const expandedKey = `${FOLDER_EXPANDED_KEY}:${info?.catalogPath || ""}`;
  const [expandedIds, setExpandedIds] = useState(() => readExpanded(expandedKey));
  useEffect(() => { setExpandedIds(readExpanded(expandedKey)); }, [expandedKey]);
  const expand = (ids, open = true) => setExpandedIds((current) => {
    const next = new Set(current);
    for (const id of ids) { if (open) next.add(id); else next.delete(id); }
    writeExpanded(expandedKey, next);
    return next;
  });
  const toggleExpanded = (id) => expand([id], !expandedIds.has(id));
  // The folder on screen is never hidden inside a closed one.
  useEffect(() => {
    if (!activeCollectionId) return;
    const closed = ancestorIds(collections, activeCollectionId).filter((id) => !expandedIds.has(id));
    if (closed.length) expand(closed);
  }, [activeCollectionId, collections, expandedIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const treeRows = visibleTreeRows(collections, { sort: folderSort, query: folderQuery, expanded: expandedIds, locale: i18n.language });
  // Dragging to reorder sets the custom order, so it needs that order on
  // screen, whole. Dragging INTO a folder works under any order.
  const reorderable = canReorderFolders({ sort: folderSort, query: folderQuery }) && !reorderingCollections;
  const reorderTitle = folderSort !== "custom"
    ? t("sidebar.reorderNeedsCustom")
    : folderQuery.trim() ? t("sidebar.reorderNeedsNoSearch") : t("sidebar.reorderHint");
  // A new folder goes on top of the custom order; under another sort it lands
  // wherever that puts it, so scroll it into view once the list has it.
  const [revealFolderId, setRevealFolderId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);
  const [draggingFolderId, setDraggingFolderId] = useState(null);
  // { id, mode: "before" | "after" | "into" } while a folder drags over a row.
  const [folderInsertion, setFolderInsertion] = useState(null);
  // A folder dragged over the top-level drop zone.
  const [rootDrop, setRootDrop] = useState(false);
  const hoverExpandRef = useRef(null);
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

  function clearHoverExpand() {
    if (hoverExpandRef.current) {
      clearTimeout(hoverExpandRef.current.timer);
      hoverExpandRef.current = null;
    }
  }
  // Something dragged over a closed folder with folders inside: open it
  // after a moment, so a drop can reach the folders under it.
  function armHoverExpand(row) {
    if (!row.hasChildren || row.expanded) return;
    const id = row.folder.collection_id;
    if (hoverExpandRef.current?.id === id) return;
    clearHoverExpand();
    hoverExpandRef.current = { id, timer: setTimeout(() => { hoverExpandRef.current = null; expand([id]); }, HOVER_EXPAND_MS) };
  }

  function endFolderDrag() {
    clearHoverExpand();
    setDraggingFolderId(null);
    setFolderInsertion(null);
    setRootDrop(false);
    folderScrollSpeed.current = 0;
  }

  // Where a dragged folder would land on this row: the top and bottom
  // quarters put it before or after (custom order only), the middle puts it
  // inside. Nothing where it cannot go (itself, a folder under it).
  function folderDestination(event, row) {
    if (!draggingFolderId) return null;
    const id = row.folder.collection_id;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
    if (reorderable && ratio < 0.25) return { id, mode: "before" };
    if (reorderable && ratio > 0.75) return { id, mode: "after" };
    return canDropInto(collections, draggingFolderId, id) ? { id, mode: "into" } : null;
  }

  async function moveFolder(sourceId, destination) {
    if (!destination || sourceId === destination.id) return;
    if (destination.mode === "into") {
      if (await onMoveCollection?.(sourceId, destination.id)) expand([destination.id]);
      return;
    }
    if (!reorderable) return;
    // Before / after a row of another level: the folder joins that level first.
    const parentId = parentIdOf(collections, destination.id);
    const changesLevel = parentIdOf(collections, sourceId) !== parentId;
    if (changesLevel) {
      if (!canDropInto(collections, sourceId, parentId)) return;
      if (!(await onMoveCollection?.(sourceId, parentId))) return;
    }
    const current = siblingIds(collections, destination.id);
    const ordered = current.filter((id) => id !== sourceId);
    ordered.splice(ordered.indexOf(destination.id) + (destination.mode === "after" ? 1 : 0), 0, sourceId);
    const unchanged = !changesLevel && ordered.length === current.length && ordered.every((id, index) => id === current[index]);
    if (!unchanged) void onReorderCollections?.(ordered, parentId);
  }

  function moveToRoot(sourceId) {
    if (sourceId && parentIdOf(collections, sourceId) !== null) void onMoveCollection?.(sourceId, null);
  }

  // A folder with folders inside asks first: they go with it.
  async function deleteFolder(col) {
    const under = descendantIds(collections, col.collection_id).length;
    if (under) {
      const approved = await confirm({
        title: t("sidebar.deleteWithChildrenTitle", { name: col.name }),
        message: t("sidebar.deleteWithChildren", { count: under }),
        confirmLabel: t("sidebar.deleteWithChildrenAction"),
        cancelLabel: t("sidebar.deleteCancel"),
        danger: true,
      });
      if (!approved) return;
    }
    await onDeleteCollection?.(col.collection_id);
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
            const active = !activeCollectionId && !activeSmartCollectionId && !similarTo && !featureViewMode && !peopleMode && !discoverMode && !foldersMode && !tagsMode && item.key === status;
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
          {/* The feature modules' views (today the sticker library), each
              locked with the platform hint where its feature is off. */}
          {sidebarViews.map(({ id, icon: ViewIcon, labelKey, cap, unavailable }) => {
            const available = api.can(cap);
            if (!available && unavailable === "hidden") return null;
            const current = activeView === id;
            return (
              <button
                key={id}
                type="button"
                title={!available ? tc(LOCKED_HINT_KEY) : undefined}
                onClick={available ? (e) => { e.currentTarget.blur(); onOpenView?.(id); } : undefined}
                className={[
                  "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left outline-none transition-colors focus:outline-none focus-visible:outline-none",
                  !available
                    ? "cursor-default text-muted2"
                    : current
                      ? "bg-selected text-text"
                      : "text-muted hover:bg-hover/70 hover:text-text",
                ].join(" ")}
              >
                <span className="flex items-center gap-2.5">
                  <ViewIcon className={`h-4 w-4 stroke-[1.6] ${current ? "text-accent" : ""}`} />
                  <span className="text-[13px]">{t(labelKey)}</span>
                </span>
              </button>
            );
          })}
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
          {onOpenTags && (
            <button
              type="button"
              data-testid="sidebar-tags"
              onClick={(e) => { e.currentTarget.blur(); onOpenTags(); }}
              className={[
                "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left outline-none transition-colors focus:outline-none focus-visible:outline-none",
                tagsMode ? "bg-selected text-text" : "text-muted hover:bg-hover/70 hover:text-text",
              ].join(" ")}
            >
              <span className="flex items-center gap-2.5">
                <Tags className={`h-4 w-4 stroke-[1.6] ${tagsMode ? "text-accent" : ""}`} />
                <span className="text-[13px]">{t("sidebar.tags")}</span>
              </span>
            </button>
          )}
        </div>

        <SmartCollections
          collections={collections}
          activeId={featureViewMode || peopleMode || discoverMode || foldersMode || tagsMode ? null : activeSmartCollectionId}
          view={folderView}
          grow={!foldersOpen}
          onOpen={onOpenSmartCollection}
          onEditRules={onEditSmartCollection}
          onRename={onRenameCollection}
          onDelete={onDeleteCollection}
          onSnapshot={onSnapshotSmartCollection}
        />

        <div className={foldersOpen ? "flex min-h-0 flex-1 flex-col" : "shrink-0"} data-sidebar-folders="true" data-open={foldersOpen ? "true" : "false"}>
          <SectionHeading
            id="folders"
            label={t("sidebar.folders")}
            open={foldersOpen}
            onToggle={toggleFolders}
            holdsActive={manualCollections.some((c) => c.collection_id === activeCollectionId)}
            className={rootDrop ? "rounded-md ring-1 ring-inset ring-accent/45" : ""}
            data-folder-root-drop={draggingFolderId ? "true" : undefined}
            onDragOver={(event) => {
              if (!draggingFolderId || parentIdOf(collections, draggingFolderId) === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setFolderInsertion(null);
              setRootDrop(true);
            }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setRootDrop(false); }}
            onDrop={(event) => {
              if (!draggingFolderId) return;
              event.preventDefault();
              const source = draggingFolderId;
              endFolderDrag();
              moveToRoot(source);
            }}
          >
              <button
                type="button"
                className={`rounded p-0.5 transition-colors hover:bg-hover hover:text-text ${searchingFolders ? "text-text" : "text-muted2"}`}
                title={t("sidebar.searchFolders")}
                aria-pressed={searchingFolders}
                onClick={() => { if (searchingFolders) closeFolderSearch(); else { showFolders(); setSearchingFolders(true); } }}
              >
                <Search className="h-3.5 w-3.5" />
              </button>
              <FolderSortMenu sort={folderSort} onChange={changeFolderSort} />
              <button
                type="button"
                className="rounded p-0.5 text-muted2 transition-colors hover:bg-hover hover:text-text"
                title={folderView === "covers" ? t("sidebar.viewList") : t("sidebar.viewCovers")}
                onClick={toggleFolderView}
              >
                {folderView === "covers" ? <List className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                className="rounded p-0.5 text-muted2 transition-colors hover:bg-hover hover:text-text"
                title={t("sidebar.newFolder")}
                onClick={() => {
                  // The field opens on top of the list: show it, and let no
                  // search hide the folder it makes.
                  closeFolderSearch();
                  setCreatingUnder(null);
                  showFolders();
                  setCreatingFolder(true);
                  if (folderScrollRef.current) folderScrollRef.current.scrollTop = 0;
                }}
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
              {onOpenFolders && (
                <button
                  type="button"
                  data-testid="sidebar-manage-folders"
                  className={`rounded p-0.5 transition-colors hover:bg-hover hover:text-text ${foldersMode ? "bg-selected text-accent" : "text-muted2"}`}
                  title={t("sidebar.manageFolders")}
                  aria-label={t("sidebar.manageFolders")}
                  aria-pressed={foldersMode}
                  onClick={(e) => { e.currentTarget.blur(); onOpenFolders(); }}
                >
                  <FolderCog className="h-3.5 w-3.5" />
                </button>
              )}
          </SectionHeading>

          {foldersOpen && (<>
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
                    const created = await onCreateCollection?.(name, null);
                    setCreatingFolder(false);
                    if (created?.collection_id) setRevealFolderId(created.collection_id);
                  }}
                  onCancel={() => setCreatingFolder(false)}
                />
              </div>
            )}

            {treeRows.map((row) => {
              const { folder: col, depth, hasChildren, expanded, pathLabel } = row;
              const active = activeCollectionId === col.collection_id;
              const indent = { paddingLeft: `${10 + depth * 14}px` };
              // The field for a folder made inside this one, right under it.
              const subfolderField = creatingUnder === col.collection_id ? (
                <div key={`${col.collection_id}:new`} className="py-0.5 pr-2.5" style={{ paddingLeft: `${10 + (depth + 1) * 14 + 18}px` }} data-testid="sidebar-new-subfolder">
                  <InlineEdit
                    initial=""
                    onConfirm={async (name) => {
                      const created = await onCreateCollection?.(name, col.collection_id);
                      setCreatingUnder(null);
                      if (created?.collection_id) setRevealFolderId(created.collection_id);
                    }}
                    onCancel={() => setCreatingUnder(null)}
                  />
                </div>
              ) : null;
              // Folders with folders inside open and close; the others keep the space.
              const toggle = hasChildren ? (
                <button
                  type="button"
                  data-folder-toggle={expanded ? "open" : "closed"}
                  aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")}
                  aria-expanded={expanded}
                  className="-ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted2 hover:bg-hover hover:text-text"
                  onClick={(e) => { e.stopPropagation(); toggleExpanded(col.collection_id); }}
                >
                  {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
              ) : (
                <span className="-ml-1 h-4 w-4 shrink-0" aria-hidden="true" />
              );
              // A closed folder counts everything under it; open, only its own.
              const count = hasChildren && !expanded ? (col.subtree_count ?? col.item_count ?? 0) : (col.item_count || 0);
              const meta = pathLabel
                ? <span className="mt-0.5 block truncate text-[10px] text-muted2">{pathLabel}</span>
                : null;
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
                    <Fragment key={col.collection_id}>
                      <div className={`flex w-full items-center rounded-md py-1.5 pr-2.5 ${active ? "bg-selected" : ""}`} style={indent}>
                        <span className="flex min-w-0 flex-1 items-center gap-2.5">
                          {toggle}
                          {coverOf(col) ? (
                            <img src={localFileUrl(coverOf(col))} alt="" draggable={false} className="h-10 w-10 shrink-0 rounded-[8px] object-cover" />
                          ) : (
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-[var(--fill-2)]">
                              <Folder className="h-4 w-4 stroke-[1.6] text-muted2" />
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            {editor}
                            <span className="mt-0.5 block truncate text-[11px] text-muted2">{t("sidebar.folderMeta", { count })}</span>
                          </span>
                        </span>
                      </div>
                      {subfolderField}
                    </Fragment>
                  );
                }
                return (
                  <Fragment key={col.collection_id}>
                    <div className="py-0.5 pr-2.5" style={{ paddingLeft: `${10 + depth * 14 + 18}px` }}>
                      {editor}
                    </div>
                    {subfolderField}
                  </Fragment>
                );
              }
              return (
                <Fragment key={col.collection_id}>
                <div
                  role="button"
                  tabIndex={0}
                  data-collection-id={col.collection_id}
                  data-folder-depth={depth}
                  data-folder-children={hasChildren ? "true" : undefined}
                  data-folder-expanded={hasChildren ? (expanded ? "true" : "false") : undefined}
                  data-target-folder={targetFolderId === col.collection_id ? "true" : undefined}
                  data-folder-insertion={folderInsertion?.id === col.collection_id ? folderInsertion.mode : undefined}
                  draggable={!folderQuery.trim() && !reorderingCollections}
                  title={reorderTitle}
                  style={indent}
                  onDragStart={(event) => {
                    if (event.target.closest("button, input") || folderQuery.trim() || reorderingCollections) {
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
                    if (event.key === "ArrowRight" && hasChildren && !expanded) { event.preventDefault(); expand([col.collection_id]); }
                    if (event.key === "ArrowLeft" && hasChildren && expanded) { event.preventDefault(); expand([col.collection_id], false); }
                    if (reorderable && event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                      event.preventDefault();
                      const siblings = siblingIds(collections, col.collection_id);
                      const after = event.key === "ArrowDown";
                      const neighbor = siblings[siblings.indexOf(col.collection_id) + (after ? 1 : -1)];
                      if (neighbor) void moveFolder(col.collection_id, { id: neighbor, mode: after ? "after" : "before" });
                    }
                  }}
                  onDragOver={(event) => {
                    if (draggingFolderId) {
                      const destination = folderDestination(event, row);
                      setRootDrop(false);
                      if (!destination || draggingFolderId === col.collection_id) {
                        setFolderInsertion(null);
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      armHoverExpand(row);
                      setFolderInsertion(destination);
                      return;
                    }
                    if (!readDraggedAssetIds(event).length) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    armHoverExpand(row);
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
                      if (hoverExpandRef.current?.id === col.collection_id) clearHoverExpand();
                      setFolderInsertion((current) => current?.id === col.collection_id ? null : current);
                      setDropTargetId((current) => (current === col.collection_id ? null : current));
                    }
                  }}
                  onDrop={async (event) => {
                    if (draggingFolderId) {
                      event.preventDefault();
                      event.stopPropagation();
                      const destination = folderDestination(event, row);
                      const source = draggingFolderId;
                      endFolderDrag();
                      await moveFolder(source, destination);
                      return;
                    }
                    const assetIds = readDraggedAssetIds(event);
                    event.preventDefault();
                    clearHoverExpand();
                    setDropTargetId(null);
                    window.__mediaWorkspaceDraggingAssetId = null;
                    window.__mediaWorkspaceDraggingAssetIds = null;
                    if (!assetIds.length) return;
                    await onAddToCollection?.(col.collection_id, assetIds);
                  }}
                  className={[
                    "sidebar-folder-row group relative flex w-full cursor-pointer items-center justify-between rounded-md py-1.5 pr-2.5 text-left transition-colors",
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
                      {toggle}
                      {coverOf(col) ? (
                        <img
                          src={localFileUrl(coverOf(col))}
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
                        {meta}
                        <span className="mt-0.5 block truncate text-[11px] text-muted2">{t("sidebar.folderMeta", { count })}</span>
                      </span>
                    </span>
                  ) : (
                    <span className="flex min-w-0 items-center gap-2.5">
                      {toggle}
                      <Folder className={`h-4 w-4 shrink-0 stroke-[1.6] ${active ? "text-accent" : ""}`} />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px]">{col.name}</span>
                        {meta}
                      </span>
                    </span>
                  )}
                  <span className="flex shrink-0 items-center gap-1">
                    {targetFolderId === col.collection_id && targetKey && (
                      <kbd
                        className="rounded border border-border/60 px-1 font-sans text-[10px] leading-4 text-muted2"
                        title={t("sidebar.targetFolder", { keys: targetKey })}
                      >
                        {targetKey}
                      </kbd>
                    )}
                    {folderView !== "covers" && (
                      <span className={`text-[11px] tabular-nums ${active ? "text-accent" : "text-muted2"}`}>
                        {count}
                      </span>
                    )}
                    <span className="hidden gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted2 hover:text-text"
                        title={t("sidebar.newSubfolder")}
                        aria-label={t("sidebar.newSubfolder")}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeFolderSearch();
                          setCreatingFolder(false);
                          // Open it, so the new folder is seen the moment it exists.
                          expand([col.collection_id]);
                          setCreatingUnder(col.collection_id);
                        }}
                      >
                        <FolderPlus className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted2 hover:text-text"
                        title={t("sidebar.annotateFolder")}
                        onClick={(e) => { e.stopPropagation(); onAnnotateCollection?.(col.collection_id); }}
                      >
                        <Sparkles className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted2 hover:text-text"
                        title={t("sidebar.rename")}
                        onClick={(e) => { e.stopPropagation(); setEditingId(col.collection_id); }}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted2 hover:text-red-400"
                        title={t("sidebar.delete")}
                        onClick={(e) => { e.stopPropagation(); void deleteFolder(col); }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  </span>
                </div>
                {subfolderField}
                </Fragment>
              );
            })}

            {!manualCollections.length && !creatingFolder && (
              <div className="px-2.5 py-2 text-[11px] text-muted2">{t("sidebar.noFolders")}</div>
            )}
            {manualCollections.length > 0 && !treeRows.length && folderQuery.trim() && (
              <div className="px-2.5 py-2 text-[11px] text-muted2">{t("sidebar.noFolderMatches", { query: folderQuery.trim() })}</div>
            )}
            {/* Empty space under the rows: a dragged folder dropped here goes to the top level. */}
            {draggingFolderId && (
              <div
                data-folder-root-zone="true"
                data-active={rootDrop ? "true" : undefined}
                className={`mx-2.5 mt-1 rounded-md border border-dashed px-2 py-1.5 text-center text-[10px] ${rootDrop ? "border-accent/70 text-text" : "border-border/60 text-muted2"}`}
                onDragOver={(event) => {
                  if (!draggingFolderId || parentIdOf(collections, draggingFolderId) === null) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setFolderInsertion(null);
                  setRootDrop(true);
                }}
                onDragLeave={() => setRootDrop(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const source = draggingFolderId;
                  endFolderDrag();
                  moveToRoot(source);
                }}
              >
                {t("sidebar.moveToRoot")}
              </div>
            )}
          </div>
          </>)}
        </div>
      </nav>

      {api.capabilities.web && <div className="shrink-0 pt-2"><DesktopHint /></div>}
    </aside>
  );
}
