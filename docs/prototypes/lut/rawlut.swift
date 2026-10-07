// Prototype: RAW -> LUT on macOS with Apple's RAW engine (CIRAWFilter).
//   rawlut <raw> <cube> <out.jpg> rec709            Apple's default render -> LUT
//   rawlut <raw> <cube> <out.jpg> slog3 <ref.cube>  linear -> S-Gamut3.Cine/S-Log3 -> LUT,
//                                                    exposure matched so <ref.cube> (Sony's
//                                                    official LC-709) lands on Apple's render
// Float math in strips; tetrahedral LUT; 8-bit sRGB JPEG out.
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Cube { let n: Int; let t: [Float] }  // R fastest, 3 floats per node

func loadCube(_ path: String) -> Cube {
  let text = try! String(contentsOfFile: path, encoding: .utf8)
  var n = 0; var t: [Float] = []
  for raw in text.split(whereSeparator: \.isNewline) {
    let s = raw.trimmingCharacters(in: .whitespaces)
    if s.isEmpty || s.hasPrefix("#") { continue }
    if let c = s.unicodeScalars.first, CharacterSet.letters.contains(c) {
      if s.hasPrefix("LUT_3D_SIZE") { n = Int(s.split(separator: " ").last!)! }
      continue
    }
    for v in s.split(whereSeparator: { $0 == " " || $0 == "\t" }).prefix(3) { t.append(Float(v)!) }
  }
  precondition(t.count == n * n * n * 3)
  return Cube(n: n, t: t)
}

@inline(__always) func tetra(_ c: Cube, _ r: Float, _ g: Float, _ b: Float) -> (Float, Float, Float) {
  let n1 = Float(c.n - 1)
  let x = min(max(r, 0), 1) * n1, y = min(max(g, 0), 1) * n1, z = min(max(b, 0), 1) * n1
  let i = min(Int(x), c.n - 2), j = min(Int(y), c.n - 2), k = min(Int(z), c.n - 2)
  let fr = x - Float(i), fg = y - Float(j), fb = z - Float(k)
  let sR = 3, sG = 3 * c.n, sB = 3 * c.n * c.n
  let o = i * sR + j * sG + k * sB
  var a = 0, d = 0; var w0: Float = 0, w1: Float = 0, w2: Float = 0, w3: Float = 0
  if fr >= fg {
    if fg >= fb { a = sR; d = sR + sG; w0 = 1 - fr; w1 = fr - fg; w2 = fg - fb; w3 = fb }
    else if fr >= fb { a = sR; d = sR + sB; w0 = 1 - fr; w1 = fr - fb; w2 = fb - fg; w3 = fg }
    else { a = sB; d = sR + sB; w0 = 1 - fb; w1 = fb - fr; w2 = fr - fg; w3 = fg }
  } else {
    if fb > fg { a = sB; d = sG + sB; w0 = 1 - fb; w1 = fb - fg; w2 = fg - fr; w3 = fr }
    else if fb > fr { a = sG; d = sG + sB; w0 = 1 - fg; w1 = fg - fb; w2 = fb - fr; w3 = fr }
    else { a = sG; d = sR + sG; w0 = 1 - fg; w1 = fg - fr; w2 = fr - fb; w3 = fb }
  }
  let e = sR + sG + sB
  return c.t.withUnsafeBufferPointer { t -> (Float, Float, Float) in
    @inline(__always) func ch(_ q: Int) -> Float {
      let p0: Float = t[q] * w0, p1: Float = t[q + a] * w1
      let p2: Float = t[q + d] * w2, p3: Float = t[q + e] * w3
      return p0 + p1 + p2 + p3
    }
    return (ch(o), ch(o + 1), ch(o + 2))
  }
}

@inline(__always) func slog3(_ x: Float) -> Float {
  let v = max(x, -0.01)
  return v >= 0.01125 ? (420 + log10((v + 0.01) / 0.19) * 261.5) / 1023 : (v * (171.2102946929 - 95) / 0.01125 + 95) / 1023
}

// Linear Rec.709 (Core Image's linear sRGB) -> S-Gamut3.Cine, both D65.
func matrix709ToSG3C() -> [Float] {
  func m(_ p: [(Double, Double)]) -> [[Double]] {
    let w = (0.3127, 0.3290)
    let cols = p.map { [$0.0 / $0.1, 1, (1 - $0.0 - $0.1) / $0.1] }
    let W = [w.0 / w.1, 1, (1 - w.0 - w.1) / w.1]
    let M = (0..<3).map { r in (0..<3).map { c in cols[c][r] } }
    let s = solve(M, W)
    return (0..<3).map { r in (0..<3).map { c in M[r][c] * s[c] } }
  }
  let a = m([(0.64, 0.33), (0.30, 0.60), (0.15, 0.06)])
  let b = inv(m([(0.766, 0.275), (0.225, 0.800), (0.089, -0.087)]))
  var out = [Float](repeating: 0, count: 9)
  for r in 0..<3 { for c in 0..<3 { out[r * 3 + c] = Float((0..<3).reduce(0) { $0 + b[r][$1] * a[$1][c] }) } }
  return out
}
func det(_ m: [[Double]]) -> Double {
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}
func inv(_ m: [[Double]]) -> [[Double]] {
  let d = det(m)
  return (0..<3).map { r in (0..<3).map { c in
    let rr = [0, 1, 2].filter { $0 != c }, cc = [0, 1, 2].filter { $0 != r }
    let minor = m[rr[0]][cc[0]] * m[rr[1]][cc[1]] - m[rr[0]][cc[1]] * m[rr[1]][cc[0]]
    return ((r + c) % 2 == 0 ? 1 : -1) * minor / d
  } }
}
func solve(_ m: [[Double]], _ v: [Double]) -> [Double] {
  let i = inv(m); return (0..<3).map { r in (0..<3).reduce(0) { $0 + i[r][$1] * v[$1] } }
}

let args = CommandLine.arguments
let rawURL = URL(fileURLWithPath: args[1]), lut = loadCube(args[2]), outPath = args[3], mode = args[4]
let ctx = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!, .cacheIntermediates: false])
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!, linear = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!

func rawFilter(scale: Float, boost: Float, ev: Float) -> CIImage {
  let f = CIRAWFilter(imageURL: rawURL)!
  f.scaleFactor = scale
  f.boostAmount = boost
  f.exposure = ev
  return f.outputImage!
}

// Renders `image` strip by strip into float RGBA in `space`, hands each pixel to `px`,
// and returns 8-bit RGBA.
func process(_ image: CIImage, space: CGColorSpace, _ px: (Float, Float, Float) -> (Float, Float, Float)) -> (Data, Int, Int) {
  let e = image.extent.integral, w = Int(e.width), h = Int(e.height), strip = 256
  var out = Data(count: w * h * 4)
  var buf = [Float](repeating: 0, count: w * strip * 4)
  out.withUnsafeMutableBytes { (o: UnsafeMutableRawBufferPointer) in
    let ob = o.bindMemory(to: UInt8.self)
    var y = 0
    while y < h {
      let rows = min(strip, h - y)
      // Core Image's origin is bottom-left.
      let rect = CGRect(x: e.minX, y: e.maxY - CGFloat(y + rows), width: CGFloat(w), height: CGFloat(rows))
      buf.withUnsafeMutableBytes { b in
        ctx.render(image, toBitmap: b.baseAddress!, rowBytes: w * 16, bounds: rect, format: .RGBAf, colorSpace: space)
      }
      DispatchQueue.concurrentPerform(iterations: rows) { r in
        for x in 0..<w {
          let i = (r * w + x) * 4
          let (R, G, B) = px(buf[i], buf[i + 1], buf[i + 2])
          let oi = ((y + r) * w + x) * 4
          ob[oi] = UInt8(min(max(R, 0), 1) * 255 + 0.5); ob[oi + 1] = UInt8(min(max(G, 0), 1) * 255 + 0.5)
          ob[oi + 2] = UInt8(min(max(B, 0), 1) * 255 + 0.5); ob[oi + 3] = 255
        }
      }
      y += rows
    }
  }
  return (out, w, h)
}

func medianLuma(_ d: Data) -> Float {
  var v = [Float](); v.reserveCapacity(d.count / 4)
  d.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
    var i = 0
    while i < p.count { v.append(0.2126 * Float(p[i]) + 0.7152 * Float(p[i + 1]) + 0.0722 * Float(p[i + 2])); i += 16 }
  }
  v.sort(); return v[v.count / 2]
}

let M = matrix709ToSG3C()
func logPixel(_ r: Float, _ g: Float, _ b: Float, _ k: Float) -> (Float, Float, Float) {
  let R = (M[0] * r + M[1] * g + M[2] * b) * k, G = (M[3] * r + M[4] * g + M[5] * b) * k, B = (M[6] * r + M[7] * g + M[8] * b) * k
  return (slog3(R), slog3(G), slog3(B))
}

let t0 = Date()
var result: (Data, Int, Int)
if mode == "rec709" {
  result = process(rawFilter(scale: 1, boost: 1, ev: 0), space: srgb) { tetra(lut, $0, $1, $2) }
} else {
  let ref = loadCube(args[5])
  let target = medianLuma(process(rawFilter(scale: 0.125, boost: 1, ev: 0), space: srgb) { ($0, $1, $2) }.0)
  let small = rawFilter(scale: 0.125, boost: 0, ev: 0)
  var best: (Float, Float) = (0, .infinity)
  for step in -10...30 {
    let ev = Float(step) / 10, k = powf(2, ev)
    let m = medianLuma(process(small, space: linear) { let l = logPixel($0, $1, $2, k); return tetra(ref, l.0, l.1, l.2) }.0)
    if abs(m - target) < best.1 { best = (ev, abs(m - target)) }
  }
  FileHandle.standardError.write("exposure matched to Apple's render: \(String(format: "%+.1f", best.0)) EV\n".data(using: .utf8)!)
  let k = powf(2, best.0)
  result = process(rawFilter(scale: 1, boost: 0, ev: 0), space: linear) { let l = logPixel($0, $1, $2, k); return tetra(lut, l.0, l.1, l.2) }
}
let (data, w, h) = result
let provider = CGDataProvider(data: data as CFData)!
let cg = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4, space: srgb,
                 bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
                 decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
CGImageDestinationFinalize(dest)
print("\(mode) \(w)x\(h) in \(String(format: "%.1f", Date().timeIntervalSince(t0)))s")
