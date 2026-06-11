// Shared, module-level caches + subscription for annotation state. Both the
// provider config flag (used to enable/disable the "Annotate with AI" button)
// and the per-asset annotation payload live here so:
//   1. flipping a provider on/off in Settings propagates everywhere instantly
//   2. switching between assets that we've already loaded is synchronous —
//      no IPC roundtrip, no Loading placeholder flicker

const subscribers = new Set();
let cachedHasProvider = null; // null = unknown, boolean = known
let providerInflight = null;

const annotationCache = new Map(); // assetId -> annotation | null
const annotationInflight = new Map(); // assetId -> Promise

// Bump on any state change. useSyncExternalStore consumers read this as their
// snapshot, then pull live values via the getters — avoids the cost (and
// referential-equality landmines) of constructing snapshot objects per call.
let version = 0;
function notify() {
  version++;
  subscribers.forEach((fn) => fn());
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getVersion() {
  return version;
}

export function getHasProvider() {
  return cachedHasProvider;
}

// Set the flag directly (no IPC). Used when Settings already knows the answer
// and hands it to us via the change event — avoids racing the settings write.
export function setHasProvider(next) {
  const val = !!next;
  if (val !== cachedHasProvider) {
    cachedHasProvider = val;
    notify();
  }
}

export async function refreshProviders() {
  if (providerInflight) return providerInflight;
  providerInflight = (async () => {
    try {
      const s = (await window.mediaWorkspace?.getAnnotationSettings?.()) || {};
      const next = Array.isArray(s.providers) && s.providers.length > 0;
      if (next !== cachedHasProvider) {
        cachedHasProvider = next;
        notify();
      } else {
        cachedHasProvider = next;
      }
    } catch {
      if (cachedHasProvider !== false) {
        cachedHasProvider = false;
        notify();
      }
    } finally {
      providerInflight = null;
    }
  })();
  return providerInflight;
}

export function getCachedAnnotation(assetId) {
  if (!assetId) return undefined;
  return annotationCache.get(assetId);
}

export function setCachedAnnotation(assetId, value) {
  if (!assetId) return;
  annotationCache.set(assetId, value || null);
  notify();
}

// Bulk-hydrate from browse results (rows carry an inline `annotation` field).
// Marks every listed asset as KNOWN — annotated or known-empty — so the
// Inspector renders synchronously on selection, like the EXIF sections.
export function seedAnnotations(items) {
  if (!Array.isArray(items) || !items.length) return;
  let changed = false;
  for (const item of items) {
    if (!item?.asset_id || item.annotation === undefined) continue;
    const next = item.annotation || null;
    const prev = annotationCache.get(item.asset_id);
    // Only mark changed on real differences — otherwise every browse page
    // re-renders all subscribers for identical data.
    if (prev === undefined || JSON.stringify(prev) !== JSON.stringify(next)) {
      changed = true;
    }
    annotationCache.set(item.asset_id, next);
  }
  if (changed) notify();
}

// Drop all cached per-asset annotations (e.g. after a batch job) so the next
// view re-fetches fresh results from the catalog.
export function invalidateAnnotations() {
  if (annotationCache.size === 0) return;
  annotationCache.clear();
  notify();
}

// ── Batch annotation job ──────────────────────────────────────────────────
// scope: "all" | "selection" | "collection". onlyMissing defaults true
// (skip already-annotated); pass false to re-annotate.
export async function countAnnotationTargets(opts = {}) {
  const res = await window.mediaWorkspace?.countAnnotationTargets?.(opts);
  return Number(res?.count || 0);
}

export async function startAnnotationJob(opts = {}) {
  return await window.mediaWorkspace?.startAnnotationJob?.({
    scope: opts.scope || "all",
    onlyMissing: opts.onlyMissing !== false,
    assetIds: Array.isArray(opts.assetIds) ? opts.assetIds : null,
    collectionId: opts.collectionId || null,
  });
}

export async function getAnnotationJobStatus() {
  return await window.mediaWorkspace?.getAnnotationJobStatus?.();
}

export async function fetchAnnotation(assetId) {
  if (!assetId) return null;
  if (annotationInflight.has(assetId)) return annotationInflight.get(assetId);
  const p = (async () => {
    try {
      const result = (await window.mediaWorkspace?.getAnnotation?.(assetId)) || null;
      annotationCache.set(assetId, result);
      notify();
      return result;
    } finally {
      annotationInflight.delete(assetId);
    }
  })();
  annotationInflight.set(assetId, p);
  return p;
}

if (typeof window !== "undefined") {
  window.addEventListener("annotation-settings:changed", (e) => {
    const hp = e?.detail?.hasProvider;
    if (typeof hp === "boolean") setHasProvider(hp);
    else void refreshProviders();
  });
  // Also re-probe when the window regains focus — covers cases where settings
  // were changed in another route/overlay without firing the custom event
  // (defensive; the event dispatch is the primary path).
  window.addEventListener("focus", () => {
    void refreshProviders();
  });
}
