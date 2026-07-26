/**
 * Modal dismissal and text entry, against a real blessed screen.
 *
 * The amount prompt could not be used: clicking into the field dismissed it,
 * and it accepted no keystrokes. One cause for both — blessed's textarea binds
 * `on('blur', __done)`, where `__done` is `_done(null, null)`, which emits
 * "cancel"; and blessed's own click-to-focus emits a blur on the element that
 * already had focus. So a click cancelled the read, which both closed the modal
 * and tore down the keypress listener.
 *
 * Driven through real events on a real screen rather than stubs, because every
 * part of this bug lived in blessed's event wiring rather than in our code.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import blessed from "blessed";
import { createBlessedInputProvider } from "../../../src/tui/input-provider";
import { createModal } from "../../../src/tui/widgets/modal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let screen: any;

const makeScreen = () => {
  const output = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  return blessed.screen({
    output,
    input: new Readable({ read() {} }),
    term: "xterm",
    smartCSR: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
};

/** Everything blessed has drawn, with SGR colour stripped. */
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const visible = (s: any): string => String(s.screenshot()).replace(SGR, "");

beforeEach(() => {
  screen = makeScreen();
});

afterEach(() => {
  screen.destroy();
});

// --- the input bug ---------------------------------------------------------

test("a blur does not dismiss the amount prompt", async () => {
  const provider = createBlessedInputProvider(blessed, screen);
  let settled = false;
  const answer = provider.input("Amount of ETH").then((v) => {
    settled = true;
    return v;
  });
  await new Promise((r) => setImmediate(r));

  // Exactly what blessed's click-to-focus does to an already-focused element.
  screen.focused.emit("blur");
  await new Promise((r) => setImmediate(r));

  assert.equal(settled, false, "the prompt closed on a blur");
  screen.focused.emit("submit");
  await answer;
});

test("the field still takes keystrokes after a blur", async () => {
  const provider = createBlessedInputProvider(blessed, screen);
  const answer = provider.input("Amount of ETH");
  await new Promise((r) => setImmediate(r));

  const input = screen.focused;
  input.emit("blur");
  await new Promise((r) => setImmediate(r));

  // _reading is what drives blessed's keypress listener. If a blur cancelled
  // the read, this is false and nothing typed would ever register.
  assert.equal(input._reading, true, "the read was torn down by a blur");

  input.setValue("1.5");
  input.emit("submit");
  assert.equal(await answer, "1.5");
});

test("Enter submits what was typed", async () => {
  const provider = createBlessedInputProvider(blessed, screen);
  const answer = provider.input("Amount of ETH");
  await new Promise((r) => setImmediate(r));
  screen.focused.setValue("0.25");
  screen.focused.emit("submit");
  assert.equal(await answer, "0.25");
});

test("Esc still cancels", async () => {
  const provider = createBlessedInputProvider(blessed, screen);
  const answer = provider.input("Amount of ETH");
  await new Promise((r) => setImmediate(r));
  screen.focused.emit("cancel");
  assert.equal(await answer, undefined);
});

test("closing releases grabKeys so the deck keys work again", async () => {
  const provider = createBlessedInputProvider(blessed, screen);
  const answer = provider.input("Amount of ETH");
  await new Promise((r) => setImmediate(r));
  assert.equal(screen.grabKeys, true, "the modal should hold the keyboard");
  screen.focused.emit("cancel");
  await answer;
  assert.equal(screen.grabKeys, false, "the deck would be left unable to take keys");
});

// --- dismissal chrome ------------------------------------------------------

const openModal = (over: Record<string, unknown> = {}) => {
  let dismissed = 0;
  const chrome = createModal(blessed, screen, {
    title: "t",
    widthPct: 60,
    height: 7,
    onDismiss: () => {
      dismissed += 1;
    },
    ...over,
  });
  screen.render();
  return { chrome, dismissed: () => dismissed };
};

test("every modal shows a close button on its border", () => {
  openModal();
  assert.match(visible(screen), /\[x\]/);
});

test("the close button dismisses", () => {
  const { chrome, dismissed } = openModal();
  const button = chrome.box.children.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => String(c.content).includes("[x]"),
  );
  button.emit("click");
  assert.equal(dismissed(), 1);
});

test("a full press and release outside dismisses", () => {
  const { chrome, dismissed } = openModal();
  chrome.scrim.emit("mousedown");
  chrome.scrim.emit("mouseup");
  assert.equal(dismissed(), 1);
});

test("the release of the click that opened the modal does not dismiss it", () => {
  // That press landed on a button below, before this scrim existed. Only the
  // release arrives here — and on its own it must do nothing, or opening a
  // modal by clicking would close it again immediately.
  const { chrome, dismissed } = openModal();
  chrome.scrim.emit("mouseup");
  assert.equal(dismissed(), 0);
});

test("a hardened modal ignores outside clicks but still offers the button", () => {
  // The password prompt. A stray click while confirming a spend is the most
  // expensive click in the app; an explicit [x] is still unambiguous.
  const { chrome, dismissed } = openModal({ hardened: true });
  chrome.scrim.emit("mousedown");
  chrome.scrim.emit("mouseup");
  assert.equal(dismissed(), 0, "an outside click dismissed a hardened modal");
  assert.match(visible(screen), /\[x\]/);
  const button = chrome.box.children.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => String(c.content).includes("[x]"),
  );
  button.emit("click");
  assert.equal(dismissed(), 1);
});

test("a modal with no dismiss path grows no button", () => {
  // Nothing to call: closing without resolving would hang the promise behind
  // it, so the chrome declines to offer an exit it cannot complete.
  createModal(blessed, screen, { title: "t", widthPct: 60, height: 7 });
  screen.render();
  assert.ok(!visible(screen).includes("[x]"));
});
