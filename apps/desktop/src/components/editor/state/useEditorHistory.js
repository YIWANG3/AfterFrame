// Transform-state machine + undo/redo history for the editor. Owns the current
// editorState (crop/rotate/flip/zoom) and a stack of snapshots. Refs mirror the
// state so pointer handlers can read/commit synchronously without waiting for a
// React re-render. Extracted verbatim from EditorOverlay (Phase 1b).
//
// This is the TRANSFORM history only; text/sticker layers have their own stack
// (useLayerHistory). `baseSnapshotRef` holds the initial centered-crop snapshot
// used by "Reset". Callers destructure with their original names, e.g.
//   const { editorStateRef, apply: applyState, record: recordState, ... }
// so existing call sites stay unchanged.

import { useRef, useState } from "react";
import { BASE_STATE, cloneState } from "./editorStateModel";

export function useEditorHistory() {
  const editorStateRef = useRef(cloneState(BASE_STATE));
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);
  const baseSnapshotRef = useRef(null);
  const [editorState, setEditorState] = useState(cloneState(BASE_STATE));
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  function syncHistory(nextHistory, nextIndex) {
    historyRef.current = nextHistory;
    historyIndexRef.current = nextIndex;
    setHistory(nextHistory);
    setHistoryIndex(nextIndex);
  }

  function apply(nextState) {
    const snapshot = cloneState(nextState);
    editorStateRef.current = snapshot;
    setEditorState(snapshot);
    return snapshot;
  }

  function record(nextState) {
    const snapshot = apply(nextState);
    const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
    nextHistory.push(snapshot);
    syncHistory(nextHistory, nextHistory.length - 1);
    return snapshot;
  }

  function undo() {
    if (historyIndexRef.current <= 0) return;
    const nextIndex = historyIndexRef.current - 1;
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
    apply(historyRef.current[nextIndex]);
  }

  function redo() {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    const nextIndex = historyIndexRef.current + 1;
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
    apply(historyRef.current[nextIndex]);
  }

  return {
    editorState, editorStateRef,
    history, historyIndex, historyRef, historyIndexRef,
    baseSnapshotRef,
    syncHistory, apply, record, undo, redo,
  };
}
