import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { GitMerge, ScanFace } from "lucide-react";
import api from "../api";
import { localFileUrl } from "../utils/format";
import FaceCrop from "./FaceCrop";

const PANEL_WIDTH = 248;
const SUGGESTION_LIMIT = 10;

// The one naming interaction for people, shared by the people wall and the
// Inspector. Typing suggests existing named people; choosing one asks to merge
// this group into that person instead of creating a duplicate name — naming
// with an existing name IS the merge gesture (same as Apple Photos).
export default function NamePersonPopover({
  anchorRect,
  group,
  namedGroups = [],
  onRename,
  onMerge,
  onClose,
}) {
  const { t } = useTranslation("nav");
  const [value, setValue] = useState(group?.name || "");
  const [mergeTarget, setMergeTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [similar, setSimilar] = useState(null); // centroid-ranked merge targets
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const [pos, setPos] = useState(null);

  // Before the user types, suggest the people this group most likely IS —
  // ranked by embedding-centroid similarity, not by who has the most faces.
  useEffect(() => {
    let cancelled = false;
    if (!group?.group_id) { setSimilar([]); return undefined; }
    (async () => {
      try {
        const rows = await api.similarPeopleGroups({ groupId: group.group_id, limit: SUGGESTION_LIMIT });
        if (!cancelled) setSimilar(Array.isArray(rows) ? rows : []);
      } catch {
        if (!cancelled) setSimilar([]);
      }
    })();
    return () => { cancelled = true; };
  }, [group?.group_id]);

  useLayoutEffect(() => {
    if (!anchorRect) return;
    let left = anchorRect.left;
    if (left + PANEL_WIDTH > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - PANEL_WIDTH);
    let top = anchorRect.bottom + 6;
    if (top + 220 > window.innerHeight - 8) top = Math.max(8, anchorRect.top - 226);
    setPos({ left, top });
  }, [anchorRect]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    function down(e) {
      if (panelRef.current?.contains(e.target)) return;
      onClose?.();
    }
    function key(e) {
      if (e.key === "Escape") onClose?.();
    }
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const cleaned = value.trim();
  const notSelf = (candidate) => candidate.group_id !== group?.group_id && candidate.name;
  const suggestions = (cleaned
    ? namedGroups.filter((candidate) => notSelf(candidate)
        && candidate.name.toLowerCase().includes(cleaned.toLowerCase()))
    : (similar?.length ? similar : namedGroups).filter(notSelf)
  ).slice(0, SUGGESTION_LIMIT);
  const exactMatch = namedGroups.find(
    (candidate) => candidate.group_id !== group?.group_id
      && candidate.name && candidate.name.toLowerCase() === cleaned.toLowerCase(),
  );

  async function run(action) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      onClose?.();
    } catch {
      // The caller already surfaced the failure (toast); swallowing here keeps
      // the popover open for a retry instead of leaking an unhandled rejection.
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    if (!cleaned) return;
    if (exactMatch) {
      setMergeTarget(exactMatch);
      return;
    }
    void run(() => onRename(cleaned));
  }

  if (!pos) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[12000] rounded-lg border border-border/60 bg-chrome p-2 shadow-overlay"
      style={{ left: pos.left, top: pos.top, width: PANEL_WIDTH }}
    >
      {mergeTarget ? (
        <div>
          <div className="flex items-center gap-2 px-1 py-1">
            <FaceCrop
              src={localFileUrl(mergeTarget.cover_preview_path || mergeTarget.cover_image_path)}
              bbox={mergeTarget.cover_bbox}
              size={30}
              className="shrink-0 rounded-full"
            />
            <div className="min-w-0 text-[12px] leading-tight text-text">
              {t("people.mergePrompt", { name: mergeTarget.name })}
            </div>
          </div>
          <p className="px-1 pb-1.5 text-[11px] leading-4 text-muted2">{t("people.mergeHint")}</p>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => onMerge(mergeTarget))}
              className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent/90 text-[11px] font-medium text-app transition hover:bg-accent disabled:opacity-55"
            >
              <GitMerge className="h-3 w-3" />
              {t("people.mergeConfirm")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMergeTarget(null)}
              className="h-7 flex-1 rounded-md border border-border/65 text-[11px] text-muted transition hover:bg-hover hover:text-text disabled:opacity-55"
            >
              {t("people.mergeBack")}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <input
            ref={inputRef}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder={t("people.namePlaceholder")}
            className="w-full rounded border border-border/60 bg-app px-2 py-1.5 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
          />
          {suggestions.length > 0 && (
            <div className="popover-scroll mt-1.5 max-h-[180px] overflow-y-auto">
              {suggestions.map((candidate) => (
                <button
                  key={candidate.group_id}
                  type="button"
                  disabled={busy}
                  onClick={() => setMergeTarget(candidate)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-hover"
                >
                  <FaceCrop
                    src={localFileUrl(candidate.cover_preview_path || candidate.cover_image_path)}
                    bbox={candidate.cover_bbox}
                    size={24}
                    className="shrink-0 rounded-full"
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-text">{candidate.name}</span>
                  <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted2">
                    <ScanFace className="h-3 w-3" />
                    {Number(candidate.face_count) || 0}
                  </span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={!cleaned || busy}
            onClick={submit}
            className="mt-1.5 h-7 w-full rounded-md bg-accent/90 text-[11px] font-medium text-app transition hover:bg-accent disabled:cursor-default disabled:opacity-40"
          >
            {exactMatch ? t("people.mergeAction", { name: exactMatch.name }) : t("people.nameAction")}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
