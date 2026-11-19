// Folders on disk (docs/collections-and-folders-design.md §5): the tree the
// sidebar's Folders section shows, and what a folder's menu does. The tree is
// the sidecar's, derived from the photos' paths (db/folders.py); it is asked
// again whenever the library may have changed (`refreshKey`). Nothing here
// changes a folder on disk except Move to Trash, which goes through the same
// path a photo's does.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import api from "../api";
import { choose } from "../components/confirm";
import { folderName, hasChildren as folderHasChildren, isSynced, isWithin } from "../components/diskFolderTree";
import { folderBase } from "./workspaceLogic";

export default function useDiskFolders({ workspaceRef, pushToast, refreshKey }) {
  const { t } = useTranslation("nav");
  const { t: tApp } = useTranslation("app");
  const [folders, setFolders] = useState([]);
  const [watchedDirs, setWatchedDirs] = useState([]);
  const loadIdRef = useRef(0);

  async function refresh() {
    if (!api.has("listFolders")) return;
    const id = ++loadIdRef.current;
    const [tree, watched] = await Promise.all([
      Promise.resolve(api.listFolders()).catch(() => null),
      api.has("getWatchedDirs") ? Promise.resolve(api.getWatchedDirs()).catch(() => []) : [],
    ]);
    if (id !== loadIdRef.current) return;
    setFolders(tree?.folders || []);
    setWatchedDirs(watched || []);
  }

  useEffect(() => {
    void refresh();
  }, [refreshKey]);

  const fail = (error) => pushToast?.({ title: t("diskFolders.failed"), message: String(error?.message || error), tone: "error", ttl: 7000 });

  // Every photo of a folder and the ones below it, as the gallery lists them.
  async function photosOf(path) {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const page = await api.browseImages({ status: "all", base: folderBase(path, true), limit: 500, offset });
      for (const row of page || []) rows.push({ asset_id: row.asset_id, image_path: row.image_path });
      if (!page || page.length < 500) break;
    }
    return rows;
  }

  // A folder that moved: where is it now? Its photos are relinked to the same
  // places there, each checked by its content.
  async function locate(folder) {
    try {
      const result = await api.locateFolder({ old: folder.path });
      if (!result || result.status === "cancelled") return;
      const rest = [
        result.not_found ? t("missingView.notFound", { count: result.not_found }) : null,
        result.mismatch ? t("missingView.mismatch", { count: result.mismatch }) : null,
        result.in_use ? t("missingView.inUse", { count: result.in_use }) : null,
      ].filter(Boolean);
      pushToast?.({
        title: result.relinked ? t("missingView.relinked", { count: result.relinked }) : t("missingView.relinkedNone"),
        message: rest.length ? rest.join(" · ") : undefined,
        tone: result.relinked ? undefined : "error",
        ttl: rest.length ? 8000 : 4000,
      });
      await workspaceRef.current.refreshAll({ preserveView: true });
      await refresh();
    } catch (error) {
      fail(error);
    }
  }

  // Sync: what left the folder is marked missing, what arrived is imported
  // (a moved photo keeps its record, db.maintenance.claim_moved_original).
  async function sync(folder) {
    try {
      const verified = await api.verifyAssets({ under: folder.path });
      pushToast?.({
        title: t("diskFolders.synced", { name: folder.name }),
        message: verified?.newly_missing ? t("diskFolders.syncedMissing", { count: verified.newly_missing }) : undefined,
        ttl: 4000,
      });
      // Asked now: the tree's `exists` is from when it was listed.
      const there = api.has("statDirs") ? ((await api.statDirs([folder.path])) || []).length > 0 : folder.exists;
      if (there) await workspaceRef.current.addImagesFromPaths([folder.path], { auto: true });
      else await workspaceRef.current.refreshAll({ preserveView: true });
      await refresh();
    } catch (error) {
      fail(error);
    }
  }

  // Every folder at once: each top folder checked and imported again.
  async function syncAll() {
    const tops = folders.filter((folder) => folder.parent == null);
    if (!tops.length) return;
    try {
      let missing = 0;
      for (const folder of tops) missing += (await api.verifyAssets({ under: folder.path }))?.newly_missing || 0;
      pushToast?.({
        title: t("diskFolders.syncedAll", { count: tops.length }),
        message: missing ? t("diskFolders.syncedMissing", { count: missing }) : undefined,
        ttl: 4000,
      });
      const there = api.has("statDirs") ? (await api.statDirs(tops.map((folder) => folder.path))) || [] : tops.map((folder) => folder.path);
      if (there.length) await workspaceRef.current.addImagesFromPaths(there, { auto: true });
      else await workspaceRef.current.refreshAll({ preserveView: true });
      await refresh();
    } catch (error) {
      fail(error);
    }
  }

  // Auto-sync is the folder being watched (electron/watcher.js).
  async function setAutoSync(folder, on) {
    try {
      if (on) {
        await api.addWatchedDir(folder.path);
        pushToast?.({ title: t("diskFolders.autoSyncOnToast", { name: folder.name }), ttl: 4000 });
      } else {
        // Off is the watched folder that covers it: itself, or one above it.
        const covering = watchedDirs.filter((dir) => isSynced(folder.path, [dir]));
        for (const dir of covering) await api.removeWatchedDir(dir);
      }
      await refresh();
    } catch (error) {
      fail(error);
    }
  }

  // A one-time snapshot: a collection holding the folder's photos now, and
  // never following the disk afterwards. With folders under it, grouped by
  // subfolder or all in one, the same choice a Finder drop asks.
  async function saveAsCollection(folder) {
    let mirror = false;
    if (folderHasChildren(folders, folder.path)) {
      const choice = await choose({
        title: t("diskFolders.saveTitle", { name: folder.name }),
        choices: [
          { id: "flat", label: t("folders.dropFlatten") },
          { id: "mirror", label: t("folders.dropKeepSubfolders") },
        ],
        cancelLabel: tApp("cancel"),
      });
      if (!choice) return;
      mirror = choice === "mirror";
    }
    try {
      const made = await workspaceRef.current.createCollection(folder.name);
      if (!made?.collection_id) return;
      await api.collectionAddPaths(made.collection_id, [folder.path], { mirror });
      await workspaceRef.current.refreshAll({ preserveView: true });
      pushToast?.({ title: t("diskFolders.saved", { name: folder.name }), ttl: 4000 });
    } catch (error) {
      fail(error);
    }
  }

  // Out of the library, or into the Trash: the same two ways a photo goes.
  async function remove(folder) {
    let photos;
    try {
      photos = await photosOf(folder.path);
    } catch (error) {
      fail(error);
      return;
    }
    if (!photos.length) return;
    const canTrash = api.can("fileSystem");
    const choice = await choose({
      title: t("diskFolders.removeTitle", { name: folder.name }),
      message: t("diskFolders.removeMsg", { count: photos.length }),
      detail: `${t("diskFolders.removeDetail")} ${folder.path}`,
      choices: [
        { id: "library", label: t("diskFolders.removeFromLibrary") },
        ...(canTrash ? [{ id: "trash", label: t("diskFolders.removeToTrash", { count: photos.length }), danger: true }] : []),
      ],
      cancelLabel: tApp("cancel"),
      danger: true,
    });
    if (!choice) return;
    const ids = photos.map((photo) => photo.asset_id);
    try {
      if (choice === "library") {
        await workspaceRef.current.deleteImageAssets(ids);
        pushToast?.({ title: t("diskFolders.removed", { count: ids.length }), ttl: 4000 });
      } else {
        const result = await workspaceRef.current.deleteImageAssetsFromDisk(ids, photos.map((photo) => photo.image_path).filter(Boolean));
        if (result?.failed?.length) pushToast?.({ title: tApp("diskDeleteFailed", { count: result.failed.length }), tone: "error", ttl: 5000 });
        else pushToast?.({ title: t("diskFolders.trashed", { count: ids.length }), ttl: 4000 });
      }
      // The folder on screen is gone from the tree: back to the library.
      if (isWithin(workspaceRef.current.activeFolderPath, folder.path)) workspaceRef.current.clearCollection();
      await refresh();
    } catch (error) {
      fail(error);
    }
  }

  return {
    folders,
    watchedDirs,
    refresh,
    hasChildren: (path) => folderHasChildren(folders, path),
    isSynced: (path) => isSynced(path, watchedDirs),
    folderName,
    locate,
    sync,
    syncAll,
    setAutoSync,
    saveAsCollection,
    reveal: (folder) => api.revealPath(folder.path),
    remove,
  };
}
