import type {AccountCardV1, AccountContactV1, AccountContactsV1, AccountContactsUpdateV1, AccountContactsReplyV1, SignedPayloadV1, WrappedKeyV1} from "@fotoro/contracts";
import {mergeContacts, validateContacts, type ContactConflict} from "@fotoro/contracts/contacts";
import {validatePublicAccountCard} from "@fotoro/contracts/share-links";
import {validateWire} from "@fotoro/contracts/validate";
import {ready, utf8, wrapKey, unwrapKey, signPayload, verifyPayload, unb64} from "@fotoro/crypto";
import {requireVault, type UnlockedVault} from "../vault/vault";
import {assertVault} from "../vault/scope";
import {db, get, all} from "./cache";
import {api, ApiError, fixtureMode, isPublicDemoAccount} from "./api";
import {diagnose} from "../diagnostics";
import type {ShareScope} from "./share-service";

interface Ledger {
  version: 1; ownerAccountId: string; origin: string;
  accepted: SignedPayloadV1 | null; base: AccountContactsV1; draft: AccountContactsV1;
  pending: SignedPayloadV1 | null; conflicts: ContactConflict[];
}
export interface ContactReview extends ContactConflict {local?: AccountContactV1; remote?: AccountContactV1;}
export interface ContactSyncState {pending: boolean; conflicts: ContactReview[];}
const versions = new Map<string, number>();
export const contactTrustVersion = (owner: string) => versions.get(owner) ?? 0;
const listeners = new Set<() => void>();
export function subscribeContacts(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};}
let channel: BroadcastChannel | undefined;
function publish(owner: string, trustChanged: boolean, broadcast = true) {
  if (trustChanged) versions.set(owner, contactTrustVersion(owner) + 1);
  for (const listener of listeners) listener();
  if (broadcast && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    if (!channel) {
      channel = new BroadcastChannel("fotoro-contacts");
      channel.onmessage = event => {if (typeof event.data?.owner === "string") publish(event.data.owner, event.data.trustChanged === true, false);};
    }
    channel.postMessage({owner, trustChanged});
  }
}
// Subscribe before the first local write so another tab's projection can refresh this UI.
if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
  channel = new BroadcastChannel("fotoro-contacts");
  channel.onmessage = event => {if (typeof event.data?.owner === "string") publish(event.data.owner, event.data.trustChanged === true, false);};
}
const origin = () => typeof location === "undefined" ? "" : location.origin;
function bound(session: UnlockedVault, scope: ShareScope = {}) {
  const capturedOrigin = origin();
  return {check() {assertVault(session); scope.signal?.throwIfAborted(); if (origin() !== capturedOrigin || scope.current && !scope.current()) throw new DOMException("Share cancelled", "AbortError");}, origin: capturedOrigin};
}
const encrypt = (value: unknown, session: UnlockedVault) => wrapKey(utf8(value), session.vaultKey);
function decrypt<T>(value: WrappedKeyV1, session: UnlockedVault): T {
  const plain = unwrapKey(value, session.vaultKey);
  try {return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(plain));} finally {plain.fill(0);}
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const empty = (ownerAccountId: string): AccountContactsV1 => ({version: 1, ownerAccountId, entries: []});
function decoded(signed: SignedPayloadV1, session: UnlockedVault) {
  validateWire("SignedPayloadV1", signed);
  if (signed.kind !== "account-contacts" || signed.accountId !== session.accountId) throw new Error("CONTACT_OWNER_MISMATCH");
  const plain = verifyPayload(signed, unb64(session.card.signingPublicKey));
  let update: AccountContactsUpdateV1;
  try {update = validateWire<AccountContactsUpdateV1>("AccountContactsUpdateV1", JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(plain)));} finally {plain.fill(0);}
  return {revision: update.revision, book: validateContacts(decrypt(update.encrypted, session), session.accountId)};
}
function validateLedger(value: Ledger, session: UnlockedVault, pageOrigin: string) {
  if (value.version !== 1 || value.ownerAccountId !== session.accountId || value.origin !== pageOrigin || !Array.isArray(value.conflicts)) throw new Error("CONTACT_BINDING_MISMATCH");
  validateContacts(value.base, session.accountId); validateContacts(value.draft, session.accountId);
  if (value.accepted ? !same(decoded(value.accepted, session).book, value.base) : !same(value.base, empty(session.accountId))) throw new Error("CONTACT_BINDING_MISMATCH");
  if (value.pending && decoded(value.pending, session).revision !== (value.accepted ? decoded(value.accepted, session).revision : 0) + 1) throw new Error("CONTACT_REVISION_MISMATCH");
  const ids = new Set<string>();
  for (const conflict of value.conflicts) {
    if (!value.draft.entries.some(entry => entry.accountId === conflict.accountId) || ids.has(conflict.accountId) || !Array.isArray(conflict.fields) || !conflict.fields.length || conflict.fields.some(field => !["card", "name", "deleted"].includes(field))) throw new Error("CONTACT_BINDING_MISMATCH");
    ids.add(conflict.accountId);
  }
  return value;
}
// Read/modify/write and legacy projections share one transaction. IndexedDB also
// serializes this transaction against another tab; no async crypto runs inside it.
async function edit(session: UnlockedVault, scope: ShareScope, mutate: (ledger: Ledger) => void = () => {}) {
  const access = bound(session, scope); access.check(); await ready; const database = await db(); access.check();
  const prefix = session.accountId + ":", key = prefix + "contacts-book";
  let changed = false, trustChanged = false;
  const result = await new Promise<Ledger>((resolve, reject) => {
    const tx = database.transaction("settings", "readwrite"), store = tx.objectStore("settings");
    let next: Ledger, failure: unknown;
    const fail = (error: unknown) => {failure = error; tx.abort();};
    const finish = (value: Ledger, stored: boolean, repairNames = new Set<string>()) => {
      try {
        access.check(); next = validateLedger(value, session, access.origin);
        const before = JSON.stringify(next), prior = new Map(next.draft.entries.map(entry => [entry.accountId, {...entry}]));
        mutate(next); validateLedger(next, session, access.origin); access.check();
        changed = !stored || before !== JSON.stringify(next);
        if (!changed) return;
        store.put(encrypt(next, session), key);
        for (const entry of next.draft.entries) {
          const old = prior.get(entry.accountId), pin = prefix + "pin:" + entry.accountId, name = prefix + "contact-name:" + entry.accountId;
          if (!same(old?.card, entry.card)) {
            trustChanged ||= old?.card != null || entry.card !== null;
            if (entry.card === null) store.delete(pin); else store.put(encrypt(entry.card, session), pin);
          }
          if (entry.card === null) {if (old?.card !== null) store.delete(name);}
          else if (!old?.card || old.name !== entry.name || repairNames.has(entry.accountId)) store.put(encrypt({accountId: entry.accountId, name: entry.name}, session), name);
        }
      } catch (error) {fail(error);}
    };
    const reading = store.get(key);
    reading.onsuccess = () => {
      if (reading.result) {
        try {finish(decrypt<Ledger>(reading.result, session), true);} catch (error) {fail(error);}
        return;
      }
      // Bootstrap only the bounded legacy contact namespace, never photo facts.
      const pinPrefix = prefix + "pin:", cursor = store.openCursor(IDBKeyRange.bound(pinPrefix, prefix + "pin;", false, true));
      const entries: AccountContactV1[] = [], repairNames = new Set<string>();
      let cursorDone = false, namesPending = 0;
      const complete = () => {
        if (cursorDone && namesPending === 0) finish({version: 1, ownerAccountId: session.accountId, origin: access.origin, accepted: null, base: empty(session.accountId), draft: {version: 1, ownerAccountId: session.accountId, entries: entries.sort((a, b) => a.accountId.localeCompare(b.accountId))}, pending: null, conflicts: []}, false, repairNames);
      };
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) {cursorDone = true; complete(); return;}
        let card: AccountCardV1 | undefined;
        try {
          access.check(); card = validatePublicAccountCard(decrypt(row.value, session));
          if (String(row.key) !== pinPrefix + card.accountId) card = undefined;
          else validateContacts({version: 1, ownerAccountId: session.accountId, entries: [{accountId: card.accountId, card, name: ""}]}, session.accountId);
        } catch {card = undefined;}
        if (card) {
          const accepted = card; namesPending++;
          const name = store.get(prefix + "contact-name:" + accepted.accountId);
          name.onsuccess = () => {
            let label = "";
            if (name.result) {
              try {
                const value = decrypt<{accountId: string; name: string}>(name.result, session);
                if (value.accountId !== accepted.accountId || typeof value.name !== "string" || value.name.length > 80) throw new Error("CONTACT_BINDING_MISMATCH");
                label = value.name;
              } catch {repairNames.add(accepted.accountId);}
            }
            entries.push({accountId: accepted.accountId, card: accepted, name: label}); namesPending--; complete();
          };
        }
        row.continue();
      };
    };
    tx.oncomplete = () => resolve(next!);
    tx.onerror = () => reject(failure ?? tx.error);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("STORAGE_ABORTED"));
  });
  access.check(); if (changed) publish(session.accountId, trustChanged); return result;
}
const state = (ledger: Ledger): ContactSyncState => ({pending: !!ledger.pending || !same(ledger.base, ledger.draft), conflicts: ledger.conflicts.map(conflict => ({...conflict, local: ledger.draft.entries.find(entry => entry.accountId === conflict.accountId), remote: ledger.base.entries.find(entry => entry.accountId === conflict.accountId)}))});
export async function contactSyncState(session = requireVault(), scope: ShareScope = {}) {return state(await edit(session, scope));}
export async function pinCard(value: string | AccountCardV1, scope: ShareScope = {}) {
  const session = requireVault(), card = validatePublicAccountCard(typeof value === "string" ? JSON.parse(value) : value);
  if (card.accountId === session.accountId) {
    if (!same(card, session.card)) throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
    bound(session, scope).check(); return card;
  }
  await edit(session, scope, ledger => {
    const entry = ledger.draft.entries.find(item => item.accountId === card.accountId);
    if (entry) entry.card = card; else ledger.draft.entries.push({accountId: card.accountId, card, name: ""});
    ledger.conflicts = ledger.conflicts.flatMap(item => item.accountId === card.accountId ? item.fields.filter(field => field === "name").length ? [{...item, fields: ["name"]}] : [] : [item]);
  });
  return card;
}
export async function trustedCard(id: string, session = requireVault(), scope: ShareScope = {}) {
  const access = bound(session, scope); access.check(); if (id === session.accountId) return session.card;
  await ready; access.check(); const cached = await get<WrappedKeyV1>("settings", session.accountId + ":pin:" + id); access.check();
  if (!cached) throw new Error("PIN_ACCOUNT_CARD_FROM_TRUSTED_CHANNEL");
  const card = validatePublicAccountCard(decrypt(cached, session));
  if (card.accountId !== id) throw new Error("CONTACT_BINDING_MISMATCH"); return card;
}
export async function contacts(scope: ShareScope = {}) {
  const session = requireVault(), access = bound(session, scope), prefix = session.accountId + ":pin:";
  access.check(); await ready; access.check(); const rows = await all<WrappedKeyV1>("settings", prefix); access.check();
  return rows.filter(([key]) => key !== prefix + session.accountId).map(([key, value]) => {
    const card = validatePublicAccountCard(decrypt(value, session)); if (key !== prefix + card.accountId) throw new Error("CONTACT_BINDING_MISMATCH"); return card;
  });
}
export async function contactNames(scope: ShareScope = {}) {
  const session = requireVault(), access = bound(session, scope), prefix = session.accountId + ":contact-name:";
  access.check(); await ready; access.check(); const rows = await all<WrappedKeyV1>("settings", prefix); access.check();
  const names = new Map<string, string>();
  for (const [key, encrypted] of rows) {
    const value = decrypt<{accountId: string; name: string}>(encrypted, session);
    if (key !== prefix + value.accountId || typeof value.name !== "string" || value.name.length > 80) throw new Error("CONTACT_BINDING_MISMATCH");
    if (value.name.trim()) names.set(value.accountId, value.name);
  }
  return names;
}
export async function saveContactName(accountId: string, name: string, scope: ShareScope = {}, expectedCard?: AccountCardV1) {
  if (typeof name !== "string" || name.length > 80) throw new Error("CONTACT_NAME_TOO_LONG");
  await edit(requireVault(), scope, ledger => {
    const entry = ledger.draft.entries.find(item => item.accountId === accountId && item.card);
    if (!entry) throw new Error("PIN_ACCOUNT_CARD_FROM_TRUSTED_CHANNEL");
    if (expectedCard && !same(entry.card, expectedCard)) throw new Error("CONTACT_REVIEW_CHANGED");
    entry.name = name;
    ledger.conflicts = ledger.conflicts.flatMap(item => item.accountId === accountId ? item.fields.filter(field => field !== "name").length ? [{...item, fields: item.fields.filter(field => field !== "name")}] : [] : [item]);
  });
}
export async function resolveContactConflict(review: ContactReview, choice: "local" | "remote", scope: ShareScope = {}) {
  const accountId = review.accountId;
  return state(await edit(requireVault(), scope, ledger => {
    const conflict = ledger.conflicts.find(item => item.accountId === accountId), remote = ledger.base.entries.find(item => item.accountId === accountId);
    const local = ledger.draft.entries.find(item => item.accountId === accountId);
    if (!conflict || !same({...conflict, local, remote}, review)) throw new Error("CONTACT_REVIEW_CHANGED");
    if (choice === "remote") {
      if (!local) throw new Error("CONTACT_REVIEW_CHANGED");
      if (conflict.fields.includes("deleted")) {if (!remote) throw new Error("CONTACT_REVIEW_CHANGED"); ledger.draft.entries = ledger.draft.entries.map(item => item.accountId === accountId ? remote : item);}
      else {if (!remote?.card) throw new Error("CONTACT_REVIEW_CHANGED"); if (conflict.fields.includes("card")) local.card = remote.card; if (conflict.fields.includes("name")) local.name = remote.name;}
    }
    ledger.conflicts = ledger.conflicts.filter(item => item.accountId !== accountId);
  }));
}
function acceptRemote(ledger: Ledger, signed: SignedPayloadV1 | null, session: UnlockedVault, acknowledged?: SignedPayloadV1) {
  const remote = signed ? decoded(signed, session) : {revision: 0, book: empty(session.accountId)}, previous = ledger.accepted ? decoded(ledger.accepted, session).revision : 0;
  if (remote.revision < previous || remote.revision === previous && !same(signed, ledger.accepted)) throw new Error("CONTACT_REVISION_MISMATCH");
  const ownReceipt = acknowledged && same(ledger.pending, acknowledged) && same(signed, acknowledged);
  const merged = mergeContacts(ownReceipt ? decoded(acknowledged, session).book : ledger.base, ledger.draft, remote.book, ledger.conflicts);
  ledger.accepted = signed; ledger.base = remote.book; ledger.draft = merged.value; ledger.conflicts = merged.conflicts;
  if (acknowledged && same(ledger.pending, acknowledged)) ledger.pending = null;
}
interface ContactFlight {work: Promise<ContactSyncState>; check: () => void; requested: boolean;}
const flights = new WeakMap<UnlockedVault, ContactFlight>();
export async function syncContacts(session = requireVault(), scope: ShareScope = {}): Promise<ContactSyncState> {
  const access = bound(session, scope); access.check();
  const running = flights.get(session);
  if (running) {
    running.requested = true;
    return running.work.then(result => {access.check(); return result;}, error => {
    access.check();
    try {running.check();} catch {return syncContacts(session, scope);}
    throw error;
    });
  }
  const flight: ContactFlight = {work: undefined!, check: access.check, requested: false};
  const work = diagnose("share", async diagnostic => {
    let result: ContactSyncState;
    do {
      flight.requested = false;
      result = await synchronize(session, {...scope, diagnostic});
    } while (flight.requested);
    if (result.conflicts.length) diagnostic.incomplete("verification");
    return result;
  }, "refresh").finally(() => {if (flights.get(session)?.work === work) flights.delete(session);});
  flight.work = work; flights.set(session, flight); return work;
}
async function synchronize(session: UnlockedVault, scope: ShareScope) {
  const access = bound(session, scope); let ledger = await edit(session, scope), downloaded = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    access.check();
    if (ledger.pending) {
      if (fixtureMode || isPublicDemoAccount(session.accountId)) return state(ledger);
      const pending = ledger.pending;
      try {
        const reply = await api<AccountContactsReplyV1>("/v1/contacts", pending, "AccountContactsReplyV1", "PUT", scope.signal, scope.diagnostic); access.check();
        if (!same(reply.contacts, pending)) throw new Error("CONTACT_RECEIPT_MISMATCH"); decoded(pending, session);
        ledger = await edit(session, scope, current => acceptRemote(current, reply.contacts, session, pending)); downloaded = true;
      } catch (error) {
        if (!(error instanceof ApiError) || !/CONFLICT/.test(error.code)) throw error;
        const reply = await api<AccountContactsReplyV1>("/v1/contacts", undefined, "AccountContactsReplyV1", "GET", scope.signal, scope.diagnostic); access.check();
        ledger = await edit(session, scope, current => acceptRemote(current, reply.contacts, session, pending)); downloaded = true;
      }
    } else if (!downloaded) {
      const reply = await api<AccountContactsReplyV1>("/v1/contacts", undefined, "AccountContactsReplyV1", "GET", scope.signal, scope.diagnostic); access.check();
      ledger = await edit(session, scope, current => acceptRemote(current, reply.contacts, session)); downloaded = true;
    }
    if (ledger.conflicts.length || same(ledger.base, ledger.draft) || fixtureMode || isPublicDemoAccount(session.accountId)) return state(ledger);
    ledger = await edit(session, scope, current => {
      if (current.pending || current.conflicts.length || same(current.base, current.draft)) return;
      const revision = (current.accepted ? decoded(current.accepted, session).revision : 0) + 1;
      const update = validateWire<AccountContactsUpdateV1>("AccountContactsUpdateV1", {version: 1, revision, encrypted: encrypt(current.draft, session)});
      current.pending = signPayload("account-contacts", session.accountId, utf8(update), session.signingSecretKey);
    });
  }
  return state(ledger);
}
