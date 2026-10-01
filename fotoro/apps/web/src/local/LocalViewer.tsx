import { useEffect, useRef, useState } from "react";
import { Icon } from "../library/icons";
import { type LocalPhoto, LocalResources } from "./resources";
import type { LocalOcrPhoto } from "./useLocalOcr";
export function LocalViewer({photos, initial, resources, onClose, onLabels, onUse, onConfirm, onPin, meaning, onReselect}: {
  photos: LocalPhoto[]; initial: string; resources: LocalResources; onClose: () => void;
  onLabels?: (id: string, labels: string[]) => void;
  onUse?: (id: string) => void; onConfirm?: (id: string) => void; onPin?: (id: string) => void;
  meaning?: string; onReselect?: () => void;
}) {
  const [selected, setSelected] = useState(initial), [loaded, setLoaded] = useState({id: "", url: ""}),
    [details, setDetails] = useState(false), [zoom, setZoom] = useState(false), [status, setStatus] = useState(""), [label, setLabel] = useState("");
  const panel = useRef<HTMLDivElement>(null), touch = useRef<{x: number; y: number} | undefined>(undefined);
  const index = Math.max(0, photos.findIndex(p => p.id === selected)), photo = photos[index] as LocalOcrPhoto | undefined;
  useEffect(() => {panel.current?.focus();}, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      const editing = (event.target as HTMLElement)?.matches("input,textarea,select");
      if (!editing && event.key === "ArrowRight") setSelected(photos[Math.min(photos.length - 1, index + 1)]?.id ?? selected);
      if (!editing && event.key === "ArrowLeft") setSelected(photos[Math.max(0, index - 1)]?.id ?? selected);
      if (event.key === "Tab") {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,textarea,summary") ?? []);
        if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === panel.current)) {event.preventDefault(); controls.at(-1)?.focus();}
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) {event.preventDefault(); controls[0]?.focus();}
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, photos, selected, onClose]);
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
    if (!photo.file) return;
    const url = URL.createObjectURL(photo.file), link = document.createElement("a");
    link.href = url; link.download = photo.filename; link.click(); onUse?.(photo.id);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  let canShare = false;
  try {canShare = !!photo.file && typeof navigator.canShare === "function" && navigator.canShare({files: [photo.file]});} catch {}
  return <div className="viewer" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Photo viewer">
    <div className="viewer-top glass">
      <button onClick={onClose} aria-label="Close viewer"><Icon kind="close" /></button>
      <span>{index + 1} / {photos.length}</span>
      <button onClick={() => setDetails(!details)} aria-label="Photo details" aria-expanded={details}><Icon kind="info" /></button>
    </div>
    <div className="view-image" onDoubleClick={() => setZoom(!zoom)}
      onTouchStart={event => {touch.current = event.touches.length === 1 ? {x: event.touches[0].clientX, y: event.touches[0].clientY} : undefined;}}
      onTouchEnd={event => {
        if (touch.current && !zoom) {
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
      {canShare ? <button onClick={async () => {
        if (!photo.file) return;
        try {await navigator.share({files: [photo.file]}); onUse?.(photo.id);}
        catch (error) {if ((error as Error).name !== "AbortError") setStatus("The photo could not be shared. Try downloading it instead.");}
      }}>Share</button> : <button onClick={download} disabled={!photo.file}>Download</button>}
      <button aria-label="Next photo" disabled={index === photos.length - 1} onClick={() => setSelected(photos[index + 1].id)}><Icon kind="next" /></button>
    </div>
    {details && <aside className="details local-details">
      <p>{photo.filename}</p><p>{photo.width} × {photo.height}{(photo.originalSize ?? photo.file?.size) ? ` · ${((photo.originalSize ?? photo.file!.size) / 1024 / 1024).toFixed(1)} MB` : ""}</p>
      <p>{new Date(photo.date).toLocaleString()}</p><p>{photo.dateSource === "exif" ? "Date from the photo" : "Capture date unavailable · date selected"}</p>
      <p>{photo.file ? "Original file unchanged" : "Retained preview · original not selected"}</p>
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
      {meaning && <div className="actions">{onConfirm && <button onClick={() => {onConfirm(photo.id); setStatus("Photo confirmed.");}}>This is the photo</button>}{onPin && <button onClick={() => {onPin(photo.id); setStatus("Pinned for " + meaning + ".");}}>Pin for {meaning}</button>}</div>}
    </aside>}
    {status && <p className="viewer-status" role="status">{status}</p>}
  </div>;
}
