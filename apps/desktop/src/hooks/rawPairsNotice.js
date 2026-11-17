// Same-shot RAW+JPG pairs (docs/raw-jpg-pairing-plan.md): said once per
// catalog, the first time it has pairs. A new catalog merges them and offers
// to show them apart; an upgraded one keeps them apart and offers to merge.
// Whichever it is, the setting stays in Settings ▸ Library.
import api from "../api";

export const RAW_PAIRS_CHANGED = "afterframe:raw-pairs-changed";

export async function setRawPairsMode(mode) {
  const status = await api.setRawPairsMode(mode);
  window.dispatchEvent(new CustomEvent(RAW_PAIRS_CHANGED, { detail: status }));
  return status;
}

export async function maybeNoticeRawPairs({ t, pushToast }) {
  if (!api.has?.("rawPairsStatus")) return;
  let status;
  try {
    status = await api.rawPairsStatus();
  } catch {
    return;
  }
  if (!status || status.noticed || !(status.pairs > 0)) return;
  // Told now: a toast that times out unread is not shown again.
  await Promise.resolve(api.noticeRawPairs()).catch(() => null);
  const merged = status.mode === "merge";
  pushToast?.({
    title: t(merged ? "rawPairs.merged" : "rawPairs.found", { count: status.pairs }),
    ttl: 12000,
    actions: [{
      label: t(merged ? "rawPairs.separate" : "rawPairs.merge"),
      primary: !merged,
      onClick: () => void setRawPairsMode(merged ? "separate" : "merge"),
    }],
  });
}
