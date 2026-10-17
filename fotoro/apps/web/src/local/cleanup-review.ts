import {isPhotoScreenshot, isPhotoTrashed} from "@fotoro/contracts/organization";
import type {LocalPhoto} from "./resources";

export const CLEANUP_BATCH_SIZE = 200;
export function cleanupSourceCurrent(initial: LocalPhoto, latest: LocalPhoto | undefined): latest is LocalPhoto {
  return !!latest && initial.current?.() !== false && latest.current?.() !== false && !isPhotoTrashed(latest) &&
    latest.previewAvailable !== false && latest.digest === initial.digest && latest.file === initial.file &&
    latest.preview === initial.preview && latest.previewLoader === initial.previewLoader &&
    latest.width === initial.width && latest.height === initial.height;
}
export function cleanupReviewPhotos(photos: readonly LocalPhoto[]) {
  return [...new Map(photos.filter(photo => photo.current?.() !== false && !isPhotoTrashed(photo)).map(photo => [photo.id, photo])).values()];
}

export interface ScreenshotReviewGroup {key: string; title: string; photos: LocalPhoto[]}
// Group only known screenshots, using literal supplied tags or current readable
// OCR. These are review aids, never a guess about screenshot status or value.
export function screenshotReviewGroups(photos: readonly LocalPhoto[]): ScreenshotReviewGroup[] {
  const groups = new Map<string, ScreenshotReviewGroup>();
  for (const photo of cleanupReviewPhotos(photos)) {
    if (!isPhotoScreenshot(photo)) continue;
    const tag = photo.labels?.find(label => label.trim().length > 0 && label.trim().length <= 80)?.trim();
    const ocr = photo.ocr;
    const text = ocr?.status === "complete" && ocr.photoID === photo.id && ocr.revision === (photo.digest ?? photo.id) &&
      ["vision-text-v1", "tesseract.js-7.0.0/eng-1.0.0/lstm-orientation-v2"].includes(ocr.processor) &&
      Number.isFinite(ocr.confidence) && ocr.confidence >= .8 && ocr.confidence <= 1
      ? ocr.text.slice(0, 8192).split(/[\r\n\u2028\u2029]/u).map(line => line.normalize("NFC").trim().replace(/\s+/gu, " "))
        .find(line => line.length >= 4 && line.length <= 80 && /[\p{L}\p{N}]/u.test(line) && !/\p{C}/u.test(line)) : undefined;
    const title = tag ? `Tag: ${tag}` : text ? `Text: ${text}` : "Without a readable text group";
    const key = tag ? `tag:${tag.normalize("NFC").toLocaleLowerCase("en")}` : text ? `text:${text.toLocaleLowerCase("en")}` : "ungrouped";
    const group = groups.get(key);
    if (group) group.photos.push(photo);
    else groups.set(key, {key, title, photos: [photo]});
  }
  return [...groups.values()];
}
