import Foundation
import CoreGraphics
import Observation

// Parents observe only the zoom-mode boundary. Per-frame scale/pan changes are
// observed by the image modifier, never by the viewer's whole photo-page list.
@MainActor @Observable final class PhotoViewerZoomController {
  private(set) var value = PhotoViewerZoom()
  private(set) var isZoomed = false
  private func publishMode() {
    let next = value.scale > 1
    if next != isZoomed { isZoomed = next }
  }
  func change(_ magnification: CGFloat) { value.change(magnification); publishMode() }
  func settle(_ magnification: CGFloat) { value.settle(magnification); publishMode() }
  func toggle() { value.toggle(); publishMode() }
  func toggle(at point: CGPoint, viewport: CGSize, content: CGSize? = nil) {
    value.toggle(at: point, viewport: viewport, content: content); publishMode()
  }
  func drag(_ translation: CGSize, viewport: CGSize, content: CGSize? = nil) {
    value.drag(translation, viewport: viewport, content: content)
  }
  func settleDrag(_ translation: CGSize, viewport: CGSize, content: CGSize? = nil) {
    value.settleDrag(translation, viewport: viewport, content: content)
  }
  func constrain(to viewport: CGSize, content: CGSize? = nil) { value.constrain(to: viewport, content: content) }
  func reset() { value.reset(); publishMode() }
}

struct PhotoViewerVerticalGesture {
  enum Action { case dismiss, details }
  private enum Axis { case horizontal, vertical }
  private var axis: Axis?
  private(set) var offset: CGFloat = 0
  mutating func update(_ value: CGSize, enabled: Bool) {
    guard enabled, value.width.isFinite, value.height.isFinite else { reset(); return }
    if axis == nil, max(abs(value.width), abs(value.height)) >= 12 {
      if abs(value.height) > abs(value.width) * 1.25 { axis = .vertical }
      else if abs(value.width) > abs(value.height) * 1.25 { axis = .horizontal }
    }
    offset = axis == .vertical ? value.height : 0
  }
  func action(predicted: CGSize, height: CGFloat) -> Action? {
    guard axis == .vertical, abs(offset) >= 32, height.isFinite, height > 0 else { return nil }
    let threshold = min(160, max(80, height * 0.18))
    let prediction = predicted.height.isFinite && predicted.height * offset > 0 ? predicted.height : offset
    guard abs(offset) >= threshold || abs(prediction) >= threshold else { return nil }
    return offset > 0 ? .dismiss : .details
  }
  mutating func reset() { axis = nil; offset = 0 }
}

struct PhotoGridSelectionStroke {
  private(set) var selected = true
  private var visited: Set<String> = []
  static func canBegin(velocity: CGPoint) -> Bool {
    velocity.x.isFinite && velocity.y.isFinite && abs(velocity.x) >= 8 && abs(velocity.x) > abs(velocity.y) * 1.25
  }
  mutating func begin(selected: Bool) { self.selected = !selected; visited = [] }
  mutating func visit(_ id: String) -> Bool { visited.insert(id).inserted }
  mutating func reset() { visited = [] }
  static func frame(_ frame: CGRect, measuredOffset: CGFloat, currentOffset: CGFloat) -> CGRect {
    guard measuredOffset.isFinite, currentOffset.isFinite else { return .zero }
    return frame.offsetBy(dx: 0, dy: measuredOffset - currentOffset)
  }
  static func intersects(_ rect: CGRect, from start: CGPoint, to end: CGPoint) -> Bool {
    guard !rect.isEmpty, start.x.isFinite, start.y.isFinite, end.x.isFinite, end.y.isFinite else { return false }
    if rect.contains(start) || rect.contains(end) { return true }
    var low: CGFloat = 0, high: CGFloat = 1
    for (origin, delta, minimum, maximum) in [(start.x,end.x-start.x,rect.minX,rect.maxX),
      (start.y,end.y-start.y,rect.minY,rect.maxY)] {
      if delta == 0 { if origin < minimum || origin > maximum { return false }; continue }
      let first = (minimum-origin)/delta, second = (maximum-origin)/delta
      low = max(low,min(first,second)); high = min(high,max(first,second))
      if low > high { return false }
    }
    return true
  }
}

enum PhotoGridEdgeScroll {
  static func velocity(at point: CGPoint, viewport: CGRect) -> CGFloat {
    guard point.x.isFinite, point.y.isFinite, viewport.width.isFinite, viewport.height.isFinite,
      viewport.height > 0, viewport.width > 0, point.x >= viewport.minX, point.x <= viewport.maxX,
      point.y >= viewport.minY, point.y <= viewport.maxY else { return 0 }
    let zone = min(72, max(24, viewport.height * 0.12), viewport.height / 2)
    if point.y < viewport.minY + zone { return -480 * pow((viewport.minY + zone - point.y) / zone, 2) }
    if point.y > viewport.maxY - zone { return 480 * pow((point.y - viewport.maxY + zone) / zone, 2) }
    return 0
  }
  static func offset(current: CGFloat, velocity: CGFloat, elapsed: Double, contentHeight: CGFloat,
    viewportHeight: CGFloat, topInset: CGFloat, bottomInset: CGFloat) -> CGFloat {
    guard current.isFinite, velocity.isFinite, elapsed.isFinite, elapsed > 0,
      contentHeight.isFinite, viewportHeight.isFinite, viewportHeight > 0,
      topInset.isFinite, bottomInset.isFinite else { return current }
    let minimum = -max(0, topInset), maximum = max(minimum, contentHeight - viewportHeight + max(0, bottomInset))
    return min(maximum, max(minimum, current + velocity * CGFloat(min(elapsed, 1.0 / 15))))
  }
}
