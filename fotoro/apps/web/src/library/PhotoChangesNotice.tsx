import {useEffect, useRef, useState} from "react";
import {photoChangeState, type ConsumerPhotoChanges} from "./consumer-changes";

export function PhotoChangesNotice({changes, photoId, digest, accountId, current}: {
  changes: ConsumerPhotoChanges; photoId: string; digest: string; accountId: string; current: () => boolean;
}) {
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const alive = useRef(false), pending = useRef(false), latest = useRef(current);
  latest.current = current;
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  const state = photoChangeState(changes, photoId, digest, accountId);
  if (!current() || !state.pending && !state.error && !error) return null;
  return <section className="viewer-changes" aria-label="Photo changes">
    <p role="status">{state.error || error || (state.conflict ? "This photo changed on another device." : "Your changes are on this device until you save them.")}</p>
    {state.pending && <button disabled={state.busy || saving} onClick={async () => {
      if (pending.current || !latest.current() || !changes.current()) return;
      if (state.conflict) {changes.review(); return;}
      pending.current = true; setSaving(true); setError("");
      try {if (!await changes.save()) throw new Error("Save failed");}
      catch {if (alive.current && latest.current() && changes.current()) setError("Changes are still on this device. Try saving again.");}
      finally {pending.current = false; if (alive.current) setSaving(false);}
    }}>{saving ? "Saving changes…" : state.conflict ? "Review changes" : "Save changes"}</button>}
  </section>;
}
