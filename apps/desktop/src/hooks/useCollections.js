// Folders and smart collections, extracted from useWorkspace (review S1-a):
// the list, and every write to it. The scope (where the user is) stays in
// useWorkspace; this hook reaches it through `bridgeRef.current`, reassigned
// every render so a call that lands after an await sees the current state:
//   t, pushToast                  the failure toasts
//   scopeRef                      the view on screen (rules are saved from it)
//   updateScope(patch), goTo(next), openSmartCollection(collection)
//   bumpCatalogRevision()         membership changes move the map's points
//   refreshBrowse()               re-browse the folder on screen
//   dropLoadedItems(ids)          rows taken out of the folder on screen

import { useRef, useState } from "react";
import api from "../api";
import { rulesFromScope } from "./workspaceLogic";

export default function useCollections(bridgeRef) {
  const [collections, setCollections] = useState([]);
  const hasSmartCollections = () => collections.some((c) => c.kind === "smart");

  async function loadCollections() {
    try {
      const list = await api.listCollections();
      setCollections(list || []);
      return list || [];
    } catch {
      setCollections([]);
      return [];
    }
  }

  async function createCollection(name) {
    const col = await api.createCollection(name, "manual");
    await loadCollections();
    return col;
  }

  // Save the current view as a smart collection: where the user is plus the
  // refinement (workspaceLogic.rulesFromScope). The new collection then becomes
  // the place, which also empties the filter bar: what was a refinement is now
  // its rules.
  async function saveSmartCollection(name) {
    const bridge = bridgeRef.current;
    const rules = rulesFromScope(bridge.scopeRef.current);
    if (!rules) return null;
    const col = await api.createCollection(name, "smart", rules);
    const saved = (await loadCollections()).find((c) => c.collection_id === col.collection_id);
    // Never leave a smart collection that lost its conditions on the way in:
    // it would sit in the sidebar at 0 photos, forever, under a "saved" toast.
    // (Seen in dev with a main process older than the renderer, which dropped
    // the rules argument.)
    if (!saved?.rules) {
      await api.deleteCollection(col.collection_id).catch(() => {});
      await loadCollections();
      throw new Error(bridge.t("smartCollectionRulesLost"));
    }
    bridge.openSmartCollection(saved);
    return col;
  }

  // Rewrite a smart collection's rules from the current view, then show it:
  //   viewing + a refinement → "narrow this collection to what I see" (the
  //                            refinement nests on its old rules)
  //   editing                → the bar's conditions replace its top layer
  async function updateSmartCollectionRules(collectionId) {
    const bridge = bridgeRef.current;
    const rules = rulesFromScope(bridge.scopeRef.current);
    if (!rules) return;
    await api.updateCollection(collectionId, { rules });
    const saved = (await loadCollections()).find((c) => c.collection_id === collectionId);
    if (saved) bridge.openSmartCollection(saved);
  }

  // Freeze what a smart collection shows right now into an ordinary folder.
  async function snapshotSmartCollection(collection, name) {
    const rules = collection?.rules;
    if (!rules) return null;
    const ids = [];
    for (let offset = 0; ; offset += 500) {
      const page = await api.browseImages({ status: "all", base: rules, limit: 500, offset });
      ids.push(...(page || []).map((row) => row.asset_id));
      if (!page || page.length < 500) break;
    }
    const folder = await api.createCollection(name, "manual");
    if (ids.length) await api.collectionAddItems(folder.collection_id, ids);
    await loadCollections();
    return { ...folder, count: ids.length };
  }

  const reorderingCollectionsRef = useRef(false);
  const [reorderingCollections, setReorderingCollections] = useState(false);
  async function reorderCollections(collectionIds) {
    if (reorderingCollectionsRef.current) return;
    reorderingCollectionsRef.current = true;
    setReorderingCollections(true);
    const byId = new Map(collections.map((c) => [c.collection_id, c]));
    setCollections([
      ...collectionIds.map((id, sort_order) => ({ ...byId.get(id), sort_order })),
      ...collections.filter((c) => c.kind !== "manual"),
    ]);
    try {
      await api.reorderCollections(collectionIds);
    } catch (error) {
      const bridge = bridgeRef.current;
      bridge.pushToast?.({ title: bridge.t("folderOrderFailed"), message: String(error?.message || error), tone: "error" });
    } finally {
      await loadCollections();
      reorderingCollectionsRef.current = false;
      setReorderingCollections(false);
    }
  }

  async function renameCollection(collectionId, name) {
    await api.updateCollection(collectionId, { name });
    await loadCollections();
  }

  async function deleteCollection(collectionId) {
    const bridge = bridgeRef.current;
    await api.deleteCollection(collectionId);
    bridge.bumpCatalogRevision();
    if (bridge.scopeRef.current.collectionId === collectionId) bridge.updateScope({ collectionId: null });
    if (bridge.scopeRef.current.smartCollectionId === collectionId) bridge.goTo({});
    await loadCollections();
  }

  async function addToCollection(collectionId, assetIds) {
    const bridge = bridgeRef.current;
    await api.collectionAddItems(collectionId, assetIds);
    bridge.bumpCatalogRevision();
    await loadCollections();
    if (bridge.scopeRef.current.collectionId === collectionId) {
      await bridge.refreshBrowse();
    }
  }

  async function removeFromCollection(collectionId, assetIds) {
    const bridge = bridgeRef.current;
    const targetIds = [...new Set((assetIds || []).filter(Boolean))];
    if (!targetIds.length) return;
    await api.collectionRemoveItems(collectionId, targetIds);
    bridge.bumpCatalogRevision();
    await loadCollections();
    if (bridge.scopeRef.current.collectionId === collectionId) bridge.dropLoadedItems(targetIds);
  }

  return {
    collections,
    setCollections,
    hasSmartCollections,
    loadCollections,
    createCollection,
    saveSmartCollection,
    updateSmartCollectionRules,
    snapshotSmartCollection,
    reorderCollections,
    reorderingCollections,
    renameCollection,
    deleteCollection,
    addToCollection,
    removeFromCollection,
  };
}
