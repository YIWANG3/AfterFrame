import { useEffect, useState } from "react";
import { ChevronRight, Star, Copy, Layers } from "lucide-react";
import { fileName, escapePathLabel, formatBytes, formatTimestamp, localFileUrl, formatShutterSpeed, formatAperture, formatFocalLength, formatISO } from "../utils/format";

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

export default function Inspector({ detail, onRatingChange, onSelectAsset }) {
  const [localRating, setLocalRating] = useState(null);
  const currentAssetId = detail?.asset_id || detail?.export_path || null;

  useEffect(() => {
    setLocalRating(null);
  }, [currentAssetId]);

  if (!detail) {
    return (
      <aside className="flex h-full items-center justify-center overflow-y-auto bg-chrome px-4">
        <div className="text-center">
          <div className="text-[12px] text-muted">Select an asset</div>
        </div>
      </aside>
    );
  }

  const previewPath = detail.export_preview_path || detail.raw_preview_path;
  const exportMeta = detail.export_metadata || {};
  const rawMeta = detail.raw_metadata || {};
  const exportName = fileName(detail.export_path);
  const rawName = fileName(detail.raw_path || "");
  const formatValue = (detail.export_path || "").split(".").pop()?.toUpperCase() || "Unknown";
  const dimensions = exportMeta.width && exportMeta.height ? `${exportMeta.width} × ${exportMeta.height}` : "Unknown";
  const fileSize = formatBytes(exportMeta.file_size || exportMeta.size_bytes) || "Unknown";

  const metaRating = Number(detail.app_rating ?? rawMeta.rating ?? exportMeta.rating ?? 0);
  const rating = localRating ?? metaRating;
  const gps = formatGPS(
    rawMeta.gps_latitude ?? exportMeta.gps_latitude,
    rawMeta.gps_longitude ?? exportMeta.gps_longitude,
  );

  const exposureMeta = rawMeta.capture_time ? rawMeta : exportMeta;
  const aperture = formatAperture(exposureMeta.aperture);
  const shutter = formatShutterSpeed(exposureMeta.shutter_speed);
  const iso = formatISO(exposureMeta.iso);
  const focal = formatFocalLength(exposureMeta.focal_length);
  const hasExposure = aperture || shutter || iso || focal;

  return (
    <aside className="flex h-full flex-col overflow-hidden border-l border-border/40 bg-chrome">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="relative mb-4 flex h-[200px] items-center justify-center overflow-hidden">
          {previewPath ? (
            <img src={localFileUrl(previewPath)} alt={detail.stem} className="max-h-full max-w-full object-contain" draggable={false} />
          ) : (
            <div className="flex items-center justify-center text-[12px] text-muted">No preview</div>
          )}
          <span className="absolute left-2 top-2 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {formatValue}
          </span>
        </div>

        <div className="px-0.5">
          <h2 className="text-[13px] font-medium leading-tight text-text">{exportName || detail.stem}</h2>

          {detail.collage_sources?.length > 0 ? (
            <div className="mt-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">Source Images</div>
              <ThumbnailStrip items={detail.collage_sources} onSelect={onSelectAsset} />
            </div>
          ) : null}

          {detail.version_siblings?.length > 0 ? (
            <div className="mt-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">Other Versions</div>
              <ThumbnailStrip items={detail.version_siblings} onSelect={onSelectAsset} />
            </div>
          ) : null}

          <Section title="Properties">
            <DetailRow label="Rating">
              <StarRating
                value={rating}
                onChange={(next) => {
                  setLocalRating(next);
                  onRatingChange?.(next);
                }}
              />
            </DetailRow>
            <DetailRow label="Dimensions">{dimensions}</DetailRow>
            <DetailRow label="Size">{fileSize}</DetailRow>
            <DetailRow label="Type">{formatValue}</DetailRow>
          </Section>

          <Section title="Source">
            <DetailRow label="Asset">
              <button
                type="button"
                className="cursor-pointer text-right text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent hover:decoration-accent/60"
                onClick={() => void window.mediaWorkspace?.revealPath?.(detail.export_path)}
                title="Reveal in Finder"
              >
                {escapePathLabel(detail.export_path)}
              </button>
            </DetailRow>
            <DetailRow label="RAW Source">
              {detail.raw_path ? (
                <button
                  type="button"
                  className="cursor-pointer text-right text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent hover:decoration-accent/60"
                  onClick={() => void window.mediaWorkspace?.revealPath?.(detail.raw_path)}
                  title="Reveal in Finder"
                >
                  {escapePathLabel(detail.raw_path)}
                </button>
              ) : "Not linked"}
            </DetailRow>
            {exportMeta.software ? <DetailRow label="Last edited by">{exportMeta.software}</DetailRow> : null}
          </Section>

          <Section title="Camera">
            <DetailRow label="Camera">{rawMeta.camera_model || exportMeta.camera_model || "—"}</DetailRow>
            <DetailRow label="Lens">{rawMeta.lens_model || exportMeta.lens_model || "—"}</DetailRow>
          </Section>

          {hasExposure ? (
            <Section title="Exposure">
              {focal ? <DetailRow label="Focal length">{focal}</DetailRow> : null}
              {aperture ? <DetailRow label="Aperture">{aperture}</DetailRow> : null}
              {shutter ? <DetailRow label="Shutter">{shutter}</DetailRow> : null}
              {iso ? <DetailRow label="ISO">{iso}</DetailRow> : null}
            </Section>
          ) : null}

          <Section title="Dates">
            <DetailRow label="Imported">{formatTimestamp(detail.imported_at || exportMeta.imported_at)}</DetailRow>
            <DetailRow label="Captured">{formatTimestamp(rawMeta.capture_time || exportMeta.capture_time)}</DetailRow>
            <DetailRow label="Modified">{formatTimestamp(exportMeta.modified_time || detail.updated_at)}</DetailRow>
          </Section>

          {gps ? (
            <Section title="Location">
              <DetailRow label="GPS">{gps}</DetailRow>
            </Section>
          ) : null}

          {detail.duplicates?.length > 0 ? (
            <Section title="Duplicates">
              <div className="mt-1 space-y-1.5">
                {detail.duplicates.map((dup) => (
                  <button
                    key={dup.asset_id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
                    onClick={() => void window.mediaWorkspace?.revealPath?.(dup.export_path)}
                    title="Reveal in Finder"
                  >
                    <Copy className="h-3 w-3 shrink-0 text-muted2" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] text-text">{dup.stem}</div>
                      <div className="truncate text-[10px] text-muted">{escapePathLabel(dup.export_path)}</div>
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
