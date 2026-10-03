import type { AccountCardV1 } from "./models.js";

export const FOTORO_SHARE_ORIGIN = "https://fotoro.cloud";
export const SHARE_LINK_MAX_LENGTH = 2048;
export interface FotoroMomentInvitation {
  version: 1;
  grantId: string;
  senderCard: AccountCardV1;
}
export type FotoroShareLink =
  | { kind: "contact"; card: AccountCardV1 }
  | { kind: "moment"; grantId: string; senderCard: AccountCardV1 };
export class ShareLinkError extends Error {
  readonly code = "INVALID_SHARE_LINK";
  constructor() { super("This Fotoro link is invalid or belongs to another service."); }
}

const invalid = (): never => { throw new ShareLinkError(); };
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decoded(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value.length || value.length > SHARE_LINK_MAX_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return invalid();
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
    if (base64url(bytes) !== value) return invalid();
    return bytes;
  } catch { return invalid(); }
}
/** Validates public identity only. Callers must ask the user before pinning keys. */
export function validatePublicAccountCard(value: unknown): AccountCardV1 {
  if (!exactKeys(value, ["accountId", "boxPublicKey", "signingPublicKey", "version"]) ||
      value.version !== 1 || !uuid(value.accountId)) return invalid();
  for (const key of [value.boxPublicKey, value.signingPublicKey]) {
    if (typeof key !== "string" || key.length !== 43 || decoded(key).length !== 32) return invalid();
  }
  // Alphabetical property order is shared with Swift's JSONEncoder.sortedKeys.
  return { accountId: value.accountId, boxPublicKey: value.boxPublicKey as string,
    signingPublicKey: value.signingPublicKey as string, version: 1 };
}
function invitation(value: unknown): FotoroMomentInvitation {
  if (!exactKeys(value, ["grantId", "senderCard", "version"]) || value.version !== 1 || !uuid(value.grantId)) return invalid();
  return { grantId: value.grantId, senderCard: validatePublicAccountCard(value.senderCard), version: 1 };
}
function checkedOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const namedHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host) && /[a-z]/.test(host.split(".").at(-1)!);
    if (url.origin !== origin || url.href !== origin + "/" || url.username || url.password ||
        !(namedHost || ["127.0.0.1", "[::1]"].includes(host)) ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return invalid();
    return origin;
  } catch { return invalid(); }
}
function encode(kind: "contact" | "moment", value: unknown, origin: string): string {
  const result = checkedOrigin(origin) + "/#" + kind + "=" + base64url(new TextEncoder().encode(JSON.stringify(value)));
  if (result.length > SHARE_LINK_MAX_LENGTH) return invalid();
  return result;
}
export function createContactLink(card: AccountCardV1, origin = FOTORO_SHARE_ORIGIN): string {
  return encode("contact", validatePublicAccountCard(card), origin);
}
export function createMomentLink(grantId: string, senderCard: AccountCardV1, origin = FOTORO_SHARE_ORIGIN): string {
  return encode("moment", invitation({ version: 1, grantId, senderCard }), origin);
}
/** Strict canonical parsing rejects hidden fields, duplicate JSON/fragment keys and URL normalization tricks. */
export function parseShareLink(value: string, expectedOrigin = FOTORO_SHARE_ORIGIN): FotoroShareLink {
  const prefix = checkedOrigin(expectedOrigin) + "/#";
  if (typeof value !== "string" || value.length > SHARE_LINK_MAX_LENGTH || !value.startsWith(prefix)) return invalid();
  const match = /^(contact|moment)=([A-Za-z0-9_-]+)$/.exec(value.slice(prefix.length));
  if (!match) return invalid();
  try {
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decoded(match[2]));
    const parsed: unknown = JSON.parse(json);
    const payload = match[1] === "contact" ? validatePublicAccountCard(parsed) : invitation(parsed);
    if (JSON.stringify(payload) !== json) return invalid();
    return match[1] === "contact" ? { kind: "contact", card: payload as AccountCardV1 }
      : { kind: "moment", grantId: (payload as FotoroMomentInvitation).grantId, senderCard: (payload as FotoroMomentInvitation).senderCard };
  } catch { return invalid(); }
}
