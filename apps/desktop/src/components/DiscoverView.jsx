// 发现页 — the library's front page, laid out like Apple Photos' Collections.
// Everything here is a collection the gallery can open as a clean filter:
//   回忆  one visit to a place (sidecar discover-collections: place + date run)
//   固定  fixed entries: recent / rated / RAW / map / people
//   相册  manual folders
//   人物  face groups
//   地点  small map + one tile per place
// Every tile is backed by a real photo; entries without a cover are hidden.
// Clicking never intersects with the previous gallery state — `onOpen` hands
// App a complete destination (status / filters / collection / map).
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import api from "../api";
import { localFileUrl } from "../utils/format";
import FaceCrop from "./FaceCrop";
import useMapPoints from "./map/useMapPoints";

const PhotoMap = lazy(() => import("./map/PhotoMap.jsx"));

// Fallback when the catalog has no located photos at all (no GPS, no AI
// locations, or the web build): memories become plain month groups.
const SLICE_LIMIT = 400;

const pad2 = (n) => String(n).padStart(2, "0");

function captureDate(item) {
  const v = item?.image_metadata?.capture_time || item?.capture_time || item?.created_at;
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function groupMonths(items) {
  const map = new Map();
  for (const item of items) {
    const d = captureDate(item);
    if (!d) continue;
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    const g = map.get(key) || { key, year: d.getFullYear(), month: d.getMonth() + 1, count: 0, cover: item };
    g.count += 1;
    if ((item.app_rating || 0) > (g.cover.app_rating || 0)) g.cover = item;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => (b.key > a.key ? 1 : -1));
}

// Gallery filter for one place/memory: the sidecar's padded bounds, at the
// same precision floor the map draws, labelled so the filter chip reads
// "Sausalito" instead of "map area" and survives the map drawer closing.
function geoFilterFor(entry, label) {
  return { mode: "bounds", ...entry.bounds, min_precision: "locality", label };
}

function Row({ title, meta, children }) {
  return (
    <section className="mt-9 first:mt-0">
      <div className="mb-4 flex items-end justify-between px-1">
        <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
        {meta ? <span className="text-[12px] text-muted2">{meta}</span> : null}
      </div>
      <div className="-mx-6 flex gap-4 overflow-x-auto px-6 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
    </section>
  );
}

// Square tile with the label on a dark gradient — pinned entries, albums, places.
function Tile({ cover, title, subtitle, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative h-[180px] w-[180px] shrink-0 overflow-hidden rounded-[14px] bg-[var(--fill-2)] text-left"
    >
      <img src={cover} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_55%,rgba(0,0,0,.55)_100%)]" />
      <div className="pointer-events-none absolute bottom-3 left-3.5 right-3.5 text-white">
        <div className="truncate text-[13px] font-semibold">{title}</div>
        {subtitle ? <div className="truncate text-[11px] text-white/75">{subtitle}</div> : null}
      </div>
    </button>
  );
}

// Big memory card: place (or month) as the title, date range below.
function MemoryCard({ cover, title, subtitle, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative h-[300px] w-[300px] shrink-0 overflow-hidden rounded-[18px] bg-[var(--fill)] text-left"
    >
      <img src={cover} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_45%,rgba(0,0,0,.6)_100%)]" />
      <div className="pointer-events-none absolute bottom-5 left-5 right-5 text-white">
        <div className="truncate text-[26px] font-bold leading-tight tracking-[-0.02em]">{title}</div>
        <div className="mt-1 truncate text-[12px] font-medium uppercase tracking-[0.04em] text-white/75">{subtitle}</div>
      </div>
    </button>
  );
}

export default function DiscoverView({
  collections,
  people,
  catalogRevision,
  catalogKey,
  onOpen,
  onOpenPerson,
  onOpenPeopleView,
}) {
  const { t, i18n } = useTranslation("nav");
  const locale = i18n.language || undefined;
  const zh = (i18n.language || "").toLowerCase().startsWith("zh");
  const nameOf = (entry) => (zh ? entry.name_zh : entry.name_en) || entry.name_en || entry.name_zh;
  const countryOf = (entry) => (zh ? entry.country_zh : entry.country_en) || entry.country_en || entry.country_zh || null;

  const [discover, setDiscover] = useState({ places: [], memories: [], loaded: false });
  const [months, setMonths] = useState([]);
  const [pinnedCovers, setPinnedCovers] = useState({}); // status → first asset
  const [covers, setCovers] = useState({}); // collection_id → { path, count }
  const manual = (collections || []).filter((c) => c.kind === "manual");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let out = { places: [], memories: [] };
      try {
        const res = await api.discoverCollections();
        if (res && typeof res === "object") out = { places: res.places || [], memories: res.memories || [] };
      } catch { /* sidecar without gazetteer: empty */ }
      if (cancelled) return;
      setDiscover({ ...out, loaded: true });
      if (!out.memories.length) {
        try {
          const rows = await api.browseImages({ status: "all", limit: SLICE_LIMIT, offset: 0, sort: "captured-desc" });
          if (!cancelled) setMonths(groupMonths(Array.isArray(rows) ? rows : []));
        } catch { if (!cancelled) setMonths([]); }
      } else {
        setMonths([]);
      }
      const next = {};
      for (const status of ["recent", "rated", "matched"]) {
        try {
          const rows = await api.browseImages({ status, limit: 1, offset: 0 });
          next[status] = Array.isArray(rows) ? rows[0] || null : null;
        } catch { next[status] = null; }
      }
      if (!cancelled) setPinnedCovers(next);
    })();
    return () => { cancelled = true; };
  }, [catalogRevision]);

  // The little map from the gallery drawer, scoped to the whole catalog.
  const { points } = useMapPoints({ enabled: true, status: "all", collectionId: null, search: "", filters: null, catalogKey, refreshToken: catalogRevision });

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

  const thumb = (item) => (item ? localFileUrl(item.preview_path || item.image_path) : null);
  const fmt = (iso, opts) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale, opts);
  const rangeLabel = (from, to) => {
    const year = from.slice(0, 4) === String(new Date().getFullYear()) ? {} : { year: "numeric" };
    if (from === to) return fmt(from, { month: "short", day: "numeric", ...year });
    if (from.slice(0, 7) === to.slice(0, 7)) return `${fmt(from, { month: "short", day: "numeric" })} – ${fmt(to, { day: "numeric", ...year })}`;
    return `${fmt(from, { month: "short", day: "numeric", ...year })} – ${fmt(to, { month: "short", day: "numeric", ...year })}`;
  };
  const monthLabel = (g) => new Date(g.year, g.month - 1, 1).toLocaleDateString(locale, { year: "numeric", month: "long" });
  const countLabel = (count) => t("discover.folderMeta", { count });

  const memories = discover.memories.filter((m) => m.cover_preview_path);
  const placeTiles = discover.places.filter((p) => p.cover_preview_path);
  const folderCards = manual.filter((c) => (c.item_count || 0) > 0 && covers[c.collection_id]?.path);
  const peopleWithFace = (people || []).filter((g) => g.cover_preview_path || g.cover_image_path);
  const mapCover = points.find((pt) => pt.preview_path);

  const pinned = [
    { key: "recent", label: t("discover.recentTitle"), cover: thumb(pinnedCovers.recent), onClick: () => onOpen?.({ status: "recent" }) },
    { key: "rated", label: t("discover.pinRated"), cover: thumb(pinnedCovers.rated), onClick: () => onOpen?.({ status: "rated" }) },
    { key: "raw", label: t("discover.pinRaw"), cover: thumb(pinnedCovers.matched), onClick: () => onOpen?.({ status: "matched" }) },
    { key: "map", label: t("discover.pinMap"), cover: mapCover ? localFileUrl(mapCover.preview_path) : null, onClick: () => onOpen?.({ map: {} }) },
    peopleWithFace[0]
      ? { key: "people", label: t("discover.peopleTitle"), cover: localFileUrl(peopleWithFace[0].cover_preview_path || peopleWithFace[0].cover_image_path), onClick: onOpenPeopleView }
      : null,
  ].filter((tile) => tile && tile.cover);

  const openMemory = (m) => onOpen?.({ filters: { date_from: m.date_from, date_to: m.date_to, geo: geoFilterFor(m, nameOf(m)) } });
  const openMonth = (g) => {
    const last = new Date(g.year, g.month, 0).getDate();
    onOpen?.({ filters: { date_from: `${g.year}-${pad2(g.month)}-01`, date_to: `${g.year}-${pad2(g.month)}-${pad2(last)}` } });
  };
  const openPlace = (p) => onOpen?.({ filters: { geo: geoFilterFor(p, nameOf(p)) } });
  // A marker on the overview map opens the gallery with its drawer flown there.
  const openMapAsset = (assetId) => {
    const pt = points.find((x) => x.asset_id === assetId);
    onOpen?.({ map: pt ? { flyTo: { lat: pt.latitude, lon: pt.longitude, zoom: 12 } } : {} });
  };

  const empty = discover.loaded && memories.length === 0 && months.length === 0 && pinned.length === 0 && folderCards.length === 0;

  return (
    <div data-testid="workspace-split" className="relative min-h-0 flex-1 overflow-hidden">
      <div data-testid="gallery-scroll" className="h-full overflow-y-auto px-6 pb-10">
        {empty ? (
          <div className="flex h-[220px] items-center justify-center rounded-[18px] bg-[var(--fill)] text-[13px] text-muted2">
            {t("discover.empty")}
          </div>
        ) : null}

        {(memories.length > 0 || months.length > 0) && (
          <Row title={t("discover.memories")}>
            {memories.map((m) => (
              <MemoryCard
                key={m.key}
                cover={localFileUrl(m.cover_preview_path)}
                title={nameOf(m)}
                subtitle={`${rangeLabel(m.date_from, m.date_to)} · ${countLabel(m.count)}`}
                onClick={() => openMemory(m)}
              />
            ))}
            {months.map((g) => (
              <MemoryCard key={g.key} cover={thumb(g.cover)} title={monthLabel(g)} subtitle={countLabel(g.count)} onClick={() => openMonth(g)} />
            ))}
          </Row>
        )}

        {pinned.length > 0 && (
          <Row title={t("discover.pinned")}>
            {pinned.map((tile) => <Tile key={tile.key} cover={tile.cover} title={tile.label} onClick={tile.onClick} />)}
          </Row>
        )}

        {folderCards.length > 0 && (
          <Row title={t("discover.albums")}>
            {folderCards.map((col) => (
              <Tile
                key={col.collection_id}
                cover={localFileUrl(covers[col.collection_id].path)}
                title={<><span className="mr-1.5 tabular-nums">{col.item_count || 0}</span>{col.name}</>}
                onClick={() => onOpen?.({ collectionId: col.collection_id })}
              />
            ))}
          </Row>
        )}

        {peopleWithFace.length > 0 && (
          <Row title={t("discover.peopleTitle")}>
            {peopleWithFace.map((g) => (
              <button key={g.group_id || g.id} type="button" onClick={() => onOpenPerson?.(g)} className="w-[112px] shrink-0 text-center">
                <div className="mx-auto h-[96px] w-[96px] overflow-hidden rounded-full bg-[var(--fill)]">
                  <FaceCrop src={localFileUrl(g.cover_preview_path || g.cover_image_path)} bbox={g.cover_bbox} size={96} className="h-full w-full" />
                </div>
                <div className="mt-2 truncate text-[13px] text-text">{g.name?.trim() || t("discover.unnamed")}</div>
                <div className="mt-0.5 text-[11px] text-muted2">{countLabel(g.face_count || 0)}</div>
              </button>
            ))}
          </Row>
        )}

        {(placeTiles.length > 0 || points.length > 0) && (
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
                    scrollZoom={false}
                    onSelectAsset={openMapAsset}
                    levelLabels={{ world: t("map.level.world"), region: t("map.level.region"), city: t("map.level.city") }}
                  />
                </Suspense>
              </div>
            )}
            {placeTiles.length > 0 && (
              <div className="-mx-6 flex gap-4 overflow-x-auto px-6 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {placeTiles.map((p) => (
                  <Tile
                    key={p.key}
                    cover={localFileUrl(p.cover_preview_path)}
                    title={nameOf(p)}
                    subtitle={[countryOf(p), countLabel(p.count)].filter(Boolean).join(" · ")}
                    onClick={() => openPlace(p)}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
