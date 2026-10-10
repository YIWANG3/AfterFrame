// The four Mac builds: Apple silicon and Intel, each for macOS 14+ and for
// macOS 12+.
//
// - The arm64 build for macOS 14+ is package.json build itself (dist:mac).
// - The other three derive from it (electron-builder.mac.cjs, built by
//   scripts/dist-mac-build.sh into release/<name>/).
// - The macOS 12 builds have no people, depth or stickers: their Core ML models
//   and Vision request need macOS 14. They leave those helpers out, and
//   electron/capabilities.js locks what's missing.
//
// Read by the build scripts too: node -p "require('./mac-builds.cjs').macBuild('intel').arch"

const { build } = require("./package.json");

const LATEST = build.mac.minimumSystemVersion; // 14.0
const MONTEREY = "12.0";

const BUILDS = {
  arm64: { arch: "arm64", minimum: LATEST, artifact: "arm64" },
  intel: { arch: "x64", minimum: LATEST, artifact: "Intel" },
  "macos12-arm64": { arch: "arm64", minimum: MONTEREY, artifact: "macOS12-arm64" },
  "macos12-intel": { arch: "x64", minimum: MONTEREY, artifact: "macOS12-Intel" },
};

function macBuild(name) {
  const found = BUILDS[name];
  if (!found) throw new Error(`Unknown Mac build "${name}"; one of: ${Object.keys(BUILDS).join(", ")}`);
  // people, depth and stickers: the helpers that need macOS 14.
  return { name, ...found, macos14Features: found.minimum === LATEST };
}

module.exports = { BUILDS, macBuild };
