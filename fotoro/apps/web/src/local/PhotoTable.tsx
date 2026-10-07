import {useMemo, useRef, useState} from "react";
import {useVirtualizer} from "@tanstack/react-virtual";
import {type LocalPhoto, LocalResources} from "./resources";
import {photoCell, photoColumns, sortTablePhotos, type PhotoColumn, type PhotoSort} from "./photo-table";
import {useLocalThumbnail} from "./useLocalThumbnail";
import type {PickSelection} from "./LocalLibrary";
import {usePhotoNavigation} from "../library/photo-navigation";

function PhotoRow({photo, resources, columns, onOpen, onFailure, selection, index}: {
  photo: LocalPhoto; resources: LocalResources; columns: readonly PhotoColumn[];
  onOpen: (id: string) => void; onFailure: (id: string, message: string) => void;
  selection?: PickSelection; index: number;
}) {
  const {url, error} = useLocalThumbnail(photo, resources, onFailure);
  return <tr aria-rowindex={index + 2}>
    {selection?.editing && <td className="table-selection"><input type="checkbox" aria-label={"Select " + photo.filename} checked={selection.ids.has(photo.id)} disabled={selection.disabled} onChange={event => selection.onChange(photo.id, event.target.checked)} /></td>}
    {columns.map(column => <td key={column} className={"photo-column-" + column}>
      {column === "name" ? <button className="table-photo" aria-label={(selection?.editing ? "Select " : "Open ") + photo.filename}
        data-photo-navigation-id={photo.id}
        aria-pressed={selection?.editing ? selection.ids.has(photo.id) : undefined} disabled={selection?.editing && selection.disabled}
        onClick={() => selection?.editing ? selection.onChange(photo.id, !selection.ids.has(photo.id)) : onOpen(photo.id)}>
        <span className="table-thumbnail">{url ? <img src={url} alt="" /> : <span aria-label={error ? "Preview unavailable" : "Preparing photo"}>{error ? "—" : "…"}</span>}</span>
        <span>{photo.filename}</span>{!selection?.editing && selection?.ids.has(photo.id) ? <span aria-label="Selected">✓</span> : null}
      </button> : <span title={photoCell(photo, column)}>{photoCell(photo, column)}</span>}
    </td>)}
  </tr>;
}

export function PhotoTable({photos, resources, onOpen, onFailure, selection, columns, active = true}: {
  photos: LocalPhoto[]; resources: LocalResources; onOpen: (id: string) => void;
  onFailure: (id: string, message: string) => void; selection?: PickSelection;
  columns: readonly PhotoColumn[]; active?: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<PhotoSort>({column: "date", descending: true});
  const sorted = useMemo(() => sortTablePhotos(photos, sort), [photos, sort]);
  const virtual = useVirtualizer({count: sorted.length, getScrollElement: () => parent.current,
    getItemKey: index => sorted[index].id, estimateSize: () => 76, overscan: 4, scrollMargin: 44,
    useCachedMeasurements: !active});
  const visible = virtual.getVirtualItems(), cells = columns.length + (selection?.editing ? 1 : 0);
  const navigationRows = useMemo(() => sorted.map(photo => [photo.id]),[sorted]);
  const navigate = usePhotoNavigation(parent,navigationRows,index => virtual.scrollToIndex(index,{align: "auto"}),
    Math.max(1,Math.floor(((parent.current?.clientHeight ?? 120)-44)/76)),active);
  const reorder = (column: PhotoColumn) => {
    setSort(current => ({column, descending: current.column === column ? !current.descending : column === "date"}));
    virtual.scrollToOffset(0);
  };
  return <div ref={parent} className="canvas photo-table-scroll" role="region" aria-label="Photo table" tabIndex={0} onKeyDown={navigate}>
    <table className="photo-table" aria-label="Photos" aria-rowcount={photos.length + 1}>
      <thead><tr>{selection?.editing && <th scope="col"><span className="visually-hidden">Selection</span></th>}
        {columns.map(column => <th key={column} scope="col" aria-sort={sort.column === column ? sort.descending ? "descending" : "ascending" : "none"}>
          <button onClick={() => reorder(column)}>{photoColumns.find(value => value.id === column)!.label}<span aria-hidden="true">{sort.column === column ? sort.descending ? " ↓" : " ↑" : ""}</span></button>
        </th>)}
      </tr></thead>
      <tbody>
        {visible.length && visible[0].start > 44 ? <tr aria-hidden="true"><td colSpan={cells} style={{height: visible[0].start - 44, padding: 0, border: 0}} /></tr> : null}
        {visible.map(row => <PhotoRow key={row.key} index={row.index} photo={sorted[row.index]} resources={resources} columns={columns} onOpen={onOpen} onFailure={onFailure} selection={selection} />)}
        {visible.length ? <tr aria-hidden="true"><td colSpan={cells} style={{height: Math.max(0, virtual.getTotalSize() - (visible[visible.length - 1].end - 44)), padding: 0, border: 0}} /></tr> : null}
      </tbody>
    </table>
  </div>;
}
