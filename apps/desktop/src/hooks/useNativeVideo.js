import { useCallback, useEffect, useRef, useState } from "react";
import api from "../api";
import { topLayerOpen, TOP_LAYER_ATTR } from "../utils/topLayer";

// Only the picture is native. Bounds are CSS pixels; main converts them to
// Cocoa points using the webContents zoom factor (never devicePixelRatio).
export default function useNativeVideo(path, surfaceRef) {
  const available = Boolean(path && api.platform === "darwin" && api.has("nativeVideoOpen"));
  const [fallback, setFallback] = useState(false);
  const [state, setState] = useState({ playing: false, time: 0, duration: 0, muted: false, ready: false });
  const sessionRef = useRef(null);
  const stateRef = useRef(state);
  const enabled = available && !fallback;

  const command = useCallback((action, value) => {
    const session = sessionRef.current;
    if (session) Promise.resolve(api.nativeVideoCommand(session, action, value)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled || !surfaceRef.current) return;
    const session = crypto.randomUUID();
    sessionRef.current = session;
    let disposed = false, opened = false, polling = false;
    let lastBounds = "", lastVisible = null;
    const started = performance.now();
    const rect = () => {
      const { x, y, width, height } = surfaceRef.current.getBoundingClientRect();
      return { x, y, width, height };
    };
    const fail = () => {
      if (!disposed) setFallback(true);
    };
    const syncSurface = () => {
      if (!opened || disposed) return;
      const bounds = rect(), key = JSON.stringify(bounds);
      if (key !== lastBounds) { lastBounds = key; command("bounds", bounds); }
      const visible = !topLayerOpen() && document.visibilityState !== "hidden";
      if (visible !== lastVisible) { lastVisible = visible; command("visible", Number(visible)); }
    };
    const poll = async () => {
      if (!opened || disposed || polling) return;
      polling = true;
      try {
        const next = await api.nativeVideoState(session);
        if (disposed) return;
        if (!next || next.failed || (!next.ready && performance.now() - started > 15_000)) { fail(); return; }
        stateRef.current = next;
        setState(next);
      } catch { fail(); }
      finally { polling = false; }
    };
    Promise.resolve(api.nativeVideoOpen({ session, path, bounds: rect() }))
      .then((result) => {
        if (disposed) { Promise.resolve(api.nativeVideoClose(session)).catch(() => {}); return; }
        if (!result) { fail(); return; }
        opened = true;
        syncSurface();
        poll();
      }).catch(fail);
    const resize = new ResizeObserver(syncSurface);
    resize.observe(surfaceRef.current);
    const overlays = new MutationObserver(syncSurface);
    overlays.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: [TOP_LAYER_ATTR] });
    window.addEventListener("resize", syncSurface);
    document.addEventListener("fullscreenchange", syncSurface);
    document.addEventListener("visibilitychange", syncSurface);
    const timer = setInterval(poll, 100);
    return () => {
      disposed = true;
      sessionRef.current = null;
      clearInterval(timer); resize.disconnect(); overlays.disconnect();
      window.removeEventListener("resize", syncSurface);
      document.removeEventListener("fullscreenchange", syncSurface);
      document.removeEventListener("visibilitychange", syncSurface);
      Promise.resolve(api.nativeVideoClose(session)).catch(() => {});
    };
  }, [enabled, path, surfaceRef, command]);

  const togglePlay = useCallback(() => {
    const playing = !stateRef.current.playing;
    stateRef.current = { ...stateRef.current, playing };
    command(playing ? "play" : "pause");
    setState((current) => ({ ...current, playing }));
  }, [command]);
  const seek = useCallback((time) => {
    command("seek", time);
    setState((current) => ({ ...current, time }));
  }, [command]);
  const toggleMute = useCallback(() => {
    const muted = !stateRef.current.muted;
    stateRef.current = { ...stateRef.current, muted };
    command("mute", Number(muted));
    setState((current) => ({ ...current, muted }));
  }, [command]);
  const toggleFullscreen = useCallback(() => command("fullscreen"), [command]);
  return { enabled, session: sessionRef.current, ...state, togglePlay, seek, toggleMute, toggleFullscreen };
}
