// Sidebar section for smart collections: saved filters with a live count.
// Unlike folders they are not drop targets and have no manual order — what is
// in them is decided by their conditions (hooks/workspaceLogic.rulesFromScope).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput, ListFilter, Pencil, Trash2 } from "lucide-react";
import InlineEdit from "./InlineEdit";

export default function SmartCollections({ collections, activeId, onOpen, onRename, onDelete, onSnapshot }) {
  const { t } = useTranslation("nav");
  const [editingId, setEditingId] = useState(null);
  const smart = (collections || []).filter((c) => c.kind === "smart");
  if (!smart.length) return null;

  return (
    <div className="mb-3 shrink-0" data-smart-collections="true">
      <div className="px-2.5 pb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{t("sidebar.smartCollections")}</span>
      </div>
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
            className={[
              "group flex w-full cursor-pointer items-center justify-between gap-2 rounded-[8px] px-2.5 py-1.5 text-left transition-colors",
              active ? "bg-selected text-text" : "text-muted hover:bg-hover/70 hover:text-text",
              readable ? "" : "opacity-50",
            ].join(" ")}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <ListFilter className={`h-4 w-4 shrink-0 stroke-[1.6] ${active ? "text-accent" : ""}`} />
              <span className="min-w-0 truncate text-[13px]">{col.name}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <span className={`text-[11px] tabular-nums ${active ? "text-accent" : "text-muted2"}`}>{col.item_count || 0}</span>
              <span className="hidden gap-0.5 group-hover:flex">
                {readable && (
                  <button
                    type="button"
                    className="rounded-md p-0.5 text-muted2 hover:text-text"
                    title={t("sidebar.snapshotToFolder")}
                    onClick={(e) => { e.stopPropagation(); onSnapshot?.(col); }}
                  >
                    <FolderInput className="h-3 w-3" />
                  </button>
                )}
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
                  onClick={(e) => { e.stopPropagation(); onDelete?.(col.collection_id); }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
