import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

const db = (env as { DB: D1Database }).DB;

function object(accountId: string, objectId: string, state = "live") {
  return db.prepare(
    "INSERT INTO objects(id,account_id,upload_id,bytes,digest,binding,state) VALUES(?,?,?,?,?,?,?)",
  ).bind(objectId, accountId, crypto.randomUUID(), 4, "test-digest", "{}", state);
}

function photo(accountId: string, photoId: string, originalId: string, metadataId: string) {
  const manifest = JSON.stringify({
    representations: [{ objectId: originalId }],
    metadataRepresentation: { objectId: metadataId },
  });
  return db.prepare("INSERT INTO photos(id,account_id,manifest,signed) VALUES(?,?,?,?)")
    .bind(photoId, accountId, manifest, "test-signed-manifest");
}

describe("catalog migration retention guard", () => {
  it("retains both live original and metadata objects and emits one photo change", async () => {
    const accountId = crypto.randomUUID();
    const photoId = crypto.randomUUID();
    const originalId = crypto.randomUUID();
    const metadataId = crypto.randomUUID();
    await db.batch([object(accountId, originalId), object(accountId, metadataId)]);

    await photo(accountId, photoId, originalId, metadataId).run();

    expect(await db.prepare("SELECT id FROM photos WHERE id=?").bind(photoId).first())
      .toEqual({ id: photoId });
    const retained = await db.prepare(
      "SELECT object_id,account_id,photo_id FROM retention WHERE photo_id=?",
    ).bind(photoId).all();
    expect(retained.results).toEqual(expect.arrayContaining([
      { object_id: originalId, account_id: accountId, photo_id: photoId },
      { object_id: metadataId, account_id: accountId, photo_id: photoId },
    ]));
    expect(retained.results).toHaveLength(2);
    const changes = await db.prepare(
      "SELECT entity,entity_id,deleted,payload FROM changes WHERE account_id=?",
    ).bind(accountId).all();
    expect(changes.results).toEqual([
      { entity: "photo", entity_id: photoId, deleted: 0, payload: "test-signed-manifest" },
    ]);
  });

  it.each(["missing", "staged", "deleted"])(
    "rejects %s metadata and rolls back the photo, earlier original retention and preceding batch writes",
    async (state) => {
      const accountId = crypto.randomUUID();
      const photoId = crypto.randomUUID();
      const originalId = crypto.randomUUID();
      const metadataId = crypto.randomUUID();
      await object(accountId, originalId).run();
      if (state !== "missing") await object(accountId, metadataId, state).run();
      // The trigger inserts live original retention before attempting metadata.
      // A separate successful statement before the failure must also roll back.
      const precedingWrite = db.prepare(
        "INSERT INTO changes(account_id,entity,entity_id,payload) VALUES(?,'probe',?,'test-probe')",
      ).bind(accountId, photoId);
      await expect(db.batch([
        precedingWrite,
        photo(accountId, photoId, originalId, metadataId),
      ])).rejects.toThrow("OBJECT_UNAVAILABLE");

      expect(await db.prepare("SELECT id FROM photos WHERE id=?").bind(photoId).first())
        .toBeNull();
      const retained = await db.prepare("SELECT object_id FROM retention WHERE photo_id=?")
        .bind(photoId).all();
      expect(retained.results).toEqual([]);
      const changes = await db.prepare("SELECT entity_id FROM changes WHERE account_id=?")
        .bind(accountId).all();
      expect(changes.results).toEqual([]);
      // Rollback must preserve the object records seeded outside the batch.
      expect(await db.prepare("SELECT state FROM objects WHERE id=?").bind(originalId).first())
        .toEqual({ state: "live" });
      expect(await db.prepare("SELECT state FROM objects WHERE id=?").bind(metadataId).first())
        .toEqual(state === "missing" ? null : { state });
    },
  );
});
