// In-process ImageIO thumbnail cost (what a resident helper would pay):
// decode at most 512 px on the long edge, orientation applied, JPEG out.
// usage: imageio_thumb <out dir> <file>...
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let outDir = URL(fileURLWithPath: args[1])
var byExt: [String: [Double]] = [:]
for path in args.dropFirst(2) {
    let url = URL(fileURLWithPath: path)
    let start = DispatchTime.now().uptimeNanoseconds
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { continue }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceThumbnailMaxPixelSize: 512,
        kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { continue }
    let target = outDir.appendingPathComponent(url.deletingPathExtension().lastPathComponent + ".imageio.jpg")
    guard let dest = CGImageDestinationCreateWithURL(target as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { continue }
    CGImageDestinationAddImage(dest, thumb, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    CGImageDestinationFinalize(dest)
    let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
    byExt[url.pathExtension.lowercased(), default: []].append(ms)
}
for (ext, times) in byExt.sorted(by: { $0.key < $1.key }) {
    let sorted = times.sorted()
    print(String(format: "ImageIO in-process thumbnail, %@: median %.1f ms (n=%d)", ext, sorted[sorted.count / 2], sorted.count))
}
