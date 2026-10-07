import test from "node:test";
import assert from "node:assert/strict";
import {factsWithPeople,validatedPeopleAssignments,peopleNames,PERSON_PREFIX,PEOPLE_SOURCE_PREFIX} from "@fotoro/contracts/people";
import {FACE_LANDMARKS,faceTransform,normalizedVector,decodeYuNet,quantizedBox} from "../src/people/geometry";
import {assignmentsForCorrection,groupPeopleFaces,peopleSourceCurrent,validatePeopleFace,type PeopleFace} from "../src/people/groups";
import type {LocalPhoto} from "../src/local/resources";
import {scanPeoplePhotos} from "../src/people/scan";
import {PeopleRuntimeUnavailable} from "../src/people/engine";
const digest="a".repeat(64),personId="11111111-1111-4111-8111-111111111111";
const assigned={personId,name:"Daksh",box:[1000,2000,3000,4000] as [number,number,number,number]};
const photo=(id="photo",facts?:string[]):LocalPhoto=>({id,digest,filename:id+".jpg",date:"2026-10-01",dateSource:"selected",facts});
const vector=normalizedVector(Float32Array.from({length:128},(_,i)=>i===0?1:0));
const face=(photoID:string,id:string,box=assigned.box):PeopleFace=>({id,photoID,digest,box,vector,score:.99});
test("People facts preserve supplied, location and cloud facts, bind names to original, and reject ambiguous or oversized wire data",()=> {
 const before=["User supplied fact","fotoro.location.v1:{}","fotoro.ai.v1:{}"],facts=factsWithPeople(before,digest,[assigned]);
 assert.deepEqual(facts.slice(0,3),before);assert.deepEqual(validatedPeopleAssignments(facts,digest),[assigned]);assert.deepEqual(peopleNames(facts,digest),["Daksh"]);
 assert.deepEqual(peopleNames(facts,"b".repeat(64)),[]);assert.deepEqual(peopleNames([...facts,PEOPLE_SOURCE_PREFIX+digest],digest),[]);
 assert.deepEqual(factsWithPeople(facts,digest,[]),before);
 assert.throws(()=>factsWithPeople(Array(64).fill("existing"),digest,[assigned]),/capacity/);
 assert.throws(()=>factsWithPeople(before,digest,[{...assigned,name:"😀".repeat(81)}]),/capacity/);
 const duplicate=PERSON_PREFIX+JSON.stringify({p:personId,n:"Daksh",b:assigned.box}).replace('"n":"Daksh"','"n":"Other","\\u006e":"Daksh"');
 assert.deepEqual(validatedPeopleAssignments([PEOPLE_SOURCE_PREFIX+digest,duplicate],digest),[]);
 assert.throws(()=>factsWithPeople(before,digest,[{...assigned,box:[9999,0,2,3]}]),/capacity/);
});
test("five-point SFace alignment recovers identity and a translated scaled face",()=> {
 const identity=faceTransform(FACE_LANDMARKS);assert.ok(Math.abs(identity.a-1)<1e-6);assert.ok(Math.abs(identity.b)<1e-6);
 const shifted=FACE_LANDMARKS.map(([x,y])=>[x*2+10,y*2+20] as const),transform=faceTransform(shifted);
 assert.ok(Math.abs(transform.a-.5)<1e-6);assert.ok(Math.abs(transform.x+5)<1e-6);assert.ok(Math.abs(transform.y+10)<1e-6);
 assert.throws(()=>faceTransform(Array(5).fill([1,1])),/landmarks/);
 assert.deepEqual(quantizedBox([20,10,30,40],100,100),[2000,1000,3000,4000]);
 assert.throws(()=>normalizedVector(new Float32Array(128)),/embedding/);
 assert.throws(()=>normalizedVector(Float32Array.from({length:128},()=>NaN)),/embedding/);
});
test("named people use exact assignments; similar unassigned faces stay unnamed and same-photo faces remain separate",()=> {
 const named=photo("named",factsWithPeople([],digest,[assigned])),unknown=photo("unknown"),same=photo("same");
 const groups=groupPeopleFaces([face("named","named-face"),face("unknown","unknown-face"),face("same","one"),face("same","two")],[named,unknown,same],(()=>{let n=0;return()=>String(n++);})());
 assert.equal(groups[0].name,"Daksh");assert.deepEqual(groups[0].faceIDs,["named-face"]);
 assert.ok(groups.slice(1).every(group=>group.name===undefined));assert.ok(groups.every(group=>!group.faceIDs.includes("one")||!group.faceIDs.includes("two")));
});
test("separating a reviewed face removes only its exact source assignment and source replacement cannot publish",()=> {
 const first=face("photo","one"),second=face("photo","two",[6000,2000,2000,4000]);
 const original=photo("photo",factsWithPeople(["preserved"],digest,[assigned,{...assigned,box:second.box}]));
 const previous={id:personId,name:"Daksh",faceIDs:["one","two"]};
 const updates=assignmentsForCorrection([original],[first,second],[previous],[{...previous,faceIDs:["one"]},{id:"new",faceIDs:["two"]}]);
 assert.deepEqual(updates[0].assignments,[assigned]);assert.equal(peopleSourceCurrent(original,{...original}),true);assert.equal(peopleSourceCurrent(original,{...original,digest:"b".repeat(64)}),false);
 assert.equal(peopleSourceCurrent(original,{...original,current:()=>false}),false);
 const stale={...original,current:()=>false};
 assert.equal(peopleSourceCurrent(stale,original),false);
 assert.equal(peopleSourceCurrent(stale,original,true),true);
 assert.equal(peopleSourceCurrent(stale,{...original,digest:"b".repeat(64)},true),false);
 const saved={...original,id:"saved:photo",previewLoader:async()=>new Blob(["preview"])};
 assert.equal(peopleSourceCurrent(saved,{...saved,previewLoader:async()=>new Blob(["new preview instance"])}),true);
 assert.throws(()=>validatePeopleFace({box:assigned.box,vector,score:2},original),/unavailable/);
});
test("YuNet malformed or nonfinite output fails rather than manufacturing face coverage",()=> {
 assert.throws(()=>decodeYuNet({}),/invalid/);
 const outputs:Record<string,Float32Array>={};for(const stride of [8,16,32]){const count=(640/stride)**2;outputs[`cls_${stride}`]=new Float32Array(count);outputs[`obj_${stride}`]=new Float32Array(count);outputs[`bbox_${stride}`]=new Float32Array(count*4);outputs[`kps_${stride}`]=new Float32Array(count*10);}
 assert.deepEqual(decodeYuNet(outputs),[]);outputs.cls_8[0]=NaN;assert.throws(()=>decodeYuNet(outputs),/invalid/);
});
test("a model or runtime failure stops a 500-photo batch after one attempt",async()=> {
 let previews=0,attempts=0;
 await assert.rejects(scanPeoplePhotos(Array.from({length:500},(_,i)=>photo(String(i))),new AbortController().signal,{
  current:()=>true,progress:()=>{},preview:async()=>{previews++;return new Blob();},
  analyze:async()=>{attempts++;throw new PeopleRuntimeUnavailable();},
 }),PeopleRuntimeUnavailable);
 assert.equal(previews,1);assert.equal(attempts,1);
});
test("an individual unreadable photo is skipped while valid faces retain the correct source",async()=> {
 let attempts=0;
 const result=await scanPeoplePhotos([photo("unreadable"),photo("valid")],new AbortController().signal,{
  current:()=>true,progress:()=>{},preview:async()=>new Blob(),
  analyze:async()=>{if(++attempts===1)throw new Error("Photo unavailable");return [{box:assigned.box,vector,score:.99}];},
 });
 assert.equal(result.skipped,1);assert.equal(result.faces.length,1);assert.equal(result.faces[0].photoID,"valid");
 assert.deepEqual([...result.sources.keys()],["valid"]);
});
test("cancelled or changed sources cannot publish face results",async()=> {
 const controller=new AbortController();let current=true;
 await assert.rejects(scanPeoplePhotos([photo()],controller.signal,{
  current:()=>true,progress:()=>{},preview:async()=>new Blob(),
  analyze:async()=>{controller.abort();return [{box:assigned.box,vector,score:.99}];},
 }),{name:"AbortError"});
 const result=await scanPeoplePhotos([photo()],new AbortController().signal,{
  current:()=>current,progress:()=>{},preview:async()=>new Blob(),
  analyze:async()=>{current=false;return [{box:assigned.box,vector,score:.99}];},
 });
 assert.deepEqual(result.faces,[]);assert.equal(result.sources.size,0);
});
