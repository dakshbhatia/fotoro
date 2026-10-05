import type {PhotoLocationV1} from "@fotoro/contracts";
import {placeMapURL, placeSource, placeTitle, validPlace} from "./places";

export function PhotoLocation({location}: {location?: PhotoLocationV1}) {
  if (!validPlace(location)) return null;
  return <div className="photo-location">
    <a href={placeMapURL(location)} target="_blank" rel="noopener noreferrer">{placeTitle(location)} ↗</a>
    <p className="hint">{placeSource(location)}</p>
  </div>;
}
