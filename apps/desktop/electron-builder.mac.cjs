// electron-builder config for the Mac builds other than package.json's own
// (mac-builds.cjs): AFTERFRAME_MAC_BUILD names one. Same app, with that
// build's architecture, minimum macOS, sidecar and helpers.
//
//   bash scripts/dist-mac-build.sh intel [--release]

const { build } = require("./package.json");
const { macBuild } = require("./mac-builds.cjs");

const target = macBuild(process.env.AFTERFRAME_MAC_BUILD || "");
const intel = target.arch === "x64";

module.exports = {
  ...build,
  directories: { ...build.directories, output: `release/${target.name}` },
  // Its own sidecar (scripts/build-sidecar-mac.sh --build <name>).
  extraResources: build.extraResources.map((entry) =>
    entry.to === "sidecar/media-workspace" ? { ...entry, from: `../../services/sidecar/dist-${target.name}/media-workspace` } : entry,
  ),
  // sharp for this architecture only: the x64 packages come from
  // scripts/install-sharp-x64.mjs, next to the arm64 ones npm installed.
  files: intel
    ? [
      ...build.files.filter((pattern) => !pattern.includes("darwin-x64")),
      "!node_modules/@img/sharp-darwin-arm64/**",
      "!node_modules/@img/sharp-libvips-darwin-arm64/**",
    ]
    : build.files,
  // Its own update channel (electron/updater.js): this app reads
  // <name>-mac.yml, never latest-mac.yml, the Apple-silicon macOS 14 app's.
  // electron-updater tells builds apart by CPU only, so a shared file could
  // move a macOS 12 Mac onto an app that needs 14.
  publish: build.publish.map((entry) => ({ ...entry, channel: target.name })),
  mac: {
    ...build.mac,
    minimumSystemVersion: target.minimum,
    // The zip is what the app downloads to update itself; the DMG is for a
    // first install.
    target: [{ target: "dmg", arch: [target.arch] }, { target: "zip", arch: [target.arch] }],
    // The zip's name (the DMG has its own below): by default the macOS 12
    // Apple-silicon zip would take the macOS 14 one's,
    // AfterFrame-<version>-arm64-mac.zip, on the release.
    artifactName: `\${productName}-\${version}-${target.artifact}-mac.\${ext}`,
    // Its helpers (scripts/build-native.sh --build <name>), and the Core ML
    // models where people and depth can run.
    extraResources: [
      { from: `native/bin-${target.name}`, to: "native/bin" },
      ...(target.macos14Features ? [{ from: "native", to: "native", filter: ["*.mlpackage/**/*"] }] : []),
    ],
    notarize: process.env.AFTERFRAME_NOTARIZE === "1",
  },
  dmg: { ...build.dmg, artifactName: `\${productName}-\${version}-${target.artifact}.\${ext}` },
};
