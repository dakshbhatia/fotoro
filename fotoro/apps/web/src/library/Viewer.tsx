import { useState, useEffect, useRef } from "react";
import { photoBytes, type Photo } from "./catalog";
import { mediaURL } from "../vault/vault";
import { Icon } from "./icons";
import { saveReceivedPhoto } from "../exchange/Exchange";
export function Viewer({
  photos,
  initial,
  onClose,
  onSaved,
}: {
  photos: Photo[];
  initial: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [index, setIndex] = useState(
      Math.max(
        0,
        photos.findIndex((p) => p.manifest.photoId === initial),
      ),
    ),
    [url, setUrl] = useState(""),
    [zoom, setZoom] = useState(false),
    [details, setDetails] = useState(false),
    [status, setStatus] = useState("");
  const touch = useRef<{ x: number; y: number } | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);
  const photo = photos[index];
  useEffect(() => {
    panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight")
        setIndex((i) => Math.min(photos.length - 1, i + 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (e.key === "Tab") {
        const buttons = Array.from(
          panel.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        if (e.shiftKey && document.activeElement === buttons[0]) {
          e.preventDefault();
          buttons.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === buttons.at(-1)) {
          e.preventDefault();
          buttons[0]?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    let alive = true;
    setUrl("");
    setStatus("");
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
  }, [photo]);
  return (
    <div
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      tabIndex={-1}
      ref={panel}
    >
      <div className="viewer-top glass">
        <button onClick={onClose} aria-label="Close viewer">
          <Icon kind="close" />
        </button>
        <span>
          {index + 1} / {photos.length}
        </span>
        <button onClick={() => setDetails(!details)} aria-label="Photo details">
          <Icon kind="info" />
        </button>
      </div>
      <div
        className="view-image"
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
              setIndex((i) =>
                Math.max(0, Math.min(photos.length - 1, i + (dx < 0 ? 1 : -1))),
              );
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
      <div className="viewer-bottom glass">
        <button
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
          aria-label="Previous photo"
        >
          <Icon kind="previous" />
        </button>
        <button onClick={() => setZoom(!zoom)}>{zoom ? "Fit" : "Zoom"}</button>
        <button
          onClick={async () => {
            try {
              const bytes = await photoBytes(photo, "original");
              const url = mediaURL(
                photo.manifest.photoId + ":original",
                bytes,
                photo.metadata.mediaType,
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = photo.metadata.filename;
              a.click();
              setStatus("Original verified");
            } catch (e) {
              setStatus((e as Error).message);
            }
          }}
        >
          Download original
        </button>
        {photo.grantId && (
          <button
            onClick={async () => {
              try {
                setStatus("Verifying original…");
                await saveReceivedPhoto(photo.grantId!, photo.manifest.photoId);
                setStatus("Saved · original digest verified");
                onSaved();
              } catch (e) {
                setStatus((e as Error).message);
              }
            }}
          >
            Save to library
          </button>
        )}
        <button
          disabled={index === photos.length - 1}
          onClick={() => setIndex(index + 1)}
          aria-label="Next photo"
        >
          <Icon kind="next" />
        </button>
      </div>
      {details && (
        <aside className="details">
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
        </aside>
      )}
      <p role="status" className="viewer-status">
        {status}
      </p>
    </div>
  );
}
