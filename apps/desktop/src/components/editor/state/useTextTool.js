// Text tool — selection + clipboard + layer CRUD actions. Owns which layers are
// selected and the copy/paste clipboard; the layer STACK itself lives in
// useLayerHistory. Extracted from EditorOverlay (Phase 3b).
//
// The heavier "Apply text" bake (composite onto the source + reset the editor)
// stays in EditorOverlay — like the crop Apply, it's a cross-cutting operation,
// not tool-local state.

import { useRef, useState } from "react";
import { createDefaultLayer } from "../textState";
import { isTextLayer, moveLayerBy, removeLayerById } from "../layerStack";

export function useTextTool({ layers, layerHistory }) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const clipboardRef = useRef(null);
  const commit = layerHistory.commit;

  function moveLayer(id, direction) {
    commit(moveLayerBy(layers, id, direction));
  }

  function deleteLayer(id) {
    commit(removeLayerById(layers, id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function selectLayers(ids) {
    setSelectedIds(new Set(ids));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function addTextLayer(text) {
    const nl = createDefaultLayer({ text: text || "Test Text", x: 0.5, y: 0.5 });
    const next = [...layers, nl];
    commit(next);
    setSelectedIds(new Set([nl.id]));
    // Post-add count so callers (e2e) don't wait for a re-render.
    return { id: nl.id, count: next.length };
  }

  function copySelection() {
    const copied = layers.filter((l) => isTextLayer(l) && selectedIds.has(l.id)).map((l) => ({ ...l }));
    if (copied.length > 0) clipboardRef.current = copied;
  }

  function pasteClipboard() {
    if (!clipboardRef.current?.length) return;
    const pasted = clipboardRef.current.map((l) => {
      const { id, ...rest } = l;
      return createDefaultLayer({ ...rest, x: l.x + 0.02, y: l.y + 0.02 });
    });
    // Read the live layer stack from history (not the possibly-stale `layers`
    // closure) so rapid paste after another mutation doesn't clobber it.
    const currentLayers = layerHistory.historyRef.current[layerHistory.indexRef.current] || [];
    commit([...currentLayers, ...pasted]);
    setSelectedIds(new Set(pasted.map((p) => p.id)));
  }

  function deleteSelection() {
    if (selectedIds.size === 0) return;
    commit(layers.filter((l) => !selectedIds.has(l.id)));
    setSelectedIds(new Set());
  }

  return {
    selectedIds, setSelectedIds,
    moveLayer, deleteLayer, selectLayers, clearSelection, addTextLayer,
    copySelection, pasteClipboard, deleteSelection,
  };
}
