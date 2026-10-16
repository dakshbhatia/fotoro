import test from "node:test";
import assert from "node:assert/strict";
import {viewerGesture, viewerKeyboardAllowed} from "../src/library/viewer-gestures";

test("horizontal paging requires a deliberate dominant direction", () => {
  assert.equal(viewerGesture(-90, 12, false), "next");
  assert.equal(viewerGesture(90, 12, false), "previous");
  assert.equal(viewerGesture(75, 65, false), undefined);
  assert.equal(viewerGesture(18, 0, false), undefined);
});
test("vertical gestures dismiss down and reveal details up", () => {
  assert.equal(viewerGesture(10, 110, false), "dismiss");
  assert.equal(viewerGesture(10, -110, false), "details");
  assert.equal(viewerGesture(80, 100, false), undefined);
});
test("zoom reserves all directional gestures for image pan", () => {
  for (const [x, y] of [[-120, 0], [120, 0], [0, 130], [0, -130]]) assert.equal(viewerGesture(x, y, true), undefined);
});
test("keyboard paging respects editing, prevented events, modifiers and zoom", () => {
  const event = {defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false};
  assert.equal(viewerKeyboardAllowed(event, false, false), true);
  assert.equal(viewerKeyboardAllowed(event, true, false), false);
  assert.equal(viewerKeyboardAllowed(event, false, true), false);
  assert.equal(viewerKeyboardAllowed({...event, defaultPrevented: true}, false, false), false);
  assert.equal(viewerKeyboardAllowed({...event, metaKey: true}, false, false), false);
});

test("a horizontal gesture cannot switch axis and dismiss the photo", async () => {
  const {ViewerTouchSession} = await import("../src/library/viewer-gestures");
  const session = new ViewerTouchSession();
  session.start(0, 0, 7, "a"); session.move(35, 2);
  assert.equal(session.end(10, 150, 7, "a", false), undefined);
  session.start(0, 0, 7, "a"); session.move(2, 35);
  assert.equal(session.end(-150, 10, 7, "a", false), undefined);
});
test("touch completion rejects canceled, replaced and mismatched touches", async () => {
  const {ViewerTouchSession} = await import("../src/library/viewer-gestures");
  const session = new ViewerTouchSession();
  session.start(0, 0, 7, "a"); session.cancel();
  assert.equal(session.end(-150, 0, 7, "a", false), undefined);
  session.start(0, 0, 7, "a");
  assert.equal(session.end(-150, 0, 7, "b", false), undefined);
  session.start(0, 0, 7, "a");
  assert.equal(session.end(-150, 0, 8, "a", false), undefined);
  session.start(0, 0, 7, "a");
  assert.equal(session.end(-150, 0, 7, "a", true), undefined);
  assert.equal(session.end(-150, 0, 7, "a", false), undefined);
});
