import {useEffect, useRef, type TouchEvent} from "react";

export function viewerGesture(dx: number, dy: number, zoom: boolean): "next" | "previous" | "dismiss" | "details" | undefined {
  if (zoom) return;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) return dx < 0 ? "next" : "previous";
  if (Math.abs(dy) > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) return dy > 0 ? "dismiss" : "details";
}
export function viewerKeyboardAllowed(event: {defaultPrevented: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean}, editing: boolean, zoom: boolean) {
  return !editing && !zoom && !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export class ViewerTouchSession {
  private touch?: {x: number; y: number; id: number; identity: string; axis?: "horizontal" | "vertical"};
  start(x: number, y: number, id: number, identity: string) {this.touch = {x, y, id, identity};}
  cancel() {this.touch = undefined;}
  move(x: number, y: number) {
    const start = this.touch;
    if (!start || start.axis) return;
    const dx = Math.abs(x - start.x), dy = Math.abs(y - start.y);
    if (Math.max(dx, dy) < 12) return;
    if (dx > dy * 1.5) start.axis = "horizontal";
    else if (dy > dx * 1.5) start.axis = "vertical";
  }
  end(x: number, y: number, id: number, identity: string, disabled: boolean) {
    const start = this.touch;
    if (!start || disabled || start.id !== id || start.identity !== identity) {this.cancel(); return;}
    this.move(x, y); this.cancel();
    const gesture = viewerGesture(x - start.x, y - start.y, false);
    if ((gesture === "next" || gesture === "previous") && start.axis === "horizontal") return gesture;
    if ((gesture === "dismiss" || gesture === "details") && start.axis === "vertical") return gesture;
  }
}

export function useViewerGestures(options: {identity: string; source?: unknown; zoom: boolean; disabled?: boolean; onPrevious: () => void; onNext: () => void; onDismiss: () => void; onDetails: () => void}) {
  const session = useRef(new ViewerTouchSession()), latest = useRef(options);
  if (latest.current.identity !== options.identity || latest.current.source !== options.source || latest.current.zoom !== options.zoom || latest.current.disabled !== options.disabled) session.current.cancel();
  latest.current = options;
  useEffect(() => {session.current.cancel(); return () => session.current.cancel();}, [options.identity, options.source, options.zoom, options.disabled]);
  const cancel = () => session.current.cancel();
  return {
    onTouchStart(event: TouchEvent<HTMLDivElement>) {
      cancel();
      const current = latest.current;
      if (current.disabled || current.zoom || event.touches.length !== 1 || (event.target as HTMLElement).closest("button,input,textarea,select,a,video,[contenteditable]")) return;
      const point = event.touches[0];
      session.current.start(point.clientX, point.clientY, point.identifier, current.identity);
    },
    onTouchMove(event: TouchEvent<HTMLDivElement>) {
      if (event.touches.length !== 1) {cancel(); return;}
      session.current.move(event.touches[0].clientX, event.touches[0].clientY);
    },
    onTouchCancel: cancel,
    onTouchEnd(event: TouchEvent<HTMLDivElement>) {
      if (event.touches.length || event.changedTouches.length !== 1) {cancel(); return;}
      const current = latest.current, point = event.changedTouches[0];
      const gesture = session.current.end(point.clientX, point.clientY, point.identifier, current.identity, !!current.disabled || current.zoom);
      if (gesture === "next") current.onNext();
      if (gesture === "previous") current.onPrevious();
      if (gesture === "dismiss") current.onDismiss();
      if (gesture === "details") current.onDetails();
    },
  };
}
