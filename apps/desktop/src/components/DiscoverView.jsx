// 发现页 — the library's front page, laid out like Apple Photos' Collections:
// 回忆 (one big card per month, titled by that month's most-photographed place),
// 固定 (square entries into recent / rated / RAW / map / people), 相册 (manual
// folders), 人物 (face circles) and 地点 (small map + place tiles). Nothing here
// is a single photo, and every tile is backed by a real photo — entries without
// a cover are hidden rather than drawn as icons.
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import api from "../api";
import { localFileUrl } from "../utils/format";
import FaceCrop from "./FaceCrop";
import useMapPoints from "./map/useMapPoints";

// Same lazy chunk as the gallery's map drawer, so the base map is only parsed once.
const PhotoMap = lazy(() => import("./map/PhotoMap.jsx"));

const RECENT_LIMIT = 16;
// One slice of the newest captures feeds both 按月回顾 and 地点: enough for a
// year or two of shooting without pulling a 5000-photo catalog into memory.
const SLICE_LIMIT = 400;

function captureDate(item) {
  const meta = item?.image_metadata || {};
  const v = meta.capture_time || item?.imported_at || meta.imported_at || meta.modified_time;
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function placeOf(item) {
  const loc = item?.annotation?.location;
  if (!loc) return null;
  const name = loc.locality || loc.admin1 || loc.region || loc.landmark || loc.country;
  if (!name) return null;
  const sub = loc.country && loc.country !== name ? loc.country : null;
  return { key: `${name}|${sub || ""}`, name, sub };
}

function groupMonths(items) {
  const map = new Map();
  for (const item of items) {
    const d = captureDate(item);
    if (!d) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const g = map.get(key) || { key, year: d.getFullYear(), month: d.getMonth() + 1, count: 0, cover: item, places: new Map() };
    g.count += 1;
    const pl = placeOf(item);
    if (pl) g.places.set(pl.name, (g.places.get(pl.name) || 0) + 1);
    map.set(key, g);
  }
  // A memory is titled by where most of that month's photos were taken.
  return [...map.values()]
    .map((g) => ({ ...g, place: [...g.places.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null }))
    .sort((a, b) => (b.key > a.key ? 1 : -1));
}

function groupPlaces(items) {
  const map = new Map();
  for (const item of items) {
    const p = placeOf(item);
    if (!p) continue;
    const g = map.get(p.key) || { ...p, count: 0, cover: item };
    g.count += 1;
    map.set(p.key, g);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function Row({ title, action, onAction, children }) {
  return (
    <section className="mt-9 first:mt-0">
      <div className="mb-4 flex items-end justify-between px-1">
        <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
        {action && onAction ? (
          <button type="button" onClick={onAction} className="text-[12px] text-muted transition-colors hover:text-text">{action}</button>
        ) : null}
      </div>
      <div className="-mx-6 flex gap-4 overflow-x-auto px-6 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
    </section>
  );
}

export default function DiscoverView({
  summary,
  collections,
  people,
  catalogRevision,
  onOpenItem,
  onOpenCollection,
  onOpenPerson,
  onShowRecent,
  onOpenMonth,
  onOpenPlace,
  onItemsChange,
  catalogKey,
  onShowStatus,
  onOpenMap,
  onOpenPeopleView,
}) {
  const { t } = useTranslation("nav");
  const [recent, setRecent] = useState([]);
  const [slice, setSlice] = useState([]);
  const [pinnedCovers, setPinnedCovers] = useState({}); // rated / matched → first asset
  const [covers, setCovers] = useState({});
  const manual = (collections || []).filter((c) => c.kind === "manual");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.browseImages({ status: "recent", limit: RECENT_LIMIT, offset: 0 });
        if (!cancelled) setRecent(Array.isArray(rows) ? rows : []);
      } catch { if (!cancelled) setRecent([]); }
      try {
        const rows = await api.browseImages({ status: "all", limit: SLICE_LIMIT, offset: 0, sort: "captured-desc" });
        if (!cancelled) setSlice(Array.isArray(rows) ? rows : []);
      } catch { if (!cancelled) setSlice([]); }
      const next = {};
      for (const status of ["rated", "matched"]) {
        try {
          const rows = await api.browseImages({ status, limit: 1, offset: 0 });
          next[status] = Array.isArray(rows) ? rows[0] || null : null;
        } catch { next[status] = null; }
      }
      if (!cancelled) setPinnedCovers(next);
    })();
    return () => { cancelled = true; };
  }, [catalogRevision]);
  // Keep the app's ordered item list in step with this page, so selecting a
  // card here does not read as "asset not on screen" and trigger a reveal
  // (which would yank the view back to the gallery).
  useEffect(() => { onItemsChange?.(recent); }, [recent, onItemsChange]);
  const months = groupMonths(slice);
  const places = groupPlaces(slice);
  // The little map from the gallery drawer, scoped to the whole catalog.
  const { points } = useMapPoints({ enabled: true, status: "all", collectionId: null, search: "", filters: null, catalogKey, refreshToken: catalogRevision });
  const monthLabel = (g) => new Date(g.year, g.month - 1, 1).toLocaleDateString([], { year: "numeric", month: "long" });

  const coverKey = manual.map((c) => `${c.collection_id}:${c.item_count || 0}`).join("|");
  useEffect(() => {
    let cancelled = false;
    const stale = manual.filter((c) => (c.item_count || 0) > 0 && covers[c.collection_id]?.count !== (c.item_count || 0));
    if (!stale.length) return undefined;
    (async () => {
      const next = {};
      await Promise.all(stale.map(async (c) => {
        try {
          const rows = await api.browseCollection(c.collection_id, { limit: 1, offset: 0 });
          const first = Array.isArray(rows) ? rows[0] : rows?.items?.[0];
          next[c.collection_id] = { path: first?.preview_path || first?.image_path || null, count: c.item_count || 0 };
        } catch { next[c.collection_id] = { path: null, count: c.item_count || 0 }; }
      }));
      if (!cancelled) setCovers((prev) => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverKey]);

  // Every tile on this page is backed by a real photo: folders without a loaded cover stay out.
  const folderCards = manual.filter((c) => (c.item_count || 0) > 0 && covers[c.collection_id]?.path);

  const thumb = (item) => (item ? localFileUrl(item.preview_path || item.image_path) : null);
  const peopleWithFace = (people || []).filter((g) => g.cover_preview_path || g.cover_image_path);
  const firstPerson = (people || []).find((g) => g.cover_preview_path || g.cover_image_path);
  const pinned = [
    { key: "recent", label: t("discover.recentTitle"), cover: thumb(recent[0]), onClick: onShowRecent },
    Number(summary?.rated_count ?? 0) > 0 ? { key: "rated", label: t("discover.pinRated"), cover: thumb(pinnedCovers.rated), onClick: () => onShowStatus?.("rated") } : null,
    Number(summary?.raw_assets ?? 0) > 0 ? { key: "raw", label: t("discover.pinRaw"), cover: thumb(pinnedCovers.matched), onClick: () => onShowStatus?.("matched") } : null,
    { key: "map", label: t("discover.pinMap"), cover: thumb(points.find((pt) => pt.preview_path)), onClick: onOpenMap },
    firstPerson ? { key: "people", label: t("discover.peopleTitle"), cover: localFileUrl(firstPerson.cover_preview_path || firstPerson.cover_image_path), onClick: onOpenPeopleView } : null,
  ].filter((tile) => tile && tile.cover);

  return (
    <div data-testid="workspace-split" className="relative min-h-0 flex-1 overflow-hidden">
      <div data-testid="gallery-scroll" className="h-full overflow-y-auto px-6 pb-10">
        {months.length === 0 && recent.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center rounded-[18px] bg-[var(--fill)] text-[13px] text-muted2">
            {t("discover.empty")}
          </div>
        ) : null}

        {/* 回忆:按月一张大卡,标题 = 当月照片最多的地点,副标题 = 月份 */}
        {months.length > 0 && (
          <Row title={t("discover.memories")}>
            {months.map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => onOpenMonth?.(g.year, g.month)}
                className="group relative h-[300px] w-[300px] shrink-0 overflow-hidden rounded-[18px] bg-[var(--fill)] text-left"
              >
                <img src={thumb(g.cover)} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_45%,rgba(0,0,0,.6)_100%)]" />
                <div className="pointer-events-none absolute bottom-5 left-5 right-5 text-white">
                  <div className="truncate text-[26px] font-bold leading-tight tracking-[-0.02em]">{g.place || monthLabel(g)}</div>
                  <div className="mt-1 text-[12px] font-medium uppercase tracking-[0.04em] text-white/75">{g.place ? monthLabel(g) : t("discover.folderMeta", { count: g.count })}</div>
                </div>
              </button>
            ))}
          </Row>
        )}

        {/* 固定:通往各视图的方块入口 */}
        {pinned.length > 0 && (
          <Row title={t("discover.pinned")}>
            {pinned.map((tile) => (
              <button
                key={tile.key}
                type="button"
                onClick={() => tile.onClick?.()}
                className="relative h-[180px] w-[180px] shrink-0 overflow-hidden rounded-[14px] bg-[var(--fill-2)] text-left"
              >
                <img src={tile.cover} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_55%,rgba(0,0,0,.55)_100%)]" />
                <div className="pointer-events-none absolute bottom-3 left-3.5 right-3.5 truncate text-[13px] font-semibold text-white">{tile.label}</div>
              </button>
            ))}
          </Row>
        )}

        {/* 相册:文件夹方块,「张数 名称」压在图上 */}
        {folderCards.length > 0 && (
          <Row title={t("discover.albums")}>
            {folderCards.map((col) => {
              const cover = covers[col.collection_id]?.path;
              return (
                <button
                  key={col.collection_id}
                  type="button"
                  onClick={() => onOpenCollection?.(col.collection_id)}
                  className="relative h-[180px] w-[180px] shrink-0 overflow-hidden rounded-[14px] bg-[var(--fill-2)] text-left"
                >
                  <img src={localFileUrl(cover)} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />
                  <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_55%,rgba(0,0,0,.55)_100%)]" />
                  <div className="pointer-events-none absolute bottom-3 left-3.5 right-3.5 truncate text-[13px] font-semibold text-white">
                    <span className="mr-1.5 tabular-nums">{col.item_count || 0}</span>{col.name}
                  </div>
                </button>
              );
            })}
          </Row>
        )}

        {peopleWithFace.length > 0 && (
          <Row title={t("discover.peopleTitle")}>
            {peopleWithFace.map((g) => (
              <button
                key={g.group_id || g.id}
                type="button"
                onClick={() => onOpenPerson?.(g)}
                className="w-[112px] shrink-0 text-center"
              >
                <div className="mx-auto h-[96px] w-[96px] overflow-hidden rounded-full bg-[var(--fill)]">
                  <FaceCrop src={localFileUrl(g.cover_preview_path || g.cover_image_path)} bbox={g.cover_bbox} size={96} className="h-full w-full" />
                </div>
                <div className="mt-2 truncate text-[13px] text-text">{g.name?.trim() || t("discover.unnamed")}</div>
                <div className="mt-0.5 text-[11px] text-muted2">{t("discover.folderMeta", { count: g.face_count || 0 })}</div>
              </button>
            ))}
          </Row>
        )}

        {(places.length > 0 || points.length > 0) && (
          <section className="mt-9">
            <div className="mb-4 flex items-end justify-between px-1">
              <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-text">{t("discover.placesTitle")}</h2>
              <span className="text-[12px] text-muted2">{t("discover.mapMeta", { count: points.length })}</span>
            </div>
            {points.length > 0 && (
              <div className="mb-4 h-[280px] w-full overflow-hidden rounded-[14px] bg-[var(--fill)]">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-[12px] text-muted2">{t("map.loading")}</div>}>
                  <PhotoMap
                    points={points}
                    visible
                    onSelectAsset={(assetId) => onOpenItem?.(assetId)}
                    levelLabels={{ world: t("map.level.world"), region: t("map.level.region"), city: t("map.level.city") }}
                  />
                </Suspense>
              </div>
            )}
            {places.length > 0 && (
              <div className="-mx-6 flex gap-4 overflow-x-auto px-6 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {places.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => onOpenPlace?.(g.name)}
                    className="relative h-[180px] w-[180px] shrink-0 overflow-hidden rounded-[14px] bg-[var(--fill-2)] text-left"
                  >
                    <img src={thumb(g.cover)} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />
                    <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_55%,rgba(0,0,0,.55)_100%)]" />
                    <div className="pointer-events-none absolute bottom-3 left-3.5 right-3.5 text-white">
                      <div className="truncate text-[13px] font-semibold">{g.name}</div>
                      <div className="truncate text-[11px] text-white/75">{[g.sub, t("discover.folderMeta", { count: g.count })].filter(Boolean).join(" · ")}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
