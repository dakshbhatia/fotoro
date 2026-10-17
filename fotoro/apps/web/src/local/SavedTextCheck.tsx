import {useEffect, useRef, useState} from "react";
import {savedInferenceSource, type OwnedPhotoSnapshot} from "../library/consumer-search";
import type {ConsumerPhotoChanges} from "../library/consumer-changes";
import type {LocalPhoto} from "./resources";
import {savedTextCandidates, type SavedTextProgress} from "./saved-ocr";

export function SavedTextCheck({snapshot, photos, consent, active, scope, changes, onSync, showSaveAction = true, automatic = false, onBusyChange, onIncomplete}: {
  snapshot: OwnedPhotoSnapshot; photos: readonly LocalPhoto[]; consent: boolean; active: boolean; scope: string;
  changes?: ConsumerPhotoChanges; onSync: () => void; showSaveAction?: boolean; automatic?: boolean; onBusyChange?: (busy: boolean) => void; onIncomplete?: () => void;
}) {
  const latest = useRef({snapshot, photos, consent, active, scope}); latest.current = {snapshot, photos, consent, active, scope};
  const controller = useRef<AbortController | null>(null), alive = useRef(false);
  const [progress, setProgress] = useState<SavedTextProgress>(), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const busyObserver = useRef(onBusyChange); busyObserver.current = onBusyChange;
  useEffect(() => {busyObserver.current?.(busy); return () => busyObserver.current?.(false);}, [busy]);
  const invalidated = useRef(false), failedAutomaticBatch = useRef("");
  const [foreground, setForeground] = useState(0);
  const saving = useRef(false), [saveBusy, setSaveBusy] = useState(false), [saveError, setSaveError] = useState("");
  useEffect(() => {
    alive.current = true; invalidated.current = false;
    const cancel = () => {invalidated.current = true; controller.current?.abort();};
    const visibility = () => {if (document.visibilityState !== "visible") cancel(); else {invalidated.current = false; setForeground(value => value + 1);}};
    document.addEventListener("visibilitychange", visibility); window.addEventListener("fotoro-lock", cancel); window.addEventListener("pagehide", cancel);
    return () => {alive.current = false; cancel(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("fotoro-lock", cancel); window.removeEventListener("pagehide", cancel);};
  }, []);
  useEffect(() => {controller.current?.abort();}, [consent, active, scope, snapshot.token, photos]);
  const attempted = useRef<{token: object; keys: Set<string>}>({token: snapshot.token, keys: new Set()});
  if (attempted.current.token !== snapshot.token) {invalidated.current = false; attempted.current = {token: snapshot.token, keys: new Set()}; failedAutomaticBatch.current = "";}
  const attemptKey = (photo: LocalPhoto) => {
    const source = savedInferenceSource(photo);
    return source ? JSON.stringify([source.accountId, source.photoId, source.digest, source.revision]) : undefined;
  };
  const today = new Date(), from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 9).getTime(),
    until = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
  const eligible = automatic ? photos.filter(photo => {
    const date = Date.parse(photo.date), key = attemptKey(photo);
    return key && !attempted.current.keys.has(key) && date >= from && date < until;
  }) : photos;
  const candidates = savedTextCandidates(snapshot, eligible);
  const candidateKey = JSON.stringify(candidates.map(photo => [photo.id, photo.digest]));
  const pending = changes?.current() && changes.accountId === snapshot.accountId && changes.token === snapshot.token && changes.pending.length > 0;
  const save = async () => {
    if (!pending || !changes || changes.busy || saving.current) return;
    if (changes.pending.some(edit => edit.conflict)) {changes.review(); onSync(); return;}
    saving.current = true; setSaveBusy(true); setSaveError("");
    try {if (!await changes.save()) throw new Error("Save failed");}
    catch {if (alive.current) setSaveError("Changes could not finish saving. Try again.");}
    finally {saving.current = false; if (alive.current) setSaveBusy(false);}
  };
  const start = async () => {
    if (controller.current || invalidated.current || !consent || !active || !snapshot.current() || !snapshot.checkText || !candidates.length) return;
    const source = latest.current, work = new AbortController(); controller.current = work;
    const current = () => alive.current && !invalidated.current && !work.signal.aborted && document.visibilityState === "visible"
      && latest.current.consent && latest.current.active && latest.current.scope === source.scope
      && latest.current.snapshot.token === source.snapshot.token && latest.current.photos === source.photos;
    const attempts = attempted.current, keys = automatic ? candidates.map(attemptKey) : [];
    const keepAttempts = (checked: number) => {for (const key of keys.slice(0, checked)) if (key) attempts.keys.add(key);};
    setBusy(true); setMessage(""); setProgress({checked: 0, total: candidates.length, kept: 0, failed: 0});
    try {
      const result = await snapshot.checkText(candidates, work.signal, current, value => {if (current()) {keepAttempts(value.checked); setProgress(value);}});
      keepAttempts(result.checked);
      if (automatic && result.failed > 0 && current()) onIncomplete?.();
      if (alive.current) {
        setProgress(result);
        setMessage(`${result.cancelled ? "Stopped. " : ""}Text kept for ${result.kept} ${result.kept === 1 ? "photo" : "photos"} on this device${result.failed ? ` · ${result.failed} could not be checked; try again` : ""}.`);
      }
    } catch {if (automatic && current()) {failedAutomaticBatch.current = candidateKey; onIncomplete?.();} if (alive.current) setMessage("Text checks could not finish. Try again.");}
    finally {
      if (controller.current === work) controller.current = null; if (alive.current) setBusy(false);}
  };
  useEffect(() => {
    if (automatic && !invalidated.current && consent && active && document.visibilityState === "visible" && !busy && candidates.length && failedAutomaticBatch.current !== candidateKey) void start();
  }, [automatic, consent, active, scope, snapshot.token, photos, busy, candidateKey, foreground]);
  if (automatic) return null;
  return <section aria-label="Saved photo text">
    <p className="hint">Check up to 25 loaded Saved photos in the current filters. Text is read on this device; existing text is kept.</p>
    <button disabled={!consent || !active || busy || !snapshot.checkText || !candidates.length} onClick={() => {void start();}}>Check Saved photo text ({candidates.length})</button>
    {busy && <button onClick={() => controller.current?.abort()}>Stop text check</button>}
    {busy && progress && <p role="status">Checking Saved text… {progress.checked} / {progress.total}</p>}
    {message && <p role="status">{message}</p>}
    {pending && <p className="hint">{changes?.automatic ? "Changes save automatically." : "Changes are pending on this device until saving resumes."}</p>}
    {showSaveAction && pending && changes && (!changes.automatic || changes.error || changes.pending.some(edit => edit.conflict)) && <button disabled={busy || changes.busy || saveBusy} onClick={() => {void save();}}>{changes.pending.some(edit => edit.conflict) ? "Review changes in Sync" : "Save changes"}</button>}
    {saveError && <p role="alert">{saveError}</p>}
  </section>;
}
