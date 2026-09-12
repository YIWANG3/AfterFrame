// 发现页 — the library's front page, laid out like Apple Photos' Collections.
// Everything here is a collection the gallery can open as a clean filter:
//   回忆  the newest visits to places (sidecar discover-collections: place + date run)
//   固定  fixed entries: recent / rated / RAW
//   相册  manual folders
//   人物  face groups
//   地点  one tile per place with enough photos
// Every tile is backed by a real photo; entries without a cover are hidden.
// Clicking never intersects with the previous gallery state — `onOpen` hands
// App a complete destination (status / filters / collection / map).
import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import api from "../api";
import { localFileUrl } from "../utils/format";
import FaceCrop from "./FaceCrop";

// Fallback when the catalog has no located photos at all (no GPS, no AI
// locations, or the web build): memories become plain month groups.
const SLICE_LIMIT = 400;

// 回忆 and 地点 both group by place; they must not be the same list twice.
// 回忆 is a feed of what happened lately (the newest visits only), 地点 is the
// full index (every place worth a tile). A place visited once shows up in
// 回忆 only while it is recent, and in 地点 for good.
const MEMORY_LIMIT = 12;
const PLACE_MIN_PHOTOS = 5;

const pad2 = (n) => String(n).padStart(2, "0");

// ── Page data cache ──
// The view is unmounted on every switch away, so without this each visit
// re-ran the sidecar's place clustering (~1s), three cover queries and one
// browse per folder. Keyed by catalog + revision: the same library state
// yields the same page, so re-entering is instant and a catalog change (import,
// rating, annotation) invalidates everything at once. App calls
// prefetchDiscover once the catalog is ready so even the first open is warm.
const pageCache = new Map(); // key → { data, promise }
const folderCoverCache = new Map(); // collection_id → { path, count }

function pageKey(catalogKey, catalogRevision) {
  return `${catalogKey || ""}#${catalogRevision || 0}`;
}

async function loadPageData() {
  // Everything in parallel: the sidecar clustering (~1s) must not queue
  // behind the cover queries or vice versa.
  const [discover, pinnedCovers] = await Promise.all([
    api.discoverCollections()
      .then((res) => (res && typeof res === "object" ? { places: res.places || [], memories: res.memories || [] } : { places: [], memories: [] }))
      .catch(() => ({ places: [], memories: [] })),
    // Pinned covers: newest import for 最近添加 / 含 RAW, the best-rated photo
    // for 已评分 — the tile should show the library's favourite, not the last one.
    Promise.all([["recent", undefined], ["rated", "rating-desc"], ["matched", undefined]].map(([status, sort]) =>
      api.browseImages({ status, limit: 1, offset: 0, sort })
        .then((rows) => [status, Array.isArray(rows) ? rows[0] || null : null])
        .catch(() => [status, null]),
    )).then(Object.fromEntries),
  ]);
  let months = [];
  if (!discover.memories.length) {
    try {
      const rows = await api.browseImages({ status: "all", limit: SLICE_LIMIT, offset: 0, sort: "captured-desc" });
      months = groupMonths(Array.isArray(rows) ? rows : []);
    } catch { months = []; }
  }
  return { discover, months, pinnedCovers };
}

// Last complete page per catalog, whatever its revision: shown immediately
// while the current revision loads, so a rating or an import never blanks
// the memories row on the next visit.
const latestByCatalog = new Map();

export function prefetchDiscover({ catalogKey, catalogRevision }) {
  const key = pageKey(catalogKey, catalogRevision);
  const hit = pageCache.get(key);
  if (hit) return hit.promise;
  const entry = { data: null, promise: null };
  entry.promise = loadPageData().then((data) => {
    entry.data = data;
    latestByCatalog.set(catalogKey || "", data);
    return data;
  });
  // Keep the last two revisions only; older ones can never be asked for again.
  pageCache.set(key, entry);
  while (pageCache.size > 2) pageCache.delete(pageCache.keys().next().value);
  return entry.promise;
}

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

function Row({ id, title, meta, children }) {
  return (
    <section id={`discover-${id}`} data-discover-section={id} className="mt-9 first:mt-0">
      <div className="mb-4 flex items-end justify-between px-1">
        <h2 tabIndex={-1} className="text-[22px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
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
}) {
  const { t, i18n } = useTranslation("nav");
  const locale = i18n.language || undefined;
  const scrollRef = useRef(null);
  const [activeSection, setActiveSection] = useState(null);
  // Place names are shown in English in every locale: the gazetteer's Chinese
  // labels come from Wikidata's generic `zh` label, which mixes Traditional
  // and Simplified (舊金山 next to 纽约), and the user preferred English over
  // a conversion table.
  const nameOf = (entry) => entry.name_en || entry.name_zh;
  const countryOf = (entry) => entry.country_en || entry.country_zh || null;

  const key = pageKey(catalogKey, catalogRevision);
  // Synchronous cache hit → the page paints complete on the first frame. On a
  // revision miss the catalog's previous page stays on screen while the new
  // one loads, rather than flashing empty.
  const [page, setPage] = useState(() => pageCache.get(key)?.data || latestByCatalog.get(catalogKey || "") || null);
  const [covers, setCovers] = useState(() => Object.fromEntries(folderCoverCache));
  const manual = (collections || []).filter((c) => c.kind === "manual");

  useEffect(() => {
    let cancelled = false;
    const hit = pageCache.get(key)?.data;
    if (hit) {
      setPage(hit);
      return undefined;
    }
    prefetchDiscover({ catalogKey, catalogRevision }).then((data) => {
      if (!cancelled) setPage(data);
    });
    return () => { cancelled = true; };
  }, [key, catalogKey, catalogRevision]);
  const discover = page?.discover || { places: [], memories: [] };
  const months = page?.months || [];
  const pinnedCovers = page?.pinnedCovers || {};

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
      if (cancelled) return;
      for (const [id, entry] of Object.entries(next)) folderCoverCache.set(id, entry);
      setCovers((prev) => ({ ...prev, ...next }));
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

  const memories = discover.memories.filter((m) => m.cover_preview_path).slice(0, MEMORY_LIMIT);
  const placeTiles = discover.places.filter((p) => p.cover_preview_path && p.count >= PLACE_MIN_PHOTOS);
  const folderCards = manual.filter((c) => (c.item_count || 0) > 0 && covers[c.collection_id]?.path);
  const peopleWithFace = (people || []).filter((g) => g.cover_preview_path || g.cover_image_path);
  const pinned = [
    { key: "recent", label: t("discover.recentTitle"), cover: thumb(pinnedCovers.recent), onClick: () => onOpen?.({ status: "recent" }) },
    { key: "rated", label: t("discover.pinRated"), cover: thumb(pinnedCovers.rated), onClick: () => onOpen?.({ status: "rated" }) },
    { key: "raw", label: t("discover.pinRaw"), cover: thumb(pinnedCovers.matched), onClick: () => onOpen?.({ status: "matched" }) },
  ].filter((tile) => tile.cover);

  const openMemory = (m) => onOpen?.({ filters: { date_from: m.date_from, date_to: m.date_to, geo: geoFilterFor(m, nameOf(m)) } });
  const openMonth = (g) => {
    const last = new Date(g.year, g.month, 0).getDate();
    onOpen?.({ filters: { date_from: `${g.year}-${pad2(g.month)}-01`, date_to: `${g.year}-${pad2(g.month)}-${pad2(last)}` } });
  };
  const openPlace = (p) => onOpen?.({ filters: { geo: geoFilterFor(p, nameOf(p)) } });
  const sections = [
    { id: "memories", label: t("discover.memories"), visible: memories.length || months.length },
    { id: "pinned", label: t("discover.pinned"), visible: pinned.length },
    { id: "albums", label: t("discover.albums"), visible: folderCards.length },
    { id: "people", label: t("discover.peopleTitle"), visible: peopleWithFace.length },
    { id: "places", label: t("discover.placesTitle"), visible: placeTiles.length },
  ].filter(section => section.visible);
  const empty = !!page && !sections.length;
  const currentSection = sections.some(section => section.id === activeSection) ? activeSection : sections[0]?.id;
  const updateSection = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rows = [...scroller.querySelectorAll("[data-discover-section]")];
    const top = scroller.getBoundingClientRect().top + 90;
    const atBottom = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    const row = atBottom ? rows.at(-1) : rows.filter(el => el.getBoundingClientRect().top <= top).at(-1) || rows[0];
    if (row) setActiveSection(row.dataset.discoverSection);
  };
  const jumpToSection = (id) => {
    const scroller = scrollRef.current;
    const row = scroller?.querySelector(`[data-discover-section="${id}"]`);
    if (!row) return;
    row.querySelector("h2")?.focus({ preventScroll: true });
    scroller.scrollTo({
      top: scroller.scrollTop + row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 72,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    setActiveSection(id);
  };

  return (
    <div data-testid="workspace-split" className="discover-view relative min-h-0 flex-1 overflow-hidden">
      <div className="discover-drag-region" aria-hidden="true" />
      {sections.length > 0 && (
        <nav className="discover-navigation" aria-label={t("discover.navigation")}>
          {sections.map(section => (
            <button key={section.id} type="button" aria-controls={`discover-${section.id}`}
              aria-current={currentSection === section.id ? "location" : undefined}
              onClick={() => jumpToSection(section.id)}>
              {section.label}
            </button>
          ))}
        </nav>
      )}
      <div ref={scrollRef} onScroll={updateSection} data-testid="gallery-scroll" className="h-full overflow-y-auto px-6 pb-10">
        {empty ? (
          <div className="flex h-[220px] items-center justify-center rounded-[18px] bg-[var(--fill)] text-[13px] text-muted2">
            {t("discover.empty")}
          </div>
        ) : null}

        {(memories.length > 0 || months.length > 0) && (
          <Row id="memories" title={t("discover.memories")}>
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
          <Row id="pinned" title={t("discover.pinned")}>
            {pinned.map((tile) => <Tile key={tile.key} cover={tile.cover} title={tile.label} onClick={tile.onClick} />)}
          </Row>
        )}

        {folderCards.length > 0 && (
          <Row id="albums" title={t("discover.albums")}>
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
          <Row id="people" title={t("discover.peopleTitle")}>
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

        {placeTiles.length > 0 && (
          <Row id="places" title={t("discover.placesTitle")}>
            {placeTiles.map((p) => (
              <Tile
                key={p.key}
                cover={localFileUrl(p.cover_preview_path)}
                title={nameOf(p)}
                subtitle={[countryOf(p), countLabel(p.count)].filter(Boolean).join(" · ")}
                onClick={() => openPlace(p)}
              />
            ))}
          </Row>
        )}
      </div>
    </div>
  );
}
