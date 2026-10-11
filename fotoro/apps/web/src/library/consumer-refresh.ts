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

// Cached paging does not own Save status or drain uploads.
export async function readSavedBrowsePage(options: {
  signal: AbortSignal; current: () => boolean;
  read: () => Promise<{photos: import("./catalog").Photo[]; coverage: import("./catalog").CatalogCoverage}>;
  publish: (result: {photos: import("./catalog").Photo[]; coverage: import("./catalog").CatalogCoverage}) => void;
}) {
  const check = () => {
    options.signal.throwIfAborted();
    if (!options.current()) throw new DOMException("Saved browse changed", "AbortError");
  };
  check();
  const result = await options.read();
  let published = false;
  try {check(); options.publish(result); published = true;}
  finally {if (!published) for (const photo of result.photos) photo.metadataKey.fill(0);}
}
