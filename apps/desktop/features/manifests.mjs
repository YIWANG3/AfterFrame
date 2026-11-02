// The one static list of feature manifests (see README.md in this directory).
// Pure data: both the main process (electron/features.js) and the renderer
// (features/index.js, shared/ipcChannels.mjs) import it.
import lut from "./lut/manifest.mjs";

export default [lut];
