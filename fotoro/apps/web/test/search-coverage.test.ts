import test from "node:test";
import assert from "node:assert/strict";
import {searchCoverage} from "../src/local/search-coverage";
import {OCR_PROCESSOR} from "../src/local/ocr";
import {VISUAL_PROCESSOR} from "@fotoro/contracts/visual";
import type {LocalPhoto} from "../src/local/resources";
const photo = (id: string): LocalPhoto => ({id, digest: id, filename: "photo.jpg", date: "2026-10-17", dateSource: "selected", preview: new Blob(["fixture"])});
const checked = (id: string, text = "") => ({...photo(id), ocr: {photoID: id, revision: id, processor: OCR_PROCESSOR, status: "complete" as const, text, confidence: .9}});

test("coverage distinguishes checked empty text, unchecked and failed or unavailable photos", () => {
  const failed = {...checked("failed"), ocr: {...checked("failed").ocr, status: "failed" as const}};
  assert.deepEqual(searchCoverage([checked("empty"), checked("text", "receipt"), photo("pending"), failed,
    {...photo("unavailable"), previewAvailable: false}]),
    {total: 5, textChecked: 2, textFound: 1, textUnchecked: 1, textUnavailable: 2, visualLabels: 0});
});

test("coverage rejects revoked sources, duplicate identities and stale OCR evidence", () => {
  const complete = checked("current", "receipt");
  assert.equal(searchCoverage([complete, complete, {...checked("revoked"), current: () => false}]).total, 1);
  for (const ocr of [{...complete.ocr, revision: "old"}, {...complete.ocr, processor: "old"}, {...complete.ocr, photoID: "other"}, {...complete.ocr, confidence: NaN}]) {
    assert.equal(searchCoverage([{...complete, ocr}]).textChecked, 0);
  }
});

test("only current validated visual labels count; empty results are not searchable coverage", () => {
  const valid = {...photo("visual"), visual: {photoID: "visual", revision: "visual", status: "complete" as const,
    processor: VISUAL_PROCESSOR, labels: [{identifier: "dog", label: "dog", confidence: .9}]}};
  assert.equal(searchCoverage([valid]).visualLabels, 1);
  for (const visual of [{...valid.visual, revision: "old"}, {...valid.visual, processor: "old"}, {...valid.visual, photoID: "other"}, {...valid.visual, labels: []}, {...valid.visual, labels: [{identifier: "dog", label: "dog", confidence: .1}]}]) {
    assert.equal(searchCoverage([{...valid, visual}]).visualLabels, 0);
  }
});

test("coverage remains truthful when an existing source loses permission", () => {
  let permitted = true;
  const source = {...checked("permission", "receipt"), current: () => permitted};
  assert.equal(searchCoverage([source]).textChecked, 1);
  permitted = false;
  assert.equal(searchCoverage([source]).total, 0);
});


test("supported Saved Vision text counts only while its source and revision remain current", () => {
  const source = {...checked("saved:vision", "receipt"), current: () => true};
  const vision = {...source, ocr: {...source.ocr, processor: "vision-text-v1"}};
  assert.equal(searchCoverage([vision]).textFound, 1);
  assert.equal(searchCoverage([{...vision, ocr: {...vision.ocr, text: ""}}]).textChecked, 1);
  for (const stale of [{...vision, current: () => false}, {...vision, digest: "replacement"},
    {...vision, ocr: {...vision.ocr, photoID: "saved:other"}},
    {...vision, ocr: {...vision.ocr, confidence: NaN}},
    {...vision, ocr: {...vision.ocr, processor: "unsupported"}},
    {...vision, id: "local", digest: "local", ocr: {...vision.ocr, photoID: "local", revision: "local"}}]) {
    assert.equal(searchCoverage([stale]).textChecked, 0);
  }
});
