import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {subscribeSavedRefresh} from "../src/library/consumer-refresh";
import {photoChangeState, type ConsumerPhotoChanges} from "../src/library/consumer-changes";
import {requireVault} from "../src/vault/vault";
import {LocalTrial} from "../src/local/LocalTrial";

test("foreground and reconnect read refresh survive paused writes, while hidden and withdrawn accounts stay quiet", () => {
  const windowTarget = new EventTarget(), documentTarget = Object.assign(new EventTarget(), {visibilityState: "hidden"});
  let reads = 0;
  const detach = subscribeSavedRefresh(windowTarget, documentTarget, () => {reads++;});
  windowTarget.dispatchEvent(new Event("online"));
  windowTarget.dispatchEvent(new Event("focus"));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(reads, 0);
  documentTarget.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  windowTarget.dispatchEvent(new Event("online"));
  windowTarget.dispatchEvent(new Event("focus"));
  assert.equal(reads, 3, "Returning to a visible window checks photos saved on another device");
  detach();
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  windowTarget.dispatchEvent(new Event("online"));
  windowTarget.dispatchEvent(new Event("focus"));
  assert.equal(reads, 3, "Account withdrawal removes every read trigger");
});

test("first use offers Saved and device photos without contacting the server or unlocking", () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = (async () => {throw new Error("Browsing entry must not contact the server");}) as typeof fetch;
  try {
    assert.throws(requireVault, /VAULT_LOCKED/);
    const markup = renderToStaticMarkup(createElement(LocalTrial, {onBackup() {}}));
    assert.match(markup, /Open Saved photos/);
    assert.match(markup, /Open photos from this device/);
    assert.throws(requireVault, /VAULT_LOCKED/);
  } finally {globalThis.fetch = fetch;}
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
