// The gallery's asset actions, extracted from App.jsx (review S2): the two
// deletes (each behind a confirm), copy path / name, and the two disk
// refreshes the cards ask for. Each resolves ids to the loaded records
// through `itemById` and reports through toasts; the catalog writes
// themselves are useWorkspace's (reached through `workspaceRef`, so a
// confirm that stays open across a re-render still acts on the live hook).

import { useTranslation } from "react-i18next";
import api from "../api";
import { confirm } from "../components/confirm";
import { fileName } from "../utils/format";

// Missing thumbnails made in one background pass: a short wait for the first
// of them to show, and few enough processes for a long list.
const THUMBNAIL_PASS = 100;

export default function useAssetActions({ workspaceRef, itemById, pushToast }) {
  const { t } = useTranslation("app");
  const pathsOf = (ids) => [...new Set((ids || []).map((id) => itemById.get(id)?.image_path).filter(Boolean))];

  const deleteAssets = async (ids) => {
    const list = [...new Set((ids || []).filter(Boolean))];
    if (!list.length) return;
    const ok = await confirm({
      title: t("deleteTitle"),
      message: t("deleteMsg", { count: list.length }),
      detail: t("deleteDetail"),
      confirmLabel: t("remove"),
      cancelLabel: t("cancel"),
      danger: true,
    });
    if (!ok) return;
    await workspaceRef.current.deleteImageAssets(list);
  };

  const deleteFromDisk = async (ids) => {
    const list = [...new Set((ids || []).filter(Boolean))];
    if (!list.length) return;
    const ok = await confirm({
      title: t("diskDeleteTitle"),
      message: t("diskDeleteMsg", { count: list.length }),
      detail: t("diskDeleteDetail"),
      confirmLabel: t("diskDeleteConfirm"),
      cancelLabel: t("cancel"),
      danger: true,
    });
    if (!ok) return;
    const paths = list.map((id) => itemById.get(id)?.image_path).filter(Boolean);
    const result = await workspaceRef.current.deleteImageAssetsFromDisk(list, paths);
    if (result?.failed?.length) {
      pushToast?.({
        title: t("diskDeleteFailed", { count: result.failed.length }),
        tone: "error",
        ttl: 5000,
      });
    }
  };

  // field: "path" | "name"
  const copyAssetField = async (ids, field) => {
    const paths = (ids || [])
      .map((id) => itemById.get(id)?.image_path)
      .filter(Boolean);
    if (!paths.length) return;
    const texts = field === "name" ? paths.map((p) => fileName(p)) : paths;
    await api.copyText(texts.join("\n"));
    pushToast?.({
      title: t(field === "name" ? "copiedName" : "copiedPath", { count: texts.length }),
      ttl: 2000,
    });
  };

  // Thumbnails the gallery is missing, made in the background where missing,
  // THUMBNAIL_PASS at a time from the top of the grid down. After each pass
  // the grid is asked again, so they show as they come. Something skipped as
  // ready was made since the grid loaded (by an import, say): that too.
  const ensureThumbnails = async (ids) => {
    const paths = pathsOf(ids);
    for (let start = 0; start < paths.length; start += THUMBNAIL_PASS) {
      let result;
      try {
        result = await api.ensurePreviews(paths.slice(start, start + THUMBNAIL_PASS));
      } catch {
        return; // the pass failed: the cards go on saying "No preview"
      }
      if (Number(result?.generated || 0) + Number(result?.skipped || 0) > 0) {
        await workspaceRef.current.refreshAll({ preserveView: true });
      }
    }
  };

  const refreshAssetsFromDisk = async (ids, { silent = false } = {}) => {
    const paths = pathsOf(ids);
    if (!paths.length) return null;
    if (!silent) pushToast?.({ title: t("refreshingAssets", { count: paths.length }), ttl: 2500 });
    try {
      const result = await api.refreshAssets(paths);
      await workspaceRef.current.refreshAll({ preserveView: true });
      const deferred = Number(result?.deferred || 0);
      const failed = Number(result?.failed || 0);
      const completed = Math.max(0, paths.length - deferred);
      if (!silent) {
        pushToast?.({
          title: completed
            ? t("refreshAssetsComplete", { count: completed })
            : t("refreshAssetsPostponed"),
          message: deferred
            ? t("refreshAssetsDeferred", { count: deferred })
            : failed
              ? t("refreshAssetsSomeFailed", { count: failed })
              : t("refreshAssetsCompleteMsg"),
          tone: failed ? "error" : undefined,
          ttl: 5000,
        });
      }
      return result;
    } catch (error) {
      if (!silent) {
        pushToast?.({
          title: t("refreshAssetsFailed"),
          message: error?.message || String(error),
          tone: "error",
          ttl: 6000,
        });
      }
      return null;
    }
  };

  return { deleteAssets, deleteFromDisk, copyAssetField, ensureThumbnails, refreshAssetsFromDisk };
}
