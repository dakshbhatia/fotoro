import { useRef, useState, useEffect, useLayoutEffect, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { photoBytes, type Photo } from "./catalog";
import { mediaURL } from "../vault/vault";
export function Thumbnail({
  photo,
  onOpen,
  selected,
  onSelect,
  selecting = false,
  reasons,
}: {
  photo: Photo;
  onOpen: () => void;
  selected: boolean;
  onSelect: () => void;
  selecting?: boolean;
  reasons?: string[];
}) {
  const [loaded, setLoaded] = useState<{photo?: Photo; url: string}>({url: ""}),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setLoaded({url: ""}); setError("");
    photoBytes(photo, "thumbnail")
      .then((bytes) => {
        if (alive)
          setLoaded({photo, url: mediaURL(
              photo.manifest.ownerAccountId + ":" + photo.manifest.photoId + ":" + photo.metadata.originalSha256 + ":" + (photo.manifest.representations.find(value => value.binding.kind === "thumbnail")?.binding.representationId ?? "original") + ":thumbnail",
              bytes,
              "image/jpeg",
              256 * 256 * 4,
            )});
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [photo]);
  return (
    <div className={"tile" + (selected ? " selected" : "")}>
      <button
        className="photo"
        id={"photo-" + photo.manifest.photoId}
        onClick={onOpen}
        aria-label={"Open " + photo.metadata.filename}
        aria-description={reasons?.join(". ")}
      >
        {loaded.photo === photo && loaded.url ? (
          <img src={loaded.url} alt={photo.metadata.filename} />
        ) : (
          <span>{error || "Loading photo…"}</span>
        )}
        {reasons?.length ? <span className="find-photo-reason">{reasons.join(" · ")}</span> : null}
      </button>
      {(selecting || selected) && <button
        className="select"
        aria-label={"Select " + photo.metadata.filename}
        aria-pressed={selected}
        onClick={onSelect}
      >
        {selected ? "✓" : ""}
      </button>}
    </div>
  );
}
export function Library({
  photos,
  selected,
  onSelect,
  onOpen,
  active = true,
  selecting = false,
  reasons,
}: {
  photos: Photo[];
  selected: Set<string>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  active?: boolean;
  selecting?: boolean;
  reasons?: ReadonlyMap<string, string[]>;
}) {
  const parent = useRef<HTMLDivElement>(null),
    [columns, setColumns] = useState(2),
    [width, setWidth] = useState(800);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w <= 0) return;
      setWidth(w);
      setColumns(w < 700 ? 2 : Math.max(3, Math.floor(w / 250)));
    });
    if (parent.current) observer.observe(parent.current);
    return () => observer.disconnect();
  }, []);
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const rows = useMemo(() => {
    const days = new Map<string, Photo[]>();
    for (const photo of photos) {
      const date = new Date(photo.metadata.sourceDate);
      const day = `${photo.metadata.dateSource === "import" ? "import" : "capture"}:${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const group = days.get(day);
      if (group) group.push(photo);
      else days.set(day, [photo]);
    }
    const result: { key: string; photos: Photo[]; heading?: string }[] = [];
    for (const [day, group] of days) {
      for (let index = 0; index < group.length; index += columns) {
        const items = group.slice(index, index + columns);
        result.push({
          key: `${day}:${items[0].manifest.photoId}`,
          photos: items,
          heading:
            index === 0
              ? (group[0].metadata.dateSource === "import" ? "Imported " : "") + new Date(group[0].metadata.sourceDate).toLocaleDateString(
                  undefined,
                  { month: "long", day: "numeric", year: "numeric" },
                )
              : undefined,
        });
      }
    }
    return result;
  }, [photos, columns]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (index) =>
      (width - (columns - 1) * 3) / columns +
      (rows[index].heading ? (width < 700 ? 40 : 44) : 0) +
      3,
    overscan: 3,
    getItemKey: (index) => rows[index].key,
    useCachedMeasurements: !active,
  });
  useLayoutEffect(() => {
    if (active && anchor.current && parent.current) {
      const index = rows.findIndex((row) =>
        row.photos.some((photo) => photo.manifest.photoId === anchor.current!.id),
      );
      const offset =
        index >= 0 ? virtual.getOffsetForIndex(index, "start") : undefined;
      if (offset) virtual.scrollToOffset(offset[0] + anchor.current.offset);
    }
  }, [rows, width, virtual, active]);
  return (
    <div
      className="canvas"
      ref={parent}
      onScroll={() => {
        if (!active) return;
        const top = parent.current?.scrollTop ?? 0;
        const row = virtual
          .getVirtualItems()
          .find((r) => r.start + r.size > top);
        if (row && rows[row.index])
          anchor.current = {
            id: rows[row.index].photos[0].manifest.photoId,
            offset: top - row.start,
          };
      }}
    >
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="row"
            data-index={row.index}
            ref={virtual.measureElement}
            style={{
              display: "flow-root",
              paddingBottom: 3,
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${row.start}px)`,
            }}
          >
            {rows[row.index].heading && (
              <p className="date">{rows[row.index].heading}</p>
            )}
            <div
              className="grid"
              style={{
                gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`,
              }}
            >
              {rows[row.index].photos.map((photo) => (
                <Thumbnail
                  key={photo.manifest.photoId}
                  photo={photo}
                  selected={selected.has(photo.manifest.photoId)}
                  selecting={selecting}
                  reasons={reasons?.get(photo.manifest.photoId)}
                  onSelect={() => onSelect(photo.manifest.photoId)}
                  onOpen={() => onOpen(photo.manifest.photoId)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
