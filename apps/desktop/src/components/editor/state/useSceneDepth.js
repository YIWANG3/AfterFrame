import { useRef, useState } from "react";
import { localFileUrl } from "../../../utils/format";

// Scene-level depth field state. One Depth Anything V2 inference per source
// image, cached as both an HTMLImageElement (for the overlay visualization)
// and a Canvas (for pixel reads when building per-layer masks).
export function useSceneDepth({ sourcePath } = {}) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [sourcePathOnDisk, setSourcePathOnDisk] = useState(null);
  const fieldImageRef = useRef(null);
  const fieldCanvasRef = useRef(null);
  const [version, setVersion] = useState(0);
  const [feather, setFeather] = useState(0.08);
  const [mapVisible, setMapVisible] = useState(false);

  function clear() {
    fieldImageRef.current = null;
    fieldCanvasRef.current = null;
    setSourcePathOnDisk(null);
    setVersion((v) => v + 1);
  }

  async function loadFromPath(fieldPath) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Failed to load depth field"));
      img.src = localFileUrl(fieldPath);
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    fieldImageRef.current = img;
    fieldCanvasRef.current = canvas;
    setSourcePathOnDisk(fieldPath);
    setVersion((v) => v + 1);
  }

  async function compute({ force = false } = {}) {
    if (!sourcePath) {
      setError("No source image.");
      return;
    }
    if (!window.mediaWorkspace?.computeDepth) {
      setError("Depth API unavailable.");
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const result = await window.mediaWorkspace.computeDepth({ sourcePath, force });
      if (!result?.outputPath) throw new Error("Empty result");
      await loadFromPath(result.outputPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  function clearError() {
    setError(null);
  }
  function clearAll() {
    clear();
    setError(null);
  }

  return {
    generating,
    error,
    sourcePathOnDisk,
    fieldImageRef,
    fieldCanvasRef,
    version,
    feather, setFeather,
    mapVisible, setMapVisible,
    clear,
    loadFromPath,
    compute,
    clearError,
    clearAll,
    setError,
  };
}
