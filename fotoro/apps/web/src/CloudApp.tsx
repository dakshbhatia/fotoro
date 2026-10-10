import {diagnose, diagnosticReason, type DiagnosticContext} from "./diagnostics";
import {CopyDiagnostics} from "./components/CopyDiagnostics";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceChallengeV1, GrantV1, PhotoLocationV1 } from "@fotoro/contracts";
import {annotationLocation} from "@fotoro/contracts/location";
import { ready } from "@fotoro/crypto";
import { Library } from "./library/Library";
import { Viewer } from "./library/Viewer";
import { cacheOwnedPhotoDetails, photoBytes, type Photo, type CatalogCoverage, type OwnedPhotoDetailsSource } from "./library/catalog";
import {projectLocalAnnotations} from "./library/annotation-projection";
import {
  lockVault,
  requireVault,
  vaultGeneration,
  vaultLockDetail,
  authenticatedApprovalAccount, requestDeviceApproval, cancelDeviceApproval, deviceApprovalDeadline, reviewDeviceChallenge, approveDeviceChallenge, unlockVault,
} from "./vault/vault";
import {
  publicTestSession,
  recover,
  prepareEnrollment,
  completeEnrollment,
  cancelEnrollment,
  clearBrowserSession,
  passkeyLogin,
  addPasskey,
} from "./vault/session";
import {
  fixtureMode,
  isPublicDemoAccount,
  ApiError,
  ApiTransportError,
} from "./exchange/api";
import { Exchange } from "./exchange/Exchange";
import {ExpiredSavedSelection, IncomingShareIntent, grantState, ShareSelection} from "./exchange/sharing";
import {ReceivedAccessRefresh} from "./exchange/received-access";
import {
  stageImport,
  resumePendingImports,
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
import { localOriginalDigest, queueAnnotations, queuePhotoLocation, queuePhotoObservation, queuePhotoPeople, queueLocalAnnotations, pendingAnnotations, resolveAnnotationConflict, type PendingAnnotation } from "./exchange/annotations";
import type {PhotoObservationV1} from "@fotoro/contracts/intelligence";
import type {PeopleAssignment} from "@fotoro/contracts/people";
import {useSemanticFind} from "./local/useSemanticFind";
import {visualSearchFeedback} from "./local/LocalSearch";
import { PhotoSearchIndex, normalizeSearch } from "./local/search";
import type { LocalPhoto } from "./local/resources";
import { cloudSearchRecords } from "./library/search";
import {deriveConsumerSyncSummary, syncStateLabel} from "./library/consumer-sync";
import {loadUploadPause, saveUploadPause} from "./library/consumer-preferences";
import type {OwnedPhotoSnapshot} from "./library/consumer-search";
import {savedSearchPhotos} from "./library/consumer-search";
import {findMatchPhotos, shortlistSearchResult} from "./local/find-best-shots";
import {useFindBestShots} from "./local/useFindBestShots";
import {FindBestShots, selectionCandidates} from "./local/FindBestShots";
import {useDialogFocus} from "./library/dialog-focus";
import {AccountAccess} from "./vault/AccountAccess";
import {resolveChosenTripSources, chosenTripPhotos} from "./exchange/chosen-trip";
import {ChosenSaveIntent, continueChosenSave, type ChosenSaveSnapshot} from "./exchange/chosen-save";
import type {UnlockedVault} from "./vault/vault";
import {syncContacts, subscribeContacts} from "./exchange/contacts";
import {subscribeSavedRefresh} from "./library/consumer-refresh";
import {saveQueuedAnnotations} from "./library/consumer-annotation-save";
import type {ConsumerPhotoChanges} from "./library/consumer-changes";
import {canShareOriginals, downloadOriginal, OriginalShareAttempt, prepareSavedOriginals, savedOriginalSelectionCurrent} from "./library/system-share";
import {cameraOriginalFiles} from "./media/camera-original";
import {Places} from "./local/PhotoPlaces";
import {currentTimelineCandidates} from "./local/places";
import type {TimelineCandidate} from "./local/google-timeline";
import {ConsumerPreviewResources, ConsumerSelectionRetention} from "./library/consumer-search";
import {PeopleFilter, usePeopleFilter} from "./people/PeopleFilter";
import {peopleMatchingPhotoIDs, peopleFilteredResult, peopleMetadataMatches} from "./people/filter";
import {inRecentSelectedRange, recentBrowseActive} from "./local/consumer-range";
import {peopleSourceCurrent} from "./people/groups";
import type {PeopleUpdate} from "./people/People";
import type {IncomingAlbumIntent} from "./albums/intent";
import {saveTripFiles, tripSavedSources} from "./albums/import";
import {AlbumPanel} from "./albums/AlbumPanel";
import {AlbumEntryRevision, type AlbumEntrySelection} from "./albums/entry";
import {AlbumContinuation, type AlbumDestination} from "./albums/AlbumContinuation";
const People = lazy(() => import("./people/People").then(module => ({default: module.People})));
export interface ChosenTripSelection {request: ChosenSaveIntent; savedSources: readonly OwnedPhotoDetailsSource[]}
interface SelectedOriginalContext {snapshot: ShareSelection; session: UnlockedVault; controller: AbortController;}
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
  onOwnedPhotos,
  onPhotoChanges,
  saveIntent = null,
  chosenTrip = null,
  incoming = null,
  incomingError = "",
  onIncomingDone,
  sharePhotos = null,
  onShareDone,
  incomingAlbum = null,
  onAlbumIncomingDone,
  albumPhotos = null,
  onAlbumDone,
}: {
  onBack: () => void;
  localPhotos?: LocalPhoto[];
  active?: boolean;
  onOwnedPhotos?: (snapshot: OwnedPhotoSnapshot | null) => void;
  onPhotoChanges?: (changes: ConsumerPhotoChanges | null) => void;
  saveIntent?: ChosenSaveIntent | null;
  chosenTrip?: ChosenTripSelection | null;
  incoming?: IncomingShareIntent | null;
  incomingError?: string;
  onIncomingDone?: () => void;
  sharePhotos?: Photo[] | null;
  onShareDone?: () => void;
  incomingAlbum?: IncomingAlbumIntent | null;
  onAlbumIncomingDone?: () => void;
  albumPhotos?: Photo[] | null;
  onAlbumDone?: () => void;
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
  const [receivedContext, setReceivedContext] = useState<{grant: GrantV1; sender: string} | null>(null);
  const [preparingOriginals, setPreparingOriginals] = useState(false), [sharingOriginals, setSharingOriginals] = useState(false);
  const [preparedOriginals, setPreparedOriginals] = useState<{files: File[]; context: SelectedOriginalContext} | null>(null);
  const [originalShareError, setOriginalShareError] = useState("");
  const [originalShareAttempt] = useState(() => new OriginalShareAttempt());
  const originalContext = useRef<SelectedOriginalContext | null>(null), originalPanel = useRef<HTMLElement>(null), originalButton = useRef<HTMLButtonElement>(null), hadOriginalOptions = useRef(false);
  const [receivedNow, setReceivedNow] = useState(Date.now);
  const [receivedAccessRefresh] = useState(() => new ReceivedAccessRefresh());
  const [annotationError, setAnnotationError] = useState<{message: string; photoId?: string; originalSha256?: string} | null>(null);
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
  const [catalogCoverage, setCatalogCoverage] = useState<CatalogCoverage | null>(null);
  const catalogBrowse = useRef<{session: UnlockedVault; limit: number} | null>(null);
  const albumDetailPhoto = useRef<{session: UnlockedVault; photoId: string} | null>(null);
  const [consumerSelection] = useState(() => new ConsumerSelectionRetention());
  const browseFor = (session: UnlockedVault) => {
    if (catalogBrowse.current?.session !== session) catalogBrowse.current = {session, limit: 100};
    return {limit: catalogBrowse.current.limit, retainPhotoIds: [...new Set([...currentSelection.current, ...consumerSelection.idsFor(session, session.accountId, location.origin), ...(expiredSelection.current?.photoIdsFor(session.accountId) ?? []), ...(albumDetailPhoto.current?.session === session ? [albumDetailPhoto.current.photoId] : [])])]};
  };
  const [passwordFallback, setPasswordFallback] = useState(false);
  const [approvalAccount, setApprovalAccount] = useState<string>(), [deviceChallenge, setDeviceChallenge] = useState<DeviceChallengeV1>();
  const [approvalText, setApprovalText] = useState(""), [approvalReview, setApprovalReview] = useState<{challenge: DeviceChallengeV1; session: UnlockedVault; generation: number; origin: string}>();
  const approvalEpoch = useRef(0);
  const cancelApproval = () => {approvalEpoch.current++; cancelDeviceApproval(); setDeviceChallenge(undefined); setApprovalReview(undefined); setApprovalText("");};
  useEffect(() => {
    const clearApproval = () => {cancelApproval(); setApprovalAccount(undefined);};
    const hidden = () => {if (document.visibilityState === "hidden") clearApproval();};
    window.addEventListener("fotoro-lock", clearApproval); window.addEventListener("pagehide", clearApproval); document.addEventListener("visibilitychange", hidden);
    return () => {cancelDeviceApproval(); approvalEpoch.current++; window.removeEventListener("fotoro-lock", clearApproval); window.removeEventListener("pagehide", clearApproval); document.removeEventListener("visibilitychange", hidden);};
  }, []);
  useEffect(() => {if (!active) cancelApproval();}, [active]);
  useEffect(() => {
    if (!deviceChallenge) return;
    const deadline = deviceApprovalDeadline(deviceChallenge.enrollmentId) ?? Date.parse(deviceChallenge.expiresAt);
    const timer = window.setTimeout(() => {cancelApproval(); setStatus(authenticatedApprovalAccount() ? "This approval request expired. Request approval again." : "Sign in again to request device approval.");}, Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deviceChallenge]);
  useEffect(() => {setPasswordFallback(false);}, [account]);
  const [placesOpen, setPlacesOpen] = useState(false), [placeResources] = useState(() => new ConsumerPreviewResources());
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [albumsOpen, setAlbumsOpen] = useState(false), [albumSelection, setAlbumSelection] = useState<AlbumEntrySelection | null>(null);
  const [albumEntryRevision] = useState(() => new AlbumEntryRevision());
  const [albumDestination, setAlbumDestination] = useState<AlbumDestination | null>(null);
  const albumPanelKey = account + ":" + albumEntryRevision.key(incomingAlbum);
  const albumIncomingRef = useRef(incomingAlbum); albumIncomingRef.current = incomingAlbum;
  useEffect(() => {if (!active || !account) setPlacesOpen(false);}, [active, account]);
  useEffect(() => {if (!active || !account) setPeopleOpen(false);}, [active, account]);
  useEffect(() => {if (!active || !account) {setAlbumsOpen(false); setAlbumSelection(null); setAlbumDestination(null);}}, [active, account]);
  useEffect(() => () => placeResources.clear(), [placeResources]);
  const running = useRef(false),
    authIntent = useRef(0),
    pausedRef = useRef(true),
    intentVersion = useRef(0),
    uploadAbort = useRef<AbortController | null>(null),
    localSynced = useRef(new WeakMap<File, string>());
  const input = useRef<HTMLInputElement>(null), searchInput = useRef<HTMLInputElement>(null), scopeSelector = useRef<HTMLSelectElement>(null);
  const activeRef = useRef(active), saveIntentRef = useRef(saveIntent), incomingRef = useRef(incoming);
  const chosenTripRef = useRef(chosenTrip); chosenTripRef.current = chosenTrip;
  activeRef.current = active; saveIntentRef.current = saveIntent; incomingRef.current = incoming;
  const backButton = useRef<HTMLButtonElement>(null), passwordPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active) return;
    const target = account ? scopeSelector.current : passwordPanel.current?.querySelector<HTMLInputElement>('input[name="password"]');
    target?.focus({preventScroll: true});
  }, [active, account, recoveryNew]);
  const accountPanel = useRef<HTMLElement>(null), menuRef = useRef(menu);
  menuRef.current = menu;
  const closeAccountPanel = () => {authIntent.current++; cancelApproval(); menuRef.current = false; setMenu(false);};
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
  const currentSelection = useRef(selected), currentReceived = useRef(received);
  const currentPickedFiles = useRef(pickedFiles);
  const expiredSelection = useRef<ExpiredSavedSelection | null>(null);
  currentSelection.current = selected; currentReceived.current = received;
  currentPickedFiles.current = pickedFiles;
  const originalsCurrent = (context: SelectedOriginalContext) => originalContext.current === context && context.snapshot.current && activeRef.current &&
    document.visibilityState !== "hidden" && !currentReceived.current && sameVault(context.session) &&
    savedOriginalSelectionCurrent(context.snapshot.photos, currentCatalog.current, currentSelection.current, context.session.accountId);
  const cancelOriginals = () => {
    const context = originalContext.current;
    originalContext.current = null;
    context?.controller.abort(); context?.snapshot.dispose();
    setPreparedOriginals(null); setPreparingOriginals(false); setOriginalShareError("");
  };
  useDialogFocus(originalPanel, cancelOriginals, !!preparedOriginals);
  useEffect(() => {
    if (preparedOriginals) {hadOriginalOptions.current = true; return;}
    if (!hadOriginalOptions.current) return;
    hadOriginalOptions.current = false;
    const frame = requestAnimationFrame(() => originalButton.current?.focus({preventScroll: true}));
    return () => cancelAnimationFrame(frame);
  }, [preparedOriginals]);
  useEffect(() => {if (originalContext.current && !originalsCurrent(originalContext.current)) cancelOriginals();}, [photos, selected, active, account, received]);
  useEffect(() => {
    const hide = () => {if (document.visibilityState === "hidden") cancelOriginals();};
    document.addEventListener("visibilitychange", hide); window.addEventListener("pagehide", cancelOriginals);
    return () => {document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", cancelOriginals); cancelOriginals();};
  }, []);
  const allLocalFiles = [...new Set([...(saveIntent?.pending ? saveIntent.snapshot.files : []), ...pickedFiles])];
  const catalogDigests = new Set(photos.map(photo => photo.metadata.originalSha256));
  const localSources = new Map(localPhotos.flatMap(photo => photo.file ? [[photo.file, photo] as const] : []));
  const unsavedLocalFiles = allLocalFiles.filter(file => {
    const source = localSources.get(file), digest = source ? localOriginalDigest(source) : undefined;
    return localSynced.current.get(file) !== account && (!digest || !catalogDigests.has(digest));
  });
  const unlocked = (() => {try {return !!account && requireVault().accountId === account;} catch {return false;}})();
  const accountReference = account ? account.slice(0, 8) + "…" + account.slice(-4) : "";
  const publicDemo = fixtureMode || isPublicDemoAccount(account);
  const clear = () => {
    cancelOriginals();
    placeResources.clear();
    for (const photo of [...photos, ...(received ?? [])])
      photo.metadataKey.fill(0);
    setAccount("");
    setPhotos([]);
    setCatalogCoverage(null); catalogBrowse.current = null; consumerSelection.clear();
    setReceived(null);
    setReceivedContext(null);
    setSelected(new Set());
    setSelecting(false);
    setPickedFiles([]);
    localSynced.current = new WeakMap();
    setViewer(null);
    setExchange(false);
    setMenu(false);
    setPeopleOpen(false);
    setAlbumsOpen(false); setAlbumSelection(null); setAlbumDestination(null);
    setReselect(undefined);
    setPending([]);
    setAnnotationPending([]);
    setAnnotationError(null);
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
  // A lock can occur after render and before passive effects commit.
  const effectVault = () => {
    try {const session = requireVault(); if (session.accountId === account) return session;} catch {}
    clear(); onOwnedPhotos?.(null); onPhotoChanges?.(null);
    return undefined;
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
    } catch {if (account) {clear(); onOwnedPhotos?.(null); onPhotoChanges?.(null);}}
    const onLock = (event: Event) => {
      const detail = vaultLockDetail(event);
      if (detail?.reason === "expired" && detail.accountId && !currentReceived.current)
        expiredSelection.current = new ExpiredSavedSelection(detail.accountId, currentCatalog.current, currentSelection.current, currentPickedFiles.current);
      else if (detail?.reason !== "expired" && detail?.reason !== "unlock") expiredSelection.current = null;
      if (observed) pauseSync(observed);
      clear();
      if (detail?.reason === "expired") setStatus("Enter your Fotoro password again to continue.");
    };
    window.addEventListener("fotoro-lock", onLock);
    return () => window.removeEventListener("fotoro-lock", onLock);
  }, [photos, received]);
  const refresh = async (send = false, current = () => true, signal?: AbortSignal, diagnostic?: DiagnosticContext) => {
    const check = () => {signal?.throwIfAborted(); if (!current()) throw new DOMException("Save cancelled", "AbortError");};
    check();
    const session = requireVault();
    const browse = browseFor(session);
    const cached = await cachedSync(session, diagnostic, browse);
    check();
    if (!sameVault(session)) return;
    setPhotos(cached.photos);
    setCatalogCoverage(cached.coverage);
    const recoveredSelection = expiredSelection.current;
    expiredSelection.current = null;
    if (recoveredSelection) {
      setSelected(recoveredSelection.restore(cached.photos, session.accountId));
      setPickedFiles(recoveredSelection.filesFor(session.accountId));
    }
    setPending(cached.pending);
    setAnnotationPending(cached.annotations);
    setLastSuccessfulSync(cached.lastSuccessfulSync);
    setSkipped(cached.skipped);
    setSaveReady(session);
    if (send && pausedRef.current) {
      diagnostic?.incomplete("cancelled");
      setStatus("Saving is paused. Continue when you’re ready.");
      return;
    }
    if (!navigator.onLine) {
      diagnostic?.incomplete("network");
      setStatus(
        "Offline · your cached photos are available. Save when you’re online.",
      );
      return;
    }
    check();
    const result = await (send ? saveSync(session, signal, diagnostic) : refreshSync(session, browse));
    check();
    if (!sameVault(session)) return;
    if (send && catalogBrowse.current?.session === session) catalogBrowse.current.limit = Math.max(catalogBrowse.current.limit, result.photos.length);
    setPhotos((previous) => (sameVault(session) ? result.photos : previous));
    setCatalogCoverage(result.coverage);
    if (recoveredSelection) setSelected(previous => recoveredSelection.restore(result.photos, session.accountId, previous));
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
        const message = e instanceof ApiError && ["UNAUTHENTICATED", "HTTP_401"].includes(e.code)
          ? "Enter your Fotoro password again to continue." : e instanceof Error && e.message === "TRIP_SAVE_INCOMPLETE"
            ? "The chosen originals could not open for this trip. Retry to continue." : e instanceof Error && e.message === "PRF_UNAVAILABLE_USE_RECOVERY" && authenticatedApprovalAccount()
            ? "Signed in. Unlock with your Fotoro password or approve this device from an unlocked device." : e instanceof Error && e.message === "DEVICE_APPROVAL_EXPIRED"
            ? "This approval request expired. Request approval again." : e instanceof Error && e.message === "DEVICE_APPROVAL_REQUIRED"
            ? "Approval is not ready. Confirm it on your unlocked device, then try unlock again." : e instanceof Error && e.message === "INVALID_DEVICE_CHALLENGE"
            ? "This request is invalid, expired, or belongs to another account or site." : e instanceof Error && e.message === "DEVICE_COPY_UNAVAILABLE"
            ? "Copy is unavailable. Select and copy the public request below." : e instanceof Error && /INVALID_DEVICE_APPROVAL_RECEIPT|INVALID_DEVICE_COMPLETION|INVALID_DEVICE_SIGNATURE|DEVICE_BINDING_MISMATCH/.test(e.message)
            ? "This device approval could not be verified. Request approval again." : readableSyncError(e);
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
  const login = async (fn: (current: () => boolean) => Promise<unknown>, passkey = false, completingApproval = false) => {
    if (!completingApproval) {cancelApproval(); setApprovalAccount(undefined);}
    const request = saveIntentRef.current, version = authIntent.current;
    return run(async () => {
      const ticket = request?.beginAuthentication(vaultGeneration());
      const shareRequest = incomingRef.current, shareTicket = shareRequest?.beginAuthentication(vaultGeneration());
      const albumRequest = albumIncomingRef.current, albumTicket = albumRequest?.beginAuthentication(vaultGeneration());
      try {await fn(() => activeRef.current && authIntent.current === version);}
      catch (error) {if (passkey && !(error instanceof Error && error.name === "AbortError") && activeRef.current && authIntent.current === version) {setPasswordFallback(true); setApprovalAccount(authenticatedApprovalAccount());} request?.finishAuthentication(ticket, undefined, error); shareRequest?.finishAuthentication(shareTicket); albumRequest?.finishAuthentication(albumTicket); throw error;}
      if (!activeRef.current || authIntent.current !== version) {request?.cancel(); shareRequest?.cancel(); albumRequest?.cancel(); return;}
      let opened: {session: UnlockedVault; generation: number; origin: string};
      try {
        const session = requireVault();
        opened = {session, generation: vaultGeneration(), origin: location.origin};
        request?.finishAuthentication(ticket, {session, generation: vaultGeneration(), current: () => sameVault(session)});
        shareRequest?.finishAuthentication(shareTicket, session, vaultGeneration());
        albumRequest?.finishAuthentication(albumTicket, session, vaultGeneration());
        setAccount(session.accountId);
        setPasswordFallback(false);
        if (request?.pending && request.boundVault === session) setMenu(false);
      } catch {
        setPasswordFallback(true);
        request?.finishAuthentication(ticket);
        shareRequest?.finishAuthentication(shareTicket);
        albumRequest?.finishAuthentication(albumTicket);
        setStatus(
          "Enter your Fotoro password to unlock photos on this device.",
        );
        return;
      }
      await restorePause();
      const current = () => activeRef.current && authIntent.current === version &&
        vaultGeneration() === opened.generation && location.origin === opened.origin && sameVault(opened.session);
      try {await refresh(false, current);}
      catch (error) {
        if (!current()) return;
        if (!(error instanceof ApiTransportError)) throw error;
        let cached;
        try {cached = await cachedSync(opened.session, undefined, browseFor(opened.session));}
        catch (cacheError) {if (!current()) return; throw cacheError;}
        if (!current()) return;
        setStatus(cached.photos.length ? "Couldn’t connect. Showing saved photos." : "Couldn’t connect. Try again when you’re online.");
        setNeedsAttention(true);
      }
    }, true);
  };
  useEffect(() => {
    if (!account) return;
    const session = effectVault(); if (!session) return;
    void run(async () => {await restorePause(session); if (sameVault(session)) await refresh(false, () => sameVault(session));});
  }, [account]);
  useEffect(() => {
    if (!account) return;
    if (!effectVault()) return;
    return subscribeSavedRefresh(window, document, () => {void run(refresh);});
  }, [account]);
  useEffect(() => {
    if (!active || !account) return;
    const session = effectVault(); if (!session) return;
    const controller = new AbortController(), origin = location.origin;
    const current = () => activeRef.current && sameVault(session) && location.origin === origin && !controller.signal.aborted;
    const synchronize = () => {
      if (!current() || !navigator.onLine || document.visibilityState !== "visible") return;
      // Contact approval has its own encrypted queue; photo Pause does not pause it.
      void syncContacts(session, {signal: controller.signal, current}).catch(() => {});
    };
    synchronize();
    const refresh = subscribeSavedRefresh(window, document, synchronize), edits = subscribeContacts(synchronize);
    return () => {controller.abort(); refresh(); edits();};
  }, [active, account]);
  useEffect(() => {
    setReceivedNow(Date.now());
    if (!active || !account || !receivedContext) return;
    const session = effectVault(); if (!session) return;
    const captured = receivedContext;
    let alive = true;
    const current = () => alive && activeRef.current && document.visibilityState === "visible" && sameVault(session);
    const withdraw = () => {
      if (!current()) return;
      for (const photo of received ?? []) photo.metadataKey.fill(0);
      setReceived(null); setReceivedContext(null); setViewer(null); setSelected(new Set());
      setQuery(""); setCommittedMeaning(undefined);
      setStatus("These shared photos are no longer available. Copies you saved stay in your Fotoro.");
    };
    const recheck = () => {
      if (document.visibilityState !== "visible" || !current()) return;
      if (captured.grant.expiresAt && Date.parse(captured.grant.expiresAt) <= Date.now()) {withdraw(); return;}
      void receivedAccessRefresh.read(captured.grant, session, current).then(grant => {
        if (!current()) return;
        if (!grant) withdraw();
        else if (grant.version !== captured.grant.version || grant.expiresAt !== captured.grant.expiresAt) {
          setReceivedContext(previous => previous === captured ? {...captured, grant} : previous);
        }
      }).catch(error => {
        if (current() && error?.name !== "AbortError") setStatus("Shared photos could not be checked. Check your connection and try again.");
      });
    };
    recheck();
    const detach = subscribeSavedRefresh(window, document, recheck);
    const hide = () => {if (document.visibilityState !== "visible") receivedAccessRefresh.cancel();};
    const leave = () => receivedAccessRefresh.cancel();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    const remaining = captured.grant.expiresAt ? Date.parse(captured.grant.expiresAt) - Date.now() : null;
    const timer = remaining == null ? undefined : window.setTimeout(() => {setReceivedNow(Date.now()); recheck();}, Math.max(0, Math.min(remaining + 1, 2_147_483_647)));
    return () => {
      alive = false; receivedAccessRefresh.cancel(); detach();
      document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", leave);
      window.clearTimeout(timer);
    };
  }, [active, account, receivedContext]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => {window.removeEventListener("online", update); window.removeEventListener("offline", update);};
  }, []);
  const syncLocal = (snapshot?: ChosenSaveSnapshot, signal?: AbortSignal, current = () => true) =>
    run(() => diagnose("sync", async diagnostic => {
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
            await refresh(true, current, controller.signal, diagnostic);
          },
          unresolved: async () => {
            const queue = await pendingImports();
            if (!sameVault(session)) throw new Error("VAULT_LOCKED");
            return queue.some((item) => item.state !== "committed");
          },
          skipped: async (file, error) => {
            failures++; diagnostic.incomplete(diagnosticReason(error));
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
        if (result.stopped || failures) diagnostic.incomplete("unavailable");
        return !result.stopped && failures === 0;
      } finally {
        signal?.removeEventListener("abort", abort);
        if (uploadAbort.current === controller) uploadAbort.current = null;
        if (sameVault(session)) setStaging(0);
      }
    }, "save"));
  const startChosenSave = (request = saveIntentRef.current) => {
    if (!request?.pending) return Promise.resolve(false);
    // A failed cache activation can be retried explicitly without replacing the selection.
    if (!saveReady || !sameVault(saveReady)) return run(async () => {await restorePause(); await refresh();});
    return request.start({
      active: activeRef.current && document.visibilityState !== "hidden",
      busy: running.current,
      session: saveReady,
      current: () => activeRef.current && saveIntentRef.current === request && sameVault(saveReady) && document.visibilityState !== "hidden",
      save: async (snapshot, signal, current) => {
        setMenu(false);
        const trip = chosenTripRef.current?.request === request ? chosenTripRef.current : null;
        return continueChosenSave(snapshot, signal, current, syncLocal, trip ? () => run(async () => {
          const session = requireVault();
          const check = () => {signal.throwIfAborted(); if (!current() || chosenTripRef.current !== trip || !sameVault(session)) throw new DOMException("Trip selection changed", "AbortError");};
          check();
          const pending = await pendingImports(); check();
          const sources = resolveChosenTripSources({local: snapshot.photos, saved: trip.savedSources, owned: currentCatalog.current, pending, ownerAccountId: session.accountId, current});
          for (const source of sources) {check(); await cacheOwnedPhotoDetails(source, signal); check();}
          const browse = browseFor(session), ids = sources.map(source => source.photoId);
          const loaded = await cachedSync(session, undefined, {...browse, retainPhotoIds: [...new Set([...(browse.retainPhotoIds ?? []), ...ids])]});
          check();
          const selectedPhotos = chosenTripPhotos(sources, loaded.photos, session.accountId, current);
          check(); currentCatalog.current = loaded.photos; setPhotos(loaded.photos); setCatalogCoverage(loaded.coverage);
          currentSelection.current = new Set(ids); setSelected(new Set(ids));
          setAlbumDestination(null); openAlbums(selectedPhotos, null);
          return true;
        }) : undefined);
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
    void saveUploadPause(true, session).catch(() => {if (sameVault(session)) {setStatus("Pause could not be saved in this browser. Keep it open and try again."); setNeedsAttention(true);}});
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
  const ownedSnapshot = useMemo<OwnedPhotoSnapshot | null>(() => {
    if (!account) return null;
    let session;
    try {session = requireVault();} catch {return null;}
    if (session.accountId !== account) return null;
    const origin = location.origin;
    const current = () => sameVault(session) && location.origin === origin && currentCatalog.current === photos;
    const snapshot: OwnedPhotoSnapshot = {accountId: account, token: session, photos, coverage: catalogCoverage ?? undefined, current,
      get selectionReady() {return current() && !running.current;},
      sourceCurrent: source => sameVault(session) && currentCatalog.current.some(photo => !photo.grantId && photo.manifest.ownerAccountId === account
        && photo.manifest.photoId === source.manifest.photoId && photo.metadata.originalSha256 === source.metadata.originalSha256
        && photo.manifest === source.manifest && photo.metadata === source.metadata && photo.metadataKey === source.metadataKey),
      people: publicDemo ? undefined : async updates => {
      if (!current() || updates.some(update => !photos.includes(update.photo) || update.photo.grantId || update.photo.manifest.ownerAccountId !== account)) throw new Error("Photo source changed");
      for (const update of updates) await editAnnotations(update.photo, {people: update.assignments}, session);
    }, locate: publicDemo ? undefined : async updates => {
      if (!current()) throw new Error("VAULT_LOCKED");
      return editPhotoLocations(updates, session);
    }, edit: publicDemo ? undefined : async (photo, changes) => {
      if (!current() || !photos.includes(photo) || photo.manifest.ownerAccountId !== account || photo.grantId) throw new Error("VAULT_LOCKED");
      await editAnnotations(photo, changes, session);
    }, preview: async photo => {
      if (!current() || !photos.includes(photo) || photo.manifest.ownerAccountId !== account || photo.grantId) throw new Error("VAULT_LOCKED");
      if (!photo.manifest.representations.some(representation => representation.binding.kind === "preview")) throw new Error("Saved preview unavailable.");
      const bytes = await photoBytes(photo, "preview");
      try {if (!current()) throw new Error("VAULT_LOCKED"); return new Blob([new Uint8Array(bytes)], {type: "image/jpeg"});}
      finally {bytes.fill(0);}
    }};
    snapshot.retainSelection = consumerSelection.bind(snapshot, origin, () => location.origin);
    return snapshot;
  }, [account, photos, publicDemo, catalogCoverage, busy, consumerSelection]);
  useEffect(() => {placeResources.clear();}, [ownedSnapshot?.token, ownedSnapshot?.photos, placeResources]);
  useEffect(() => {onOwnedPhotos?.(ownedSnapshot);}, [ownedSnapshot, onOwnedPhotos]);
  const currentOwnedSnapshot = useRef(ownedSnapshot); currentOwnedSnapshot.current = ownedSnapshot;
  const photoChanges = useMemo<ConsumerPhotoChanges | null>(() => {
    if (!account || publicDemo) return null;
    let session;
    try {session = requireVault();} catch {return null;}
    if (session.accountId !== account) return null;
    return {token: session, accountId: session.accountId, current: () => sameVault(session), pending: annotationPending, busy,
      error: annotationError?.message ?? "",
      errorSource: annotationError?.photoId && annotationError.originalSha256 ? {photoId: annotationError.photoId, originalSha256: annotationError.originalSha256} : undefined,
      save: async () => sameVault(session) ? saveAnnotationChanges(session) : false,
      review: () => {if (sameVault(session)) setMenu(true);},
    };
  }, [account, publicDemo, annotationPending, busy, annotationError]);
  useEffect(() => {onPhotoChanges?.(photoChanges);}, [photoChanges, onPhotoChanges]);
  const searchable = received ?? photos;
  const catalogIncomplete = !!catalogCoverage && (catalogCoverage.hasMore || catalogCoverage.hasMoreChanges !== false);
  const peopleRecords = useMemo(() => cloudSearchRecords(searchable), [searchable]);
  const peopleFind = usePeopleFilter(peopleRecords, receivedContext ?? ownedSnapshot?.token ?? account);
  const [recentOnly, setRecentOnly] = useState(true);
  useEffect(() => {setRecentOnly(true);}, [account]);
  const recentActive = !received && recentBrowseActive(recentOnly, query);
  const familyFilter = peopleFind.filter.ids.size > 0;
  const permitted = useMemo(() => peopleMatchingPhotoIDs(peopleRecords.filter(photo => !recentActive || inRecentSelectedRange(photo)), peopleFind.filter), [peopleRecords, peopleFind.filter, recentActive]);
  const index = useMemo(() => new PhotoSearchIndex(peopleRecords), [peopleRecords]);
  const lexicalSearchResult = useMemo(() => index.search(query, {scope: "account:" + account, allowedIds: permitted, committedMeaning}), [index, query, account, committedMeaning, permitted]);
  const peoplePhotos = useMemo(() => savedSearchPhotos(ownedSnapshot, []), [ownedSnapshot]);
  const peopleEligibleIDs = useMemo(() => new Set([...(normalizeSearch(query) ? peopleMetadataMatches(lexicalSearchResult) : permitted)].map(id => "saved:" + id)), [query, lexicalSearchResult, permitted]);
  const latestPeoplePhotos = useRef(peoplePhotos); latestPeoplePhotos.current = peoplePhotos;
  const findPhotos = useMemo(() => peoplePhotos.map(photo => ({...photo, id: photo.id.slice(6)})).filter(photo => permitted.has(photo.id)), [peoplePhotos, permitted]);
  const semanticSearchResult = useSemanticFind(findPhotos, lexicalSearchResult, active && unlocked && !received, ownedSnapshot?.token, committedMeaning);
  const searchResult = useMemo(() => peopleFilteredResult(semanticSearchResult, permitted), [semanticSearchResult, permitted]);
  const findMatches = useMemo(() => findMatchPhotos(findPhotos, searchResult), [findPhotos, searchResult]);
  const bestShots = useFindBestShots(findMatches, normalizeSearch(query) && !received ? JSON.stringify([query, searchResult.scope, searchResult.meaning?.id, [...peopleFind.filter.ids].sort(), peopleFind.filter.mode]) : "", ownedSnapshot,
    () => activeRef.current && !!ownedSnapshot?.current(), active && unlocked && !received);
  const filteredSearchResult = bestShots.active ? shortlistSearchResult(searchResult, bestShots.recommendations) : searchResult;
  const searchableById = useMemo(() => {
    const byId = new Map<string, Photo>();
    for (const photo of searchable) if (!byId.has(photo.manifest.photoId)) byId.set(photo.manifest.photoId, photo);
    return byId;
  }, [searchable]);
  const shown = useMemo(() => normalizeSearch(query)
    ? filteredSearchResult.photoIds.flatMap(id => {const photo = searchableById.get(id); return photo ? [photo] : [];})
    : searchable.filter(photo => permitted.has(photo.manifest.photoId)), [query, filteredSearchResult, searchableById, searchable, permitted]);
  const selectionInput = useMemo(() => ({shown, query, filter: peopleFind.filter, token: ownedSnapshot?.token, received}), [shown, query, peopleFind.filter, ownedSnapshot?.token, received]);
  const latestSelectionInput = useRef(selectionInput); latestSelectionInput.current = selectionInput;
  const applyPeople = async (updates: PeopleUpdate[]) => {
    const snapshot = ownedSnapshot;
    if (!snapshot?.current() || !snapshot.people || !activeRef.current) throw new Error("Saved library is read-only");
    const saved = updates.map(update => {
      if (!peopleSourceCurrent(update.photo, latestPeoplePhotos.current.find(photo => photo.id === update.photo.id))) throw new Error("Photo source changed");
      const photo = snapshot.photos.find(photo => !photo.grantId && photo.manifest.photoId === update.photo.id.slice(6) && photo.manifest.ownerAccountId === snapshot.accountId && photo.metadata.originalSha256 === update.photo.digest);
      if (!photo) throw new Error("Photo source changed");
      return {photo, assignments: update.assignments};
    });
    await snapshot.people(saved);
  };
  const viewing = !!viewer && shown.some(photo => photo.manifest.photoId === viewer);
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
  const editAnnotations = async (photo: Photo, changes: {labels?: string[]; favorite?: boolean; location?: PhotoLocationV1; observation?: PhotoObservationV1; people?: PeopleAssignment[]}, session = requireVault()) => {
    if (!sameVault(session) || !currentCatalog.current.includes(photo) || photo.grantId || photo.manifest.ownerAccountId !== session.accountId) throw new Error("VAULT_LOCKED");
    try {
      setAnnotationError(null);
      const {location, observation, people, ...patch} = changes;
      const identity = {ownerAccountId: photo.manifest.ownerAccountId, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256};
      if (location && !await queuePhotoLocation(identity, location, session)) throw new Error("Photo location changed");
      if (observation) await queuePhotoObservation(identity, observation, session);
      if (people) await queuePhotoPeople(identity, people, session);
      if (Object.keys(patch).length) await queueAnnotations(identity, patch, session);
      await publishLocalAnnotations([photo], session);
    } catch (error) {if (sameVault(session)) {
      const message = "Changes could not be kept on this device. Try again.";
      setAnnotationError({message, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256});
      setStatus(message); setNeedsAttention(true);
    } throw error;}
  };
  const editPhotoLocations = async (updates: readonly {photo: Photo; location: PhotoLocationV1}[], session = requireVault()) => {
    const sources: Photo[] = [], seen = new Set<string>();
    let failed = 0;
    for (const {photo, location} of updates) {
      if (!sameVault(session)) throw new Error("VAULT_LOCKED");
      if (!currentCatalog.current.includes(photo) || photo.grantId || photo.manifest.ownerAccountId !== session.accountId
        || annotationLocation(photo.annotations ?? {}) || seen.has(photo.manifest.photoId)) {failed++; continue;}
      seen.add(photo.manifest.photoId);
      try {
        const accepted = await queuePhotoLocation({ownerAccountId: session.accountId, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256}, location, session);
        if (!sameVault(session)) throw new Error("VAULT_LOCKED");
        if (accepted) sources.push(photo); else failed++;
      } catch (error) {if (!sameVault(session)) throw error; failed++;}
    }
    if (sources.length) await publishLocalAnnotations(sources, session);
    if (!sameVault(session)) throw new Error("VAULT_LOCKED");
    return {applied: sources.length, failed, updatedPhotoIDs: sources.map(photo => photo.manifest.photoId)};
  };
  const applyTimelineLocations = async (candidates: readonly TimelineCandidate[]) => {
    const snapshot = ownedSnapshot;
    if (!snapshot?.current() || !snapshot.locate) throw new Error("VAULT_LOCKED");
    const eligible = currentTimelineCandidates(candidates, findPhotos);
    const updates = eligible.flatMap(candidate => {
      const photo = snapshot.photos.find(photo => photo.manifest.photoId === candidate.photoID);
      return photo ? [{photo, location: candidate.location}] : [];
    });
    return {...await snapshot.locate(updates), needsSave: true};
  };
  const saveAnnotationChanges = async (session = requireVault()) => {
    if (!sameVault(session) || publicDemo || running.current) return false;
    let failure = "Changes could not be saved. Check your connection and try again.";
    const saved = await run(async () => {
      try {
        const result = await saveQueuedAnnotations(session, () => sameVault(session), browseFor(session));
        if (!sameVault(session)) return false;
        setPhotos(result.photos); setCatalogCoverage(result.coverage); setAnnotationPending(result.annotations);
      }
      catch (error) {failure = readableSyncError(error); throw error;}
    });
    if (sameVault(session)) {
      setAnnotationError(saved ? null : {message: failure});
      if (saved) {setStatus(""); setNeedsAttention(false);}
    }
    return saved;
  };
  useEffect(() => {
    if (!account || publicDemo) return;
    const session = effectVault(); if (!session) return;
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
  const selectBestShots = () => {
    if (running.current || !bestShots.active || bestShots.busy || !bestShots.recommendations || !ownedSnapshot?.current() || !activeRef.current || currentReceived.current || preparingOriginals || sharingOriginals) return;
    const ids = selectionCandidates(findMatches, bestShots.recommendations).map(photo => photo.id);
    setSelected(previous => ownedSnapshot.current() ? new Set([...previous, ...ids]) : previous);
    setSelecting(true);
  };
  const selectResults = () => {
    if (running.current || !activeRef.current || latestSelectionInput.current !== selectionInput || received || !ownedSnapshot?.current() || preparingOriginals || sharingOriginals || searchResult.searching || bestShots.busy) return;
    const ids = shown.filter(photo => currentCatalog.current.includes(photo) && !photo.grantId && photo.manifest.ownerAccountId === ownedSnapshot.accountId
      && (ownedSnapshot.sourceCurrent?.(photo) ?? true)).map(photo => photo.manifest.photoId);
    setSelected(new Set(ids)); setSelecting(true);
  };
  const prepareSelectedOriginals = async (items = chosen) => {
    if (running.current || originalContext.current || originalShareAttempt.pending || !items.length || received || !activeRef.current || document.visibilityState === "hidden") return;
    const session = requireVault(), ids = new Set(items.map(photo => photo.manifest.photoId));
    if (!savedOriginalSelectionCurrent(items, currentCatalog.current, ids, session.accountId)) return;
    currentSelection.current = ids; setSelected(ids);
    const context = {snapshot: new ShareSelection(items), session, controller: new AbortController()};
    originalContext.current = context;
    setPreparingOriginals(true); setStatus(""); setOriginalShareError("");
    try {
      const files = await prepareSavedOriginals(context.snapshot.photos, context.controller.signal, () => originalsCurrent(context), photoBytes, (bytes, photo) => cameraOriginalFiles(bytes, photo.metadata));
      if (originalsCurrent(context)) setPreparedOriginals({files, context});
    } catch (error) {
      if (originalsCurrent(context) && (error as Error).name !== "AbortError") setStatus("Photos could not be prepared. Check your connection and try again.");
      if (originalContext.current === context) cancelOriginals();
    } finally {if (originalContext.current === context) setPreparingOriginals(false);}
  };
  const sendSelectedOriginals = (prepared: NonNullable<typeof preparedOriginals>, download = false) => {
    if (originalShareAttempt.pending || sharingOriginals || !originalsCurrent(prepared.context)) return;
    const current = () => originalsCurrent(prepared.context);
    setSharingOriginals(true); setStatus(""); setOriginalShareError("");
    const result = download ? originalShareAttempt.runFiles(prepared.files, current, {canShare: () => false, download: downloadOriginal})
      : originalShareAttempt.runFiles(prepared.files, current);
    void result.then(outcome => {
      if (current() && outcome !== "cancelled" && outcome !== "busy") {
        cancelOriginals(); if (outcome === "downloaded") setStatus("Original downloads started.");
      }
    }).catch(() => {if (current()) setOriginalShareError(download ? "The originals could not be downloaded. Try again." : "Sharing could not finish. You can download the originals instead.");})
      .finally(() => setSharingOriginals(false));
  };
  const toggleSelection = (id: string) => {
    if (running.current) return;
    setSelected(previous => {
    if (running.current) return previous;
    const next = new Set(previous);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
    });
  };
  const openSharing = (items: Photo[] = []) => {setExchangePhotos([...items]); setExchangeVersion(version => version + 1); setExchange(true);};
  const closeSharing = () => {setExchange(false); setExchangePhotos([]); onShareDone?.(); onIncomingDone?.();};
  const priorIncoming = useRef(incoming);
  useEffect(() => {
    const previous = priorIncoming.current; priorIncoming.current = incoming;
    if (previous && !incoming) {setExchange(false); setExchangePhotos([]);}
    if (!active || !account || !incoming?.pending) return;
    const session = effectVault(); if (!session) return; incoming.bindInitialVault(session);
    if (incoming.current(session)) openSharing();
  }, [active, account, incoming]);
  const priorAlbumIncoming = useRef(incomingAlbum);
  useEffect(() => {
    const previous = priorAlbumIncoming.current; priorAlbumIncoming.current = incomingAlbum;
    if (previous && !incomingAlbum) {setAlbumsOpen(false); setAlbumSelection(null);}
    if (!active || !account || !incomingAlbum?.pending) return;
    const session = effectVault(); if (!session) return; incomingAlbum.bindInitialVault(session);
    if (incomingAlbum.current(session)) openAlbums();
  }, [active, account, incomingAlbum]);
  const openAlbums = (selection: Photo[] = [], destination: string | null | undefined = albumDestination?.current() ? albumDestination.albumId : undefined) => {
    if (selection.length > 100) {setStatus("Choose up to 100 photos to add to a trip."); return;}
    cancelOriginals(); setViewer(null); setExchange(false); setExchangePhotos([]); setPeopleOpen(false); setPlacesOpen(false); setMenu(false); menuRef.current = false;
    if (destination && albumDestination?.albumId !== destination) return;
    setAlbumSelection(albumEntryRevision.capture(selection)); setAlbumsOpen(true);
  };
  const closeAlbums = () => {setAlbumsOpen(false); setAlbumSelection(null); setAlbumDestination(null); onAlbumDone?.();};
  useEffect(() => {if (active && account && albumPhotos?.length) {setAlbumDestination(null); openAlbums(albumPhotos, null);}}, [active, account, albumPhotos]);
  useEffect(() => {
    if (!active || !account || !sharePhotos?.length) return;
    openSharing(sharePhotos);
  }, [active, account, sharePhotos]);
  const tripPhotoCount = active && document.visibilityState !== "hidden" && saveIntent?.pending && chosenTrip?.request === saveIntent
    && saveIntent.snapshot.photos.every(photo => photo.current?.() !== false)
    ? saveIntent.snapshot.files.length + new Set(chosenTrip.savedSources.map(source => source.photoId)).size : 0;
  return (
    <>
      <main className={"cloud-library" + (selecting ? " exchange-selection" : "")} aria-busy={searchResult.searching || undefined} inert={viewing || exchange || menu || preparedOriginals || placesOpen || peopleOpen || albumsOpen ? true : undefined}>
        <header className="consumer-navigation">
          {unlocked ? <nav className="consumer-scope-menu" aria-label="Photo library"><select ref={scopeSelector} aria-label="Photo library" value={received ? "shared" : "saved"} onChange={event => {
            if (event.target.value === "photos") onBack();
            else if (event.target.value === "places") setPlacesOpen(true);
            else if (event.target.value === "shared") openSharing();
            else if (event.target.value === "albums") openAlbums(albumDestination?.current() ? chosen : []);
            else {setReceived(null); setReceivedContext(null); setQuery(""); setCommittedMeaning(undefined);}
          }}><option value="photos">Photos</option><option value="saved">Saved</option><option value="shared">Shared</option><option value="places">Places</option>{!publicDemo && <option value="albums">Trips</option>}</select></nav> : <h1>Fotoro</h1>}
          <div className="header-actions">
          {!unlocked && <button
            ref={backButton}
            onClick={() => {
              cancelApproval(); setApprovalAccount(undefined);
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
            <>
            {!received && photos.length > 0 && <button disabled={busy} aria-pressed={selecting} onClick={() => {if (!running.current) setSelecting(value => !value);}}>{selecting ? "Done" : "Select"}</button>}
            {!received && <button className="menu-button" onClick={() => {setReselect(undefined); input.current?.click();}} aria-label="Add photos" disabled={busy || publicDemo}><PlusIcon /></button>}
            <button className="menu-button" aria-label="Settings" onClick={() => setMenu(!menu)}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="12" cy="12" r="3" /><path d="m9 3 1 2h4l1-2 3 2-1 2 2 3 2 1v3l-2 1-2 3 1 2-3 2-1-2h-4l-1 2-3-2 1-2-2-3-2-1v-3l2-1 2-3-1-2z" />
              </svg>
            </button>
            </>
          )}
          </div>
        </header>
        {incomingError && <p className="hint share-link-error" role="status">{incomingError}</p>}
        {!unlocked ? (
          <section className="unlock sync-onboarding" ref={passwordPanel}>
            {incoming?.pending && <p className="hint">{incoming.link.kind === "moment" ? "Enter the Fotoro password this photo invitation was sent to." : "Enter your Fotoro password to accept this contact."}</p>}
            {incomingAlbum?.pending && <p className="hint">Sign in to the Fotoro account invited to this album.</p>}
            <AccountAccess
              heading={tripPhotoCount ? `Add ${tripPhotoCount} ${tripPhotoCount === 1 ? "photo" : "photos"} to a trip` : undefined}
              passwordFallback={passwordFallback}
              password={recovery}
              onPassword={setRecovery}
              generatedPassword={recoveryNew}
              busy={busy}
              onSignIn={() => {
                void login(async current => {await recover(recovery, current); setRecovery("");});
              }}
              onPasskey={window.isSecureContext && "PublicKeyCredential" in window
                ? () => {void login(current => passkeyLogin(current), true);} : undefined}
              onAnotherAccount={window.isSecureContext && "PublicKeyCredential" in window
                ? () => {void login(current => passkeyLogin(current, {discoverAccount: true}), true);} : undefined}
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

            {approvalAccount && authenticatedApprovalAccount() === approvalAccount && <details open onToggle={event => {if (event.target === event.currentTarget && !event.currentTarget.open) cancelApproval();}}>
              <summary>Unlock with another device</summary>
              <p className="hint">Use a device where this Fotoro account is already unlocked.</p>
              {!deviceChallenge ? <button disabled={busy} onClick={() => {const epoch = approvalEpoch.current; void run(async () => {
                const current = () => activeRef.current && document.visibilityState !== "hidden" && approvalEpoch.current === epoch && authenticatedApprovalAccount() === approvalAccount;
                try {const challenge = await requestDeviceApproval(current); if (current()) setDeviceChallenge(challenge);}
                catch (error) {
                  if (error instanceof ApiError && error.status === 401 && approvalEpoch.current === epoch) {cancelApproval(); setApprovalAccount(undefined); throw error;}
                  if (!current()) return false; throw error;
                }
              }, true);}}>Request approval</button> : <>
                <p className="hint">On your unlocked device, open Settings → Open on another device → Approve a device. Paste this public request and confirm only if it came from you. Keep this page open.</p>
                <textarea aria-label="Public device approval request" readOnly value={JSON.stringify(deviceChallenge)} />
                <p className="hint">Request {deviceChallenge.challenge.slice(0, 12)} · Expires {new Date(deviceApprovalDeadline(deviceChallenge.enrollmentId) ?? deviceChallenge.expiresAt).toLocaleTimeString()}.</p>
                <button disabled={busy} onClick={() => {const text = JSON.stringify(deviceChallenge), epoch = approvalEpoch.current; void run(async () => {
                  if (approvalEpoch.current !== epoch || !activeRef.current || document.visibilityState === "hidden") return false;
                  if (!navigator.clipboard) throw new Error("DEVICE_COPY_UNAVAILABLE");
                  try {await navigator.clipboard.writeText(text);}
                  catch {if (approvalEpoch.current !== epoch) return false; throw new Error("DEVICE_COPY_UNAVAILABLE");}
                  if (approvalEpoch.current === epoch) setStatus("Public request copied.");
                });}}>Copy public request</button>
                <button className="primary-action" disabled={busy} onClick={() => {const challenge = deviceChallenge, epoch = approvalEpoch.current; void login(async current => {
                  if (approvalEpoch.current !== epoch || authenticatedApprovalAccount() !== approvalAccount) throw new DOMException("Device approval cancelled", "AbortError");
                  try {await unlockVault({kind: "trustedDevice", enrollmentId: challenge.enrollmentId});}
                  catch (error) {
                    if (deviceApprovalDeadline(challenge.enrollmentId) === undefined) cancelApproval();
                    if (error instanceof ApiError && error.status === 401) setApprovalAccount(undefined);
                    throw error;
                  }
                  // Successful unlock emits the normal lock event, clearing the public UI.
                  if (!current()) {lockVault(); throw new DOMException("Device approval cancelled", "AbortError");}
                }, false, true);}}>I approved it — unlock</button>
              </>}
              <button onClick={cancelApproval}>Cancel request</button>
            </details>}

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
            {(photos.length > 0 || !!received?.length || !!query) && <div className="photo-browse-toolbar"><div className="consumer-search">
              <SearchIcon />
              <input ref={searchInput} aria-label="Search photos" placeholder="Search photos" value={query} onChange={event => {setQuery(event.target.value); setCommittedMeaning(undefined);}} />
              {query && <button onClick={() => {setQuery(""); setCommittedMeaning(undefined); searchInput.current?.focus();}} aria-label="Clear search">×</button>}
            </div>
            {!received && photos.length > 0 && <details className="photo-browse-filters" onKeyDown={event => {
              if (event.key === "Escape") {event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();}
            }}><summary>Filters<span className="photo-browse-filter-state">{[
              recentBrowseActive(true, query) ? recentOnly ? "Last 30 days" : catalogIncomplete ? "All loaded photos" : "All photos" : undefined,
              familyFilter ? `${peopleFind.filter.ids.size} ${peopleFind.filter.ids.size === 1 ? "person" : "people"}${peopleFind.filter.mode === "everyone" ? " · Everyone" : ""}` : undefined,
            ].filter(Boolean).join(" · ")}</span></summary><div className="photo-browse-filter-options">
              {recentBrowseActive(true, query) && <label className="local-check"><input type="checkbox" checked={recentOnly} disabled={preparingOriginals || sharingOriginals} onChange={event => setRecentOnly(event.target.checked)} />Last 30 days</label>}
              <PeopleFilter people={peopleFind.people} value={peopleFind.filter} onChange={peopleFind.change}
                disabled={preparingOriginals || sharingOriginals} onReview={!publicDemo ? () => setPeopleOpen(true) : undefined} />
            </div></details>}
            </div>}
            {!received && photos.length > 0 && (familyFilter || normalizeSearch(query)) && <div className="photo-browse-result-actions"><button disabled={busy || preparingOriginals || sharingOriginals || searchResult.searching || bestShots.busy || !shown.length} onClick={selectResults}>Select {shown.length} {shown.length === 1 ? "photo" : "photos"}</button></div>}
            {!received && catalogIncomplete && <div className="hint" aria-label="Saved coverage"><p role="status">{catalogCoverage!.loaded} Saved {catalogCoverage!.loaded === 1 ? "photo loaded" : "photos loaded"}. Date, search and People filters cover loaded photos only.</p><button disabled={busy || preparingOriginals || sharingOriginals} onClick={() => void run(async () => {
              const session = requireVault(); browseFor(session);
              catalogBrowse.current!.limit += 100;
              await refresh(false, () => sameVault(session));
            })}>Load more Saved photos</button></div>}
            {!received && (busy || localCount > 0 || summary.pending > 0 || summary.failed > 0 || needsAttention || annotationPending.length > 0) && <section className={"consumer-save-progress state-" + consumerSummary.state} aria-label="Save progress">
              <div><p role="status">{status || syncStateLabel[consumerSummary.state]}</p>{consumerSummary.detail && <p className="hint">{consumerSummary.detail}</p>}</div>
              <div className="actions">
                {busy && !paused && <button onClick={pause}>Pause</button>}
                {!busy && (saveIntent?.pending || localCount > 0 || summary.pending > 0 || summary.failed > 0 || annotationPending.length > 0) && <button className="primary-action" disabled={publicDemo} onClick={() => {if (annotationPending.some(edit => edit.conflict)) setMenu(true); else if (saveIntent?.pending) void startChosenSave(); else if (localCount > 0) void syncLocal(); else void retry();}}>{annotationPending.some(edit => edit.conflict) ? "Review changes" : needsAttention || summary.failed ? "Retry" : localCount > 0 ? `Save ${localCount}` : summary.pending > 0 ? "Continue" : "Save changes"}</button>}
                {!busy && needsAttention && <button onClick={() => setMenu(true)}>Details</button>}
              </div>
            </section>}
            {received && (
              <div className="received-bar">
                <span>{receivedContext ? <><strong>{received.length} {received.length === 1 ? "photo" : "photos"} from {receivedContext.sender}</strong><small>{grantState(receivedContext.grant, receivedNow)} · open a photo to Save your own copy</small></> : "Shared photos · open a photo to Save"}</span>
                <button
                  onClick={() => {
                    setReceived(null);
                    setReceivedContext(null);
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
            {normalizeSearch(query) && !received && (findMatches.length > 0 || bestShots.active) && <FindBestShots total={findMatches.length} review={bestShots} showCount onSelect={selectBestShots} disabled={busy || preparingOriginals || sharingOriginals} />}
            {shown.length ? (
              <>
              {normalizeSearch(query) && visualSearchFeedback(searchResult) && <p className="hint" role="status">{visualSearchFeedback(searchResult)}</p>}
              <Library
                active={active}
                photos={shown}
                selected={selected}
                selecting={selecting}
                selectionDisabled={busy}
                reasons={bestShots.active ? bestShots.recommendations?.reasons : undefined}
                onSelect={toggleSelection}
                onOpen={id => selecting && !received ? toggleSelection(id) : setViewer(id)}
              />
              </>
            ) : (
              <div className="empty" aria-busy={searchResult.searching || undefined}>
                <p role={searchResult.searching || searchResult.visualStatus ? "status" : undefined}>
                  {searchResult.searching ? "Searching photos…" : visualSearchFeedback(searchResult) ?? (bestShots.active ? bestShots.busy ? "Choosing best shots…" : "No best shots to suggest" : query || familyFilter
                    ? catalogIncomplete && !received ? "No matching loaded photos" : "No matching photos"
                    : received
                      ? "No received photos"
                      : recentActive && photos.length ? catalogIncomplete ? "No loaded photos in the last 30 days" : "No photos in the last 30 days" : "Your Saved photos will appear here")}
                </p>
                {bestShots.active && <p className="hint">All matches remain available. You choose what to Share.</p>}
                {recentActive && photos.length > 0 && <button onClick={() => setRecentOnly(false)}>Show all photos</button>}
                {!query && !familyFilter && !received && !photos.length && <button onClick={onBack}>Choose photos to Save</button>}
                {query && (
                  <button onClick={() => setQuery("")}>Clear search</button>
                )}
              </div>
            )}
            {!received && selected.size > 0 && <div className="consumer-selection glass" aria-label="Selected photos">
              <span role="status">{selected.size} selected</span>
              <AlbumContinuation destination={albumDestination} photos={chosen} disabled={busy || preparingOriginals || sharingOriginals || chosen.length > 100} onContinue={(items, albumId) => {if (!running.current) openAlbums(items, albumId);}} />
              <button ref={originalButton} className="primary-action" disabled={busy || preparingOriginals || sharingOriginals} onClick={() => void prepareSelectedOriginals()}>{preparingOriginals ? "Preparing…" : "Share"}</button>
              {!publicDemo && !albumDestination?.current() && <button disabled={busy || preparingOriginals || sharingOriginals || chosen.length > 100} onClick={() => {if (!running.current) openAlbums(chosen);}}>Add to trip</button>}
              {chosen.length > 100 && <small>Choose up to 100 photos to add to a trip.</small>}
              <details className="selection-more" onKeyDown={event => {if (event.key === "Escape") {event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();}}}>
                <summary>More</summary><div><button disabled={busy || preparingOriginals || sharingOriginals} onClick={() => {if (!running.current) openSharing(chosen);}}>Share in Fotoro</button>
                <button disabled={busy || sharingOriginals} onClick={() => {if (!running.current) setSelected(new Set());}}>Clear selection</button></div>
              </details>
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
        {busy && (!unlocked || received) && (
          <p className="busy" role="status">
            {unlocked ? "Opening photos…" : "Opening Fotoro…"}
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
              {(saveIntent?.pending || localCount > 0 || summary.pending || summary.failed || annotationPending.length > 0) && <button className="primary-action" disabled={busy || publicDemo} onClick={() => {if (saveIntent?.pending) void startChosenSave(); else if (localCount > 0) void syncLocal(); else void retry();}}>
                {needsAttention && saveIntent?.pending ? "Retry" : localCount > 0 ? `Save ${localCount} selected ${localCount === 1 ? "photo" : "photos"}` : summary.pending || summary.failed ? "Continue" : "Save changes"}
              </button>}
              {!paused && busy && <button onClick={pause}>Pause</button>}
              <button onClick={closeAccountPanel}>Saved photos</button>
            </div>
            <details>
              <summary>Open on another device</summary>
              <p className="hint">Open <a href="https://fotoro.cloud/saved" target="_blank" rel="noopener">fotoro.cloud/saved</a> and enter the same Fotoro password. In another Fotoro app, choose Saved.</p>
              {window.isSecureContext && "PublicKeyCredential" in window && <button disabled={busy || publicDemo} onClick={() => {const version = authIntent.current; void run(async () => {
                const ready = await addPasskey(() => activeRef.current && menuRef.current && authIntent.current === version);
                setStatus(ready ? "Passkey added. Choose Use a passkey on your other device." : "Passkey added. Keep your Fotoro password to unlock photos on another device.");
              }, true);}}>Add a passkey</button>}
              <p className="hint">Automatic sync enabled in the Fotoro app can add photos here too. Photos opened in this browser stay here until you choose Save.</p>
              <details onToggle={event => {if (event.target === event.currentTarget && !event.currentTarget.open) {setApprovalText(""); setApprovalReview(undefined); approvalEpoch.current++;}}}>
                <summary>Approve a device</summary>
                <p className="hint">Paste the public approval request from your other device.</p>
                <textarea aria-label="Device approval request to review" value={approvalText} disabled={busy} onChange={event => {approvalEpoch.current++; setApprovalText(event.target.value); setApprovalReview(undefined);}} />
                <button disabled={busy || !approvalText.trim()} onClick={() => {const epoch = approvalEpoch.current; void run(async () => {
                  if (!activeRef.current || !menuRef.current || document.visibilityState === "hidden" || approvalEpoch.current !== epoch) return false;
                  const session = requireVault(), challenge = reviewDeviceChallenge(approvalText); setApprovalReview({challenge, session, generation: vaultGeneration(), origin: location.origin});
                });}}>Review request</button>
                {approvalReview && <>
                  <p className="hint">This request is for your current Fotoro account at {approvalReview.challenge.origin}. Request {approvalReview.challenge.challenge.slice(0, 12)} · Device {approvalReview.challenge.deviceId}. Expires {new Date(approvalReview.challenge.expiresAt).toLocaleTimeString()}.</p>
                  <p className="hint">Confirm that this exact request came from your device. Approval gives that device access to your photos.</p>
                  <button className="primary-action" disabled={busy || publicDemo} onClick={() => {const reviewed = approvalReview, epoch = approvalEpoch.current; void run(async () => {
                    const current = () => activeRef.current && menuRef.current && document.visibilityState !== "hidden" && approvalEpoch.current === epoch && sameVault(reviewed.session) && vaultGeneration() === reviewed.generation && location.origin === reviewed.origin;
                    try {await approveDeviceChallenge(JSON.stringify(reviewed.challenge), current);}
                    catch (error) {if (!current()) return false; throw error;}
                    if (current()) {setApprovalReview(undefined); setApprovalText(""); setStatus("Device approved. Return to that device and choose unlock.");}
                  }, true);}}>Confirm and approve my device</button>
                </>}
              </details>
            </details>
            <details>
              <summary>Settings</summary>
              <CopyDiagnostics />
              <button disabled={busy} onClick={() => {void run(refresh);}}>Refresh saved photos</button>
              <button
                onClick={() => {
                  lockVault();
                  setMenu(false);
                }}
              >
                Lock
              </button>
              {received && <button onClick={() => {openSharing(); setMenu(false);}}>Shared photos</button>}
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
                  const origin = location.origin;
                  const result = await clearBrowserSession();
                  setMenu(false);
                  setStatus("This browser is cleared.");
                  void result.remote.then(confirmed => {
                    if (!running.current && vaultGeneration() === result.generation && location.origin === origin)
                      setStatus(confirmed ? "Signed out and cleared this browser." : "This browser is cleared. Server sign-out could not be confirmed.");
                  });
                })
              }
            >
              Sign out and clear this browser
            </button>
            </details>
          </aside>
        )}
      {active && preparedOriginals && originalsCurrent(preparedOriginals.context) && <aside className="original-share saved-original-share" ref={originalPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Share selected photos">
        <button className="close" aria-label="Close share options" disabled={sharingOriginals} onClick={cancelOriginals}>Close</button>
        <h2>Share {preparedOriginals.context.snapshot.photos.length} {preparedOriginals.context.snapshot.photos.length === 1 ? "photo" : "photos"}</h2>
        {originalShareError && <p className="hint" role="status">{originalShareError}</p>}
        <div className="actions">
          {canShareOriginals(preparedOriginals.files) && <button className="primary-action" disabled={sharingOriginals} onClick={() => sendSelectedOriginals(preparedOriginals)}>{sharingOriginals ? "Sharing…" : "Share"}</button>}
          <button className={canShareOriginals(preparedOriginals.files) ? undefined : "primary-action"} disabled={sharingOriginals} onClick={() => sendSelectedOriginals(preparedOriginals, true)}>Download originals</button>
        </div>
      </aside>}
      {active && placesOpen && unlocked && <Places photos={findPhotos} resources={placeResources} onClose={() => setPlacesOpen(false)}
        onApplyLocations={!publicDemo ? applyTimelineLocations : undefined} onOpen={id => {
          setPlacesOpen(false); setReceived(null); setReceivedContext(null); setQuery(""); setCommittedMeaning(undefined); peopleFind.change({...peopleFind.filter, ids: new Set()}); setViewer(id);
        }} />}
      {active && peopleOpen && unlocked && <Suspense fallback={<aside className="settings-panel" role="dialog" aria-modal="true" aria-label="People"><button autoFocus onClick={() => setPeopleOpen(false)}>Close</button><p role="status">Opening People…</p></aside>}><People photos={peoplePhotos} eligibleIDs={peopleEligibleIDs} onExpand={recentActive ? () => setRecentOnly(false) : undefined} scopeLabel={(recentActive ? "Last 30 days and current filters" : "Current filters") + (catalogIncomplete ? " · loaded Saved photos only" : "")} selectedIDs={new Set([...selected].map(id=>"saved:"+id))} resources={placeResources}
        onClose={() => setPeopleOpen(false)} onAssignments={!publicDemo ? applyPeople : undefined} onFind={id => {peopleFind.change({ids: new Set([id]), mode: "any"}); setRecentOnly(false); setPeopleOpen(false);}}
        onOpen={id => {setPeopleOpen(false); setRecentOnly(false); setReceived(null); setReceivedContext(null); setQuery(""); setCommittedMeaning(undefined); peopleFind.change({...peopleFind.filter, ids: new Set()}); setViewer(id.slice(6));}} /></Suspense>}
      {active && exchange && unlocked && (
        <Exchange
          key={exchangeVersion}
          selection={exchangePhotos}
          incoming={incoming?.pending ? incoming : undefined}
          onClose={closeSharing}
          onRetryPassword={incoming?.pending ? () => {incoming.retryPassword(); setExchange(false); setExchangePhotos([]); lockVault();} : undefined}
          onRefresh={() => run(refresh)}
          onReceived={(items: Photo[], grant: GrantV1, sender?: string) => {
            setReceived(items);
            setReceivedContext({grant, sender: sender || "Fotoro " + grant.ownerAccountId.slice(0, 8)});
            closeSharing();
            setQuery(""); setCommittedMeaning(undefined);
            setSelected(new Set());
          }}
        />
      )}
      {active && albumsOpen && unlocked && <AlbumPanel key={albumPanelKey} selection={albumEntryRevision.photos(albumSelection)} initialAlbumId={albumDestination?.current() ? albumDestination.albumId : undefined} currentPhotos={() => currentCatalog.current} currentOwnedPhotos={() => currentOwnedSnapshot.current}
        onImportPhotos={async (choice, signal, current) => {
          const session = requireVault(), origin = location.origin;
          const check = () => {signal.throwIfAborted(); if (!current() || !choice.current || !sameVault(session) || !activeRef.current || location.origin !== origin) throw new DOMException("Trip closed", "AbortError");};
          check(); if (publicDemo) throw new Error("PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED");
          return saveTripFiles(choice, {signal, current: () => current() && choice.current && sameVault(session) && activeRef.current && location.origin === origin,
            stage: async file => {check(); const staged = await stageImport(file, undefined, signal); check(); return {photoId: staged.photoId, sourceDigest: staged.sourceDigest};},
            drain: async photoIds => {
              check(); const pending = await pendingImports(); check();
              if (choice.sources.some(source => !pending.some(item => item.photoId === source.photoId && item.sourceDigest === source.sourceDigest))) throw new Error("TRIP_SOURCE_CHANGED");
              await resumePendingImports(signal, undefined, photoIds, () => current() && choice.current && sameVault(session) && activeRef.current && location.origin === origin); check();
            },
            unresolved: async photoIds => {const pending = await pendingImports(); check(); return photoIds.some(id => !pending.some(item => item.photoId === id && item.state === "committed"));},
            load: async photoIds => {
              const pending = await pendingImports(); check();
              const sources = tripSavedSources(photoIds, session.accountId, pending);
              for (const source of sources) {check(); await cacheOwnedPhotoDetails(source, signal); check();}
              const browse = browseFor(session);
              const result = await cachedSync(session, undefined, {...browse, retainPhotoIds: [...(browse.retainPhotoIds ?? []), ...photoIds]});
              check(); currentCatalog.current = result.photos; setPhotos(result.photos); setCatalogCoverage(result.coverage);
              return result.photos;
            },
          });
        }}
        onLoadOwnedPhoto={async (photo, signal) => {
          const session = requireVault(), origin = location.origin;
          const check = () => {signal.throwIfAborted(); if (!sameVault(session) || !activeRef.current || location.origin !== origin || photo.manifest.ownerAccountId !== session.accountId || photo.grantId) throw new DOMException("Photo source changed", "AbortError");};
          check();
          await cacheOwnedPhotoDetails({ownerAccountId: session.accountId, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256, manifest: photo.manifest}, signal);
          check(); albumDetailPhoto.current = {session, photoId: photo.manifest.photoId};
          const result = await cachedSync(session, undefined, browseFor(session));
          check(); setPhotos(result.photos); setCatalogCoverage(result.coverage);
          // The album reads the new source-bound snapshot after React publishes it.
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          check();
        }}
        onClose={closeAlbums} onIncomingDone={() => {setAlbumDestination(null); onAlbumIncomingDone?.();}} onChoosePhotos={albumId => {const session = effectVault(); if (!session) return; const origin = location.origin; const invitation = albumIncomingRef.current?.pending && albumIncomingRef.current.link.albumId === albumId ? albumIncomingRef.current : undefined; setAlbumDestination({albumId, current: () => sameVault(session) && location.origin === origin && activeRef.current && (!invitation || invitation.current(session))}); setReceived(null); setReceivedContext(null); setSelecting(true);}} incoming={incomingAlbum ?? undefined}
        onRetryAccount={incomingAlbum?.pending ? () => {incomingAlbum.retryPassword(); setAlbumsOpen(false); setAlbumSelection(null); lockVault();} : undefined} />}
      {active && viewing && viewer && unlocked && (
        <Viewer
          photos={shown}
          initial={viewer}
          onSaved={() => run(refresh)}
          onShare={!received ? photo => {setViewer(null); openSharing([photo]);} : undefined}
          changes={!received ? photoChanges ?? undefined : undefined}
          onLabels={!received && !publicDemo ? (photo, labels) => editAnnotations(photo, {labels}) : undefined}
          onFavorite={!received && !publicDemo ? (photo, favorite) => editAnnotations(photo, {favorite}) : undefined}
          onObservation={!received && !publicDemo ? (photo, observation) => editAnnotations(photo, {observation}) : undefined}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}
