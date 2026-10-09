import type {OwnedPhotoDetailsSource, Photo} from "../library/catalog";

export const fail = (): never => {throw new Error("TRIP_SAVE_INCOMPLETE");};
export const validDigest = (value: string | undefined): value is string => !!value && /^[A-Za-z0-9_-]{43}$/.test(value);
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
export const sameManifest = (a: OwnedPhotoDetailsSource["manifest"], b: OwnedPhotoDetailsSource["manifest"]) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

export function ownedSource(photo: Photo, ownerAccountId: string): OwnedPhotoDetailsSource {
  if (photo.grantId || !ownerAccountId || photo.manifest.ownerAccountId !== ownerAccountId || !photo.manifest.photoId || !validDigest(photo.metadata?.originalSha256)) fail();
  return {ownerAccountId, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256, manifest: structuredClone(photo.manifest)};
}

// Capture identities before authentication or saving can replace the browse snapshot.
export function snapshotChosenTripSources(photos: readonly Photo[], ownerAccountId: string): OwnedPhotoDetailsSource[] {
  const sources = new Map<string, OwnedPhotoDetailsSource>();
  for (const photo of photos) {
    const source = ownedSource(photo, ownerAccountId), prior = sources.get(source.photoId);
    if (prior && (prior.originalSha256 !== source.originalSha256 || !sameManifest(prior.manifest, source.manifest))) fail();
    sources.set(source.photoId, source);
  }
  return [...sources.values()];
}

