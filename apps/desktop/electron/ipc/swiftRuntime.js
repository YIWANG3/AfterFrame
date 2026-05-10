// Find a usable swift binary. Xcode's toolchain is preferred since it ships
// with the right SDK for the macOS we're targeting; falls back to the bundled
// /usr/bin/swift on systems without Xcode (less reliable for recent APIs).

const fs = require("fs");

let cached = null;

function findSwiftRuntime() {
  if (cached) return cached;
  const xcodeSwift = "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift";
  const xcodeDeveloper = "/Applications/Xcode.app/Contents/Developer";
  if (fs.existsSync(xcodeSwift)) {
    cached = { binary: xcodeSwift, developerDir: xcodeDeveloper };
    return cached;
  }
  cached = { binary: "/usr/bin/swift", developerDir: null };
  return cached;
}

module.exports = { findSwiftRuntime };
