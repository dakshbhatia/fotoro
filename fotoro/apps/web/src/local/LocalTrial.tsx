import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../library/icons";
import { LocalLibrary } from "./LocalLibrary";
import { LocalViewer } from "./LocalViewer";
import { LocalSearch } from "./LocalSearch";
import { LocalRetention } from "./retention";
import { PhotoSearchIndex, emptyFeedback, normalizeSearch, type SearchMeaning, type SearchResult } from "./search";
import { OCR_PROCESSOR, hasCurrentLocalOcr, localTextSearchStatus } from "./ocr";
import { useLocalOcr, type LocalOcrPhoto } from "./useLocalOcr";
import { collectLocalFiles, type LocalPhoto, LocalResources } from "./resources";
import {loadLocalChoices, saveLocalChoices} from "./preferences";
import {savedSearchPhotos, combineConsumerSearch, mergeConsumerSearchPhotos, ConsumerPreviewResources, type OwnedPhotoSnapshot} from "../library/consumer-search";
import {inRecentSelectedRange} from "./consumer-range";
import {usePhotoPicks} from "./usePhotoPicks";
import {useDialogFocus} from "../library/dialog-focus";
import {canShareOriginals, downloadOriginal, OriginalShareAttempt, prepareSavedOriginals, savedOriginalSelectionCurrent} from "../library/system-share";
import {ShareSelection} from "../exchange/sharing";
import type {Photo} from "../library/catalog";
import {ownedPhotoForLocal, selectedOwnedPhotos, reconcileSavedSelection} from "./selection";
import {findMatchPhotos, shortlistSearchResult} from "./find-best-shots";
import {useSemanticFind} from "./useSemanticFind";
import {useFindBestShots} from "./useFindBestShots";
import {FindBestShots, selectionCandidates} from "./FindBestShots";
import {Places} from "./PhotoPlaces";
import {currentTimelineCandidates} from "./places";
import type {TimelineCandidate} from "./google-timeline";
import type {PhotoLocationV1} from "@fotoro/contracts";
import {annotationLocation} from "@fotoro/contracts/location";
import {requireVault} from "../vault/vault";
import {applyTimelineTargets} from "./timeline-application";
import {withPhotoObservation, type PhotoObservationV1} from "@fotoro/contracts/intelligence";
import {intelligenceScope} from "../intelligence/scope";
import {factsWithPeople} from "@fotoro/contracts/people";
import type {PeopleUpdate} from "../people/People";
import {peopleSourceCurrent} from "../people/groups";
import {peopleEditsVisible} from "../people/settlement";
const People = lazy(() => import("../people/People").then(module => ({default: module.People})));
interface ChosenOriginalContext {
  local: LocalPhoto[]; saved: ShareSelection; snapshot: OwnedPhotoSnapshot; generation: number;
  controller: AbortController; files: File[];
}
export async function prepareChosenOriginals(local: readonly LocalPhoto[], saved: readonly Photo[], signal: AbortSignal, current: () => boolean,
  read: Parameters<typeof prepareSavedOriginals>[3], filesForOriginal?: Parameters<typeof prepareSavedOriginals>[4]) {
  const files = selectedOriginals([...local]);
  const completeLocal = files.length === local.length;
  const check = () => {signal.throwIfAborted(); if (!completeLocal || !local.length && !saved.length || local.some(photo => photo.current?.() === false) || !current()) throw new DOMException("Photo selection changed", "AbortError");};
  try {
    check();
    if (saved.length) files.push(...await prepareSavedOriginals(saved, signal, current, read, filesForOriginal));
    check();
    return files;
  } catch (error) {files.length = 0; throw error;}
}
export function selectedOriginals(photos: LocalPhoto[], selected?: ReadonlySet<string>): File[] {
  return photos.flatMap(photo => photo.file instanceof File && photo.current?.() !== false && (!selected || selected.has(photo.id)) ? [photo.file] : []);
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
export function LocalTrial({onBackup, onSave, onCancelSave, onPhotosChange, ownedPhotos = null, onOpenSaved, onShareSaved, active = true}: {onBackup: () => void; onSave?: (photos: LocalPhoto[]) => void; onCancelSave?: () => void; onPhotosChange?: (photos: LocalPhoto[]) => void; ownedPhotos?: OwnedPhotoSnapshot | null; onOpenSaved?: (id: string) => void; onShareSaved?: (photos: Photo[]) => void; active?: boolean}) {
  const [photos, setPhotos] = useState<LocalOcrPhoto[]>([]), [query, setQuery] = useState(""),
    [viewer, setViewer] = useState<string | null>(null), [settings, setSettings] = useState(false),
    [last30, setLast30] = useState(false), [status, setStatus] = useState(""), [progress, setProgress] = useState(""),
    [retained, setRetained] = useState(false), [retentionBusy, setRetentionBusy] = useState(false), [ready, setReady] = useState(false), [saving, setSaving] = useState(""),
    [readText, setReadText] = useState(() => loadLocalChoices()?.readText ?? false), [feedback, setFeedback] = useState(emptyFeedback),
    [committed, setCommitted] = useState<string>(), [navigation, setNavigation] = useState<SearchNavigation>(), [sourceGeneration, setSourceGeneration] = useState(0);
  const [reviewingPicks, setReviewingPicks] = useState(false);
  const [placesOpen, setPlacesOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [browseScope, setBrowseScope] = useState<"photos" | "picks">("photos"), [sharing, setSharing] = useState(false);
  const [chosenSavedIDs, setChosenSavedIDs] = useState(new Set<string>());
  const [preparingShare, setPreparingShare] = useState(false), [preparedShare, setPreparedShare] = useState<ChosenOriginalContext | null>(null);
  const [originalShareError, setOriginalShareError] = useState("");
  const [originalShareAttempt] = useState(() => new OriginalShareAttempt());
  const originalContext = useRef<ChosenOriginalContext | null>(null), originalPanel = useRef<HTMLElement>(null);
  const activeRef = useRef(active), chosenSavedRef = useRef(chosenSavedIDs);
  activeRef.current = active; chosenSavedRef.current = chosenSavedIDs;
  const chosenSavedToken = useRef<object | null>(null);
  const currentPhotos = useRef(photos), currentOwnedPhotos = useRef(ownedPhotos);
  currentPhotos.current = photos;
  currentOwnedPhotos.current = ownedPhotos;
  const input = useRef<HTMLInputElement>(null), searchInput = useRef<HTMLInputElement>(null), settingsPanel = useRef<HTMLElement>(null), generation = useRef(0),
    importing = useRef<number | null>(null), alive = useRef(false), retainedRef = useRef(false), saveVersion = useRef(0),
    previous = useRef<SearchResult | undefined>(undefined), session = useRef(crypto.randomUUID());
  const [resources] = useState(() => new LocalResources()), [savedResources] = useState(() => new ConsumerPreviewResources()), [retention] = useState(() => new LocalRetention());
  const closeSettings = () => setSettings(false);
  useDialogFocus(settingsPanel, closeSettings, settings);
  retainedRef.current = retained;
  const picks = usePhotoPicks(photos, resources, ready && !progress, sourceGeneration);
  const localSelectionRef = useRef(picks.ids);
  localSelectionRef.current = picks.ids;
  const reviewedPhotos = useMemo(() => photos.filter(photo => picks.ids.has(photo.id)), [photos, picks.ids]);
  const openBackup = () => {onPhotosChange?.(reviewedPhotos); onBackup();};
  const scope = "local:all";
  const scoped = useMemo(() => photos.filter(photo => (!last30 || inRecentSelectedRange(photo)) && (browseScope === "photos" || picks.recommendations?.ids.has(photo.id))), [photos, last30, browseScope, picks.recommendations]);
  const savedPhotos = useMemo(() => savedSearchPhotos(ownedPhotos, photos), [ownedPhotos, photos]);
  const reconciledSelection = useMemo(() => reconcileSavedSelection(ownedPhotos, chosenSavedToken.current, chosenSavedIDs, photos), [ownedPhotos, chosenSavedIDs, photos]);
  const chosenSaved = useMemo(() => selectedOwnedPhotos(ownedPhotos, chosenSavedToken.current, reconciledSelection.savedIDs), [ownedPhotos, reconciledSelection]);
  useLayoutEffect(() => {
    for (const id of reconciledSelection.localIDs) if (!picks.ids.has(id)) picks.choose(id, true);
    setChosenSavedIDs(current => current.size === reconciledSelection.savedIDs.size && [...current].every(id => reconciledSelection.savedIDs.has(id)) ? current : reconciledSelection.savedIDs);
  }, [reconciledSelection]);
  const chooseSearchPhoto = (id: string, checked: boolean) => {
    if (!id.startsWith("saved:")) {picks.choose(id, checked); return;}
    const photoId = id.slice(6);
    if (!ownedPhotos?.current() || !ownedPhotos.photos.some(photo => !photo.grantId && photo.manifest.ownerAccountId === ownedPhotos.accountId && photo.manifest.photoId === photoId)) return;
    const sameSelection = chosenSavedToken.current === ownedPhotos.token;
    chosenSavedToken.current = ownedPhotos.token;
    setChosenSavedIDs(current => {const next = new Set(sameSelection ? current : []); checked ? next.add(photoId) : next.delete(photoId); return next;});
  };
  const searchSelectionIDs = useMemo(() => new Set([...picks.ids, ...chosenSaved.map(photo => "saved:" + photo.manifest.photoId)]), [picks.ids, chosenSaved]);
  const searchPhotos = useMemo(() => mergeConsumerSearchPhotos(photos, savedPhotos), [photos, savedPhotos]);
  const currentSearchPhotos = useRef(searchPhotos); currentSearchPhotos.current = searchPhotos;
  const hasPhotos = searchPhotos.length > 0;
  useEffect(() => {if (!active) {setPlacesOpen(false); setPeopleOpen(false);}}, [active]);
  const index = useMemo(() => new PhotoSearchIndex(photos.map(photo => photo.ocr && photo.ocr.processor !== OCR_PROCESSOR ? {...photo, ocr: undefined} : photo), feedback), [photos, feedback]);
  const localPredicted = useMemo(() => index.search(query, {scope, committedMeaning: committed, previous: previous.current}), [index, query, committed]);
  const savedIndex = useMemo(() => new PhotoSearchIndex(savedPhotos), [savedPhotos]);
  const savedPredicted = useMemo(() => savedIndex.search(query, {scope: "saved:" + (ownedPhotos?.accountId ?? ""), committedMeaning: committed}), [savedIndex, query, ownedPhotos?.accountId, committed]);
  const lexicalPredicted = useMemo(() => combineConsumerSearch(localPredicted, savedPredicted, committed), [localPredicted, savedPredicted, committed]);
  const predicted = useSemanticFind(searchPhotos, lexicalPredicted, active && ready && !progress, ownedPhotos?.token, committed);
  const findMatches = useMemo(() => findMatchPhotos(searchPhotos, predicted), [searchPhotos, predicted]);
  const findSource = useMemo(() => ({sourceGeneration, token: ownedPhotos?.token, photos: ownedPhotos?.photos}), [sourceGeneration, ownedPhotos?.token, ownedPhotos?.photos]);
  const bestShots = useFindBestShots(findMatches, normalizeSearch(query) ? JSON.stringify([query, predicted.scope, predicted.meaning?.id]) : "", findSource,
    () => alive.current && generation.current === sourceGeneration && (!ownedPhotos || ownedPhotos.current()), active && ready && !progress);
  const filteredResult = useMemo(() => bestShots.active ? shortlistSearchResult(predicted, bestShots.recommendations) : predicted, [predicted, bestShots.active, bestShots.recommendations]);
  const result = useMemo(() => displaySearchResult(filteredResult, navigation), [filteredResult, navigation]);
  useEffect(() => {previous.current = result; if (committed && result.meaning?.id !== committed) setCommitted(undefined);}, [result, committed]);
  const matching = useMemo(() => findMatchPhotos(searchPhotos, result), [result, searchPhotos]);
  const viewerPhotos = normalizeSearch(query) ? matching : scoped;
  const viewing = !!viewer && viewerPhotos.some(photo => photo.id === viewer && !photo.id.startsWith("saved:"));
  useEffect(() => {if (viewer && !viewing) setViewer(null);}, [viewer, viewing]);
  const pin = result.meaning ? feedback.pins[JSON.stringify([scope, result.meaning.id])] : undefined;
  const available = scoped.filter(photo => photo.previewAvailable !== false && (photo.file || photo.preview || photo.previewLoader)).length,
    textComplete = scoped.filter(hasCurrentLocalOcr).length;
  const coverage = `${scoped.length} photos${readText || textComplete ? ` · ${textComplete} with text read` : ""}${available < scoped.length ? ` · ${scoped.length - available} need to be reopened` : ""}`;
  const ocrProgress = useLocalOcr(photos, readText, resources, sourceGeneration, output => {
    setPhotos(current => current.map(photo => photo.id === output.photoID && (photo.digest ?? photo.id) === output.revision ? {...photo, ocr: output} : photo));
  });
  const bump = () => {generation.current++; setSourceGeneration(value => value + 1); importing.current = null;};
  const reset = (message = "") => {
    onCancelSave?.();
    bump(); retainedRef.current = false; setRetained(false); saveVersion.current++; resources.clear();
    picks.clear(); setChosenSavedIDs(new Set()); setReviewingPicks(false);
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
    const clearSaved = () => {savedResources.clear(); setChosenSavedIDs(new Set()); setPlacesOpen(false); setPeopleOpen(false);};
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
  const shareSelection = () => {
    if (originalShareAttempt.pending || originalContext.current || chosenSaved.length || !reviewedPhotos.length) return;
    const chosen = [...reviewedPhotos], token = generation.current;
    const files = selectedOriginals(chosen);
    const current = () => alive.current && activeRef.current && document.visibilityState !== "hidden" && generation.current === token && files.length === chosen.length &&
      localSelectionRef.current.size === chosen.length && chosen.every(photo => localSelectionRef.current.has(photo.id) && photo.current?.() !== false &&
        currentPhotos.current.some(value => value.id === photo.id && value.file === photo.file && value.digest === photo.digest && value.current?.() !== false));
    if (!current()) return;
    setSharing(true); setStatus("");
    void originalShareAttempt.runFiles(files, current).then(result => {
      if (current() && result === "downloaded") setStatus(`${chosen.length === 1 ? "Original downloaded" : "Original downloads started"}.`);
    }).catch(() => {if (current()) setStatus("Sharing could not finish. Try again with the chosen originals.");})
      .finally(() => {if (alive.current) setSharing(false);});
  };
  const readyOriginals = selectedOriginals(photos, picks.ids).length;
  const selectedCount = picks.ids.size + chosenSaved.length;
  const shareBusy = sharing || preparingShare;
  const originalsCurrent = (context: ChosenOriginalContext) => {
    const latest = currentOwnedPhotos.current;
    if (originalContext.current !== context || !alive.current || !activeRef.current || document.visibilityState === "hidden" || generation.current !== context.generation ||
      localSelectionRef.current.size !== context.local.length || !latest?.current() || latest.token !== context.snapshot.token || latest.accountId !== context.snapshot.accountId || !context.saved.current) return false;
    try {if (requireVault() !== context.snapshot.token) return false;} catch {return false;}
    return context.local.every(source => localSelectionRef.current.has(source.id) && source.current?.() !== false && currentPhotos.current.some(photo =>
      photo.id === source.id && photo.file === source.file && photo.digest === source.digest && photo.current?.() !== false)) &&
      savedOriginalSelectionCurrent(context.saved.photos, latest.photos, chosenSavedRef.current, latest.accountId);
  };
  const cancelOriginals = () => {
    const context = originalContext.current;
    originalContext.current = null;
    context?.controller.abort(); context?.saved.dispose();
    if (context) context.files.length = 0;
    setPreparedShare(null); setPreparingShare(false); setOriginalShareError("");
  };
  useDialogFocus(originalPanel, cancelOriginals, !!preparedShare);
  useLayoutEffect(() => {if (originalContext.current && !originalsCurrent(originalContext.current)) cancelOriginals();}, [photos, picks.ids, chosenSavedIDs, ownedPhotos, active]);
  useEffect(() => {
    const hide = () => {if (document.visibilityState === "hidden") cancelOriginals();};
    window.addEventListener("fotoro-lock", cancelOriginals); window.addEventListener("pagehide", cancelOriginals);
    document.addEventListener("visibilitychange", hide);
    return () => {window.removeEventListener("fotoro-lock", cancelOriginals); window.removeEventListener("pagehide", cancelOriginals); document.removeEventListener("visibilitychange", hide); cancelOriginals();};
  }, []);
  const prepareSelection = async () => {
    if (originalShareAttempt.pending || originalContext.current || !chosenSaved.length || readyOriginals !== picks.ids.size || !ownedPhotos?.current()) return;
    const context: ChosenOriginalContext = {local: reviewedPhotos.map(photo => ({...photo})), saved: new ShareSelection(chosenSaved), snapshot: ownedPhotos,
      generation: generation.current, controller: new AbortController(), files: []};
    originalContext.current = context;
    if (!originalsCurrent(context)) {cancelOriginals(); return;}
    setPreparingShare(true); setStatus(""); setOriginalShareError("");
    try {
      const [{photoBytes}, {cameraOriginalFiles}] = await Promise.all([import("../library/catalog"), import("../media/camera-original")]);
      const files = await prepareChosenOriginals(context.local, context.saved.photos, context.controller.signal, () => originalsCurrent(context), photoBytes,
        (bytes, photo) => cameraOriginalFiles(bytes, photo.metadata));
      if (originalsCurrent(context)) {context.files = files; setPreparedShare(context);}
      else {files.length = 0; if (originalContext.current === context) cancelOriginals();}
    } catch (error) {
      if (originalsCurrent(context) && (error as Error).name !== "AbortError") setStatus("Photos could not be prepared. Check your connection and try again.");
      if (originalContext.current === context) cancelOriginals();
    } finally {if (originalContext.current === context) setPreparingShare(false);}
  };
  const sendPrepared = (context: ChosenOriginalContext, download = false) => {
    if (originalShareAttempt.pending || !originalsCurrent(context)) return;
    const current = () => originalsCurrent(context);
    setSharing(true); setStatus(""); setOriginalShareError("");
    void originalShareAttempt.runFiles(context.files, current, download ? {canShare: () => false, download: downloadOriginal} : undefined).then(result => {
      if (current() && result !== "cancelled" && result !== "busy") {cancelOriginals(); if (result === "downloaded") setStatus("Original downloads started.");}
    }).catch(() => {if (current()) setOriginalShareError(download ? "The originals could not be downloaded. Try again." : "Sharing could not finish. You can download the originals instead.");})
      .finally(() => {if (alive.current) setSharing(false);});
  };
  const selectBestShots = () => {
    if (!bestShots.active || bestShots.busy || !bestShots.recommendations || !alive.current || !activeRef.current || generation.current !== sourceGeneration || shareBusy) return;
    for (const photo of selectionCandidates(findMatches, bestShots.recommendations)) chooseSearchPhoto(photo.id, true);
    setReviewingPicks(true);
  };
  const shareSaved = () => {
    if (!ownedPhotos?.current() || !chosenSaved.length || chosenSaved.some(photo => !ownedPhotos.photos.includes(photo) || photo.grantId || photo.manifest.ownerAccountId !== ownedPhotos.accountId)) return;
    onShareSaved?.([...chosenSaved]);
  };
  const editLocalPhoto = (id: string, changes: {labels?: string[]; favorite?: boolean; location?: PhotoLocationV1}) => {
    const local = currentPhotos.current.find(photo => photo.id === id);
    if (!local) return;
    setPhotos(current => current.map(photo => photo.id === id ? {...photo, ...changes} : photo));
    const snapshot = ownedPhotos, saved = ownedPhotoForLocal(snapshot, local), token = generation.current;
    if (!snapshot?.current() || !snapshot.edit || !saved) return;
    void snapshot.edit(saved, changes).catch(() => {
      if (alive.current && generation.current === token && snapshot.current()) setStatus("Changes remain on this device. Open Saved to try again.");
    });
  };
  const keepLocalObservation = async (photo: LocalPhoto, observation: PhotoObservationV1) => {
    const snapshot = currentOwnedPhotos.current;
    if (!alive.current || !activeRef.current || !snapshot?.current() || photo.current?.() === false || observation.photoId !== photo.id || observation.sourceRevision !== (photo.digest ?? photo.id)) throw new Error("Photo source changed");
    const local = currentPhotos.current.find(value => value.id === photo.id && value.digest === photo.digest && value.file === photo.file);
    if (!local) throw new Error("Photo source changed");
    const facts = withPhotoObservation(local, observation).facts;
    setPhotos(current => current.map(value => value === local ? {...value, facts} : value));
  };
  const applyPeople = async (updates: PeopleUpdate[]) => {
    const snapshot = currentOwnedPhotos.current, token = generation.current;
    const sources = currentSearchPhotos.current;
    const changes = updates.map(update => {
      if (!alive.current || !activeRef.current || !peopleSourceCurrent(update.photo, sources.find(photo => photo.id === update.photo.id))) throw new Error("Photo source changed");
      const local = currentPhotos.current.find(photo => photo.id === update.photo.id);
      const saved = local ? ownedPhotoForLocal(snapshot, local) : snapshot?.photos.find(photo => "saved:" + photo.manifest.photoId === update.photo.id);
      if (saved && (!snapshot?.people || !snapshot.current())) throw new Error("Saved library is read-only");
      return {local, saved, assignments: update.assignments, facts: local ? factsWithPeople(local.facts, local.digest ?? "", update.assignments) : undefined};
    });
    const saved = changes.flatMap(change => change.saved ? [{photo: change.saved, assignments: change.assignments}] : []);
    if (saved.length) {
      await snapshot!.people!(saved);
      let settled = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (!alive.current || !activeRef.current || generation.current !== token || currentOwnedPhotos.current?.token !== snapshot!.token) throw new Error("Photo source changed");
        if (peopleEditsVisible(currentOwnedPhotos.current, snapshot!.token, saved)) {settled = true; break;}
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      if (!settled) throw new Error("People edits were kept. Reopen People after Saved finishes updating.");
    }
    if (!alive.current || !activeRef.current || token !== generation.current || saved.length && currentOwnedPhotos.current?.token !== snapshot?.token) throw new Error("Photo source changed");
    for (const update of updates) if (!peopleSourceCurrent(update.photo, currentSearchPhotos.current.find(photo => photo.id === update.photo.id), saved.length > 0)) throw new Error("Photo source changed");
    const rebased = changes.flatMap(change => {
      if (!change.local) return [];
      const local = currentPhotos.current.find(photo => photo.id === change.local!.id);
      if (!local || !peopleSourceCurrent(change.local, local)) throw new Error("Photo source changed");
      return [{local, facts: factsWithPeople(local.facts, local.digest ?? "", change.assignments)}];
    });
    setPhotos(current => current.map(photo => {
      const change = rebased.find(change => change.local === photo);
      return change ? {...photo, facts: change.facts} : photo;
    }));
  };
  const applyTimelineLocations = async (candidates: readonly TimelineCandidate[]) => {
    const token = generation.current, snapshot = ownedPhotos;
    const sources = mergeConsumerSearchPhotos(currentPhotos.current, savedSearchPhotos(snapshot, currentPhotos.current));
    const targets = currentTimelineCandidates(candidates, sources).map(candidate => {
      const local = currentPhotos.current.find(photo => photo.id === candidate.photoID);
      const saved = local ? ownedPhotoForLocal(snapshot, local) : snapshot?.photos.find(photo => "saved:" + photo.manifest.photoId === candidate.photoID && !photo.grantId && photo.manifest.ownerAccountId === snapshot.accountId);
      return {candidate, local, saved};
    });
    const accountBound = targets.some(target => target.saved !== undefined);
    const current = () => {
      if (!alive.current || generation.current !== token) return false;
      if (!accountBound) return true;
      try {return requireVault() === snapshot?.token;} catch {return false;}
    };
    const localCurrent = (original: LocalPhoto, latest = currentPhotos.current.find(photo => photo.id === original.id)) => !!latest
      && latest.current?.() !== false && latest.location === undefined && latest.file === original.file && latest.digest === original.digest
      && latest.date === original.date && latest.dateSource === original.dateSource && latest.captureVerified === original.captureVerified
      && latest.captureTimezoneVerified === original.captureTimezoneVerified;
    const savedCurrent = (original: Photo, location: PhotoLocationV1) => {
      const latest = currentOwnedPhotos.current;
      if (!current() || !snapshot || !latest || latest.token !== snapshot.token || latest.accountId !== snapshot.accountId) return false;
      const photo = latest.photos.find(photo => photo.manifest.photoId === original.manifest.photoId && !photo.grantId && photo.manifest.ownerAccountId === latest.accountId);
      if (!photo || photo.metadata.originalSha256 !== original.metadata.originalSha256 || photo.metadata.sourceDate !== original.metadata.sourceDate || photo.metadata.dateSource !== original.metadata.dateSource) return false;
      const existing = annotationLocation(photo.annotations ?? {});
      return !existing || existing.source === location.source && existing.latitude === location.latitude && existing.longitude === location.longitude
        && existing.name === location.name && existing.accuracyMeters === location.accuracyMeters;
    };
    return applyTimelineTargets(targets, {current, localCurrent, savedCurrent,
      queueSaved: snapshot?.locate ? updates => snapshot.locate!(updates) : undefined,
      applyLocal: updates => {
        const changes = new Map(updates.map(update => [update.photo.id, update]));
        const savedForLocal = new Map(targets.flatMap(target => target.local && target.saved ? [[target.local.id, target.saved] as const] : []));
        setPhotos(photos => current() ? photos.map(photo => {
          const update = changes.get(photo.id), saved = savedForLocal.get(photo.id);
          return update && localCurrent(update.photo, photo) && (!saved || savedCurrent(saved, update.location)) ? {...photo, location: update.location} : photo;
        }) : photos);
      }});
  };
  return <>
    <main inert={viewing || settings || placesOpen || peopleOpen || preparedShare ? true : undefined} className="local-trial">
      <header className="consumer-navigation">
        {hasPhotos ? <nav className="consumer-scope-menu" aria-label="Photo library"><select aria-label="Photo library" value={browseScope} onChange={event => {
          if (event.target.value === "saved") openBackup();
          else setBrowseScope(event.target.value as "photos" | "picks");
        }}><option value="photos">Photos</option><option value="picks">Picks</option><option value="saved">Saved</option></select></nav> : <h1>Fotoro</h1>}
        <div className="header-actions">
          {hasPhotos && <>
            {(photos.length > 0 || findMatches.length > 0) && <button disabled={shareBusy} aria-pressed={reviewingPicks} onClick={() => setReviewingPicks(!reviewingPicks)}>{reviewingPicks ? "Done" : "Select"}</button>}
            <button className="menu-button" aria-label="Add photos" disabled={!!progress || !ready} onClick={() => input.current?.click()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg></button>
          </>}
          <button className="menu-button" aria-label="Settings" onClick={() => setSettings(true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 3-1 3-3 1-2-1-2 4 2 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-3-1-1-3z" transform="translate(0 -1) scale(.9)"/><circle cx="12" cy="12" r="3" /></svg></button>
        </div>
      </header>
      {hasPhotos && <div className="consumer-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="m15 15 6 6" /></svg><input ref={searchInput} aria-label="Search photos" placeholder="Search photos" value={query} onChange={event => changeQuery(event.target.value)} />{query && <button aria-label="Clear search" onClick={() => {changeQuery(""); searchInput.current?.focus();}}><Icon kind="close" /></button>}</div>}
      {normalizeSearch(query) && (findMatches.length > 0 || bestShots.active) && <FindBestShots total={findMatches.length} review={bestShots} onSelect={selectBestShots} disabled={shareBusy} />}
      {normalizeSearch(query) && searchPhotos.length ? <LocalSearch key={sourceGeneration} photos={searchPhotos} result={{...result, textStatus: localTextSearchStatus(photos, readText, query, committed, !!ocrProgress)}} resources={result.photoId?.startsWith("saved:") ? savedResources : resources} committed={committed} pinned={pin} selection={reviewingPicks ? {ids: searchSelectionIDs, onChange: chooseSearchPhoto, eligible: id => photos.some(photo => photo.id === id) || (id.startsWith("saved:") && !!ownedPhotos?.current() && savedPhotos.some(photo => photo.id === id)), disabled: sharing} : undefined} reasons={bestShots.active ? bestShots.recommendations?.reasons : undefined} emptyMessage={bestShots.active ? bestShots.busy ? "Choosing best shots…" : "No best shots to suggest" : undefined} emptyHint={bestShots.active ? "All matches remain available. You choose what to Save or Share." : undefined} canCorrect={!!result.photoId && localPredicted.meaning?.id === result.meaning?.id && localPredicted.photoIds.includes(result.photoId)} coverage={coverage + (savedPhotos.length ? ` · ${savedPhotos.length} saved photos available` : "")} onAccept={accept} onNavigate={id => setNavigation({query, scope, meaningID: result.meaning!.id, photoID: id})} onOpen={id => id.startsWith("saved:") ? onOpenSaved?.(id.slice(6)) : setViewer(id)} onConfirm={id => confirm(id)} onPin={id => confirm(id, true)} onFailure={failure} />
        : !photos.length ? <section className="local-empty local-first-use"><div className="first-use-content"><div className="first-use-actions"><button className="open-photos" onClick={openBackup}>Open Saved photos</button><button className="text-button" disabled={!ready || !!progress} onClick={() => input.current?.click()}>Open photos from this device</button></div><p className="hint first-use-note">Photos opened here stay on this device until you choose Save.</p></div></section>
        : scoped.length ? <LocalLibrary key={sourceGeneration} active={active} photos={scoped} resources={resources} onOpen={setViewer} onFailure={failure} selection={{ids: picks.ids, editing: reviewingPicks, disabled: sharing, onChange: picks.choose}} />
        : <section className="empty"><p>{browseScope === "picks" ? picks.busy ? "Choosing your picks…" : "No picks yet" : "No photos in this date range"}</p><button onClick={() => {setBrowseScope("photos"); setLast30(false);}}>Show all photos</button></section>}
      {selectedCount > 0 && <section className="consumer-selection" aria-label="Chosen photos">
        <p role="status">{selectedCount} selected</p>
        <button disabled={shareBusy} onClick={() => {picks.clearSelection(); setChosenSavedIDs(new Set());}}>Clear</button>
        {onSave && picks.ids.size > 0 && <button disabled={readyOriginals !== picks.ids.size || shareBusy} onClick={() => onSave(reviewedPhotos)}>Save</button>}
        <button className="primary-action" disabled={readyOriginals !== picks.ids.size || shareBusy} onClick={() => chosenSaved.length ? void prepareSelection() : shareSelection()}>{preparingShare ? "Preparing…" : sharing ? "Sharing…" : "Share"}</button>
        {chosenSaved.length > 0 && onShareSaved && <details className="selection-more" onKeyDown={event => {if (event.key === "Escape") {event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();}}}>
          <summary>More</summary><div><button disabled={shareBusy} onClick={shareSaved}>{picks.ids.size ? "Share saved photos in Fotoro" : "Share in Fotoro"}</button></div>
        </details>}
        {readyOriginals < picks.ids.size && <small>Reselect {picks.ids.size - readyOriginals} {picks.ids.size - readyOriginals === 1 ? "original" : "originals"} to Save or Share.</small>}
      </section>}
      {last30 && photos.length > 0 && !normalizeSearch(query) && <button className="local-filter" onClick={() => setLast30(false)}>Last 10 days ×</button>}
      {(progress || ocrProgress || (saving && !saving.startsWith("Saved locally ·")) || (browseScope === "picks" && picks.busy)) && <p className="local-progress" role="status">{progress || ocrProgress || (saving.startsWith("Saved locally ·") ? "" : saving) || "Choosing picks…"}</p>}
      {status && <div className="status" role="status">{status}<button aria-label="Dismiss message" onClick={() => setStatus("")}><Icon kind="close" /></button></div>}
    </main>
    <input ref={input} hidden type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" multiple onChange={event => {const files = Array.from(event.target.files ?? []); event.target.value = ""; void openFiles(files);}} />
    {settings && <aside className="sheet local-settings" ref={settingsPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Settings">
      <button className="close" aria-label="Close settings" onClick={closeSettings}><Icon kind="close" /></button><h2>Settings</h2>
      <button onClick={() => {closeSettings(); setPlacesOpen(true);}}>Places</button>
      <button onClick={() => {closeSettings(); setPeopleOpen(true);}}>People</button>
      <label className="local-check"><input type="checkbox" checked={last30} onChange={event => setLast30(event.target.checked)} />Browse the last 10 days</label>
      <h3>Selection</h3>
      <p className="hint">{picks.ids.size} of {photos.length} selected.</p>
      <div className="photo-pick-actions">
        <button disabled={!photos.length || picks.busy} onClick={picks.suggested}>Highlights</button>
        <button disabled={!photos.length} onClick={picks.chooseAll}>Select all</button>
      </div>
      {(picks.recommendations?.unassessed ?? 0) > 0 && <p className="hint">{picks.recommendations!.unassessed} could not be assessed. You can still select them.</p>}
      <h3>Search and storage</h3>
      <label className="local-check"><input type="checkbox" checked={readText} onChange={event => {const choice = {readText: event.target.checked, retain: retained}; saveLocalChoices(choice); setReadText(choice.readText);}} />Find words in photos</label>
      <p className="hint">Find photos by English words inside them. Text is read on this device.</p>
      <label className="local-check"><input type="checkbox" checked={retained} disabled={!ready || retentionBusy} onChange={event => {const choice = {readText, retain: event.target.checked}; saveLocalChoices(choice); void toggleRetention(choice.retain);}} />Remember these photos</label>
      <p className="hint">Keep search data and up to 100 MB of previews in this browser. Original files are not retained.</p>
      {saving && <p role="status">{saving}</p>}
      <button disabled={!ready} onClick={() => {void clear(); closeSettings();}}>Clear local search</button>
    </aside>}
    {active && preparedShare && originalsCurrent(preparedShare) && <aside className="original-share saved-original-share" ref={originalPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Share selected photos">
      <button className="close" aria-label="Close share options" disabled={sharing} onClick={cancelOriginals}><Icon kind="close" /></button>
      <h2>Share {preparedShare.local.length + preparedShare.saved.photos.length} {(preparedShare.local.length + preparedShare.saved.photos.length) === 1 ? "photo" : "photos"}</h2>
      {originalShareError && <p className="hint" role="status">{originalShareError}</p>}
      <div className="actions">
        {canShareOriginals(preparedShare.files) && <button className="primary-action" disabled={sharing} onClick={() => sendPrepared(preparedShare)}>{sharing ? "Sharing…" : "Share"}</button>}
        <button className={canShareOriginals(preparedShare.files) ? undefined : "primary-action"} disabled={sharing} onClick={() => sendPrepared(preparedShare, true)}>Download originals</button>
      </div>
    </aside>}
    {active && peopleOpen && <Suspense fallback={<aside className="settings-panel" role="dialog" aria-modal="true" aria-label="People"><button autoFocus onClick={() => setPeopleOpen(false)}>Close</button><p role="status">Opening People…</p></aside>}><People photos={searchPhotos} resources={resources} savedResources={savedResources} onClose={() => setPeopleOpen(false)} onAssignments={applyPeople} onOpen={id => {
      setPeopleOpen(false); if (id.startsWith("saved:")) onOpenSaved?.(id.slice(6)); else setViewer(id);
    }} /></Suspense>}
    {active && placesOpen && <Places photos={searchPhotos} resources={resources} savedResources={savedResources} onClose={() => setPlacesOpen(false)} onApplyLocations={applyTimelineLocations} onOpen={id => {
      setPlacesOpen(false);
      if (id.startsWith("saved:")) onOpenSaved?.(id.slice(6));
      else {setBrowseScope("photos"); setLast30(false); changeQuery(""); setViewer(id);}
    }} />}
    {viewing && viewer && <LocalViewer photos={viewerPhotos.filter(photo => !photo.id.startsWith("saved:"))} initial={viewer} resources={resources} intelligence={active && ownedPhotos?.current() && ownedPhotos.edit ? {scopeKey: intelligenceScope(ownedPhotos.token), expectedAccountId: ownedPhotos.accountId, current: () => activeRef.current && currentOwnedPhotos.current?.token === ownedPhotos.token && ownedPhotos.current(), keep: keepLocalObservation} : undefined} onSave={onSave ? photo => onSave([photo]) : undefined} isSaved={photo => !!ownedPhotos?.current() && savedPhotos.some(saved => saved.id === photo.id)} onLabels={(id, labels) => editLocalPhoto(id, {labels})} onFavorite={(id, favorite) => editLocalPhoto(id, {favorite})} onUse={normalizeSearch(query) ? id => confirm(id) : undefined} onConfirm={normalizeSearch(query) ? id => confirm(id) : undefined} onPin={normalizeSearch(query) ? id => confirm(id, true) : undefined} meaning={result.meaning?.term} onReselect={() => {input.current?.click(); setViewer(null);}} onClose={() => setViewer(null)} />}
  </>;
}
