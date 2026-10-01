import AppKit
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
func render(_ name: String, _ lines: [String], rotated: Bool = false) throws {
    let size = NSSize(width: 1200, height: 800)
    let image = NSImage(size: size)
    image.lockFocus()
    NSColor.white.setFill()
    NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()
    if rotated {
        let transform = NSAffineTransform()
        transform.translateX(by: 1200, yBy: 800)
        transform.rotate(byDegrees: 180)
        transform.concat()
    }
    for (i, line) in lines.enumerated() {
        let attr: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 76, weight: .semibold), .foregroundColor: NSColor.black]
        (line as NSString).draw(at: NSPoint(x: 85, y: 580 - i * 145), withAttributes: attr)
    }
    image.unlockFocus()
    let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)!
    let rep = NSBitmapImageRep(cgImage: cg)
    try rep.representation(using: .png, properties: [:])!.write(to: dir.appendingPathComponent(name))
}
try render("neutral-a.png", ["SEATTLE RECEIPT", "INVOICE 4826", "TOTAL 28.50"])
try render("neutral-b.png", ["BOARDING PASS", "BOSTON", "GATE TWELVE"])
try render("neutral-c.png", ["BOARDING PASS", "BOSTON", "GATE TWELVE"], rotated: true)
