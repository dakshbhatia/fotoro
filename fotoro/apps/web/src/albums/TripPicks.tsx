import {useMemo, type ReactNode} from "react";
import type {Photo} from "../library/catalog";
import {useFindBestShots} from "../local/useFindBestShots";
import type {AlbumAccess} from "./service";
import {TRIP_PICK_LIMIT, tripPickPhotos} from "./trip-picks";

export function TripPicks({access, photos, hasMore, disabled, renderPhoto}: {
  access: AlbumAccess; photos: readonly Photo[]; hasMore: boolean; disabled: boolean;
  renderPhoto: (photo: Photo) => ReactNode;
}) {
  const candidates = useMemo(() => tripPickPhotos(photos, access), [photos, access]);
  const scope = useMemo(() => JSON.stringify(candidates.map(photo => photo.id)), [candidates]);
  const review = useFindBestShots(candidates, scope, access, () => access.current() && !access.signal.aborted);
  const suggested = review.recommendations;
  return <section aria-label="Trip best shots" className="trip-picks">
    <button disabled={!review.active && (disabled || !candidates.length)} onClick={review.toggle} aria-expanded={review.active}>
      {review.active ? "Close best shots" : "Find best shots"}
    </button>
    {review.active && <>
      <p className="hint" role="status">{review.busy ? `Reviewing ${review.done} of ${candidates.length} photos…` : `${suggested?.ids.size ?? 0} suggested photos`}
        {suggested?.unassessed ? ` · ${suggested.unassessed} previews unavailable` : ""}
      </p>
      <p className="hint">Reviews up to {TRIP_PICK_LIMIT} matching unique photos using small previews. {hasMore ? "Load more trip photos to expand coverage. " : ""}All originals stay in your trip.</p>
      {suggested && <div className="album-grid">{photos.filter(photo => suggested.ids.has(photo.manifest.photoId)).map(photo => <div className="tile" key={photo.manifest.photoId}>
        {renderPhoto(photo)}
        <p className="hint">{suggested.reasons.get(photo.manifest.photoId)?.join(" · ")}</p>
      </div>)}</div>}
    </>}
  </section>;
}
