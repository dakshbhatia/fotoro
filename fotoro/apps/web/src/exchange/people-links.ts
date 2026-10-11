import type {TripPersonLinkV1, AccountPeopleLinksV1, AccountPeopleLinksUpdateV1, AccountPeopleLinksReplyV1, SignedPayloadV1, WrappedKeyV1} from "@fotoro/contracts";
import {canonicalPeopleLinks, mergePeopleLinks, validatePeopleLinks, type PeopleLinksConflict} from "@fotoro/contracts/people-links";
import {validateWire} from "@fotoro/contracts/validate";
import {ready, utf8, wrapKey, unwrapKey, signPayload, verifyPayload, unb64} from "@fotoro/crypto";
import {requireVault, type UnlockedVault} from "../vault/vault";
import {assertVault} from "../vault/scope";
import {db} from "./cache";
import {api, ApiError, fixtureMode, isPublicDemoAccount} from "./api";
import {diagnose} from "../diagnostics";
import type {ShareScope} from "./share-service";

interface Ledger {
  version: 1; ownerAccountId: string; origin: string;
  accepted: SignedPayloadV1 | null; base: AccountPeopleLinksV1; draft: AccountPeopleLinksV1;
  pending: SignedPayloadV1 | null; conflicts: PeopleLinksConflict[];
}
export interface PeopleLinksReview extends PeopleLinksConflict {local: AccountPeopleLinksV1; remote: AccountPeopleLinksV1;}
export interface PeopleLinksSyncState {pending: boolean; conflicts: PeopleLinksReview[];}
const listeners = new Set<() => void>();
export function subscribePeopleLinks(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};}
let channel: BroadcastChannel | undefined;
function publish(broadcast = true) {for (const listener of listeners) listener(); if (broadcast) channel?.postMessage({changed: true});}
if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
  channel = new BroadcastChannel("fotoro-people-links");
  channel.onmessage = event => {if (event.data?.changed === true) publish(false);};
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
const sameBook = (a: AccountPeopleLinksV1, b: AccountPeopleLinksV1) => canonicalPeopleLinks(a) === canonicalPeopleLinks(b);
const empty = (ownerAccountId: string): AccountPeopleLinksV1 => ({version: 1, ownerAccountId, links: []});
function decoded(signed: SignedPayloadV1, session: UnlockedVault) {
  validateWire("SignedPayloadV1", signed);
  if (signed.kind !== "account-people-links" || signed.accountId !== session.accountId) throw new Error("PEOPLE_LINKS_OWNER_MISMATCH");
  const plain = verifyPayload(signed, unb64(session.card.signingPublicKey));
  let update: AccountPeopleLinksUpdateV1;
  try {update = validateWire<AccountPeopleLinksUpdateV1>("AccountPeopleLinksUpdateV1", JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(plain)));} finally {plain.fill(0);}
  return {revision: update.revision, book: validatePeopleLinks(decrypt(update.encrypted, session), session.accountId)};
}
function validateLedger(value: Ledger, session: UnlockedVault, pageOrigin: string) {
  if (value.version !== 1 || value.ownerAccountId !== session.accountId || value.origin !== pageOrigin || !Array.isArray(value.conflicts)) throw new Error("PEOPLE_LINKS_BINDING_MISMATCH");
  validatePeopleLinks(value.base, session.accountId); validatePeopleLinks(value.draft, session.accountId);
  if (value.accepted ? !sameBook(decoded(value.accepted, session).book, value.base) : !sameBook(value.base, empty(session.accountId))) throw new Error("PEOPLE_LINKS_BINDING_MISMATCH");
  if (value.pending && decoded(value.pending, session).revision !== (value.accepted ? decoded(value.accepted, session).revision : 0) + 1) throw new Error("PEOPLE_LINKS_REVISION_MISMATCH");
  if (value.conflicts.length > 1 || value.conflicts.some(conflict => conflict.field !== "links")) throw new Error("PEOPLE_LINKS_BINDING_MISMATCH");
  return value;
}
// One encrypted settings transaction serializes same-account edits across tabs.
async function edit(session: UnlockedVault, scope: ShareScope, mutate: (ledger: Ledger) => void = () => {}) {
  const access = bound(session, scope); access.check(); await ready; const database = await db(); access.check();
  const key = session.accountId + ":people-links-book";
  let changed = false;
  const result = await new Promise<Ledger>((resolve, reject) => {
    const tx = database.transaction("settings", "readwrite"), store = tx.objectStore("settings");
    let next: Ledger, failure: unknown;
    const reading = store.get(key);
    reading.onsuccess = () => {
      try {
        access.check();
        next = reading.result ? validateLedger(decrypt<Ledger>(reading.result, session), session, access.origin)
          : {version: 1, ownerAccountId: session.accountId, origin: access.origin, accepted: null, base: empty(session.accountId), draft: empty(session.accountId), pending: null, conflicts: []};
        const before = JSON.stringify(next);
        mutate(next); validateLedger(next, session, access.origin); access.check();
        changed = !reading.result || before !== JSON.stringify(next);
        if (changed) store.put(encrypt(next, session), key);
      } catch (error) {failure = error; tx.abort();}
    };
    tx.oncomplete = () => resolve(next!);
    tx.onerror = () => reject(failure ?? tx.error);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("STORAGE_ABORTED"));
  });
  access.check(); if (changed) publish(); return result;
}
const state = (ledger: Ledger): PeopleLinksSyncState => ({pending: !!ledger.pending || !sameBook(ledger.base, ledger.draft), conflicts: ledger.conflicts.map(conflict => ({...conflict, local: ledger.draft, remote: ledger.base}))});
export async function peopleLinksState(session = requireVault(), scope: ShareScope = {}) {const ledger = await edit(session, scope); return {...state(ledger), book: ledger.draft};}
export async function savePersonLink(link: TripPersonLinkV1, scope: ShareScope = {}, expected?: TripPersonLinkV1) {
  await edit(requireVault(), scope, ledger => {
    if (ledger.conflicts.length) throw new Error("PEOPLE_LINKS_REVIEW_REQUIRED");
    if (expected && !same(ledger.draft.links.find(item => item.id === expected.id), expected)) throw new Error("PEOPLE_LINKS_REVIEW_CHANGED");
    ledger.draft.links = [...ledger.draft.links.filter(item => item.id !== link.id), link];
  });
}
export async function resolvePeopleLinksConflict(review: PeopleLinksReview, choice: "local" | "remote", scope: ShareScope = {}) {
  return state(await edit(requireVault(), scope, ledger => {
    if (ledger.conflicts.length !== 1 || !same({...ledger.conflicts[0], local: ledger.draft, remote: ledger.base}, review)) throw new Error("PEOPLE_LINKS_REVIEW_CHANGED");
    if (choice === "remote") ledger.draft = ledger.base;
    ledger.conflicts = [];
  }));
}
function acceptRemote(ledger: Ledger, signed: SignedPayloadV1 | null, session: UnlockedVault, acknowledged?: SignedPayloadV1) {
  const remote = signed ? decoded(signed, session) : {revision: 0, book: empty(session.accountId)}, previous = ledger.accepted ? decoded(ledger.accepted, session).revision : 0;
  if (remote.revision < previous || remote.revision === previous && !same(signed, ledger.accepted)) throw new Error("PEOPLE_LINKS_REVISION_MISMATCH");
  const ownReceipt = acknowledged && same(ledger.pending, acknowledged) && same(signed, acknowledged);
  const merged = mergePeopleLinks(ownReceipt ? decoded(acknowledged, session).book : ledger.base, ledger.draft, remote.book, ledger.conflicts);
  ledger.accepted = signed; ledger.base = remote.book; ledger.draft = merged.value; ledger.conflicts = merged.conflicts;
  if (acknowledged && same(ledger.pending, acknowledged)) ledger.pending = null;
}
interface PeopleLinksFlight {work: Promise<PeopleLinksSyncState>; check: () => void; requested: boolean;}
const flights = new WeakMap<UnlockedVault, PeopleLinksFlight>();
export async function syncPeopleLinks(session = requireVault(), scope: ShareScope = {}): Promise<PeopleLinksSyncState> {
  const access = bound(session, scope); access.check();
  const running = flights.get(session);
  if (running) {
    running.requested = true;
    return running.work.then(result => {access.check(); return result;}, error => {
    access.check();
    try {running.check();} catch {return syncPeopleLinks(session, scope);}
    throw error;
    });
  }
  const flight: PeopleLinksFlight = {work: undefined!, check: access.check, requested: false};
  const work = diagnose("share", async diagnostic => {
    let result: PeopleLinksSyncState;
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
        const reply = await api<AccountPeopleLinksReplyV1>("/v1/people-links", pending, "AccountPeopleLinksReplyV1", "PUT", scope.signal, scope.diagnostic); access.check();
        if (!same(reply.peopleLinks, pending)) throw new Error("PEOPLE_LINKS_RECEIPT_MISMATCH"); decoded(pending, session);
        ledger = await edit(session, scope, current => acceptRemote(current, reply.peopleLinks, session, pending)); downloaded = true;
      } catch (error) {
        if (!(error instanceof ApiError) || !/CONFLICT/.test(error.code)) throw error;
        const reply = await api<AccountPeopleLinksReplyV1>("/v1/people-links", undefined, "AccountPeopleLinksReplyV1", "GET", scope.signal, scope.diagnostic); access.check();
        ledger = await edit(session, scope, current => acceptRemote(current, reply.peopleLinks, session, pending)); downloaded = true;
      }
    } else if (!downloaded) {
      const reply = await api<AccountPeopleLinksReplyV1>("/v1/people-links", undefined, "AccountPeopleLinksReplyV1", "GET", scope.signal, scope.diagnostic); access.check();
      ledger = await edit(session, scope, current => acceptRemote(current, reply.peopleLinks, session)); downloaded = true;
    }
    if (ledger.conflicts.length || sameBook(ledger.base, ledger.draft) || fixtureMode || isPublicDemoAccount(session.accountId)) return state(ledger);
    ledger = await edit(session, scope, current => {
      if (current.pending || current.conflicts.length || sameBook(current.base, current.draft)) return;
      const revision = (current.accepted ? decoded(current.accepted, session).revision : 0) + 1;
      const update = validateWire<AccountPeopleLinksUpdateV1>("AccountPeopleLinksUpdateV1", {version: 1, revision, encrypted: encrypt(current.draft, session)});
      current.pending = signPayload("account-people-links", session.accountId, utf8(update), session.signingSecretKey);
    });
  }
  return state(ledger);
}
