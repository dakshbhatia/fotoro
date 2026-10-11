import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type LocalPhoto, LocalResources } from "./resources";
import {captureGroup} from "./capture-groups";
import {PhotoTable} from "./PhotoTable";
import type {PhotoColumn} from "./photo-table";
import {useLocalThumbnail} from "./useLocalThumbnail";
import {restorePhotoGridAnchor, usePhotoNavigation} from "../library/photo-navigation";
export interface PickSelection {
  ids: ReadonlySet<string>;
  reasons?: ReadonlyMap<string, string[]>;
  disabled: boolean;
  editing: boolean;
  onChange: (id: string, checked: boolean) => void;
}
function Tile({
  photo,
  resources,
  onOpen,
  onFailure,
  selection,
}: {
  photo: LocalPhoto;
  resources: LocalResources;
  onOpen: () => void;
  onFailure: (id: string, message: string) => void;
  selection?: PickSelection;
}) {
  const {url, error} = useLocalThumbnail(photo, resources, onFailure);
  return (
    <div className="tile">
      <button
        className="photo"
        id={"local-photo-" + photo.id}
        data-photo-navigation-id={photo.id}
        aria-label={(selection?.editing ? "Select " : "Open ") + photo.filename}
        aria-pressed={selection?.editing ? selection.ids.has(photo.id) : undefined}
        disabled={selection?.editing && selection.disabled}
        onClick={() => selection?.editing ? selection.onChange(photo.id, !selection.ids.has(photo.id)) : onOpen()}
      >
        {url ? (
          <img src={url} alt={photo.filename} />
        ) : error || (!photo.file && photo.previewAvailable === false) ? (
          <span className="unavailable-photo">Preview unavailable<br /><small>Open details</small></span>
        ) : (
          <span className="loading-photo" aria-label="Preparing photo" />
        )}
      </button>
      {selection && (selection.editing || selection.ids.has(photo.id)) && <>
        <label className="photo-pick-toggle">
          <input type="checkbox" aria-label={"Select " + photo.filename} checked={selection.ids.has(photo.id)} disabled={selection.disabled}
            onChange={event => selection.onChange(photo.id, event.target.checked)} />
        </label>
      </>}
    </div>
  );
}
export function LocalLibrary({view, columns, ...props}: Parameters<typeof LocalGrid>[0] & {
  view: "grid" | "table"; columns: PhotoColumn[];
}) {
  return view === "grid" ? <LocalGrid {...props} /> : <PhotoTable {...props} columns={columns} />;
}

function LocalGrid({
  photos,
  resources,
  onOpen,
  onFailure,
  selection,
  resourceForPhoto,
  active = true,
}: {
  photos: LocalPhoto[];
  resources: LocalResources;
  onOpen: (id: string) => void;
  onFailure: (id: string, message: string) => void;
  selection?: PickSelection;
  resourceForPhoto?: (photo: LocalPhoto) => LocalResources;
  active?: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(800),
    [columns, setColumns] = useState(2);
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const measuredGeometry = useRef<{width: number; columns: number} | undefined>(undefined);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w <= 0) return;
      setWidth(w);
      setColumns(w < 700 ? 2 : Math.min(5, Math.max(4, Math.floor(w / 250))));
    });
    if (parent.current) observer.observe(parent.current);
    return () => observer.disconnect();
  }, []);
  const rows = useMemo(() => {
    const days = new Map<string, LocalPhoto[]>();
    for (const photo of photos) {
      const day = captureGroup(photo).key;
      const group = days.get(day);
      group ? group.push(photo) : days.set(day, [photo]);
    }
    const result: { key: string; photos: LocalPhoto[]; heading?: string; group?: LocalPhoto[] }[] =
      [];
    for (const [day, group] of days) {
      for (let i = 0; i < group.length; i += columns) {
        const items = group.slice(i, i + columns);
        result.push({
          key: day + ":" + items[0].id,
          photos: items,
          group: i === 0 ? group : undefined,
          heading:
            i === 0
              ? captureGroup(group[0]).heading
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
    useCachedMeasurements: !active,
  });
  const navigationRows = useMemo(() => rows.map(row => row.photos.map(photo => photo.id)),[rows]);
  const navigate = usePhotoNavigation(parent,navigationRows,index => virtual.scrollToIndex(index,{align: "auto"}),
    Math.max(1,Math.floor((parent.current?.clientHeight ?? width)/Math.max(1,width/columns))),active);
  useLayoutEffect(() => {
    if (!active) return;
    const changed = measuredGeometry.current?.width !== width || measuredGeometry.current?.columns !== columns;
    measuredGeometry.current = {width, columns};
    restorePhotoGridAnchor(virtual, navigationRows, anchor.current, changed);
  }, [navigationRows, width, columns, virtual, active]);
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
              <div className="photo-day-heading"><p className="date">{rows[row.index].heading}</p>
                {selection && <button disabled={selection.disabled} onClick={() => {
                  const group = rows[row.index].group!;
                  const checked = !group.every(photo => selection.ids.has(photo.id));
                  for (const photo of group) selection.onChange(photo.id, checked);
                }}>{rows[row.index].group!.every(photo => selection.ids.has(photo.id)) ? "Deselect" : "Select"}<span className="visually-hidden"> photos from {rows[row.index].heading}</span></button>}
              </div>
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
                  resources={resourceForPhoto?.(photo) ?? resources}
                  onOpen={() => onOpen(photo.id)}
                  onFailure={onFailure}
                  selection={selection}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
