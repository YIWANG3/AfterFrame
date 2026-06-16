import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, FolderInput, FolderPlus } from "lucide-react";
import api from "../../api";
import { Group, FieldRow, Toggle, SecondaryButton } from "./SettingsPrimitives";

// Strip the catalog extension for a friendlier display name.
function catalogName(p) {
  if (!p) return null;
  const base = p.split("/").filter(Boolean).pop() || p;
  return base.replace(/\.(afcatalog|mwcatalog)$/i, "");
}

function OpenFolderButton({ kind, label }) {
  return (
    <button
      type="button"
      onClick={() => void window.mediaWorkspace?.openCacheDir?.(kind)}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text focus:outline-none"
    >
      <FolderOpen className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export default function LibrarySettings({ info, summary, onSwitchCatalog, onClose }) {
  const { t } = useTranslation("settings");
  const [generateHd, setGenerateHd] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = (await window.mediaWorkspace?.getPreviewSettings?.()) || {};
      if (!cancelled) setGenerateHd(stored.generateHd === true);
    })();
    return () => { cancelled = true; };
  }, []);

  const setHd = useCallback((value) => {
    setGenerateHd(value);
    void window.mediaWorkspace?.savePreviewSettings?.({ generateHd: value });
  }, []);

  const catalogPath = info?.catalogPath || null;
  const isScratch = !catalogPath || catalogPath === info?.scratchCatalogPath;

  // summary breaks out image/raw; videos are the remainder of the total.
  const totalAssets = summary?.assets ?? 0;
  const imageAssets = summary?.image_assets ?? 0;
  const rawAssets = summary?.raw_assets ?? 0;
  const videoAssets = Math.max(0, totalAssets - imageAssets - rawAssets);

  const switchTo = useCallback(async (resolver) => {
    if (switching) return;
    setSwitching(true);
    try {
      const target = await resolver();
      if (target === undefined) return; // user cancelled the picker
      await onSwitchCatalog?.(target);
      onClose?.(); // let the freshly-loaded library show through
    } finally {
      setSwitching(false);
    }
  }, [switching, onSwitchCatalog, onClose]);

  const openCatalog = useCallback(
    () => switchTo(async () => (await api.pickCatalog?.()) || undefined),
    [switchTo],
  );
  const newCatalog = useCallback(
    () => switchTo(async () => (await api.createCatalog?.()) || undefined),
    [switchTo],
  );

  return (
    <div>
      <Group title={t("library.currentCatalog")}>
        <FieldRow
          label={isScratch ? t("library.catalogScratch") : catalogName(catalogPath)}
          hint={isScratch ? t("library.catalogScratchHint") : catalogPath}
        >
          {!isScratch && (
            <SecondaryButton onClick={() => api.revealPath?.(catalogPath)}>
              <span className="inline-flex items-center gap-1.5">
                <FolderOpen className="h-3.5 w-3.5" />
                {t("library.revealInFinder")}
              </span>
            </SecondaryButton>
          )}
        </FieldRow>
        <FieldRow label={t("library.catalogContents")}>
          <span className="text-[11px] tabular-nums text-muted">
            {t("library.catalogStats", { assets: totalAssets, photos: imageAssets, videos: videoAssets })}
          </span>
        </FieldRow>
        <FieldRow label={t("library.switchCatalog")} hint={t("library.switchCatalogHint")}>
          <SecondaryButton onClick={openCatalog} disabled={switching}>
            <span className="inline-flex items-center gap-1.5">
              <FolderInput className="h-3.5 w-3.5" />
              {t("library.openCatalog")}
            </span>
          </SecondaryButton>
          <SecondaryButton onClick={newCatalog} disabled={switching}>
            <span className="inline-flex items-center gap-1.5">
              <FolderPlus className="h-3.5 w-3.5" />
              {t("library.newCatalog")}
            </span>
          </SecondaryButton>
        </FieldRow>
      </Group>
      <Group title={t("library.previewsTitle")}>
        <FieldRow label={t("library.generateHd")} hint={t("library.generateHdHint")}>
          <Toggle on={generateHd} onChange={setHd} />
        </FieldRow>
      </Group>
      <Group title={t("library.cacheStorage")} subtitle={t("library.cacheSubtitle")}>
        <FieldRow label={t("library.depthMaps")} hint={t("library.depthMapsHint")}>
          <OpenFolderButton kind="depth" label={t("library.openFolder")} />
        </FieldRow>
        <FieldRow label={t("library.stickerLibrary")} hint={t("library.stickerLibraryHint")}>
          <OpenFolderButton kind="stickers" label={t("library.openFolder")} />
        </FieldRow>
        <FieldRow label={t("library.videoProxies")} hint={t("library.videoProxiesHint")}>
          <OpenFolderButton kind="videoProxies" label={t("library.openFolder")} />
        </FieldRow>
      </Group>
    </div>
  );
}
