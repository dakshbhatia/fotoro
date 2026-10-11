import { useRef, useState, useEffect, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type Photo } from "./catalog";
import {requireVault} from "../vault/vault";
import {sameVault} from "../vault/scope";
import {leaseSavedRaster, savedRasterSource} from "./saved-raster";
import {usePhotoGridAnchorRestoration, usePhotoNavigation} from "./photo-navigation";
export function PhotoSelectionButton({filename, selected, disabled = false, onSelect}: {filename: string; selected: boolean; disabled?: boolean; onSelect: () => void}) {
  return <button className="select" aria-label={"Select " + filename} aria-pressed={selected} disabled={disabled}
    onClick={() => {if (!disabled) onSelect();}}>{selected ? "✓" : ""}</button>;
}
export function Thumbnail({
  photo,
  onOpen,
  selected,
  onSelect,
  selecting = false,
  selectionDisabled = false,
  reasons,
}: {
  photo: Photo;
  onOpen: () => void;
  selected: boolean;
  onSelect: () => void;
  selecting?: boolean;
  selectionDisabled?: boolean;
  reasons?: string[];
}) {
  const source = savedRasterSource(photo, "thumbnail");
  const [loaded, setLoaded] = useState<{source?: string; url: string}>({url: ""}),
    [returnVersion, setReturnVersion] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoaded({url: ""}); setError("");
    let session;
    try {session = requireVault();} catch {setError("Preview unavailable."); return;}
    const current = () => !controller.signal.aborted && sameVault(session);
    const clear = () => {controller.abort(); setLoaded({url: ""});};
    const returned = () => setReturnVersion(value => value + 1);
    window.addEventListener("fotoro-lock", clear); window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", returned);
    leaseSavedRaster(photo, "thumbnail", controller.signal, current)
      .then(url => {if (url && current()) setLoaded({source, url});})
      .catch(() => {if (current()) setError("Preview unavailable.");});
    return () => {
      controller.abort(); window.removeEventListener("fotoro-lock", clear); window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", returned);
    };
  }, [source, returnVersion]);
  return (
    <div className={"tile" + (selected ? " selected" : "")}>
      <button
        className="photo"
        id={"photo-" + photo.manifest.photoId}
        data-photo-navigation-id={photo.manifest.photoId}
        onClick={onOpen}
        disabled={selecting && selectionDisabled}
        aria-label={"Open " + photo.metadata.filename}
        aria-description={reasons?.join(". ")}
      >
        {loaded.source === source && loaded.url ? (
          <img src={loaded.url} alt="" onError={() => {setLoaded({url: ""}); setError("Preview unavailable.");}} />
        ) : (
          <span>{error || "Loading photo…"}</span>
        )}
        {reasons?.length ? <span className="find-photo-reason">{reasons.join(" · ")}</span> : null}
      </button>
      {(selecting || selected) && <PhotoSelectionButton filename={photo.metadata.filename} selected={selected} disabled={selectionDisabled} onSelect={onSelect} />}
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
  selectionDisabled = false,
  reasons,
}: {
  photos: Photo[];
  selected: Set<string>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  active?: boolean;
  selecting?: boolean;
  selectionDisabled?: boolean;
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
  const navigationRows = useMemo(() => rows.map(row => row.photos.map(photo => photo.manifest.photoId)),[rows]);
  const navigate = usePhotoNavigation(parent,navigationRows,index => virtual.scrollToIndex(index,{align: "auto"}),
    Math.max(1,Math.floor((parent.current?.clientHeight ?? width)/Math.max(1,width/columns))),active);
  usePhotoGridAnchorRestoration(virtual, navigationRows, anchor, width, columns, active);
  return (
    <div
      className="canvas"
      ref={parent}
      role="region"
      aria-label="Photo grid"
      tabIndex={0}
      onKeyDown={navigate}
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
                  selectionDisabled={selectionDisabled}
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
