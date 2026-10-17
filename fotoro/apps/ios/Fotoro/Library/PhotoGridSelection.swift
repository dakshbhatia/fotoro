import SwiftUI
import UIKit

struct PhotoGridSelectionContext: Equatable {
  let photos: UUID
  var account: String? = nil
  var vault: UUID? = nil
  var catalog: ObjectIdentifier? = nil
  var origin: String? = nil
  var presentation = ""
}

// Visible tile geometry is deliberately unobserved: scrolling must not publish
// the whole grid merely to support a selection gesture that is not running.
@MainActor final class PhotoGridSelectionRegistry {
  struct Entry {
    let token: UUID
    let frame: CGRect
    let offsetY: CGFloat
    let selected: Bool
    let toggle: () -> Void
  }
  var entries: [String: Entry] = [:]
  var scrollOffset: () -> CGFloat = { 0 }
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
  @State private var measuredOffsetY: CGFloat = 0
  @State private var visible = false
  func body(content: Content) -> some View {
    content.onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0; measuredOffsetY = registry?.scrollOffset() ?? 0; publish() }
      .onScrollVisibilityChange(threshold: 0.1) { visible = $0; publish() }
      .onChange(of: selected) { publish() }
      .onChange(of: id) { old, _ in remove(old); publish() }
      .onDisappear { remove(id) }
  }
  private func publish() {
    guard visible, !frame.isEmpty else { remove(id); return }
    registry?.entries[id] = .init(token: token, frame: frame, offsetY: measuredOffsetY, selected: selected, toggle: toggle)
  }
  private func remove(_ key: String) {
    if registry?.entries[key]?.token == token { registry?.entries[key] = nil }
  }
}

// A native recognizer decides direction before beginning. Vertical drags remain
// owned by UIScrollView; only horizontal drags in Select mode paint selection.
struct PhotoGridSelectionGesture: UIViewRepresentable {
  let registry: PhotoGridSelectionRegistry
  let context: PhotoGridSelectionContext
  let enabled: Bool
  func makeUIView(context: Context) -> Attachment { Attachment(coordinator: context.coordinator) }
  func updateUIView(_ view: Attachment, context: Context) {
    context.coordinator.registry = registry
    if context.coordinator.context != self.context { context.coordinator.cancel() }
    context.coordinator.context = self.context
    context.coordinator.enabled = enabled
    if !enabled { context.coordinator.cancel() }
    view.attach()
  }
  static func dismantleUIView(_ view: Attachment, coordinator: Coordinator) { coordinator.detach() }
  func makeCoordinator() -> Coordinator { Coordinator(registry: registry, enabled: enabled, context: context) }
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
    var context: PhotoGridSelectionContext
    private weak var scroll: UIScrollView?
    private var recognizer: UIPanGestureRecognizer?
    private var stroke = PhotoGridSelectionStroke()
    private var captured: [String: UUID] = [:]
    private var previous: CGPoint = .zero
    private var painting = false
    private var displayLink: CADisplayLink?
    private var lastTimestamp: CFTimeInterval?
    // The display link retains its target. This proxy must not retain its owner.
    private final class Tick: NSObject {
      weak var owner: Coordinator?
      init(_ owner: Coordinator) { self.owner = owner }
      @objc func fire(_ link: CADisplayLink) { if let owner { owner.scrollTick(link) } else { link.invalidate() } }
    }
    init(registry: PhotoGridSelectionRegistry, enabled: Bool, context: PhotoGridSelectionContext) { self.registry = registry; self.enabled = enabled; self.context = context }
    func attach(_ scroll: UIScrollView) {
      guard self.scroll !== scroll else { return }
      detach(); self.scroll = scroll
      registry.scrollOffset = { [weak scroll] in scroll?.contentOffset.y ?? 0 }
      let pan = UIPanGestureRecognizer(target: self, action: #selector(moved(_:)))
      pan.minimumNumberOfTouches = 1; pan.maximumNumberOfTouches = 1
      pan.delegate = self; scroll.addGestureRecognizer(pan)
      scroll.panGestureRecognizer.require(toFail: pan)
      recognizer = pan
    }
    func detach() { if let recognizer { scroll?.removeGestureRecognizer(recognizer) }; recognizer = nil; scroll = nil; cancel() }
    func cancel() { painting = false; stopScrolling(); stroke.reset(); captured = [:] }
    private func stopScrolling() { displayLink?.invalidate(); displayLink = nil; lastTimestamp = nil }
    private func viewport(_ scroll: UIScrollView) -> CGRect {
      let insets = scroll.adjustedContentInset
      return scroll.convert(scroll.bounds.inset(by: UIEdgeInsets(top: max(0, insets.top), left: 0, bottom: max(0, insets.bottom), right: 0)), to: nil)
    }
    private func updateScrolling(at point: CGPoint) {
      guard painting, let scroll, PhotoGridEdgeScroll.velocity(at: point, viewport: viewport(scroll)) != 0 else { stopScrolling(); return }
      if displayLink == nil {
        let link = CADisplayLink(target: Tick(self), selector: #selector(Tick.fire(_:)))
        link.preferredFramesPerSecond = 60
        link.add(to: .main, forMode: .common)
        displayLink = link
      }
    }
    private func scrollTick(_ link: CADisplayLink) {
      guard painting, enabled, !UIAccessibility.isVoiceOverRunning, UIApplication.shared.applicationState == .active,
        let scroll, scroll.window != nil, scroll.isScrollEnabled, let pan = recognizer,
        pan.numberOfTouches == 1, pan.state == .began || pan.state == .changed else { cancel(); return }
      let point = pan.location(in: nil), velocity = PhotoGridEdgeScroll.velocity(at: point, viewport: viewport(scroll))
      guard velocity != 0 else { stopScrolling(); return }
      let elapsed = lastTimestamp.map { link.timestamp - $0 } ?? link.duration
      lastTimestamp = link.timestamp
      let target = PhotoGridEdgeScroll.offset(current: scroll.contentOffset.y, velocity: velocity, elapsed: elapsed,
        contentHeight: scroll.contentSize.height, viewportHeight: scroll.bounds.height,
        topInset: scroll.adjustedContentInset.top, bottomInset: scroll.adjustedContentInset.bottom)
      // Paint at the current geometry before moving content; offset-bound frames
      // remain valid until SwiftUI publishes its next visible-tile geometry.
      paint(to: point, admitNewTiles: true)
      if target != scroll.contentOffset.y { scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: target), animated: false) }
    }
    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
      guard enabled, !UIAccessibility.isVoiceOverRunning, let pan = recognizer as? UIPanGestureRecognizer else { return false }
      let velocity = pan.velocity(in: scroll)
      guard PhotoGridSelectionStroke.canBegin(velocity: velocity) else { return false }
      let point = pan.location(in: nil)
      let translation = pan.translation(in: nil)
      let start = CGPoint(x: point.x - translation.x, y: point.y - translation.y)
      return registry.entries.values.contains { frame($0).contains(start) }
    }
    @objc private func moved(_ pan: UIPanGestureRecognizer) {
      guard enabled, pan.numberOfTouches <= 1, !UIAccessibility.isVoiceOverRunning else { cancel(); return }
      let point = pan.location(in: nil)
      switch pan.state {
      case .began:
        captured = registry.entries.mapValues(\.token)
        let translation = pan.translation(in: nil)
        previous = CGPoint(x: point.x - translation.x, y: point.y - translation.y)
        guard let entry = registry.entries.first(where: { frame($0.value).contains(previous) }) else { cancel(); return }
        stroke.begin(selected: entry.value.selected)
        painting = true
        paint(to: point)
        updateScrolling(at: point)
      case .changed: if painting { paint(to: point); updateScrolling(at: point) }
      case .ended: if painting { paint(to: point) }; cancel()
      default: cancel()
      }
    }
    private func paint(to point: CGPoint, admitNewTiles: Bool = false) {
      let desired = stroke.selected
      if admitNewTiles { for (id, entry) in registry.entries where captured[id] == nil { captured[id] = entry.token } }
      // Work stays proportional to visible tiles even after a long edge scroll.
      for (id, current) in registry.entries {
        guard current.token == captured[id] else { continue }
        guard PhotoGridSelectionStroke.intersects(frame(current), from: previous, to: point), stroke.visit(id) else { continue }
        if current.selected != desired { current.toggle() }
      }
      previous = point
    }
    private func frame(_ entry: PhotoGridSelectionRegistry.Entry) -> CGRect {
      PhotoGridSelectionStroke.frame(entry.frame, measuredOffset: entry.offsetY, currentOffset: scroll?.contentOffset.y ?? entry.offsetY)
    }
  }
}
