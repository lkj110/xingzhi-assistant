// Apple API references:
// https://developer.apple.com/documentation/vision/recognizing-text-in-images
// https://developer.apple.com/documentation/imageio/cgimagesourcecreatethumbnailatindex(_:_:_:)
import Foundation
import Vision
import ImageIO
import CoreGraphics
import Darwin

let maxBytes = 10_000_000
func emit(_ value: [String: Any], status: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
    }
    exit(status)
}
func fail(_ code: String) -> Never { emit(["error": code], status: 1) }

// The process has no path arguments and reads only bounded bytes from stdin.
// ImageIO and Vision use the system frameworks; no subprocess, file, or network API is used.
var input = Data()
while input.count <= maxBytes {
    guard let chunk = try? FileHandle.standardInput.read(upToCount: min(65536, maxBytes + 1 - input.count)), !chunk.isEmpty else { break }
    input.append(chunk)
}
guard !input.isEmpty && input.count <= maxBytes else { fail("OCR_LIMIT") }
guard let source = CGImageSourceCreateWithData(input as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetStatus(source) == .statusComplete,
      CGImageSourceGetCount(source) == 1 else { fail("OCR_INVALID") }
let type = CGImageSourceGetType(source) as String?
guard type == "public.png" || type == "public.jpeg" else { fail("OCR_FORMAT") }
guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
      let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
      width > 0, height > 0 else { fail("OCR_INVALID") }
guard width <= 10000, height <= 10000, width * height <= 25_000_000 else { fail("OCR_LIMIT") }
let thumbnailOptions: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 4096,
    kCGImageSourceShouldCacheImmediately: true]
guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else { fail("OCR_INVALID") }
guard #available(macOS 13.0, *) else { fail("OCR_UNSUPPORTED") }
let request = VNRecognizeTextRequest()
request.revision = VNRecognizeTextRequestRevision3
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
do {
    let supported = try request.supportedRecognitionLanguages()
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"].filter { supported.contains($0) }
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch { fail("OCR_FAILED") }
let observations = (request.results ?? []).sorted { left, right in
    if left.boundingBox.maxY != right.boundingBox.maxY { return left.boundingBox.maxY > right.boundingBox.maxY }
    return left.boundingBox.minX < right.boundingBox.minX
}
var characters = 0
var lines: [[String: Any]] = []
for observation in observations {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { continue }
    characters += text.utf16.count
    guard characters <= 500_000, lines.count < 10000 else { fail("OCR_OUTPUT") }
    let box = observation.boundingBox
    lines.append(["text": text, "confidence": candidate.confidence,
        "box": ["x": max(0, box.minX), "y": max(0, 1 - box.maxY),
                "width": min(1, box.width), "height": min(1, box.height)]])
}
guard !lines.isEmpty else { fail("OCR_EMPTY") }
let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
let swapsAxes = (5...8).contains(orientation)
emit(["version": 1, "engine": "apple-vision", "format": type == "public.png" ? "png" : "jpeg",
      "width": swapsAxes ? height : width, "height": swapsAxes ? width : height,
      "scaled": max(width, height) > 4096, "lines": lines])
