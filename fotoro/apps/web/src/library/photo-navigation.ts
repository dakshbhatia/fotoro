import {useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject} from "react";
import type {Virtualizer} from "@tanstack/react-virtual";

type GridMeasurements = Pick<Virtualizer<HTMLDivElement, Element>, "measure" | "getTotalSize" | "getOffsetForIndex" | "getVirtualItemForOffset" | "scrollToOffset">;
type GridAnchor = {id: string; offset: number};
export function restorePhotoGridAnchor(virtual: GridMeasurements,
  rows: readonly (readonly string[])[], anchor: GridAnchor | undefined, phase: "remeasure" | "resized" | "return") {
  if (phase === "remeasure") {
    virtual.measure();
    virtual.getTotalSize();
    // The spacer still has its previous DOM height until the next commit.
    return;
  }
  if (!anchor) return;
  const index = rows.findIndex(row => row.includes(anchor.id));
  const offset = index >= 0 ? virtual.getOffsetForIndex(index, "start") : undefined;
  if (offset) {
    const row = phase === "resized" ? virtual.getVirtualItemForOffset(offset[0]) : undefined;
    // A smaller row cannot retain an inset beyond its end. At the scroll
    // boundary, the aligned offset is already clamped before this row.
    const inset = phase === "resized" ? row?.index === index ? Math.max(0, Math.min(anchor.offset, row.size - 1)) : 0 : anchor.offset;
    virtual.scrollToOffset(offset[0] + inset);
  }
}

export function usePhotoGridAnchorRestoration(virtual: GridMeasurements, rows: readonly (readonly string[])[],
  anchor: RefObject<GridAnchor | undefined>, width: number, columns: number, active: boolean) {
  const geometry = useRef<{width: number; columns: number} | undefined>(undefined);
  const pending = useRef<{anchor: GridAnchor | undefined; commit: number} | undefined>(undefined);
  const [spacerCommit, setSpacerCommit] = useState(0);
  useLayoutEffect(() => {
    if (!active) return;
    if (geometry.current?.width !== width || geometry.current?.columns !== columns) {
      geometry.current = {width, columns};
      pending.current = {anchor: pending.current ? pending.current.anchor : anchor.current, commit: spacerCommit + 1};
      restorePhotoGridAnchor(virtual, rows, pending.current.anchor, "remeasure");
      setSpacerCommit(spacerCommit + 1);
      return;
    }
    if (pending.current && spacerCommit < pending.current.commit) return;
    restorePhotoGridAnchor(virtual, rows, pending.current ? pending.current.anchor : anchor.current, pending.current ? "resized" : "return");
    pending.current = undefined;
  }, [virtual, rows, anchor, width, columns, active, spacerCommit]);
}

export function photoNavigationDestination(rows: readonly (readonly string[])[], current: string, key: string, pageRows = 1) {
  const row = rows.findIndex(values => values.includes(current));if(row < 0)return;
  const column = rows[row].indexOf(current), ids = rows.flat(), index = ids.indexOf(current);
  if(key === "Home")return ids[0];if(key === "End")return ids.at(-1);
  if(key === "ArrowLeft" || key === "ArrowRight")return ids[Math.max(0, Math.min(ids.length-1,index+(key === "ArrowLeft" ? -1 : 1)))];
  const step = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : key === "PageUp" ? -Math.max(1,pageRows) : key === "PageDown" ? Math.max(1,pageRows) : undefined;
  if(step === undefined)return;
  const next = rows[Math.max(0,Math.min(rows.length-1,row+step))];return next[Math.min(column,next.length-1)];
}
export function usePhotoNavigation(parent: RefObject<HTMLDivElement | null>, rows: readonly (readonly string[])[],
  scrollToRow: (row: number) => void, pageRows: number, active = true) {
  const pending = useRef<string | undefined>(undefined), [, refresh] = useState(0);
  useLayoutEffect(() => {
    if(!active || !pending.current)return;
    const target = Array.from(parent.current?.querySelectorAll<HTMLButtonElement>("button[data-photo-navigation-id]") ?? [])
      .find(button => button.dataset.photoNavigationId === pending.current);
    if(target) {target.focus({preventScroll: true});pending.current = undefined;}
  });
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if(!active || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey)return;
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-photo-navigation-id]");
    if(!target || !parent.current?.contains(target))return;
    const id = photoNavigationDestination(rows,target.dataset.photoNavigationId!,event.key,pageRows);
    if(!id)return;
    event.preventDefault();pending.current = id;scrollToRow(rows.findIndex(values => values.includes(id)));refresh(value => value+1);
  };
}
