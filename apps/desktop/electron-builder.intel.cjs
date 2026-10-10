// The Intel build: x64, for macOS 12 and later. Same app as the regular arm64
// build (package.json build), minus what needs Apple silicon and macOS 14:
// people, depth and stickers, which electron/capabilities.js locks. Apple
// silicon Macs still on macOS 12–13 run it too, through Rosetta.
//
//   npm run dist:mac:intel            # unsigned, for testing
//   npm run dist:mac:intel:release    # signed + notarized (as dist:mac:release)

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { build } = require("./package.json");

const MINIMUM = "12.0";

module.exports = {
  ...build,
  // The x64 sidecar (scripts/build-sidecar-mac.sh --intel).
  extraResources: build.extraResources.map((entry) =>
    entry.to === "sidecar/media-workspace" ? { ...entry, from: "../../services/sidecar/dist-x64/media-workspace" } : entry,
  ),
  // sharp's x64 binaries come from scripts/install-sharp-x64.mjs; the arm64
  // ones npm installed on this Mac stay out.
  files: [...build.files, "!node_modules/@img/sharp-darwin-arm64/**", "!node_modules/@img/sharp-libvips-darwin-arm64/**"],
  mac: {
    ...build.mac,
    minimumSystemVersion: MINIMUM,
    target: [{ target: "dmg", arch: ["x64"] }],
    // Only video-tool (scripts/build-native.sh --intel), and no Core ML models.
    extraResources: [{ from: "native/bin-x64", to: "native/bin" }],
    notarize: process.env.AFTERFRAME_NOTARIZE === "1",
  },
  dmg: { ...build.dmg, artifactName: "${productName}-${version}-Intel.${ext}" },
  // Every binary in the app must run on an Intel Mac with macOS 12.
  afterPack: async ({ appOutDir, packager }) => {
    const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
    const check = path.join(__dirname, "scripts", "check-macos-minimum.mjs");
    execFileSync(process.execPath, [check, "--minimum", MINIMUM, "--arch", "x86_64", app], { stdio: "inherit" });
  },
};
