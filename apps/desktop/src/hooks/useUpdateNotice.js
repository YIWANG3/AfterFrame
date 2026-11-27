// A version the app found by itself (electron/updater.js's daily check) is
// said once, in a toast that leads to Settings ▸ About. A check the user asked
// for is already on screen there, so it gets no toast.
import { useEffect } from "react";
import useUpdateState from "./useUpdateState";
import { readPref, writePref } from "../utils/prefs";

const TOLD_PREF = "updates.toldVersion";

export default function useUpdateNotice({ t, pushToast }) {
  const update = useUpdateState();
  const version = update?.status === "available" && update.background ? update.version : null;
  useEffect(() => {
    if (!version || readPref(TOLD_PREF, null) === version) return;
    writePref(TOLD_PREF, version);
    pushToast?.({
      title: t("update.available", { version }),
      ttl: 12_000,
      actions: [{
        label: t("update.show"),
        primary: true,
        onClick: () => window.dispatchEvent(new CustomEvent("afterframe:open-settings", { detail: { tab: "about" } })),
      }],
    });
  }, [version, t, pushToast]);
}
