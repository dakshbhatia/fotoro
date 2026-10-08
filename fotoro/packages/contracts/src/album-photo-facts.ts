import type {SignedPayloadV1, WrappedKeyV1} from "./models.js";
import {albumUUID, albumBase64, readAlbumSignedBody} from "./albums.js";
import {validatedPhotoLocation, type PhotoLocationV1} from "./location.js";
import {WireError} from "./validate.js";

export const ALBUM_FACTS_KIND = "album-photo-facts-v1";
export const ALBUM_FACTS_MAX_CIPHERTEXT = 8192;
export const ALBUM_FACTS_PAGE_SIZE = 100;
export interface AlbumPhotoFactsContextV1 {version: 1; albumId: string; photoId: string; ownerAccountId: string; definitionSignature: string; revision: number}
export interface AlbumPhotoFactsV1 extends AlbumPhotoFactsContextV1 {encrypted: WrappedKeyV1}
export interface AlbumPhotoFactsContentV1 extends AlbumPhotoFactsContextV1 {originalSha256: string; people: string[]; location?: PhotoLocationV1}
export interface AlbumPhotoFactsRequestV1 {version: 1; facts: SignedPayloadV1}
export interface AlbumPhotoFactsReplyV1 {version: 1; facts: SignedPayloadV1 | null}
export interface AlbumPhotoFactsPageV1 {version: 1; facts: SignedPayloadV1[]; nextCursor: string | null; hasMore: boolean}
const invalid = (): never => {throw new WireError("Invalid album photo facts");};
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) invalid();
}
const contextKeys = ["version", "albumId", "photoId", "ownerAccountId", "definitionSignature", "revision"];
function context(value: Record<string, any>) {
  if (value.version !== 1 || !albumUUID(value.albumId) || !albumUUID(value.photoId) || !albumUUID(value.ownerAccountId) || !Number.isInteger(value.revision) || value.revision < 1 || value.revision > 2147483647) invalid();
  albumBase64(value.definitionSignature, 64);
}
export function validateAlbumPhotoFacts(value: unknown): AlbumPhotoFactsV1 {
  exact(value, [...contextKeys, "encrypted"]); context(value);
  exact(value.encrypted, ["version", "nonce", "ciphertext"]);
  if (value.encrypted.version !== 1) invalid();
  albumBase64(value.encrypted.nonce, 24); albumBase64(value.encrypted.ciphertext, 17, ALBUM_FACTS_MAX_CIPHERTEXT);
  return value as AlbumPhotoFactsV1;
}
export function validateAlbumPhotoFactsContent(value: unknown): AlbumPhotoFactsContentV1 {
  if (!value || typeof value !== "object") return invalid();
  exact(value, [...contextKeys, "originalSha256", "people", ...(Object.hasOwn(value, "location") ? ["location"] : [])]); context(value);
  albumBase64(value.originalSha256, 32);
  if (!Array.isArray(value.people) || value.people.length > 12 || new Set(value.people).size !== value.people.length || value.people.some((name: unknown) => typeof name !== "string" || !name.trim() || [...name].length > 80 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(name))) invalid();
  if (Object.hasOwn(value, "location") && !validatedPhotoLocation(value.location)) invalid();
  return value as AlbumPhotoFactsContentV1;
}
export function readAlbumPhotoFacts(value: unknown): AlbumPhotoFactsV1 {return readAlbumSignedBody(value, ALBUM_FACTS_KIND, validateAlbumPhotoFacts);}
export function validateAlbumPhotoFactsRequest(value: unknown): AlbumPhotoFactsRequestV1 {
  exact(value, ["version", "facts"]); if (value.version !== 1) invalid(); readAlbumPhotoFacts(value.facts); return value as AlbumPhotoFactsRequestV1;
}
export function validateAlbumPhotoFactsReply(value: unknown): AlbumPhotoFactsReplyV1 {
  exact(value, ["version", "facts"]); if (value.version !== 1) invalid(); if (value.facts !== null) readAlbumPhotoFacts(value.facts); return value as AlbumPhotoFactsReplyV1;
}
export function validateAlbumPhotoFactsPage(value: unknown): AlbumPhotoFactsPageV1 {
  exact(value, ["version", "facts", "nextCursor", "hasMore"]);
  if (value.version !== 1 || !Array.isArray(value.facts) || value.facts.length > ALBUM_FACTS_PAGE_SIZE || typeof value.hasMore !== "boolean" || (value.hasMore ? typeof value.nextCursor !== "string" || !/^[1-9][0-9]{0,14}$/.test(value.nextCursor) || !value.facts.length : value.nextCursor !== null)) invalid();
  const ids = new Set();
  for (const signed of value.facts) {const facts = readAlbumPhotoFacts(signed); if (ids.has(facts.photoId)) invalid(); ids.add(facts.photoId);}
  return value as AlbumPhotoFactsPageV1;
}
