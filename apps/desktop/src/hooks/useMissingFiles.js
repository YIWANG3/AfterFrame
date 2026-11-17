// The Missing Originals view's batch actions (MissingFilesBar): remove the
// photos from the library, or look for their originals under a folder and
// relink the ones whose content matches. Each acts on the given ids, or on
// every photo of the view when there are none. Catalog writes go through
// useWorkspace (reached through `workspaceRef`, like useAssetActions).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import api from "../api";
import { confirm } from "../components/confirm";

export default function useMissingFiles({ workspaceRef, pushToast }) {
  const { t } = useTranslation("nav");
  const { t: tApp } = useTranslation("app");
  const [busy, setBusy] = useState(false);

  const targetsOf = async (ids) => {
    const list = [...new Set((ids || []).filter(Boolean))];
    if (list.length) return list;
    return (await workspaceRef.current.collectView()).map((row) => row.asset_id);
  };

  const run = async (work) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      pushToast?.({ title: t("missingView.failed"), message: String(error?.message || error), tone: "error", ttl: 7000 });
    } finally {
      setBusy(false);
    }
  };

  const remove = (ids) => run(async () => {
    const list = await targetsOf(ids);
    if (!list.length) return;
    const ok = await confirm({
      title: t("missingView.removeTitle"),
      message: t("missingView.removeMsg", { count: list.length }),
      detail: t("missingView.removeDetail"),
      confirmLabel: t("missingView.removeConfirm"),
      cancelLabel: tApp("cancel"),
      danger: true,
    });
    if (!ok) return;
    await workspaceRef.current.deleteImageAssets(list);
    pushToast?.({ title: t("missingView.removed", { count: list.length }), ttl: 4000 });
  });

  const relink = (ids) => run(async () => {
    const list = await targetsOf(ids);
    if (!list.length) return;
    const result = await api.relinkFromFolder({ assetIds: list });
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
    // Relinked photos (and ones found back in place) leave the view.
    await workspaceRef.current.refreshAll({ preserveView: true });
  });

  return { busy, remove, relink };
}
