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
  PhotoAnnotationsReplyV1,
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
import { get, all, atomic, cacheCipher, boundedRows, cachedMetadataRevision, cachedPhotoRevision } from "../exchange/cache";
import { requireVault, encryptPrivate, decryptPrivate, type UnlockedVault } from "../vault/vault";
import {assertVault, sameVault} from "../vault/scope";
import {PhotoSearchIndex, type SearchPhoto} from "../local/search";
import {cloudSearchRecords} from "./search";
import { annotationCacheWrite, readAnnotations, serializeAnnotationWrites, verifyAnnotations, type AnnotationIdentity } from "../exchange/annotations";
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
export interface OwnedPhotoDetailsSource extends AnnotationIdentity {manifest: PhotoManifestV1}
const orderedSource = (value: unknown): unknown => Array.isArray(value) ? value.map(orderedSource) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, orderedSource(item)])) : value;
/* Read only the selected owner's signed records; hydration remains bounded by the caller. */
export async function cacheOwnedPhotoDetails(source: OwnedPhotoDetailsSource, signal?: AbortSignal, diagnostic?: DiagnosticContext): Promise<void> {
  const session = requireVault(), origin = typeof location === "undefined" ? undefined : location.origin;
  const identity: AnnotationIdentity = {ownerAccountId: source.ownerAccountId, photoId: source.photoId, originalSha256: source.originalSha256};
  const expected = JSON.stringify(orderedSource(source.manifest));
  const check = () => {
    assertVault(session); signal?.throwIfAborted();
    if (origin !== (typeof location === "undefined" ? undefined : location.origin)) throw new Error("CATALOG_SOURCE_CHANGED");
    if (JSON.stringify(orderedSource(source.manifest)) !== expected || source.ownerAccountId !== identity.ownerAccountId || source.photoId !== identity.photoId || source.originalSha256 !== identity.originalSha256) throw new Error("CATALOG_SOURCE_CHANGED");
  };
  check();
  if (identity.ownerAccountId !== session.accountId || source.manifest.ownerAccountId !== session.accountId || source.manifest.photoId !== identity.photoId) throw new Error("CATALOG_BINDING_MISMATCH");
  const request = diagnostic ? scopedApi(diagnostic) : api;
  const path = "/v1/photos/" + encodeURIComponent(identity.photoId);
  const signed = await request<SignedPayloadV1>(path + "/manifest", undefined, "SignedPayloadV1", "GET", signal);
  check();
  if (signed.accountId !== session.accountId) throw new Error("CATALOG_BINDING_MISMATCH");
  acceptedPhotoManifestKind(signed.kind);
  const bytes = verifyPayload(signed, unb64(session.card.signingPublicKey));
  let manifest: PhotoManifestV1;
  try {manifest = validateWire<PhotoManifestV1>("PhotoManifestV1", JSON.parse(new TextDecoder().decode(bytes)));}
  finally {bytes.fill(0);}
  if (manifest.ownerAccountId !== session.accountId || manifest.photoId !== identity.photoId) throw new Error("CATALOG_BINDING_MISMATCH");
  if (JSON.stringify(orderedSource(manifest)) !== expected) throw new Error("CATALOG_SOURCE_CHANGED");
  const response = await request<PhotoAnnotationsReplyV1>(path + "/annotations", undefined, "PhotoAnnotationsReplyV1", "GET", signal);
  check();
  if (response.annotations) verifyAnnotations(response.annotations, identity, session);
  await serializeAnnotationWrites(session, async () => {
    check();
    const annotation = response.annotations ? await annotationCacheWrite(response.annotations, identity.photoId, session) : undefined;
    check();
    const key = session.accountId + ":" + identity.photoId;
    const stored = await get<WrappedKeyV1>("catalog", key);
    check();
    if (stored) {
      const previous = decryptPrivate<SignedPayloadV1>(stored);
      if (previous.body !== signed.body || previous.signature !== signed.signature || previous.kind !== signed.kind || previous.accountId !== signed.accountId) throw new Error("CATALOG_SOURCE_CHANGED");
    }
    await atomic([{store: "catalog", key, value: stored ?? encryptPrivate(signed)}, ...(annotation ? [annotation] : [])]);
    check();
  });
}

export async function applyChanges(
  page: ChangePageV1,
  session = requireVault(), signal?: AbortSignal, current?: () => boolean,
) {
  const check = () => {assertVault(session); signal?.throwIfAborted(); if (current?.() === false) throw new DOMException("Catalog read withdrawn", "AbortError");};
  return serializeAnnotationWrites(session, async () => {
    check(); validateWire("ChangePageV1", page);
    if (requireVault() !== session) throw new Error("VAULT_LOCKED");
    const v = requireVault();
    const writes: any[] = [];
    const stagedAnnotations = new Map<string, SignedPayloadV1>();
    for (const change of page.changes) {
      check();
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
    writes.push({store: "settings", key: v.accountId + ":catalog-has-more", value: encryptPrivate(page.hasMore)});
    check(); await atomic(writes); check();
  });
}
export async function syncCatalog(signal?: AbortSignal, diagnostic?: DiagnosticContext, maxPages = Infinity, current?: () => boolean) {
  if (!(maxPages === Infinity || Number.isSafeInteger(maxPages) && maxPages > 0)) throw new Error("INVALID_CATALOG_WINDOW");
  const request = diagnostic ? scopedApi(diagnostic) : api;
  const session = requireVault();
  const check = () => {assertVault(session); signal?.throwIfAborted(); if (current?.() === false) throw new DOMException("Catalog read withdrawn", "AbortError");};
  check(); const id = session.accountId;
  const capability = await get<WrappedKeyV1>("settings", id + ":media-reader-v1");
  let cursor = capability ? await get<WrappedKeyV1>("settings", id + ":cursor") : undefined;
  let pages = 0;
  while (true) {
    check();
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
    check();
    if (page.mediaVersion !== 1) throw new Error("MEDIA_READER_UPDATE_REQUIRED");
    await applyChanges(page, session, signal, current);
    check();
    await atomic([{store: "settings", key: id + ":media-reader-v1", value: encryptPrivate(true)}]);
    check();
    signal?.throwIfAborted();
    if (!page.hasMore || ++pages >= maxPages) return {hasMore: page.hasMore};
    await new Promise(resolve => setTimeout(resolve, 0)); check();
    cursor = await get("settings", id + ":cursor");
  }
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
  return (await cachedCatalogSnapshot(diagnostic)).photos;
}
export interface CatalogBrowse {limit: number; retainPhotoIds?: readonly string[]; retainedOnly?: boolean; signal?: AbortSignal; current?: () => boolean}
export interface CatalogCoverage {loaded: number; cachedTotal: number; hasMore: boolean; hasMoreChanges: boolean | null}
export async function cachedCatalogSnapshot(diagnostic?: DiagnosticContext, browse?: CatalogBrowse) {
  const v = requireVault(), cache = currentHydratedCatalog(v);
  const check = () => {assertVault(v); browse?.signal?.throwIfAborted(); if (browse?.current && !browse.current()) throw new DOMException("Catalog source changed", "AbortError");};
  check();
  const window = browse ? await boundedRows<WrappedKeyV1>("catalog", v.accountId + ":", browse.limit) : undefined;
  const rows = browse?.retainedOnly ? [] : window?.rows ?? await all<WrappedKeyV1>("catalog", v.accountId + ":");
  if (browse?.retainPhotoIds?.length) {
    const present = new Set(rows.map(([id]) => id));
    for (const photoId of new Set(browse.retainPhotoIds)) {
      const id = v.accountId + ":" + photoId;
      if (present.has(id)) continue;
      const value = await get<WrappedKeyV1>("catalog", id);
      check();
      if (value) {rows.push([id, value]); present.add(id);}
    }
  }
  check();
  const photos: Photo[] = [], present = new Set<string>();
  try {
    for (const [id, value] of rows) {
      check();
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
        photo = previous?.signed === identity ? previous.photo : await readPhoto(manifest, undefined, undefined, browse?.signal, diagnostic);
        try {check(); if (hydrated !== cache) throw new Error("VAULT_LOCKED");}
        catch (error) {if (photo !== previous?.photo) photo.metadataKey.fill(0); throw error;}
      }
      // Read annotations every time. Failed reads never publish a cached or partial annotation result.
      let annotation;
      try {
        annotation = await readAnnotations({ownerAccountId: photo.manifest.ownerAccountId, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256}, v);
        check();
        if (hydrated !== cache) throw new Error("VAULT_LOCKED");
        const current = await get<WrappedKeyV1>("catalog", id);
        check();
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
    if (!browse?.retainedOnly && (!window || window.total === rows.length)) for (const id of cache.entries.keys()) if (!present.has(id)) forgetHydrated(cache, id);
    const remaining = await get<WrappedKeyV1>("settings", v.accountId + ":catalog-has-more");
    check();
    if (hydrated !== cache) throw new Error("VAULT_LOCKED");
    const hasMoreChanges = remaining ? decryptPrivate<boolean>(remaining) : null;
    if (hasMoreChanges !== null && typeof hasMoreChanges !== "boolean") throw new Error("CATALOG_COVERAGE_INVALID");
    const coverage: CatalogCoverage = {loaded: photos.length, cachedTotal: window?.total ?? rows.length,
      hasMore: !!window && window.total > rows.length, hasMoreChanges};
    return {photos: photos.sort((a, b) => b.metadata.sourceDate.localeCompare(a.metadata.sourceDate)), coverage};
  } catch (error) {
    for (const photo of photos) photo.metadataKey.fill(0);
    throw error;
  }
}

export interface CachedMetadataSource {manifest: string; annotation?: string; revision: number}
const metadataReceipt = (wrapped: WrappedKeyV1) => digest(new TextEncoder().encode(JSON.stringify([wrapped.version, wrapped.nonce, wrapped.ciphertext])));
// Metadata-only account traversal. No gallery keys or image representations are retained by the scan.
export async function scanCachedMetadata(session: UnlockedVault, signal: AbortSignal, current: () => boolean,
  visit: (photo: Photo, source: CachedMetadataSource) => void,
  reuse?: (id: string, source: CachedMetadataSource) => boolean) {
  const check = () => {
    signal.throwIfAborted(); assertVault(session);
    if (!current()) throw new DOMException("Metadata source changed", "AbortError");
  };
  let after: string | undefined, processed = 0;
  const yieldPhoto = async () => {if (++processed % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0)); check();};
  check();
  for (;;) {
    const batchRevision = cachedMetadataRevision(session.accountId);
    const batch = await boundedRows<WrappedKeyV1>("catalog", session.accountId + ":", 64, after); check();
    const changedBatch = batchRevision !== cachedMetadataRevision(session.accountId);
    const revisions = new Map(batch.rows.map(([id]) => [id, cachedPhotoRevision(session.accountId, id.slice(session.accountId.length + 1))]));
    for (const [id, wrapped] of batch.rows) {
      check();
      const photoId = id.slice(session.accountId.length + 1);
      const revision = revisions.get(id)!;
      const annotation = await get<WrappedKeyV1>("settings", session.accountId + ":annotation:" + photoId); check();
      if (cachedPhotoRevision(session.accountId, photoId) !== revision) continue;
      const receipt = {manifest: metadataReceipt(wrapped), annotation: annotation ? metadataReceipt(annotation) : undefined, revision};
      if (changedBatch && !await cachedMetadataSourceCurrent(session, photoId, receipt)) continue;
      check(); if (cachedPhotoRevision(session.accountId, photoId) !== revision) continue;
      if (reuse?.(photoId, receipt)) {
        await yieldPhoto(); continue;
      }
      const signed = validateWire<SignedPayloadV1>("SignedPayloadV1", decryptPrivate<SignedPayloadV1>(wrapped));
      const manifest = validateWire<PhotoManifestV1>("PhotoManifestV1", JSON.parse(new TextDecoder().decode(verifyPayload(signed, unb64(session.card.signingPublicKey)))));
      if (signed.accountId !== session.accountId || !["photo-manifest", "photo-media-manifest-v1"].includes(signed.kind) || manifest.ownerAccountId !== session.accountId || id !== session.accountId + ":" + manifest.photoId) throw new Error("CATALOG_BINDING_MISMATCH");
      const photo = await readPhoto(manifest, undefined, undefined, signal);
      try {
        check();
        const admitted = await readAnnotations({ownerAccountId: session.accountId, photoId: manifest.photoId, originalSha256: photo.metadata.originalSha256}, session); check();
        if (admitted) {photo.annotations = admitted.value; photo.annotationRevision = admitted.revision;}
        const source = {manifest: metadataReceipt(wrapped), annotation: annotation ? metadataReceipt(annotation) : undefined, revision};
        if (!await cachedMetadataSourceCurrent(session, manifest.photoId, source)) continue;
        if (cachedPhotoRevision(session.accountId, photoId) !== revision) continue;
        check(); visit(photo, source); check();
      } finally {photo.metadataKey.fill(0);}
      await yieldPhoto();
    }
    if (batch.rows.length < 64) break;
    after = batch.rows.at(-1)![0];
    // Yield between bounded IDB batches, including when ciphertext is already cached.
    await new Promise<void>(resolve => setTimeout(resolve, 0)); check();
  }
  check();
}
export async function cachedMetadataSourceCurrent(session: UnlockedVault, id: string, source: CachedMetadataSource) {
  const manifest = await get<WrappedKeyV1>("catalog", session.accountId + ":" + id); assertVault(session);
  const annotation = await get<WrappedKeyV1>("settings", session.accountId + ":annotation:" + id); assertVault(session);
  return cachedPhotoRevision(session.accountId, id) === source.revision && !!manifest && source.manifest === metadataReceipt(manifest) && (!source.annotation && !annotation || !!source.annotation && !!annotation && source.annotation === metadataReceipt(annotation));
}

// Plain metadata exists only for this unlocked, visible account lifetime. Receipts remain encrypted.
export class CachedAccountSearch {
  records: SearchPhoto[] = [];
  index?: PhotoSearchIndex;
  private sources = new Map<string, CachedMetadataSource>();
  private verified = new Map<string, SearchPhoto>();
  private withdrawn = new Set<string>();
  private disposed = false;
  private readonly revision: number;
  private previousIndex?: PhotoSearchIndex;
  constructor(private session: UnlockedVault, private current: () => boolean, previous?: CachedAccountSearch) {
    this.revision = cachedMetadataRevision(session.accountId);
    if (previous && !previous.disposed && previous.session === session && previous.current()) {
      this.sources = new Map(previous.sources); this.verified = new Map(previous.verified);
      this.previousIndex = previous.index;
    }
  }
  get admitted() {return !this.disposed && sameVault(this.session) && this.current();}
  get complete() {return this.admitted && !this.withdrawn.size && cachedMetadataRevision(this.session.accountId) === this.revision;}
  private project(record: SearchPhoto, revision: number) {
    const id = record.id;
    return {...record, current: () => this.admitted && !this.withdrawn.has(id) && cachedPhotoRevision(this.session.accountId, id) === revision};
  }
  dispose() {this.disposed = true; this.records = []; this.sources.clear(); this.verified.clear(); this.withdrawn.clear(); this.index?.dispose(); this.index = undefined; this.previousIndex = undefined;}
  async scan(signal: AbortSignal) {
    let metadataBytes = 0;
    const unchanged = new Set<string>();
    const admit = (record: SearchPhoto) => {metadataBytes += 512 + 2 * JSON.stringify(record).length; if (metadataBytes > 32 * 1024 * 1024) throw new Error("CACHED_SEARCH_BUDGET");};
    try {
      await scanCachedMetadata(this.session, signal, () => this.admitted, (photo, source) => {
        // Override the gallery closure, so the record cannot retain a temporary Photo/key.
        const record = cloudSearchRecords([photo])[0];
        const projected = this.project(record, source.revision);
        admit(projected); this.records.push(projected); this.verified.set(record.id, projected);
        this.sources.set(record.id, source);
      }, (id, source) => {
        const previous = this.sources.get(id), record = this.verified.get(id);
        if (!previous || !record || previous.manifest !== source.manifest
          || previous.revision !== source.revision
          || !!previous.annotation !== !!source.annotation || previous.annotation && source.annotation && previous.annotation !== source.annotation) return false;
        const projected = this.project(record, source.revision);
        admit(projected); this.records.push(projected); this.verified.set(id, projected); unchanged.add(id); return true;
      });
      const present = new Set(this.records.map(record => record.id));
      for (const id of this.sources.keys()) if (!present.has(id)) {this.sources.delete(id); this.verified.delete(id);}
      this.index = await PhotoSearchIndex.build(this.records, signal, () => this.admitted, 128 * 1024 * 1024 - metadataBytes,
        this.previousIndex ? {index: this.previousIndex, unchanged} : undefined);
      return this;
    } catch (error) {this.records = []; if (!sameVault(this.session) || !this.current() || error instanceof Error && error.message === "CACHED_SEARCH_BUDGET") this.dispose(); throw error;}
    finally {this.previousIndex = undefined;}
  }
  async hydrate(ids: readonly string[], signal: AbortSignal) {
    const chosen = [...new Set(ids)].slice(0, 200);
    const check = () => {signal.throwIfAborted(); if (!this.admitted) throw new DOMException("Saved search changed", "AbortError");};
    const verify = async () => {
      for (const id of chosen) {
        check(); const source = this.sources.get(id);
        if (!source || !await cachedMetadataSourceCurrent(this.session, id, source)) {this.withdrawn.add(id); throw new Error("CATALOG_SOURCE_CHANGED");}
        check();
      }
    };
    await verify(); check();
    const result = await cachedCatalogSnapshot(undefined, {limit: 1, retainedOnly: true, retainPhotoIds: chosen, signal, current: () => this.admitted});
    try {await verify(); check(); return result.photos;}
    catch (error) {for (const photo of result.photos) photo.metadataKey.fill(0); throw error;}
  }
}
