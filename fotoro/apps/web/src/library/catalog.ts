import {type DiagnosticContext} from "../diagnostics";
import {acceptedPhotoManifestKind, LIVE_PHOTO_TYPE} from "@fotoro/contracts/camera-media";
import type {
  PhotoManifestV1,
  PhotoMetadataV1,
  RepresentationV1,
  SignedPayloadV1,
  ChangePageV1,
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
  decodeLivePhoto,
} from "@fotoro/crypto";
import { api, scopedApi, fetchCipher } from "../exchange/api";
import { get, all, atomic, cacheCipher } from "../exchange/cache";
import { requireVault, encryptPrivate, decryptPrivate, type UnlockedVault } from "../vault/vault";
import {assertVault} from "../vault/scope";
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
export async function representation(rep: RepresentationV1, key: Uint8Array, signal?: AbortSignal, diagnostic?: DiagnosticContext) {
  await ready;
  signal?.throwIfAborted();
  const session = requireVault();
  const check = () => {assertVault(session); signal?.throwIfAborted();};
  const account = session.accountId;
  const cacheKey = account + ":" + rep.objectId;
  let bytes = await get<Uint8Array>("read", cacheKey);
  check();
  if (!bytes) {
    bytes = await fetchCipher(rep.objectId, signal, diagnostic);
    check();
    if (
      bytes.byteLength !== rep.ciphertextBytes ||
      digest(bytes) !== rep.ciphertextSha256 ||
      b64(bytes.subarray(0, 24)) !== rep.header
    )
      throw new Error("CIPHERTEXT_MISMATCH");
    await cacheCipher(cacheKey, bytes);
    check();
  }
  if (
    bytes.byteLength !== rep.ciphertextBytes ||
    digest(bytes) !== rep.ciphertextSha256 ||
    b64(bytes.subarray(0, 24)) !== rep.header
  )
    throw new Error("CIPHERTEXT_MISMATCH");
  check();
  const plaintext = await collect(
    decryptMedia(source(bytes), key, rep.binding),
  );
  try {check();} catch (error) {plaintext.fill(0); throw error;}
  return plaintext;
}
export async function readPhoto(
  manifest: PhotoManifestV1,
  metadataKey?: Uint8Array,
  grantId?: string,
  signal?: AbortSignal,
  diagnostic?: DiagnosticContext,
): Promise<Photo> {
  signal?.throwIfAborted();
  const key =
    metadataKey ??
    unwrapKey(manifest.ownerWrappedMetadataKey, requireVault().vaultKey);
  let plain: Uint8Array | undefined;
  try {
    plain = await representation(manifest.metadataRepresentation, key, signal, diagnostic);
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
  signal?: AbortSignal,
  diagnostic?: DiagnosticContext,
) {
  signal?.throwIfAborted();
  const session = requireVault();
  const rep =
    photo.manifest.representations.find((r) => r.binding.kind === kind) ??
    photo.manifest.representations.find((r) => r.binding.kind === "original")!;
  const bytes = await representation(
    rep,
    unb64(photo.metadata.representationKeys[rep.binding.representationId]),
    signal,
    diagnostic,
  );
  if (
    rep.binding.kind === "original" &&
    (bytes.length !== photo.metadata.originalBytes ||
      digest(bytes) !== photo.metadata.originalSha256)
  ) {
    bytes.fill(0);
    throw new Error("ORIGINAL_DIGEST_MISMATCH");
  }
  try {
    if (rep.binding.kind === "original" && photo.metadata.mediaType === LIVE_PHOTO_TYPE) await decodeLivePhoto(bytes);
    assertVault(session); signal?.throwIfAborted();
  } catch (error) {bytes.fill(0); throw error;}
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
        acceptedPhotoManifestKind(payload.kind);
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
export async function syncCatalog(signal?: AbortSignal, diagnostic?: DiagnosticContext) {
  const request = diagnostic ? scopedApi(diagnostic) : api;
  const session = requireVault();
  const id = session.accountId;
  const capability = await get<WrappedKeyV1>("settings", id + ":media-reader-v1");
  let cursor = capability ? await get<WrappedKeyV1>("settings", id + ":cursor") : undefined;
  do {
    if (requireVault() !== session) throw new Error("VAULT_LOCKED");
    const page = await request<ChangePageV1>(
      "/v1/changes?limit=100&media=1" +
        (cursor && decryptPrivate<string | null>(cursor)
          ? "&cursor=" + encodeURIComponent(decryptPrivate<string>(cursor))
          : ""),
      undefined,
      "ChangePageV1",
      "GET",
      signal,
    );
    assertVault(session);
    if (page.mediaVersion !== 1) throw new Error("MEDIA_READER_UPDATE_REQUIRED");
    await applyChanges(page, session);
    if (requireVault() !== session) throw new Error("VAULT_LOCKED");
    await atomic([{store: "settings", key: id + ":media-reader-v1", value: encryptPrivate(true)}]);
    if (requireVault() !== session) throw new Error("VAULT_LOCKED");
    if (!page.hasMore) break;
    cursor = await get("settings", id + ":cursor");
  } while (true);
}
const HYDRATED_PHOTOS = 2048, HYDRATED_BYTES = 16 * 1024 * 1024;
interface HydratedEntry {wrapped: WrappedKeyV1; signed: string; photo: Photo; bytes: number}
interface HydratedCatalog {session: UnlockedVault; entries: Map<string, HydratedEntry>; bytes: number}
let hydrated: HydratedCatalog | undefined;
function disposeHydratedCatalog() {
  for (const entry of hydrated?.entries.values() ?? []) entry.photo.metadataKey.fill(0);
  hydrated?.entries.clear();
  hydrated = undefined;
}
if (typeof window !== "undefined") {
  window.addEventListener("fotoro-lock", disposeHydratedCatalog);
  window.addEventListener("pagehide", disposeHydratedCatalog);
}
function currentHydratedCatalog(session: UnlockedVault) {
  assertVault(session);
  if (hydrated?.session !== session) {
    disposeHydratedCatalog();
    hydrated = {session, entries: new Map(), bytes: 0};
  }
  return hydrated!;
}
function sameWrapped(a: WrappedKeyV1, b: WrappedKeyV1) {
  return b.version === 1 && Object.keys(b).length === 3 && a.nonce === b.nonce && a.ciphertext === b.ciphertext;
}
function forgetHydrated(cache: HydratedCatalog, id: string) {
  const entry = cache.entries.get(id);
  if (!entry) return;
  entry.photo.metadataKey.fill(0); cache.bytes -= entry.bytes; cache.entries.delete(id);
}
function rememberHydrated(cache: HydratedCatalog, id: string, entry: HydratedEntry) {
  forgetHydrated(cache, id);
  if (entry.bytes > HYDRATED_BYTES) {entry.photo.metadataKey.fill(0); return;}
  while (cache.entries.size >= HYDRATED_PHOTOS || cache.bytes + entry.bytes > HYDRATED_BYTES) {
    forgetHydrated(cache, cache.entries.keys().next().value!);
  }
  cache.entries.set(id, entry); cache.bytes += entry.bytes;
}
export async function cachedCatalog(diagnostic?: DiagnosticContext) {
  const v = requireVault(), cache = currentHydratedCatalog(v);
  const rows = await all<WrappedKeyV1>("catalog", v.accountId + ":");
  assertVault(v);
  const photos: Photo[] = [], present = new Set<string>();
  try {
    for (const [id, value] of rows) {
      assertVault(v);
      const previous = cache.entries.get(id);
      let photo: Photo, identity: string;
      if (previous && sameWrapped(previous.wrapped, value)) {
        photo = previous.photo; identity = previous.signed;
      } else {
        const signed = validateWire<SignedPayloadV1>("SignedPayloadV1", decryptPrivate<SignedPayloadV1>(value));
        identity = JSON.stringify([signed.version, signed.kind, signed.accountId, signed.body, signed.signature]);
        const manifest = validateWire<PhotoManifestV1>(
          "PhotoManifestV1",
          JSON.parse(new TextDecoder().decode(verifyPayload(signed, unb64(v.card.signingPublicKey)))),
        );
        if (signed.accountId !== v.accountId || !["photo-manifest", "photo-media-manifest-v1"].includes(signed.kind) || manifest.ownerAccountId !== v.accountId || id !== v.accountId + ":" + manifest.photoId)
          throw new Error("CATALOG_BINDING_MISMATCH");
        photo = previous?.signed === identity ? previous.photo : await readPhoto(manifest, undefined, undefined, undefined, diagnostic);
        try {assertVault(v); if (hydrated !== cache) throw new Error("VAULT_LOCKED");}
        catch (error) {if (photo !== previous?.photo) photo.metadataKey.fill(0); throw error;}
      }
      // Read annotations every time. Failed reads never publish a cached or partial annotation result.
      let annotation;
      try {
        annotation = await readAnnotations({ownerAccountId: photo.manifest.ownerAccountId, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256}, v);
        assertVault(v);
        if (hydrated !== cache) throw new Error("VAULT_LOCKED");
        const current = await get<WrappedKeyV1>("catalog", id);
        assertVault(v);
        if (!current || !sameWrapped(value, current)) throw new Error("CATALOG_SOURCE_CHANGED");
      } catch (error) {if (photo !== previous?.photo) photo.metadataKey.fill(0); throw error;}
      photos.push({...photo, metadataKey: new Uint8Array(photo.metadataKey), ...(annotation ? {annotations: annotation.value, annotationRevision: annotation.revision} : {})});
      present.add(id);
      if (previous?.photo === photo && sameWrapped(previous.wrapped, value)) {
        cache.entries.delete(id); cache.entries.set(id, previous);
      } else {
        const bytes = 256 + 2 * (JSON.stringify(value).length + JSON.stringify(photo.metadata).length + identity.length);
        // Own a separate key: cache eviction cannot destroy keys held by current gallery consumers.
        const cached = {...photo, metadataKey: new Uint8Array(photo.metadataKey)};
        rememberHydrated(cache, id, {wrapped: value, signed: identity, photo: cached, bytes});
        if (photo !== previous?.photo) photo.metadataKey.fill(0);
      }
    }
    for (const id of cache.entries.keys()) if (!present.has(id)) forgetHydrated(cache, id);
    assertVault(v);
    return photos.sort((a, b) => b.metadata.sourceDate.localeCompare(a.metadata.sourceDate));
  } catch (error) {
    for (const photo of photos) photo.metadataKey.fill(0);
    throw error;
  }
}
