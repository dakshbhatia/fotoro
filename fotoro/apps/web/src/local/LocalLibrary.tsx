import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type LocalPhoto, LocalResources } from "./resources";
function Tile({
  photo,
  resources,
  onOpen,
  onFailure,
}: {
  photo: LocalPhoto;
  resources: LocalResources;
  onOpen: () => void;
  onFailure: (id: string, message: string) => void;
}) {
  const [url, setUrl] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setUrl(""); setError("");
    resources
      .load(photo, "thumbnail")
      .then((value) => {
        if (alive) setUrl(value.url);
      })
      .catch((error) => {
        if (alive) {setError(error.message); onFailure(photo.id, error.message);}
      });
    return () => {
      alive = false;
    };
  }, [photo.id, photo.file, photo.previewLoader, resources]);
  return (
    <div className="tile">
      <button
        className="photo"
        id={"local-photo-" + photo.id}
        aria-label={"Open " + photo.filename}
        onClick={onOpen}
      >
        {url ? (
          <img src={url} alt={photo.filename} />
        ) : error || (!photo.file && photo.previewAvailable === false) ? (
          <span className="unavailable-photo">Preview unavailable<br /><small>Open details</small></span>
        ) : (
          <span className="loading-photo" aria-label="Preparing photo" />
        )}
      </button>
    </div>
  );
}
export function LocalLibrary({
  photos,
  resources,
  onOpen,
  onFailure,
}: {
  photos: LocalPhoto[];
  resources: LocalResources;
  onOpen: (id: string) => void;
  onFailure: (id: string, message: string) => void;
}) {
  const parent = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(800),
    [columns, setColumns] = useState(3);
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setWidth(w);
      setColumns(w < 700 ? 3 : Math.max(3, Math.floor(w / 250)));
    });
    if (parent.current) observer.observe(parent.current);
    return () => observer.disconnect();
  }, []);
  const rows = useMemo(() => {
    const days = new Map<string, LocalPhoto[]>();
    for (const photo of photos) {
      const d = new Date(photo.date),
        day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const group = days.get(day);
      group ? group.push(photo) : days.set(day, [photo]);
    }
    const result: { key: string; photos: LocalPhoto[]; heading?: string }[] =
      [];
    for (const [day, group] of days) {
      for (let i = 0; i < group.length; i += columns) {
        const items = group.slice(i, i + columns);
        result.push({
          key: day + ":" + items[0].id,
          photos: items,
          heading:
            i === 0
              ? new Date(group[0].date).toLocaleDateString(undefined, {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })
              : undefined,
        });
      }
    }
    return result;
  }, [photos, columns]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    getItemKey: (index) => rows[index].key,
    estimateSize: (index) =>
      (width - (columns - 1) * 3) / columns +
      (rows[index].heading ? 44 : 0) +
      3,
    overscan: 3,
  });
  useLayoutEffect(() => {
    if (!anchor.current) return;
    const index = rows.findIndex((row) =>
      row.photos.some((photo) => photo.id === anchor.current!.id),
    );
    const offset =
      index >= 0 ? virtual.getOffsetForIndex(index, "start") : undefined;
    if (offset) virtual.scrollToOffset(offset[0] + anchor.current.offset);
  }, [rows, width, virtual]);
  return (
    <div
      className="canvas"
      ref={parent}
      onScroll={() => {
        const top = parent.current?.scrollTop ?? 0;
        const row = virtual
          .getVirtualItems()
          .find((item) => item.start + item.size > top);
        if (row)
          anchor.current = {
            id: rows[row.index].photos[0].id,
            offset: top - row.start,
          };
      }}
    >
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtual.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              display: "flow-root",
              paddingBottom: 3,
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
                <Tile
                  key={photo.id}
                  photo={photo}
                  resources={resources}
                  onOpen={() => onOpen(photo.id)}
                  onFailure={onFailure}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
