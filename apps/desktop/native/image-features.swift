// AfterFrame image features helper.
//
// Apple Vision's image feature print (VNGenerateImageFeaturePrintRequest) for
// a photo: a unit-length float vector whose Euclidean distance says how alike
// two pictures look. The sidecar launches it for a visual-index job and keeps
// the vectors; this helper owns no catalog state.
//
// Usage:
//   image-features --serve            one JSON request per stdin line
//   image-features --model            the model name this Mac's prints carry
//   image-features <image> [<image>…] one response line per argument
//
// Request:  {"id":"asset-42","path":"/path/to/preview.jpg"}
// Response: {"id":"asset-42","ok":true,"model":"vision-fp-r2","dim":768,"b64":"…"}
//           b64 is the vector as little-endian float32.
//           {"id":"asset-42","ok":false,"error":"…"} when the image can't be read.
// stdout carries nothing else: anything a framework prints goes to stderr.

import Foundation
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
        respond(id: (object["id"] as? String) ?? path, path: path)
    }
} else if arguments.first == "--model" {
    print(modelName)
} else if arguments.isEmpty {
    FileHandle.standardError.write(Data("Usage: image-features --serve | image-features <image>...\n".utf8))
    exit(64)
} else {
    for path in arguments { respond(id: path, path: path) }
}
