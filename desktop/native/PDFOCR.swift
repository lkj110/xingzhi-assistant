// https://developer.apple.com/documentation/coregraphics/cgpdfdocument
// https://developer.apple.com/documentation/coregraphics/cgpdfpage/getdrawingtransform(_:rect:rotate:preserveaspectratio:)
// https://developer.apple.com/documentation/vision/recognizing-text-in-images
import Foundation
import CoreGraphics
import Vision
import Darwin

func emit(_ value: [String: Any], status: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) { FileHandle.standardOutput.write(data) }
    exit(status)
}
func fail(_ code: String) -> Never { emit(["error": code], status: 1) }
let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2, args.count <= 21, let expectedCount = Int(args[0]), expectedCount > 0, expectedCount <= 250 else { fail("PDF_OCR_LIMIT") }
let selected = args.dropFirst().compactMap { Int($0) }
guard selected.count == args.count - 1, Set(selected).count == selected.count, selected.allSatisfy({ $0 > 0 && $0 <= expectedCount }) else { fail("PDF_OCR_LIMIT") }
var data = Data()
while data.count <= 10_000_000 {
    guard let chunk = try? FileHandle.standardInput.read(upToCount: min(65536, 10_000_001 - data.count)), !chunk.isEmpty else { break }
    data.append(chunk)
}
guard !data.isEmpty, data.count <= 10_000_000 else { fail("PDF_OCR_LIMIT") }
guard let provider = CGDataProvider(data: data as CFData), let document = CGPDFDocument(provider) else { fail("PDF_OCR_INVALID") }
guard !document.isEncrypted else { fail("PDF_OCR_ENCRYPTED") }
guard document.numberOfPages == expectedCount else { fail("PDF_OCR_INVALID") }
guard #available(macOS 13.0, *) else { fail("PDF_OCR_UNSUPPORTED") }
var totalPixels = 0, totalCharacters = 0
var output: [[String: Any]] = []
for pageNumber in selected {
    autoreleasepool {
        guard let page = document.page(at: pageNumber) else { fail("PDF_OCR_INVALID") }
        let box = page.getBoxRect(.cropBox)
        guard box.width.isFinite, box.height.isFinite, box.minX.isFinite, box.minY.isFinite,
              box.width > 0, box.height > 0 else { fail("PDF_OCR_INVALID") }
        guard box.width <= 10000, box.height <= 10000 else { fail("PDF_OCR_LIMIT") }
        let angle = ((page.rotationAngle % 360) + 360) % 360
        guard [0, 90, 180, 270].contains(angle) else { fail("PDF_OCR_INVALID") }
        let rotated = angle == 90 || angle == 270
        let displayWidth = rotated ? box.height : box.width, displayHeight = rotated ? box.width : box.height
        let scale = min(2.0, 3000.0 / max(displayWidth, displayHeight))
        let width = max(1, Int(floor(displayWidth * scale))), height = max(1, Int(floor(displayHeight * scale)))
        totalPixels += width * height
        guard width <= 3000, height <= 3000, width * height <= 9_000_000, totalPixels <= 100_000_000 else { fail("PDF_OCR_LIMIT") }
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("PDF_OCR_FAILED") }
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(rect)
        context.saveGState(); context.concatenate(page.getDrawingTransform(.cropBox, rect: rect, rotate: 0, preserveAspectRatio: true)); context.drawPDFPage(page); context.restoreGState()
        guard let image = context.makeImage() else { fail("PDF_OCR_FAILED") }
        let request = VNRecognizeTextRequest(); request.revision = VNRecognizeTextRequestRevision3; request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
        do {
            let supported = try request.supportedRecognitionLanguages()
            request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"].filter { supported.contains($0) }
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        } catch { fail("PDF_OCR_FAILED") }
        let observations = (request.results ?? []).sorted { left, right in
            if left.boundingBox.maxY != right.boundingBox.maxY { return left.boundingBox.maxY > right.boundingBox.maxY }
            return left.boundingBox.minX < right.boundingBox.minX
        }
        var lines: [[String: Any]] = []
        for observation in observations {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            totalCharacters += text.utf16.count
            guard totalCharacters <= 500_000, lines.count < 10000 else { fail("PDF_OCR_OUTPUT") }
            let box = observation.boundingBox
            lines.append(["text": text, "confidence": candidate.confidence, "box": ["x": max(0, box.minX), "y": max(0, 1 - box.maxY), "width": min(1, box.width), "height": min(1, box.height)]])
        }
        output.append(["page": pageNumber, "width": width, "height": height, "pageWidthPoints": displayWidth, "pageHeightPoints": displayHeight, "scaled": scale < 2, "lines": lines])
    }
}
emit(["version": 1, "engine": "apple-vision-pdf", "pageCount": document.numberOfPages, "pages": output])
