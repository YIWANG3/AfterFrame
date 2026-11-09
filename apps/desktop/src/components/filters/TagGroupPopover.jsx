// The Tags facet: the library's tags by group, each group's most-used first
// (pinned on top) with "N more" for the rest, a search across every group,
// and a tick on a group's header for "any tag of this group" (`tag_group`).
// Several tags: any of them (default) / by group ((sunny OR cloudy) AND
// street) / all of them / none of them.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Pin } from "lucide-react";
import Popover, { MatchModes } from "./Popover";
import { toList, fromList, sameOption } from "./filterValues";
import { TextInput } from "../../ui";
import { groupLabel, tagLabel } from "../annotation/tagStore";
import { bucketByGroup, tagChipSummary } from "../tags/tagGroups";

// How many of a group's tags show before "N more".
const SHOWN_PER_GROUP = 8;

function OptionRow({ on, label, count, pinned, muted, onClick, testValue }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      className={[
        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[11px] hover:bg-hover",
        on ? "text-text" : "text-muted",
      ].join(" ")}
      onClick={onClick}
      data-facet-option={testValue}
      data-facet-count={count}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={["flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border", on ? "border-accent/70 bg-accent/15" : "border-border"].join(" ")}>
          {on && <Check className="h-2.5 w-2.5 text-accent" />}
        </span>
        <span className="truncate">{label}</span>
        {pinned && <Pin className="h-2.5 w-2.5 shrink-0 text-muted2" />}
        {muted && <span className="truncate text-[9.5px] text-muted2">{muted}</span>}
      </span>
      {count != null && <span className="shrink-0 text-[10px] tabular-nums text-muted2">{count}</span>}
    </button>
  );
}

export default function TagGroupPopover({
  value, groupValue, options, groups, ungroupedCount = 0,
  onSearch, onSelect, onSelectGroups, modes, mode, onMode, excluded,
}) {
  const { t, i18n } = useTranslation("nav");
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState(null);
  // Groups whose whole list was asked for ("N more"), keyed by group id
  // ("ungrouped" for the ungrouped): the sidecar's answer per group.
  const [expanded, setExpanded] = useState({});
  const picked = toList(value);
  const pickedGroups = toList(groupValue);
  const labelOf = (tag) => tagLabel(tag, i18n.language);
  const groupById = new Map((groups || []).map((group) => [group.group_id, group]));
  const groupLabelOf = (id) => (id ? groupLabel(groupById.get(id), t) || String(id) : t("filter.ungrouped"));

  useEffect(() => {
    const term = q.trim();
    if (!term) { setRemote(null); return undefined; }
    const timer = setTimeout(async () => {
      try { setRemote(await onSearch(term)); } catch { setRemote([]); }
    }, 200);
    return () => clearTimeout(timer);
  }, [q, onSearch]);

  const isPicked = (tag) => picked.some((v) => sameOption(v, tag));
  const toggle = (tag) => onSelect(fromList(isPicked(tag) ? picked.filter((v) => !sameOption(v, tag)) : [...picked, tag]));
  const toggleGroup = (id) => onSelectGroups(fromList(pickedGroups.includes(id) ? pickedGroups.filter((g) => g !== id) : [...pickedGroups, id]));

  async function expandGroup(id) {
    try {
      const rows = await onSearch("", id);
      setExpanded((current) => ({ ...current, [id]: rows || [] }));
    } catch {
      setExpanded((current) => ({ ...current, [id]: [] }));
    }
  }

  // Counts follow the other filters, so a picked tag can drop out of the list;
  // it stays, at 0, as the row to untick.
  const listed = [...(options || [])];
  for (const tag of picked) {
    if (!listed.some((o) => sameOption(o.value, tag))) listed.push({ value: tag, count: 0, group_id: undefined, pinned: false });
  }
  const buckets = bucketByGroup(listed, groups, (option) => option.group_id);
  const activeCount = picked.length + pickedGroups.length;
  const summary = tagChipSummary({ tags: picked, groups: pickedGroups, labelOf, groupLabelOf, t });
  const chipSummary = excluded && summary ? t("filter.excludedTag", { value: summary }) : summary;

  const searching = q.trim().length > 0;

  return (
    <Popover label={t("filter.tag")} active={activeCount > 0} summary={chipSummary} width={260} excluded={excluded && activeCount > 0}>
      <TextInput autoFocus value={q} onChange={setQ} placeholder={t("filter.searchPlaceholder", { label: t("filter.tag") })} className="mb-1.5 w-full" data-testid="tag-facet-search" />
      {onMode && modes?.length > 1 && picked.length > 1 && <MatchModes modes={modes} mode={mode} onMode={onMode} />}
      <div className="popover-scroll -mr-2 max-h-[320px] overflow-y-auto pr-1" data-tag-facet="true">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-muted hover:bg-hover hover:text-text"
          onClick={() => { onSelect(undefined); onSelectGroups(undefined); }}
        >
          <span className="flex h-3 w-3 items-center justify-center">{activeCount === 0 && <Check className="h-3 w-3 text-accent" />}</span>
          {t("filter.any", { label: t("filter.tag") })}
        </button>

        {searching ? (
          (remote || []).map((opt) => (
            <OptionRow
              key={opt.value}
              on={isPicked(opt.value)}
              label={labelOf(opt.value)}
              muted={groupLabelOf(opt.group_id)}
              count={opt.count}
              pinned={opt.pinned}
              onClick={() => toggle(opt.value)}
              testValue={opt.value}
            />
          ))
        ) : (
          buckets.map(({ group, items }) => {
            const id = group?.group_id ?? "ungrouped";
            const info = group ? groupById.get(group.group_id) : null;
            const total = group ? (info?.shown_count ?? items.length) : ungroupedCount || items.length;
            const full = expanded[id];
            const rows = full || items.slice(0, SHOWN_PER_GROUP);
            const more = full ? 0 : total - rows.length;
            const groupOn = group ? pickedGroups.includes(group.group_id) : false;
            return (
              <div key={id} className="mt-1" data-tag-facet-group={id}>
                <div className="flex items-center gap-2 px-2 py-0.5">
                  {group ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={groupOn}
                      title={t("filter.anyInGroup")}
                      data-tag-group-option={group.group_id}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => toggleGroup(group.group_id)}
                    >
                      <span className={["flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border", groupOn ? "border-accent/70 bg-accent/15" : "border-border/70"].join(" ")}>
                        {groupOn && <Check className="h-2.5 w-2.5 text-accent" />}
                      </span>
                      <span className={["truncate text-[10px] font-semibold uppercase tracking-[0.12em]", groupOn ? "text-text" : "text-muted2"].join(" ")}>{groupLabelOf(group.group_id)}</span>
                      {info?.asset_count != null && <span className="shrink-0 text-[9.5px] tabular-nums text-muted2">{info.asset_count}</span>}
                    </button>
                  ) : (
                    <span className="flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{t("filter.ungrouped")}</span>
                  )}
                </div>
                {rows.map((opt) => (
                  <OptionRow
                    key={opt.value}
                    on={isPicked(opt.value)}
                    label={labelOf(opt.value)}
                    count={opt.count}
                    pinned={opt.pinned}
                    onClick={() => toggle(opt.value)}
                    testValue={opt.value}
                  />
                ))}
                {more > 0 && (
                  <button
                    type="button"
                    data-tag-facet-more={id}
                    className="flex w-full items-center gap-1 rounded-md px-2 py-0.5 text-left text-[10px] text-muted2 hover:text-text"
                    onClick={() => void expandGroup(id)}
                  >
                    <ChevronDown className="h-2.5 w-2.5" />
                    {t("filter.tagMore", { count: more })}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </Popover>
  );
}
