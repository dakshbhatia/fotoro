import { PhotoSymbol } from "@/components/PhotoSymbol";
import type {
    CatalogRefreshPhase,
    UploadActivityPhase,
} from "@/services/fotoro-library";
import styles from "@/styles/intelligence.module.css";
import MenuIcon from "@mui/icons-material/Menu";
import Head from "next/head";

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
    return (
        <>
            <Head>
                <title>Fotoro</title>
            </Head>
            <header className={styles.header}>
                <h1>Fotoro</h1>
                <div className={styles.accountControls}>
                    <span role="status" className={styles.syncStatus}>
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
            <div className={styles.toolbar}>
                <label className={styles.search}>
                    <PhotoSymbol name="search" />
                    <input
                        type="search"
                        aria-label="Search photos"
                        placeholder="Search photos"
                        value={query}
                        onChange={(e) => onQuery(e.target.value)}
                    />
                </label>
                {query && (
                    <button
                        aria-label="Clear search"
                        className={styles.clearSearch}
                        onClick={() => onQuery("")}
                    >
                        <PhotoSymbol name="close" />
                    </button>
                )}
                <button
                    aria-label="Add photos"
                    className={styles.add}
                    onClick={onUpload}
                >
                    <PhotoSymbol name="add" />
                </button>
            </div>
        </>
    );
}
