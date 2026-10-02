import {useEffect, useRef, type RefObject} from "react";

export function dialogControls(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(
    "button,input,textarea,select,a[href],summary,[tabindex]",
  )).filter(element => element.tabIndex >= 0 && !element.matches(":disabled,[hidden]") &&
    !element.closest("[inert]") && element.getClientRects().length > 0);
}

export function trapDialogTab(event: KeyboardEvent, panel: HTMLElement, active: Element | null) {
  const controls = dialogControls(panel), first = controls[0], last = controls.at(-1);
  if (!first || !last) {event.preventDefault(); panel.focus(); return;}
  if (event.shiftKey && (!active || !controls.includes(active as HTMLElement) || active === first)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (!active || !controls.includes(active as HTMLElement) || active === last)) {
    event.preventDefault(); first.focus();
  }
}

export function useDialogFocus<T extends HTMLElement>(panel: RefObject<T | null>, onClose: () => void, open = true) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = panel.current;
    if (!open || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.focus({preventScroll: true});
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !dialog.getClientRects().length) return;
      if (event.key === "Escape") {event.preventDefault(); close.current();}
      if (event.key === "Tab") trapDialogTab(event, dialog, document.activeElement);
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      requestAnimationFrame(() => {
        if (dialog.isConnected && dialog.getClientRects().length) return;
        if (previous?.isConnected && !previous.closest("[hidden],[inert]") && previous.getClientRects().length)
          previous.focus({preventScroll: true});
      });
    };
  }, [panel, open]);
}
