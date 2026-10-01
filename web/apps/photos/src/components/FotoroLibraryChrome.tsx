import { PhotoSymbol } from "@/components/PhotoSymbol";
import type {
    CatalogRefreshPhase,
    UploadActivityPhase,
} from "@/services/fotoro-library";
import styles from "@/styles/intelligence.module.css";
import MenuIcon from "@mui/icons-material/Menu";
import Head from "next/head";
import { useEffect, useRef, useState } from "react";

export function FotoroLibraryChrome({
    query,
    onQuery,
    phase,
    offline,
    onRetry,
    onAccount,
    onUpload,
    uploadActivity,
    onReviewUpload,
}: {
    query: string;
    onQuery: (value: string) => void;
    phase: CatalogRefreshPhase;
    offline: boolean;
    onRetry: () => void;
    onAccount: () => void;
    onUpload: () => void;
    uploadActivity: UploadActivityPhase;
    onReviewUpload: () => void;
}) {
    const [searchOpen, setSearchOpen] = useState(false);
    const [keyboardInset, setKeyboardInset] = useState(0);
    const searchInput = useRef<HTMLInputElement>(null);
    const searchButton = useRef<HTMLButtonElement>(null);
    const cancelSearchButton = useRef<HTMLButtonElement>(null);
    const wasSearchOpen = useRef(false);

    useEffect(() => {
        if (searchOpen) searchInput.current?.focus();
        else if (wasSearchOpen.current) searchButton.current?.focus();
        wasSearchOpen.current = searchOpen;
    }, [searchOpen]);

    useEffect(() => {
        const viewport = window.visualViewport;
        if (!searchOpen || !viewport) {
            setKeyboardInset(0);
            return;
        }
        const update = () =>
            setKeyboardInset(
                viewport.scale === 1
                    ? Math.max(
                          0,
                          window.innerHeight -
                              viewport.height -
                              viewport.offsetTop,
                      )
                    : 0,
            );
        update();
        viewport.addEventListener("resize", update);
        viewport.addEventListener("scroll", update, { passive: true });
        return () => {
            viewport.removeEventListener("resize", update);
            viewport.removeEventListener("scroll", update);
        };
    }, [searchOpen]);

    const closeSearch = () => {
        onQuery("");
        setSearchOpen(false);
    };
    const status =
        uploadActivity === "error"
            ? "Upload needs attention"
            : uploadActivity === "uploading"
              ? "Uploading…"
              : offline
                ? "Offline · cached photos"
                : {
                      loading: "Opening your library…",
                      syncing: "Syncing…",
                      current: "Up to date",
                      offline: "Offline · cached photos",
                      error: "Couldn’t sync",
                  }[phase];
    const showStatus =
        uploadActivity !== "idle" || offline || phase !== "current";
    return (
        <>
            <Head>
                <title>Fotoro</title>
            </Head>
            <header className={`${styles.header} ${styles.libraryHeader}`}>
                <h1>Fotoro</h1>
                <div className={styles.accountControls}>
                    <span
                        role="status"
                        className={
                            showStatus ? styles.syncStatus : styles.srOnly
                        }
                    >
                        {status}
                    </span>
                    {uploadActivity === "error" && (
                        <button onClick={onReviewUpload}>Review</button>
                    )}
                    {uploadActivity === "idle" &&
                        phase === "error" &&
                        !offline && <button onClick={onRetry}>Retry</button>}
                    <button
                        aria-label="Account and albums"
                        onClick={onAccount}
                        className={styles.accountButton}
                    >
                        <MenuIcon />
                    </button>
                </div>
            </header>
            <div
                className={`${styles.libraryDock} ${searchOpen ? styles.searchDock : ""}`}
                style={{
                    bottom: `calc(max(24px, env(safe-area-inset-bottom)) + ${keyboardInset}px)`,
                }}
            >
                {searchOpen ? (
                    <form
                        role="search"
                        className={styles.searchSurface}
                        onSubmit={(event) => {
                            event.preventDefault();
                            cancelSearchButton.current?.focus();
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                closeSearch();
                            }
                        }}
                    >
                        <label className={styles.search}>
                            <PhotoSymbol name="search" />
                            <input
                                ref={searchInput}
                                type="search"
                                aria-label="Search photos"
                                placeholder="Search photos"
                                value={query}
                                onChange={(e) => onQuery(e.target.value)}
                            />
                        </label>
                        {query && (
                            <button
                                type="button"
                                aria-label="Clear search"
                                className={styles.clearSearch}
                                onClick={() => {
                                    onQuery("");
                                    searchInput.current?.focus();
                                }}
                            >
                                <PhotoSymbol name="close" />
                            </button>
                        )}
                        <button
                            ref={cancelSearchButton}
                            type="button"
                            aria-label="Cancel search"
                            className={styles.closeSearch}
                            onClick={closeSearch}
                        >
                            Cancel
                        </button>
                    </form>
                ) : (
                    <>
                        <button
                            ref={searchButton}
                            className={styles.searchLauncher}
                            onClick={() => setSearchOpen(true)}
                            aria-label="Search photos"
                        >
                            <PhotoSymbol name="search" />
                            <span>Search</span>
                        </button>
                        <button
                            aria-label="Add photos"
                            className={styles.dockAdd}
                            onClick={onUpload}
                        >
                            <PhotoSymbol name="add" />
                        </button>
                    </>
                )}
            </div>
        </>
    );
}
