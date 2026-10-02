import test from "node:test";
import assert from "node:assert/strict";
import { resolveUploadURL } from "../src/exchange/api";

test("local Worker upload URLs pass through the authenticated same-origin proxy", () => {
  const path =
    "/v1/uploads/00000000-0000-4000-8000-000000000010/staging?cap=test";
  assert.equal(
    resolveUploadURL(
      "http://127.0.0.1:8787" + path,
      "http://localhost:4310",
      "http://127.0.0.1:8787",
    ).href,
    "http://localhost:4310" + path,
  );
  assert.throws(
    () =>
      resolveUploadURL("http://127.0.0.1:8787" + path, "https://fotoro.cloud"),
    /UNTRUSTED_UPLOAD_URL/,
  );
  assert.throws(
    () =>
      resolveUploadURL(
        "https://wrong.example" + path,
        "http://localhost:4310",
        "https://wrong.example",
      ),
    /UNTRUSTED_UPLOAD_URL/,
  );
  assert.equal(
    resolveUploadURL("https://fotoro.cloud" + path, "https://fotoro.cloud")
      .href,
    "https://fotoro.cloud" + path,
  );
});
