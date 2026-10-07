import {useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject} from "react";

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
