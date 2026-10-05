import type {PhotoRecommendations} from "./auto-picks";
import type {LocalPhoto} from "./resources";

export function selectionCandidates(photos: readonly LocalPhoto[], recommendations: PhotoRecommendations) {
  return photos.filter(photo => recommendations.ids.has(photo.id) && photo.current?.() !== false);
}

export function FindBestShots({total, review, showCount = false, onSelect, disabled = false}: {total: number; showCount?: boolean; onSelect?: () => void; disabled?: boolean; review: {
  active: boolean; busy: boolean; done: number; recommendations?: PhotoRecommendations; toggle: () => void;
}}) {
  const unavailable = review.recommendations?.unassessed ?? 0;
  return <section className="find-best-shots" aria-label="Find review">
    <button aria-pressed={review.active} disabled={!total && !review.active} onClick={review.toggle}>{review.active ? "All matches" : "Best shots"}</button>
    {onSelect && review.active && !review.busy && !!review.recommendations?.ids.size && <button disabled={disabled} onClick={onSelect}>Select best shots</button>}
    {(review.active || showCount) && <p role="status">{review.active ? review.busy ? `Choosing best shots… ${review.done} of ${total}`
      : `${review.recommendations?.ids.size ?? 0} of ${total} matches${unavailable ? ` · ${unavailable} ${unavailable === 1 ? "preview" : "previews"} unavailable` : ""}`
      : `${total} ${total === 1 ? "match" : "matches"}`}</p>}
  </section>;
}
