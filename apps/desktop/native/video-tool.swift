import Foundation
import AVFoundation
import AppKit

// AfterFrame video helper (AVFoundation, no ffmpeg).
//   probe  <input>                         -> JSON metadata on stdout
//   poster <input> <out.jpg> [--max-edge N]
//   frames <input> <out-dir> [--count N | --interval SECONDS] [--max N] [--max-edge N]
//
// `frames` samples evenly across the clip (or one frame every INTERVAL seconds)
// and writes frame_0.jpg, frame_1.jpg, … plus a manifest.json. Picture only —
// audio is ignored by design. Frames feed the multi-image AI annotator; poster
// feeds the gallery thumbnail.

func fail(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

func arg(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

// Encode a CGImage to JPEG on disk, optionally downscaled to maxEdge (longest side).
func writeJPEG(_ cg: CGImage, to path: String, maxEdge: Int) {
    var image = cg
    let longest = max(cg.width, cg.height)
    if maxEdge > 0 && longest > maxEdge {
        let scale = Double(maxEdge) / Double(longest)
        let w = Int((Double(cg.width) * scale).rounded())
        let h = Int((Double(cg.height) * scale).rounded())
        if let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) {
            ctx.interpolationQuality = .high
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            if let scaled = ctx.makeImage() { image = scaled }
        }
    }
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
        fail("failed to encode JPEG for \(path)", 72)
    }
    do {
        try data.write(to: URL(fileURLWithPath: path))
    } catch {
        fail("failed to write \(path): \(error.localizedDescription)", 73)
    }
}

func loadAsset(_ inputPath: String) -> AVURLAsset {
    let url = URL(fileURLWithPath: inputPath)
    guard FileManager.default.fileExists(atPath: inputPath) else { fail("input not found: \(inputPath)", 66) }
    return AVURLAsset(url: url)
}

func videoTrack(_ asset: AVURLAsset) -> AVAssetTrack {
    guard let track = asset.tracks(withMediaType: .video).first else { fail("no video track", 65) }
    return track
}

func makeGenerator(_ asset: AVURLAsset, maxEdge: Int) -> AVAssetImageGenerator {
    let gen = AVAssetImageGenerator(asset: asset)
    gen.appliesPreferredTrackTransform = true
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = .zero
    if maxEdge > 0 { gen.maximumSize = CGSize(width: maxEdge, height: maxEdge) }
    return gen
}

func cmd_probe(_ inputPath: String) {
    let asset = loadAsset(inputPath)
    let track = videoTrack(asset)
    let duration = CMTimeGetSeconds(asset.duration)
    let size = track.naturalSize.applying(track.preferredTransform)
    let width = Int(abs(size.width))
    let height = Int(abs(size.height))
    let fps = Double(track.nominalFrameRate)
    let hasAudio = !asset.tracks(withMediaType: .audio).isEmpty

    var codec = ""
    if let desc = track.formatDescriptions.first {
        // swiftlint:disable:next force_cast
        let fd = desc as! CMFormatDescription
        let sub = CMFormatDescriptionGetMediaSubType(fd)
        let bytes = [UInt8((sub >> 24) & 0xff), UInt8((sub >> 16) & 0xff), UInt8((sub >> 8) & 0xff), UInt8(sub & 0xff)]
        codec = String(bytes: bytes, encoding: .ascii)?.trimmingCharacters(in: .whitespaces) ?? ""
    }

    var creationDate: String? = nil
    if let date = asset.creationDate?.dateValue {
        let fmt = ISO8601DateFormatter()
        creationDate = fmt.string(from: date)
    }

    var out: [String: Any] = [
        "duration": duration.isFinite ? duration : 0,
        "width": width,
        "height": height,
        "fps": fps.isFinite ? fps : 0,
        "codec": codec,
        "hasAudio": hasAudio
    ]
    out["creationDate"] = creationDate as Any
    let data = try! JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func cmd_poster(_ inputPath: String, _ outPath: String, maxEdge: Int) {
    let asset = loadAsset(inputPath)
    _ = videoTrack(asset)
    let duration = CMTimeGetSeconds(asset.duration)
    let t = duration.isFinite && duration > 0 ? min(1.0, duration / 2.0) : 0.0
    let gen = makeGenerator(asset, maxEdge: maxEdge)
    do {
        let cg = try gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil)
        writeJPEG(cg, to: outPath, maxEdge: maxEdge)
    } catch {
        fail("poster extraction failed: \(error.localizedDescription)", 74)
    }
}

func cmd_frames(_ inputPath: String, _ outDir: String, maxEdge: Int) {
    let asset = loadAsset(inputPath)
    _ = videoTrack(asset)
    let duration = CMTimeGetSeconds(asset.duration)
    guard duration.isFinite && duration > 0 else { fail("invalid duration", 65) }

    let maxFrames = Int(arg("--max") ?? "20") ?? 20

    // Build sample timestamps: by interval, by explicit count, or adaptive.
    var times: [Double] = []
    if let intervalStr = arg("--interval"), let interval = Double(intervalStr), interval > 0 {
        var t = interval / 2.0
        while t < duration && times.count < maxFrames {
            times.append(t)
            t += interval
        }
        if times.isEmpty { times = [duration / 2.0] }
    } else {
        let count: Int
        if let cStr = arg("--count"), let c = Int(cStr), c > 0 {
            count = min(c, maxFrames)
        } else {
            count = max(3, min(8, Int((duration / 10.0).rounded())))
        }
        for i in 0..<count {
            times.append(duration * (Double(i) + 0.5) / Double(count))
        }
    }

    try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
    let gen = makeGenerator(asset, maxEdge: maxEdge)

    var manifest: [[String: Any]] = []
    for (idx, t) in times.enumerated() {
        do {
            let cg = try gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil)
            let name = "frame_\(idx).jpg"
            writeJPEG(cg, to: (outDir as NSString).appendingPathComponent(name), maxEdge: maxEdge)
            manifest.append(["index": idx, "time": t, "filename": name])
        } catch {
            FileHandle.standardError.write(Data("frame \(idx) @\(t)s failed: \(error.localizedDescription)\n".utf8))
        }
    }

    let out: [String: Any] = ["duration": duration, "count": manifest.count, "frames": manifest]
    let data = try! JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted])
    let manifestPath = (outDir as NSString).appendingPathComponent("manifest.json")
    try? data.write(to: URL(fileURLWithPath: manifestPath))
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    fail("usage: video-tool <probe|poster|frames> <input> [args]", 64)
}
let sub = args[1]
let input = args[2]
let maxEdge = Int(arg("--max-edge") ?? "0") ?? 0

switch sub {
case "probe":
    cmd_probe(input)
case "poster":
    guard args.count >= 4 else { fail("usage: video-tool poster <input> <out.jpg>", 64) }
    cmd_poster(input, args[3], maxEdge: maxEdge > 0 ? maxEdge : 1024)
case "frames":
    guard args.count >= 4 else { fail("usage: video-tool frames <input> <out-dir>", 64) }
    cmd_frames(input, args[3], maxEdge: maxEdge > 0 ? maxEdge : 512)
default:
    fail("unknown subcommand: \(sub)", 64)
}
