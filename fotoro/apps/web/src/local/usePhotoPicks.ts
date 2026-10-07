import {useCallback, useEffect, useMemo, useState} from "react";
import {analyzePixels, PickAnalyzer, type PhotoRecommendations} from "./auto-picks";
import {LocalResources, type LocalPhoto} from "./resources";
import {availablePhotoSelection} from "./selection";

export async function readPickSignals(photo: LocalPhoto, resources: LocalResources, signal?: AbortSignal) {
  const check = () => {
    signal?.throwIfAborted();
    if (photo.current?.() === false) throw new DOMException("Preview source changed", "AbortError");
  };
  check();
  const thumbnail = await resources.load(photo, "thumbnail", signal);
  check();
  const image = await createImageBitmap(thumbnail.blob);
  const canvas = document.createElement("canvas");
  try {
    check();
    const ratio = Math.min(1, 64 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * ratio)); canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Preview measurements unavailable.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {...analyzePixels(context.getImageData(0, 0, canvas.width, canvas.height)), width: thumbnail.width, height: thumbnail.height};
  } finally {image.close(); canvas.width = 0; canvas.height = 0;}
}

export function usePhotoPicks(photos: LocalPhoto[], resources: LocalResources, enabled: boolean, sourceGeneration = 0) {
  const [analyzer] = useState(() => new PickAnalyzer());
  const [recommendations, setRecommendations] = useState<PhotoRecommendations>();
  const [busy, setBusy] = useState(false), [done, setDone] = useState(0);
  const [selection, setSelection] = useState(new Set<string>());
  const clear = useCallback(() => {
    analyzer.clear(); setRecommendations(undefined); setSelection(new Set()); setBusy(false); setDone(0);
  }, [analyzer]);
  useEffect(() => {
    analyzer.clear();
    return () => analyzer.clear();
  }, [analyzer, resources, sourceGeneration]);
  useEffect(() => {
    let alive = true;
    if (!photos.length) {clear(); return;}
    setRecommendations(undefined); setBusy(enabled); setDone(0);
    if (enabled) void analyzer.run(photos, (photo, signal) => readPickSignals(photo, resources, signal), completed => {if (alive) setDone(completed);})
      .then(result => {if (alive && result) {setRecommendations(result); setBusy(false);}});
    return () => {alive = false; analyzer.cancel();};
  }, [photos, resources, analyzer, enabled, clear, sourceGeneration]);
  const ids = useMemo(() => availablePhotoSelection(selection, photos), [photos, selection]);
  useEffect(() => {setSelection(current => availablePhotoSelection(current, photos));}, [photos, selection]);
  const choose = (id: string, checked: boolean) => setSelection(current => {
    const next = new Set(current);
    checked ? next.add(id) : next.delete(id);
    return next;
  });
  const suggested = () => setSelection(new Set(recommendations?.ids));
  const chooseAll = () => setSelection(new Set(photos.map(photo => photo.id)));
  const clearSelection = () => setSelection(new Set());
  const replaceSelection = (ids: ReadonlySet<string>) => setSelection(availablePhotoSelection(new Set(ids), photos));
  return {ids, recommendations, busy, done, clear, clearSelection, replaceSelection, choose, suggested, chooseAll};
}
