// The sidebar's Folders section: the folders on disk the library's photos are
// in, a read-only mirror (docs/collections-and-folders-design.md §5). It
// follows the disk and never changes it: no new folder, no rename, no
// dragging photos in. A folder opens as a place; its menu locates one that
// moved, syncs, turns auto-sync on or off, saves it as a collection, shows it
// in Finder, or takes its photos out of the library. The rows and their
// order come from components/diskFolderTree.js.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Album, ChevronDown, ChevronRight, Folder, FolderSearch, FolderX, HardDrive, RefreshCw, Trash2, FolderSync, Eye } from "lucide-react";
import FaceMenu from "./FaceMenu";
import { SectionHeading, useSectionOpen } from "./SidebarSection";
import { ancestorsOf, isSynced, visibleRows } from "./diskFolderTree";

export default function DiskFolders({ folders, watchedDirs, activePath, onOpen, actions, onDragOver, onDragLeave, onDrop, dropActive = false }) {
  const { t } = useTranslation("nav");
  const [open, toggleOpen] = useSectionOpen("diskFolders");
  const [expanded, setExpanded] = useState(() => new Set());
  const [menu, setMenu] = useState(null);

  // The folder on screen stays visible: the folders above it open.
  useEffect(() => {
    if (!activePath) return;
    const above = ancestorsOf(folders, activePath);
    if (!above.length) return;
    setExpanded((current) => (above.every((path) => current.has(path)) ? current : new Set([...current, ...above])));
  }, [activePath, folders]);

  const rows = useMemo(() => visibleRows(folders, expanded), [folders, expanded]);
  const toggle = (path) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const menuItems = (folder) => {
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
  };

  if (!folders?.length) return null;

  return (
    <div
      className={[
        !open ? "shrink-0" : "flex max-h-[45%] min-h-0 shrink-0 flex-col",
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
        id="diskFolders"
        label={t("sidebar.folders")}
        open={open}
        onToggle={toggleOpen}
        holdsActive={!!activePath}
      />
      {open && (
        <div className="min-h-0 overflow-y-auto overscroll-contain" data-disk-folders-list="true">
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
            // Closed, a folder counts everything under it; open, only its own
            // (the collections' tree does the same).
            const count = expandable && !isOpen ? folder.total : folder.direct;
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
