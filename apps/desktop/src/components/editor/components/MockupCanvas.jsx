// The camera mockup in the live preview: the display, the photo played back
// on it and the camera, drawn with the export's own function (drawMockup) at
// the preview's size and the screen's pixel density. The photo is cut the way
// the export cuts it (the crop, turned by the free angle), so it stands in for
// the plain photo element underneath, which the overlay hides.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cutRotatedCrop } from "../render/canvasHelpers";
import { drawMockup } from "../render/mockupRender";
import { loadMockupImage, mockupById, mockupImageIfLoaded } from "../mockups";

export default function MockupCanvas({ rect, contentRect, spec, source, srcRect, freeAngle = 0 }) {
  const ref = useRef(null);
  const asset = mockupById(spec?.id);
  const [image, setImage] = useState(() => mockupImageIfLoaded(spec?.id));
  useEffect(() => {
    let alive = true;
    setImage(mockupImageIfLoaded(spec?.id));
    loadMockupImage(spec?.id).then((img) => { if (alive) setImage(img); });
    return () => { alive = false; };
  }, [spec?.id]);

  const srcKey = srcRect ? [srcRect.x, srcRect.y, srcRect.width, srcRect.height].map((v) => Math.round(v)).join(",") : "";
  const content = useMemo(
    () => (source && srcRect ? cutRotatedCrop(source, srcRect, freeAngle) : null),
    [source, srcKey, freeAngle], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  // Only what changes the picture: panning moves the element, not its pixels.
  const relX = contentRect.x - rect.x;
  const relY = contentRect.y - rect.y;
  const key = [
    Math.round(rect.width), Math.round(rect.height), Math.round(relX), Math.round(relY),
    Math.round(contentRect.width), Math.round(contentRect.height), dpr, JSON.stringify(spec || null),
  ].join("|");

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !asset || !content) return;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    drawMockup(ctx, {
      asset, spec, photo: content, image,
      contentRect: { x: relX * dpr, y: relY * dpr, width: contentRect.width * dpr, height: contentRect.height * dpr },
    });
  }, [key, content, image]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!asset) return null;
  return (
    <canvas
      ref={ref}
      data-frame-mockup={spec.id}
      data-mockup-ready={image ? "true" : "false"}
      className="pointer-events-none absolute block"
      style={{
        left: `${rect.x}px`, top: `${rect.y}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      }}
    />
  );
}
