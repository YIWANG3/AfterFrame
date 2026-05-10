import { useEffect, useState } from "react";

// Depth model picker state. The Sticker tool lets the user swap the CoreML
// model used by Depth Anything V2 — this hook loads the active selection on
// mount and exposes pick/reset callbacks that re-run depth inference on the
// current source so the new model's output replaces the cached one.
export function useDepthModel({ sourcePath, onComputeDepth, onError }) {
  const [depthModel, setDepthModel] = useState(null);

  useEffect(() => {
    if (!window.mediaWorkspace?.getDepthModel) return;
    window.mediaWorkspace.getDepthModel().then(setDepthModel).catch(() => {});
  }, []);

  async function pickDepthModel() {
    if (!window.mediaWorkspace?.pickDepthModel) return;
    try {
      const next = await window.mediaWorkspace.pickDepthModel();
      if (next) {
        setDepthModel(next);
        if (sourcePath) await onComputeDepth?.({ force: true });
      }
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  async function resetDepthModel() {
    if (!window.mediaWorkspace?.resetDepthModel) return;
    try {
      const next = await window.mediaWorkspace.resetDepthModel();
      setDepthModel(next);
      if (sourcePath) await onComputeDepth?.({ force: true });
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  return { depthModel, pickDepthModel, resetDepthModel };
}
