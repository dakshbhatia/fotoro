import type {PhotoNameAnalysis} from "@fotoro/contracts/organization";
import type {Photo} from "./catalog";
import type {SearchPhoto} from "../local/search";

export function localPhotoNameAnalysis(photo: Pick<SearchPhoto, "id" | "digest" | "ocr" | "visual" | "current">): PhotoNameAnalysis | undefined {
  if (photo.current?.() === false) return;
  const revision = photo.digest ?? photo.id, ocr = photo.ocr, visual = photo.visual;
  return {
    ocr: ocr?.status === "complete" && ocr.photoID === photo.id && ocr.revision === revision ? ocr : undefined,
    visual: visual?.status === "complete" && visual.photoID === photo.id && visual.revision === revision ? visual : undefined,
  };
}

export function savedPhotoNameAnalysis(photo: Pick<Photo, "manifest" | "metadata" | "annotations">): PhotoNameAnalysis | undefined {
  const value = photo.annotations;
  if (value?.photoId !== photo.manifest.photoId || value.originalSha256 !== photo.metadata.originalSha256) return;
  return {ocr: value.ocr, visual: value.visual};
}
