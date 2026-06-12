// The agent ↔ UI bridge, extracted from App.jsx (review P3-6). Three flows
// live together so their contract is visible in one place:
//
//  1. REVEAL (agent → UI): MCP show_in_app → reveal in gallery → select →
//     toast → ack {found, missing} back to the agent. workspace.revealAssets
//     opens a suppress window so the catalog-changed refresh below cannot
//     cancel the in-flight reveal (see useWorkspace).
//  2. AGENT-CHANGE TOAST: agent writes broadcast catalog-changed; views
//     refresh in useWorkspace, this surfaces the lightweight heads-up.
//  3. SELECTION MIRROR (UI → agent): every selection change is pushed to the
//     main process so MCP get_selection answers "these photos" instantly.

import { useEffect, useRef } from "react";
import api from "../api";

export default function useAgentBridge({
  revealAssets,
  lastAgentChange,
  selectedIds,
  setSelectedIds,
  setAnchorId,
  primaryId,
  itemById,
  pushToast,
  onBeforeReveal,
}) {
  // 1. Reveal — listener registers once; latest closure flows through a ref.
  const revealRef = useRef(null);
  revealRef.current = async ({ requestId, assetIds }) => {
    onBeforeReveal?.();
    const result = await revealAssets(assetIds || []);
    setSelectedIds(result.found);
    setAnchorId(result.found[0] || null);
    if (result.found.length || result.missing.length) {
      const missingNote = result.missing.length ? ` (${result.missing.length} not found)` : "";
      pushToast?.({
        title: "Agent",
        message: `Selected ${result.found.length} photo${result.found.length === 1 ? "" : "s"}${missingNote}.`,
        ttl: 4000,
      });
    }
    api.sendAgentRevealResult(requestId, result);
  };
  useEffect(() => {
    return api.onAgentRevealAssets((payload) => revealRef.current?.(payload));
  }, []);

  // 2. Agent-change toast
  useEffect(() => {
    if (!lastAgentChange) return;
    const n = lastAgentChange.ids?.length || 0;
    pushToast?.({
      title: "Agent",
      message:
        lastAgentChange.scope === "collections"
          ? "Collections updated."
          : `Updated ${n || "some"} item${n === 1 ? "" : "s"} in the library.`,
      ttl: 3500,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAgentChange]);

  // 3. Selection mirror — deduped, since itemById is rebuilt on every items
  // mutation (paging, polls, rating edits).
  const lastSentRef = useRef("");
  useEffect(() => {
    const ids = selectedIds.length ? selectedIds : [primaryId].filter(Boolean);
    const payload = ids
      .map((id) => itemById.get(id))
      .filter(Boolean)
      .map((item) => ({ asset_id: item.asset_id, stem: item.stem, export_path: item.export_path }));
    const serialized = JSON.stringify(payload);
    if (serialized === lastSentRef.current) return;
    lastSentRef.current = serialized;
    api.reportSelection(payload);
  }, [selectedIds, primaryId, itemById]);
}
