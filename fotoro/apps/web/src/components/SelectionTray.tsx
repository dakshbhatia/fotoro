import {useLayoutEffect, useRef, type HTMLAttributes} from "react";

// Reserve the tray's actual wrapped height on its own browsing surface.
export function SelectionTray({as: Tag = "div", ...props}: HTMLAttributes<HTMLElement> & {as?: "div" | "section"}) {
  const tray = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = tray.current, main = element?.closest("main");
    if (!element || !main) return;
    let height = -1;
    let active = true;
    const measure = () => {
      if (!active) return;
      const next = Math.ceil(element.getBoundingClientRect().height);
      if (next !== height) {height = next; main.style.setProperty("--selection-tray-height", `${next}px`);}
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    // Older browsers still update the initial clearance when the viewport changes.
    if (!observer) window.addEventListener("resize", measure);
    return () => {
      active = false;
      observer?.disconnect();
      if (!observer) window.removeEventListener("resize", measure);
      main.style.removeProperty("--selection-tray-height");
    };
  }, [Tag]);
  return <Tag {...props} ref={node => {tray.current = node;}} />;
}
