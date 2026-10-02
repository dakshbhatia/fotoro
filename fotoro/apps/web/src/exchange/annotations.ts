import type { PhotoAnnotationsV1, PhotoAnnotationsUpdateV1, PhotoAnnotationsReplyV1, SignedPayloadV1, WrappedKeyV1 } from "@fotoro/contracts";
import { validateWire } from "@fotoro/contracts/validate";
import { signPayload, verifyPayload, unb64, b64, utf8 } from "@fotoro/crypto";
import { requireVault, encryptPrivate, decryptPrivate, type UnlockedVault } from "../vault/vault";
import { assertVault } from "../vault/scope";
import { all, atomic, get, put, type Store } from "./cache";
import { api, ApiError, fixtureMode, isPublicDemoAccount } from "./api";
import type { LocalPhoto } from "../local/resources";
import { OCR_PROCESSOR } from "../local/ocr";

export interface AnnotationIdentity { ownerAccountId: string; photoId: string; originalSha256: string }
export interface VerifiedAnnotations { signed: SignedPayloadV1; revision: number; value: PhotoAnnotationsV1 }
const fields = ["labels", "caption", "keywords", "facts", "favorite", "ocr"] as const;
export type AnnotationPatch = Pick<Partial<PhotoAnnotationsV1>, typeof fields[number]>;
export interface PendingAnnotation {
  version: 1;
  photoId: string;
  originalSha256: string;
  base: PhotoAnnotationsV1;
  signed: SignedPayloadV1;
  patch: AnnotationPatch;
  conflict: boolean;
}
const cacheKey = (session: UnlockedVault, id: string) => session.accountId + ":annotation:" + id;
const outboxKey = (session: UnlockedVault, id: string) => session.accountId + ":annotation-outbox:" + id;
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const serial = new WeakMap<UnlockedVault, Promise<unknown>>();
export function serializeAnnotationWrites<T>(session: UnlockedVault, operation: () => Promise<T>): Promise<T> {
  const previous = serial.get(session) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => {assertVault(session); return operation();});
  serial.set(session, next);
  void next.finally(() => {if (serial.get(session) === next) serial.delete(session);}).catch(() => undefined);
  return next;
}
function identityFor(session: UnlockedVault, pending: Pick<PendingAnnotation, "photoId" | "originalSha256">): AnnotationIdentity {
  return {ownerAccountId: session.accountId, photoId: pending.photoId, originalSha256: pending.originalSha256};
}
function empty(identity: AnnotationIdentity): PhotoAnnotationsV1 {
  return {version: 1, photoId: identity.photoId, originalSha256: identity.originalSha256};
}
function decode(signed: SignedPayloadV1, photoId: string, session: UnlockedVault): VerifiedAnnotations {
  assertVault(session);
  validateWire("SignedPayloadV1", signed);
  if (signed.accountId !== session.accountId || signed.kind !== "photo-annotations") throw new Error("ANNOTATION_IDENTITY_MISMATCH");
  const body = verifyPayload(signed, unb64(session.card.signingPublicKey));
  let update: PhotoAnnotationsUpdateV1;
  try {update = validateWire("PhotoAnnotationsUpdateV1", JSON.parse(new TextDecoder().decode(body)));}
  finally {body.fill(0);}
  if (update.photoId !== photoId) throw new Error("ANNOTATION_BINDING_MISMATCH");
  const value = validateWire<PhotoAnnotationsV1>("PhotoAnnotationsV1", decryptPrivate(update.encrypted));
  if (value.photoId !== photoId) throw new Error("ANNOTATION_BINDING_MISMATCH");
  return {signed, revision: update.revision, value};
}
export function verifyAnnotations(signed: SignedPayloadV1, identity: AnnotationIdentity, session = requireVault()): VerifiedAnnotations {
  assertVault(session);
  if (identity.ownerAccountId !== session.accountId) throw new Error("ANNOTATION_IDENTITY_MISMATCH");
  const verified = decode(signed, identity.photoId, session);
  if (verified.value.originalSha256 !== identity.originalSha256) throw new Error("ANNOTATION_ORIGINAL_DIGEST_MISMATCH");
  return verified;
}
async function cached(identity: AnnotationIdentity, session: UnlockedVault) {
  const wrapped = await get<WrappedKeyV1>("settings", cacheKey(session, identity.photoId));
  assertVault(session);
  return wrapped ? verifyAnnotations(decryptPrivate<SignedPayloadV1>(wrapped), identity, session) : undefined;
}
async function pendingOne(id: string, session: UnlockedVault) {
  const wrapped = await get<WrappedKeyV1>("settings", outboxKey(session, id));
  assertVault(session);
  if (!wrapped) return;
  const pending = decryptPrivate<PendingAnnotation>(wrapped);
  if (pending.photoId !== id || pending.version !== 1) throw new Error("ANNOTATION_BINDING_MISMATCH");
  verifyAnnotations(pending.signed, identityFor(session, pending), session);
  return pending;
}
export async function readAnnotations(identity: AnnotationIdentity, session = requireVault()) {
  assertVault(session);
  if (identity.ownerAccountId !== session.accountId) throw new Error("ANNOTATION_IDENTITY_MISMATCH");
  const pending = await pendingOne(identity.photoId, session);
  if (pending) return verifyAnnotations(pending.signed, identity, session);
  return cached(identity, session);
}
function createSigned(identity: AnnotationIdentity, value: PhotoAnnotationsV1, revision: number, session: UnlockedVault) {
  assertVault(session);
  validateWire("PhotoAnnotationsV1", value);
  const update = validateWire<PhotoAnnotationsUpdateV1>("PhotoAnnotationsUpdateV1", {version: 1, photoId: identity.photoId, revision, encrypted: encryptPrivate(value)});
  return signPayload("photo-annotations", session.accountId, utf8(update), session.signingSecretKey);
}
/* Keeps signed ciphertext in the account cache. Source digest is checked against immutable metadata before use. */
export async function annotationCacheWrite(signed: SignedPayloadV1, photoId: string, session = requireVault(), staged?: SignedPayloadV1) {
  const incoming = decode(signed, photoId, session);
  const stored = staged ? undefined : await get<WrappedKeyV1>("settings", cacheKey(session, photoId));
  assertVault(session);
  if (staged || stored) {
    const previous = decode(staged ?? decryptPrivate<SignedPayloadV1>(stored!), photoId, session);
    if (incoming.revision < previous.revision) return undefined;
    if (incoming.revision === previous.revision && !same(incoming.signed, previous.signed)) throw new Error("ANNOTATION_REVISION_MISMATCH");
  }
  return {store: "settings" as Store, key: cacheKey(session, photoId), value: encryptPrivate(signed)};
}
export async function cacheAnnotations(signed: SignedPayloadV1, photoId: string, session = requireVault()) {
  await serializeAnnotationWrites(session, async () => {
    const write = await annotationCacheWrite(signed, photoId, session);
    if (write) await atomic([write]);
    assertVault(session);
  });
}
export async function queueAnnotations(identity: AnnotationIdentity, changes: AnnotationPatch, session = requireVault()) {
  return serializeAnnotationWrites(session, async () => {
    if (identity.ownerAccountId !== session.accountId) throw new Error("ANNOTATION_IDENTITY_MISMATCH");
    if (fixtureMode || isPublicDemoAccount(session.accountId)) throw new Error("PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED");
    const existing = await pendingOne(identity.photoId, session), remote = await cached(identity, session);
    const projected = existing ? verifyAnnotations(existing.signed, identity, session) : remote;
    const patch: AnnotationPatch = {...existing?.patch};
    for (const field of fields) if (Object.hasOwn(changes, field)) (patch as Record<string, unknown>)[field] = changes[field];
    const value = {...(projected?.value ?? empty(identity)), ...patch};
    const next: PendingAnnotation = {version: 1, photoId: identity.photoId, originalSha256: identity.originalSha256, base: existing?.base ?? remote?.value ?? empty(identity), patch, conflict: existing?.conflict ?? false, signed: createSigned(identity, value, projected?.revision ?? 1, session)};
    if (!existing) next.signed = createSigned(identity, value, (remote?.revision ?? 0) + 1, session);
    if (projected && same(value, projected.value)) return false;
    await put("settings", outboxKey(session, identity.photoId), encryptPrivate(next));
    assertVault(session);
    return true;
  });
}
export async function pendingAnnotations(session = requireVault()) {
  const rows = await all<WrappedKeyV1>("settings");
  assertVault(session);
  const pending: PendingAnnotation[] = [];
  for (const [key, value] of rows) {
    if (!key.startsWith(session.accountId + ":annotation-outbox:")) continue;
    const item = decryptPrivate<PendingAnnotation>(value);
    if (key !== outboxKey(session, item.photoId)) throw new Error("ANNOTATION_BINDING_MISMATCH");
    verifyAnnotations(item.signed, identityFor(session, item), session);
    pending.push(item);
  }
  return pending;
}
async function reconcile(id: string, remote: VerifiedAnnotations | undefined, session: UnlockedVault, sent?: SignedPayloadV1) {
  return serializeAnnotationWrites(session, async () => {
    const pending = await pendingOne(id, session);
    if (!pending) return;
    if (sent && same(pending.signed, sent)) {
      await atomic([{store: "settings", key: outboxKey(session, id)}]);
      assertVault(session);
      return;
    }
    const identity = identityFor(session, pending), base = remote?.value ?? empty(identity);
    const projected = verifyAnnotations(pending.signed, identity, session).value;
    const conflicts = !sent && fields.some(field => Object.hasOwn(pending.patch, field) && !same(base[field], pending.base[field]) && !same(base[field], projected[field]));
    const next = {...pending, conflict: conflicts};
    if (!conflicts) {
      next.base = base;
      next.signed = createSigned(identity, {...base, ...pending.patch}, (remote?.revision ?? 0) + 1, session);
    }
    await put("settings", outboxKey(session, id), encryptPrivate(next));
    assertVault(session);
  });
}
const flights = new WeakMap<UnlockedVault, Promise<void>>();
export function flushAnnotations(session = requireVault(), signal?: AbortSignal): Promise<void> {
  const existing = flights.get(session);
  if (existing) return existing;
  const flight = (async () => {
    for (const item of await pendingAnnotations(session)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        assertVault(session); signal?.throwIfAborted();
        const pending = await pendingOne(item.photoId, session);
        if (!pending || pending.conflict) break;
        const identity = identityFor(session, pending);
        try {
          const response = await api<SignedPayloadV1>("/v1/photos/" + item.photoId + "/annotations", pending.signed, "SignedPayloadV1", "PUT", signal);
          assertVault(session);
          const remote = verifyAnnotations(response, identity, session);
          if (!same(response, pending.signed)) throw new Error("ANNOTATION_RECEIPT_MISMATCH");
          await cacheAnnotations(response, item.photoId, session);
          await reconcile(item.photoId, remote, session, pending.signed);
        } catch (error) {
          assertVault(session);
          if (!(error instanceof ApiError) || error.code !== "VERSION_CONFLICT") throw error;
          const response = await api<PhotoAnnotationsReplyV1>("/v1/photos/" + item.photoId + "/annotations", undefined, "PhotoAnnotationsReplyV1", "GET", signal);
          assertVault(session);
          const remote = response.annotations ? verifyAnnotations(response.annotations, identity, session) : undefined;
          if (remote) await cacheAnnotations(remote.signed, item.photoId, session);
          await reconcile(item.photoId, remote, session);
        }
      }
    }
  })();
  flights.set(session, flight);
  void flight.finally(() => {if (flights.get(session) === flight) flights.delete(session);}).catch(() => undefined);
  return flight;
}
export async function resolveAnnotationConflict(photoId: string, choice: "local" | "remote", session = requireVault()) {
  await serializeAnnotationWrites(session, async () => {
    const pending = await pendingOne(photoId, session);
    if (!pending) return;
    if (choice === "remote") {
      await atomic([{store: "settings", key: outboxKey(session, photoId)}]);
    } else {
      const identity = identityFor(session, pending), remote = await cached(identity, session), base = remote?.value ?? empty(identity);
      const next = {...pending, base, conflict: false, signed: createSigned(identity, {...base, ...pending.patch}, (remote?.revision ?? 0) + 1, session)};
      await put("settings", outboxKey(session, photoId), encryptPrivate(next));
    }
    assertVault(session);
  });
}
/* Preserve local hex IDs while comparing the shared base64url SHA-256 wire identity. */
export function localOriginalDigest(local: Pick<LocalPhoto, "digest">) {
  const value = local.digest;
  if (!value) return undefined;
  return /^[a-f0-9]{64}$/i.test(value) ? b64(Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16))) : value;
}
function localFields(local: LocalPhoto): AnnotationPatch {
  const value: AnnotationPatch = {labels: local.labels ?? []};
  for (const field of ["caption", "keywords", "facts", "favorite"] as const) if (local[field] !== undefined) (value as Record<string, unknown>)[field] = local[field];
  const ocr = local.ocr;
  if (ocr?.status === "complete" && ocr.processor === OCR_PROCESSOR && ocr.photoID === local.id && ocr.revision === local.digest && Number.isFinite(ocr.confidence) && ocr.confidence >= 0 && ocr.confidence <= 1)
    value.ocr = {text: ocr.text, confidence: ocr.confidence, processor: ocr.processor};
  return value;
}
/* Local source snapshots only detect later source edits; no choice history or pins enter account sync. */
export async function queueLocalAnnotations(identity: AnnotationIdentity, local: LocalPhoto, session = requireVault(), initial = true) {
  if (localOriginalDigest(local) !== identity.originalSha256) return false;
  const key = session.accountId + ":annotation-source:" + identity.photoId;
  const stored = await get<WrappedKeyV1>("settings", key);
  assertVault(session);
  if (!stored && !initial) return false;
  const previous = stored ? decryptPrivate<AnnotationPatch>(stored) : undefined;
  const next = localFields(local), patch: AnnotationPatch = {};
  for (const field of fields) if (Object.hasOwn(next, field) && (!previous || !same(previous[field], next[field]))) (patch as Record<string, unknown>)[field] = next[field];
  if (!Object.keys(patch).length) return false;
  const changed = await queueAnnotations(identity, patch, session);
  assertVault(session);
  await put("settings", key, encryptPrivate(next));
  assertVault(session);
  return changed;
}
