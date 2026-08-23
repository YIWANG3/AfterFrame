import api from "../../../api";
import { useEffect, useState } from "react";

// Depth model picker state. The Sticker tool lets the user swap the CoreML
// model used by Depth Anything V2 — this hook loads the active selection on
// mount and exposes pick/reset callbacks that re-run depth inference on the
// current source so the new model's output replaces the cached one.
export function useDepthModel({ sourcePath, onComputeDepth, onError }) {
  const [depthModel, setDepthModel] = useState(null);

  useEffect(() => {
    if (!api.has("getDepthModel")) return;
    api.getDepthModel().then(setDepthModel).catch(() => {});
  }, []);

  async function pickDepthModel() {
    if (!api.has("pickDepthModel")) return;
    try {
      const next = await api.pickDepthModel();
      if (next) {
        setDepthModel(next);
        if (sourcePath) await onComputeDepth?.({ force: true });
      }
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  async function resetDepthModel() {
    if (!api.has("resetDepthModel")) return;
    try {
      const next = await api.resetDepthModel();
      setDepthModel(next);
      if (sourcePath) await onComputeDepth?.({ force: true });
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  return { depthModel, pickDepthModel, resetDepthModel };
}
