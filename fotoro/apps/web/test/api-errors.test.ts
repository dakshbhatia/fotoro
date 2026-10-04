import test from "node:test";
import assert from "node:assert/strict";
import {api, fetchCipher, ApiError, accountLimitMessage} from "../src/exchange/api";

test("JSON and media failures retain a validated support request ID without changing error codes", async () => {
  const requestId = "12345678-1234-4234-8234-123456789abc";
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({code: "FORBIDDEN", retryable: true, requestId}), {status: 403});
  try {
    for (const operation of [() => api("/v1/vault"), () => fetchCipher("photo")]) {
      await assert.rejects(operation(), error => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.message, "FORBIDDEN");
        assert.equal(error.retryable, true);
        assert.equal((error as ApiError & {requestId?: string}).requestId, requestId);
        return true;
      });
    }
  } finally {globalThis.fetch = previous;}
});

test("non-JSON and malformed API failures report HTTP status instead of a parsing exception", async () => {
  const previous = globalThis.fetch;
  try {
    for (const body of ["<html>Not found</html>", "null", '{"code":null}']) {
      globalThis.fetch = async () => new Response(body, {status: 404});
      for (const operation of [() => api("/v1/vault"), () => fetchCipher("photo")]) {
        await assert.rejects(operation(), error => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.code, "HTTP_404");
          return true;
        });
      }
    }
  } finally {globalThis.fetch = previous;}
});

test("a malformed request ID cannot enter client diagnostics", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({code: "FORBIDDEN", requestId: "private-token\nnot-an-id"}), {status: 403});
  try {
    await assert.rejects(api("/v1/vault"), error => {
      assert.ok(error instanceof ApiError);
      assert.equal((error as ApiError & {requestId?: string}).requestId, undefined);
      return true;
    });
  } finally {globalThis.fetch = previous;}
});

test("quota and throttling stay readable and Retry-After is a bounded numeric hint, never an automatic retry", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {calls++; return new Response(JSON.stringify({version: 1, code: "AUTH_RATE_LIMITED", retryable: true}), {status: 429, headers: {"Retry-After": "120"}});};
    await assert.rejects(api("/v1/auth/recovery/options"), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.retryAfterSeconds, 120);
      assert.equal(accountLimitMessage(error), "Too many attempts. Retry in 2 minutes.");
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(accountLimitMessage(new ApiError("STORAGE_QUOTA_EXCEEDED")), "Fotoro storage is full. Contact support to continue saving.");
    for (const value of ["Fri, 01 Jan 2027 12:00:00 GMT", "-1", "Infinity", "1e9", "private-text", "1000000"]) {
      const error = new ApiError("AUTH_RATE_LIMITED", true, undefined, value);
      assert.equal(error.retryAfterSeconds, undefined);
      assert.equal(accountLimitMessage(error), "Too many attempts. Wait a little, then Retry.");
    }
  } finally {globalThis.fetch = previous;}
});
