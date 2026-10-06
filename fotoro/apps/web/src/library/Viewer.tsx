import {isCameraMedia, LIVE_PHOTO_TYPE} from "@fotoro/contracts/camera-media";
import {cameraOriginalFiles, readCameraPlayback} from "../media/camera-original";
import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { photoBytes, type Photo } from "./catalog";
import { Icon } from "./icons";
import { saveReceivedPhoto } from "../exchange/share-service";
import {readableShareError} from "../exchange/sharing";
import {requireVault, type UnlockedVault} from "../vault/vault";
import {sameVault} from "../vault/scope";
import {canShareOriginals, downloadOriginal, OriginalShareAttempt} from "./system-share";
import {useDialogFocus} from "./dialog-focus";
import {photoChangeState, type ConsumerPhotoChanges} from "./consumer-changes";
import {failedViewerPreview, readViewerPreview, viewerPreviewSource, type ViewerPreview} from "./viewer-preview";
import {annotationLocation} from "@fotoro/contracts/location";
import {PhotoLocation} from "../local/PhotoLocation";
import type {PhotoObservationV1} from "@fotoro/contracts/intelligence";
import {KeptObservations} from "../intelligence/KeptObservations";
import {intelligenceScope} from "../intelligence/scope";
const CloudPhotoUnderstanding = lazy(() => import("../intelligence/CloudPhotoUnderstanding").then(module => ({default: module.CloudPhotoUnderstanding})));
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
  changes,
  onObservation,
}: {
  photos: Photo[];
  initial: string;
  onClose: () => void;
  onSaved: () => void;
  onLabels?: (photo: Photo, labels: string[]) => void | Promise<void>;
  onShare?: (photo: Photo) => void;
  onFavorite?: (photo: Photo, favorite: boolean) => void | Promise<void>;
  changes?: ConsumerPhotoChanges;
  onObservation?: (photo: Photo, observation: PhotoObservationV1) => Promise<void>;
}) {
  const [selected, setSelected] = useState(initial),
    [preview, setPreview] = useState<ViewerPreview>(),
    [previewAttempt, setPreviewAttempt] = useState(0),
    [zoom, setZoom] = useState(false),
    [details, setDetails] = useState(false),
    [status, setStatus] = useState(""),
    [originalShareError, setOriginalShareError] = useState(""),
    [editError, setEditError] = useState(""),
    [savingChanges, setSavingChanges] = useState(false),
    [label, setLabel] = useState(""),
    [saving, setSaving] = useState(false),
    [saveState, setSaveState] = useState<"idle" | "saved" | "failed">("idle"),
    [preparingShare, setPreparingShare] = useState(false),
    [sharing, setSharing] = useState(false),
    [shareAttempt] = useState(() => new OriginalShareAttempt()),
    [playRequest, setPlayRequest] = useState<string>(),
    [playAttempt, setPlayAttempt] = useState(0),
    [motion, setMotion] = useState<{source: string; url?: string; failed?: boolean}>(),
    [prepared, setPrepared] = useState<{files: File[]; photo: Photo; session: UnlockedVault} | null>(null);
  const touch = useRef<{ x: number; y: number } | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null), originalPanel = useRef<HTMLElement>(null), originalButton = useRef<HTMLButtonElement>(null), hadOriginalOptions = useRef(false);
  const index = viewerPhotoIndex(photos, selected), photo = photos[index];
  const previewSource = photo ? viewerPreviewSource(photo) : "";
  const currentPreviewSource = useRef(previewSource);
  currentPreviewSource.current = previewSource;
  const currentPhoto = useRef(photo), mounted = useRef(false), shareGeneration = useRef(0), savingRef = useRef(false);
  const shareController = useRef<AbortController | null>(null), preparedRef = useRef(prepared);
  preparedRef.current = prepared;
  const savingChangesRef = useRef(false);
  let intelligenceSession: UnlockedVault | undefined;
  try {intelligenceSession = requireVault();} catch {}
  currentPhoto.current = photo;
  const authorized = (source: Photo, session: UnlockedVault) => mounted.current && currentPhoto.current === source && sameVault(session);
  const originalCurrent = (source: Photo, session: UnlockedVault) => authorized(source, session) && document.visibilityState !== "hidden";
  const clearPrepared = () => {
    shareGeneration.current++; shareController.current?.abort(); shareController.current = null;
    if (preparedRef.current) preparedRef.current.files.length = 0;
    preparedRef.current = null; setPrepared(null); setPreparingShare(false); setOriginalShareError("");
  };
  useDialogFocus(panel, () => prepared ? clearPrepared() : onClose());
  useDialogFocus(originalPanel, clearPrepared, !!prepared);
  useEffect(() => {
    if (prepared) {hadOriginalOptions.current = true; return;}
    if (!hadOriginalOptions.current) return;
    hadOriginalOptions.current = false;
    const frame = requestAnimationFrame(() => originalButton.current?.focus({preventScroll: true}));
    return () => cancelAnimationFrame(frame);
  }, [prepared]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {if (document.visibilityState === "hidden") clearPrepared();};
    window.addEventListener("fotoro-lock", clearPrepared); window.addEventListener("pagehide", clearPrepared);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false; clearPrepared();
      window.removeEventListener("fotoro-lock", clearPrepared); window.removeEventListener("pagehide", clearPrepared);
      document.removeEventListener("visibilitychange", hidden);
    };
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
    clearPrepared(); setPlayRequest(undefined); setMotion(undefined);
  }, [photo]);
  useEffect(() => {
    if (!photo) return;
    setLabel("");
    setStatus("");
    setEditError("");
    setSaveState("idle");
    setZoom(false);
  }, [photo?.manifest.photoId]);
  useEffect(() => {
    if (!photo) return;
    let session: UnlockedVault;
    try {session = requireVault();} catch {return;}
    const controller = new AbortController(), source = previewSource;
    let alive = true;
    const current = () => alive && mounted.current && currentPreviewSource.current === source && sameVault(session);
    setPreview({source, state: "loading"});
    void readViewerPreview(photo, controller.signal, current).then(url => {
      if (url && current()) setPreview({source, state: "ready", url});
    }).catch(() => {
      if (!controller.signal.aborted && current()) setPreview({source, state: "failed"});
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [previewSource, previewAttempt]);
  useEffect(() => {
    if (!photo || playRequest !== previewSource || !isCameraMedia(photo.metadata.mediaType)) return;
    let session: UnlockedVault;
    try {session = requireVault();} catch {return;}
    const controller = new AbortController(), source = previewSource;
    let alive = true, url: string | undefined;
    const current = () => alive && mounted.current && currentPreviewSource.current === source && sameVault(session);
    const clear = () => {alive = false; controller.abort(); if (url) URL.revokeObjectURL(url);};
    const hidden = () => {if (document.hidden) {clear(); setMotion(undefined);}};
    window.addEventListener("fotoro-lock", clear);
    document.addEventListener("visibilitychange", hidden);
    setMotion({source});
    void readCameraPlayback(photo, controller.signal, current).then(blob => {
      if (!blob || !current()) return;
      url = URL.createObjectURL(blob);
      if (!current()) {URL.revokeObjectURL(url); url = undefined; return;}
      setMotion({source, url});
    }).catch(() => {if (!controller.signal.aborted && current()) setMotion({source, failed: true});});
    return () => {clear(); window.removeEventListener("fotoro-lock", clear); document.removeEventListener("visibilitychange", hidden);};
  }, [previewSource, playRequest, playAttempt]);
  if (!photo) return null;
  const previewState = preview?.source === previewSource ? preview.state : "loading";
  const previewURL = previewState === "ready" ? preview?.url : undefined;
  const correction = photoChangeState(photo.grantId ? undefined : changes, photo.manifest.photoId, photo.metadata.originalSha256, photo.manifest.ownerAccountId);
  const applyChange = async (action: () => void | Promise<unknown>) => {
    const source = photo;
    let session: UnlockedVault | undefined;
    try {session = requireVault(); await action(); if (mounted.current && sameVault(session)) setEditError("");}
    catch {if (session && mounted.current && sameVault(session) && currentPhoto.current?.manifest.photoId === source.manifest.photoId && currentPhoto.current?.metadata.originalSha256 === source.metadata.originalSha256) setEditError("Changes could not be kept. Try again.");}
  };
  const prepareShare = async () => {
    if (shareController.current || shareAttempt.pending || !mounted.current || document.visibilityState === "hidden") return;
    let session: UnlockedVault;
    try {session = requireVault();} catch {return;}
    const generation = ++shareGeneration.current, controller = new AbortController();
    shareController.current = controller;
    const current = () => !controller.signal.aborted && originalCurrent(photo, session) && shareGeneration.current === generation;
    setPreparingShare(true); setStatus("Preparing original…"); setOriginalShareError("");
    try {
      const bytes = await photoBytes(photo, "original", controller.signal);
      try {
        if (!current()) return;
        const files = await cameraOriginalFiles(bytes, photo.metadata);
        if (!current()) {files.length = 0; return;}
        preparedRef.current = {files, photo, session}; setPrepared(preparedRef.current); setStatus("");
      } finally {bytes.fill(0);}
    } catch (error) {if (current() && (error as Error).name !== "AbortError") setStatus("The original could not be prepared. Check your connection and try again.");}
    finally {if (shareController.current === controller) {shareController.current = null; if (current()) setPreparingShare(false);}}
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
        {photos.length > 1 && <span>
          {index + 1} / {photos.length}
        </span>}
        <button onClick={() => setDetails(!details)} aria-label="More photo options" aria-expanded={details}>More</button>
      </div>
      <div
        className="view-image"
        aria-busy={previewState === "loading"}
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
        {motion?.source === previewSource && motion.url ? <video src={motion.url} controls autoPlay playsInline aria-label={photo.metadata.filename} style={{maxWidth: "100%", maxHeight: "100%"}} onError={() => setMotion({source: previewSource, failed: true})} /> : previewURL ? (
          <img
            className={zoom ? "zoomed" : ""}
            src={previewURL}
            alt={photo.metadata.filename}
            onError={() => {
              if (mounted.current && currentPreviewSource.current === previewSource)
                setPreview(previous => failedViewerPreview(previous, previewSource, previewURL));
            }}
          />
        ) : previewState === "failed" ? <div>
          <p role="status">Photo preview unavailable.</p>
          <button onClick={() => {setPreview({source: previewSource, state: "loading"}); setPreviewAttempt(attempt => attempt + 1);}}>Retry</button>
        </div> : <p role="status">Opening photo…</p>}
      </div>
      <div className="viewer-bottom glass" inert={prepared ? true : undefined}>
        {photos.length > 1 && <button
          disabled={index === 0}
          onClick={() => setSelected(photos[index - 1].manifest.photoId)}
          aria-label="Previous photo"
        >
          <Icon kind="previous" />
        </button>}
        {isCameraMedia(photo.metadata.mediaType) && <button disabled={playRequest === previewSource && !motion?.url && !motion?.failed} onClick={() => {setPlayRequest(previewSource); setPlayAttempt(value => value + 1);}}>
          {playRequest === previewSource && !motion?.url && !motion?.failed ? "Opening original…" : photo.metadata.mediaType === LIVE_PHOTO_TYPE ? "Play Live Photo" : "Play video"}
        </button>}
        {motion?.source === previewSource && motion.failed && <p role="status">This browser cannot play the original. You can download its unchanged resources.</p>}
        <button
          ref={originalButton}
          className="primary-action"
          disabled={preparingShare || sharing}
          onClick={() => void prepareShare()}
        >
          {preparingShare ? "Preparing…" : sharing ? "Sharing…" : "Share"}
        </button>
        {photo.grantId && (
          <button
            disabled={saving || saveState === "saved"}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "failed" ? "Retry Save" : "Save"}
          </button>
        )}
        {photos.length > 1 && <button
          disabled={index === photos.length - 1}
          onClick={() => setSelected(photos[index + 1].manifest.photoId)}
          aria-label="Next photo"
        >
          <Icon kind="next" />
        </button>}
      </div>
      {prepared && prepared.photo === photo && sameVault(prepared.session) && <aside className="original-share" ref={originalPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Share photo">
        <button className="close" aria-label="Close share options" onClick={clearPrepared}><Icon kind="close" /></button>
        <h2>Share photo</h2>
        {originalShareError && <p className="hint" role="status">{originalShareError}</p>}
        <div className="actions">
          {canShareOriginals(prepared.files) && <button className="primary-action" disabled={sharing} onClick={() => {
            if (shareAttempt.pending) return;
            const current = () => originalCurrent(prepared.photo, prepared.session);
            setSharing(true); setStatus(""); setOriginalShareError("");
            void shareAttempt.runFiles(prepared.files, current).then(result => {
              if (current() && result !== "cancelled" && result !== "busy") {clearPrepared(); if (result === "downloaded") setStatus("Original downloaded");}
            }).catch(() => {if (current()) setOriginalShareError("Sharing could not finish. You can download the original instead.");})
              .finally(() => {if (mounted.current) setSharing(false);});
          }}>{sharing ? "Sharing…" : "Share"}</button>}
          <button className={canShareOriginals(prepared.files) ? undefined : "primary-action"} disabled={sharing} onClick={() => {
            if (shareAttempt.pending || !originalCurrent(prepared.photo, prepared.session)) return;
            const current = () => originalCurrent(prepared.photo, prepared.session);
            setSharing(true); setStatus(""); setOriginalShareError("");
            void shareAttempt.runFiles(prepared.files, current, {canShare: () => false, download: downloadOriginal}).then(result => {
              if (current() && result === "downloaded") {clearPrepared(); setStatus("Original downloaded");}
            }).catch(() => {if (current()) setOriginalShareError("The original could not be downloaded. Try again.");})
              .finally(() => {if (mounted.current) setSharing(false);});
          }}>Download original</button>
        </div>
      </aside>}
      {details && (
        <aside className="details" inert={prepared ? true : undefined}>
          {!isCameraMedia(photo.metadata.mediaType) && <button onClick={() => setZoom(!zoom)}>{zoom ? "Fit" : "Zoom"}</button>}
          {onShare && !photo.grantId && <button disabled={preparingShare || sharing} onClick={() => onShare(photo)}>Share in Fotoro</button>}
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
          {!photo.grantId && <PhotoLocation location={annotationLocation(photo.annotations ?? {})} />}
          {!photo.grantId && <>
            <KeptObservations facts={photo.annotations?.facts} photoId={photo.manifest.photoId} sourceRevision={photo.metadata.originalSha256} />
            {onObservation && intelligenceSession && photo.manifest.ownerAccountId === intelligenceSession.accountId && <Suspense fallback={null}>
              <CloudPhotoUnderstanding apiBase="" expectedAccountId={intelligenceSession.accountId} scopeKey={intelligenceScope(intelligenceSession)} photoId={photo.manifest.photoId} sourceRevision={photo.metadata.originalSha256}
                current={() => mounted.current && currentPhoto.current?.manifest === photo.manifest && currentPhoto.current.metadata === photo.metadata && !currentPhoto.current.grantId && sameVault(intelligenceSession!)}
                getPreview={async signal => {
                  const bytes = await photoBytes(photo, "preview", signal);
                  try {signal.throwIfAborted(); return new Blob([new Uint8Array(bytes)], {type: "image/jpeg"});}
                  finally {bytes.fill(0);}
                }} onObservation={observation => onObservation(photo, observation)} />
            </Suspense>}
            {(correction.pending || correction.error || editError) && <section className="viewer-changes" aria-label="Photo changes">
              <p role="status">{correction.error || editError || (correction.conflict ? "This photo changed on another device. Review before saving." : "Changes stay on this device until you Save changes.")}</p>
              {correction.pending && changes && <button disabled={correction.busy || savingChanges} onClick={() => {
                if (savingChangesRef.current || !changes.current()) return;
                if (correction.conflict) {changes.review(); return;}
                savingChangesRef.current = true; setSavingChanges(true);
                void applyChange(async () => {if (!await changes.save()) throw new Error("SAVE_FAILED");}).finally(() => {savingChangesRef.current = false; if (mounted.current) setSavingChanges(false);});
              }}>{savingChanges ? "Saving changes…" : correction.conflict ? "Review changes" : "Save changes"}</button>}
            </section>}
            {onFavorite && <button aria-pressed={photo.annotations?.favorite === true} onClick={() => void applyChange(() => onFavorite(photo, photo.annotations?.favorite !== true))}>{photo.annotations?.favorite ? "Unfavorite" : "Favorite"}</button>}
            <h3>Labels</h3>
            <div className="local-labels">{(photo.annotations?.labels ?? []).map((value, index) => onLabels ? <button key={index} aria-label={"Remove label " + value} onClick={() => void applyChange(() => onLabels(photo, photo.annotations!.labels!.filter((_, position) => position !== index)))}>{value} ×</button> : <span key={index}>{value}</span>)}</div>
            {onLabels && <form className="local-label-form" onSubmit={event => {
              event.preventDefault();
              const labels = photo.annotations?.labels ?? [];
              if (!label.trim() || labels.length >= 64) return;
              if (!labels.includes(label)) void applyChange(() => onLabels(photo, [...labels, label]));
              setLabel("");
            }}><label>New label<input aria-label="New label" value={label} maxLength={120} onChange={event => setLabel(event.target.value)} /></label><button disabled={!label.trim() || (photo.annotations?.labels?.length ?? 0) >= 64}>Add label</button></form>}
            {photo.annotations?.ocr && <details><summary>Text in photo</summary><p className="local-ocr-text">{photo.annotations.ocr.text || "No readable text found."}</p></details>}
          </>}
        </aside>
      )}
      <p role="status" className="viewer-status">
        {status || (!details && (correction.error || editError || (correction.pending ? "Changes on this device · open Info to Save changes" : "")))}
      </p>
    </div>
  );
}
