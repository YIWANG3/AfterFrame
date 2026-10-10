// "Add Tags…" for the selection (gallery menu, T): gather one or more tags —
// typed, or picked from the library's own — then put them all on every
// selected photo in one write. Tags already on a photo stay; nothing is
// removed here.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tag, X } from "lucide-react";
import api from "../api";
import Modal from "../ui/Modal";

export default function TagBatchDialog({ count, onApply, onClose }) {
  const { t } = useTranslation("annotation");
  const [tags, setTags] = useState([]);
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  // The library's tags, most used first, narrowed as the user types.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = (await api.searchFacet({ field: "tag", q: text.trim(), limit: 12 }).catch(() => [])) || [];
      if (cancelled) return;
      const chosen = new Set(tags.map((tag) => tag.toLowerCase()));
      setSuggestions(found.filter((entry) => !chosen.has(String(entry.value).toLowerCase())));
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [text, tags]);

  function addTag(value) {
    const tag = String(value ?? text).trim();
    setText("");
    if (!tag || tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
    setTags((current) => [...current, tag]);
    inputRef.current?.focus();
  }

  async function apply() {
    // A tag still in the box counts: typing one and pressing Add should work.
    const pending = text.trim();
    const all = pending && !tags.some((tag) => tag.toLowerCase() === pending.toLowerCase()) ? [...tags, pending] : tags;
    if (!all.length || busy) return;
    setBusy(true);
    try {
      await onApply(all);
    } finally {
      setBusy(false);
    }
  }

  const canApply = (tags.length > 0 || text.trim().length > 0) && !busy;

  return (
    <Modal onClose={onClose} z="overlayTop" className="max-w-[400px]">
      <div className="p-4" data-testid="tag-batch-dialog">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold text-text">
          <Tag className="h-4 w-4 text-accent" />
          {t("batch.title", { count })}
        </div>
        <div className="mt-1 text-[11.5px] leading-snug text-muted2">{t("batch.hint")}</div>

        <div className="mt-3 flex min-h-[34px] flex-wrap items-center gap-1 rounded-lg border border-border bg-app px-2 py-1 focus-within:border-accent/50">
          {tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-1.5 py-[2px] text-[11px] text-accent" data-batch-tag={tag}>
              {tag}
              <button
                type="button"
                aria-label={t("batch.removeTag", { tag })}
                onClick={() => setTags((current) => current.filter((existing) => existing !== tag))}
                className="text-accent/70 hover:text-accent"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                // Enter on an empty box applies; otherwise it adds the tag typed.
                if (text.trim()) addTag();
                else void apply();
              } else if (event.key === "Backspace" && !text && tags.length) {
                setTags((current) => current.slice(0, -1));
              } else if (event.key === "," || event.key === "，") {
                event.preventDefault();
                addTag();
              }
            }}
            placeholder={tags.length ? "" : t("batch.placeholder")}
            className="min-w-[120px] flex-1 bg-transparent py-0.5 text-[12px] text-text outline-none placeholder:text-muted2"
            data-testid="tag-batch-input"
          />
        </div>

        {suggestions.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{t("batch.existing")}</div>
            <div className="flex max-h-[96px] flex-wrap gap-1 overflow-y-auto">
              {suggestions.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  onClick={() => addTag(entry.value)}
                  className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-[2px] text-[11px] text-muted transition-colors hover:border-border hover:text-text"
                  data-tag-suggestion={entry.value}
                >
                  {entry.value}
                  <span className="text-[9.5px] tabular-nums text-muted2">{entry.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:bg-hover"
          >
            {t("batch.cancel")}
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => void apply()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-app transition-colors hover:bg-accent/90 disabled:cursor-default disabled:opacity-40"
            data-testid="tag-batch-apply"
          >
            {t("batch.apply", { count })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
