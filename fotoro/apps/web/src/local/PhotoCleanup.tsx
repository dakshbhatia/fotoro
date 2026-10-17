import {useEffect, useMemo, useRef, useState} from "react";
import {isPhotoTrashed, photoName} from "@fotoro/contracts/organization";
import {CleanupAnalyzer} from "./auto-picks";
import {CleanupReviewPersistence} from "./cleanup-persistence";
import {readPickSignals} from "./usePhotoPicks";
import type {LocalPhoto, LocalResources} from "./resources";
import {useLocalThumbnail} from "./useLocalThumbnail";
import {useDialogFocus} from "../library/dialog-focus";
import type {ConsumerPhotoChanges} from "../library/consumer-changes";
import {diagnose} from "../diagnostics";
import {CLEANUP_BATCH_SIZE, cleanupSourceCurrent, cleanupSourceIdentityCurrent, cleanupReviewPhotos, screenshotReviewGroups, type ScreenshotReviewGroup} from "./cleanup-review";
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
  const [reviewSnapshot, setReviewSnapshot] = useState(() => cleanupReviewPhotos(photos));
  const scope = useRef(reviewSnapshot), completed = useRef(0), runEpoch = useRef(0);
  const reviewReady = useRef(false), closing = useRef(false);
  const [persistence] = useState(() => new CleanupReviewPersistence());
  const [request, setRequest] = useState(0), [reviewNotice, setReviewNotice] = useState("");
  const [limit, setLimit] = useState(0);
  const measurementScan = useMemo(() => reviewSnapshot.slice(0, limit), [reviewSnapshot, limit]);
  const photoMap = useMemo(() => new Map(photos.map(photo => [photo.id, photo])), [photos]);
  const latestPhotos = useRef(photoMap);
  latestPhotos.current = photoMap;
  // Keep measured source identity stable across harmless annotation refreshes;
  // current favorites, screenshot corrections and Trash still control the review.
  const scan = useMemo(() => measurementScan.flatMap(initial => {
    const latest = latestPhotos.current.get(initial.id);
    if (!cleanupSourceIdentityCurrent(initial, latest)) return [];
    return [{...initial, favorite: latest.favorite, facts: latest.facts, labels: latest.labels,
      current: () => cleanupSourceIdentityCurrent(initial, latestPhotos.current.get(initial.id))}];
  }), [measurementScan, photos]);
  const result = analyzer.review(scan);
  const latestResources = useRef(resources); latestResources.current = resources;
  const [view, setView] = useState<"quality" | "screenshots">("quality");
  const screenshotGroups = useMemo(() => screenshotReviewGroups(scan), [scan]);
  const [done, setDone] = useState(0), [busy, setBusy] = useState(true), [saveError, setSaveError] = useState("");
  const remaining = Math.max(0, reviewSnapshot.length - done);
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
  const measuredSignals = (count: number) => analyzer.signals(scope.current.slice(0, count).flatMap(initial => {
    const latest = latestPhotos.current.get(initial.id);
    if (!cleanupSourceIdentityCurrent(initial, latest)) return [];
    return [{...initial, facts: latest.facts, current: () => cleanupSourceIdentityCurrent(initial, latestPhotos.current.get(initial.id))}];
  }));
  useDialogFocus(panel, () => pauseReview(true));
  useEffect(() => {
    let active = true;
    const epoch = ++runEpoch.current;
    const current = () => active && epoch === runEpoch.current && scope.current.every(initial =>
      cleanupSourceIdentityCurrent(initial, latestPhotos.current.get(initial.id), true));
    const checkpoint = async (count: number) => {
      const retained = scope.current.map(initial => latestPhotos.current.get(initial.id)!).filter(photo => photo && !isPhotoTrashed(photo));
      const checkedIDs = new Set(scope.current.slice(0, count).map(photo => photo.id));
      const checked = retained.filter(photo => checkedIDs.has(photo.id));
      const durable = await persistence.write(retained, checked.length, measuredSignals(count), current);
      if (current()) setReviewNotice(durable ? "Progress is kept encrypted on this device for this loaded scope." : "Progress stays in this session. Remember these photos to keep eligible local review progress after restart.");
    };
    setBusy(true);
    void (async () => {
      if (!reviewReady.current) {
        const restored = await persistence.read(scope.current, current, [...latestPhotos.current.values()].filter(isPhotoTrashed));
        if (!current()) return;
        reviewReady.current = true;
        if (restored) {
          scope.current = restored.photos; setReviewSnapshot(restored.photos);
          analyzer.restore(restored.photos, restored.signals);
          completed.current = restored.completed; setDone(restored.completed); setLimit(restored.completed);
          setReviewNotice("Previous review restored. Continue explicitly to check more of this loaded scope.");
          return;
        }
      }
      if (!current()) return;
      const start = completed.current, end = Math.min(scope.current.length, start + CLEANUP_BATCH_SIZE);
      setLimit(end); setDone(start);
      const result = await diagnose("metadata", async () => analyzer.run(scope.current.slice(start, end), (photo, signal) => {
        const latest = latestPhotos.current.get(photo.id);
        if (!current() || !cleanupSourceCurrent(photo, latest))
          return Promise.reject(new Error("Review source changed. Reopen review for the new snapshot."));
        const guarded = {...latest, current: () => current() && cleanupSourceCurrent(photo, latestPhotos.current.get(photo.id))};
        return readPickSignals(guarded, latestResources.current(latest), signal);
      }, value => {
        if (!active || epoch !== runEpoch.current) return;
        completed.current = start + value;
        if (value % 8 === 0 || start + value === end) setDone(start + value);
        if ((start + value) % 32 === 0) void checkpoint(start + value).catch(() => {
          if (current()) setReviewNotice("Progress could not be kept after restart. This review remains available while open.");
        });
      }));
      if (!current() || !result) return;
      completed.current = end; setDone(end);
      await checkpoint(end);
    })().catch(() => {
      if (active && epoch === runEpoch.current) setReviewNotice("Progress could not finish saving. Completed previews remain available while open.");
    }).finally(() => {
      if (active && epoch === runEpoch.current) {
        nextPending.current = false; setBusy(false);
        if (!current()) setReviewNotice("The review source changed. Close and reopen to check the current photos.");
      }
    });
    return () => {active = false; analyzer.cancel();};
  }, [analyzer, persistence, request]);
  const continueReview = () => {
    if (nextPending.current) return;
    nextPending.current = true; setBusy(true); setRequest(value => value + 1);
  };
  const pauseReview = (close = false) => {
    if (closing.current) return;
    closing.current = close;
    const epoch = ++runEpoch.current; analyzer.cancel(); setLimit(completed.current); setDone(completed.current);
    if (!reviewReady.current) {
      nextPending.current = false; setBusy(false); setReviewNotice("Review paused.");
      if (close) onClose();
      return;
    }
    nextPending.current = true; setBusy(true);
    const current = () => alive.current && epoch === runEpoch.current && scope.current.every(initial => cleanupSourceIdentityCurrent(initial, latestPhotos.current.get(initial.id), true));
    const retained = scope.current.map(initial => latestPhotos.current.get(initial.id)!).filter(photo => photo && !isPhotoTrashed(photo));
    const checkedIDs = new Set(scope.current.slice(0, completed.current).map(photo => photo.id));
    const checked = retained.filter(photo => checkedIDs.has(photo.id));
    void persistence.write(retained, checked.length, measuredSignals(completed.current), current).then(durable => {
      if (current()) setReviewNotice(durable ? "Review paused. Progress is kept encrypted on this device." : "Review paused. Progress stays in this session.");
    }).catch(() => {if (current()) setReviewNotice("Review paused. Its latest progress could not be kept after restart.");})
      .finally(() => {if (alive.current && epoch === runEpoch.current) {nextPending.current = false; setBusy(false); if (close) onClose();}});
  };

  const rows = photos.filter(photo => photo.current?.() !== false && !isPhotoTrashed(photo) && result.reasons.has(photo.id));
  return <aside className="sheet places-sheet photo-cleanup" ref={panel} role="dialog" aria-modal="true" aria-label="Review cleanup" tabIndex={-1}>
    <header className="places-header"><h2>Review cleanup</h2><button onClick={() => pauseReview(true)}>Done</button></header>
    <p>Review possible duplicates, blurry shots, and photos with little detail. Nothing is selected or removed automatically.</p>
    <p className="hint">Review currently loaded photos in batches of {CLEANUP_BATCH_SIZE}. Photos outside this loaded snapshot have not been checked. Trash is recoverable and only affects Fotoro; it does not free storage.</p>
    {busy ? <p role="status">Checking previews… {done} / {measurementScan.length} · {remaining} remaining in this loaded snapshot.</p> : <p role="status">{done} scanned · {remaining} remaining · {result.unassessed} current previews unassessed · {rows.length} cleanup candidates.</p>}
    {busy && <button onClick={() => pauseReview()}>Pause review</button>}
    {!busy && remaining > 0 && <button onClick={continueReview}>Review next {Math.min(CLEANUP_BATCH_SIZE, remaining)} photos</button>}
    {!busy && done > 0 && <button onClick={() => {analyzer.clear(); completed.current = 0; setDone(0); setLimit(0); continueReview();}}>Start review over</button>}
    {reviewNotice && <p className="hint" role="status">{reviewNotice}</p>}
    <div role="group" aria-label="Review type"><button aria-pressed={view === "quality"} onClick={() => setView("quality")}>Quality and duplicates</button><button aria-pressed={view === "screenshots"} onClick={() => setView("screenshots")}>Screenshots ({screenshotGroups.reduce((total, group) => total + group.photos.length, 0)})</button></div>
    {view === "quality" && !busy && !rows.length && <p>No candidates found in this review. Unassessed photos have not been judged.</p>}
    {view === "quality" && <ul>{rows.map(photo => <CleanupRow key={photo.id} photo={photo} reasons={result.reasons.get(photo.id)!} resources={resources(photo)} remove={canTrash(photo) ? () => onTrash(photo) : undefined} open={() => onOpen(photo)} />)}</ul>}
    {view === "screenshots" && <section><p>Screenshots grouped by existing tags or matching readable text. Open each photo to decide what to keep. Nothing is selected automatically.</p>{!screenshotGroups.length && <p>No known screenshots in these review batches.</p>}{screenshotGroups.map(group => <ScreenshotGroup key={group.key} group={group} resources={resources} canTrash={canTrash} onTrash={onTrash} onOpen={onOpen} />)}</section>}
    {changes?.current() && changes.pending.length > 0 && <section><p>Changes are on this device until you save them.</p><button disabled={changes.busy || saveBusy} onClick={() => void save()}>{changes.pending.some(edit => edit.conflict) ? "Review changes" : "Save changes"}</button></section>}
    {saveError && <p role="alert">{saveError}</p>}
  </aside>;
}
