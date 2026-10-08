import {makeAlbumPhotoFacts, openAlbumPhotoFacts} from "@fotoro/crypto/album-photo-facts";
import {readAlbumPhotoFacts, validateAlbumPhotoFactsPage, validateAlbumPhotoFactsReply, type AlbumPhotoFactsContentV1} from "@fotoro/contracts/album-photo-facts";
import {ApiError} from "../exchange/api-errors";
import type {OwnedAlbumDetails} from "./details";
import {diagnose, type DiagnosticContext} from "../diagnostics";
import type {AccountCardV1, SignedPayloadV1} from "@fotoro/contracts";
import {acceptedPhotoManifestKind} from "@fotoro/contracts/camera-media";
import {validateWire} from "@fotoro/contracts/validate";
import {ALBUM_DEFINITION_KIND, ALBUM_PHOTO_KIND, readAlbumSignedBody, validateAlbumPhoto, validateAlbumDefinition, validateAlbumInbox, validateAlbumDetail, validateAlbumOverview, validateAlbumTitle, validateAlbumAppendResult, validateAlbumAppend, type AlbumAppendV1, type AlbumOverviewV1, type AlbumDetailV1} from "@fotoro/contracts/albums";
import {makeAlbumDefinition, openAlbumDefinition, makeAlbumAction, makeAlbumPhoto, openAlbumPhoto, verifyAlbumPhoto} from "@fotoro/crypto/albums";
import {ready, verifyPayload, unb64, utf8, wrapKey, unwrapKey} from "@fotoro/crypto";
import {api, scopedApi} from "../exchange/api";
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
export function albumInbox(scope: ShareScope) {return diagnose("album", diagnostic => albumInboxAction({...scope, diagnostic}), "refresh");}
async function albumInboxAction(scope: ShareScope) {
  const request = scope.diagnostic ? scopedApi(scope.diagnostic) : api;
  const session = requireVault(); check(session, scope);
  const inbox = validateAlbumInbox(await request("/v1/albums", undefined, undefined, "GET", scope.signal)); check(session, scope);
  return inbox.albums;
}
export interface AlbumPhotoPage {photos: Photo[]; nextCursor?: string; hasMore: boolean; photoCount: number}
export interface AlbumCreationDraft {signed?: SignedPayloadV1;}
export async function albumOriginalFiles(access: AlbumAccess, photo: Photo, signal: AbortSignal) {
  const bytes = await access.bytes(photo, "original", signal);
  try {const files = await cameraOriginalFiles(bytes, photo.metadata); await access.assertAccess(); signal.throwIfAborted(); return files;}
  finally {bytes.fill(0);}
}
export function createAlbum(title: string, cards: readonly AccountCardV1[], scope: ShareScope, draft?: AlbumCreationDraft) {return diagnose("album", diagnostic => createAlbumAction(title, cards, {...scope, diagnostic}, draft), "create");}
async function createAlbumAction(title: string, cards: readonly AccountCardV1[], scope: ShareScope, draft?: AlbumCreationDraft) {
  const request = scope.diagnostic ? scopedApi(scope.diagnostic) : api;
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
    const result = validateAlbumOverview(await request("/v1/albums", {version: 1, definition: signed}, undefined, "POST", scope.signal)); check(session, scope);
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
  private photoSources = new Map<Photo, {entry: SignedPayloadV1; manifest: SignedPayloadV1}>();
  private loadingKeys = new Set<Uint8Array>();
  private pageIds = new Set<string>();
  private pageCursors = new Set<string>();
  private nextPhotoCursor?: string;
  private pageLoading = false;
  private pendingFacts = new Map<string, {signature: string; signed: SignedPayloadV1}>();
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
  dispose() {if (this.disposed) return; this.disposed = true; this.key.fill(0); for (const key of this.loadingKeys) key.fill(0); this.loadingKeys.clear(); for (const photo of this.photos) photo.metadataKey.fill(0); this.photos.clear(); this.photoSources.clear(); this.pendingFacts.clear(); this.cancellation.abort();}
  private async trusted() {
    this.check(); const card = await trustedCard(this.owner.accountId, this.session, this.scope); this.check();
    if (!sameIdentity(card, this.owner)) {this.dispose(); throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");}
  }
  private async detail(cursor?: string, diagnostic?: DiagnosticContext) {
    const request = diagnostic ? scopedApi(diagnostic) : api;
    this.check(); await this.trusted();
    const result = validateAlbumDetail(await request("/v1/albums/" + this.albumId + (cursor === undefined ? "" : "?cursor=" + encodeURIComponent(cursor)), undefined, undefined, "GET", this.scope.signal)); this.check();
    if (!albumReadable(result, this.session.accountId, this.identity)) {this.dispose(); throw new Error("ALBUM_ACCESS_ENDED");}
    await this.trusted(); return result;
  }
  async assertAccess(diagnostic?: DiagnosticContext) {
    const request = diagnostic ? scopedApi(diagnostic) : api;
    try {
      this.check(); await this.trusted();
      const value = validateAlbumOverview(await request("/v1/albums/" + this.albumId + "/access", undefined, undefined, "GET", this.scope.signal)); this.check();
      if (!albumReadable(value, this.session.accountId, this.identity)) throw new Error("ALBUM_ACCESS_ENDED");
      await this.trusted(); return value;
    } catch (error) {this.dispose(); throw error;}
  }
  accept() {return diagnose("album", diagnostic => this.acceptAction(diagnostic), "accept");}
  private async acceptAction(diagnostic: DiagnosticContext) {
    const request = scopedApi(diagnostic);
    this.check(); await this.trusted();
    const action = makeAlbumAction({signedDefinition: this.overview.definition, trustedOwner: this.owner, memberCard: this.session.card, signingSecretKey: this.session.signingSecretKey, action: "accept"});
    const result = validateAlbumOverview(await request("/v1/albums/" + this.albumId + "/accept", {version: 1, action}, undefined, "POST", this.scope.signal)); this.check();
    if (!albumReadable(result, this.session.accountId, this.identity)) throw new Error("ALBUM_BINDING_MISMATCH");
    await this.assertAccess(diagnostic); return result;
  }
  end() {return diagnose("album", diagnostic => this.endAction(diagnostic), "end");}
  private async endAction(diagnostic: DiagnosticContext) {
    const request = scopedApi(diagnostic);
    await this.assertAccess(diagnostic);
    const action = makeAlbumAction({signedDefinition: this.overview.definition, trustedOwner: this.owner, memberCard: this.session.card, signingSecretKey: this.session.signingSecretKey, action: "end"});
    const result = validateAlbumOverview(await request("/v1/albums/" + this.albumId + "/end", {version: 1, action}, undefined, "POST", this.scope.signal)); this.check();
    if (albumDefinitionIdentity(result) !== this.identity || result.endedAt === null) throw new Error("ALBUM_BINDING_MISMATCH");
    this.dispose(); return result;
  }
  loadPhotoPage(cursor?: string): Promise<AlbumPhotoPage> {return diagnose("album", diagnostic => this.loadPhotoPageAction(cursor, diagnostic), "refresh");}
  private async loadPhotoPageAction(cursor: string | undefined, diagnostic: DiagnosticContext): Promise<AlbumPhotoPage> {
    // One traversal at a time: callers publish each page before requesting its continuation.
    if (this.pageLoading) throw new Error("ALBUM_PAGE_LOADING");
    this.pageLoading = true;
    const loaded: Photo[] = [], keys: Uint8Array[] = [];
    try {
      this.check();
      if (cursor === undefined) {this.pageIds.clear(); this.pageCursors.clear(); this.nextPhotoCursor = undefined;}
      else if (cursor !== this.nextPhotoCursor || this.pageCursors.has(cursor)) throw new Error("ALBUM_PAGE_MISMATCH");
      const page = await this.detail(cursor, diagnostic);
      if (cursor !== undefined) this.pageCursors.add(cursor);
      if ((page.hasMore && (!page.entries.length || !page.nextCursor || this.pageCursors.has(page.nextCursor))) || this.pageIds.size + page.entries.length > Math.min(page.photoCount, 1000)) throw new Error("ALBUM_PAGE_MISMATCH");
      const ids = new Set(this.pageIds);
      // Verify the complete bounded page before starting any encrypted metadata reads.
      const verified = page.entries.map((entry, n) => {
        const signedManifest = page.manifests[n];
        const manifest = verifyAlbumPhoto({definition: this.definition, entry, manifest: signedManifest}).manifest;
        if (ids.has(manifest.photoId)) throw new Error("ALBUM_DUPLICATE_PHOTO");
        ids.add(manifest.photoId);
        const key = openAlbumPhoto({definition: this.definition, entry, manifest: signedManifest, albumKey: this.key}); keys.push(key); this.loadingKeys.add(key);
        return {manifest, key, entry, signedManifest};
      });
      // Metadata is one bounded publication unit. Membership/account/trust are fenced
      // around the page; original and derivative media retain their per-read fences.
      await this.assertAccess(diagnostic);
      const signal = this.scope.signal ? AbortSignal.any([this.signal, this.scope.signal]) : this.signal;
      let next = 0;
      const workers = Array.from({length: Math.min(4, verified.length)}, async () => {
        try {
          for (;;) {
            this.check(); const n = next++; if (n >= verified.length) return;
            const item = verified[n];
            const photo = await readPhoto(item.manifest, item.key, undefined, signal, diagnostic);
            loaded[n] = photo; this.check();
          }
        } catch (error) {this.dispose(); throw error;}
      });
      const results = await Promise.allSettled(workers);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await this.assertAccess(diagnostic); this.check();
      for (let n = 0; n < loaded.length; n++) {
        const photo = loaded[n], item = verified[n];
        this.photos.add(photo); this.photoSources.set(photo, {entry: item.entry, manifest: item.signedManifest});
      }
      this.pageIds = ids; this.nextPhotoCursor = page.nextCursor ?? undefined;
      return {photos: loaded, nextCursor: this.nextPhotoCursor, hasMore: page.hasMore, photoCount: page.photoCount};
    } catch (error) {for (const key of keys) key.fill(0); for (const photo of loaded) photo?.metadataKey.fill(0); this.dispose(); throw error;}
    finally {for (const key of keys) this.loadingKeys.delete(key); this.pageLoading = false;}
  }
  private factsSource(photo: Photo) {
    this.check(); const source = this.photoSources.get(photo);
    if (!source || !this.photos.has(photo)) throw new Error("ALBUM_PHOTO_CHANGED");
    return {signedDefinition: this.overview.definition, trustedOwner: this.owner, ...source,
      originalSha256: photo.metadata.originalSha256, albumKey: this.key};
  }
  async loadFacts(): Promise<{supported: boolean; facts: Map<string, AlbumPhotoFactsContentV1>; unmatched: number}> {
    await this.assertAccess();
    const facts = new Map<string, AlbumPhotoFactsContentV1>(), cursors = new Set<string>(), seen = new Set<string>(), photos = new Map([...this.photos].map(photo => [photo.manifest.photoId, photo]));
    let unmatched = 0;
    try {
      this.check();
      const capability = await api<{version: number; albumFactsVersion: number}>("/v1/album-photo-facts/capabilities", undefined, undefined, "GET", this.scope.signal); this.check();
      if (capability.version !== 1 || capability.albumFactsVersion !== 1) throw new Error("ALBUM_FACTS_UPDATE_REQUIRED");
      let cursor: string | undefined;
      do {
        this.check();
        const page = validateAlbumPhotoFactsPage(await api("/v1/albums/" + this.albumId + "/photo-facts" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), undefined, undefined, "GET", this.scope.signal)); this.check();
        for (const signed of page.facts) {
          const outer = readAlbumPhotoFacts(signed), photo = photos.get(outer.photoId);
          if (seen.has(outer.photoId) || outer.albumId !== this.albumId || outer.definitionSignature !== this.overview.definition.signature || !this.definition.members.some(member => member.card.accountId === outer.ownerAccountId)) throw new Error("ALBUM_FACTS_BINDING_MISMATCH");
          seen.add(outer.photoId);
          if (!photo) {unmatched++; continue;}
          facts.set(outer.photoId, openAlbumPhotoFacts({...this.factsSource(photo), signed}));
        }
        if (!page.hasMore) break;
        if (!page.nextCursor || cursors.has(page.nextCursor) || cursors.size >= 9 || seen.size >= 1000) throw new Error("ALBUM_FACTS_PAGE_MISMATCH");
        cursor = page.nextCursor; cursors.add(cursor);
      } while (true);
      await this.assertAccess(); return {supported: true, facts, unmatched};
    } catch (error) {
      this.check();
      if (error instanceof ApiError && ["NOT_FOUND", "HTTP_404", "HTTP_501"].includes(error.code)) {await this.assertAccess(); return {supported: false, facts: new Map(), unmatched: 0};}
      throw error;
    }
  }
  async readFactsFor(photo: Photo) {
    this.factsSource(photo); await this.assertAccess(); this.check();
    const reply = validateAlbumPhotoFactsReply(await api("/v1/albums/" + this.albumId + "/photo-facts/" + photo.manifest.photoId, undefined, undefined, "GET", this.scope.signal)); this.check();
    const content = reply.facts ? openAlbumPhotoFacts({...this.factsSource(photo), signed: reply.facts}) : undefined;
    await this.assertAccess(); this.check(); return content;
  }
  async shareDetails(photo: Photo, source: OwnedAlbumDetails, selected: {people: boolean | readonly string[]; location: boolean}, revision: number) {
    const checkSource = () => {this.check(); if (photo.manifest.ownerAccountId !== this.session.accountId || source.ownerAccountId !== this.session.accountId || source.photoId !== photo.manifest.photoId || source.originalSha256 !== photo.metadata.originalSha256 || !source.current()) throw new Error("ALBUM_SELECTION_CHANGED");};
    checkSource(); await this.assertAccess(); checkSource();
    const people = Array.isArray(selected.people) ? [...selected.people] : selected.people ? source.people : [];
    if (people.some(name => !source.people.includes(name))) throw new Error("ALBUM_SELECTION_CHANGED");
    const location = selected.location ? source.location : undefined;
    const signature = JSON.stringify([revision, people, location]);
    let retained = this.pendingFacts.get(photo.manifest.photoId);
    if (!retained || retained.signature !== signature) {
      retained = {signature, signed: makeAlbumPhotoFacts({...this.factsSource(photo), revision, people, ...(location ? {location} : {}), signingSecretKey: this.session.signingSecretKey})};
      this.pendingFacts.set(photo.manifest.photoId, retained);
    }
    checkSource();
    const reply = validateAlbumPhotoFactsReply(await api("/v1/albums/" + this.albumId + "/photo-facts/" + photo.manifest.photoId, {version: 1, facts: retained.signed}, undefined, "PUT", this.scope.signal)); checkSource();
    if (!reply.facts || JSON.stringify(ordered(reply.facts)) !== JSON.stringify(ordered(retained.signed))) throw new Error("ALBUM_FACTS_BINDING_MISMATCH");
    const content = openAlbumPhotoFacts({...this.factsSource(photo), signed: reply.facts});
    checkSource(); await this.assertAccess(); checkSource();
    this.pendingFacts.delete(photo.manifest.photoId); return content;
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
  add(chosen: readonly Photo[], latest: () => readonly Photo[]) {return diagnose("album", diagnostic => this.addAction(diagnostic, chosen, latest), "add");}
  private async addAction(diagnostic: DiagnosticContext, chosen: readonly Photo[], latest: () => readonly Photo[]) {
    const requestApi = scopedApi(diagnostic);
    albumOwnedSelection(chosen, this.session, latest()); await this.assertAccess(diagnostic);
    // Never generate a different immutable envelope for a contribution already present.
    const existing = new Set<string>(); let page = await this.detail(undefined, diagnostic); const cursors = new Set<string>();
    for (;;) {
      const {verifyAlbumPhoto} = await import("@fotoro/crypto/albums"); this.check();
      for (let n = 0; n < page.entries.length; n++) existing.add(verifyAlbumPhoto({definition: this.definition, entry: page.entries[n], manifest: page.manifests[n]}).photo.photoId);
      if (!page.hasMore) break;
      if (!page.nextCursor || cursors.has(page.nextCursor) || existing.size >= 1000) throw new Error("ALBUM_PAGE_MISMATCH");
      cursors.add(page.nextCursor); page = await this.detail(page.nextCursor, diagnostic);
    }
    const pending = chosen.filter(photo => !existing.has(photo.manifest.photoId)).slice().sort((left, right) => left.manifest.photoId.localeCompare(right.manifest.photoId));
    let added = 0;
    for (let at = 0; at < pending.length; at += 100) {
      albumOwnedSelection(chosen, this.session, latest());
      const batch = pending.slice(at, at + 100), operationId = crypto.randomUUID();
      const manifests: SignedPayloadV1[] = [];
      for (const photo of batch) {
        this.check(); albumOwnedSelection(chosen, this.session, latest());
        const signed = validateWire<SignedPayloadV1>("SignedPayloadV1", await requestApi("/v1/photos/" + photo.manifest.photoId + "/manifest", undefined, undefined, "GET", this.scope.signal)); this.check();
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
      await this.assertAccess(diagnostic); albumOwnedSelection(chosen, this.session, latest());
      const result = validateAlbumAppendResult(await requestApi("/v1/albums/" + this.albumId + "/photos", request, undefined, "POST", this.scope.signal)); this.check();
      if (result.albumId !== this.albumId || result.operationId !== request.operationId || result.added > batch.length) throw new Error("ALBUM_BINDING_MISMATCH");
      await this.assertAccess(diagnostic); added += result.added;
    }
    return added;
  }
}
