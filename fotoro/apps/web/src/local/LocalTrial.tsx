import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../library/icons";
import { LocalLibrary } from "./LocalLibrary";
import { LocalViewer } from "./LocalViewer";
import { LocalSearch } from "./LocalSearch";
import { LocalRetention } from "./retention";
import { PhotoSearchIndex, emptyFeedback, normalizeSearch, type SearchMeaning, type SearchResult } from "./search";
import { OCR_PROCESSOR } from "./ocr";
import { useLocalOcr, type LocalOcrPhoto } from "./useLocalOcr";
import { collectLocalFiles, type LocalPhoto, LocalResources } from "./resources";
import {loadLocalChoices, saveLocalChoices} from "./preferences";
import {syncStateLabel, type ConsumerSyncSummary} from "../library/consumer-sync";
import {savedSearchPhotos, combineConsumerSearch, mergeConsumerSearchPhotos, ConsumerPreviewResources, type OwnedPhotoSnapshot} from "../library/consumer-search";
import {inRecentSelectedRange} from "./consumer-range";
import {usePhotoPicks} from "./usePhotoPicks";
import {PhotoPicks} from "./PhotoPicks";
import {useDialogFocus} from "../library/dialog-focus";
export function selectedOriginals(photos: LocalPhoto[], selected?: ReadonlySet<string>): File[] {
  return photos.flatMap(photo => photo.file instanceof File && (!selected || selected.has(photo.id)) ? [photo.file] : []);
}
/* The digest, never a filename, reconnects original operations and supplied labels. */
export function mergeSelectedPhotos(existing: LocalPhoto[], selected: LocalPhoto[]): LocalPhoto[] {
  const result = new Map(existing.map(photo => [photo.id, photo]));
  for (const photo of selected) {
    const previous = result.get(photo.id) as LocalOcrPhoto | undefined;
    const merged = {...previous, ...photo, labels: previous?.labels ?? photo.labels ?? []} as LocalOcrPhoto;
    if (photo.file) {merged.preview = undefined; merged.previewLoader = undefined; merged.previewAvailable = undefined; merged.previewSize = undefined;}
    if (previous?.ocr?.status === "failed" && !previous.file && photo.file) merged.ocr = undefined;
    result.set(photo.id, merged);
  }
  return [...result.values()].sort((a, b) => b.date.localeCompare(a.date));
}
export interface SearchNavigation { query: string; scope: string; meaningID: string; photoID: string }
/* Manual browsing changes the visible photo, while the ranked hit list and default pin remain intact. */
export function displaySearchResult(predicted: SearchResult, navigation?: SearchNavigation): SearchResult {
  if (navigation && navigation.query === predicted.query && navigation.scope === predicted.scope && navigation.meaningID === predicted.meaning?.id && predicted.photoIds.includes(navigation.photoID))
    return {...predicted, photoId: navigation.photoID};
  return predicted;
}
export function LocalTrial({onBackup, onPhotosChange, syncSummary, ownedPhotos = null, onOpenSaved, active = true}: {onBackup: () => void; onPhotosChange?: (photos: LocalPhoto[]) => void; syncSummary?: ConsumerSyncSummary; ownedPhotos?: OwnedPhotoSnapshot | null; onOpenSaved?: (id: string) => void; active?: boolean}) {
  const [photos, setPhotos] = useState<LocalOcrPhoto[]>([]), [query, setQuery] = useState(""),
    [viewer, setViewer] = useState<string | null>(null), [settings, setSettings] = useState(false),
    [last30, setLast30] = useState(false), [status, setStatus] = useState(""), [progress, setProgress] = useState(""),
    [retained, setRetained] = useState(false), [retentionBusy, setRetentionBusy] = useState(false), [ready, setReady] = useState(false), [saving, setSaving] = useState(""),
    [readText, setReadText] = useState(() => loadLocalChoices()?.readText ?? false), [feedback, setFeedback] = useState(emptyFeedback),
    [committed, setCommitted] = useState<string>(), [navigation, setNavigation] = useState<SearchNavigation>(), [sourceGeneration, setSourceGeneration] = useState(0);
  const [reviewingPicks, setReviewingPicks] = useState(false);
  const input = useRef<HTMLInputElement>(null), settingsPanel = useRef<HTMLElement>(null), generation = useRef(0),
    importing = useRef<number | null>(null), alive = useRef(false), retainedRef = useRef(false), saveVersion = useRef(0),
    previous = useRef<SearchResult | undefined>(undefined), session = useRef(crypto.randomUUID());
  const [resources] = useState(() => new LocalResources()), [savedResources] = useState(() => new ConsumerPreviewResources()), [retention] = useState(() => new LocalRetention());
  const closeSettings = () => setSettings(false);
  useDialogFocus(settingsPanel, closeSettings, settings);
  retainedRef.current = retained;
  const picks = usePhotoPicks(photos, resources, ready && !progress);
  const reviewedPhotos = useMemo(() => photos.filter(photo => picks.ids.has(photo.id)), [photos, picks.ids]);
  const openBackup = () => {onPhotosChange?.(reviewedPhotos); onBackup();};
  const scope = "local:all";
  const scoped = useMemo(() => photos.filter(photo => !last30 || inRecentSelectedRange(photo)), [photos, last30]);
  const savedPhotos = useMemo(() => savedSearchPhotos(ownedPhotos, photos), [ownedPhotos, photos]);
  const searchPhotos = useMemo(() => mergeConsumerSearchPhotos(photos, savedPhotos), [photos, savedPhotos]);
  const index = useMemo(() => new PhotoSearchIndex(photos.map(photo => photo.ocr && photo.ocr.processor !== OCR_PROCESSOR ? {...photo, ocr: undefined} : photo), feedback), [photos, feedback]);
  const localPredicted = useMemo(() => index.search(query, {scope, committedMeaning: committed, previous: previous.current}), [index, query, committed]);
  const savedIndex = useMemo(() => new PhotoSearchIndex(savedPhotos), [savedPhotos]);
  const savedPredicted = useMemo(() => savedIndex.search(query, {scope: "saved:" + (ownedPhotos?.accountId ?? ""), committedMeaning: committed}), [savedIndex, query, ownedPhotos?.accountId, committed]);
  const predicted = useMemo(() => combineConsumerSearch(localPredicted, savedPredicted, committed), [localPredicted, savedPredicted, committed]);
  const result = useMemo(() => displaySearchResult(predicted, navigation), [predicted, navigation]);
  useEffect(() => {previous.current = result; if (committed && result.meaning?.id !== committed) setCommitted(undefined);}, [result, committed]);
  const matching = useMemo(() => result.photoIds.flatMap(id => {const photo = searchPhotos.find(value => value.id === id); return photo ? [photo] : [];}), [result.photoIds, searchPhotos]);
  const viewerPhotos = normalizeSearch(query) ? matching : scoped;
  const viewing = !!viewer && viewerPhotos.some(photo => !photo.id.startsWith("saved:"));
  useEffect(() => {if (viewer && !viewing) setViewer(null);}, [viewer, viewing]);
  const pin = result.meaning ? feedback.pins[JSON.stringify([scope, result.meaning.id])] : undefined;
  const available = scoped.filter(photo => photo.previewAvailable !== false && (photo.file || photo.preview || photo.previewLoader)).length,
    textComplete = scoped.filter(photo => photo.ocr?.status === "complete").length;
  const coverage = `${scoped.length} photos${readText || textComplete ? ` · ${textComplete} with text read` : ""}${available < scoped.length ? ` · ${scoped.length - available} need to be reopened` : ""}`;
  const ocrProgress = useLocalOcr(photos, readText, resources, sourceGeneration, output => {
    setPhotos(current => current.map(photo => photo.id === output.photoID && (photo.digest ?? photo.id) === output.revision ? {...photo, ocr: output} : photo));
  });
  const bump = () => {generation.current++; setSourceGeneration(value => value + 1); importing.current = null;};
  const reset = (message = "") => {
    bump(); retainedRef.current = false; setRetained(false); saveVersion.current++; resources.clear();
    picks.clear(); setReviewingPicks(false);
    setPhotos([]); setFeedback(emptyFeedback()); setViewer(null); setQuery(""); setCommitted(undefined); previous.current = undefined; setNavigation(undefined);
    setProgress(""); setSaving(""); setStatus(message);
  };
  useEffect(() => {
    alive.current = true;
    const token = generation.current;
    const stop = retention.watchClear(() => {if (alive.current) {reset("Local search was cleared in another tab."); setReady(true);}});
    void retention.load().then(saved => {
      if (!alive.current || token !== generation.current) return;
      setPhotos(saved.photos); setFeedback(saved.feedback); setRetained(saved.enabled); retainedRef.current = saved.enabled;
      if (saved.skipped) setStatus(`${saved.skipped} saved records could not be opened. Coverage is incomplete.`);
    }).catch(error => {if (alive.current && token === generation.current) setStatus(error.message);})
      .finally(() => {if (alive.current && token === generation.current) setReady(true);});
    return () => {alive.current = false; generation.current++; saveVersion.current++; stop(); resources.clear();};
  }, [resources, retention]);
  // Selection changes stay local until Sync is opened; clearing revokes old File references.
  useEffect(() => {if (!photos.length) onPhotosChange?.([]);}, [photos.length, onPhotosChange]);
  useEffect(() => {
    const clearSaved = () => savedResources.clear();
    window.addEventListener("fotoro-lock", clearSaved);
    return () => {window.removeEventListener("fotoro-lock", clearSaved); savedResources.clear();};
  }, [savedResources]);
  useLayoutEffect(() => {savedResources.clear();}, [ownedPhotos?.token, ownedPhotos?.photos, savedResources]);
  useEffect(() => {
    if (!ready || !retained) return;
    const token = generation.current, version = ++saveVersion.current;
    const current = () => alive.current && retainedRef.current && generation.current === token && saveVersion.current === version;
    const timeout = setTimeout(() => {
      if (!current()) return;
      setSaving("Saving local search…");
      void retention.save(photos, feedback, current, async photo => {
        if (!current() || !photo.file) return;
        try {return (await resources.load(photo, "preview")).blob;}
        catch {return undefined;}
      }).then(saved => {
        if (current()) {const coverage = retention.previewCoverage; setSaving(saved ? `Saved locally · ${coverage.count} of ${photos.length} previews` : "This update was not retained.");}
      }).catch(error => {if (current()) {setSaving("Changes could not be retained."); setStatus(`${error.message} Current selected photos remain usable in this session.`);}});
    }, 180);
    return () => {clearTimeout(timeout); if (saveVersion.current === version) saveVersion.current++;};
  }, [photos, feedback, retained, ready, resources, retention]);
  const changeQuery = (value: string) => {
    setNavigation(undefined);
    if (!normalizeSearch(query) && normalizeSearch(value)) session.current = crypto.randomUUID();
    if (!normalizeSearch(value)) {setCommitted(undefined); previous.current = undefined;}
    setQuery(value);
  };
  const editSelection = () => {changeQuery(""); setLast30(false); setReviewingPicks(true);};
  async function openFiles(files: File[]) {
    if (!files.length || importing.current !== null || !ready) return;
    bump(); const token = generation.current; importing.current = token;
    const current = () => alive.current && generation.current === token;
    setStatus(""); setProgress("Opening photos…");
    try {
      const opened = await collectLocalFiles(files, current, append => {if (current()) setPhotos(currentPhotos => current() ? mergeSelectedPhotos(currentPhotos, append) : currentPhotos);},
        completed => {if (current()) setProgress(completed < files.length ? `Opening ${completed} of ${files.length}…` : "");});
      if (current() && opened.skipped) setStatus(`${opened.skipped} ${opened.skipped === 1 ? "file was" : "files were"} skipped. ${opened.reason}`);
    } finally {if (importing.current === token) importing.current = null; if (current()) setProgress("");}
  }
  const failure = (id: string, message: string) => {
    setPhotos(current => current.some(photo => photo.id === id && photo.previewAvailable !== false) ? current.map(photo => photo.id === id ? {...photo, previewAvailable: false} : photo) : current);
    setStatus(message);
  };
  const accept = (meaning: SearchMeaning) => {
    setNavigation(undefined);
    if (localPredicted.meanings.some(value => value.id === meaning.id)) {index.acceptMeaning(meaning.id, session.current, Date.now(), scope); setFeedback(index.feedback());}
    setCommitted(meaning.id);
  };
  const confirm = (id: string, pin = false) => {
    if (!result.meaning || localPredicted.meaning?.id !== result.meaning.id || !localPredicted.photoIds.includes(id)) return;
    if (pin) setNavigation(undefined);
    index.choosePhoto(result.meaning.id, id, session.current, Date.now(), pin, scope); setFeedback(index.feedback());
    setStatus(pin ? "Preferred photo saved on this device." : "Photo choice saved on this device.");
  };
  const toggleRetention = async (enabled: boolean) => {
    if (retentionBusy) return;
    if (enabled) {retainedRef.current = true; setRetained(true); return;}
    setRetentionBusy(true); bump(); retainedRef.current = false; setRetained(false); saveVersion.current++; resources.clear(); setViewer(null);
    setPhotos(current => current.filter(photo => photo.file).map(photo => ({...photo, preview: undefined, previewLoader: undefined, previewAvailable: undefined, previewSize: undefined})));
    try {await retention.clear(); setSaving(""); setStatus("Saved search removed. Selected originals stay in this session.");}
    catch (error) {setStatus(`Local storage could not be cleared: ${(error as Error).message}`);}
    finally {if (alive.current) setRetentionBusy(false);}
  };
  const clear = async () => {reset(); try {await retention.clear();} catch (error) {setStatus(`Local storage could not be cleared: ${(error as Error).message}`);}};
  return <>
    <main inert={viewing || settings ? true : undefined} className="local-trial">
      <header><div className="brand"><p className="eyebrow">Your photos</p><h1>Fotoro</h1></div><div className="header-actions"><button className={"sync-pill glass state-" + (syncSummary?.state ?? "notStarted")} onClick={openBackup} aria-label={(syncSummary ? syncStateLabel[syncSummary.state] : "Sync photos") + ". Open sync details"}><span className="sync-dot" aria-hidden="true" /><span>{syncSummary ? syncStateLabel[syncSummary.state] : "Sync photos"}</span></button><button className="menu-button glass" aria-label="Settings" onClick={() => setSettings(true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button></div></header>
      {normalizeSearch(query) && searchPhotos.length ? <LocalSearch key={sourceGeneration} photos={searchPhotos} result={result} resources={result.photoId?.startsWith("saved:") ? savedResources : resources} committed={committed} pinned={pin} canCorrect={!!result.photoId && localPredicted.meaning?.id === result.meaning?.id && localPredicted.photoIds.includes(result.photoId)} coverage={coverage + (savedPhotos.length ? ` · ${savedPhotos.length} saved photos available` : "")} onAccept={accept} onNavigate={id => setNavigation({query, scope, meaningID: result.meaning!.id, photoID: id})} onOpen={id => id.startsWith("saved:") ? onOpenSaved?.(id.slice(6)) : setViewer(id)} onConfirm={id => confirm(id)} onPin={id => confirm(id, true)} onFailure={failure} />
        : !photos.length ? <section className="local-empty"><h2>Your photos, close by.</h2><p className="hint">Choose photos to browse and search here.{savedPhotos.length > 0 && <> Your saved photos are ready to search.</>}</p><button className="open-photos" disabled={!ready || !!progress} onClick={() => input.current?.click()}>Open photos</button><p className="hint">Photos stay on this device until you choose to sync.<br />This browser opens the files you select.</p>{!ready && <p role="status">Opening saved search…</p>}</section>
        : scoped.length ? <><PhotoPicks count={picks.ids.size} total={photos.length} ready={selectedOriginals(photos, picks.ids).length} busy={picks.busy} done={picks.done} detail={syncSummary?.detail} reviewing={reviewingPicks} onReview={() => reviewingPicks ? setReviewingPicks(false) : editSelection()} /><LocalLibrary key={sourceGeneration} active={active} photos={scoped} resources={resources} onOpen={setViewer} onFailure={failure} selection={reviewingPicks ? {ids: picks.ids, reasons: picks.recommendations?.reasons, disabled: picks.busy, onChange: picks.choose} : undefined} /></>
        : <section className="empty"><p>No photos in this date range</p><button onClick={() => setLast30(false)}>Show all photos</button></section>}
      {searchPhotos.length > 0 && <div className="toolbar glass"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10" cy="10" r="7" /><path d="m15 15 6 6" /></svg><input aria-label="Search photos" placeholder="Search" value={query} onChange={event => changeQuery(event.target.value)} />{query && <button aria-label="Clear search" onClick={() => changeQuery("")}><Icon kind="close" /></button>}<button aria-label="Add photos" disabled={!!progress || !ready} onClick={() => input.current?.click()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 3v18M3 12h18" /></svg></button></div>}
      {last30 && photos.length > 0 && !normalizeSearch(query) && <button className="local-filter" onClick={() => setLast30(false)}>Last 10 days ×</button>}
      {(progress || ocrProgress || saving) && <p className="local-progress" role="status">{progress || ocrProgress || saving}</p>}
      {status && <div className="status" role="status">{status}<button aria-label="Dismiss message" onClick={() => setStatus("")}><Icon kind="close" /></button></div>}
    </main>
    <input ref={input} hidden type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" multiple onChange={event => {const files = Array.from(event.target.files ?? []); event.target.value = ""; void openFiles(files);}} />
    {settings && <aside className="sheet local-settings" ref={settingsPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Settings">
      <button className="close" aria-label="Close settings" onClick={closeSettings}><Icon kind="close" /></button><h2>Photos</h2>
      <label className="local-check"><input type="checkbox" checked={last30} onChange={event => setLast30(event.target.checked)} />Browse the last 10 days</label>
      <p className="hint">Photos without a capture date stay visible. Search covers all selected and unlocked saved photos.</p>
      <h3>Selection</h3>
      <p className="hint">{picks.ids.size} of {photos.length} selected. All photos stay available.</p>
      <div className="photo-pick-actions">
        <button disabled={!photos.length} onClick={() => {closeSettings(); editSelection();}}>Edit selection</button>
        <button disabled={!photos.length || picks.busy} onClick={picks.suggested}>Suggested 10%</button>
        <button disabled={!photos.length} onClick={picks.chooseAll}>Select all</button>
      </div>
      {(picks.recommendations?.unassessed ?? 0) > 0 && <p className="hint">{picks.recommendations!.unassessed} could not be assessed. You can still select them.</p>}
      <h3>Search and storage</h3>
      <label className="local-check"><input type="checkbox" checked={readText} onChange={event => {const choice = {readText: event.target.checked, retain: retained}; saveLocalChoices(choice); setReadText(choice.readText);}} />Find words in photos</label>
      <p className="hint">Find photos by English words inside them. Text is read on this device.</p>
      <label className="local-check"><input type="checkbox" checked={retained} disabled={!ready || retentionBusy} onChange={event => {const choice = {readText, retain: event.target.checked}; saveLocalChoices(choice); void toggleRetention(choice.retain);}} />Remember these photos</label>
      <p className="hint">Keep search data and up to 100 MB of previews in this browser. Original files are not retained.</p>
      {saving && <p role="status">{saving}</p>}
      <button onClick={() => {closeSettings(); openBackup();}}>Sync photos</button>
      <p className="hint">Sync selected photos to your account to use them on another device.</p>
      <details><summary>About local storage</summary><p className="hint">Originals stay unchanged and aren’t saved in this browser. Saved previews use up to 100 MB. Browser storage may be cleared, so keep your original files. Choose photos to open; this browser cannot scan your Photos library.</p></details>
      <button disabled={!ready} onClick={() => {void clear(); closeSettings();}}>Clear local search</button>
    </aside>}
    {viewing && viewer && <LocalViewer photos={viewerPhotos.filter(photo => !photo.id.startsWith("saved:"))} initial={viewer} resources={resources} onLabels={(id, labels) => setPhotos(current => current.map(photo => photo.id === id ? {...photo, labels} : photo))} onUse={normalizeSearch(query) ? id => confirm(id) : undefined} onConfirm={normalizeSearch(query) ? id => confirm(id) : undefined} onPin={normalizeSearch(query) ? id => confirm(id, true) : undefined} meaning={result.meaning?.term} onReselect={() => {input.current?.click(); setViewer(null);}} onClose={() => setViewer(null)} />}
  </>;
}
