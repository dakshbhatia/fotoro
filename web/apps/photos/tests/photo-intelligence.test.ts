import { expect, test, vi } from "vitest";
import {
    describePhoto,
    duplicateGroups,
    parseDescription,
    searchPhotos,
} from "../src/services/photo-intelligence";

const description = {
    summary: "A red bicycle beside a lake",
    tags: ["bicycle", "lake", "outdoors"],
    visibleText: "",
    kind: "photo" as const,
};
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const response = () =>
    new Response(
        JSON.stringify({
            candidates: [
                {
                    finishReason: "STOP",
                    content: { parts: [{ text: JSON.stringify(description) }] },
                },
            ],
            usageMetadata: {
                promptTokenCount: 900,
                candidatesTokenCount: 100,
                thoughtsTokenCount: 40,
            },
        }),
        { status: 200 },
    );

test("local-only mode never sends an image, even when a key is present", async () => {
    const fetcher = vi.fn();
    await expect(
        describePhoto({ jpeg, apiKey: "test-key", allowCloud: false, fetcher }),
    ).rejects.toThrow("Enable cloud analysis");
    expect(fetcher).not.toHaveBeenCalled();
});

test("a missing key and an unsupported derivative fail before transmission", async () => {
    const fetcher = vi.fn();
    await expect(
        describePhoto({ jpeg, apiKey: "", allowCloud: true, fetcher }),
    ).rejects.toThrow("API key");
    await expect(
        describePhoto({
            jpeg: new Uint8Array([1, 2]),
            apiKey: "test",
            allowCloud: true,
            fetcher,
        }),
    ).rejects.toThrow("JPEG");
    expect(fetcher).not.toHaveBeenCalled();
});

test("3.8 receives only the JPEG derivative, uses low thinking, and returns measured usage", async () => {
    const fetcher = vi.fn(async () => response());
    const result = await describePhoto({
        jpeg,
        apiKey: "test-key",
        allowCloud: true,
        fetcher,
    });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [
        string,
        RequestInit,
    ];
    expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    expect(url).not.toContain("test-key");
    const request = JSON.parse(init.body as string);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(
        "test-key",
    );
    expect(request.contents[0].parts[1]).toEqual({
        inlineData: { mimeType: "image/jpeg", data: "/9j/2Q==" },
    });
    expect(request.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: "low",
    });
    expect(result.description).toEqual(description);
    expect(result.usage).toEqual({ input: 900, output: 140 });
});

test("provider errors never echo private provider response bodies", async () => {
    const fetcher = vi.fn(
        async () => new Response("PRIVATE PIXELS AND KEY", { status: 429 }),
    );
    await expect(
        describePhoto({ jpeg, apiKey: "test-key", allowCloud: true, fetcher }),
    ).rejects.toThrow("Gemini request failed (429)");
});

test("truncated or blocked results never become successful index records", async () => {
    const fetcher = vi.fn(
        async () =>
            new Response(
                JSON.stringify({
                    candidates: [
                        {
                            finishReason: "MAX_TOKENS",
                            content: {
                                parts: [{ text: JSON.stringify(description) }],
                            },
                        },
                    ],
                }),
            ),
    );
    await expect(
        describePhoto({ jpeg, apiKey: "test-key", allowCloud: true, fetcher }),
    ).rejects.toThrow("complete description");
});

test("invalid model data is rejected at the index boundary", () => {
    expect(() => parseDescription({ ...description, tags: [42] })).toThrow();
    expect(() =>
        parseDescription({ ...description, kind: "invented" }),
    ).toThrow();
    expect(() =>
        parseDescription({ ...description, summary: "x".repeat(601) }),
    ).toThrow();
    expect(() =>
        parseDescription({ ...description, extra: "not in schema" }),
    ).toThrow();
});

test("local search finds descriptions, visible text, and names without remote calls", () => {
    const records = [
        { id: "a", name: "IMG_1.jpg", description },
        {
            id: "b",
            name: "receipt.jpg",
            description: {
                summary: "A paper receipt",
                tags: ["receipt"],
                visibleText: "Coffee $4",
                kind: "document" as const,
            },
        },
    ];
    expect(
        searchPhotos(records, "a red bicycle by the lake").map((p) => p.id),
    ).toEqual(["a"]);
    expect(searchPhotos(records, "coffee").map((p) => p.id)).toEqual(["b"]);
    expect(searchPhotos(records, "receipt.jpg").map((p) => p.id)).toEqual([
        "b",
    ]);
    expect(searchPhotos(records, "snow")).toEqual([]);
    expect(searchPhotos(records, "")).toEqual(records);
});

test("exact duplicates group original hashes; similar descriptions do not count", () => {
    expect(
        duplicateGroups([
            { id: "a", hash: "same" },
            { id: "b", hash: "same" },
            { id: "c", hash: "different" },
            { id: "pending", hash: "" },
        ]),
    ).toEqual([["a", "b"]]);
});

test("EXIF-derived dates and camera names are searchable before cloud analysis", () => {
    const photos = [
        { id: "local", name: "IMG.jpg", localText: "2024-06-12 Canon EOS R6" },
    ];
    expect(searchPhotos(photos, "Canon 2024")).toEqual(photos);
});
