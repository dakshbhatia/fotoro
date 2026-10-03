import type {Photo} from "./catalog";
import {readAnnotations} from "../exchange/annotations";
import {assertVault} from "../vault/scope";
import type {UnlockedVault} from "../vault/vault";

export async function projectLocalAnnotations(photos: readonly Photo[], session: UnlockedVault): Promise<Photo[]> {
  assertVault(session);
  if (photos.some(photo => photo.grantId || photo.manifest.ownerAccountId !== session.accountId)) throw new Error("ANNOTATION_IDENTITY_MISMATCH");
  const projected: Photo[] = [];
  for (const photo of photos) {
    const annotation = await readAnnotations({ownerAccountId: photo.manifest.ownerAccountId,
      photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256}, session);
    assertVault(session);
    projected.push({...photo, annotations: annotation?.value, annotationRevision: annotation?.revision});
  }
  return projected;
}
