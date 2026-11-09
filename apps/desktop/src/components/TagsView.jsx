// The Tags page (docs/tags-redesign.md §5.3): every tag of the library by
// group, with its photo count, aliases and pin; groups are made, renamed,
// switched on or off for AI and deleted here; tags are moved, renamed,
// merged, deleted and pinned, one or many at a time. A tag's name opens the
// gallery filtered by it. Same header shell as the People and Folders pages.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, MoreHorizontal, Pin, Plus, Sparkles, Tags, X } from "lucide-react";
import api from "../api";
import { Button, cx, Z } from "../ui";
import useDismiss from "../ui/useDismiss";
import { groupLabel, invalidateTagGroups, invalidateTags, tagLabel } from "./annotation/tagStore";
import InlineEdit from "./InlineEdit";
import LibraryToolbar from "./LibraryToolbar";
import { confirm } from "./confirm";
import { DEFAULT_TAG_PAGE_SORT, TAG_PAGE_SORTS, allTags, otherSpellings, tagSections } from "./tagsPage";

const SORT_KEY = "tags.sort";
const readSort = () => { try { const v = localStorage.getItem(SORT_KEY); return TAG_PAGE_SORTS.includes(v) ? v : DEFAULT_TAG_PAGE_SORT; } catch { return DEFAULT_TAG_PAGE_SORT; } };

// A small anchored menu, dismissed by a click elsewhere or Esc.
function Menu({ anchor, onClose, children, testId }) {
  const ref = useRef(null);
  useDismiss(ref, onClose, { enabled: true });
  // Kept on screen: a long list (every group) scrolls inside the menu.
  const maxHeight = Math.min(400, window.innerHeight - 16);
  const left = Math.min(anchor.x, window.innerWidth - 220);
  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - maxHeight - 8));
  return createPortal(
    <div ref={ref} data-testid={testId} className="fixed min-w-[180px] overflow-y-auto rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay" style={{ left, top, maxHeight, zIndex: Z.popover }}>
      {children}
    </div>,
    document.body,
  );
}
const ITEM = "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-text";

function SortDropdown({ sort, setSort }) {
  const { t } = useTranslation("nav");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(ref, () => setOpen(false), { enabled: open });
  return (
    <div ref={ref} className="relative ml-1 shrink-0">
      <button
        type="button"
        data-testid="tags-sort"
        className="flex h-8 w-[110px] cursor-pointer items-center justify-center gap-1 rounded-md border border-border/70 bg-app px-2 text-[12px] text-text outline-none transition-colors hover:border-border"
        onClick={() => setOpen((c) => !c)}
      >
        <span className="truncate">{t(`tags.sort.${sort}`)}</span>
        <ChevronDown className="h-3 w-3 text-muted2" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 min-w-[150px] rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay" style={{ zIndex: Z.dropdown }}>
          {TAG_PAGE_SORTS.map((value) => (
            <button key={value} type="button" className={cx(ITEM, sort === value && "text-text")} onClick={() => { setSort(value); setOpen(false); }}>
              <span>{t(`tags.sort.${value}`)}</span>
              {sort === value && <Check className="h-3 w-3 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TagsView({ catalogRevision, onOpenTag, pushToast }) {
  const { t, i18n } = useTranslation("nav");
  const [listed, setListed] = useState(null);
  const [query, setQuery] = useState("");
  const [sort, setSortState] = useState(readSort);
  const setSort = (value) => { setSortState(value); try { localStorage.setItem(SORT_KEY, value); } catch { /* private mode */ } };
  const [selected, setSelected] = useState(() => new Set());
  const [renaming, setRenaming] = useState(null); // a tag name
  const [renamingGroup, setRenamingGroup] = useState(null); // a group id
  const [creating, setCreating] = useState(false);
  const [merging, setMerging] = useState(false); // the merge-name box is open
  const [menu, setMenu] = useState(null); // { kind: "tag" | "group" | "move" | "bulkMove", key, x, y }
  const labelOf = useCallback((tag) => tagLabel(tag, i18n.language), [i18n.language]);
  const groups = useMemo(() => listed?.groups || [], [listed]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g.group_id, g])), [groups]);
  const groupLabelOf = (group) => groupLabel(group, t);

  const load = useCallback(async () => {
    try {
      const result = await api.listTags({});
      setListed(result || { groups: [], ungrouped: [] });
    } catch (error) {
      pushToast?.({ title: t("tags.loadFailed"), message: String(error?.message || error), tone: "error", ttl: 6000 });
    }
  }, [pushToast, t]);
  useEffect(() => { void load(); }, [load, catalogRevision]);

  const sections = useMemo(() => tagSections(listed, { query, sort, locale: i18n.language, labelOf }), [listed, query, sort, i18n.language, labelOf]);
  const total = allTags(listed).length;
  const known = new Set(allTags(listed).map((entry) => entry.tag));
  const picked = [...selected].filter((tag) => known.has(tag));

  // Every edit here changes the library: reload the page, drop the caches
  // the Inspector and the filter bar hold, and let the gallery refetch.
  async function edit(run, failKey = "tags.editFailed") {
    try {
      await run();
      invalidateTagGroups();
      invalidateTags();
      await load();
    } catch (error) {
      pushToast?.({ title: t(failKey), message: String(error?.message || error), tone: "error", ttl: 6000 });
    }
  }

  const toggle = (tag) => setSelected((current) => { const next = new Set(current); if (next.has(tag)) next.delete(tag); else next.add(tag); return next; });
  const clearSelection = () => setSelected(new Set());

  async function deleteTags(tags) {
    if (!tags.length) return;
    const photos = tags.reduce((n, tag) => n + (allTags(listed).find((entry) => entry.tag === tag)?.count || 0), 0);
    const approved = await confirm({
      title: tags.length === 1 ? t("tags.deleteConfirmOne", { tag: labelOf(tags[0]) }) : t("tags.deleteConfirmMany", { count: tags.length }),
      message: t("tags.deleteConfirmMessage", { count: photos }),
      confirmLabel: t("tags.delete"),
      cancelLabel: t("tags.cancel"),
      danger: true,
    });
    if (!approved) return;
    await edit(async () => { for (const tag of tags) await api.deleteTag(tag); });
    clearSelection();
  }

  async function deleteGroup(group) {
    const approved = await confirm({
      title: t("tags.deleteGroupConfirm", { name: groupLabelOf(group) }),
      message: t("tags.deleteGroupMessage", { count: group.tag_count ?? group.tags?.length ?? 0 }),
      confirmLabel: t("tags.deleteGroup"),
      cancelLabel: t("tags.cancel"),
      danger: true,
    });
    if (!approved) return;
    await edit(() => api.manageTagGroups({ action: "delete", group: group.group_id }));
  }

  async function mergeInto(target) {
    const name = String(target || "").trim();
    if (!name || !picked.length) return;
    await edit(() => api.mergeTags(picked, name));
    clearSelection();
    setMerging(false);
  }

  const openMenu = (kind, key, event) => { event.preventDefault(); event.stopPropagation(); setMenu({ kind, key, x: event.clientX, y: event.clientY }); };
  const groupChoices = (onPick, currentId) => (
    <>
      {groups.map((group) => (
        <button key={group.group_id} type="button" data-tags-move-to={group.group_id} className={ITEM} onClick={() => onPick(group.group_id)}>
          <span className="truncate">{groupLabelOf(group)}</span>
          {currentId === group.group_id && <Check className="h-3 w-3 text-accent" />}
        </button>
      ))}
      <button type="button" data-tags-move-to="" className={ITEM} onClick={() => onPick(null)}>
        <span>{t("tags.ungrouped")}</span>
        {currentId === null && <Check className="h-3 w-3 text-accent" />}
      </button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="tags-view">
      <LibraryToolbar
        icon={Tags}
        title={t("tags.title")}
        count={total}
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder={t("tags.search")}
        actions={(
          <>
            <Button variant="ghost" size="sm" data-testid="tags-new-group" onClick={() => setCreating(true)} className="shrink-0 gap-1 whitespace-nowrap">
              <Plus className="h-3.5 w-3.5" />
              {t("tags.newGroup")}
            </Button>
            <SortDropdown sort={sort} setSort={setSort} />
          </>
        )}
      />

      {picked.length > 0 && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-chrome/60 px-4 py-1.5 text-[12px]" data-testid="tags-selection-bar">
          <span className="text-text">{t("tags.selected", { count: picked.length })}</span>
          <Button variant="ghost" size="xs" data-testid="tags-bulk-move" onClick={(e) => openMenu("bulkMove", null, e)}>{t("tags.moveTo")}</Button>
          {merging ? (
            <input
              autoFocus
              defaultValue={picked[0]}
              data-testid="tags-merge-input"
              placeholder={t("tags.mergePlaceholder")}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") void mergeInto(e.currentTarget.value);
                else if (e.key === "Escape") setMerging(false);
              }}
              className="h-6 w-40 rounded-md border border-accent/50 bg-app px-2 text-[12px] text-text outline-none"
            />
          ) : (
            <Button variant="ghost" size="xs" data-testid="tags-bulk-merge" disabled={picked.length < 1} onClick={() => setMerging(true)}>{t("tags.mergeInto")}</Button>
          )}
          <Button variant="ghost" size="xs" data-testid="tags-bulk-delete" className="hover:text-red-400" onClick={() => void deleteTags(picked)}>{t("tags.delete")}</Button>
          <button type="button" className="ml-auto rounded p-0.5 text-muted2 hover:text-text" onClick={clearSelection} title={t("tags.clearSelection")}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-2">
        {creating && (
          <div className="mb-3 max-w-[280px]" data-testid="tags-new-group-input">
            <InlineEdit
              initial=""
              placeholder={t("tags.groupNamePlaceholder")}
              onConfirm={(name) => { setCreating(false); void edit(() => api.manageTagGroups({ action: "create", name })); }}
              onCancel={() => setCreating(false)}
            />
          </div>
        )}
        {listed && total === 0 && !creating && (
          <div className="py-10 text-center text-[12.5px] text-muted2">{t("tags.empty")}</div>
        )}
        {sections.map(({ group, items }) => {
          const id = group?.group_id ?? "ungrouped";
          return (
            <section key={id} className="mb-4" data-tags-group={id}>
              <div className="flex h-7 items-center gap-2">
                {group && renamingGroup === group.group_id ? (
                  <div className="w-[220px]">
                    <InlineEdit
                      initial={group.name}
                      onConfirm={(name) => { setRenamingGroup(null); void edit(() => api.manageTagGroups({ action: "rename", group: group.group_id, name })); }}
                      onCancel={() => setRenamingGroup(null)}
                    />
                  </div>
                ) : (
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted2">{group ? groupLabelOf(group) : t("tags.ungrouped")}</h2>
                )}
                <span className="text-[11px] tabular-nums text-muted3">{items.length}</span>
                {group && !group.ai_fill && <span className="rounded border border-border/60 px-1 text-[9.5px] text-muted2" title={t("tags.aiOff")}>{t("tags.aiOffShort")}</span>}
                {group ? (
                  <button type="button" data-tags-group-menu={group.group_id} className="rounded p-0.5 text-muted2 hover:bg-hover hover:text-text" onClick={(e) => openMenu("group", group.group_id, e)}>
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  items.length > 0 && (
                    <Button variant="ghost" size="xs" data-testid="tags-regroup" className="shrink-0 gap-1 whitespace-nowrap" onClick={() => void edit(() => api.regroupTags())}>
                      <Sparkles className="h-3 w-3" />
                      {t("tags.regroup")}
                    </Button>
                  )
                )}
              </div>
              {items.length === 0 && group && <div className="py-1 text-[11.5px] text-muted3">{t("tags.emptyGroup")}</div>}
              <div className="flex flex-col">
                {items.map((entry) => {
                  const on = selected.has(entry.tag);
                  return (
                    <div
                      key={entry.tag}
                      data-tag-row={entry.tag}
                      data-selected={on ? "true" : "false"}
                      className={cx("group/row flex h-7 items-center gap-2 rounded-md px-1.5 text-[12.5px]", on ? "bg-selected" : "hover:bg-hover/60")}
                      onContextMenu={(e) => openMenu("tag", entry.tag, e)}
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        data-tag-select={entry.tag}
                        onClick={() => toggle(entry.tag)}
                        className={cx("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border", on ? "border-accent/70 bg-accent/15" : "border-border")}
                      >
                        {on && <Check className="h-2.5 w-2.5 text-accent" />}
                      </button>
                      {renaming === entry.tag ? (
                        <div className="w-[220px]">
                          <InlineEdit
                            initial={entry.tag}
                            onConfirm={(name) => { setRenaming(null); void edit(() => api.renameTag(entry.tag, name)); }}
                            onCancel={() => setRenaming(null)}
                          />
                        </div>
                      ) : (
                        <button type="button" data-tag-open={entry.tag} className="truncate text-left text-text hover:text-accent" onClick={() => onOpenTag?.(entry.tag)} title={t("tags.openHint")}>
                          {labelOf(entry.tag)}
                        </button>
                      )}
                      {otherSpellings(entry, labelOf(entry.tag)).length > 0 && <span className="truncate text-[11px] text-muted3">{otherSpellings(entry, labelOf(entry.tag)).join(" · ")}</span>}
                      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted2">{t("tags.photos", { count: entry.count })}</span>
                      <button
                        type="button"
                        data-tag-pin={entry.tag}
                        aria-pressed={entry.pinned}
                        title={entry.pinned ? t("tags.unpin") : t("tags.pin")}
                        className={cx("rounded p-0.5", entry.pinned ? "text-accent" : "text-muted3 opacity-0 hover:text-text group-hover/row:opacity-100")}
                        onClick={() => void edit(() => api.pinTag(entry.tag, !entry.pinned))}
                      >
                        <Pin className={cx("h-3 w-3", entry.pinned && "fill-current")} />
                      </button>
                      <button type="button" data-tag-menu={entry.tag} className="rounded p-0.5 text-muted3 opacity-0 hover:text-text group-hover/row:opacity-100" onClick={(e) => openMenu("tag", entry.tag, e)}>
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {menu?.kind === "tag" && (() => {
        const entry = allTags(listed).find((item) => item.tag === menu.key);
        const groupId = groups.find((group) => (group.tags || []).some((item) => item.tag === menu.key))?.group_id ?? null;
        return (
          <Menu anchor={menu} onClose={() => setMenu(null)} testId="tag-row-menu">
            <button type="button" className={ITEM} onClick={() => { setMenu(null); onOpenTag?.(menu.key); }}>{t("tags.open")}</button>
            <button type="button" data-tag-menu-move="true" className={ITEM} onClick={() => setMenu({ ...menu, kind: "move", groupId })}>{t("tags.moveTo")}</button>
            <button type="button" data-tag-menu-rename="true" className={ITEM} onClick={() => { setMenu(null); setRenaming(menu.key); }}>{t("tags.rename")}</button>
            <button type="button" className={ITEM} onClick={() => { setMenu(null); void edit(() => api.pinTag(menu.key, !entry?.pinned)); }}>{entry?.pinned ? t("tags.unpin") : t("tags.pin")}</button>
            <button type="button" data-tag-menu-delete="true" className={cx(ITEM, "hover:text-red-400")} onClick={() => { setMenu(null); void deleteTags([menu.key]); }}>{t("tags.delete")}</button>
          </Menu>
        );
      })()}
      {menu?.kind === "move" && (
        <Menu anchor={menu} onClose={() => setMenu(null)} testId="tag-move-menu">
          {groupChoices((groupId) => { setMenu(null); void edit(() => api.setTagGroup([menu.key], groupId)); }, menu.groupId)}
        </Menu>
      )}
      {menu?.kind === "bulkMove" && (
        <Menu anchor={menu} onClose={() => setMenu(null)} testId="tags-bulk-move-menu">
          {groupChoices((groupId) => { setMenu(null); void edit(() => api.setTagGroup(picked, groupId)).then(clearSelection); }, undefined)}
        </Menu>
      )}
      {menu?.kind === "group" && (() => {
        const group = groupById.get(menu.key);
        if (!group) return null;
        return (
          <Menu anchor={menu} onClose={() => setMenu(null)} testId="tag-group-menu">
            <button type="button" data-group-menu-rename="true" className={ITEM} onClick={() => { setMenu(null); setRenamingGroup(group.group_id); }}>{t("tags.renameGroup")}</button>
            <button type="button" data-group-menu-ai="true" className={ITEM} onClick={() => { setMenu(null); void edit(() => api.manageTagGroups({ action: "ai-fill", group: group.group_id, aiFill: !group.ai_fill })); }}>
              <span>{t("tags.aiFill")}</span>
              {group.ai_fill ? <Check className="h-3 w-3 text-accent" /> : null}
            </button>
            <button type="button" data-group-menu-delete="true" className={cx(ITEM, "hover:text-red-400")} onClick={() => { setMenu(null); void deleteGroup(group); }}>{t("tags.deleteGroup")}</button>
          </Menu>
        );
      })()}
    </div>
  );
}
