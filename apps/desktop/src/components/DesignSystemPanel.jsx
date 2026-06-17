import { useState } from "react";
import { Palette, X, Search, ChevronDown, Check, Star, Sparkles, Play, FolderPlus } from "lucide-react";

/* ── Proposed design‑token reference ────────────────────────── */
const RADIUS_SCALE = [
  { label: "none",  css: "0 px",   tw: "rounded-none", cls: "rounded-none" },
  { label: "sm",    css: "2 px",   tw: "rounded-sm",   cls: "rounded-sm" },
  { label: "md",    css: "4 px",   tw: "rounded-md",   cls: "rounded-md" },
  { label: "lg",    css: "8 px",   tw: "rounded-lg",   cls: "rounded-lg" },
  { label: "xl",    css: "12 px",  tw: "rounded-xl",   cls: "rounded-xl" },
  { label: "2xl",   css: "16 px",  tw: "rounded-2xl",  cls: "rounded-2xl" },
  { label: "full",  css: "999 px", tw: "rounded-full",  cls: "rounded-full" },
];

const COLORS = [
  { name: "app-bg",      var: "--app-bg",       tw: "bg-app" },
  { name: "chrome-bg",   var: "--chrome-bg",    tw: "bg-chrome" },
  { name: "panel-bg",    var: "--panel-bg",     tw: "bg-panel" },
  { name: "panel-bg-2",  var: "--panel-bg-2",   tw: "bg-panel2" },
  { name: "hover-bg",    var: "--hover-bg",     tw: "bg-hover" },
  { name: "selected-bg", var: "--selected-bg",  tw: "bg-selected" },
  { name: "border",      var: "--border-color", tw: "border-border" },
  { name: "text",        var: "--text-color",   tw: "text-text" },
  { name: "muted",       var: "--muted-text",   tw: "text-muted" },
  { name: "muted-2",     var: "--muted-text-2", tw: "text-muted2" },
  { name: "accent",      var: "--accent-color", tw: "text-accent" },
  { name: "accent-soft", var: "--accent-soft",  tw: "bg-accentSoft" },
  { name: "success",     var: "--success-color",tw: "text-success" },
  { name: "warn",        var: "--warn-color",   tw: "text-warn" },
  { name: "error",       var: "--error-color",  tw: "text-error" },
];

const TYPE_SCALE = [
  { size: "11px", tw: "text-[11px]", use: "Compact labels, badges" },
  { size: "12px", tw: "text-[12px]", use: "Default body, buttons, inputs" },
  { size: "13px", tw: "text-[13px]", use: "Sidebar nav, section titles" },
  { size: "14px", tw: "text-[14px]", use: "Panel headings" },
  { size: "18px", tw: "text-[18px]", use: "Modal titles" },
];

/* ── Section wrapper ────────────────────────────────────────── */
function Section({ title, children }) {
  return (
    <div className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted2">{title}</h3>
      {children}
    </div>
  );
}

/* ── Main panel ─────────────────────────────────────────────── */
function Panel({ onClose }) {
  const [inputVal, setInputVal] = useState("");
  const [selectVal, setSelectVal] = useState("option-1");
  const [checked, setChecked] = useState(false);
  const [sliderVal, setSliderVal] = useState(50);

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="relative flex max-h-[85vh] w-[680px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-panel shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Palette size={16} className="text-accent" />
            <span className="text-[14px] font-semibold text-text">Design System</span>
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">DRAFT</span>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-text"
          >
            <X size={14} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 space-y-8 overflow-y-auto px-6 py-6">

          {/* ─── BUTTONS ─────────────────────────────── */}
          <Section title="Buttons">
            <div className="space-y-4">
              {/* Primary / Accent */}
              <div>
                <p className="mb-2 text-[11px] text-muted">Primary (accent)</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-app transition-opacity hover:opacity-90">
                    <Play size={13} /> Run Task
                  </button>
                  <button className="flex h-7 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11px] font-medium text-app transition-opacity hover:opacity-90">
                    Compact
                  </button>
                  <button className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-app opacity-40 cursor-not-allowed">
                    Disabled
                  </button>
                </div>
              </div>

              {/* Secondary / Ghost */}
              <div>
                <p className="mb-2 text-[11px] text-muted">Secondary (ghost)</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-transparent px-3 text-[12px] text-text transition-colors hover:bg-hover">
                    <FolderPlus size={13} /> Add Folder
                  </button>
                  <button className="flex h-7 items-center gap-1.5 rounded-lg border border-border/70 bg-transparent px-2.5 text-[11px] text-text transition-colors hover:bg-hover">
                    Compact
                  </button>
                  <button className="flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-transparent px-3 text-[12px] text-text opacity-40 cursor-not-allowed">
                    Disabled
                  </button>
                </div>
              </div>

              {/* Subtle */}
              <div>
                <p className="mb-2 text-[11px] text-muted">Subtle (no border)</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="flex h-8 items-center gap-1.5 rounded-lg bg-transparent px-3 text-[12px] text-muted transition-colors hover:bg-hover hover:text-text">
                    <Sparkles size={13} /> Enrich
                  </button>
                  <button className="flex h-7 items-center gap-1.5 rounded-lg bg-transparent px-2.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text">
                    Compact
                  </button>
                </div>
              </div>

              {/* Icon buttons */}
              <div>
                <p className="mb-2 text-[11px] text-muted">Icon buttons</p>
                <div className="flex items-center gap-2">
                  <button className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-text">
                    <Star size={15} />
                  </button>
                  <button className="flex h-8 w-8 items-center justify-center rounded-lg bg-hover text-text transition-colors hover:bg-hover">
                    <Sparkles size={15} />
                  </button>
                  <button className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-text">
                    <X size={14} />
                  </button>
                </div>
              </div>

              {/* Spec table */}
              <div className="rounded-xl border border-border/40 bg-panel2/50 p-3">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-muted2">
                      <th className="pb-1.5 font-medium">Prop</th>
                      <th className="pb-1.5 font-medium">Standard</th>
                      <th className="pb-1.5 font-medium">Compact</th>
                    </tr>
                  </thead>
                  <tbody className="text-muted">
                    <tr><td className="py-0.5">Height</td><td>h-8 (32px)</td><td>h-7 (28px)</td></tr>
                    <tr><td className="py-0.5">Radius</td><td colSpan={2}>rounded-lg (8px)</td></tr>
                    <tr><td className="py-0.5">Font</td><td>text-[12px]</td><td>text-[11px]</td></tr>
                    <tr><td className="py-0.5">Padding</td><td>px-3</td><td>px-2.5</td></tr>
                    <tr><td className="py-0.5">Icon btn</td><td>h-8 w-8</td><td>h-7 w-7</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </Section>

          {/* ─── INPUTS ──────────────────────────────── */}
          <Section title="Inputs">
            <div className="space-y-3">
              {/* Text input */}
              <div>
                <label className="mb-1 block text-[11px] text-muted">Text input</label>
                <input
                  type="text"
                  placeholder="Placeholder text…"
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  className="h-8 w-full rounded-lg border border-border/70 bg-transparent px-2.5 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
                />
              </div>

              {/* Search input */}
              <div>
                <label className="mb-1 block text-[11px] text-muted">Search input</label>
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted2" />
                  <input
                    type="text"
                    placeholder="Search…"
                    className="h-8 w-full rounded-lg border border-border/70 bg-transparent pl-8 pr-2.5 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
                  />
                </div>
              </div>

              {/* Select */}
              <div>
                <label className="mb-1 block text-[11px] text-muted">Select</label>
                <select
                  value={selectVal}
                  onChange={(e) => setSelectVal(e.target.value)}
                  className="h-8 w-full rounded-lg border border-border/70 bg-transparent px-2.5 text-[12px] text-text outline-none focus:border-accent/50"
                >
                  <option value="option-1">Date Added</option>
                  <option value="option-2">Name</option>
                  <option value="option-3">Rating</option>
                </select>
              </div>

              {/* Textarea */}
              <div>
                <label className="mb-1 block text-[11px] text-muted">Textarea</label>
                <textarea
                  placeholder="Enter description…"
                  rows={3}
                  className="w-full rounded-lg border border-border/70 bg-transparent px-2.5 py-2 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
                />
              </div>

              {/* Range slider */}
              <div>
                <label className="mb-1 block text-[11px] text-muted">Range slider — {sliderVal}%</label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={sliderVal}
                  onChange={(e) => setSliderVal(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              {/* Checkbox-like toggle */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setChecked(!checked)}
                  className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                    checked ? "border-accent bg-accent text-app" : "border-border/70 bg-transparent text-transparent"
                  }`}
                >
                  <Check size={10} strokeWidth={3} />
                </button>
                <span className="text-[12px] text-text">Checkbox option</span>
              </div>

              {/* Spec */}
              <div className="rounded-xl border border-border/40 bg-panel2/50 p-3">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-muted2">
                      <th className="pb-1.5 font-medium">Prop</th>
                      <th className="pb-1.5 font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody className="text-muted">
                    <tr><td className="py-0.5">Height</td><td>h-8 (32px)</td></tr>
                    <tr><td className="py-0.5">Radius</td><td>rounded-lg (8px)</td></tr>
                    <tr><td className="py-0.5">Border</td><td>border-border/70</td></tr>
                    <tr><td className="py-0.5">Focus</td><td>border-accent/50</td></tr>
                    <tr><td className="py-0.5">Font</td><td>text-[12px]</td></tr>
                    <tr><td className="py-0.5">Padding</td><td>px-2.5</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </Section>

          {/* ─── BORDER RADIUS ───────────────────────── */}
          <Section title="Border Radius Scale">
            <div className="flex flex-wrap gap-3">
              {RADIUS_SCALE.map((r) => (
                <div key={r.label} className="flex flex-col items-center gap-1.5">
                  <div className={`h-12 w-12 border border-border/70 bg-panel2 ${r.cls}`} />
                  <span className="text-[10px] font-medium text-text">{r.label}</span>
                  <span className="text-[10px] text-muted2">{r.css}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-xl border border-border/40 bg-panel2/50 p-3">
              <p className="text-[11px] text-muted">
                <span className="font-medium text-text">Recommended usage:</span>{" "}
                Buttons & inputs <span className="text-accent">rounded-lg</span> &middot;
                Cards & panels <span className="text-accent">rounded-xl</span> &middot;
                Modals <span className="text-accent">rounded-2xl</span> &middot;
                Badges & pills <span className="text-accent">rounded-full</span>
              </p>
            </div>
          </Section>

          {/* ─── TYPOGRAPHY ──────────────────────────── */}
          <Section title="Typography">
            <div className="space-y-2">
              {TYPE_SCALE.map((t) => (
                <div key={t.size} className="flex items-baseline gap-3">
                  <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-muted2">{t.size}</span>
                  <span className={`${t.tw} text-text`}>Plus Jakarta Sans — {t.use}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Font weights: <span className="font-normal text-text">400 regular</span> &middot;{" "}
              <span className="font-medium text-text">500 medium</span> &middot;{" "}
              <span className="font-semibold text-text">600 semibold</span>
            </p>
          </Section>

          {/* ─── COLORS ──────────────────────────────── */}
          <Section title="Color Palette">
            <div className="grid grid-cols-5 gap-2">
              {COLORS.map((c) => (
                <div key={c.name} className="flex flex-col items-center gap-1">
                  <div
                    className="h-8 w-full rounded-lg border border-white/5"
                    style={{ background: `rgb(var(${c.var}))` }}
                  />
                  <span className="text-[10px] text-muted">{c.name}</span>
                </div>
              ))}
            </div>
          </Section>

          {/* ─── BADGES & PILLS ──────────────────────── */}
          <Section title="Badges & Pills">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">Accent</span>
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">Success</span>
              <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium text-warn">Warning</span>
              <span className="rounded-full bg-error/15 px-2 py-0.5 text-[10px] font-medium text-error">Error</span>
              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted">Neutral</span>
            </div>
          </Section>

          {/* ─── SPACING REFERENCE ───────────────────── */}
          <Section title="Spacing Reference">
            <div className="space-y-1.5">
              {[
                { label: "4px",  tw: "w-1",  desc: "gap-1 · p-1" },
                { label: "6px",  tw: "w-1.5", desc: "gap-1.5 · p-1.5" },
                { label: "8px",  tw: "w-2",  desc: "gap-2 · p-2" },
                { label: "10px", tw: "w-2.5", desc: "gap-2.5 · p-2.5" },
                { label: "12px", tw: "w-3",  desc: "gap-3 · p-3" },
                { label: "16px", tw: "w-4",  desc: "gap-4 · p-4" },
                { label: "24px", tw: "w-6",  desc: "gap-6 · p-6" },
              ].map((s) => (
                <div key={s.label} className="flex items-center gap-3">
                  <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-muted2">{s.label}</span>
                  <div className={`h-2 ${s.tw} rounded-sm bg-accent/60`} />
                  <span className="text-[10px] text-muted">{s.desc}</span>
                </div>
              ))}
            </div>
          </Section>

          {/* ─── COMPOSITE EXAMPLE ───────────────────── */}
          <Section title="Composite Example — Card">
            <div className="rounded-xl border border-border/50 bg-panel2/80 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[13px] font-medium text-text">Import Settings</span>
                <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">Active</span>
              </div>
              <div className="mb-3 space-y-2">
                <input
                  type="text"
                  placeholder="Output directory…"
                  className="h-8 w-full rounded-lg border border-border/70 bg-transparent px-2.5 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
                />
                <select className="h-8 w-full rounded-lg border border-border/70 bg-transparent px-2.5 text-[12px] text-text outline-none focus:border-accent/50">
                  <option>JPEG — Quality 90</option>
                  <option>PNG</option>
                  <option>WebP</option>
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <button className="flex h-8 items-center rounded-lg border border-border/70 bg-transparent px-3 text-[12px] text-text transition-colors hover:bg-hover">
                  Cancel
                </button>
                <button className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-app transition-opacity hover:opacity-90">
                  <Check size={13} /> Save
                </button>
              </div>
            </div>
          </Section>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border/50 px-6 py-3">
          <p className="text-[11px] text-muted2">
            Review these tokens, then we will unify the codebase to match.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Exported component with trigger button ─────────────────── */
export default function DesignSystemPanel() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Trigger button — fixed bottom-left, raised above the sidebar's
          Settings entry so the two don't overlap (dev-only panel). */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-16 left-4 z-[8999] flex h-8 w-8 items-center justify-center rounded-lg border border-border/50 bg-panel text-muted shadow-lg transition-colors hover:bg-hover hover:text-accent"
        title="Design System"
      >
        <Palette size={14} />
      </button>

      {open && <Panel onClose={() => setOpen(false)} />}
    </>
  );
}
