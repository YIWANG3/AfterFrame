// Sidebar section for smart collections: saved filters with a live count.
// Unlike folders they are not drop targets and have no manual order — what is
// in them is decided by their conditions (hooks/workspaceLogic.rulesFromScope).
// Like the other two sections the heading has a search, which narrows the rows
// to the names that hold it (the same rule as the manager's Smart tab).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EyeOff, FolderCog, FolderInput, Image as ImageIcon, List, ListFilter, Pencil, Plus, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import api from "../api";
import { localFileUrl } from "../utils/format";
import FaceMenu from "./FaceMenu";
import InlineEdit from "./InlineEdit";
import { SectionHeading, useSectionOpen } from "./SidebarSection";
import SectionMoreMenu from "./SectionMoreMenu";
import { setSidebarHidden } from "./sidebarLayout";

// One of the sidebar's three sections, first unless the user moves it.
// `view` is the sidebar's list / covers switch, shared with the collections.
// `grow`: the collections are folded, so this one may run past its cap, as
// tall as its rows.
// `headingProps` go on the heading row (its right-click menu, the drag that
// moves the section), `rootProps` on the section itself (where a dragged
// section lands).
// `onNew` starts a new one (the filter bar, whose conditions it saves);
// `onToggleView` flips the list / covers switch; `onOpenManager` opens the
// manager on its Smart Collections tab.
export default function SmartCollections({ collections, activeId, view = "list", grow = false, onOpen, onEditRules, onRename, onDelete, onSnapshot, onNew, onToggleView, onOpenManager, headingProps = {}, rootProps = {} }) {
  const { t } = useTranslation("nav");
  const [editingId, setEditingId] = useState(null);
  // The row right-clicked: { col, x, y }. Its actions are in that menu.
  const [menu, setMenu] = useState(null);
  const menuItems = (col) => [
    col.rules && { key: "edit-rules", icon: SlidersHorizontal, label: t("sidebar.editSmartRules"), onClick: () => onEditRules?.(col) },
    col.rules && { key: "snapshot", icon: FolderInput, label: t("sidebar.snapshotToFolder"), onClick: () => onSnapshot?.(col) },
    { key: "rename", icon: Pencil, label: t("sidebar.rename"), onClick: () => setEditingId(col.collection_id) },
    { key: "delete", icon: Trash2, label: t("sidebar.delete"), danger: true, onClick: () => onDelete?.(col.collection_id) },
  ].filter(Boolean);
  const smart = (collections || []).filter((c) => c.kind === "smart");
  const [open, toggleOpen, showSection] = useSectionOpen("smart");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const closeSearch = () => { setSearching(false); setQuery(""); };
  const needle = query.trim().toLowerCase();
  const shown = needle ? smart.filter((c) => String(c.name).toLowerCase().includes(needle)) : smart;

  // Covers: the first photo the saved filter currently shows. Keyed on the
  // conditions and the live count, so a cover follows its collection when a
  // photo joins or leaves it, or when its conditions are updated.
  const [covers, setCovers] = useState({});
  const coverKey = smart.map((c) => `${c.collection_id}:${c.item_count || 0}:${JSON.stringify(c.rules || null)}`).join("|");
  useEffect(() => {
    if (view !== "covers" || !open) return undefined;
    let cancelled = false;
    const stale = smart.filter((c) => covers[c.collection_id]?.key !== `${c.item_count || 0}:${JSON.stringify(c.rules || null)}`);
    if (!stale.length) return undefined;
    (async () => {
      const next = {};
      await Promise.all(stale.map(async (c) => {
        let path = null;
        if (c.rules && (c.item_count || 0) > 0) {
          try {
            const rows = await api.browseImages({ status: "all", base: c.rules, limit: 1, offset: 0 });
            path = rows?.[0]?.preview_path || rows?.[0]?.image_path || null;
          } catch { path = null; }
        }
        next[c.collection_id] = { path, key: `${c.item_count || 0}:${JSON.stringify(c.rules || null)}` };
      }));
      if (!cancelled) setCovers((prev) => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, open, coverKey]);

  return (
    // Open, the section is as tall as its rows up to two fifths of the
    // sidebar, and scrolls inside past that.
    <div
      className={!open ? "shrink-0" : grow ? "flex min-h-0 shrink flex-col" : "flex max-h-[40%] min-h-0 shrink flex-col"}
      data-smart-collections="true"
      data-open={open ? "true" : "false"}
      {...rootProps}
    >
      <SectionHeading
        {...headingProps}
        id="smart"
        label={t("sidebar.smartCollections")}
        open={open}
        onToggle={toggleOpen}
        holdsActive={smart.some((c) => c.collection_id === activeId)}
      >
        <button
          type="button"
          className={`rounded p-0.5 transition-colors hover:bg-hover hover:text-text ${searching ? "text-text" : "text-muted2"}`}
          title={t("sidebar.searchSmart")}
          aria-label={t("sidebar.searchSmart")}
          aria-pressed={searching}
          onClick={() => { if (searching) closeSearch(); else { showSection(); setSearching(true); } }}
        >
          <Search className="h-3.5 w-3.5" />
        </button>
        {onNew && (
          <button
            type="button"
            className="rounded p-0.5 text-muted2 transition-colors hover:bg-hover hover:text-text"
            title={t("sidebar.newSmart")}
            aria-label={t("sidebar.newSmart")}
            // No search hides the one it makes.
            onClick={() => { closeSearch(); onNew(); }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        <SectionMoreMenu
          testId="sidebar-more-smart"
          items={[
            onToggleView && { key: "view", icon: view === "covers" ? List : ImageIcon, label: view === "covers" ? t("sidebar.viewList") : t("sidebar.viewCovers"), onClick: onToggleView },
            onOpenManager && { key: "manage", icon: FolderCog, label: t("sidebar.openInManager"), onClick: onOpenManager },
            null,
            { key: "hide", icon: EyeOff, label: t("sidebar.hideSection"), onClick: () => setSidebarHidden("smartCollections", true) },
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
            placeholder={t("sidebar.searchSmart")}
            aria-label={t("sidebar.searchSmart")}
            data-testid="smart-collection-search"
            className="h-7 w-full rounded-md bg-[var(--fill-2)] pl-6 pr-6 text-[12px] text-text outline-none placeholder:text-muted2/60"
          />
          {query && (
            <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted2 hover:text-text" aria-label={t("sidebar.clearFolderSearch")} title={t("sidebar.clearFolderSearch")} onClick={() => setQuery("")}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      {open && (
      <div className="min-h-0 overflow-y-auto overscroll-contain" data-smart-collections-list="true">
      {!smart.length && <div className="px-2.5 py-2 text-[11px] text-muted2">{t("sidebar.noSmart")}</div>}
      {smart.length > 0 && !shown.length && <div className="px-2.5 py-2 text-[11px] text-muted2">{t("sidebar.noSmartMatches", { query: query.trim() })}</div>}
      {shown.map((col) => {
        const active = activeId === col.collection_id;
        // Rules this version cannot read (written by a newer one): shown, but inert.
        const readable = !!col.rules;
        if (editingId === col.collection_id) {
          return (
            <div key={col.collection_id} className="px-2.5 py-1">
              <InlineEdit
                initial={col.name}
                onConfirm={async (name) => { await onRename?.(col.collection_id, name); setEditingId(null); }}
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
            data-smart-collection={col.collection_id}
            title={readable ? undefined : t("sidebar.smartUnreadable")}
            onClick={() => readable && onOpen?.(col)}
            onKeyDown={(e) => { if (e.key === "Enter" && readable) onOpen?.(col); }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ col, x: e.clientX, y: e.clientY }); }}
            className={[
              "flex w-full cursor-pointer items-center justify-between gap-2 rounded-[8px] px-2.5 py-1.5 text-left transition-colors",
              active ? "bg-selected text-text" : "text-muted hover:bg-hover/70 hover:text-text",
              readable ? "" : "opacity-50",
            ].join(" ")}
          >
            {view === "covers" ? (
              <span className="flex min-w-0 items-center gap-2.5">
                {covers[col.collection_id]?.path ? (
                  <img
                    src={localFileUrl(covers[col.collection_id].path)}
                    alt=""
                    draggable={false}
                    data-smart-cover="true"
                    className="h-10 w-10 shrink-0 rounded-[8px] object-cover"
                  />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-[var(--fill-2)]">
                    <ListFilter className="h-4 w-4 stroke-[1.6] text-muted2" />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-[13px]">{col.name}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted2">{t("sidebar.folderMeta", { count: col.item_count || 0 })}</span>
                </span>
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-2.5">
                <ListFilter className={`h-4 w-4 shrink-0 stroke-[1.6] ${active ? "text-accent" : ""}`} />
                <span className="min-w-0 truncate text-[13px]">{col.name}</span>
              </span>
            )}
            {view !== "covers" && (
              <span className={`shrink-0 text-[11px] tabular-nums ${active ? "text-accent" : "text-muted2"}`}>{col.item_count || 0}</span>
            )}
          </div>
        );
      })}
      </div>
      )}
      {menu && <FaceMenu testId="sidebar-smart-menu" position={menu} items={menuItems(menu.col)} onClose={() => setMenu(null)} />}
    </div>
  );
}
