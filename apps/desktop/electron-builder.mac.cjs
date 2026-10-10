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
  mac: {
    ...build.mac,
    minimumSystemVersion: target.minimum,
    target: [{ target: "dmg", arch: [target.arch] }],
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
