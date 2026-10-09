import SwiftUI

#if !FOTORO_LOCAL_PREVIEW
struct PhotoSyncRail: View {
  let summary: ConsumerSyncSummary
  let progress: PhotoSyncProgress
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var active: Bool {
    [.preparing, .uploading, .checking].contains(summary.state)
  }
  private var visible: Bool {
    active || [.paused, .offline, .needsAttention].contains(summary.state)
  }
  private var total: Int? {
    guard let total = progress.total, total > 0,
      progress.completed >= 0, progress.completed <= total else { return nil }
    return total
  }
  private var title: String {
    switch summary.state {
    case .preparing: return "Preparing photos"
    case .uploading:
      if let total { return "Saving \(progress.completed) of \(total)" }
      return "Saving photos"
    case .checking: return "Checking cloud"
    case .paused: return "Sync paused"
    case .offline: return "Waiting for a connection"
    case .needsAttention: return "Sync needs attention"
    case .notStarted, .upToDate: return ""
    }
  }
  private var tint: Color { active ? .accentColor : .orange }

  var body: some View {
    if visible {
      VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.caption).monospacedDigit().foregroundStyle(.secondary)
        Group {
          if let total {
            GeometryReader { geometry in
              Capsule().fill(.quaternary)
              Capsule().fill(tint)
                .frame(width: geometry.size.width * CGFloat(progress.completed) / CGFloat(total))
                .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: progress.completed)
            }
          } else if active && !reduceMotion {
            ProgressView().progressViewStyle(.linear).tint(tint)
          } else {
            Capsule().fill(.quaternary)
          }
        }.frame(height: 3).clipped()
      }
      .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
      .transaction { $0.animation = nil }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(title)
      .accessibilityValue(total.map { "\(progress.completed) of \($0) photos saved to Fotoro" } ?? "")
      .accessibilityIdentifier("home.sync.progress")
    }
  }
}

extension PhotoSyncItemStatus {
  var accessibilityText: String {
    switch phase {
    case .waiting: return "Waiting to sync"
    case .preparing: return "Preparing to save"
    case .uploading: return "Uploading photo"
    case .finishing: return "Finishing save"
    case .saved: return "Saved in Fotoro"
    case .skipped: return "Not saved in Fotoro"
    case .needsAttention: return "Sync needs attention"
    }
  }
}

struct PhotoSyncTileIndicator: View {
  let status: PhotoSyncItemStatus
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

  private var active: Bool {
    [.preparing, .uploading, .finishing].contains(status.phase)
  }
  private var symbol: String {
    switch status.phase {
    case .preparing: return "photo"
    case .uploading: return "arrow.up"
    case .finishing: return "ellipsis"
    case .skipped: return "icloud.slash"
    case .needsAttention: return "exclamationmark"
    case .waiting, .saved: return ""
    }
  }
  private var badge: some View {
    Group {
      if active && !reduceMotion {
        ProgressView().controlSize(.mini).tint(.primary)
      } else {
        Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
          .foregroundStyle(active ? Color.primary : .orange)
      }
    }.frame(width: 24, height: 24)
  }

  var body: some View {
    Group {
      if status.phase != .waiting && status.phase != .saved {
        Group {
          if reduceTransparency {
            badge.background(Color(uiColor: .secondarySystemBackground), in: .circle)
          } else if #available(iOS 26, *) {
            badge.glassEffect(.regular, in: .circle)
          } else {
            badge.background(.regularMaterial, in: .circle)
          }
        }
        .contentTransition(.opacity).transition(.opacity)
        .padding(7).allowsHitTesting(false).accessibilityHidden(true)
      }
    }.animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: status.phase)
  }
}
#endif
