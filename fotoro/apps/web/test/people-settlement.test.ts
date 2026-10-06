import test from 'node:test';
import assert from 'node:assert/strict';
import {factsWithPeople} from '@fotoro/contracts/people';
import {peopleEditsVisible} from '../src/people/settlement';
import type {Photo} from '../src/library/catalog';
import type {OwnedPhotoSnapshot} from '../src/library/consumer-search';
const digest = 'a'.repeat(64), token = {}, person = {personId:'11111111-1111-4111-8111-111111111111', name:'Maya', box:[0,0,1000,1000] as [number,number,number,number]};
const photo = {manifest:{ownerAccountId:'owner',photoId:'photo'},metadata:{originalSha256:digest},annotations:{facts:[]}} as unknown as Photo;
function snapshot(facts:string[], current=true, scope=token): OwnedPhotoSnapshot {
 return {accountId:'owner',token:scope,current:()=>current,preview:async()=>new Blob(),photos:[{...photo,annotations:{...photo.annotations!,facts}}]};
}
test('own People acknowledgement waits for projected edits while fencing vaults and originals',()=>{
 const updates=[{photo,assignments:[person]}];
 assert.equal(peopleEditsVisible(snapshot([]),token,updates),false);
 assert.equal(peopleEditsVisible(snapshot(factsWithPeople(['User fact'],digest,[person])),token,updates),true);
 assert.equal(peopleEditsVisible(snapshot(factsWithPeople([],digest,[person]),false),token,updates),false);
 assert.equal(peopleEditsVisible(snapshot(factsWithPeople([],digest,[person]),true,{}),token,updates),false);
 assert.equal(peopleEditsVisible(snapshot(factsWithPeople([],'b'.repeat(64),[person])),token,updates),false);
 const changed=snapshot(factsWithPeople([],digest,[person])); changed.photos[0].metadata={...changed.photos[0].metadata,originalSha256:'b'.repeat(64)};
 assert.equal(peopleEditsVisible(changed,token,updates),false);
});
test('People removal waits for reserved facts to disappear and order does not alter acknowledgement',()=>{
 assert.equal(peopleEditsVisible(snapshot(factsWithPeople([],digest,[person])),token,[{photo,assignments:[]}]),false);
 assert.equal(peopleEditsVisible(snapshot(['User fact']),token,[{photo,assignments:[]}]),true);
 assert.equal(peopleEditsVisible(snapshot(['fotoro:person:v1:invalid']),token,[{photo,assignments:[]}]),false);
 const second={...person,personId:'22222222-2222-4222-8222-222222222222',box:[1000,1000,1000,1000] as [number,number,number,number]};
 assert.equal(peopleEditsVisible(snapshot(factsWithPeople([],digest,[second,person])),token,[{photo,assignments:[person,second]}]),true);
});
