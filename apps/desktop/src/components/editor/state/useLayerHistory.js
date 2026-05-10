import { useRef, useState } from "react";

// Undo/redo stack for the text + sticker layers in the editor. Each commit
// pushes a deep-cloned snapshot onto a single linear history; undo/redo just
// shifts the index. Reset wipes everything; reset-hard skips the commit and
// is used when loading a fresh image (no history to roll back to).
export function useLayerHistory() {
  const [layers, setLayers] = useState([]);
  const historyRef = useRef([[]]);
  const indexRef = useRef(0);

  function commit(nextLayers) {
    const snap = nextLayers.map((l) => ({ ...l }));
    historyRef.current = historyRef.current.slice(0, indexRef.current + 1);
    historyRef.current.push(snap);
    indexRef.current = historyRef.current.length - 1;
    setLayers(snap);
  }
  function undo() {
    if (indexRef.current <= 0) return;
    indexRef.current--;
    setLayers(historyRef.current[indexRef.current]);
  }
  function redo() {
    if (indexRef.current >= historyRef.current.length - 1) return;
    indexRef.current++;
    setLayers(historyRef.current[indexRef.current]);
  }
  // Soft reset: clears layers but keeps the action in history so the user
  // can still undo back to whatever they had.
  function reset() {
    commit([]);
  }
  // Hard reset: wipe layers AND history. Used when the editor opens a fresh
  // image — there's nothing to undo to.
  function resetHard() {
    setLayers([]);
    historyRef.current = [[]];
    indexRef.current = 0;
  }
  function canUndo() {
    return indexRef.current > 0;
  }
  function canRedo() {
    return indexRef.current < historyRef.current.length - 1;
  }

  return {
    layers, setLayers,
    historyRef, indexRef,
    commit, undo, redo, reset, resetHard,
    canUndo, canRedo,
  };
}
