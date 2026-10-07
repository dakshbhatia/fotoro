import {photoBytes, type Photo} from "./catalog";
import {leaseSavedRaster, savedRasterSource} from "./saved-raster";

// Annotation-only catalog updates keep the same pixels; replacements and access scopes do not.
export function viewerPreviewSource(photo: Photo) {
  return savedRasterSource(photo, "preview");
}

export interface ViewerPreview {source: string; state: "loading" | "ready" | "failed"; url?: string;}
export function failedViewerPreview(
  preview: ViewerPreview | undefined,
  source: string,
  url: string | undefined,
): ViewerPreview | undefined {
  return preview?.source === source && preview.state === "ready" && preview.url === url
    ? {...preview, state: "failed", url: undefined} : preview;
}

export async function readViewerPreview(
  photo: Photo,
  signal: AbortSignal,
  current: () => boolean,
  read = photoBytes,
  createURL?: Parameters<typeof leaseSavedRaster>[5],
): Promise<string | undefined> {
  return leaseSavedRaster(photo, "preview", signal, current, read, createURL);
}
