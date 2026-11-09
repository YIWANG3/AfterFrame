// Tags as entities for the browser catalog: the sidecar's db/tags.py in
// memory. Groups (the 13 built-ins, then the user's), one record per distinct
// tag (group, pin), aliases that resolve to a tag, and the built-in
// vocabulary shared with the sidecar (@sidecar-data/tag_vocabulary.json).
// Every tag written to a photo goes through resolveTag, as in the sidecar.

import VOCABULARY from "@sidecar-data/tag_vocabulary.json";
import { assets, collections, emitCatalogChanged, normalizeTag } from "./state";

// (group_id, English name, ai_fill) — db/tags.py BUILTIN_GROUPS, in order.
export const BUILTIN_GROUPS = [
  ["weather", "Weather", 1], ["season", "Season", 1], ["time", "Time of day", 1], ["light", "Light", 1],
  ["subject", "Subject", 1], ["place", "Place type", 1], ["event", "Occasion", 1], ["gear", "Gear", 1],
  ["technique", "Technique", 1], ["style", "Style", 1], ["color", "Color", 1], ["mood", "Mood", 1],
  ["workflow", "Workflow", 0],
];

export const groups = BUILTIN_GROUPS.map(([group_id, name, ai_fill], index) => ({ group_id, name, kind: "builtin", sort_order: index, ai_fill }));
export const tagMeta = new Map(); // tag → { group_id, pinned, aliases: Set }
const aliases = new Map(); // normalized spelling → tag

const conceptBySpelling = new Map();
for (const concept of VOCABULARY.concepts || []) {
  conceptBySpelling.set(normalizeTag(concept.en), concept);
  conceptBySpelling.set(normalizeTag(concept.zh), concept);
}
const conceptFor = (tag) => conceptBySpelling.get(normalizeTag(tag)) || null;
const groupExists = (id) => !!id && groups.some((g) => g.group_id === id);
const tagCounts = () => {
  const counts = new Map();
  for (const asset of assets) for (const tag of asset.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  return counts;
};
const byNorm = () => new Map([...tagMeta.keys()].map((tag) => [normalizeTag(tag), tag]));

// The library's spelling for a raw tag: alias, then the library's own case,
// then the vocabulary's other language; `isNew` when none of those.
export function resolveTag(raw) {
  const norm = normalizeTag(raw);
  if (!norm) return null;
  const known = byNorm();
  if (aliases.has(norm) && tagMeta.has(aliases.get(norm))) return { tag: aliases.get(norm), isNew: false };
  if (known.has(norm)) return { tag: known.get(norm), isNew: false };
  const concept = conceptFor(norm);
  if (concept) {
    for (const spelling of [concept.en, concept.zh]) {
      if (known.has(normalizeTag(spelling))) return { tag: known.get(normalizeTag(spelling)), isNew: false, concept };
    }
    return { tag: norm === normalizeTag(concept.en) ? concept.en : concept.zh, isNew: true, concept, groupId: groupExists(concept.group) ? concept.group : null };
  }
  return { tag: String(raw).trim(), isNew: true, concept: null, groupId: null };
}

// The record for a resolved tag, made if new; `groupId` only places a new
// non-vocabulary tag (or a known tag that has no group yet).
export function ensureTag(resolved, groupId = null, { fillable = null } = {}) {
  const suggested = groupExists(groupId) && (!fillable || fillable.has(groupId)) ? groupId : null;
  if (!tagMeta.has(resolved.tag)) {
    let group = resolved.concept ? resolved.groupId : suggested;
    if (fillable && group && !fillable.has(group)) group = null;
    tagMeta.set(resolved.tag, { group_id: group || null, pinned: false, aliases: new Set() });
  } else if (suggested && !tagMeta.get(resolved.tag).group_id) {
    tagMeta.get(resolved.tag).group_id = suggested;
  }
  if (resolved.concept) {
    for (const spelling of [resolved.concept.en, resolved.concept.zh]) {
      if (normalizeTag(spelling) !== normalizeTag(resolved.tag)) {
        aliases.set(normalizeTag(spelling), resolved.tag);
        tagMeta.get(resolved.tag).aliases.add(normalizeTag(spelling));
      }
    }
  }
  return tagMeta.get(resolved.tag);
}

// A record for every tag a photo carries (after an import, say).
export function ensureTagRows() {
  for (const asset of assets) for (const tag of asset.tags || []) if (!tagMeta.has(tag)) ensureTag({ tag, isNew: true, concept: conceptFor(tag), groupId: conceptFor(tag) ? conceptFor(tag).group : null });
}

export const tagEntry = (tag) => tagMeta.get(tag) || null;
export const aliasesOf = (tag) => [...(tagMeta.get(tag)?.aliases || [])];

function entryFor(tag, counts) {
  const meta = tagMeta.get(tag) || { pinned: false, aliases: new Set() };
  return { tag, count: counts.get(tag) || 0, pinned: !!meta.pinned, aliases: [...meta.aliases] };
}
const order = (a, b) => (b.pinned - a.pinned) || (b.count - a.count) || a.tag.localeCompare(b.tag);

export function listTagsGrouped({ limit, query, group } = {}) {
  ensureTagRows();
  const counts = tagCounts();
  const q = normalizeTag(query || "");
  const matches = (tag) => !q || tag.toLowerCase().includes(q) || aliasesOf(tag).some((a) => a.includes(q));
  const bucket = (id) => [...tagMeta.entries()].filter(([tag, meta]) => (meta.group_id || null) === id && matches(tag)).map(([tag]) => entryFor(tag, counts)).sort(order).slice(0, limit || undefined);
  const listedGroups = groups.filter((g) => !group || group === g.group_id).map((g) => ({ ...g, tag_count: [...tagMeta.values()].filter((m) => m.group_id === g.group_id).length, tags: bucket(g.group_id) }));
  const ungrouped = !group || group === "ungrouped" ? bucket(null) : [];
  return { count: listedGroups.reduce((n, g) => n + g.tags.length, 0) + ungrouped.length, groups: listedGroups, ungrouped };
}

// What the prompt lists: each group the model may fill with the library's
// tags in it, then the ungrouped under "other".
export function reuseHints() {
  const listed = listTagsGrouped({ limit: 40 });
  return [
    ...listed.groups.filter((g) => g.ai_fill).map((g) => ({ id: g.group_id, name: g.name, examples: g.tags.filter((t) => t.count > 0).slice(0, 25).map((t) => t.tag) })),
    { id: "other", name: "Other", examples: listed.ungrouped.filter((t) => t.count > 0).map((t) => t.tag) },
  ];
}

// ── smart collections that name a tag or a group ──
function rewriteFilters(filters, key, mapping) {
  if (!filters || typeof filters !== "object") return filters;
  const out = { ...filters };
  if (key in out) {
    const values = Array.isArray(out[key]) ? out[key] : [out[key]];
    const kept = [];
    for (const value of values) {
      const next = typeof value === "string" && value in mapping ? mapping[value] : value;
      if (next != null && !kept.includes(next)) kept.push(next);
    }
    if (!kept.length) delete out[key]; else out[key] = kept.length === 1 ? kept[0] : kept;
    if (key === "tag" && kept.length < 2) delete out.tag_match;
  }
  if (Array.isArray(out.any_of)) out.any_of = out.any_of.map((g) => rewriteFilters(g, key, mapping));
  return out;
}
function rewriteRules(key, mapping) {
  for (const collection of collections) {
    if (collection.kind !== "smart" || !collection.rules) continue;
    const walk = (rules) => (rules ? { ...rules, filters: rewriteFilters(rules.filters || {}, key, mapping), base: walk(rules.base) } : rules);
    collection.rules = walk(collection.rules);
  }
}

// ── the edits ──
function retire(source, target) {
  const meta = tagMeta.get(source);
  for (const alias of meta?.aliases || []) { aliases.set(alias, target); tagMeta.get(target).aliases.add(alias); }
  tagMeta.delete(source);
  aliases.set(normalizeTag(source), target);
  tagMeta.get(target).aliases.add(normalizeTag(source));
  aliases.delete(normalizeTag(target));
  tagMeta.get(target).aliases.delete(normalizeTag(target));
}

export function mergeTags(sources, into) {
  const target = resolveTag(into);
  if (!target) throw new Error("A target tag is required");
  const sourceTags = [...new Set((sources || []).map((raw) => resolveTag(raw)).filter((r) => r && !r.isNew && r.tag !== target.tag).map((r) => r.tag))];
  if (!sourceTags.length) return { target: target.tag, merged: [], photos: 0 };
  if (target.isNew) {
    const first = tagMeta.get(sourceTags[0]);
    ensureTag(target, target.concept ? null : first?.group_id);
    if (first?.pinned) tagMeta.get(target.tag).pinned = true;
  }
  let photos = 0;
  for (const source of sourceTags) {
    const meta = tagMeta.get(source);
    for (const asset of assets) {
      if (!(asset.tags || []).includes(source)) continue;
      photos += 1;
      asset.tags = asset.tags.includes(target.tag) ? asset.tags.filter((t) => t !== source) : asset.tags.map((t) => (t === source ? target.tag : t));
      asset.aiTags = (asset.aiTags || []).filter((t) => t !== source);
      if (asset.annotation) asset.annotation = { ...asset.annotation, tags: asset.tags };
    }
    if (meta?.group_id && !tagMeta.get(target.tag).group_id) tagMeta.get(target.tag).group_id = meta.group_id;
    if (meta?.pinned) tagMeta.get(target.tag).pinned = true;
    retire(source, target.tag);
  }
  rewriteRules("tag", Object.fromEntries(sourceTags.map((s) => [s, target.tag])));
  emitCatalogChanged("tags");
  return { target: target.tag, merged: sourceTags, photos };
}

export function renameTag(tag, to) {
  const current = resolveTag(tag);
  if (!current || current.isNew) throw new Error(`Unknown tag: ${tag}`);
  const name = String(to || "").trim();
  if (!name) throw new Error("A tag needs a name");
  const existing = resolveTag(name);
  if (existing && !existing.isNew && existing.tag !== current.tag) return { ...mergeTags([current.tag], existing.tag), tag: existing.tag, from: current.tag, merged: true };
  if (name === current.tag) return { tag: name, from: name, merged: false };
  const meta = tagMeta.get(current.tag);
  tagMeta.delete(current.tag);
  tagMeta.set(name, meta);
  for (const alias of meta.aliases) aliases.set(alias, name);
  if (normalizeTag(name) !== normalizeTag(current.tag)) { aliases.set(normalizeTag(current.tag), name); meta.aliases.add(normalizeTag(current.tag)); }
  aliases.delete(normalizeTag(name)); meta.aliases.delete(normalizeTag(name));
  for (const asset of assets) {
    if (!(asset.tags || []).includes(current.tag)) continue;
    asset.tags = asset.tags.map((t) => (t === current.tag ? name : t));
    asset.aiTags = (asset.aiTags || []).map((t) => (t === current.tag ? name : t));
    if (asset.annotation) asset.annotation = { ...asset.annotation, tags: asset.tags };
  }
  rewriteRules("tag", { [current.tag]: name });
  emitCatalogChanged("tags");
  return { tag: name, from: current.tag, merged: false };
}

export function deleteTag(tag) {
  const resolved = resolveTag(tag);
  if (!resolved || resolved.isNew) throw new Error(`Unknown tag: ${tag}`);
  let photos = 0;
  for (const asset of assets) {
    if (!(asset.tags || []).includes(resolved.tag)) continue;
    photos += 1;
    asset.tags = asset.tags.filter((t) => t !== resolved.tag);
    asset.aiTags = (asset.aiTags || []).filter((t) => t !== resolved.tag);
    if (asset.annotation) asset.annotation = { ...asset.annotation, tags: asset.tags };
  }
  for (const alias of tagMeta.get(resolved.tag)?.aliases || []) aliases.delete(alias);
  tagMeta.delete(resolved.tag);
  rewriteRules("tag", { [resolved.tag]: null });
  emitCatalogChanged("tags");
  return { tag: resolved.tag, photos };
}

export function setTagGroup(tags, groupId) {
  if (groupId && !groupExists(groupId)) throw new Error(`Unknown tag group: ${groupId}`);
  const moved = [];
  for (const raw of tags || []) {
    const resolved = resolveTag(raw);
    if (!resolved) continue;
    ensureTag(resolved);
    tagMeta.get(resolved.tag).group_id = groupId || null;
    moved.push(resolved.tag);
  }
  emitCatalogChanged("tags");
  return { tags: moved, group_id: groupId || null };
}

export function pinTag(tag, pinned) {
  const resolved = resolveTag(tag);
  if (!resolved) throw new Error("A tag is required");
  ensureTag(resolved);
  tagMeta.get(resolved.tag).pinned = !!pinned;
  emitCatalogChanged("tags");
  return { tag: resolved.tag, pinned: !!pinned };
}

export function regroupByVocabulary() {
  let regrouped = 0;
  for (const [tag, meta] of tagMeta) {
    const concept = conceptFor(tag);
    if (!concept) continue;
    for (const spelling of [concept.en, concept.zh]) if (normalizeTag(spelling) !== normalizeTag(tag)) { aliases.set(normalizeTag(spelling), tag); meta.aliases.add(normalizeTag(spelling)); }
    if (!meta.group_id && groupExists(concept.group)) { meta.group_id = concept.group; regrouped += 1; }
  }
  emitCatalogChanged("tags");
  return { regrouped };
}

let nextGroup = 1;
export function manageTagGroups({ action, group, name, aiFill } = {}) {
  if (action === "create") {
    const label = String(name || "").trim();
    if (!label) throw new Error("A tag group needs a name");
    const created = { group_id: `grp_web${nextGroup++}`, name: label, kind: "custom", sort_order: groups.length, ai_fill: aiFill === false ? 0 : 1 };
    groups.push(created);
    emitCatalogChanged("tags");
    return { ...created, tag_count: 0 };
  }
  const found = groups.find((g) => g.group_id === group);
  if (!found) throw new Error(`Unknown tag group: ${group}`);
  if (action === "rename") {
    const label = String(name || "").trim();
    if (!label) throw new Error("A tag group needs a name");
    found.name = label;
  } else if (action === "ai-fill") {
    found.ai_fill = aiFill ? 1 : 0;
  } else if (action === "delete") {
    let ungrouped = 0;
    for (const meta of tagMeta.values()) if (meta.group_id === found.group_id) { meta.group_id = null; ungrouped += 1; }
    groups.splice(groups.indexOf(found), 1);
    rewriteRules("tag_group", { [found.group_id]: null });
    emitCatalogChanged("tags");
    return { group_id: found.group_id, ungrouped };
  }
  emitCatalogChanged("tags");
  return { ...found, tag_count: [...tagMeta.values()].filter((m) => m.group_id === found.group_id).length };
}

export const tagMethods = {
  listTags: async (options) => listTagsGrouped(options || {}),
  listTagGroups: async () => groups.map((g) => ({ ...g, tag_count: [...tagMeta.values()].filter((m) => m.group_id === g.group_id).length })),
  manageTagGroups: async (options) => manageTagGroups(options || {}),
  setTagGroup: async (tags, group) => setTagGroup(tags, group || null),
  renameTag: async (tag, to) => renameTag(tag, to),
  mergeTags: async (tags, into) => mergeTags(tags, into),
  deleteTag: async (tag) => deleteTag(tag),
  pinTag: async (tag, pinned) => pinTag(tag, pinned),
  regroupTags: async () => regroupByVocabulary(),
  listSelectionTags: async (assetIds) => {
    const wanted = new Set(assetIds || []);
    const counts = new Map();
    for (const asset of assets) if (wanted.has(asset.asset_id)) for (const tag of asset.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count, group_id: tagMeta.get(tag)?.group_id || null }));
  },
};
