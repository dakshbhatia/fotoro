import { useState, useEffect, useRef } from "react";
import { photoBytes, type Photo } from "./catalog";
import { mediaURL } from "../vault/vault";
import { Icon } from "./icons";
import { saveReceivedPhoto } from "../exchange/share-service";
import {readableShareError} from "../exchange/sharing";
import {requireVault, type UnlockedVault} from "../vault/vault";
import {sameVault} from "../vault/scope";
import {canShareOriginal, downloadOriginal, OriginalShareAttempt} from "./system-share";
import {useDialogFocus} from "./dialog-focus";
export function viewerPhotoIndex(photos: Photo[], selected: string) {
  return Math.max(0, photos.findIndex(photo => photo.manifest.photoId === selected));
}
export function Viewer({
  photos,
  initial,
  onClose,
  onSaved,
  onLabels,
  onShare,
  onFavorite,
}: {
  photos: Photo[];
  initial: string;
  onClose: () => void;
  onSaved: () => void;
  onLabels?: (photo: Photo, labels: string[]) => void;
  onShare?: (photo: Photo) => void;
  onFavorite?: (photo: Photo, favorite: boolean) => void;
}) {
  const [selected, setSelected] = useState(initial),
    [url, setUrl] = useState(""),
    [zoom, setZoom] = useState(false),
    [details, setDetails] = useState(false),
    [status, setStatus] = useState(""),
    [label, setLabel] = useState(""),
    [saving, setSaving] = useState(false),
    [saveState, setSaveState] = useState<"idle" | "saved" | "failed">("idle"),
    [preparingShare, setPreparingShare] = useState(false),
    [sharing, setSharing] = useState(false),
    [shareAttempt] = useState(() => new OriginalShareAttempt()),
    [prepared, setPrepared] = useState<{file: File; photo: Photo; session: UnlockedVault} | null>(null);
  const touch = useRef<{ x: number; y: number } | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null), originalPanel = useRef<HTMLElement>(null), originalButton = useRef<HTMLButtonElement>(null), hadOriginalOptions = useRef(false);
  const index = viewerPhotoIndex(photos, selected), photo = photos[index];
  const currentPhoto = useRef(photo), mounted = useRef(false), shareGeneration = useRef(0), savingRef = useRef(false);
  currentPhoto.current = photo;
  const authorized = (source: Photo, session: UnlockedVault) => mounted.current && currentPhoto.current === source && sameVault(session);
  useDialogFocus(panel, () => prepared ? setPrepared(null) : onClose());
  useDialogFocus(originalPanel, () => setPrepared(null), !!prepared);
  useEffect(() => {
    if (prepared) {hadOriginalOptions.current = true; return;}
    if (!hadOriginalOptions.current) return;
    hadOriginalOptions.current = false;
    const frame = requestAnimationFrame(() => originalButton.current?.focus({preventScroll: true}));
    return () => cancelAnimationFrame(frame);
  }, [prepared]);
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; shareGeneration.current++;};
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const editing = (e.target as HTMLElement)?.matches("input,textarea,select");
      if (!editing && !prepared && e.key === "ArrowRight") {e.preventDefault(); setSelected(photos[Math.min(photos.length - 1, index + 1)]?.manifest.photoId ?? selected);}
      if (!editing && !prepared && e.key === "ArrowLeft") {e.preventDefault(); setSelected(photos[Math.max(0, index - 1)]?.manifest.photoId ?? selected);}
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [photos, index, selected, prepared]);
  useEffect(() => {
    shareGeneration.current++; setPrepared(null); setPreparingShare(false);
  }, [photo]);
  useEffect(() => {
    if (!photo) return;
    let alive = true;
    setLabel("");
    setUrl("");
    setStatus("");
    setSaveState("idle");
    setZoom(false);
    photoBytes(photo, "preview")
      .then((bytes) => {
        if (alive)
          setUrl(
            mediaURL(
              photo.manifest.photoId + ":preview",
              bytes,
              "image/jpeg",
              1600 * 1600 * 4,
            ),
          );
      })
      .catch((e) => {
        if (alive) setStatus(e.message);
      });
    return () => {
      alive = false;
    };
  }, [photo?.manifest.photoId]);
  if (!photo) return null;
  const prepareShare = async () => {
    const session = requireVault(), generation = ++shareGeneration.current;
    setPreparingShare(true); setStatus("Preparing original…");
    try {
      const bytes = await photoBytes(photo, "original");
      try {
        if (!authorized(photo, session) || shareGeneration.current !== generation) return;
        const file = new File([new Uint8Array(bytes)], photo.metadata.filename, {type: photo.metadata.mediaType});
        setPrepared({file, photo, session}); setStatus("");
      } finally {bytes.fill(0);}
    } catch (error) {if (authorized(photo, session) && shareGeneration.current === generation) setStatus((error as Error).message);}
    finally {if (authorized(photo, session) && shareGeneration.current === generation) setPreparingShare(false);}
  };
  const save = async () => {
    if (!photo.grantId || savingRef.current) return;
    const session = requireVault();
    savingRef.current = true; setSaving(true); setStatus("Verifying original…");
    try {
      await saveReceivedPhoto(photo.grantId, photo.manifest.photoId, {current: () => authorized(photo, session)});
      if (mounted.current && sameVault(session)) {
        if (currentPhoto.current === photo) {setSaveState("saved"); setStatus("Saved to your photos");}
        onSaved();
      }
    } catch (error) {if (authorized(photo, session)) {setSaveState("failed"); setStatus(readableShareError(error));}}
    finally {savingRef.current = false; if (mounted.current) setSaving(false);}
  };
  return (
    <div
      className="viewer"
      role="dialog"
      aria-modal={prepared ? undefined : true}
      aria-label="Photo viewer"
      tabIndex={-1}
      ref={panel}
    >
      <div className="viewer-top glass" inert={prepared ? true : undefined}>
        <button onClick={onClose} aria-label="Close viewer">
          <Icon kind="close" />
        </button>
        <span>
          {index + 1} / {photos.length}
        </span>
        <button onClick={() => setDetails(!details)} aria-label="Photo details" aria-expanded={details}>
          <Icon kind="info" />
        </button>
      </div>
      <div
        className="view-image"
        inert={prepared ? true : undefined}
        onTouchStart={(e) => {
          if (e.touches.length === 1)
            touch.current = {
              x: e.touches[0].clientX,
              y: e.touches[0].clientY,
            };
          else touch.current = undefined;
        }}
        onTouchEnd={(e) => {
          if (touch.current && !zoom && e.changedTouches.length === 1) {
            const dx = e.changedTouches[0].clientX - touch.current.x,
              dy = e.changedTouches[0].clientY - touch.current.y;
            if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5)
              setSelected(photos[Math.max(0, Math.min(photos.length - 1, index + (dx < 0 ? 1 : -1)))].manifest.photoId);
          }
          touch.current = undefined;
        }}
        onDoubleClick={() => setZoom(!zoom)}
      >
        {url && (
          <img
            className={zoom ? "zoomed" : ""}
            src={url}
            alt={photo.metadata.filename}
          />
        )}
      </div>
      <div className="viewer-bottom glass" inert={prepared ? true : undefined}>
        <button
          disabled={index === 0}
          onClick={() => setSelected(photos[index - 1].manifest.photoId)}
          aria-label="Previous photo"
        >
          <Icon kind="previous" />
        </button>
        <button onClick={() => setZoom(!zoom)}>{zoom ? "Fit" : "Zoom"}</button>
        {onShare && !photo.grantId && <button onClick={() => onShare(photo)}>Share</button>}
        <button
          ref={originalButton}
          disabled={preparingShare || sharing}
          onClick={() => void prepareShare()}
        >
          {preparingShare ? "Preparing…" : sharing ? "Sharing…" : onShare ? "Original" : "Share"}
        </button>
        {photo.grantId && (
          <button
            disabled={saving || saveState === "saved"}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "failed" ? "Retry Save" : "Save"}
          </button>
        )}
        <button
          disabled={index === photos.length - 1}
          onClick={() => setSelected(photos[index + 1].manifest.photoId)}
          aria-label="Next photo"
        >
          <Icon kind="next" />
        </button>
      </div>
      {prepared && prepared.photo === photo && sameVault(prepared.session) && <aside className="original-share" ref={originalPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Share original">
        <button className="close" aria-label="Close share options" onClick={() => setPrepared(null)}><Icon kind="close" /></button>
        <h2>Original ready</h2><p className="hint">{photo.metadata.filename} · verified, unchanged</p>
        <div className="actions">
          {canShareOriginal(prepared.file) && <button disabled={sharing} onClick={() => {
            if (shareAttempt.pending) return;
            const current = () => authorized(prepared.photo, prepared.session);
            setSharing(true); setStatus("");
            void shareAttempt.run(prepared.file, current).then(result => {
              if (current() && result !== "cancelled" && result !== "busy") {setPrepared(null); if (result === "downloaded") setStatus("Original downloaded");}
            }).catch(error => {if (current()) setStatus("Sharing could not finish. You can download the original instead.");})
              .finally(() => {if (mounted.current) setSharing(false);});
          }}>{sharing ? "Sharing…" : "Share original"}</button>}
          <button disabled={sharing} onClick={() => {if (!authorized(prepared.photo, prepared.session)) return; downloadOriginal(prepared.file); setPrepared(null); setStatus("Original downloaded");}}>Download original</button>
        </div>
      </aside>}
      {details && (
        <aside className="details" inert={prepared ? true : undefined}>
          <p>{photo.metadata.filename}</p>
          <p>
            {photo.metadata.mediaType} ·{" "}
            {photo.metadata.originalBytes.toLocaleString()} bytes
          </p>
          <p>
            {photo.metadata.dateSource === "import"
              ? "Import date · original capture date unavailable"
              : "Capture date"}{" "}
            · {new Date(photo.metadata.sourceDate).toLocaleString()}
          </p>
          {!photo.grantId && <>
            {onFavorite && <button aria-pressed={photo.annotations?.favorite === true} onClick={() => onFavorite(photo, photo.annotations?.favorite !== true)}>{photo.annotations?.favorite ? "Unfavorite" : "Favorite"}</button>}
            <h3>Labels</h3>
            <div className="local-labels">{(photo.annotations?.labels ?? []).map((value, index) => onLabels ? <button key={index} aria-label={"Remove label " + value} onClick={() => onLabels(photo, photo.annotations!.labels!.filter((_, position) => position !== index))}>{value} ×</button> : <span key={index}>{value}</span>)}</div>
            {onLabels && <form className="local-label-form" onSubmit={event => {
              event.preventDefault();
              const labels = photo.annotations?.labels ?? [];
              if (!label.trim() || labels.length >= 64) return;
              if (!labels.includes(label)) onLabels(photo, [...labels, label]);
              setLabel("");
            }}><label>New label<input aria-label="New label" value={label} maxLength={120} onChange={event => setLabel(event.target.value)} /></label><button disabled={!label.trim() || (photo.annotations?.labels?.length ?? 0) >= 64}>Add label</button></form>}
            {photo.annotations?.ocr && <details><summary>Text in photo</summary><p className="local-ocr-text">{photo.annotations.ocr.text || "No readable text found."}</p></details>}
          </>}
        </aside>
      )}
      <p role="status" className="viewer-status">
        {status}
      </p>
    </div>
  );
}
