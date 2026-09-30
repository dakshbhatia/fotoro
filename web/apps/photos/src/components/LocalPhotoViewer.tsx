import type { PhotoDescription } from "@/services/photo-intelligence";
import styles from "@/styles/intelligence.module.css";
import type { ParsedMetadata } from "ente-media/file-metadata";
import type PhotoSwipe from "photoswipe";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PhotoSymbol } from "./PhotoSymbol";

export interface ViewerPhoto {
    id: string;
    name: string;
    original: File;
    derivative: Blob;
    preview: string;
    width: number;
    height: number;
    metadata: ParsedMetadata;
    description?: PhotoDescription;
    error?: string;
}

/** Uses Ente's existing PhotoSwipe dependency for touch, zoom and focus handling. */
export function LocalPhotoViewer({
    photos,
    initialID,
    onClose,
    onSearchTag,
    onError,
}: {
    photos: ViewerPhoto[];
    initialID: string;
    onClose: () => void;
    onSearchTag: (tag: string) => void;
    onError: (message: string) => void;
}) {
    // Freeze navigation order when opened; background indexing must not move us.
    const [items] = useState(() => photos);
    const [index, setIndex] = useState(() =>
        items.findIndex((p) => p.id === initialID),
    );
    const [root, setRoot] = useState<HTMLElement>();
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [shareError, setShareError] = useState("");
    const instance = useRef<PhotoSwipe | undefined>(undefined);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const errorRef = useRef(onError);
    errorRef.current = onError;
    const current =
        photos.find((p) => p.id === items[index]?.id) ?? items[index];

    useEffect(() => {
        let disposed = false;
        let background: HTMLElement | null = null;
        let wasInert = false;
        const restoreBackground = () => {
            if (background) background.inert = wasInert;
        };
        const urls = items.map((p) => URL.createObjectURL(p.original));
        const previews = items.map((p) => URL.createObjectURL(p.derivative));
        const origin = document.querySelector<HTMLElement>(
            `[data-photo-id="${initialID}"]`,
        );
        void import("photoswipe")
            .then(({ default: PhotoSwipe }) => {
                if (disposed) return;
                const pswp = new PhotoSwipe({
                    dataSource: items.map((p, i) => ({
                        src: urls[i],
                        // Avoid decoding every adjacent full-resolution original.
                        // PhotoSwipe updates sizes when zooming; the browser can
                        // then select the original from this responsive source.
                        srcset:
                            Math.max(p.width, p.height) > 1536
                                ? `${previews[i]} ${Math.round((p.width * 1536) / Math.max(p.width, p.height))}w, ${urls[i]} ${p.width}w`
                                : undefined,
                        msrc: previews[i],
                        width: p.width,
                        height: p.height,
                        alt: p.description?.summary ?? p.name,
                        element:
                            document.querySelector<HTMLElement>(
                                `[data-photo-id="${p.id}"]`,
                            ) ?? undefined,
                        thumbCropped: true,
                    })),
                    index: Math.max(
                        0,
                        items.findIndex((p) => p.id === initialID),
                    ),
                    mainClass: styles.viewer,
                    bgOpacity: 1,
                    showHideAnimationType: "zoom",
                    showAnimationDuration: 180,
                    hideAnimationDuration: 180,
                    zoomAnimationDuration: 180,
                    loop: false,
                    trapFocus: true,
                    returnFocus: true,
                    clickToCloseNonZoomable: false,
                    bgClickAction: "toggle-controls",
                    close: false,
                    zoom: false,
                    counter: false,
                    arrowPrev: false,
                    arrowNext: false,
                    errorMsg: "This photo could not be displayed.",
                });
                instance.current = pswp;
                pswp.on("afterInit", () => {
                    if (!pswp.element) return;
                    pswp.element.setAttribute("role", "dialog");
                    pswp.element.setAttribute("aria-modal", "true");
                    pswp.element.setAttribute("aria-label", "Photo viewer");
                    const controls = document.createElement("div");
                    controls.className = styles.viewerLayer ?? "";
                    pswp.element.appendChild(controls);
                    setRoot(controls);
                });
                pswp.on("bindEvents", () => {
                    // PhotoSwipe has moved focus into the viewer by this point.
                    background = document.querySelector("[data-photo-library]");
                    wasInert = background?.inert ?? false;
                    if (background) background.inert = true;
                });
                pswp.on("close", restoreBackground);
                pswp.on("change", () => {
                    setIndex(pswp.currIndex);
                    setDetailsOpen(false);
                    setShareError("");
                });
                pswp.on("destroy", () => {
                    restoreBackground();
                    if (!disposed) {
                        closeRef.current();
                        // Preserve the thumbnail origin even after a dev hot reload.
                        requestAnimationFrame(() => {
                            if (origin?.isConnected)
                                origin.focus({ preventScroll: true });
                        });
                    }
                });
                pswp.init();
            })
            .catch(() => {
                restoreBackground();
                if (!disposed) {
                    errorRef.current(
                        "The photo viewer could not be opened. Try again.",
                    );
                    closeRef.current();
                }
            });
        return () => {
            disposed = true;
            restoreBackground();
            instance.current?.destroy();
            for (const url of urls) URL.revokeObjectURL(url);
            for (const url of previews) URL.revokeObjectURL(url);
        };
    }, [items, initialID]);

    if (!root || !current) return null;
    const canShare =
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [current.original] });
    async function share() {
        if (!current || !canShare) return;
        try {
            await navigator.share({ files: [current.original] });
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") return;
            setShareError("This browser could not share the photo.");
        }
    }

    return createPortal(
        <>
            <div className={styles.viewerControls}>
                {canShare && (
                    <button
                        className={styles.share}
                        onClick={() => void share()}
                    >
                        <PhotoSymbol name="share" />
                        Share
                    </button>
                )}
                <button
                    className={styles.viewerClose}
                    aria-label="Close photo"
                    onClick={() => instance.current?.close()}
                >
                    <PhotoSymbol name="close" />
                </button>
            </div>
            {shareError && (
                <p role="alert" className={styles.shareError}>
                    {shareError}
                </p>
            )}
            {detailsOpen && (
                <section
                    id="photo-details"
                    className={styles.photoInfo}
                    aria-label="Photo details"
                >
                    <h2>{current.name}</h2>
                    {current.description && (
                        <p>{current.description.summary}</p>
                    )}
                    <span>
                        {[
                            current.metadata.creationDate?.dateTime.slice(
                                0,
                                10,
                            ),
                            current.metadata.cameraModel,
                            `${current.width} × ${current.height}`,
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    </span>
                    {current.description && (
                        <div className={styles.tags}>
                            {current.description.tags.map((tag) => (
                                <button
                                    key={tag}
                                    onClick={() => {
                                        onSearchTag(tag);
                                        instance.current?.close();
                                    }}
                                >
                                    {tag}
                                </button>
                            ))}
                        </div>
                    )}
                    {current.error && <p role="alert">{current.error}</p>}
                </section>
            )}
            <div className={styles.viewerBottom}>
                <button
                    className={styles.viewerArrow}
                    aria-label="Previous photo"
                    disabled={index === 0}
                    onClick={() => instance.current?.prev()}
                >
                    <PhotoSymbol name="previous" />
                </button>
                <button
                    className={styles.detailsButton}
                    aria-expanded={detailsOpen}
                    aria-controls="photo-details"
                    onClick={() => setDetailsOpen((open) => !open)}
                >
                    Details{" "}
                    <span
                        className={
                            detailsOpen ? styles.disclosureOpen : undefined
                        }
                    >
                        <PhotoSymbol name="up" />
                    </span>
                </button>
                <button
                    className={styles.viewerArrow}
                    aria-label="Next photo"
                    disabled={index === items.length - 1}
                    onClick={() => instance.current?.next()}
                >
                    <PhotoSymbol name="next" />
                </button>
            </div>
        </>,
        root,
    );
}
