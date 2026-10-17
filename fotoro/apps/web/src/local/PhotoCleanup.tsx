import {useEffect, useMemo, useRef, useState} from "react";
import {isPhotoTrashed, photoName} from "@fotoro/contracts/organization";
import {CleanupAnalyzer} from "./auto-picks";
import {readPickSignals} from "./usePhotoPicks";
import type {LocalPhoto, LocalResources} from "./resources";
import {useLocalThumbnail} from "./useLocalThumbnail";
import {useDialogFocus} from "../library/dialog-focus";
import type {ConsumerPhotoChanges} from "../library/consumer-changes";
import {diagnose} from "../diagnostics";
import {CLEANUP_BATCH_SIZE, cleanupSourceCurrent, cleanupReviewPhotos, screenshotReviewGroups, type ScreenshotReviewGroup} from "./cleanup-review";
function CleanupRow({photo, reasons, resources, remove, open}: {photo: LocalPhoto; reasons: string[]; resources: LocalResources; remove?: () => Promise<void>; open: () => void}) {
  const {url} = useLocalThumbnail(photo, resources, () => {}), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false), alive = useRef(true);
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  return <li><button onClick={open}>{url && <img src={url} alt="" />}<strong>{photoName(photo, photo.filename)}</strong></button><p>{reasons.join(" · ")}</p>{photo.favorite && <p>Favorite · review carefully</p>}
    {remove ? <button disabled={busy} onClick={() => {if (pending.current || photo.current?.() === false) return; pending.current = true; setBusy(true); setError(""); void remove().catch(() => {if (alive.current) setError("Could not move this photo. Try again.");}).finally(() => {pending.current = false; if (alive.current) setBusy(false);});}}>Move to Fotoro Trash</button> : <p className="hint">Save this photo in Fotoro before moving its saved copy to Trash.</p>}{error && <p role="alert">{error}</p>}</li>;
}
function ScreenshotGroup({group, resources, canTrash, onTrash, onOpen}: {
  group: ScreenshotReviewGroup; resources: (photo: LocalPhoto) => LocalResources;
  canTrash: (photo: LocalPhoto) => boolean; onTrash: (photo: LocalPhoto) => Promise<void>; onOpen: (photo: LocalPhoto) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <details onToggle={event => setExpanded(event.currentTarget.open)}><summary>{group.title} ({group.photos.length})</summary>
    {expanded && <ul>{group.photos.map(photo => <CleanupRow key={photo.id} photo={photo} reasons={[group.title]} resources={resources(photo)} remove={canTrash(photo) ? () => onTrash(photo) : undefined} open={() => onOpen(photo)} />)}</ul>}
  </details>;
}
export function PhotoCleanup({photos, resources, onTrash, canTrash, onOpen, changes, onClose}: {
  photos: LocalPhoto[]; resources: (photo: LocalPhoto) => LocalResources;
  onTrash: (photo: LocalPhoto) => Promise<void>; canTrash: (photo: LocalPhoto) => boolean;
  onOpen: (photo: LocalPhoto) => void; changes?: ConsumerPhotoChanges; onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null), [analyzer] = useState(() => new CleanupAnalyzer());
  const [reviewSnapshot] = useState(() => cleanupReviewPhotos(photos));
  const [limit, setLimit] = useState(CLEANUP_BATCH_SIZE);
  const measurementScan = useMemo(() => reviewSnapshot.slice(0, limit), [reviewSnapshot, limit]);
  const scanIDs = useMemo(() => new Set(measurementScan.map(photo => photo.id)), [measurementScan]);
  const scan = useMemo(() => photos.filter(photo => scanIDs.has(photo.id)), [photos, scanIDs]);
  const result = analyzer.review(scan);
  const latestPhotos = useRef(new Map(photos.map(photo => [photo.id, photo])));
  latestPhotos.current = new Map(photos.map(photo => [photo.id, photo]));
  const latestResources = useRef(resources); latestResources.current = resources;
  const [view, setView] = useState<"quality" | "screenshots">("quality");
  const screenshotGroups = useMemo(() => screenshotReviewGroups(scan), [scan]);
  const remaining = Math.max(0, reviewSnapshot.length - measurementScan.length);
  const [done, setDone] = useState(0), [busy, setBusy] = useState(true), [saveError, setSaveError] = useState("");
  const nextPending = useRef(false);
  const alive = useRef(false), saving = useRef(false), [saveBusy, setSaveBusy] = useState(false);
  const latestChanges = useRef(changes); latestChanges.current = changes;
  useEffect(() => {alive.current = true; return () => {alive.current = false; analyzer.clear();};}, [analyzer]);
  const save = async () => {
    const source = latestChanges.current;
    if (!source?.current() || saving.current || source.busy) return;
    if (source.pending.some(edit => edit.conflict)) {source.review(); return;}
    saving.current = true; setSaveBusy(true); setSaveError("");
    try {if (!await source.save()) throw new Error("Save failed");}
    catch {if (alive.current && source.current() && latestChanges.current?.token === source.token) setSaveError("Changes could not finish saving. Try again.");}
    finally {saving.current = false; if (alive.current) setSaveBusy(false);}
  };
  useDialogFocus(panel, onClose);
  useEffect(() => {
    let alive = true;
    const start = Math.max(0, limit - CLEANUP_BATCH_SIZE);
    setBusy(true); setDone(start);
    void diagnose("metadata", async () => analyzer.run(measurementScan.slice(start), (photo, signal) => {
      const latest = latestPhotos.current.get(photo.id);
      if (!cleanupSourceCurrent(photo, latest))
        return Promise.reject(new Error("Review source changed. Reopen review for the new snapshot."));
      const guarded = {...latest, current: () => cleanupSourceCurrent(photo, latestPhotos.current.get(photo.id))};
      return readPickSignals(guarded, latestResources.current(latest), signal);
    }, value => {if (alive) setDone(start + value);}))
      .then(() => {if (alive) {nextPending.current = false; setBusy(false);}}).catch(() => {if (alive) {nextPending.current = false; setBusy(false); setSaveError("Review could not finish. Close and try again.");}});
    return () => {alive = false; analyzer.cancel();};
  }, [analyzer, measurementScan, limit]);
  const rows = photos.filter(photo => photo.current?.() !== false && !isPhotoTrashed(photo) && result.reasons.has(photo.id));
  return <aside className="sheet places-sheet photo-cleanup" ref={panel} role="dialog" aria-modal="true" aria-label="Review cleanup" tabIndex={-1}>
    <header className="places-header"><h2>Review cleanup</h2><button onClick={onClose}>Done</button></header>
    <p>Review possible duplicates, blurry shots, and photos with little detail. Nothing is selected or removed automatically.</p>
    <p className="hint">Review currently loaded photos in batches of {CLEANUP_BATCH_SIZE}. Photos outside this loaded snapshot have not been checked. Trash is recoverable and only affects Fotoro; it does not free storage.</p>
    {busy ? <p role="status">Checking previews… {done} / {measurementScan.length} · {remaining} remaining in this loaded snapshot.</p> : <p role="status">{done} scanned · {remaining} remaining · {result.unassessed} current previews unassessed · {rows.length} cleanup candidates.</p>}
    {!busy && remaining > 0 && <button onClick={() => {if (nextPending.current) return; nextPending.current = true; setLimit(value => value + CLEANUP_BATCH_SIZE);}}>Review next {Math.min(CLEANUP_BATCH_SIZE, remaining)} photos</button>}
    <div role="group" aria-label="Review type"><button aria-pressed={view === "quality"} onClick={() => setView("quality")}>Quality and duplicates</button><button aria-pressed={view === "screenshots"} onClick={() => setView("screenshots")}>Screenshots ({screenshotGroups.reduce((total, group) => total + group.photos.length, 0)})</button></div>
    {view === "quality" && !busy && !rows.length && <p>No candidates found in this review. Unassessed photos have not been judged.</p>}
    {view === "quality" && <ul>{rows.map(photo => <CleanupRow key={photo.id} photo={photo} reasons={result.reasons.get(photo.id)!} resources={resources(photo)} remove={canTrash(photo) ? () => onTrash(photo) : undefined} open={() => onOpen(photo)} />)}</ul>}
    {view === "screenshots" && <section><p>Screenshots grouped by existing tags or matching readable text. Open each photo to decide what to keep. Nothing is selected automatically.</p>{!screenshotGroups.length && <p>No known screenshots in these review batches.</p>}{screenshotGroups.map(group => <ScreenshotGroup key={group.key} group={group} resources={resources} canTrash={canTrash} onTrash={onTrash} onOpen={onOpen} />)}</section>}
    {changes?.current() && changes.pending.length > 0 && <section><p>Changes are on this device until you save them.</p><button disabled={changes.busy || saveBusy} onClick={() => void save()}>{changes.pending.some(edit => edit.conflict) ? "Review changes" : "Save changes"}</button></section>}
    {saveError && <p role="alert">{saveError}</p>}
  </aside>;
}
