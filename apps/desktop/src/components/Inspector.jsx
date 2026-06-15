import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Star, Copy, Layers, AlertTriangle, Link2 } from "lucide-react";
import { fileName, escapePathLabel, formatBytes, formatTimestamp, localFileUrl, formatShutterSpeed, formatAperture, formatFocalLength, formatISO } from "../utils/format";
import AnnotationsSection from "./AnnotationsSection";

function StarRating({ value = 0, onChange }) {
  const [hover, setHover] = useState(0);
  const display = hover || value;
  return (
    <div className="flex gap-0.5" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          className="p-0.5 transition-colors"
          onMouseEnter={() => setHover(i)}
          onClick={() => onChange?.(i === value ? 0 : i)}
        >
          <Star
            className={`h-3.5 w-3.5 ${i <= display ? "fill-[rgb(225,180,105)] text-[rgb(225,180,105)]" : "text-muted2/40 hover:text-muted2/60"}`}
          />
        </button>
      ))}
    </div>
  );
}

function DetailRow({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[12px] leading-[1.4]">
      <div className="shrink-0 text-muted">{label}</div>
      <div className="min-w-0 break-words text-right text-text">{children}</div>
    </div>
  );
}

function Section({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-4 border-t border-border/40 pt-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{title}</span>
        <ChevronRight className={`h-3 w-3 text-muted2 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}

function formatGPS(lat, lon) {
  if (lat == null || lon == null) return null;
  const latDir = lat >= 0 ? "N" : "S";
  const lonDir = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lon).toFixed(4)}° ${lonDir}`;
}

function ThumbnailStrip({ items, icon: Icon, onSelect }) {
  if (!items?.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {items.map((item) => (
        <button
          key={item.asset_id}
          type="button"
          className="group relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-black transition-all hover:ring-2 hover:ring-accent/50"
          onClick={() => onSelect?.(item.asset_id)}
          title={item.stem}
        >
          {item.preview_path ? (
            <img src={localFileUrl(item.preview_path)} alt={item.stem} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[8px] text-muted2">—</div>
          )}
          {Icon ? (
            <div className="absolute bottom-0.5 right-0.5 rounded bg-black/50 p-0.5">
              <Icon className="h-2 w-2 text-white/60" />
            </div>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export default function Inspector({ detail, onRatingChange, onSelectAsset, onTagFilter, onRelinked, pushToast }) {
  const { t } = useTranslation("inspector");
  const [localRating, setLocalRating] = useState(null);
  const [relinking, setRelinking] = useState(false);
  const currentAssetId = detail?.asset_id || detail?.image_path || null;

  useEffect(() => {
    setLocalRating(null);
  }, [currentAssetId]);

  async function handleRelink() {
    if (!detail?.asset_id || relinking) return;
    setRelinking(true);
    try {
      let res = await window.mediaWorkspace?.relinkAsset?.({ assetId: detail.asset_id });
      if (res?.status === "fingerprint_mismatch") {
        const proceed = window.confirm(t("missing.mismatchConfirm"));
        if (!proceed) return;
        res = await window.mediaWorkspace?.relinkAsset?.({
          assetId: detail.asset_id,
          newPath: res.candidate_path,
          force: true,
        });
      }
      if (res?.status === "relinked") {
        pushToast?.({ title: t("toast.relinked"), message: t("toast.relinkedMsg"), ttl: 4000 });
        onRelinked?.();
      } else if (res && res.status !== "cancelled") {
        pushToast?.({ title: t("toast.relinkFailed"), message: String(res.status || "Unknown error"), ttl: 6000, tone: "error" });
      }
    } catch (err) {
      pushToast?.({ title: t("toast.relinkFailed"), message: err?.message || String(err), ttl: 6000, tone: "error" });
    } finally {
      setRelinking(false);
    }
  }

  if (!detail) {
    return (
      <aside className="flex h-full items-center justify-center overflow-y-auto bg-chrome px-4">
        <div className="text-center">
          <div className="text-[12px] text-muted">{t("selectAsset")}</div>
        </div>
      </aside>
    );
  }

  const missing = detail.exists_on_disk === false;
  const previewPath = detail.image_preview_path || detail.raw_preview_path;
  const imageMeta = detail.image_metadata || {};
  const rawMeta = detail.raw_metadata || {};
  const imageName = fileName(detail.image_path);
  const rawName = fileName(detail.raw_path || "");
  const formatValue = (detail.image_path || "").split(".").pop()?.toUpperCase() || t("unknown");
  const dimensions = imageMeta.width && imageMeta.height ? `${imageMeta.width} × ${imageMeta.height}` : t("unknown");
  const fileSize = formatBytes(imageMeta.file_size || imageMeta.size_bytes) || t("unknown");

  const metaRating = Number(detail.app_rating ?? rawMeta.rating ?? imageMeta.rating ?? 0);
  const rating = localRating ?? metaRating;
  const gps = formatGPS(
    rawMeta.gps_latitude ?? imageMeta.gps_latitude,
    rawMeta.gps_longitude ?? imageMeta.gps_longitude,
  );

  const exposureMeta = rawMeta.capture_time ? rawMeta : imageMeta;
  const aperture = formatAperture(exposureMeta.aperture);
  const shutter = formatShutterSpeed(exposureMeta.shutter_speed);
  const iso = formatISO(exposureMeta.iso);
  const focal = formatFocalLength(exposureMeta.focal_length);
  const hasExposure = aperture || shutter || iso || focal;

  const isVideo = detail.asset_type === "video";
  const videoDuration = (() => {
    const total = Math.round(Number(imageMeta.duration) || 0);
    if (total <= 0) return null;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
  })();
  const videoFps = imageMeta.fps ? `${Math.round(Number(imageMeta.fps))} fps` : null;
  const videoCodec = imageMeta.codec ? String(imageMeta.codec).toUpperCase() : null;

  return (
    <aside className="flex h-full flex-col overflow-hidden border-l border-border/40 bg-chrome">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="relative mb-4 flex h-[200px] items-center justify-center overflow-hidden">
          {previewPath ? (
            <img src={localFileUrl(previewPath)} alt={detail.stem} className="max-h-full max-w-full object-contain" draggable={false} />
          ) : (
            <div className="flex items-center justify-center text-[12px] text-muted">{t("noPreview")}</div>
          )}
          <span className="absolute left-2 top-2 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {formatValue}
          </span>
        </div>

        <div className="px-0.5">
          <h2 className="text-[13px] font-medium leading-tight text-text">{imageName || detail.stem}</h2>

          {missing ? (
            <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-[rgba(239,159,39,0.42)] bg-[rgba(120,70,8,0.18)] px-2.5 py-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#EF9F27]" />
              <div className="min-w-0">
                <div className="text-[12px] leading-tight text-[#FAC775]">{t("missing.banner")}</div>
                <div className="mt-0.5 text-[11px] leading-tight text-[#9a8f7a]">
                  {t("missing.hint")}
                </div>
                <button
                  type="button"
                  disabled={relinking}
                  onClick={handleRelink}
                  className="mt-2 inline-flex items-center gap-1 rounded-md bg-[#EF9F27] px-2.5 py-1 text-[11px] font-medium text-[#412402] transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  <Link2 className="h-3 w-3" />
                  {relinking ? t("missing.relinking") : t("missing.relink")}
                </button>
              </div>
            </div>
          ) : null}

          {detail.collage_sources?.length > 0 ? (
            <div className="mt-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{t("sections.sourceImages")}</div>
              <ThumbnailStrip items={detail.collage_sources} onSelect={onSelectAsset} />
            </div>
          ) : null}

          {detail.version_siblings?.length > 0 ? (
            <div className="mt-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{t("sections.otherVersions")}</div>
              <ThumbnailStrip items={detail.version_siblings} onSelect={onSelectAsset} />
            </div>
          ) : null}

          <Section title={t("sections.properties")}>
            <DetailRow label={t("rows.rating")}>
              <StarRating
                value={rating}
                onChange={(next) => {
                  setLocalRating(next);
                  onRatingChange?.(next);
                }}
              />
            </DetailRow>
            <DetailRow label={t("rows.dimensions")}>{dimensions}</DetailRow>
            {isVideo && videoDuration ? <DetailRow label={t("rows.duration")}>{videoDuration}</DetailRow> : null}
            <DetailRow label={t("rows.size")}>{fileSize}</DetailRow>
            <DetailRow label={t("rows.type")}>{formatValue}</DetailRow>
            {isVideo && videoCodec ? (
              <DetailRow label={t("rows.codec")}>{videoCodec}{videoFps ? ` · ${videoFps}` : ""}</DetailRow>
            ) : null}
          </Section>

          <AnnotationsSection
            assetId={detail.asset_id}
            imagePath={detail.image_path || detail.image_preview_path || detail.raw_preview_path}
            onTagClick={onTagFilter}
            pushToast={pushToast}
          />

          <Section title={t("sections.source")}>
            <DetailRow label={t("rows.asset")}>
              {missing ? (
                <span className="flex min-w-0 items-center justify-end gap-1.5">
                  <span className="shrink-0 rounded border border-[rgba(239,159,39,0.42)] px-1 text-[10px] text-[#EF9F27]">{t("missing.badge")}</span>
                  <span className="truncate text-muted2 line-through">{escapePathLabel(detail.image_path)}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className="max-w-full cursor-pointer break-all text-right text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent hover:decoration-accent/60"
                  onClick={() => void window.mediaWorkspace?.revealPath?.(detail.image_path)}
                  title={t("reveal")}
                >
                  {escapePathLabel(detail.image_path)}
                </button>
              )}
            </DetailRow>
            <DetailRow label={t("rows.rawSource")}>
              {detail.raw_path ? (
                <button
                  type="button"
                  className="max-w-full cursor-pointer break-all text-right text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent hover:decoration-accent/60"
                  onClick={() => void window.mediaWorkspace?.revealPath?.(detail.raw_path)}
                  title={t("reveal")}
                >
                  {escapePathLabel(detail.raw_path)}
                </button>
              ) : t("notLinked")}
            </DetailRow>
            {imageMeta.software ? <DetailRow label={t("rows.lastEditedBy")}>{imageMeta.software}</DetailRow> : null}
          </Section>

          {!isVideo ? (
            <Section title={t("sections.camera")}>
              <DetailRow label={t("rows.camera")}>{rawMeta.camera_model || imageMeta.camera_model || "—"}</DetailRow>
              <DetailRow label={t("rows.lens")}>{rawMeta.lens_model || imageMeta.lens_model || "—"}</DetailRow>
            </Section>
          ) : null}

          {hasExposure ? (
            <Section title={t("sections.exposure")}>
              {focal ? <DetailRow label={t("rows.focalLength")}>{focal}</DetailRow> : null}
              {aperture ? <DetailRow label={t("rows.aperture")}>{aperture}</DetailRow> : null}
              {shutter ? <DetailRow label={t("rows.shutter")}>{shutter}</DetailRow> : null}
              {iso ? <DetailRow label={t("rows.iso")}>{iso}</DetailRow> : null}
            </Section>
          ) : null}

          <Section title={t("sections.dates")}>
            <DetailRow label={t("rows.imported")}>{formatTimestamp(detail.imported_at || imageMeta.imported_at)}</DetailRow>
            <DetailRow label={t("rows.captured")}>{formatTimestamp(rawMeta.capture_time || imageMeta.capture_time)}</DetailRow>
            <DetailRow label={t("rows.modified")}>{formatTimestamp(imageMeta.modified_time || detail.updated_at)}</DetailRow>
          </Section>

          {gps ? (
            <Section title={t("sections.location")}>
              <DetailRow label={t("rows.gps")}>{gps}</DetailRow>
            </Section>
          ) : null}

          {detail.duplicates?.length > 0 ? (
            <Section title={t("sections.duplicates")}>
              <div className="mt-1 space-y-1.5">
                {detail.duplicates.map((dup) => (
                  <button
                    key={dup.asset_id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
                    onClick={() => void window.mediaWorkspace?.revealPath?.(dup.image_path)}
                    title={t("reveal")}
                  >
                    <Copy className="h-3 w-3 shrink-0 text-muted2" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] text-text">{dup.stem}</div>
                      <div className="truncate text-[10px] text-muted">{escapePathLabel(dup.image_path)}</div>
                    </div>
                  </button>
                ))}
              </div>
            </Section>
          ) : null}

        </div>
      </div>
    </aside>
  );
}
