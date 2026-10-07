import type {AccountCardV1, PhotoManifestV1, SignedPayloadV1} from "../../contracts/src/models.js";
import {ALBUM_MAX_MEMBERS, ALBUM_DEFINITION_KIND, ALBUM_PHOTO_KIND, ALBUM_ACCEPT_KIND, ALBUM_END_KIND, readAlbumSignedBody, validateAlbumDefinition, validateAlbumPhoto, validateAlbumAction, validateAlbumTitle, type AlbumDefinitionV1, type AlbumPhotoV1, type AlbumActionV1} from "../../contracts/src/albums.js";
import {validatePublicAccountCard} from "../../contracts/src/share-links.js";
import {acceptedPhotoManifestKind} from "../../contracts/src/camera-media.js";
import {validateWire} from "../../contracts/src/validate.js";
import {sodium, b64, unb64, utf8, key32, CryptoError} from "./common.js";
import {wrapKey, unwrapKey} from "./envelopes.js";
import {signPayload, verifyPayload} from "./signatures.js";
const same = (left: AccountCardV1, right: AccountCardV1) => left.accountId === right.accountId && left.signingPublicKey === right.signingPublicKey && left.boxPublicKey === right.boxPublicKey;
function checked<T>(signed: SignedPayloadV1, kind: string, card: AccountCardV1, validator: (value: unknown) => T): T {
  validatePublicAccountCard(card);
  if (signed.kind !== kind || signed.accountId !== card.accountId) throw new CryptoError("WRONG_ALBUM_SIGNER");
  const body = readAlbumSignedBody(signed, kind, validator);
  verifyPayload(signed, unb64(card.signingPublicKey));
  return body;
}
function signingKey(card: AccountCardV1, secretKey: Uint8Array) {
  if (secretKey.length !== 64 || b64(sodium.crypto_sign_ed25519_sk_to_pk(secretKey)) !== card.signingPublicKey) throw new CryptoError("WRONG_ALBUM_SIGNER");
}
export function verifyAlbumDefinition(signed: SignedPayloadV1, trustedOwner: AccountCardV1): AlbumDefinitionV1 {
  const definition = checked(signed, ALBUM_DEFINITION_KIND, trustedOwner, validateAlbumDefinition);
  const owner = definition.members.find(member => member.card.accountId === definition.ownerAccountId);
  if (definition.ownerAccountId !== trustedOwner.accountId || !owner || !same(owner.card, trustedOwner)) throw new CryptoError("WRONG_ALBUM_OWNER");
  return definition;
}
export function makeAlbumDefinition(input: {albumId: string; title: string; createdAt: string; ownerCard: AccountCardV1; members: readonly AccountCardV1[]; signingSecretKey: Uint8Array}): {definition: AlbumDefinitionV1; signed: SignedPayloadV1; albumKey: Uint8Array} {
  validatePublicAccountCard(input.ownerCard); signingKey(input.ownerCard, input.signingSecretKey); validateAlbumTitle(input.title);
  if (!Array.isArray(input.members) || input.members.length < 2 || input.members.length > ALBUM_MAX_MEMBERS) throw new CryptoError("INVALID_ALBUM_MEMBERS");
  const albumKey = sodium.randombytes_buf(32);
  const titleBytes = new TextEncoder().encode(input.title);
  try {
    const definition = validateAlbumDefinition({version: 1, albumId: input.albumId, ownerAccountId: input.ownerCard.accountId, createdAt: input.createdAt,
      encryptedTitle: wrapKey(titleBytes, albumKey),
      members: input.members.map(card => {validatePublicAccountCard(card); return {card: {...card}, sealedAlbumKey: b64(sodium.crypto_box_seal(albumKey, unb64(card.boxPublicKey)))};})});
    const owner = definition.members.find(member => member.card.accountId === input.ownerCard.accountId);
    if (!owner || !same(owner.card, input.ownerCard)) throw new CryptoError("WRONG_ALBUM_OWNER");
    return {definition, signed: signPayload(ALBUM_DEFINITION_KIND, definition.ownerAccountId, utf8(definition), input.signingSecretKey), albumKey};
  } catch (error) {albumKey.fill(0); throw error;} finally {titleBytes.fill(0);}
}
export function openAlbumDefinition(input: {signed: SignedPayloadV1; trustedOwner: AccountCardV1; recipientCard: AccountCardV1; recipientSecretKey: Uint8Array; expectedAlbumId: string; trustedMembers?: readonly AccountCardV1[]}): {definition: AlbumDefinitionV1; albumKey: Uint8Array; title: string} {
  const definition = verifyAlbumDefinition(input.signed, input.trustedOwner);
  if (definition.albumId !== input.expectedAlbumId) throw new CryptoError("WRONG_ALBUM_BINDING");
  validatePublicAccountCard(input.recipientCard); key32(input.recipientSecretKey);
  const member = definition.members.find(member => member.card.accountId === input.recipientCard.accountId);
  if (!member || !same(member.card, input.recipientCard) || b64(sodium.crypto_scalarmult_base(input.recipientSecretKey)) !== member.card.boxPublicKey) throw new CryptoError("WRONG_ALBUM_MEMBER");
  for (const trusted of input.trustedMembers ?? []) {
    validatePublicAccountCard(trusted);
    const declared = definition.members.find(member => member.card.accountId === trusted.accountId);
    if (!declared || !same(declared.card, trusted)) throw new CryptoError("ALBUM_MEMBER_KEYS_CHANGED");
  }
  const albumKey = sodium.crypto_box_seal_open(unb64(member.sealedAlbumKey), unb64(member.card.boxPublicKey), input.recipientSecretKey);
  let titleBytes: Uint8Array | undefined;
  try {key32(albumKey); titleBytes = unwrapKey(definition.encryptedTitle, albumKey); const title = validateAlbumTitle(new TextDecoder("utf-8", {fatal: true}).decode(titleBytes)); return {definition, albumKey, title};}
  catch (error) {albumKey.fill(0); throw error;}
  finally {titleBytes?.fill(0);}
}
function manifestBody(signed: SignedPayloadV1, definition: AlbumDefinitionV1): {manifest: PhotoManifestV1; card: AccountCardV1} {
  const member = definition.members.find(member => member.card.accountId === signed.accountId);
  if (!member) throw new CryptoError("WRONG_ALBUM_MEMBER");
  const manifest = checked(signed, acceptedPhotoManifestKind(signed.kind), member.card, body => validateWire<PhotoManifestV1>("PhotoManifestV1", body));
  if (manifest.ownerAccountId !== member.card.accountId) throw new CryptoError("WRONG_ALBUM_PHOTO_OWNER");
  return {manifest, card: member.card};
}
// Callers obtain definition/key from make/openAlbumDefinition and fence accepted
// membership/current account before network dispatch. These helpers do not grant access.
export function makeAlbumPhoto(input: {definition: AlbumDefinitionV1; manifest: SignedPayloadV1; metadataKey: Uint8Array; albumKey: Uint8Array; signingSecretKey: Uint8Array}): SignedPayloadV1 {
  validateAlbumDefinition(input.definition); key32(input.metadataKey); key32(input.albumKey);
  const {manifest, card} = manifestBody(input.manifest, input.definition); signingKey(card, input.signingSecretKey);
  const photo = validateAlbumPhoto({version: 1, albumId: input.definition.albumId, photoId: manifest.photoId, ownerAccountId: manifest.ownerAccountId, wrappedMetadataKey: wrapKey(input.metadataKey, input.albumKey)});
  return signPayload(ALBUM_PHOTO_KIND, card.accountId, utf8(photo), input.signingSecretKey);
}
export function verifyAlbumPhoto(input: {definition: AlbumDefinitionV1; entry: SignedPayloadV1; manifest: SignedPayloadV1}): {photo: AlbumPhotoV1; manifest: PhotoManifestV1} {
  validateAlbumDefinition(input.definition);
  const {manifest, card} = manifestBody(input.manifest, input.definition);
  const photo = checked(input.entry, ALBUM_PHOTO_KIND, card, validateAlbumPhoto);
  if (photo.albumId !== input.definition.albumId || photo.photoId !== manifest.photoId || photo.ownerAccountId !== manifest.ownerAccountId) throw new CryptoError("WRONG_ALBUM_BINDING");
  return {photo, manifest};
}
export function openAlbumPhoto(input: {definition: AlbumDefinitionV1; entry: SignedPayloadV1; manifest: SignedPayloadV1; albumKey: Uint8Array}): Uint8Array {
  key32(input.albumKey); const {photo} = verifyAlbumPhoto(input);
  const metadataKey = unwrapKey(photo.wrappedMetadataKey, input.albumKey);
  try {key32(metadataKey); return metadataKey;} catch (error) {metadataKey.fill(0); throw error;}
}
export function makeAlbumAction(input: {signedDefinition: SignedPayloadV1; trustedOwner: AccountCardV1; memberCard: AccountCardV1; signingSecretKey: Uint8Array; action: "accept" | "end"}): SignedPayloadV1 {
  if (input.action !== "accept" && input.action !== "end") throw new CryptoError("INVALID_ALBUM_ACTION");
  const definition = verifyAlbumDefinition(input.signedDefinition, input.trustedOwner), member = definition.members.find(member => member.card.accountId === input.memberCard.accountId);
  if (!member || !same(member.card, input.memberCard) || input.action === "end" && input.memberCard.accountId !== definition.ownerAccountId) throw new CryptoError("WRONG_ALBUM_MEMBER");
  signingKey(member.card, input.signingSecretKey);
  return signPayload(input.action === "accept" ? ALBUM_ACCEPT_KIND : ALBUM_END_KIND, member.card.accountId, utf8(validateAlbumAction({version: 1, albumId: definition.albumId, definitionSignature: input.signedDefinition.signature})), input.signingSecretKey);
}
export function verifyAlbumAction(input: {signedDefinition: SignedPayloadV1; trustedOwner: AccountCardV1; signed: SignedPayloadV1; action: "accept" | "end"}): AlbumActionV1 {
  if (input.action !== "accept" && input.action !== "end") throw new CryptoError("INVALID_ALBUM_ACTION");
  const definition = verifyAlbumDefinition(input.signedDefinition, input.trustedOwner), member = definition.members.find(member => member.card.accountId === input.signed.accountId);
  if (!member || input.action === "end" && member.card.accountId !== definition.ownerAccountId) throw new CryptoError("WRONG_ALBUM_MEMBER");
  const action = checked(input.signed, input.action === "accept" ? ALBUM_ACCEPT_KIND : ALBUM_END_KIND, member.card, validateAlbumAction);
  if (action.albumId !== definition.albumId || action.definitionSignature !== input.signedDefinition.signature) throw new CryptoError("WRONG_ALBUM_BINDING");
  return action;
}
