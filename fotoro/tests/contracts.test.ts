import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWire } from "../packages/contracts/src/validate.js";
import accounts from "../fixtures/accounts.json";
test("account cards conform and unknown fields/version fail", () => {
  for (const a of accounts.accounts) {
    assert.equal(validateWire("AccountCardV1", a), a);
    assert.throws(() => validateWire("AccountCardV1", { ...a, version: 2 }));
    assert.throws(() => validateWire("AccountCardV1", { ...a, extra: true }));
  }
});
test("snapshot changes and signed crypto fixtures conform", async () => {
  const changes = (await import("../fixtures/changes-v1.json")).default,
    crypto = (await import("../fixtures/crypto-v1.json")).default;
  validateWire("ChangePageV1", changes);
  validateWire("SignedPayloadV1", crypto.signed);
  validateWire("ShareKeyEnvelopeV1", crypto.share.envelope);
  validateWire("WrappedKeyV1", crypto.wrappedKey);
  assert.throws(() => validateWire("ChangePageV1", { ...changes, version: 2 }));
  assert.throws(() =>
    validateWire("AccountCardV1", {
      ...accounts.accounts[0],
      boxPublicKey: "?".repeat(43),
    }),
  );
});
test("still original metadata accepts HEIC and PhotoKit dates without allowing video or empty originals", () => {
  const metadata = {
    version: 1,
    filename: "IMG_0001.HEIC",
    mediaType: "image/heic",
    sourceDate: "2026-10-01T12:00:00.000Z",
    dateSource: "photos",
    originalBytes: 52428800,
    originalSha256: "A".repeat(43),
    representationKeys: {},
  };
  assert.equal(validateWire("PhotoMetadataV1", metadata), metadata);
  for (const mediaType of ["image/jpeg", "image/png", "image/heic"]) {
    validateWire("PhotoMetadataV1", { ...metadata, mediaType });
  }
  for (const mediaType of ["video/quicktime", "image/gif", "image/heif"]) {
    assert.throws(() =>
      validateWire("PhotoMetadataV1", { ...metadata, mediaType }),
    );
  }
  for (const originalBytes of [0, -1, 52428801]) {
    assert.throws(() =>
      validateWire("PhotoMetadataV1", { ...metadata, originalBytes }),
    );
  }
  assert.throws(() =>
    validateWire("PhotoMetadataV1", { ...metadata, dateSource: "guessed" }),
  );
});
