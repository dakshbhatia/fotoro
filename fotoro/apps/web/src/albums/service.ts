import type {AccountCardV1, SignedPayloadV1} from "@fotoro/contracts";
import {acceptedPhotoManifestKind} from "@fotoro/contracts/camera-media";
import {validateWire} from "@fotoro/contracts/validate";
import {ALBUM_DEFINITION_KIND, ALBUM_PHOTO_KIND, readAlbumSignedBody, validateAlbumPhoto, validateAlbumDefinition, validateAlbumInbox, validateAlbumDetail, validateAlbumOverview, validateAlbumTitle, validateAlbumAppendResult, validateAlbumAppend, type AlbumAppendV1, type AlbumOverviewV1, type AlbumDetailV1} from "@fotoro/contracts/albums";
import {makeAlbumDefinition, openAlbumDefinition, makeAlbumAction, makeAlbumPhoto, openAlbumPhoto} from "@fotoro/crypto/albums";
import {ready, verifyPayload, unb64, utf8, wrapKey, unwrapKey} from "@fotoro/crypto";
import {api} from "../exchange/api";
import {trustedCard, type ShareScope} from "../exchange/share-service";
import {sameIdentity} from "../exchange/sharing";
import {requireVault, type UnlockedVault} from "../vault/vault";
import {assertVault} from "../vault/scope";
import {digest, photoBytes, readPhoto, type Photo} from "../library/catalog";
import {db} from "../exchange/cache";
import {savedOriginalSelectionCurrent} from "../library/system-share";
import {cameraOriginalFiles} from "../media/camera-original";
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, ordered(child)])) : value;

export function albumDefinitionIdentity(overview: AlbumOverviewV1) {
  const signed = overview.definition;
  return JSON.stringify([signed.version, signed.kind, signed.accountId, signed.body, signed.signature]);
}
export function albumReadable(overview: AlbumOverviewV1, accountId: string, definitionIdentity?: string) {
  const definition = readAlbumSignedBody(overview.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition);
  return overview.endedAt === null && overview.membership === "accepted" && definition.members.some(member => member.card.accountId === accountId) &&
    (definitionIdentity === undefined || definitionIdentity === albumDefinitionIdentity(overview));
}
export function albumOwnedSelection(photos: readonly Photo[], session: UnlockedVault, currentPhotos: readonly Photo[]) {
  if (!photos.length || photos.length > 1000) throw new Error("SELECT_1_TO_1000_SAVED_PHOTOS");
  const ids = new Set<string>();
  for (const photo of photos) {
    if (photo.grantId || photo.manifest.ownerAccountId !== session.accountId || ids.has(photo.manifest.photoId)) throw new Error("ALBUM_SELECTION_CHANGED");
    ids.add(photo.manifest.photoId);
  }
  if (!savedOriginalSelectionCurrent(photos, currentPhotos, ids, session.accountId)) throw new Error("ALBUM_SELECTION_CHANGED");
  return photos;
}
function check(session: UnlockedVault, scope: ShareScope) {
  assertVault(session); scope.signal?.throwIfAborted();
  if (scope.current?.() === false) throw new DOMException("Album closed", "AbortError");
}
export async function albumCapabilities(scope: ShareScope) {
  const session = requireVault(); check(session, scope);
  const value = await api<{version: number; albumsVersion: number; maxMembers: number; maxPhotos: number; pageSize: number}>("/v1/albums/capabilities", undefined, undefined, "GET", scope.signal); check(session, scope);
  if (value.version !== 1 || value.albumsVersion !== 1 || value.maxMembers !== 12 || value.maxPhotos !== 1000 || value.pageSize !== 100) throw new Error("ALBUM_UPDATE_REQUIRED");
  return value;
}
export async function albumInbox(scope: ShareScope) {
  const session = requireVault(); check(session, scope);
  const inbox = validateAlbumInbox(await api("/v1/albums", undefined, undefined, "GET", scope.signal)); check(session, scope);
  return inbox.albums;
}
export interface AlbumCreationDraft {signed?: SignedPayloadV1;}
export async function albumOriginalFiles(access: AlbumAccess, photo: Photo, signal: AbortSignal) {
  const bytes = await access.bytes(photo, "original", signal);
  try {const files = await cameraOriginalFiles(bytes, photo.metadata); await access.assertAccess(); signal.throwIfAborted(); return files;}
  finally {bytes.fill(0);}
}
export async function createAlbum(title: string, cards: readonly AccountCardV1[], scope: ShareScope, draft?: AlbumCreationDraft) {
  const session = requireVault(); await ready; check(session, scope); validateAlbumTitle(title);
  if (!cards.length || cards.length > 11) throw new Error("CHOOSE_1_TO_11_CONTACTS");
  for (const card of cards) {const trusted = await trustedCard(card.accountId, session, scope); check(session, scope); if (!sameIdentity(card, trusted)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");}
  let signed = draft?.signed;
  if (!signed) {
    const made = makeAlbumDefinition({albumId: crypto.randomUUID(), title, createdAt: new Date().toISOString(), ownerCard: session.card, members: [session.card, ...cards], signingSecretKey: session.signingSecretKey});
    signed = made.signed; made.albumKey.fill(0); if (draft) draft.signed = signed;
  }
  const definition = readAlbumSignedBody(signed, ALBUM_DEFINITION_KIND, validateAlbumDefinition);
  const opened = openAlbumDefinition({signed, trustedOwner: session.card, recipientCard: session.card, recipientSecretKey: session.boxSecretKey, expectedAlbumId: definition.albumId});
  try {
    if (opened.title !== title || opened.definition.ownerAccountId !== session.accountId || JSON.stringify(ordered(opened.definition.members.map(member => member.card).sort((left, right) => left.accountId.localeCompare(right.accountId)))) !== JSON.stringify(ordered([session.card, ...cards].sort((left, right) => left.accountId.localeCompare(right.accountId))))) throw new Error("ALBUM_SELECTION_CHANGED");
    for (const card of cards) {const trusted = await trustedCard(card.accountId, session, scope); check(session, scope); if (!sameIdentity(card, trusted)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");}
    const result = validateAlbumOverview(await api("/v1/albums", {version: 1, definition: signed}, undefined, "POST", scope.signal)); check(session, scope);
    if (albumDefinitionIdentity(result) !== albumDefinitionIdentity({...result, definition: signed}) || !albumReadable(result, session.accountId)) throw new Error("ALBUM_BINDING_MISMATCH");
    if (draft) draft.signed = undefined;
    return result;
  } finally {opened.albumKey.fill(0);}
}

async function retainAppend(request: AlbumAppendV1, albumId: string, session: UnlockedVault, scope: ShareScope) {
  const database = await db(); check(session, scope);
  const key = session.accountId + ":album-append:" + albumId + ":" + digest(utf8(request.manifests));
  const proposed = wrapKey(utf8(request), session.vaultKey);
  const encrypted = await new Promise<typeof proposed>((resolve, reject) => {
    const transaction = database.transaction("saves", "readwrite"), store = transaction.objectStore("saves"), reading = store.get(key);
    let value = proposed;
    reading.onsuccess = () => {if (reading.result !== undefined) value = reading.result; else store.put(proposed, key);};
    transaction.oncomplete = () => resolve(value); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error ?? new Error("STORAGE_ABORTED"));
  });
  check(session, scope);
  const plain = unwrapKey(encrypted, session.vaultKey);
  try {
    const retained = validateAlbumAppend(JSON.parse(new TextDecoder().decode(plain)));
    if (JSON.stringify(retained.manifests) !== JSON.stringify(request.manifests) || retained.entries.some(entry => readAlbumSignedBody(entry, ALBUM_PHOTO_KIND, validateAlbumPhoto).albumId !== albumId)) throw new Error("ALBUM_SELECTION_CHANGED");
    return retained;
  } finally {plain.fill(0);}
}

// One open album owns its keys. Membership is rechecked around every media read.
export class AlbumAccess {
  readonly session = requireVault();
  readonly identity: string;
  readonly albumId: string;
  readonly title: string;
  readonly definition: ReturnType<typeof openAlbumDefinition>["definition"];
  private key: Uint8Array;
  private cancellation = new AbortController();
  get signal() {return this.cancellation.signal;}
  private disposed = false;
  private photos = new Set<Photo>();
  private constructor(readonly overview: AlbumOverviewV1, opened: ReturnType<typeof openAlbumDefinition>, readonly scope: ShareScope, readonly owner: AccountCardV1) {
    this.key = opened.albumKey; this.title = opened.title; this.definition = opened.definition;
    this.albumId = opened.definition.albumId; this.identity = albumDefinitionIdentity(overview);
  }
  static async open(overview: AlbumOverviewV1, scope: ShareScope) {
    const session = requireVault(); await ready; check(session, scope);
    const definition = readAlbumSignedBody(overview.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition);
    if (overview.endedAt !== null || !definition.members.some(member => member.card.accountId === session.accountId)) throw new Error("ALBUM_ACCESS_ENDED");
    const owner = await trustedCard(definition.ownerAccountId, session, scope); check(session, scope);
    const opened = openAlbumDefinition({signed: overview.definition, trustedOwner: owner, recipientCard: session.card, recipientSecretKey: session.boxSecretKey, expectedAlbumId: definition.albumId});
    try {check(session, scope); return new AlbumAccess(overview, opened, scope, owner);} catch (error) {opened.albumKey.fill(0); throw error;}
  }
  current() {try {this.check(); return true;} catch {return false;}}
  private check() {try {check(this.session, this.scope); if (this.disposed) throw new DOMException("Album closed", "AbortError");} catch (error) {this.dispose(); throw error;}}
  dispose() {if (this.disposed) return; this.disposed = true; this.key.fill(0); for (const photo of this.photos) photo.metadataKey.fill(0); this.photos.clear(); this.cancellation.abort();}
  private async trusted() {
    this.check(); const card = await trustedCard(this.owner.accountId, this.session, this.scope); this.check();
    if (!sameIdentity(card, this.owner)) {this.dispose(); throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");}
  }
  private async detail(cursor?: string) {
    this.check(); await this.trusted();
    const result = validateAlbumDetail(await api("/v1/albums/" + this.albumId + (cursor === undefined ? "" : "?cursor=" + encodeURIComponent(cursor)), undefined, undefined, "GET", this.scope.signal)); this.check();
    if (!albumReadable(result, this.session.accountId, this.identity)) {this.dispose(); throw new Error("ALBUM_ACCESS_ENDED");}
    await this.trusted(); return result;
  }
  async assertAccess() {
    try {
      this.check(); await this.trusted();
      const value = validateAlbumOverview(await api("/v1/albums/" + this.albumId + "/access", undefined, undefined, "GET", this.scope.signal)); this.check();
      if (!albumReadable(value, this.session.accountId, this.identity)) throw new Error("ALBUM_ACCESS_ENDED");
      await this.trusted(); return value;
    } catch (error) {this.dispose(); throw error;}
  }
  async accept() {
    this.check(); await this.trusted();
    const action = makeAlbumAction({signedDefinition: this.overview.definition, trustedOwner: this.owner, memberCard: this.session.card, signingSecretKey: this.session.signingSecretKey, action: "accept"});
    const result = validateAlbumOverview(await api("/v1/albums/" + this.albumId + "/accept", {version: 1, action}, undefined, "POST", this.scope.signal)); this.check();
    if (!albumReadable(result, this.session.accountId, this.identity)) throw new Error("ALBUM_BINDING_MISMATCH");
    await this.assertAccess(); return result;
  }
  async end() {
    await this.assertAccess();
    const action = makeAlbumAction({signedDefinition: this.overview.definition, trustedOwner: this.owner, memberCard: this.session.card, signingSecretKey: this.session.signingSecretKey, action: "end"});
    const result = validateAlbumOverview(await api("/v1/albums/" + this.albumId + "/end", {version: 1, action}, undefined, "POST", this.scope.signal)); this.check();
    if (albumDefinitionIdentity(result) !== this.identity || result.endedAt === null) throw new Error("ALBUM_BINDING_MISMATCH");
    this.dispose(); return result;
  }
  async loadPhotos() {
    const loaded: Photo[] = [], ids = new Set<string>(), cursors = new Set<string>();
    try {
      let page: AlbumDetailV1 = await this.detail();
      for (;;) {
        for (let n = 0; n < page.entries.length; n++) {
          this.check();
          const metadataKey = openAlbumPhoto({definition: this.definition, entry: page.entries[n], manifest: page.manifests[n], albumKey: this.key});
          let photo: Photo | undefined;
          try {
            const {verifyAlbumPhoto} = await import("@fotoro/crypto/albums"); this.check();
            const manifest = verifyAlbumPhoto({definition: this.definition, entry: page.entries[n], manifest: page.manifests[n]}).manifest;
            if (ids.has(manifest.photoId)) throw new Error("ALBUM_DUPLICATE_PHOTO");
            await this.assertAccess();
            photo = await readPhoto(manifest, metadataKey, undefined, this.scope.signal); this.check();
            try {await this.assertAccess();} catch (error) {photo.metadataKey.fill(0); throw error;}
            ids.add(manifest.photoId); loaded.push(photo);
          } catch (error) {metadataKey.fill(0); throw error;}
        }
        if (!page.hasMore) break;
        if (!page.nextCursor || cursors.has(page.nextCursor) || loaded.length >= 1000) throw new Error("ALBUM_PAGE_MISMATCH");
        cursors.add(page.nextCursor); page = await this.detail(page.nextCursor);
      }
      await this.assertAccess();
      for (const photo of loaded) this.photos.add(photo);
      return loaded;
    } catch (error) {for (const photo of loaded) photo.metadataKey.fill(0); this.dispose(); throw error;}
  }
  async bytes(photo: Photo, kind: "thumbnail" | "preview" | "original", signal: AbortSignal) {
    signal.throwIfAborted(); this.check();
    if (!this.photos.has(photo)) throw new Error("ALBUM_PHOTO_CHANGED");
    const derivative = photo.manifest.representations.find(rep => rep.binding.kind === kind) ?? (kind === "thumbnail" ? photo.manifest.representations.find(rep => rep.binding.kind === "preview") : undefined);
    if (kind !== "original" && !derivative) throw new Error("PREVIEW_UNAVAILABLE");
    await this.assertAccess(); signal.throwIfAborted();
    const bytes = await photoBytes(photo, kind === "original" ? kind : derivative!.binding.kind as "thumbnail" | "preview", signal);
    try {await this.assertAccess(); signal.throwIfAborted(); this.check(); return bytes;} catch (error) {bytes.fill(0); throw error;}
  }
  async add(chosen: readonly Photo[], latest: () => readonly Photo[]) {
    albumOwnedSelection(chosen, this.session, latest()); await this.assertAccess();
    // Never generate a different immutable envelope for a contribution already present.
    const existing = new Set<string>(); let page = await this.detail(); const cursors = new Set<string>();
    for (;;) {
      const {verifyAlbumPhoto} = await import("@fotoro/crypto/albums"); this.check();
      for (let n = 0; n < page.entries.length; n++) existing.add(verifyAlbumPhoto({definition: this.definition, entry: page.entries[n], manifest: page.manifests[n]}).photo.photoId);
      if (!page.hasMore) break;
      if (!page.nextCursor || cursors.has(page.nextCursor) || existing.size >= 1000) throw new Error("ALBUM_PAGE_MISMATCH");
      cursors.add(page.nextCursor); page = await this.detail(page.nextCursor);
    }
    const pending = chosen.filter(photo => !existing.has(photo.manifest.photoId)).slice().sort((left, right) => left.manifest.photoId.localeCompare(right.manifest.photoId));
    let added = 0;
    for (let at = 0; at < pending.length; at += 100) {
      albumOwnedSelection(chosen, this.session, latest());
      const batch = pending.slice(at, at + 100), operationId = crypto.randomUUID();
      const manifests: SignedPayloadV1[] = [];
      for (const photo of batch) {
        this.check(); albumOwnedSelection(chosen, this.session, latest());
        const signed = validateWire<SignedPayloadV1>("SignedPayloadV1", await api("/v1/photos/" + photo.manifest.photoId + "/manifest", undefined, undefined, "GET", this.scope.signal)); this.check();
        acceptedPhotoManifestKind(signed.kind);
        if (signed.accountId !== this.session.accountId) throw new Error("ALBUM_SELECTION_CHANGED");
        const bytes = verifyPayload(signed, unb64(this.session.card.signingPublicKey));
        try {
          const manifest = validateWire("PhotoManifestV1", JSON.parse(new TextDecoder().decode(bytes)));
          if (JSON.stringify(ordered(manifest)) !== JSON.stringify(ordered(photo.manifest))) throw new Error("ALBUM_SELECTION_CHANGED");
        } finally {bytes.fill(0);}
        manifests.push(signed);
      }
      const entries = batch.map((photo, n) => makeAlbumPhoto({definition: this.definition, manifest: manifests[n], metadataKey: photo.metadataKey, albumKey: this.key, signingSecretKey: this.session.signingSecretKey}));
      const request = await retainAppend({version: 1, operationId, entries, manifests}, this.albumId, this.session, this.scope);
      await this.assertAccess(); albumOwnedSelection(chosen, this.session, latest());
      const result = validateAlbumAppendResult(await api("/v1/albums/" + this.albumId + "/photos", request, undefined, "POST", this.scope.signal)); this.check();
      if (result.albumId !== this.albumId || result.operationId !== request.operationId || result.added > batch.length) throw new Error("ALBUM_BINDING_MISMATCH");
      await this.assertAccess(); added += result.added;
    }
    return added;
  }
}
