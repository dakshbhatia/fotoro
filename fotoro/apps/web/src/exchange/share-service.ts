import {diagnose, type DiagnosticContext} from "../diagnostics";
import {acceptedPhotoManifestKind, photoManifestKind} from "@fotoro/contracts/camera-media";
import type {AccountCardV1, GrantV1, GrantDetailV1, PhotoManifestV1, SavedPhotoV1, SaveRequestV1, ContributionV1, WrappedKeyV1} from "@fotoro/contracts";
import {validatePublicAccountCard} from "@fotoro/contracts/share-links";
import {validateWire} from "@fotoro/contracts/validate";
import {ready, sealShareKey, openShareKey, signPayload, verifyPayload, utf8, unb64, wrapKey, unwrapKey} from "@fotoro/crypto";
import {api as rawApi, scopedApi} from "./api";
import {get, db} from "./cache";
import {requireVault, type UnlockedVault} from "../vault/vault";
import {assertVault} from "../vault/scope";
import {readPhoto, photoBytes, type Photo} from "../library/catalog";
import {sameIdentity} from "./sharing";
import {trustedCard, contactTrustVersion} from "./contacts";
export interface ShareScope {diagnostic?: DiagnosticContext; signal?: AbortSignal; current?: () => boolean;}
const check = (session: UnlockedVault, scope: ShareScope = {}) => {assertVault(session); scope.signal?.throwIfAborted(); if (scope.current && !scope.current()) throw new DOMException("Share cancelled", "AbortError");};
export {pinCard, trustedCard, contacts, contactNames, saveContactName, syncContacts} from "./contacts";
interface SharingAuthority {session: UnlockedVault; scope: ShareScope; trustVersion: number; cards: Map<string, AccountCardV1>;}
const authority = (session: UnlockedVault, scope: ShareScope): SharingAuthority => {
  check(session, scope);
  return {session, scope, trustVersion: contactTrustVersion(session.accountId), cards: new Map()};
};
const checkAuthority = (access: SharingAuthority) => {
  check(access.session, access.scope);
  if (contactTrustVersion(access.session.accountId) !== access.trustVersion) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
};
async function captureCard(id: string, access: SharingAuthority) {
  checkAuthority(access);
  const card = validatePublicAccountCard(await trustedCard(id, access.session, access.scope)); checkAuthority(access);
  const captured = access.cards.get(id);
  if (captured && !sameIdentity(captured, card)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
  access.cards.set(id, card);
  return card;
}
async function checkTrust(access: SharingAuthority) {
  checkAuthority(access);
  // Re-read encrypted pins as well as checking local acceptance changes; another tab can update IndexedDB.
  for (const [id, captured] of access.cards) {
    const current = await trustedCard(id, access.session, access.scope); checkAuthority(access);
    if (!sameIdentity(current, captured)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
  }
  checkAuthority(access);
}
const orderedJSON = (value: unknown): unknown => Array.isArray(value) ? value.map(orderedJSON)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, orderedJSON(nested)])) : value;
const sameJSON = (left: unknown, right: unknown) => JSON.stringify(orderedJSON(left)) === JSON.stringify(orderedJSON(right));
function verifyOwnedSave(save: SavedPhotoV1, session: UnlockedVault) {
  if (!["photo-manifest", "photo-media-manifest-v1"].includes(save.signedPayload.kind) || save.signedPayload.accountId !== session.accountId ||
      save.manifest.ownerAccountId !== session.accountId || save.photoId !== save.manifest.photoId) throw new Error("SAVE_RECEIPT_MISMATCH");
  try {
    const plain = verifyPayload(save.signedPayload, unb64(session.card.signingPublicKey));
    try {
      const manifest = validateWire<PhotoManifestV1>("PhotoManifestV1", JSON.parse(new TextDecoder().decode(plain)));
      if (!sameJSON(manifest, save.manifest)) throw new Error("SAVE_RECEIPT_MISMATCH");
    } finally {plain.fill(0);}
  } catch {throw new Error("SAVE_RECEIPT_MISMATCH");}
}
async function scopedPut(store: "settings" | "saves", key: string, value: unknown, session: UnlockedVault, scope: ShareScope) {
  const database = await db(); check(session, scope);
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("STORAGE_ABORTED"));
  });
  check(session, scope);
}
async function saveRequestOnce(key: string, request: SaveRequestV1, session: UnlockedVault, scope: ShareScope) {
  const database = await db(); check(session, scope);
  const proposed = encrypt(request, session);
  const stored = await new Promise<WrappedKeyV1>((resolve, reject) => {
    // A readwrite transaction also serializes another tab saving the same source.
    const transaction = database.transaction("saves", "readwrite"), store = transaction.objectStore("saves");
    let value = proposed;
    const reading = store.get(key);
    reading.onsuccess = () => {
      if (reading.result !== undefined) value = reading.result;
      else store.put(proposed, key);
    };
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("STORAGE_ABORTED"));
  });
  check(session, scope);
  return validateWire<SaveRequestV1>("SaveRequestV1", decrypt(stored, session));
}
const encrypt = (value: unknown, session: UnlockedVault) => wrapKey(utf8(value), session.vaultKey);
const decrypt = <T,>(value: WrappedKeyV1, session: UnlockedVault): T => {const plain = unwrapKey(value, session.vaultKey); try {return JSON.parse(new TextDecoder().decode(plain));} finally {plain.fill(0);}};
const owned = (photos: readonly Photo[], session: UnlockedVault) => {
  if (!photos.length || photos.length > 100) throw new Error("SELECT_1_TO_100_PHOTOS");
  if (photos.some(photo => photo.grantId || photo.manifest.ownerAccountId !== session.accountId)) throw new Error("PHOTO_NOT_OWNED");
};
export function sharePhotos(photos: Photo[], recipient: AccountCardV1, access: "ongoing" | "temporary", scope: ShareScope = {}) {return diagnose("share", diagnostic => sharePhotosAction(photos, recipient, access, {...scope, diagnostic}), "create");}
async function sharePhotosAction(photos: Photo[], recipient: AccountCardV1, access: "ongoing" | "temporary", scope: ShareScope) {
  const api = scope.diagnostic ? scopedApi(scope.diagnostic) : rawApi;
  const session = requireVault(), authorization = authority(session, scope); owned(photos, session);
  recipient = validatePublicAccountCard(recipient);
  if (recipient.accountId === session.accountId) throw new Error("SHARE_OWN_ACCOUNT");
  const trusted = await captureCard(recipient.accountId, authorization);
  if (!sameIdentity(recipient, trusted)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
  const moment = crypto.randomUUID();
  const grant = await api<GrantV1>("/v1/moments/" + moment + "/grants/options", {version: 1, recipientAccountId: recipient.accountId, role: "contributor", access}, "GrantV1", "POST", scope.signal);
  await checkTrust(authorization);
  if (grant.ownerAccountId !== session.accountId || grant.recipientAccountId !== recipient.accountId || grant.momentId !== moment || grant.role !== "contributor" || grant.revokedAt !== null) throw new Error("GRANT_BINDING_MISMATCH");
  const envelopes = photos.map(photo => sealShareKey(photo.metadataKey, recipient, {version: 1, grantId: grant.grantId, photoId: photo.manifest.photoId, senderAccountId: session.accountId, recipientAccountId: recipient.accountId}, session.signingSecretKey));
  const result = await api<GrantV1>("/v1/moments/" + moment + "/grants", {version: 1, grant, envelopes, signedPayload: signPayload("grant", session.accountId, utf8({grant, envelopes}), session.signingSecretKey)}, "GrantV1", "POST", scope.signal);
  await checkTrust(authorization);
  if (!sameJSON(result, grant)) throw new Error("GRANT_BINDING_MISMATCH");
  return result;
}
export function receive(grantId: string, scope: ShareScope = {}, expectedSender?: AccountCardV1) {return diagnose("share", diagnostic => receiveAction(grantId, {...scope, diagnostic}, expectedSender), "receive");}
async function receiveAction(grantId: string, scope: ShareScope, expectedSender?: AccountCardV1) {
  const api = scope.diagnostic ? scopedApi(scope.diagnostic) : rawApi;
  return receiveWithAuthority(grantId, authority(requireVault(), scope), expectedSender);
}
async function receiveWithAuthority(grantId: string, authorization: SharingAuthority, expectedSender?: AccountCardV1) {
  const {session, scope} = authorization;
  const api = scope.diagnostic ? scopedApi(scope.diagnostic) : rawApi;
  if (expectedSender && !sameIdentity(await captureCard(expectedSender.accountId, authorization), expectedSender)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
  const detail = await api<GrantDetailV1>("/v1/grants/" + grantId + "?media=1", undefined, "GrantDetailV1", "GET", scope.signal); checkAuthority(authorization);
  if (detail.grant.grantId !== grantId) throw new Error("GRANT_BINDING_MISMATCH");
  if (detail.grant.ownerAccountId !== session.accountId && detail.grant.recipientAccountId !== session.accountId) throw new Error("INVITATION_RECIPIENT_MISMATCH");
  if (expectedSender && detail.grant.recipientAccountId !== session.accountId) throw new Error("INVITATION_RECIPIENT_MISMATCH");
  if (expectedSender && detail.grant.ownerAccountId !== expectedSender.accountId) throw new Error("INVITATION_SENDER_MISMATCH");
  if (expectedSender) {
    const sender = detail.cards.find(card => card.accountId === expectedSender.accountId);
    if (!sender || !sameIdentity(sender, expectedSender)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
  }
  const owner = await captureCard(detail.grant.ownerAccountId, authorization);
  const suppliedOwner = detail.cards.find(card => card.accountId === owner.accountId);
  if (!suppliedOwner || !sameIdentity(suppliedOwner, owner)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
  const photos: Photo[] = [];
  try {
    for (const payload of detail.manifests) {
      if (payload.accountId !== detail.grant.ownerAccountId && payload.accountId !== detail.grant.recipientAccountId) throw new Error("MANIFEST_PARTICIPANT_MISMATCH");
      const card = await captureCard(payload.accountId, authorization);
      const supplied = detail.cards.find(candidate => candidate.accountId === card.accountId);
      if (!supplied || !sameIdentity(supplied, card)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
      if (expectedSender && card.accountId === expectedSender.accountId && !sameIdentity(card, expectedSender)) throw new Error("INVITATION_SENDER_MISMATCH");
      acceptedPhotoManifestKind(payload.kind);
      const manifest = validateWire<PhotoManifestV1>("PhotoManifestV1", JSON.parse(new TextDecoder().decode(verifyPayload(payload, unb64(card.signingPublicKey)))));
      if (manifest.ownerAccountId !== card.accountId) throw new Error("MANIFEST_OWNER_MISMATCH");
      const envelope = detail.envelopes.find(item => item.photoId === manifest.photoId && item.recipientAccountId === session.accountId);
      if (!envelope) continue;
      checkAuthority(authorization);
      const key = openShareKey(envelope, session.boxSecretKey, card, {version: 1, grantId, photoId: manifest.photoId, senderAccountId: card.accountId, recipientAccountId: session.accountId});
      try {const photo = await readPhoto(manifest, key, grantId, scope.signal, scope.diagnostic); await checkTrust(authorization); photos.push(photo);} catch (error) {key.fill(0); throw error;}
    }
    await checkTrust(authorization);
    await api("/v1/grants/" + grantId + "/viewed", {}, undefined, "POST", scope.signal); await checkTrust(authorization);
    return {grant: detail.grant, photos};
  } catch (error) {for (const photo of photos) photo.metadataKey.fill(0); throw error;}
}
export function saveReceivedPhoto(grantId: string, photoId: string, scope: ShareScope = {}): Promise<SavedPhotoV1> {return diagnose("share", diagnostic => saveReceivedPhotoAction(grantId, photoId, {...scope, diagnostic}), "save");}
async function saveReceivedPhotoAction(grantId: string, photoId: string, scope: ShareScope): Promise<SavedPhotoV1> {
  const api = scope.diagnostic ? scopedApi(scope.diagnostic) : rawApi;
  const session = requireVault(), authorization = authority(session, scope), key = session.accountId + ":" + grantId + ":" + photoId;
  let request: SaveRequestV1;
  const saved = await get<WrappedKeyV1>("saves", key); checkAuthority(authorization);
  if (saved) request = validateWire<SaveRequestV1>("SaveRequestV1", decrypt(saved, session));
  else {
    const received = await receiveWithAuthority(grantId, authorization); checkAuthority(authorization);
    try {
      const photo = received.photos.find(item => item.manifest.photoId === photoId);
      if (!photo) throw new Error("PHOTO_NOT_GRANTED");
      const original = await photoBytes(photo, "original", scope.signal, scope.diagnostic); original.fill(0); await checkTrust(authorization);
      const manifest: PhotoManifestV1 = {...photo.manifest, photoId: crypto.randomUUID(), ownerAccountId: session.accountId, ownerWrappedMetadataKey: wrapKey(photo.metadataKey, session.vaultKey)};
      const save: SavedPhotoV1 = {version: 1, operationId: crypto.randomUUID(), photoId: manifest.photoId, sourceGrantId: grantId, sourcePhotoId: photoId, manifest, signedPayload: signPayload(photoManifestKind(photo.metadata), session.accountId, utf8(manifest), session.signingSecretKey)};
      request = {version: 1, expectedGrantVersion: received.grant.version, save};
      request = await saveRequestOnce(key, request, session, scope);
    } finally {for (const photo of received.photos) photo.metadataKey.fill(0);}
  }
  if (request.save.sourceGrantId !== grantId || request.save.sourcePhotoId !== photoId) throw new Error("SAVE_RECEIPT_MISMATCH");
  verifyOwnedSave(request.save, session);
  await checkTrust(authorization);
  const result = await api<SavedPhotoV1>("/v1/saves", request, "SavedPhotoV1", "POST", scope.signal); await checkTrust(authorization);
  verifyOwnedSave(result, session);
  if (result.operationId !== request.save.operationId || result.photoId !== request.save.photoId ||
      result.sourceGrantId !== request.save.sourceGrantId || result.sourcePhotoId !== request.save.sourcePhotoId ||
      !sameJSON(result.manifest, request.save.manifest)) throw new Error("SAVE_RECEIPT_MISMATCH");
  return result;
}
export function contribute(grant: GrantV1, photos: Photo[], scope: ShareScope = {}) {return diagnose("share", diagnostic => contributeAction(grant, photos, {...scope, diagnostic}), "contribute");}
async function contributeAction(grant: GrantV1, photos: Photo[], scope: ShareScope) {
  const api = scope.diagnostic ? scopedApi(scope.diagnostic) : rawApi;
  const session = requireVault(), authorization = authority(session, scope); owned(photos, session);
  if (grant.ownerAccountId !== session.accountId && grant.recipientAccountId !== session.accountId) throw new Error("INVITATION_RECIPIENT_MISMATCH");
  const recipientId = grant.ownerAccountId === session.accountId ? grant.recipientAccountId : grant.ownerAccountId;
  const recipient = await captureCard(recipientId, authorization);
  const key = session.accountId + ":contribution:" + grant.grantId + ":" + photos.map(photo => photo.manifest.photoId).sort().join(",");
  const stored = await get<WrappedKeyV1>("saves", key); await checkTrust(authorization);
  const request = validateWire<ContributionV1>("ContributionV1", stored ? decrypt(stored, session) : {version: 1, operationId: crypto.randomUUID(), expectedGrantVersion: grant.version, manifests: photos.map(photo => signPayload(photoManifestKind(photo.metadata), session.accountId, utf8(photo.manifest), session.signingSecretKey)), envelopes: photos.map(photo => sealShareKey(photo.metadataKey, recipient, {version: 1, grantId: grant.grantId, photoId: photo.manifest.photoId, senderAccountId: session.accountId, recipientAccountId: recipient.accountId}, session.signingSecretKey))});
  if (request.envelopes.some(envelope => envelope.grantId !== grant.grantId || envelope.senderAccountId !== session.accountId || envelope.recipientAccountId !== recipientId) ||
      request.manifests.some(manifest => manifest.accountId !== session.accountId)) throw new Error("GRANT_BINDING_MISMATCH");
  if (!stored) {await scopedPut("saves", key, encrypt(request, session), session, scope);}
  await checkTrust(authorization);
  const result = await api("/v1/moments/" + grant.momentId + "/contributions", request, undefined, "POST", scope.signal); await checkTrust(authorization); return result;
}
