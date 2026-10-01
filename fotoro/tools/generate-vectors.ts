// Generate public test identities and frozen ciphertext once; never production key material.
import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  sodium,
  ready,
  b64,
  utf8,
  encryptMedia,
  wrapKey,
  sealShareKey,
  signPayload,
} from "../packages/crypto/src/index.js";
await ready;
const id = (i: number) =>
  `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`;
const accounts = [1, 2].map((i) => {
  const box = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(i)),
    sign = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(i + 2)),
    vault = new Uint8Array(32).fill(i + 4),
    recovery = new Uint8Array(32).fill(i + 6);
  const card = {
    version: 1 as const,
    accountId: id(i),
    boxPublicKey: b64(box.publicKey),
    signingPublicKey: b64(sign.publicKey),
  };
  const bundle = utf8({
    vaultKey: b64(vault),
    boxSecretKey: b64(box.privateKey),
    signingSecretKey: b64(sign.privateKey),
  });
  return { card, box, sign, vault, recovery, bundle };
});
const publicData = {
  version: 1,
  accounts: accounts.map((a) => a.card),
  testSecrets: accounts.map((a) => ({
    accountId: a.card.accountId,
    boxSecretKey: b64(a.box.privateKey),
    signingSecretKey: b64(a.sign.privateKey),
    vaultKey: b64(a.vault),
    recoverySecret: b64(a.recovery),
    encryptedBundle: wrapKey(a.bundle, a.recovery),
  })),
};
await writeFile("fixtures/accounts.json", JSON.stringify(publicData, null, 2));
const key = new Uint8Array(32).fill(9),
  binding = {
    version: 1 as const,
    photoId: id(10),
    representationId: id(11),
    kind: "original" as const,
  };
const plaintext = new TextEncoder().encode(
  "Fotoro public vector\nOriginal bytes preserved.",
);
async function* records() {
  yield plaintext.subarray(0, 20);
  yield plaintext.subarray(20);
}
const parts = [];
for await (const p of encryptMedia(records(), key, binding)) parts.push(p);
const container = Buffer.concat(parts),
  shareBinding = {
    version: 1 as const,
    grantId: id(20),
    photoId: id(10),
    senderAccountId: id(1),
    recipientAccountId: id(2),
  };
const envelope = sealShareKey(
  key,
  accounts[1].card,
  shareBinding,
  accounts[0].sign.privateKey,
);
await writeFile(
  "fixtures/crypto-v1.json",
  JSON.stringify(
    {
      version: 1,
      constants: {
        secretstreamKeyBytes: 32,
        secretstreamHeaderBytes: 24,
        secretstreamOverheadBytes: 17,
        secretboxNonceBytes: 24,
        secretboxMacBytes: 16,
        boxPublicKeyBytes: 32,
        boxSecretKeyBytes: 32,
        sealedBoxOverheadBytes: 48,
        signingPublicKeyBytes: 32,
        signingSecretKeyBytes: 64,
        signatureBytes: 64,
        recordBytes: 4194304,
      },
      media: {
        binding,
        key: b64(key),
        plaintext: b64(plaintext),
        plaintextSha256: createHash("sha256")
          .update(plaintext)
          .digest("base64url"),
        container: b64(container),
        chunks: parts.map(b64),
      },
      wrappedKey: wrapKey(key, accounts[0].vault),
      share: { binding: shareBinding, envelope },
      signed: signPayload(
        "vector",
        id(1),
        plaintext,
        accounts[0].sign.privateKey,
      ),
      negative: {
        wrongKey: b64(new Uint8Array(32)),
        wrongBinding: { ...binding, kind: "preview" },
        truncated: b64(container.subarray(0, -1)),
        reordered: b64(Buffer.concat([parts[0], parts[2], parts[1]])),
        trailing: b64(Buffer.concat([container, Buffer.from([0])])),
      },
    },
    null,
    2,
  ),
);
