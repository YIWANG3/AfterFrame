// The renderer's one record of HD previews made on demand (a RAW's HD isn't
// made at import), shared by the lightbox, the editor and the collage so an HD
// one of them made is never asked for again by another.
//
// Making one runs on the resident sidecar, which answers one command at a time
// with a 30 s timeout per call. Every browse page, detail read and rating waits
// behind whatever HD work is queued there, so this store keeps at most one
// request out at a time, app-wide, and decides what to send only when the last
// one comes back: the photo someone is looking at first, then explicit batches
// (the collage), then neighbours to prefetch. A photo the user has stepped past
// is no longer wanted by then, so it is never sent.

export const HD_RETRY_AFTER_MS = 15_000;
export const HD_PREFETCH_SETTLE_MS = 300;

// `ensure(paths)` makes the HD previews (api.ensureHdPreviews); `readDetail(id)`
// reads an asset back to learn where its HD went (api.getAssetDetailById).
export function createHdPreviewStore({
  ensure,
  readDetail,
  now = () => Date.now(),
  retryAfterMs = HD_RETRY_AFTER_MS,
  settleMs = HD_PREFETCH_SETTLE_MS,
}) {
  // asset_id is a hash of fingerprint + path, so the same photo has the same id
  // in every catalog that imports it. Everything here belongs to one catalog
  // and is dropped when it changes; `generation` marks results of a request
  // sent before the change, which are dropped when they land.
  let catalog = null;
  let generation = 0;
  // asset_id → { path } once made, { failedAt } once making it failed.
  let entries = new Map();
  // The asset_ids of the one request out now.
  let inFlight = new Set();
  let busy = false;
  // consumer → { key, since, current, prefetch, pendingPrefetch, timer }
  const demands = new Map();
  // Explicit batches, first come first served: { items, signal, resolve }.
  let jobs = [];
  const listeners = new Set();
  let snapshot = freeze();

  function freeze() {
    return { catalog, entries: new Map(entries), inFlight: new Set(inFlight) };
  }

  function emit() {
    snapshot = freeze();
    for (const listener of [...listeners]) listener();
  }

  function isReady(id) {
    return Boolean(entries.get(id)?.path);
  }

  function failedRecently(id) {
    const failedAt = entries.get(id)?.failedAt;
    return failedAt !== undefined && now() - failedAt < retryAfterMs;
  }

  // A failure is retried the next time its photo becomes current, or once it
  // is old enough; until then it stays failed, so a view that keeps asking
  // (or a photo that can't be read) doesn't send the same request in a loop.
  function forgetFailure(id, becameCurrent) {
    const entry = entries.get(id);
    if (entry?.failedAt === undefined) return false;
    if (!becameCurrent && now() - entry.failedAt < retryAfterMs) return false;
    entries.delete(id);
    return true;
  }

  function answerFor(items) {
    return new Map(items.map((item) => [item.asset_id, entries.get(item.asset_id)?.path || null]));
  }

  function setCatalog(key) {
    const next = key || null;
    if (next === catalog) return;
    catalog = next;
    generation += 1;
    entries = new Map();
    inFlight = new Set();
    for (const demand of demands.values()) clearTimeout(demand.timer);
    demands.clear();
    const dropped = jobs;
    jobs = [];
    for (const job of dropped) job.resolve(new Map(job.items.map((item) => [item.asset_id, null])));
    // `busy` stays set until the request already out settles: the sidecar is
    // still working on it, and one at a time is the point.
    emit();
    pump();
  }

  // What one consumer (a lightbox, an editor) is showing. `key` is where it is
  // (the current photo's id, whether or not it needs an HD); `current` is that
  // photo if it needs one, and `prefetch` the photos worth making ahead. The
  // current one is wanted at once; the prefetch only once `key` has held still
  // for settleMs, so stepping quickly through a folder asks for nothing it
  // passes. Each call replaces what the consumer wanted before.
  function want(consumer, { key = null, current = null, prefetch = [] } = {}) {
    let demand = demands.get(consumer);
    let changed = false;
    if (current) {
      const becameCurrent = demand?.current?.asset_id !== current.asset_id;
      changed = forgetFailure(current.asset_id, becameCurrent);
    }
    if (!demand || demand.key !== key) {
      if (demand) clearTimeout(demand.timer);
      demand = { key, since: now(), current, prefetch: [], pendingPrefetch: [], timer: null };
      demands.set(consumer, demand);
    }
    demand.current = current;
    demand.pendingPrefetch = prefetch;
    clearTimeout(demand.timer);
    demand.timer = null;
    // Held still since `since`: measured from when the position last changed,
    // so neighbours that arrive later (a page still loading) wait out the rest.
    const wait = demand.since + settleMs - now();
    if (wait <= 0 || !prefetch.length) {
      changed = applyPrefetch(demand) || changed;
    } else {
      const scheduled = demand;
      scheduled.timer = setTimeout(() => {
        scheduled.timer = null;
        if (demands.get(consumer) !== scheduled) return;
        if (applyPrefetch(scheduled)) emit();
        pump();
      }, wait);
    }
    if (changed) emit();
    pump();
  }

  function applyPrefetch(demand) {
    demand.prefetch = demand.pendingPrefetch;
    let forgot = false;
    for (const item of demand.prefetch) forgot = forgetFailure(item.asset_id, false) || forgot;
    return forgot;
  }

  function release(consumer) {
    const demand = demands.get(consumer);
    if (!demand) return;
    clearTimeout(demand.timer);
    demands.delete(consumer);
  }

  // Make the HD previews of `items` (the collage's cells, a chunk at a time),
  // queued behind the photo on screen. Resolves to asset_id → HD path, or null
  // where none could be made. One that failed moments ago answers null without
  // asking again. A batch whose signal aborts before its turn is never sent.
  function ensureBatch(items, { catalogKey = catalog, signal } = {}) {
    const list = [];
    const seen = new Set();
    for (const item of items || []) {
      if (!item?.asset_id || !item.image_path || seen.has(item.asset_id)) continue;
      seen.add(item.asset_id);
      list.push(item);
    }
    // Asked for by a view of a catalog that is no longer open.
    if ((catalogKey || null) !== catalog) {
      return Promise.resolve(new Map(list.map((item) => [item.asset_id, null])));
    }
    if (list.every((item) => isReady(item.asset_id) || failedRecently(item.asset_id))) {
      return Promise.resolve(answerFor(list));
    }
    return new Promise((resolve) => {
      jobs.push({ items: list, signal, resolve });
      pump();
    });
  }

  function sendable(item) {
    return Boolean(item) && !inFlight.has(item.asset_id) && !entries.has(item.asset_id);
  }

  function nextWork() {
    for (const demand of demands.values()) {
      if (sendable(demand.current)) return { items: [demand.current] };
    }
    while (jobs.length) {
      const job = jobs.shift();
      const send = job.signal?.aborted
        ? []
        : job.items.filter((item) => !isReady(item.asset_id) && !failedRecently(item.asset_id));
      if (send.length) return { items: send, job };
      job.resolve(answerFor(job.items));
    }
    for (const demand of demands.values()) {
      const item = demand.prefetch.find(sendable);
      if (item) return { items: [item] };
    }
    return null;
  }

  async function request(items) {
    const found = new Map(items.map((item) => [item.asset_id, null]));
    try {
      const result = await ensure(items.map((item) => item.image_path));
      // The IPC handler turns a sidecar error or timeout into { error }. Reading
      // details now would only queue behind the same backlog; a later view
      // retries, and finds the HD at once if it was made after all.
      if (result?.error) throw new Error(result.error);
      const details = await Promise.all(
        items.map((item) => Promise.resolve().then(() => readDetail(item.asset_id)).catch(() => null)),
      );
      for (const detail of details) {
        const hd = detail?.image_preview_hd_path || detail?.preview_hd_path;
        if (hd && found.has(detail.asset_id)) found.set(detail.asset_id, hd);
      }
    } catch (err) {
      console.warn("[hd] on-demand HD preview failed:", err?.message || err);
    }
    return found;
  }

  function pump() {
    if (busy) return;
    const work = nextWork();
    if (!work) return;
    busy = true;
    const sentFor = generation;
    for (const item of work.items) inFlight.add(item.asset_id);
    emit();
    void request(work.items).then((found) => {
      busy = false;
      const stillOpen = sentFor === generation;
      if (stillOpen) {
        const at = now();
        for (const [id, path] of found) {
          inFlight.delete(id);
          entries.set(id, path ? { path } : { failedAt: at });
        }
      }
      if (work.job) {
        work.job.resolve(stillOpen
          ? answerFor(work.job.items)
          : new Map(work.job.items.map((item) => [item.asset_id, null])));
      }
      emit();
      pump();
    });
  }

  return {
    setCatalog,
    want,
    release,
    ensureBatch,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}

// The HD preview a snapshot holds for `assetId`: its path once made, null once
// making it failed (until a retry is sent), undefined while it is being made
// or hasn't been asked for.
export function hdPreviewIn(snapshot, assetId) {
  if (!assetId || snapshot.inFlight.has(assetId)) return undefined;
  const entry = snapshot.entries.get(assetId);
  if (!entry) return undefined;
  return entry.path || null;
}
