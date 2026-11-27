// AfterFrame image features helper.
//
// Apple Vision's image feature print (VNGenerateImageFeaturePrintRequest) for
// a photo: a unit-length float vector whose Euclidean distance says how alike
// two pictures look. The sidecar launches it for a visual-index job and keeps
// the vectors; this helper owns no catalog state.
//
// It also renders previews (op "thumb"): Image I/O decodes a JPEG or HEIF
// straight to the preview's size, where Pillow decodes a HEIF whole (600 ms
// for a 12 MP iPhone photo against 70 ms here). The sidecar keeps one helper
// per render thread and falls back to Pillow for whatever this declines.
//
// Usage:
//   image-features --serve            one JSON request per stdin line
//   image-features --model            the model name this Mac's prints carry
//   image-features --thumb-protocol   1: this build renders previews
//   image-features <image> [<image>…] one response line per argument
//
// Request:  {"id":"asset-42","path":"/path/to/preview.jpg"}
// Response: {"id":"asset-42","ok":true,"model":"vision-fp-r2","dim":768,"b64":"…"}
//           b64 is the vector as little-endian float32.
//           {"id":"asset-42","ok":false,"error":"…"} when the image can't be read.
//
// Request:  {"id":"asset-42","op":"thumb","path":"/photo.jpg","out":"/preview.jpg",
//            "size":512,"quality":0.8,"transform":false,"orientation":6}
//           orientation: the EXIF tag to write (default: the source's own);
//           transform: turn the pixels upright instead, and write none.
// Response: {"id":"asset-42","ok":true,"width":512,"height":384}
//           {"id":"asset-42","ok":false,"declined":true,"error":"…"} for a picture
//           the sidecar renders itself (see thumbnail()), ok false alone when
//           the file can't be read.
// stdout carries nothing else: anything a framework prints goes to stderr.

import Foundation
import ImageIO
import Vision

// Revision 2 (macOS 14) gives 768 values, revision 1 gives 2048, and the two
// are not comparable: the model name tells the sidecar which it has, so a
// catalog never mixes them without knowing.
private let request: VNGenerateImageFeaturePrintRequest = {
    let request = VNGenerateImageFeaturePrintRequest()
    if #available(macOS 14.0, *) {
        request.revision = VNGenerateImageFeaturePrintRequestRevision2
    } else {
        request.revision = VNGenerateImageFeaturePrintRequestRevision1
    }
    return request
}()

private var modelName: String {
    if #available(macOS 14.0, *) { return "vision-fp-r2" }
    return "vision-fp-r1"
}

private func featurePrint(_ path: String) throws -> VNFeaturePrintObservation {
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
    try handler.perform([request])
    guard let observation = request.results?.first else {
        throw NSError(domain: "image-features", code: 1, userInfo: [NSLocalizedDescriptionKey: "no feature print for \(path)"])
    }
    return observation
}

private func respond(id: String, path: String) {
    var response: [String: Any] = ["id": id]
    do {
        let observation = try featurePrint(path)
        guard observation.elementType == .float else {
            throw NSError(domain: "image-features", code: 2, userInfo: [NSLocalizedDescriptionKey: "unexpected element type"])
        }
        response["ok"] = true
        response["model"] = modelName
        response["dim"] = observation.elementCount
        response["b64"] = observation.data.base64EncodedString()
    } catch {
        response["ok"] = false
        response["error"] = error.localizedDescription
    }
    let data = try! JSONSerialization.data(withJSONObject: response)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private struct ThumbnailError: Error {
    let message: String
    /// The picture is fine but not one this renders exactly as the sidecar's
    /// Pillow path does: the sidecar renders it itself.
    var declined = false
}

/// A JPEG preview of `path` at most `size` px on its long edge, written to
/// `out`, the same picture the sidecar's Pillow path makes:
/// - pixels as stored with the EXIF orientation carried over (`orientation`
///   when the sidecar names it: the tag Pillow reads), unless `transform`
///   (pillow-heif hands a HEIF over upright, without the tag);
/// - the source's RGB colour space kept (a Display P3 photo stays P3);
/// - never enlarged.
/// Anything else that path treats specially is declined rather than
/// approximated: CMYK and grey (converted to sRGB there), transparency
/// (flattened onto white), more than 8 bits a channel (a camera's HDR HEIF).
private func thumbnail(path: String, out: String, size: Int, quality: Double, transform: Bool, orientation: Int?) throws -> (Int, Int) {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else {
        throw ThumbnailError(message: "can't open \(path)")
    }
    let index = CGImageSourceGetPrimaryImageIndex(source)
    guard let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any] else {
        throw ThumbnailError(message: "can't read \(path)")
    }
    let colorModel = properties[kCGImagePropertyColorModel] as? String
    guard colorModel == (kCGImagePropertyColorModelRGB as String) else {
        throw ThumbnailError(message: "colour model \(colorModel ?? "unknown")", declined: true)
    }
    if (properties[kCGImagePropertyHasAlpha] as? Bool) == true {
        throw ThumbnailError(message: "transparency", declined: true)
    }
    if let depth = properties[kCGImagePropertyDepth] as? Int, depth > 8 {
        throw ThumbnailError(message: "\(depth) bits a channel", declined: true)
    }
    let width = properties[kCGImagePropertyPixelWidth] as? Int ?? 0
    let height = properties[kCGImagePropertyPixelHeight] as? Int ?? 0
    guard width > 0, height > 0 else { throw ThumbnailError(message: "no size for \(path)") }
    let tag = orientation ?? properties[kCGImagePropertyOrientation] as? Int ?? 1
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,  // never the small embedded one
        kCGImageSourceThumbnailMaxPixelSize: min(size, max(width, height)),
        kCGImageSourceCreateThumbnailWithTransform: transform,
        kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) else {
        throw ThumbnailError(message: "can't decode \(path)")
    }
    guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, "public.jpeg" as CFString, 1, nil) else {
        throw ThumbnailError(message: "can't write \(out)")
    }
    var written: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
    if !transform && tag != 1 {
        written[kCGImagePropertyOrientation] = tag
    }
    CGImageDestinationAddImage(destination, image, written as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw ThumbnailError(message: "can't write \(out)") }
    return (image.width, image.height)
}

private func respondThumbnail(id: String, request: [String: Any]) {
    var response: [String: Any] = ["id": id]
    do {
        guard let path = request["path"] as? String, let out = request["out"] as? String else {
            throw ThumbnailError(message: "thumb needs path and out")
        }
        let (width, height) = try thumbnail(
            path: path,
            out: out,
            size: request["size"] as? Int ?? 512,
            quality: request["quality"] as? Double ?? 0.8,
            transform: request["transform"] as? Bool ?? false,
            orientation: request["orientation"] as? Int
        )
        response["ok"] = true
        response["width"] = width
        response["height"] = height
    } catch let error as ThumbnailError {
        response["ok"] = false
        response["error"] = error.message
        if error.declined { response["declined"] = true }
    } catch {
        response["ok"] = false
        response["error"] = error.localizedDescription
    }
    let data = try! JSONSerialization.data(withJSONObject: response)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--serve" {
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty else { continue }
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let path = object["path"] as? String else {
            FileHandle.standardError.write(Data("image-features: bad request line\n".utf8))
            continue
        }
        // Each request is answered before the next is read. Vision loads its
        // model on the first print, so a helper that only renders previews
        // never does.
        if object["op"] as? String == "thumb" {
            autoreleasepool { respondThumbnail(id: (object["id"] as? String) ?? path, request: object) }
        } else {
            respond(id: (object["id"] as? String) ?? path, path: path)
        }
    }
} else if arguments.first == "--model" {
    print(modelName)
} else if arguments.first == "--thumb-protocol" {
    print(1)
} else if arguments.isEmpty {
    FileHandle.standardError.write(Data("Usage: image-features --serve | image-features <image>...\n".utf8))
    exit(64)
} else {
    for path in arguments { respond(id: path, path: path) }
}
