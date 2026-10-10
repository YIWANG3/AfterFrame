// Each photo's tags — one list, hand-added and AI alike (the sidecar's
// asset_tags). Like the annotation store next to it: seeded from browse
// pages so the Inspector shows a photo's tags at once, fetched on a miss,
// replaced by what an add / remove answers, dropped after anything that
// writes tags out of view (an annotation run, the batch "Add Tags…", an agent).

import { useEffect, useSyncExternalStore } from "react";
import api from "../../api";

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

export function getCachedTags(assetId) {
  return assetId ? cache.get(assetId) : undefined;
}

export function setCachedTags(assetId, tags) {
  if (!assetId) return;
  cache.set(assetId, Array.isArray(tags) ? tags : []);
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

// Forget some photos' tags (or all): the next look fetches them again.
export function invalidateTags(assetIds) {
  if (!assetIds) {
    if (!cache.size) return;
    cache.clear();
  } else {
    for (const id of assetIds) cache.delete(id);
  }
  notify();
}

export function fetchTags(assetId) {
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
