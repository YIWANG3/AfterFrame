import { useMemo, useState } from "react";
import { ScanFace } from "lucide-react";

// Square avatar showing just the face region of a photo. `bbox` is the
// normalized [x, y, w, h] face box in top-left image space; the crop math runs
// off the image's natural size on load, so any same-aspect preview works as a
// source. Falls back to a plain cover fit (no bbox) or an icon (load failure).
export default function FaceCrop({ src, bbox, size, className = "", padding = 0.65, alt = "" }) {
  const [natural, setNatural] = useState(null);
  const [failed, setFailed] = useState(false);

  const style = useMemo(() => {
    if (!natural || !Array.isArray(bbox) || bbox.length !== 4) return null;
    const { width: W, height: H } = natural;
    const [x, y, w, h] = bbox.map(Number);
    if (!(W > 0) || !(H > 0) || !(w > 0) || !(h > 0)) return null;
    let side = Math.max(w * W, h * H) * (1 + padding * 2);
    side = Math.min(side, Math.min(W, H));
    const half = side / 2;
    const cx = Math.min(Math.max((x + w / 2) * W, half), W - half);
    const cy = Math.min(Math.max((y + h / 2) * H, half), H - half);
    // Percent units keep the crop correct at any rendered size, so callers can
    // size the container with CSS alone (grid tiles, chips, banners).
    return {
      position: "absolute",
      width: `${(W / side) * 100}%`,
      height: `${(H / side) * 100}%`,
      left: `${(-(cx - half) / side) * 100}%`,
      top: `${(-(cy - half) / side) * 100}%`,
      maxWidth: "none",
    };
  }, [natural, bbox, padding]);

  return (
    <div
      className={`relative overflow-hidden bg-hover/45 ${className}`}
      style={size ? { width: size, height: size } : undefined}
    >
      {src && !failed ? (
        <img
          src={src}
          alt={alt}
          draggable={false}
          loading="lazy"
          onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
          className={style ? "" : "h-full w-full object-cover"}
          style={style || undefined}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted2">
          <ScanFace className="h-[45%] w-[45%] stroke-[1.25]" />
        </div>
      )}
    </div>
  );
}
