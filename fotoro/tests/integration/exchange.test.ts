import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import accounts from "../../fixtures/accounts.json";
import type {
  PhotoManifestV1,
  RepresentationV1,
  MediaBinding,
  GrantV1,
  SavedPhotoV1,
  SignedPayloadV1,
  RecoveryOptionsV1,
  SessionV1,
  UploadReservationV1,
  UploadCommitV1,
  PhotoMetadataV1,
} from "../../packages/contracts/src/models.js";
import {
  ready,
  sodium,
  b64,
  unb64,
  utf8,
  encryptMedia,
  decryptMedia,
  wrapKey,
  unwrapKey,
  signPayload,
  verifyPayload,
  sealShareKey,
  openShareKey,
} from "../../packages/crypto/src/index.js";

const base = new URL(process.env.FOTORO_API_URL ?? "http://127.0.0.1:8787");
if (
  base.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(base.hostname)
)
  throw new Error(
    "This test may run only against a local service with public test keys",
  );
const origin = "http://localhost:4310";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("base64url");
async function* records(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += 4194304)
    yield bytes.subarray(offset, offset + 4194304);
}
async function collect(stream: AsyncIterable<Uint8Array>) {
  const result = [];
  for await (const chunk of stream) result.push(chunk);
  return new Uint8Array(Buffer.concat(result));
}
function request(
  path: string,
  token?: string,
  value?: unknown,
  method = value === undefined ? "GET" : "POST",
) {
  return fetch(new URL(path, base), {
    method,
    headers: {
      origin,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(value === undefined ? {} : { "content-type": "application/json" }),
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}
async function api<T>(
  path: string,
  token?: string,
  value?: unknown,
  method?: string,
): Promise<T> {
  const response = await request(path, token, value, method);
  const body = await response.json();
  assert.equal(
    response.status,
    200,
    `${path}: ${body.code ?? response.status}`,
  );
  return body as T;
}
async function authenticate(index: number) {
  const card = accounts.accounts[index],
    secrets = accounts.testSecrets[index];
  const options = await api<RecoveryOptionsV1>(
    "/v1/auth/recovery/options",
    undefined,
    { version: 1, accountId: card.accountId, client: "native" },
  );
  // Exercise client-only recovery decryption before proving identity to the service.
  const bundle = JSON.parse(
    new TextDecoder().decode(
      unwrapKey(
        options.vault.wrappers[0].wrappedBundle,
        unb64(secrets.recoverySecret),
      ),
    ),
  );
  assert.equal(bundle.signingSecretKey, secrets.signingSecretKey);
  const proof = {
    version: 1,
    challengeId: options.challengeId,
    challenge: options.challenge,
    accountId: card.accountId,
    client: "native",
    origin,
  };
  const session = await api<SessionV1>("/v1/auth/recovery/verify", undefined, {
    version: 1,
    challengeId: options.challengeId,
    client: "native",
    signedPayload: signPayload(
      "recovery-session",
      card.accountId,
      utf8(proof),
      unb64(bundle.signingSecretKey),
    ),
  });
  assert.ok(session.token);
  return { card, secrets, token: session.token! };
}
type Client = Awaited<ReturnType<typeof authenticate>>;
async function upload(client: Client) {
  const photoId = randomUUID(),
    metadataKey = sodium.randombytes_buf(32),
    keys: Record<string, string> = {};
  async function representation(
    kind: MediaBinding["kind"],
    bytes: Uint8Array,
    key: Uint8Array,
  ) {
    const binding: MediaBinding = {
      version: 1,
      photoId,
      representationId: randomUUID(),
      kind,
    };
    const ciphertext = await collect(
      encryptMedia(records(bytes), key, binding),
    );
    const reservation = await api<UploadReservationV1>(
      "/v1/uploads/reserve",
      client.token,
      {
        version: 1,
        binding,
        operationId: randomUUID(),
        ciphertextBytes: ciphertext.length,
        ciphertextSha256: sha(ciphertext),
      },
    );
    const staging = new URL(reservation.stagingUrl);
    assert.equal(staging.origin, base.origin);
    const put = await fetch(staging, {
      method: "PUT",
      headers: { origin, authorization: `Bearer ${client.token}` },
      body: ciphertext,
    });
    assert.equal(put.status, 200);
    const commit = await api<UploadCommitV1>(
      `/v1/uploads/${reservation.uploadId}/commit`,
      client.token,
      {},
    );
    assert.deepEqual(
      await api(`/v1/uploads/${reservation.uploadId}/commit`, client.token, {}),
      commit,
    );
    return {
      binding,
      objectId: commit.objectId,
      header: b64(ciphertext.subarray(0, 24)),
      ciphertextBytes: ciphertext.length,
      ciphertextSha256: sha(ciphertext),
    } satisfies RepresentationV1;
  }
  const original = await readFile(
    new URL("../../fixtures/media/singapore.jpg", import.meta.url),
  );
  const reps: RepresentationV1[] = [];
  for (const [kind, name] of [
    ["original", "singapore"],
    ["thumbnail", "thumbnail"],
    ["preview", "preview"],
  ] as const) {
    const key = sodium.randombytes_buf(32);
    const rep = await representation(
      kind,
      await readFile(
        new URL(`../../fixtures/media/${name}.jpg`, import.meta.url),
      ),
      key,
    );
    reps.push(rep);
    keys[rep.binding.representationId] = b64(key);
  }
  const metadata: PhotoMetadataV1 = {
    version: 1,
    filename: "singapore.jpg",
    mediaType: "image/jpeg",
    sourceDate: new Date().toISOString(),
    dateSource: "import",
    originalBytes: original.length,
    originalSha256: sha(original),
    representationKeys: keys,
  };
  const manifest: PhotoManifestV1 = {
    version: 1,
    photoId,
    ownerAccountId: client.card.accountId,
    representations: reps,
    metadataRepresentation: await representation(
      "metadata",
      utf8(metadata),
      metadataKey,
    ),
    ownerWrappedMetadataKey: wrapKey(
      metadataKey,
      unb64(client.secrets.vaultKey),
    ),
  };
  const signed = signPayload(
    "photo-manifest",
    client.card.accountId,
    utf8(manifest),
    unb64(client.secrets.signingSecretKey),
  );
  assert.deepEqual(await api("/v1/photos", client.token, signed), manifest);
  return { manifest, signed, metadataKey, original };
}
async function restore(client: Client, manifest: PhotoManifestV1) {
  const metadataKey = unwrapKey(
    manifest.ownerWrappedMetadataKey,
    unb64(client.secrets.vaultKey),
  );
  async function decode(rep: RepresentationV1, key: Uint8Array) {
    const response = await request(`/v1/objects/${rep.objectId}`, client.token);
    assert.equal(response.status, 200);
    const ciphertext = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha(ciphertext), rep.ciphertextSha256);
    assert.equal(ciphertext.length, rep.ciphertextBytes);
    assert.equal(b64(ciphertext.subarray(0, 24)), rep.header);
    return collect(decryptMedia(records(ciphertext), key, rep.binding));
  }
  const metadata: PhotoMetadataV1 = JSON.parse(
    new TextDecoder().decode(
      await decode(manifest.metadataRepresentation, metadataKey),
    ),
  );
  const rep = manifest.representations.find(
    (value) => value.binding.kind === "original",
  )!;
  const original = await decode(
    rep,
    unb64(metadata.representationKeys[rep.binding.representationId]),
  );
  assert.equal(sha(original), metadata.originalSha256);
  assert.equal(original.length, metadata.originalBytes);
  return original;
}
async function save(
  client: Client,
  sender: Client,
  photo: Awaited<ReturnType<typeof upload>>,
  grant: GrantV1,
) {
  const detail = await api<{ envelopes: any[] }>(
    `/v1/grants/${grant.grantId}`,
    client.token,
  );
  const envelope = detail.envelopes.find(
    (value) =>
      value.photoId === photo.manifest.photoId &&
      value.recipientAccountId === client.card.accountId,
  );
  const key = openShareKey(
    envelope,
    unb64(client.secrets.boxSecretKey),
    sender.card as any,
    {
      version: 1,
      grantId: grant.grantId,
      photoId: photo.manifest.photoId,
      senderAccountId: sender.card.accountId,
      recipientAccountId: client.card.accountId,
    },
  );
  const manifest: PhotoManifestV1 = {
    ...photo.manifest,
    photoId: randomUUID(),
    ownerAccountId: client.card.accountId,
    ownerWrappedMetadataKey: wrapKey(key, unb64(client.secrets.vaultKey)),
  };
  assert.equal(
    Buffer.from(await restore(client, manifest)).equals(photo.original),
    true,
    "Received original bytes must match the source",
  );
  const signedPayload = signPayload(
    "photo-manifest",
    client.card.accountId,
    utf8(manifest),
    unb64(client.secrets.signingSecretKey),
  );
  const save: SavedPhotoV1 = {
    version: 1,
    operationId: randomUUID(),
    photoId: manifest.photoId,
    sourceGrantId: grant.grantId,
    sourcePhotoId: photo.manifest.photoId,
    manifest,
    signedPayload,
  };
  const input = { version: 1, expectedGrantVersion: grant.version, save };
  assert.deepEqual(await api("/v1/saves", client.token, input), save);
  assert.deepEqual(await api("/v1/saves", client.token, input), save);
  return manifest;
}
test("real local D1/R2: recover, encrypted originals both ways, independent saves after revocation", async () => {
  await ready;
  const A = await authenticate(0),
    B = await authenticate(1),
    photoA = await upload(A),
    moment = randomUUID();
  assert.equal(
    (
      await request(
        `/v1/objects/${photoA.manifest.representations[0].objectId}`,
        B.token,
      )
    ).status,
    403,
  );
  const grant = await api<GrantV1>(
    `/v1/moments/${moment}/grants/options`,
    A.token,
    {
      version: 1,
      recipientAccountId: B.card.accountId,
      role: "contributor",
      access: "ongoing",
    },
  );
  const envelopes = [
    sealShareKey(
      photoA.metadataKey,
      B.card as any,
      {
        version: 1,
        grantId: grant.grantId,
        photoId: photoA.manifest.photoId,
        senderAccountId: A.card.accountId,
        recipientAccountId: B.card.accountId,
      },
      unb64(A.secrets.signingSecretKey),
    ),
  ];
  await api(`/v1/moments/${moment}/grants`, A.token, {
    version: 1,
    grant,
    envelopes,
    signedPayload: signPayload(
      "grant",
      A.card.accountId,
      utf8({ grant, envelopes }),
      unb64(A.secrets.signingSecretKey),
    ),
  });
  const savedB = await save(B, A, photoA, grant);
  const photoB = await upload(B);
  const contribution = {
    version: 1,
    operationId: randomUUID(),
    expectedGrantVersion: grant.version,
    manifests: [photoB.signed],
    envelopes: [
      sealShareKey(
        photoB.metadataKey,
        A.card as any,
        {
          version: 1,
          grantId: grant.grantId,
          photoId: photoB.manifest.photoId,
          senderAccountId: B.card.accountId,
          recipientAccountId: A.card.accountId,
        },
        unb64(B.secrets.signingSecretKey),
      ),
    ],
  };
  await api(`/v1/moments/${moment}/contributions`, B.token, contribution);
  const savedA = await save(A, B, photoB, grant);
  await api(`/v1/grants/${grant.grantId}`, A.token, undefined, "DELETE");
  assert.equal(
    (await request(`/v1/grants/${grant.grantId}`, B.token)).status,
    403,
  );
  // New sessions, with no transient metadata keys, restore recipient-owned records.
  for (const [index, saved, original] of [
    [0, savedA, photoB.original],
    [1, savedB, photoA.original],
  ] as const) {
    const clean = await authenticate(index);
    const page = await api<{
      changes: { entityId: string; payload: SignedPayloadV1 | null }[];
    }>("/v1/changes?limit=100", clean.token);
    const signed = page.changes.find(
      (change) => change.entityId === saved.photoId,
    )!.payload!;
    const restoredManifest = JSON.parse(
      new TextDecoder().decode(
        verifyPayload(signed, unb64(clean.card.signingPublicKey)),
      ),
    );
    assert.equal(
      Buffer.from(await restore(clean, restoredManifest)).equals(original),
      true,
      "Restored original bytes must match the source",
    );
  }
});
