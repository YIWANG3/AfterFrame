import { Suspense, lazy, useRef } from "react";
import { useTranslation } from "react-i18next";
import useMapPoints from "./useMapPoints";

// PhotoMap (and with it maplibre-gl + the 22 MB base-map data) loads on the
// first expand only; afterwards the component stays mounted so collapsing and
// re-opening the drawer is instant and keeps the camera position.
const PhotoMap = lazy(() => import("./PhotoMap.jsx"));

export default function MapDrawer({
  expanded,
  status,
  collectionId,
  search,
  filters,
  catalogKey,
  refreshToken,
  onViewportChange,
  onSelectAsset,
}) {
  const { t } = useTranslation("nav");
  // Once opened, stay mounted: tearing down on collapse would re-parse the
  // base-map data on every toggle.
  const hasOpenedRef = useRef(false);
  if (expanded) hasOpenedRef.current = true;

  const { points } = useMapPoints({
    enabled: hasOpenedRef.current,
    status,
    collectionId,
    search,
    filters,
    catalogKey,
    refreshToken,
  });

  if (!hasOpenedRef.current) return <div className="min-h-0 overflow-hidden" data-testid="map-drawer" />;

  return (
    <div
      className={`relative min-h-0 overflow-hidden ${expanded ? "border-b border-border/60" : ""}`}
      data-testid="map-drawer"
      data-expanded={expanded ? "true" : "false"}
    >
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center bg-chrome text-[12px] text-muted2">
            {t("map.loading")}
          </div>
        }
      >
        <PhotoMap
          points={points}
          visible={expanded}
          onViewportChange={onViewportChange}
          onSelectAsset={onSelectAsset}
          levelLabels={{
            world: t("map.level.world"),
            region: t("map.level.region"),
            city: t("map.level.city"),
          }}
        />
      </Suspense>
    </div>
  );
}
