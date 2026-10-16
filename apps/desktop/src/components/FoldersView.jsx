// The folder page (docs/folders-page-plan.md): every folder at once, with the
// columns the sidebar cannot fit — cover mosaic, capture span, when a photo
// last joined — searchable, sortable, filterable, and selectable in bulk.
// Opened from the sidebar's folder header (FolderCog) or Discover's Albums
// row. The header is the gallery's two rows — Toolbar, then FilterBar — in
// the same markup, so the skin dresses it the same way (index.css §5).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check, ChevronDown, Folder, FolderCog, LayoutGrid, List, MoreHorizontal, Pencil, Plus, Search, SlidersHorizontal, Sparkles, Trash2, X,
} from "lucide-react";
import api from "../api";
import { Button, cx, Z } from "../ui";
import useDismiss from "../ui/useDismiss";
import { localFileUrl } from "../utils/format";
import FaceMenu from "./FaceMenu";
import InlineEdit from "./InlineEdit";
import { confirm } from "./confirm";
import Popover, { ACTION_CHIP } from "./filters/Popover";
import RangePopover from "./filters/RangePopover";
import DateRangePopover, { RELATIVE_DAY_PRESETS } from "./filters/DateRangePopover";
import { setOrDelete } from "./filters/filterValues";
import {
  DEFAULT_FOLDER_PAGE_SORT,
  FOLDER_PAGE_SORTS,
  coverLayout,
  folderFilterCount,
  formatMonthRange,
  formatRelativeTime,
  parseStamp,
  selectRange,
  statusCounts,
  visibleFolderCards,
} from "./foldersPage";

// This page's own habits, apart from the sidebar's (a sidebar in custom order
// next to a page by last addition is a sensible pair).
const SORT_KEY = "folders.sort";
const VIEW_KEY = "folders.view"; // "grid" | "list"
// Tiles are appended in pages as the wall scrolls (PeopleView's pattern).
const PAGE_SIZE = 80;

const readPref = (key, allowed, fallback) => {
  try {
    const saved = localStorage.getItem(key);
    return allowed.includes(saved) ? saved : fallback;
  } catch { return fallback; }
};
const writePref = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

function IconButton({ className = "", ...props }) {
  return <Button variant="icon" className={cx("cursor-pointer disabled:hover:bg-transparent", className)} {...props} />;
}

// Toolbar.jsx's sort button, over this page's sorts.
function SortDropdown({ sort, setSort }) {
  const { t } = useTranslation("nav");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(ref, () => setOpen(false), { enabled: open });
  return (
    <div ref={ref} className="relative ml-1">
      <button
        type="button"
        data-testid="folders-sort"
        title={t("folders.sortTitle")}
        className="flex h-8 w-[120px] cursor-pointer items-center justify-center rounded-md border border-border/70 bg-app px-2 text-[12px] text-text outline-none transition-colors hover:border-border focus:border-accent/50"
        onClick={() => setOpen((c) => !c)}
      >
        <span className="truncate">{t(`folders.sort.${sort}`)}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 min-w-[170px] rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay" style={{ zIndex: Z.dropdown }}>
          {FOLDER_PAGE_SORTS.map((value) => (
            <button
              key={value}
              type="button"
              className={cx(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-hover",
                sort === value ? "text-text" : "text-muted",
              )}
              onClick={() => { setSort(value); setOpen(false); }}
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {sort === value && <Check className="h-3 w-3 text-accent" />}
              </span>
              {t(`folders.sort.${value}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// A single-choice facet (status, last added): the chip reads the choice.
function ChoicePopover({ label, value, options, onSelect, testId }) {
  const current = options.find((o) => o.value === value);
  return (
    <span data-testid={testId} className="contents">
      <Popover label={label} active={!!current} summary={current?.label} width={240}>
        <div className="popover-scroll -mr-2 max-h-[280px] overflow-y-auto pr-1">
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              data-facet-option={String(option.value)}
              onClick={() => onSelect(option.value === value ? null : option.value)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-muted hover:bg-hover hover:text-text"
            >
              <span className="flex h-3 w-3 items-center justify-center">{option.value === value && <Check className="h-3 w-3 text-accent" />}</span>
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.count != null && <span className="shrink-0 text-[10px] tabular-nums text-muted2">{option.count}</span>}
            </button>
          ))}
        </div>
      </Popover>
    </span>
  );
}

// Up to four of the folder's newest photos, 1 whole / 2 halves / 3 one tall
// + two stacked / 4 a 2×2; the folder icon when it has none.
function CoverMosaic({ paths, className = "" }) {
  const n = coverLayout(paths?.length);
  if (!n) {
    return (
      <div className={cx("flex items-center justify-center bg-[var(--fill-2)] text-muted2", className)}>
        <Folder className="h-6 w-6 stroke-[1.4]" />
      </div>
    );
  }
  const shown = paths.slice(0, n);
  const grid = n === 1 ? "grid-cols-1" : n === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2";
  return (
    <div data-cover-count={n} className={cx("grid gap-px bg-[var(--pane)]", grid, className)}>
      {shown.map((path, index) => (
        <img
          key={`${index}:${path}`}
          src={localFileUrl(path)}
          alt=""
          draggable={false}
          loading="lazy"
          className={cx("h-full w-full min-h-0 object-cover", n === 3 && index === 0 ? "row-span-2" : "")}
        />
      ))}
    </div>
  );
}

export default function FoldersView({
  collections,
  onOpenFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onAnnotateFolder,
  pushToast,
}) {
  const { t, i18n } = useTranslation("nav");
  const locale = i18n.language || undefined;
  const canAnnotate = api.can("annotation");

  const [query, setQuery] = useState("");
  const [sort, setSortState] = useState(() => readPref(SORT_KEY, FOLDER_PAGE_SORTS, DEFAULT_FOLDER_PAGE_SORT));
  const setSort = (next) => { setSortState(next); writePref(SORT_KEY, next); };
  const [view, setViewState] = useState(() => readPref(VIEW_KEY, ["grid", "list"], "grid"));
  const setView = (next) => { setViewState(next); writePref(VIEW_KEY, next); };
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const anchorRef = useRef(null);
  const [menu, setMenu] = useState(null); // { folder, x, y }
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);

  const manual = useMemo(() => (collections || []).filter((c) => c.kind === "manual"), [collections]);
  const cards = useMemo(
    () => visibleFolderCards(collections, { sort, query, filters, locale }),
    [collections, sort, query, filters, locale],
  );
  const filterCount = folderFilterCount(filters);
  const counts = useMemo(() => statusCounts(collections, { sort, query, filters, locale }), [collections, sort, query, filters, locale]);
  const byId = useMemo(() => new Map(manual.map((c) => [c.collection_id, c])), [manual]);
  const maxCount = manual.reduce((max, c) => Math.max(max, c.item_count || 0), 0);
  const captureRange = useMemo(() => {
    const stamps = manual.flatMap((c) => [c.captured_from, c.captured_to]).filter(Boolean).sort();
    return { min: stamps[0]?.slice(0, 10), max: stamps[stamps.length - 1]?.slice(0, 10) };
  }, [manual]);

  // A folder that went away (deleted here or elsewhere) leaves the selection.
  const selected = [...selectedIds].filter((id) => byId.has(id));
  const selectedPhotos = selected.reduce((n, id) => n + (byId.get(id)?.item_count || 0), 0);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [query, sort, filters, view]);
  const visible = cards.slice(0, visibleCount);
  const hasMore = cards.length > visibleCount;
  useEffect(() => {
    if (!hasMore || !sentinelRef.current) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisibleCount((count) => count + PAGE_SIZE);
    }, { root: scrollRef.current, rootMargin: "600px" });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, visibleCount]);

  function select(id, event) {
    const order = cards.map((c) => c.collection_id);
    setSelectedIds((current) => {
      if (event?.shiftKey && anchorRef.current) return new Set(selectRange(order, anchorRef.current, id));
      if (event?.metaKey || event?.ctrlKey) {
        const next = new Set(current);
        if (next.has(id)) next.delete(id); else next.add(id);
        anchorRef.current = id;
        return next;
      }
      anchorRef.current = id;
      return new Set([id]);
    });
  }
  const clearSelection = () => { setSelectedIds(new Set()); anchorRef.current = null; };

  async function deleteFolders(ids) {
    const folders = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!folders.length) return;
    const many = folders.length > 1;
    const approved = await confirm({
      title: many ? t("folders.deleteConfirmTitleMany", { count: folders.length }) : t("folders.deleteConfirmTitleOne", { name: folders[0].name }),
      message: many ? t("folders.deleteConfirmMessageMany") : t("folders.deleteConfirmMessageOne"),
      confirmLabel: many ? t("folders.deleteConfirmActionMany", { count: folders.length }) : t("folders.deleteConfirmActionOne"),
      cancelLabel: t("folders.deleteCancel"),
      danger: true,
    });
    if (!approved) return;
    try {
      for (const folder of folders) await onDeleteFolder?.(folder.collection_id);
      clearSelection();
    } catch (error) {
      pushToast?.({ title: t("folders.deleteFailed"), message: String(error?.message || error), tone: "error", ttl: 7000 });
    }
  }

  function annotateFolders(ids) {
    for (const id of ids) onAnnotateFolder?.(id);
  }

  // Esc clears; ⌘A selects what the page shows; Enter opens a lone selection;
  // Delete / Backspace asks about the selection. Not while typing in a field.
  useEffect(() => {
    function onKey(event) {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.closest("input, textarea, [contenteditable]"));
      if (event.key === "Escape") {
        if (menu) { setMenu(null); return; }
        if (!typing && selected.length) { event.preventDefault(); clearSelection(); }
        return;
      }
      if (typing || editingId || creating) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(new Set(cards.map((c) => c.collection_id)));
        return;
      }
      if (event.key === "Enter" && selected.length === 1) { event.preventDefault(); onOpenFolder?.(selected[0]); return; }
      if ((event.key === "Delete" || event.key === "Backspace") && selected.length) { event.preventDefault(); void deleteFolders(selected); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const metaLine = (folder) => {
    const count = folder.item_count || 0;
    if (!count) return t("folders.empty");
    const span = formatMonthRange(folder.captured_from, folder.captured_to, locale);
    return span ? `${t("sidebar.folderMeta", { count })} · ${span}` : t("sidebar.folderMeta", { count });
  };
  const createdLabel = (folder) => parseStamp(folder.created_at, { zoneless: "utc" })?.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) || "";

  // Right-clicking one of several selected folders acts on the whole
  // selection; open and rename only make sense for one.
  const menuItems = (folder) => {
    const targets = selected.length > 1 && selected.includes(folder.collection_id) ? selected : [folder.collection_id];
    const single = targets.length === 1;
    return [
      ...(single ? [
        { key: "open", icon: Folder, label: t("folders.open"), onClick: () => onOpenFolder?.(folder.collection_id) },
        { key: "rename", icon: Pencil, label: t("folders.rename"), onClick: () => setEditingId(folder.collection_id) },
      ] : []),
      ...(canAnnotate ? [{ key: "annotate", icon: Sparkles, label: single ? t("folders.annotateFolder") : t("folders.annotateHint"), onClick: () => annotateFolders(targets) }] : []),
      { key: "delete", icon: Trash2, label: single ? t("folders.delete") : t("folders.deleteConfirmActionMany", { count: targets.length }), danger: true, onClick: () => void deleteFolders(targets) },
    ];
  };

  const openMenu = (folder, event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedIds.has(folder.collection_id)) { setSelectedIds(new Set([folder.collection_id])); anchorRef.current = folder.collection_id; }
    const rect = event.currentTarget.getBoundingClientRect?.();
    setMenu({ folder, x: event.clientX || rect?.right || 0, y: event.clientY || rect?.bottom || 0 });
  };

  const statusOptions = [
    { value: "empty", label: t("folders.statusEmpty"), count: counts.empty },
    { value: "recent", label: t("folders.statusRecent"), count: counts.recent },
  ];
  const addedOptions = RELATIVE_DAY_PRESETS.map((days) => ({ value: days, label: t("filter.lastDays", { count: days }) }));

  const nameEditor = (folder) => (
    <InlineEdit
      initial={folder.name}
      onConfirm={async (name) => { await onRenameFolder?.(folder.collection_id, name); setEditingId(null); }}
      onCancel={() => setEditingId(null)}
    />
  );

  // The card's shared handlers, for the grid tile and the list row alike.
  const rowProps = (folder) => ({
    "data-folder-id": folder.collection_id,
    "data-selected": selectedIds.has(folder.collection_id) ? "true" : undefined,
    role: "button",
    tabIndex: 0,
    onClick: (event) => { if (!event.target.closest("button, input")) select(folder.collection_id, event); },
    onDoubleClick: (event) => { if (!event.target.closest("button, input")) onOpenFolder?.(folder.collection_id); },
    onContextMenu: (event) => openMenu(folder, event),
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === " ") { event.preventDefault(); select(folder.collection_id, event); }
    },
  });

  return (
    <div data-testid="workspace-split" className="library-view relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="app-toolbar library-toolbar relative z-50 flex h-11 items-center gap-1 bg-chrome px-2.5">
        <IconButton title={t("folders.newFolder")} aria-label={t("folders.newFolder")} data-testid="folders-new" onClick={() => { setCreating(true); scrollRef.current?.scrollTo({ top: 0 }); }}>
          <Plus className="h-4 w-4 stroke-[1.8]" />
        </IconButton>
        <div className="ml-2 mr-2 flex min-w-0 flex-1 items-center gap-2 text-muted2">
          <FolderCog className="h-4 w-4 shrink-0" />
          <h1 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-text">{t("folders.title")}</h1>
          <span data-testid="folders-count" className="shrink-0 text-[12px] text-muted3">· {manual.length}</span>
        </div>

        <label className="relative block min-w-[96px] max-w-[176px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }}
            placeholder={t("folders.searchPlaceholder")}
            aria-label={t("folders.searchPlaceholder")}
            className="h-8 w-full rounded-md border border-border/70 bg-app py-0 pl-7 pr-2 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
          />
        </label>

        <SortDropdown sort={sort} setSort={setSort} />

        {/* Not `toolbar-modes`: the skin hides that class on a narrow toolbar
            (index.css container query), and this toggle must stay reachable. */}
        <div className="ml-1 flex items-center gap-0.5">
          <IconButton title={t("folders.viewGrid")} aria-label={t("folders.viewGrid")} aria-pressed={view === "grid"} data-testid="folders-view-grid" className={view === "grid" ? "bg-selected text-accent" : ""} onClick={() => setView("grid")}>
            <LayoutGrid className="h-3.5 w-3.5 stroke-[1.6]" />
          </IconButton>
          <IconButton title={t("folders.viewList")} aria-label={t("folders.viewList")} aria-pressed={view === "list"} data-testid="folders-view-list" className={view === "list" ? "bg-selected text-accent" : ""} onClick={() => setView("list")}>
            <List className="h-3.5 w-3.5 stroke-[1.6]" />
          </IconButton>
        </div>

        <div className="relative">
          <IconButton
            onClick={() => setShowFilters((c) => !c)}
            className={showFilters || filterCount > 0 ? "bg-selected text-accent" : ""}
            title={t("folders.filters")}
            aria-label={t("folders.filters")}
            data-testid="folders-filters-toggle"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 stroke-[1.8]" />
          </IconButton>
          {filterCount > 0 && (
            <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-accentInk">
              {filterCount}
            </span>
          )}
        </div>
      </div>

      {(showFilters || filterCount > 0) && (
        <div data-filter-bar="true" data-testid="folders-filter-bar" className="flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-chrome/60 px-2 py-1.5">
          <div className="filter-bar-scroll flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <ChoicePopover
              testId="folders-facet-status"
              label={t("folders.status")}
              value={filters.status || null}
              options={statusOptions}
              onSelect={(value) => setFilters((f) => setOrDelete(f, "status", value || undefined))}
            />
            {maxCount > 0 && (
              <RangePopover label={t("folders.count")} bounds={{ min: 0, max: maxCount }} step={1} minKey="count_min" maxKey="count_max" filters={filters} onChange={setFilters} />
            )}
            {captureRange.min && (
              <DateRangePopover captureRange={captureRange} filters={filters} onChange={setFilters} />
            )}
            <ChoicePopover
              testId="folders-facet-added"
              label={t("folders.lastAdded")}
              value={filters.added_within_days || null}
              options={addedOptions}
              onSelect={(value) => setFilters((f) => setOrDelete(f, "added_within_days", value || undefined))}
            />
          </div>
          {filterCount > 0 && (
            <div data-filter-actions="true" className="filter-bar-actions flex shrink-0 items-center gap-1.5">
              <button type="button" onClick={() => setFilters({})} className={ACTION_CHIP}>
                <X className="h-2.5 w-2.5" />
                {t("filter.clear", { count: filterCount })}
              </button>
            </div>
          )}
        </div>
      )}

      <main ref={scrollRef} data-testid="gallery-scroll" className="min-h-0 flex-1 overflow-y-auto p-6 pb-24">
        {creating && (
          <div className="mb-4 max-w-[320px]" data-testid="folders-create">
            <InlineEdit
              initial=""
              placeholder={t("folders.newFolderPlaceholder")}
              onConfirm={async (name) => {
                const created = await onCreateFolder?.(name);
                setCreating(false);
                if (created?.collection_id) { setSelectedIds(new Set([created.collection_id])); anchorRef.current = created.collection_id; }
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        )}

        {!manual.length && !creating ? (
          <div className="flex h-[260px] flex-col items-center justify-center gap-3 rounded-[18px] bg-[var(--fill)] text-center">
            <Folder className="h-8 w-8 stroke-[1.4] text-muted2" />
            <div className="text-[13px] text-text">{t("folders.noFolders")}</div>
            <div className="max-w-[360px] text-[12px] text-muted2">{t("folders.noFoldersHint")}</div>
            <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>{t("folders.newFolder")}</Button>
          </div>
        ) : !cards.length ? (
          <div className="px-1 py-6 text-[12px] text-muted2">
            {query.trim() ? t("folders.noMatches", { query: query.trim() }) : t("folders.noFilterMatches")}
          </div>
        ) : view === "grid" ? (
          <div data-testid="folders-grid" className="grid gap-x-4 gap-y-5 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
            {visible.map((folder) => {
              const isSelected = selectedIds.has(folder.collection_id);
              return (
                <div
                  key={folder.collection_id}
                  {...rowProps(folder)}
                  className="group/card relative cursor-default select-none outline-none focus-visible:[&>div:first-child]:ring-2 focus-visible:[&>div:first-child]:ring-accent/60"
                >
                  <div className={cx(
                    "relative aspect-square overflow-hidden rounded-xl border border-border/40 transition",
                    isSelected ? "ring-2 ring-accent/80" : "group-hover/card:border-accent/40",
                  )}>
                    <CoverMosaic paths={folder.cover_preview_paths} className="h-full w-full" />
                    <button
                      type="button"
                      aria-label={isSelected ? t("folders.clearSelection") : folder.name}
                      aria-pressed={isSelected}
                      onClick={(event) => { event.stopPropagation(); select(folder.collection_id, { metaKey: true }); }}
                      className={cx(
                        "absolute left-2 top-2 flex h-[18px] w-[18px] items-center justify-center rounded-full border transition",
                        isSelected
                          ? "border-accent bg-accent text-accentInk opacity-100"
                          : "border-white/70 bg-black/35 text-white opacity-0 group-hover/card:opacity-100",
                      )}
                    >
                      <Check className="h-3 w-3 stroke-[2.5]" />
                    </button>
                    <button
                      type="button"
                      aria-label={t("folders.open")}
                      onClick={(event) => openMenu(folder, event)}
                      className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-black/45 text-white opacity-0 transition group-hover/card:opacity-100"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 min-w-0">
                    {editingId === folder.collection_id ? nameEditor(folder) : (
                      <div className="truncate text-[13px] text-text" title={folder.name}>{folder.name}</div>
                    )}
                    <div className="mt-0.5 truncate text-[11px] text-muted2">{metaLine(folder)}</div>
                  </div>
                </div>
              );
            })}
            {hasMore && <div ref={sentinelRef} className="h-px w-full" />}
          </div>
        ) : (
          <table data-testid="folders-list" className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-muted2">
                <th className="w-7 px-2 py-1.5 font-medium" />
                <th className="w-10 px-2 py-1.5 font-medium" />
                {[
                  ["name", "name"], ["count", "largest"], ["captured", "captured"], ["lastAdded", "lastAdded"], ["created", "newest"],
                ].map(([column, sortKey]) => (
                  <th key={column} className={cx("whitespace-nowrap px-2 py-1.5 font-medium", column === "count" ? "text-right" : "")}>
                    <button
                      type="button"
                      onClick={() => setSort(sortKey)}
                      className={cx("inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-text", sort === sortKey ? "text-text" : "")}
                    >
                      {t(`folders.columns.${column}`)}
                      {sort === sortKey && <ChevronDown className="h-2.5 w-2.5" />}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((folder) => {
                const isSelected = selectedIds.has(folder.collection_id);
                return (
                  <tr
                    key={folder.collection_id}
                    {...rowProps(folder)}
                    className={cx(
                      "cursor-default select-none border-t border-border/30 outline-none transition-colors focus-visible:bg-hover",
                      isSelected ? "bg-selected text-text" : "text-muted hover:bg-hover hover:text-text",
                    )}
                  >
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={folder.name}
                        onClick={(event) => { event.stopPropagation(); select(folder.collection_id, { metaKey: true }); }}
                        className={cx("flex h-3.5 w-3.5 items-center justify-center rounded border", isSelected ? "border-accent bg-accent text-accentInk" : "border-muted2")}
                      >
                        {isSelected && <Check className="h-2.5 w-2.5 stroke-[3]" />}
                      </button>
                    </td>
                    <td className="px-2 py-1.5"><CoverMosaic paths={folder.cover_preview_paths?.slice(0, 1)} className="h-7 w-7 overflow-hidden rounded-md" /></td>
                    <td className="max-w-[320px] px-2 py-1.5 text-text">
                      {editingId === folder.collection_id ? nameEditor(folder) : <span className="block truncate">{folder.name}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{folder.item_count || 0}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{formatMonthRange(folder.captured_from, folder.captured_to, locale) || t("folders.captureUnknown")}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap" title={folder.last_added_at ? parseStamp(folder.last_added_at, { zoneless: "utc" })?.toLocaleString(locale) : undefined}>
                      {formatRelativeTime(folder.last_added_at, { locale }) || t("folders.captureUnknown")}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{createdLabel(folder)}</td>
                  </tr>
                );
              })}
              {hasMore && <tr><td colSpan={7}><div ref={sentinelRef} className="h-px w-full" /></td></tr>}
            </tbody>
          </table>
        )}
      </main>

      {selected.length > 0 && (
        <div
          data-testid="folders-selection-bar"
          className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border/60 bg-chrome/90 py-2 pl-3.5 pr-2 text-[12px] text-text shadow-overlay backdrop-blur-md"
          style={{ zIndex: Z.dropdown }}
        >
          <span className="whitespace-nowrap">{t("folders.selected", { count: selected.length, photos: selectedPhotos.toLocaleString(locale) })}</span>
          {canAnnotate && (
            <Button variant="secondary" size="sm" title={t("folders.annotateHint")} onClick={() => annotateFolders(selected)}>
              <Sparkles className="mr-1.5 h-3 w-3" />{t("folders.annotate")}
            </Button>
          )}
          <Button variant="danger" size="sm" data-testid="folders-delete-selected" onClick={() => void deleteFolders(selected)}>
            <Trash2 className="mr-1.5 h-3 w-3" />{t("folders.delete")}
          </Button>
          <IconButton size="sm" title={t("folders.clearSelection")} aria-label={t("folders.clearSelection")} onClick={clearSelection}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}

      {menu && (
        <FaceMenu position={menu} items={menuItems(menu.folder)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
