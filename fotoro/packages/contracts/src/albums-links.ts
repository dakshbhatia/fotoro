import type {AccountCardV1} from "./models.js";
import {FOTORO_SHARE_ORIGIN, SHARE_LINK_MAX_LENGTH, ShareLinkError, validatePublicAccountCard, createContactLink} from "./share-links.js";
export interface FotoroAlbumInvitation {version: 1; albumId: string; ownerCard: AccountCardV1}
const invalid = (): never => {throw new ShareLinkError();};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
function decoded(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 1366 || value.length % 4 === 1) return invalid();
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  if (raw.length > 1024 || btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== value) return invalid();
  return raw;
}
function payload(value: unknown): FotoroAlbumInvitation {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "albumId,ownerCard,version") return invalid();
  const result = value as FotoroAlbumInvitation;
  if (result.version !== 1 || !uuid(result.albumId)) return invalid();
  return {albumId: result.albumId, ownerCard: validatePublicAccountCard(result.ownerCard), version: 1};
}
function prefix(origin: string, card: AccountCardV1) {
  // Reuse the established strict origin validator without modifying legacy links.
  createContactLink(card, origin); return origin + "/#album=";
}
export function createAlbumLink(albumId: string, ownerCard: AccountCardV1, origin = FOTORO_SHARE_ORIGIN): string {
  const value = payload({version: 1, albumId, ownerCard});
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const result = prefix(origin, ownerCard) + encoded;
  if (result.length > SHARE_LINK_MAX_LENGTH) return invalid(); return result;
}
export function parseAlbumLink(value: string, expectedOrigin = FOTORO_SHARE_ORIGIN): FotoroAlbumInvitation {
  if (typeof value !== "string" || value.length > SHARE_LINK_MAX_LENGTH) return invalid();
  const start = expectedOrigin + "/#album="; if (!value.startsWith(start)) return invalid();
  try {
    const raw = decoded(value.slice(start.length));
    const json = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(Uint8Array.from(raw, c => c.charCodeAt(0)));
    const result = payload(JSON.parse(json)); prefix(expectedOrigin, result.ownerCard);
    if (JSON.stringify(result) !== json) return invalid(); return result;
  } catch {return invalid();}
}
