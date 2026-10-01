import { useEffect, useRef, useState } from "react";
import { LocalOcrQueue, OCR_PROCESSOR, type OcrResult } from "./ocr";
import { imageDimensions, type LocalPhoto, LocalResources } from "./resources";
export type LocalOcrPhoto = LocalPhoto;
/** Queue on source changes, never on queries. Results are fenced against the latest permitted digest. */
export function useLocalOcr(photos: LocalOcrPhoto[], enabled: boolean, resources: LocalResources, sourceGeneration: number, onResult: (result: OcrResult) => void) {
  const latest = useRef({photos, enabled, sourceGeneration, onResult});
  latest.current = {photos, enabled, sourceGeneration, onResult};
  const queue = useRef<LocalOcrQueue | null>(null), scheduled = useRef(new Set<string>()), generation = useRef(0);
  const [progress, setProgress] = useState("");
  useEffect(() => {
    const token = ++generation.current;
    scheduled.current.clear();
    if (queue.current) void queue.current.cancel();
    setProgress("");
    if (!enabled) return;
    const worker = new LocalOcrQueue({onProgress: event => {
      if (generation.current === token && latest.current.enabled) setProgress(event.status);
    }});
    queue.current = worker;
    return () => {
      generation.current++;
      void worker.cancel();
      if (queue.current === worker) queue.current = null;
    };
  }, [enabled, sourceGeneration]);
  useEffect(() => {
    const worker = queue.current, token = generation.current;
    if (!enabled || !worker) return;
    for (const photo of photos) {
      const revision = photo.digest ?? photo.id, key = photo.id + ":" + revision;
      if (scheduled.current.has(key) || (photo.ocr?.status === "complete" && photo.ocr.processor === OCR_PROCESSOR && (!photo.ocr.revision || photo.ocr.revision === revision))) continue;
      scheduled.current.add(key);
      const current = () => generation.current === token && latest.current.enabled && latest.current.photos.some(p => p.id === photo.id && (p.digest ?? p.id) === revision);
      void worker.recognize(photo.id, revision, async () => {
        const value = await resources.load(photo, "preview");
        const dimensions = imageDimensions(new Uint8Array(await value.blob.slice(0, 256 * 1024).arrayBuffer()));
        if (!dimensions) throw new Error("Preview dimensions are unavailable.");
        return {blob: value.blob, ...dimensions};
      }, current).then(result => {
        if (result && current()) latest.current.onResult(result);
      }).finally(() => {
        if (current()) setProgress("");
      });
    }
  }, [photos, enabled, sourceGeneration, resources]);
  return progress;
}
