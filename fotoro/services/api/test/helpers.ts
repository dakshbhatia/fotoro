import { env } from "cloudflare:test";
import app from "../src/index";
import { b64, unb64, utf8 } from "../src/errors";
import cards from "../../../fixtures/accounts.json";
export const actors = cards.accounts.map((c) => ({
  accountId: c.accountId,
  deviceId: crypto.randomUUID(),
}));
export async function signed(index: number, kind: string, body: any) {
  const seed = unb64(cards.testSecrets[index].signingSecretKey).slice(0, 32),
    der = new Uint8Array(48);
  der.set([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  der.set(seed, 16);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const s = {
    version: 1,
    kind,
    accountId: actors[index].accountId,
    body: b64(utf8(body)),
    signature: "",
  };
  s.signature = b64(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        key,
        utf8(["fotoro-signed-v1", kind, s.accountId, s.body]),
      ),
    ),
  );
  return s;
}
export async function share(index: number, grant: any, photoId: string) {
  const e = {
    version: 1,
    grantId: grant.grantId,
    photoId,
    senderAccountId: actors[index].accountId,
    recipientAccountId: index === 0 ? actors[1].accountId : actors[0].accountId,
    sealedMetadataKey: b64(new Uint8Array(80)),
    senderSignature: "",
  };
  const seed = unb64(cards.testSecrets[index].signingSecretKey).slice(0, 32),
    der = new Uint8Array(48);
  der.set([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]);
  der.set(seed, 16);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  e.senderSignature = b64(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        key,
        utf8([
          "fotoro-share-v1",
          e.grantId,
          photoId,
          e.senderAccountId,
          e.recipientAccountId,
          e.sealedMetadataKey,
        ]),
      ),
    ),
  );
  return e;
}
export async function seed() {
  for (let n = 0; n < 2; n++) {
    await env.DB.prepare("INSERT OR IGNORE INTO accounts VALUES(?,?)")
      .bind(actors[n].accountId, JSON.stringify(cards.accounts[n]))
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO devices(id,account_id,trusted) VALUES(?,?,1)",
    )
      .bind(actors[n].deviceId, actors[n].accountId)
      .run();
  }
}
export async function http(
  index: number,
  path: string,
  method = "GET",
  body?: any,
) {
  const token = `public-test-${index}`,
    hash = b64(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
    );
  await env.DB.prepare("INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)")
    .bind(
      hash,
      actors[index].accountId,
      actors[index].deviceId,
      Date.now() + 60000,
    )
    .run();
  return app.fetch(
    new Request("http://localhost:8787" + path, {
      method,
      headers: {
        authorization: "Bearer " + token,
        origin: "http://localhost:4310",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env as any,
  );
}
export async function photo(index: number) {
  const id = crypto.randomUUID(),
    reps = [];
  for (const kind of ["original", "metadata"]) {
    const bytes = utf8("cipher-" + crypto.randomUUID()),
      binding = {
        version: 1,
        photoId: id,
        representationId: crypto.randomUUID(),
        kind,
      },
      input = {
        version: 1,
        binding,
        operationId: crypto.randomUUID(),
        ciphertextBytes: bytes.length,
        ciphertextSha256: b64(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        ),
      };
    const r = (await (
      await http(index, "/v1/uploads/reserve", "POST", input)
    ).json()) as any;
    const p = await app.fetch(
      new Request(r.stagingUrl, {
        method: "PUT",
        headers: {
          authorization: `Bearer public-test-${index}`,
          origin: "http://localhost:4310",
        },
        body: bytes,
      }),
      env as any,
    );
    if (p.status !== 200) throw new Error(await p.text());
    const c = (await (
      await http(index, `/v1/uploads/${r.uploadId}/commit`, "POST")
    ).json()) as any;
    reps.push({
      binding,
      objectId: c.objectId,
      header: b64(new Uint8Array(24)),
      ciphertextBytes: bytes.length,
      ciphertextSha256: input.ciphertextSha256,
    });
  }
  const m = {
    version: 1,
    photoId: id,
    ownerAccountId: actors[index].accountId,
    representations: [reps[0]],
    metadataRepresentation: reps[1],
    ownerWrappedMetadataKey: {
      version: 1,
      nonce: b64(new Uint8Array(24)),
      ciphertext: b64(new Uint8Array(48)),
    },
  };
  const s = await signed(index, "photo-manifest", m);
  const res = await http(index, "/v1/photos", "POST", s);
  if (res.status !== 200) throw new Error(await res.text());
  return { m, s };
}
