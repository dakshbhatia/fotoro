import type {PhotoRecommendations} from "./auto-picks";

export function FindBestShots({total, review, showCount = false}: {total: number; showCount?: boolean; review: {
  active: boolean; busy: boolean; done: number; recommendations?: PhotoRecommendations; toggle: () => void;
}}) {
  const unavailable = review.recommendations?.unassessed ?? 0;
  return <section className="find-best-shots" aria-label="Find review">
    <button aria-pressed={review.active} disabled={!total && !review.active} onClick={review.toggle}>{review.active ? "All matches" : "Best shots"}</button>
    {(review.active || showCount) && <p role="status">{review.active ? review.busy ? `Choosing best shots… ${review.done} of ${total}`
      : `${review.recommendations?.ids.size ?? 0} of ${total} matches${unavailable ? ` · ${unavailable} ${unavailable === 1 ? "preview" : "previews"} unavailable` : ""}`
      : `${total} ${total === 1 ? "match" : "matches"}`}</p>}
  </section>;
}
