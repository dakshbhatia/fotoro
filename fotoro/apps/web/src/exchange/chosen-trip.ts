import type {LocalPhoto} from "../local/resources";
import type {OwnedPhotoDetailsSource, Photo} from "../library/catalog";
import type {PendingImport} from "./journal";
import {localOriginalDigest} from "./annotations";
import {tripSavedSources} from "../albums/import";

import {fail, validDigest, sameManifest, ownedSource} from "./chosen-trip-snapshot";
export {snapshotChosenTripSources} from "./chosen-trip-snapshot";

// Select exact hydrated originals after cacheOwnedPhotoDetails and cachedSync.
export function chosenTripPhotos(sources: readonly OwnedPhotoDetailsSource[], owned: readonly Photo[], ownerAccountId: string, current: () => boolean): Photo[] {
  const check = () => {if (!current()) throw new DOMException("Trip choice changed", "AbortError");};
  check();
  if (!sources.length || sources.length > 100) throw new Error("TRIP_CHOOSE_1_TO_100_FILES");
  const selected = new Map<string, Photo>();
  for (const source of sources) {
    if (source.ownerAccountId !== ownerAccountId || source.manifest.ownerAccountId !== ownerAccountId
      || source.manifest.photoId !== source.photoId || !validDigest(source.originalSha256)) fail();
    const matches = owned.filter(photo => photo.manifest.photoId === source.photoId);
    if (matches.length !== 1) fail();
    const exact = ownedSource(matches[0], ownerAccountId);
    if (exact.originalSha256 !== source.originalSha256 || !sameManifest(exact.manifest, source.manifest)) fail();
    selected.set(source.photoId, matches[0]);
  }
  check();
  return [...selected.values()];
}

// Resolve the entire explicit choice, including commits not yet in the browse catalog.
export function resolveChosenTripSources(options: {
  local: readonly LocalPhoto[]; saved: readonly OwnedPhotoDetailsSource[];
  owned: readonly Photo[]; pending: readonly PendingImport[];
  ownerAccountId: string; current: () => boolean;
}): OwnedPhotoDetailsSource[] {
  const {local, saved, owned, pending, ownerAccountId, current} = options;
  const check = () => {if (!current() || local.some(photo => photo.current?.() === false)) throw new DOMException("Trip choice changed", "AbortError");};
  check();
  if (!ownerAccountId || (!local.length && !saved.length) || local.length + saved.length > 100) throw new Error("TRIP_CHOOSE_1_TO_100_FILES");
  const result = new Map<string, OwnedPhotoDetailsSource>();
  const add = (source: OwnedPhotoDetailsSource) => {
    const prior = result.get(source.photoId);
    if (prior && (prior.originalSha256 !== source.originalSha256 || !sameManifest(prior.manifest, source.manifest))) fail();
    result.set(source.photoId, source);
  };
  const journalSource = (photoId: string) => {
    // Conflicting journal entries must never be hidden by Map's last-write behavior.
    const matches = pending.filter(item => item.photoId === photoId);
    if (matches.length !== 1) fail();
    return tripSavedSources([photoId], ownerAccountId, matches)[0];
  };
  for (const captured of saved) {
    if (captured.ownerAccountId !== ownerAccountId || captured.manifest.ownerAccountId !== ownerAccountId
      || captured.photoId !== captured.manifest.photoId || !validDigest(captured.originalSha256)) fail();
    const matches = owned.filter(photo => photo.manifest.photoId === captured.photoId);
    if (matches.length > 1) fail();
    const resolved = matches.length ? ownedSource(matches[0], ownerAccountId) : journalSource(captured.photoId);
    if (resolved.originalSha256 !== captured.originalSha256 || !sameManifest(resolved.manifest, captured.manifest)) fail();
    add(resolved);
  }
  for (const photo of local) {
    if (!(photo.file instanceof File)) fail();
    const digest = localOriginalDigest(photo);
    if (!validDigest(digest)) fail();
    const matches = owned.filter(value => !value.grantId && value.manifest.ownerAccountId === ownerAccountId && value.metadata?.originalSha256 === digest);
    let resolved: OwnedPhotoDetailsSource;
    if (matches.length) {
      // syncLocal reuses the first exact owned digest in this catalog order.
      resolved = ownedSource(matches[0], ownerAccountId);
    } else {
      const candidates = pending.filter(value => value.sourceDigest === digest);
      if (candidates.length !== 1) fail();
      resolved = journalSource(candidates[0].photoId);
    }
    if (resolved.originalSha256 !== digest) fail();
    add(resolved);
  }
  check();
  return [...result.values()];
}
