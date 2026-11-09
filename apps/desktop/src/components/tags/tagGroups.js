// Pure helpers for showing tags by group: the Inspector's chips, the filter
// bar's popover and the Tags page all bucket the same way. No React here.

// Items bucketed by their group, in the groups' display order; a group with
// nothing in it is left out; the ungrouped come last under `group: null`.
// `groupIdOf(item)` says which group an item belongs to (null for none).
export function bucketByGroup(items, groups, groupIdOf) {
  const byId = new Map();
  for (const item of items || []) {
    const id = groupIdOf(item) || null;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(item);
  }
  const out = [];
  for (const group of groups || []) {
    const bucket = byId.get(group.group_id);
    if (bucket?.length) out.push({ group, items: bucket });
    byId.delete(group.group_id);
  }
  // A group the list does not know (deleted a moment ago, say) is as good as none.
  const rest = [...byId.entries()].flatMap(([, bucket]) => bucket);
  if (rest.length) out.push({ group: null, items: rest });
  return out;
}

// What the filter chip says for picked tags and groups: the first pick, then
// "+N" for the rest (the bar's pickedMore wording), the groups' "any tag of"
// wording first when only groups are picked.
export function tagChipSummary({ tags = [], groups = [], labelOf, groupLabelOf, t }) {
  const parts = [...groups.map((group) => t("filter.tagGroupPick", { group: groupLabelOf(group) })), ...tags.map(labelOf)];
  if (!parts.length) return undefined;
  if (parts.length === 1) return parts[0];
  return t("filter.pickedMore", { first: parts[0], count: parts.length - 1 });
}

// The match modes the popover offers for the number of tags picked: one tag
// has only include / exclude; several add any / all / by group.
export function tagMatchModes(pickedCount) {
  return pickedCount > 1 ? ["any", "by_group", "all", "exclude"] : ["include", "exclude"];
}

export function tagMatchMode({ excluded, tagMatch, pickedCount }) {
  if (excluded) return "exclude";
  if (pickedCount > 1 && (tagMatch === "all" || tagMatch === "by_group")) return tagMatch;
  return tagMatchModes(pickedCount)[0];
}
