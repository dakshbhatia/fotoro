import {AlbumNameChoices} from "./AlbumNameChoices";
import {useEffect, useMemo, useRef, useState} from "react";
import type {AccountCardV1} from "@fotoro/contracts";
import {ALBUM_DEFINITION_KIND, readAlbumSignedBody, validateAlbumDefinition, type AlbumOverviewV1} from "@fotoro/contracts/albums";
import {createAlbumLink} from "@fotoro/contracts/albums-links";
import {contacts, contactNames, type ShareScope} from "../exchange/share-service";
import {identityLabel, ShareSelection} from "../exchange/sharing";
import {requireVault} from "../vault/vault";
import {sameVault} from "../vault/scope";
import {useDialogFocus} from "../library/dialog-focus";
import type {Photo} from "../library/catalog";
import {AlbumAccess, albumInbox, albumOwnedSelection, albumOriginalFiles, createAlbum, type AlbumCreationDraft} from "./service";
import type {IncomingAlbumIntent} from "./intent";
import type {AlbumPhotoFactsContentV1} from "@fotoro/contracts/album-photo-facts";
import type {OwnedPhotoSnapshot} from "../library/consumer-search";
import {emptyPeopleFilter} from "../people/filter";
import {PeopleFilter} from "../people/PeopleFilter";
import {albumPhotoGroups} from "./browse";
import {ownedAlbumDetails, type OwnedAlbumDetails} from "./details";
import {albumReviewedPeople, sharedAlbumDetails, searchAlbumPhotos} from "./search";
import {albumDateTag, albumMemberLabel} from "./presentation";
import {Icon} from "../library/icons";
import {joinAlbumInvitation, loadAlbumEntry, unsupportedAlbumCapabilities} from "./bootstrap";
import {shareOriginals} from "../library/system-share";
import {subscribeAlbumLifetime} from "./entry";

function readableError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
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
    const controller = new AbortController(); let ownedURL = "";
    setURL(""); setError("");
    if (!visible) return;
    const clear = () => {controller.abort(); if (ownedURL) URL.revokeObjectURL(ownedURL); ownedURL = ""; setURL("");};
    access.signal.addEventListener("abort", clear, {once: true});
    void access.bytes(photo, preview ? "preview" : "thumbnail", controller.signal).then(bytes => {
      try {if (!controller.signal.aborted && access.current()) {ownedURL = URL.createObjectURL(new Blob([new Uint8Array(bytes)], {type: "image/jpeg"})); setURL(ownedURL);}} finally {bytes.fill(0);}
    }).catch(() => {if (!controller.signal.aborted) setError("Preview unavailable.");});
    return () => {access.signal.removeEventListener("abort", clear); controller.abort(); if (ownedURL) URL.revokeObjectURL(ownedURL);};
  }, [access, photo, preview, visible]);
  const image = url ? <img src={url} alt={preview ? photo.metadata.filename : ""} onError={() => setError("Preview unavailable.")} /> : <span>{error || "Loading photo…"}</span>;
  return <div ref={element} className={preview ? "album-preview-image" : "album-thumbnail"}>{preview ? error || image : <button className="photo" onClick={onOpen} aria-label={"Open " + photo.metadata.filename}>{error || image}</button>}</div>;
}
export function Albums({selection, currentPhotos, onClose, onChoosePhotos, incoming, onRetryAccount, currentOwnedPhotos, onLoadOwnedPhoto, initialAlbumId}: {selection: readonly Photo[]; initialAlbumId?: string; currentPhotos: () => readonly Photo[]; onClose: () => void; onChoosePhotos: (albumId: string) => void; incoming?: IncomingAlbumIntent; onRetryAccount?: () => void; currentOwnedPhotos?: () => OwnedPhotoSnapshot | null; onLoadOwnedPhoto?: (photo: Photo, signal: AbortSignal) => Promise<void>}) {
  const [session] = useState(requireVault), [controller] = useState(() => new AbortController());
  const [chosenSnapshot] = useState(() => new ShareSelection([...selection]));
  const creationDraft = useRef<AlbumCreationDraft>({});
  const panel = useRef<HTMLElement>(null), alive = useRef(true), accessRef = useRef<AlbumAccess | null>(null), working = useRef(false);
  const [available, setAvailable] = useState<boolean | null>(null), [items, setItems] = useState<AlbumOverviewV1[]>([]), [cards, setCards] = useState<AccountCardV1[]>([]), [names, setNames] = useState(new Map<string, string>());
  const [titles, setTitles] = useState(new Map<string, string>()), previewPanel = useRef<HTMLElement>(null);
  const [ownerReview, setOwnerReview] = useState<AlbumOverviewV1 | null>(null), [ownerChanged, setOwnerChanged] = useState(false);
  const [access, setAccess] = useState<AlbumAccess | null>(null), [photos, setPhotos] = useState<Photo[]>([]), [preview, setPreview] = useState<Photo | null>(null);
  const [page, setPage] = useState<{hasMore: boolean; nextCursor?: string; photoCount: number}>({hasMore: false, photoCount: 0});
  const [query, setQuery] = useState("");
  const [facts, setFacts] = useState(new Map<string, AlbumPhotoFactsContentV1>()), [factsState, setFactsState] = useState<"loading" | "ready" | "legacy" | "error" | "partial">("loading");
  const [peopleFilter, setPeopleFilter] = useState(emptyPeopleFilter), [from, setFrom] = useState(""), [through, setThrough] = useState(""), [groupCopies, setGroupCopies] = useState(true);
  const [detailDraft, setDetailDraft] = useState<{photo: Photo; source: OwnedAlbumDetails; revision: number; people: string[]; location: boolean; existing: boolean} | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [title, setTitle] = useState(""), [invitees, setInvitees] = useState(new Set<string>()), [confirmEnd, setConfirmEnd] = useState(false);
  const [creating, setCreating] = useState(false), [unsupported, setUnsupported] = useState(false), [entryFailed, setEntryFailed] = useState(false);
  const preparedDownload = useRef<{access: AlbumAccess; photo: Photo; files: File[]; controller: AbortController} | null>(null);
  const [downloadReady, setDownloadReady] = useState(false);
  const clearDownload = () => {preparedDownload.current?.controller.abort(); if (preparedDownload.current) preparedDownload.current.files.length = 0; preparedDownload.current = null; setDownloadReady(false);};
  const scope: ShareScope = {signal: controller.signal, current: () => alive.current && sameVault(session) && (!incoming || incoming.current(session))};
  const closeAlbum = () => {clearDownload(); const previous = accessRef.current; accessRef.current = null; previous?.dispose(); setAccess(null); setPhotos([]); setPage({hasMore: false, photoCount: 0}); setPreview(null); setQuery(""); setConfirmEnd(false); setFacts(new Map()); setFactsState("loading"); setPeopleFilter(emptyPeopleFilter()); setFrom(""); setThrough(""); setDetailDraft(null);};
  const close = () => {alive.current = false; controller.abort(); closeAlbum(); onClose();};
  useDialogFocus(panel, () => preview ? setPreview(null) : close());
  useEffect(() => {setDetailDraft(null); if (preview) previewPanel.current?.focus({preventScroll: true});}, [preview]);
  useEffect(() => {
    clearDownload();
    const clear = () => clearDownload();
    access?.signal.addEventListener("abort", clear, {once: true});
    return () => {access?.signal.removeEventListener("abort", clear); clearDownload();};
  }, [access, preview]);
  useEffect(() => subscribeAlbumLifetime(window, document, () => {
    alive.current = false; controller.abort(); accessRef.current?.dispose(); chosenSnapshot.dispose();
  }, close), []);
  async function action(task: () => Promise<void>, background = false) {
    if (working.current || !scope.current?.()) return;
    working.current = true; setBusy(true); if (!background) {setError(""); setNotice("");}
    try {await task();} catch (failure) {if (scope.current?.()) {setError(readableError(failure)); if (accessRef.current && !accessRef.current.current()) closeAlbum();}}
    finally {working.current = false; if (scope.current?.()) setBusy(false);}
  }
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
  async function readFacts(opened: AlbumAccess, background = false) {
    if (!scope.current?.() || accessRef.current !== opened) return;
    if (!background) {setFacts(new Map()); setFactsState("loading");}
    try {
      const result = await opened.loadFacts();
      if (scope.current?.() && accessRef.current === opened && opened.current()) {setFacts(result.facts); setFactsState(!result.supported ? "legacy" : result.unmatched ? "partial" : "ready");}
    } catch {
      if (scope.current?.() && accessRef.current === opened) {setFacts(new Map()); setFactsState("error"); if (!opened.current()) closeAlbum();}
    }
  }
  async function loadPage(opened: AlbumAccess, cursor?: string) {
    const loaded = await opened.loadPhotoPage(cursor);
    if (!scope.current?.() || accessRef.current !== opened || !opened.current()) return;
    setPhotos(previous => cursor ? [...previous, ...loaded.photos] : loaded.photos);
    setPage({hasMore: loaded.hasMore, nextCursor: loaded.nextCursor, photoCount: loaded.photoCount});
    await readFacts(opened, !!cursor);
  }
  async function open(overview: AlbumOverviewV1) {
    closeAlbum(); const opened = await AlbumAccess.open(overview, scope);
    if (!scope.current?.()) {opened.dispose(); return;}
    accessRef.current = opened; setAccess(opened);
    if (overview.membership === "accepted") await loadPage(opened);
  }
  // Keep the visible window, filters and current photo while checking for new contributions.
  async function refreshOpened(previous: AlbumAccess, overview: AlbumOverviewV1) {
    if (!scope.current?.() || accessRef.current !== previous) return;
    if (overview.membership !== "accepted") {await open(overview); return;}
    const opened = await AlbumAccess.open(overview, scope);
    try {
      const target = Math.min(1000, Math.max(100, photos.length + (!page.hasMore && overview.photoCount > page.photoCount ? 100 : 0)));
      const loaded: Photo[] = [];
      let next = await opened.loadPhotoPage(); loaded.push(...next.photos);
      while (next.hasMore && loaded.length < target) {next = await opened.loadPhotoPage(next.nextCursor); loaded.push(...next.photos);}
      if (!scope.current?.() || accessRef.current !== previous || !opened.current()) {opened.dispose(); return;}
      clearDownload(); setDetailDraft(null);
      accessRef.current = opened; setAccess(opened); setPhotos(loaded);
      setPage({hasMore: next.hasMore, nextCursor: next.nextCursor, photoCount: next.photoCount});
      setPreview(current => current ? loaded.find(photo => photo.manifest.photoId === current.manifest.photoId) ?? null : null);
      previous.dispose();
      await readFacts(opened, true);
    } catch (failure) {
      if (accessRef.current !== opened) {opened.dispose(); previous.dispose();}
      throw failure;
    }
  }
  const initialize = () => action(async () => {
    let checked = false;
    setAvailable(null); setUnsupported(false); setEntryFailed(false);
    try {
      const entry = await loadAlbumEntry({session, scope, incoming, albumId: initialAlbumId, loadInbox, onAvailable: () => {checked = true; setAvailable(true);}});
      if (entry.kind === "missing") setError("This account has no invitation to that album.");
      else if (entry.kind === "review") {setOwnerChanged(entry.changed); setOwnerReview(entry.overview);}
      else if (entry.kind === "open") await open(entry.overview);
    } catch (failure) {
      if (scope.current?.()) setEntryFailed(true);
      if (!checked && scope.current?.()) {setAvailable(false); setUnsupported(unsupportedAlbumCapabilities(failure));}
      throw failure;
    }
  });
  useEffect(() => {void initialize();}, []);
  useEffect(() => {
    if (!access || access.overview.membership !== "accepted") return;
    const ended = () => {if (accessRef.current === access) {closeAlbum(); setError("Album access has ended or is unavailable.");}};
    access.signal.addEventListener("abort", ended, {once: true});
    const refresh = () => {if (!working.current) void action(async () => {
      const current = await access.assertAccess();
      if (current.photoCount !== page.photoCount) await refreshOpened(access, current);
      else await readFacts(access, true);
    }, true);};
    const timer = setInterval(refresh, 15000); window.addEventListener("focus", refresh);
    return () => {clearInterval(timer); window.removeEventListener("focus", refresh); access.signal.removeEventListener("abort", ended);};
  }, [access, photos.length, page.photoCount, page.hasMore]);
  const contributor = (id: string, roster = access?.definition.members.map(member => member.card.accountId) ?? cards.map(card => card.accountId)) => albumMemberLabel(id, session.accountId, names, roster);
  const shown = useMemo(() => searchAlbumPhotos(photos, query, () => !!access?.current(), Date.now(), {facts, people: peopleFilter, from, through}), [photos, query, access, facts, peopleFilter, from, through]);
  const groups = useMemo(() => albumPhotoGroups(shown, groupCopies, () => !!access?.current()), [shown, groupCopies, access]);
  const reviewed = useMemo(() => albumReviewedPeople(photos, facts, () => !!access?.current()).map(person => ({...person, names: [person.names[0] + " · " + contributor(JSON.parse(person.id)[0])]})), [photos, facts, access, names]);
  const openDetails = (photo: Photo) => action(async () => {
    if (!access || accessRef.current !== access || factsState === "legacy") return;
    let source = ownedAlbumDetails(photo, currentOwnedPhotos?.() ?? null);
    if (!source?.current() && onLoadOwnedPhoto) {
      await onLoadOwnedPhoto(photo, controller.signal);
      if (!scope.current?.() || accessRef.current !== access || !access.current()) throw new Error("ALBUM_SELECTION_CHANGED");
      source = ownedAlbumDetails(photo, currentOwnedPhotos?.() ?? null);
    }
    if (!source?.current()) throw new Error("ALBUM_SELECTION_CHANGED");
    const latest = await access.readFactsFor(photo);
    if (!source.current() || !scope.current?.() || accessRef.current !== access) throw new Error("ALBUM_SELECTION_CHANGED");
    setDetailDraft({photo, source, revision: (latest?.revision ?? 0) + 1, people: [], location: false, existing: !!latest && (!!latest.people.length || !!latest.location)});
  });
  let chosen = 0;
  try {chosen = chosenSnapshot.current ? albumOwnedSelection(chosenSnapshot.photos, session, currentPhotos()).length : 0;} catch {}
  const refresh = () => entryFailed ? initialize() : action(async () => {
    const list = await loadInbox();
    if (access) {const item = list?.find(item => item.definition.body === access.overview.definition.body && item.definition.signature === access.overview.definition.signature); if (!item || item.endedAt) {closeAlbum(); setNotice("Album access has ended.");} else await refreshOpened(access, item);}
  });
  const memberIDs = access?.definition.members.map(member => member.card.accountId) ?? [];
  const photoCount = access?.overview.membership === "accepted" ? page.photoCount : access?.overview.photoCount ?? 0;
  const previewDate = preview && albumDateTag(preview.metadata), previewIndex = preview ? shown.indexOf(preview) : -1;
  const previewOwned = preview && ownedAlbumDetails(preview, currentOwnedPhotos?.() ?? null);
  const prepareDownload = () => action(async () => {
    if (!access || !preview) return;
    clearDownload();
    const prepared = {access, photo: preview, files: [] as File[], controller: new AbortController()};
    preparedDownload.current = prepared;
    const files = await albumOriginalFiles(access, preview, prepared.controller.signal);
    if (preparedDownload.current !== prepared || !scope.current?.() || !access.current()) {files.length = 0; return;}
    prepared.files = files; setDownloadReady(true);
  });
  const download = () => {
    const prepared = preparedDownload.current;
    const current = () => !!prepared && preparedDownload.current === prepared && prepared.access === access && prepared.photo === preview && !prepared.controller.signal.aborted && !!scope.current?.() && prepared.access.current();
    if (!prepared || !current()) {clearDownload(); return;}
    // Original bytes and access checks are prepared first; the download starts in this fresh click.
    void shareOriginals(prepared.files, current, {canShare: () => false, download: file => {
      const url = URL.createObjectURL(file), anchor = document.createElement("a"), revoke = () => {anchor.remove(); URL.revokeObjectURL(url);};
      controller.signal.addEventListener("abort", revoke, {once: true}); prepared.access.signal.addEventListener("abort", revoke, {once: true});
      anchor.href = url; anchor.download = file.name; anchor.hidden = true; document.body.append(anchor);
      try {anchor.click();} finally {setTimeout(() => {revoke(); controller.signal.removeEventListener("abort", revoke); prepared.access.signal.removeEventListener("abort", revoke);}, 1000);}
    }}).catch(() => {if (scope.current?.()) setError("The original could not be downloaded. Try again.");});
  };
  return <aside ref={panel} className="albums-sheet" role="dialog" aria-modal="true" aria-label="Live albums" tabIndex={-1}>
    <header inert={preview ? true : undefined}>
      {access && <button className="album-icon-button" disabled={busy} onClick={closeAlbum} aria-label="All albums"><Icon kind="previous" /></button>}
      <div className="album-heading"><h2>{access ? access.title : creating ? "New album" : "Live albums"}</h2>
        {access && <div className="album-chips" aria-label="Album summary"><span>{photoCount} {photoCount === 1 ? "photo" : "photos"}</span><span aria-label={`${memberIDs.length} invited roster members`}>{memberIDs.length} people</span></div>}
      </div>
      {!access && !ownerReview && !creating && available && <button onClick={() => setCreating(true)}>New album</button>}
      {available && <details className="album-menu" onKeyDown={event => {if (event.key === "Escape") {event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();}}}>
        <summary>More</summary><div>
          <button disabled={busy} onClick={() => void refresh()}>Refresh</button>
          {incoming && onRetryAccount && <button disabled={busy} onClick={onRetryAccount}>Use another account</button>}
          {access && <details className="album-roster"><summary>Details</summary><p className="hint">Fixed invited roster</p><ul>{access.definition.members.map(member => <li key={member.card.accountId}><span>{contributor(member.card.accountId)}</span><small>{identityLabel(member.card)}</small></li>)}</ul><p className="hint">Search includes filenames, capture dates and explicitly shared details. Private labels stay in your account.</p></details>}
          {access?.definition.ownerAccountId === session.accountId && <>
            <button disabled={busy} onClick={() => void action(async () => {const link = createAlbumLink(access.albumId, session.card, location.origin); await navigator.clipboard.writeText(link); if (scope.current?.()) setNotice("Album link copied. Only invited accounts can accept it.");})}>Copy invitation link</button>
            <details><summary>End access</summary><label><input type="checkbox" checked={confirmEnd} onChange={event => setConfirmEnd(event.target.checked)} />End album access for everyone</label><button disabled={busy || !confirmEnd} onClick={() => void action(async () => {await access.end(); closeAlbum(); await loadInbox(); setError(""); setNotice("Album access ended.");})}>End access</button></details>
          </>}
        </div>
      </details>}
      <button className="album-icon-button" onClick={close} aria-label="Close albums"><Icon kind="close" /></button>
    </header>
    <div className="albums-content" inert={preview ? true : undefined} aria-busy={busy || available === null}>
      {error && <p className="hint" role="alert">{available === false ? unsupported ? "Live albums are unavailable on this server. Existing photos and Share still work." : "Live albums could not be opened. Try again." : error}</p>}
      {entryFailed && <button className="primary-action" disabled={busy} onClick={() => void initialize()}>Try again</button>}
      {notice && <p className="hint" role="status">{notice}</p>}
      {available === null && <p role="status">Checking album availability…</p>}
      {available && <>
        {ownerReview && incoming ? <section className="identity-confirmation">
          <h3>{ownerChanged ? "The album owner's identity changed" : "Accept the album owner"}</h3>
          <p className="hint">Only accept an album link sent to you by its owner. {ownerChanged && "Confirm the new link with them before continuing."}</p>
          <details className="album-roster"><summary>Verify sender</summary><p className="contact-identity">Fotoro {identityLabel(incoming.link.ownerCard)}</p></details>
          <button className="primary-action" disabled={busy} onClick={() => void action(async () => {const accepted = await joinAlbumInvitation(ownerReview, scope, incoming.link.ownerCard); if (!scope.current?.()) return; setOwnerReview(null); await open(accepted); await loadInbox();})}>{ownerChanged ? "Join album with new identity" : "Join album"}</button>
        </section> : access ? <>
          {access.overview.membership === "invited" ? <>
            <p>Accept to view this album and add chosen Saved photos. Its invited members stay fixed.</p>
            <button className="primary-action" disabled={busy} onClick={() => void action(async () => {const accepted = await joinAlbumInvitation(access.overview, scope); await open(accepted); await loadInbox();})}>Join album</button>
          </> : <>
            <div className="album-toolbar"><input type="search" aria-label="Search album people, places, filenames or capture dates" placeholder="Search album" value={query} onChange={event => setQuery(event.target.value)} />
              {chosen ? <button className="primary-action" disabled={busy} onClick={() => void action(async () => {const added = await access.add(chosenSnapshot.photos, currentPhotos); const list = await loadInbox(); const updated = list?.find(item => item.definition.body === access.overview.definition.body); if (updated) await refreshOpened(access, updated); setNotice(added ? `${added} ${added === 1 ? "photo added" : "photos added"}.` : "Already in this album.");})}>Add {chosen} {chosen === 1 ? "photo" : "photos"}</button> : <button disabled={busy} onClick={() => onChoosePhotos(access.albumId)}>Choose photos</button>}
            </div>
            <div className="album-filters"><PeopleFilter people={reviewed} value={peopleFilter} onChange={setPeopleFilter} disabled={busy} />
              <details><summary>Time and copies</summary><div className="album-range"><label>Captured from<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>Captured through<input type="date" value={through} onChange={event => setThrough(event.target.value)} /></label>
                {(from || through) && <button onClick={() => {setFrom(""); setThrough("");}}>Clear dates</button>}<label><input type="checkbox" checked={groupCopies} onChange={event => setGroupCopies(event.target.checked)} />Group exact copies</label></div></details></div>
            {factsState === "loading" && <p className="hint" role="status">Loading shared details…</p>}
            {factsState === "legacy" && <p className="hint" role="status">This server supports filenames and capture dates. Shared details are unavailable.</p>}
            {factsState === "error" && <p className="hint" role="status">Shared details could not load. Filename and date search still work. <button disabled={busy} onClick={() => void action(() => readFacts(access))}>Retry details</button></p>}
            {factsState === "partial" && !page.hasMore && <p className="hint" role="status">New photo details are available. <button disabled={busy} onClick={() => void refresh()}>Refresh photos</button></p>}
            {busy && !photos.length && <p className="hint" role="status">Loading photos…</p>}
            {(query || peopleFilter.ids.size > 0 || from || through) && <p role="status">{shown.length} matching {shown.length === 1 ? "photo" : "photos"}</p>}
            {groups.length < shown.length && <p className="hint">{groups.length} exact originals · {shown.length} contributed copies. All copies are kept.</p>}
            <div className="album-grid">{groups.map(group => {const photo = group.photo, shared = sharedAlbumDetails(photo, facts), date = albumDateTag(photo.metadata); return <div className="tile" key={photo.manifest.photoId}><AlbumImage access={access} photo={photo} onOpen={() => setPreview(photo)} /><div className="album-photo-tags" aria-label="Photo information"><span aria-label="Contributor">{contributor(photo.manifest.ownerAccountId)}</span>{date && <span aria-label={date.label}>{date.text}</span>}{shared?.people.map(name => <span key={name} aria-label="Shared reviewed person">{name}</span>)}{shared?.location?.name && <span aria-label="Shared place">{shared.location.name}</span>}</div>
              {group.copies.length > 1 && <details className="album-copies"><summary>{group.copies.length} copies</summary>{group.copies.map(copy => <button key={copy.manifest.photoId} onClick={() => setPreview(copy)}>{contributor(copy.manifest.ownerAccountId)} · {copy.metadata.filename}</button>)}</details>}</div>;})}</div>
            {page.hasMore && <div className="hint" aria-label="Album coverage"><p role="status">{photos.length} of {page.photoCount} photos loaded. Search covers loaded photos.</p><button disabled={busy} onClick={() => void action(() => loadPage(access, page.nextCursor))}>Load more photos</button></div>}
            {!photos.length && !busy && <p>No contributions yet.</p>}
          </>}
        </> : <>
          {creating && <form onSubmit={event => {event.preventDefault(); void action(async () => {const created = await createAlbum(title, cards.filter(card => invitees.has(card.accountId)), scope, creationDraft.current); setTitle(""); setInvitees(new Set()); setCreating(false); await loadInbox(); await open(created);});}}>
            <label>Album title<input value={title} onChange={event => {creationDraft.current = {}; setTitle(event.target.value);}} required disabled={busy} aria-describedby="album-title-limit" /></label>
            <p className="hint" id="album-title-limit">Up to 80 characters. Choose 1 to 11 accepted contacts. Invitations require acceptance.</p>
            <fieldset disabled={busy}><legend>Invite contacts</legend>{cards.map(card => <label key={card.accountId}><input type="checkbox" checked={invitees.has(card.accountId)} disabled={!invitees.has(card.accountId) && invitees.size >= 11} onChange={event => {creationDraft.current = {}; setInvitees(previous => {const next = new Set(previous); if (event.target.checked) next.add(card.accountId); else next.delete(card.accountId); return next;});}} />{contributor(card.accountId)}</label>)}</fieldset>
            {!cards.length && <p className="hint">Accept contacts in Share in Fotoro first.</p>}
            <button type="submit" className="primary-action" disabled={busy || !title.trim() || [...title].length > 80 || !invitees.size}>Create and invite</button>
            <button type="button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button>
          </form>}
          {!creating && <div className="album-inbox">{items.map(item => {const definition = readAlbumSignedBody(item.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition), label = titles.get(definition.albumId) || (item.membership === "invited" ? "Album invitation" : "Album"); return <button className="album-inbox-card" key={definition.albumId} disabled={busy || !!item.endedAt} onClick={() => void action(() => open(item))} aria-label={`${item.membership === "invited" ? "Review invitation to" : "Open"} ${label}`}><div><strong>{label}</strong><div className="album-chips"><span>{item.photoCount} {item.photoCount === 1 ? "photo" : "photos"}</span><span>{definition.members.length} people</span><span>{item.endedAt ? "Access ended" : item.membership === "invited" ? "Invitation" : contributor(definition.ownerAccountId, definition.members.map(member => member.card.accountId))}</span></div></div><Icon kind="next" /></button>;})}</div>}
          {!creating && !items.length && !busy && <p>No albums or invitations yet.</p>}
        </>}
      </>}
    </div>
    {preview && access && <section ref={previewPanel} className="album-preview" aria-label={preview.metadata.filename} tabIndex={-1} onKeyDown={event => {if (event.key === "ArrowLeft" && previewIndex > 0) {event.preventDefault(); setPreview(shown[previewIndex - 1]);} else if (event.key === "ArrowRight" && previewIndex >= 0 && previewIndex < shown.length - 1) {event.preventDefault(); setPreview(shown[previewIndex + 1]);}}}>
      <header><button className="album-icon-button" onClick={() => setPreview(null)} aria-label="Back to album"><Icon kind="previous" /></button><p>{previewIndex + 1} of {shown.length}</p><div className="actions"><button className="album-icon-button" aria-label="Previous photo" disabled={previewIndex <= 0} onClick={() => setPreview(shown[previewIndex - 1])}><Icon kind="previous" /></button><button className="album-icon-button" aria-label="Next photo" disabled={previewIndex < 0 || previewIndex >= shown.length - 1} onClick={() => setPreview(shown[previewIndex + 1])}><Icon kind="next" /></button></div></header>
      <AlbumImage access={access} photo={preview} preview />
      <div className="album-photo-tags" aria-label="Photo information"><span aria-label="Contributor">{contributor(preview.manifest.ownerAccountId)}</span>{previewDate && <span aria-label={previewDate.label}>{previewDate.text}</span>}</div>
      <div className="album-photo-tags" aria-label="Shared photo details">{sharedAlbumDetails(preview, facts)?.people.map(name => <span key={name} aria-label="Shared reviewed person">{name}</span>)}{sharedAlbumDetails(preview, facts)?.location && <span aria-label="Shared photo location">{sharedAlbumDetails(preview, facts)?.location?.name || "Photo location shared"}</span>}</div>
      <details className="album-preview-details"><summary>Details</summary><p>{preview.metadata.filename}</p>
        {error && <p className="hint" role="alert">{error}</p>}{notice && <p className="hint" role="status">{notice}</p>}
        {preview.manifest.ownerAccountId === session.accountId && factsState !== "legacy" && <button disabled={busy || (!previewOwned && !onLoadOwnedPhoto)} onClick={() => void openDetails(preview)}>Share details</button>}
        {detailDraft && detailDraft.photo === preview && <section className="album-share-details" aria-label="Share photo details"><h3>Share photo details</h3><p className="hint">Choose details to share with album members. Unchecked details are removed on save.</p>
          <AlbumNameChoices names={detailDraft.source.people} selected={detailDraft.people} disabled={busy || !detailDraft.source.current()} onChange={people => setDetailDraft({...detailDraft, people})} />
          <label><input type="checkbox" checked={detailDraft.location} disabled={busy || !detailDraft.source.location || !detailDraft.source.current()} onChange={event => setDetailDraft({...detailDraft, location: event.target.checked})} />Photo location{detailDraft.source.location?.name ? ": " + detailDraft.source.location.name : ""}</label>
          {detailDraft.source.location && <p className="hint">Sharing location includes exact coordinates.</p>}
          {!detailDraft.source.current() && <p className="hint" role="alert">The Saved source changed. Refresh details and review again.</p>}
          <div className="actions"><button disabled={busy || !detailDraft.source.current() || (!detailDraft.people.length && !detailDraft.location && !detailDraft.existing)} onClick={() => void action(async () => {
            const draft = detailDraft; const content = await access.shareDetails(draft.photo, draft.source, draft, draft.revision);
            if (scope.current?.() && accessRef.current === access && draft.source.current()) {setFacts(current => new Map(current).set(draft.photo.manifest.photoId, content)); setDetailDraft(null); setNotice(content.people.length || content.location ? "Selected details shared." : "Shared details cleared.");}
          })}>{detailDraft.people.length || detailDraft.location ? "Share selected details" : "Clear shared details"}</button><button disabled={busy} onClick={() => void openDetails(preview)}>Refresh details</button><button disabled={busy} onClick={() => setDetailDraft(null)}>Cancel</button></div></section>}
        <button disabled={busy} onClick={downloadReady ? download : () => void prepareDownload()}>{downloadReady ? "Download original" : busy ? "Preparing…" : "Prepare download"}</button></details>
    </section>}
  </aside>;
}
