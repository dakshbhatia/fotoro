import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import accounts from "../../fixtures/accounts.json";
import { validateWire } from "../../packages/contracts/src/validate.js";
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
  PhotoAnnotationsV1,
  PhotoAnnotationsUpdateV1,
  PhotoAnnotationsReplyV1,
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
async function upload(client: Client, filename = "singapore.jpg", background = false) {
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
    if (background) staging.pathname = `/v1/background/uploads/${reservation.uploadId}/staging`;
    const put = await fetch(staging, {
      method: "PUT",
      headers: background ? { origin } : { origin, authorization: `Bearer ${client.token}` },
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
    new URL(`../../fixtures/media/${filename}`, import.meta.url),
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
      kind === "original"
        ? original
        : await readFile(
            new URL(`../../fixtures/media/${name}.jpg`, import.meta.url),
          ),
      key,
    );
    reps.push(rep);
    keys[rep.binding.representationId] = b64(key);
  }
  const metadata: PhotoMetadataV1 = {
    version: 1,
    filename,
    mediaType: filename.endsWith(".heic") ? "image/heic" : "image/jpeg",
    sourceDate: new Date().toISOString(),
    dateSource: filename.endsWith(".heic") ? "photos" : "import",
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
  validateWire("PhotoMetadataV1", metadata);
  return { manifest, signed, metadataKey, original, metadata };
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
  const metadata = validateWire<PhotoMetadataV1>(
    "PhotoMetadataV1",
    JSON.parse(
      new TextDecoder().decode(
        await decode(manifest.metadataRepresentation, metadataKey),
      ),
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

test("real local D1/R2: background ciphertext upload and encrypted labels/OCR restore into a fresh account session", async () => {
  await ready;
  const owner = await authenticate(0), other = await authenticate(1);
  const photo = await upload(owner, "singapore.jpg", true);
  const value: PhotoAnnotationsV1 = {
    version: 1, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256,
    labels: ["My EXACT Marina label"], caption: "Public test photo", favorite: true,
    ocr: {text: "Public invoice 481 total 86.00", confidence: 0.93, processor: "fixture-ocr-v1"},
  };
  validateWire("PhotoAnnotationsV1", value);
  const encrypted = wrapKey(utf8(value), unb64(owner.secrets.vaultKey));
  const update: PhotoAnnotationsUpdateV1 = {version: 1, photoId: value.photoId, revision: 1, encrypted};
  const proof = signPayload("photo-annotations", owner.card.accountId, utf8(update), unb64(owner.secrets.signingSecretKey));
  const path = `/v1/photos/${value.photoId}/annotations`;
  assert.deepEqual(await api(path, owner.token, proof, "PUT"), proof);
  assert.deepEqual(await api(path, owner.token, proof, "PUT"), proof);
  const fresh = await authenticate(0);
  const reply = validateWire<PhotoAnnotationsReplyV1>("PhotoAnnotationsReplyV1", await api(path, fresh.token));
  const restoredUpdate = validateWire<PhotoAnnotationsUpdateV1>("PhotoAnnotationsUpdateV1", JSON.parse(new TextDecoder().decode(verifyPayload(reply.annotations!, unb64(fresh.card.signingPublicKey)))));
  const restored = validateWire<PhotoAnnotationsV1>("PhotoAnnotationsV1", JSON.parse(new TextDecoder().decode(unwrapKey(restoredUpdate.encrypted, unb64(fresh.secrets.vaultKey)))));
  assert.deepEqual(restored, value);
  assert.equal(restored.originalSha256, photo.metadata.originalSha256);
  assert.equal(JSON.stringify(update).includes(value.labels![0]), false);
  assert.equal((await request(path, other.token)).status, 403);
  const competing = signPayload("photo-annotations", owner.card.accountId, utf8({...update, encrypted: wrapKey(utf8({...value, labels:["Other edit"]}),unb64(owner.secrets.vaultKey))}), unb64(owner.secrets.signingSecretKey));
  assert.equal((await request(path, fresh.token, competing, "PUT")).status, 409);
  const page = await api<{changes:{entity:string;entityId:string;payload:SignedPayloadV1|null}[]}>("/v1/changes?limit=100", fresh.token);
  assert.equal(page.changes.filter(c => c.entity === "annotation" && c.entityId === value.photoId).length, 1);
  assert.deepEqual(page.changes.find(c => c.entity === "annotation" && c.entityId === value.photoId)!.payload, proof);
  assert.equal(Buffer.from(await restore(fresh, photo.manifest)).equals(photo.original), true);
});

test("real local D1/R2: HEIC still bytes survive upload and same-account restore in a fresh session", async () => {
  await ready;
  const original = await readFile(
    new URL("../../fixtures/media/singapore.heic", import.meta.url),
  );
  assert.equal(original.subarray(4, 8).toString(), "ftyp");
  const owner = await authenticate(0);
  const photo = await upload(owner, "singapore.heic");
  assert.equal(photo.metadata.mediaType, "image/heic");
  assert.equal(photo.metadata.filename, "singapore.heic");
  assert.equal(photo.metadata.dateSource, "photos");
  assert.equal(Buffer.from(photo.original).equals(original), true);
  const freshSession = await authenticate(0);
  const page = await api<{
    changes: { entityId: string; payload: SignedPayloadV1 | null }[];
  }>("/v1/changes?limit=100", freshSession.token);
  const signed = page.changes.find(
    (change) => change.entityId === photo.manifest.photoId,
  )!.payload!;
  const manifest = JSON.parse(
    new TextDecoder().decode(
      verifyPayload(signed, unb64(freshSession.card.signingPublicKey)),
    ),
  );
  const restored = await restore(freshSession, manifest);
  assert.equal(Buffer.from(restored).equals(original), true);
  assert.equal(sha(restored), sha(original));
});
