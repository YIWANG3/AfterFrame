// The frame's background in the live preview when it is made from the photo
// (photo colours, blurred photo): drawn with the same function the
// export uses, at the preview's size and the screen's pixel density. Flat and
// gradient backgrounds stay plain CSS.

import { useLayoutEffect, useRef } from "react";
import { drawCanvasBackground } from "../render/frameBackdrop";

export default function FrameBackgroundCanvas({ rect, contentRect, bg, photoStyle, userPad, source, srcRect }) {
  const ref = useRef(null);
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  // Only what changes the picture: panning moves the element, not its pixels.
  const relX = contentRect.x - rect.x;
  const relY = contentRect.y - rect.y;
  const key = [
    Math.round(rect.width), Math.round(rect.height), Math.round(relX), Math.round(relY),
    Math.round(contentRect.width), Math.round(contentRect.height), dpr,
    JSON.stringify(bg), JSON.stringify(photoStyle || null), JSON.stringify(userPad || null),
    srcRect ? `${Math.round(srcRect.x)},${Math.round(srcRect.y)},${Math.round(srcRect.width)},${Math.round(srcRect.height)}` : "",
  ].join("|");

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !source) return;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const content = { x: relX * dpr, y: relY * dpr, width: contentRect.width * dpr, height: contentRect.height * dpr };
    const short = Math.min(content.width, content.height);
    drawCanvasBackground(ctx, bg, {
      W: canvas.width, H: canvas.height, source, srcRect, contentRect: content, short, photoStyle,
      userPadPx: {
        top: (userPad?.top || 0) * short, right: (userPad?.right || 0) * short,
        bottom: (userPad?.bottom || 0) * short, left: (userPad?.left || 0) * short,
      },
    });
  }, [key, source]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <canvas
      ref={ref}
      data-frame-background={bg?.mode || "solid"}
      className="absolute block"
      style={{
        left: `${rect.x}px`, top: `${rect.y}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      }}
    />
  );
}
