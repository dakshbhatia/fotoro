import test from "node:test";
import assert from "node:assert/strict";
import {photoNavigationDestination as move, restorePhotoGridAnchor} from "../src/library/photo-navigation";
import {Virtualizer} from "@tanstack/react-virtual";
test("navigation crosses virtual rows and capture-day boundaries while respecting incomplete grid rows",()=>{
 const rows=[["a","b","c"],["d"],["e","f","g"],["h","i"]];
 assert.equal(move(rows,"c","ArrowDown"),"d");assert.equal(move(rows,"d","ArrowDown"),"e");
 assert.equal(move(rows,"f","ArrowUp"),"d");assert.equal(move(rows,"d","ArrowLeft"),"c");
 assert.equal(move(rows,"c","ArrowRight"),"d");assert.equal(move(rows,"c","PageDown",2),"g");
 assert.equal(move(rows,"i","PageUp",2),"d");assert.equal(move(rows,"c","End"),"i");assert.equal(move(rows,"h","Home"),"a");
});
test("table navigation follows its supplied sort order and clamps ends without changing selection",()=>{
 const rows=[["sorted-third"],["sorted-first"],["sorted-second"]], before=JSON.stringify(rows);
 assert.equal(move(rows,"sorted-third","ArrowDown"),"sorted-first");assert.equal(move(rows,"sorted-second","ArrowDown"),"sorted-second");
 assert.equal(move(rows,"sorted-third","PageDown",100),"sorted-second");assert.equal(move(rows,"sorted-third","ArrowUp"),"sorted-third");
 assert.equal(move(rows,"sorted-first"," "),undefined);assert.equal(move(rows,"removed","ArrowDown"),undefined);assert.equal(move([],"none","Home"),undefined);
 assert.equal(JSON.stringify(rows),before);
});

test("deep grid return after a hidden resize rebuilds offscreen heights before restoring its photo", () => {
 const rows = Array.from({length: 100}, (_, index) => ["photo-" + index]);
 let height = 300, scrolled = -1;
 const virtual = new Virtualizer<HTMLDivElement, Element>({count: rows.length, getScrollElement: () => null,
  getItemKey: index => rows[index][0], estimateSize: () => height,
  initialRect: {width: 600, height: 500}, observeElementRect: () => undefined, observeElementOffset: () => undefined,
  scrollToFn: offset => {scrolled = offset;}});
 virtual.scrollElement = {clientHeight: 500, get scrollHeight() {return virtual.getTotalSize();}} as HTMLDivElement;
 virtual.getTotalSize();
 for (let index = 0; index < rows.length; index++) virtual.resizeItem(index, height);
 const anchor = {id: "photo-70", offset: 15};
 restorePhotoGridAnchor(virtual, rows, anchor, false);
 assert.equal(scrolled, 21015);
 height = 200;
 virtual.setOptions({...virtual.options, estimateSize: () => height, useCachedMeasurements: true});
 virtual.getTotalSize();
 assert.equal(virtual.getOffsetForIndex(70, "start")?.[0], 21000, "Stable photo keys retain old offscreen measurements while hidden");
 virtual.setOptions({...virtual.options, useCachedMeasurements: false});
 restorePhotoGridAnchor(virtual, rows, anchor, true);
 assert.equal(scrolled, 14015, "Return restores the same photo using the current grid geometry");
 virtual.resizeItem(0, 244);
 virtual.getTotalSize();
 restorePhotoGridAnchor(virtual, rows, anchor, false);
 assert.equal(scrolled, 14059, "An ordinary viewer return retains valid measured heading heights");
});
