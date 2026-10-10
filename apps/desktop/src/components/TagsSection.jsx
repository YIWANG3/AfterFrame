// Inspector block for a photo's tags: one list, hand-added and AI alike
// (annotation/tagStore.js). Always there — empty until someone tags the
// photo; an annotation run adds its tags to it, never in place of these.

import api from "../api";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Section } from "./AnnotationsSection";
import { setCachedTags, useAssetTags } from "./annotation/tagStore";

// Inline tag adder: type to search existing tags (server-side, scales to many)
// or Enter to add a brand-new one.
function TagAdder({ onAdd, existing }) {
  const { t } = useTranslation("annotation");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(async () => {
      const res = (await api.searchFacet({ field: "tag", q: q.trim(), limit: 8 }).catch(() => [])) || [];
      const have = new Set((existing || []).map((x) => String(x).toLowerCase()));
      setSuggestions(res.filter((r) => !have.has(String(r.value).toLowerCase())));
    }, 180);
    return () => clearTimeout(timer);
  }, [q, open, existing]);

  function commit(tag) {
    const v = (tag ?? q).trim();
    if (v) onAdd(v);
    setQ("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="tag-add"
        className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-border/60 px-2 py-[2px] text-[10px] text-muted2 transition-colors hover:border-border hover:text-text"
      >
        <Plus className="h-2.5 w-2.5" /> {t("add")}
      </button>
    );
  }
  return (
    <div className="relative">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          // Enter that ends an input method's composition picks the
          // characters; it isn't the tag yet.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") { setQ(""); setOpen(false); }
        }}
        placeholder={t("addTag")}
        data-testid="tag-add-input"
        className="w-28 rounded-md border border-accent/50 bg-app px-2 py-[2px] text-[10px] text-text outline-none placeholder:text-muted2"
      />
      {suggestions.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-44 w-44 overflow-y-auto rounded-md border border-border/60 bg-chrome py-1 shadow-overlay">
          {suggestions.map((s) => (
            <button
              key={s.value}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); commit(s.value); }}
              className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[10px] text-muted hover:bg-hover hover:text-text"
            >
              <span className="truncate">{s.value}</span>
              <span className="shrink-0 text-[9px] tabular-nums text-muted2">{s.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TagsSection({ assetId, onTagClick, pushToast }) {
  const { t } = useTranslation("annotation");
  const { tags, known } = useAssetTags(assetId);

  const addTag = useCallback(async (tag) => {
    if (!assetId || !tag) return;
    try {
      const updated = await api.addAssetTag(assetId, tag);
      setCachedTags(assetId, updated?.tags || []);
    } catch (e) {
      pushToast?.({ title: t("toast.addTagFailed"), message: e?.message || t("toast.failedFallback"), ttl: 4000, tone: "error" });
    }
  }, [assetId, pushToast, t]);

  const removeTag = useCallback(async (tag) => {
    if (!assetId || !tag) return;
    try {
      const updated = await api.removeAssetTag(assetId, tag);
      setCachedTags(assetId, updated?.tags || []);
    } catch (e) {
      pushToast?.({ title: t("toast.removeTagFailed"), message: e?.message || t("toast.failedFallback"), ttl: 4000, tone: "error" });
    }
  }, [assetId, pushToast, t]);

  return (
    <Section title={t("section.tags")} badge={tags.length ? `${tags.length}` : undefined} collapsible>
      <div className="flex flex-wrap items-center gap-1" data-testid="inspector-tags" data-count={known ? tags.length : undefined}>
        {tags.map((tag) => (
          <span
            key={tag}
            data-tag={tag}
            className="group/tag inline-flex items-center rounded-md border border-transparent bg-app px-2 py-[2px] text-[10px] text-muted transition-colors hover:border-border hover:text-text"
          >
            <button
              type="button"
              onClick={() => onTagClick?.(tag)}
              title={t("filterBy", { tag })}
              className="hover:text-text"
            >
              {tag}
            </button>
            <button
              type="button"
              onClick={() => removeTag(tag)}
              title={t("removeTag")}
              className="ml-0.5 hidden rounded p-px text-muted2 transition-colors hover:text-red-400 group-hover/tag:inline-flex"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        {known && !tags.length && <span className="mr-1 text-[10px] text-muted2">{t("noTags")}</span>}
        <TagAdder onAdd={addTag} existing={tags} />
      </div>
    </Section>
  );
}
