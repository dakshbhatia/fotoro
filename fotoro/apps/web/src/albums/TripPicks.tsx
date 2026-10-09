import {useLayoutEffect, useMemo, type ReactNode} from "react";
import type {Photo} from "../library/catalog";
import {useFindBestShots} from "../local/useFindBestShots";
import type {AlbumAccess} from "./service";
import {TRIP_PICK_LIMIT, tripPickPhotos} from "./trip-picks";

export function TripPicks({access, photos, hasMore, onClose, renderPhoto}: {
  access: AlbumAccess; photos: readonly Photo[]; hasMore: boolean; onClose: () => void;
  renderPhoto: (photo: Photo) => ReactNode;
}) {
  const candidates = useMemo(() => tripPickPhotos(photos, access), [photos, access]);
  const scope = useMemo(() => JSON.stringify(candidates.map(photo => photo.id)), [candidates]);
  const review = useFindBestShots(candidates, scope, access, () => access.current() && !access.signal.aborted);
  useLayoutEffect(() => {
    if (candidates.length && !review.active && access.current() && !access.signal.aborted) review.toggle();
    // Start once for each current photo scope. Closing unmounts this review and
    // lets the hook cancel its workers and release previews.
  }, [scope, access]);
  const suggested = review.recommendations;
  return <section id="album-trip-picks" aria-label="Trip best shots" className="trip-picks">
    <div className="trip-picks-heading"><h3>Best shots</h3><button aria-label="Close best shots" onClick={onClose}>{review.busy ? "Cancel" : "Close"}</button></div>
    {!candidates.length && <p className="hint" role="status">No photos to review.</p>}
    {review.active && <>
      <p className="hint" role="status">{review.busy ? `Reviewing ${review.done} of ${candidates.length} photos…` : `${suggested?.ids.size ?? 0} suggested photos`}
        {suggested?.unassessed ? ` · ${suggested.unassessed} previews unavailable` : ""}
      </p>
      {(hasMore || photos.length > TRIP_PICK_LIMIT) && <p className="hint">{hasMore ? "Trip still loading. " : ""}Reviews up to {TRIP_PICK_LIMIT} matching photos.</p>}
      {suggested && <div className="album-grid">{photos.filter(photo => suggested.ids.has(photo.manifest.photoId)).map(photo => <div className="tile" key={photo.manifest.photoId}>
        {renderPhoto(photo)}
        <p className="hint">{suggested.reasons.get(photo.manifest.photoId)?.join(" · ")}</p>
      </div>)}</div>}
    </>}
  </section>;
}
