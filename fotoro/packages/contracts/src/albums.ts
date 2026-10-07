import type {AccountCardV1, PhotoManifestV1, SignedPayloadV1, WrappedKeyV1} from "./models.js";
import {validatePublicAccountCard} from "./share-links.js";
import {validateWire, WireError} from "./validate.js";
import {acceptedPhotoManifestKind} from "./camera-media.js";

export const ALBUM_MAX_MEMBERS = 12;
export const ALBUM_MAX_PHOTOS = 1000;
export const ALBUM_PAGE_SIZE = 100;
export const ALBUM_DEFINITION_KIND = "album-v1";
export const ALBUM_PHOTO_KIND = "album-photo-v1";
export const ALBUM_ACCEPT_KIND = "album-accept-v1";
export const ALBUM_END_KIND = "album-end-v1";
export interface AlbumDefinitionV1 {version: 1; albumId: string; ownerAccountId: string; createdAt: string; encryptedTitle: WrappedKeyV1; members: {card: AccountCardV1; sealedAlbumKey: string}[]}
export interface AlbumPhotoV1 {version: 1; albumId: string; photoId: string; ownerAccountId: string; wrappedMetadataKey: WrappedKeyV1}
export interface AlbumActionV1 {version: 1; albumId: string; definitionSignature: string}
export interface CreateAlbumV1 {version: 1; definition: SignedPayloadV1}
export interface AlbumAppendV1 {version: 1; operationId: string; entries: SignedPayloadV1[]; manifests: SignedPayloadV1[]}
export interface AlbumActionRequestV1 {version: 1; action: SignedPayloadV1}
export interface AlbumAppendResultV1 {version: 1; albumId: string; operationId: string; added: number; photoCount: number}
export interface AlbumOverviewV1 {definition: SignedPayloadV1; membership: "invited" | "accepted"; endedAt: string | null; photoCount: number}
export interface AlbumInboxV1 {version: 1; albums: AlbumOverviewV1[]}
export interface AlbumDetailV1 extends AlbumOverviewV1 {version: 1; entries: SignedPayloadV1[]; manifests: SignedPayloadV1[]; nextCursor: string | null; hasMore: boolean}
const invalid = (): never => {throw new WireError("Invalid album");};
export function albumUUID(value: unknown): value is string {return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);}
function exact(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.slice().sort().join(",")) invalid();
}
export function albumBase64(value: unknown, minimum: number, maximum = minimum): string {
  if (typeof value !== "string" || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return invalid();
  try {
    const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    const canonical = btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (raw.length < minimum || raw.length > maximum || canonical !== value) return invalid();
    return value;
  } catch {return invalid();}
}
function timestamp(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
}
function wrapped(value: unknown, minimum: number, maximum = minimum): WrappedKeyV1 {
  exact(value, ["version", "nonce", "ciphertext"]);
  if (value.version !== 1) invalid();
  albumBase64(value.nonce, 24); albumBase64(value.ciphertext, minimum, maximum);
  return value as WrappedKeyV1;
}
export function validateAlbumTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > 80 || /[\u0000-\u001f\u007f]/.test(value) || /[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) return invalid();
  return value;
}
export function validateAlbumDefinition(value: unknown): AlbumDefinitionV1 {
  exact(value, ["version", "albumId", "ownerAccountId", "createdAt", "encryptedTitle", "members"]);
  if (value.version !== 1 || !albumUUID(value.albumId) || !albumUUID(value.ownerAccountId) || !Array.isArray(value.members) || value.members.length < 2 || value.members.length > ALBUM_MAX_MEMBERS) invalid();
  timestamp(value.createdAt); wrapped(value.encryptedTitle, 17, 336);
  const accounts = new Set(), boxes = new Set(), signs = new Set();
  for (const member of value.members) {
    exact(member, ["card", "sealedAlbumKey"]);
    const card = validatePublicAccountCard(member.card); albumBase64(member.sealedAlbumKey, 80);
    if (accounts.has(card.accountId) || boxes.has(card.boxPublicKey) || signs.has(card.signingPublicKey)) invalid();
    accounts.add(card.accountId); boxes.add(card.boxPublicKey); signs.add(card.signingPublicKey);
  }
  if (!accounts.has(value.ownerAccountId)) invalid();
  return value as AlbumDefinitionV1;
}
export function validateAlbumPhoto(value: unknown): AlbumPhotoV1 {
  exact(value, ["version", "albumId", "photoId", "ownerAccountId", "wrappedMetadataKey"]);
  if (value.version !== 1 || !albumUUID(value.albumId) || !albumUUID(value.photoId) || !albumUUID(value.ownerAccountId)) invalid();
  wrapped(value.wrappedMetadataKey, 48); return value as AlbumPhotoV1;
}
export function validateAlbumAction(value: unknown): AlbumActionV1 {
  exact(value, ["version", "albumId", "definitionSignature"]);
  if (value.version !== 1 || !albumUUID(value.albumId)) invalid();
  albumBase64(value.definitionSignature, 64); return value as AlbumActionV1;
}
export function validateAlbumSigned(value: unknown, kind: string): SignedPayloadV1 {
  exact(value, ["version", "kind", "accountId", "body", "signature"]);
  if (value.version !== 1 || value.kind !== kind || !albumUUID(value.accountId)) invalid();
  albumBase64(value.signature, 64); albumBase64(value.body, 1, 32768);
  return value as SignedPayloadV1;
}
// Older signed originals permit JSON whitespace/escaping. Preserve those bytes,
// while rejecting duplicate keys even when their spellings use different escapes.
function uniqueJSONKeys(json: string) {
  let position = 0;
  const space = () => {while (position < json.length && " \t\r\n".includes(json[position])) position++;};
  const string = (): string => {
    space(); const start = position;
    if (json[position++] !== '"') return invalid();
    while (position < json.length) {
      if (json[position] === "\\") {position += 2; continue;}
      if (json[position++] === '"') return JSON.parse(json.slice(start, position));
    }
    return invalid();
  };
  const value = (depth: number): void => {
    space(); if (depth > 32 || position >= json.length) invalid();
    if (json[position] === '"') {string(); return;}
    if (json[position] === "{" || json[position] === "[") {
      const object = json[position++] === "{", end = object ? "}" : "]", keys = new Set<string>();
      space(); if (json[position] === end) {position++; return;}
      for (;;) {
        if (object) {
          const key = string(); if (keys.has(key)) invalid(); keys.add(key);
          space(); if (json[position++] !== ":") invalid();
        }
        value(depth + 1); space();
        if (json[position] === end) {position++; return;}
        if (json[position++] !== ",") invalid();
      }
    }
    const start = position;
    while (position < json.length && !" \t\r\n,]}".includes(json[position])) position++;
    if (start === position) invalid();
  };
  value(0); space(); if (position !== json.length) invalid();
}
// This parses bounded exact JSON; it does not authenticate a signature.
export function readAlbumSignedBody<T>(value: unknown, kind: string, validator: (body: unknown) => T): T {
  const signed = validateAlbumSigned(value, kind);
  try {
    const bytes = Uint8Array.from(atob(signed.body.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - signed.body.length % 4) % 4)), c => c.charCodeAt(0));
    const json = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes), parsed = JSON.parse(json);
    if (JSON.stringify(parsed) !== json) {
      if (kind !== "photo-manifest" && kind !== "photo-media-manifest-v1") invalid();
      uniqueJSONKeys(json);
    }
    return validator(parsed);
  } catch {return invalid();}
}
export function validateCreateAlbum(value: unknown): CreateAlbumV1 {
  exact(value, ["version", "definition"]); if (value.version !== 1) invalid();
  const definition = readAlbumSignedBody(value.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition);
  if (value.definition.accountId !== definition.ownerAccountId) invalid();
  return value as CreateAlbumV1;
}
function entries(entries: unknown, manifests: unknown, maximum: number, minimum: number) {
  if (!Array.isArray(entries) || !Array.isArray(manifests)) return invalid();
  if (entries.length < minimum || entries.length > maximum || entries.length !== manifests.length) invalid();
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = readAlbumSignedBody(entries[i], ALBUM_PHOTO_KIND, validateAlbumPhoto);
    let kind: string;
    try {kind = acceptedPhotoManifestKind(manifests[i]?.kind);} catch {return invalid();}
    const manifest = readAlbumSignedBody(manifests[i], kind, body => validateWire<PhotoManifestV1>("PhotoManifestV1", body));
    if (seen.has(entry.photoId) || entry.photoId !== manifest.photoId || entry.ownerAccountId !== manifest.ownerAccountId || entries[i].accountId !== entry.ownerAccountId || manifests[i].accountId !== entry.ownerAccountId) invalid();
    seen.add(entry.photoId);
  }
}
export function validateAlbumAppend(value: unknown): AlbumAppendV1 {
  exact(value, ["version", "operationId", "entries", "manifests"]);
  if (value.version !== 1 || !albumUUID(value.operationId)) invalid();
  entries(value.entries, value.manifests, ALBUM_PAGE_SIZE, 1);
  const albumIDs = new Set(value.entries.map((entry: unknown) => readAlbumSignedBody(entry, ALBUM_PHOTO_KIND, validateAlbumPhoto).albumId));
  if (albumIDs.size !== 1) invalid();
  return value as AlbumAppendV1;
}
export function validateAlbumActionRequest(value: unknown, kind: typeof ALBUM_ACCEPT_KIND | typeof ALBUM_END_KIND): AlbumActionRequestV1 {
  exact(value, ["version", "action"]); if (value.version !== 1) invalid();
  readAlbumSignedBody(value.action, kind, validateAlbumAction); return value as AlbumActionRequestV1;
}
export function validateAlbumAppendResult(value: unknown): AlbumAppendResultV1 {
  exact(value, ["version", "albumId", "operationId", "added", "photoCount"]);
  if (value.version !== 1 || !albumUUID(value.albumId) || !albumUUID(value.operationId) || !Number.isSafeInteger(value.added) || value.added < 0 || value.added > ALBUM_PAGE_SIZE || !Number.isSafeInteger(value.photoCount) || value.photoCount < value.added || value.photoCount > ALBUM_MAX_PHOTOS) invalid();
  return value as AlbumAppendResultV1;
}
function overview(value: Record<string, any>) {
  const definition = readAlbumSignedBody(value.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition);
  if (value.definition.accountId !== definition.ownerAccountId || !["invited", "accepted"].includes(value.membership) || !Number.isSafeInteger(value.photoCount) || value.photoCount < 0 || value.photoCount > ALBUM_MAX_PHOTOS) invalid();
  if (value.endedAt !== null) timestamp(value.endedAt);
}
export function validateAlbumOverview(value: unknown): AlbumOverviewV1 {
  exact(value, ["definition", "membership", "endedAt", "photoCount"]); overview(value); return value as AlbumOverviewV1;
}
export function validateAlbumInbox(value: unknown): AlbumInboxV1 {
  exact(value, ["version", "albums"]); if (value.version !== 1 || !Array.isArray(value.albums) || value.albums.length > 100) invalid();
  const ids = new Set();
  for (const album of value.albums) {validateAlbumOverview(album); const id = readAlbumSignedBody(album.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition).albumId; if (ids.has(id)) invalid(); ids.add(id);}
  return value as AlbumInboxV1;
}
export function validateAlbumDetail(value: unknown): AlbumDetailV1 {
  exact(value, ["version", "definition", "membership", "endedAt", "photoCount", "entries", "manifests", "nextCursor", "hasMore"]); overview(value);
  if (value.version !== 1 || typeof value.hasMore !== "boolean" || (value.nextCursor !== null && (typeof value.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value.nextCursor))) || value.hasMore !== (value.nextCursor !== null) || value.membership !== "accepted" || value.endedAt !== null) invalid();
  entries(value.entries, value.manifests, ALBUM_PAGE_SIZE, 0);
  const definition = readAlbumSignedBody(value.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition);
  if (value.entries.length > value.photoCount || value.entries.some((entry: unknown) => {const photo = readAlbumSignedBody(entry, ALBUM_PHOTO_KIND, validateAlbumPhoto); return photo.albumId !== definition.albumId || !definition.members.some(member => member.card.accountId === photo.ownerAccountId);})) invalid();
  return value as AlbumDetailV1;
}
