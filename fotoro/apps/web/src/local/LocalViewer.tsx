import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Icon } from "../library/icons";
import { type LocalPhoto, LocalResources } from "./resources";
import type { LocalOcrPhoto } from "./useLocalOcr";
import {downloadOriginal, OriginalShareAttempt} from "../library/system-share";
import {useDialogFocus} from "../library/dialog-focus";
import {PhotoLocation} from "./PhotoLocation";
import type {CloudPhotoUnderstandingProps} from "../intelligence/CloudPhotoUnderstanding";
import {KeptObservations} from "../intelligence/KeptObservations";
import {CaptureMetadataInfo} from "../library/CaptureMetadataInfo";
const CloudPhotoUnderstanding = lazy(() => import("../intelligence/CloudPhotoUnderstanding").then(module => ({default: module.CloudPhotoUnderstanding})));
export function LocalViewer({photos, initial, resources, onClose, onLabels, onFavorite, onUse, onConfirm, onPin, meaning, onReselect, onSave, isSaved, intelligence}: {
  photos: LocalPhoto[]; initial: string; resources: LocalResources; onClose: () => void;
  onLabels?: (id: string, labels: string[]) => void;
  onFavorite?: (id: string, favorite: boolean) => void;
  onUse?: (id: string) => void; onConfirm?: (id: string) => void; onPin?: (id: string) => void;
  meaning?: string; onReselect?: () => void;
  onSave?: (photo: LocalPhoto) => void; isSaved?: (photo: LocalPhoto) => boolean;
  intelligence?: {scopeKey: string; expectedAccountId: string; current: () => boolean; keep: (photo: LocalPhoto, observation: Parameters<CloudPhotoUnderstandingProps["onObservation"]>[0]) => Promise<void>};
}) {
  const [selected, setSelected] = useState(initial), [loaded, setLoaded] = useState<{id: string; source?: unknown; url: string}>({id: "", url: ""}),
    [details, setDetails] = useState(false), [zoom, setZoom] = useState(false), [status, setStatus] = useState(""), [label, setLabel] = useState(""),
    [sharing, setSharing] = useState(false), [shareAttempt] = useState(() => new OriginalShareAttempt());
  const panel = useRef<HTMLDivElement>(null), touch = useRef<{x: number; y: number} | undefined>(undefined);
  const index = Math.max(0, photos.findIndex(p => p.id === selected)), photo = photos[index] as LocalOcrPhoto | undefined;
  const source = photo?.file ?? photo?.preview ?? photo?.previewLoader;
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
    const controller = new AbortController();
    setLoaded({id: "", url: ""}); setZoom(false); setStatus("");
    resources.lease(photo, "preview", controller.signal).then(value => {if (!controller.signal.aborted) setLoaded({id: photo.id, source, url: value.url});})
      .catch(error => {if (!controller.signal.aborted) {setStatus(error.message); setDetails(true);}});
    return () => controller.abort();
  }, [photo?.id, source, photo?.digest, photo?.width, photo?.height, resources]);
  useEffect(() => {setDetails(false); setLabel("");}, [photo?.id]);
  if (!photo) return null;
  const download = () => {
    if (!photo.file || !alive.current || currentPhoto.current !== photo) return;
    downloadOriginal(photo.file); onUse?.(photo.id);
  };
  const saved = isSaved?.(photo) ?? false;
  return <div className="viewer" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Photo viewer">
    <div className="viewer-top glass">
      <button onClick={onClose} aria-label="Close viewer"><Icon kind="close" /></button>
      <span>{index + 1} / {photos.length}</span>
      <button onClick={() => setDetails(!details)} aria-label="More photo options" aria-expanded={details}>More</button>
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
      {loaded.id === photo.id && loaded.source === source && loaded.url && <img className={zoom ? "zoomed" : ""} src={loaded.url} alt={photo.filename} />}
    </div>
    {!photo.file && <p className="original-gate">Reselect the original to Save or Share. <button onClick={onReselect}>Reselect</button></p>}
    <div className="viewer-bottom glass">
      <button aria-label="Previous photo" disabled={index === 0} onClick={() => setSelected(photos[index - 1].id)}><Icon kind="previous" /></button>
      {onSave && <button disabled={!photo.file || sharing || saved} onClick={() => {
        if (photo.file && !isSaved?.(photo) && alive.current && currentPhoto.current === photo) onSave(photo);
      }}>{saved ? "Saved" : "Save"}</button>}
      <button className="primary-action" disabled={!photo.file || sharing} onClick={async () => {
        if (!photo.file || shareAttempt.pending) return;
        const current = () => alive.current && currentPhoto.current === photo && photo.current?.() !== false && document.visibilityState !== "hidden";
        setSharing(true); setStatus("");
        try {const result = await shareAttempt.run(photo.file, current); if (current() && result !== "cancelled" && result !== "busy") onUse?.(photo.id);}
        catch (error) {if (current()) setStatus("The photo could not be shared. Download the original from More.");}
        finally {if (alive.current) setSharing(false);}
      }}>{sharing ? "Sharing…" : "Share"}</button>
      <button aria-label="Next photo" disabled={index === photos.length - 1} onClick={() => setSelected(photos[index + 1].id)}><Icon kind="next" /></button>
    </div>
    {details && <aside className="details local-details">
      <button onClick={() => setZoom(!zoom)}>{zoom ? "Fit" : "Zoom"}</button>
      <p>{photo.filename}</p><p>{photo.width} × {photo.height}{(photo.originalSize ?? photo.file?.size) ? ` · ${((photo.originalSize ?? photo.file!.size) / 1024 / 1024).toFixed(1)} MB` : ""}</p>
      <p>{new Date(photo.date).toLocaleString()}</p><p>{photo.dateSource === "photos" ? "Date from Photos" : photo.dateSource === "exif" ? "Date from the photo" : "Capture date unavailable · date selected"}</p>
      <PhotoLocation location={photo.location} />
      <CaptureMetadataInfo facts={photo.facts} originalSha256={photo.digest ?? ""} />
      <KeptObservations facts={photo.facts} photoId={photo.id} sourceRevision={photo.digest ?? photo.id} />
      {intelligence && <Suspense fallback={null}><CloudPhotoUnderstanding apiBase="" expectedAccountId={intelligence.expectedAccountId} photoId={photo.id} sourceRevision={photo.digest ?? photo.id} scopeKey={intelligence.scopeKey}
        current={() => alive.current && currentPhoto.current?.id === photo.id && currentPhoto.current.digest === photo.digest && photo.current?.() !== false && intelligence.current()}
        getPreview={async signal => {const loaded = await resources.load(photo, "preview", signal); return loaded.blob;}}
        onObservation={observation => intelligence.keep(photo, observation)} /></Suspense>}
      <p>{photo.file ? "Original file unchanged" : "Retained preview · original not selected"}</p>
      {onFavorite && <button aria-pressed={!!photo.favorite} onClick={() => {
        if (alive.current && currentPhoto.current === photo) onFavorite(photo.id, !photo.favorite);
      }}>{photo.favorite ? "Unfavorite" : "Favorite"}</button>}
      {photo.file && <button onClick={download} disabled={sharing}>Download original</button>}
      <h3>Labels</h3>
      <div className="local-labels">{(photo.labels ?? []).map((value, i) => <button key={i} aria-label={"Remove label " + value} onClick={() => onLabels?.(photo.id, photo.labels!.filter((_, position) => position !== i))}>{value} ×</button>)}</div>
      {onLabels && <form className="local-label-form" onSubmit={event => {
        event.preventDefault();
        if (!label.trim() || (photo.labels?.length ?? 0) >= 64) return;
        if (!photo.labels?.includes(label)) onLabels(photo.id, [...(photo.labels ?? []), label]);
        setLabel("");
      }}><label>New label<input aria-label="New label" value={label} maxLength={120} onChange={event => setLabel(event.target.value)} /></label><button disabled={!label.trim() || (photo.labels?.length ?? 0) >= 64}>Add label</button></form>}
      {photo.ocr?.status === "complete" && <details><summary>Text in photo</summary><p className="local-ocr-text">{photo.ocr.text || "No readable text found."}</p></details>}
      {photo.ocr?.status === "failed" && <p>Text unavailable · {photo.ocr.error ?? "This preview could not be read."}</p>}
      {meaning && <details><summary>Adjust future matches</summary><div className="actions">{onConfirm && <button onClick={() => {onConfirm(photo.id); setStatus("Photo choice saved on this device.");}}>This is the photo</button>}{onPin && <button onClick={() => {onPin(photo.id); setStatus("Preferred photo saved on this device.");}}>Prefer this photo</button>}</div></details>}
    </aside>}
    {status && <p className="viewer-status" role="status">{status}</p>}
  </div>;
}
