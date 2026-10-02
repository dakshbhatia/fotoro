import { test } from "node:test";
import assert from "node:assert/strict";
import accounts from "../fixtures/accounts.json";
import { warmLocalApi } from "../tools/warm-local-api.js";

const challenge = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function fixture(failure: "proxy" | "application" | "persistent") {
  let options = 0;
  const proofs: string[] = [];
  let logout = 0;
  const fetchRequest: typeof fetch = async (input, request) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(request?.body));
    if (path.endsWith("/options")) return Response.json({
      version: 1, challengeId: challenge(++options), challenge: "A".repeat(43), expiresAt: "2026-10-03T00:00:00Z",
      vault: { version: 1, accountCard: accounts.accounts[0], wrappers: [{
        version: 1, wrapperId: challenge(40), kind: "recovery", credentialId: null, prfSalt: null,
        wrappedBundle: accounts.testSecrets[0].encryptedBundle, verified: true,
      }] },
    });
    if (path.endsWith("/verify")) {
      const signedProof = JSON.parse(Buffer.from(body.signedPayload.body, "base64url").toString());
      assert.equal(signedProof.challengeId, body.challengeId);
      proofs.push(body.challengeId);
      if (failure === "application") return Response.json({ code: "INTERNAL_ERROR", requestId: challenge(50) }, { status: 500 });
      if (failure === "persistent" || proofs.length === 1) return new Response("Network connection lost.", { status: 500 });
      return Response.json({ version: 1, accountId: accounts.accounts[0].accountId, deviceId: challenge(60), token: "T".repeat(43), expiresAt: "2026-10-03T00:00:00Z" });
    }
    assert.equal(path, "/v1/auth/logout");
    assert.equal(new Headers(request?.headers).get("authorization"), "Bearer " + "T".repeat(43));
    logout++;
    return Response.json({ version: 1 });
  };
  return { fetchRequest, proofs, counts: () => ({ options, logout }) };
}
test("readiness restarts public recovery with a fresh challenge after a lost verify response", async () => {
  const mock = fixture("proxy");
  await warmLocalApi("http://127.0.0.1:8787", mock.fetchRequest);
  assert.deepEqual(mock.proofs, [challenge(1), challenge(2)]);
  assert.deepEqual(mock.counts(), { options: 2, logout: 1 });
});
test("readiness fails immediately on an application JSON 500", async () => {
  const mock = fixture("application");
  await assert.rejects(warmLocalApi("http://127.0.0.1:8787", mock.fetchRequest), /Local API warmup failed \(500\)/);
  assert.deepEqual(mock.counts(), { options: 1, logout: 0 });
});
test("readiness bounds proxy retries and cannot send public keys to a remote service", async () => {
  const mock = fixture("persistent");
  await assert.rejects(warmLocalApi("https://fotoro.cloud", mock.fetchRequest), /loopback/);
  assert.deepEqual(mock.counts(), { options: 0, logout: 0 });
  await assert.rejects(warmLocalApi("http://127.0.0.1:8787", mock.fetchRequest), /Local API proxy unavailable/);
  assert.equal(mock.counts().options, 3);
});
