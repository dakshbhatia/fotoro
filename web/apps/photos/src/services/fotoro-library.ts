import type { UploadResult } from "ente-gallery/services/upload";
import type { EnteFile } from "ente-media/file";
import { fileCreationTime, fileFileName } from "ente-media/file-metadata";

export type CatalogRefreshPhase =
    | "loading"
    | "syncing"
    | "current"
    | "offline"
    | "error";

export type UploadActivityPhase = "idle" | "uploading" | "error";

/* Rejected files still need attention even if the catalog itself is current. */
export function uploadOutcome(results: UploadResult[]): "idle" | "error" {
    return results.some((result) => !("file" in result)) ? "error" : "idle";
}

const searchable = (text: string) =>
    text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

/* Search only the visibility-filtered, ordered view supplied by Ente's reducer. */
export function searchFotoroFiles(
    files: EnteFile[],
    query: string,
): EnteFile[] {
    const words = searchable(query).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return files;
    return files.filter((file) => {
        const data = file.pubMagicMetadata?.data;
        const time = fileCreationTime(file);
        const capturedAt = new Date(time / 1000);
        const date =
            data?.dateTime ??
            (Number.isFinite(capturedAt.getTime())
                ? capturedAt.toISOString().slice(0, 10)
                : "");
        const text = searchable(
            [
                fileFileName(file),
                data?.caption,
                data?.cameraMake,
                data?.cameraModel,
                date,
            ]
                .filter(Boolean)
                .join(" "),
        );
        return words.every((word) => text.includes(word));
    });
}

/* A pending/failed reconciliation must never look like a successful sync. */
export async function trackCatalogRefresh(
    online: boolean,
    pull: () => Promise<void>,
    onPhase: (phase: CatalogRefreshPhase) => void,
): Promise<"current" | "offline"> {
    if (!online) {
        onPhase("offline");
        return "offline";
    }
    onPhase("syncing");
    try {
        await pull();
        onPhase("current");
        return "current";
    } catch (error) {
        onPhase("error");
        throw error;
    }
}
