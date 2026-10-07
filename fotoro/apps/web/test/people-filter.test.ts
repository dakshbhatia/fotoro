import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {factsWithPeople} from "@fotoro/contracts/people";
import {PeopleFilter} from "../src/people/PeopleFilter";
import {emptyPeopleFilter, reviewedPeople, peopleMatchingPhotoIDs, peopleFilteredResult, peopleResultSelection, peopleReviewPhotos} from "../src/people/filter";
import {PhotoSearchIndex, type SearchPhoto} from "../src/local/search";
import {addSemanticMatches} from "../src/local/semantic-find";
const digest = "a".repeat(64);
const people = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const photo = (id: string, persons: number[], year = 2020, name = "Paris"): SearchPhoto => ({id, digest, filename: id+".jpg", labels: [name], date: `${year}-05-01T12:00:00Z`, dateSource: "exif",
  facts: factsWithPeople([], digest, persons.map((person, index) => ({personId: people[person], name: ["Alex", "Bo", "Cam", "Dee"][person], box: [index*2000,0,1500,1500]})))});

test("Any selected people includes individual visits across trips; Everyone in a photo requires all reviewed people in one image", () => {
  const photos = [photo("trip-one", [0], 2020), photo("trip-two", [1], 2021), photo("trip-three", [2], 2022), photo("trip-four", [3], 2023), photo("together", [0,1,2,3], 2024), photo("unreviewed", [])];
  const ids = new Set(people);
  assert.deepEqual([...peopleMatchingPhotoIDs(photos,{ids,mode:"any"})], ["trip-one","trip-two","trip-three","trip-four","together"]);
  assert.deepEqual([...peopleMatchingPhotoIDs(photos,{ids,mode:"everyone"})], ["together"]);
  const query = new PhotoSearchIndex(photos).search("Paris in 2021", {allowedIds: peopleMatchingPhotoIDs(photos,{ids,mode:"any"})});
  assert.deepEqual(query.photoIds, ["trip-two"]);
});

test("reviewed identities stay separate for duplicate names and repeated faces count each photo once", () => {
  const duplicate = photo("two", [0,0,1]);
  duplicate.facts = factsWithPeople([],digest,[{personId:people[0],name:"Alex",box:[0,0,1000,1000]},{personId:people[0],name:"Alex",box:[2000,0,1000,1000]},{personId:people[1],name:"Alex",box:[4000,0,1000,1000]}]);
  const options = reviewedPeople([duplicate, duplicate, photo("one",[0])]);
  assert.equal(options.length,2); assert.deepEqual(options.map(person=>person.photoCount),[2,1]);
  assert.deepEqual([...peopleMatchingPhotoIDs([photo("alex-one",[0]),{...photo("alex-two",[1]),facts:factsWithPeople([],digest,[{personId:people[1],name:"Alex",box:[0,0,1000,1000]}])}],{ids:new Set([people[0]]),mode:"any"})],["alex-one"]);
  const markup = renderToStaticMarkup(createElement(PeopleFilter,{people:options,value:{ids:new Set([people[0]]),mode:"everyone"},onChange(){}}));
  assert.match(markup,/Alex · Group 1/); assert.match(markup,/Alex · Group 2/);
  assert.match(markup,/aria-label="Match selected people"/); assert.match(markup,/Any selected people/); assert.match(markup,/Everyone in a photo/);
});

test("unreviewed labels, stale source facts, malformed assignments and withdrawn accounts cannot supply People matches", () => {
  const stale = {...photo("stale",[0]),digest:"b".repeat(64)}, withdrawn = {...photo("withdrawn",[0]),current:()=>false};
  const malformed = {...photo("bad",[0]),facts:[...photo("bad",[0]).facts!,"fotoro:person:v1:{}"]};
  const mention = {...photo("mention",[]),labels:["Alex"],caption:"Alex visited Paris"};
  assert.deepEqual(reviewedPeople([stale,withdrawn,malformed,mention]),[]);
  assert.equal(peopleMatchingPhotoIDs([stale,withdrawn,malformed,mention],{ids:new Set([people[0]]),mode:"any"}).size,0);
  assert.deepEqual([...peopleMatchingPhotoIDs([stale,withdrawn,malformed,mention],emptyPeopleFilter())],["stale","bad","mention"]);
  assert.equal(peopleMatchingPhotoIDs([photo("valid",[0])],{ids:new Set([people[0],"missing"]),mode:"everyone"}).size,0);
  // Different partial reviews must not manufacture a group shot by joining facts.
  assert.equal(peopleMatchingPhotoIDs([photo("same-original",[0]),photo("same-original",[1])],{ids:new Set([people[0],people[1]]),mode:"everyone"}).size,0);
});

test("People filtering happens before lexical result caps and cannot be widened by visual results", () => {
  const photos = [...Array.from({length:250},(_,index)=>photo(`outside-${index}`,[],2026)),photo("family",[0],2020)];
  const permitted = peopleMatchingPhotoIDs(photos,{ids:new Set([people[0]]),mode:"any"});
  const index = new PhotoSearchIndex(photos);
  assert.equal(index.search("Paris").photoIds.includes("family"),false);
  const result = index.search("Paris",{allowedIds:permitted});
  assert.deepEqual(result.photoIds,["family"]);
  const visual = addSemanticMatches(result,new Map([["outside-1",1],["family",1]]),permitted);
  assert.deepEqual(visual.photoIds,["family"]);
  const stale = peopleFilteredResult({...result,photoIds:["outside-1"],photoId:"outside-1",meaning:{...result.meaning!,photoIds:["outside-1"]}},permitted);
  assert.deepEqual(stale.photoIds,[]); assert.equal(stale.photoId,undefined); assert.equal(stale.meaning,undefined);
});

test("filter edits leave existing picks alone; explicit selection replaces them with exact current local and Saved results", () => {
  const local = photo("local",[0]), saved = photo("saved:owned",[0]), old = photo("previous-hidden",[1]);
  const stale = {...photo("saved:stale",[0]),current:()=>false};
  const prior = new Set([old.id]), localIDs = new Set([local.id,old.id]);
  const matches = peopleMatchingPhotoIDs([local,saved,old,stale],{ids:new Set([people[0]]),mode:"any"});
  assert.deepEqual([...prior],[old.id]);
  const next = peopleResultSelection([local,saved,old,stale],[local,saved,saved,stale],localIDs);
  assert.deepEqual([...next.local],[local.id]); assert.deepEqual([...next.saved],["owned"]);
  assert.equal(next.local.has(old.id),false); assert.deepEqual([...prior],[old.id]);
  assert.equal(matches.size,next.local.size+next.saved.size);
});

test("same-ID source replacement, old result callbacks and withdrawn Saved access cannot select new or unavailable originals", () => {
  const old = photo("local",[0]), changed = {...old,digest:"b".repeat(64)}, saved = {...photo("saved:owned",[0]),current:()=>false};
  const result = peopleResultSelection([changed,saved],[old,saved],new Set([old.id]));
  assert.equal(result.local.size,0); assert.equal(result.saved.size,0);
  const cancelled = {...old,current:()=>false};
  assert.equal(peopleResultSelection([old],[cancelled],new Set([old.id])).local.size,0);
});

test("People review can assess an explicit selected subset without scanning the rest of a large library or withdrawn records", () => {
  const photos = Array.from({length:600},(_,index)=>photo(String(index),[]));
  const selected = new Set(["5","7","saved:locked","undigested"]);
  const sources = [...photos,{...photo("saved:locked",[]),current:()=>false},{...photo("undigested",[]),digest:undefined}];
  assert.equal(peopleReviewPhotos(sources).length,600);
  assert.deepEqual(peopleReviewPhotos(sources,true,selected).map(photo=>photo.id),["5","7"]);
  assert.deepEqual(peopleReviewPhotos(sources,true,new Set()),[]);
  assert.equal(selected.size,4);
});
