import { useEffect, useRef, useState } from "react";
import { Icon } from "../library/icons";
import { type LocalPhoto, LocalResources } from "./resources";
export function LocalViewer({
  photos,
  initial,
  resources,
  onClose,
}: {
  photos: LocalPhoto[];
  initial: string;
  resources: LocalResources;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(
      Math.max(
        0,
        photos.findIndex((p) => p.id === initial),
      ),
    ),
    [url, setUrl] = useState(""),
    [details, setDetails] = useState(false),
    [zoom, setZoom] = useState(false),
    [status, setStatus] = useState("");
  const panel = useRef<HTMLDivElement>(null),
    touch = useRef<{ x: number; y: number } | undefined>(undefined);
  const photo = photos[index];
  useEffect(() => {
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight")
        setIndex((i) => Math.min(photos.length - 1, i + 1));
      if (event.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (event.key === "Tab") {
        const controls = Array.from(
          panel.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        if (
          event.shiftKey &&
          (document.activeElement === controls[0] ||
            document.activeElement === panel.current)
        ) {
          event.preventDefault();
          controls.at(-1)?.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === controls.at(-1)
        ) {
          event.preventDefault();
          controls[0]?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    let alive = true;
    setUrl("");
    setZoom(false);
    setDetails(false);
    setStatus("");
    resources
      .load(photo, "preview")
      .then((value) => {
        if (alive) setUrl(value.url);
      })
      .catch((error) => {
        if (alive) setStatus(error.message);
      });
    return () => {
      alive = false;
    };
  }, [photo, resources]);
  const download = () => {
    const original = URL.createObjectURL(photo.file);
    const link = document.createElement("a");
    link.href = original;
    link.download = photo.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(original), 1000);
  };
  const canShare =
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [photo.file] });
  return (
    <div
      className="viewer"
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
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
        onDoubleClick={() => setZoom(!zoom)}
        onTouchStart={(event) => {
          touch.current =
            event.touches.length === 1
              ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
              : undefined;
        }}
        onTouchEnd={(event) => {
          if (touch.current && !zoom) {
            const dx = event.changedTouches[0].clientX - touch.current.x,
              dy = event.changedTouches[0].clientY - touch.current.y;
            if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5)
              setIndex((i) =>
                Math.max(0, Math.min(photos.length - 1, i + (dx < 0 ? 1 : -1))),
              );
          }
          touch.current = undefined;
        }}
      >
        {url && (
          <img
            className={zoom ? "zoomed" : ""}
            src={url}
            alt={photo.filename}
          />
        )}
      </div>
      <div className="viewer-bottom glass">
        <button
          aria-label="Previous photo"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          <Icon kind="previous" />
        </button>
        <button onClick={() => setZoom(!zoom)}>{zoom ? "Fit" : "Zoom"}</button>
        {canShare ? (
          <button
            onClick={async () => {
              try {
                await navigator.share({ files: [photo.file] });
              } catch (error) {
                if ((error as Error).name !== "AbortError")
                  setStatus(
                    "The photo could not be shared. Try downloading it instead.",
                  );
              }
            }}
          >
            Share
          </button>
        ) : (
          <button onClick={download}>Download</button>
        )}
        <button
          aria-label="Next photo"
          disabled={index === photos.length - 1}
          onClick={() => setIndex(index + 1)}
        >
          <Icon kind="next" />
        </button>
      </div>
      {details && (
        <aside className="details">
          <p>{photo.filename}</p>
          <p>
            {photo.width} × {photo.height} ·{" "}
            {(photo.file.size / 1024 / 1024).toFixed(1)} MB
          </p>
          <p>{new Date(photo.date).toLocaleString()}</p>
          <p>
            {photo.dateSource === "exif"
              ? "Date from the photo"
              : "Capture date unavailable · date selected"}
          </p>
          <p>Original file unchanged · this browser session only</p>
        </aside>
      )}
      {status && (
        <p className="viewer-status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
