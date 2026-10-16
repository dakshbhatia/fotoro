import SwiftUI
import UIKit

// Visible tile geometry is deliberately unobserved: scrolling must not publish
// the whole grid merely to support a selection gesture that is not running.
@MainActor final class PhotoGridSelectionRegistry {
  struct Entry {
    let token: UUID
    let frame: CGRect
    let selected: Bool
    let toggle: () -> Void
  }
  var entries: [String: Entry] = [:]
}
private struct PhotoGridSelectionEnvironmentKey: EnvironmentKey {
  static let defaultValue: PhotoGridSelectionRegistry? = nil
}
extension EnvironmentValues {
  var photoGridSelection: PhotoGridSelectionRegistry? {
    get { self[PhotoGridSelectionEnvironmentKey.self] }
    set { self[PhotoGridSelectionEnvironmentKey.self] = newValue }
  }
}

struct PhotoGridSelectionTile: ViewModifier {
  let id: String
  let selected: Bool
  let toggle: () -> Void
  @Environment(\.photoGridSelection) private var registry
  @State private var token = UUID()
  @State private var frame: CGRect = .zero
  @State private var visible = false
  func body(content: Content) -> some View {
    content.onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0; publish() }
      .onScrollVisibilityChange(threshold: 0.1) { visible = $0; publish() }
      .onChange(of: selected) { publish() }
      .onChange(of: id) { old, _ in remove(old); publish() }
      .onDisappear { remove(id) }
  }
  private func publish() {
    guard visible, !frame.isEmpty else { remove(id); return }
    registry?.entries[id] = .init(token: token, frame: frame, selected: selected, toggle: toggle)
  }
  private func remove(_ key: String) {
    if registry?.entries[key]?.token == token { registry?.entries[key] = nil }
  }
}

// A native recognizer decides direction before beginning. Vertical drags remain
// owned by UIScrollView; only horizontal drags in Select mode paint selection.
struct PhotoGridSelectionGesture: UIViewRepresentable {
  let registry: PhotoGridSelectionRegistry
  let enabled: Bool
  func makeUIView(context: Context) -> Attachment { Attachment(coordinator: context.coordinator) }
  func updateUIView(_ view: Attachment, context: Context) {
    context.coordinator.registry = registry
    context.coordinator.enabled = enabled
    if !enabled { context.coordinator.cancel() }
    view.attach()
  }
  static func dismantleUIView(_ view: Attachment, coordinator: Coordinator) { coordinator.detach() }
  func makeCoordinator() -> Coordinator { Coordinator(registry: registry, enabled: enabled) }
  final class Attachment: UIView {
    let coordinator: Coordinator
    init(coordinator: Coordinator) { self.coordinator = coordinator; super.init(frame: .zero); isUserInteractionEnabled = false }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func didMoveToWindow() { super.didMoveToWindow(); attach() }
    override func didMoveToSuperview() { super.didMoveToSuperview(); attach() }
    override func layoutSubviews() { super.layoutSubviews(); attach() }
    func attach() {
      var parent = superview
      while let candidate = parent {
        if let scroll = candidate as? UIScrollView { coordinator.attach(scroll); return }
        parent = candidate.superview
      }
    }
  }
  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    var registry: PhotoGridSelectionRegistry
    var enabled: Bool
    private weak var scroll: UIScrollView?
    private var recognizer: UIPanGestureRecognizer?
    private var stroke = PhotoGridSelectionStroke()
    private var captured: [String: PhotoGridSelectionRegistry.Entry] = [:]
    private var previous: CGPoint = .zero
    init(registry: PhotoGridSelectionRegistry, enabled: Bool) { self.registry = registry; self.enabled = enabled }
    func attach(_ scroll: UIScrollView) {
      guard self.scroll !== scroll else { return }
      detach(); self.scroll = scroll
      let pan = UIPanGestureRecognizer(target: self, action: #selector(moved(_:)))
      pan.minimumNumberOfTouches = 1; pan.maximumNumberOfTouches = 1
      pan.delegate = self; scroll.addGestureRecognizer(pan)
      scroll.panGestureRecognizer.require(toFail: pan)
      recognizer = pan
    }
    func detach() { if let recognizer { scroll?.removeGestureRecognizer(recognizer) }; recognizer = nil; scroll = nil; cancel() }
    func cancel() { stroke.reset(); captured = [:] }
    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
      guard enabled, !UIAccessibility.isVoiceOverRunning, let pan = recognizer as? UIPanGestureRecognizer else { return false }
      let velocity = pan.velocity(in: scroll)
      guard PhotoGridSelectionStroke.canBegin(velocity: velocity) else { return false }
      let point = pan.location(in: nil)
      let translation = pan.translation(in: nil)
      let start = CGPoint(x: point.x - translation.x, y: point.y - translation.y)
      return registry.entries.values.contains { $0.frame.contains(start) }
    }
    @objc private func moved(_ pan: UIPanGestureRecognizer) {
      guard enabled, pan.numberOfTouches <= 1, !UIAccessibility.isVoiceOverRunning else { cancel(); return }
      let point = pan.location(in: nil)
      switch pan.state {
      case .began:
        captured = registry.entries
        let translation = pan.translation(in: nil)
        previous = CGPoint(x: point.x - translation.x, y: point.y - translation.y)
        guard let entry = captured.first(where: { $0.value.frame.contains(previous) }) else { cancel(); return }
        stroke.begin(selected: entry.value.selected)
        paint(to: point)
      case .changed: paint(to: point)
      case .ended: paint(to: point); cancel()
      default: cancel()
      }
    }
    private func paint(to point: CGPoint) {
      let desired = stroke.selected
      for (id, entry) in captured where PhotoGridSelectionStroke.intersects(entry.frame, from: previous, to: point) {
        guard stroke.visit(id), let current = registry.entries[id], current.token == entry.token else { continue }
        if current.selected != desired { current.toggle() }
      }
      previous = point
    }
  }
}
