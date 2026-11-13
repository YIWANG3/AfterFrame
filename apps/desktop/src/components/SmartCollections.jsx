// Sidebar section for smart collections: saved filters with a live count.
// Unlike folders they are not drop targets and have no manual order — what is
// in them is decided by their conditions (hooks/workspaceLogic.rulesFromScope).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput, ListFilter, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";
import api from "../api";
import { localFileUrl } from "../utils/format";
import FaceMenu from "./FaceMenu";
import InlineEdit from "./InlineEdit";
import { SectionHeading, useSectionOpen } from "./SidebarSection";

// `view` is the sidebar's list / covers switch, shared with the folders below.
// `grow`: the folders below are folded, so this section may run past its cap,
// as tall as its rows; the folders' heading follows right under the last one.
export default function SmartCollections({ collections, activeId, view = "list", grow = false, onOpen, onEditRules, onRename, onDelete, onSnapshot }) {
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
  const [open, toggleOpen] = useSectionOpen("smart");

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

  if (!smart.length) return null;

  return (
    // Open, the section takes at most two fifths of the sidebar and scrolls
    // inside that, so the folders below always keep their room; in a short
    // window it shrinks further, down to its heading and a couple of rows.
    <div
      className={!open ? "mb-3 shrink-0" : grow ? "mb-3 flex min-h-0 shrink flex-col" : "mb-3 flex min-h-[96px] max-h-[40%] shrink flex-col"}
      data-smart-collections="true"
      data-open={open ? "true" : "false"}
    >
      <SectionHeading
        id="smart"
        label={t("sidebar.smartCollections")}
        open={open}
        onToggle={toggleOpen}
        holdsActive={smart.some((c) => c.collection_id === activeId)}
      />
      {open && (
      <div className="min-h-0 overflow-y-auto overscroll-contain" data-smart-collections-list="true">
      {smart.map((col) => {
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
