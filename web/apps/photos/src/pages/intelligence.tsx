import {
    describePhoto,
    duplicateGroups,
    searchPhotos,
    type PhotoDescription,
} from "@/services/photo-intelligence";
import styles from "@/styles/intelligence.module.css";
import AddRounded from "@mui/icons-material/AddRounded";
import AutoAwesomeRounded from "@mui/icons-material/AutoAwesomeRounded";
import CloseRounded from "@mui/icons-material/CloseRounded";
import ContentCopyRounded from "@mui/icons-material/ContentCopyRounded";
import PhotoLibraryRounded from "@mui/icons-material/PhotoLibraryRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import TuneRounded from "@mui/icons-material/TuneRounded";
import { Dialog } from "@mui/material";
import type { ParsedMetadata } from "ente-media/file-metadata";
import { useEffect, useMemo, useRef, useState } from "react";

interface LocalPhoto {
    id: string;
    hash: string;
    name: string;
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
            extractExif(file).catch(() => ({}) as ParsedMetadata),
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
    const [busy, setBusy] = useState(false);
    const [adding, setAdding] = useState(false);
    const [completed, setCompleted] = useState(0);
    const [message, setMessage] = useState("");
    const [usage, setUsage] = useState({ input: 0, output: 0 });
    const photosRef = useRef(photos);
    photosRef.current = photos;
    const controller = useRef<AbortController | undefined>(undefined);
    const active = useRef(true);
    const importing = useRef(false);
    const cloudRef = useRef(allowCloud);
    cloudRef.current = allowCloud;
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
            controller.current?.abort();
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
    const indexed = photos.filter((p) => p.description).length;
    const estimatedSpend =
        (usage.input * 0.75 + usage.output * 3.75) / 1_000_000;

    async function addPhotos(files: FileList | null) {
        if (!files || importing.current || busy) return;
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

    async function analyze() {
        if (!allowCloud || !apiKey.trim() || busy) return;
        setBusy(true);
        setCompleted(0);
        setMessage("");
        controller.current = new AbortController();
        const signal = controller.current.signal;
        const descriptions = new Map(
            photos
                .filter((p) => p.description)
                .map((p) => [p.hash, p.description!]),
        );
        for (const photo of photos) {
            if (!active.current || signal.aborted || !cloudRef.current) break;
            try {
                if (photo.description) {
                    setCompleted((n) => n + 1);
                    continue;
                }
                let description = descriptions.get(photo.hash);
                if (!description) {
                    const result = await describePhoto({
                        jpeg: photo.jpeg,
                        apiKey,
                        allowCloud: cloudRef.current,
                        signal,
                    });
                    description = result.description;
                    if (!active.current || signal.aborted) break;
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
                if (signal.aborted || !active.current) break;
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
                setMessage(text);
                break;
            }
            setCompleted((n) => n + 1);
        }
        if (active.current) setBusy(false);
    }

    function clear() {
        controller.current?.abort();
        for (const photo of photos) URL.revokeObjectURL(photo.preview);
        setPhotos([]);
        setUsage({ input: 0, output: 0 });
        setQuery("");
        setMessage("");
        setSelectedID(undefined);
    }

    return (
        <main className={styles.app}>
            <header className={styles.header}>
                <div className={styles.heading}>
                    <h1>{view === "library" ? "Library" : "Duplicates"}</h1>
                    <span>
                        {photos.length
                            ? `${visible.length} ${visible.length === 1 ? "photo" : "photos"}`
                            : ""}
                    </span>
                </div>
                <label className={styles.search}>
                    <SearchRounded />
                    <input
                        aria-label="Search photos"
                        placeholder="Search your photos"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                        <button
                            type="button"
                            aria-label="Clear search"
                            onClick={() => setQuery("")}
                        >
                            <CloseRounded />
                        </button>
                    )}
                </label>
                <button
                    className={styles.add}
                    aria-label="Add photos"
                    title="Add photos"
                    disabled={busy || adding}
                    onClick={() => fileInput.current?.click()}
                >
                    <AddRounded />
                </button>
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
            </header>

            {message && (
                <div role="alert" className={styles.notice}>
                    {message}
                    <button
                        aria-label="Dismiss message"
                        onClick={() => setMessage("")}
                    >
                        <CloseRounded />
                    </button>
                </div>
            )}
            {busy && (
                <div role="status" className={styles.progress}>
                    <span>
                        Describing {Math.min(completed + 1, photos.length)} of{" "}
                        {photos.length}
                    </span>
                    <button
                        aria-label="Stop analysis"
                        onClick={() => controller.current?.abort()}
                    >
                        <CloseRounded />
                    </button>
                </div>
            )}
            {adding && (
                <div role="status" className={styles.progress}>
                    Adding photos…
                </div>
            )}

            {visible.length ? (
                <div className={styles.grid}>
                    {visible.map((photo) => (
                        <button
                            key={photo.id}
                            className={styles.photo}
                            aria-label={`Open photo ${photo.name}`}
                            onClick={() => setSelectedID(photo.id)}
                        >
                            <img
                                src={photo.preview}
                                alt={photo.description?.summary ?? photo.name}
                                loading="lazy"
                            />
                            {duplicateIDs.has(photo.id) && (
                                <span className={styles.duplicate}>
                                    <ContentCopyRounded />
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            ) : (
                <section className={styles.empty}>
                    <div className={styles.emptyIcon}>
                        <PhotoLibraryRounded />
                    </div>
                    <h2>
                        {query
                            ? "No photos found"
                            : view === "duplicates"
                              ? "No duplicates"
                              : "Your photos, together."}
                    </h2>
                    {!query && view === "library" && (
                        <button
                            className={styles.emptyAction}
                            disabled={busy || adding}
                            onClick={() => fileInput.current?.click()}
                        >
                            Add your first photos <AddRounded />
                        </button>
                    )}
                </section>
            )}

            <nav className={styles.dock} aria-label="Photo views">
                <button
                    className={view === "library" ? styles.active : ""}
                    onClick={() => setView("library")}
                    aria-pressed={view === "library"}
                >
                    <PhotoLibraryRounded />
                    <span>Library</span>
                </button>
                <button
                    className={view === "duplicates" ? styles.active : ""}
                    onClick={() => setView("duplicates")}
                    aria-pressed={view === "duplicates"}
                >
                    <ContentCopyRounded />
                    <span>Duplicates</span>
                </button>
                <div className={styles.divider} />
                <button
                    aria-label="Describe photos"
                    title="Describe photos"
                    disabled={
                        busy ||
                        adding ||
                        !photos.length ||
                        indexed === photos.length
                    }
                    onClick={() => {
                        if (!allowCloud || !apiKey.trim())
                            setSettingsOpen(true);
                        else void analyze();
                    }}
                >
                    <AutoAwesomeRounded />
                </button>
                <button
                    aria-label="Photo settings"
                    title="Photo settings"
                    onClick={() => setSettingsOpen(true)}
                >
                    <TuneRounded />
                </button>
            </nav>

            <Dialog
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                maxWidth="xs"
                fullWidth
                slotProps={{ paper: { className: styles.sheet } }}
            >
                <div className={styles.sheetHeader}>
                    <h2>Photo intelligence</h2>
                    <button
                        aria-label="Close settings"
                        onClick={() => setSettingsOpen(false)}
                    >
                        <CloseRounded />
                    </button>
                </div>
                <p className={styles.sheetCopy}>
                    Let Gemini describe your photos so they’re easier to find.
                </p>
                <label className={styles.toggle}>
                    <span>Use Gemini 3.8</span>
                    <input
                        type="checkbox"
                        checked={allowCloud}
                        onChange={(e) => {
                            setAllowCloud(e.target.checked);
                            if (!e.target.checked) {
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
                            placeholder="Your paid Gemini key"
                            autoComplete="off"
                            disabled={busy}
                        />
                    </label>
                )}
                <p className={styles.privacy}>
                    Only selected, resized previews go to Google when you press
                    Describe. EXIF is removed; visible faces and text remain.
                    Your key and this preview’s index clear on refresh.
                </p>
                <button
                    className={styles.primary}
                    disabled={allowCloud && !apiKey.trim()}
                    onClick={() => setSettingsOpen(false)}
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
                        Clear this session
                    </button>
                )}
                {!!usage.input && (
                    <p className={styles.privacy}>
                        Estimated API usage: ${estimatedSpend.toFixed(4)}.
                        Provider billing may include failed requests.
                    </p>
                )}
            </Dialog>

            <Dialog
                open={!!selected}
                onClose={() => setSelectedID(undefined)}
                maxWidth="md"
                fullWidth
                slotProps={{ paper: { className: styles.viewer } }}
            >
                {selected && (
                    <>
                        <button
                            className={styles.viewerClose}
                            aria-label="Close photo"
                            onClick={() => setSelectedID(undefined)}
                        >
                            <CloseRounded />
                        </button>
                        <img
                            className={styles.fullPhoto}
                            src={selected.preview}
                            alt={selected.description?.summary ?? selected.name}
                        />
                        <div className={styles.photoInfo}>
                            <h2>{selected.name}</h2>
                            {selected.description && (
                                <p>{selected.description.summary}</p>
                            )}
                            <span>
                                {[
                                    selected.metadata.creationDate?.dateTime.slice(
                                        0,
                                        10,
                                    ),
                                    selected.metadata.cameraModel,
                                    `${selected.width} × ${selected.height}`,
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </span>
                            {selected.description && (
                                <div className={styles.tags}>
                                    {selected.description.tags.map((tag) => (
                                        <button
                                            key={tag}
                                            onClick={() => {
                                                setQuery(tag);
                                                setView("library");
                                                setSelectedID(undefined);
                                            }}
                                        >
                                            {tag}
                                        </button>
                                    ))}
                                </div>
                            )}
                            {selected.error && (
                                <p role="alert">{selected.error}</p>
                            )}
                        </div>
                    </>
                )}
            </Dialog>
        </main>
    );
}
