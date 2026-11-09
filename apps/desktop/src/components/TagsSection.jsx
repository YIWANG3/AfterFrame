// Inspector block for a photo's tags: one list, hand-added and AI alike
// (annotation/tagStore.js), shown by group with the ungrouped last. A chip
// filters the gallery by its tag; its menu moves, pins, renames the tag
// for the whole library or takes it off this photo. The adder types to
// search the library's tags (by group), Enter adds a new one into the group
// picked, or "auto": the vocabulary's group, else ungrouped.

import api from "../api";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Pin, PinOff, Plus, X } from "lucide-react";
import { Section } from "./AnnotationsSection";
import { Z } from "../ui";
import useDismiss from "../ui/useDismiss";
import { groupLabel, invalidateTagGroups, invalidateTags, setCachedTags, tagLabel, useAssetTags, useTagGroups, useTagIndex } from "./annotation/tagStore";
import { bucketByGroup } from "./tags/tagGroups";

const AUTO = "";

// Inline tag adder: type to search existing tags (server-side, scales to many)
// or Enter to add a brand-new one, into the group picked.
function TagAdder({ onAdd, existing, groups, pinned, labelOf, groupLabelOf }) {
  const { t } = useTranslation("annotation");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState(AUTO);
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    if (!open) return undefined;
    const have = new Set((existing || []).map((x) => String(x).toLowerCase()));
    if (!q.trim()) {
      // Nothing typed: the pinned tags are the quick picks.
      setSuggestions(pinned.filter((tag) => !have.has(tag.toLowerCase())).map((tag) => ({ value: tag, pinned: true })));
      return undefined;
    }
    const timer = setTimeout(async () => {
      const res = (await api.searchFacet({ field: "tag", q: q.trim(), limit: 8 }).catch(() => [])) || [];
      setSuggestions(res.filter((r) => !have.has(String(r.value).toLowerCase())));
    }, 180);
    return () => clearTimeout(timer);
  }, [q, open, existing, pinned]);

  function commit(tag) {
    const v = (tag ?? q).trim();
    if (v) onAdd(v, group || undefined);
    setQ("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="tag-add"
        className="inline-flex items-center gap-0.5 rounded border border-dashed border-border/60 px-2 py-[2px] text-[10px] text-muted2 transition-colors hover:border-border hover:text-text"
      >
        <Plus className="h-2.5 w-2.5" /> {t("add")}
      </button>
    );
  }
  return (
    // Focus leaving the whole adder (input and group picker) closes it; moving
    // between the two does not.
    <div
      className="relative flex items-center gap-1"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setTimeout(() => setOpen(false), 150); }}
    >
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          // Enter that ends an input method's composition picks the
          // characters; it isn't the tag yet.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") { setQ(""); setOpen(false); }
        }}
        placeholder={t("addTag")}
        data-testid="tag-add-input"
        className="h-[22px] w-28 rounded-md border border-accent/50 bg-app px-2 text-[10px] leading-none text-text outline-none placeholder:text-muted2"
      />
      {/* Where a NEW tag goes; a tag the library has keeps its group. */}
      <select
        value={group}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setGroup(e.target.value)}
        data-testid="tag-add-group"
        className="h-[22px] max-w-[88px] rounded-md border border-border/60 bg-app px-1 text-[10px] leading-none text-muted outline-none"
      >
        <option value={AUTO}>{t("group.auto")}</option>
        {groups.map((g) => <option key={g.group_id} value={g.group_id}>{groupLabelOf(g)}</option>)}
      </select>
      {suggestions.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-44 w-48 overflow-y-auto rounded-md border border-border/60 bg-chrome py-1 shadow-overlay">
          {suggestions.map((s) => (
            <button
              key={s.value}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); commit(s.value); }}
              data-tag-suggestion={s.value}
              className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[10px] text-muted hover:bg-hover hover:text-text"
            >
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate">{labelOf(s.value)}</span>
                {s.pinned && <Pin className="h-2.5 w-2.5 shrink-0 text-muted2" />}
              </span>
              {s.group_id != null && <span className="shrink-0 truncate text-[9px] text-muted2">{groupLabelOf(groups.find((g) => g.group_id === s.group_id))}</span>}
              {s.count != null && <span className="shrink-0 text-[9px] tabular-nums text-muted2">{s.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// A chip's menu: what to do with the tag, on this photo or for the library.
function ChipMenu({ at, tag, info, groups, groupLabelOf, onClose, onFilter, onMove, onPin, onRename, onRemove }) {
  const { t } = useTranslation("annotation");
  const ref = useRef(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(tag);
  const [moving, setMoving] = useState(false);
  useDismiss(ref, onClose, { enabled: true });
  const item = "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1 text-left text-[11px] text-muted hover:bg-hover hover:text-text";
  // Kept on screen: the group list scrolls inside the menu when it is long.
  const maxHeight = Math.min(360, window.innerHeight - 16);
  const left = Math.min(at.x, window.innerWidth - 200);
  const top = Math.max(8, Math.min(at.y, window.innerHeight - maxHeight - 8));
  return createPortal(
    <div ref={ref} data-tag-chip-menu={tag} className="fixed min-w-[168px] overflow-y-auto rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay" style={{ left, top, maxHeight, zIndex: Z.popover }}>
      {renaming ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="tag-rename-input"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") { const v = name.trim(); if (v && v !== tag) onRename(v); onClose(); }
            else if (e.key === "Escape") onClose();
          }}
          className="w-full rounded-md border border-accent/50 bg-app px-2 py-1 text-[11px] text-text outline-none"
        />
      ) : moving ? (
        <>
          {groups.map((g) => (
            <button key={g.group_id} type="button" data-tag-move-to={g.group_id} className={item} onClick={() => { onMove(g.group_id); onClose(); }}>
              <span className="truncate">{groupLabelOf(g)}</span>
              {info?.group_id === g.group_id && <Check className="h-3 w-3 text-accent" />}
            </button>
          ))}
          <button type="button" data-tag-move-to="" className={item} onClick={() => { onMove(null); onClose(); }}>
            <span>{t("chip.ungrouped")}</span>
            {!info?.group_id && <Check className="h-3 w-3 text-accent" />}
          </button>
        </>
      ) : (
        <>
          <button type="button" className={item} onClick={() => { onFilter(); onClose(); }}>{t("chip.filter")}</button>
          <button type="button" data-tag-chip-move="true" className={item} onClick={() => setMoving(true)}>
            <span>{t("chip.moveTo")}</span><ChevronRight className="h-3 w-3 text-muted2" />
          </button>
          <button type="button" data-tag-chip-pin="true" className={item} onClick={() => { onPin(!info?.pinned); onClose(); }}>
            <span>{info?.pinned ? t("chip.unpin") : t("chip.pin")}</span>
            {info?.pinned ? <PinOff className="h-3 w-3 text-muted2" /> : <Pin className="h-3 w-3 text-muted2" />}
          </button>
          <button type="button" data-tag-chip-rename="true" className={item} onClick={() => setRenaming(true)}>{t("chip.rename")}</button>
          <button type="button" data-tag-chip-remove="true" className={`${item} hover:text-red-400`} onClick={() => { onRemove(); onClose(); }}>{t("chip.remove")}</button>
        </>
      )}
    </div>,
    document.body,
  );
}

export default function TagsSection({ assetId, onTagClick, pushToast }) {
  const { t, i18n } = useTranslation("annotation");
  const { t: tNav } = useTranslation("nav");
  const { tags, known } = useAssetTags(assetId);
  const groups = useTagGroups();
  const index = useTagIndex();
  const [menu, setMenu] = useState(null); // { tag, x, y }
  const labelOf = (tag) => tagLabel(tag, i18n.language);
  const groupLabelOf = (group) => groupLabel(group, tNav);
  const pinned = [...index.entries()].filter(([, info]) => info.pinned).map(([tag]) => tag);

  const fail = useCallback((key, e) => {
    pushToast?.({ title: t(key), message: e?.message || t("toast.failedFallback"), ttl: 4000, tone: "error" });
  }, [pushToast, t]);

  const addTag = useCallback(async (tag, group) => {
    if (!assetId || !tag) return;
    try {
      const updated = await api.addAssetTag(assetId, tag, group);
      setCachedTags(assetId, updated?.tags || []);
    } catch (e) {
      fail("toast.addTagFailed", e);
    }
  }, [assetId, fail]);

  const removeTag = useCallback(async (tag) => {
    if (!assetId || !tag) return;
    try {
      const updated = await api.removeAssetTag(assetId, tag);
      setCachedTags(assetId, updated?.tags || []);
    } catch (e) {
      fail("toast.removeTagFailed", e);
    }
  }, [assetId, fail]);

  // Library-level edits: the tag changes on every photo, so every cache goes.
  const libraryEdit = useCallback(async (run) => {
    try {
      await run();
      invalidateTagGroups();
      invalidateTags();
    } catch (e) {
      fail("toast.tagEditFailed", e);
    }
  }, [fail]);

  const buckets = bucketByGroup(tags, groups, (tag) => index.get(tag)?.group_id);

  const chip = (tag) => (
    <span
      key={tag}
      data-tag={tag}
      className="group/tag inline-flex items-center rounded-md border border-transparent bg-app px-2 py-[2px] text-[10px] text-muted transition-colors hover:border-border hover:text-text"
      onContextMenu={(e) => { e.preventDefault(); setMenu({ tag, x: e.clientX, y: e.clientY }); }}
    >
      <button type="button" onClick={() => onTagClick?.(tag)} title={t("filterBy", { tag: labelOf(tag) })} className="hover:text-text">
        {labelOf(tag)}
      </button>
      {index.get(tag)?.pinned && <Pin className="ml-0.5 h-2.5 w-2.5 text-muted2" />}
      <button
        type="button"
        onClick={() => removeTag(tag)}
        title={t("removeTag")}
        className="ml-0.5 hidden rounded p-px text-muted2 transition-colors hover:text-red-400 group-hover/tag:inline-flex"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );

  return (
    <Section title={t("section.tags")} badge={tags.length ? `${tags.length}` : undefined} collapsible>
      <div className="flex flex-col gap-1" data-testid="inspector-tags" data-count={known ? tags.length : undefined}>
        {buckets.map(({ group, items }) => (
          <div key={group?.group_id ?? "ungrouped"} data-tag-group={group?.group_id ?? ""} className="flex flex-wrap items-center gap-1">
            {group && buckets.length > 1 && (
              <span className="mr-0.5 text-[9px] uppercase tracking-[0.1em] text-muted2">{groupLabelOf(group)}</span>
            )}
            {items.map(chip)}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-1">
          {known && !tags.length && <span className="mr-1 text-[10px] text-muted2">{t("noTags")}</span>}
          <TagAdder onAdd={addTag} existing={tags} groups={groups} pinned={pinned} labelOf={labelOf} groupLabelOf={groupLabelOf} />
        </div>
      </div>
      {menu && (
        <ChipMenu
          at={menu}
          tag={menu.tag}
          info={index.get(menu.tag)}
          groups={groups}
          groupLabelOf={groupLabelOf}
          onClose={() => setMenu(null)}
          onFilter={() => onTagClick?.(menu.tag)}
          onMove={(groupId) => libraryEdit(() => api.setTagGroup([menu.tag], groupId))}
          onPin={(pinned_) => libraryEdit(() => api.pinTag(menu.tag, pinned_))}
          onRename={(name) => libraryEdit(() => api.renameTag(menu.tag, name))}
          onRemove={() => removeTag(menu.tag)}
        />
      )}
    </Section>
  );
}
