// All content is synthesized for isolated tests; the sole path argument is the output directory.
import AppKit
import PDFKit
import CoreGraphics
guard CommandLine.arguments.count == 2 else { fatalError("Pass an isolated output directory") }
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
func drawWords(_ words: [String], height: CGFloat, fontSize: CGFloat = 58) {
    let style: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: fontSize), .foregroundColor: NSColor.black]
    for (index, word) in words.enumerated() { (word as NSString).draw(at: NSPoint(x: 70, y: height - 120 - CGFloat(index) * 105), withAttributes: style) }
}
func bitmap() -> CGImage {
    let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1400, pixelsHigh: 550, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: image)!
    NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1400, height: 550).fill()
    drawWords(["青禾扫描资料", "Scan budget 7200", "Owner Lin Yue"], height: 550)
    NSGraphicsContext.restoreGraphicsState(); return image.cgImage!
}
let scan = bitmap()
func makePDF(_ filename: String, pages: [String], size: CGSize = CGSize(width: 1400, height: 550)) {
    var box = CGRect(origin: .zero, size: size)
    let context = CGContext(directory.appendingPathComponent(filename) as CFURL, mediaBox: &box, nil)!
    for (index, kind) in pages.enumerated() {
        context.beginPDFPage(nil)
        if kind == "scan" || kind == "hybrid" { context.draw(scan, in: box) }
        if kind == "text" || kind == "hybrid" {
            NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
            drawWords(["Native text page \(index + 1)", "Reference 6800"], height: size.height)
            NSGraphicsContext.restoreGraphicsState()
        }
        context.endPDFPage()
    }
    context.closePDF()
}
makePDF("scanned.pdf", pages: ["scan", "scan"])
makePDF("mixed.pdf", pages: ["text", "scan", "blank", "scan"])
makePDF("text.pdf", pages: ["text", "text"])
makePDF("hybrid.pdf", pages: ["hybrid"])
makePDF("blank.pdf", pages: ["blank"])
makePDF("rotated.pdf", pages: ["scan"])
let rotated = PDFDocument(url: directory.appendingPathComponent("rotated.pdf"))!
rotated.page(at: 0)!.rotation = 90
rotated.write(to: directory.appendingPathComponent("rotated.pdf"))
makePDF("oversize.pdf", pages: ["scan"], size: CGSize(width: 10001, height: 550))
makePDF("ocr-overpages.pdf", pages: Array(repeating: "blank", count: 21))
makePDF("overpages.pdf", pages: Array(repeating: "blank", count: 251))
makePDF("pixel-limit.pdf", pages: Array(repeating: "blank", count: 12), size: CGSize(width: 2000, height: 2000))
let protected = PDFDocument(url: directory.appendingPathComponent("scanned.pdf"))!
protected.write(to: directory.appendingPathComponent("encrypted.pdf"), withOptions: [.userPasswordOption: "synthetic-password", .ownerPasswordOption: "synthetic-owner"])
