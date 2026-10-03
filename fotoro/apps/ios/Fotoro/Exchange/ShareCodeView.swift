import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

struct ShareCodePresentation: Identifiable {
  let id = UUID()
  let url: URL
  let title: String
}

struct ShareCodeView: View {
  let presentation: ShareCodePresentation
  @Environment(\.dismiss) private var dismiss
  private var code: UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(presentation.url.absoluteString.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage,
      let image = CIContext().createCGImage(output.transformed(by: .init(scaleX: 4, y: 4)),
        from: output.extent.applying(.init(scaleX: 4, y: 4))) else { return nil }
    return UIImage(cgImage: image)
  }
  var body: some View {
    NavigationStack {
      VStack(spacing: 24) {
        if let code {
          Image(uiImage: code).interpolation(.none).resizable().scaledToFit()
            .padding(20).background(.white).clipShape(RoundedRectangle(cornerRadius: 20))
            .frame(maxWidth: 320).accessibilityLabel("Fotoro QR code")
        }
        Text("Scan with the iPhone camera to open Fotoro.").foregroundStyle(.secondary)
        ShareLink("Share link", item: presentation.url)
      }.padding().navigationTitle(presentation.title).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
  }
}
