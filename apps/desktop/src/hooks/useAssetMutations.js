// Writes to the photos themselves, extracted from useWorkspace (review S1-b):
// rating, flag, description, tags, and the two deletes. The grid and the
// Inspector live in useWorkspace; this hook reaches them through
// `bridgeRef.current` (reassigned every render, so a call that lands after an
// await still sees the current state):
//   t, pushToast                    the failure toast
//   itemsRef, detailRef             the loaded records, for the snapshot
//   setItems, setDetail             the optimistic patch and its rollback
//   scopeRef, revealRef             whether the view selects by the field
//   refreshBrowse()                 re-browse the view, keeping the scroll
//   loadCollections(), hasSmartCollections()  live smart-collection counts
//   loadFacetValues()               the tag filter's options
//   bumpCatalogRevision()           the map's point cache
//   selectedAssetIdRef, setSelectedAssetId, setBrowserOffset   the deletes

import api from "../api";
import { invalidateTags } from "../components/annotation/tagStore";
import { scopeSelectsByFlag, scopeSelectsByRating, scopeSelectsByTag } from "./workspaceLogic";
import {
  FLAG_VALUES, descriptionFields, descriptionPatch, flagFields, flagPatch, normalizeDescription,
  patchList, patchRecord, ratingFields, ratingPatch, rollbackPatch, snapshotFields, uniqueIds,
} from "./assetMutationLogic";

export default function useAssetMutations(bridgeRef) {
  // One optimistic write: snapshot what the loaded records show (`read`),
  // show the change (`patch`), send it (`call`), and on failure put the
  // snapshot back and say so. After a successful write the change is shown
  // again: a detail asked for just before (click, then a key at once) answers
  // after the change was shown, with the old value — the sidecar takes
  // requests in order. Then the views that select by the field follow: the
  // smart-collection counts, and the grid when the view is one of them, as
  // a photo that no longer qualifies has already left the sidebar count.
  async function optimisticAssetPatch({ assetIds, read, patch, call, refreshWhen, failedTitle }) {
    const bridge = bridgeRef.current;
    const targetIds = uniqueIds(assetIds);
    if (!targetIds.length) return false;
    const targetSet = new Set(targetIds);
    const previous = snapshotFields([...bridge.itemsRef.current, bridge.detailRef.current], targetSet, read);
    const apply = (next) => {
      bridge.setItems((current) => patchList(current, targetSet, next));
      bridge.setDetail((current) => patchRecord(current, targetSet, next));
    };
    apply(patch);
    try {
      await call(targetIds);
      apply(patch);
    } catch (error) {
      apply(rollbackPatch(previous));
      bridge.pushToast?.({ title: bridge.t(failedTitle), message: String(error?.message || error), tone: "error", ttl: 6000 });
      // Handled in full here (rolled back + surfaced); the callers invoke
      // these as `void setAssetRating(...)`, so rethrowing would just produce
      // an unhandled rejection.
      return false;
    }
    if (bridge.hasSmartCollections()) void bridge.loadCollections();
    if (refreshWhen(bridge.scopeRef.current) && !bridge.revealRef.current) void bridge.refreshBrowse();
    bridge.bumpCatalogRevision();
    return true;
  }

  function setAssetRating(assetIds, rating) {
    // 0 is a rating of its own (cleared), as the catalog stores it.
    const nextRating = Number(rating) || 0;
    return optimisticAssetPatch({
      assetIds,
      read: ratingFields,
      patch: ratingPatch(nextRating),
      call: (ids) => api.setAssetRating(ids, nextRating),
      // A view that selects by rating loses a photo that no longer qualifies
      // now — and the selection with it, like a delete, so nothing else gets
      // rated by the next key press.
      refreshWhen: scopeSelectsByRating,
      failedTitle: "ratingFailed",
    });
  }

  // Pick / reject / none, as Lightroom's P / X / U.
  function setAssetFlag(assetIds, flag) {
    const value = FLAG_VALUES[flag];
    if (value === undefined) return Promise.resolve(false);
    return optimisticAssetPatch({
      assetIds,
      read: flagFields,
      patch: flagPatch(value),
      call: (ids) => api.setAssetFlag(ids, flag),
      refreshWhen: scopeSelectsByFlag,
      failedTitle: "flagFailed",
    });
  }

  // The description the user writes (Inspector), shown at once. "" leaves
  // it empty (their choice); null hands it back to the AI's caption.
  function setAssetDescription(assetIds, text) {
    const value = normalizeDescription(text);
    return optimisticAssetPatch({
      assetIds,
      read: descriptionFields,
      patch: descriptionPatch(value),
      call: (ids) => api.setAssetDescription(ids, value),
      refreshWhen: (scope) => !!(scope.query?.trim() || scope.filters?.caption_contains),
      failedTitle: "descriptionFailed",
    });
  }

  // The gallery's "Add Tags…": every tag onto every photo, in one write. The
  // Inspector's tags, the tag filter's options and a view that selects by
  // tag all follow.
  async function addTagsToAssets(assetIds, tags) {
    const bridge = bridgeRef.current;
    const targetIds = uniqueIds(assetIds);
    const clean = [...new Set((tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))];
    if (!targetIds.length || !clean.length) return null;
    const result = await api.addAssetTags(targetIds, clean);
    invalidateTags(targetIds);
    bridge.loadFacetValues();
    if (bridge.hasSmartCollections()) void bridge.loadCollections();
    if (scopeSelectsByTag(bridge.scopeRef.current) && !bridge.revealRef.current) void bridge.refreshBrowse();
    bridge.bumpCatalogRevision();
    return result;
  }

  // The rows just left the list the server pages through (deleted, or taken
  // out of the folder on screen). Paging is by offset, so the offset falls by
  // every one of them that was loaded; otherwise the next page starts that
  // many rows late and skips them. Ids past the loaded range never counted.
  function dropLoadedItems(assetIds) {
    const bridge = bridgeRef.current;
    const loadedIds = new Set(bridge.itemsRef.current.map((item) => item.asset_id));
    const loaded = assetIds.filter((id) => loadedIds.has(id)).length;
    const dropped = new Set(assetIds);
    bridge.setItems((current) => current.filter((item) => !dropped.has(item.asset_id)));
    // Not inside the setItems updater: StrictMode runs updaters twice.
    if (loaded) bridge.setBrowserOffset((offset) => Math.max(0, offset - loaded));
  }

  // The records are gone: out of the grid, and out of the Inspector when the
  // photo shown was one of them.
  function forgetDeleted(targetIds) {
    const bridge = bridgeRef.current;
    bridge.bumpCatalogRevision();
    dropLoadedItems(targetIds);
    const selectedId = bridge.selectedAssetIdRef.current;
    if (selectedId && targetIds.includes(selectedId)) {
      bridge.setSelectedAssetId(null);
      bridge.setDetail(null);
    }
  }

  async function deleteImageAssets(assetIds) {
    const targetIds = uniqueIds(assetIds);
    if (!targetIds.length) return;
    await api.deleteImageAssets(targetIds);
    forgetDeleted(targetIds);
  }

  // Delete from disk: trash the originals AND drop the catalog records. Main
  // trashes the files first, so no tombstone is written (a trashed file can't
  // reappear in a watched dir). Paths are resolved by the caller (it has them).
  async function deleteImageAssetsFromDisk(assetIds, paths) {
    const targetIds = uniqueIds(assetIds);
    if (!targetIds.length) return null;
    const result = await api.deleteImageAssetsFromDisk(targetIds, paths || []);
    forgetDeleted(targetIds);
    return result;
  }

  return {
    setAssetRating,
    setAssetFlag,
    setAssetDescription,
    addTagsToAssets,
    dropLoadedItems,
    deleteImageAssets,
    deleteImageAssetsFromDisk,
  };
}
