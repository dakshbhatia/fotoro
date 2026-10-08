import test from "node:test";
import assert from "node:assert/strict";
import {type ReactElement} from "react";
import cards from "../../../fixtures/accounts.json";
import {createAlbumLink, parseAlbumLink} from "@fotoro/contracts/albums-links";
import {IncomingAlbumIntent} from "../src/albums/intent";
import {AlbumPanel} from "../src/albums/AlbumPanel";
import type {Photo} from "../src/library/catalog";

function navigation() {
  const session = {accountId: cards.accounts[1].accountId};
  const incoming = new IncomingAlbumIntent(parseAlbumLink(createAlbumLink(crypto.randomUUID(), cards.accounts[0])), session);
  let open = true, selecting = false, completed = 0, selection: Photo[] = [];
  const currentPhotos: Photo[] = [];
  const render = () => AlbumPanel({selection, currentPhotos: () => currentPhotos, incoming,
    onClose() {open = false; selection = [];},
    onIncomingDone() {completed++; incoming.cancel();},
    onChoosePhotos() {selecting = true;},
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
  initial.onChoosePhotos();
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
    const flow = navigation(); albums(flow.render()).onChoosePhotos();
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
  const flow = navigation(); albums(flow.render()).onChoosePhotos();
  assert.equal(flow.incoming.current({...flow.session}), false, "Same account IDs cannot substitute a different vault session");
  flow.incoming.vaultLocked("expired", flow.session.accountId);
  const ticket = flow.incoming.beginAuthentication(8), renewed = {...flow.session};
  flow.incoming.finishAuthentication(ticket, renewed, 9);
  assert.equal(flow.incoming.current(renewed), true);
  assert.equal(flow.incoming.current(flow.session), false);
  assert.equal(albums(flow.reopen([])).incoming, flow.incoming);
});
