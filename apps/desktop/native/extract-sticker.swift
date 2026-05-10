import Foundation
import Vision
import CoreImage
import AppKit

// AfterFrame sticker extractor.
// Runs Apple's VNGenerateForegroundInstanceMaskRequest on an image and emits
// one transparent PNG per detected subject instance at full source resolution
// (the renderer crops/pads to the bbox itself when displaying thumbnails).
//
// Output layout:
//   <out-dir>/instance_0.png
//   <out-dir>/instance_1.png
//   ...
//   <out-dir>/manifest.json   { "instances": [{ index, bbox: {x,y,w,h}, width, height }, ...] }

func usage() -> Never {
    FileHandle.standardError.write(Data(
        "Usage: extract-sticker <input-image> <output-dir>\n".utf8
    ))
    exit(64)
}

guard CommandLine.arguments.count >= 3 else { usage() }
let inputPath = CommandLine.arguments[1]
let outDirPath = CommandLine.arguments[2]

guard FileManager.default.fileExists(atPath: inputPath) else {
    FileHandle.standardError.write(Data("Input not found: \(inputPath)\n".utf8))
    exit(66)
}

try? FileManager.default.createDirectory(atPath: outDirPath, withIntermediateDirectories: true)

let inputURL = URL(fileURLWithPath: inputPath)
let outDirURL = URL(fileURLWithPath: outDirPath)

// MARK: - Run instance segmentation

guard let cgImage = NSImage(contentsOf: inputURL).flatMap({ image -> CGImage? in
    var rect = NSRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}) else {
    FileHandle.standardError.write(Data("Failed to decode input image\n".utf8))
    exit(67)
}

let imageW = CGFloat(cgImage.width)
let imageH = CGFloat(cgImage.height)

let request: VNGenerateForegroundInstanceMaskRequest
if #available(macOS 14.0, *) {
    request = VNGenerateForegroundInstanceMaskRequest()
} else {
    FileHandle.standardError.write(Data("Requires macOS 14 or later.\n".utf8))
    exit(68)
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write(Data("Vision request failed: \(error.localizedDescription)\n".utf8))
    exit(69)
}

guard let observation = request.results?.first as? VNInstanceMaskObservation else {
    // No subject found — write empty manifest and exit 0; the UI surfaces this
    // as "No subject detected" via toast.
    let manifest: [String: Any] = ["instances": [Any]()]
    if let data = try? JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted]) {
        try? data.write(to: outDirURL.appendingPathComponent("manifest.json"))
    }
    print("0 instances")
    exit(0)
}

let instances = observation.allInstances

// MARK: - Emit one PNG per instance

let ciContext = CIContext()
var manifestEntries: [[String: Any]] = []

for (idx, instanceIndex) in instances.enumerated() {
    do {
        // generateMaskedImage returns the original RGB content with alpha = mask
        let maskedBuffer = try observation.generateMaskedImage(
            ofInstances: IndexSet(integer: instanceIndex),
            from: handler,
            croppedToInstancesExtent: false,
        )

        let ciImage = CIImage(cvPixelBuffer: maskedBuffer)
        guard let fullCG = ciContext.createCGImage(ciImage, from: ciImage.extent) else {
            FileHandle.standardError.write(Data("Failed to render instance \(idx)\n".utf8))
            continue
        }

        // Crop to the alpha bounding box so the saved PNG doesn't carry the
        // entire source image's transparent padding. The manifest still records
        // the original bbox in source-image coordinates for downstream use.
        let bbox = computeAlphaBBox(cgImage: fullCG)
        let outCG: CGImage
        if bbox.size.width > 0 && bbox.size.height > 0 {
            // Add a 1px safety border to avoid clipping anti-aliased edges.
            let pad: CGFloat = 1
            let crop = CGRect(
                x: max(0, bbox.origin.x - pad),
                y: max(0, bbox.origin.y - pad),
                width: min(CGFloat(fullCG.width) - max(0, bbox.origin.x - pad), bbox.size.width + pad * 2),
                height: min(CGFloat(fullCG.height) - max(0, bbox.origin.y - pad), bbox.size.height + pad * 2),
            )
            outCG = fullCG.cropping(to: crop) ?? fullCG
        } else {
            outCG = fullCG
        }

        let bitmapRep = NSBitmapImageRep(cgImage: outCG)
        guard let pngData = bitmapRep.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write(Data("PNG encode failed for instance \(idx)\n".utf8))
            continue
        }

        let outURL = outDirURL.appendingPathComponent("instance_\(idx).png")
        try pngData.write(to: outURL)

        manifestEntries.append([
            "index": idx,
            "filename": "instance_\(idx).png",
            // bbox in original source-image coords (top-left origin)
            "bbox": [
                "x": bbox.origin.x,
                "y": bbox.origin.y,
                "w": bbox.size.width,
                "h": bbox.size.height,
            ],
            // dimensions of the cropped PNG that was actually written
            "width": outCG.width,
            "height": outCG.height,
        ])
    } catch {
        FileHandle.standardError.write(Data("Instance \(idx) failed: \(error.localizedDescription)\n".utf8))
    }
}

let manifest: [String: Any] = [
    "instances": manifestEntries,
    "sourceWidth": Int(imageW),
    "sourceHeight": Int(imageH),
]
let manifestURL = outDirURL.appendingPathComponent("manifest.json")
let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted])
try manifestData.write(to: manifestURL)

print("\(manifestEntries.count) instances")

// MARK: - Helpers

func computeAlphaBBox(cgImage: CGImage) -> CGRect {
    let w = cgImage.width
    let h = cgImage.height
    guard let provider = cgImage.dataProvider, let data = provider.data else {
        return CGRect(x: 0, y: 0, width: w, height: h)
    }
    let bytes = CFDataGetBytePtr(data)!
    let bytesPerRow = cgImage.bytesPerRow
    let bytesPerPixel = cgImage.bitsPerPixel / 8
    let alphaInfo = cgImage.alphaInfo
    let alphaIdx: Int
    switch alphaInfo {
    case .premultipliedFirst, .first:
        alphaIdx = 0
    case .premultipliedLast, .last:
        alphaIdx = 3
    default:
        return CGRect(x: 0, y: 0, width: w, height: h)
    }

    var minX = w, minY = h, maxX = -1, maxY = -1
    for y in 0..<h {
        let rowOffset = y * bytesPerRow
        for x in 0..<w {
            let pixelOffset = rowOffset + x * bytesPerPixel
            if bytes[pixelOffset + alphaIdx] > 0 {
                if x < minX { minX = x }
                if y < minY { minY = y }
                if x > maxX { maxX = x }
                if y > maxY { maxY = y }
            }
        }
    }
    if maxX < 0 { return CGRect(x: 0, y: 0, width: 0, height: 0) }
    return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
}
