import { it, expect } from "vitest";
import { actors, seed, http, signed } from "./helpers";
import { b64, unb64, utf8 } from "../src/errors";
import cards from "../../../fixtures/accounts.json";
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let n = 0;
  for (const p of parts) {
    out.set(p, n);
    n += p.length;
  }
  return out;
};
function cbor(v: any): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24
      ? new Uint8Array([major * 32 + n])
      : n < 256
        ? new Uint8Array([major * 32 + 24, n])
        : new Uint8Array([major * 32 + 25, n >> 8, n & 255]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const bytes = new TextEncoder().encode(v);
    return concat(head(3, bytes.length), bytes);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (v instanceof Map)
    return concat(
      head(5, v.size),
      ...Array.from(v).flatMap(([k, x]) => [cbor(k), cbor(x)]),
    );
  throw Error("unsupported CBOR");
}
const digest = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
function der(raw: Uint8Array) {
  const integer = (b: Uint8Array) => {
    let start = 0;
    while (start < b.length - 1 && b[start] === 0) start++;
    b = b.slice(start);
    if (b[0] & 128) b = concat(new Uint8Array([0]), b);
    return concat(new Uint8Array([2, b.length]), b);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(new Uint8Array([48, body.length]), body);
}
it("SimpleWebAuthn verifies real P256 passkey registration/login, rejects RP swap and challenge replay", async () => {
  await seed();
  const opts = (await (
    await http(0, "/v1/auth/register/options", "POST", {
      version: 1,
      accountId: actors[0].accountId,
      client: "native",
    })
  ).json()) as any;
  const key = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ),
    jwk = await crypto.subtle.exportKey("jwk", key.publicKey),
    credential = crypto.getRandomValues(new Uint8Array(32));
  const cose = cbor(
    new Map<any, any>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, unb64(jwk.x!)],
      [-3, unb64(jwk.y!)],
    ]),
  );
  const rp = await digest(new TextEncoder().encode("localhost")),
    authData = concat(
      rp,
      new Uint8Array([0x45, 0, 0, 0, 0]),
      new Uint8Array(16),
      new Uint8Array([0, 32]),
      credential,
      cose,
    );
  const clientData = b64(
    utf8({
      type: "webauthn.create",
      challenge: opts.options.challenge,
      origin: "http://localhost:4310",
      crossOrigin: false,
    }),
  );
  const response = {
    id: b64(credential),
    rawId: b64(credential),
    type: "public-key",
    response: {
      clientDataJSON: clientData,
      attestationObject: b64(
        cbor(
          new Map<any, any>([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", authData],
          ]),
        ),
      ),
      transports: ["internal"],
    },
    clientExtensionResults: {},
  };
  const wrapper = {
      version: 1,
      wrapperId: crypto.randomUUID(),
      kind: "recovery",
      credentialId: null,
      prfSalt: null,
      wrappedBundle: cards.testSecrets[0].encryptedBundle,
      verified: true,
    },
    enrollment = {
      version: 1,
      accountCard: cards.accounts[0],
      recoveryWrapper: wrapper,
      proof: await signed(0, "account-enrollment", {
        accountCard: cards.accounts[0],
        recoveryWrapper: wrapper,
      }),
    };
  const registration = {
    version: 1,
    challengeId: opts.challengeId,
    client: "native",
    response,
    enrollment,
  };
  const registered = await http(
    0,
    "/v1/auth/register/verify",
    "POST",
    registration,
  );
  expect(registered.status).toBe(200);
  expect(((await registered.json()) as any).token).toBeTypeOf("string");
  expect(
    (await http(0, "/v1/auth/register/verify", "POST", registration)).status,
  ).toBe(403);
  const login = (await (
    await http(0, "/v1/auth/login/options", "POST", {
      version: 1,
      accountId: actors[0].accountId,
      client: "web",
    })
  ).json()) as any;
  const assertionData = utf8({
      type: "webauthn.get",
      challenge: login.options.challenge,
      origin: "http://localhost:4310",
      crossOrigin: false,
    }),
    assertionAuth = concat(rp, new Uint8Array([5, 0, 0, 0, 1]));
  const signature = der(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key.privateKey,
        concat(assertionAuth, await digest(assertionData)),
      ),
    ),
  );
  const assertion = {
    id: b64(credential),
    rawId: b64(credential),
    type: "public-key",
    response: {
      clientDataJSON: b64(assertionData),
      authenticatorData: b64(assertionAuth),
      signature: b64(signature),
      userHandle: b64(new TextEncoder().encode(actors[0].accountId)),
    },
    clientExtensionResults: {},
  };
  const wrongRp = concat(
    await digest(new TextEncoder().encode("evil.invalid")),
    new Uint8Array([5, 0, 0, 0, 1]),
  );
  const wrongSignature = der(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key.privateKey,
        concat(wrongRp, await digest(assertionData)),
      ),
    ),
  );
  expect(
    (
      await http(0, "/v1/auth/login/verify", "POST", {
        version: 1,
        challengeId: login.challengeId,
        client: "web",
        response: {
          ...assertion,
          response: {
            ...assertion.response,
            authenticatorData: b64(wrongRp),
            signature: b64(wrongSignature),
          },
        },
      })
    ).status,
  ).toBe(403);
  const verified = await http(0, "/v1/auth/login/verify", "POST", {
    version: 1,
    challengeId: login.challengeId,
    client: "web",
    response: assertion,
  });
  expect(verified.status).toBe(200);
  expect(verified.headers.get("set-cookie")).toContain(
    "HttpOnly; Secure; SameSite=Strict",
  );
  expect(((await verified.json()) as any).token).toBeUndefined();
  expect(
    (
      await http(0, "/v1/auth/login/verify", "POST", {
        version: 1,
        challengeId: login.challengeId,
        client: "web",
        response: assertion,
      })
    ).status,
  ).toBe(403);
});
