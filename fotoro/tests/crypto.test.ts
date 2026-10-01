import { test } from "node:test";
import assert from "node:assert/strict";
import sodium from "libsodium-wrappers-sumo";
import { encryptMedia, decryptMedia } from "../packages/crypto/src/media.js";
import {
  signPayload,
  verifyPayload,
} from "../packages/crypto/src/signatures.js";
import {
  wrapKey,
  unwrapKey,
  sealShareKey,
  openShareKey,
} from "../packages/crypto/src/envelopes.js";
await sodium.ready;
const id = "11111111-1111-4111-8111-111111111111";
const binding = {
  version: 1 as const,
  photoId: id,
  representationId: id,
  kind: "original" as const,
};
async function* chunks(values: Uint8Array[]) {
  yield* values;
}
async function collect(values: AsyncIterable<Uint8Array>) {
  const a = [];
  for await (const v of values) a.push(v);
  return a;
}
test("secretstream preserves bytes and rejects corrupt containers", async () => {
  const key = new Uint8Array(32).fill(1),
    parts = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const encrypted = await collect(encryptMedia(chunks(parts), key, binding));
  assert.deepEqual(
    await collect(decryptMedia(chunks(encrypted), key, binding)),
    parts,
  );
  for (const [value, k, b] of [
    [encrypted, new Uint8Array(32), binding],
    [encrypted, key, { ...binding, kind: "preview" as const }],
    [encrypted.slice(0, -1), key, binding],
    [[encrypted[0], encrypted[2], encrypted[1]], key, binding],
    [[...encrypted, new Uint8Array([0])], key, binding],
  ] as const)
    await assert.rejects(() => collect(decryptMedia(chunks([...value]), k, b)));
});
test("signature verifies exact bytes, envelope binds recipient and sender", () => {
  const sender = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(3)),
    b = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(4)),
    c = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(5));
  const body = new Uint8Array([255, 1]);
  const signed = signPayload("manifest", id, body, sender.privateKey);
  assert.deepEqual(verifyPayload(signed, sender.publicKey), body);
  assert.throws(() =>
    verifyPayload({ ...signed, body: "AQ" }, sender.publicKey),
  );
  const key = new Uint8Array(32).fill(9),
    vault = new Uint8Array(32).fill(10);
  assert.deepEqual(unwrapKey(wrapKey(key, vault), vault), key);
  assert.throws(() => unwrapKey(wrapKey(key, vault), key));
  const card = {
    version: 1 as const,
    accountId: id,
    boxPublicKey: sodium.to_base64(
      b.publicKey,
      sodium.base64_variants.URLSAFE_NO_PADDING,
    ),
    signingPublicKey: sodium.to_base64(
      sender.publicKey,
      sodium.base64_variants.URLSAFE_NO_PADDING,
    ),
  };
  const bind = {
    version: 1 as const,
    grantId: id,
    photoId: id,
    senderAccountId: id,
    recipientAccountId: id,
  };
  const env = sealShareKey(key, card, bind, sender.privateKey);
  assert.deepEqual(openShareKey(env, b.privateKey, card, bind), key);
  assert.throws(() => openShareKey(env, c.privateKey, card, bind));
  assert.throws(() =>
    openShareKey(
      { ...env, senderSignature: "A".repeat(86) },
      b.privateKey,
      card,
      bind,
    ),
  );
});

test("frozen cross-language vectors decrypt and authenticate independently of generation", async () => {
  const vectors = (await import("../fixtures/crypto-v1.json")).default;
  const accounts = (await import("../fixtures/accounts.json")).default;
  const { unb64, b64 } = await import("../packages/crypto/src/common.js");
  const { createHash } = await import("node:crypto");
  const result = await collect(
    decryptMedia(
      chunks([unb64(vectors.media.container)]),
      unb64(vectors.media.key),
      vectors.media.binding as any,
    ),
  );
  const plaintext = Buffer.concat(result);
  assert.equal(b64(plaintext), vectors.media.plaintext);
  assert.equal(
    createHash("sha256").update(plaintext).digest("base64url"),
    vectors.media.plaintextSha256,
  );
  assert.equal(
    b64(
      verifyPayload(
        vectors.signed as any,
        unb64(accounts.accounts[0].signingPublicKey),
      ),
    ),
    vectors.media.plaintext,
  );
  assert.equal(
    b64(
      unwrapKey(
        vectors.wrappedKey as any,
        unb64(accounts.testSecrets[0].vaultKey),
      ),
    ),
    vectors.media.key,
  );
  assert.equal(
    b64(
      openShareKey(
        vectors.share.envelope as any,
        unb64(accounts.testSecrets[1].boxSecretKey),
        accounts.accounts[0] as any,
        vectors.share.binding as any,
      ),
    ),
    vectors.media.key,
  );
  for (const name of ["truncated", "reordered", "trailing"] as const)
    await assert.rejects(() =>
      collect(
        decryptMedia(
          chunks([unb64(vectors.negative[name])]),
          unb64(vectors.media.key),
          vectors.media.binding as any,
        ),
      ),
    );
});

test("arbitrary network chunks, empty input and 4 MiB records retain framing integrity", async () => {
  const key = new Uint8Array(32).fill(8);
  for (const parts of [
    [],
    [new Uint8Array(4 * 1024 * 1024).fill(1), new Uint8Array([2, 3])],
  ]) {
    const encoded = Buffer.concat(
      await collect(encryptMedia(chunks(parts), key, binding)),
    );
    async function* transport() {
      for (let i = 0; i < encoded.length; i += 16381)
        yield encoded.subarray(i, i + 16381);
    }
    assert.deepEqual(
      Buffer.concat(await collect(decryptMedia(transport(), key, binding))),
      Buffer.concat(parts),
    );
    const altered = new Uint8Array(encoded);
    altered[altered.length - 1] ^= 1;
    await assert.rejects(() =>
      collect(decryptMedia(chunks([altered]), key, binding)),
    );
    await assert.rejects(() =>
      collect(
        decryptMedia(chunks([encoded]), key, {
          ...binding,
          representationId: "00000000-0000-4000-8000-000000000099",
        }),
      ),
    );
    await assert.rejects(() =>
      collect(
        decryptMedia(chunks([encoded]), key, { ...binding, version: 2 } as any),
      ),
    );
  }
  await assert.rejects(() =>
    collect(encryptMedia(chunks([new Uint8Array(4194305)]), key, binding)),
  );
});
