// 发现页 — the "front page" of the library (ported from demo C's 发现):
// a hero card for what came in most recently, then horizontally scrolling
// rows: recently added photos, folders (manual collections) and people.
// Pure presentation over data the app already has; the only fetches are the
// recent slice and one cover per folder.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react";
import api from "../api";
import { fileName, localFileUrl } from "../utils/format";
import FaceCrop from "./FaceCrop";

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
    const g = map.get(key) || { key, year: d.getFullYear(), month: d.getMonth() + 1, count: 0, cover: item };
    g.count += 1;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => (b.key > a.key ? 1 : -1));
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

function itemDate(item) {
  const meta = item?.image_metadata || {};
  const v = item?.imported_at || meta.imported_at || meta.modified_time || item?.updated_at;
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function shortDate(d) {
  if (!d) return "";
  return d.toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-");
}

function cameraOf(item) {
  const meta = item?.image_metadata || {};
  return meta.camera_model || meta.camera || null;
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
  onSelectItem,
  onOpenItem,
  onOpenCollection,
  onOpenPerson,
  onShowRecent,
  onOpenMonth,
  onOpenPlace,
  onItemsChange,
}) {
  const { t } = useTranslation("nav");
  const [recent, setRecent] = useState([]);
  const [slice, setSlice] = useState([]);
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
    })();
    return () => { cancelled = true; };
  }, [catalogRevision]);
  // Keep the app's ordered item list in step with this page, so selecting a
  // card here does not read as "asset not on screen" and trigger a reveal
  // (which would yank the view back to the gallery).
  useEffect(() => { onItemsChange?.(recent); }, [recent, onItemsChange]);
  const months = groupMonths(slice);
  const places = groupPlaces(slice);
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

  const hero = recent[0] || null;
  // Hero is big: show the preview at once, then the original on top once it
  // has decoded (a 30MB JPEG can take a second).
  const heroPreview = hero ? localFileUrl(hero.preview_path || hero.image_path) : null;
  const heroFull = hero ? localFileUrl(hero.image_path || hero.preview_path) : null;
  const [heroFullReady, setHeroFullReady] = useState(false);
  useEffect(() => { setHeroFullReady(false); }, [heroFull]);
  // Empty folders have nothing to show on a cover row; the sidebar still lists them.
  const folderCards = manual.filter((c) => (c.item_count || 0) > 0);
  const newCount = Number(summary?.recently_added_count ?? recent.length);
  const heroDate = itemDate(hero);
  const heroFolder = manual.length ? manual[manual.length - 1] : null;

  return (
    <div data-testid="workspace-split" className="relative min-h-0 flex-1 overflow-hidden">
      <div data-testid="gallery-scroll" className="h-full overflow-y-auto px-6 pb-10">
        {hero ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => onSelectItem?.(hero.asset_id)}
            onDoubleClick={() => onOpenItem?.(hero.asset_id, recent)}
            onKeyDown={(e) => { if (e.key === "Enter") onOpenItem?.(hero.asset_id, recent); }}
            className="relative mb-2 h-[min(46vh,420px)] w-full cursor-pointer overflow-hidden rounded-[18px] bg-[var(--fill)]"
          >
            <img src={heroPreview} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
            <img
              src={heroFull}
              alt=""
              draggable={false}
              decoding="async"
              onLoad={() => setHeroFullReady(true)}
              className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${heroFullReady ? "opacity-100" : "opacity-0"}`}
            />
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_35%,rgba(0,0,0,.55)_100%)]" />
            <div className="pointer-events-none absolute bottom-7 left-8 right-8 text-white">
              <div className="text-[12px] text-white/70">{newCount > 0 ? t("discover.heroKicker") : t("discover.heroKickerQuiet")}</div>
              <div className="mt-2 truncate text-[40px] font-bold leading-none tracking-[-0.02em]">{heroFolder?.name || t("discover.recentTitle")}</div>
              <div className="mt-3 text-[13px] text-white/75">
                {t("discover.heroMeta", { count: newCount })}{heroDate ? ` · ${t("discover.updated", { date: shortDate(heroDate) })}` : ""}
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-2 flex h-[220px] items-center justify-center rounded-[18px] bg-[var(--fill)] text-[13px] text-muted2">
            {t("discover.empty")}
          </div>
        )}

        {recent.length > 0 && (
          <Row title={t("discover.recentTitle")} action={t("discover.showAll")} onAction={onShowRecent}>
            {recent.map((item) => {
              const d = itemDate(item);
              const cam = cameraOf(item);
              return (
                <button
                  key={item.asset_id}
                  type="button"
                  onClick={() => onSelectItem?.(item.asset_id)}
                  onDoubleClick={() => onOpenItem?.(item.asset_id, recent)}
                  className="w-[300px] shrink-0 text-left"
                >
                  <div className="h-[200px] w-[300px] overflow-hidden rounded-[14px] bg-[var(--fill)]">
                    <img src={localFileUrl(item.preview_path || item.image_path)} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />
                  </div>
                  <div className="mt-3 truncate text-[14px] font-medium text-text">{fileName(item.image_path) || item.stem}</div>
                  <div className="mt-1 truncate text-[12px] text-muted2">{[d ? shortDate(d) : null, cam].filter(Boolean).join(" · ")}</div>
                </button>
              );
            })}
          </Row>
        )}

        {folderCards.length > 0 && (
          <Row title={t("discover.foldersTitle")}>
            {folderCards.map((col) => {
              const cover = covers[col.collection_id]?.path;
              return (
                <button
                  key={col.collection_id}
                  type="button"
                  onClick={() => onOpenCollection?.(col.collection_id)}
                  className="w-[260px] shrink-0 text-left"
                >
                  <div className="flex h-[174px] w-[260px] items-center justify-center overflow-hidden rounded-[14px] bg-[var(--fill)]">
                    {cover
                      ? <img src={localFileUrl(cover)} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />
                      : <Folder className="h-7 w-7 stroke-[1.4] text-muted2" />}
                  </div>
                  <div className="mt-3 truncate text-[14px] font-medium text-text">{col.name}</div>
                  <div className="mt-1 text-[12px] text-muted2">{t("discover.folderMeta", { count: col.item_count || 0 })}</div>
                </button>
              );
            })}
          </Row>
        )}

        {(people || []).length > 0 && (
          <Row title={t("discover.peopleTitle")}>
            {(people || []).map((g) => (
              <button
                key={g.group_id || g.id}
                type="button"
                onClick={() => onOpenPerson?.(g)}
                className="w-[112px] shrink-0 text-center"
              >
                <div className="mx-auto h-[96px] w-[96px] overflow-hidden rounded-full bg-[var(--fill)]">
                  {(g.cover_preview_path || g.cover_image_path)
                    ? <FaceCrop src={localFileUrl(g.cover_preview_path || g.cover_image_path)} bbox={g.cover_bbox} size={96} className="h-full w-full" />
                    : null}
                </div>
                <div className="mt-2 truncate text-[13px] text-text">{g.name?.trim() || t("discover.unnamed")}</div>
                <div className="mt-0.5 text-[11px] text-muted2">{t("discover.folderMeta", { count: g.face_count || 0 })}</div>
              </button>
            ))}
          </Row>
        )}

        {places.length > 0 && (
          <Row title={t("discover.placesTitle")}>
            {places.map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => onOpenPlace?.(g.name)}
                className="w-[260px] shrink-0 text-left"
              >
                <div className="h-[174px] w-[260px] overflow-hidden rounded-[14px] bg-[var(--fill)]">
                  <img src={localFileUrl(g.cover.preview_path || g.cover.image_path)} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />
                </div>
                <div className="mt-3 truncate text-[14px] font-medium text-text">{g.name}</div>
                <div className="mt-1 truncate text-[12px] text-muted2">{[g.sub, t("discover.folderMeta", { count: g.count })].filter(Boolean).join(" · ")}</div>
              </button>
            ))}
          </Row>
        )}

        {months.length > 0 && (
          <Row title={t("discover.monthsTitle")}>
            {months.map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => onOpenMonth?.(g.year, g.month)}
                className="w-[260px] shrink-0 text-left"
              >
                <div className="h-[174px] w-[260px] overflow-hidden rounded-[14px] bg-[var(--fill)]">
                  <img src={localFileUrl(g.cover.preview_path || g.cover.image_path)} alt="" draggable={false} loading="lazy" className="h-full w-full object-cover" />
                </div>
                <div className="mt-3 truncate text-[14px] font-medium text-text">{monthLabel(g)}</div>
                <div className="mt-1 text-[12px] text-muted2">{t("discover.folderMeta", { count: g.count })}</div>
              </button>
            ))}
          </Row>
        )}
      </div>
    </div>
  );
}
