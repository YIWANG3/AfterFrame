// Paste the copied edits onto many photos, one at a time. Each target is read
// from its ORIGINAL file and written next to it as <name>_edited.<ext> (never
// over an existing file), then registered as a version of that photo.
// Sequential on purpose: sharp decodes at full resolution, and a 100 MP file
// with a straighten angle holds a ~300 MB raw buffer.
import api from "../api";
import { canPasteOnto, planForTarget } from "../components/editor/pasteEdits";
import { deriveEditedFileName, replaceFileName } from "../components/editor/render/canvasHelpers";

export async function runPasteEdits(clipboard, items, { onProgress } = {}) {
  const targets = items.filter(canPasteOnto);
  const result = { saved: [], skipped: items.length - targets.length, failed: 0 };
  let done = 0;
  for (const item of targets) {
    try {
      const size = await api.imageDisplaySize(item.image_path);
      const plan = planForTarget(clipboard, size);
      if (!plan) throw new Error("Could not read the photo's size");
      const saved = await api.processAndSave({
        sourcePath: item.image_path,
        savePath: replaceFileName(item.image_path, deriveEditedFileName(item.image_path)),
        ...plan,
        quality: 92,
        avoidOverwrite: true,
      });
      // Same stance as the editor's save: the file is the result, the catalog
      // entry is a convenience.
      try { await api.quickRegister(saved.path, item.image_path); }
      catch (error) { console.warn("[paste-edits] quickRegister skipped:", error?.message || error); }
      result.saved.push(saved.path);
    } catch (error) {
      console.error("[paste-edits] failed for", item.image_path, error);
      result.failed += 1;
    }
    done += 1;
    onProgress?.({ done, total: targets.length });
  }
  return result;
}
