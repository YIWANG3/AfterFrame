// Vertical tool switcher on the right edge of the editor. Presentational —
// owns no state; the parent passes the active tool + a single onSelect(toolKey)
// handler (which also resets the depth-map overlay for non-text tools).
// Which tools, in what order, with what icon: editorTools.js. Extracted from
// EditorOverlay (Phase 4).

import api from "../../../api";
import { LOCKED_HINT_KEY } from "../../DesktopOnly";
import { EDITOR_TOOLS } from "../editorTools";

function ToolTab({ active, icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      data-testid={`tool-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={[
        "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-[rgb(var(--accent-color)/0.16)] text-[rgb(var(--accent-color))]"
          : "text-muted2 hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

// A tool this build lacks: the button stays in place, greyed, and its title
// says what the tool needs (no test id — it is not a tool the tests can open).
function LockedTab({ icon: Icon, label, t }) {
  return (
    <button
      type="button"
      className="flex h-8 w-8 cursor-default items-center justify-center rounded-md text-muted2/50"
      title={`${label} · ${t(LOCKED_HINT_KEY, { ns: "common" })}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export default function ToolRail({ tool, onSelect, t }) {
  return (
    <div
      className="pointer-events-auto flex w-12 flex-col items-center gap-2 rounded-xl border border-border/60 bg-chrome/95 p-1.5 shadow-overlay backdrop-blur-xl"
      data-editor-wheel-scope="toolbar"
    >
      {EDITOR_TOOLS.map(({ key, icon, labelKey, cap, unavailable }) => {
        const label = t(labelKey);
        if (cap && !api.can(cap)) {
          return unavailable === "locked" ? <LockedTab key={key} icon={icon} label={label} t={t} /> : null;
        }
        return <ToolTab key={key} active={tool === key} icon={icon} label={label} onClick={() => onSelect(key)} />;
      })}
    </div>
  );
}
