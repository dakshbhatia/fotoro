import type { EnteFile } from "ente-media/file";
import { describe, expect, test, vi } from "vitest";
import {
    searchFotoroFiles,
    trackCatalogRefresh,
    uploadOutcome,
    type CatalogRefreshPhase,
} from "../src/services/fotoro-library";

const photo = (id: number, title: string, data = {}) =>
    ({
        id,
        metadata: { title, creationTime: Date.UTC(2026, 8, 30) * 1000 },
        pubMagicMetadata: { data },
    }) as EnteFile;

describe("search within the visible account library", () => {
    test("keeps the supplied ordering and searches edited names and captions", () => {
        const files = [
            photo(2, "IMG_1.jpg", {
                editedName: "Beach.jpg",
                caption: "Family",
            }),
            photo(1, "Beach.jpg", { caption: "Friends" }),
        ];
        expect(searchFotoroFiles(files, "beach").map((f) => f.id)).toEqual([
            2, 1,
        ]);
        expect(
            searchFotoroFiles(files, "beach family").map((f) => f.id),
        ).toEqual([2]);
        expect(searchFotoroFiles(files, "IMG_1")).toEqual([]);
        expect(searchFotoroFiles(files, "   ")).toBe(files);
    });

    test("matches camera metadata and photo-local capture dates", () => {
        const files = [
            photo(1, "One.jpg", {
                cameraMake: "Canon",
                cameraModel: "R6",
                dateTime: "2026-10-01T01:30:00",
            }),
            photo(2, "Two.jpg"),
        ];
        expect(searchFotoroFiles(files, "CANON r6 2026-10-01")).toEqual([
            files[0],
        ]);
        expect(searchFotoroFiles(files, "2026-09-30")).toEqual([files[1]]);
    });

    test("normalizes accents without adding files outside the supplied view", () => {
        const visible = [photo(2, "Café.jpg")];
        expect(searchFotoroFiles(visible, "cafe")).toEqual(visible);
        expect(searchFotoroFiles(visible, "hidden")).toEqual([]);
    });
});

describe("catalog refresh truth", () => {
    test("does not claim current until the actual pull completes", async () => {
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const phases: CatalogRefreshPhase[] = [];
        const refreshing = trackCatalogRefresh(
            true,
            () => pending,
            (s) => phases.push(s),
        );
        expect(phases).toEqual(["syncing"]);
        finish();
        await expect(refreshing).resolves.toBe("current");
        expect(phases).toEqual(["syncing", "current"]);
    });

    test("preserves failure and allows an explicit retry to recover", async () => {
        const phases: CatalogRefreshPhase[] = [];
        const onPhase = (s: CatalogRefreshPhase) => phases.push(s);
        const pull = vi
            .fn()
            .mockRejectedValueOnce(new Error("Upload or sync failed"))
            .mockResolvedValueOnce(undefined);
        await expect(trackCatalogRefresh(true, pull, onPhase)).rejects.toThrow(
            "sync failed",
        );
        expect(phases).toEqual(["syncing", "error"]);
        await expect(trackCatalogRefresh(true, pull, onPhase)).resolves.toBe(
            "current",
        );
        expect(phases).toEqual(["syncing", "error", "syncing", "current"]);
    });

    test("offline browsing never attempts a remote pull or claims current", async () => {
        const pull = vi.fn();
        const phases: CatalogRefreshPhase[] = [];
        await expect(
            trackCatalogRefresh(false, pull, (s) => phases.push(s)),
        ).resolves.toBe("offline");
        expect(pull).not.toHaveBeenCalled();
        expect(phases).toEqual(["offline"]);
    });
});

test("a partial upload with rejected files needs attention even when catalog sync succeeds", () => {
    expect(
        uploadOutcome([
            { type: "uploaded", file: photo(1, "One.jpg") },
            { type: "blocked" },
        ]),
    ).toBe("error");
    expect(uploadOutcome([{ type: "unsupported" }])).toBe("error");
    expect(uploadOutcome([{ type: "failed" }])).toBe("error");
    expect(
        uploadOutcome([
            { type: "uploaded", file: photo(1, "One.jpg") },
            { type: "alreadyUploaded", file: photo(2, "Two.jpg") },
        ]),
    ).toBe("idle");
});

test("a corrupt legacy timestamp does not break search for the remaining photos", () => {
    const corrupt = photo(1, "Bad.jpg");
    corrupt.metadata.creationTime = 1e30;
    expect(
        searchFotoroFiles([corrupt, photo(2, "Good.jpg")], "good").map(
            (f) => f.id,
        ),
    ).toEqual([2]);
});
