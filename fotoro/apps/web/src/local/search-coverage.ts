import {validatedVisualLabels} from "@fotoro/contracts/visual";
import {hasCurrentLocalOcr, OCR_PROCESSOR, ocrSourceIdentity} from "./ocr";
import type {LocalPhoto} from "./resources";

/** Evidence for the supplied loaded scope only; this never schedules work. */
export function searchCoverage(photos: readonly LocalPhoto[]) {
  let total = 0, textChecked = 0, textFound = 0, textUnchecked = 0, textUnavailable = 0, visualLabels = 0;
  const seen = new Set<string>();
  for (const photo of photos) {
    if (photo.current?.() === false || seen.has(photo.id)) continue;
    seen.add(photo.id);
    total++;
    const savedOcr = photo.ocr;
    const hasCurrentSavedOcr = photo.id.startsWith("saved:") && savedOcr?.processor === "vision-text-v1"
      && savedOcr.status === "complete" && savedOcr.photoID === photo.id
      && !!photo.digest && savedOcr.revision === photo.digest && typeof savedOcr.text === "string"
      && Number.isFinite(savedOcr.confidence) && savedOcr.confidence >= 0 && savedOcr.confidence <= 1;
    if (hasCurrentLocalOcr(photo) || hasCurrentSavedOcr) {
      textChecked++;
      if (photo.ocr!.text.trim()) textFound++;
    } else {
      const ocr = photo.ocr;
      const failed = ocr?.status === "failed" && ocr.processor === OCR_PROCESSOR
        && ocr.photoID === photo.id && ocr.revision === (photo.digest ?? photo.id);
      if (failed || photo.previewAvailable === false || !ocrSourceIdentity(photo)) textUnavailable++;
      else textUnchecked++;
    }
    const visual = photo.visual;
    if (visual?.status === "complete" && visual.photoID === photo.id && visual.revision === photo.digest
      && validatedVisualLabels(visual).length > 0) visualLabels++;
  }
  return {total, textChecked, textFound, textUnchecked, textUnavailable, visualLabels};
}
