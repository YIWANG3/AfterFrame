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

function baseName(p) {
  return String(p).split("/").filter(Boolean).pop() || String(p);
}

function FinderButton({ onClick, label }) {
  return (
    <SecondaryButton onClick={onClick}>
      <span className="inline-flex items-center gap-1.5">
        <FolderOpen className="h-3.5 w-3.5" />
        {label}
      </span>
    </SecondaryButton>
  );
}

function OpenFolderButton({ kind, label }) {
  return <FinderButton onClick={() => void window.mediaWorkspace?.openCacheDir?.(kind)} label={label} />;
}

export default function LibrarySettings({ info, summary, onSwitchCatalog, onClose }) {
  const { t } = useTranslation("settings");
  const [generateHd, setGenerateHd] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [watched, setWatched] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = (await window.mediaWorkspace?.getPreviewSettings?.()) || {};
      if (!cancelled) setGenerateHd(stored.generateHd === true);
      const dirs = await api.getWatchedDirs?.();
      if (!cancelled) setWatched(Array.isArray(dirs) ? dirs : []);
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

  const addWatchedDir = useCallback(async () => {
    const picked = await api.pickDirectories?.("image");
    if (!picked?.length) return;
    let next = watched;
    for (const p of picked) next = await api.addWatchedDir(p);
    setWatched(Array.isArray(next) ? next : []);
  }, [watched]);

  const removeWatchedDir = useCallback(async (dir) => {
    const next = await api.removeWatchedDir(dir);
    setWatched(Array.isArray(next) ? next : []);
  }, []);

  return (
    <div>
      <Group title={t("library.currentCatalog")} scope={t("scope.catalog")}>
        <FieldRow
          label={isScratch ? t("library.catalogScratch") : catalogName(catalogPath)}
          hint={isScratch ? t("library.catalogScratchHint") : catalogPath}
        >
          {!isScratch && (
            <FinderButton onClick={() => api.revealPath?.(catalogPath)} label={t("library.revealInFinder")} />
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
      <Group title={t("library.watchedTitle")} subtitle={t("library.watchedSubtitle")} scope={t("scope.catalog")}>
        {watched.length === 0 ? (
          <div className="py-3 text-[11px] text-muted2">{t("library.noWatched")}</div>
        ) : (
          watched.map((dir) => (
            <FieldRow key={dir} label={baseName(dir)} hint={dir}>
              <SecondaryButton onClick={() => removeWatchedDir(dir)}>{t("library.remove")}</SecondaryButton>
            </FieldRow>
          ))
        )}
        <div className="py-3">
          <SecondaryButton onClick={addWatchedDir}>
            <span className="inline-flex items-center gap-1.5">
              <FolderPlus className="h-3.5 w-3.5" />
              {t("library.addFolder")}
            </span>
          </SecondaryButton>
        </div>
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
