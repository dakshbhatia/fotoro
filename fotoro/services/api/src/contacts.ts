import type {AccountContactsReplyV1, AccountContactsUpdateV1, SignedPayloadV1} from "@fotoro/contracts";
import {type Actor, type Env, fail, json, signedBody, unb64} from "./errors";
import {readJson} from "./requests";

export async function getContacts(env: Env, actor: Actor): Promise<AccountContactsReplyV1> {
  if (!await env.DB.prepare("SELECT 1 FROM devices WHERE id=? AND account_id=? AND trusted=1")
    .bind(actor.deviceId, actor.accountId).first()) fail("FORBIDDEN", 403);
  const row = await env.DB.prepare("SELECT signed FROM account_contacts WHERE account_id=?")
    .bind(actor.accountId).first<{signed: string}>();
  return {version: 1, contacts: row ? JSON.parse(row.signed) : null};
}

export async function putContacts(env: Env, actor: Actor, payload: SignedPayloadV1): Promise<AccountContactsReplyV1> {
  // Bound base64 before signature verification and body decoding. One base64
  // character cannot encode a byte and would otherwise escape as a decode error.
  if (typeof payload?.body !== "string" || payload.body.length > 360000 || payload.body.length % 4 === 1) fail("INVALID_WIRE");
  const value = await signedBody<AccountContactsUpdateV1>(env, actor, payload, "account-contacts", "AccountContactsUpdateV1");
  // signedBody authenticates before parsing; additionally reject replacement
  // decoding of malformed UTF8, even when the parsed shape happens to validate.
  try {new TextDecoder("utf-8", {fatal: true}).decode(unb64(payload.body));}
  catch {fail("INVALID_WIRE");}
  const proof = json(payload);
  const prior = await env.DB.prepare("SELECT signed FROM account_contacts WHERE account_id=?")
    .bind(actor.accountId).first<{signed: string}>();
  if (prior?.signed === proof) return {version: 1, contacts: payload};

  // The revision condition belongs in the write: two devices may both have
  // read the same revision. A new book must begin at one.
  const written = await env.DB.prepare(
    "INSERT INTO account_contacts(account_id,revision,signed) SELECT ?,?,? WHERE ((?=1 AND NOT EXISTS(SELECT 1 FROM account_contacts WHERE account_id=?)) OR EXISTS(SELECT 1 FROM account_contacts WHERE account_id=? AND revision=?)) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,signed=excluded.signed WHERE account_contacts.revision=?",
  ).bind(actor.accountId, value.revision, proof, value.revision, actor.accountId, actor.accountId, value.revision - 1, value.revision - 1).run();
  if (written.meta.changes !== 1) {
    const current = await env.DB.prepare("SELECT signed FROM account_contacts WHERE account_id=?")
      .bind(actor.accountId).first<{signed: string}>();
    if (current?.signed !== proof) fail("VERSION_CONFLICT", 409);
  }
  return {version: 1, contacts: payload};
}

export function readContactsRequest(request: Request): Promise<SignedPayloadV1> {
  return readJson(request, 512 * 1024);
}
