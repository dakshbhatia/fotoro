import {PickAnalyzer, type PhotoRecommendations, type PhotoSignals} from "./auto-picks";
import type {LocalPhoto} from "./resources";
import type {SearchResult} from "./search";

export function findMatchPhotos(photos: LocalPhoto[], result: SearchResult): LocalPhoto[] {
  const byID = new Map(photos.map(photo => [photo.id, photo]));
  return [...new Set(result.photoIds)].flatMap(id => {const photo = byID.get(id); return photo ? [photo] : [];});
}

export function shortlistSearchResult(result: SearchResult, recommendations?: PhotoRecommendations): SearchResult {
  const matches = new Set(result.photoIds);
  const photoIds = [...(recommendations?.ids ?? [])].filter(id => matches.has(id));
  return {...result, photoIds, photoId: result.photoId && photoIds.includes(result.photoId) ? result.photoId : photoIds[0],
    meaning: result.meaning ? {...result.meaning, photoIds} : undefined};
}

export async function runCurrentFindReview(analyzer: PickAnalyzer, photos: LocalPhoto[], load: (photo: LocalPhoto) => Promise<PhotoSignals>, current: () => boolean, progress?: (done: number, total: number) => void) {
  if (!current()) return;
  const recommendations = await analyzer.run(photos, async photo => {
    if (!current()) throw new DOMException("Review cancelled", "AbortError");
    const signal = await load(photo);
    if (!current()) throw new DOMException("Review cancelled", "AbortError");
    return signal;
  }, (done, total) => {if (current()) progress?.(done, total);});
  return current() ? recommendations : undefined;
}
