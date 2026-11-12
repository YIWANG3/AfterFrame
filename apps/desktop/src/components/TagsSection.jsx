// Inspector block for a photo's tags: one list, hand-added and AI alike
// (annotation/tagStore.js), shown by group with the ungrouped last. A chip
// filters the gallery by its tag; its menu moves, pins, renames the tag
// for the whole library or takes it off this photo. The adder shows the
// library's tags by group and filters them as the user types.

import api from "../api";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Pin, PinOff, Plus, X } from "lucide-react";
import { Section } from "./AnnotationsSection";
import { cx, Z } from "../ui";
import { CARD_FRAME } from "../ui/surfaces";
import useDismiss from "../ui/useDismiss";
import { groupLabel, invalidateTagGroups, invalidateTags, setCachedTags, tagLabel, useAssetTags, useTagGroups, useTagIndex } from "./annotation/tagStore";
import { bucketByGroup } from "./tags/tagGroups";
import { tagMatches } from "./tagsPage";

const AUTO = "";
const TAG_CHIP = "inline-flex items-center rounded-md border border-transparent px-2 py-[2px] text-[10px] transition-colors";
const AVAILABLE_TAG = "bg-app text-muted hover:border-border hover:text-text";
const TAG_PIN = "ml-0.5 h-2.5 w-2.5 shrink-0";
// Explicit opacity keeps this surface outside the glass rule for .shadow-overlay.bg-panel.
const TAG_PICKER_SURFACE = cx(CARD_FRAME, "border-border bg-panel/100 shadow-overlay");

function TagPicker({ id, panelRef, index, groups, existing, query, pending, labelOf, groupLabelOf, onToggle }) {
  const { t } = useTranslation("annotation");
  const sections = useMemo(() => {
    const matches = [];
    for (const [tag, info] of index || []) {
      const entry = { tag, ...info };
      if (tagMatches(entry, query, labelOf)) matches.push(entry);
    }
    return bucketByGroup(matches, groups, (entry) => entry.group_id);
  }, [index, groups, query, labelOf]);
  const selected = new Set(existing);

  return (
    <div
      ref={panelRef}
      id={id}
      role="region"
      aria-label={t("batch.existing")}
      data-testid="tag-picker"
      className={cx(TAG_PICKER_SURFACE, "absolute inset-x-0 bottom-full mb-1 space-y-2 overflow-y-auto overscroll-contain [overflow-anchor:none]")}
      style={{ zIndex: Z.dropdown }}
    >
      {sections.length ? sections.map(({ group, items }) => (
        <section key={group?.group_id ?? "ungrouped"}>
          <h3 className="mb-1 text-[9px] font-semibold uppercase tracking-[0.1em] text-muted2">
            {group ? groupLabelOf(group) : t("chip.ungrouped")}
          </h3>
          <div className="flex flex-wrap gap-1">
            {items.map(({ tag, pinned }) => {
              const isSelected = selected.has(tag);
              const label = labelOf(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  disabled={pending}
                  aria-pressed={isSelected}
                  data-tag-suggestion={tag}
                  title={label}
                  onClick={() => onToggle(tag, isSelected)}
                  className={cx(TAG_CHIP, "max-w-full", isSelected ? "bg-accent/15 text-accent" : AVAILABLE_TAG)}
                >
                  <span className="truncate">{label}</span>
                  {pinned && <Pin className={cx(TAG_PIN, !isSelected && "text-muted2")} />}
                </button>
              );
            })}
          </div>
        </section>
      )) : (
        <p role="status" className="px-1 py-0.5 text-[10px] text-muted2">
          {!index ? t("tagPicker.loading") : query ? t("tagPicker.noMatches") : t("noTags")}
        </p>
      )}
    </div>
  );
}

function TagAdder({ onAdd, onRemove, existing, empty, groups, index, labelOf, groupLabelOf }) {
  const { t } = useTranslation("annotation");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState(AUTO);
  const [pending, setPending] = useState(false);
  const anchorRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const addButtonRef = useRef(null);
  const restoreAddFocus = useRef(false);
  const pickerId = useId();

  function close(event) {
    if (event?.isComposing) return;
    restoreAddFocus.current = event?.type === "keydown" || event?.type === "click";
    setQ("");
    setOpen(false);
  }

  useDismiss(anchorRef, close, { enabled: open });

  useLayoutEffect(() => {
    if (!open) {
      if (restoreAddFocus.current) {
        restoreAddFocus.current = false;
        addButtonRef.current.focus({ preventScroll: true });
      }
      return undefined;
    }
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    const scroller = anchor.closest(".overflow-y-auto");

    function place() {
      const bounds = anchor.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      const room = bounds.top - viewport.top - 12;
      panel.style.visibility = room > 0 && bounds.top < viewport.bottom ? "visible" : "hidden";
      panel.style.maxHeight = `${Math.max(0, Math.min(320, room))}px`;
    }

    inputRef.current.focus({ preventScroll: true });
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor.parentElement);
    observer.observe(scroller);
    scroller.addEventListener("scroll", place, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", place);
    };
  }, [open]);

  async function updateTag(run) {
    setPending(true);
    try {
      await run();
    } finally {
      setPending(false);
    }
  }

  return (
    <div ref={anchorRef} className="relative min-w-0">
      {/* Keep the original row in flow so opening the picker reserves the same space. */}
      <div className={cx("flex flex-wrap items-center gap-1", open && "invisible")}>
        {empty && <span className="mr-1 text-[10px] text-muted2">{t("noTags")}</span>}
        <button
          ref={addButtonRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls={open ? pickerId : undefined}
          data-testid="tag-add"
          className="inline-flex items-center gap-0.5 rounded border border-dashed border-border/60 px-2 py-[2px] text-[10px] text-muted2 transition-colors hover:border-border hover:text-text"
        >
          <Plus className="h-2.5 w-2.5" /> {t("add")}
        </button>
      </div>
      {open && (
        <div className="absolute inset-0 flex items-center gap-1">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); panelRef.current.scrollTop = 0; }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.key !== "Enter" || pending) return;
              if (q.trim()) void updateTag(() => onAdd(q.trim(), group || undefined));
              close(e);
            }}
            aria-label={t("addTag")}
            aria-controls={pickerId}
            placeholder={t("addTag")}
            data-testid="tag-add-input"
            className="h-full min-w-0 flex-1 rounded-md border border-accent/50 bg-app px-2 text-[10px] leading-none text-text outline-none placeholder:text-muted2"
          />
          {/* The group picker applies to typed tags. */}
          <select
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            aria-label={t("chip.moveTo")}
            data-testid="tag-add-group"
            className="h-full max-w-[88px] rounded-md border border-border/60 bg-app px-1 text-[10px] leading-none text-muted outline-none"
          >
            <option value={AUTO}>{t("group.auto")}</option>
            {groups.map((g) => <option key={g.group_id} value={g.group_id}>{groupLabelOf(g)}</option>)}
          </select>
          <button
            type="button"
            onClick={close}
            aria-controls={pickerId}
            aria-label={t("tagPicker.close")}
            title={t("tagPicker.close")}
            className="inline-flex h-full w-[22px] shrink-0 items-center justify-center rounded-md text-muted2 hover:bg-hover hover:text-text"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {open && (
        <TagPicker
          id={pickerId}
          panelRef={panelRef}
          index={index}
          groups={groups}
          existing={existing}
          query={q.trim().replace(/\s+/g, " ")}
          pending={pending}
          labelOf={labelOf}
          groupLabelOf={groupLabelOf}
          onToggle={(tag, isSelected) => {
            inputRef.current.focus({ preventScroll: true });
            void updateTag(() => isSelected ? onRemove(tag) : onAdd(tag));
          }}
        />
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
  const language = i18n.language;
  const labelOf = useCallback((tag) => tagLabel(tag, language), [language]);
  const groupLabelOf = (group) => groupLabel(group, tNav);

  const fail = useCallback((key, e) => {
    pushToast?.({ title: t(key), message: e?.message || t("toast.failedFallback"), ttl: 4000, tone: "error" });
  }, [pushToast, t]);

  const addTag = useCallback(async (tag, group) => {
    if (!assetId || !tag) return;
    try {
      const updated = await api.addAssetTag(assetId, tag, group);
      // Attaching a known tag keeps its metadata and the open picker's scroll position.
      setCachedTags(assetId, updated?.tags || [], { invalidateIndex: Boolean(group) || !index?.has(tag) });
    } catch (e) {
      fail("toast.addTagFailed", e);
    }
  }, [assetId, fail, index]);

  const removeTag = useCallback(async (tag) => {
    if (!assetId || !tag) return;
    try {
      const updated = await api.removeAssetTag(assetId, tag);
      setCachedTags(assetId, updated?.tags || [], { invalidateIndex: false });
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

  const buckets = bucketByGroup(tags, groups, (tag) => index?.get(tag)?.group_id);

  const chip = (tag) => (
    <span
      key={tag}
      data-tag={tag}
      className={cx(TAG_CHIP, AVAILABLE_TAG, "group/tag")}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ tag, x: e.clientX, y: e.clientY }); }}
    >
      <button type="button" onClick={() => onTagClick?.(tag)} title={t("filterBy", { tag: labelOf(tag) })} className="hover:text-text">
        {labelOf(tag)}
      </button>
      {index?.get(tag)?.pinned && <Pin className={cx(TAG_PIN, "text-muted2")} />}
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
        <TagAdder
          key={assetId}
          onAdd={addTag}
          onRemove={removeTag}
          existing={tags}
          empty={known && !tags.length}
          groups={groups}
          index={index}
          labelOf={labelOf}
          groupLabelOf={groupLabelOf}
        />
      </div>
      {menu && (
        <ChipMenu
          at={menu}
          tag={menu.tag}
          info={index?.get(menu.tag)}
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
