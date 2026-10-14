import { useCallback, useEffect, useRef, useState } from "react";
import api from "../api";
import { topLayerOpen, TOP_LAYER_ATTR } from "../utils/topLayer";

// Only the picture is native. Bounds are CSS pixels; main converts them to
// Cocoa points using the webContents zoom factor (never devicePixelRatio).
export default function useNativeVideo(path, surfaceRef) {
  const available = Boolean(path && api.platform === "darwin" && api.has("nativeVideoOpen"));
  const [fallback, setFallback] = useState(false);
  // AVPlayer starts playing as soon as it opens.
  const [state, setState] = useState({ playing: true, time: 0, duration: 0, muted: false, ready: false });
  const sessionRef = useRef(null);
  const stateRef = useRef(state);
  // Counts the transport commands sent. A state read already on its way when
  // one is sent describes the player before it, so it is dropped rather than
  // undoing what the button just showed.
  const sentRef = useRef(0);
  // Where the last seek is going: the player's own time lags until it lands.
  const seekRef = useRef(null);
  const enabled = available && !fallback;

  const command = useCallback((action, value) => {
    const session = sessionRef.current;
    if (session) Promise.resolve(api.nativeVideoCommand(session, action, value)).catch(() => {});
  }, []);
  const transport = useCallback((action, value) => {
    sentRef.current += 1;
    command(action, value);
  }, [command]);
  const show = useCallback((patch) => {
    stateRef.current = { ...stateRef.current, ...patch };
    setState(stateRef.current);
  }, []);

  useEffect(() => {
    if (!enabled || !surfaceRef.current) return;
    const session = crypto.randomUUID();
    sessionRef.current = session;
    let disposed = false, opened = false, polling = false;
    let lastBounds = "", lastVisible = null;
    // How long the picture has been on screen: a first frame is waited for
    // only while it can be seen (Settings over it, or a hidden window, pause
    // the clock).
    let shownMs = 0, shownSince = null;
    const shownFor = () => shownMs + (shownSince === null ? 0 : performance.now() - shownSince);
    const rect = () => {
      const { x, y, width, height } = surfaceRef.current.getBoundingClientRect();
      return { x, y, width, height };
    };
    const fail = () => {
      if (!disposed) setFallback(true);
    };
    const syncBounds = () => {
      if (!opened || disposed) return;
      const bounds = rect(), key = JSON.stringify(bounds);
      if (key !== lastBounds) { lastBounds = key; command("bounds", bounds); }
    };
    // The native picture sits above the whole page, so it steps aside for
    // anything opened over the lightbox (utils/topLayer.js).
    const syncVisible = () => {
      if (!opened || disposed) return;
      const visible = !topLayerOpen() && document.visibilityState !== "hidden";
      if (visible === lastVisible) return;
      lastVisible = visible;
      if (visible) shownSince = performance.now();
      else if (shownSince !== null) { shownMs += performance.now() - shownSince; shownSince = null; }
      command("visible", Number(visible));
    };
    const poll = async () => {
      if (!opened || disposed || polling) return;
      polling = true;
      const sent = sentRef.current;
      try {
        const next = await api.nativeVideoState(session);
        if (disposed) return;
        if (!next || next.failed || (!next.ready && shownFor() > 15_000)) { fail(); return; }
        if (sent !== sentRef.current) return;
        if (!next.seeking) seekRef.current = null;
        else if (seekRef.current !== null) next.time = seekRef.current;
        // Paused, nothing moves: no render.
        if (JSON.stringify(next) === JSON.stringify(stateRef.current)) return;
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
        syncBounds();
        syncVisible();
        poll();
      }).catch(fail);
    const resize = new ResizeObserver(syncBounds);
    resize.observe(surfaceRef.current);
    // Only top layers coming and going: nothing here measures the page.
    const overlays = new MutationObserver(syncVisible);
    overlays.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: [TOP_LAYER_ATTR] });
    window.addEventListener("resize", syncBounds);
    document.addEventListener("visibilitychange", syncVisible);
    const timer = setInterval(poll, 100);
    return () => {
      disposed = true;
      sessionRef.current = null;
      clearInterval(timer); resize.disconnect(); overlays.disconnect();
      window.removeEventListener("resize", syncBounds);
      document.removeEventListener("visibilitychange", syncVisible);
      Promise.resolve(api.nativeVideoClose(session)).catch(() => {});
    };
  }, [enabled, path, surfaceRef, command]);

  const togglePlay = useCallback(() => {
    const playing = !stateRef.current.playing;
    transport(playing ? "play" : "pause");
    show({ playing });
  }, [transport, show]);
  const seek = useCallback((time) => {
    seekRef.current = time;
    transport("seek", time);
    show({ time });
  }, [transport, show]);
  const toggleMute = useCallback(() => {
    const muted = !stateRef.current.muted;
    transport("mute", Number(muted));
    show({ muted });
  }, [transport, show]);
  return { enabled, session: sessionRef.current, ...state, togglePlay, seek, toggleMute };
}
