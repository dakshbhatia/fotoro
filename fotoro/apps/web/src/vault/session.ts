import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  VaultV1,
  RecoveryOptionsV1,
  AccountCardV1,
  VaultWrapperV1,
} from "@fotoro/contracts";
import {
  ready,
  unb64,
  b64,
  sodium,
  wrapKey,
  unwrapKey,
  signPayload,
  utf8,
} from "@fotoro/crypto";
import { api, setFixtureAccount, fixtureMode } from "../exchange/api";
import { get, put } from "../exchange/cache";
import {
  configureVault,
  configureDevice,
  unlockVault,
  requireVault,
  lockVault,
} from "./vault";
export async function fixtureAccounts() {
  if (!fixtureMode) throw new Error("FIXTURE_DISABLED");
  return api<{
    accounts: AccountCardV1[];
    testSecrets: { accountId: string; recoverySecret: string }[];
  }>("/__fixtures/accounts");
}
async function remember(vault: VaultV1) {
  await put("settings", vault.accountCard.accountId + ":vault", vault);
  await put("settings", "last-account", vault.accountCard.accountId);
}
export async function publicTestSession(accountId: string) {
  lockVault();
  const data = await fixtureAccounts();
  setFixtureAccount(accountId);
  const vault = await api<VaultV1>("/v1/vault", undefined, "VaultV1");
  configureVault(vault);
  await unlockVault({
    kind: "recovery",
    secret: unb64(
      data.testSecrets.find((s) => s.accountId === accountId)!.recoverySecret,
    ),
  });
  await remember(vault);
}
function prfOutput(response: any): Uint8Array | undefined {
  const value = response.clientExtensionResults?.prf?.results?.first;
  return value
    ? new Uint8Array(value instanceof ArrayBuffer ? value : unb64(value))
    : undefined;
}
function publicResponse(response: any) {
  return {
    ...response,
    clientExtensionResults: {
      ...response.clientExtensionResults,
      prf: response.clientExtensionResults?.prf
        ? { enabled: response.clientExtensionResults.prf.enabled }
        : undefined,
    },
  };
}
export async function passkeyLogin() {
  setFixtureAccount();
  const known = await get<string>("settings", "last-account");
  const stored = known
    ? await get<VaultV1>("settings", known + ":vault")
    : undefined;
  const options = await api<any>("/v1/auth/login/options", {
    version: 1,
    client: "web",
    ...(known ? { accountId: known } : {}),
  });
  const evalByCredential: Record<string, { first: Uint8Array }> = {};
  for (const w of stored?.wrappers ?? []) {
    if (w.kind === "prf" && w.credentialId && w.prfSalt)
      evalByCredential[w.credentialId] = { first: unb64(w.prfSalt) };
  }
  if (Object.keys(evalByCredential).length)
    options.options.extensions = {
      ...options.options.extensions,
      prf: { evalByCredential },
    };
  const response = await startAuthentication({ optionsJSON: options.options });
  const output = prfOutput(response);
  const session = await api<any>(
    "/v1/auth/login/verify",
    {
      version: 1,
      challengeId: options.challengeId,
      response: publicResponse(response),
      client: "web",
    },
    "SessionV1",
  );
  configureDevice(session.deviceId);
  const vault = await api<VaultV1>("/v1/vault", undefined, "VaultV1");
  await remember(vault);
  configureVault(vault, output, response.id);
  if (output) await unlockVault({ kind: "prf" });
  return session;
}
export async function recover(code: string) {
  await ready;
  setFixtureAccount();
  const parts = code.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "fotoro1")
    throw new Error("INVALID_RECOVERY_CODE");
  const secret = unb64(parts[2]);
  try {
    if (!navigator.onLine) {
      const cached = await get<VaultV1>("settings", parts[1] + ":vault");
      if (!cached) throw new Error("NO_CACHED_VAULT");
      configureVault(cached);
      await unlockVault({ kind: "recovery", secret });
      return;
    }
    const options = await api<RecoveryOptionsV1>(
      "/v1/auth/recovery/options",
      { version: 1, accountId: parts[1], client: "web" },
      "RecoveryOptionsV1",
    );
    configureVault(options.vault);
    await unlockVault({ kind: "recovery", secret });
    const v = requireVault();
    const session = await api<any>(
      "/v1/auth/recovery/verify",
      {
        version: 1,
        challengeId: options.challengeId,
        client: "web",
        signedPayload: signPayload(
          "recovery-session",
          v.accountId,
          utf8({
            version: 1,
            challengeId: options.challengeId,
            challenge: options.challenge,
            accountId: v.accountId,
            client: "web",
            origin: location.origin,
          }),
          v.signingSecretKey,
        ),
      },
      "SessionV1",
    );
    configureDevice(session.deviceId);
    await remember(options.vault);
  } catch (e) {
    lockVault();
    throw e;
  } finally {
    secret.fill(0);
  }
}
let enrollment:
  | {
      options: any;
      card: AccountCardV1;
      wrapper: VaultWrapperV1;
      bundle: Uint8Array;
      recovery: Uint8Array;
      signing: Uint8Array;
      prfSalt: Uint8Array;
    }
  | undefined;
let enrollmentEpoch = 0;
export async function prepareEnrollment() {
  cancelEnrollment();
  const epoch = enrollmentEpoch;
  await ready;
  if (epoch !== enrollmentEpoch)
    throw new DOMException("Setup cancelled", "AbortError");
  setFixtureAccount();
  const options = await api<any>("/v1/auth/register/options", {
    version: 1,
    client: "web",
  });
  if (epoch !== enrollmentEpoch)
    throw new DOMException("Setup cancelled", "AbortError");
  const box = sodium.crypto_box_keypair(),
    signing = sodium.crypto_sign_keypair(),
    vault = sodium.randombytes_buf(32),
    recovery = sodium.randombytes_buf(32),
    prfSalt = sodium.randombytes_buf(32);
  const card: AccountCardV1 = {
    version: 1,
    accountId: options.accountId,
    boxPublicKey: b64(box.publicKey),
    signingPublicKey: b64(signing.publicKey),
  };
  const bundle = utf8({
    vaultKey: b64(vault),
    boxSecretKey: b64(box.privateKey),
    signingSecretKey: b64(signing.privateKey),
  });
  const wrappedBundle = wrapKey(bundle, recovery);
  const verified = unwrapKey(wrappedBundle, recovery);
  if (b64(verified) !== b64(bundle))
    throw new Error("RECOVERY_VERIFICATION_FAILED");
  verified.fill(0);
  box.privateKey.fill(0);
  vault.fill(0);
  enrollment = {
    options,
    card,
    wrapper: {
      version: 1,
      wrapperId: crypto.randomUUID(),
      kind: "recovery",
      credentialId: null,
      prfSalt: null,
      wrappedBundle,
      verified: true,
    },
    bundle,
    recovery,
    signing: signing.privateKey,
    prfSalt,
  };
  return "fotoro1." + card.accountId + "." + b64(recovery);
}
export function cancelEnrollment() {
  enrollmentEpoch++;
  if (enrollment) {
    enrollment.bundle.fill(0);
    enrollment.recovery.fill(0);
    enrollment.signing.fill(0);
    enrollment.prfSalt.fill(0);
    enrollment = undefined;
  }
}
export async function completeEnrollment(recoverySaved: boolean) {
  if (!enrollment || !recoverySaved)
    throw new Error("SAVE_RECOVERY_CODE_FIRST");
  const e = enrollment;
  try {
    e.options.options.extensions = {
      ...e.options.options.extensions,
      prf: { eval: { first: e.prfSalt } },
    };
    const response = await startRegistration({
      optionsJSON: e.options.options,
    });
    if (enrollment !== e)
      throw new DOMException("Setup cancelled", "AbortError");
    const output = prfOutput(response);
    const session = await api<any>(
      "/v1/auth/register/verify",
      {
        version: 1,
        challengeId: e.options.challengeId,
        response: publicResponse(response),
        client: "web",
        enrollment: {
          accountCard: e.card,
          recoveryWrapper: e.wrapper,
          proof: signPayload(
            "account-enrollment",
            e.card.accountId,
            utf8({ accountCard: e.card, recoveryWrapper: e.wrapper }),
            e.signing,
          ),
        },
      },
      "SessionV1",
    );
    if (enrollment !== e)
      throw new DOMException("Setup cancelled", "AbortError");
    configureDevice(session.deviceId);
    const vault: VaultV1 = {
      version: 1,
      accountCard: e.card,
      wrappers: [e.wrapper],
    };
    if (output) {
      const wrapper: VaultWrapperV1 = {
        version: 1,
        wrapperId: crypto.randomUUID(),
        kind: "prf",
        credentialId: response.id,
        prfSalt: b64(e.prfSalt),
        wrappedBundle: wrapKey(e.bundle, output),
        verified: false,
      };
      await api(
        "/v1/vault/wrappers/" + wrapper.wrapperId,
        wrapper,
        "VaultWrapperV1",
        "PUT",
      );
      vault.wrappers.push(wrapper);
      output.fill(0);
    }
    configureVault(vault);
    await unlockVault({ kind: "recovery", secret: e.recovery });
    await remember(vault);
  } finally {
    if (enrollment === e) cancelEnrollment();
  }
}
