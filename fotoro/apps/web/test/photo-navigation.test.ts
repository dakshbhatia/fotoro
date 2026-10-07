import test from "node:test";
import assert from "node:assert/strict";
import {photoNavigationDestination as move} from "../src/library/photo-navigation";
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
