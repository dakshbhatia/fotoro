import type {PhotoLocationV1} from "@fotoro/contracts";
import {placeMapURL, placeSource, placeTitle, validPlace} from "./places";

export function PhotoLocation({location}: {location?: PhotoLocationV1}) {
  if (!validPlace(location)) return null;
  return <div className="photo-location">
    <h3>Place</h3>
    <a href={placeMapURL(location)} target="_blank" rel="noopener noreferrer">{location.name?.trim() ? placeTitle(location) : "View on map"} ↗</a>
    <details><summary>Location details</summary>
      <p>{location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}</p>
      <p className="hint">{placeSource(location)}</p>
      {location.accuracyMeters !== undefined && <p className="hint">Accuracy: about {Math.round(location.accuracyMeters)} m</p>}
    </details>
  </div>;
}
