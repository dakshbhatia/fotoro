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

test("private photo annotations preserve labels and bound OCR and update ciphertext", () => {
  const photoId = "a1672cf8-cc9b-44a5-9992-5508a40b36bc";
  const value = { version: 1, photoId, originalSha256: "A".repeat(43), labels: ["My EXACT label"], ocr: { text: "Receipt", confidence: 0.8, processor: "vision-v1" } };
  assert.equal(validateWire("PhotoAnnotationsV1", value), value);
  for (const bad of [{...value, labels: ["x".repeat(121)]}, {...value, labels: Array(65).fill("a")}, {...value, ocr: {...value.ocr, text: "x".repeat(131073)}}, {...value, ocr: {...value.ocr, confidence: 1.1}}, {...value, originalSha256: "not-a-digest"}, {...value, searchHistory: []}])
    assert.throws(() => validateWire("PhotoAnnotationsV1", bad));
  const update = {version: 1, photoId, revision: 1, encrypted: {version: 1, nonce: "A".repeat(32), ciphertext: "A".repeat(22)}};
  validateWire("PhotoAnnotationsUpdateV1", update);
  for (const revision of [0, 1.2, 2147483648]) assert.throws(() => validateWire("PhotoAnnotationsUpdateV1", {...update, revision}));
  assert.throws(() => validateWire("PhotoAnnotationsUpdateV1", {...update, encrypted: {...update.encrypted, ciphertext: "A".repeat(262145)}}));
});
test("optional scene annotations preserve old payloads and bound processor, category count and confidence", () => {
  const old = {version: 1, photoId: "a1672cf8-cc9b-44a5-9992-5508a40b36bc", originalSha256: "A".repeat(43)};
  assert.equal(validateWire("PhotoAnnotationsV1", old), old);
  const visual = {processor: "vision-image-classification-r1-v1", labels: [{label: "beach", identifier: "beach", confidence: 0.9}]};
  validateWire("PhotoAnnotationsV1", {...old, visual});
  validateWire("PhotoAnnotationsV1", {...old, visual: {...visual, labels: []}});
  for (const invalid of [null, {...visual, extra: true}, {...visual, labels: Array(7).fill(visual.labels[0])},
    {...visual, processor: ""}, {...visual, labels: [{...visual.labels[0], confidence: 1.1}]},
    {...visual, labels: [{...visual.labels[0], name: "Person"}]}]) assert.throws(() => validateWire("PhotoAnnotationsV1", {...old, visual: invalid}));
});
