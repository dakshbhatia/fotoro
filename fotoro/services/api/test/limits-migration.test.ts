import {expect, it} from "vitest";
import {env} from "cloudflare:test";
import migration from "../migrations/0006_storage_and_auth_limits.sql?raw";
import {accountStorage} from "../src/limits";
import {b64, json} from "../src/errors";

it("backfills ambiguous legacy uploads conservatively and preserves old Worker PUT completion checks", async () => {
  // Restore the pre-migration schema in this isolated public-fixture database.
  await env.DB.exec("DROP TRIGGER upload_storage_insert; DROP TRIGGER upload_storage_renew; DROP TRIGGER upload_storage_expiry_update; DROP TABLE upload_storage_claims; DROP TABLE account_storage; DROP TABLE auth_rate_limits;");
  const actor = {accountId: crypto.randomUUID(), deviceId: crypto.randomUUID()};
  const bytes = 17;
  const insert = (state: string) => {
    const id = crypto.randomUUID();
    const input = {version: 1, operationId: crypto.randomUUID(), ciphertextBytes: bytes,
      ciphertextSha256: b64(new Uint8Array(32)), binding: {version: 1, photoId: crypto.randomUUID(), representationId: crypto.randomUUID(), kind: "original"}};
    return {id, statement: env.DB.prepare("INSERT INTO uploads(id,account_id,device_id,operation_id,input,cap,expires,object_id,state) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(id, actor.accountId, actor.deviceId, input.operationId, json(input), b64(crypto.getRandomValues(new Uint8Array(32))), 0, crypto.randomUUID(), state)};
  };
  const legacy = [insert("reserved"), insert("uploaded"), insert("committed")];
  await env.DB.batch(legacy.map(value => value.statement));
  await env.DB.exec(migration.replace(/\n/g, " "));
  expect(await accountStorage(env as any, actor)).toMatchObject({reservedBytes: 0, storedBytes: 3 * bytes});
  // The previous deployed Worker relies on exactly one affected upload row.
  // A trigger here would inflate D1 meta.changes and turn a successful PUT into 409.
  const completion = await env.DB.prepare("UPDATE uploads SET state='uploaded',etag=?,revision=revision+1 WHERE id=? AND state='reserved' AND revision=1")
    .bind("public-test-etag", legacy[0].id).run();
  expect(completion.meta.changes).toBe(1);
  expect((await accountStorage(env as any, actor)).storedBytes).toBe(3 * bytes);

  // Old Worker insert/renew SQL remains valid until the new Worker is cut over.
  const duringCutover = insert("reserved");
  await duringCutover.statement.run();
  expect((await accountStorage(env as any, actor)).storedBytes).toBe(4 * bytes);
  await env.DB.prepare("UPDATE uploads SET cap=?,expires=?,revision=revision+1 WHERE id=? AND state='reserved'")
    .bind(b64(crypto.getRandomValues(new Uint8Array(32))), Date.now() + 900000, duringCutover.id).run();
  expect(await accountStorage(env as any, actor)).toMatchObject({reservedBytes: 0, storedBytes: 5 * bytes});
});
