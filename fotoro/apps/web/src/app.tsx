import { useEffect, useRef, useState } from "react";
import type { GrantV1 } from "@fotoro/contracts";
import { ready } from "@fotoro/crypto";
import { Library } from "./library/Library";
import { Viewer } from "./library/Viewer";
import { cachedCatalog, syncCatalog, type Photo } from "./library/catalog";
import {
  lockVault,
  requireVault,
  requestDeviceApproval,
  approveDeviceChallenge,
  unlockVault,
} from "./vault/vault";
import {
  publicTestSession,
  passkeyLogin,
  recover,
  fixtureAccounts,
  prepareEnrollment,
  completeEnrollment,
  cancelEnrollment,
} from "./vault/session";
import { fixtureMode, setFixtureAccount, api } from "./exchange/api";
import { Exchange } from "./exchange/Exchange";
import {
  stageImport,
  resumePendingImports,
  pendingImports,
  type PendingImport,
} from "./exchange/journal";
import { clearAccount } from "./exchange/cache";
const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="10" cy="10" r="7" />
    <path d="m15 15 6 6" />
  </svg>
);
const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 3v18M3 12h18" />
  </svg>
);
export default function App() {
  const [account, setAccount] = useState(""),
    [photos, setPhotos] = useState<Photo[]>([]),
    [received, setReceived] = useState<Photo[] | null>(null),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState(new Set<string>()),
    [viewer, setViewer] = useState<string | null>(null),
    [exchange, setExchange] = useState(false),
    [menu, setMenu] = useState(false),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [recovery, setRecovery] = useState(""),
    [pending, setPending] = useState<PendingImport[]>([]);
  const [recoveryNew, setRecoveryNew] = useState(""),
    [recoverySaved, setRecoverySaved] = useState(false),
    [deviceChallenge, setDeviceChallenge] = useState(""),
    [enrollmentId, setEnrollmentId] = useState(""),
    [approvalText, setApprovalText] = useState(""),
    [authenticated, setAuthenticated] = useState(false),
    [reselect, setReselect] = useState<PendingImport | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const unlocked = !!account;
  const clear = () => {
    for (const photo of [...photos, ...(received ?? [])])
      photo.metadataKey.fill(0);
    setAccount("");
    setPhotos([]);
    setReceived(null);
    setSelected(new Set());
    setViewer(null);
    setExchange(false);
    setPending([]);
  };
  useEffect(() => {
    const onLock = () => clear();
    window.addEventListener("fotoro-lock", onLock);
    return () => window.removeEventListener("fotoro-lock", onLock);
  }, [photos, received]);
  const refresh = async () => {
    setPhotos(await cachedCatalog());
    setPending(await pendingImports());
    try {
      await syncCatalog();
      setPhotos(await cachedCatalog());
      setStatus("");
    } catch (e) {
      setStatus(
        navigator.onLine
          ? (e as Error).message
          : "Offline · cached photos available after unlock",
      );
    }
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus("");
    try {
      await ready;
      await fn();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const login = async (fn: () => Promise<unknown>) =>
    run(async () => {
      await fn();
      setAuthenticated(true);
      try {
        setAccount(requireVault().accountId);
      } catch {
        throw new Error("AUTHENTICATED_USE_RECOVERY_OR_TRUSTED_DEVICE");
      }
      await refresh();
    });
  const shown = (received ?? photos).filter((p) =>
    (p.metadata.filename + " " + p.metadata.sourceDate)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const chosen = photos.filter((p) => selected.has(p.manifest.photoId));
  return (
    <>
      <main inert={viewer || exchange ? true : undefined}>
        <header>
          <h1>Fotoro</h1>
          {unlocked && (
            <button
              className="menu-button glass"
              aria-label="Account and exchanges"
              onClick={() => setMenu(!menu)}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>
          )}
        </header>
        {!unlocked ? (
          <section className="unlock">
            <h2>Unlock your library</h2>
            <button disabled={busy} onClick={() => login(passkeyLogin)}>
              Use passkey
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  setRecoveryNew(await prepareEnrollment());
                  setRecoverySaved(false);
                })
              }
            >
              Create account
            </button>
            {recoveryNew && (
              <section>
                <label>
                  Save this recovery code
                  <textarea readOnly value={recoveryNew} />
                </label>
                <p className="hint">
                  Store this code safely. The service never receives it. Without
                  PRF support, use this code or trusted-device approval after
                  reload.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={recoverySaved}
                    onChange={(e) => setRecoverySaved(e.target.checked)}
                  />
                  I saved the recovery code
                </label>
                <button
                  disabled={busy || !recoverySaved}
                  onClick={() =>
                    login(async () => {
                      await completeEnrollment(recoverySaved);
                      setRecoveryNew("");
                      setRecoverySaved(false);
                    })
                  }
                >
                  Create passkey and enroll
                </button>
                <button
                  onClick={() => {
                    cancelEnrollment();
                    setRecoveryNew("");
                  }}
                >
                  Cancel enrollment
                </button>
              </section>
            )}
            <label>
              Recovery code
              <input
                value={recovery}
                onChange={(e) => setRecovery(e.target.value)}
                type="password"
                autoComplete="off"
                placeholder="fotoro1.account.secret"
              />
            </label>
            <button
              disabled={busy || !recovery}
              onClick={() =>
                login(async () => {
                  await recover(recovery);
                  setRecovery("");
                })
              }
            >
              Use recovery code
            </button>
            <p className="hint">
              A passkey authenticates your account. Without passkey PRF,
              recovery or a trusted device is required again after reload. Photo
              caches stay encrypted while locked.
            </p>
            {authenticated && (
              <section>
                <button
                  onClick={() =>
                    run(async () => {
                      const challenge = await requestDeviceApproval();
                      setDeviceChallenge(JSON.stringify(challenge));
                      setEnrollmentId(challenge.enrollmentId);
                    })
                  }
                >
                  Request trusted-device approval
                </button>
                {deviceChallenge && (
                  <>
                    <label>
                      Send challenge to your trusted device
                      <textarea readOnly value={deviceChallenge} />
                    </label>
                    <button
                      onClick={() =>
                        login(() =>
                          unlockVault({ kind: "trustedDevice", enrollmentId }),
                        )
                      }
                    >
                      Complete approved request
                    </button>
                  </>
                )}
              </section>
            )}
            {fixtureMode && (
              <details open>
                <summary>Public test accounts · loopback fixture</summary>
                <p className="hint">
                  These accounts and their keys are public test data. Fixture
                  auth does not simulate passkey success.
                </p>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      login(() =>
                        publicTestSession(
                          "00000000-0000-4000-8000-000000000001",
                        ),
                      )
                    }
                  >
                    Open public account 1
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      login(() =>
                        publicTestSession(
                          "00000000-0000-4000-8000-000000000002",
                        ),
                      )
                    }
                  >
                    Open public account 2
                  </button>
                </div>
              </details>
            )}
          </section>
        ) : (
          <>
            {received && (
              <div className="received-bar">
                <span>Received · explicit save required</span>
                <button
                  onClick={() => {
                    setReceived(null);
                    setSelected(new Set());
                  }}
                >
                  My library
                </button>
              </div>
            )}
            {shown.length ? (
              <Library
                photos={shown}
                selected={selected}
                onSelect={(id) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    next.has(id) ? next.delete(id) : next.add(id);
                    return next;
                  })
                }
                onOpen={setViewer}
              />
            ) : (
              <div className="empty">
                <p>
                  {query
                    ? "No matching photos"
                    : received
                      ? "No received photos"
                      : "Add your first photos"}
                </p>
                {query && (
                  <button onClick={() => setQuery("")}>Clear search</button>
                )}
              </div>
            )}
            <div className="toolbar glass">
              <SearchIcon />
              <input
                aria-label="Search photos"
                placeholder="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="Clear search">
                  ×
                </button>
              )}
              <button
                onClick={() => input.current?.click()}
                aria-label="Add photos"
                disabled={busy}
              >
                <PlusIcon />
              </button>
            </div>
            {selected.size > 0 && (
              <button
                id="share-selected"
                className="share-button glass"
                onClick={() => setExchange(true)}
              >
                Share · {selected.size}
              </button>
            )}
            <input
              ref={input}
              hidden
              type="file"
              accept="image/jpeg,image/png"
              multiple
              onChange={(e) =>
                run(async () => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  for (const file of files) {
                    await stageImport(file, reselect);
                    setReselect(undefined);
                    setStatus(
                      "Ciphertext staged · keep your source until committed",
                    );
                  }
                  await resumePendingImports();
                  await refresh();
                })
              }
            />
          </>
        )}
        {status && (
          <p className="status" role="status">
            {status}
          </p>
        )}
        {busy && (
          <p className="busy" role="status">
            Working…
          </p>
        )}
        {menu && unlocked && (
          <aside className="account-sheet sheet">
            <button
              className="close"
              aria-label="Close account"
              onClick={() => setMenu(false)}
            >
              ×
            </button>
            <h2>Library</h2>
            <p className="hint">
              {fixtureMode ? "Public test account · " : ""}
              {account}
            </p>
            <div className="actions">
              <button
                onClick={() => {
                  setExchange(true);
                  setMenu(false);
                }}
              >
                Exchanges
              </button>
              <button disabled={busy} onClick={() => run(refresh)}>
                Sync
              </button>
              <button
                onClick={() => {
                  lockVault();
                  setMenu(false);
                }}
              >
                Lock
              </button>
            </div>
            <label>
              Your account card
              <textarea readOnly value={JSON.stringify(requireVault().card)} />
            </label>
            <p className="hint">
              Send this card through a trusted channel. Compare the complete
              keys before pinning a received card.
            </p>
            {fixtureMode && (
              <button
                onClick={() =>
                  run(async () => {
                    const data = await fixtureAccounts();
                    const card = data.accounts.find(
                      (c) => c.accountId !== account,
                    )!;
                    await navigator.clipboard.writeText(JSON.stringify(card));
                    setStatus(
                      "Other public test card copied · pin explicitly in Exchanges",
                    );
                  })
                }
              >
                Copy other public test account card
              </button>
            )}
            <button
              onClick={() =>
                run(async () => {
                  const challenge = await requestDeviceApproval();
                  setStatus("Approval requested · " + challenge.enrollmentId);
                })
              }
            >
              Request trusted-device approval
            </button>
            <label>
              Device challenge from your other device
              <textarea
                value={approvalText}
                onChange={(e) => setApprovalText(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !approvalText}
              onClick={() =>
                run(async () => {
                  await approveDeviceChallenge(approvalText);
                  setApprovalText("");
                  setStatus("Device approved");
                })
              }
            >
              Approve device challenge
            </button>
            <h3>Pending imports</h3>
            <p className="hint">
              JPEG/PNG originals only, up to 50 MiB. Keep source files until
              commit. Browser storage may be evicted.
            </p>
            {pending.length === 0 ? (
              <p>No pending imports</p>
            ) : (
              pending.map((p) => (
                <p key={p.operationId}>
                  {p.sourceFilename} · {p.state}
                  {p.error ? " · " + p.error : ""}
                  {p.error === "STAGING_MISSING_RESELECT_ORIGINAL" && (
                    <button
                      onClick={() => {
                        setReselect(p);
                        input.current?.click();
                      }}
                    >
                      Re-select matching original
                    </button>
                  )}
                </p>
              ))
            )}
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await resumePendingImports();
                  await refresh();
                })
              }
            >
              Retry pending imports
            </button>
            <button
              onClick={() =>
                run(async () => {
                  if (
                    pending.some((p) => p.state !== "committed") &&
                    !window.confirm(
                      "Unsent imports will be removed from this browser. Keep your source files. Sign out?",
                    )
                  )
                    return;
                  if (!fixtureMode) await api("/v1/auth/logout", {});
                  await clearAccount(account);
                  setAuthenticated(false);
                  setFixtureAccount();
                  lockVault();
                  setMenu(false);
                })
              }
            >
              Sign out and clear this browser
            </button>
          </aside>
        )}
      </main>
      {exchange && unlocked && (
        <Exchange
          selection={chosen}
          onClose={() => {
            setExchange(false);
            requestAnimationFrame(() =>
              document.getElementById("share-selected")?.focus(),
            );
          }}
          onRefresh={() => run(refresh)}
          onReceived={(items: Photo[], _grant: GrantV1) => {
            setReceived(items);
            setExchange(false);
            setSelected(new Set());
          }}
        />
      )}
      {viewer && unlocked && (
        <Viewer
          photos={shown}
          initial={viewer}
          onSaved={() => run(refresh)}
          onClose={() => {
            const id = viewer;
            setViewer(null);
            requestAnimationFrame(() =>
              document
                .getElementById("photo-" + id)
                ?.focus({ preventScroll: true }),
            );
          }}
        />
      )}
    </>
  );
}
