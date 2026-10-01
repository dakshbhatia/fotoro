import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { ready } from "@fotoro/crypto";
import { atomic, get, put, cacheCipher } from "../src/exchange/cache";
import { validateSource, sourceMatches } from "../src/exchange/journal";
import { digest } from "../src/library/catalog";
test("original format and size boundary are explicit", () => {
  assert.throws(
    () => validateSource({ type: "image/heic", size: 1 }),
    /JPEG_AND_PNG/,
  );
  assert.throws(
    () => validateSource({ type: "image/png", size: 50 * 1024 * 1024 + 1 }),
    /50_MIB/,
  );
  validateSource({ type: "image/jpeg", size: 50 * 1024 * 1024 });
});
test("read eviction does not remove uncommitted staging or change journal state", async () => {
  await put("staging", "test:pending", new Uint8Array([1]));
  await put("journal", "test:op", { state: "queued" });
  await cacheCipher("old", new Uint8Array(60 * 1024 * 1024));
  await cacheCipher("new", new Uint8Array(60 * 1024 * 1024));
  assert.equal(await get("read", "old"), undefined);
  assert.deepEqual(await get("staging", "test:pending"), new Uint8Array([1]));
  assert.deepEqual(await get("journal", "test:op"), { state: "queued" });
});
test("source re-selection matches actual digest rather than filename", async () => {
  await ready;
  const original = new File([new Uint8Array([1, 2, 3])], "same.jpg", {
    type: "image/jpeg",
  });
  const pending = { sourceDigest: digest(new Uint8Array([1, 2, 3])) } as any;
  assert.equal(await sourceMatches(original, pending), true);
  assert.equal(
    await sourceMatches(new File([new Uint8Array([4])], "same.jpg"), pending),
    false,
  );
});
test("failed structured-clone staging writes abort atomically", async () => {
  await assert.rejects(
    atomic([
      { store: "staging", key: "partial", value: new Uint8Array([1]) },
      { store: "journal", key: "invalid", value: () => 0 },
    ]),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await get("staging", "partial"), undefined);
});
test("quota failure cannot persist partial staging or a complete journal", async () => {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
    if (this.name === "journal")
      throw new DOMException("quota", "QuotaExceededError");
    return original.call(this, value, key);
  } as any;
  try {
    await assert.rejects(
      atomic([
        { store: "staging", key: "quota-part", value: new Uint8Array([1]) },
        { store: "journal", key: "quota-op", value: { state: "committed" } },
      ]),
      /quota/,
    );
    assert.equal(await get("staging", "quota-part"), undefined);
    assert.equal(await get("journal", "quota-op"), undefined);
  } finally {
    IDBObjectStore.prototype.put = original;
  }
});
