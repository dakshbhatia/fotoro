import {useEffect, useRef, useState} from "react";
import {useDialogFocus} from "../library/dialog-focus";
import {Icon} from "../library/icons";
import type {LocalPhoto, LocalResources} from "./resources";
import {currentTimelineCandidates, groupPhotoPlaces} from "./places";
import {PhotoLocation} from "./PhotoLocation";
import {parseGoogleTimelineFile, previewGoogleTimeline, type TimelineCandidate, type GoogleTimelinePreview} from "./google-timeline";
import {remainingTimelineCandidates, type TimelineApplicationReply} from "./timeline-application";

function PlaceThumbnail({photo, resources, onOpen}: {photo: LocalPhoto; resources: LocalResources; onOpen: (id: string) => void}) {
  const [url, setURL] = useState("");
  useEffect(() => {
    let alive = true;
    if (photo.current?.() !== false) void resources.load(photo, "thumbnail").then(value => {
      if (alive && photo.current?.() !== false) setURL(value.url);
    }).catch(() => {});
    return () => {alive = false;};
  }, [photo, resources]);
  return <button className="place-thumbnail" aria-label={`Open ${photo.filename}`} onClick={() => {
    if (photo.current?.() !== false) onOpen(photo.id);
  }}>{url ? <img src={url} alt={photo.filename} /> : <span>{photo.filename}</span>}</button>;
}
export function Places({photos, resources, savedResources, onOpen, onClose, onApplyLocations}: {
  photos: LocalPhoto[];
  resources: LocalResources;
  savedResources?: LocalResources;
  onOpen: (id: string) => void;
  onClose: () => void;
  onApplyLocations?: (candidates: readonly TimelineCandidate[]) => Promise<TimelineApplicationReply>;
}) {
  const panel = useRef<HTMLElement>(null), input = useRef<HTMLInputElement>(null), alive = useRef(false), importGeneration = useRef(0), currentPhotos = useRef(photos), close = useRef(onClose);
  currentPhotos.current = photos;
  close.current = onClose;
  const [stopLimit, setStopLimit] = useState(40), [preview, setPreview] = useState<GoogleTimelinePreview>(),
    [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useDialogFocus(panel, onClose);
  useEffect(() => {
    alive.current = true;
    const locked = () => {importGeneration.current++; setPreview(undefined); close.current();};
    window.addEventListener("fotoro-lock", locked);
    return () => {alive.current = false; importGeneration.current++; window.removeEventListener("fotoro-lock", locked);};
  }, []);
  const days = groupPhotoPlaces(photos), count = days.reduce((sum, day) => sum + day.visits.reduce((total, visit) => total + visit.photos.length, 0), 0);
  let remaining = stopLimit;
  const displayedDays = days.flatMap(day => {
    const visits = day.visits.slice(0, remaining); remaining -= visits.length;
    return visits.length ? [{...day, visits}] : [];
  });
  const totalStops = days.reduce((sum, day) => sum + day.visits.length, 0);
  const importFile = async (file: File) => {
    const generation = ++importGeneration.current;
    setBusy(true); setPreview(undefined); setMessage("");
    try {
      const timeline = await parseGoogleTimelineFile(file);
      if (!alive.current || generation !== importGeneration.current) return;
      setPreview(previewGoogleTimeline(currentPhotos.current.filter(photo => photo.current?.() !== false), timeline));
    } catch (error) {
      if (alive.current && generation === importGeneration.current) setMessage((error as Error).message);
    } finally {if (alive.current && generation === importGeneration.current) setBusy(false);}
  };
  const apply = async () => {
    if (!preview?.candidates.length || !onApplyLocations || busy) return;
    const generation = importGeneration.current;
    const eligible = currentTimelineCandidates(preview.candidates, currentPhotos.current);
    if (!eligible.length) {setPreview(undefined); setMessage("These photo matches changed. Import Timeline again to check them."); return;}
    setPreview({...preview, candidates: eligible, summary: {...preview.summary, candidateCount: eligible.length}});
    setBusy(true); setMessage("");
    try {
      const result = await onApplyLocations(eligible);
      if (!alive.current || generation !== importGeneration.current) return;
      const retry = remainingTimelineCandidates(eligible, result);
      setPreview(retry.length ? {...preview, candidates: retry, summary: {...preview.summary, candidateCount: retry.length}} : undefined);
      const localOnly = result.localOnlyCount ?? 0;
      setMessage(`${result.applied} ${result.applied === 1 ? "photo updated" : "photos updated"}.${result.failed ? ` ${result.failed} could not be updated.${retry.length ? " Try the remaining matches." : " Import Timeline again to check them."}` : ""}${localOnly ? ` ${localOnly} ${localOnly === 1 ? "photo changed" : "photos changed"} only on this device. Save ${localOnly === 1 ? "it" : "them"} to keep ${localOnly === 1 ? "its location" : "their locations"} in Saved.` : ""}${result.needsSave ? " Save photo changes to sync the new locations." : ""}`);
    } catch {
      if (alive.current && generation === importGeneration.current) setMessage("Locations could not be kept. Try again.");
    } finally {if (alive.current && generation === importGeneration.current) setBusy(false);}
  };
  return <aside className="sheet places-sheet" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Places">
    <header className="places-header"><div><h2>Places</h2><p className="hint">{count ? `${count} ${count === 1 ? "photo" : "photos"} with location` : "Where your photos were taken"}</p></div>
      <button className="menu-button" aria-label="Close Places" onClick={onClose}><Icon kind="close" /></button></header>
    {!days.length && <div className="places-empty"><p>Your photos’ places will appear here.</p><p className="hint">Open or sync photos that contain location.</p></div>}
    {displayedDays.map(day => <section className="places-day" key={day.key}>
      <h3>{day.date ? new Date(day.date).toLocaleDateString(undefined, {year: "numeric", month: "long", day: "numeric"}) : "Capture date unavailable"}</h3>
      <ol>{day.visits.map(visit => <li className="place-stop" key={visit.id}>
        <PhotoLocation location={visit.location} />
        <div className="place-photos">{visit.photos.slice(0, 6).map(photo => <PlaceThumbnail key={photo.id} photo={photo}
          resources={photo.id.startsWith("saved:") && savedResources ? savedResources : resources} onOpen={onOpen} />)}</div>
        {visit.photos.length > 6 && <button className="text-button" onClick={() => onOpen(visit.photos[0].id)}>View {visit.photos.length} photos</button>}
      </li>)}</ol>
    </section>)}
    {totalStops > stopLimit && <button onClick={() => setStopLimit(limit => limit + 40)}>Show more places</button>}
    {onApplyLocations && <section className="timeline-import">
      <button disabled={busy} onClick={() => input.current?.click()}>{busy ? "Working…" : "Import Google Timeline"}</button>
      <details><summary>How to export from Google Maps</summary><p className="hint">On iPhone: Google Maps → Settings → Location &amp; Privacy → Export Timeline data → Save to Files.</p>
        <a href="https://support.google.com/maps/answer/6258979?co=GENIE.Platform%3DiOS&hl=en" target="_blank" rel="noopener noreferrer">Google’s instructions ↗</a></details>
      <input ref={input} hidden type="file" accept="application/json,.json" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file);
      }} />
      {preview && <div className="timeline-preview">
        <p>{preview.candidates.length ? `${preview.candidates.length} ${preview.candidates.length === 1 ? "photo can" : "photos can"} use a location from Timeline.` : "No clear location matches found."}</p>
        <p className="hint">Existing photo locations stay as they are. Timeline matches are shown as estimates.</p>
        {preview.summary.unverifiedTimestampCount > 0 && <p className="hint">{preview.summary.unverifiedTimestampCount} {preview.summary.unverifiedTimestampCount === 1 ? "photo is" : "photos are"} missing a reliable capture time. Open the originals with their capture time and time zone, then import Timeline again.</p>}
        {preview.candidates.slice(0, 3).map(candidate => <p className="hint" key={candidate.photoID}>
          {candidate.location.name || `${candidate.location.latitude.toFixed(4)}, ${candidate.location.longitude.toFixed(4)}`} · {new Date(candidate.capturedAt).toLocaleString()}
        </p>)}
        <div className="actions">{preview.candidates.length > 0 && <button className="primary-action" disabled={busy} onClick={() => void apply()}>Use Timeline locations</button>}
          <button disabled={busy} onClick={() => {importGeneration.current++; setPreview(undefined);}}>Cancel</button></div>
      </div>}
    </section>}
    {message && <p role="status">{message}</p>}
  </aside>;
}
