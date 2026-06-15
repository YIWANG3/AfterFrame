import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize2 } from "lucide-react";

// mm:ss (or h:mm:ss) for the scrubber readout.
function fmtTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

// Custom video player — replaces Chromium's default controls with an
// app-styled bar (play/pause, scrubber, time, volume, fullscreen). Click the
// frame to toggle play. Used in the Lightbox for video assets.
export default function VideoPlayer({ src, onError }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const seek = useCallback((value) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = value;
    setTime(value);
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  // Spacebar toggles play while a video is open.
  useEffect(() => {
    function onKey(e) {
      if (e.code === "Space") { e.preventDefault(); e.stopPropagation(); togglePlay(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [togglePlay]);

  const progress = duration > 0 ? (time / duration) * 100 : 0;

  return (
    <div ref={containerRef} className="absolute inset-0 flex flex-col bg-black" onClick={(e) => e.stopPropagation()}>
      <div className="relative min-h-0 flex-1 cursor-pointer" onClick={togglePlay}>
        <video
          ref={videoRef}
          key={src}
          src={src}
          autoPlay
          playsInline
          className="absolute inset-0 m-auto max-h-full max-w-full"
          onError={onError}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration); setMuted(e.currentTarget.muted); }}
        />
      </div>

      <div
        className="flex shrink-0 items-center gap-3 px-5 py-3"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={togglePlay} className="flex h-8 w-8 items-center justify-center rounded-md text-white/85 transition-colors hover:bg-white/10 hover:text-white focus:outline-none">
          {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
        </button>

        <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-white/70">{fmtTime(time)}</span>

        {/* Div-based bar (solid accent fill, round thumb, no border); the native
            range sits transparent on top for drag + keyboard seeking. */}
        <div className="relative flex h-4 flex-1 items-center">
          <div className="relative h-1 w-full rounded-full bg-white/25">
            <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${progress}%` }} />
            <div className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white" style={{ left: `calc(${progress}% - 6px)` }} />
          </div>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={Math.min(time, duration || 0)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </div>

        <span className="w-12 shrink-0 text-[11px] tabular-nums text-white/70">{fmtTime(duration)}</span>

        <button type="button" onClick={toggleMute} className="flex h-8 w-8 items-center justify-center rounded-md text-white/85 transition-colors hover:bg-white/10 hover:text-white focus:outline-none">
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <button type="button" onClick={toggleFullscreen} className="flex h-8 w-8 items-center justify-center rounded-md text-white/85 transition-colors hover:bg-white/10 hover:text-white focus:outline-none">
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
