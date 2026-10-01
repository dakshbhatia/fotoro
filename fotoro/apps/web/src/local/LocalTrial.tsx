import { useEffect, useRef, useState } from "react";
import { Icon } from "../library/icons";
import { LocalLibrary } from "./LocalLibrary";
import { LocalViewer } from "./LocalViewer";
import {
  inLast30Days,
  collectLocalFiles,
  type LocalPhoto,
  LocalResources,
} from "./resources";
export function LocalTrial({ onBackup }: { onBackup: () => void }) {
  const [photos, setPhotos] = useState<LocalPhoto[]>([]),
    [query, setQuery] = useState(""),
    [viewer, setViewer] = useState<string | null>(null),
    [settings, setSettings] = useState(false),
    [last30, setLast30] = useState(false),
    [status, setStatus] = useState(""),
    [progress, setProgress] = useState("");
  const input = useRef<HTMLInputElement>(null),
    settingsPanel = useRef<HTMLElement>(null),
    generation = useRef(0),
    importing = useRef<number | null>(null),
    resources = useRef(new LocalResources());
  const shown = photos.filter(
    (photo) =>
      (!last30 || inLast30Days(photo)) &&
      (
        photo.filename +
        " " +
        photo.date +
        " " +
        new Date(photo.date).toLocaleDateString()
      )
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  useEffect(() => () => resources.current.clear(), []);
  useEffect(() => {
    if (!settings) return;
    settingsPanel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettings(false);
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLButtonElement>('[aria-label="Settings"]')
            ?.focus(),
        );
      }
      if (event.key === "Tab") {
        const controls = Array.from(
          settingsPanel.current?.querySelectorAll<HTMLElement>(
            "button,input",
          ) ?? [],
        );
        if (
          event.shiftKey &&
          (document.activeElement === controls[0] ||
            document.activeElement === settingsPanel.current)
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
  }, [settings]);
  async function openFiles(files: File[]) {
    if (!files.length || importing.current !== null) return;
    const token = generation.current;
    importing.current = token;
    const current = () => generation.current === token;
    setStatus("");
    setProgress("Opening photos…");
    try {
      const result = await collectLocalFiles(
        files,
        current,
        (append) => {
          if (current())
            setPhotos((photos) =>
              current()
                ? [...photos, ...append].sort((a, b) =>
                    b.date.localeCompare(a.date),
                  )
                : photos,
            );
        },
        (completed) => {
          if (current())
            setProgress(
              completed < files.length
                ? `Opening ${completed} of ${files.length}…`
                : "",
            );
        },
      );
      if (current() && result.skipped)
        setStatus(
          `${result.skipped} ${result.skipped === 1 ? "file was" : "files were"} skipped. ${result.reason}`,
        );
    } finally {
      if (importing.current === token) importing.current = null;
      if (current()) setProgress("");
    }
  }
  const failure = (id: string, message: string) => {
    setPhotos((current) => current.filter((photo) => photo.id !== id));
    setStatus(message);
  };
  const clear = () => {
    generation.current++;
    importing.current = null;
    resources.current.clear();
    setPhotos([]);
    setViewer(null);
    setQuery("");
    setProgress("");
    setStatus("");
  };
  return (
    <>
      <main
        inert={viewer || settings ? true : undefined}
        className="local-trial"
      >
        <header>
          <h1>Fotoro</h1>
          <button
            className="menu-button glass"
            aria-label="Settings"
            onClick={() => setSettings(true)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
        </header>
        {!photos.length ? (
          <section className="local-empty">
            <button
              className="open-photos"
              disabled={!!progress}
              onClick={() => input.current?.click()}
            >
              Open photos
            </button>
            <p className="hint">Photos stay on this device.</p>
          </section>
        ) : shown.length ? (
          <LocalLibrary
            photos={shown}
            resources={resources.current}
            onOpen={setViewer}
            onFailure={failure}
          />
        ) : (
          <section className="empty">
            <p>No matching photos</p>
            <button
              onClick={() => {
                setQuery("");
                setLast30(false);
              }}
            >
              Show all photos
            </button>
          </section>
        )}
        {photos.length > 0 && (
          <div className="toolbar glass">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="10" cy="10" r="7" />
              <path d="m15 15 6 6" />
            </svg>
            <input
              aria-label="Search photos"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery("")}>
                <Icon kind="close" />
              </button>
            )}
            <button
              aria-label="Add photos"
              disabled={!!progress}
              onClick={() => input.current?.click()}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M12 3v18M3 12h18" />
              </svg>
            </button>
          </div>
        )}
        <input
          ref={input}
          hidden
          type="file"
          accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void openFiles(files);
          }}
        />
        {last30 && photos.length > 0 && (
          <button className="local-filter" onClick={() => setLast30(false)}>
            Last 30 days ×
          </button>
        )}
        {progress && (
          <p className="busy" role="status">
            {progress}
          </p>
        )}
        {status && (
          <div className="status" role="status">
            {status}
            <button aria-label="Dismiss message" onClick={() => setStatus("")}>
              <Icon kind="close" />
            </button>
          </div>
        )}
      </main>
      {settings && (
        <aside
          className="sheet local-settings"
          ref={settingsPanel}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
        >
          <button
            className="close"
            aria-label="Close settings"
            onClick={() => {
              setSettings(false);
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLButtonElement>('[aria-label="Settings"]')
                  ?.focus(),
              );
            }}
          >
            <Icon kind="close" />
          </button>
          <h2>Photos</h2>
          <label className="local-check">
            <input
              type="checkbox"
              checked={last30}
              onChange={(event) => setLast30(event.target.checked)}
            />
            Last 30 days
          </label>
          <p className="hint">
            Uses capture dates when available. Photos without a capture date
            stay visible. Your other selected photos are kept.
          </p>
          <button
            onClick={() => {
              setSettings(false);
              onBackup();
            }}
          >
            Backup & sharing
          </button>
          <p className="hint">
            Choose the files you want to open. This browser cannot scan your
            Photos library. Originals stay unchanged in this browser session;
            nothing is uploaded. Closing or reloading starts a new session.
          </p>
          {photos.length > 0 && (
            <button
              onClick={() => {
                clear();
                setSettings(false);
              }}
            >
              Clear this session
            </button>
          )}
        </aside>
      )}
      {viewer && shown.length > 0 && (
        <LocalViewer
          photos={shown}
          initial={viewer}
          resources={resources.current}
          onClose={() => {
            const id = viewer;
            setViewer(null);
            requestAnimationFrame(() =>
              document
                .getElementById("local-photo-" + id)
                ?.focus({ preventScroll: true }),
            );
          }}
        />
      )}
    </>
  );
}
