import test from "node:test";
import assert from "node:assert/strict";
import cards from "../../../fixtures/accounts.json";
import {createAlbumLink, parseAlbumLink} from "@fotoro/contracts/albums-links";
import {IncomingAlbumIntent} from "../src/albums/intent";
const invitation = () => parseAlbumLink(createAlbumLink(crypto.randomUUID(), cards.accounts[0]));
test("album invitation survives its own sign-in and binds the exact unlocked session", () => {
  const link = invitation(), intent = new IncomingAlbumIntent(link), ticket = intent.beginAuthentication(5);
  link.ownerCard.boxPublicKey = cards.accounts[1].boxPublicKey;
  assert.equal(intent.link.ownerCard.boxPublicKey, cards.accounts[0].boxPublicKey);
  assert.ok(Object.isFrozen(intent.link.ownerCard));
  intent.vaultLocked();
  const session = {accountId: cards.accounts[1].accountId};
  intent.finishAuthentication(ticket, session, 6);
  assert.equal(intent.current(session), true); assert.equal(intent.current({...session}), false);
  intent.vaultLocked(); assert.equal(intent.pending, false);
});
test("cancelled or superseded album sign-in cannot reopen a late invitation", () => {
  for (const cancel of [true, false]) {
    const intent = new IncomingAlbumIntent(invitation()), ticket = intent.beginAuthentication(4);
    if (cancel) intent.cancel();
    intent.finishAuthentication(ticket, {}, cancel ? 5 : 6);
    assert.equal(intent.pending, false); assert.equal(intent.current({}), false);
  }
});
test("expiry permits the original account to resume an album while another account cancels it", () => {
  for (const sameAccount of [true, false]) {
    const original = {accountId: cards.accounts[1].accountId}, intent = new IncomingAlbumIntent(invitation(), original);
    intent.vaultLocked("expired", original.accountId);
    const ticket = intent.beginAuthentication(10), renewed = {accountId: cards.accounts[sameAccount ? 1 : 0].accountId};
    intent.finishAuthentication(ticket, renewed, 11);
    assert.equal(intent.pending, sameAccount); assert.equal(intent.current(renewed), sameAccount);
  }
});
