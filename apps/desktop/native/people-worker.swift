// AfterFrame People Worker
//
// A precompiled, line-oriented local worker for face detection and ArcFace
// embedding inference, and (with --pet-model) for finding cats and dogs and
// embedding them with a pet identity model. It deliberately owns no
// catalog/database state: the sidecar launches it for a people_index job and
// persists its JSON responses. Each photo is decoded once for both.
//
// Usage:
//   people-worker --model /path/to/ArcFaceR100.mlpackage --self-test
//   people-worker --pet-model /path/to/PetEmbedding.mlpackage --self-test
//   people-worker --model /path/to/ArcFaceR100.mlpackage [--pet-model /path/to/PetEmbedding.mlpackage] --serve
//
// --compiled-model <path.mlmodelc> (and --pet-compiled-model for the pet
// model): where to keep the model's compiled copy between runs. An .mlpackage
// has to be compiled before it loads; Core ML compiles it into the temporary
// directory, and a worker that left the copy there left 125 MB behind each
// time it started, three times a scan. Without the flag the copy is removed
// when the worker exits.
//
// In --serve mode stdin/stdout use one JSON object per line:
//   request:  {"id":"asset-42","asset_path":"/path/to/photo.jpg",
//              "known_input_hash":"…","known_pet_input_hash":"…"}
//   response: {"id":"asset-42","ok":true,"input_hash":"…","faces":[…],
//              "animals":[…],"animals_skipped":false}
// A known hash equal to the photo's skips that half. `animals` is null when
// no pet model is loaded.
// stdout carries nothing else: anything a framework prints there goes to stderr.

import Accelerate
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import CryptoKit
import Darwin
import Foundation
import ImageIO
import Vision

private enum WorkerError: LocalizedError {
    case invalidArguments(String)
    case unreadableImage(String)
    case invalidImageBuffer
    case missingModelFeature(String)
    case unsupportedModelOutput
    case invalidAlignment
    case invalidEmbedding

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let message): return message
        case .unreadableImage(let path): return "Unable to decode image: \(path)"
        case .invalidImageBuffer: return "Unable to create an RGBA image buffer"
        case .missingModelFeature(let name): return "Core ML model is missing required feature: \(name)"
        case .unsupportedModelOutput: return "Core ML output must be a Float32 or Float64 MLMultiArray"
        case .invalidAlignment: return "Face landmarks could not produce a stable five-point alignment"
        case .invalidEmbedding: return "ArcFace embedding was empty or could not be normalized"
        }
    }
}

private struct Request: Decodable {
    let id: String
    let assetPath: String
    let knownInputHash: String?
    let knownPetInputHash: String?

    enum CodingKeys: String, CodingKey {
        case id
        case assetPath = "asset_path"
        case knownInputHash = "known_input_hash"
        case knownPetInputHash = "known_pet_input_hash"
    }
}

private struct Response: Encodable {
    let id: String
    let ok: Bool
    let skipped: Bool
    let inputHash: String?
    let imageSize: ImageSize?
    let faces: [Face]
    /// nil when the worker has no pet model; empty when none were found or
    /// `animalsSkipped` says the pet half matched its known hash.
    let animals: [Animal]?
    let animalsSkipped: Bool
    /// Why the pet half failed while the faces succeeded (animals is nil).
    let animalsError: String?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case id, ok, skipped, faces, animals, error
        case inputHash = "input_hash"
        case imageSize = "image_size"
        case animalsSkipped = "animals_skipped"
        case animalsError = "animals_error"
    }

    static func failure(id: String, _ message: String) -> Response {
        Response(id: id, ok: false, skipped: false, inputHash: nil, imageSize: nil, faces: [],
                 animals: nil, animalsSkipped: false, animalsError: nil, error: message)
    }
}

private struct SelfTestResponse: Encodable {
    let ok: Bool
    let inputName: String
    let outputName: String
    let embeddingDimensions: Int
    /// "face" or "pet": which kind of model was tested.
    let kind: String

    enum CodingKeys: String, CodingKey {
        case ok, kind
        case inputName = "input_name"
        case outputName = "output_name"
        case embeddingDimensions = "embedding_dimensions"
    }
}

private struct Animal: Encodable {
    /// "cat" or "dog".
    let subject: String
    /// The animal's body, [x, y, width, height] normalized, top-left origin.
    let boundingBox: [Double]
    /// The head as the same kind of box (ears, eyes and nose from the body
    /// pose), or empty when the pose had too few of them. Covers only.
    let landmarks: [Double]
    let confidence: Float
    let quality: String
    /// "recognizer" (VNRecognizeAnimalsRequest) or "pose" (body pose only).
    let source: String
    let embedding: [Float]

    enum CodingKeys: String, CodingKey {
        case subject, landmarks, confidence, quality, source, embedding
        case boundingBox = "bounding_box"
    }
}

private struct ImageSize: Encodable {
    let width: Int
    let height: Int
}

private struct Face: Encodable {
    /// [x, y, width, height], normalized to the image and using a top-left origin.
    let boundingBox: [Double]
    /// Five x/y landmark pairs in the same top-left normalized coordinate space.
    let landmarks: [Double]
    let confidence: Float
    let quality: String
    let embedding: [Float]

    enum CodingKeys: String, CodingKey {
        case landmarks, confidence, quality, embedding
        case boundingBox = "bounding_box"
    }
}

private struct Point {
    let x: Double
    let y: Double
}

private struct ImageBuffer {
    let pixels: [UInt8]
    let width: Int
    let height: Int
    let inputHash: String
}

private struct SimilarityTransform {
    // targetX = a * sourceX - b * sourceY + tx
    // targetY = b * sourceX + a * sourceY + ty
    let a: Double
    let b: Double
    let tx: Double
    let ty: Double

    init?(source: [Point], target: [Point]) {
        guard source.count == target.count, source.count >= 3 else { return nil }
        let sourceCenter = Point(
            x: source.map(\.x).reduce(0, +) / Double(source.count),
            y: source.map(\.y).reduce(0, +) / Double(source.count)
        )
        let targetCenter = Point(
            x: target.map(\.x).reduce(0, +) / Double(target.count),
            y: target.map(\.y).reduce(0, +) / Double(target.count)
        )
        var scale = 0.0
        var cosine = 0.0
        var sine = 0.0
        for (sourcePoint, targetPoint) in zip(source, target) {
            let sx = sourcePoint.x - sourceCenter.x
            let sy = sourcePoint.y - sourceCenter.y
            let dx = targetPoint.x - targetCenter.x
            let dy = targetPoint.y - targetCenter.y
            scale += sx * sx + sy * sy
            cosine += sx * dx + sy * dy
            sine += sx * dy - sy * dx
        }
        guard scale > 0 else { return nil }
        a = cosine / scale
        b = sine / scale
        guard a * a + b * b > 0.0000001 else { return nil }
        tx = targetCenter.x - a * sourceCenter.x + b * sourceCenter.y
        ty = targetCenter.y - b * sourceCenter.x - a * sourceCenter.y
    }

    func sourcePoint(forTarget target: Point) -> Point {
        let x = target.x - tx
        let y = target.y - ty
        let divisor = a * a + b * b
        return Point(
            x: (a * x + b * y) / divisor,
            y: (-b * x + a * y) / divisor
        )
    }
}

private final class ArcFaceModel {
    private enum InputKind {
        case multiArray
        case image
    }

    private let model: MLModel
    private let inputName: String
    private let outputName: String
    private let inputKind: InputKind

    init(modelURL: URL, compiledURL: URL?) throws {
        model = try loadModel(at: modelURL, compiledURL: compiledURL)
        guard let discoveredInput = model.modelDescription.inputDescriptionsByName.keys.sorted().first else {
            throw WorkerError.missingModelFeature("input")
        }
        guard let discoveredOutput = model.modelDescription.outputDescriptionsByName.keys.sorted().first else {
            throw WorkerError.missingModelFeature("output")
        }
        inputName = discoveredInput
        outputName = discoveredOutput
        guard let inputDescription = model.modelDescription.inputDescriptionsByName[inputName] else {
            throw WorkerError.missingModelFeature(inputName)
        }
        switch inputDescription.type {
        case .multiArray:
            inputKind = .multiArray
        case .image:
            inputKind = .image
        default:
            throw WorkerError.missingModelFeature("supported input type for \(inputName)")
        }
    }

    func selfTest() throws -> SelfTestResponse {
        let inputValue: MLFeatureValue
        switch inputKind {
        case .multiArray:
            let input = try MLMultiArray(shape: [1, 3, 112, 112], dataType: .float32)
            inputValue = MLFeatureValue(multiArray: input)
        case .image:
            inputValue = MLFeatureValue(pixelBuffer: try makeImagePixelBuffer(buffer: nil, transform: nil))
        }
        let provider = try MLDictionaryFeatureProvider(dictionary: [inputName: inputValue])
        let output = try model.prediction(from: provider)
        guard let array = output.featureValue(for: outputName)?.multiArrayValue else {
            throw WorkerError.missingModelFeature(outputName)
        }
        return SelfTestResponse(
            ok: true,
            inputName: inputName,
            outputName: outputName,
            embeddingDimensions: array.count,
            kind: "face"
        )
    }

    func embedding(from buffer: ImageBuffer, transform: SimilarityTransform) throws -> [Float] {
        let inputValue: MLFeatureValue
        switch inputKind {
        case .multiArray:
            let input = try MLMultiArray(shape: [1, 3, 112, 112], dataType: .float32)
            guard input.dataType == .float32 else { throw WorkerError.invalidEmbedding }
            let values = input.dataPointer.assumingMemoryBound(to: Float32.self)
            for y in 0..<112 {
                for x in 0..<112 {
                    let source = transform.sourcePoint(forTarget: Point(x: Double(x) + 0.5, y: Double(y) + 0.5))
                    let rgba = sampleRGBA(buffer, atX: source.x, y: source.y)
                    let offset = y * 112 + x
                    values[offset] = normalizeInput(rgba.0)
                    values[112 * 112 + offset] = normalizeInput(rgba.1)
                    values[2 * 112 * 112 + offset] = normalizeInput(rgba.2)
                }
            }
            inputValue = MLFeatureValue(multiArray: input)
        case .image:
            inputValue = MLFeatureValue(pixelBuffer: try makeImagePixelBuffer(buffer: buffer, transform: transform))
        }
        let provider = try MLDictionaryFeatureProvider(dictionary: [inputName: inputValue])
        let prediction = try model.prediction(from: provider)
        guard let output = prediction.featureValue(for: outputName)?.multiArrayValue else {
            throw WorkerError.missingModelFeature(outputName)
        }
        return try unitLength(try floats(from: output))
    }

    private func normalizeInput(_ byte: UInt8) -> Float32 {
        // ArcFace ONNX Model Zoo preprocessing: RGB, CHW, (value - 127.5) / 127.5.
        (Float32(byte) - 127.5) / 127.5
    }

    private func makeImagePixelBuffer(buffer: ImageBuffer?, transform: SimilarityTransform?) throws -> CVPixelBuffer {
        var pixelBuffer: CVPixelBuffer?
        let options: CFDictionary = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ] as CFDictionary
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            112,
            112,
            kCVPixelFormatType_32BGRA,
            options,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else { throw WorkerError.invalidImageBuffer }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { throw WorkerError.invalidImageBuffer }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let pixels = baseAddress.assumingMemoryBound(to: UInt8.self)
        for y in 0..<112 {
            for x in 0..<112 {
                let rgba: (UInt8, UInt8, UInt8, UInt8)
                if let buffer, let transform {
                    let source = transform.sourcePoint(forTarget: Point(x: Double(x) + 0.5, y: Double(y) + 0.5))
                    rgba = sampleRGBA(buffer, atX: source.x, y: source.y)
                } else {
                    rgba = (0, 0, 0, 255)
                }
                let offset = y * bytesPerRow + x * 4
                pixels[offset] = rgba.2
                pixels[offset + 1] = rgba.1
                pixels[offset + 2] = rgba.0
                pixels[offset + 3] = 255
            }
        }
        return pixelBuffer
    }
}

private func floats(from array: MLMultiArray) throws -> [Float] {
    switch array.dataType {
    case .float32:
        let pointer = array.dataPointer.assumingMemoryBound(to: Float32.self)
        return (0..<array.count).map { pointer[$0] }
    case .double:
        let pointer = array.dataPointer.assumingMemoryBound(to: Double.self)
        return (0..<array.count).map { Float(pointer[$0]) }
    case .float16:
        // vImage widens the halves: Swift has no Float16 on Intel Macs.
        var values = [Float](repeating: 0, count: array.count)
        values.withUnsafeMutableBytes { out in
            let width = vImagePixelCount(array.count)
            var source = vImage_Buffer(data: array.dataPointer, height: 1, width: width, rowBytes: array.count * 2)
            var destination = vImage_Buffer(data: out.baseAddress, height: 1, width: width, rowBytes: array.count * 4)
            _ = vImageConvert_Planar16FtoPlanarF(&source, &destination, vImage_Flags(kvImageNoFlags))
        }
        return values
    default:
        throw WorkerError.unsupportedModelOutput
    }
}

private func unitLength(_ embedding: [Float]) throws -> [Float] {
    let squaredLength = embedding.reduce(Float(0)) { $0 + $1 * $1 }
    guard squaredLength > 0, squaredLength.isFinite else { throw WorkerError.invalidEmbedding }
    let length = sqrt(squaredLength)
    return embedding.map { $0 / length }
}

/// Compiled copies made for this run alone (no --compiled-model), removed
/// when the worker exits: Core ML may read a loaded model from disk again.
private var temporaryCompiledModels: [URL] = []

private func removeTemporaryCompiledModels() {
    for url in temporaryCompiledModels { try? FileManager.default.removeItem(at: url) }
    temporaryCompiledModels.removeAll()
}

/// A model ready to run. An .mlmodelc loads as is; an .mlpackage loads from
/// its compiled copy at `compiledURL`, compiled there the first time. When
/// that copy can't be made or won't load, the worker compiles one for this
/// run instead of replacing it: another worker may have it loaded. (A model
/// that doesn't compile at all then fails there, with Core ML's error.)
private func loadModel(at modelURL: URL, compiledURL: URL?) throws -> MLModel {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .all
    if modelURL.pathExtension.lowercased() == "mlmodelc" {
        return try MLModel(contentsOf: modelURL, configuration: configuration)
    }
    if let compiledURL {
        do {
            return try MLModel(contentsOf: try compileOnce(modelURL, into: compiledURL), configuration: configuration)
        } catch {
            writeError("people-worker: could not use the compiled model at \(compiledURL.path) (\(error.localizedDescription)); compiling one for this run")
        }
    }
    let compiled = try MLModel.compileModel(at: modelURL)
    temporaryCompiledModels.append(compiled)
    return try MLModel(contentsOf: compiled, configuration: configuration)
}

/// `compiledURL`, compiling `modelURL` into it unless it is there already.
/// A scan starts its workers together: the first one compiles while holding
/// a lock beside the copy, the others wait for it and load what it made. The
/// copy is staged beside its final place (leaving the temporary directory can
/// be a copy across volumes, which can be cut short) and renamed into it, so
/// that path never holds part of a model.
private func compileOnce(_ modelURL: URL, into compiledURL: URL) throws -> URL {
    let fm = FileManager.default
    if fm.fileExists(atPath: compiledURL.path) { return compiledURL }
    let directory = compiledURL.deletingLastPathComponent()
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    let name = compiledURL.lastPathComponent
    let lock = open(directory.appendingPathComponent(".\(name).lock").path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
    if lock >= 0 { flock(lock, LOCK_EX) }
    defer { if lock >= 0 { close(lock) } }  // closing it releases the lock
    if fm.fileExists(atPath: compiledURL.path) { return compiledURL }
    let compiled = try MLModel.compileModel(at: modelURL)
    defer { try? fm.removeItem(at: compiled) }  // already gone once moved
    let staging = directory.appendingPathComponent(".\(name).\(getpid())")
    try? fm.removeItem(at: staging)
    defer { try? fm.removeItem(at: staging) }
    try fm.moveItem(at: compiled, to: staging)
    do {
        try fm.moveItem(at: staging, to: compiledURL)
    } catch {
        // Put there meanwhile by a run that didn't take the lock: use theirs.
        if !fm.fileExists(atPath: compiledURL.path) { throw error }
    }
    writeError("people-worker: compiled \(modelURL.lastPathComponent) into \(compiledURL.path)")
    return compiledURL
}

/// A pet identity model: one RGB image in (any size, read from the model),
/// one vector out. The animal's box is padded to a square with mid grey and
/// scaled to the model's input, so its whole body fits without distortion.
private final class PetModel {
    private let model: MLModel
    private let inputName: String
    private let outputName: String
    private let side: Int

    init(modelURL: URL, compiledURL: URL?) throws {
        model = try loadModel(at: modelURL, compiledURL: compiledURL)
        guard let input = model.modelDescription.inputDescriptionsByName.sorted(by: { $0.key < $1.key }).first,
              input.value.type == .image,
              let constraint = input.value.imageConstraint else {
            throw WorkerError.missingModelFeature("an image input")
        }
        guard let output = model.modelDescription.outputDescriptionsByName.keys.sorted().first else {
            throw WorkerError.missingModelFeature("output")
        }
        inputName = input.key
        outputName = output
        side = max(constraint.pixelsWide, constraint.pixelsHigh)
        guard side >= 32 else { throw WorkerError.missingModelFeature("an image input of at least 32×32") }
    }

    func selfTest() throws -> SelfTestResponse {
        let blank = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)?.makeImage()
        guard let blank else { throw WorkerError.invalidImageBuffer }
        let vector = try embedding(of: blank)
        return SelfTestResponse(ok: true, inputName: inputName, outputName: outputName,
                                embeddingDimensions: vector.count, kind: "pet")
    }

    func embedding(of crop: CGImage) throws -> [Float] {
        var pixelBuffer: CVPixelBuffer?
        let attributes: CFDictionary = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ] as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault, side, side, kCVPixelFormatType_32BGRA, attributes, &pixelBuffer) == kCVReturnSuccess,
              let pixelBuffer else { throw WorkerError.invalidImageBuffer }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(pixelBuffer), width: side, height: side, bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer), space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { throw WorkerError.invalidImageBuffer }
        context.setFillColor(CGColor(red: 128.0 / 255, green: 128.0 / 255, blue: 128.0 / 255, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: side, height: side))
        let scale = CGFloat(side) / CGFloat(max(crop.width, crop.height))
        let width = CGFloat(crop.width) * scale
        let height = CGFloat(crop.height) * scale
        context.interpolationQuality = .high
        context.draw(crop, in: CGRect(x: (CGFloat(side) - width) / 2, y: (CGFloat(side) - height) / 2, width: width, height: height))
        let provider = try MLDictionaryFeatureProvider(dictionary: [inputName: MLFeatureValue(pixelBuffer: pixelBuffer)])
        let prediction = try model.prediction(from: provider)
        guard let output = prediction.featureValue(for: outputName)?.multiArrayValue else {
            throw WorkerError.missingModelFeature(outputName)
        }
        return try unitLength(try floats(from: output))
    }
}

private let arcFaceReference = [
    Point(x: 38.2946, y: 51.6963),
    Point(x: 73.5318, y: 51.5014),
    Point(x: 56.0252, y: 71.7366),
    Point(x: 41.5493, y: 92.3655),
    Point(x: 70.7299, y: 92.2041),
]

// Longest-edge cap for the analysis buffer. Detection and a 112×112 aligned
// crop don't benefit from more resolution, while a 10000px image costs ~400MB
// of RGBA and seconds of decode. Images at or below the cap keep the original
// full-resolution path so their stored people_input_hash stays valid across
// this optimization; larger images re-analyze once.
private let maxAnalysisPixelSize = 4096

// Vision is deliberately recall-oriented and can return face-shaped signs,
// windows, or illustrations. Reject weak/tiny observations before ArcFace is
// asked to embed them; embedding a non-face makes two similar textures look
// like a real person to the clustering stage.
private let minimumFaceConfidence: Float = 0.65
private let minimumFacePixelSize = 48.0

private func canonicalImage(at path: String) throws -> CGImage {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        throw WorkerError.unreadableImage(path)
    }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let pixelWidth = (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
    let pixelHeight = (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0

    if max(pixelWidth, pixelHeight) > maxAnalysisPixelSize {
        // Scaled decode via ImageIO (libjpeg ratio decoding where available):
        // never materializes the full-resolution bitmap, and WithTransform
        // applies the EXIF orientation for us.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxAnalysisPixelSize,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        guard let scaled = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw WorkerError.unreadableImage(path)
        }
        return scaled
    }

    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw WorkerError.unreadableImage(path)
    }
    let orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    let oriented = CIImage(cgImage: image).oriented(forExifOrientation: Int32(orientation))
    let context = CIContext(options: [.cacheIntermediates: false])
    guard let canonical = context.createCGImage(oriented, from: oriented.extent) else {
        throw WorkerError.unreadableImage(path)
    }
    return canonical
}

private func makeBuffer(_ image: CGImage) throws -> ImageBuffer {
    let width = image.width
    let height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let rendered = pixels.withUnsafeMutableBytes { rawBuffer -> Bool in
        guard let context = CGContext(
            data: rawBuffer.baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        ) else { return false }
        // CGBitmapContext memory already stores row 0 as the top scanline, so an
        // identity CTM keeps the buffer upright — the same top-left space the
        // converted Vision boxes/landmarks use. Adding a vertical flip here would
        // make the alignment sample mirrored pixels while the landmarks still
        // point at the upright image, which destroys the embeddings.
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    guard rendered else { throw WorkerError.invalidImageBuffer }
    let digest = SHA256.hash(data: Data(pixels))
    let inputHash = digest.map { String(format: "%02x", $0) }.joined()
    return ImageBuffer(pixels: pixels, width: width, height: height, inputHash: inputHash)
}

private func sampleRGBA(_ buffer: ImageBuffer, atX x: Double, y: Double) -> (UInt8, UInt8, UInt8, UInt8) {
    guard x >= 0, y >= 0, x < Double(buffer.width - 1), y < Double(buffer.height - 1) else {
        return (0, 0, 0, 255)
    }
    let x0 = Int(floor(x))
    let y0 = Int(floor(y))
    let x1 = x0 + 1
    let y1 = y0 + 1
    let dx = x - Double(x0)
    let dy = y - Double(y0)
    func value(_ x: Int, _ y: Int, _ channel: Int) -> Double {
        Double(buffer.pixels[(y * buffer.width + x) * 4 + channel])
    }
    func interpolate(_ channel: Int) -> UInt8 {
        let top = value(x0, y0, channel) * (1 - dx) + value(x1, y0, channel) * dx
        let bottom = value(x0, y1, channel) * (1 - dx) + value(x1, y1, channel) * dx
        return UInt8(max(0, min(255, Int((top * (1 - dy) + bottom * dy).rounded()))))
    }
    return (interpolate(0), interpolate(1), interpolate(2), interpolate(3))
}

private func detectFaces(in image: CGImage) throws -> [VNFaceObservation] {
    let request = VNDetectFaceLandmarksRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    try handler.perform([request])
    return request.results ?? []
}

private func pointInPixels(
    _ point: CGPoint,
    faceBox: CGRect,
    width: Int,
    height: Int
) -> Point {
    let x = faceBox.minX + point.x * faceBox.width
    let y = faceBox.minY + point.y * faceBox.height
    return Point(x: Double(x * CGFloat(width)), y: Double((1 - y) * CGFloat(height)))
}

private func center(
    of landmark: VNFaceLandmarkRegion2D?,
    faceBox: CGRect,
    width: Int,
    height: Int
) -> Point? {
    guard let landmark, landmark.pointCount > 0 else { return nil }
    let points = landmark.normalizedPoints
    var totalX = 0.0
    var totalY = 0.0
    for index in 0..<landmark.pointCount {
        let point = pointInPixels(points[index], faceBox: faceBox, width: width, height: height)
        totalX += point.x
        totalY += point.y
    }
    return Point(x: totalX / Double(landmark.pointCount), y: totalY / Double(landmark.pointCount))
}

private func mouthCorners(
    _ landmark: VNFaceLandmarkRegion2D?,
    faceBox: CGRect,
    width: Int,
    height: Int
) -> (Point, Point)? {
    guard let landmark, landmark.pointCount >= 2 else { return nil }
    let points = landmark.normalizedPoints
    let mapped = (0..<landmark.pointCount).map {
        pointInPixels(points[$0], faceBox: faceBox, width: width, height: height)
    }
    guard let left = mapped.min(by: { $0.x < $1.x }),
          let right = mapped.max(by: { $0.x < $1.x }) else { return nil }
    return (left, right)
}

private func sourceLandmarks(
    for face: VNFaceObservation,
    width: Int,
    height: Int
) -> [Point]? {
    guard let landmarks = face.landmarks,
          let leftEye = center(of: landmarks.leftEye, faceBox: face.boundingBox, width: width, height: height),
          let rightEye = center(of: landmarks.rightEye, faceBox: face.boundingBox, width: width, height: height),
          let nose = center(of: landmarks.nose ?? landmarks.noseCrest, faceBox: face.boundingBox, width: width, height: height),
          let mouth = mouthCorners(landmarks.outerLips, faceBox: face.boundingBox, width: width, height: height) else {
        return nil
    }
    return [leftEye, rightEye, nose, mouth.0, mouth.1]
}

private func normalizedTopLeftBox(_ box: CGRect) -> [Double] {
    [
        Double(box.minX),
        Double(1 - box.maxY),
        Double(box.width),
        Double(box.height),
    ]
}

private func normalizedTopLeftLandmarks(_ points: [Point], width: Int, height: Int) -> [Double] {
    points.flatMap { [
        $0.x / Double(width),
        $0.y / Double(height),
    ] }
}

private func faceQuality(_ box: CGRect, width: Int, height: Int) -> String {
    let smallestDimension = min(box.width * CGFloat(width), box.height * CGFloat(height))
    return smallestDimension < 56 ? "low" : "standard"
}

private func plausibleFace(
    _ observation: VNFaceObservation,
    points: [Point],
    width: Int,
    height: Int
) -> Bool {
    guard observation.confidence >= minimumFaceConfidence, points.count == 5 else { return false }

    let boxWidth = Double(observation.boundingBox.width) * Double(width)
    let boxHeight = Double(observation.boundingBox.height) * Double(height)
    guard min(boxWidth, boxHeight) >= minimumFacePixelSize else { return false }

    // Normalize roll so the remaining checks describe facial topology rather
    // than image orientation. The five points are eyes, nose, mouth corners.
    let eyeA = points[0]
    let eyeB = points[1]
    let eyeLeft = eyeA.x <= eyeB.x ? eyeA : eyeB
    let eyeRight = eyeA.x <= eyeB.x ? eyeB : eyeA
    let eyeDX = eyeRight.x - eyeLeft.x
    let eyeDY = eyeRight.y - eyeLeft.y
    let eyeDistance = hypot(eyeDX, eyeDY)
    guard eyeDistance >= max(8.0, boxWidth * 0.16), eyeDistance <= boxWidth * 0.82 else { return false }

    let eyeMid = Point(x: (eyeLeft.x + eyeRight.x) / 2, y: (eyeLeft.y + eyeRight.y) / 2)
    let angle = -atan2(eyeDY, eyeDX)
    let cosine = cos(angle)
    let sine = sin(angle)
    func unrolled(_ point: Point) -> Point {
        let dx = point.x - eyeMid.x
        let dy = point.y - eyeMid.y
        return Point(
            x: eyeMid.x + dx * cosine - dy * sine,
            y: eyeMid.y + dx * sine + dy * cosine
        )
    }

    let nose = unrolled(points[2])
    let mouthA = unrolled(points[3])
    let mouthB = unrolled(points[4])
    let mouthMid = Point(x: (mouthA.x + mouthB.x) / 2, y: (mouthA.y + mouthB.y) / 2)
    let eyeToMouth = mouthMid.y - eyeMid.y
    let mouthWidth = hypot(mouthB.x - mouthA.x, mouthB.y - mouthA.y)

    guard eyeToMouth >= boxHeight * 0.16, eyeToMouth <= boxHeight * 0.88 else { return false }
    guard nose.y >= eyeMid.y + boxHeight * 0.035, nose.y <= mouthMid.y + boxHeight * 0.10 else { return false }
    guard abs(nose.x - eyeMid.x) <= eyeDistance * 0.62 else { return false }
    guard abs(mouthMid.x - eyeMid.x) <= eyeDistance * 0.72 else { return false }
    guard mouthWidth >= eyeDistance * 0.28, mouthWidth <= eyeDistance * 1.65 else { return false }
    return true
}

// MARK: - Cats and dogs

// An animal smaller than this on its short side carries too little detail to
// tell one cat from another; anything below 128 is kept but marked low.
private let minimumAnimalPixelSize: CGFloat = 64
private let lowQualityAnimalPixelSize: CGFloat = 128
// Vision's image classifier labels for each species (its taxonomy has the
// parents too). bobcat, prairie_dog and hotdog are deliberately absent.
private let catLabels: Set<String> = ["cat", "adult_cat", "kitten", "feline"]
private let dogLabels: Set<String> = ["dog", "canine", "bulldog", "sheepdog"]
// Measured on 201 Commons photos of 12 animals: 0.1 keeps 36 body-pose-only
// animals with one species wrong; 0.3 kept 27 (one wrong), 0 kept 42 (three).
private let minimumSpeciesScore: Float = 0.1

// The second look. Both detectors only know cats and dogs, so a cow, a seal,
// a deer, a rock or a plush toy comes back as one of them, sometimes with
// full confidence. Vision's classifier knows those, given some of the
// surroundings: a tight crop of a cow in a field reads as a greyhound, the
// cow with its field around it as a cow.
private let contextMargin: CGFloat = 0.25
// Species labels without their parents: "feline" also means lion and
// bobcat, "canine" fox, wolf and hyena.
private let catOnlyLabels: Set<String> = ["cat", "adult_cat", "kitten"]
private let dogOnlyLabels: Set<String> = [
    "dog", "australian_shepherd", "basenji", "basset", "beagle", "bernese_mountain", "bichon", "bulldog",
    "chihuahua", "collie", "corgi", "dachshund", "dalmatian", "doberman", "german_shepherd", "greyhound",
    "hound", "husky", "irish_wolfhound", "jack_russell_terrier", "malamute", "malinois", "mastiff",
    "newfoundland", "pitbull", "pomeranian", "poodle", "pug", "retriever", "ridgeback", "rottweiler",
    "saint_bernard", "schnauzer", "setter", "sheepdog", "spaniel", "terrier", "vizsla", "weimaraner",
]
// Other animals, and things shaped like one.
private let notPetLabels: Set<String> = [
    "ungulates", "cow", "deer", "elk", "moose", "horse", "donkey", "sheep", "goat", "pig", "camel", "llama",
    "bison", "boar", "giraffe", "zebra", "rhinoceros", "hippopotamus", "elephant", "kangaroo", "marsupial",
    "bear", "panda", "koala", "raccoon", "skunk", "otter", "seal", "sealion", "walrus", "cetacean", "dolphin",
    "whale", "hyena", "fox", "coyote_wolf", "lion", "tiger", "leopard", "cheetah", "cougar", "lynx", "bobcat",
    "lemur", "rabbit", "rodent", "ferret", "hedgehog", "porcupine", "bird", "poultry", "reptile", "fish", "insect",
    "rocks", "stuffed_animals", "toy", "doll", "statue", "figurine", "puppet",
]
// Something else wins when it scores at least this and more than twice the
// species. On the 27 animals one photo library turned up (18 cats and dogs;
// 3 cows, a sea lion, a seal, a deer, 2 rocks, a plush toy) every miss had
// something else at 23 times its species or more, every pet at most 0.96
// times: a backlit retriever the classifier half took for a cow.
private let minimumOtherScore: Float = 0.1
private let otherOverSpecies: Float = 2

private struct FoundAnimal {
    var subject: String?
    let confidence: Float
    /// Pixels, top-left origin.
    let body: CGRect
    var head: CGRect?
    let source: String
}

/// Vision's normalized lower-left rect → pixels with a top-left origin.
private func pixelRect(_ box: CGRect, width: Int, height: Int) -> CGRect {
    CGRect(x: box.minX * CGFloat(width), y: (1 - box.maxY) * CGFloat(height),
           width: box.width * CGFloat(width), height: box.height * CGFloat(height))
}

private func clamped(_ rect: CGRect, width: Int, height: Int) -> CGRect {
    rect.intersection(CGRect(x: 0, y: 0, width: width, height: height)).integral
}

private func normalizedTopLeft(_ rect: CGRect, width: Int, height: Int) -> [Double] {
    [Double(rect.minX) / Double(width), Double(rect.minY) / Double(height),
     Double(rect.width) / Double(width), Double(rect.height) / Double(height)]
}

/// Ears, eyes and nose → a square around the head. The points stop at the
/// nose, so the square sits a little lower than their middle.
@available(macOS 14.0, *)
private func headRect(_ pose: VNAnimalBodyPoseObservation, width: Int, height: Int) -> CGRect? {
    guard let points = try? pose.recognizedPoints(.head) else { return nil }
    let confident = points.filter { $0.value.confidence > 0.3 }
    let hasFace = confident.keys.contains(.nose) || confident.keys.contains(.leftEye) || confident.keys.contains(.rightEye)
    guard confident.count >= 3, hasFace else { return nil }
    let xs = confident.values.map { $0.location.x * CGFloat(width) }
    let ys = confident.values.map { (1 - $0.location.y) * CGFloat(height) }
    guard let minX = xs.min(), let maxX = xs.max(), let minY = ys.min(), let maxY = ys.max() else { return nil }
    let side = max(maxX - minX, maxY - minY) * 1.6
    guard side >= 40 else { return nil }
    let center = CGPoint(x: (minX + maxX) / 2, y: (minY + maxY) / 2 + side * 0.08)
    return clamped(CGRect(x: center.x - side / 2, y: center.y - side / 2, width: side, height: side), width: width, height: height)
}

/// Every confident joint → the animal's extent, grown so the fur fits.
@available(macOS 14.0, *)
private func poseBodyRect(_ pose: VNAnimalBodyPoseObservation, width: Int, height: Int) -> CGRect? {
    guard let points = try? pose.recognizedPoints(.all) else { return nil }
    let confident = points.values.filter { $0.confidence > 0.2 }
    guard confident.count >= 5 else { return nil }
    let xs = confident.map { $0.location.x * CGFloat(width) }
    let ys = confident.map { (1 - $0.location.y) * CGFloat(height) }
    guard let minX = xs.min(), let maxX = xs.max(), let minY = ys.min(), let maxY = ys.max() else { return nil }
    let rect = CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    return clamped(rect.insetBy(dx: -rect.width * 0.15 - 8, dy: -rect.height * 0.15 - 8), width: width, height: height)
}

/// Cat or dog for a crop the recognizer missed (the pose request doesn't
/// say which), or nil when Vision's classifier is sure of neither.
private func classifySpecies(_ crop: CGImage) -> String? {
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cgImage: crop, orientation: .up, options: [:])
    guard (try? handler.perform([request])) != nil, let results = request.results else { return nil }
    var cat: Float = 0
    var dog: Float = 0
    for observation in results {
        if catLabels.contains(observation.identifier) { cat = max(cat, observation.confidence) }
        if dogLabels.contains(observation.identifier) { dog = max(dog, observation.confidence) }
    }
    guard max(cat, dog) >= minimumSpeciesScore else { return nil }
    return cat >= dog ? "cat" : "dog"
}

/// True when Vision's classifier, shown the animal with its surroundings,
/// sees another animal or a thing (a cow, a seal, a rock, a toy) rather
/// than the cat or dog a detector found.
private func isSomethingElse(_ context: CGImage, subject: String) -> Bool {
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cgImage: context, orientation: .up, options: [:])
    guard (try? handler.perform([request])) != nil, let results = request.results else { return false }
    let species = subject == "cat" ? catOnlyLabels : dogOnlyLabels
    var speciesScore: Float = 0
    var otherScore: Float = 0
    for observation in results {
        if species.contains(observation.identifier) { speciesScore = max(speciesScore, observation.confidence) }
        if notPetLabels.contains(observation.identifier) { otherScore = max(otherScore, observation.confidence) }
    }
    return otherScore >= minimumOtherScore && otherScore > speciesScore * otherOverSpecies
}

private func detectAnimals(in image: CGImage, model: PetModel) throws -> [Animal] {
    let width = image.width
    let height = image.height
    let recognizer = VNRecognizeAnimalsRequest()
    var requests: [VNRequest] = [recognizer]
    var poseRequest: VNRequest?
    if #available(macOS 14.0, *) {
        let request = VNDetectAnimalBodyPoseRequest()
        requests.append(request)
        poseRequest = request
    }
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    try handler.perform(requests)

    var found: [FoundAnimal] = (recognizer.results ?? []).compactMap { observation in
        guard let label = observation.labels.first else { return nil }
        let subject = label.identifier.lowercased()
        guard subject == "cat" || subject == "dog" else { return nil }
        return FoundAnimal(subject: subject, confidence: label.confidence,
                           body: pixelRect(observation.boundingBox, width: width, height: height),
                           head: nil, source: "recognizer")
    }
    if #available(macOS 14.0, *), let poses = (poseRequest as? VNDetectAnimalBodyPoseRequest)?.results {
        let recognized = found.map(\.body)
        for pose in poses {
            let head = headRect(pose, width: width, height: height)
            let body = poseBodyRect(pose, width: width, height: height)
            let anchor = head.map { CGPoint(x: $0.midX, y: $0.midY) } ?? body.map { CGPoint(x: $0.midX, y: $0.midY) }
            guard let anchor else { continue }
            if let owner = recognized.indices.filter({ recognized[$0].contains(anchor) })
                .min(by: { recognized[$0].width * recognized[$0].height < recognized[$1].width * recognized[$1].height }) {
                // The pose belongs to a recognized animal: give it the largest head.
                if let head, (found[owner].head?.width ?? 0) < head.width { found[owner].head = head }
            } else if let body {
                found.append(FoundAnimal(subject: nil, confidence: pose.confidence, body: body, head: head, source: "pose"))
            }
        }
    }

    var animals: [Animal] = []
    for animal in found {
        let body = animal.source == "recognizer"
            ? clamped(animal.body.insetBy(dx: -animal.body.width * 0.05, dy: -animal.body.height * 0.05), width: width, height: height)
            : animal.body
        guard min(body.width, body.height) >= minimumAnimalPixelSize, let crop = image.cropping(to: body) else { continue }
        guard let subject = animal.subject ?? classifySpecies(crop) else { continue }
        let context = clamped(body.insetBy(dx: -body.width * contextMargin, dy: -body.height * contextMargin),
                              width: width, height: height)
        if let contextCrop = image.cropping(to: context), isSomethingElse(contextCrop, subject: subject) { continue }
        let quality = animal.source == "pose" || min(body.width, body.height) < lowQualityAnimalPixelSize ? "low" : "standard"
        animals.append(Animal(
            subject: subject,
            boundingBox: normalizedTopLeft(body, width: width, height: height),
            landmarks: animal.head.map { normalizedTopLeft($0, width: width, height: height) } ?? [],
            confidence: min(1, max(0, animal.confidence)),
            quality: quality,
            source: animal.source,
            embedding: try model.embedding(of: crop)
        ))
    }
    return animals
}

private func analyze(request: Request, model: ArcFaceModel, petModel: PetModel?) -> Response {
    do {
        let image = try canonicalImage(at: request.assetPath)
        let buffer = try makeBuffer(image)
        let facesSkipped = request.knownInputHash == buffer.inputHash
        let animalsSkipped = petModel != nil && request.knownPetInputHash == buffer.inputHash
        let faces: [Face] = facesSkipped ? [] : try detectFaces(in: image).compactMap { observation in
            guard let points = sourceLandmarks(for: observation, width: buffer.width, height: buffer.height),
                  plausibleFace(observation, points: points, width: buffer.width, height: buffer.height),
                  let transform = SimilarityTransform(source: points, target: arcFaceReference) else {
                return nil
            }
            return Face(
                boundingBox: normalizedTopLeftBox(observation.boundingBox),
                landmarks: normalizedTopLeftLandmarks(points, width: buffer.width, height: buffer.height),
                confidence: observation.confidence,
                quality: faceQuality(observation.boundingBox, width: buffer.width, height: buffer.height),
                embedding: try model.embedding(from: buffer, transform: transform)
            )
        }
        // A pet failure must not cost the photo its faces: report it beside
        // them (animals nil + error) and let the sidecar record it for pets.
        var animals: [Animal]?
        var animalsError: String?
        if let petModel {
            if animalsSkipped {
                animals = []
            } else {
                do { animals = try detectAnimals(in: image, model: petModel) } catch { animalsError = error.localizedDescription }
            }
        }
        return Response(
            id: request.id,
            ok: true,
            skipped: facesSkipped,
            inputHash: buffer.inputHash,
            imageSize: ImageSize(width: buffer.width, height: buffer.height),
            faces: faces,
            animals: animals,
            animalsSkipped: animalsSkipped,
            animalsError: animalsError,
            error: nil
        )
    } catch {
        return Response.failure(id: request.id, error.localizedDescription)
    }
}

// Frameworks print to stdout through C stdio: on Intel Macs MPSGraph prints
// "MPSGraph doesn't support padded tensors…" without a newline when the model
// loads. The buffer flushes at exit, after the self-test's JSON, or earlier,
// in front of a response. Keep the real stdout on a private descriptor for the
// protocol and point fd 1 at stderr, before anything loads.
private func reserveStdoutForProtocol() -> FileHandle {
    let protocolFD = dup(STDOUT_FILENO)
    guard protocolFD >= 0, dup2(STDERR_FILENO, STDOUT_FILENO) >= 0 else {
        return FileHandle.standardOutput
    }
    return FileHandle(fileDescriptor: protocolFD, closeOnDealloc: true)
}

private func writeJSON<T: Encodable>(_ value: T, to output: FileHandle) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(value) else { return }
    output.write(data)
    output.write(Data([10]))
}

private func writeError(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private struct Arguments {
    let modelURL: URL?
    let petModelURL: URL?
    let compiledModelURL: URL?
    let petCompiledModelURL: URL?
    let serve: Bool
    let selfTest: Bool

    init() throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        func value(_ flag: String) -> URL? {
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
            return URL(fileURLWithPath: arguments[index + 1])
        }
        modelURL = value("--model")
        petModelURL = value("--pet-model")
        compiledModelURL = value("--compiled-model")
        petCompiledModelURL = value("--pet-compiled-model")
        serve = arguments.contains("--serve")
        selfTest = arguments.contains("--self-test")
        let usage = "Usage: people-worker --model <face .mlpackage|.mlmodelc> [--compiled-model <path.mlmodelc>]\n"
            + "         [--pet-model <pet model> [--pet-compiled-model <path.mlmodelc>]] --serve\n"
            + "       people-worker (--model <face model> | --pet-model <pet model>) [--compiled-model … | --pet-compiled-model …] --self-test"
        guard serve != selfTest else { throw WorkerError.invalidArguments(usage) }
        // Serving always reads faces; the pet model rides along. A self-test
        // checks exactly one model, so the settings can vet a pet model alone.
        if serve, modelURL == nil { throw WorkerError.invalidArguments(usage) }
        if selfTest, (modelURL == nil) == (petModelURL == nil) { throw WorkerError.invalidArguments(usage) }
    }
}

do {
    let arguments = try Arguments()
    let output = reserveStdoutForProtocol()
    if arguments.selfTest {
        if let petModelURL = arguments.petModelURL {
            writeJSON(try PetModel(modelURL: petModelURL, compiledURL: arguments.petCompiledModelURL).selfTest(), to: output)
        } else if let modelURL = arguments.modelURL {
            writeJSON(try ArcFaceModel(modelURL: modelURL, compiledURL: arguments.compiledModelURL).selfTest(), to: output)
        }
    } else if let modelURL = arguments.modelURL {
        let model = try ArcFaceModel(modelURL: modelURL, compiledURL: arguments.compiledModelURL)
        let petModel = try arguments.petModelURL.map { try PetModel(modelURL: $0, compiledURL: arguments.petCompiledModelURL) }
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else { continue }
            do {
                let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                writeJSON(analyze(request: request, model: model, petModel: petModel), to: output)
            } catch {
                writeJSON(Response.failure(id: "", error.localizedDescription), to: output)
            }
        }
    }
    removeTemporaryCompiledModels()
} catch {
    removeTemporaryCompiledModels()
    writeError(error.localizedDescription)
    exit(2)
}
