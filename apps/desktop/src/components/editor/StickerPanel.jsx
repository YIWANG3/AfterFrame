import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Sparkles, Trash2, Star, Loader2, Check, RotateCcw } from "lucide-react";
import { localFileUrl, fileName, stickerLabel } from "../../utils/format";
import ColorPickerPopover from "../collage/ColorPickerPopover";

// Sticker tool — only handles "production" of sticker PNGs:
//   • Library tab: browse / star / delete entries from local sticker folder
//   • Create new tab: run VisionKit subject segmentation on the current image,
//     pick an instance, adjust outline, bake to PNG, save to library
//
// This component intentionally does NOT add layers to the editor canvas —
// consumption happens in the Text tool's layer system.

export default function StickerPanel({ sourcePath, sourceLabel, pushToast, region, onClearRegion }) {
  const [tab, setTab] = useState("create"); // "library" | "create"
  const [stickers, setStickers] = useState([]);
  const [highlightId, setHighlightId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const list = await window.mediaWorkspace.stickerList();
      setStickers(list || []);
    } catch (err) {
      console.error("[StickerPanel] list failed", err);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function handleSaved(entry) {
    setStickers((prev) => [entry, ...prev.filter((s) => s.id !== entry.id)]);
    setHighlightId(entry.id);
    setTab("library");
    pushToast?.({
      title: "Sticker saved",
      message: entry.sourceLabel || "Added to sticker library",
      ttl: 6000,
    });
    setTimeout(() => setHighlightId((id) => (id === entry.id ? null : id)), 2000);
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 className="text-[11px] uppercase tracking-wider text-muted2">Sticker</h2>
        <span className="text-[10px] text-muted3">
          {tab === "library" ? `${stickers.length} in library` : "Make a new sticker"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 pb-2">
        <SegBtn active={tab === "create"} onClick={() => setTab("create")}>Create new</SegBtn>
        <SegBtn active={tab === "library"} onClick={() => setTab("library")}>Library</SegBtn>
      </div>

      {tab === "library" ? (
        <Library
          stickers={stickers}
          highlightId={highlightId}
          onChanged={refresh}
          onCreate={() => setTab("create")}
        />
      ) : (
        <CreateNew
          sourcePath={sourcePath}
          sourceLabel={sourceLabel}
          onSaved={handleSaved}
          pushToast={pushToast}
          region={region}
          onClearRegion={onClearRegion}
        />
      )}
    </div>
  );
}

/* ─── Library tab ─────────────────────────────────────────────── */

function Library({ stickers, highlightId, onChanged, onCreate }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (!query.trim()) return stickers;
    const q = query.trim().toLowerCase();
    return stickers.filter((s) => stickerLabel(s).toLowerCase().includes(q));
  }, [stickers, query]);

  async function handleDelete(sticker) {
    if (!confirm(`Delete this sticker?\n${stickerLabel(sticker)}`)) return;
    await window.mediaWorkspace.stickerDelete(sticker.id);
    onChanged();
  }
  async function handleStar(sticker) {
    await window.mediaWorkspace.stickerToggleStar(sticker.id);
    onChanged();
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="px-3 pb-3">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stickers…"
            className="h-7 w-full rounded-md border border-border/60 bg-app pl-7 pr-2 text-[11px] text-text outline-none placeholder:text-muted3 focus:border-[rgb(var(--accent-color))]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3 pt-1">
        {stickers.length === 0 ? (
          <EmptyState onCreate={onCreate} />
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {filtered.map((s) => (
              <StickerThumb
                key={s.id}
                sticker={s}
                highlight={highlightId === s.id}
                onDelete={() => handleDelete(s)}
                onStar={() => handleStar(s)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ onCreate }) {
  return (
    <div className="mt-6 flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 px-4 py-8 text-center">
      <div className="text-[13px] text-text">No stickers yet</div>
      <div className="text-[11px] leading-relaxed text-muted2">
        Make your first one by extracting a subject from the current image.
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="rounded-md bg-[rgb(var(--accent-color))] px-3 py-1.5 text-[11px] font-medium text-[#111] transition-colors hover:brightness-110"
      >
        Create sticker
      </button>
    </div>
  );
}

function StickerThumb({ sticker, highlight, onDelete, onStar }) {
  return (
    <div className="group flex flex-col" title={stickerLabel(sticker)}>
      <div
        className={[
          "relative aspect-square overflow-hidden rounded-md border bg-checker transition-all",
          highlight
            ? "border-[rgb(var(--accent-color))] ring-2 ring-[rgb(var(--accent-color))]"
            : "border-border hover:border-[rgb(var(--accent-color))]",
        ].join(" ")}
      >
        <img
          src={localFileUrl(sticker.path)}
          alt=""
          className="h-full w-full object-contain"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "copy";
            e.dataTransfer.setData("application/x-afterframe-sticker", JSON.stringify({
              id: sticker.id, path: sticker.path,
            }));
          }}
        />
        {sticker.starred && (
          <Star className="absolute left-1 top-1 h-3 w-3 fill-[rgb(var(--accent-color))] text-[rgb(var(--accent-color))]" />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-6 items-end justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent px-1 pb-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onStar(); }}
            className="flex h-4 w-4 items-center justify-center rounded text-white/80 hover:text-white"
            title={sticker.starred ? "Unstar" : "Star"}
          >
            <Star className={`h-3 w-3 ${sticker.starred ? "fill-current" : ""}`} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="flex h-4 w-4 items-center justify-center rounded text-white/80 hover:text-white"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div className="mt-1 truncate px-0.5 text-[9px] text-muted2">
        {stickerLabel(sticker)}
      </div>
    </div>
  );
}

/* ─── Create new tab ─────────────────────────────────────────── */

function CreateNew({ sourcePath, sourceLabel, onSaved, pushToast, region, onClearRegion }) {
  const [phase, setPhase] = useState("idle"); // idle | detecting | preview | saving
  const [scratchDir, setScratchDir] = useState(null);
  const [instances, setInstances] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [outline, setOutline] = useState({ width: 8, color: "#ffffff" });
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const previousScratchRef = useRef(null);

  // When detection produces instances, prefill the name with the source stem
  // (no extension) — but only if the user hasn't typed one yet.
  useEffect(() => {
    if (instances.length === 0 || name) return;
    const base = (sourceLabel || fileName(sourcePath) || "").replace(/\.[^.]+$/, "");
    if (instances.length > 1) {
      setName(`${base} ${activeIdx + 1}`);
    } else {
      setName(base);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances.length, activeIdx]);

  // Cleanup any pending scratch dir when unmounting or starting over.
  useEffect(() => {
    return () => {
      if (previousScratchRef.current) {
        window.mediaWorkspace.stickerCleanupScratch?.(previousScratchRef.current);
        previousScratchRef.current = null;
      }
    };
  }, []);

  async function handleDetect() {
    if (!sourcePath) return;
    setError(null);
    setPhase("detecting");
    try {
      // Clean up previous scratch dir if any.
      if (previousScratchRef.current) {
        await window.mediaWorkspace.stickerCleanupScratch?.(previousScratchRef.current);
        previousScratchRef.current = null;
      }
      const result = await window.mediaWorkspace.stickerDetect({ sourcePath, region });
      previousScratchRef.current = result.scratchDir;
      setScratchDir(result.scratchDir);
      setInstances(result.instances || []);
      setActiveIdx(0);
      if (!result.instances?.length) {
        setPhase("idle");
        pushToast?.({
          title: "No subject detected",
          message: "Try another photo with a clearer foreground subject.",
          ttl: 6000,
        });
        return;
      }
      setPhase("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  }

  async function handleSave() {
    if (!instances.length) return;
    const inst = instances[activeIdx];
    if (!inst) return;
    setPhase("saving");
    setError(null);
    try {
      const bytes = await bakeOutline(inst.absolutePath, outline);
      const entry = await window.mediaWorkspace.stickerSave({
        bytes,
        width: inst.width,
        height: inst.height,
        sourcePath,
        sourceLabel: sourceLabel || fileName(sourcePath) || null,
        name: name.trim() || null,
        instanceIndex: inst.index,
        outlineWidth: outline.width,
        outlineColor: outline.color,
      });
      // Reset state for next extraction
      if (previousScratchRef.current) {
        window.mediaWorkspace.stickerCleanupScratch?.(previousScratchRef.current);
        previousScratchRef.current = null;
      }
      setScratchDir(null);
      setInstances([]);
      setName("");
      setPhase("idle");
      onSaved(entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("preview");
    }
  }

  function handleReset() {
    setError(null);
    setInstances([]);
    setActiveIdx(0);
    setPhase("idle");
    if (previousScratchRef.current) {
      window.mediaWorkspace.stickerCleanupScratch?.(previousScratchRef.current);
      previousScratchRef.current = null;
    }
  }

  const activeInst = instances[activeIdx];

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <Section label="Source">
          <div className="mb-2 truncate rounded-md border border-border/60 bg-app px-2 py-1.5 text-[11px] text-text">
            {sourceLabel || fileName(sourcePath) || "—"}
          </div>

          {/* Region indicator: tells user whether detection runs full-image or just inside the marquee */}
          <div className="mb-2 flex items-center gap-2 rounded-md border border-border/60 bg-app px-2 py-1.5 text-[10px]">
            {region ? (
              <>
                <span className="h-2 w-2 rounded-full bg-[rgb(var(--accent-color))]" />
                <span className="text-text">Limited to selection</span>
                <span className="text-muted2">({Math.round(region.w * 100)}% × {Math.round(region.h * 100)}%)</span>
                <button
                  type="button"
                  onClick={onClearRegion}
                  className="ml-auto text-muted2 hover:text-text"
                  title="Clear selection"
                >
                  Clear
                </button>
              </>
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-muted3" />
                <span className="text-muted2">Detects in full image · drag on canvas to limit</span>
              </>
            )}
          </div>

          {phase === "idle" && (
            <button
              type="button"
              onClick={handleDetect}
              disabled={!sourcePath}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border/60 bg-app text-[11px] text-text transition-colors hover:border-[rgb(var(--accent-color))] hover:bg-hover disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" /> Detect subjects
            </button>
          )}
          {phase === "detecting" && (
            <div className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border/60 bg-app text-[11px] text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Detecting subjects…
            </div>
          )}
        </Section>

        {error && (
          <div className="mb-3 rounded-md bg-[rgb(var(--error-color)/0.08)] px-2 py-1.5 text-[10px] text-[rgb(var(--error-color))]">
            {error}
          </div>
        )}

        {phase !== "idle" && phase !== "detecting" && instances.length > 0 && (
          <>
            <Section label={`Detected (${instances.length})`}>
              <div className="grid grid-cols-4 gap-1.5">
                {instances.map((inst, i) => (
                  <button
                    key={inst.index}
                    type="button"
                    onClick={() => setActiveIdx(i)}
                    className={[
                      "relative aspect-square overflow-hidden rounded-md border-2 bg-checker transition-colors",
                      i === activeIdx ? "border-[rgb(var(--accent-color))]" : "border-border hover:border-border-strong",
                    ].join(" ")}
                  >
                    <img
                      src={localFileUrl(inst.absolutePath)}
                      alt=""
                      className="h-full w-full object-contain"
                    />
                  </button>
                ))}
              </div>
            </Section>

            <Section label="Preview">
              <div className="mb-3 aspect-square overflow-hidden rounded-md border border-border bg-checker">
                {activeInst && (
                  <OutlinePreview
                    src={localFileUrl(activeInst.absolutePath)}
                    width={outline.width}
                    color={outline.color}
                  />
                )}
              </div>

              <SliderRow
                label="Outline"
                min={0}
                max={32}
                value={outline.width}
                onChange={(v) => setOutline((o) => ({ ...o, width: v }))}
                suffix="px"
              />
              <OutlineColorRow
                color={outline.color}
                onChange={(c) => setOutline((o) => ({ ...o, color: c }))}
              />
            </Section>

            <Section label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Sticker name"
                className="h-7 w-full rounded-md border border-border/60 bg-app px-2 text-[11px] text-text outline-none placeholder:text-muted3 focus:border-[rgb(var(--accent-color))]"
              />
            </Section>
          </>
        )}
      </div>

      {phase !== "idle" && phase !== "detecting" && instances.length > 0 && (
        <div className="flex items-center gap-1.5 border-t border-border/60 px-3 py-2">
          <button
            type="button"
            onClick={handleReset}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted2 hover:bg-hover hover:text-text"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={phase === "saving"}
            className="ml-auto flex h-7 items-center gap-1.5 rounded-md bg-[rgb(var(--accent-color))] px-3 text-[11px] font-medium text-[#111] transition-all hover:brightness-110 disabled:opacity-60"
          >
            {phase === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {phase === "saving" ? "Saving…" : "Save sticker"}
          </button>
        </div>
      )}
    </div>
  );
}

const OUTLINE_PRESETS = ["#ffffff", "#000000", "#d2a05a", "#f55b5b", "#5bf59c", "#5b8cf5"];

function OutlineColorRow({ color, onChange }) {
  const swatchRef = useRef(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 mt-2 flex items-center gap-2">
      <span className="w-12 text-[10px] uppercase tracking-wider text-muted2">Color</span>
      <button
        ref={swatchRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-5 w-5 flex-shrink-0 rounded border border-border/60 transition-shadow hover:border-border-strong"
        style={{ backgroundColor: color }}
        title="Pick custom color"
      />
      <span className="font-mono text-[10px] text-muted2">{color.toUpperCase()}</span>
      {open && (
        <ColorPickerPopover
          color={color}
          onChange={onChange}
          onClose={() => setOpen(false)}
          anchorEl={swatchRef.current}
          presets={OUTLINE_PRESETS}
        />
      )}
    </div>
  );
}

/* ─── Helper components ──────────────────────────────────────── */

function SegBtn({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "h-7 rounded-md text-[11px] transition-colors",
        active ? "bg-hover text-text" : "text-muted2 hover:text-muted",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Section({ label, children }) {
  return (
    <div className="mb-3">
      <h4 className="mb-1.5 text-[9px] uppercase tracking-wider text-muted3">{label}</h4>
      {children}
    </div>
  );
}

function SliderRow({ label, min, max, value, onChange, suffix }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <span className="w-12 text-[10px] uppercase tracking-wider text-muted2">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider flex-1"
      />
      <div className="flex h-6 w-12 items-center justify-end rounded border border-border/60 bg-app px-1.5 text-[11px] text-text">
        {value}{suffix ? <span className="ml-0.5 text-muted2">{suffix}</span> : null}
      </div>
    </div>
  );
}

/* ─── Outline preview (SVG) ──────────────────────────────────── */

function OutlinePreview({ src, width, color }) {
  // SVG feMorphology dilate on the source alpha → flood fill outline color →
  // composite under the original. Renders the same effect we'll bake.
  const filterId = useMemo(() => `outline-${Math.random().toString(36).slice(2)}`, []);
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="h-full w-full">
      <defs>
        <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
          <feMorphology in="SourceAlpha" operator="dilate" radius={width / 4} result="dilated" />
          <feFlood floodColor={color} result="floodColor" />
          <feComposite in="floodColor" in2="dilated" operator="in" result="outline" />
          <feMerge>
            <feMergeNode in="outline" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <image
        href={src}
        x="0"
        y="0"
        width="100"
        height="100"
        preserveAspectRatio="xMidYMid meet"
        filter={`url(#${filterId})`}
      />
    </svg>
  );
}

/* ─── Bake outline → PNG bytes ───────────────────────────────── */

async function bakeOutline(srcPath, outline) {
  const img = await loadImage(localFileUrl(srcPath));
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  // Pad the canvas so the dilated outline doesn't get clipped at the edges.
  const pad = Math.ceil(outline.width) + 4;
  const W = w + pad * 2;
  const H = h + pad * 2;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";

  if (outline.width > 0) {
    // Stamp a colored copy of the alpha mask at offsets in a circle to
    // approximate dilate. drawImage with a flat color overlay is achieved
    // via globalCompositeOperation = "source-in" on a tinted mask canvas.
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = W;
    maskCanvas.height = H;
    const maskCtx = maskCanvas.getContext("2d");
    // Stamp the source image at (offset) positions on a circle so the union
    // of all alpha = dilated alpha. Use 12 stamps (every 30°) for smoothness.
    const r = outline.width;
    const stamps = 24;
    for (let i = 0; i < stamps; i++) {
      const ang = (i / stamps) * Math.PI * 2;
      maskCtx.drawImage(img, pad + Math.cos(ang) * r, pad + Math.sin(ang) * r);
    }
    // Tint mask to outline color
    maskCtx.globalCompositeOperation = "source-in";
    maskCtx.fillStyle = outline.color;
    maskCtx.fillRect(0, 0, W, H);

    ctx.drawImage(maskCanvas, 0, 0);
  }

  ctx.drawImage(img, pad, pad);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return await blob.arrayBuffer();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

