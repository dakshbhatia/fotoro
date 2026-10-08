import type {AlbumOverviewV1} from "@fotoro/contracts/albums";
import {ALBUM_DEFINITION_KIND, readAlbumSignedBody, validateAlbumDefinition} from "@fotoro/contracts/albums";
import {verifyAlbumDefinition} from "@fotoro/crypto/albums";
import {ApiError} from "../exchange/api-errors";
import {trustedCard, type ShareScope} from "../exchange/share-service";
import {sameIdentity} from "../exchange/sharing";
import {assertVault} from "../vault/scope";
import type {UnlockedVault} from "../vault/vault";
import type {IncomingAlbumIntent} from "./intent";
import {albumCapabilities} from "./service";

export function unsupportedAlbumCapabilities(error: unknown) {
  return error instanceof Error && error.message === "ALBUM_UPDATE_REQUIRED" ||
    error instanceof ApiError && ["NOT_FOUND", "HTTP_404", "HTTP_501"].includes(error.code);
}

// Initial entry and explicit retries use the same owner verification and captured vault.
export async function loadAlbumEntry({session, scope, incoming, loadInbox, onAvailable}: {
  session: UnlockedVault; scope: ShareScope; incoming?: IncomingAlbumIntent;
  loadInbox: () => Promise<AlbumOverviewV1[] | undefined>; onAvailable: () => void;
}): Promise<{kind: "inbox"} | {kind: "missing"} | {kind: "review"; overview: AlbumOverviewV1; changed: boolean} | {kind: "open"; overview: AlbumOverviewV1}> {
  const check = () => {
    assertVault(session); scope.signal?.throwIfAborted();
    if (scope.current?.() === false || incoming && !incoming.current(session)) throw new DOMException("Album closed", "AbortError");
  };
  check(); await albumCapabilities(scope); check(); onAvailable();
  const list = await loadInbox(); check();
  if (!incoming) return {kind: "inbox"};
  const found = list?.find(item => readAlbumSignedBody(item.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition).albumId === incoming.link.albumId);
  if (!found) return {kind: "missing"};
  verifyAlbumDefinition(found.definition, incoming.link.ownerCard);
  let trusted;
  try {trusted = await trustedCard(incoming.link.ownerCard.accountId, session, scope);}
  catch (error) {if (!(error instanceof Error && error.message === "PIN_ACCOUNT_CARD_FROM_TRUSTED_CHANNEL")) throw error;}
  check();
  return !trusted || !sameIdentity(trusted, incoming.link.ownerCard)
    ? {kind: "review", overview: found, changed: !!trusted} : {kind: "open", overview: found};
}
