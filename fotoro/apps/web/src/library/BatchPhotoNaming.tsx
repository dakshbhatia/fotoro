import {useRef, useState} from "react";
import {canRestorePhotoNames} from "./batch-photo-naming";
import {planPhotoNames, photoName, type PhotoNamePlanEntry, type PhotoNamePlanSource, type PhotoOrganizationPatch} from "@fotoro/contracts/organization";

/** Mount within the selection's source/account boundary; mutations use its existing annotation flow. */
export function BatchPhotoNaming({sources, reservedNames, disabled, current, onChange}: {
  sources: readonly PhotoNamePlanSource[];
  reservedNames: readonly string[];
  disabled?: boolean;
  current: () => boolean;
  onChange: (id: string, patch: PhotoOrganizationPatch) => Promise<void>;
}) {
  const [preview, setPreview] = useState<PhotoNamePlanEntry[]>(), [undo, setUndo] = useState<PhotoNamePlanEntry[]>([]);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const pending = useRef(false);
  const latest = useRef({sources, reservedNames, current, onChange, disabled});
  latest.current = {sources, reservedNames, current, onChange, disabled};
  const valid = (plan: PhotoNamePlanEntry[], restoring: boolean) => {
    const live = latest.current;
    if (!live.current()) return false;
    const byId = new Map(live.sources.map(source => [source.id, source]));
    if (!restoring && (plan.length !== live.sources.length || JSON.stringify(planPhotoNames(live.sources, live.reservedNames)) !== JSON.stringify(plan))) return false;
    return plan.every(entry => {
      const source = byId.get(entry.id);
      return source?.filename === entry.original && source.digest === entry.digest && photoName(source, source.filename) === (restoring ? entry.name : entry.before);
    });
  };
  const apply = async (plan: PhotoNamePlanEntry[], restoring: boolean) => {
    if (pending.current || disabled || !valid(plan, restoring) || restoring && !canRestorePhotoNames(plan, latest.current.sources, latest.current.reservedNames)) {setStatus("Selection or names changed. Preview again."); return;}
    pending.current = true; setBusy(true); setStatus("");
    const completed: PhotoNamePlanEntry[] = [];
    try {
      for (const entry of plan) {
        if (restoring && (!canRestorePhotoNames(plan, latest.current.sources, latest.current.reservedNames) || !valid([entry], true))) throw new Error("changed");
        if (latest.current.disabled || !latest.current.current()) throw new Error("changed");
        if (!restoring && (latest.current.sources.length !== plan.length || !plan.every(item => latest.current.sources.some(source => source.id === item.id)))) throw new Error("changed");
        if (!restoring && latest.current.reservedNames.some(name => name.normalize("NFC").toLowerCase() === entry.name.normalize("NFC").toLowerCase())) throw new Error("changed");
        const source = latest.current.sources.find(source => source.id === entry.id);
        if (!source || source.filename !== entry.original || source.digest !== entry.digest || photoName(source, source.filename) !== (restoring ? entry.name : entry.before)) throw new Error("changed");
        if (entry.name === entry.before) continue;
        await latest.current.onChange(entry.id, {name: restoring ? entry.previousName : entry.name});
        completed.push(entry);
      }
      setStatus(restoring ? "Names restored." : `${completed.length} names applied. Original files stay unchanged.`);
    } catch {setStatus("Stopped because a photo changed or could not be updated. Completed changes are kept.");}
    finally {
      setUndo(restoring ? plan.filter(entry => !completed.includes(entry)) : completed);
      setPreview(undefined); pending.current = false; setBusy(false);
    }
  };
  return <section aria-label="Name selected photos">
    <button type="button" disabled={disabled || busy || !sources.length} onClick={() => {setPreview(planPhotoNames(sources, reservedNames)); setStatus("");}}>Preview names</button>
    {preview && <>
      <p>Review {preview.length} selected photos. Original files stay unchanged.</p>
      <ul>{preview.map(entry => <li key={entry.id}>{entry.before} → {entry.name}</li>)}</ul>
      <button type="button" disabled={disabled || busy} onClick={() => void apply(preview, false)}>Apply names</button>
      <button type="button" disabled={busy} onClick={() => setPreview(undefined)}>Cancel</button>
    </>}
    {!!undo.length && <button type="button" disabled={disabled || busy} onClick={() => void apply(undo, true)}>Undo names</button>}
    {status && <p role="status">{status}</p>}
  </section>;
}
