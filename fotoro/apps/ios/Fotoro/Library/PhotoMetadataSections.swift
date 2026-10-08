import SwiftUI

/// Presents measured capture details without turning technical metadata into user tags.
struct PhotoMetadataSections: View {
  private let summary: PhotoMetadataPresentation
  init(metadata: PhotoCaptureMetadata) {
    summary = PhotoMetadataPresentation(metadata)
  }

  var body: some View {
    if !summary.media.isEmpty {
      Section("Photo") {
        ForEach(summary.media) { PhotoMetadataRow(row: $0) }
      }
    }
    if !summary.camera.isEmpty {
      Section("Camera") {
        ForEach(summary.camera) { PhotoMetadataRow(row: $0) }
      }
    }
    if !summary.details.isEmpty {
      Section {
        DisclosureGroup("Capture details") {
          ForEach(summary.details) { PhotoMetadataRow(row: $0) }
        }
      }
    }
  }
}

/// Keeps current Photos dimensions prominent; original file measurements remain available.
struct PhotoMetadataPresentation {
  var media: [PhotoCaptureMetadata.Row] = []
  var camera: [PhotoCaptureMetadata.Row] = []
  var details: [PhotoCaptureMetadata.Row] = []

  init(_ metadata: PhotoCaptureMetadata) {
    let items = metadata.items.filter(PhotoCaptureMetadata.validated)
    func item(_ key: String, _ provenance: PhotoCaptureMetadata.Provenance) -> PhotoCaptureMetadata.Item? {
      items.first { $0.k == key && $0.p == provenance }
    }
    func row(_ id: String, _ title: String, _ value: String, _ group: PhotoCaptureMetadata.Group,
      _ provenance: PhotoCaptureMetadata.Provenance) -> PhotoCaptureMetadata.Row {
      PhotoCaptureMetadata.Row(id: id, title: title, value: value, group: group, provenance: provenance)
    }
    var preferredDimensions: String?
    for provenance in [PhotoCaptureMetadata.Provenance.photos, .original] {
      guard let width = item("width", provenance)?.v, let height = item("height", provenance)?.v else { continue }
      let dimensions = width + " × " + height
      if preferredDimensions == nil {
        media.append(row("dimensions", "Dimensions", dimensions + " px", .media, provenance))
        preferredDimensions = dimensions
      } else if dimensions != preferredDimensions {
        details.append(row("originalDimensions", "Original dimensions", dimensions + " px", .source, provenance))
      }
    }
    let features = ["panorama": "Panorama", "hdr": "HDR", "screenshot": "Screenshot",
      "livePhoto": "Live Photo", "depthEffect": "Portrait depth", "animation": "Animated",
      "spatial": "Spatial", "streamed": "Streamed", "highFrameRate": "High frame rate",
      "timelapse": "Time-lapse", "screenRecording": "Screen recording", "cinematic": "Cinematic"]
    let sourceNames = ["userLibrary": "Your library", "cloudShared": "iCloud shared album", "iTunesSynced": "Synced from a computer"]
    var preferredFormat: String?
    let keys = ["mediaType", "contentType", "subtypes", "duration", "cameraMake", "cameraModel",
      "lensMake", "lensModel", "aperture", "exposureSeconds", "iso", "focalLength", "focalLength35mm",
      "originalDateTime", "offsetTimeOriginal", "orientation", "hasAdjustments", "burst", "burstSelection",
      "modifiedAt", "addedAt", "sourceTypes"]
    let rows = metadata.rows
    for key in keys {
      for provenance in [PhotoCaptureMetadata.Provenance.photos, .original] {
        guard let value = item(key, provenance)?.v,
          var display = rows.first(where: { $0.id == provenance.rawValue + ":" + key }) else { continue }
        switch key {
        case "mediaType": display.value = ["image": "Photo", "video": "Video", "audio": "Audio"][value] ?? value
        case "contentType":
          display.value = ["public.jpeg": "JPEG", "public.png": "PNG", "public.heic": "HEIC",
            "public.heif": "HEIF", "com.apple.quicktime-movie": "QuickTime", "public.mpeg-4": "MPEG-4"][value] ?? value
          if preferredFormat == display.value { continue }
          if preferredFormat != nil { display.title = "Original format"; display.group = .source }
          preferredFormat = display.value
        case "subtypes": display.value = value.split(separator: ",").compactMap { features[String($0)] }.joined(separator: " · ")
        case "sourceTypes": display.value = value.split(separator: ",").compactMap { sourceNames[String($0)] }.joined(separator: " · ")
        case "hasAdjustments", "burst":
          if value == "false" { continue }
          display.value = "Yes"
        case "burstSelection": display.value = value.split(separator: ",").map { $0 == "autoPick" ? "Photos pick" : "Your pick" }.joined(separator: " · ")
        case "exposureSeconds":
          if let seconds = Double(value), seconds > 0, seconds < 1 {
            let denominator = (1 / seconds).rounded()
            if denominator.isFinite, denominator <= 1_000_000_000,
              abs(1 / denominator - seconds) / seconds < 0.005 {
              display.value = "1/\(Int(denominator)) s"
            }
          }
        case "orientation":
          display.value = ["1": "Upright", "2": "Mirrored", "3": "Rotated 180°", "4": "Mirrored vertically",
            "5": "Mirrored and rotated", "6": "Rotated 90° clockwise", "7": "Mirrored and rotated",
            "8": "Rotated 90° counterclockwise"][value] ?? value
          display.group = .source
        case "originalDateTime", "offsetTimeOriginal": display.group = .source
        default: break
        }
        switch display.group {
        case .media: media.append(display)
        case .camera: camera.append(display)
        case .exposure, .source: details.append(display)
        }
      }
    }
  }
}

private struct PhotoMetadataRow: View {
  let row: PhotoCaptureMetadata.Row

  var body: some View {
    LabeledContent {
      Text(row.value).multilineTextAlignment(.trailing).textSelection(.enabled)
    } label: {
      VStack(alignment: .leading, spacing: 2) {
        Text(row.title)
        Text(row.provenance.title).font(.caption2).foregroundStyle(.secondary)
      }
    }.accessibilityElement(children: .combine)
  }
}
