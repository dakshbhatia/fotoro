import { useEffect, useRef, useState } from "react";
import { Icon } from "../library/icons";
import { type LocalPhoto, LocalResources } from "./resources";
import type { LocalOcrPhoto } from "./useLocalOcr";
import {canShareOriginal, downloadOriginal, OriginalShareAttempt} from "../library/system-share";
import {useDialogFocus} from "../library/dialog-focus";
export function LocalViewer({photos, initial, resources, onClose, onLabels, onFavorite, onUse, onConfirm, onPin, meaning, onReselect, onSave, isSaved}: {
  photos: LocalPhoto[]; initial: string; resources: LocalResources; onClose: () => void;
  onLabels?: (id: string, labels: string[]) => void;
  onFavorite?: (id: string, favorite: boolean) => void;
  onUse?: (id: string) => void; onConfirm?: (id: string) => void; onPin?: (id: string) => void;
  meaning?: string; onReselect?: () => void;
  onSave?: (photo: LocalPhoto) => void; isSaved?: (photo: LocalPhoto) => boolean;
}) {
  const [selected, setSelected] = useState(initial), [loaded, setLoaded] = useState({id: "", url: ""}),
    [details, setDetails] = useState(false), [zoom, setZoom] = useState(false), [status, setStatus] = useState(""), [label, setLabel] = useState(""),
    [sharing, setSharing] = useState(false), [shareAttempt] = useState(() => new OriginalShareAttempt());
  const panel = useRef<HTMLDivElement>(null), touch = useRef<{x: number; y: number} | undefined>(undefined);
  const index = Math.max(0, photos.findIndex(p => p.id === selected)), photo = photos[index] as LocalOcrPhoto | undefined;
  const currentPhoto = useRef(photo), alive = useRef(false);
  currentPhoto.current = photo;
  useDialogFocus(panel, onClose);
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const editing = (event.target as HTMLElement)?.matches("input,textarea,select");
      if (!editing && event.key === "ArrowRight") {event.preventDefault(); setSelected(photos[Math.min(photos.length - 1, index + 1)]?.id ?? selected);}
      if (!editing && event.key === "ArrowLeft") {event.preventDefault(); setSelected(photos[Math.max(0, index - 1)]?.id ?? selected);}
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, photos, selected]);
  useEffect(() => {
    if (!photo) return;
    let alive = true;
    setLoaded({id: "", url: ""}); setZoom(false); setStatus("");
    resources.load(photo, "preview").then(value => {if (alive) setLoaded({id: photo.id, url: value.url});})
      .catch(error => {if (alive) {setStatus(error.message); setDetails(true);}});
    return () => {alive = false;};
  }, [photo?.id, photo?.file, photo?.previewLoader, resources]);
  useEffect(() => {setDetails(false); setLabel("");}, [photo?.id]);
  if (!photo) return null;
  const download = () => {
    if (!photo.file || !alive.current || currentPhoto.current !== photo) return;
    downloadOriginal(photo.file); onUse?.(photo.id);
  };
  const canShare = !!photo.file && canShareOriginal(photo.file);
  const saved = isSaved?.(photo) ?? false;
  return <div className="viewer" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Photo viewer">
    <div className="viewer-top glass">
      <button onClick={onClose} aria-label="Close viewer"><Icon kind="close" /></button>
      <span>{index + 1} / {photos.length}</span>
      <button onClick={() => setDetails(!details)} aria-label="Photo details" aria-expanded={details}><Icon kind="info" /></button>
    </div>
    <div className="view-image" onDoubleClick={() => setZoom(!zoom)}
      onTouchStart={event => {touch.current = event.touches.length === 1 ? {x: event.touches[0].clientX, y: event.touches[0].clientY} : undefined;}}
      onTouchEnd={event => {
        if (touch.current && !zoom && event.changedTouches.length === 1) {
          const dx = event.changedTouches[0].clientX - touch.current.x, dy = event.changedTouches[0].clientY - touch.current.y;
          if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) setSelected(photos[Math.max(0, Math.min(photos.length - 1, index + (dx < 0 ? 1 : -1)))].id);
        }
        touch.current = undefined;
      }}>
      {loaded.id === photo.id && loaded.url && <img className={zoom ? "zoomed" : ""} src={loaded.url} alt={photo.filename} />}
    </div>
    {!photo.file && <p className="original-gate">Reselect the original to download or share. <button onClick={onReselect}>Reselect</button></p>}
    <div className="viewer-bottom glass">
      <button aria-label="Previous photo" disabled={index === 0} onClick={() => setSelected(photos[index - 1].id)}><Icon kind="previous" /></button>
      <button onClick={() => setZoom(!zoom)}>{zoom ? "Fit" : "Zoom"}</button>
      {onSave && <button disabled={!photo.file || sharing || saved} onClick={() => {
        if (photo.file && !isSaved?.(photo) && alive.current && currentPhoto.current === photo) onSave(photo);
      }}>{saved ? "Saved" : "Save"}</button>}
      {canShare ? <button disabled={sharing} onClick={async () => {
        if (!photo.file || shareAttempt.pending) return;
        const current = () => alive.current && currentPhoto.current === photo;
        setSharing(true); setStatus("");
        try {const result = await shareAttempt.run(photo.file, current); if (current() && result !== "cancelled" && result !== "busy") onUse?.(photo.id);}
        catch (error) {if (current()) setStatus("The photo could not be shared. Download the original from Info.");}
        finally {if (alive.current) setSharing(false);}
      }}>{sharing ? "Sharing…" : "Share"}</button> : <button onClick={download} disabled={!photo.file || sharing}>Download</button>}
      <button aria-label="Next photo" disabled={index === photos.length - 1} onClick={() => setSelected(photos[index + 1].id)}><Icon kind="next" /></button>
    </div>
    {details && <aside className="details local-details">
      <p>{photo.filename}</p><p>{photo.width} × {photo.height}{(photo.originalSize ?? photo.file?.size) ? ` · ${((photo.originalSize ?? photo.file!.size) / 1024 / 1024).toFixed(1)} MB` : ""}</p>
      <p>{new Date(photo.date).toLocaleString()}</p><p>{photo.dateSource === "exif" ? "Date from the photo" : "Capture date unavailable · date selected"}</p>
      <p>{photo.file ? "Original file unchanged" : "Retained preview · original not selected"}</p>
      {onFavorite && <button aria-pressed={!!photo.favorite} onClick={() => {
        if (alive.current && currentPhoto.current === photo) onFavorite(photo.id, !photo.favorite);
      }}>{photo.favorite ? "Unfavorite" : "Favorite"}</button>}
      {canShare && <button onClick={download} disabled={sharing}>Download original</button>}
      <h3>Labels</h3>
      <div className="local-labels">{(photo.labels ?? []).map((value, i) => <button key={i} aria-label={"Remove label " + value} onClick={() => onLabels?.(photo.id, photo.labels!.filter((_, position) => position !== i))}>{value} ×</button>)}</div>
      {onLabels && <form className="local-label-form" onSubmit={event => {
        event.preventDefault();
        if (!label.trim() || (photo.labels?.length ?? 0) >= 64) return;
        if (!photo.labels?.includes(label)) onLabels(photo.id, [...(photo.labels ?? []), label]);
        setLabel("");
      }}><label>New label<input aria-label="New label" value={label} maxLength={120} onChange={event => setLabel(event.target.value)} /></label><button disabled={!label.trim() || (photo.labels?.length ?? 0) >= 64}>Add label</button></form>}
      <p className="hint">Labels are your supplied associations.</p>
      {photo.ocr?.status === "complete" && <details><summary>Text in photo</summary><p className="local-ocr-text">{photo.ocr.text || "No readable text found."}</p></details>}
      {photo.ocr?.status === "failed" && <p>Text unavailable · {photo.ocr.error ?? "This preview could not be read."}</p>}
      {meaning && <details><summary>Adjust future matches</summary><div className="actions">{onConfirm && <button onClick={() => {onConfirm(photo.id); setStatus("Photo choice saved on this device.");}}>This is the photo</button>}{onPin && <button onClick={() => {onPin(photo.id); setStatus("Preferred photo saved on this device.");}}>Prefer this photo</button>}</div></details>}
    </aside>}
    {status && <p className="viewer-status" role="status">{status}</p>}
  </div>;
}
