// Synthetic, non-private images for native OCR tests only.
import AppKit
import ImageIO
guard CommandLine.arguments.count == 2 else { fatalError("Pass an isolated output directory") }
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
func bitmap(width: Int = 1400, height: Int = 550, blank: Bool = false) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
    NSColor.white.setFill(); NSRect(x: 0, y: 0, width: width, height: height).fill()
    if !blank {
        let style: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 60), .foregroundColor: NSColor.black]
        ("青禾项目会议" as NSString).draw(at: NSPoint(x: 70, y: height - 120), withAttributes: style)
        ("Project Cedar 2026" as NSString).draw(at: NSPoint(x: 70, y: height - 230), withAttributes: style)
        ("Budget 7200" as NSString).draw(at: NSPoint(x: 70, y: height - 340), withAttributes: style)
    }
    NSGraphicsContext.restoreGraphicsState(); return rep
}
let normal = bitmap()
try normal.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("synthetic.png"))
try normal.representation(using: .jpeg, properties: [.compressionFactor: 0.95])!.write(to: directory.appendingPathComponent("synthetic.jpeg"))
try bitmap(blank: true).representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("blank.png"))
try bitmap(width: 10001, height: 1, blank: true).representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("oversize.png"))
try bitmap(width: 5000, height: 2000).representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("large.png"))
let rotatedURL = directory.appendingPathComponent("oriented.jpeg")
let destination = CGImageDestinationCreateWithURL(rotatedURL as CFURL, "public.jpeg" as CFString, 1, nil)!
CGImageDestinationAddImage(destination, normal.cgImage!, [kCGImagePropertyOrientation: 6] as CFDictionary)
CGImageDestinationFinalize(destination)
