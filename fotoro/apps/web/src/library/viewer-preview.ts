import {photoBytes, type Photo} from "./catalog";
import {mediaURL} from "../vault/vault";

// Annotation-only catalog updates keep the same pixels; replacements and access scopes do not.
export function viewerPreviewSource(photo: Photo) {
  const representation = photo.manifest.representations.find(value => value.binding.kind === "preview")
    ?? photo.manifest.representations.find(value => value.binding.kind === "original");
  const metadata = photo.manifest.metadataRepresentation;
  return JSON.stringify([photo.manifest.ownerAccountId, photo.manifest.photoId, photo.metadata.originalSha256,
    photo.grantId, representation?.binding.representationId, representation?.objectId, representation?.ciphertextSha256,
    metadata?.binding.representationId, metadata?.objectId, metadata?.ciphertextSha256]);
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
  createURL = mediaURL,
): Promise<string | undefined> {
  if (signal.aborted || !current()) return;
  const bytes = await read(photo, "preview", signal);
  try {
    if (signal.aborted || !current()) return;
    return createURL("viewer-preview:" + viewerPreviewSource(photo), bytes, "image/jpeg", 1600 * 1600 * 4);
  } finally {bytes.fill(0);}
}
