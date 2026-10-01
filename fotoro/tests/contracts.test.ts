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
