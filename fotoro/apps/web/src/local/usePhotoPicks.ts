import {useCallback, useEffect, useMemo, useState} from "react";
import {analyzePixels, PickAnalyzer, type PhotoRecommendations} from "./auto-picks";
import {LocalResources, type LocalPhoto} from "./resources";

async function readSignals(photo: LocalPhoto, resources: LocalResources) {
  const thumbnail = await resources.load(photo, "thumbnail");
  const image = await createImageBitmap(thumbnail.blob);
  const canvas = document.createElement("canvas");
  try {
    const ratio = Math.min(1, 64 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * ratio)); canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Preview measurements unavailable.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return analyzePixels(context.getImageData(0, 0, canvas.width, canvas.height));
  } finally {image.close(); canvas.width = 0; canvas.height = 0;}
}

export function usePhotoPicks(photos: LocalPhoto[], resources: LocalResources, enabled: boolean) {
  const [analyzer] = useState(() => new PickAnalyzer());
  const [recommendations, setRecommendations] = useState<PhotoRecommendations>();
  const [busy, setBusy] = useState(false), [done, setDone] = useState(0);
  const [overrides, setOverrides] = useState(new Map<string, boolean>()), [all, setAll] = useState(false);
  const clear = useCallback(() => {
    analyzer.clear(); setRecommendations(undefined); setOverrides(new Map()); setAll(false); setBusy(false); setDone(0);
  }, [analyzer]);
  useEffect(() => {
    let alive = true;
    if (!photos.length) {clear(); return;}
    setBusy(true); setDone(0);
    if (enabled) void analyzer.run(photos, photo => readSignals(photo, resources), completed => {if (alive) setDone(completed);})
      .then(result => {if (alive && result) {setRecommendations(result); setBusy(false);}});
    return () => {alive = false;};
  }, [photos, resources, analyzer, enabled, clear]);
  useEffect(() => () => analyzer.clear(), [analyzer]);
  const ids = useMemo(() => new Set(photos.filter(photo =>
    overrides.get(photo.id) ?? (all || recommendations?.ids.has(photo.id) || false)).map(photo => photo.id)), [photos, overrides, all, recommendations]);
  const choose = (id: string, checked: boolean) => setOverrides(current => new Map(current).set(id, checked));
  const suggested = () => {setAll(false); setOverrides(new Map());};
  const chooseAll = () => {setAll(true); setOverrides(new Map());};
  return {ids, recommendations, busy, done, clear, choose, suggested, chooseAll};
}
