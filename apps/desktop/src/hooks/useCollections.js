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

import { useEffect, useRef, useState } from "react";
import api from "../api";
import { rulesFromScope } from "./workspaceLogic";
import { readTargetFolderId, resolveTargetFolder, writeTargetFolderId } from "./targetFolder";
import { ancestorIds, canDropInto, descendantIds } from "../components/folderTree";

// `catalogKey` tells catalogs apart for the remembered target folder.
export default function useCollections(bridgeRef, catalogKey = null) {
  const [collections, setCollections] = useState([]);
  const hasSmartCollections = () => collections.some((c) => c.kind === "smart");

  // The target folder (hooks/targetFolder.js): the one B adds to. Set by
  // making a folder or adding to one; read back per catalog.
  const [targetFolderId, setTargetFolderId] = useState(null);
  useEffect(() => {
    setTargetFolderId(readTargetFolderId(catalogKey));
  }, [catalogKey]);
  function setTargetFolder(collectionId) {
    setTargetFolderId(collectionId || null);
    writeTargetFolderId(catalogKey, collectionId || null);
  }
  const targetFolder = resolveTargetFolder(collections, targetFolderId);

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

  // `parentId` makes the folder inside another folder (folders nest).
  async function createCollection(name, parentId = null) {
    const col = await api.createCollection(name, "manual", null, parentId || null);
    await loadCollections();
    if (col?.collection_id) setTargetFolder(col.collection_id);
    return col;
  }

  // Put a folder inside another, or at the top level (parentId null). The
  // sidebar shows the move at once; the list is reloaded either way.
  async function moveCollection(collectionId, parentId = null) {
    const bridge = bridgeRef.current;
    const target = parentId || null;
    if (!canDropInto(collections, collectionId, target)) return false;
    setCollections((current) => current.map((c) => (c.collection_id === collectionId ? { ...c, parent_collection_id: target } : c)));
    try {
      await api.moveCollection(collectionId, target);
      return true;
    } catch (error) {
      bridge.pushToast?.({ title: bridge.t("folderMoveFailed"), message: String(error?.message || error), tone: "error" });
      return false;
    } finally {
      await loadCollections();
    }
  }

  // Is the folder on screen showing this folder's photos: the folder itself,
  // or one of its ancestors with its subfolders included?
  function showsFolder(collectionId) {
    const scope = bridgeRef.current.scopeRef.current;
    if (!scope.collectionId) return false;
    if (scope.collectionId === collectionId) return true;
    return scope.includeDescendants !== false && ancestorIds(collections, collectionId).includes(scope.collectionId);
  }

  // Save the current view as a smart collection: where the user is plus the
  // refinement (workspaceLogic.rulesFromScope). The new collection then becomes
  // the place, which also empties the filter bar: what was a refinement is now
  // its rules.
  // Inside a folder with folders under it (and them showing), the saved rule
  // follows the whole subtree.
  const rulesOnScreen = () => {
    const scope = bridgeRef.current.scopeRef.current;
    return rulesFromScope(scope, { hasSubfolders: !!scope.collectionId && descendantIds(collections, scope.collectionId).length > 0 });
  };

  async function saveSmartCollection(name) {
    const bridge = bridgeRef.current;
    const rules = rulesOnScreen();
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
    const rules = rulesOnScreen();
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
    if (folder?.collection_id) setTargetFolder(folder.collection_id);
    return { ...folder, count: ids.length };
  }

  const reorderingCollectionsRef = useRef(false);
  const [reorderingCollections, setReorderingCollections] = useState(false);
  // The order of one level: the folders directly under `parentId` (the top
  // level when null), all of them.
  async function reorderCollections(collectionIds, parentId = null) {
    if (reorderingCollectionsRef.current) return;
    reorderingCollectionsRef.current = true;
    setReorderingCollections(true);
    const position = new Map(collectionIds.map((id, index) => [id, index]));
    setCollections(collections.map((c) => (position.has(c.collection_id) ? { ...c, sort_order: position.get(c.collection_id) } : c)));
    try {
      await api.reorderCollections(collectionIds, parentId || null);
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

  // A folder goes with every folder under it (the sidecar deletes the
  // subtree): the view and the target folder leave with any of them.
  async function deleteCollection(collectionId) {
    const bridge = bridgeRef.current;
    const gone = new Set([collectionId, ...descendantIds(collections, collectionId)]);
    await api.deleteCollection(collectionId);
    if (gone.has(targetFolderId)) setTargetFolder(null);
    bridge.bumpCatalogRevision();
    if (gone.has(bridge.scopeRef.current.collectionId)) bridge.updateScope({ collectionId: null });
    if (bridge.scopeRef.current.smartCollectionId === collectionId) bridge.goTo({});
    await loadCollections();
  }

  async function addToCollection(collectionId, assetIds) {
    const bridge = bridgeRef.current;
    await api.collectionAddItems(collectionId, assetIds);
    setTargetFolder(collectionId);
    bridge.bumpCatalogRevision();
    await loadCollections();
    if (showsFolder(collectionId)) {
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
    // Shown through an ancestor: the photo may still be there by way of
    // another folder, so ask again instead of dropping it.
    else if (showsFolder(collectionId)) await bridge.refreshBrowse();
  }

  return {
    collections,
    setCollections,
    hasSmartCollections,
    loadCollections,
    createCollection,
    moveCollection,
    saveSmartCollection,
    updateSmartCollectionRules,
    snapshotSmartCollection,
    reorderCollections,
    reorderingCollections,
    renameCollection,
    deleteCollection,
    addToCollection,
    removeFromCollection,
    targetFolder,
    setTargetFolder,
  };
}
