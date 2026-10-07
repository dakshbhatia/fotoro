import {photoBytes, type Photo} from "./catalog";

type RasterKind = "thumbnail" | "preview";
function rasterRepresentation(photo: Photo, kind: RasterKind) {
  return photo.manifest.representations.find(value => value.binding.kind === kind)
    ?? (kind === "thumbnail" ? photo.manifest.representations.find(value => value.binding.kind === "preview") : undefined);
}
// Original downloads require an explicit original action. A missing derivative
// must never use photoBytes' original fallback during browsing.
export function savedRasterSource(photo: Photo, kind: RasterKind) {
  const representation = rasterRepresentation(photo, kind), metadata = photo.manifest.metadataRepresentation;
  return JSON.stringify([photo.manifest.ownerAccountId, photo.manifest.photoId, photo.metadata.originalSha256,
    photo.grantId, representation?.binding.representationId, representation?.objectId, representation?.ciphertextSha256,
    metadata?.binding.representationId, metadata?.objectId, metadata?.ciphertextSha256]);
}
const createRasterURL = (_key: string, bytes: Uint8Array, type: string, _decodedBytes: number) =>
  URL.createObjectURL(new Blob([new Uint8Array(bytes)], {type}));
export async function leaseSavedRaster(photo: Photo, kind: RasterKind, signal: AbortSignal,
  current: () => boolean, read = photoBytes, createURL = createRasterURL, revokeURL = URL.revokeObjectURL.bind(URL)) {
  if (signal.aborted || !current()) return;
  const representation = rasterRepresentation(photo, kind);
  if (!representation) throw new Error("Saved preview unavailable.");
  const bytes = await read(photo, representation.binding.kind as RasterKind, signal);
  try {
    if (signal.aborted || !current()) return;
    const url = createURL((kind === "preview" ? "viewer-preview:" : "thumbnail:") + savedRasterSource(photo, kind), bytes,
      "image/jpeg", kind === "preview" || representation.binding.kind === "preview" ? 1600 * 1600 * 4 : 256 * 256 * 4);
    let released = false;
    const release = () => {if (!released) {released = true; signal.removeEventListener("abort", release); revokeURL(url);}};
    signal.addEventListener("abort", release, {once: true});
    if (signal.aborted || !current()) {release(); return;}
    return url;
  } finally {bytes.fill(0);}
}
