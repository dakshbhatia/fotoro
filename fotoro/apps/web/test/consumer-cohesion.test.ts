import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {subscribeSavedRefresh} from "../src/library/consumer-refresh";
import {photoChangeState, type ConsumerPhotoChanges} from "../src/library/consumer-changes";
import {requireVault} from "../src/vault/vault";
import {LocalTrial, bestShotSelectionRequestCurrent} from "../src/local/LocalTrial";

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

test("loaded Saved photos enter the browse grid, and a stale account returns to first use", () => {
  let current = true;
  const ownedPhotos = {accountId: "owner", token: {}, current: () => current,
    photos: [{manifest: {photoId: "saved-one", ownerAccountId: "owner"},
      metadata: {filename: "saved.jpg", sourceDate: "2026-10-06", dateSource: "import", originalSha256: "A".repeat(43)}}],
    preview: async () => new Blob()};
  const render = () => renderToStaticMarkup(createElement(LocalTrial, {onBackup() {}, ownedPhotos: ownedPhotos as any}));
  const markup = render();
  assert.match(markup, /aria-label="Photo grid"/);
  assert.match(markup, /aria-label="Search photos"/);
  assert.match(markup, /aria-pressed="false"[^>]*>Select<\/button>/, "Saved-only browsing keeps the primary selection action visible");
  assert.doesNotMatch(markup, /Open photos from this device/);
  current = false;
  const stale = render();
  assert.match(stale, /Open photos from this device/);
  assert.doesNotMatch(stale, /aria-label="Photo grid"|aria-label="Search photos"/);
});

test("a delayed best-shot selection cannot undo Clear or a newer manual choice", async () => {
  const source = {}, baseline = new Set(["manual"]);
  const request = {scope: "trip", source, selection: baseline};
  let complete!: (recommendations: string[]) => void;
  const recommendations = new Promise<string[]>(resolve => {complete = resolve;});
  let selected = baseline;
  const apply = recommendations.then(ids => {
    if (bestShotSelectionRequestCurrent(request, "trip", source, selected)) selected = new Set([...selected, ...ids]);
  });
  selected = new Set(); // User clears while the preview analysis is still pending.
  complete(["recommended"]);
  await apply;
  assert.deepEqual([...selected], []);
  assert.equal(bestShotSelectionRequestCurrent(request, "trip", source, new Set(["different-manual"])), false);
  assert.equal(bestShotSelectionRequestCurrent(request, "trip", source, new Set(["manual"])), false, "Editing away and back is newer intent");
  assert.equal(bestShotSelectionRequestCurrent(request, "different filter", source, baseline), false);
  assert.equal(bestShotSelectionRequestCurrent(request, "trip", {}, baseline), false);
  assert.equal(bestShotSelectionRequestCurrent(request, "trip", source, baseline), true, "Unchanged manual choices permit additive recommendations");
});
