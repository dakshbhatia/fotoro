import test from "node:test";
import assert from "node:assert/strict";
import {type ReactElement} from "react";
import cards from "../../../fixtures/accounts.json";
import {createAlbumLink, parseAlbumLink} from "@fotoro/contracts/albums-links";
import {IncomingAlbumIntent} from "../src/albums/intent";
import {AlbumEntryRevision, subscribeAlbumLifetime} from "../src/albums/entry";
import {AlbumContinuation} from "../src/albums/AlbumContinuation";
import {AlbumNameChoices} from "../src/albums/AlbumNameChoices";
import {AlbumPanel} from "../src/albums/AlbumPanel";
import type {Photo} from "../src/library/catalog";

function navigation(onChoice?: (albumId: string) => void) {
  const session = {accountId: cards.accounts[1].accountId};
  const incoming = new IncomingAlbumIntent(parseAlbumLink(createAlbumLink(crypto.randomUUID(), cards.accounts[0])), session);
  let open = true, selecting = false, completed = 0, selection: Photo[] = [];
  const currentPhotos: Photo[] = [];
  const render = () => AlbumPanel({selection, currentPhotos: () => currentPhotos, incoming,
    onClose() {open = false; selection = [];},
    onIncomingDone() {completed++; incoming.cancel();},
    onChoosePhotos(albumId) {selecting = true; onChoice?.(albumId);},
  });
  return {session, incoming, render, currentPhotos,
    state: () => ({open, selecting, completed, selection}),
    reopen(chosen: Photo[]) {selection = [...chosen]; open = true; return render();},
  };
}
// Invoke the actual callbacks passed by the production panel to its lazy Albums child.
const albums = (panel: ReturnType<typeof AlbumPanel>) => (panel.props as {children: ReactElement<any>}).children.props;

test("Choose photos preserves the exact invitation through selection and reopening without contributing", () => {
  const flow = navigation(), original = flow.incoming.link;
  const initial = albums(flow.render());
  initial.onChoosePhotos(original.albumId);
  assert.deepEqual(flow.state(), {open: false, selecting: true, completed: 0, selection: []});
  assert.equal(flow.incoming.current(flow.session), true);
  assert.equal(flow.incoming.link, original);
  const selected = {manifest: {photoId: crypto.randomUUID()}} as Photo;
  flow.currentPhotos.push(selected);
  const reopened = albums(flow.reopen([selected]));
  assert.equal(reopened.incoming, flow.incoming);
  assert.equal(reopened.incoming.link.albumId, original.albumId);
  assert.deepEqual(reopened.selection, [selected]);
  assert.equal(reopened.currentPhotos(), flow.currentPhotos);
  assert.equal(flow.state().completed, 0);
});

test("choosing photos from another active album completes the original invitation before reopening", () => {
  const flow = navigation(), otherAlbumId = crypto.randomUUID();
  assert.notEqual(otherAlbumId, flow.incoming.link.albumId);
  albums(flow.render()).onChoosePhotos(otherAlbumId);
  assert.deepEqual(flow.state(), {open: false, selecting: true, completed: 1, selection: []});
  assert.equal(flow.incoming.pending, false);
  assert.equal(flow.incoming.current(flow.session), false);
  const selected = {manifest: {photoId: crypto.randomUUID()}} as Photo;
  flow.currentPhotos.push(selected);
  const reopened = albums(flow.reopen([selected]));
  assert.equal(reopened.incoming, undefined, "Reopening must not redirect from the selected album to the original invitation");
  assert.deepEqual(reopened.selection, [selected]);
  assert.equal(reopened.currentPhotos(), flow.currentPhotos);
  assert.equal(flow.state().completed, 1);
});

test("explicit Close completes the invitation from both the loaded panel and loading fallback", () => {
  for (const loading of [false, true]) {
    const flow = navigation(), panel = flow.render();
    if (loading) {
      const fallback = (panel.props as any).fallback;
      fallback.props.children.props.children[1].props.onClick();
    } else albums(panel).onClose();
    assert.equal(flow.state().open, false);
    assert.equal(flow.state().completed, 1);
    assert.equal(flow.incoming.pending, false);
    assert.equal(albums(flow.reopen([])).incoming, undefined);
  }
});

test("a retained invitation cannot return after manual lock or an expired-account swap", () => {
  for (const expired of [false, true]) {
    const flow = navigation(); albums(flow.render()).onChoosePhotos(flow.incoming.link.albumId);
    flow.incoming.vaultLocked(expired ? "expired" : "manual", flow.session.accountId);
    assert.equal(flow.incoming.current(flow.session), false);
    if (expired) {
      const ticket = flow.incoming.beginAuthentication(10);
      flow.incoming.finishAuthentication(ticket, {accountId: cards.accounts[0].accountId}, 11);
    }
    assert.equal(flow.incoming.pending, false);
    assert.equal(albums(flow.reopen([])).incoming, undefined);
  }
});

test("a retained invitation resumes only after its original expired account unlocks", () => {
  const flow = navigation(); albums(flow.render()).onChoosePhotos(flow.incoming.link.albumId);
  assert.equal(flow.incoming.current({...flow.session}), false, "Same account IDs cannot substitute a different vault session");
  flow.incoming.vaultLocked("expired", flow.session.accountId);
  const ticket = flow.incoming.beginAuthentication(8), renewed = {...flow.session};
  flow.incoming.finishAuthentication(ticket, renewed, 9);
  assert.equal(flow.incoming.current(renewed), true);
  assert.equal(flow.incoming.current(flow.session), false);
  assert.equal(albums(flow.reopen([])).incoming, flow.incoming);
});

test("mounted album teardown preserves account correction and same-account expiry until sign-in returns", () => {
  for (const reason of ["retry", "expired"] as const) {
    const flow = navigation(), windowTarget = new EventTarget(), documentTarget = Object.assign(new EventTarget(), {visibilityState: "visible"});
    const request = new AbortController(); let disposed = 0;
    windowTarget.addEventListener("fotoro-lock", () => flow.incoming.vaultLocked(reason === "retry" ? "manual" : "expired", flow.session.accountId));
    const detach = subscribeAlbumLifetime(windowTarget, documentTarget, () => {disposed++; request.abort();}, albums(flow.render()).onClose);
    if (reason === "retry") flow.incoming.retryPassword();
    // lockVault dispatches synchronously before React can unmount the mounted panel.
    windowTarget.dispatchEvent(new Event("fotoro-lock"));
    assert.equal(flow.incoming.pending, true, "Lifecycle teardown must not invoke explicit invitation completion");
    assert.equal(flow.state().completed, 0);
    assert.equal(disposed, 1); assert.equal(request.signal.aborted, true, "Stale requests stop immediately while the public intent survives");
    const ticket = flow.incoming.beginAuthentication(12), renewed = {accountId: cards.accounts[reason === "retry" ? 0 : 1].accountId};
    flow.incoming.finishAuthentication(ticket, renewed, 13);
    assert.equal(flow.incoming.current(renewed), true);
    detach();
  }
});


test("Choose photos → one chosen Saved photo → direct continuation passes exact album and selection to the panel", () => {
  let destination: string | undefined;
  const flow = navigation(id => {destination = id;});
  // Invoke the production panel's callback, not an independently recreated route.
  albums(flow.render()).onChoosePhotos(flow.incoming.link.albumId);
  assert.equal(destination, flow.incoming.link.albumId);
  const selected = {manifest: {photoId: crypto.randomUUID()}} as Photo;
  let current = true, reopened: ReturnType<typeof AlbumPanel> | undefined, opens = 0;
  const button = AlbumContinuation({destination: {albumId: destination!, current: () => current}, photos: [selected], onContinue: (photos, id) => {
    opens++; assert.equal(id, destination); reopened = AlbumPanel({selection: photos, initialAlbumId: id, incoming: flow.incoming,
      currentPhotos: () => [selected], onClose: () => {}, onChoosePhotos: () => {}});
  }})!;
  button.props.onClick();
  assert.equal(opens, 1);
  assert.deepEqual(albums(reopened!).selection, [selected]);
  assert.equal(albums(reopened!).initialAlbumId, destination);
  assert.equal(albums(reopened!).incoming, flow.incoming);
  current = false; button.props.onClick(); assert.equal(opens, 1, "A captured continuation cannot reopen after lock/account change");
  assert.equal(AlbumContinuation({destination: {albumId: destination!, current: () => false}, photos: [selected], onContinue: () => assert.fail()}), null);
});

test("reviewed names are individually opt-in and a photo with 13 names can share any selected subset up to12", () => {
  const names = Array.from({length: 13}, (_, index) => "Reviewed " + index);
  let selected: string[] = [];
  const render = () => AlbumNameChoices({names, selected, onChange: next => {selected = next;}});
  const inputs = () => (render().props.children[2] as ReactElement<any>[]).map(label => label.props.children[0]);
  assert.equal(inputs().every(input => input.props.checked === false), true);
  inputs()[12].props.onChange({target: {checked: true}});
  assert.deepEqual(selected, [names[12]], "No first12 truncation or automatic name choice");
  for (let index = 0; index < 11; index++) inputs()[index].props.onChange({target: {checked: true}});
  assert.equal(selected.length, 12); assert.equal(inputs()[11].props.disabled, true);
  inputs()[11].props.onChange({target: {checked: true}}); assert.equal(selected.length, 12);
  inputs()[0].props.onChange({target: {checked: false}}); assert.equal(selected.length, 11);
  assert.equal(inputs()[11].props.disabled, false);
});


test("same-page invitation replacement remounts the entry and cannot inherit the prior album's chosen snapshot", () => {
  const entry = new AlbumEntryRevision(), a = navigation(), b = navigation();
  const keyA = entry.key(a.incoming), chosen = {manifest: {photoId: crypto.randomUUID()}} as Photo;
  const selectionA = entry.capture([chosen]);
  assert.equal(entry.key(a.incoming), keyA); assert.deepEqual(entry.photos(selectionA), [chosen]);
  const keyB = entry.key(b.incoming); assert.notEqual(keyB, keyA);
  assert.deepEqual(entry.photos(selectionA), [], "The new panel's first render must not capture A's old choices before passive effects clear them");
  const continuationB = entry.capture([chosen]);
  assert.equal(entry.key(b.incoming), keyB); assert.deepEqual(entry.photos(continuationB), [chosen], "Ordinary Choose → Continue leaves the same entry revision and preserves explicit choices");
  const replacement = new IncomingAlbumIntent(b.incoming.link, b.session);
  b.incoming.cancel(); assert.equal(b.incoming.current(b.session), false);
  assert.notEqual(entry.key(replacement), keyB, "A fresh link to the same album also needs a new lifetime because the prior scope was cancelled");
  assert.deepEqual(entry.photos(continuationB), []);
});
