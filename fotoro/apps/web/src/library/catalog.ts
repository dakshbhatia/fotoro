import type {
  PhotoManifestV1,
  PhotoMetadataV1,
  RepresentationV1,
  SignedPayloadV1,
  ChangePageV1,
  AccountCardV1,
  WrappedKeyV1,
  PhotoAnnotationsV1,
} from "@fotoro/contracts";
import { validateWire } from "@fotoro/contracts/validate";
import {
  ready,
  unwrapKey,
  unb64,
  b64,
  sodium,
  decryptMedia,
  verifyPayload,
} from "@fotoro/crypto";
import { api, fetchCipher } from "../exchange/api";
import { get, all, atomic, cacheCipher } from "../exchange/cache";
import { requireVault, encryptPrivate, decryptPrivate } from "../vault/vault";
import { annotationCacheWrite, readAnnotations, serializeAnnotationWrites } from "../exchange/annotations";
export interface Photo {
  manifest: PhotoManifestV1;
  metadata: PhotoMetadataV1;
  metadataKey: Uint8Array;
  grantId?: string;
  annotations?: PhotoAnnotationsV1;
  annotationRevision?: number;
}
export const digest = (bytes: Uint8Array) =>
  b64(sodium.crypto_hash_sha256(bytes));
export async function* source(bytes: Uint8Array) {
  for (let n = 0; n < bytes.length; n += 4 * 1024 * 1024)
    yield bytes.subarray(n, n + 4 * 1024 * 1024);
}
export async function collect(parts: AsyncIterable<Uint8Array>) {
  const chunks = [];
  let length = 0;
  for await (const v of parts) {
    chunks.push(v);
    length += v.length;
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}
export async function representation(rep: RepresentationV1, key: Uint8Array) {
  await ready;
  const session = requireVault();
  const account = session.accountId;
  const cacheKey = account + ":" + rep.objectId;
  let bytes = await get<Uint8Array>("read", cacheKey);
  if (!bytes) {
    bytes = await fetchCipher(rep.objectId);
    if (
      bytes.byteLength !== rep.ciphertextBytes ||
      digest(bytes) !== rep.ciphertextSha256 ||
      b64(bytes.subarray(0, 24)) !== rep.header
    )
      throw new Error("CIPHERTEXT_MISMATCH");
    await cacheCipher(cacheKey, bytes);
  }
  if (
    bytes.byteLength !== rep.ciphertextBytes ||
    digest(bytes) !== rep.ciphertextSha256 ||
    b64(bytes.subarray(0, 24)) !== rep.header
  )
    throw new Error("CIPHERTEXT_MISMATCH");
  if (requireVault() !== session) throw new Error("VAULT_LOCKED");
  const plaintext = await collect(
    decryptMedia(source(bytes), key, rep.binding),
  );
  if (requireVault() !== session) {
    plaintext.fill(0);
    throw new Error("VAULT_LOCKED");
  }
  return plaintext;
}
export async function readPhoto(
  manifest: PhotoManifestV1,
  metadataKey?: Uint8Array,
  grantId?: string,
): Promise<Photo> {
  const key =
    metadataKey ??
    unwrapKey(manifest.ownerWrappedMetadataKey, requireVault().vaultKey);
  let plain: Uint8Array | undefined;
  try {
    plain = await representation(manifest.metadataRepresentation, key);
    const metadata = validateWire<PhotoMetadataV1>(
      "PhotoMetadataV1",
      JSON.parse(new TextDecoder().decode(plain)),
    );
    return { manifest, metadata, metadataKey: key, grantId };
  } catch (error) {key.fill(0); throw error;}
  finally {plain?.fill(0);}
}
export async function photoBytes(
  photo: Photo,
  kind: "thumbnail" | "preview" | "original",
) {
  const rep =
    photo.manifest.representations.find((r) => r.binding.kind === kind) ??
    photo.manifest.representations.find((r) => r.binding.kind === "original")!;
  const bytes = await representation(
    rep,
    unb64(photo.metadata.representationKeys[rep.binding.representationId]),
  );
  if (
    rep.binding.kind === "original" &&
    (bytes.length !== photo.metadata.originalBytes ||
      digest(bytes) !== photo.metadata.originalSha256)
  ) {
    bytes.fill(0);
    throw new Error("ORIGINAL_DIGEST_MISMATCH");
  }
  return bytes;
}
export async function applyChanges(
  page: ChangePageV1,
  session = requireVault(),
) {
  return serializeAnnotationWrites(session, async () => {
    validateWire("ChangePageV1", page);
    if (requireVault() !== session) throw new Error("VAULT_LOCKED");
    const v = requireVault();
    const writes: any[] = [];
    const stagedAnnotations = new Map<string, SignedPayloadV1>();
    for (const change of page.changes) {
      if (change.entity === "annotation") {
        if (change.deleted) writes.push({store: "settings", key: v.accountId + ":annotation:" + change.entityId});
        else {
          const write = await annotationCacheWrite(change.payload!, change.entityId, session, stagedAnnotations.get(change.entityId));
          if (write) {writes.push(write); stagedAnnotations.set(change.entityId, change.payload!);}
        }
        continue;
      }
      if (change.entity !== "photo") continue;
      const key = v.accountId + ":" + change.entityId;
      if (change.deleted) writes.push({ store: "catalog", key });
      else {
        const payload = change.payload!;
        if (payload.accountId !== v.accountId) continue;
        if (payload.kind !== "photo-manifest")
          throw new Error("CATALOG_IDENTITY_MISMATCH");
        const manifest = validateWire<PhotoManifestV1>(
          "PhotoManifestV1",
          JSON.parse(
            new TextDecoder().decode(
              verifyPayload(payload, unb64(v.card.signingPublicKey)),
            ),
          ),
        );
        if (
          manifest.ownerAccountId !== v.accountId ||
          manifest.photoId !== change.entityId
        )
          throw new Error("CATALOG_BINDING_MISMATCH");
        writes.push({ store: "catalog", key, value: encryptPrivate(payload) });
      }
    }
    writes.push({
      store: "settings",
      key: v.accountId + ":cursor",
      value: encryptPrivate(page.nextCursor),
    });
    await atomic(writes);
    if (requireVault() !== session) throw new Error("VAULT_LOCKED");
  });
}
export async function syncCatalog(signal?: AbortSignal) {
  const session = requireVault();
  const id = session.accountId;
  let cursor = await get<WrappedKeyV1>("settings", id + ":cursor");
  do {
    if (requireVault() !== session) throw new Error("VAULT_LOCKED");
    const page = await api<ChangePageV1>(
      "/v1/changes?limit=100" +
        (cursor && decryptPrivate<string | null>(cursor)
          ? "&cursor=" + encodeURIComponent(decryptPrivate<string>(cursor))
          : ""),
      undefined,
      "ChangePageV1",
      "GET",
      signal,
    );
    await applyChanges(page, session);
    if (!page.hasMore) break;
    cursor = await get("settings", id + ":cursor");
  } while (true);
}
export async function cachedCatalog() {
  const v = requireVault();
  const rows = await all<WrappedKeyV1>("catalog");
  if (requireVault() !== v) throw new Error("VAULT_LOCKED");
  const photos: Photo[] = [];
  for (const [id, value] of rows) {
    if (!id.startsWith(v.accountId + ":")) continue;
    const signed = decryptPrivate<SignedPayloadV1>(value);
    const manifest = validateWire<PhotoManifestV1>(
      "PhotoManifestV1",
      JSON.parse(
        new TextDecoder().decode(
          verifyPayload(signed, unb64(v.card.signingPublicKey)),
        ),
      ),
    );
    if (signed.accountId !== v.accountId || signed.kind !== "photo-manifest" || manifest.ownerAccountId !== v.accountId || id !== v.accountId + ":" + manifest.photoId)
      throw new Error("CATALOG_BINDING_MISMATCH");
    const photo = await readPhoto(manifest);
    const annotation = await readAnnotations({ownerAccountId: manifest.ownerAccountId, photoId: manifest.photoId, originalSha256: photo.metadata.originalSha256}, v);
    if (annotation) {photo.annotations = annotation.value; photo.annotationRevision = annotation.revision;}
    photos.push(photo);
    if (requireVault() !== v) throw new Error("VAULT_LOCKED");
  }
  return photos.sort((a, b) =>
    b.metadata.sourceDate.localeCompare(a.metadata.sourceDate),
  );
}
