import type {AlbumOverviewV1} from "@fotoro/contracts/albums";
import {ALBUM_DEFINITION_KIND, readAlbumSignedBody, validateAlbumDefinition} from "@fotoro/contracts/albums";
import {verifyAlbumDefinition} from "@fotoro/crypto/albums";
import {ApiError} from "../exchange/api-errors";
import {pinCard, trustedCard, type ShareScope} from "../exchange/share-service";
import {sameIdentity} from "../exchange/sharing";
import {assertVault} from "../vault/scope";
import {requireVault, type UnlockedVault} from "../vault/vault";
import type {AccountCardV1} from "@fotoro/contracts";
import type {IncomingAlbumIntent} from "./intent";
import {AlbumAccess, albumCapabilities} from "./service";

export function unsupportedAlbumCapabilities(error: unknown) {
  return error instanceof Error && error.message === "ALBUM_UPDATE_REQUIRED" ||
    error instanceof ApiError && ["NOT_FOUND", "HTTP_404", "HTTP_501"].includes(error.code);
}

// Initial entry and explicit retries use the same owner verification and captured vault.
export async function loadAlbumEntry({session, scope, incoming, albumId, loadInbox, onAvailable}: {
  session: UnlockedVault; scope: ShareScope; incoming?: IncomingAlbumIntent; albumId?: string;
  loadInbox: () => Promise<AlbumOverviewV1[] | undefined>; onAvailable: () => void;
}): Promise<{kind: "inbox"} | {kind: "missing"} | {kind: "review"; overview: AlbumOverviewV1; changed: boolean} | {kind: "open"; overview: AlbumOverviewV1}> {
  const check = () => {
    assertVault(session); scope.signal?.throwIfAborted();
    if (scope.current?.() === false || incoming && !incoming.current(session)) throw new DOMException("Album closed", "AbortError");
  };
  check(); await albumCapabilities(scope); check(); onAvailable();
  const list = await loadInbox(); check();
  if (!incoming && !albumId) return {kind: "inbox"};
  const found = list?.find(item => readAlbumSignedBody(item.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition).albumId === (incoming?.link.albumId ?? albumId));
  if (!found) return {kind: "missing"};
  if (!incoming) return {kind: "open", overview: found};
  verifyAlbumDefinition(found.definition, incoming.link.ownerCard);
  let trusted;
  try {trusted = await trustedCard(incoming.link.ownerCard.accountId, session, scope);}
  catch (error) {if (!(error instanceof Error && error.message === "PIN_ACCOUNT_CARD_FROM_TRUSTED_CHANNEL")) throw error;}
  check();
  return !trusted || !sameIdentity(trusted, incoming.link.ownerCard)
    ? {kind: "review", overview: found, changed: !!trusted} : {kind: "open", overview: found};
}

// This is invoked only by the explicit Join album gesture after sender review.
export async function joinAlbumInvitation(overview: AlbumOverviewV1, scope: ShareScope, reviewedOwner?: AccountCardV1) {
  const session = requireVault();
  const check = () => {assertVault(session); scope.signal?.throwIfAborted(); if (scope.current?.() === false) throw new DOMException("Album closed", "AbortError");};
  check();
  if (reviewedOwner) {verifyAlbumDefinition(overview.definition, reviewedOwner); check(); await pinCard(reviewedOwner, scope); check();}
  const access = await AlbumAccess.open(overview, scope);
  try {check(); const accepted = overview.membership === "invited" ? await access.accept() : overview; check(); return accepted;}
  finally {access.dispose();}
}
