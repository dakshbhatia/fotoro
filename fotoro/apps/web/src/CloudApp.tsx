import { useEffect, useMemo, useRef, useState } from "react";
import type { GrantV1 } from "@fotoro/contracts";
import { ready } from "@fotoro/crypto";
import { Library } from "./library/Library";
import { Viewer } from "./library/Viewer";
import { photoBytes, type Photo } from "./library/catalog";
import {projectLocalAnnotations} from "./library/annotation-projection";
import {
  lockVault,
  requireVault,
  vaultGeneration,
} from "./vault/vault";
import {
  publicTestSession,
  recover,
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
import {IncomingShareIntent} from "./exchange/sharing";
import {
  stageImport,
  pendingImports,
  type PendingImport,
} from "./exchange/journal";
import {
  refreshSync,
  cachedSync,
  saveSync,
  syncStatus,
  sameVault,
  readableSyncError,
  pauseSync,
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
import {AccountAccess} from "./vault/AccountAccess";
import {ChosenSaveIntent, type ChosenSaveSnapshot} from "./exchange/chosen-save";
import type {UnlockedVault} from "./vault/vault";
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
  saveIntent = null,
  incoming = null,
  incomingError = "",
  onIncomingDone,
  sharePhotos = null,
  onShareDone,
}: {
  onBack: () => void;
  localPhotos?: LocalPhoto[];
  active?: boolean;
  onSyncSummary?: (summary: ConsumerSyncSummary) => void;
  onOwnedPhotos?: (snapshot: OwnedPhotoSnapshot | null) => void;
  saveIntent?: ChosenSaveIntent | null;
  incoming?: IncomingShareIntent | null;
  incomingError?: string;
  onIncomingDone?: () => void;
  sharePhotos?: Photo[] | null;
  onShareDone?: () => void;
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
    [exchangePhotos, setExchangePhotos] = useState<Photo[]>([]),
    [exchangeVersion, setExchangeVersion] = useState(0),
    [menu, setMenu] = useState(false),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [recovery, setRecovery] = useState(""),
    [pending, setPending] = useState<PendingImport[]>([]);
  const [recoveryNew, setRecoveryNew] = useState(""),
    [reselect, setReselect] = useState<PendingImport | undefined>(undefined);
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<string | null>(null),
    [staging, setStaging] = useState(0),
    [skipped, setSkipped] = useState(0),
    [paused, setPaused] = useState(false),
    [pickedFiles, setPickedFiles] = useState<File[]>([]),
    [needsAttention, setNeedsAttention] = useState(false),
    [annotationPending, setAnnotationPending] = useState<PendingAnnotation[]>([]),
    [committedMeaning, setCommittedMeaning] = useState<string>(),
    [selecting, setSelecting] = useState(false),
    [online, setOnline] = useState(() => navigator.onLine !== false);
  const [saveReady, setSaveReady] = useState<UnlockedVault | null>(null);
  const running = useRef(false),
    authIntent = useRef(0),
    pausedRef = useRef(true),
    intentVersion = useRef(0),
    uploadAbort = useRef<AbortController | null>(null),
    localSynced = useRef(new WeakMap<File, string>());
  const input = useRef<HTMLInputElement>(null);
  const activeRef = useRef(active), saveIntentRef = useRef(saveIntent), incomingRef = useRef(incoming);
  activeRef.current = active; saveIntentRef.current = saveIntent; incomingRef.current = incoming;
  const backButton = useRef<HTMLButtonElement>(null), passwordPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active) return;
    const target = account ? backButton.current : passwordPanel.current?.querySelector<HTMLInputElement>('input[name="password"]');
    target?.focus({preventScroll: true});
  }, [active, account, recoveryNew]);
  const accountPanel = useRef<HTMLElement>(null);
  const closeAccountPanel = () => setMenu(false);
  useDialogFocus(accountPanel, closeAccountPanel, menu && active && !!account);
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
  const allLocalFiles = [...new Set([...(saveIntent?.pending ? saveIntent.snapshot.files : []), ...pickedFiles])];
  const catalogDigests = new Set(photos.map(photo => photo.metadata.originalSha256));
  const localSources = new Map(localPhotos.flatMap(photo => photo.file ? [[photo.file, photo] as const] : []));
  const unsavedLocalFiles = allLocalFiles.filter(file => {
    const source = localSources.get(file), digest = source ? localOriginalDigest(source) : undefined;
    return localSynced.current.get(file) !== account && (!digest || !catalogDigests.has(digest));
  });
  const unlocked = !!account;
  const accountReference = account ? account.slice(0, 8) + "…" + account.slice(-4) : "";
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
    setSaveReady(null);
    setSkipped(0);
    pausedRef.current = true;
    setPaused(true);
    intentVersion.current++;
    uploadAbort.current?.abort();
  };
  const restorePause = async (session = requireVault()) => {
    const version = intentVersion.current;
    const value = await loadUploadPause(session);
    if (!sameVault(session) || intentVersion.current !== version) return;
    pausedRef.current = value; setPaused(value);
  };
  const continueSync = async (session = requireVault()) => {
    const version = ++intentVersion.current;
    await saveUploadPause(false, session);
    if (!sameVault(session) || intentVersion.current !== version) throw new DOMException("Sync paused", "AbortError");
    pausedRef.current = false; setPaused(false);
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
  const refresh = async (send = false, current = () => true, signal?: AbortSignal) => {
    const check = () => {signal?.throwIfAborted(); if (!current()) throw new DOMException("Save cancelled", "AbortError");};
    check();
    const session = requireVault();
    const cached = await cachedSync(session);
    check();
    if (!sameVault(session)) return;
    setPhotos(cached.photos);
    setPending(cached.pending);
    setAnnotationPending(cached.annotations);
    setLastSuccessfulSync(cached.lastSuccessfulSync);
    setSkipped(cached.skipped);
    setSaveReady(session);
    if (send && pausedRef.current) {
      setStatus("Saving is paused. Continue when you’re ready.");
      return;
    }
    if (!navigator.onLine) {
      setStatus(
        "Offline · your cached photos are available. Save when you’re online.",
      );
      return;
    }
    check();
    const result = await (send ? saveSync(session, signal) : refreshSync(session));
    check();
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
  const run = async (fn: () => Promise<void | boolean>, accountAction = false) => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setStatus("");
    let accepted = false;
    let session;
    try {
      session = requireVault();
    } catch {}
    try {
      await ready;
      accepted = (await fn()) !== false;
    } catch (e) {
      if (!session || sameVault(session)) {
        const message = readableSyncError(e);
        setStatus(accountAction && message.startsWith("Save could not finish.") ? "Sign-in could not finish. Check your connection and try again." : message);
        setNeedsAttention(true);
      }
      if (session && sameVault(session)) {
        try {
          const queue = await pendingImports();
          const edits = await pendingAnnotations(session);
          if (sameVault(session)) setAnnotationPending(edits);
          if (sameVault(session))
            setPending((previous) => (sameVault(session) ? queue : previous));
        } catch {}
      }
    } finally {
      if (uploadAbort.current?.signal.aborted) {
        uploadAbort.current = null;
        setStaging(0);
      }
      running.current = false;
      setBusy(false);
    }
    return accepted;
  };
  const login = async (fn: () => Promise<unknown>) => {
    const request = saveIntentRef.current, version = authIntent.current;
    return run(async () => {
      const ticket = request?.beginAuthentication(vaultGeneration());
      const shareRequest = incomingRef.current, shareTicket = shareRequest?.beginAuthentication(vaultGeneration());
      try {await fn();}
      catch (error) {request?.finishAuthentication(ticket, undefined, error); shareRequest?.finishAuthentication(shareTicket); throw error;}
      if (!activeRef.current || authIntent.current !== version) {request?.cancel(); shareRequest?.cancel(); return;}
      try {
        const session = requireVault();
        request?.finishAuthentication(ticket, {session, generation: vaultGeneration(), current: () => sameVault(session)});
        shareRequest?.finishAuthentication(shareTicket, session, vaultGeneration());
        setAccount(session.accountId);
        if (request?.pending && request.boundVault === session) setMenu(false);
      } catch {
        request?.finishAuthentication(ticket);
        shareRequest?.finishAuthentication(shareTicket);
        setStatus(
          "Enter your Fotoro password to unlock photos on this device.",
        );
        return;
      }
      await restorePause();
      await refresh();
    }, true);
  };
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
  const syncLocal = (snapshot?: ChosenSaveSnapshot, signal?: AbortSignal, current = () => true) =>
    run(async () => {
      const session = requireVault();
      const check = () => {signal?.throwIfAborted(); if (!current() || !sameVault(session)) throw new DOMException("Save cancelled", "AbortError");};
      check();
      if (publicDemo) throw new Error("PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED");
      await continueSync(session);
      check();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, {once: true});
      uploadAbort.current = controller;
      let failures = 0;
      const candidates = (snapshot?.files ?? pickedFiles).filter(
        (file) => localSynced.current.get(file) !== session.accountId,
      );
      try {
        const result = await syncSelectedSequential(candidates, {
          current: () => sameVault(session) && current(),
          signal: controller.signal,
          stage: async (file) => {
            setStaging((value) => (sameVault(session) ? 1 : value));
            check();
            const source = (snapshot?.photos ?? localPhotosRef.current).find(photo => photo.file === file);
            const existing = source?.digest ? currentCatalog.current.find(photo => photo.metadata.originalSha256 === localOriginalDigest(source)) : undefined;
            const staged = existing ? undefined : await stageImport(file, undefined, controller.signal);
            check();
            if (source && (staged || existing)) {
              const photoId = existing?.manifest.photoId ?? staged!.photoId;
              const originalSha256 = existing?.metadata.originalSha256 ?? staged!.sourceDigest;
              await queueLocalAnnotations({ownerAccountId: session.accountId, photoId, originalSha256}, source, session);
              check();
            }
            if (!sameVault(session)) throw new Error("VAULT_LOCKED");
            localSynced.current.set(file, session.accountId);
            await clearSkipped(session, file);
            setStaging((value) => (sameVault(session) ? 0 : value));
          },
          drain: async () => {
            check();
            await refresh(true, current, controller.signal);
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
            "A photo still needs to Save. Retry it before adding more photos.",
          );
        else if (sameVault(session) && failures)
          setStatus(
            `${failures} photos could not be prepared. Your local originals are unchanged.`,
          );
        check();
        return !result.stopped && failures === 0;
      } finally {
        signal?.removeEventListener("abort", abort);
        if (uploadAbort.current === controller) uploadAbort.current = null;
        if (sameVault(session)) setStaging(0);
      }
    });
  const startChosenSave = (request = saveIntentRef.current) => {
    if (!request?.pending) return Promise.resolve(false);
    // A failed cache activation can be retried explicitly without replacing the selection.
    if (!saveReady || !sameVault(saveReady)) return run(async () => {await restorePause(); await refresh();});
    return request.start({
      active: activeRef.current && document.visibilityState !== "hidden",
      busy: running.current,
      session: saveReady,
      current: () => activeRef.current && saveIntentRef.current === request && sameVault(saveReady) && document.visibilityState !== "hidden",
      save: (snapshot, signal, current) => {
        setMenu(false);
        return syncLocal(snapshot, signal, current);
      },
    });
  };
  useEffect(() => {
    // A request arriving at an already-open account needs no authentication transition.
    if (!active || !account || !saveIntent?.pending) return;
    try {const session = requireVault(); if (session.accountId === account) saveIntent.bindInitialVault(session);} catch {}
  }, [active, saveIntent]);
  useEffect(() => {
    if (active && !busy && saveIntent?.needsInitialSave && saveReady) void startChosenSave(saveIntent);
  }, [active, busy, saveIntent, saveReady]);
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
    setStatus("Saving paused. Your originals are unchanged.");
    const session = requireVault();
    void saveUploadPause(true, session).catch(error => {if (sameVault(session)) {setStatus("Pause could not be saved in this browser. Keep it open and try again."); setNeedsAttention(true);}});
  };
  const retry = () =>
    run(async () => {
      await continueSync();
      await refresh(true);
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
    return {accountId: account, token: session, photos, current, edit: publicDemo ? undefined : async (photo, changes) => {
      if (!current() || !photos.includes(photo) || photo.manifest.ownerAccountId !== account || photo.grantId) throw new Error("VAULT_LOCKED");
      await editAnnotations(photo, changes, session);
    }, preview: async photo => {
      if (!current() || !photos.includes(photo) || photo.manifest.ownerAccountId !== account || photo.grantId) throw new Error("VAULT_LOCKED");
      const bytes = await photoBytes(photo, "preview");
      try {if (!current()) throw new Error("VAULT_LOCKED"); return new Blob([new Uint8Array(bytes)], {type: "image/jpeg"});}
      finally {bytes.fill(0);}
    }};
  }, [account, photos, publicDemo]);
  useEffect(() => {onOwnedPhotos?.(ownedSnapshot);}, [ownedSnapshot, onOwnedPhotos]);
  const searchable = received ?? photos;
  const index = useMemo(() => new PhotoSearchIndex(cloudSearchRecords(searchable)), [searchable]);
  const searchResult = useMemo(() => index.search(query, {scope: "account:" + account, committedMeaning}), [index, query, account, committedMeaning]);
  const shown = normalizeSearch(query) ? searchResult.photoIds.flatMap(id => {const photo = searchable.find(photo => photo.manifest.photoId === id); return photo ? [photo] : [];}) : searchable;
  const viewing = !!viewer && shown.length > 0;
  useEffect(() => {if (viewer && !viewing) setViewer(null);}, [viewer, viewing]);
  const publishLocalAnnotations = async (sources: Photo[], session: UnlockedVault, current = () => true) => {
    const original = new Map(sources.map(photo => [photo.manifest.photoId, photo]));
    const matchesSource = (photo: Photo, source: Photo) => !photo.grantId && photo.manifest.ownerAccountId === session.accountId
      && photo.manifest === source.manifest && photo.metadata === source.metadata && photo.metadataKey === source.metadataKey;
    const isCurrent = () => sameVault(session) && current()
      && sources.every(source => currentCatalog.current.some(photo => matchesSource(photo, source)));
    if (!isCurrent()) return;
    const projected = await projectLocalAnnotations(sources, session);
    if (!isCurrent()) return;
    const edits = await pendingAnnotations(session);
    if (!isCurrent()) return;
    const updated = new Map(projected.map(photo => [photo.manifest.photoId, photo]));
    setPhotos(previous => sameVault(session) && current() ? previous.map(photo => {
      const source = original.get(photo.manifest.photoId);
      return source && matchesSource(photo, source) ? updated.get(photo.manifest.photoId)! : photo;
    }) : previous);
    setAnnotationPending(previous => sameVault(session) && current() ? edits : previous);
  };
  const editAnnotations = async (photo: Photo, changes: {labels?: string[]; favorite?: boolean}, session = requireVault()) => {
    if (!sameVault(session) || !currentCatalog.current.includes(photo) || photo.grantId || photo.manifest.ownerAccountId !== session.accountId) return;
    try {
      await queueAnnotations({ownerAccountId: photo.manifest.ownerAccountId, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256}, changes, session);
      await publishLocalAnnotations([photo], session);
    } catch (error) {if (sameVault(session)) {setStatus(readableSyncError(error)); setNeedsAttention(true);}}
  };
  useEffect(() => {
    if (!account || publicDemo) return;
    const session = requireVault();
    let alive = true;
    void (async () => {
      const changed: Photo[] = [];
      for (const photo of photos) {
        if (!alive || !sameVault(session) || !currentCatalog.current.includes(photo)) return;
        const local = localPhotos.find(source => localOriginalDigest(source) === photo.metadata.originalSha256);
        if (!local) continue;
        if (await queueLocalAnnotations({ownerAccountId: session.accountId, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256}, local, session, false)) changed.push(photo);
      }
      if (changed.length) await publishLocalAnnotations(changed, session, () => alive);
    })().catch(error => {if (alive && sameVault(session)) {setStatus(readableSyncError(error)); setNeedsAttention(true);}});
    return () => {alive = false;};
  }, [account, localPhotos, photos, publicDemo]);
  useEffect(() => {
    const available = new Set(photos.map(photo => photo.manifest.photoId));
    setSelected(previous => {
      const next = new Set([...previous].filter(id => available.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [photos]);
  const chosen = photos.filter((p) => selected.has(p.manifest.photoId));
  const toggleSelection = (id: string) => setSelected(previous => {
    const next = new Set(previous);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const openSharing = (items: Photo[] = []) => {setExchangePhotos([...items]); setExchangeVersion(version => version + 1); setExchange(true);};
  const closeSharing = () => {setExchange(false); setExchangePhotos([]); onShareDone?.(); onIncomingDone?.();};
  const priorIncoming = useRef(incoming);
  useEffect(() => {
    const previous = priorIncoming.current; priorIncoming.current = incoming;
    if (previous && !incoming) {setExchange(false); setExchangePhotos([]);}
    if (!active || !account || !incoming?.pending) return;
    const session = requireVault(); incoming.bindInitialVault(session);
    if (incoming.current(session)) openSharing();
  }, [active, account, incoming]);
  useEffect(() => {
    if (active && account && sharePhotos?.length) openSharing(sharePhotos);
  }, [active, account, sharePhotos]);
  return (
    <>
      <main className={"cloud-library" + (selecting ? " exchange-selection" : "")} inert={viewing || exchange || menu ? true : undefined}>
        <header className="consumer-navigation">
          <div className="brand"><h1>Fotoro</h1></div>
          <div className="header-actions">
          {!unlocked && <button
            ref={backButton}
            onClick={() => {
              if (!account) {
                authIntent.current++;
                cancelEnrollment();
                setRecoveryNew("");
                setRecovery("");
              }
              onBack();
            }}
          >
            Back to photos
          </button>}
          {unlocked && (
            <button
              className="menu-button glass"
              aria-label="Settings"
              onClick={() => setMenu(!menu)}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="12" cy="12" r="3" /><path d="m9 3 1 2h4l1-2 3 2-1 2 2 3 2 1v3l-2 1-2 3 1 2-3 2-1-2h-4l-1 2-3-2 1-2-2-3-2-1v-3l2-1 2-3-1-2z" />
              </svg>
            </button>
          )}
          </div>
        </header>
        {incomingError && <p className="hint share-link-error" role="status">{incomingError}</p>}
        {!unlocked ? (
          <section className="unlock sync-onboarding" ref={passwordPanel}>
            {incoming?.pending && <p className="hint">{incoming.link.kind === "moment" ? "Enter the Fotoro password this photo invitation was sent to." : "Enter your Fotoro password to accept this contact."}</p>}
            <AccountAccess
              password={recovery}
              onPassword={setRecovery}
              generatedPassword={recoveryNew}
              busy={busy}
              onSignIn={() => {
                const version = authIntent.current;
                void login(async () => {await recover(recovery, () => authIntent.current === version); setRecovery("");});
              }}
              onCreate={() => {void run(async () => {setRecoveryNew(await prepareEnrollment());}, true);}}
              onContinue={() => {void login(async () => {await completeEnrollment(); setRecoveryNew("");});}}
              onBack={() => {cancelEnrollment(); setRecovery(recoveryNew); setRecoveryNew(""); setStatus("");}}
              onCopy={() => {void run(async () => {
                if (!navigator.clipboard) throw new Error("PASSWORD_COPY_UNAVAILABLE");
                await navigator.clipboard.writeText(recoveryNew).catch(() => {throw new Error("PASSWORD_COPY_UNAVAILABLE");});
                setStatus("Password copied.");
              });}}
              onSave={() => {
                const url = URL.createObjectURL(new Blob([recoveryNew + "\n"], {type: "text/plain"}));
                const link = document.createElement("a");
                link.href = url; link.download = "Fotoro password.txt"; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            />

            {fixtureMode && (
              <details>
                <summary>Advanced DEBUG</summary>
                <p className="hint">
                  Public test accounts only.
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
                Public test account · private uploads disabled.
              </p>
            )}
            <div className="toolbar glass consumer-search">
              <SearchIcon />
              <input aria-label="Search photos" placeholder="Search photos" value={query} onChange={event => {setQuery(event.target.value); setCommittedMeaning(undefined);}} />
              {query && <button onClick={() => {setQuery(""); setCommittedMeaning(undefined);}} aria-label="Clear search">×</button>}
              {!received && <button onClick={() => {setReselect(undefined); input.current?.click();}} aria-label="Add photos" disabled={busy || publicDemo}><PlusIcon /></button>}
            </div>
            <nav className="consumer-scopes" aria-label="Photo library">
              <button ref={backButton} onClick={onBack}>Photos</button>
              <button aria-current={!received ? "page" : undefined} onClick={() => {setReceived(null); setQuery(""); setCommittedMeaning(undefined);}}>Saved</button>
              <button aria-current={received ? "page" : undefined} onClick={() => openSharing()}>Shared</button>
            </nav>
            <div className="consumer-section">
              <h2>{query ? "Search results" : received ? "Shared photos" : "Saved photos"}</h2>
              {!received && <button aria-pressed={selecting} onClick={() => setSelecting(value => !value)}>{selecting ? "Done" : "Select"}</button>}
            </div>
            {!received && (busy || localCount > 0 || summary.pending > 0 || summary.failed > 0 || needsAttention || annotationPending.length > 0) && <section className={"consumer-save-progress state-" + consumerSummary.state} aria-label="Save progress">
              <div><p role="status">{status || syncStateLabel[consumerSummary.state]}</p>{consumerSummary.detail && <p className="hint">{consumerSummary.detail}</p>}</div>
              <div className="actions">
                {busy && !paused && <button onClick={pause}>Pause</button>}
                {!busy && (localCount > 0 || summary.pending > 0 || summary.failed > 0 || annotationPending.length > 0) && <button className="primary-action" disabled={publicDemo} onClick={() => {if (annotationPending.some(edit => edit.conflict)) setMenu(true); else if (saveIntent?.pending) void startChosenSave(); else if (localCount > 0) void syncLocal(); else void retry();}}>{annotationPending.some(edit => edit.conflict) ? "Review changes" : needsAttention || summary.failed ? "Retry" : localCount > 0 ? `Save ${localCount}` : summary.pending > 0 ? "Continue" : "Save changes"}</button>}
                {!busy && needsAttention && <button onClick={() => setMenu(true)}>Details</button>}
              </div>
            </section>}
            {received && (
              <div className="received-bar">
                <span>Shared photos · open a photo to Save</span>
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
                selecting={selecting}
                onSelect={toggleSelection}
                onOpen={id => selecting && !received ? toggleSelection(id) : setViewer(id)}
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
            {!received && selected.size > 0 && <div className="consumer-selection glass" aria-label="Selected photos">
              <span role="status">{selected.size} selected</span>
              <button onClick={() => setSelected(new Set())}>Clear</button>
              <button className="primary-action" onClick={() => openSharing(chosen)}>Share</button>
            </div>}
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
                    await refresh(true);
                  });
                  return;
                }
                setPickedFiles((current) => [
                  ...new Set([...current, ...files]),
                ]);
                setMenu(false);
              }}
            />
          </>
        )}
        {status && !menu && (!unlocked || received || !busy && localCount === 0 && summary.pending === 0 && summary.failed === 0 && !needsAttention && annotationPending.length === 0) && (
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
          <aside className="account-sheet sheet" ref={accountPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Settings">
            <button
              className="close"
              aria-label="Close account"
              onClick={closeAccountPanel}
            >
              ×
            </button>
            <h2>Settings</h2>
            <p className="hint">This Fotoro · {accountReference}</p>
            <p role="status">
              {status || syncStateLabel[consumerSummary.state]}
            </p>
            <p className="hint">
              {consumerSummary.detail}
            </p>
            <div className="actions">
              {(localCount > 0 || summary.pending || summary.failed || annotationPending.length > 0) && <button className="primary-action" disabled={busy || publicDemo} onClick={() => {if (saveIntent?.pending) void startChosenSave(); else if (localCount > 0) void syncLocal(); else void retry();}}>
                {localCount > 0 ? `Save ${localCount} selected ${localCount === 1 ? "photo" : "photos"}` : summary.pending || summary.failed ? "Continue" : "Save changes"}
              </button>}
              {!paused && busy && <button onClick={pause}>Pause</button>}
              <button onClick={closeAccountPanel}>Saved photos</button>
            </div>
            <details>
              <summary>Settings</summary>
              <button disabled={busy} onClick={() => {void run(refresh);}}>Refresh saved photos</button>
              <button
                onClick={() => {
                  lockVault();
                  setMenu(false);
                }}
              >
                Lock
              </button>
              <div className="actions"><button onClick={() => {openSharing(); setMenu(false);}}>Shared photos</button><button onClick={() => {setSelecting(true); setMenu(false);}}>Choose photos to Share</button></div>
            {annotationPending.length > 0 && <details open={annotationPending.some(edit => edit.conflict)}>
              <summary>Labels and photo text · {annotationPending.length} pending</summary>
              {annotationPending.map(edit => <div key={edit.photoId}>
                <p>{photos.find(photo => photo.manifest.photoId === edit.photoId)?.metadata.filename ?? "Photo"} · {edit.conflict ? "Changed on another device" : "Waiting to Save"}</p>
                {edit.conflict && <>
                  <p className="hint">Your pending edits are kept here. Choose which changes to keep.</p>
                  <div className="actions"><button disabled={busy} onClick={() => run(async () => {await resolveAnnotationConflict(edit.photoId, "local"); await continueSync(); await refresh(true);})}>Use my edits</button><button disabled={busy} onClick={() => run(async () => {await resolveAnnotationConflict(edit.photoId, "remote"); await refresh();})}>Keep synced edits</button></div>
                </>}
              </div>)}
            </details>}
            {pending.some(p => p.state !== "committed") && <details open={summary.failed > 0}>
              <summary>Waiting photos</summary>
              {pending.filter(p => p.state !== "committed").map((p) => (
                  <p key={p.operationId}>
                    {p.sourceFilename} ·{" "}
                    {p.state === "failed"
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
                ))}
            </details>}
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
            </details>
          </aside>
        )}
      {active && exchange && unlocked && (
        <Exchange
          key={exchangeVersion}
          selection={exchangePhotos}
          incoming={incoming?.pending ? incoming : undefined}
          onClose={closeSharing}
          onRetryPassword={incoming?.pending ? () => {incoming.retryPassword(); setExchange(false); setExchangePhotos([]); lockVault();} : undefined}
          onRefresh={() => run(refresh)}
          onReceived={(items: Photo[], _grant: GrantV1) => {
            setReceived(items);
            closeSharing();
            setQuery(""); setCommittedMeaning(undefined);
            setSelected(new Set());
          }}
        />
      )}
      {active && viewing && viewer && unlocked && (
        <Viewer
          photos={shown}
          initial={viewer}
          onSaved={() => run(refresh)}
          onShare={!received ? photo => {setViewer(null); openSharing([photo]);} : undefined}
          onLabels={!received && !publicDemo ? (photo, labels) => {void editAnnotations(photo, {labels});} : undefined}
          onFavorite={!received && !publicDemo ? (photo, favorite) => {void editAnnotations(photo, {favorite});} : undefined}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}
