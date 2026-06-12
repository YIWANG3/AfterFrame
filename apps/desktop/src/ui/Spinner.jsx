import { Loader2 } from "lucide-react";
import cx from "./cx";

// One spinner. Previously 8+ inline `animate-spin` with three different icons.
export default function Spinner({ className = "h-4 w-4", label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted2">
      <Loader2 className={cx("animate-spin", className)} />
      {label && <span className="text-[11px]">{label}</span>}
    </span>
  );
}
