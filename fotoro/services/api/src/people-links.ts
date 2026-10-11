import type {AccountPeopleLinksReplyV1, AccountPeopleLinksUpdateV1, SignedPayloadV1} from "@fotoro/contracts";
import {type Actor, type Env, fail, json, signedBody, unb64} from "./errors";
import {readJson} from "./requests";

export async function getPeopleLinks(env: Env, actor: Actor): Promise<AccountPeopleLinksReplyV1> {
  if (!await env.DB.prepare("SELECT 1 FROM devices WHERE id=? AND account_id=? AND trusted=1")
    .bind(actor.deviceId, actor.accountId).first()) fail("FORBIDDEN", 403);
  const row = await env.DB.prepare("SELECT signed FROM account_people_links WHERE account_id=?")
    .bind(actor.accountId).first<{signed: string}>();
  return {version: 1, peopleLinks: row ? JSON.parse(row.signed) : null};
}

export async function putPeopleLinks(env: Env, actor: Actor, payload: SignedPayloadV1): Promise<AccountPeopleLinksReplyV1> {
  // Bound base64 before signature verification and body decoding. One base64
  // character cannot encode a byte and would otherwise escape as a decode error.
  if (typeof payload?.body !== "string" || payload.body.length > 360000 || payload.body.length % 4 === 1) fail("INVALID_WIRE");
  const value = await signedBody<AccountPeopleLinksUpdateV1>(env, actor, payload, "account-people-links", "AccountPeopleLinksUpdateV1");
  // signedBody authenticates before parsing; additionally reject replacement
  // decoding of malformed UTF8, even when the parsed shape happens to validate.
  try {new TextDecoder("utf-8", {fatal: true}).decode(unb64(payload.body));}
  catch {fail("INVALID_WIRE");}
  const proof = json(payload);
  const prior = await env.DB.prepare("SELECT signed FROM account_people_links WHERE account_id=?")
    .bind(actor.accountId).first<{signed: string}>();
  if (prior?.signed === proof) return {version: 1, peopleLinks: payload};

  // The revision condition belongs in the write: two devices may both have
  // read the same revision. A new book must begin at one.
  const written = await env.DB.prepare(
    "INSERT INTO account_people_links(account_id,revision,signed) SELECT ?,?,? WHERE ((?=1 AND NOT EXISTS(SELECT 1 FROM account_people_links WHERE account_id=?)) OR EXISTS(SELECT 1 FROM account_people_links WHERE account_id=? AND revision=?)) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,signed=excluded.signed WHERE account_people_links.revision=?",
  ).bind(actor.accountId, value.revision, proof, value.revision, actor.accountId, actor.accountId, value.revision - 1, value.revision - 1).run();
  if (written.meta.changes !== 1) {
    const current = await env.DB.prepare("SELECT signed FROM account_people_links WHERE account_id=?")
      .bind(actor.accountId).first<{signed: string}>();
    if (current?.signed !== proof) fail("VERSION_CONFLICT", 409);
  }
  return {version: 1, peopleLinks: payload};
}

export function readPeopleLinksRequest(request: Request): Promise<SignedPayloadV1> {
  return readJson(request, 512 * 1024);
}
