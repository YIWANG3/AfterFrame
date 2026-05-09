import Foundation
import Vision
import CoreML
import CoreImage
import AppKit

// AfterFrame depth field generator.
// Runs Apple's CoreML Depth Anything V2 Small (F16) on an input image
// and writes the raw 518×392 single-channel depth as an 8-bit grayscale PNG.
// The renderer applies cut/feather/zPosition itself — this CLI is purely the
// scene-level depth inference step.

func usage() -> Never {
    FileHandle.standardError.write(Data(
        "Usage: compute-depth <input-image> <output-png> [model-path]\n".utf8
    ))
    exit(64)
}

guard CommandLine.arguments.count >= 3 else { usage() }
let inputPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let modelArg: String? = CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : nil

guard FileManager.default.fileExists(atPath: inputPath) else {
    FileHandle.standardError.write(Data("Input not found: \(inputPath)\n".utf8))
    exit(66)
}

let inputURL = URL(fileURLWithPath: inputPath)
let outputURL = URL(fileURLWithPath: outputPath)

// MARK: - Locate model. Caller may pass an absolute path; otherwise fall back
// to the model bundled next to the script.

let modelURL: URL
if let arg = modelArg, !arg.isEmpty {
    modelURL = URL(fileURLWithPath: arg)
} else {
    let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0])
        .deletingLastPathComponent()
        .standardizedFileURL
    modelURL = scriptDir.appendingPathComponent("DepthAnythingV2SmallF16.mlpackage")
}

guard FileManager.default.fileExists(atPath: modelURL.path) else {
    FileHandle.standardError.write(Data("Model missing at \(modelURL.path)\n".utf8))
    exit(67)
}

// MARK: - Load model + run inference

let visionModel: VNCoreMLModel
do {
    let compiledURL = try MLModel.compileModel(at: modelURL)
    let cfg = MLModelConfiguration()
    cfg.computeUnits = .all
    let mlModel = try MLModel(contentsOf: compiledURL, configuration: cfg)
    visionModel = try VNCoreMLModel(for: mlModel)
} catch {
    FileHandle.standardError.write(Data("Model load failed: \(error.localizedDescription)\n".utf8))
    exit(68)
}

var depthPB: CVPixelBuffer?
let request = VNCoreMLRequest(model: visionModel) { req, _ in
    if let obs = req.results?.first as? VNPixelBufferObservation {
        depthPB = obs.pixelBuffer
    }
}
request.imageCropAndScaleOption = .scaleFill

let handler = VNImageRequestHandler(url: inputURL, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write(Data("Inference failed: \(error.localizedDescription)\n".utf8))
    exit(69)
}
guard let pb = depthPB else {
    FileHandle.standardError.write(Data("Empty depth output\n".utf8))
    exit(70)
}

// MARK: - Read Float16 depth values + normalize to 0..255 grayscale

CVPixelBufferLockBaseAddress(pb, .readOnly)
let dW = CVPixelBufferGetWidth(pb)
let dH = CVPixelBufferGetHeight(pb)
let bytesPerRow = CVPixelBufferGetBytesPerRow(pb)
guard let base = CVPixelBufferGetBaseAddress(pb) else {
    CVPixelBufferUnlockBaseAddress(pb, .readOnly)
    FileHandle.standardError.write(Data("Could not lock depth buffer\n".utf8))
    exit(71)
}

var depth = [Float](repeating: 0, count: dW * dH)
for y in 0..<dH {
    let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: Float16.self)
    for x in 0..<dW {
        depth[y * dW + x] = Float(row[x])
    }
}
CVPixelBufferUnlockBaseAddress(pb, .readOnly)

var minV = Float.greatestFiniteMagnitude
var maxV = -Float.greatestFiniteMagnitude
for v in depth {
    if v < minV { minV = v }
    if v > maxV { maxV = v }
}
let range = max(0.0001, maxV - minV)

// Pack into 8-bit grayscale (the renderer reads it back via canvas).
// Depth Anything V2 outputs disparity-like values: HIGHER = CLOSER.
// We keep that convention so 255 = nearest, 0 = farthest.
var pixels = [UInt8](repeating: 0, count: dW * dH * 4)
for i in 0..<depth.count {
    let n = (depth[i] - minV) / range
    let g = UInt8(min(255, max(0, (n * 255).rounded())))
    let p = i * 4
    pixels[p] = g
    pixels[p + 1] = g
    pixels[p + 2] = g
    pixels[p + 3] = 255
}

// MARK: - Write PNG

let bytesPerRowOut = dW * 4
let space = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
guard let ctx = pixels.withUnsafeMutableBytes({ buf -> CGContext? in
    guard let baseAddr = buf.baseAddress else { return nil }
    return CGContext(
        data: baseAddr,
        width: dW,
        height: dH,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRowOut,
        space: space,
        bitmapInfo: bitmapInfo,
    )
}), let cgImage = ctx.makeImage() else {
    FileHandle.standardError.write(Data("Failed to compose output PNG\n".utf8))
    exit(72)
}

let rep = NSBitmapImageRep(cgImage: cgImage)
guard let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write(Data("PNG encode failed\n".utf8))
    exit(73)
}

do {
    try png.write(to: outputURL)
} catch {
    FileHandle.standardError.write(Data("Write failed: \(error.localizedDescription)\n".utf8))
    exit(74)
}

print(outputURL.path)
print("\(dW)x\(dH)")
