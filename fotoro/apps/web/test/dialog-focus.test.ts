import test from "node:test";
import assert from "node:assert/strict";
import {dialogControls, trapDialogTab} from "../src/library/dialog-focus";

function control(name: string, options: {visible?: boolean; disabled?: boolean; tabIndex?: number; inert?: boolean} = {}) {
  let focused = false;
  return {
    name, get focused() {return focused;}, tabIndex: options.tabIndex ?? 0,
    matches: () => !!options.disabled,
    closest: () => options.inert ? {} : null,
    getClientRects: () => options.visible === false ? [] : [{}],
    focus: () => {focused = true;},
  } as unknown as HTMLElement & {focused: boolean};
}
function panelWith(controls: HTMLElement[]) {
  return Object.assign(control("panel", {tabIndex: -1}), {querySelectorAll: () => controls}) as unknown as HTMLElement;
}
function tab(shiftKey = false) {
  let prevented = false;
  return {event: {shiftKey, preventDefault: () => {prevented = true;}} as KeyboardEvent, get prevented() {return prevented;}};
}

test("dialog tab stops omit collapsed details, disabled and inert controls", () => {
  const close = control("close"), summary = control("summary"), collapsed = control("collapsed", {visible: false}),
    disabled = control("disabled", {disabled: true}), inert = control("inert", {inert: true}), excluded = control("excluded", {tabIndex: -1});
  assert.deepEqual(dialogControls(panelWith([close, summary, collapsed, disabled, inert, excluded])), [close, summary]);
});
test("Shift Tab from a newly opened panel wraps to the last visible control", () => {
  const close = control("close"), summary = control("summary"), collapsed = control("collapsed", {visible: false}), panel = panelWith([close, summary, collapsed]);
  const input = tab(true); trapDialogTab(input.event, panel, panel);
  assert.equal(input.prevented, true); assert.equal(summary.focused, true); assert.equal(collapsed.focused, false);
});
test("Tab after the last visible control wraps even when collapsed content follows it", () => {
  const close = control("close"), summary = control("summary"), panel = panelWith([close, summary, control("collapsed", {visible: false})]);
  const input = tab(); trapDialogTab(input.event, panel, summary);
  assert.equal(input.prevented, true); assert.equal(close.focused, true);
});
test("a control becoming disabled keeps the next Tab inside the dialog", () => {
  const close = control("close"), disabled = control("disabled", {disabled: true}), panel = panelWith([close, disabled]);
  const input = tab(); trapDialogTab(input.event, panel, disabled);
  assert.equal(input.prevented, true); assert.equal(close.focused, true);
});
test("normal interior Tab follows native ordering; an empty dialog retains panel focus", () => {
  const close = control("close"), next = control("next"), interior = tab();
  trapDialogTab(interior.event, panelWith([close, next]), close);
  assert.equal(interior.prevented, false);
  const panel = panelWith([]), empty = tab(); trapDialogTab(empty.event, panel, panel);
  assert.equal(empty.prevented, true); assert.equal((panel as HTMLElement & {focused: boolean}).focused, true);
});
