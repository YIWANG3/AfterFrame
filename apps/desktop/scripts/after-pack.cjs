// electron-builder afterPack (package.json build.afterPack, so every Mac build):
// every binary in the packaged app must run on the build's oldest macOS and
// have its architecture. The four Mac builds (mac-builds.cjs) are made on one
// Apple silicon Mac, where an arm64 file in the Intel app, or one built for a
// newer macOS, would otherwise slip through unnoticed.

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Arch } = require("electron-builder");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const minimum = context.packager.platformSpecificBuildOptions.minimumSystemVersion;
  const arch = context.arch === Arch.x64 ? "x86_64" : Arch[context.arch];
  const check = path.join(__dirname, "check-macos-minimum.mjs");
  execFileSync(process.execPath, [check, "--minimum", minimum, "--arch", arch, app], { stdio: "inherit" });
};
