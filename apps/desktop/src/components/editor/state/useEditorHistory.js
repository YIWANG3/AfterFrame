// Unified undo/redo history for the editor. ONE timeline holds combined
// snapshots of BOTH the transform state (crop/rotate/flip/zoom/canvas) AND the
// text/sticker layer stack, so a single undo/redo reverses the user's last
// action regardless of which it touched. Cmd+Z and every panel Undo button drive
// the same stack — no more split transform-vs-layer histories on different keys.
//
// Refs mirror the live values so pointer handlers can read/commit synchronously
// without waiting for a React re-render. `baseSnapshotRef` holds the initial
// centered-crop snapshot used by "Reset". Callers destructure with their prior
// names (apply/record/commitCurrent/undo/redo + the layer variants).

import { useRef, useState } from "react";
import { BASE_STATE, cloneState, stateEquals } from "./editorStateModel";

function cloneLayers(layers) {
  return (layers || []).map((l) => ({ ...l }));
}

// Value equality for a layer array. Reference-equal short-circuits (the common
// case when only the transform changed); otherwise a per-layer compare. Only
// runs at commit time (not per drag frame), so the stringify fallback is fine.
function layersEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

export function useEditorHistory() {
  const editorStateRef = useRef(cloneState(BASE_STATE));
  const layersRef = useRef([]);
  const historyRef = useRef([]); // [{ state, layers }]
  const historyIndexRef = useRef(-1);
  const baseSnapshotRef = useRef(null);
  // Coalescing a run of same-kind layer edits (a slider scrub, a typing burst)
  // into ONE undo step: a pending debounced commit whose "signature" is the
  // target layer + edited fields. A different signature / transform edit / undo
  // flushes it first so distinct actions stay separate.
  const layerCommitTimerRef = useRef(null);
  const layerCommitSigRef = useRef(null);
  const LAYER_COMMIT_MS = 350;
  const [editorState, setEditorState] = useState(cloneState(BASE_STATE));
  const [layers, setLayers] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  function syncHistory(nextHistory, nextIndex) {
    historyRef.current = nextHistory;
    historyIndexRef.current = nextIndex;
    setHistory(nextHistory);
    setHistoryIndex(nextIndex);
  }

  // Live transform update — no history entry (used per-frame during drags).
  function apply(nextState) {
    const snapshot = cloneState(nextState);
    editorStateRef.current = snapshot;
    setEditorState(snapshot);
    return snapshot;
  }

  // Live layer update — no history entry (used per-frame during layer drags).
  function applyLayers(nextLayers) {
    const snapshot = cloneLayers(nextLayers);
    layersRef.current = snapshot;
    setLayers(snapshot);
    return snapshot;
  }

  // True when {state, layers} is value-identical to the current head — recording
  // it would burn an undo step on a no-op (idle blur, unchanged re-commit).
  function equalsHead(state, layersValue) {
    const head = historyRef.current[historyIndexRef.current];
    return !!head && stateEquals(head.state, state) && layersEqual(head.layers, layersValue);
  }

  function pushEntry(state, layersValue) {
    const entry = { state: cloneState(state), layers: cloneLayers(layersValue) };
    const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
    nextHistory.push(entry);
    syncHistory(nextHistory, nextHistory.length - 1);
  }

  function pushCurrentIfChanged() {
    if (equalsHead(editorStateRef.current, layersRef.current)) return;
    pushEntry(editorStateRef.current, layersRef.current);
  }

  // Land a pending coalesced layer edit NOW as its own entry. Called before any
  // other kind of commit / undo so distinct actions never merge.
  function flushLayerCommit() {
    if (!layerCommitTimerRef.current) return;
    clearTimeout(layerCommitTimerRef.current);
    layerCommitTimerRef.current = null;
    layerCommitSigRef.current = null;
    pushCurrentIfChanged();
  }

  // Commit a transform change (keeps the current layers alongside it).
  function record(nextState) {
    flushLayerCommit();
    const snapshot = apply(nextState);
    if (equalsHead(snapshot, layersRef.current)) return snapshot;
    pushEntry(snapshot, layersRef.current);
    return snapshot;
  }

  // Commit a layer change immediately as one entry — discrete ops (add / delete /
  // reorder / align). Flushes any pending scrub first so they stay separate.
  function commitLayers(nextLayers) {
    flushLayerCommit();
    const snapshot = applyLayers(nextLayers);
    if (equalsHead(editorStateRef.current, snapshot)) return snapshot;
    pushEntry(editorStateRef.current, snapshot);
    return snapshot;
  }

  // Apply a layer edit live now, but DEBOUNCE the history entry, collapsing a run
  // of edits with the same signature (target + fields) into one undo step. A
  // different signature flushes the previous run first.
  function commitLayersCoalesced(nextLayers, signature) {
    if (layerCommitTimerRef.current && layerCommitSigRef.current !== signature) {
      flushLayerCommit(); // land the previous gesture (current live) before applying the new value
    }
    applyLayers(nextLayers);
    layerCommitSigRef.current = signature;
    if (layerCommitTimerRef.current) clearTimeout(layerCommitTimerRef.current);
    layerCommitTimerRef.current = setTimeout(() => {
      layerCommitTimerRef.current = null;
      layerCommitSigRef.current = null;
      pushCurrentIfChanged();
    }, LAYER_COMMIT_MS);
  }

  // Push the CURRENT live {state, layers} — used at the end of a drag, which
  // applies intermediate values live (no history) then commits the final one.
  function commitCurrent() {
    flushLayerCommit();
    pushCurrentIfChanged();
  }

  function restore(index) {
    const entry = historyRef.current[index];
    if (!entry) return;
    apply(entry.state);
    applyLayers(entry.layers);
  }

  function undo() {
    flushLayerCommit();
    if (historyIndexRef.current <= 0) return;
    const nextIndex = historyIndexRef.current - 1;
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
    restore(nextIndex);
  }

  function redo() {
    flushLayerCommit();
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    const nextIndex = historyIndexRef.current + 1;
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
    restore(nextIndex);
  }

  return {
    editorState, editorStateRef,
    layers, layersRef,
    history, historyIndex, historyRef, historyIndexRef,
    baseSnapshotRef,
    syncHistory, apply, applyLayers,
    record, commitLayers, commitLayersCoalesced, flushLayerCommit, commitCurrent,
    undo, redo,
  };
}
