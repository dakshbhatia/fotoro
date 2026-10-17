import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {readSavedBrowsePage, subscribeSavedRefresh} from "../src/library/consumer-refresh";
import {photoChangeState, type ConsumerPhotoChanges} from "../src/library/consumer-changes";
import {requireVault} from "../src/vault/vault";
import {LocalTrial, bestShotSelectionRequestCurrent} from "../src/local/LocalTrial";

test("foreground and reconnect read refresh survive paused writes, while hidden and withdrawn accounts stay quiet", () => {
  const windowTarget = new EventTarget(), documentTarget = Object.assign(new EventTarget(), {visibilityState: "hidden"});
  let reads = 0;
  const detach = subscribeSavedRefresh(windowTarget, documentTarget, () => {reads++;});
  windowTarget.dispatchEvent(new Event("online"));
  windowTarget.dispatchEvent(new Event("focus"));
  windowTarget.dispatchEvent(new Event("pageshow"));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(reads, 0);
  documentTarget.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  windowTarget.dispatchEvent(new Event("online"));
  windowTarget.dispatchEvent(new Event("focus"));
  windowTarget.dispatchEvent(new Event("pageshow"));
  assert.equal(reads, 4, "Returning to a visible window, including browser Back, checks photos saved on another device");
  detach();
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  windowTarget.dispatchEvent(new Event("online"));
  windowTarget.dispatchEvent(new Event("focus"));
  windowTarget.dispatchEvent(new Event("pageshow"));
  assert.equal(reads, 4, "Account withdrawal removes every read trigger");
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
  assert.deepEqual(photoChangeState(changes, "a", "digest-a", "owner"), {pending: true, conflict: true, busy: false, automatic: false, error: "Storage is unavailable"});
  assert.deepEqual(photoChangeState(changes, "a", "replacement", "owner"), {pending: false, conflict: false, busy: false, automatic: false, error: ""});
  assert.equal(photoChangeState(changes, "b", "digest-a", "owner").error, "");
  assert.deepEqual(photoChangeState(changes, "a", "digest-a", "other-owner"), {pending: false, conflict: false, busy: false, automatic: false, error: ""});
  assert.deepEqual(photoChangeState(undefined, "a", "digest-a", "owner"), {pending: false, conflict: false, busy: false, automatic: false, error: ""});
  assert.equal(photoChangeState({...changes, errorSource: undefined}, "a", "digest-a", "owner").error, "Storage is unavailable");
  assert.equal(photoChangeState({...changes, pending: [], errorSource: undefined}, "a", "digest-a", "owner").error, "");
  assert.deepEqual(photoChangeState({...changes, current: () => false}, "a", "digest-a", "owner"), {pending: false, conflict: false, busy: false, automatic: false, error: ""});
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


test("a delayed best-shot selection follows user intent across metadata refreshes and manual edits", async () => {
  const source = {};
  let selectionRevision = 0;
  const request = {scope: "trip", source, selectionRevision};
  let selected = new Set(["manual"]);
  let complete!: (recommendations: string[]) => void;
  const recommendations = new Promise<string[]>(resolve => {complete = resolve;});
  const apply = recommendations.then(ids => {
    if (bestShotSelectionRequestCurrent(request, "trip", source, selectionRevision)) selected = new Set([...selected, ...ids]);
  });
  selected = new Set(selected); // OCR refreshed derived records without user selection changes.
  assert.equal(bestShotSelectionRequestCurrent(request, "trip", source, selectionRevision), true);
  complete(["recommended"]);
  await apply;
  assert.deepEqual([...selected], ["manual", "recommended"], "Metadata updates preserve additive completion");

  for (const edits of [[[]], [["different-manual"]], [["different-manual"], ["manual"]]]) {
    selected = new Set(["manual"]);
    const pendingRequest = {scope: "trip", source, selectionRevision};
    const pending = Promise.resolve(["recommended"]).then(ids => {
      if (bestShotSelectionRequestCurrent(pendingRequest, "trip", source, selectionRevision)) selected = new Set([...selected, ...ids]);
    });
    for (const ids of edits) {selected = new Set(ids); selectionRevision++;}
    await pending;
    assert.deepEqual([...selected], edits.at(-1), "Pending completion cannot undo Clear or edit-away-and-back intent");
  }
  assert.equal(bestShotSelectionRequestCurrent(request, "different filter", source, request.selectionRevision), false);
  assert.equal(bestShotSelectionRequestCurrent(request, "trip", {}, request.selectionRevision), false);
});

test("cached Saved paging publishes while an independent upload remains active", async () => {
  const controller = new AbortController(), keys = new Uint8Array([1, 2, 3]);
  let current = true, uploading = true, published = 0;
  const result = {photos: [{metadataKey: keys}] as import("../src/library/catalog").Photo[],
    coverage: {loaded: 200, cachedTotal: 300, hasMore: true, hasMoreChanges: false}};
  await readSavedBrowsePage({signal: controller.signal, current: () => current,
    read: async () => {assert.equal(uploading, true); return result;},
    publish: value => {assert.equal(value, result); published++;}});
  assert.equal(published, 1); assert.equal(uploading, true); assert.deepEqual([...keys], [1, 2, 3]);
  current = false; uploading = false;
});

test("cached Saved paging rejects withdrawn scope or cancellation and wipes unpublished keys", async () => {
  for (const withdrawal of ["scope", "cancel"]) {
    const controller = new AbortController(), keys = new Uint8Array([1, 2, 3]);
    let current = true, release!: () => void, publications = 0;
    const held = new Promise<void>(resolve => {release = resolve;});
    const reading = readSavedBrowsePage({signal: controller.signal, current: () => current,
      read: async () => {await held; return {photos: [{metadataKey: keys}] as import("../src/library/catalog").Photo[],
        coverage: {loaded: 200, cachedTotal: 300, hasMore: true, hasMoreChanges: false}};},
      publish: () => {publications++;}});
    if (withdrawal === "cancel") controller.abort(); else current = false;
    release();
    await assert.rejects(reading, {name: "AbortError"}, withdrawal);
    assert.equal(publications, 0); assert.ok(keys.every(byte => byte === 0), "Discarded read owns and wipes its copied metadata keys");
  }
});
