import type {LocalPhoto} from "./resources";
import type {SearchResult} from "./search";
import {visualSearchFeedback, visualSearchProgress} from "./LocalSearch";
import {searchCoverage} from "./search-coverage";

export function SearchCoverage({photos, scopeLabel, textEnabled, result, onReviewSettings}: {
  photos: readonly LocalPhoto[];
  scopeLabel: string;
  textEnabled: boolean;
  result?: SearchResult;
  onReviewSettings: () => void;
}) {
  const coverage = searchCoverage(photos);
  const visualStatus = result ? visualSearchProgress(result) ?? visualSearchFeedback(result) : undefined;
  return <details className="hint search-coverage">
    <summary>Search coverage · {coverage.total} loaded {coverage.total === 1 ? "photo" : "photos"}</summary>
    <p>{scopeLabel}. Counts cover loaded photos in this scope.</p>
    <p>Photo text: {coverage.textChecked} checked · {coverage.textFound} with text found
      {coverage.textUnchecked > 0 ? ` · ${coverage.textUnchecked} not checked` : ""}
      {coverage.textUnavailable > 0 ? ` · ${coverage.textUnavailable} unavailable or failed` : ""}.
      {!textEnabled ? " Reading new photo text is off." : " Unchecked photos are not necessarily queued."}</p>
    <p>Visual labels: {coverage.visualLabels} of {coverage.total} photos have searchable labels.
      {" "}Visual similarity is checked when you search; this count does not measure its coverage.</p>
    {visualStatus && <p role="status">{visualStatus}</p>}
    <button className="text-button" onClick={onReviewSettings}>Search settings</button>
  </details>;
}
