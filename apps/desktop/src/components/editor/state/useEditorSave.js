// Save / export pipeline for the editor. Owns the `saving` flag and the three
// entry points (execute to a path, Export = pick-a-path, Quick Save = derive a
// path), delegating the actual compositing to saveEditedImage. Extracted from
// EditorOverlay (Phase 2).
//
// The caller passes `buildSaveArgs(savePath)` — a closure that assembles the
// full saveEditedImage argument object from the editor's current state. It's
// read through a ref so `executeSave`/`executeSaveRef` always run against the
// latest state (the E2E backdoor calls executeSaveRef after transforms). The
// path refs are owned by EditorOverlay (reset + Apply also touch them) and
// passed in.

import api from "../../../api";
import { useRef, useState } from "react";
import { saveEditedImage } from "../render/saveImage";
import { deriveEditedFileName, replaceFileName } from "../render/canvasHelpers";

const SAVE_FILTERS = [
  { name: "JPEG", extensions: ["jpg", "jpeg"] },
  { name: "PNG", extensions: ["png"] },
  { name: "WebP", extensions: ["webp"] },
];

export function useEditorSave({
  saveBasePath, buildSaveArgs, canSave, quickSavePathRef,
  onSaveComplete, pushToast, t, onSaveStart,
}) {
  const [saving, setSaving] = useState(false);
  // Latest-value refs so the async callbacks don't capture stale closures.
  const buildArgsRef = useRef(buildSaveArgs); buildArgsRef.current = buildSaveArgs;
  const canSaveRef = useRef(canSave); canSaveRef.current = canSave;
  const savingRef = useRef(false); savingRef.current = saving;
  const executeSaveRef = useRef(null);

  async function executeSave(savePath) {
    setSaving(true);
    onSaveStart?.();
    try {
      await saveEditedImage(buildArgsRef.current(savePath));
      onSaveComplete?.(savePath);
    } catch (error) {
      pushToast?.({
        title: t("overlay.saveFailed"),
        message: error instanceof Error ? error.message : t("overlay.saveFailedMsg"),
        ttl: 20_000,
      });
    } finally {
      setSaving(false);
    }
  }
  executeSaveRef.current = executeSave;

  async function handleExport() {
    if (!canSaveRef.current() || savingRef.current) return;
    const defaultPath = replaceFileName(saveBasePath, deriveEditedFileName(saveBasePath));
    const savePath = await api.pickSavePath({ defaultPath, filters: SAVE_FILTERS });
    if (!savePath) return;
    await executeSave(savePath);
  }

  async function handleQuickSave() {
    if (!canSaveRef.current() || savingRef.current) return;
    if (!quickSavePathRef.current) {
      quickSavePathRef.current = replaceFileName(saveBasePath, deriveEditedFileName(saveBasePath));
    }
    await executeSave(quickSavePathRef.current);
  }

  return { saving, executeSave, executeSaveRef, handleExport, handleQuickSave };
}
