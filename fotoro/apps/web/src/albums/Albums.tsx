import {albumDetailsSelection, retainAlbumDetailsDraft} from "./detail-selection";
import {AlbumActionQueue, bindAlbumAction} from "./action-queue";
import {loadAlbumSearchPages} from "./search-loading";
import {VirtualAlbumGrid} from "./VirtualAlbumGrid";
import {TripDownloadLease} from "./download-lease";
import {cleanupTripDownloads, prepareTripDownload, type TripDownloadProgress} from "./download";
import {TripPicks} from "./TripPicks";
import {AlbumNameChoices} from "./AlbumNameChoices";
import {lazy, Suspense, useEffect, useMemo, useRef, useState} from "react";
import type {AccountCardV1} from "@fotoro/contracts";
import {ALBUM_DEFINITION_KIND, readAlbumSignedBody, validateAlbumDefinition, type AlbumOverviewV1} from "@fotoro/contracts/albums";
import {createAlbumLink} from "@fotoro/contracts/albums-links";
import {subscribeContacts} from "../exchange/contacts";
import {contacts, contactNames, type ShareScope} from "../exchange/share-service";
import {identityLabel, ShareSelection} from "../exchange/sharing";
import {requireVault} from "../vault/vault";
import {sameVault} from "../vault/scope";
import {useDialogFocus} from "../library/dialog-focus";
import type {Photo} from "../library/catalog";
import {AlbumAccess, albumInbox, albumOwnedSelection, downloadAlbumOriginal, createAlbum, type AlbumCreationDraft} from "./service";
import type {IncomingAlbumIntent} from "./intent";
import type {AlbumPhotoFactsContentV1} from "@fotoro/contracts/album-photo-facts";
import type {OwnedPhotoSnapshot} from "../library/consumer-search";
import {emptyPeopleFilter} from "../people/filter";
import {albumPhotoGroups, albumPreviewNavigation} from "./browse";
import {ownedAlbumDetails, type OwnedAlbumDetails} from "./details";
import {albumReviewedPeople, sharedAlbumDetails, searchAlbumPhotos} from "./search";
import {albumDateTag, albumMemberLabel} from "./presentation";
import {Icon} from "../library/icons";
import {joinAlbumInvitation, loadAlbumEntry, reviewAlbumOwner, unsupportedAlbumCapabilities, type AlbumOwnerEntry} from "./bootstrap";
import {subscribeAlbumLifetime} from "./entry";
import {copyAlbumInvitation} from "./invitation";

const AlbumContacts = lazy(() => import("../exchange/Exchange").then(module => ({default: module.Exchange})));

function readableError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "TRIP_CHOOSE_1_TO_100_FILES") return "Choose 1 to 100 device photos at a time.";
  if (code === "TRIP_SAVE_INCOMPLETE") return "Saving has not finished. Check Saved and retry before adding these photos to the trip.";
  if (/SUPPORTED_ORIGINALS|SOURCE_FORMAT|SOURCE_DIMENSIONS|EMPTY_ORIGINAL|ORIGINAL_EXCEEDS/.test(code)) return "Choose JPEG, PNG or HEIC photos up to 50 MiB each.";
  if (code === "TRIP_MEMORY_LIMIT") return "This trip is too large for this browser’s 128 MiB download limit. Try a browser with temporary disk storage.";
  if (code === "TRIP_ZIP_LIMIT") return "This trip is too large for one ZIP download. Download individual originals instead.";
  if (code === "TRIP_CHANGED") return "New trip photos arrived while checking. Try Download trip again to include them.";
  if (code === "TRIP_EMPTY") return "There are no trip photos to download yet.";
  if (/TRIP_|INVALID_ORIGINAL_FILENAME|ORIGINAL_DIGEST_MISMATCH/.test(code)) return "The complete trip could not be verified for download. Try again.";
  if (/PIN_ACCOUNT_CARD/.test(code)) return "Accept the album owner's contact in Share in Fotoro before opening this invitation.";
  if (/ALBUM_(ACCESS_ENDED|NOT_FOUND|NOT_ACCEPTED)|FORBIDDEN/.test(code)) return "Album access has ended or is unavailable.";
  if (/CAPACITY|PHOTO_LIMIT/.test(code)) return "This album has reached its photo limit.";
  if (/ALBUM_LIMIT/.test(code)) return "This account has reached its active album limit.";
  if (/CONFLICT/.test(code)) return "Shared details changed. Refresh and review before saving again.";
  if (/SELECTION_CHANGED/.test(code)) return "The chosen Saved photos changed. Close this panel and choose them again.";
  if (/KEYS_CHANGED/.test(code)) return "An account's keys changed. Review the contact before continuing.";
  return "Albums could not finish this action. Refresh and try again.";
}
function AlbumImage({access, photo, preview = false, onOpen}: {access: AlbumAccess; photo: Photo; preview?: boolean; onOpen?: () => void}) {
  const element = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(preview);
  const [url, setURL] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    if (preview || !element.current) return;
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), {root: element.current.closest(".albums-content"), rootMargin: "200px"});
    observer.observe(element.current); return () => observer.disconnect();
  }, [preview]);
  useEffect(() => {
    const controller = new AbortController();
    setURL(""); setError("");
    if (!visible) return;
    const clear = () => {controller.abort(); setURL("");};
    access.signal.addEventListener("abort", clear, {once: true});
    void access.leaseRaster(photo, preview ? "preview" : "thumbnail", controller.signal).then(url => {
      if (!controller.signal.aborted && access.current()) {setURL(url);}
    }).catch(() => {if (!controller.signal.aborted) setError("Preview unavailable.");});
    return () => {access.signal.removeEventListener("abort", clear); controller.abort();};
  }, [access, photo, preview, visible]);
  const image = url ? <img src={url} alt={preview ? photo.metadata.filename : ""} onError={() => setError("Preview unavailable.")} /> : <span>{error || "Loading photo…"}</span>;
  return <div ref={element} className={preview ? "album-preview-image" : "album-thumbnail"}>{preview ? error || image : <button className="photo" data-photo-navigation-id={photo.manifest.photoId} onClick={onOpen} aria-label={"Open " + photo.metadata.filename}>{error || image}</button>}</div>;
}
export function AlbumContributionActions({albumId, chosen, busy, onChoosePhotos, onAdd, showSaved = true}: {showSaved?: boolean; albumId: string; chosen: number; busy: boolean; onChoosePhotos: (albumId: string) => void; onAdd: () => void}) {
  return <>{showSaved && <button disabled={busy} title="Choose photos already in Saved" onClick={() => onChoosePhotos(albumId)}>From Saved</button>}{chosen > 0 && <button className="primary-action" disabled={busy} onClick={onAdd}>Add {chosen} {chosen === 1 ? "photo" : "photos"}</button>}</>;
}
export function Albums({selection, currentPhotos, onClose, onChoosePhotos, incoming, onRetryAccount, currentOwnedPhotos, onLoadOwnedPhoto, onImportPhotos, initialAlbumId}: {selection: readonly Photo[]; initialAlbumId?: string; onImportPhotos?: (files: readonly File[], signal: AbortSignal, current: () => boolean) => Promise<Photo[]>; currentPhotos: () => readonly Photo[]; onClose: () => void; onChoosePhotos: (albumId: string) => void; incoming?: IncomingAlbumIntent; onRetryAccount?: () => void; currentOwnedPhotos?: () => OwnedPhotoSnapshot | null; onLoadOwnedPhoto?: (photo: Photo, signal: AbortSignal) => Promise<void>}) {
  const [session] = useState(requireVault), [controller] = useState(() => new AbortController());
  const [chosenSnapshot] = useState(() => new ShareSelection([...selection]));
  const creationDraft = useRef<AlbumCreationDraft>({});
  const deviceInput = useRef<HTMLInputElement>(null), searchInput = useRef<HTMLInputElement>(null), moreMenu = useRef<HTMLDetailsElement>(null);
  const panel = useRef<HTMLElement>(null), alive = useRef(true), accessRef = useRef<AlbumAccess | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null), [items, setItems] = useState<AlbumOverviewV1[]>([]), [cards, setCards] = useState<AccountCardV1[]>([]), [names, setNames] = useState(new Map<string, string>());
  const [titles, setTitles] = useState(new Map<string, string>()), previewPanel = useRef<HTMLElement>(null);
  const [ownerReview, setOwnerReview] = useState<Extract<AlbumOwnerEntry, {kind: "review"}> | null>(null);
  const [access, setAccess] = useState<AlbumAccess | null>(null), [photos, setPhotos] = useState<Photo[]>([]), [preview, setPreview] = useState<Photo | null>(null);
  const currentPreview = useRef(preview); currentPreview.current = preview;
  const [page, setPage] = useState<{hasMore: boolean; nextCursor?: string; photoCount: number}>({hasMore: false, photoCount: 0});
  const pageRef = useRef(page);
  const publishPage = (next: typeof page) => {pageRef.current = next; setPage(next);};
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false), [showTripPicks, setShowTripPicks] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false), [searchRetry, setSearchRetry] = useState(0);
  const [facts, setFacts] = useState(new Map<string, AlbumPhotoFactsContentV1>()), [factsState, setFactsState] = useState<"loading" | "ready" | "legacy" | "error" | "partial">("loading");
  const [peopleFilter, setPeopleFilter] = useState(emptyPeopleFilter), [from, setFrom] = useState(""), [through, setThrough] = useState(""), [groupCopies, setGroupCopies] = useState(true);
  const [detailDraft, setDetailDraft] = useState<{photo: Photo; source: OwnedAlbumDetails; revision: number; people: string[]; location: boolean; existing: boolean; unavailable: number} | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [title, setTitle] = useState(""), [invitees, setInvitees] = useState(new Set<string>()), [confirmEnd, setConfirmEnd] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [creating, setCreating] = useState(false), [unsupported, setUnsupported] = useState(false), [entryFailed, setEntryFailed] = useState(false);
  const preparedDownload = useRef<{access: AlbumAccess; photo: Photo; controller: AbortController} | null>(null);
  const tripDownload = useRef<{controller: AbortController; access?: AlbumAccess; lease?: TripDownloadLease} | null>(null);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [tripProgress, setTripProgress] = useState<TripDownloadProgress | null>(null);
  const clearTripDownload = () => {
    const attempt = tripDownload.current; tripDownload.current = null;
    attempt?.controller.abort(); attempt?.access?.dispose();
    if (attempt?.lease) void attempt.lease.dispose();
    setTripProgress(null); setDownloadStarted(false);
  };
  const clearDownload = () => {preparedDownload.current?.controller.abort(); preparedDownload.current = null;};
  const scope: ShareScope = {signal: controller.signal, current: () => alive.current && sameVault(session) && (!incoming || incoming.current(session))};
  const closeAlbum = () => {clearTripDownload(); clearDownload(); const previous = accessRef.current; accessRef.current = null; previous?.dispose(); setAccess(null); setPhotos([]); publishPage({hasMore: false, photoCount: 0}); setPreview(null); setQuery(""); setFiltersOpen(false); setShowTripPicks(false); setSearchFailed(false); setConfirmEnd(false); setFacts(new Map()); setFactsState("loading"); setPeopleFilter(emptyPeopleFilter()); setFrom(""); setThrough(""); setDetailDraft(null);};
  const close = () => {alive.current = false; controller.abort(); closeAlbum(); onClose();};
  useDialogFocus(panel, () => preview ? setPreview(null) : close(), !showContacts);
  useEffect(() => {setDetailDraft(null); if (preview) previewPanel.current?.focus({preventScroll: true});}, [preview]);
  useEffect(() => {
    clearDownload();
    return () => clearDownload();
  }, [access, preview]);
  useEffect(() => subscribeAlbumLifetime(window, document, () => {
    alive.current = false; controller.abort(); clearTripDownload(); accessRef.current?.dispose(); chosenSnapshot.dispose();
  }, close), []);
  const [actions] = useState(() => new AlbumActionQueue(() => alive.current && sameVault(session)
    && (!incoming || incoming.current(session)), value => {if (alive.current && sameVault(session)) setBusy(value);}));
  async function action(task: () => Promise<void>, background = false) {
    const intent = bindAlbumAction(() => accessRef.current, async () => {
      if (!background) {setError(""); setNotice("");}
      try {await task();} catch (failure) {if (scope.current?.()) {setError(readableError(failure)); if (accessRef.current && !accessRef.current.current()) closeAlbum();}}
    }, () => {if (!background) setNotice("Trip changed. Try that action again.");});
    await actions.run(intent, background);
  }
  useEffect(() => subscribeContacts(() => {
    if (!scope.current?.()) return;
    void Promise.all([contacts(scope), contactNames(scope)]).then(([accepted, labels]) => {
      if (scope.current?.()) {setCards(accepted); setNames(labels);}
    }).catch(() => {});
  }), []);
  async function loadInbox() {
    const [list, accepted, labels] = await Promise.all([albumInbox(scope), contacts(scope), contactNames(scope)]);
    if (!scope.current?.()) return;
    setItems(list); setCards(accepted); setNames(labels);
    const decrypted = new Map<string, string>();
    for (const item of list) {
      if (item.endedAt) continue;
      let opened: AlbumAccess | undefined;
      try {opened = await AlbumAccess.open(item, scope); decrypted.set(opened.albumId, opened.title);} catch {if (!scope.current?.()) return;} finally {opened?.dispose();}
    }
    if (scope.current?.()) setTitles(decrypted);
    return list;
  }
  async function readFacts(opened: AlbumAccess, background = false, searching = false) {
    if (!scope.current?.() || accessRef.current !== opened) return;
    if (!background) {setFacts(new Map()); setFactsState("loading");}
    try {
      const result = await opened.loadFacts({preserveTransientFailure: searching});
      if (scope.current?.() && accessRef.current === opened && opened.current()) {setFacts(result.facts); setFactsState(!result.supported ? "legacy" : result.unmatched ? "partial" : "ready");}
    } catch {
      if (scope.current?.() && accessRef.current === opened) {setFacts(new Map()); setFactsState("error"); if (!opened.current()) closeAlbum();}
    }
  }
  async function loadPage(opened: AlbumAccess, cursor?: string, searching = false) {
    const loaded = await opened.loadPhotoPage(cursor, {preserveTransientFailure: searching});
    if (!scope.current?.() || accessRef.current !== opened || !opened.current()) return;
    setPhotos(previous => cursor ? [...previous, ...loaded.photos] : loaded.photos);
    publishPage({hasMore: loaded.hasMore, nextCursor: loaded.nextCursor, photoCount: loaded.photoCount});
    await readFacts(opened, !!cursor, searching);
  }
  async function open(overview: AlbumOverviewV1) {
    closeAlbum(); const opened = await AlbumAccess.open(overview, scope);
    if (!scope.current?.()) {opened.dispose(); return;}
    accessRef.current = opened; setAccess(opened);
    if (overview.membership === "accepted") await loadPage(opened);
  }
  async function enter(overview: AlbumOverviewV1) {
    const entry = await reviewAlbumOwner(overview, session, scope);
    if (entry.kind === "review") setOwnerReview(entry);
    else await open(entry.overview);
  }
  // Keep the visible window, filters and current photo while checking for new contributions.
  async function refreshOpened(previous: AlbumAccess, overview: AlbumOverviewV1) {
    if (!scope.current?.() || accessRef.current !== previous) return;
    if (overview.membership !== "accepted") {await open(overview); return;}
    let opened: AlbumAccess | undefined, adopted = false;
    try {
      opened = await AlbumAccess.open(overview, scope);
      const target = Math.min(1000, Math.max(100, photos.length + (!page.hasMore && overview.photoCount > page.photoCount ? 100 : 0)));
      const loaded: Photo[] = [];
      let next = await opened.loadPhotoPage(); loaded.push(...next.photos);
      while (next.hasMore && loaded.length < target) {next = await opened.loadPhotoPage(next.nextCursor); loaded.push(...next.photos);}
      if (!scope.current?.() || accessRef.current !== previous || !opened.current()) {opened.dispose(); return;}
      clearDownload();
      const retained = previous.adoptRefresh(opened, loaded); adopted = true;
      setDetailDraft(current => retainAlbumDetailsDraft(current, retained));
      setPhotos(retained);
      publishPage({hasMore: next.hasMore, nextCursor: next.nextCursor, photoCount: next.photoCount});
      setPreview(current => current ? retained.find(photo => photo.manifest.photoId === current.manifest.photoId) ?? null : null);
      await readFacts(previous, true);
    } catch (failure) {
      if (!adopted) previous.discardFailedRefresh(opened, failure);
      else opened?.dispose();
      throw failure;
    }
  }
  const initialize = () => action(async () => {
    let checked = false;
    setAvailable(null); setUnsupported(false); setEntryFailed(false);
    try {
      const entry = await loadAlbumEntry({session, scope, incoming, albumId: initialAlbumId, loadInbox, onAvailable: () => {checked = true; setAvailable(true);}});
      if (entry.kind === "missing") setError("This account has no invitation to that album.");
      else if (entry.kind === "review") setOwnerReview(entry);
      else if (entry.kind === "open") await open(entry.overview);
    } catch (failure) {
      if (scope.current?.()) setEntryFailed(true);
      if (!checked && scope.current?.()) {setAvailable(false); setUnsupported(unsupportedAlbumCapabilities(failure));}
      throw failure;
    }
  });
  useEffect(() => {void cleanupTripDownloads(); void initialize();}, []);
  useEffect(() => {
    if (!access || access.overview.membership !== "accepted") return;
    const ended = () => {if (accessRef.current === access) {closeAlbum(); setError("Album access has ended or is unavailable.");}};
    access.signal.addEventListener("abort", ended, {once: true});
    const refresh = () => {void action(async () => {
      if (accessRef.current !== access) return;
      const current = await access.assertAccess();
      if (current.photoCount !== page.photoCount) await refreshOpened(access, current);
      else await readFacts(access, true);
    }, true);};
    const timer = setInterval(refresh, 15000); window.addEventListener("focus", refresh);
    return () => {clearInterval(timer); window.removeEventListener("focus", refresh); access.signal.removeEventListener("abort", ended);};
  }, [access, photos.length, page.photoCount, page.hasMore]);
  const filtering = !!(query.trim() || peopleFilter.ids.size || from || through);
  const searching = filtering || filtersOpen;
  const filterSummary = [peopleFilter.ids.size ? `${peopleFilter.ids.size} ${peopleFilter.ids.size === 1 ? "person" : "people"}` : "", from || through ? "Dates" : "", !groupCopies ? "All copies" : ""].filter(Boolean).join(" · ");
  const clearFilters = () => {setPeopleFilter(emptyPeopleFilter()); setFrom(""); setThrough(""); setGroupCopies(true);};
  useEffect(() => {
    if (!access || access.overview.membership !== "accepted" || !searching || !page.hasMore) return;
    let cancelled = false;
    const current = () => !cancelled && !!scope.current?.() && accessRef.current === access && access.current();
    setSearchFailed(false);
    // Coalesce typing/opening filters. Changing terms reuses the same metadata.
    const timer = window.setTimeout(() => {
      void loadAlbumSearchPages({queue: actions, current, page: () => pageRef.current, load: cursor => loadPage(access, cursor, true)})
        .catch(() => {if (current()) setSearchFailed(true);});
    }, 200);
    return () => {cancelled = true; window.clearTimeout(timer);};
  }, [access, searching, page.hasMore, searchRetry]);
  const contributor = (id: string, roster = access?.definition.members.map(member => member.card.accountId) ?? cards.map(card => card.accountId)) => albumMemberLabel(id, session.accountId, names, roster);
  const shown = useMemo(() => searchAlbumPhotos(photos, query, () => !!access?.current(), Date.now(), {facts, people: peopleFilter, from, through}), [photos, query, access, facts, peopleFilter, from, through]);
  const groups = useMemo(() => albumPhotoGroups(shown, groupCopies, () => !!access?.current()), [shown, groupCopies, access]);
  const reviewed = useMemo(() => albumReviewedPeople(photos, facts, () => !!access?.current()).map(person => ({...person, names: [person.names[0] + " · " + contributor(JSON.parse(person.id)[0])]})), [photos, facts, access, names]);
  const openDetails = (photo: Photo) => action(async () => {
    if (!access || accessRef.current !== access || factsState === "legacy") return;
    setDetailDraft(null);
    // A current local snapshot can still predate another device's private edit.
    // Explicitly opening or refreshing the editor reloads this contributor's
    // verified details before restoring previously shared choices.
    if (onLoadOwnedPhoto) await onLoadOwnedPhoto(photo, controller.signal);
    if (!scope.current?.() || accessRef.current !== access || !access.current()) throw new Error("ALBUM_SELECTION_CHANGED");
    const source = ownedAlbumDetails(photo, currentOwnedPhotos?.() ?? null);
    if (!source?.current()) throw new Error("ALBUM_SELECTION_CHANGED");
    const latest = await access.readFactsFor(photo);
    if (!source.current() || !scope.current?.() || accessRef.current !== access) throw new Error("ALBUM_SELECTION_CHANGED");
    setDetailDraft({photo, source, revision: (latest?.revision ?? 0) + 1, ...albumDetailsSelection(source, latest)});
  });
  let chosen = 0;
  try {chosen = chosenSnapshot.current ? albumOwnedSelection(chosenSnapshot.photos, session, currentPhotos()).length : 0;} catch {}
  const refresh = () => entryFailed ? initialize() : action(async () => {
    const list = await loadInbox();
    if (access) {const item = list?.find(item => item.definition.body === access.overview.definition.body && item.definition.signature === access.overview.definition.signature); if (!item || item.endedAt) {closeAlbum(); setNotice("Album access has ended.");} else await refreshOpened(access, item);}
  });
  const memberIDs = access?.definition.members.map(member => member.card.accountId) ?? [];
  const photoCount = access?.overview.membership === "accepted" ? page.photoCount : access?.overview.photoCount ?? 0;
  const previewDate = preview && albumDateTag(preview.metadata), previewNavigation = albumPreviewNavigation(groups, preview);
  const previewCopies = previewNavigation.copies;
  const previewOwned = preview && ownedAlbumDetails(preview, currentOwnedPhotos?.() ?? null);
  const downloadTrip = () => action(async () => {
    const opened = accessRef.current; if (!opened || opened.overview.membership !== "accepted") return;
    clearTripDownload();
    const attempt: NonNullable<typeof tripDownload.current> = {controller: new AbortController()}; tripDownload.current = attempt;
    const current = () => tripDownload.current === attempt && !attempt.controller.signal.aborted && !!scope.current?.() && accessRef.current === opened && opened.current();
    setTripProgress({phase: "checking", completed: 0, total: 0});
    let published = false;
    try {
      const signal = AbortSignal.any([controller.signal, attempt.controller.signal]);
      attempt.access = await AlbumAccess.open(opened.overview, {signal, current});
      if (!current()) {attempt.access.dispose(); return;}
      const result = await prepareTripDownload(attempt.access, signal, value => {if (current()) setTripProgress(value);});
      attempt.lease = new TripDownloadLease(result);
      await opened.assertAccess(); signal.throwIfAborted();
      if (!current()) return;
      attempt.lease.publish(current); published = true;
      if (!current()) return;
      setTripProgress(null); setDownloadStarted(true);
      setNotice(`Download started. Keep this trip open until it finishes. ${result.photos} unique ${result.photos === 1 ? "photo" : "photos"}${result.duplicates ? ` · ${result.duplicates} exact ${result.duplicates === 1 ? "copy" : "copies"} skipped` : ""}.`);
    } catch (failure) {
      if (!attempt.controller.signal.aborted) throw failure;
    } finally {
      if (!published) {
        if (tripDownload.current === attempt) clearTripDownload();
        else if (attempt.lease) await attempt.lease.dispose();
      }
    }
  });
  const download = () => action(async () => {
    if (!access || !preview || currentPreview.current !== preview) return;
    clearDownload();
    const prepared = {access, photo: preview, controller: new AbortController()};
    preparedDownload.current = prepared;
    const current = () => preparedDownload.current === prepared && accessRef.current === prepared.access
      && currentPreview.current === prepared.photo && !prepared.controller.signal.aborted && !!scope.current?.() && prepared.access.current();
    const signal = AbortSignal.any([controller.signal, prepared.controller.signal, access.signal]);
    try {
      await downloadAlbumOriginal(access, preview, signal, current, file => {
        const url = URL.createObjectURL(file), anchor = document.createElement("a"), revoke = () => {anchor.remove(); URL.revokeObjectURL(url);};
        controller.signal.addEventListener("abort", revoke, {once: true}); prepared.access.signal.addEventListener("abort", revoke, {once: true});
        anchor.href = url; anchor.download = file.name; anchor.hidden = true; document.body.append(anchor);
        try {anchor.click();} finally {setTimeout(() => {revoke(); controller.signal.removeEventListener("abort", revoke); prepared.access.signal.removeEventListener("abort", revoke);}, 1000);}
      });
    } catch (failure) {
      // Access denial aborts the reader too; only a withdrawn preview or panel cancels silently.
      if (!controller.signal.aborted && !prepared.controller.signal.aborted && scope.current?.()) throw failure;
    }
    finally {if (preparedDownload.current === prepared) clearDownload();}
  });
  return <><aside style={showContacts ? {display: "none"} : undefined} ref={panel} className="albums-sheet" role="dialog" aria-modal="true" aria-label="Trips" tabIndex={-1}>
    <header inert={preview ? true : undefined}>
      {access && <button className="album-icon-button" disabled={busy} onClick={closeAlbum} aria-label="All trips"><Icon kind="previous" /></button>}
      <div className="album-heading"><h2>{access ? access.title : creating ? "New trip" : "Trips"}</h2>
        {access && <div className="album-chips" aria-label="Album summary"><span>{photoCount} {photoCount === 1 ? "photo" : "photos"}</span><span aria-label={`${memberIDs.length} invited roster members`}>{memberIDs.length} people</span></div>}
      </div>
      {!access && !ownerReview && !creating && available && <button onClick={() => setCreating(true)}>New trip</button>}
      {available && <details ref={moreMenu} className="album-menu" onKeyDown={event => {if (event.key === "Escape") {event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();}}}>
        <summary>More</summary><div>
          <button disabled={busy} onClick={() => void refresh()}>Refresh</button>
          {access?.overview.membership === "accepted" && onImportPhotos && <button disabled={busy} onClick={() => onChoosePhotos(access.albumId)}>From Saved</button>}
          {access?.overview.membership === "accepted" && <button disabled={!showTripPicks && (busy || !shown.length)} aria-expanded={showTripPicks} aria-controls="album-trip-picks" onClick={event => {setShowTripPicks(value => !value); const menu = event.currentTarget.closest("details"); if (menu) {menu.open = false; menu.querySelector("summary")?.focus();}}}>{showTripPicks ? "Close best shots" : "Best shots"}</button>}
          {incoming && onRetryAccount && <button disabled={busy} onClick={onRetryAccount}>Use another account</button>}
          {access && <details className="album-roster"><summary>Details</summary><ul>{access.definition.members.map(member => <li key={member.card.accountId}><span>{contributor(member.card.accountId)}</span><small>{identityLabel(member.card)}</small></li>)}</ul></details>}
          {access?.definition.ownerAccountId === session.accountId && <>
            <label>Invitation link<input readOnly value={createAlbumLink(access.albumId, session.card, location.origin)} onFocus={event => event.target.select()} /></label>
            <button disabled={busy} onClick={() => void action(async () => {
              const opened = access, current = () => !!scope.current?.() && accessRef.current === opened && opened.current();
              const result = await copyAlbumInvitation(createAlbumLink(opened.albumId, session.card, location.origin), current, navigator.clipboard);
              if (result && current()) setNotice(result === "copied" ? "Album link copied. Only invited accounts can accept it." : "Select and copy the invitation link in More. Only invited accounts can accept it.");
            })}>Copy invitation link</button>
            <details><summary>End access</summary><label><input type="checkbox" checked={confirmEnd} onChange={event => setConfirmEnd(event.target.checked)} />End trip access for everyone</label><button disabled={busy || !confirmEnd} onClick={() => void action(async () => {await access.end(); closeAlbum(); await loadInbox(); setError(""); setNotice("Album access ended.");})}>End access</button></details>
          </>}
        </div>
      </details>}
      <button className="album-icon-button" onClick={close} aria-label="Close trips"><Icon kind="close" /></button>
    </header>
    <div className="albums-content" inert={preview ? true : undefined} aria-busy={busy || available === null}>
      {error && <p className="hint" role="alert">{available === false ? unsupported ? "Live albums are unavailable on this server. Existing photos and Share still work." : "Live albums could not be opened. Try again." : error}</p>}
      {entryFailed && <button className="primary-action" disabled={busy} onClick={() => void initialize()}>Try again</button>}
      {notice && <p className="hint" role="status">{notice}</p>}
      {available === null && <p role="status">Checking album availability…</p>}
      {available && <>
        {ownerReview ? <section className="identity-confirmation">
          <h3>{ownerReview.changed ? "The album owner's identity changed" : "Accept the album owner"}</h3>
          <p className="hint">Confirm this sender with the album owner through a trusted channel before continuing. {ownerReview.changed && "Their identity differs from the contact saved in this browser."}</p>
          <details className="album-roster"><summary>Verify sender</summary><p className="contact-identity">Fotoro {identityLabel(ownerReview.owner)}</p></details>
          <button className="primary-action" disabled={busy} onClick={() => void action(async () => {const accepted = await joinAlbumInvitation(ownerReview.overview, scope, ownerReview.owner); if (!scope.current?.()) return; setOwnerReview(null); await open(accepted); await loadInbox();})}>{ownerReview.overview.membership === "accepted" ? "Verify sender and open trip" : ownerReview.changed ? "Join trip with new identity" : "Join trip"}</button>
          <button disabled={busy} onClick={() => setOwnerReview(null)}>All trips</button>
        </section> : access ? <>
          {access.overview.membership === "invited" ? <>
            <p>Accept to view this album and add chosen Saved photos. Its invited members stay fixed.</p>
            <button className="primary-action" disabled={busy} onClick={() => void action(async () => {const accepted = await joinAlbumInvitation(access.overview, scope); await open(accepted); await loadInbox();})}>Join trip</button>
          </> : <>
            <div className="album-toolbar">
              <div className="album-actions">
              {onImportPhotos && <><button className={chosen ? undefined : "primary-action"} disabled={busy} title="Save photos from this device and add them to this trip" onClick={() => deviceInput.current?.click()}>Add photos</button><input ref={deviceInput} type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" multiple hidden aria-label="Choose device photos to save and add to trip" onChange={event => {
                const files = Array.from(event.target.files ?? []); event.target.value = "";
                if (!files.length) return;
                void action(async () => {
                  clearTripDownload(); clearDownload();
                  const opened = access;
                  const current = () => !!scope.current?.() && accessRef.current === opened && opened.current();
                  const signal = AbortSignal.any([controller.signal, opened.signal]);
                  setNotice("Saving chosen photos before adding…");
                  let saved: Photo[];
                  try {saved = await onImportPhotos(files, signal, current);} catch (failure) {if (scope.current?.()) setNotice(""); throw failure;}
                  if (!current()) throw new DOMException("Trip closed", "AbortError");
                  setNotice("Adding chosen photos…");
                  let added: number;
                  try {added = await opened.add(saved, () => current() ? currentPhotos() : []);} catch (failure) {if (scope.current?.()) setNotice(""); throw failure;}
                  const list = await loadInbox(), updated = list?.find(item => item.definition.body === opened.overview.definition.body);
                  if (updated) await refreshOpened(opened, updated);
                  if (scope.current?.()) setNotice(`${added} ${added === 1 ? "photo added" : "photos added"}.`);
                });
              }} /></>}
              <AlbumContributionActions showSaved={!onImportPhotos} albumId={access.albumId} chosen={chosen} busy={busy} onChoosePhotos={onChoosePhotos} onAdd={() => void action(async () => {const added = await access.add(chosenSnapshot.photos, currentPhotos); const list = await loadInbox(); const updated = list?.find(item => item.definition.body === access.overview.definition.body); if (updated) await refreshOpened(access, updated); setNotice(added ? `${added} ${added === 1 ? "photo added" : "photos added"}.` : "Already in this album.");})} />
              <button disabled={busy || !photoCount || downloadStarted} onClick={() => void downloadTrip()}>Download trip</button>
              </div>
              <div className="album-search-row"><div className="album-search"><input ref={searchInput} type="search" aria-label="Search trip people, places, filenames or capture dates" placeholder="Search this trip" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="album-icon-button" aria-label="Clear trip search" onClick={() => {setQuery(""); searchInput.current?.focus();}}><Icon kind="close" /></button>}</div>
            <details className="album-filters" open={filtersOpen} onToggle={event => {if (event.target === event.currentTarget) setFiltersOpen(event.currentTarget.open);}} onKeyDown={event => {
              if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); setFiltersOpen(false); event.currentTarget.querySelector("summary")?.focus();}
            }}>
              <summary>Filters{filterSummary && <span>{filterSummary}</span>}</summary>
              <div className="album-filter-options">
                <fieldset disabled={busy}><legend>People</legend>
                  {reviewed.map(person => <label key={person.id}><input type="checkbox" checked={peopleFilter.ids.has(person.id)} onChange={event => {
                    const ids = new Set(peopleFilter.ids); event.target.checked ? ids.add(person.id) : ids.delete(person.id); setPeopleFilter({...peopleFilter, ids});
                  }} />{person.names.join(" / ")}</label>)}
                  {!reviewed.length && <p className="hint">{page.hasMore || factsState === "loading" ? "Checking shared people…" : factsState === "error" ? "Shared people could not load." : factsState === "legacy" ? "Shared people are unavailable on this server." : "No shared people."}</p>}
                  {[...peopleFilter.ids].some(id => !reviewed.some(person => person.id === id)) && <p className="hint" role="status">A selected person is unavailable. Clear filters to reset.</p>}
                </fieldset>
                {peopleFilter.ids.size > 1 && <label>Match<select aria-label="Match selected people" value={peopleFilter.mode} disabled={busy} onChange={event => setPeopleFilter({...peopleFilter, mode: event.target.value as typeof peopleFilter.mode})}><option value="any">Any selected people</option><option value="everyone">Everyone in a photo</option></select></label>}
                <div className="album-range"><label>From<input type="date" aria-label="Captured from" value={from} onChange={event => setFrom(event.target.value)} /></label><label>Through<input type="date" aria-label="Captured through" value={through} onChange={event => setThrough(event.target.value)} /></label></div>
                <label><input type="checkbox" checked={groupCopies} onChange={event => setGroupCopies(event.target.checked)} />Group exact copies</label>
                {filterSummary && <button disabled={busy} onClick={clearFilters}>Clear filters</button>}
              </div>
            </details>
              </div>
            </div>
            {downloadStarted && <button onClick={() => {clearTripDownload(); setNotice("");}}>Done downloading</button>}
            {tripProgress && <div className="trip-download-progress"><p role="status">{tripProgress.phase === "checking" ? "Checking all trip photos" : "Preparing trip download"}{tripProgress.total > 0 ? ` · ${tripProgress.completed} of ${tripProgress.total}` : "…"}</p>
              <progress aria-label="Trip download progress" max={tripProgress.total || 1} value={tripProgress.total ? tripProgress.completed : undefined} />
              <button onClick={() => {clearTripDownload(); setNotice("Trip download cancelled.");}}>Cancel download</button>
            </div>}

            {factsState === "error" && <p className="hint" role="status">Shared details could not load. <button disabled={busy} onClick={() => void action(() => readFacts(access, false, searching))}>Retry details</button></p>}
            {factsState === "partial" && !page.hasMore && <p className="hint" role="status">New photo details are available. <button disabled={busy} onClick={() => void refresh()}>Refresh photos</button></p>}
            {busy && !photos.length && <p className="hint" role="status">Loading photos…</p>}
            {searching && !page.hasMore && factsState === "loading" && <p className="hint" role="status">Checking shared details…</p>}
            {filtering && groups.length > 0 && !page.hasMore && !["loading", "error", "partial"].includes(factsState) && <p role="status">{groups.length} {groups.length === 1 ? "match" : "matches"}</p>}
            {searching && page.hasMore && <div className="hint" aria-label="Trip search coverage"><p role="status">{searchFailed ? "Search is incomplete. " : "Searching the whole trip… "}{photos.length} of {page.photoCount} photos checked.</p>{searchFailed && <button disabled={busy} onClick={() => setSearchRetry(value => value + 1)}>Retry search</button>}</div>}
            {showTripPicks && <TripPicks access={access} photos={shown} hasMore={page.hasMore} onClose={() => {setShowTripPicks(false); moreMenu.current?.querySelector("summary")?.focus();}} renderPhoto={photo => <AlbumImage access={access} photo={photo} onOpen={() => setPreview(photo)} />} />}
            <VirtualAlbumGrid groups={groups} resetKey={JSON.stringify([query, [...peopleFilter.ids].sort(), peopleFilter.mode, from, through, groupCopies])}>{group => {const photo = group.photo, shared = sharedAlbumDetails(photo, facts), date = albumDateTag(photo.metadata); return <div className="tile" key={photo.manifest.photoId}><AlbumImage access={access} photo={photo} onOpen={() => setPreview(photo)} /><div className="album-photo-tags" aria-label="Photo information"><span aria-label="Contributor">{contributor(photo.manifest.ownerAccountId)}</span>{date && <span aria-label={date.label}>{date.text}</span>}{shared?.people.length ? <span aria-label="Shared reviewed people">{shared.people.slice(0, 2).join(" · ")}{shared.people.length > 2 ? "…" : ""}</span> : shared?.location?.name && <span aria-label="Shared place">{shared.location.name}</span>}</div></div>;}}</VirtualAlbumGrid>
            {!searching && page.hasMore && <div className="hint" aria-label="Album coverage"><p role="status">{photos.length} of {page.photoCount} photos loaded.</p><button disabled={busy} onClick={() => void action(() => loadPage(access, pageRef.current.nextCursor))}>Load more photos</button></div>}
            {!photos.length && !busy && <p>No contributions yet.</p>}
            {photos.length > 0 && !shown.length && <div className="album-empty"><p>{page.hasMore || ["loading", "error", "partial"].includes(factsState) ? "No matches in the photos checked so far." : "No matching photos."}</p><button onClick={() => {setQuery(""); clearFilters(); searchInput.current?.focus();}}>Clear filters</button></div>}
          </>}
        </> : <>
          {creating && <form onSubmit={event => {event.preventDefault(); void action(async () => {const created = await createAlbum(title, cards.filter(card => invitees.has(card.accountId)), scope, creationDraft.current); setTitle(""); setInvitees(new Set()); setCreating(false); await loadInbox(); await open(created);});}}>
            <label>Trip title<input value={title} onChange={event => {creationDraft.current = {}; setTitle(event.target.value);}} required disabled={busy} aria-describedby="album-title-limit" /></label>
            <p className="hint" id="album-title-limit">Up to 80 characters. Choose 1 to 11 accepted contacts. Invitations require acceptance.</p>
            <fieldset disabled={busy}><legend>Invite contacts</legend>{cards.map(card => <label key={card.accountId}><input type="checkbox" checked={invitees.has(card.accountId)} disabled={!invitees.has(card.accountId) && invitees.size >= 11} onChange={event => {creationDraft.current = {}; setInvitees(previous => {const next = new Set(previous); if (event.target.checked) next.add(card.accountId); else next.delete(card.accountId); return next;});}} />{contributor(card.accountId)}</label>)}</fieldset>
            {!cards.length && <p className="hint">Accept a contact before inviting them to your trip.</p>}
            <button type="button" disabled={busy} onClick={() => setShowContacts(true)}>Add a contact</button>
            <button type="submit" className="primary-action" disabled={busy || !title.trim() || [...title].length > 80 || !invitees.size}>Create and invite</button>
            <button type="button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button>
          </form>}
          {!creating && <div className="album-inbox">{items.map(item => {const definition = readAlbumSignedBody(item.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition), label = titles.get(definition.albumId) || (item.membership === "invited" ? "Trip invitation" : "Trip"); return <button className="album-inbox-card" key={definition.albumId} disabled={busy || !!item.endedAt} onClick={() => void action(() => enter(item))} aria-label={`${item.membership === "invited" ? "Review invitation to" : "Open"} ${label}`}><div><strong>{label}</strong><div className="album-chips"><span>{item.photoCount} {item.photoCount === 1 ? "photo" : "photos"}</span><span>{definition.members.length} people</span><span>{item.endedAt ? "Access ended" : item.membership === "invited" ? "Invitation" : contributor(definition.ownerAccountId, definition.members.map(member => member.card.accountId))}</span></div></div><Icon kind="next" /></button>;})}</div>}
          {!creating && !items.length && !busy && <p>No trips or invitations yet.</p>}
        </>}
      </>}
    </div>
    {preview && access && <section ref={previewPanel} className="album-preview" aria-label={preview.metadata.filename} tabIndex={-1} onKeyDown={event => {if (event.key === "ArrowLeft" && previewNavigation.previous) {event.preventDefault(); setPreview(previewNavigation.previous);} else if (event.key === "ArrowRight" && previewNavigation.next) {event.preventDefault(); setPreview(previewNavigation.next);}}}>
      <header><button className="album-icon-button" onClick={() => setPreview(null)} aria-label="Back to album"><Icon kind="previous" /></button><p>{previewNavigation.index >= 0 ? `${previewNavigation.index + 1} of ${previewNavigation.count}` : "Photo outside current filters"}</p><div className="actions"><button className="album-icon-button" aria-label="Previous photo" disabled={!previewNavigation.previous} onClick={() => {if (previewNavigation.previous) setPreview(previewNavigation.previous);}}><Icon kind="previous" /></button><button className="album-icon-button" aria-label="Next photo" disabled={!previewNavigation.next} onClick={() => {if (previewNavigation.next) setPreview(previewNavigation.next);}}><Icon kind="next" /></button></div></header>
      <AlbumImage access={access} photo={preview} preview />
      <div className="album-photo-tags" aria-label="Photo information"><span aria-label="Contributor">{contributor(preview.manifest.ownerAccountId)}</span>{previewDate && <span aria-label={previewDate.label}>{previewDate.text}</span>}</div>
      <div className="album-photo-tags" aria-label="Shared photo details">{sharedAlbumDetails(preview, facts)?.people.map(name => <span key={name} aria-label="Shared reviewed person">{name}</span>)}{sharedAlbumDetails(preview, facts)?.location && <span aria-label="Shared photo location">{sharedAlbumDetails(preview, facts)?.location?.name || "Photo location shared"}</span>}</div>
      <div className="album-preview-actions"><button disabled={busy} onClick={() => void download()}>{busy ? "Preparing…" : "Download original"}</button>
        {error && <p className="hint" role="alert">{error}</p>}{notice && <p className="hint" role="status">{notice}</p>}
      </div>
      <details className="album-preview-details"><summary>Details</summary><p>{preview.metadata.filename}</p>
        {previewCopies.length > 1 && <div className="album-copies" aria-label="Identical copies"><p>{previewCopies.length} identical copies</p>{previewCopies.map(copy => <button key={copy.manifest.photoId} onClick={() => setPreview(copy)}>{contributor(copy.manifest.ownerAccountId)} · {copy.metadata.filename}</button>)}</div>}
        {preview.manifest.ownerAccountId === session.accountId && factsState !== "legacy" && <button disabled={busy || (!previewOwned && !onLoadOwnedPhoto)} onClick={() => void openDetails(preview)}>Share details</button>}
        {detailDraft && detailDraft.photo === preview && <section className="album-share-details" aria-label="Share photo details"><h3>Share photo details</h3><p className="hint">Choose details to share with album members. Unchecked details are removed on save.</p>
          {detailDraft.unavailable > 0 && <p className="hint" role="status">Previously shared details that no longer match Saved will be removed on save.</p>}
          <AlbumNameChoices names={detailDraft.source.people} selected={detailDraft.people} disabled={busy || !detailDraft.source.current()} onChange={people => setDetailDraft({...detailDraft, people})} />
          <label><input type="checkbox" checked={detailDraft.location} disabled={busy || !detailDraft.source.location || !detailDraft.source.current()} onChange={event => setDetailDraft({...detailDraft, location: event.target.checked})} />Photo location{detailDraft.source.location?.name ? ": " + detailDraft.source.location.name : ""}</label>
          {detailDraft.source.location && <p className="hint">Sharing location includes exact coordinates.</p>}
          {!detailDraft.source.current() && <p className="hint" role="alert">The Saved source changed. Refresh details and review again.</p>}
          <div className="actions"><button disabled={busy || !detailDraft.source.current() || (!detailDraft.people.length && !detailDraft.location && !detailDraft.existing)} onClick={() => void action(async () => {
            const draft = detailDraft; const content = await access.shareDetails(draft.photo, draft.source, draft, draft.revision);
            if (scope.current?.() && accessRef.current === access && draft.source.current()) {setFacts(current => new Map(current).set(draft.photo.manifest.photoId, content)); setDetailDraft(null); setNotice(content.people.length || content.location ? "Selected details shared." : "Shared details cleared.");}
          })}>{detailDraft.people.length || detailDraft.location ? "Share selected details" : "Clear shared details"}</button><button disabled={busy} onClick={() => void openDetails(preview)}>Refresh details</button><button disabled={busy} onClick={() => setDetailDraft(null)}>Cancel</button></div></section>}
        </details>
    </section>}
  </aside>
    {showContacts && <Suspense fallback={<section className="sheet share-sheet" style={{zIndex: 71}} role="dialog" aria-modal="true" aria-label="Contacts"><p role="status">Opening contacts…</p><button autoFocus onClick={() => setShowContacts(false)}>Back to trip</button></section>}>
      <AlbumContacts contactsOnly onClose={() => setShowContacts(false)} />
    </Suspense>}
  </>;
}
