// The manager page's other two tabs (ManagerTabs.jsx): every smart collection,
// and every folder on disk, as cards or a list, searchable and sortable. The
// Collections tab is FoldersView. Each card opens its place in the gallery; a
// right click (or the card's ⋯) has what the sidebar row's menu has.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput, FolderX, LayoutGrid, List, ListFilter, MoreHorizontal, Pencil, Plus, RefreshCw, Search, SlidersHorizontal, Trash2, Folder } from "lucide-react";
import { ManagerEmptyState, ToolbarIconButton as IconButton, ToolbarSortDropdown } from "./managerChrome";
import api from "../api";
import { cx } from "../ui";
import { usePref } from "../hooks/usePref";
import { folderBase } from "../hooks/workspaceLogic";
import { oneOf } from "../utils/prefs";
import { localFileUrl } from "../utils/format";
import FaceMenu from "./FaceMenu";
import InlineEdit from "./InlineEdit";
import ManagerTabs from "./ManagerTabs";
import { diskFolderMenu } from "./DiskFolders";
import { ancestorsOf, isSynced } from "./diskFolderTree";

// How many cards fetch a cover photo; past that they show the icon.
const COVER_LIMIT = 120;

// The first photo each card's place shows, fetched once per key.
function useCovers(entries) {
  const [covers, setCovers] = useState({});
  const key = entries.slice(0, COVER_LIMIT).map((entry) => entry.key).join("|");
  useEffect(() => {
    let cancelled = false;
    const missing = entries.slice(0, COVER_LIMIT).filter((entry) => !(entry.key in covers));
    if (!missing.length) return undefined;
    (async () => {
      const next = {};
      for (const entry of missing) {
        try {
          const rows = await api.browseImages({ status: "all", base: entry.base, limit: 1, offset: 0 });
          next[entry.key] = rows?.[0]?.preview_path || rows?.[0]?.image_path || null;
        } catch { next[entry.key] = null; }
        if (cancelled) return;
      }
      setCovers((prev) => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return covers;
}

function Cover({ path, icon: Icon }) {
  return path ? (
    <img src={localFileUrl(path)} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />
  ) : (
    <div className="flex h-full w-full items-center justify-center bg-[var(--fill-2)] text-muted2">
      <Icon className="h-6 w-6 stroke-[1.4]" />
    </div>
  );
}

// The toolbar both tabs share, in the collections tab's markup (FoldersView):
// new, the tabs, a search field, the sort button, grid or list.
function ManagerToolbar({ tabs, onNew, newLabel, query, setQuery, placeholder, sort, setSort, sorts, view, setView, extra = null }) {
  const { t } = useTranslation("nav");
  return (
    <div className="app-toolbar library-toolbar relative z-50 flex h-11 items-center gap-1 bg-chrome px-2.5">
      {onNew && (
        <IconButton title={newLabel} aria-label={newLabel} data-testid="manager-new" onClick={onNew}>
          <Plus className="h-4 w-4 stroke-[1.8]" />
        </IconButton>
      )}
      <div className="ml-2 mr-2 min-w-0 flex-1">{tabs}</div>
      <label className="relative block min-w-[96px] max-w-[176px] flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid="manager-search"
          className="h-8 w-full rounded-md border border-border/70 bg-app py-0 pl-7 pr-2 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
        />
      </label>
      <ToolbarSortDropdown
        value={sort}
        onChange={setSort}
        options={sorts.map((value) => ({ value, label: t(`manager.sorts.${value}`) }))}
        title={t("manager.sort")}
        testId="manager-sort"
      />
      {extra}
      <div className="toolbar-group flex items-center gap-0.5">
        <IconButton title={t("folders.viewGrid")} aria-label={t("folders.viewGrid")} aria-pressed={view === "grid"} className={view === "grid" ? "bg-selected text-accent" : ""} onClick={() => setView("grid")}>
          <LayoutGrid className="h-3.5 w-3.5 stroke-[1.6]" />
        </IconButton>
        <IconButton title={t("folders.viewList")} aria-label={t("folders.viewList")} aria-pressed={view === "list"} className={view === "list" ? "bg-selected text-accent" : ""} onClick={() => setView("list")}>
          <List className="h-3.5 w-3.5 stroke-[1.6]" />
        </IconButton>
      </div>
    </div>
  );
}

const byName = (locale) => (a, b) => String(a.name || "").localeCompare(String(b.name || ""), locale, { numeric: true, sensitivity: "base" });

// ── Smart Collections ──

const SMART_SORTS = ["name", "count"];

export function SmartCollectionsPage({ collections, tab, onTab, counts, onOpen, onEditRules, onRename, onDelete, onSnapshot, onNew }) {
  const { t, i18n } = useTranslation("nav");
  const [query, setQuery] = useState("");
  const [sort, setSort] = usePref("manager.smartSort", "name", oneOf(SMART_SORTS));
  const [view, setView] = usePref("manager.smartView", "grid", oneOf(["grid", "list"]));
  const [menu, setMenu] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const smartCount = (collections || []).filter((c) => c.kind === "smart").length;
  const smart = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = (collections || []).filter((c) => c.kind === "smart" && (!needle || String(c.name).toLowerCase().includes(needle)));
    return list.sort(sort === "count" ? (a, b) => (b.item_count || 0) - (a.item_count || 0) : byName(i18n.language));
  }, [collections, query, sort, i18n.language]);
  const covers = useCovers(smart.filter((c) => c.rules).map((c) => ({ key: `${c.collection_id}:${c.item_count || 0}`, base: c.rules })));
  const coverOf = (c) => covers[`${c.collection_id}:${c.item_count || 0}`];
  const open = (c) => c.rules && onOpen?.(c);
  const menuItems = (c) => [
    c.rules && { key: "edit-rules", icon: SlidersHorizontal, label: t("sidebar.editSmartRules"), onClick: () => onEditRules?.(c) },
    c.rules && { key: "snapshot", icon: FolderInput, label: t("sidebar.snapshotToFolder"), onClick: () => onSnapshot?.(c) },
    { key: "rename", icon: Pencil, label: t("sidebar.rename"), onClick: () => setEditingId(c.collection_id) },
    { key: "delete", icon: Trash2, label: t("sidebar.delete"), danger: true, onClick: () => onDelete?.(c.collection_id) },
  ].filter(Boolean);
  const name = (c) => (editingId === c.collection_id ? (
    <InlineEdit initial={c.name} onConfirm={async (next) => { await onRename?.(c.collection_id, next); setEditingId(null); }} onCancel={() => setEditingId(null)} />
  ) : <div className="truncate text-[13px] text-text" title={c.name}>{c.name}</div>);

  return (
    <div data-testid="workspace-split" data-manager-page="smart" className="library-view relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <ManagerToolbar
        tabs={<ManagerTabs tab={tab} onTab={onTab} counts={counts} />}
        onNew={onNew}
        newLabel={t("sidebar.newSmart")}
        query={query}
        setQuery={setQuery}
        placeholder={t("manager.searchSmart")}
        sort={sort}
        setSort={setSort}
        sorts={SMART_SORTS}
        view={view}
        setView={setView}
      />
      <main data-testid="gallery-scroll" className="min-h-0 flex-1 overflow-y-auto p-6 pb-24">
        {!smartCount ? (
          <ManagerEmptyState
            testId="manager-empty"
            icon={ListFilter}
            title={t("manager.noSmart")}
            hint={t("manager.noSmartHint")}
            action={onNew ? { label: t("sidebar.newSmart"), onClick: onNew } : null}
          />
        ) : !smart.length ? (
          <div className="px-1 py-6 text-[12px] text-muted2">{t("manager.noMatches", { query: query.trim() })}</div>
        ) : view === "grid" ? (
          <div className="grid gap-x-4 gap-y-5 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
            {smart.map((c) => (
              <div key={c.collection_id} data-manager-smart={c.collection_id} className="group/card relative cursor-pointer select-none" onClick={() => open(c)} onContextMenu={(event) => { event.preventDefault(); setMenu({ item: c, x: event.clientX, y: event.clientY }); }}>
                <div className="relative aspect-square overflow-hidden rounded-xl border border-border/40 group-hover/card:border-accent/40">
                  <Cover path={coverOf(c)} icon={ListFilter} />
                  <button type="button" aria-label={t("manager.more")} onClick={(event) => { event.stopPropagation(); setMenu({ item: c, x: event.clientX, y: event.clientY }); }} className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded bg-black/45 text-white opacity-0 transition group-hover/card:opacity-100">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 min-w-0">
                  {name(c)}
                  <div className="mt-0.5 truncate text-[11px] text-muted2">{t("sidebar.folderMeta", { count: c.item_count || 0 })}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <tbody>
              {smart.map((c) => (
                <tr key={c.collection_id} data-manager-smart={c.collection_id} className="cursor-pointer border-b border-border/40 hover:bg-hover/50" onClick={() => open(c)} onContextMenu={(event) => { event.preventDefault(); setMenu({ item: c, x: event.clientX, y: event.clientY }); }}>
                  <td className="py-2 pl-1"><span className="flex items-center gap-2"><ListFilter className="h-4 w-4 shrink-0 stroke-[1.6] text-muted2" />{name(c)}</span></td>
                  <td className="w-24 py-2 pr-2 text-right tabular-nums text-muted2">{c.item_count || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
      {menu && <FaceMenu testId="manager-smart-menu" position={menu} items={menuItems(menu.item)} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ── Folders on disk ──

const FOLDER_SORTS = ["name", "count", "path"];

export function DiskFoldersPage({ diskFolders, tab, onTab, counts, onOpen, onImport }) {
  const { t, i18n } = useTranslation("nav");
  const [query, setQuery] = useState("");
  const [sort, setSort] = usePref("manager.folderSort", "name", oneOf(FOLDER_SORTS));
  const [view, setView] = usePref("manager.folderView", "grid", oneOf(["grid", "list"]));
  const [menu, setMenu] = useState(null);
  const { folders = [], watchedDirs = [] } = diskFolders || {};
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // The folders that hold photos themselves: a folder that only leads to
    // others (a drive's Users, a project's apps) is the sidebar tree's to show.
    const list = folders.filter((f) => (f.direct > 0 || !f.exists) && (!needle || String(f.name).toLowerCase().includes(needle) || String(f.path).toLowerCase().includes(needle)));
    if (sort === "count") return [...list].sort((a, b) => (b.total || 0) - (a.total || 0));
    if (sort === "path") return [...list].sort((a, b) => String(a.path).localeCompare(String(b.path), i18n.language, { numeric: true }));
    return [...list].sort(byName(i18n.language));
  }, [folders, query, sort, i18n.language]);
  const covers = useCovers(shown.map((f) => ({ key: `${f.path}:${f.total}`, base: folderBase(f.path, true) })));
  const coverOf = (f) => covers[`${f.path}:${f.total}`];
  // Where a folder sits in the tree, as the collections page shows a
  // collection's ("照片 / 2026"); the whole path is in its tooltip.
  const locationOf = (f) => {
    const names = ancestorsOf(folders, f.path).reverse().map((above) => folders.find((x) => x.path === above)?.name || "").filter(Boolean);
    return (names.length > 2 ? ["…", ...names.slice(-2)] : names).join(" / ");
  };
  const openMenu = (folder, event) => { event.preventDefault(); event.stopPropagation(); setMenu({ item: folder, x: event.clientX, y: event.clientY }); };
  const badges = (f) => (
    <>
      {!f.exists && <span className="shrink-0 rounded border border-[rgba(239,159,39,0.42)] px-1 text-[10px] text-[#EF9F27]" data-folder-missing="true">{t("manager.notFound")}</span>}
      {isSynced(f.path, watchedDirs) && <RefreshCw aria-label={t("diskFolders.autoSynced")} className="h-3 w-3 shrink-0 text-muted2" data-auto-synced="true" />}
    </>
  );

  return (
    <div data-testid="workspace-split" data-manager-page="folders" className="library-view relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <ManagerToolbar
        tabs={<ManagerTabs tab={tab} onTab={onTab} counts={counts} />}
        onNew={onImport}
        newLabel={t("diskFolders.import")}
        query={query}
        setQuery={setQuery}
        placeholder={t("manager.searchFolders")}
        sort={sort}
        setSort={setSort}
        sorts={FOLDER_SORTS}
        view={view}
        setView={setView}
        extra={(
          <IconButton title={t("diskFolders.syncAll")} aria-label={t("diskFolders.syncAll")} data-testid="manager-sync-all" onClick={() => diskFolders?.syncAll()}>
            <RefreshCw className="h-3.5 w-3.5 stroke-[1.8]" />
          </IconButton>
        )}
      />
      <main data-testid="gallery-scroll" className="min-h-0 flex-1 overflow-y-auto p-6 pb-24">
        {!folders.length ? (
          <ManagerEmptyState
            testId="manager-empty"
            icon={Folder}
            title={t("manager.noFolders")}
            hint={t("manager.noFoldersHint")}
            action={onImport ? { label: t("diskFolders.import"), onClick: onImport } : null}
          />
        ) : !shown.length ? (
          <div className="px-1 py-6 text-[12px] text-muted2">{t("manager.noMatches", { query: query.trim() })}</div>
        ) : view === "grid" ? (
          <div className="grid gap-x-4 gap-y-5 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
            {shown.map((f) => (
              <div key={f.path} data-manager-folder={f.path} className="group/card relative cursor-pointer select-none" onClick={() => onOpen?.(f.path)} onContextMenu={(event) => openMenu(f, event)}>
                <div className={cx("relative aspect-square overflow-hidden rounded-xl border border-border/40 group-hover/card:border-accent/40", f.exists ? "" : "opacity-60")}>
                  <Cover path={coverOf(f)} icon={f.exists ? Folder : FolderX} />
                  <button type="button" aria-label={t("manager.more")} onClick={(event) => openMenu(f, event)} className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded bg-black/45 text-white opacity-0 transition group-hover/card:opacity-100">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 min-w-0">
                  <div className="flex items-center gap-1.5"><span className="min-w-0 truncate text-[13px] text-text" title={f.path}>{f.name}</span>{badges(f)}</div>
                  {locationOf(f) && <div data-folder-location="true" className="truncate text-[10px] text-muted2" title={f.path}>{locationOf(f)}</div>}
                  <div className="mt-0.5 truncate text-[11px] text-muted2">{t("sidebar.folderMeta", { count: f.total || 0 })}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <tbody>
              {shown.map((f) => (
                <tr key={f.path} data-manager-folder={f.path} className="cursor-pointer border-b border-border/40 hover:bg-hover/50" onClick={() => onOpen?.(f.path)} onContextMenu={(event) => openMenu(f, event)}>
                  <td className="py-2 pl-1">
                    <span className="flex min-w-0 items-center gap-2">
                      {f.exists ? <Folder className="h-4 w-4 shrink-0 stroke-[1.6] text-muted2" /> : <FolderX className="h-4 w-4 shrink-0 stroke-[1.6] text-muted2" />}
                      <span className="truncate text-text">{f.name}</span>
                      {badges(f)}
                    </span>
                  </td>
                  <td className="max-w-0 py-2 pr-2 text-muted2"><span className="block truncate" title={f.path}>{locationOf(f)}</span></td>
                  <td className="w-24 py-2 pr-2 text-right tabular-nums text-muted2">{f.total || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
      {menu && diskFolders && (
        <FaceMenu testId="manager-folder-menu" position={menu} items={diskFolderMenu(menu.item, { t, watchedDirs, actions: diskFolders })} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
