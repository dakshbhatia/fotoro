export function subscribeSavedRefresh(windowTarget: EventTarget, documentTarget: EventTarget & {visibilityState: string}, refresh: () => void) {
  const update = () => {if (documentTarget.visibilityState === "visible") refresh();};
  windowTarget.addEventListener("online", update);
  windowTarget.addEventListener("focus", update);
  documentTarget.addEventListener("visibilitychange", update);
  return () => {
    windowTarget.removeEventListener("online", update);
    windowTarget.removeEventListener("focus", update);
    documentTarget.removeEventListener("visibilitychange", update);
  };
}
