import { LocalPhotoViewer } from "@/components/LocalPhotoViewer";
import { PhotoSymbol } from "@/components/PhotoSymbol";
import {
    describePhoto,
    duplicateGroups,
    searchPhotos,
    type PhotoDescription,
} from "@/services/photo-intelligence";
import styles from "@/styles/intelligence.module.css";
import CloseRounded from "@mui/icons-material/CloseRounded";
import ContentCopyRounded from "@mui/icons-material/ContentCopyRounded";
import { Dialog } from "@mui/material";
import type { ParsedMetadata } from "ente-media/file-metadata";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface LocalPhoto {
    id: string;
    hash: string;
    name: string;
    original: File;
    derivative: Blob;
    preview: string;
    jpeg: Uint8Array;
    width: number;
    height: number;
    bytes: number;
    metadata: ParsedMetadata;
    localText: string;
    description?: PhotoDescription;
    error?: string;
}

async function preparePhoto(file: File): Promise<LocalPhoto> {
    if (!/^image\/(jpeg|png|webp|avif|heic|heif)$/.test(file.type))
        throw new Error(
            "Choose JPEG, PNG, WebP, AVIF, or browser-supported HEIC photos",
        );
    if (file.size > 25 * 1024 * 1024)
        throw new Error(
            "Choose photos smaller than 25 MB for this development preview",
        );
    const buffer = await file.arrayBuffer();
    const [digest, metadata] = await Promise.all([
        crypto.subtle.digest("SHA-256", buffer),
        import("ente-gallery/services/exif").then(({ extractExif }) =>
            extractExif(file).catch((): ParsedMetadata => ({})),
        ),
    ]);
    const hash = Array.from(new Uint8Array(digest), (n) =>
        n.toString(16).padStart(2, "0"),
    ).join("");
    const localText = [
        metadata.creationDate?.dateTime,
        metadata.cameraMake,
        metadata.cameraModel,
        metadata.description,
    ]
        .filter(Boolean)
        .join(" ");
    const originalURL = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.src = originalURL;
        await image.decode();
        if (image.naturalWidth * image.naturalHeight > 60_000_000)
            throw new Error(
                "Choose a photo under 60 megapixels for this preview",
            );
        const canvas = document.createElement("canvas");
        const scale = Math.min(
            1,
            1536 / Math.max(image.naturalWidth, image.naturalHeight),
        );
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context)
            throw new Error("Image processing is unavailable in this browser");
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
                (b) =>
                    b
                        ? resolve(b)
                        : reject(new Error("Could not prepare photo")),
                "image/jpeg",
                0.85,
            ),
        );
        return {
            id: crypto.randomUUID(),
            hash,
            name: file.name,
            original: file,
            derivative: blob,
            preview: URL.createObjectURL(blob),
            jpeg: new Uint8Array(await blob.arrayBuffer()),
            width: image.naturalWidth,
            height: image.naturalHeight,
            bytes: file.size,
            metadata,
            localText,
        };
    } finally {
        URL.revokeObjectURL(originalURL);
    }
}

export default function IntelligencePage() {
    const [photos, setPhotos] = useState<LocalPhoto[]>([]);
    const [query, setQuery] = useState("");
    const [view, setView] = useState<"library" | "duplicates">("library");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selectedID, setSelectedID] = useState<string | undefined>();
    const selected = photos.find((photo) => photo.id === selectedID);
    const fileInput = useRef<HTMLInputElement>(null);
    const [apiKey, setAPIKey] = useState("");
    const [allowCloud, setAllowCloud] = useState(false);
    const [indexingEnabled, setIndexingEnabled] = useState(false);
    const [indexingPaused, setIndexingPaused] = useState(false);
    const [busy, setBusy] = useState(false);
    const [adding, setAdding] = useState(false);
    const [message, setMessage] = useState("");
    const [usage, setUsage] = useState({ input: 0, output: 0 });
    const photosRef = useRef(photos);
    photosRef.current = photos;
    const controller = useRef<AbortController | undefined>(undefined);
    const active = useRef(true);
    const importing = useRef(false);
    const indexing = useRef(false);
    const cloudRef = useRef(allowCloud);
    cloudRef.current = allowCloud;
    useEffect(() => {
        active.current = true;
        // Fast Refresh preserves state but runs the previous effect cleanup.
        // Recreate revoked URLs from retained blobs so the library still works.
        // Keep URL creation outside a state updater: React may replay updaters.
        const restored = photosRef.current.map((p) => {
            return { ...p, preview: URL.createObjectURL(p.derivative) };
        });
        if (restored.length) setPhotos(restored);
        if (new URLSearchParams(window.location.search).get("setup") === "1")
            setSettingsOpen(true);
        return () => {
            active.current = false;
            controller.current?.abort();
            for (const p of restored) URL.revokeObjectURL(p.preview);
            for (const p of photosRef.current) URL.revokeObjectURL(p.preview);
        };
    }, []);
    const groups = useMemo(() => duplicateGroups(photos), [photos]);
    const duplicateIDs = useMemo(
        () => new Set(groups.flatMap((g) => g.slice(1))),
        [groups],
    );
    const visible = useMemo(
        () =>
            searchPhotos(
                view === "duplicates"
                    ? photos.filter((p) => duplicateIDs.has(p.id))
                    : photos,
                query,
            ),
        [photos, query, view, duplicateIDs],
    );
    const estimatedSpend =
        (usage.input * 0.75 + usage.output * 3.75) / 1_000_000;

    async function addPhotos(files: FileList | null) {
        if (!files || importing.current) return;
        setMessage("");
        if (files.length + photos.length > 100) {
            setMessage("Use up to 100 photos in this development preview.");
            return;
        }
        importing.current = true;
        setAdding(true);
        for (const file of Array.from(files)) {
            try {
                const photo = await preparePhoto(file);
                if (!active.current) {
                    URL.revokeObjectURL(photo.preview);
                    break;
                }
                setPhotos((prev) => [...prev, photo]);
            } catch (error) {
                if (active.current)
                    setMessage(
                        error instanceof Error
                            ? error.message
                            : "Could not read photo",
                    );
            }
        }
        importing.current = false;
        if (active.current) setAdding(false);
    }

    const analyze = useCallback(async () => {
        if (
            !indexingEnabled ||
            !allowCloud ||
            !apiKey.trim() ||
            indexing.current
        )
            return;
        indexing.current = true;
        setBusy(true);
        setMessage("");
        controller.current = new AbortController();
        const signal = controller.current.signal;
        // Re-read mutable cancellation state after each asynchronous boundary.
        const shouldStop = () =>
            !active.current || signal.aborted || !cloudRef.current;
        const descriptions = new Map(
            photos
                .filter((p) => p.description)
                .map((p) => [p.hash, p.description!]),
        );
        for (const photo of photos) {
            if (shouldStop()) break;
            try {
                if (photo.description) continue;
                let description = descriptions.get(photo.hash);
                if (!description) {
                    const result = await describePhoto({
                        jpeg: photo.jpeg,
                        apiKey,
                        allowCloud: cloudRef.current,
                        signal,
                    });
                    description = result.description;
                    if (shouldStop()) break;
                    setUsage((u) => ({
                        input: u.input + result.usage.input,
                        output: u.output + result.usage.output,
                    }));
                    descriptions.set(photo.hash, description);
                }
                setPhotos((prev) =>
                    prev.map((p) =>
                        p.id === photo.id
                            ? { ...p, description, error: undefined }
                            : p,
                    ),
                );
            } catch (error) {
                if (shouldStop()) break;
                const text =
                    error instanceof Error
                        ? error.message
                        : "Photo analysis failed";
                setPhotos((prev) =>
                    prev.map((p) =>
                        p.id === photo.id ? { ...p, error: text } : p,
                    ),
                );
                // Stop on transport/key/rate failures rather than multiplying failed calls.
                setIndexingPaused(true);
                setMessage(text);
                break;
            }
        }
        indexing.current = false;
        if (active.current) setBusy(false);
    }, [indexingEnabled, allowCloud, apiKey, photos]);

    useEffect(() => {
        if (
            indexingEnabled &&
            !indexingPaused &&
            !adding &&
            !busy &&
            photos.some((p) => !p.description)
        )
            void analyze();
    }, [indexingEnabled, indexingPaused, adding, busy, photos, analyze]);

    function clear() {
        controller.current?.abort();
        for (const photo of photos) URL.revokeObjectURL(photo.preview);
        setPhotos([]);
        setUsage({ input: 0, output: 0 });
        setQuery("");
        setMessage("");
        setSelectedID(undefined);
        setIndexingPaused(false);
    }

    return (
        <main className={styles.app} data-photo-library>
            <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif"
                multiple
                hidden
                onChange={(e) => {
                    void addPhotos(e.target.files);
                    e.target.value = "";
                }}
            />

            <header className={styles.header}>
                <h1>{view === "duplicates" ? "Duplicates" : "Photos"}</h1>
                {view === "library" &&
                    !query &&
                    duplicateIDs.size > 0 &&
                    !adding && (
                        <button
                            className={styles.cleanup}
                            onClick={() => {
                                setView("duplicates");
                                setQuery("");
                            }}
                        >
                            {duplicateIDs.size} duplicate
                            {duplicateIDs.size === 1 ? "" : "s"} · Review
                        </button>
                    )}
            </header>

            {!!photos.length && (
                <div className={styles.toolbar}>
                    {view === "duplicates" ? (
                        <button
                            className={styles.back}
                            onClick={() => {
                                setView("library");
                                setQuery("");
                            }}
                        >
                            <PhotoSymbol name="previous" /> All photos
                        </button>
                    ) : (
                        <label className={styles.search}>
                            <PhotoSymbol name="search" />
                            <input
                                type="search"
                                aria-label="Search photos"
                                placeholder="Search photos"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                            {query && (
                                <button
                                    type="button"
                                    aria-label="Clear search"
                                    onClick={() => setQuery("")}
                                >
                                    <PhotoSymbol name="close" />
                                </button>
                            )}
                        </label>
                    )}
                    <button
                        className={styles.add}
                        aria-label="Add photos"
                        disabled={adding}
                        onClick={() => fileInput.current?.click()}
                    >
                        <PhotoSymbol name="add" />
                    </button>
                </div>
            )}

            {message && (
                <div role="alert" className={styles.notice}>
                    <span>{message}</span>
                    {indexingPaused && (
                        <button
                            onClick={() => {
                                setIndexingPaused(false);
                                setMessage("");
                            }}
                        >
                            Retry
                        </button>
                    )}
                    <button
                        aria-label="Dismiss message"
                        onClick={() => setMessage("")}
                    >
                        <CloseRounded />
                    </button>
                </div>
            )}
            {(busy || adding) && (
                <div role="status" className={styles.progress}>
                    <span>
                        {adding ? "Adding photos…" : "Improving search…"}
                    </span>
                    {busy && (
                        <button
                            onClick={() => {
                                setIndexingPaused(true);
                                controller.current?.abort();
                            }}
                        >
                            Pause
                        </button>
                    )}
                </div>
            )}

            {indexingEnabled &&
                indexingPaused &&
                !busy &&
                !message &&
                photos.some((p) => !p.description) && (
                    <div role="status" className={styles.progress}>
                        <span>Search improvements paused</span>
                        <button onClick={() => setIndexingPaused(false)}>
                            Resume
                        </button>
                    </div>
                )}

            {!photos.length ? (
                <section className={styles.empty}>
                    <button
                        className={styles.start}
                        disabled={adding}
                        onClick={() => fileInput.current?.click()}
                    >
                        Add photos
                    </button>
                    <p className={styles.emptyNotice}>
                        Local preview · not backed up
                    </p>
                </section>
            ) : (
                <>
                    {visible.length ? (
                        <div className={styles.grid}>
                            {visible.map((photo) => (
                                <button
                                    key={photo.id}
                                    data-photo-id={photo.id}
                                    className={styles.photo}
                                    aria-label={`Open photo ${photo.name}`}
                                    onClick={() => setSelectedID(photo.id)}
                                >
                                    <img
                                        src={photo.preview}
                                        alt={
                                            photo.description?.summary ??
                                            photo.name
                                        }
                                        loading="lazy"
                                    />
                                    {view === "library" &&
                                        duplicateIDs.has(photo.id) && (
                                            <span
                                                className={styles.duplicate}
                                                aria-label="Duplicate copy"
                                            >
                                                <ContentCopyRounded />
                                            </span>
                                        )}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <p className={styles.noResults}>No photos found.</p>
                    )}
                    <p className={styles.localNotice}>
                        Local preview · not backed up
                    </p>
                </>
            )}

            <Dialog
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                maxWidth="xs"
                fullWidth
                slotProps={{ paper: { className: styles.sheet } }}
                aria-labelledby="cloud-setup-title"
            >
                <div className={styles.sheetHeader}>
                    <h2 id="cloud-setup-title">Developer connection</h2>
                    <button
                        aria-label="Close setup"
                        onClick={() => setSettingsOpen(false)}
                    >
                        <CloseRounded />
                    </button>
                </div>
                <p className={styles.sheetCopy}>
                    Gemini 3.8 is the photo-indexing engine. Production
                    credentials belong on the server; this preview uses your own
                    paid key in memory.
                </p>
                <label className={styles.toggle}>
                    <span>Allow cloud indexing</span>
                    <input
                        type="checkbox"
                        checked={allowCloud}
                        onChange={(e) => {
                            setAllowCloud(e.target.checked);
                            if (!e.target.checked) {
                                setIndexingEnabled(false);
                                controller.current?.abort();
                                setAPIKey("");
                            }
                        }}
                    />
                </label>
                {allowCloud && (
                    <label className={styles.keyLabel}>
                        API key
                        <input
                            type="password"
                            value={apiKey}
                            onChange={(e) => setAPIKey(e.target.value)}
                            autoComplete="off"
                            disabled={busy}
                        />
                    </label>
                )}
                <p className={styles.privacy}>
                    When enabled, selected photos you add are indexed
                    automatically using resized previews sent to Google. EXIF is
                    removed; visible faces and text remain. Your key and index
                    clear on refresh.
                </p>
                <button
                    className={styles.primary}
                    disabled={allowCloud && !apiKey.trim()}
                    onClick={() => {
                        setIndexingEnabled(allowCloud && !!apiKey.trim());
                        setIndexingPaused(false);
                        setSettingsOpen(false);
                    }}
                >
                    Done
                </button>
                {photos.length > 0 && (
                    <button
                        className={styles.clear}
                        disabled={busy || adding}
                        onClick={() => {
                            clear();
                            setSettingsOpen(false);
                        }}
                    >
                        Clear this preview
                    </button>
                )}
                {!!usage.input && (
                    <p className={styles.privacy}>
                        Estimated API usage: ${estimatedSpend.toFixed(4)}.
                        Provider billing may include failed requests.
                    </p>
                )}
            </Dialog>

            {selected && (
                <LocalPhotoViewer
                    photos={visible}
                    initialID={selected.id}
                    onClose={() => setSelectedID(undefined)}
                    onSearchTag={(tag) => {
                        setQuery(tag);
                        setView("library");
                    }}
                    onError={setMessage}
                />
            )}
        </main>
    );
}
