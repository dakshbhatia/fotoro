import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  fixtureMode,
  setFixtureAccount,
  api,
  isPublicDemoAccount,
} from "./exchange/api";
import { Exchange } from "./exchange/Exchange";
import {
  stageImport,
  resumePendingImports,
  pendingImports,
  type PendingImport,
} from "./exchange/journal";
import {
  refreshSync,
  lastSync,
  syncStatus,
  sameVault,
  readableSyncError,
  pauseSync,
  skippedImports,
  recordSkipped,
  clearSkipped,
} from "./exchange/sync";
import { syncSelectedSequential } from "./exchange/selected";
import { clearAccount } from "./exchange/cache";
import { localOriginalDigest, queueAnnotations, queueLocalAnnotations, pendingAnnotations, resolveAnnotationConflict, type PendingAnnotation } from "./exchange/annotations";
import { PhotoSearchIndex, normalizeSearch } from "./local/search";
import type { LocalPhoto } from "./local/resources";
import { cloudSearchRecords } from "./library/search";
const noLocalPhotos: LocalPhoto[] = [];
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
export default function CloudApp({
  onBack,
  localPhotos = noLocalPhotos,
  active = true,
}: {
  onBack: () => void;
  localPhotos?: LocalPhoto[];
  active?: boolean;
}) {
  const [account, setAccount] = useState(() => {
      try {
        return requireVault().accountId;
      } catch {
        return "";
      }
    }),
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
  const [authStep, setAuthStep] = useState<
      "welcome" | "recovery" | "newRecovery"
    >("welcome"),
    [lastSuccessfulSync, setLastSuccessfulSync] = useState<string | null>(null),
    [staging, setStaging] = useState(0),
    [skipped, setSkipped] = useState(0),
    [paused, setPaused] = useState(false),
    [pickedFiles, setPickedFiles] = useState<File[]>([]),
    [needsAttention, setNeedsAttention] = useState(false),
    [annotationPending, setAnnotationPending] = useState<PendingAnnotation[]>([]),
    [committedMeaning, setCommittedMeaning] = useState<string>();
  const running = useRef(false),
    pausedRef = useRef(false),
    uploadAbort = useRef<AbortController | null>(null),
    localSynced = useRef(new WeakMap<File, string>());
  const input = useRef<HTMLInputElement>(null);
  const localPhotosRef = useRef(localPhotos);
  localPhotosRef.current = localPhotos;
  const allLocalFiles = [...new Set([...localPhotos.flatMap(photo => photo.file ? [photo.file] : []), ...pickedFiles])];
  const unlocked = !!account;
  const publicDemo = fixtureMode || isPublicDemoAccount(account);
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
    setAnnotationPending([]);
    setCommittedMeaning(undefined);
    setQuery("");
    setLastSuccessfulSync(null);
    setStaging(0);
    setStatus("");
    setNeedsAttention(false);
    setSkipped(0);
    pausedRef.current = true;
    setPaused(true);
    uploadAbort.current?.abort();
  };
  useEffect(() => {
    let observed: ReturnType<typeof requireVault> | undefined;
    try {
      observed = requireVault();
    } catch {}
    const onLock = () => {
      if (observed) pauseSync(observed);
      clear();
    };
    window.addEventListener("fotoro-lock", onLock);
    return () => window.removeEventListener("fotoro-lock", onLock);
  }, [photos, received]);
  const refresh = async () => {
    const session = requireVault();
    const cached = await cachedCatalog();
    if (!sameVault(session)) return;
    setPhotos((previous) => (sameVault(session) ? cached : previous));
    const imports = await pendingImports();
    if (!sameVault(session)) return;
    setPending((previous) => (sameVault(session) ? imports : previous));
    const edits = await pendingAnnotations(session);
    if (!sameVault(session)) return;
    setAnnotationPending(edits);
    const previous = await lastSync(session);
    if (!sameVault(session)) return;
    setLastSuccessfulSync((value) => (sameVault(session) ? previous : value));
    const skip = await skippedImports(session);
    if (!sameVault(session)) return;
    setSkipped((value) => (sameVault(session) ? skip : value));
    if (pausedRef.current) {
      setStatus("Sync is paused. Retry when you’re ready.");
      return;
    }
    if (!navigator.onLine) {
      setStatus(
        "Offline · your cached photos are available. Sync will resume when online.",
      );
      return;
    }
    const result = await refreshSync(session);
    if (!sameVault(session)) return;
    setPhotos((previous) => (sameVault(session) ? result.photos : previous));
    setPending((previous) => (sameVault(session) ? result.pending : previous));
    setSkipped((previous) => (sameVault(session) ? result.skipped : previous));
    setAnnotationPending(result.annotations);
    setLastSuccessfulSync((previous) =>
      sameVault(session) ? result.lastSuccessfulSync : previous,
    );
    setStatus((previous) => (sameVault(session) ? "" : previous));
    setNeedsAttention((previous) => (sameVault(session) ? false : previous));
  };
  const run = async (fn: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setStatus("");
    let session;
    try {
      session = requireVault();
    } catch {}
    try {
      await ready;
      await fn();
    } catch (e) {
      if (!session || sameVault(session)) {
        setStatus(readableSyncError(e));
        setNeedsAttention(true);
      }
      if (session && sameVault(session)) {
        const queue = await pendingImports();
        const edits = await pendingAnnotations(session);
        if (sameVault(session)) setAnnotationPending(edits);
        if (sameVault(session))
          setPending((previous) => (sameVault(session) ? queue : previous));
      }
    } finally {
      if (uploadAbort.current?.signal.aborted) {
        uploadAbort.current = null;
        setStaging(0);
      }
      running.current = false;
      setBusy(false);
    }
  };
  const login = async (fn: () => Promise<unknown>) =>
    run(async () => {
      await fn();
      setAuthenticated(true);
      pausedRef.current = false;
      setPaused(false);
      try {
        setAccount(requireVault().accountId);
        setAuthStep("welcome");
      } catch {
        setAuthStep("recovery");
        setStatus(
          "Use your saved recovery code to unlock photos on this device.",
        );
        return;
      }
      await refresh();
    });
  useEffect(() => {
    if (!account || !active) return;
    const update = () => {
      if (document.visibilityState === "visible" && !pausedRef.current)
        void run(refresh);
    };
    update();
    window.addEventListener("online", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("online", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [account, active]);
  const syncLocal = () =>
    run(async () => {
      const session = requireVault();
      if (publicDemo) throw new Error("PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED");
      pausedRef.current = false;
      setPaused(false);
      const controller = new AbortController();
      uploadAbort.current = controller;
      let failures = 0;
      const candidates = allLocalFiles.filter(
        (file) => localSynced.current.get(file) !== session.accountId,
      );
      try {
        const result = await syncSelectedSequential(candidates, {
          current: () => sameVault(session),
          signal: controller.signal,
          stage: async (file) => {
            setStaging((value) => (sameVault(session) ? 1 : value));
            const source = localPhotosRef.current.find(photo => photo.file === file);
            const existing = source?.digest ? photos.find(photo => photo.metadata.originalSha256 === localOriginalDigest(source)) : undefined;
            const staged = existing ? undefined : await stageImport(file, undefined, controller.signal);
            if (source && (staged || existing)) {
              const photoId = existing?.manifest.photoId ?? staged!.photoId;
              const originalSha256 = existing?.metadata.originalSha256 ?? staged!.sourceDigest;
              await queueLocalAnnotations({ownerAccountId: session.accountId, photoId, originalSha256}, source, session);
            }
            if (!sameVault(session)) throw new Error("VAULT_LOCKED");
            localSynced.current.set(file, session.accountId);
            await clearSkipped(session, file);
            setStaging((value) => (sameVault(session) ? 0 : value));
          },
          drain: async () => {
            await refresh();
          },
          unresolved: async () => {
            const queue = await pendingImports();
            if (!sameVault(session)) throw new Error("VAULT_LOCKED");
            return queue.some((item) => item.state !== "committed");
          },
          skipped: async (file, error) => {
            failures++;
            await recordSkipped(session, file, error);
            if (sameVault(session)) setStatus(readableSyncError(error));
          },
        });
        if (sameVault(session) && result.stopped)
          setStatus(
            "A photo still needs to sync. Retry it before adding more photos.",
          );
        else if (sameVault(session) && failures)
          setStatus(
            `${failures} photos could not be prepared. Your local originals are unchanged.`,
          );
      } finally {
        if (uploadAbort.current === controller) uploadAbort.current = null;
        if (sameVault(session)) setStaging(0);
      }
    });
  const summary = syncStatus(
    pending,
    lastSuccessfulSync,
    skipped,
    allLocalFiles.filter((file) => localSynced.current.get(file) !== account)
      .length,
  );
  const pause = () => {
    pausedRef.current = true;
    setPaused(true);
    uploadAbort.current?.abort();
    try {
      pauseSync();
    } catch {}
    setStatus("Pausing sync. Your originals are unchanged.");
  };
  const retry = () =>
    run(async () => {
      pausedRef.current = false;
      setPaused(false);
      await refresh();
    });
  const localCount = allLocalFiles.filter(
    (file) => localSynced.current.get(file) !== account,
  ).length;
  const searchable = received ?? photos;
  const index = useMemo(() => new PhotoSearchIndex(cloudSearchRecords(searchable)), [searchable]);
  const searchResult = useMemo(() => index.search(query, {scope: "account:" + account, committedMeaning}), [index, query, account, committedMeaning]);
  const shown = normalizeSearch(query) ? searchResult.photoIds.flatMap(id => {const photo = searchable.find(photo => photo.manifest.photoId === id); return photo ? [photo] : [];}) : searchable;
  const editLabels = async (photo: Photo, labels: string[]) => {
    const session = requireVault();
    try {
      await queueAnnotations({ownerAccountId: photo.manifest.ownerAccountId, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256}, {labels}, session);
      if (!sameVault(session)) return;
      const cached = await cachedCatalog();
      if (!sameVault(session)) return;
      setPhotos(cached);
      setAnnotationPending(await pendingAnnotations(session));
    } catch (error) {if (sameVault(session)) {setStatus(readableSyncError(error)); setNeedsAttention(true);}}
  };
  useEffect(() => {
    if (!account || publicDemo) return;
    const session = requireVault();
    let alive = true;
    void (async () => {
      let changed = false;
      for (const photo of photos) {
        const local = localPhotos.find(source => localOriginalDigest(source) === photo.metadata.originalSha256);
        if (!local) continue;
        changed = await queueLocalAnnotations({ownerAccountId: session.accountId, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256}, local, session, false) || changed;
      }
      if (!alive || !sameVault(session) || !changed) return;
      const cached = await cachedCatalog();
      if (!alive || !sameVault(session)) return;
      const edits = await pendingAnnotations(session);
      if (!alive || !sameVault(session)) return;
      setPhotos(cached);
      setAnnotationPending(edits);
    })().catch(error => {if (alive && sameVault(session)) {setStatus(readableSyncError(error)); setNeedsAttention(true);}});
    return () => {alive = false;};
  }, [account, localPhotos, photos, publicDemo]);
  useEffect(() => {
    if (!account || !active || busy || paused || needsAttention || !annotationPending.some(edit => !edit.conflict)) return;
    const timeout = setTimeout(() => {
      if (navigator.onLine && !running.current && !pausedRef.current) void run(refresh);
    }, 1000);
    return () => clearTimeout(timeout);
  }, [account, active, busy, paused, needsAttention, annotationPending]);
  const chosen = photos.filter((p) => selected.has(p.manifest.photoId));
  return (
    <>
      <main inert={viewer || exchange ? true : undefined}>
        <header>
          <h1>Fotoro</h1>
          <button
            onClick={() => {
              if (!account) {
                cancelEnrollment();
                setRecoveryNew("");
                setAuthStep("welcome");
              }
              onBack();
            }}
          >
            Local photos
          </button>
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
          <section className="unlock sync-onboarding">
            <h2>Sync photos</h2>
            <p className="hint">
              Use one account on your iPhone and browser. Your local photos stay
              private until you choose to sync them.
            </p>
            {authStep === "welcome" && (
              <>
                <button
                  className="primary-action"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      setRecoveryNew(await prepareEnrollment());
                      setRecoverySaved(false);
                      setAuthStep("newRecovery");
                    })
                  }
                >
                  Create account
                </button>
                <button disabled={busy} onClick={() => login(passkeyLogin)}>
                  Sign in
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setAuthStep("recovery")}
                >
                  Use a recovery code
                </button>
              </>
            )}
            {authStep === "newRecovery" && (
              <>
                <h3>Save your recovery code</h3>
                <p className="hint">
                  Keep this code somewhere safe. It unlocks your photos on
                  another device if your passkey cannot. Fotoro never receives
                  the code.
                </p>
                <textarea
                  readOnly
                  aria-label="Your recovery code"
                  value={recoveryNew}
                />
                <label className="local-check">
                  <input
                    type="checkbox"
                    checked={recoverySaved}
                    onChange={(event) => setRecoverySaved(event.target.checked)}
                  />
                  I saved my recovery code
                </label>
                <button
                  disabled={busy || !recoverySaved}
                  onClick={() =>
                    login(async () => {
                      try {
                        await completeEnrollment(recoverySaved);
                        setRecoveryNew("");
                        setRecoverySaved(false);
                      } catch (error) {
                        setAuthStep("welcome");
                        setRecoveryNew("");
                        throw error;
                      }
                    })
                  }
                >
                  Continue
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    cancelEnrollment();
                    setRecoveryNew("");
                    setAuthStep("welcome");
                  }}
                >
                  Cancel
                </button>
              </>
            )}
            {authStep === "recovery" && (
              <>
                <h3>Unlock photos on this device</h3>
                <p className="hint">
                  Enter the recovery code you saved when creating your account.
                  This opens the same encrypted library as your iPhone.
                </p>
                <label>
                  Recovery code
                  <input
                    value={recovery}
                    onChange={(event) => setRecovery(event.target.value)}
                    type="password"
                    autoComplete="off"
                    placeholder="Paste your saved code"
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
                  Continue
                </button>
                <button disabled={busy} onClick={() => setAuthStep("welcome")}>
                  Back
                </button>
              </>
            )}
            {fixtureMode && (
              <details>
                <summary>Advanced DEBUG</summary>
                <p className="hint">
                  Public test accounts only. These accounts are not private and
                  do not simulate passkey success.
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    login(() =>
                      publicTestSession("00000000-0000-4000-8000-000000000001"),
                    )
                  }
                >
                  Open public account 1
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    login(() =>
                      publicTestSession("00000000-0000-4000-8000-000000000002"),
                    )
                  }
                >
                  Open public account 2
                </button>
              </details>
            )}
          </section>
        ) : (
          <>
            {publicDemo && (
              <p className="demo-notice hint">
                Public demo account — create a private account to sync your
                photos. Pending uploads are kept here but will not be sent.
              </p>
            )}
            {localCount > 0 && !received && (
              <button
                className="sync-local-button"
                disabled={busy || publicDemo}
                onClick={syncLocal}
              >
                Sync selected photos · {localCount}
              </button>
            )}
            {annotationPending.some(edit => edit.conflict) && !received && <button className="sync-local-button" onClick={() => setMenu(true)}>Review photo edits</button>}
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
            {normalizeSearch(query) && searchResult.meanings.length > 0 && (
              <div className="cloud-search-meanings local-labels glass">
                {searchResult.meanings.map(meaning => <button key={meaning.id} aria-pressed={meaning.id === searchResult.meaning?.id} onClick={() => setCommittedMeaning(meaning.id)}>{meaning.term} · {meaning.photoIds.length}</button>)}
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
                onChange={(e) => {setQuery(e.target.value); setCommittedMeaning(undefined);}}
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="Clear search">
                  ×
                </button>
              )}
              <button
                onClick={() => input.current?.click()}
                aria-label="Add photos"
                disabled={busy || publicDemo}
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
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (!files.length) return;
                if (reselect) {
                  void run(async () => {
                    if (publicDemo)
                      throw new Error("PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED");
                    await stageImport(files[0], reselect);
                    setReselect(undefined);
                    pausedRef.current = false;
                    setPaused(false);
                    await refresh();
                  });
                  return;
                }
                setPickedFiles((current) => [
                  ...new Set([...current, ...files]),
                ]);
                setMenu(true);
              }}
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
            <h2>Sync photos</h2>
            <p className="hint">
              Originals, labels and photo text are encrypted. Keep this browser open while syncing.
            </p>
            <p role="status">
              {paused
                ? "Paused"
                : needsAttention
                  ? "Sync needs attention"
                  : staging
                    ? "Preparing one photo…"
                    : busy
                      ? "Checking photos…"
                      : annotationPending.some(edit => edit.conflict)
                        ? "Review label or text changes"
                        : annotationPending.length
                          ? `${annotationPending.length} photo edits pending`
                          : summary.label}
            </p>
            <p className="hint">
              Browser uploads: {summary.synced} synced · {summary.pending}{" "}
              pending · {summary.failed} failed · {summary.skipped} skipped
            </p>
            <p className="hint">
              {lastSuccessfulSync
                ? "Last checked " +
                  new Date(lastSuccessfulSync).toLocaleString()
                : "Not checked yet"}
            </p>
            {localCount > 0 && (
              <>
                <button disabled={busy || publicDemo} onClick={syncLocal}>
                  Sync selected photos · {localCount}
                </button>
                <p className="hint">
                  Only these selected files will be encrypted and uploaded.
                  Originals stay unchanged. Browser imports support JPEG and
                  PNG; HEIC photos synced from iPhone use JPEG previews here.
                </p>
              </>
            )}
            <p className="hint">
              {publicDemo
                ? "Public demo account — private uploads disabled"
                : "Encrypted library"}
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
              <button disabled={busy} onClick={retry}>
                {paused ? "Resume sync" : "Sync now"}
              </button>
              {busy && <button onClick={pause}>Pause</button>}
              <button
                onClick={() => {
                  lockVault();
                  setMenu(false);
                }}
              >
                Lock
              </button>
            </div>
            <details>
              <summary>Sharing & device options</summary>
              <label>
                Your account card
                <textarea
                  readOnly
                  value={JSON.stringify(requireVault().card)}
                />
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
            </details>
            {annotationPending.length > 0 && <details open={annotationPending.some(edit => edit.conflict)}>
              <summary>Labels and photo text · {annotationPending.length} pending</summary>
              {annotationPending.map(edit => <div key={edit.photoId}>
                <p>{photos.find(photo => photo.manifest.photoId === edit.photoId)?.metadata.filename ?? "Photo"} · {edit.conflict ? "Changed on another device" : "Waiting to sync"}</p>
                {edit.conflict && <>
                  <p className="hint">Your pending edits are kept here. Choose which changes to keep.</p>
                  <div className="actions"><button disabled={busy} onClick={() => run(async () => {await resolveAnnotationConflict(edit.photoId, "local"); await refresh();})}>Use my edits</button><button disabled={busy} onClick={() => run(async () => {await resolveAnnotationConflict(edit.photoId, "remote"); await refresh();})}>Keep synced edits</button></div>
                </>}
              </div>)}
            </details>}
            <details open={summary.pending > 0 || summary.failed > 0}>
              <summary>Photo status</summary>
              <p className="hint">
                Keep your original files until they are synced.
              </p>
              {pending.length === 0 ? (
                <p>No pending imports</p>
              ) : (
                pending.map((p) => (
                  <p key={p.operationId}>
                    {p.sourceFilename} ·{" "}
                    {p.state === "committed"
                      ? "Synced"
                      : p.state === "failed"
                        ? "Failed"
                        : "Pending"}
                    {p.error
                      ? " · " + readableSyncError(new Error(p.error))
                      : ""}
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
            </details>
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
          onLabels={!received && !publicDemo ? (photo, labels) => {void editLabels(photo, labels);} : undefined}
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
