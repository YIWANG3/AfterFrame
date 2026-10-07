import { useEffect, useState } from "react";
import api from "../api";

// For a RAW, the picture the editor edits and saves from (electron/rawEditSource.js):
// its HD preview when that is the RAW's full size, else a full-size render
// made on demand — some cameras embed a JPEG a tenth of the sensor's pixels.
// The path once decided, undefined while deciding or rendering (seconds for a
// 100 MP file), null when there is nothing to ask (not a RAW, no HD preview
// yet, a bridge without the call) or the request failed — the caller keeps
// its HD then.
export default function useRawEditSource({ item, hdPath, enabled }) {
  const rawPath = enabled && item?.asset_type === "raw" && item.exists_on_disk !== false ? item.image_path : null;
  const width = Number(item?.image_metadata?.width) || 0;
  const height = Number(item?.image_metadata?.height) || 0;
  const askable = Boolean(rawPath && hdPath && api.has?.("rawEditSource"));
  const key = askable ? `${rawPath}|${hdPath}|${width}x${height}` : null;
  const [answer, setAnswer] = useState({ key: null, path: undefined });

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    api.rawEditSource({ path: rawPath, hdPath, width, height })
      .then((result) => { if (!cancelled) setAnswer({ key, path: result?.path || null }); })
      .catch(() => { if (!cancelled) setAnswer({ key, path: null }); });
    return () => { cancelled = true; };
    // The request is fully described by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return null;
  return answer.key === key ? answer.path : undefined;
}

// The RAW rendered by Apple's RAW engine at full size, never the camera's
// embedded JPEG: what the LUT tool grades (docs/lut-plan.md). { path, renderer }
// once made ("image-io", or "libraw" where Image I/O failed), undefined while
// rendering, null when there is nothing to ask or the render failed.
export function useNeutralRawRender({ item, enabled }) {
  const rawPath = enabled && item?.asset_type === "raw" && item.exists_on_disk !== false ? item.image_path : null;
  const askable = Boolean(rawPath && api.has?.("rawEditSource"));
  const key = askable ? rawPath : null;
  const [answer, setAnswer] = useState({ key: null, value: undefined });

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    api.rawEditSource({ path: rawPath, neutral: true })
      .then((result) => {
        if (cancelled) return;
        setAnswer({ key, value: result?.full && result.path ? { path: result.path, renderer: result.renderer || null } : null });
      })
      .catch(() => { if (!cancelled) setAnswer({ key, value: null }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return null;
  return answer.key === key ? answer.value : undefined;
}
