import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { put, get, clearAccount } from "../src/exchange/cache";

test("sign out clears an account with empty stores and preserves other accounts", async () => {
  await put("settings", "last-account", "A");
  await put("catalog", "A:photo", { ciphertext: "a" });
  await put("catalog", "B:photo", { ciphertext: "b" });
  await clearAccount("A");
  assert.equal(await get("settings", "last-account"), undefined);
  assert.equal(await get("catalog", "A:photo"), undefined);
  assert.deepEqual(await get("catalog", "B:photo"), { ciphertext: "b" });
  await clearAccount("A");
});
