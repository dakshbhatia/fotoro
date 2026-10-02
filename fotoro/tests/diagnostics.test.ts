import test from "node:test";
import assert from "node:assert/strict";
import {diagnosticMethod} from "../services/api/src/diagnostics";

test("request-controlled HTTP tokens cannot enter the diagnostic method field", () => {
  const request = new Request("https://fotoro.cloud/", {method: "PRIVATE_PHOTO_NAME"});
  assert.equal(diagnosticMethod(request.method), "OTHER");
  assert.equal(diagnosticMethod("GET"), "GET");
  assert.equal(diagnosticMethod("POST"), "POST");
  assert.equal(diagnosticMethod("X".repeat(10000)), "OTHER");
});
