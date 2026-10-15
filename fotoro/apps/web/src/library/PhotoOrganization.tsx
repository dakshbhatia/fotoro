import {useEffect, useRef, useState} from "react";
import {isPhotoScreenshot, isPhotoTrashed, photoName, suggestedPhotoName, validPhotoName, type PhotoOrganizationPatch} from "@fotoro/contracts/organization";
import {applyPhotoOrganizationDraft, createPhotoNameDraft, editPhotoNameDraft, reconcilePhotoNameDraft} from "./photo-name-draft";

export function PhotoOrganization({source, onChange, saved}: {
  source: {filename: string; facts?: string[]; digest?: string; date?: string; dateSource?: string; labels?: string[]; location?: {name?: string}};
  onChange?: (patch: PhotoOrganizationPatch) => Promise<void>;
  saved: boolean;
}) {
  const effective = photoName(source, source.filename), screenshot = isPhotoScreenshot(source), trashed = isPhotoTrashed(source);
  const [draft, setDraft] = useState(() => createPhotoNameDraft(effective)), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const name = draft.value;
  const alive = useRef(false), pending = useRef(false);
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  useEffect(() => setDraft(current => reconcilePhotoNameDraft(current, effective)), [effective]);
  const extension = (value: string) => value.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? "";
  const valid = validPhotoName(name) && extension(name) === extension(source.filename);
  const apply = async (patch: PhotoOrganizationPatch) => {
    if (!onChange || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {await applyPhotoOrganizationDraft(patch, source.filename, onChange, () => alive.current && pending.current, setDraft);}
    catch {if (alive.current) setError("This change could not be kept. Try again.");}
    finally {pending.current = false; if (alive.current) setBusy(false);}
  };
  return <section className="photo-organization" aria-label="Organize photo">
    <h3>Photo name</h3>
    <form onSubmit={event => {event.preventDefault(); if (valid && name !== effective) void apply({name});}}>
      <label>Filename<input aria-label="Photo filename" value={name} maxLength={160} disabled={!onChange || busy} onChange={event => {const value = event.target.value; setDraft(current => editPhotoNameDraft(current, value));}} /></label>
      {onChange && <div className="actions"><button type="button" disabled={busy} onClick={() => setDraft(current => editPhotoNameDraft(current, suggestedPhotoName({...source, screenshot})))}>Suggest name</button><button disabled={!valid || name === effective || busy}>Apply name</button>{effective !== source.filename && <button type="button" disabled={busy} onClick={() => void apply({name: null})}>Use original name</button>}</div>}
    </form>
    {draft.savedNameChanged && name !== effective && <>
      <p className="hint" role="status">The saved name changed to <strong>{effective}</strong>. Your draft is kept.</p>
      <button type="button" disabled={busy} onClick={() => setDraft(createPhotoNameDraft(effective))}>Use saved name</button>
    </>}
    {!valid && <p className="hint">Use a filename without slashes or special file characters. Keep the original extension.</p>}
    <p className="hint">{saved ? "Names follow this photo in Fotoro and on exported copies." : "Save this photo to Fotoro to keep its name across devices."} The original stays unchanged.</p>
    <label className="local-check"><input type="checkbox" checked={screenshot} disabled={!onChange || busy} onChange={event => void apply({screenshot: event.target.checked})} />Screenshot</label>
    {saved && onChange && <><button disabled={busy} onClick={() => void apply({trash: !trashed})}>{trashed ? "Restore photo" : "Move to Fotoro Trash"}</button><p className="hint">Trash hides this photo in Fotoro. You can Restore it. Device Photos and storage use stay unchanged.</p></>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
