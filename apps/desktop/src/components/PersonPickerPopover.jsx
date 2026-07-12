import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ScanFace } from "lucide-react";
import { localFileUrl } from "../utils/format";
import FaceCrop from "./FaceCrop";

// Named-people picker used by "move to another person…" corrections.
export default function PersonPickerPopover({ anchorRect, excludeGroupId, onPick, onClose }) {
  const { t } = useTranslation("inspector");
  const [groups, setGroups] = useState(null);
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await window.mediaWorkspace?.listPeopleGroups?.() || [];
        if (!cancelled) setGroups(rows.filter((group) => group.name?.trim() && group.group_id !== excludeGroupId));
      } catch { if (!cancelled) setGroups([]); }
    })();
    return () => { cancelled = true; };
  }, [excludeGroupId]);
  useEffect(() => {
    function down(e) { if (!ref.current?.contains(e.target)) onClose(); }
    function key(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);
  const left = Math.min(anchorRect.left, window.innerWidth - 248);
  const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 280);
  const shown = (groups || []).filter((group) =>
    !query.trim() || group.name.toLowerCase().includes(query.trim().toLowerCase()));
  return createPortal(
    <div ref={ref} className="fixed z-[12000] w-[240px] rounded-lg border border-border/60 bg-chrome p-2 shadow-overlay" style={{ left, top }}>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("people.pickerPlaceholder")}
        className="mb-1.5 w-full rounded border border-border/60 bg-app px-2 py-1 text-[11px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
      />
      <div className="popover-scroll max-h-[220px] overflow-y-auto">
        {groups === null ? (
          <div className="px-2 py-2 text-[11px] text-muted2">…</div>
        ) : shown.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-muted2">{t("people.pickerEmpty")}</div>
        ) : shown.map((group) => (
          <button
            key={group.group_id}
            type="button"
            onClick={() => { onClose(); onPick(group); }}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-hover"
          >
            <FaceCrop
              src={localFileUrl(group.cover_preview_path || group.cover_image_path)}
              bbox={group.cover_bbox}
              size={24}
              className="shrink-0 rounded-full"
            />
            <span className="min-w-0 flex-1 truncate text-[12px] text-text">{group.name}</span>
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted2">
              <ScanFace className="h-3 w-3" />
              {Number(group.face_count) || 0}
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
