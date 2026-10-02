import { pathToFileURL } from "node:url";
import accounts from "../fixtures/accounts.json";
import { validateWire } from "../packages/contracts/src/validate.js";
import type { RecoveryOptionsV1, SessionV1 } from "../packages/contracts/src/models.js";
import { ready, signPayload, unb64, utf8 } from "../packages/crypto/src/index.js";

class LocalTransportFailure extends Error {}

export async function warmLocalApi(base = "http://127.0.0.1:8787", fetchRequest: typeof fetch = fetch) {
  const url = new URL(base);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("API warmup requires a loopback origin with public test keys");
  }
  await ready;
  const origin = "http://localhost:4310";
  async function post(path: string, body: unknown, token?: string) {
    let response: Response;
    let text: string;
    try {
      response = await fetchRequest(new URL(path, url), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { origin, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      text = await response.text();
    } catch { throw new LocalTransportFailure("Local API transport unavailable"); }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch {
      if (response.status >= 500) throw new LocalTransportFailure("Local API proxy unavailable");
      throw new Error("Local API warmup returned an invalid response");
    }
    // Application errors must stay visible; only the dev proxy's non-JSON 5xx can be retried.
    if (response.status !== 200) throw new Error(`Local API warmup failed (${response.status})`);
    return value;
  }
  const secret = accounts.testSecrets[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // A lost verification response may have consumed the proof: never replay the same ceremony.
      const options = validateWire<RecoveryOptionsV1>("RecoveryOptionsV1", await post("/v1/auth/recovery/options", {
        version: 1, accountId: secret.accountId, client: "native",
      }));
      const proof = {
        version: 1, challengeId: options.challengeId, challenge: options.challenge,
        accountId: secret.accountId, client: "native", origin,
      };
      const session = validateWire<SessionV1>("SessionV1", await post("/v1/auth/recovery/verify", {
        version: 1, challengeId: options.challengeId, client: "native",
        signedPayload: signPayload("recovery-session", secret.accountId, utf8(proof), unb64(secret.signingSecretKey)),
      }));
      if (!session.token || session.accountId !== secret.accountId) throw new Error("Local API warmup session mismatch");
      await post("/v1/auth/logout", { version: 1 }, session.token);
      return;
    } catch (error) {
      if (!(error instanceof LocalTransportFailure) || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await warmLocalApi();
  console.log("Local API recovery readiness verified");
}
