// What the photo area shows while the picture is on its way: the catalog's
// preview of it, dimmed, under what is being waited for. A 100 MP RAW is
// rendered at full size before it can be edited (seconds, the first time),
// and the LUT tool renders a RAW again with Apple's engine; a dark area with
// one line of static text looked stuck.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { localFileUrl } from "../../../utils/format";
import { getBasePlacement } from "../imageMath";

// The hint (why it takes a while) only once it does: most loads end before.
const HINT_AFTER_MS = 1200;

// `over`: the photo already drawn ({ x, y, width, height }), to centre on.
export default function EditorLoading({ previewPath, viewportSize, over, label, hint }) {
  const [late, setLate] = useState(false);
  const [natural, setNatural] = useState(null);
  useEffect(() => {
    const id = setTimeout(() => setLate(true), HINT_AFTER_MS);
    return () => clearTimeout(id);
  }, []);
  // Where the editor will draw the photo, so it doesn't jump when it lands.
  const placement = natural && viewportSize ? getBasePlacement(viewportSize, natural) : null;
  const rect = placement ? {
    left: placement.centerX - (natural.width * placement.fitScale) / 2,
    top: placement.centerY - (natural.height * placement.fitScale) / 2,
    width: natural.width * placement.fitScale,
    height: natural.height * placement.fitScale,
  } : null;
  const area = rect || (over ? { left: over.x, top: over.y, width: over.width, height: over.height } : null);
  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-testid="editor-loading">
      {previewPath ? (
        <img
          src={localFileUrl(previewPath)}
          alt=""
          draggable={false}
          onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          className="absolute object-contain"
          style={rect ? { ...rect, opacity: 0.35 } : { opacity: 0 }}
        />
      ) : null}
      <div
        className="absolute flex flex-col items-center justify-center gap-2"
        style={area || { inset: 0 }}
      >
        <div className="flex items-center gap-2 rounded-full bg-chrome/90 px-4 py-2 text-[12.5px] text-text shadow-overlay" data-testid="editor-loading-label">
          <Loader2 className="h-4 w-4 animate-spin text-muted" />
          {label}
        </div>
        {hint && late ? (
          <div className="max-w-[320px] rounded-md bg-chrome/80 px-3 py-1.5 text-center text-[11px] leading-snug text-muted">{hint}</div>
        ) : null}
      </div>
    </div>
  );
}
