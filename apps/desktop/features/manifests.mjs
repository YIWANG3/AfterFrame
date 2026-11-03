// The one static list of feature manifests (see README.md in this directory).
// Pure data: both the main process (electron/features.js) and the renderer
// (features/index.js, shared/ipcChannels.mjs) import it. The list is checked
// against manifest v1 here, once, so a wrong manifest fails at startup in
// whichever process imports it first, naming the field.
import { validateManifests } from "./manifestSchema.mjs";
import lut from "./lut/manifest.mjs";
import repaint from "./repaint/manifest.mjs";
import sticker from "./sticker/manifest.mjs";

export default validateManifests([lut, repaint, sticker]);
