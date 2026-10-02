import { useEffect, useMemo, useRef, useState } from "react";
import type { GrantV1 } from "@fotoro/contracts";
import { ready } from "@fotoro/crypto";
import { Library } from "./library/Library";
import { Viewer } from "./library/Viewer";
import { cachedCatalog, photoBytes, type Photo } from "./library/catalog";
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
import {deriveConsumerSyncSummary, syncStateLabel, type ConsumerSyncSummary} from "./library/consumer-sync";
import {loadUploadPause, saveUploadPause} from "./library/consumer-preferences";
import type {OwnedPhotoSnapshot} from "./library/consumer-search";
import {useDialogFocus} from "./library/dialog-focus";
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
  onSyncSummary,
  onOwnedPhotos,
}: {
  onBack: () => void;
  localPhotos?: LocalPhoto[];
  active?: boolean;
  onSyncSummary?: (summary: ConsumerSyncSummary) => void;
  onOwnedPhotos?: (snapshot: OwnedPhotoSnapshot | null) => void;
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
    [approvalText, setApprovalText] = useState(""),
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
    [committedMeaning, setCommittedMeaning] = useState<string>(),
    [selecting, setSelecting] = useState(false),
    [online, setOnline] = useState(() => navigator.onLine !== false),
    [pauseReady, setPauseReady] = useState(false);
  const running = useRef(false),
    pausedRef = useRef(true),
    intentVersion = useRef(0),
    uploadAbort = useRef<AbortController | null>(null),
    localSynced = useRef(new WeakMap<File, string>());
  const input = useRef<HTMLInputElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {if (active) backButton.current?.focus({preventScroll: true});}, [active]);
  const accountPanel = useRef<HTMLElement>(null);
  useDialogFocus(accountPanel, () => setMenu(false), menu && active && !!account);
  useEffect(() => {
    const picker = input.current;
    if (!picker) return;
    const cancelled = () => setReselect(undefined);
    picker.addEventListener("cancel", cancelled);
    return () => picker.removeEventListener("cancel", cancelled);
  }, [account]);
  const localPhotosRef = useRef(localPhotos);
  localPhotosRef.current = localPhotos;
  const currentCatalog = useRef(photos);
  currentCatalog.current = photos;
  const allLocalFiles = [...new Set([...localPhotos.flatMap(photo => photo.file ? [photo.file] : []), ...pickedFiles])];
  const catalogDigests = new Set(photos.map(photo => photo.metadata.originalSha256));
  const localSources = new Map(localPhotos.flatMap(photo => photo.file ? [[photo.file, photo] as const] : []));
  const unsavedLocalFiles = allLocalFiles.filter(file => {
    const source = localSources.get(file), digest = source ? localOriginalDigest(source) : undefined;
    return localSynced.current.get(file) !== account && (!digest || !catalogDigests.has(digest));
  });
  const unlocked = !!account;
  const publicDemo = fixtureMode || isPublicDemoAccount(account);
  const clear = () => {
    for (const photo of [...photos, ...(received ?? [])])
      photo.metadataKey.fill(0);
    setAccount("");
    setPhotos([]);
    setReceived(null);
    setSelected(new Set());
    setSelecting(false);
    setPickedFiles([]);
    localSynced.current = new WeakMap();
    setViewer(null);
    setExchange(false);
    setMenu(false);
    setReselect(undefined);
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
    setPauseReady(false);
    intentVersion.current++;
    uploadAbort.current?.abort();
  };
  const restorePause = async (session = requireVault()) => {
    const version = intentVersion.current;
    const value = await loadUploadPause(session);
    if (!sameVault(session) || intentVersion.current !== version) return;
    pausedRef.current = value; setPaused(value); setPauseReady(true);
  };
  const continueSync = async (session = requireVault()) => {
    const version = ++intentVersion.current;
    await saveUploadPause(false, session);
    if (!sameVault(session) || intentVersion.current !== version) throw new DOMException("Sync paused", "AbortError");
    pausedRef.current = false; setPaused(false); setPauseReady(true);
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
      setStatus("Sync is paused. Continue when you’re ready.");
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
      await restorePause();
      await refresh();
    });
  useEffect(() => {
    if (!account) return;
    void run(async () => {await restorePause(); await refresh();});
  }, [account]);
  useEffect(() => {
    if (!account) return;
    const update = () => {
      if (document.visibilityState === "visible" && !pausedRef.current)
        void run(refresh);
    };
    window.addEventListener("online", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("online", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [account]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => {window.removeEventListener("online", update); window.removeEventListener("offline", update);};
  }, []);
  const syncLocal = () =>
    run(async () => {
      const session = requireVault();
      if (publicDemo) throw new Error("PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED");
      await continueSync(session);
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
    unsavedLocalFiles.length,
  );
  const pause = () => {
    intentVersion.current++;
    pausedRef.current = true;
    setPaused(true);
    uploadAbort.current?.abort();
    try {
      pauseSync();
    } catch {}
    setStatus("Sync paused. Your originals are unchanged.");
    const session = requireVault();
    void saveUploadPause(true, session).catch(error => {if (sameVault(session)) {setStatus("Pause could not be saved in this browser. Keep it open and try again."); setNeedsAttention(true);}});
  };
  const retry = () =>
    run(async () => {
      await continueSync();
      await refresh();
    });
  const localCount = unsavedLocalFiles.length;
  const consumerSummary = useMemo(() => deriveConsumerSyncSummary({
    unlocked, paused, online, preparing: staging > 0, busy, needsAttention,
    committedPhotos: photos.length, queuedPhotos: summary.pending, failedPhotos: summary.failed, skippedPhotos: skipped,
    pendingEdits: annotationPending.filter(edit => !edit.conflict).length, conflictingEdits: annotationPending.filter(edit => edit.conflict).length,
    localPhotos: localCount, lastCheckedAt: lastSuccessfulSync,
  }), [unlocked, paused, online, staging, busy, needsAttention, photos.length, summary.pending, summary.failed, skipped, annotationPending, localCount, lastSuccessfulSync]);
  useEffect(() => {onSyncSummary?.(consumerSummary);}, [consumerSummary, onSyncSummary]);
  const ownedSnapshot = useMemo<OwnedPhotoSnapshot | null>(() => {
    if (!account) return null;
    let session;
    try {session = requireVault();} catch {return null;}
    if (session.accountId !== account) return null;
    const current = () => sameVault(session) && currentCatalog.current === photos;
    return {accountId: account, token: session, photos, current, preview: async photo => {
      if (!current() || !photos.includes(photo) || photo.manifest.ownerAccountId !== account || photo.grantId) throw new Error("VAULT_LOCKED");
      const bytes = await photoBytes(photo, "preview");
      try {if (!current()) throw new Error("VAULT_LOCKED"); return new Blob([new Uint8Array(bytes)], {type: "image/jpeg"});}
      finally {bytes.fill(0);}
    }};
  }, [account, photos]);
  useEffect(() => {onOwnedPhotos?.(ownedSnapshot);}, [ownedSnapshot, onOwnedPhotos]);
  const searchable = received ?? photos;
  const index = useMemo(() => new PhotoSearchIndex(cloudSearchRecords(searchable)), [searchable]);
  const searchResult = useMemo(() => index.search(query, {scope: "account:" + account, committedMeaning}), [index, query, account, committedMeaning]);
  const shown = normalizeSearch(query) ? searchResult.photoIds.flatMap(id => {const photo = searchable.find(photo => photo.manifest.photoId === id); return photo ? [photo] : [];}) : searchable;
  const viewing = !!viewer && shown.length > 0;
  useEffect(() => {if (viewer && !viewing) setViewer(null);}, [viewer, viewing]);
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
    if (!account || !pauseReady || busy || paused || needsAttention || !annotationPending.some(edit => !edit.conflict)) return;
    const timeout = setTimeout(() => {
      if (navigator.onLine && !running.current && !pausedRef.current) void run(refresh);
    }, 1000);
    return () => clearTimeout(timeout);
  }, [account, pauseReady, busy, paused, needsAttention, annotationPending]);
  const chosen = photos.filter((p) => selected.has(p.manifest.photoId));
  return (
    <>
      <main className={"cloud-library" + (selecting ? " exchange-selection" : "")} inert={viewing || exchange || menu ? true : undefined}>
        <header>
          <div className="brand"><p className="eyebrow">Saved photos</p><h1>Fotoro</h1></div>
          <div className="header-actions">
          <button
            ref={backButton}
            onClick={() => {
              if (!account) {
                cancelEnrollment();
                setRecoveryNew("");
                setAuthStep("welcome");
              }
              onBack();
            }}
          >
            Back to photos
          </button>
          {unlocked && (
            <button
              className="menu-button glass"
              aria-label="Sync and account"
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
          </div>
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
              <form onSubmit={event => {
                event.preventDefault();
                if (busy || !recovery.trim()) return;
                void login(async () => {await recover(recovery); setRecovery("");});
              }}>
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
                  type="submit"
                  disabled={busy || !recovery.trim()}
                >
                  Continue
                </button>
                <button type="button" disabled={busy} onClick={() => setAuthStep("welcome")}>
                  Back
                </button>
              </form>
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
            {unlocked && !received && (
              <button
                className={"cloud-sync-status state-" + consumerSummary.state}
                onClick={() => setMenu(true)}
              >
                <span className="sync-dot" aria-hidden="true" />{syncStateLabel[consumerSummary.state]}<small>{consumerSummary.detail}</small>
              </button>
            )}
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
            {normalizeSearch(query) && searchResult.meanings.some(meaning => meaning.id !== searchResult.meaning?.id && meaning.photoIds.some(id => !searchResult.photoIds.includes(id))) && (
              <div className="cloud-search-meanings local-labels glass">
                <span>Also try</span>{searchResult.meanings.filter(meaning => meaning.id !== searchResult.meaning?.id && meaning.photoIds.some(id => !searchResult.photoIds.includes(id))).slice(0, 3).map(meaning => <button key={meaning.id} onClick={() => setCommittedMeaning(meaning.id)}>{meaning.term}</button>)}
              </div>
            )}
            {shown.length ? (
              <Library
                active={active}
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
                onClick={() => {setReselect(undefined); input.current?.click();}}
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
                Encrypted exchange · {selected.size}
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
                const pendingReselection = reselect;
                setReselect(undefined);
                if (!files.length) return;
                if (pendingReselection) {
                  void run(async () => {
                    if (publicDemo)
                      throw new Error("PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED");
                    await stageImport(files[0], pendingReselection);
                    await continueSync();
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
            {syncStateLabel[consumerSummary.state]}
          </p>
        )}
      </main>
        {active && menu && unlocked && (
          <aside className="account-sheet sheet" ref={accountPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Sync and account">
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
              {syncStateLabel[consumerSummary.state]}
            </p>
            <p className="hint">
              {consumerSummary.detail}
            </p>
            <p className="hint">
              {lastSuccessfulSync
                ? "Last checked " +
                  new Date(lastSuccessfulSync).toLocaleString()
                : "Not checked yet"}
            </p>
            {localCount > 0 && (
              <>
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
              <button className="primary-action" disabled={busy || (localCount > 0 && publicDemo)} onClick={localCount > 0 ? syncLocal : retry}>
                {paused ? "Continue sync" : localCount > 0 ? `Sync ${localCount} selected ${localCount === 1 ? "photo" : "photos"}` : needsAttention || summary.pending || summary.failed ? "Retry sync" : "Check for photos"}
              </button>
              {!paused && (busy || summary.pending > 0 || annotationPending.length > 0) && <button onClick={pause}>Pause sync</button>}
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
              <summary>Advanced · encrypted exchanges and devices</summary>
              <p className="hint">For ordinary sharing, open a photo and choose Share. Encrypted exchanges require a trusted account card.</p>
              <div className="actions"><button onClick={() => {setExchange(true); setMenu(false);}}>Open encrypted exchanges</button><button onClick={() => {setSelecting(true); setMenu(false);}}>Choose photos for an exchange</button>{selecting && <button onClick={() => {setSelecting(false); setSelected(new Set());}}>Finish choosing photos</button>}</div>
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
      {active && exchange && unlocked && (
        <Exchange
          selection={chosen}
          onClose={() => setExchange(false)}
          onRefresh={() => run(refresh)}
          onReceived={(items: Photo[], _grant: GrantV1) => {
            setReceived(items);
            setExchange(false);
            setSelected(new Set());
          }}
        />
      )}
      {active && viewing && viewer && unlocked && (
        <Viewer
          photos={shown}
          initial={viewer}
          onSaved={() => run(refresh)}
          onLabels={!received && !publicDemo ? (photo, labels) => {void editLabels(photo, labels);} : undefined}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}
