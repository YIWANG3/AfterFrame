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
// feeds the gallery thumbnail. Uses the async AVFoundation load APIs (macOS 13+).

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

func firstVideoTrack(_ asset: AVURLAsset) async -> AVAssetTrack {
    do {
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            fail("no video track", 65)
        }
        return track
    } catch {
        fail("failed to load tracks: \(error.localizedDescription)", 65)
    }
}

func durationSeconds(_ asset: AVURLAsset) async -> Double {
    do {
        return CMTimeGetSeconds(try await asset.load(.duration))
    } catch {
        fail("failed to load duration: \(error.localizedDescription)", 65)
    }
}

func makeGenerator(_ asset: AVURLAsset, maxEdge: Int) -> AVAssetImageGenerator {
    let gen = AVAssetImageGenerator(asset: asset)
    gen.appliesPreferredTrackTransform = true
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = .zero
    if maxEdge > 0 { gen.maximumSize = CGSize(width: maxEdge, height: maxEdge) }
    return gen
}

func copyFrame(_ gen: AVAssetImageGenerator, at seconds: Double) async throws -> CGImage {
    let (image, _) = try await gen.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
    return image
}

func cmd_probe(_ inputPath: String) async {
    let asset = loadAsset(inputPath)
    let track = await firstVideoTrack(asset)
    let duration = await durationSeconds(asset)

    var width = 0, height = 0, fps = 0.0
    var codec = ""
    do {
        let (naturalSize, transform, frameRate, formats) = try await track.load(
            .naturalSize, .preferredTransform, .nominalFrameRate, .formatDescriptions
        )
        let size = naturalSize.applying(transform)
        width = Int(abs(size.width))
        height = Int(abs(size.height))
        fps = Double(frameRate)
        if let fd = formats.first {
            let sub = CMFormatDescriptionGetMediaSubType(fd)
            let bytes = [UInt8((sub >> 24) & 0xff), UInt8((sub >> 16) & 0xff), UInt8((sub >> 8) & 0xff), UInt8(sub & 0xff)]
            codec = String(bytes: bytes, encoding: .ascii)?.trimmingCharacters(in: .whitespaces) ?? ""
        }
    } catch {
        fail("failed to load track metadata: \(error.localizedDescription)", 65)
    }

    let hasAudio = ((try? await asset.loadTracks(withMediaType: .audio))?.isEmpty == false)

    var creationDate: String? = nil
    if let item = try? await asset.load(.creationDate), let date = try? await item.load(.dateValue) {
        creationDate = ISO8601DateFormatter().string(from: date)
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

func cmd_poster(_ inputPath: String, _ outPath: String, maxEdge: Int) async {
    let asset = loadAsset(inputPath)
    _ = await firstVideoTrack(asset)
    let duration = await durationSeconds(asset)
    let t = duration.isFinite && duration > 0 ? min(1.0, duration / 2.0) : 0.0
    let gen = makeGenerator(asset, maxEdge: maxEdge)
    do {
        let cg = try await copyFrame(gen, at: t)
        writeJPEG(cg, to: outPath, maxEdge: maxEdge)
    } catch {
        fail("poster extraction failed: \(error.localizedDescription)", 74)
    }
}

// Sample timestamps. Floor is always 3 frames — first, middle, last — for any
// duration. An optional interval (one frame every N seconds) densifies longer
// clips; the first/middle/last anchors are always included, results are
// deduped, and capped to maxFrames (endpoints preserved).
func sampleTimes(duration: Double, interval: Double?, count: Int?, maxFrames: Int) -> [Double] {
    let eps = min(0.1, duration * 0.02)
    let last = max(0, duration - eps)
    func inset(_ t: Double) -> Double { return min(max(t, 0), last) }
    let anchors = [eps, duration / 2.0, last] // first, middle, last

    var times: [Double]
    if let iv = interval, iv > 0 {
        var grid: [Double] = []
        var t = 0.0
        while t < duration {
            grid.append(inset(t))
            t += iv
        }
        times = anchors + grid
    } else {
        let n = max(3, count ?? 3)
        times = (0..<n).map { inset(duration * Double($0) / Double(n - 1)) }
    }

    let sortedTimes = times.sorted()
    var dedup: [Double] = []
    for t in sortedTimes {
        if let prev = dedup.last, abs(prev - t) < 0.25 { continue }
        dedup.append(t)
    }
    if dedup.count > maxFrames && maxFrames >= 2 {
        let step = Double(dedup.count - 1) / Double(maxFrames - 1)
        dedup = (0..<maxFrames).map { dedup[Int((Double($0) * step).rounded())] }
    }
    return dedup
}

func cmd_frames(_ inputPath: String, _ outDir: String, maxEdge: Int) async {
    let asset = loadAsset(inputPath)
    _ = await firstVideoTrack(asset)
    let duration = await durationSeconds(asset)
    guard duration.isFinite && duration > 0 else { fail("invalid duration", 65) }

    let maxFrames = Int(arg("--max") ?? "20") ?? 20
    let interval = arg("--interval").flatMap { Double($0) }
    let count = arg("--count").flatMap { Int($0) }
    let times = sampleTimes(duration: duration, interval: interval, count: count, maxFrames: maxFrames)

    try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
    let gen = makeGenerator(asset, maxEdge: maxEdge)

    var manifest: [[String: Any]] = []
    for (idx, t) in times.enumerated() {
        do {
            let cg = try await copyFrame(gen, at: t)
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

// Transcode to an H.264 (≤1080p) MP4 proxy for playback — Electron's Chromium
// can't decode some HEVC variants (notably 10-bit), so we re-encode a proxy via
// VideoToolbox. macOS 15+ only (uses the non-deprecated async export API).
func cmd_transcode(_ inputPath: String, _ outPath: String) async {
    let asset = loadAsset(inputPath)
    _ = await firstVideoTrack(asset)
    guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1920x1080) else {
        fail("cannot create export session", 75)
    }
    let outURL = URL(fileURLWithPath: outPath)
    try? FileManager.default.removeItem(at: outURL)
    if #available(macOS 15.0, *) {
        do {
            try await session.export(to: outURL, as: .mp4)
        } catch {
            fail("transcode failed: \(error.localizedDescription)", 75)
        }
    } else {
        fail("transcode requires macOS 15+", 75)
    }
    FileHandle.standardOutput.write(Data((outPath + "\n").utf8))
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    fail("usage: video-tool <probe|poster|frames|transcode> <input> [args]", 64)
}
let sub = args[1]
let input = args[2]
let maxEdge = Int(arg("--max-edge") ?? "0") ?? 0

switch sub {
case "probe":
    await cmd_probe(input)
case "poster":
    guard args.count >= 4 else { fail("usage: video-tool poster <input> <out.jpg>", 64) }
    await cmd_poster(input, args[3], maxEdge: maxEdge > 0 ? maxEdge : 1024)
case "frames":
    guard args.count >= 4 else { fail("usage: video-tool frames <input> <out-dir>", 64) }
    await cmd_frames(input, args[3], maxEdge: maxEdge > 0 ? maxEdge : 512)
case "transcode":
    guard args.count >= 4 else { fail("usage: video-tool transcode <input> <out.mp4>", 64) }
    await cmd_transcode(input, args[3])
default:
    fail("unknown subcommand: \(sub)", 64)
}
