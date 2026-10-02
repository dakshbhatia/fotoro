import test from "node:test";
import assert from "node:assert/strict";
import {localOriginalDigest} from "../src/exchange/annotations";

// CloudApp renders this synchronously on first import, before waiting for sodium.ready.
const digestBeforeCryptoReady=localOriginalDigest({digest:"0123456789abcdef".repeat(4)});
test("local digest comparison works on a cold Sync render with canonical base64url encoding",()=>{
  assert.equal(digestBeforeCryptoReady,Buffer.from("0123456789abcdef".repeat(4),"hex").toString("base64url"));
  assert.equal(localOriginalDigest({digest:"ff".repeat(32)}),"__________________________________________8");
  assert.equal(localOriginalDigest({digest:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}),"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(localOriginalDigest({}),undefined);
});
