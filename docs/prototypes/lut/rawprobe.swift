// Probe: what Apple's RAW engine (CIRAWFilter) reports and outputs per camera.
//   rawprobe <raw>...
// Prints the camera's baselineExposure and, with boostAmount = 0 (linear
// response) at 1/8 size, the linear maximum, the share of pixels above 1.0 and
// the median luminance: how much headroom a still has above 18% grey.
import CoreImage
import Foundation
let ctx = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!])
for p in CommandLine.arguments.dropFirst() {
  let f = CIRAWFilter(imageURL: URL(fileURLWithPath: p))!
  let base = f.baselineExposure
  f.scaleFactor = 0.125; f.boostAmount = 0
  let img = f.outputImage!; let e = img.extent.integral
  var buf = [Float](repeating: 0, count: Int(e.width) * Int(e.height) * 4)
  buf.withUnsafeMutableBytes { ctx.render(img, toBitmap: $0.baseAddress!, rowBytes: Int(e.width) * 16, bounds: e, format: .RGBAf, colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!) }
  var mx: Float = 0; var over = 0; var lum: [Float] = []
  for i in stride(from: 0, to: buf.count, by: 4) { let m = max(buf[i], buf[i+1], buf[i+2]); mx = max(mx, m); if m > 1 { over += 1 }; lum.append(0.2126*buf[i]+0.7152*buf[i+1]+0.0722*buf[i+2]) }
  lum.sort()
  print("\((p as NSString).lastPathComponent): baselineExposure \(base)  linear max \(String(format: "%.2f", mx))  >1.0: \(String(format: "%.2f", Float(over) * 100 / Float(buf.count / 4)))%  median \(String(format: "%.3f", lum[lum.count/2]))")
}
