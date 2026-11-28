// Builds the macOS app icon (build/icon.icns) from the full-bleed artwork in
// build/icon.png, which Windows uses as it is.
//
// macOS lays every app icon out on the same grid: the rounded square is
// 824 x 824 inside a 1024 x 1024 canvas, with a soft shadow under it. Artwork
// that fills the whole canvas shows up a size larger than every other app in
// the Dock, Launchpad and Finder.
//
//   cd apps/desktop
//   DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
//     swift scripts/make-mac-icon.swift build/icon.png build/icon.icns

import AppKit
import SwiftUI

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
  FileHandle.standardError.write("usage: make-mac-icon.swift <artwork.png> <out.icns>\n".data(using: .utf8)!)
  exit(64)
}
let sourceURL = URL(fileURLWithPath: arguments[1])
let outputURL = URL(fileURLWithPath: arguments[2])

guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let artwork = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  FileHandle.standardError.write("can't read \(sourceURL.path)\n".data(using: .utf8)!)
  exit(1)
}

// Apple's macOS app icon grid, in units of the 1024 canvas.
let canvas: CGFloat = 1024
let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let cornerRadius: CGFloat = 185.4
let shadowOffset: CGFloat = 12
let shadowBlur: CGFloat = 20
let shadowOpacity: CGFloat = 0.28

let bodyPath = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).path(in: body).cgPath
let black = CGColor(gray: 0, alpha: 1)

func render(pixels: Int) -> CGImage {
  let scale = CGFloat(pixels) / canvas
  let context = CGContext(
    data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.interpolationQuality = .high
  context.scaleBy(x: scale, y: scale)

  // Shadow offsets and blur ignore the transform, so they're scaled by hand.
  context.saveGState()
  context.setShadow(
    offset: CGSize(width: 0, height: -shadowOffset * scale),
    blur: shadowBlur * scale,
    color: CGColor(gray: 0, alpha: shadowOpacity))
  context.addPath(bodyPath)
  context.setFillColor(black)
  context.fillPath()
  context.restoreGState()

  // The artwork's background is black; filling first covers its own corners.
  context.saveGState()
  context.addPath(bodyPath)
  context.clip()
  context.setFillColor(black)
  context.fill(body)
  context.draw(artwork, in: body)
  context.restoreGState()

  return context.makeImage()!
}

let iconset = FileManager.default.temporaryDirectory
  .appendingPathComponent("make-mac-icon-\(ProcessInfo.processInfo.processIdentifier).iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

for points in [16, 32, 128, 256, 512] {
  for factor in [1, 2] {
    let name = factor == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
    let url = iconset.appendingPathComponent(name)
    let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, render(pixels: points * factor), nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("can't write \(name)") }
  }
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", outputURL.path]
try iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: iconset)
exit(iconutil.terminationStatus)
