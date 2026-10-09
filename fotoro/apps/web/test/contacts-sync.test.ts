import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64, unwrapKey, verifyPayload} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault} from "../src/vault/vault";
import {clearAccount, all} from "../src/exchange/cache";
import * as sharing from "../src/exchange/share-service";

const owner = "11111111-1111-4111-8111-111111111111";
async function open() {
  await ready;
  const secret = accounts.testSecrets[0];
  configureVault({version: 1, accountCard: {...accounts.accounts[0], accountId: owner}, wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
test("approved contacts upload encrypted and restore on an empty same-account browser", async () => {
  const session = await open(), old = globalThis.fetch;
  let stored: any = null;
  globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
    if (options.method === "PUT") stored = JSON.parse(options.body as string);
    return new Response(JSON.stringify({version: 1, contacts: stored}));
  }) as any;
  try {
    await sharing.pinCard(accounts.accounts[1]);
    await sharing.saveContactName(accounts.accounts[1].accountId, "家族 🐈");
    await syncContacts(session);
    assert.ok(stored, "approved contacts must reach the encrypted account book");
    assert.doesNotMatch(JSON.stringify(stored), /家族|boxPublicKey/);
    const update = JSON.parse(new TextDecoder().decode(verifyPayload(stored, unb64(session.card.signingPublicKey))));
    const book = JSON.parse(new TextDecoder().decode(unwrapKey(update.encrypted, session.vaultKey)));
    assert.equal(book.entries[0].name, "家族 🐈");
    assert.doesNotMatch(JSON.stringify(await all("settings")), /家族|boxPublicKey/);
    await clearAccount(owner);
    await syncContacts(session);
    assert.deepEqual(await sharing.contacts(), [accounts.accounts[1]]);
    assert.equal((await sharing.contactNames()).get(accounts.accounts[1].accountId), "家族 🐈");
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

import {signPayload, utf8, wrapKey} from "@fotoro/crypto";
import {syncContacts, contactSyncState, resolveContactConflict} from "../src/exchange/contacts";
import type {AccountContactsV1, SignedPayloadV1} from "@fotoro/contracts";
const peer = accounts.accounts[1];
function signedBook(session: Awaited<ReturnType<typeof open>>, revision: number, entries: AccountContactsV1["entries"], signedOwner = owner) {
  return signPayload("account-contacts", signedOwner, utf8({version: 1, revision, encrypted: wrapKey(utf8({version: 1, ownerAccountId: owner, entries}), session.vaultKey)}), session.signingSecretKey);
}
const reply = (contacts: SignedPayloadV1 | null) => new Response(JSON.stringify({version: 1, contacts}));
function server(initial: SignedPayloadV1 | null = null) {
  const fixture = {stored: initial, puts: [] as SignedPayloadV1[], failReply: false, hold: undefined as undefined | (() => Promise<void>)};
  globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
    if (options.method === "PUT") {
      const pending = JSON.parse(options.body as string); fixture.puts.push(pending); fixture.stored = pending;
      if (fixture.hold) {const held = fixture.hold; fixture.hold = undefined; await held();}
      if (fixture.failReply) {fixture.failReply = false; throw new TypeError("Lost reply");}
    }
    return reply(fixture.stored);
  }) as any;
  return fixture;
}

test("lost upload response retries identical ciphertext and preserves a newer local name", async () => {
  const session = await open(), old = globalThis.fetch, remote = server();
  try {
    await sharing.pinCard(peer); await sharing.saveContactName(peer.accountId, "First");
    remote.failReply = true;
    await assert.rejects(syncContacts(session), /Lost reply/);
    await sharing.saveContactName(peer.accountId, "Newest");
    await syncContacts(session);
    assert.deepEqual(remote.puts[0], remote.puts[1]);
    assert.equal(remote.puts.length, 3);
    assert.equal((await sharing.contactNames()).get(peer.accountId), "Newest");
    assert.equal((await contactSyncState()).pending, false);
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("edits during an upload remain durable and concurrent writes keep both contacts", async () => {
  const session = await open(), old = globalThis.fetch, remote = server();
  let release!: () => void, began!: () => void;
  const entered = new Promise<void>(resolve => {began = resolve;});
  const held = new Promise<void>(resolve => {release = resolve;});
  try {
    await sharing.pinCard(peer); await sharing.saveContactName(peer.accountId, "Before");
    remote.hold = async () => {began(); await held;};
    const uploading = syncContacts(session); await entered;
    const second = {...peer, accountId: "22222222-2222-4222-8222-222222222222"};
    await Promise.all([sharing.saveContactName(peer.accountId, "During"), sharing.pinCard(second)]);
    release(); await uploading;
    assert.equal((await sharing.contacts()).length, 2);
    assert.equal((await sharing.contactNames()).get(peer.accountId), "During");
    assert.equal((await contactSyncState()).pending, false);
  } finally {release?.(); globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("remote changed keys require exact review, survive refresh, and unrelated names merge", async () => {
  const session = await open(), old = globalThis.fetch, remote = server();
  try {
    await sharing.pinCard(peer); await sharing.saveContactName(peer.accountId, "Before"); await syncContacts(session);
    const changed = {...accounts.accounts[0], accountId: peer.accountId};
    remote.stored = signedBook(session, 2, [{accountId: peer.accountId, card: changed, name: "Other device"}]);
    const count = remote.puts.length;
    await syncContacts(session); await syncContacts(session);
    assert.deepEqual(await sharing.trustedCard(peer.accountId), peer);
    assert.equal((await sharing.contactNames()).get(peer.accountId), "Other device");
    const review = (await contactSyncState()).conflicts[0];
    assert.deepEqual(review.fields, ["card"]); assert.equal(remote.puts.length, count);
    await assert.rejects(resolveContactConflict({...review, remote: {...review.remote!, name: "Stale"}}, "remote"), /CONTACT_REVIEW_CHANGED/);
    assert.deepEqual(await sharing.trustedCard(peer.accountId), peer);
    await resolveContactConflict(review, "remote");
    assert.deepEqual(await sharing.trustedCard(peer.accountId), changed);
    assert.equal((await contactSyncState()).conflicts.length, 0);
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("same-field name conflicts require a choice and keeping this device uploads that choice", async () => {
  const session = await open(), old = globalThis.fetch, remote = server();
  try {
    await sharing.pinCard(peer); await sharing.saveContactName(peer.accountId, "Before"); await syncContacts(session);
    await sharing.saveContactName(peer.accountId, "This device");
    remote.stored = signedBook(session, 2, [{accountId: peer.accountId, card: peer, name: "Synced device"}]);
    await syncContacts(session); await syncContacts(session);
    const review = (await contactSyncState()).conflicts[0]; assert.deepEqual(review.fields, ["name"]);
    assert.equal((await sharing.contactNames()).get(peer.accountId), "This device");
    await resolveContactConflict(review, "local"); await syncContacts(session);
    assert.equal((await contactSyncState()).pending, false);
    assert.equal((await sharing.contactNames()).get(peer.accountId), "This device");
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("rollback, signature tampering and owner mismatch cannot replace trusted contacts", async () => {
  const session = await open(), old = globalThis.fetch, remote = server();
  try {
    await sharing.pinCard(peer); await syncContacts(session);
    const good = remote.stored!;
    remote.stored = null; await assert.rejects(syncContacts(session), /CONTACT_REVISION_MISMATCH/);
    remote.stored = {...good, signature: "A".repeat(good.signature.length)}; await assert.rejects(syncContacts(session));
    remote.stored = signedBook(session, 2, [], peer.accountId); await assert.rejects(syncContacts(session), /CONTACT_OWNER_MISMATCH/);
    assert.deepEqual(await sharing.trustedCard(peer.accountId), peer);
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("a stale account response cannot publish contacts or send the pending book", async () => {
  const session = await open(), old = globalThis.fetch;
  let release!: () => void, began!: () => void, sends = 0;
  const entered = new Promise<void>(resolve => {began = resolve;});
  const held = new Promise<void>(resolve => {release = resolve;});
  const payload = signedBook(session, 1, [{accountId: peer.accountId, card: peer, name: "Private"}]);
  globalThis.fetch = (async (_url: unknown, options: RequestInit) => {sends++; began(); await held; return reply(payload);}) as any;
  try {
    const syncing = syncContacts(session); const rejected = assert.rejects(syncing, /VAULT_LOCKED/); await entered;
    lockVault(); release(); await rejected;
    assert.equal(sends, 1);
    assert.equal((await all("settings")).filter(([key]) => key === owner + ":pin:" + peer.accountId).length, 0);
  } finally {release?.(); globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("a pre-upgrade server leaves approved local contacts intact without uploading", async () => {
  const session = await open(), old = globalThis.fetch; let sends = 0;
  globalThis.fetch = (async () => {sends++; return new Response(JSON.stringify({code: "NOT_FOUND"}), {status: 404});}) as any;
  try {
    await sharing.pinCard(peer); await sharing.saveContactName(peer.accountId, "Offline family");
    await assert.rejects(syncContacts(session), /NOT_FOUND/);
    assert.equal(sends, 1); assert.deepEqual(await sharing.trustedCard(peer.accountId), peer);
    assert.equal((await sharing.contactNames()).get(peer.accountId), "Offline family");
    assert.equal((await contactSyncState()).pending, true);
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("CAS conflict merges unrelated remote contacts and preserves explicit tombstones", async () => {
  const session = await open(), old = globalThis.fetch;
  const third = {...peer, accountId: "33333333-3333-4333-8333-333333333333"};
  let stored: SignedPayloadV1 | null = null, raced = false, puts = 0;
  globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
    if (options.method === "PUT") {
      puts++;
      if (!raced) {raced = true; stored = signedBook(session, 1, [{accountId: third.accountId, card: third, name: "Other contact"}, {accountId: "44444444-4444-4444-8444-444444444444", card: null, name: ""}]); return new Response(JSON.stringify({code: "CONTACTS_VERSION_CONFLICT"}), {status: 409});}
      stored = JSON.parse(options.body as string);
    }
    return reply(stored);
  }) as any;
  try {
    await sharing.pinCard(peer); await syncContacts(session);
    assert.equal(puts, 2); assert.equal((await sharing.contacts()).length, 2);
    assert.equal((await contactSyncState()).pending, false);
    const book = JSON.parse(new TextDecoder().decode(unwrapKey(JSON.parse(new TextDecoder().decode(verifyPayload(stored!, unb64(session.card.signingPublicKey)))).encrypted, session.vaultKey)));
    assert.equal(book.entries.find((entry: any) => entry.accountId.startsWith("44444444")).card, null);
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("a concurrent remote removal stays pending review and a name-only edit does not invalidate trust", async () => {
  const session = await open(), old = globalThis.fetch, remote = server();
  const {contactTrustVersion} = await import("../src/exchange/contacts");
  try {
    await sharing.pinCard(peer); const trust = contactTrustVersion(owner);
    await sharing.saveContactName(peer.accountId, "Before"); await syncContacts(session);
    assert.equal(contactTrustVersion(owner), trust);
    await sharing.saveContactName(peer.accountId, "Edited here");
    remote.stored = signedBook(session, 2, [{accountId: peer.accountId, card: null, name: ""}]);
    await syncContacts(session); await syncContacts(session);
    const review = (await contactSyncState()).conflicts[0]; assert.deepEqual(review.fields, ["deleted"]);
    assert.deepEqual(await sharing.trustedCard(peer.accountId), peer);
    await resolveContactConflict(review, "remote");
    await assert.rejects(sharing.trustedCard(peer.accountId), /PIN_ACCOUNT_CARD/);
    assert.equal(contactTrustVersion(owner), trust + 1);
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("local legacy import keeps a valid pin when its optional name is malformed", async () => {
  const session = await open(), old = globalThis.fetch, remote = server();
  const {put} = await import("../src/exchange/cache");
  try {
    await put("settings", owner + ":pin:" + peer.accountId, wrapKey(utf8(peer), session.vaultKey));
    await put("settings", owner + ":contact-name:" + peer.accountId, {version: 1, nonce: "bad", ciphertext: "bad"});
    await syncContacts(session);
    assert.deepEqual(await sharing.trustedCard(peer.accountId), peer);
    assert.equal((await contactSyncState()).pending, false); assert.equal(remote.puts.length, 1);
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("cancelled scopes and changed API origins cannot publish a late verified book", async () => {
  for (const mode of ["scope", "origin"]) {
    const session = await open(), old = globalThis.fetch, priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    let release!: () => void, began!: () => void, current = true;
    const entered = new Promise<void>(resolve => {began = resolve;});
    const held = new Promise<void>(resolve => {release = resolve;});
    const payload = signedBook(session, 1, [{accountId: peer.accountId, card: peer, name: "Private"}]);
    Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://first.test"}});
    globalThis.fetch = (async () => {began(); await held; return reply(payload);}) as any;
    try {
      const syncing = syncContacts(session, {current: () => current}); const rejected = assert.rejects(syncing, {name: "AbortError"}); await entered;
      if (mode === "scope") current = false; else Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://second.test"}});
      release(); await rejected;
      await assert.rejects(sharing.trustedCard(peer.accountId), /PIN_ACCOUNT_CARD/);
    } finally {release?.(); if (priorLocation) Object.defineProperty(globalThis, "location", priorLocation); else delete (globalThis as any).location; globalThis.fetch = old; await clearAccount(owner); lockVault();}
  }
});

test("a displayed conflict choice cannot discard a newer local edit", async () => {
  const session = await open(), old = globalThis.fetch, remote = server();
  try {
    await sharing.pinCard(peer); await sharing.saveContactName(peer.accountId, "Before"); await syncContacts(session);
    await sharing.saveContactName(peer.accountId, "Local");
    const changed = {...accounts.accounts[0], accountId: peer.accountId};
    remote.stored = signedBook(session, 2, [{accountId: peer.accountId, card: changed, name: "Remote"}]);
    await syncContacts(session); const reviewed = (await contactSyncState()).conflicts[0];
    await sharing.saveContactName(peer.accountId, "Newer local");
    await assert.rejects(resolveContactConflict(reviewed, "remote"), /CONTACT_REVIEW_CHANGED/);
    assert.equal((await sharing.contactNames()).get(peer.accountId), "Newer local");
    assert.deepEqual(await sharing.trustedCard(peer.accountId), peer);
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("correctly signed malformed UTF-8 cannot become a replacement-character contact name", async () => {
  const session = await open(), old = globalThis.fetch;
  try {
    const text = JSON.stringify({version: 1, ownerAccountId: owner, entries: [{accountId: peer.accountId, card: peer, name: "X"}]}), bytes = new TextEncoder().encode(text);
    bytes[text.indexOf('"name":"X"') + 8] = 0xff;
    const signed = signPayload("account-contacts", owner, utf8({version: 1, revision: 1, encrypted: wrapKey(bytes, session.vaultKey)}), session.signingSecretKey);
    globalThis.fetch = (async () => reply(signed)) as any;
    await assert.rejects(syncContacts(session));
    assert.deepEqual(await sharing.contacts(), []);
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("the shared native/browser signed fixture restores Unicode names and tombstones without public-account uploads", async () => {
  const fixture = (await import("../../../fixtures/contact-sync-v1.json")).default;
  const old = globalThis.fetch; let puts = 0;
  await ready; const secret = accounts.testSecrets[0], fixtureOwner = accounts.accounts[0].accountId;
  configureVault({version: 1, accountCard: accounts.accounts[0], wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  const session = await unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
  globalThis.fetch = (async (_url: unknown, options: RequestInit) => {if (options.method === "PUT") puts++; return reply(fixture.crypto.signed as SignedPayloadV1);}) as any;
  try {
    await syncContacts(session);
    assert.equal((await sharing.contactNames()).get(peer.accountId), "Mum · 妈妈 💛");
    await sharing.saveContactName(peer.accountId, "Public local edit"); await syncContacts(session);
    assert.equal(puts, 0); assert.equal((await contactSyncState()).pending, true);
  } finally {globalThis.fetch = old; await clearAccount(fixtureOwner); lockVault();}
});

test("clean contact refresh never scans unrelated settings or rewrites encrypted projections", async () => {
  const session = await open(), old = globalThis.fetch, remote = server();
  const {put, get} = await import("../src/exchange/cache"), originalCursor = IDBObjectStore.prototype.openCursor;
  const ranges: Array<IDBKeyRange | IDBValidKey | null | undefined> = [];
  try {
    await sharing.pinCard(peer); await sharing.saveContactName(peer.accountId, "Family");
    await put("settings", owner + ":annotations:unrelated", {opaque: "unrelated photo facts"});
    const pin = await get("settings", owner + ":pin:" + peer.accountId), name = await get("settings", owner + ":contact-name:" + peer.accountId);
    IDBObjectStore.prototype.openCursor = function(range, direction) {if (this.name === "settings") ranges.push(range); return originalCursor.call(this, range, direction);};
    await syncContacts(session); await contactSyncState(); await syncContacts(session);
    assert.deepEqual(await get("settings", owner + ":pin:" + peer.accountId), pin);
    assert.deepEqual(await get("settings", owner + ":contact-name:" + peer.accountId), name);
    assert.equal(ranges.length, 0, "an established contact ledger reads only its own journal record");
    assert.equal(remote.puts.length, 1);
  } finally {IDBObjectStore.prototype.openCursor = originalCursor; globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("a foreground scope can resume after an older lifecycle sync was aborted", async () => {
  const session = await open(), old = globalThis.fetch, controller = new AbortController();
  let release!: () => void, began!: () => void, sends = 0;
  const entered = new Promise<void>(resolve => {began = resolve;});
  const held = new Promise<void>(resolve => {release = resolve;});
  const payload = signedBook(session, 1, [{accountId: peer.accountId, card: peer, name: "Restored"}]);
  globalThis.fetch = (async () => {sends++; if (sends === 1) {began(); await held;} return reply(payload);}) as any;
  try {
    const previous = syncContacts(session, {signal: controller.signal}), rejected = assert.rejects(previous, {name: "AbortError"});
    await entered; controller.abort();
    const resumed = syncContacts(session); release(); await rejected; await resumed;
    assert.equal(sends, 2); assert.equal((await sharing.contactNames()).get(peer.accountId), "Restored");
  } finally {release?.(); globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("contact sync diagnostics join GET and PUT without recording private contact data", async () => {
  const session = await open(), old = globalThis.fetch; server();
  const {clearDiagnostics, exportDiagnostics} = await import("../src/diagnostics");
  try {
    clearDiagnostics(); await sharing.pinCard(peer); await sharing.saveContactName(peer.accountId, "Private contact 🐈"); await syncContacts(session);
    const text = exportDiagnostics(), events = JSON.parse(text).events;
    assert.doesNotMatch(text, /Private contact|accountId|boxPublicKey|signingPublicKey|ciphertext/);
    const action = events.filter((event: any) => event.operation === "share" && event.step === "action");
    assert.deepEqual(action.map((event: any) => event.outcome), ["started", "succeeded"]);
    assert.equal(action[1].count, 2); assert.equal(action[1].action, "refresh");
    assert.equal(new Set(events.map((event: any) => event.traceId)).size, 1);
  } finally {globalThis.fetch = old; await clearAccount(owner); lockVault();}
});

test("an edit requested during final acknowledgement drains after the current flight", async () => {
  const session = await open(), old = globalThis.fetch, remote = server();
  const {subscribeContacts} = await import("../src/exchange/contacts");
  let latest: Promise<void> | undefined, joined: Promise<unknown> | undefined;
  const detach = subscribeContacts(() => {
    if (!remote.puts.length || latest) return;
    latest = sharing.saveContactName(peer.accountId, "At acknowledgement");
    joined = syncContacts(session);
  });
  try {
    await sharing.pinCard(peer); await sharing.saveContactName(peer.accountId, "Before");
    await syncContacts(session); await latest; await joined;
    assert.equal(remote.puts.length, 2);
    assert.equal((await contactSyncState()).pending, false);
    assert.equal((await sharing.contactNames()).get(peer.accountId), "At acknowledgement");
  } finally {detach(); globalThis.fetch = old; await clearAccount(owner); lockVault();}
});
