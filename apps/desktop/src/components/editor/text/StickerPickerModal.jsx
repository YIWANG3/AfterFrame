// The sticker library, as a picker that covers just the panel and stays open
// while several stickers are added in a row.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import api from "../../../api";
import { localFileUrl as mediaUrlFor } from "../../../utils/format";

export default function StickerPickerModal({ onPick, onClose }) {
  const { t } = useTranslation("editor");
  const [stickers, setStickers] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.stickerList();
        if (!cancelled) setStickers(list || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = !query.trim()
    ? stickers
    : stickers.filter((s) => {
        const q = query.trim().toLowerCase();
        return (s.name || "").toLowerCase().includes(q) ||
               (s.sourceLabel || "").toLowerCase().includes(q);
      });

  // Rendered absolutely inside the TextPanel — so it overlays *just* the panel,
  // doesn't block the canvas/toolbar, and stays open while the user adds
  // multiple stickers in a row (click sticker → layer added → picker stays).
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-chrome">
      <div className="px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("text.pickSticker")}</div>
          <button
            type="button"
            className="rounded-md p-1 text-muted2 transition-colors hover:bg-white/6 hover:text-text"
            onClick={onClose}
            title={t("text.done")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("text.search")}
          autoFocus
          className="mt-3 h-7 w-full rounded-md border border-border/60 bg-app px-2 text-[11px] text-text outline-none placeholder:text-muted3 focus:border-[rgb(var(--accent-color))]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 px-3 py-3">
        {loading ? (
          <div className="grid place-items-center py-12 text-[11px] text-muted">{t("text.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="grid place-items-center py-12 text-center text-[10px] leading-relaxed text-muted2">
            {query ? t("text.noMatches") : t("text.noStickers")}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick(s)}
                className="group flex flex-col text-left"
                title={s.name || s.sourceLabel || s.filename}
              >
                <div className="aspect-square overflow-hidden rounded-md border border-border bg-checker transition-colors group-hover:border-[rgb(var(--accent-color))]">
                  <img
                    src={mediaUrlFor(s.thumbPath || s.path)}
                    alt=""
                    className="h-full w-full object-contain"
                  />
                </div>
                <div className="mt-1 truncate px-0.5 text-[9px] text-muted2">{s.name || s.sourceLabel || "—"}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
