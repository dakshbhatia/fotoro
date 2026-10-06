import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import frozenAnnotationSchema from "./fixtures/pre-location-annotations.schema.json";
import {validateWire} from "../packages/contracts/src/validate";
import {CLOUD_FACT_PREFIX, annotationObservation, observationSearchText, validPhotoObservation, withPhotoObservation, type PhotoObservationV1} from "../packages/contracts/src/intelligence";
import {withAnnotationLocation, annotationLocation} from "../packages/contracts/src/location";
const photoId = "a1672cf8-cc9b-44a5-9992-5508a40b36bc", sourceRevision = "A".repeat(43);
const binding = {photoId, sourceRevision};
const observation = (): PhotoObservationV1 => ({version:1, ...binding, processor:"gemini-3.8-flash", observedAt:"2026-10-06T12:00:00.000Z", observations:{objects:["dog"], scene:["beach"], visibleText:"WELCOME", uncertainty:["Could be a second animal"]}});
const annotation = () => ({version:1 as const, photoId, originalSha256:sourceRevision, caption:"My exact words.", labels:["My tag"], keywords:["My keyword"], ocr:{text:"My OCR",confidence:0.5,processor:"local"},facts:["My supplied fact",'fotoro.people.v1:{"name":"Friend"}']});

test("machine observations round trip through existing and frozen annotation wire without rewriting user, People or location data", () => {
  const location = {latitude:41.9,longitude:12.49,source:"exif" as const,name:"Rome"};
  const original = withAnnotationLocation(annotation(),location), value = withPhotoObservation(original,observation());
  assert.deepEqual(annotationObservation(value,binding),observation());
  assert.deepEqual(value.facts!.slice(0,original.facts.length),original.facts);
  assert.deepEqual(annotationLocation(value),location);
  assert.equal(value.caption,original.caption); assert.deepEqual(value.labels,original.labels); assert.deepEqual(value.ocr,original.ocr);
  assert.deepEqual(annotation(),{...original, facts:annotation().facts});
  assert.equal(validateWire("PhotoAnnotationsV1",value),value);
  const ajv = new Ajv(); addFormats(ajv); assert.equal(ajv.compile(frozenAnnotationSchema)(value),true);
  assert.deepEqual(withPhotoObservation(value,undefined),original);
});

test("all reserved facts remain at most240 Unicode codepoints with maximum identity and image text", () => {
  const maximum = {...observation(),photoId:"p".repeat(128),sourceRevision:"r".repeat(128),observations:{objects:new Array(12).fill("🐕".repeat(80)),scene:new Array(6).fill("🌊".repeat(80)),visibleText:"🦋".repeat(1200),uncertainty:new Array(4).fill("❓".repeat(160))}};
  assert.equal(validPhotoObservation(maximum),true);
  const value = withPhotoObservation({facts:["Personal fact"]},maximum);
  assert.ok(value.facts.every(fact => Array.from(fact).length <=240));
  assert.deepEqual(annotationObservation(value,{photoId:maximum.photoId,sourceRevision:maximum.sourceRevision}),maximum);
  const oldWire = {...annotation(),facts:value.facts};
  assert.equal(validateWire("PhotoAnnotationsV1",oldWire),oldWire);
});

test("source and photo fences reject replay and writer mismatches", () => {
  const value = withPhotoObservation(annotation(),observation());
  for (const mismatched of [{...binding,photoId:"another"},{...binding,sourceRevision:"other_digest"}]) assert.equal(annotationObservation(value,mismatched),undefined);
  assert.equal(annotationObservation({...value,photoId:"other"},binding),undefined);
  assert.equal(annotationObservation({...value,originalSha256:"other"},binding),undefined);
  assert.throws(() => withPhotoObservation({...annotation(),photoId:"other"},observation()),/binding mismatch/);
  assert.throws(() => withPhotoObservation({...annotation(),originalSha256:"other"},observation()),/binding mismatch/);
  // A facts-only container must retain both identities rather than borrow them from a caller.
  assert.equal(annotationObservation({facts:value.facts},{...binding,photoId:"another"}),undefined);
});

test("corrupt, duplicate, incomplete, reordered-index and unknown markers fail closed", () => {
  const value = withPhotoObservation(annotation(),observation()), facts = value.facts!;
  const header = facts.find(fact => fact.startsWith(CLOUD_FACT_PREFIX+"header:"))!;
  const object = facts.find(fact => fact.startsWith(CLOUD_FACT_PREFIX+"object:"))!;
  const photo = facts.find(fact => fact.startsWith(CLOUD_FACT_PREFIX+"photo:"))!;
  const invalid = [facts.filter(fact => fact !== header),[...facts,header],[...facts,object],[...facts,photo],
    facts.filter(fact => fact !== object), facts.map(fact => fact === object ? fact.replace("object:0:","object:1:") : fact),
    [...facts,CLOUD_FACT_PREFIX+"unknown:0:test"],facts.map(fact => fact === header ? CLOUD_FACT_PREFIX+"header:{" : fact),
    facts.map(fact => fact === header ? fact.replace('"o":1','"o":1,"\\u006f":2') : fact),
    facts.map(fact => fact === header ? fact.replace('"o":1','"o":1.5') : fact),
    facts.map(fact => fact === header ? fact.replace('"t":1','"t":7') : fact),
    facts.map(fact => fact === object ? CLOUD_FACT_PREFIX+"object:00:dog" : fact),
    facts.map(fact => fact === object ? CLOUD_FACT_PREFIX+"object:0:" : fact), facts.map(fact => fact.startsWith(CLOUD_FACT_PREFIX+"text:") ? CLOUD_FACT_PREFIX+"text:0:" : fact), [...facts, "x".repeat(241)]];
  for (const corrupted of invalid) assert.equal(annotationObservation({facts:corrupted},binding),undefined);
  assert.deepEqual(annotationObservation({facts:[...facts].reverse()},binding),observation());
});

test("malformed observations and capacity failures preserve the original container", () => {
  for (const invalid of [{...observation(),caption:"invented"},{...observation(),processor:"other"},{...observation(),observedAt:"today"},
    {...observation(),observations:{...observation().observations,objects:[" "]}},
    {...observation(),observations:{...observation().observations,caption:"invented"}},
    {...observation(),observations:{...observation().observations,visibleText:"bad\u0001text"}}]) assert.equal(validPhotoObservation(invalid),false);
  const original = {...annotation(),facts:new Array(63).fill("Keep my exact words")}, before = structuredClone(original);
  assert.throws(() => withPhotoObservation(original,observation()),/capacity/);
  assert.deepEqual(original,before);
});

test("replacing or deleting observation facts preserves supplied data and search excludes uncertainty and provenance", () => {
  const value = withPhotoObservation(annotation(),observation());
  const replacement = {...observation(),processor:"gemini-3.5-flash-lite" as const,observations:{objects:["cat"],scene:[],visibleText:"NEW",uncertainty:["Maybe London"]}};
  const next = withPhotoObservation(value,replacement);
  assert.deepEqual(annotationObservation(next,binding),replacement);
  assert.deepEqual(observationSearchText(next,binding),["cat","NEW"]);
  assert.deepEqual(observationSearchText(next,{...binding,sourceRevision:"other"}),[]);
  assert.equal(next.facts.filter(fact => fact.startsWith(CLOUD_FACT_PREFIX+"header:")).length,1);
  assert.deepEqual(withPhotoObservation(next,undefined),annotation());
});
