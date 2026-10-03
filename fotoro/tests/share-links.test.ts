import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContactLink, createMomentLink, parseShareLink, validatePublicAccountCard, ShareLinkError } from "../packages/contracts/src/share-links.js";
import vectors from "../fixtures/share-links-v1.json";
import type { AccountCardV1 } from "../packages/contracts/src/models.js";

const card = vectors.card as AccountCardV1;
test("public share links use the same frozen canonical bytes as Swift", async () => {
  assert.equal(createContactLink(card), vectors.contactLink);
  assert.equal(createMomentLink(vectors.grantId, card), vectors.momentLink);
  assert.deepEqual(parseShareLink(vectors.contactLink), { kind: "contact", card });
  assert.deepEqual(parseShareLink(vectors.momentLink), { kind: "moment", grantId: vectors.grantId, senderCard: card });
  assert.deepEqual(JSON.parse(await readFile(new URL("../apps/ios/FotoroTests/share-links-v1.json", import.meta.url), "utf8")), vectors);
  for (const url of [vectors.contactLink, vectors.momentLink]) {
    const body = JSON.parse(Buffer.from(url.split("=")[1], "base64url").toString("utf8"));
    assert.ok(!/password|secret|token|vaultKey|sealedMetadataKey/.test(JSON.stringify(body)));
  }
});
test("strict share parsing rejects malformed, hidden and foreign-origin payloads", () => {
  for (const vector of vectors.invalidLinks)
    assert.throws(() => parseShareLink(vector.url), ShareLinkError, vector.name);
  for (const value of [null, {}, 1, new URL(vectors.contactLink)])
    assert.throws(() => parseShareLink(value as never), ShareLinkError);
});
test("explicit service origins never relax link origin, root path or encoding checks", () => {
  for (const origin of ["http://localhost:4310", "http://127.0.0.1:4310", "http://[::1]:4310", "https://photos.example.com"]) {
    const link = createContactLink(card, origin);
    assert.deepEqual(parseShareLink(link, origin), {kind: "contact", card});
    assert.throws(() => parseShareLink(link), ShareLinkError);
  }
  for (const origin of ["http://evil.invalid", "https://fotoro.cloud/", "https://FOTORO.cloud", "https://fotoro.cloud:443", "https://user@fotoro.cloud", "https://fotoro.cloud?x=1", "https://fotoro.cloud.", "http://localhost:04310", "http://localhost:65536", "https://127.1", "https://bad_host.invalid", "https://-bad.invalid"])
    assert.throws(() => createContactLink(card, origin), ShareLinkError, origin);
});
test("creating a link validates public fields and never mutates or trusts supplied identity", () => {
  const before = JSON.stringify(card);
  assert.deepEqual(validatePublicAccountCard(card), card);
  assert.equal(JSON.stringify(card), before);
  for (const bad of [{...card, version: 2}, {...card, signingSecretKey: "private"}, {...card, accountId: "../vault"}, {...card, boxPublicKey: card.boxPublicKey.slice(0, -1) + "d"}])
    assert.throws(() => createContactLink(bad as AccountCardV1), ShareLinkError);
  assert.throws(() => createMomentLink("../vault", card), ShareLinkError);
  // Valid public identity changes are proposals. Authentication and explicit trust belong to the caller.
  const changed = {...card, signingPublicKey: "A".repeat(43)};
  assert.deepEqual(parseShareLink(createContactLink(changed)), {kind: "contact", card: changed});
});
