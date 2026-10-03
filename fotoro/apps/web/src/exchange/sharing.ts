import type { AccountCardV1, GrantV1 } from "@fotoro/contracts";
import type { FotoroShareLink } from "@fotoro/contracts/share-links";
import type { Photo } from "../library/catalog";

export const sameIdentity = (a: AccountCardV1, b: AccountCardV1) =>
  a.accountId === b.accountId && a.boxPublicKey === b.boxPublicKey && a.signingPublicKey === b.signingPublicKey;
export const identityLabel = (card: AccountCardV1) => `${card.accountId.slice(0, 8)} · ${card.signingPublicKey.slice(0, 8)}`;
export function grantState(grant: GrantV1, now = Date.now()) {
  if (grant.revokedAt) return "Access ended";
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) return "Expired";
  return grant.expiresAt ? `Until ${new Date(grant.expiresAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}` : "Ongoing";
}
export function readableShareError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (error instanceof Error && error.name === "AbortError") return "";
  const messages: Record<string, string> = {
    GRANT_INACTIVE: "These photos are unavailable. Access may have ended, or this invitation belongs to another Fotoro password.",
    FORBIDDEN: "This invitation belongs to another Fotoro account. Try the password it was sent to.",
    AUTHENTICATION_REQUIRED: "Enter your Fotoro password to open these photos.",
    HTTP_401: "Enter your Fotoro password to open these photos.",
    VAULT_LOCKED: "Fotoro is locked. Enter your password again.",
    PIN_ACCOUNT_CARD_FROM_TRUSTED_CHANNEL: "Get this person’s contact link before opening their photos.",
    ACCOUNT_KEYS_CHANGED_RENEW_TRUST: "This person’s identity has changed. Ask them for a new contact link and accept it before continuing.",
    INVITATION_SENDER_MISMATCH: "This invitation does not match the sender’s identity.",
    INVITATION_RECIPIENT_MISMATCH: "This invitation belongs to another Fotoro password.",
    SHARE_OWN_ACCOUNT: "Choose another person’s contact link.",
    SELECT_1_TO_100_PHOTOS: "Choose between 1 and 100 saved photos.",
    PHOTO_NOT_OWNED: "Save these photos to your library before sharing them.",
    PHOTO_NOT_GRANTED: "This photo is no longer available in the invitation.",
    VERSION_CONFLICT: "Access changed while you were working. Open the invitation again.",
    PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED: "Private uploads are disabled in the public test account.",
    SHARE_LINK_INVALID: "That link could not be opened. Ask the sender for a new Fotoro link.",
    CONTACT_NAME_TOO_LONG: "Use a contact name with 80 characters or fewer.",
    SHARE_LINK_COPY_UNAVAILABLE: "Copy is unavailable in this browser. Select and copy the link below.",
  };
  if (messages[code]) return messages[code];
  if (/SIGNATURE|MISMATCH|BINDING|INVALID_MANIFEST|INVALID_WIRE/.test(code)) return "These photos could not be verified. Ask the sender for a new invitation.";
  return "Sharing could not finish. Check your connection and try again.";
}

function freezePublic<T>(value: T): T {
  if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) freezePublic(child);
    Object.freeze(value);
  }
  return value;
}

// A Share click keeps its own photo/key snapshot until the sheet is closed.
export class ShareSelection {
  readonly photos: Photo[];
  private disposed = false;
  constructor(photos: readonly Photo[]) {
    this.photos = photos.map(photo => ({...photo, manifest: structuredClone(photo.manifest), metadata: structuredClone(photo.metadata), metadataKey: new Uint8Array(photo.metadataKey)}));
    for (const photo of this.photos) {freezePublic(photo.manifest); freezePublic(photo.metadata); Object.freeze(photo);}
    Object.freeze(this.photos);
  }
  get current() {return !this.disposed;}
  dispose() {if (!this.disposed) {this.disposed = true; for (const photo of this.photos) photo.metadataKey.fill(0);}}
}

// Public links survive only their own password unlock; acceptance stays explicit.
export class IncomingShareIntent {
  readonly link: FotoroShareLink;
  private cancelled = false;
  private session?: object;
  private authentication?: {generation: number};
  private retryLock = false;
  constructor(link: FotoroShareLink, session?: object) {this.link = freezePublic(structuredClone(link)); this.session = session;}
  get pending() {return !this.cancelled;}
  bindInitialVault(session: object) {if (this.pending && !this.session && !this.authentication) this.session = session;}
  current(session: object) {return this.pending && this.session === session;}
  beginAuthentication(generation: number) {if (this.pending && !this.session) return this.authentication = {generation};}
  finishAuthentication(ticket: {generation: number} | undefined, session?: object, generation?: number) {
    if (!ticket || ticket !== this.authentication) return;
    this.authentication = undefined;
    if (!session) return;
    if (!this.pending || generation !== ticket.generation + 1) {this.cancel(); return;}
    this.session = session;
  }
  retryPassword() {if (this.pending) {this.session = undefined; this.retryLock = true; this.authentication = undefined;}}
  vaultLocked() {if (this.retryLock) {this.retryLock = false; return;} if (this.session || !this.authentication) this.cancel();}
  cancel() {this.cancelled = true; this.session = undefined; this.authentication = undefined;}
}
