import type {AlbumOverviewV1} from "@fotoro/contracts/albums";
import {ALBUM_DEFINITION_KIND, readAlbumSignedBody, validateAlbumDefinition} from "@fotoro/contracts/albums";
import {ready} from "@fotoro/crypto";
import {verifyAlbumDefinition} from "@fotoro/crypto/albums";
import {ApiError} from "../exchange/api-errors";
import {pinCard, trustedCard, type ShareScope} from "../exchange/share-service";
import {sameIdentity} from "../exchange/sharing";
import {assertVault} from "../vault/scope";
import {requireVault, type UnlockedVault} from "../vault/vault";
import type {AccountCardV1} from "@fotoro/contracts";
import type {IncomingAlbumIntent} from "./intent";
import {AlbumAccess, albumCapabilities, albumDefinitionIdentity, albumInbox} from "./service";

export function unsupportedAlbumCapabilities(error: unknown) {
  return error instanceof Error && error.message === "ALBUM_UPDATE_REQUIRED" ||
    error instanceof ApiError && ["NOT_FOUND", "HTTP_404", "HTTP_501"].includes(error.code);
}

export type AlbumOwnerEntry = {kind: "review"; overview: AlbumOverviewV1; owner: AccountCardV1; changed: boolean} | {kind: "open"; overview: AlbumOverviewV1};
function checkEntry(session: UnlockedVault, scope: ShareScope) {
  assertVault(session); scope.signal?.throwIfAborted();
  if (scope.current?.() === false) throw new DOMException("Album closed", "AbortError");
}
function albumOwner(overview: AlbumOverviewV1, session: UnlockedVault, expectedOwner?: AccountCardV1) {
  const definition = readAlbumSignedBody(overview.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition);
  const owner = definition.members.find(member => member.card.accountId === definition.ownerAccountId)!.card;
  verifyAlbumDefinition(overview.definition, expectedOwner ?? owner);
  if (overview.endedAt !== null || !["invited", "accepted"].includes(overview.membership)) throw new Error("ALBUM_ACCESS_ENDED");
  const own = definition.members.find(member => member.card.accountId === session.accountId)?.card;
  if (!own || !sameIdentity(own, session.card)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
  return owner;
}
// Inbox and link entry require the same explicit review when this browser lacks owner trust.
export async function reviewAlbumOwner(overview: AlbumOverviewV1, session: UnlockedVault, scope: ShareScope, expectedOwner?: AccountCardV1): Promise<AlbumOwnerEntry> {
  checkEntry(session, scope); await ready; checkEntry(session, scope);
  const owner = albumOwner(overview, session, expectedOwner);
  let trusted;
  try {trusted = await trustedCard(owner.accountId, session, scope);}
  catch (error) {if (!(error instanceof Error && error.message === "PIN_ACCOUNT_CARD_FROM_TRUSTED_CHANNEL")) throw error;}
  checkEntry(session, scope);
  return !trusted || !sameIdentity(trusted, owner)
    ? {kind: "review", overview, owner, changed: !!trusted} : {kind: "open", overview};
}

// Initial entry and explicit retries use the same owner verification and captured vault.
export async function loadAlbumEntry({session, scope, incoming, albumId, loadInbox, onAvailable}: {
  session: UnlockedVault; scope: ShareScope; incoming?: IncomingAlbumIntent; albumId?: string;
  loadInbox: () => Promise<AlbumOverviewV1[] | undefined>; onAvailable: () => void;
}): Promise<{kind: "inbox"} | {kind: "missing"} | AlbumOwnerEntry> {
  const entryScope = {...scope, current: () => scope.current?.() !== false && (!incoming || incoming.current(session))};
  const check = () => checkEntry(session, entryScope);
  check(); await albumCapabilities(entryScope); check(); onAvailable();
  const list = await loadInbox(); check();
  if (!incoming && !albumId) return {kind: "inbox"};
  const found = list?.find(item => readAlbumSignedBody(item.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition).albumId === (incoming?.link.albumId ?? albumId));
  if (!found) return {kind: "missing"};
  return reviewAlbumOwner(found, session, entryScope, incoming?.link.ownerCard);
}

// This is invoked only by the explicit Join album gesture after sender review.
export async function joinAlbumInvitation(overview: AlbumOverviewV1, scope: ShareScope, reviewedOwner?: AccountCardV1) {
  const session = requireVault();
  const check = () => checkEntry(session, scope);
  check();
  if (reviewedOwner) {
    await ready; check(); albumOwner(overview, session, reviewedOwner);
    const identity = albumDefinitionIdentity(overview);
    const fresh = await albumInbox(scope); check();
    const current = fresh.find(item => albumDefinitionIdentity(item) === identity);
    if (!current) throw new Error("ALBUM_ACCESS_ENDED");
    albumOwner(current, session, reviewedOwner); check();
    await pinCard(reviewedOwner, scope); check(); overview = current;
  }
  const access = await AlbumAccess.open(overview, scope);
  try {check(); const accepted = overview.membership === "invited" ? await access.accept() : overview; check(); return accepted;}
  finally {access.dispose();}
}
