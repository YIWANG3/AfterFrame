// Each photo's tags — one list, hand-added and AI alike (the sidecar's
// asset_tags). Like the annotation store next to it: seeded from browse
// pages so the Inspector shows a photo's tags at once, fetched on a miss,
// replaced by what an add / remove answers, dropped after anything that
// writes tags out of view (an annotation run, the batch "Add Tags…", an agent).
//
// Beside it, what the library says ABOUT its tags (db/tags.py): the tag
// groups, and an index of every tag's group, pin and aliases, both fetched
// once and dropped whenever a tag is written (a new tag may have made a
// group's first entry) or an agent edits tags.

import { useEffect, useSyncExternalStore } from "react";
import api from "../../api";
import VOCABULARY from "@sidecar-data/tag_vocabulary.json";

const cache = new Map(); // assetId → string[]; absent = not known yet
const inflight = new Map();
const listeners = new Set();
let version = 0;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getVersion = () => version;

function getCachedTags(assetId) {
  return assetId ? cache.get(assetId) : undefined;
}

export function setCachedTags(assetId, tags) {
  if (!assetId) return;
  cache.set(assetId, Array.isArray(tags) ? tags : []);
  // A write may have made a tag the library did not have.
  tagIndex = null;
  notify();
}

// Browse rows carry `tags`; every listed photo becomes known.
export function seedTags(items) {
  if (!Array.isArray(items) || !items.length) return;
  let changed = false;
  for (const item of items) {
    if (!item?.asset_id || !Array.isArray(item.tags)) continue;
    const prev = cache.get(item.asset_id);
    if (!prev || prev.length !== item.tags.length || prev.some((tag, i) => tag !== item.tags[i])) changed = true;
    cache.set(item.asset_id, item.tags);
  }
  if (changed) notify();
}

// Forget some photos' tags (or all): the next look fetches them again. The
// library's tag index goes with them: what was written may be new.
export function invalidateTags(assetIds) {
  tagIndex = null;
  if (!assetIds) {
    cache.clear();
  } else {
    for (const id of assetIds) cache.delete(id);
  }
  notify();
}

function fetchTags(assetId) {
  if (!assetId) return Promise.resolve([]);
  if (!inflight.has(assetId)) {
    inflight.set(assetId, Promise.resolve(api.getAssetTags(assetId))
      .then((res) => {
        const tags = Array.isArray(res?.tags) ? res.tags : [];
        setCachedTags(assetId, tags);
        return tags;
      })
      .finally(() => inflight.delete(assetId)));
  }
  return inflight.get(assetId);
}

export function useAssetTags(assetId) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const cached = getCachedTags(assetId);
  const known = cached !== undefined;
  useEffect(() => {
    if (assetId && !known) void fetchTags(assetId).catch(() => {});
  }, [assetId, known]);
  return { tags: cached || [], known };
}

// ── The library's tag groups and tag index ──────────────────────────────────

let groups = null; // [{group_id, name, kind, sort_order, ai_fill, tag_count}]; null = not known
let groupsInflight = null;
let tagIndex = null; // Map(tag → {group_id, pinned, aliases}); null = not known
let indexInflight = null;

// Groups changed, or tags were edited at the library level (moved, merged,
// renamed, pinned): both lists are fetched again on the next look.
export function invalidateTagGroups() {
  groups = null;
  tagIndex = null;
  notify();
}

function fetchGroups() {
  if (!groupsInflight) {
    groupsInflight = Promise.resolve(api.listTagGroups())
      .then((rows) => { groups = Array.isArray(rows) ? rows : []; notify(); return groups; })
      .catch(() => { groups = []; notify(); return groups; })
      .finally(() => { groupsInflight = null; });
  }
  return groupsInflight;
}

function fetchIndex() {
  if (!indexInflight) {
    indexInflight = Promise.resolve(api.listTags({}))
      .then((listed) => {
        const next = new Map();
        for (const group of listed?.groups || []) {
          for (const entry of group.tags || []) next.set(entry.tag, { group_id: group.group_id, pinned: !!entry.pinned, aliases: entry.aliases || [] });
        }
        for (const entry of listed?.ungrouped || []) next.set(entry.tag, { group_id: null, pinned: !!entry.pinned, aliases: entry.aliases || [] });
        tagIndex = next;
        notify();
        return next;
      })
      .catch(() => { tagIndex = new Map(); notify(); return tagIndex; })
      .finally(() => { indexInflight = null; });
  }
  return indexInflight;
}

// The groups in display order (empty until fetched).
export function useTagGroups() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const known = groups !== null;
  useEffect(() => {
    if (!known) void fetchGroups();
  }, [known]);
  return groups || [];
}

// Every tag's {group_id, pinned, aliases} (an empty Map until fetched).
export function useTagIndex() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const known = tagIndex !== null;
  useEffect(() => {
    if (!known) void fetchIndex();
  }, [known]);
  return tagIndex || EMPTY_INDEX;
}
const EMPTY_INDEX = new Map();

// ── Display names ────────────────────────────────────────────────────────────

const normalizeTag = (tag) => String(tag || "").trim().toLowerCase().replace(/\s+/g, " ");
const conceptBySpelling = new Map();
for (const concept of VOCABULARY.concepts || []) {
  conceptBySpelling.set(normalizeTag(concept.en), concept);
  conceptBySpelling.set(normalizeTag(concept.zh), concept);
}

// A vocabulary concept is shown in the interface language whichever spelling
// the library stores it under (sunset ↔ 日落); any other tag as it is.
export function tagLabel(tag, language) {
  const concept = conceptBySpelling.get(normalizeTag(tag));
  if (!concept) return String(tag ?? "");
  return String(language || "").toLowerCase().startsWith("zh") ? concept.zh : concept.en;
}

// A built-in group's name comes from the interface language; a custom group
// is called what the user called it. `t` is the nav namespace.
export function groupLabel(group, t) {
  if (!group) return "";
  if (group.kind === "builtin") return t(`tagGroups.${group.group_id}`, { defaultValue: group.name });
  return group.name;
}
