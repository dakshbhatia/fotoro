import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type LocalPhoto, LocalResources } from "./resources";
import {captureGroup} from "./capture-groups";
import {PhotoTable} from "./PhotoTable";
import {photoColumns, type PhotoColumn} from "./photo-table";
import {useLocalThumbnail} from "./useLocalThumbnail";
import {usePhotoNavigation} from "../library/photo-navigation";
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
export function LocalLibrary({
  ...props
}: Parameters<typeof LocalGrid>[0]) {
  const [view, setView] = useState<"grid" | "table">("grid");
  const [columns, setColumns] = useState<ReadonlySet<PhotoColumn>>(() => new Set(["name", "date", "type", "availability"]));
  const visibleColumns = photoColumns.filter(column => columns.has(column.id)).map(column => column.id);
  return <>
    <div className="photo-view-controls">
      <div role="group" aria-label="Photo view"><button aria-pressed={view === "grid"} onClick={() => setView("grid")}>Grid</button><button aria-pressed={view === "table"} onClick={() => setView("table")}>Table</button></div>
      {view === "table" && <details className="photo-column-options" onKeyDown={event => {
        if(event.key === "Escape") {event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();}
      }}><summary>Columns</summary><fieldset><legend className="visually-hidden">Visible columns</legend>
        {photoColumns.map(column => <label key={column.id}><input type="checkbox" checked={columns.has(column.id)} disabled={column.id === "name"} onChange={event => {
          const checked = event.target.checked; setColumns(current => {const next = new Set(current); checked ? next.add(column.id) : next.delete(column.id); return next;});
        }} />{column.label}</label>)}
      </fieldset></details>}
    </div>
    {view === "grid" ? <LocalGrid {...props} /> : <PhotoTable {...props} columns={visibleColumns} />}
  </>;
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
    if (!active || !anchor.current) return;
    const index = rows.findIndex((row) =>
      row.photos.some((photo) => photo.id === anchor.current!.id),
    );
    const offset =
      index >= 0 ? virtual.getOffsetForIndex(index, "start") : undefined;
    if (offset) virtual.scrollToOffset(offset[0] + anchor.current.offset);
  }, [rows, width, virtual, active]);
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
