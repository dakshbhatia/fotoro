import { startAuthentication } from "@simplewebauthn/browser";
import type {
  VaultV1,
  RecoveryOptionsV1,
  AccountCardV1,
  VaultWrapperV1,
  StartOptionsV1,
  SessionV1,
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
import { api, ApiError, setFixtureAccount, fixtureMode } from "../exchange/api";
import { get, put } from "../exchange/cache";
import {
  configureVault,
  configureDevice,
  unlockVault,
  requireVault,
  lockVault,
  vaultGeneration,
} from "./vault";
import { formatFotoroPassword, parseFotoroPassword } from "./password";
export async function fixtureAccounts() {
  if (!fixtureMode) throw new Error("FIXTURE_DISABLED");
  return api<{
    accounts: AccountCardV1[];
    testSecrets: { accountId: string; recoverySecret: string }[];
  }>("/__fixtures/accounts");
}
async function remember(vault: VaultV1, current = () => true) {
  const checkCurrent = () => { if (!current()) throw new DOMException("Sign-in cancelled", "AbortError"); };
  checkCurrent();
  await put("settings", vault.accountCard.accountId + ":vault", vault);
  checkCurrent();
  await put("settings", "last-account", vault.accountCard.accountId);
  checkCurrent();
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
export async function recover(code: string, current = () => true) {
  let opened: ReturnType<typeof requireVault> | undefined;
  let generation = vaultGeneration();
  const checkCurrent = () => { if (!current() || vaultGeneration() !== generation) throw new DOMException("Sign-in cancelled", "AbortError"); };
  const checkUnlock = () => {
    if (!current() || vaultGeneration() !== generation + 1) throw new DOMException("Sign-in cancelled", "AbortError");
    generation = vaultGeneration();
  };
  await ready;
  checkCurrent();
  setFixtureAccount();
  const { accountId, secret } = parseFotoroPassword(code);
  try {
    if (!navigator.onLine) {
      const cached = await get<VaultV1>("settings", accountId + ":vault");
      checkCurrent();
      if (!cached) throw new Error("NO_CACHED_VAULT");
      if (cached.accountCard.accountId !== accountId) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
      configureVault(cached);
      opened = await unlockVault({ kind: "recovery", secret });
      checkUnlock();
      return;
    }
    const options = await api<RecoveryOptionsV1>(
      "/v1/auth/recovery/options",
      { version: 1, accountId, client: "web" },
      "RecoveryOptionsV1",
    ).catch(error => {
      if (error instanceof ApiError && error.code === "NOT_FOUND") throw new Error("FOTORO_PASSWORD_NOT_FOUND");
      throw error;
    });
    checkCurrent();
    if (options.vault.accountCard.accountId !== accountId) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
    configureVault(options.vault);
    opened = await unlockVault({ kind: "recovery", secret });
    checkUnlock();
    const v = requireVault();
    const session = await api<SessionV1>(
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
    checkCurrent();
    if (session.accountId !== accountId) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
    configureDevice(session.deviceId);
    await remember(options.vault, () => current() && vaultGeneration() === generation);
    checkCurrent();
  } catch (e) {
    if (opened) closeIfCurrent(opened);
    throw e;
  } finally {
    secret.fill(0);
  }
}
function closeIfCurrent(opened: ReturnType<typeof requireVault>) {
  try { if (requireVault() === opened) lockVault(); } catch {}
}
let enrollment:
  | {
      options: StartOptionsV1;
      card: AccountCardV1;
      wrapper: VaultWrapperV1;
      bundle: Uint8Array;
      recovery: Uint8Array;
      signing: Uint8Array;
      verificationAttempted: boolean;
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
  const options = await api<StartOptionsV1>("/v1/auth/start/options", {
    version: 1,
    client: "web",
  }, "StartOptionsV1");
  if (epoch !== enrollmentEpoch)
    throw new DOMException("Setup cancelled", "AbortError");
  const box = sodium.crypto_box_keypair(),
    signing = sodium.crypto_sign_keypair(),
    vault = sodium.randombytes_buf(32),
    recovery = sodium.randombytes_buf(32);
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
    verificationAttempted: false,
  };
  return formatFotoroPassword(card.accountId, recovery);
}
export function cancelEnrollment() {
  enrollmentEpoch++;
  if (enrollment) {
    enrollment.bundle.fill(0);
    enrollment.recovery.fill(0);
    enrollment.signing.fill(0);
    enrollment = undefined;
  }
}
export async function completeEnrollment() {
  if (!enrollment) throw new Error("ACCOUNT_SETUP_NOT_STARTED");
  const e = enrollment;
  const current = () => enrollment === e;
  // A lost response may have committed this identity and consumed its signup challenge.
  if (e.verificationAttempted) {
    try {
      await recover(formatFotoroPassword(e.card.accountId, e.recovery), current);
      if (current()) cancelEnrollment();
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "FOTORO_PASSWORD_NOT_FOUND") throw error;
      if (!current()) throw new DOMException("Setup cancelled", "AbortError");
    }
  }
  e.verificationAttempted = true;
  const generation = vaultGeneration();
  const session = await api<SessionV1>(
    "/v1/auth/start/verify",
    {
      version: 1,
      challengeId: e.options.challengeId,
      client: "web",
      enrollment: {
        version: 1,
        accountCard: e.card,
        recoveryWrapper: e.wrapper,
        proof: signPayload(
          "account-enrollment",
          e.card.accountId,
          utf8({ accountCard: e.card, recoveryWrapper: e.wrapper }),
          e.signing,
        ),
      },
      signedPayload: signPayload(
        "start-enrollment",
        e.card.accountId,
        utf8({ version: 1, challengeId: e.options.challengeId, challenge: e.options.challenge,
          accountId: e.card.accountId, client: "web", origin: location.origin }),
        e.signing,
      ),
    },
    "SessionV1",
  );
  if (!current() || vaultGeneration() !== generation) throw new DOMException("Setup cancelled", "AbortError");
  if (session.accountId !== e.card.accountId) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
  configureDevice(session.deviceId);
  const vault: VaultV1 = {
    version: 1,
    accountCard: e.card,
    wrappers: [e.wrapper],
  };
  configureVault(vault);
  const opened = await unlockVault({ kind: "recovery", secret: e.recovery });
  if (!current() || vaultGeneration() !== generation + 1) { closeIfCurrent(opened); throw new DOMException("Setup cancelled", "AbortError"); }
  try {
    await remember(vault, () => current() && vaultGeneration() === generation + 1);
    if (!current() || vaultGeneration() !== generation + 1) throw new DOMException("Setup cancelled", "AbortError");
    cancelEnrollment();
  } catch (error) {
    closeIfCurrent(opened);
    throw error;
  }
}
