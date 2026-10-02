import { useEffect, useRef, useState } from "react";
import { Icon } from "../library/icons";
import { type LocalPhoto, LocalResources } from "./resources";
import { normalizeSearch, type SearchResult, type SearchMeaning } from "./search";
import type { LocalOcrPhoto } from "./useLocalOcr";
export function meaningRelation(meaning: SearchMeaning) {
  return meaning.kind === "label" ? "Supplied label" : meaning.kind === "date" ? "Date" : "Text mention";
}
function evidence(photo: LocalOcrPhoto, meaning: SearchMeaning) {
  const source = meaning.evidence[photo.id] ?? meaning.kind;
  if (source === "label") return "Supplied label · " + meaning.term;
  if (source === "date") return photo.dateSource === "exif" ? "Date from the photo" : "Date selected · capture date unavailable";
  const term = normalizeSearch(meaning.term), extra = photo as LocalOcrPhoto & {caption?: string; keywords?: string[]; facts?: string[]};
  const keyword = extra.keywords?.find(value => normalizeSearch(value).includes(term));
  if (source === "keyword" && keyword) return "Keyword · " + keyword;
  if (source === "caption" && extra.caption && normalizeSearch(extra.caption).includes(term)) return "Caption · " + extra.caption;
  if (source === "filename" && normalizeSearch(photo.filename).includes(term)) return "Filename text · " + photo.filename;
  if (source === "ocr" && photo.ocr?.status === "complete") {
    const line = photo.ocr.text.split("\n").find(value => normalizeSearch(value).includes(term));
    if (line) return "Text in photo · " + line.slice(0, 180);
  }
  return (source === "fact" ? "Source fact · " : "Text mention · ") + meaning.term;
}
export function LocalSearch({photos, result, resources, committed, pinned, canCorrect = true, coverage, onAccept, onNavigate, onOpen, onConfirm, onPin, onFailure}: {
  photos: LocalPhoto[]; result: SearchResult; resources: LocalResources; committed?: string; pinned?: string;
  canCorrect?: boolean;
  coverage: string; onAccept: (meaning: SearchMeaning) => void; onNavigate: (id: string) => void;
  onOpen: (id: string) => void; onConfirm: (id: string) => void; onPin: (id: string) => void;
  onFailure: (id: string, error: string) => void;
}) {
  const photo = photos.find(p => p.id === result.photoId) as LocalOcrPhoto | undefined,
    index = result.photoIds.indexOf(result.photoId ?? ""), meaning = result.meaning;
  const [loaded, setLoaded] = useState({id: "", url: ""}), [error, setError] = useState(""), [details, setDetails] = useState(false);
  const swiped = useRef(false);
  const touch = useRef<{x: number; y: number} | undefined>(undefined);
  useEffect(() => {
    let current = true;
    setLoaded({id: "", url: ""}); setError("");
    if (!photo) return;
    resources.load(photo, "preview").then(value => {if (current) setLoaded({id: photo.id, url: value.url});})
      .catch(reason => {if (current) {setError(reason.message); onFailure(photo.id, reason.message);}});
    return () => {current = false;};
  }, [photo?.id, photo?.file, photo?.previewLoader, resources]);
  const move = (step: number) => {
    const id = result.photoIds[index + step];
    if (id) onNavigate(id);
  };
  return <section className="local-search" aria-label="Search result">
    <div className="search-caption"><p className="local-coverage" role="status">{result.photoIds.length} {result.photoIds.length === 1 ? "match" : "matches"}</p><button className="text-button" aria-label="Search details" aria-expanded={details} onClick={() => setDetails(!details)}><Icon kind="info" /></button></div>
    {photo && meaning ? <>
      <button className="local-leading" id={"local-photo-" + photo.id} aria-label={"Open " + photo.filename}
        onClick={() => {if (swiped.current) {swiped.current = false; return;} onOpen(photo.id);}} onTouchStart={event => {swiped.current = false; touch.current = event.touches.length === 1 ? {x: event.touches[0].clientX, y: event.touches[0].clientY} : undefined;}}
        onTouchEnd={event => {
          if (touch.current && event.changedTouches.length === 1) {
            const dx = event.changedTouches[0].clientX - touch.current.x, dy = event.changedTouches[0].clientY - touch.current.y;
            if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {swiped.current = true; move(dx < 0 ? 1 : -1);}
          }
          touch.current = undefined;
        }}>
        {loaded.id === photo.id && loaded.url ? <img src={loaded.url} alt={photo.filename} /> : <span>{error || "Preparing preview…"}</span>}
      </button>
      <div className="local-search-controls">
        <button aria-label="Previous matching photo" disabled={index <= 0} onClick={() => move(-1)}><Icon kind="previous" /></button>
        <span>{index + 1} / {result.photoIds.length}</span>
        <button aria-label="Next matching photo" disabled={index >= result.photoIds.length - 1} onClick={() => move(1)}><Icon kind="next" /></button>
      </div>
      {result.meanings.some(value => value.id !== meaning.id && value.photoIds.some(id => !meaning.photoIds.includes(id))) && <div className="local-alternatives" aria-label="Other matches"><span>Also try</span>{result.meanings.filter(value => value.id !== meaning.id && value.photoIds.some(id => !meaning.photoIds.includes(id))).slice(0, 3).map(value => <button key={value.id} onClick={() => onAccept(value)}>{value.term}</button>)}</div>}
      {details && <aside className="search-info" aria-label="About this match">
        <p className="hint">{coverage}</p><p className="local-evidence">{evidence(photo, meaning)}</p>
        <button aria-pressed={committed === meaning.id} onClick={() => onAccept(meaning)}>Search this {meaning.kind === "label" ? "label" : meaning.kind === "date" ? "date" : "text"}</button>
        {canCorrect && <details><summary>Adjust future matches</summary><p className="hint">These choices stay on this device.</p><div className="actions"><button onClick={() => onConfirm(photo.id)}>This is the photo</button><button aria-pressed={pinned === photo.id} onClick={() => onPin(photo.id)}>{pinned === photo.id ? "Preferred photo" : "Prefer this photo"}</button></div></details>}
      </aside>}
    </> : <div className="empty"><p>No matching photos</p><p className="hint">Try a label, a date or words in the photo.</p>{details && <p className="hint">{coverage}. Text is searchable after it has been read on this device.</p>}</div>}
  </section>;
}
