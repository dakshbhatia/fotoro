import {useVirtualizer} from "@tanstack/react-virtual";
import {useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {usePhotoNavigation} from "../library/photo-navigation";
import type {AlbumPhotoGroup} from "./browse";

export function albumGridRows(groups: readonly AlbumPhotoGroup[], columns: number) {
  const rows: AlbumPhotoGroup[][] = [];
  for (let index = 0; index < groups.length; index += Math.max(1, columns)) rows.push(groups.slice(index, index + Math.max(1, columns)));
  return rows;
}

// Share the sheet's scroll container; measured rows accommodate tags and open copies.
export function VirtualAlbumGrid({groups, resetKey, children}: {groups: readonly AlbumPhotoGroup[]; resetKey?: string; children: (group: AlbumPhotoGroup) => ReactNode}) {
  const element = useRef<HTMLDivElement>(null), scroll = useRef<HTMLElement | null>(null);
  const [layout, setLayout] = useState({width: 0, columns: 2, gap: 8, margin: 0, stickyHeight: 0});
  const anchor = useRef<{id: string; offset: number} | undefined>(undefined);
  const filter = useRef(resetKey);
  const resetting = useRef(false);
  const measureLayout = () => {
    const grid = element.current, parent = scroll.current;
    if (!grid || !parent) return;
    const width = grid.clientWidth;
    if (!width) return;
    const mobile = window.matchMedia("(max-width: 600px)").matches, gap = mobile ? 8 : 16;
    const columns = mobile ? 2 : Math.max(1, Math.floor((width + gap) / (220 + gap)));
    const margin = grid.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop - parent.clientTop;
    const toolbar = parent.querySelector<HTMLElement>(".album-toolbar");
    const stickyHeight = toolbar ? toolbar.offsetHeight + (Number.parseFloat(getComputedStyle(parent).paddingTop) || 0) : 0;
    setLayout(previous => previous.width === width && previous.columns === columns && previous.gap === gap
      && Math.abs(previous.margin - margin) < .5 && previous.stickyHeight === stickyHeight
      ? previous : {width, columns, gap, margin, stickyHeight});
  };
  useLayoutEffect(() => {
    scroll.current = element.current?.closest<HTMLElement>(".albums-content") ?? null;
    measureLayout();
  }, [groups, children]);
  useEffect(() => {
    const observer = new ResizeObserver(measureLayout);
    if (element.current) observer.observe(element.current);
    const parent = scroll.current;
    const toolbar = parent?.querySelector<HTMLElement>(".album-toolbar");
    if (toolbar) observer.observe(toolbar);
    // Native disclosure toggles can move the grid without a React update.
    parent?.addEventListener("toggle", measureLayout, true);
    window.addEventListener("resize", measureLayout);
    return () => {observer.disconnect(); parent?.removeEventListener("toggle", measureLayout, true); window.removeEventListener("resize", measureLayout);};
  }, []);
  const rows = useMemo(() => albumGridRows(groups, layout.columns), [groups, layout.columns]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => Math.max(0, (layout.width - (layout.columns - 1) * layout.gap) / layout.columns) + 80,
    getItemKey: index => rows[index][0].photo.manifest.photoId,
    scrollMargin: layout.margin,
    scrollPaddingStart: layout.stickyHeight,
    gap: layout.gap,
    overscan: 3,
  });
  if (filter.current !== resetKey) resetting.current = true;
  // New rows must not compensate the offset of the previous filter.
  virtual.shouldAdjustScrollPositionOnItemSizeChange = resetting.current ? () => false : undefined;
  useLayoutEffect(() => {
    if (filter.current === resetKey) return;
    filter.current = resetKey;
    anchor.current = undefined;
    if (rows.length) virtual.scrollToIndex(0, {align: "start"});
    else scroll.current?.scrollTo({top: 0});
    const frame = requestAnimationFrame(() => {
      if (rows.length) virtual.scrollToIndex(0, {align: "start"});
      resetting.current = false;
      virtual.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [resetKey, virtual]);
  useEffect(() => {
    const parent = scroll.current;
    const remember = () => {
      if (!parent) return;
      const visibleTop = parent.scrollTop + layout.stickyHeight;
      if (visibleTop < layout.margin) {anchor.current = undefined; return;}
      const row = virtual.getVirtualItems().find(value => value.end > visibleTop);
      if (row && rows[row.index]) anchor.current = {id: rows[row.index][0].photo.manifest.photoId, offset: visibleTop - row.start};
    };
    parent?.addEventListener("scroll", remember, {passive: true});
    return () => parent?.removeEventListener("scroll", remember);
  }, [rows, layout.margin, layout.stickyHeight, virtual]);
  useLayoutEffect(() => {
    if (!anchor.current || resetting.current) return;
    const index = rows.findIndex(row => row.some(group => group.photo.manifest.photoId === anchor.current!.id));
    const offset = index >= 0 ? virtual.getOffsetForIndex(index, "start") : undefined;
    if (offset) virtual.scrollToOffset(offset[0] + anchor.current.offset);
    else {anchor.current = undefined; virtual.scrollToOffset(Math.max(0, layout.margin - layout.stickyHeight));}
  }, [rows, layout.width, layout.margin, layout.stickyHeight, virtual]);
  const navigationRows = useMemo(() => rows.map(row => row.map(group => group.photo.manifest.photoId)), [rows]);
  const navigate = usePhotoNavigation(element, navigationRows, index => virtual.scrollToIndex(index, {align: "auto"}),
    Math.max(1, Math.floor(Math.max(1, (scroll.current?.clientHeight ?? 800) - layout.stickyHeight) / Math.max(1, layout.width / layout.columns + 80))));
  return <div ref={element} className="album-virtual-grid" role="region" aria-label="Trip photos" onKeyDown={navigate}
    style={{height: virtual.getTotalSize()}}>
    {virtual.getVirtualItems().map(row => <div key={row.key} className="album-grid album-virtual-row" data-index={row.index} ref={virtual.measureElement}
      style={{gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, gap: layout.gap, transform: `translateY(${row.start - layout.margin}px)`}}>
      {rows[row.index].map(group => children(group))}
    </div>)}
  </div>;
}
