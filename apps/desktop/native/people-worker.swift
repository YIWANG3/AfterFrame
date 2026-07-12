// AfterFrame People Worker
//
// A precompiled, line-oriented local worker for face detection and ArcFace
// embedding inference. It deliberately owns no catalog/database state: the
// sidecar launches it for a people_index job and persists its JSON responses.
//
// Usage:
//   people-worker --model /path/to/ArcFaceR100.mlpackage --self-test
//   people-worker --model /path/to/ArcFaceR100.mlpackage --serve
//
// In --serve mode stdin/stdout use one JSON object per line:
//   request:  {"id":"asset-42","asset_path":"/path/to/photo.jpg"}
//   response: {"id":"asset-42","ok":true,"input_hash":"…","faces":[…]}

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

    enum CodingKeys: String, CodingKey {
        case id
        case assetPath = "asset_path"
        case knownInputHash = "known_input_hash"
    }
}

private struct Response: Encodable {
    let id: String
    let ok: Bool
    let skipped: Bool
    let inputHash: String?
    let imageSize: ImageSize?
    let faces: [Face]
    let error: String?

    enum CodingKeys: String, CodingKey {
        case id, ok, skipped, faces, error
        case inputHash = "input_hash"
        case imageSize = "image_size"
    }
}

private struct SelfTestResponse: Encodable {
    let ok: Bool
    let inputName: String
    let outputName: String
    let embeddingDimensions: Int

    enum CodingKeys: String, CodingKey {
        case ok
        case inputName = "input_name"
        case outputName = "output_name"
        case embeddingDimensions = "embedding_dimensions"
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

    init(modelURL: URL) throws {
        let resolvedURL: URL
        if modelURL.pathExtension == "mlmodelc" {
            resolvedURL = modelURL
        } else {
            resolvedURL = try MLModel.compileModel(at: modelURL)
        }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        model = try MLModel(contentsOf: resolvedURL, configuration: configuration)
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
            embeddingDimensions: array.count
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
        let embedding = try floats(from: output)
        let squaredLength = embedding.reduce(Float(0)) { $0 + $1 * $1 }
        guard squaredLength > 0 else { throw WorkerError.invalidEmbedding }
        let length = sqrt(squaredLength)
        return embedding.map { $0 / length }
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

    private func floats(from array: MLMultiArray) throws -> [Float] {
        switch array.dataType {
        case .float32:
            let pointer = array.dataPointer.assumingMemoryBound(to: Float32.self)
            return (0..<array.count).map { pointer[$0] }
        case .double:
            let pointer = array.dataPointer.assumingMemoryBound(to: Double.self)
            return (0..<array.count).map { Float(pointer[$0]) }
        case .float16:
            let pointer = array.dataPointer.assumingMemoryBound(to: Float16.self)
            return (0..<array.count).map { Float(pointer[$0]) }
        default:
            throw WorkerError.unsupportedModelOutput
        }
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

private func analyze(request: Request, model: ArcFaceModel) -> Response {
    do {
        let image = try canonicalImage(at: request.assetPath)
        let buffer = try makeBuffer(image)
        if request.knownInputHash == buffer.inputHash {
            return Response(
                id: request.id,
                ok: true,
                skipped: true,
                inputHash: buffer.inputHash,
                imageSize: ImageSize(width: buffer.width, height: buffer.height),
                faces: [],
                error: nil
            )
        }
        let observations = try detectFaces(in: image)
        let faces: [Face] = try observations.compactMap { observation in
            guard let points = sourceLandmarks(for: observation, width: buffer.width, height: buffer.height),
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
        return Response(
            id: request.id,
            ok: true,
            skipped: false,
            inputHash: buffer.inputHash,
            imageSize: ImageSize(width: buffer.width, height: buffer.height),
            faces: faces,
            error: nil
        )
    } catch {
        return Response(
            id: request.id,
            ok: false,
            skipped: false,
            inputHash: nil,
            imageSize: nil,
            faces: [],
            error: error.localizedDescription
        )
    }
}

private func writeJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(value) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

private func writeError(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private struct Arguments {
    let modelURL: URL
    let serve: Bool
    let selfTest: Bool

    init() throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let modelIndex = arguments.firstIndex(of: "--model"), arguments.indices.contains(modelIndex + 1) else {
            throw WorkerError.invalidArguments("Usage: people-worker --model <.mlpackage|.mlmodelc> [--serve|--self-test]")
        }
        modelURL = URL(fileURLWithPath: arguments[modelIndex + 1])
        serve = arguments.contains("--serve")
        selfTest = arguments.contains("--self-test")
        guard serve || selfTest else {
            throw WorkerError.invalidArguments("Specify --serve or --self-test")
        }
        guard !(serve && selfTest) else {
            throw WorkerError.invalidArguments("Specify only one of --serve or --self-test")
        }
    }
}

do {
    let arguments = try Arguments()
    let model = try ArcFaceModel(modelURL: arguments.modelURL)
    if arguments.selfTest {
        writeJSON(try model.selfTest())
    } else {
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else { continue }
            do {
                let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                writeJSON(analyze(request: request, model: model))
            } catch {
                writeJSON(Response(id: "", ok: false, skipped: false, inputHash: nil, imageSize: nil, faces: [], error: error.localizedDescription))
            }
        }
    }
} catch {
    writeError(error.localizedDescription)
    exit(2)
}
