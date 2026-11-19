// The sidebar's Folders section: the folders on disk the library's photos are
// in, a read-only mirror (docs/collections-and-folders-design.md §5). It
// follows the disk and never changes it: no new folder, no rename, no
// dragging photos in. A folder opens as a place; its menu locates one that
// moved, syncs, turns auto-sync on or off, saves it as a collection, shows it
// in Finder, or takes its photos out of the library. The rows and their
// order come from components/diskFolderTree.js.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Album, ChevronDown, ChevronRight, EyeOff, Folder, FolderCog, FolderSearch, FolderX, HardDrive, Plus, RefreshCw, Search, Trash2, FolderSync, Eye, X } from "lucide-react";
import FaceMenu from "./FaceMenu";
import { SectionHeading, useSectionOpen } from "./SidebarSection";
import { DISK_FOLDER_SORTS, ancestorsOf, isSynced, visibleRows } from "./diskFolderTree";
import SectionMoreMenu from "./SectionMoreMenu";
import { setSidebarHidden } from "./sidebarLayout";
import { usePref } from "../hooks/usePref";
import { oneOf } from "../utils/prefs";

// `onImport` picks a folder on disk to import; `onOpenManager` opens the
// manager on its Folders tab.
export default function DiskFolders({ folders, watchedDirs, activePath, onOpen, actions, onImport, onOpenManager, onDragOver, onDragLeave, onDrop, dropActive = false, headingProps = {} }) {
  const { t } = useTranslation("nav");
  const [open, toggleOpen] = useSectionOpen("diskFolders");
  const [expanded, setExpanded] = useState(() => new Set());
  const [menu, setMenu] = useState(null);
  const [sort, setSort] = usePref("sidebar.diskFolderSort", "name", oneOf(DISK_FOLDER_SORTS));
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const closeSearch = () => { setSearching(false); setQuery(""); };

  // The folder on screen stays visible: the folders above it open.
  useEffect(() => {
    if (!activePath) return;
    const above = ancestorsOf(folders, activePath);
    if (!above.length) return;
    setExpanded((current) => (above.every((path) => current.has(path)) ? current : new Set([...current, ...above])));
  }, [activePath, folders]);

  const rows = useMemo(() => visibleRows(folders, expanded, { sort, query }), [folders, expanded, sort, query]);
  const toggle = (path) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const menuItems = (folder) => diskFolderMenu(folder, { t, watchedDirs, actions });

  return (
    <div
      className={[
        !open ? "shrink-0" : "flex max-h-[45%] min-h-0 shrink flex-col",
        dropActive ? "relative after:pointer-events-none after:absolute after:inset-x-0 after:-top-1.5 after:bottom-0 after:z-10 after:rounded-md after:ring-1 after:ring-inset after:ring-accent/45" : "",
      ].join(" ")}
      data-disk-folders="true"
      data-open={open ? "true" : "false"}
      data-import-drop={dropActive ? "true" : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <SectionHeading
        {...headingProps}
        id="diskFolders"
        label={t("sidebar.folders")}
        open={open}
        onToggle={toggleOpen}
        holdsActive={!!activePath}
      >
        <button
          type="button"
          className={`rounded p-0.5 transition-colors hover:bg-hover hover:text-text ${searching ? "text-text" : "text-muted2"}`}
          title={t("diskFolders.search")}
          aria-label={t("diskFolders.search")}
          aria-pressed={searching}
          onClick={() => { if (searching) closeSearch(); else { if (!open) toggleOpen(); setSearching(true); } }}
        >
          <Search className="h-3.5 w-3.5" />
        </button>
        {onImport && (
          <button
            type="button"
            className="rounded p-0.5 text-muted2 transition-colors hover:bg-hover hover:text-text"
            title={t("diskFolders.import")}
            aria-label={t("diskFolders.import")}
            onClick={onImport}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        <SectionMoreMenu
          testId="sidebar-more-folders"
          sort={{
            value: sort,
            options: DISK_FOLDER_SORTS.map((value) => ({ value, label: t(`diskFolders.sort.${value}`) })),
            onChange: setSort,
            testId: "disk-folder-sort-menu",
          }}
          items={[
            { key: "sync-all", icon: RefreshCw, label: t("diskFolders.syncAll"), onClick: () => actions.syncAll() },
            onOpenManager && { key: "manage", icon: FolderCog, label: t("sidebar.openInManager"), onClick: onOpenManager },
            null,
            { key: "hide", icon: EyeOff, label: t("sidebar.hideSection"), onClick: () => setSidebarHidden("diskFolders", true) },
          ].filter((item) => item !== false && item !== undefined)}
        />
      </SectionHeading>
      {open && searching && (
        <div className="relative mx-2.5 mb-1.5 shrink-0">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted2" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }}
            placeholder={t("diskFolders.search")}
            aria-label={t("diskFolders.search")}
            data-testid="disk-folder-search"
            className="h-7 w-full rounded-md bg-[var(--fill-2)] pl-6 pr-6 text-[12px] text-text outline-none placeholder:text-muted2/60"
          />
          {query && (
            <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted2 hover:text-text" aria-label={t("sidebar.clearFolderSearch")} onClick={() => setQuery("")}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="min-h-0 overflow-y-auto overscroll-contain" data-disk-folders-list="true">
          {!folders?.length && <div className="px-2.5 py-2 text-[11px] text-muted2">{t("diskFolders.empty")}</div>}
          {query.trim() && !rows.length && <div className="px-2.5 py-2 text-[11px] text-muted2">{t("diskFolders.noMatches", { query: query.trim() })}</div>}
          {rows.map((row) => {
            if (row.kind === "volume") {
              return (
                <div key={`volume:${row.volume}`} className="flex items-center gap-1.5 pb-0.5 pl-[10px] pr-2.5 pt-1.5 text-[10px] text-muted2" data-disk-volume={row.volume || "local"}>
                  <HardDrive className="h-3 w-3 shrink-0" />
                  <span className="truncate">{row.volume || t("diskFolders.thisMac")}</span>
                </div>
              );
            }
            const { folder, depth, expandable, expanded: isOpen } = row;
            const active = activePath === folder.path;
            const synced = isSynced(folder.path, watchedDirs);
            const Icon = folder.exists ? Folder : FolderX;
            // Always the photos in it and every folder under it, open or not.
            const count = folder.total;
            return (
              <div
                key={folder.path}
                role="button"
                tabIndex={0}
                data-disk-folder={folder.path}
                data-missing={folder.exists ? undefined : "true"}
                title={folder.exists ? folder.path : `${folder.path}\n${t("diskFolders.missing")}`}
                onClick={() => onOpen(folder.path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onOpen(folder.path);
                  if (expandable && event.key === "ArrowRight" && !isOpen) toggle(folder.path);
                  if (expandable && event.key === "ArrowLeft" && isOpen) toggle(folder.path);
                }}
                onContextMenu={(event) => { event.preventDefault(); setMenu({ folder, x: event.clientX, y: event.clientY }); }}
                className={[
                  "flex w-full cursor-pointer items-center justify-between rounded-md py-1.5 pr-2.5 text-left transition-colors",
                  active ? "bg-selected text-text" : "text-muted hover:bg-hover/70 hover:text-text",
                ].join(" ")}
                // Laid out like a collection row: the icon first, at the same
                // place for every top folder; the chevron after the count.
                style={{ paddingLeft: `calc(10px + ${depth} * 14px)` }}
              >
                <span className="flex min-w-0 items-center gap-2.5 overflow-hidden">
                  <Icon className={`h-4 w-4 shrink-0 stroke-[1.6] ${active ? "text-accent" : ""} ${folder.exists ? "" : "text-muted2"}`} />
                  <span className={`min-w-0 truncate text-[13px] ${folder.exists ? "" : "text-muted2"}`}>{folder.name}</span>
                  {synced && <RefreshCw data-auto-synced="true" aria-label={t("diskFolders.autoSynced")} className="h-3 w-3 shrink-0 text-muted2" />}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className={`text-[11px] tabular-nums ${active ? "text-accent" : "text-muted2"}`}>{count}</span>
                  {expandable ? (
                    <button
                      type="button"
                      data-disk-folder-toggle={folder.path}
                      aria-expanded={isOpen}
                      aria-label={isOpen ? t("sidebar.collapse") : t("sidebar.expand")}
                      onClick={(event) => { event.stopPropagation(); toggle(folder.path); }}
                      className="-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted2 hover:bg-hover hover:text-text"
                    >
                      {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {menu && <FaceMenu testId="sidebar-disk-folder-menu" position={menu} items={menuItems(menu.folder)} onClose={() => setMenu(null)} />}
    </div>
  );
}

// A folder's menu, in the sidebar and on the manager's Folders tab: locate one
// that moved, sync, auto-sync on or off, save as a collection, show in
// Finder, take its photos out of the library.
export function diskFolderMenu(folder, { t, watchedDirs, actions }) {
  const synced = isSynced(folder.path, watchedDirs);
  return [
    !folder.exists && { key: "locate", icon: FolderSearch, label: t("diskFolders.locate"), onClick: () => actions.locate(folder) },
    { key: "sync", icon: RefreshCw, label: t("diskFolders.sync"), onClick: () => actions.sync(folder) },
    folder.exists && {
      key: "auto-sync",
      icon: FolderSync,
      label: synced ? t("diskFolders.autoSyncOff") : t("diskFolders.autoSyncOn"),
      onClick: () => actions.setAutoSync(folder, !synced),
    },
    { key: "save-collection", icon: Album, label: t("diskFolders.saveAsCollection"), onClick: () => actions.saveAsCollection(folder) },
    folder.exists && { key: "reveal", icon: Eye, label: t("diskFolders.reveal"), onClick: () => actions.reveal(folder) },
    { key: "remove", icon: Trash2, label: t("diskFolders.remove"), danger: true, onClick: () => actions.remove(folder) },
  ].filter(Boolean);
}
