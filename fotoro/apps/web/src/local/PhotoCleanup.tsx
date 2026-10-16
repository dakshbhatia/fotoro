import {useEffect, useMemo, useRef, useState} from "react";
import {isPhotoTrashed, photoName} from "@fotoro/contracts/organization";
import {CleanupAnalyzer} from "./auto-picks";
import {readPickSignals} from "./usePhotoPicks";
import type {LocalPhoto, LocalResources} from "./resources";
import {useLocalThumbnail} from "./useLocalThumbnail";
import {useDialogFocus} from "../library/dialog-focus";
import type {ConsumerPhotoChanges} from "../library/consumer-changes";
import {diagnose} from "../diagnostics";
function CleanupRow({photo, reasons, resources, remove, open}: {photo: LocalPhoto; reasons: string[]; resources: LocalResources; remove?: () => Promise<void>; open: () => void}) {
  const {url} = useLocalThumbnail(photo, resources, () => {}), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false), alive = useRef(true);
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  return <li><button onClick={open}>{url && <img src={url} alt="" />}<strong>{photoName(photo, photo.filename)}</strong></button><p>{reasons.join(" · ")}</p>{photo.favorite && <p>Favorite · review carefully</p>}
    {remove ? <button disabled={busy} onClick={() => {if (pending.current || photo.current?.() === false) return; pending.current = true; setBusy(true); setError(""); void remove().catch(() => {if (alive.current) setError("Could not move this photo. Try again.");}).finally(() => {pending.current = false; if (alive.current) setBusy(false);});}}>Move to Fotoro Trash</button> : <p className="hint">Save this photo in Fotoro before moving its saved copy to Trash.</p>}{error && <p role="alert">{error}</p>}</li>;
}
export function PhotoCleanup({photos, resources, onTrash, canTrash, onOpen, changes, onClose}: {
  photos: LocalPhoto[]; resources: (photo: LocalPhoto) => LocalResources;
  onTrash: (photo: LocalPhoto) => Promise<void>; canTrash: (photo: LocalPhoto) => boolean;
  onOpen: (photo: LocalPhoto) => void; changes?: ConsumerPhotoChanges; onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null), [analyzer] = useState(() => new CleanupAnalyzer());
  const [measurementScan] = useState(() => photos.filter(photo => photo.current?.() !== false && !isPhotoTrashed(photo)).slice(0, 200));
  const scanIDs = useMemo(() => new Set(measurementScan.map(photo => photo.id)), [measurementScan]);
  const scan = useMemo(() => photos.filter(photo => scanIDs.has(photo.id)), [photos, scanIDs]);
  const result = analyzer.review(scan);
  const [done, setDone] = useState(0), [busy, setBusy] = useState(true), [saveError, setSaveError] = useState("");
  const alive = useRef(false), saving = useRef(false), [saveBusy, setSaveBusy] = useState(false);
  const latestChanges = useRef(changes); latestChanges.current = changes;
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
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
    setBusy(true); setDone(0);
    void diagnose("metadata", async () => analyzer.run(measurementScan, (photo, signal) => readPickSignals(photo, resources(photo), signal), value => {if (alive) setDone(value);}))
      .then(() => {if (alive) setBusy(false);}).catch(() => {if (alive) {setBusy(false); setSaveError("Review could not finish. Close and try again.");}});
    return () => {alive = false; analyzer.clear();};
  }, [analyzer, measurementScan]);
  const rows = photos.filter(photo => photo.current?.() !== false && !isPhotoTrashed(photo) && result.reasons.has(photo.id));
  return <aside className="sheet places-sheet photo-cleanup" ref={panel} role="dialog" aria-modal="true" aria-label="Review cleanup" tabIndex={-1}>
    <header className="places-header"><h2>Review cleanup</h2><button onClick={onClose}>Done</button></header>
    <p>Review possible duplicates, blurry shots, and photos with little detail. Nothing is selected or removed automatically.</p>
    <p className="hint">This review covers up to 200 currently loaded photos. Trash is recoverable and only affects Fotoro; it does not free storage.</p>
    {busy ? <p role="status">Checking previews… {done} / {scan.length}</p> : <p role="status">{rows.length} to review · {result.unassessed} previews unassessed.</p>}
    {!busy && !rows.length && <p>No candidates found in this review. Unassessed photos have not been judged.</p>}
    <ul>{rows.map(photo => <CleanupRow key={photo.id} photo={photo} reasons={result.reasons.get(photo.id)!} resources={resources(photo)} remove={canTrash(photo) ? () => onTrash(photo) : undefined} open={() => onOpen(photo)} />)}</ul>
    {changes?.current() && changes.pending.length > 0 && <section><p>Changes are on this device until you save them.</p><button disabled={changes.busy || saveBusy} onClick={() => void save()}>{changes.pending.some(edit => edit.conflict) ? "Review changes" : "Save changes"}</button></section>}
    {saveError && <p role="alert">{saveError}</p>}
  </aside>;
}
