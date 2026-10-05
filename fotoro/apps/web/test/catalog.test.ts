import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import accounts from "../../../fixtures/accounts.json";
import type { MediaBinding, PhotoManifestV1, PhotoMetadataV1, RepresentationV1 } from "@fotoro/contracts";
import { LIVE_PHOTO_TYPE, photoManifestKind } from "@fotoro/contracts/camera-media";
import { ready, unb64, b64, encryptMedia, sodium, signPayload, utf8, wrapKey } from "@fotoro/crypto";
import { configureVault, unlockVault, lockVault, encryptPrivate, decryptPrivate } from "../src/vault/vault";
import { clearAccount, get, put } from "../src/exchange/cache";
import { cachedCatalog, collect, digest, photoBytes, source, syncCatalog } from "../src/library/catalog";
import { cameraOriginalFiles } from "../src/media/camera-original";

async function open(index: number) {
  const secret = accounts.testSecrets[index];
  configureVault({
    version: 1,
    accountCard: accounts.accounts[index],
    wrappers: [
      {
        version: 1,
        wrapperId: crypto.randomUUID(),
        kind: "recovery",
        credentialId: null,
        prfSalt: null,
        verified: true,
        wrappedBundle: secret.encryptedBundle,
      },
    ],
  } as any);
  return unlockVault({
    kind: "recovery",
    secret: unb64(secret.recoverySecret),
  });
}

test("an old account's delayed sync cannot write the new account's cursor", async () => {
  await ready;
  await open(0);
  const old = globalThis.fetch;
  let receive!: (response: Response) => void;
  let requested!: () => void;
  const began = new Promise<void>((resolve) => {
    requested = resolve;
  });
  globalThis.fetch = (async () => {
    requested();
    return new Promise<Response>((resolve) => {
      receive = resolve;
    });
  }) as any;
  try {
    const pending = syncCatalog();
    const rejected = assert.rejects(pending, /VAULT_LOCKED/);
    await began;
    lockVault();
    await open(1);
    receive(
      new Response(
        JSON.stringify({
          version: 1,
          changes: [],
          nextCursor: "b2xkLWFjY291bnQ",
          hasMore: false,
        }),
      ),
    );
    await rejected;
    assert.equal(
      await get("settings", accounts.accounts[1].accountId + ":cursor"),
      undefined,
    );
    assert.equal(
      await get("settings", accounts.accounts[0].accountId + ":cursor"),
      undefined,
    );
  } finally {
    globalThis.fetch = old;
    lockVault();
  }
});

test("an older service cannot acknowledge media support or advance the current reader cursor", async () => {
  await ready; await open(0);
  const old = globalThis.fetch, id = accounts.accounts[0].accountId;
  globalThis.fetch = (async (path: string | URL | Request) => {
    assert.ok(String(path).includes("media=1"));
    return new Response(JSON.stringify({version: 1, changes: [], nextCursor: "unsupported", hasMore: false}));
  }) as any;
  try {
    await assert.rejects(syncCatalog(), /MEDIA_READER_UPDATE_REQUIRED/);
    assert.equal(await get("settings", id + ":cursor"), undefined);
    assert.equal(await get("settings", id + ":media-reader-v1"), undefined);
  } finally {globalThis.fetch = old; lockVault();}
});

test("current media reader rescans a legacy cursor once, then resumes the acknowledged cursor", async () => {
  await ready; await open(0);
  const old = globalThis.fetch, id = accounts.accounts[0].accountId, requests: URL[] = [];
  await put("settings", id + ":cursor", encryptPrivate("legacy-skipped-media"));
  globalThis.fetch = (async (path: string | URL | Request) => {
    requests.push(new URL(String(path), "http://localhost"));
    return new Response(JSON.stringify({version: 1, mediaVersion: 1, changes: [], nextCursor: "current-media", hasMore: false}));
  }) as any;
  try {
    await syncCatalog();
    assert.equal(requests[0].searchParams.get("media"), "1");
    assert.equal(requests[0].searchParams.get("cursor"), null);
    assert.equal(decryptPrivate(await get("settings", id + ":media-reader-v1")), true);
    await syncCatalog();
    assert.equal(requests[1].searchParams.get("cursor"), "current-media");
  } finally {globalThis.fetch = old; lockVault();}
});

test("real originals recover after an interrupted download, fresh same-account unlock and offline reopen", {timeout: 10_000}, async (t) => {
  await ready;
  const read = async (path: string) => new Uint8Array(await readFile(new URL(path, import.meta.url)));
  const jpeg = await read("../../../fixtures/media/singapore.jpg"),
    png = await read("../../../fixtures/search/neutral-a.png"),
    heic = await read("../../../fixtures/media/singapore.heic"),
    thumbnailBytes = await read("../../../fixtures/media/thumbnail.jpg"),
    previewBytes = await read("../../../fixtures/media/preview.jpg"),
    motion = await read("../../ios/FotoroTests/camera-motion.mov"),
    live = await read("../../ios/FotoroTests/camera-live.fotoro-live");
  const cases: {filename: string; mediaType: PhotoMetadataV1["mediaType"]; bytes: Uint8Array;
    resources?: {filename: string; mediaType: string; bytes: Uint8Array}[]}[] = [
    {filename: "Singapore.JPG", mediaType: "image/jpeg", bytes: jpeg},
    {filename: "original.png", mediaType: "image/png", bytes: png},
    {filename: "Singapore.HEIC", mediaType: "image/heic", bytes: heic},
    {filename: "paired.MOV", mediaType: "video/quicktime", bytes: motion},
    {filename: "original.fotoro-live", mediaType: LIVE_PHOTO_TYPE, bytes: live, resources: [
      {filename: "original.png", mediaType: "image/png", bytes: png},
      {filename: "paired.MOV", mediaType: "video/quicktime", bytes: motion},
    ]},
  ];
  for (const sample of cases) await t.test(sample.mediaType, async () => {
    const oldFetch = globalThis.fetch, accountId = accounts.accounts[0].accountId;
    await clearAccount(accountId);
    try {
      const sender = await open(0), photoId = crypto.randomUUID(), objects = new Map<string, Uint8Array>();
      const representation = async (kind: MediaBinding["kind"], bytes: Uint8Array, key: Uint8Array): Promise<RepresentationV1> => {
        const binding: MediaBinding = {version: 1, photoId, representationId: crypto.randomUUID(), kind};
        const ciphertext = await collect(encryptMedia(source(bytes), key, binding)), objectId = crypto.randomUUID();
        objects.set(objectId, ciphertext);
        return {binding, objectId, header: b64(ciphertext.subarray(0, 24)), ciphertextBytes: ciphertext.length, ciphertextSha256: digest(ciphertext)};
      };
      const originalKey = sodium.randombytes_buf(32), metadataKey = sodium.randombytes_buf(32),
        thumbnailKey = sodium.randombytes_buf(32), previewKey = sodium.randombytes_buf(32);
      const original = await representation("original", sample.bytes, originalKey);
      const thumbnail = await representation("thumbnail", thumbnailBytes, thumbnailKey), preview = await representation("preview", previewBytes, previewKey);
      const metadata: PhotoMetadataV1 = {version: 1, filename: sample.filename, mediaType: sample.mediaType,
        sourceDate: "2026-10-01T12:00:00Z", dateSource: "photos", originalBytes: sample.bytes.length,
        originalSha256: digest(sample.bytes), representationKeys: {[original.binding.representationId]: b64(originalKey),
          [thumbnail.binding.representationId]: b64(thumbnailKey), [preview.binding.representationId]: b64(previewKey)}};
      const manifest: PhotoManifestV1 = {version: 1, photoId, ownerAccountId: accountId, representations: [thumbnail, preview, original],
        metadataRepresentation: await representation("metadata", utf8(metadata), metadataKey),
        ownerWrappedMetadataKey: wrapKey(metadataKey, sender.vaultKey)};
      const signed = signPayload(photoManifestKind(metadata), accountId, utf8(manifest), sender.signingSecretKey);
      originalKey.fill(0); metadataKey.fill(0); thumbnailKey.fill(0); previewKey.fill(0);
      lockVault();
      const reader = await open(0);
      assert.notEqual(reader, sender, "The reader must unwrap its own account keys");

      let began!: () => void, interrupt!: () => void;
      const bodyBegan = new Promise<void>(resolve => {began = resolve;}), interrupted = new Promise<void>(resolve => {interrupt = resolve;});
      let originalRequests = 0, offline = false;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(offline, false, "An offline reopen must use persisted verified ciphertext");
        assert.equal(init?.method ?? "GET", "GET", "Recovery must not reserve, upload or publish");
        const url = new URL(String(input), "https://recovery.test");
        if (url.pathname === "/v1/changes") {
          assert.equal(url.searchParams.get("media"), "1");
          return new Response(JSON.stringify({version: 1, mediaVersion: 1, changes: [
            {cursor: "1", entity: "photo", entityId: photoId, deleted: false, payload: signed},
          ], nextCursor: "1", hasMore: false}));
        }
        assert.ok(url.pathname.startsWith("/v1/objects/"), "Only the catalog and original object service may be read");
        const id = url.pathname.slice("/v1/objects/".length), ciphertext = objects.get(id);
        assert.ok(ciphertext, "The object must belong to the signed fixture manifest");
        if (id === original.objectId && ++originalRequests === 1) {
          let sent = false;
          return new Response(new ReadableStream<Uint8Array>({async pull(controller) {
            if (!sent) {sent = true; controller.enqueue(ciphertext.subarray(0, 1024)); began();}
            else {await interrupted; controller.error(new TypeError("Original download interrupted"));}
          }}));
        }
        return new Response(new Uint8Array(ciphertext));
      }) as typeof fetch;

      await syncCatalog();
      const [first] = await cachedCatalog();
      assert.equal(first.manifest.photoId, photoId);
      let published: File[] | undefined;
      const pending = photoBytes(first, "original").then(async bytes => {published = await cameraOriginalFiles(bytes, first.metadata);});
      const rejection = assert.rejects(pending, /Original download interrupted/);
      await bodyBegan;
      assert.equal(await get("read", accountId + ":" + original.objectId), undefined);
      assert.equal(published, undefined, "A partial original cannot publish an export");
      interrupt(); await rejection;
      assert.equal(await get("read", accountId + ":" + original.objectId), undefined, "An interrupted body must not poison the retry cache");
      assert.equal(published, undefined);

      first.metadataKey.fill(0); lockVault();
      const renewed = await open(0);
      assert.notEqual(renewed, reader);
      const [retried] = await cachedCatalog();
      const verifyOriginal = async (photo: typeof retried) => {
        const bytes = await photoBytes(photo, "original");
        assert.deepEqual(bytes, sample.bytes, "The original must retain every byte, rather than a preview");
        assert.equal(digest(bytes), metadata.originalSha256);
        const files = await cameraOriginalFiles(bytes, photo.metadata), expected = sample.resources ?? [sample];
        assert.deepEqual(files.map(file => [file.name, file.type]), expected.map(part => [part.filename, part.mediaType]));
        for (let index = 0; index < files.length; index++) {
          const resource = new Uint8Array(await files[index].arrayBuffer());
          assert.deepEqual(resource, expected[index].bytes);
          assert.equal(digest(resource), digest(expected[index].bytes));
        }
        bytes.fill(0);
      };
      await verifyOriginal(retried);
      assert.equal(originalRequests, 2, "A fresh unlock must retry the failed download exactly once");
      retried.metadataKey.fill(0); lockVault();
      offline = true;
      await open(0);
      const [reopened] = await cachedCatalog();
      await verifyOriginal(reopened);
      reopened.metadataKey.fill(0);
      assert.equal(originalRequests, 2);
    } finally {globalThis.fetch = oldFetch; lockVault(); await clearAccount(accountId);}
  });
});
