import Foundation
import CoreGraphics
import Observation
private final class ObservationCounter: @unchecked Sendable { var count = 0 }

@main struct ViewerGestureHostTests {
  @MainActor static func main() {
    let viewport=CGSize(width:400,height:800), landscape=CGSize(width:1600,height:800)
    var zoom=PhotoViewerZoom()
    zoom.toggle(at:CGPoint(x:300,y:400),viewport:viewport,content:landscape)
    precondition(zoom.scale==2 && zoom.offset.width == -100,"Double-tap must preserve the tapped photo point")
    zoom.settleDrag(CGSize(width:900,height:900),viewport:viewport,content:landscape)
    precondition(zoom.offset==CGSize(width:200,height:0),"Letterboxed landscape cannot pan into empty vertical space")
    zoom.settle(0.5);zoom.constrain(to:viewport,content:landscape)
    precondition(zoom.scale==1 && zoom.offset == .zero)
    zoom.change(.infinity);precondition(zoom.scale==1,"Invalid magnification must not poison view state")
    zoom.change(.nan);precondition(zoom.scale==1)
    zoom.toggle();zoom.settleDrag(CGSize(width:CGFloat.infinity,height:CGFloat.nan),viewport:viewport)
    precondition(zoom.offset == .zero,"Invalid translations must not poison view state")
    print("PASS: anchored double tap, fitted image pan bounds, reset and invalid input")

    var gesture=PhotoViewerVerticalGesture()
    gesture.update(CGSize(width:45,height:10),enabled:true)
    gesture.update(CGSize(width:60,height:200),enabled:true)
    precondition(gesture.action(predicted:CGSize(width:60,height:400),height:800)==nil,"Horizontal paging cannot turn into dismissal")
    gesture.reset();gesture.update(CGSize(width:4,height:110),enabled:true)
    precondition(gesture.action(predicted:CGSize(width:4,height:220),height:800) == .dismiss)
    gesture.reset();gesture.update(CGSize(width:3,height:-120),enabled:true)
    precondition(gesture.action(predicted:CGSize(width:3,height:-260),height:800) == .details)
    gesture.reset();gesture.update(CGSize(width:3,height:20),enabled:true)
    precondition(gesture.action(predicted:CGSize(width:3,height:600),height:800)==nil,"Tiny movement cannot close a photo")
    gesture.reset();gesture.update(CGSize(width:3,height:200),enabled:false)
    precondition(gesture.offset==0 && gesture.action(predicted:CGSize(width:3,height:400),height:800)==nil)
    gesture.update(CGSize(width:0,height:100),enabled:true);gesture.update(.zero,enabled:false)
    precondition(gesture.offset==0,"Pinch/accessibility changes withdraw pending dismissals")
    gesture.reset();gesture.update(CGSize(width:0,height:70),enabled:true)
    precondition(gesture.action(predicted:CGSize(width:0,height:-300),height:800)==nil,"Reversing a short pull cancels rather than dismisses")
    gesture.reset();precondition(gesture.offset==0)
    print("PASS: direction lock, dismiss/info thresholds, tiny flick, reversal and cancellation")

    precondition(PhotoGridSelectionStroke.canBegin(velocity: CGPoint(x:100,y:20)))
    precondition(!PhotoGridSelectionStroke.canBegin(velocity: CGPoint(x:10,y:100)),"Vertical movement must stay with scrolling")
    precondition(!PhotoGridSelectionStroke.canBegin(velocity: CGPoint(x:CGFloat.nan,y:0)))
    var stroke=PhotoGridSelectionStroke();stroke.begin(selected:false)
    precondition(stroke.selected && stroke.visit("a") && !stroke.visit("a"),"A drag paints each tile once instead of toggling repeatedly")
    stroke.begin(selected:true);precondition(!stroke.selected && stroke.visit("a"),"Starting on selected photo paints deselection")
    let tile=CGRect(x:100,y:100,width:40,height:40)
    precondition(PhotoGridSelectionStroke.intersects(tile,from:CGPoint(x:0,y:120),to:CGPoint(x:200,y:120)),"Fast drags must include skipped-over tiles")
    precondition(!PhotoGridSelectionStroke.intersects(tile,from:CGPoint(x:0,y:50),to:CGPoint(x:200,y:50)))
    precondition(!PhotoGridSelectionStroke.intersects(tile,from:CGPoint(x:0,y:0),to:CGPoint(x:90,y:90)))
    precondition(PhotoGridSelectionStroke.intersects(tile,from:CGPoint(x:0,y:0),to:CGPoint(x:200,y:200)))
    precondition(!PhotoGridSelectionStroke.intersects(.zero,from:.zero,to:.zero))
    print("PASS: selection direction, idempotent painting/deselecting and fast path intersection")

    let controller=PhotoViewerZoomController(), mode=ObservationCounter(), image=ObservationCounter()
    withObservationTracking { _=controller.isZoomed } onChange: { mode.count += 1 }
    controller.toggle()
    precondition(mode.count==1 && controller.isZoomed,"The toolbar must update on entry to zoom")
    mode.count=0
    withObservationTracking { _=controller.isZoomed } onChange: { mode.count += 1 }
    withObservationTracking { _=controller.value.offset } onChange: { image.count += 1 }
    for n in 1...1000 { controller.drag(CGSize(width:n%80,height:n%100),viewport:viewport) }
    controller.change(1.4);controller.settle(1.4)
    precondition(mode.count==0 && image.count==1,"Per-frame pan/pinch must update the image without invalidating the viewer's page list")
    controller.reset();precondition(mode.count==1 && !controller.isZoomed)
    print("PASS: 1,000 drag samples invalidate image observation without publishing toolbar/page-list mode")
  }
}
