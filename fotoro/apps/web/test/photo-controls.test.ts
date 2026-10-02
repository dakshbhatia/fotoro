import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {PhotoPicks} from "../src/local/PhotoPicks";

const props={count:2,total:20,ready:2,busy:false,done:20,reviewing:false,onReview:()=>{}};
test("gallery selection status is compact, with one Edit action and no setup or bulk controls",()=>{
  const markup=renderToStaticMarkup(createElement(PhotoPicks,props));
  assert.match(markup,/2 selected/);assert.match(markup,/20 photos/);
  assert.match(markup,/aria-label="Edit selection"/);
  assert.equal((markup.match(/<button/g)??[]).length,1);
  assert.doesNotMatch(markup,/Suggested 10%|Select all|ready for Sync|All photos remain available/);
});
test("retained picks clearly require their original without claiming they are ready for Sync",()=>{
  const markup=renderToStaticMarkup(createElement(PhotoPicks,{...props,count:1,total:1,ready:0}));
  assert.match(markup,/Reopen 1 original to sync/);
  assert.doesNotMatch(markup,/ready for Sync/);
});
test("analysis and editing keep accurate accessible state in the compact status",()=>{
  const busy=renderToStaticMarkup(createElement(PhotoPicks,{...props,busy:true,done:8}));
  assert.match(busy,/Choosing photos… 8 of 20/);assert.match(busy,/role="status"/);
  const editing=renderToStaticMarkup(createElement(PhotoPicks,{...props,reviewing:true}));
  assert.match(editing,/aria-label="Done editing selection"/);assert.match(editing,/aria-pressed="true"/);
});
test("selected Save is explicit and unavailable until every selected original is present",()=>{
  const markup=renderToStaticMarkup(createElement(PhotoPicks,{...props,onSave:()=>{}}));
  assert.match(markup,/aria-label="Save 2 selected photos"/);
  assert.match(markup,/>Save 2<\/button>/);
  const missing=renderToStaticMarkup(createElement(PhotoPicks,{...props,ready:1,onSave:()=>{}}));
  assert.match(missing,/<button disabled="" aria-label="Save 2 selected photos"/);
});
