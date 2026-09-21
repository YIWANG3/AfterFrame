// Dev only (the main process answers "not stale" in a packaged app). Vite
// keeps this renderer current; the Electron main process and the sidecar stay
// whatever they were at launch. When their sources have moved on, say so: a
// newer renderer talking to an older process fails quietly, and it looks like
// a bug in whatever feature was just written (electron/devStaleness.js).
import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import api from "../api";

export default function DevStaleNotice() {
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!api.has("getDevStaleness")) return undefined;
    let alive = true;
    const check = () => {
      Promise.resolve(api.getDevStaleness()).then((next) => { if (alive) setState(next); }).catch(() => {});
    };
    check();
    // Coming back from the editor is exactly when the answer changes.
    window.addEventListener("focus", check);
    const timer = setInterval(check, 20_000);
    return () => { alive = false; window.removeEventListener("focus", check); clearInterval(timer); };
  }, []);

  if (!state?.stale) return null;
  const names = state.files.map((file) => file.split("/").pop()).join(", ");
  return (
    <div
      data-dev-stale="true"
      className="floating-status-card pointer-events-auto flex w-[340px] items-center gap-2 p-3"
      title={state.files.join("\n")}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-text">Main process is running old code</div>
        <div className="mt-0.5 truncate text-[11px] text-muted">
          {state.count} file{state.count === 1 ? "" : "s"} changed since launch: {names}
        </div>
      </div>
      <button
        type="button"
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-[rgba(var(--accent-color),0.10)] px-2.5 text-[11px] font-medium text-[rgb(var(--accent-color))] transition-colors hover:bg-[rgba(var(--accent-color),0.18)]"
        onClick={() => api.relaunchApp()}
      >
        <RotateCw className="h-3 w-3" />
        Restart
      </button>
    </div>
  );
}
