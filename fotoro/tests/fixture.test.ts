import { test } from "node:test";
import assert from "node:assert/strict";
import { createFixtureServer } from "../tools/fixture-server.js";
import accounts from "../fixtures/accounts.json";
test("fixture server binds only loopback, isolates accounts, serves encrypted originals", async () => {
  assert.throws(() => createFixtureServer({ host: "0.0.0.0" }));
  assert.throws(() => createFixtureServer({ production: true }));
  const server = await createFixtureServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base + "/v1/changes")).status, 401);
    const headers = {
      "x-fotoro-fixture-account": accounts.accounts[0].accountId,
    };
    const response = await fetch(base + "/v1/changes", { headers });
    const page = await response.json();
    assert.equal(response.status, 200);
    assert.ok(page.changes.length > 0);
    const photo = JSON.parse(
      Buffer.from(page.changes[0].payload.body, "base64url").toString(),
    );
    const objectId = photo.representations.find(
      (r: any) => r.binding.kind === "original",
    ).objectId;
    assert.equal(
      (await fetch(base + "/v1/objects/" + objectId, { headers })).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/v1/objects/" + objectId, {
          headers: {
            "x-fotoro-fixture-account": accounts.accounts[1].accountId,
          },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(base + "/__fixtures/accounts")).status, 200);
  } finally {
    await new Promise<void>((r, e) => server.close((x) => (x ? e(x) : r())));
  }
});

test("inbox exposes only included photos and independent save survives revocation", async () => {
  const {
    ready,
    unb64,
    utf8,
    signPayload,
    sealShareKey,
    unwrapKey,
    verifyPayload,
  } = await import("../packages/crypto/src/index.js");
  await ready;
  const server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const A = accounts.accounts[0],
    B = accounts.accounts[1],
    headers = (id: string) => ({
      "x-fotoro-fixture-account": id,
      "content-type": "application/json",
    });
  const request = (
    path: string,
    actor: string,
    method = "GET",
    value?: unknown,
  ) =>
    fetch(base + path, {
      method,
      headers: headers(actor),
      body: value ? JSON.stringify(value) : undefined,
    });
  try {
    const page = await (await request("/v1/changes", A.accountId)).json();
    const manifest = JSON.parse(
      new TextDecoder().decode(
        verifyPayload(page.changes[0].payload, unb64(A.signingPublicKey)),
      ),
    );
    const grant = await (
      await request(
        "/v1/moments/00000000-0000-4000-8000-000000000030/grants/options",
        A.accountId,
        "POST",
        {
          version: 1,
          recipientAccountId: B.accountId,
          role: "contributor",
          access: "ongoing",
        },
      )
    ).json();
    const binding = {
      version: 1 as const,
      grantId: grant.grantId,
      photoId: manifest.photoId,
      senderAccountId: A.accountId,
      recipientAccountId: B.accountId,
    };
    const metadataKey = unwrapKey(
      manifest.ownerWrappedMetadataKey,
      unb64(accounts.testSecrets[0].vaultKey),
    );
    const envelope = sealShareKey(
      metadataKey,
      B as any,
      binding,
      unb64(accounts.testSecrets[0].signingSecretKey),
    );
    const create = {
      version: 1,
      grant,
      envelopes: [envelope],
      signedPayload: signPayload(
        "grant",
        A.accountId,
        utf8({ grant, envelopes: [envelope] }),
        unb64(accounts.testSecrets[0].signingSecretKey),
      ),
    };
    assert.equal(
      (
        await request(
          "/v1/moments/" + grant.momentId + "/grants",
          A.accountId,
          "POST",
          create,
        )
      ).status,
      200,
    );
    const inbox = await (await request("/v1/grants", B.accountId)).json();
    assert.equal(inbox.grants.length, 1);
    const detail = await (
      await request("/v1/grants/" + grant.grantId, B.accountId)
    ).json();
    assert.equal(detail.envelopes[0].photoId, manifest.photoId);
    const savedManifest = {
      ...manifest,
      photoId: "00000000-0000-4000-8000-000000000050",
      ownerAccountId: B.accountId,
    };
    const save = {
      version: 1,
      operationId: "00000000-0000-4000-8000-000000000051",
      photoId: savedManifest.photoId,
      sourceGrantId: grant.grantId,
      sourcePhotoId: manifest.photoId,
      manifest: savedManifest,
      signedPayload: signPayload(
        "photo-manifest",
        B.accountId,
        utf8(savedManifest),
        unb64(accounts.testSecrets[1].signingSecretKey),
      ),
    };
    assert.equal(
      (
        await request("/v1/saves", B.accountId, "POST", {
          version: 1,
          expectedGrantVersion: 1,
          save: {
            ...save,
            manifest: { ...savedManifest, photoId: A.accountId },
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/v1/saves", B.accountId, "POST", {
          version: 1,
          expectedGrantVersion: 1,
          save,
        })
      ).status,
      200,
    );
    assert.equal(
      (await request("/v1/grants/" + grant.grantId, A.accountId, "DELETE"))
        .status,
      200,
    );
    assert.equal(
      (
        await request(
          "/v1/objects/" + manifest.representations[0].objectId,
          B.accountId,
        )
      ).status,
      200,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
