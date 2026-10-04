import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {subscribeSavedRefresh} from "../src/library/consumer-refresh";
import {photoChangeState, type ConsumerPhotoChanges} from "../src/library/consumer-changes";
import {hasRememberedAccount} from "../src/vault/account-reference";
import {atomic, get, put} from "../src/exchange/cache";
import {requireVault} from "../src/vault/vault";
import {LocalTrial} from "../src/local/LocalTrial";

test("foreground and reconnect read refresh survive paused writes, while hidden and withdrawn accounts stay quiet", () => {
  const windowTarget = new EventTarget(), documentTarget = Object.assign(new EventTarget(), {visibilityState: "hidden"});
  let reads = 0;
  const detach = subscribeSavedRefresh(windowTarget, documentTarget, () => {reads++;});
  windowTarget.dispatchEvent(new Event("online"));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(reads, 0);
  documentTarget.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  windowTarget.dispatchEvent(new Event("online"));
  assert.equal(reads, 2);
  detach();
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  windowTarget.dispatchEvent(new Event("online"));
  assert.equal(reads, 2, "Account withdrawal removes both read triggers");
});

test("a remembered account offers Saved without retrieving a password, contacting the server or unlocking", async () => {
  const previous = await get("settings", "last-account"), fetch = globalThis.fetch;
  globalThis.fetch = (async () => {throw new Error("Remembered account lookup is local only");}) as typeof fetch;
  try {
    await put("settings", "last-account", {accountId: "invalid"});
    assert.equal(await hasRememberedAccount(), false);
    await put("settings", "last-account", "11111111-1111-4111-8111-111111111111");
    assert.equal(await hasRememberedAccount(), true);
    assert.throws(requireVault, /VAULT_LOCKED/);
    const markup = renderToStaticMarkup(createElement(LocalTrial, {onBackup() {}, rememberedAccount: true}));
    assert.match(markup, /Open Saved photos/);
    assert.match(markup, /same Fotoro password/);
    assert.match(markup, /Open photos from this device/);
    assert.throws(requireVault, /VAULT_LOCKED/);
  } finally {globalThis.fetch = fetch; await atomic([{store: "settings", key: "last-account", value: previous}]);}
});

test("viewer correction state follows the exact original and exposes a conflicting or failed edit without crossing sources", () => {
  const changes: ConsumerPhotoChanges = {token: {}, accountId: "owner", current: () => true, pending: [{photoId: "a", originalSha256: "digest-a", conflict: true}], busy: false, error: "Storage is unavailable", errorSource: {photoId: "a", originalSha256: "digest-a"}, save: async () => true, review() {}};
  assert.deepEqual(photoChangeState(changes, "a", "digest-a", "owner"), {pending: true, conflict: true, busy: false, error: "Storage is unavailable"});
  assert.deepEqual(photoChangeState(changes, "a", "replacement", "owner"), {pending: false, conflict: false, busy: false, error: ""});
  assert.equal(photoChangeState(changes, "b", "digest-a", "owner").error, "");
  assert.deepEqual(photoChangeState(changes, "a", "digest-a", "other-owner"), {pending: false, conflict: false, busy: false, error: ""});
  assert.deepEqual(photoChangeState(undefined, "a", "digest-a", "owner"), {pending: false, conflict: false, busy: false, error: ""});
  assert.equal(photoChangeState({...changes, errorSource: undefined}, "a", "digest-a", "owner").error, "Storage is unavailable");
  assert.equal(photoChangeState({...changes, pending: [], errorSource: undefined}, "a", "digest-a", "owner").error, "");
  assert.deepEqual(photoChangeState({...changes, current: () => false}, "a", "digest-a", "owner"), {pending: false, conflict: false, busy: false, error: ""});
});
