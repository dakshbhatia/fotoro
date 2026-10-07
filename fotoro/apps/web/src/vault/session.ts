import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
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
import { api, ApiError, ApiTransportError, setFixtureAccount, fixtureMode } from "../exchange/api";
import { get, put, clearAccount } from "../exchange/cache";
import {
  configureVault,
  configureDevice,
  unlockVault,
  requireVault,
  lockVault,
  vaultGeneration,
} from "./vault";
import { formatFotoroPassword, parseFotoroPassword } from "./password";
let browserSignOut: AbortController | undefined;
function cancelBrowserSignOut() {browserSignOut?.abort(); browserSignOut = undefined;}
export async function clearBrowserSession(session = requireVault()): Promise<{remote: Promise<boolean>; generation: number}> {
  if (requireVault() !== session) throw new Error("VAULT_LOCKED");
  cancelBrowserSignOut();
  lockVault();
  const generation = vaultGeneration(), controller = new AbortController();
  browserSignOut = controller;
  // Local erasure must finish even if the session expired or the network never answers.
  const remote = (fixtureMode ? Promise.resolve(true) : api("/v1/auth/logout", {}, undefined, "POST", controller.signal).then(() => true, () => false))
    .finally(() => {if (browserSignOut === controller) browserSignOut = undefined;});
  setFixtureAccount();
  await clearAccount(session.accountId);
  return {remote, generation};
}
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
  cancelBrowserSignOut();
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
export async function passkeyLogin(current = () => true) {
  cancelBrowserSignOut();
  setFixtureAccount();
  let generation = vaultGeneration();
  const origin = location.origin;
  let opened: ReturnType<typeof requireVault> | undefined;
  const checkCurrent = () => {
    if (!current() || vaultGeneration() !== generation || location.origin !== origin)
      throw new DOMException("Sign-in cancelled", "AbortError");
  };
  checkCurrent();
  const options = await api<any>("/v1/auth/login/options", {
    version: 1,
    client: "web",
  });
  checkCurrent();
  if (options.options.allowCredentials?.length === 0)
    throw new Error("NO_ACCOUNT_PASSKEY");
  // Discoverable authentication cannot use evalByCredential without an
  // explicit allowed list. Learn the selected account before requesting PRF.
  const response = await startAuthentication({ optionsJSON: options.options });
  let output: Uint8Array | undefined;
  try {
    checkCurrent();
    let session = await api<SessionV1>(
      "/v1/auth/login/verify",
      {
        version: 1,
        challengeId: options.challengeId,
        response: publicResponse(response),
        client: "web",
      },
      "SessionV1",
    );
    checkCurrent();
    configureDevice(session.deviceId);
    const vault = await api<VaultV1>("/v1/vault", undefined, "VaultV1");
    checkCurrent();
    if (vault.accountCard.accountId !== session.accountId) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
    // A fresh browser only learns the encrypted wrapper's salt after sign-in.
    // Re-evaluate the selected credential rather than requiring a password when
    // that passkey can already unlock this account on another device.
    const wrapper = vault.wrappers.find(w => w.kind === "prf" && w.credentialId === response.id && w.prfSalt);
    if (!output && wrapper) {
      const next = await api<any>("/v1/auth/login/options", {version: 1, client: "web", accountId: session.accountId});
      checkCurrent();
      next.options.allowCredentials = [{type: "public-key", id: response.id}];
      next.options.extensions = {...next.options.extensions, prf: {eval: {first: unb64(wrapper.prfSalt!)}}};
      const assertion = await startAuthentication({optionsJSON: next.options});
      output = prfOutput(assertion);
      checkCurrent();
      if (assertion.id !== response.id) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
      const verified = await api<SessionV1>("/v1/auth/login/verify", {version: 1, challengeId: next.challengeId, response: publicResponse(assertion), client: "web"}, "SessionV1");
      checkCurrent();
      if (verified.accountId !== session.accountId) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
      configureDevice(verified.deviceId);
      session = verified;
    }
    if (!output || output.length !== 32 || !wrapper) throw new Error("PRF_UNAVAILABLE_USE_RECOVERY");
    configureVault(vault, output, response.id);
    opened = await unlockVault({kind: "prf"});
    if (!current() || vaultGeneration() !== generation + 1 || location.origin !== origin)
      throw new DOMException("Sign-in cancelled", "AbortError");
    generation = vaultGeneration();
    await remember(vault, () => current() && vaultGeneration() === generation && location.origin === origin);
    checkCurrent();
    return session;
  } catch (error) {
    if (opened) closeIfCurrent(opened);
    throw error;
  } finally {output?.fill(0);}
}
export async function addPasskey(current = () => true): Promise<boolean> {
  const session = requireVault(), generation = vaultGeneration(), origin = location.origin;
  const checkCurrent = () => {
    if (!current() || vaultGeneration() !== generation || location.origin !== origin || requireVault() !== session)
      throw new DOMException("Passkey setup cancelled", "AbortError");
  };
  const vault = await api<VaultV1>("/v1/vault", undefined, "VaultV1");
  checkCurrent();
  if (vault.accountCard.accountId !== session.accountId || vault.accountCard.version !== session.card.version
    || vault.accountCard.boxPublicKey !== session.card.boxPublicKey || vault.accountCard.signingPublicKey !== session.card.signingPublicKey)
    throw new Error("PASSWORD_ACCOUNT_MISMATCH");
  const recovery = vault.wrappers.find(w => w.kind === "recovery" && w.verified);
  if (!recovery) throw new Error("RECOVERY_UNAVAILABLE");
  const options = await api<any>("/v1/auth/register/options", {version: 1, client: "web", accountId: session.accountId});
  checkCurrent();
  if (options.accountId !== session.accountId) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
  const salt = sodium.randombytes_buf(32);
  options.options.extensions = {...options.options.extensions, prf: {eval: {first: salt}}};
  const response = await startRegistration({optionsJSON: options.options});
  let output = prfOutput(response);
  try {
    checkCurrent();
    const result = await api<SessionV1>("/v1/auth/register/verify", {
      version: 1, challengeId: options.challengeId, client: "web", response: publicResponse(response),
      enrollment: {version: 1, accountCard: session.card, recoveryWrapper: recovery,
        proof: signPayload("account-enrollment", session.accountId, utf8({accountCard: session.card, recoveryWrapper: recovery}), session.signingSecretKey)},
    }, "SessionV1");
    checkCurrent();
    if (result.accountId !== session.accountId) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
    configureDevice(result.deviceId);
    // Some PRF-enabled authenticators can evaluate only during assertion.
    // Use the new credential and the same salt before saving its wrapper.
    if ((!output || output.length !== 32) && response.clientExtensionResults?.prf?.enabled === true) {
      output?.fill(0); output = undefined;
      const next = await api<any>("/v1/auth/login/options", {version: 1, client: "web", accountId: session.accountId});
      checkCurrent();
      next.options.allowCredentials = [{type: "public-key", id: response.id}];
      next.options.extensions = {...next.options.extensions, prf: {eval: {first: salt}}};
      const assertion = await startAuthentication({optionsJSON: next.options});
      output = prfOutput(assertion);
      checkCurrent();
      if (assertion.id !== response.id) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
      const verified = await api<SessionV1>("/v1/auth/login/verify", {
        version: 1, challengeId: next.challengeId, response: publicResponse(assertion), client: "web",
      }, "SessionV1");
      checkCurrent();
      if (verified.accountId !== session.accountId) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
      configureDevice(verified.deviceId);
    }
    if (!output || output.length !== 32) return false;
    const bytes = utf8({vaultKey: b64(session.vaultKey), boxSecretKey: b64(session.boxSecretKey), signingSecretKey: b64(session.signingSecretKey)});
    let wrappedBundle;
    try {wrappedBundle = wrapKey(bytes, output);} finally {bytes.fill(0);}
    const wrapper: VaultWrapperV1 = {version: 1, wrapperId: crypto.randomUUID(), kind: "prf", credentialId: response.id, prfSalt: b64(salt), wrappedBundle, verified: false};
    try {
      await api("/v1/vault/wrappers/" + wrapper.wrapperId, wrapper, "VaultWrapperV1", "PUT");
    } catch {checkCurrent(); return false;}
    checkCurrent();
    await remember({...vault, wrappers: [...vault.wrappers, wrapper]}, () => current() && vaultGeneration() === generation && location.origin === origin);
    return true;
  } finally {output?.fill(0);}
}
export async function recover(code: string, current = () => true) {
  cancelBrowserSignOut();
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
    const openCached = async (required = false) => {
      checkCurrent();
      const cached = await get<VaultV1>("settings", accountId + ":vault");
      checkCurrent();
      if (!cached) {
        if (required) throw new Error("NO_CACHED_VAULT");
        return false;
      }
      if (cached.accountCard.accountId !== accountId) throw new Error("PASSWORD_ACCOUNT_MISMATCH");
      configureVault(cached);
      opened = await unlockVault({ kind: "recovery", secret });
      checkUnlock();
      return true;
    };
    if (!navigator.onLine) {
      await openCached(true);
      return;
    }
    let options: RecoveryOptionsV1;
    try {
      options = await api<RecoveryOptionsV1>(
        "/v1/auth/recovery/options",
        { version: 1, accountId, client: "web" },
        "RecoveryOptionsV1",
      );
    } catch (error) {
      checkCurrent();
      // A connected network is not proof the service is reachable. Only a failed
      // fetch can use the already protected cache; server/data rejection cannot.
      if (error instanceof ApiTransportError && await openCached()) return;
      if (error instanceof ApiError && error.code === "NOT_FOUND") throw new Error("FOTORO_PASSWORD_NOT_FOUND");
      throw error;
    }
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
  cancelBrowserSignOut();
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
