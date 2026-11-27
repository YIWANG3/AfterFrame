// The app's update state (electron/updater.js): read once, then kept current
// by the main process's pushes. null where there is no updater (the web build).
import { useEffect, useState } from "react";
import api from "../api";

export default function useUpdateState() {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!api.has("getUpdateState")) return undefined;
    let alive = true;
    const unsubscribe = api.onUpdateChanged((next) => { if (alive) setState(next); });
    Promise.resolve(api.getUpdateState())
      .then((next) => { if (alive) setState((current) => current || next); })
      .catch(() => {});
    return () => { alive = false; unsubscribe?.(); };
  }, []);
  return state;
}

// A version the user can be told about: found, downloading or downloaded.
export const hasUpdate = (state) => ["available", "downloading", "ready"].includes(state?.status);
