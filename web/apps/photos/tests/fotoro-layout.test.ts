import { computeThumbnailGridLayoutParams } from "ente-new/photos/components/utils/thumbnail-grid-layout";
import { expect, test } from "vitest";

test("Fotoro fits three full thumbnails on a phone without overflow", () => {
    const p = computeThumbnailGridLayoutParams(390, "fotoro");
    expect(p.columns).toBe(3);
    expect(p.gap).toBe(3);
    expect(
        p.columns * p.itemWidth + (p.columns - 1) * p.gap + 2 * p.paddingInline,
    ).toBeCloseTo(390);
});

test("Fotoro expands on desktop while preserving square thumbnails", () => {
    const p = computeThumbnailGridLayoutParams(1280, "fotoro");
    expect(p.columns).toBe(6);
    expect(p.itemWidth).toBe(p.itemHeight);
    expect(p.itemWidth).toBeGreaterThanOrEqual(200);
});

test("an unmeasured Fotoro container does not produce negative image sizes", () => {
    expect(computeThumbnailGridLayoutParams(0, "fotoro").itemWidth).toBe(0);
});

test("the original Ente presentation retains its existing mobile layout", () => {
    const p = computeThumbnailGridLayoutParams(390);
    expect(p.columns).toBe(4);
    expect(p.gap).toBe(4);
});
