/**
 * The small-window crash.
 *
 *   TypeError: Cannot read properties of undefined (reading 'top')
 *     at Element._getTop (blessed/lib/widgets/element.js)
 *     at Screen._focus  (blessed/lib/widgets/screen.js)
 *     at Node.insert    (blessed/lib/widgets/node.js)
 *     at Box.Element    (blessed/lib/widgets/element.js:49)
 *
 * blessed's Element constructor calls Node — which appends to the parent —
 * BEFORE it sets `this.position`. Node.insert does
 * `if (!screen.focused) screen.focused = element`, and that setter runs
 * Screen._focus, which reads `element.rtop` when the element has a scrollable
 * ancestor. `position` does not exist yet, so it throws from inside a
 * constructor, with a stack naming none of our code.
 *
 * Both conditions are needed, and both were reachable: the palette box becomes
 * scrollable in a short pane, and shrinking the terminal hides the rails —
 * rewindFocus pops through the history skipping anything invisible, so the
 * history can empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import blessed from "blessed";
import { ensureFocus } from "../../../src/tui/widgets/focus-guard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const makeScreen = () => {
  const output = new Writable({ write(_c, _e, cb) { cb(); } }) as any;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  return blessed.screen({
    output,
    input: new Readable({ read() {} }),
    term: "xterm",
  } as any);
};

/** Focus emptied by hiding whatever held it — what a shrunk terminal leaves. */
const emptyFocus = (screen: blessed.Widgets.Screen) => {
  (screen as unknown as { history: unknown[] }).history.length = 0;
};

test("appending into a scrollable parent with no focus is the crash", () => {
  // The control: this MUST throw, or the guard below proves nothing.
  const screen = makeScreen();
  const box = blessed.box({
    parent: screen, top: 0, left: 0, width: 20, height: 10, scrollable: true,
  } as any);
  emptyFocus(screen);
  assert.throws(
    () => blessed.box({ parent: box, top: 0, left: 0, width: 5, height: 2 }),
    /Cannot read properties of undefined \(reading 'top'\)/,
  );
  screen.destroy();
});

test("ensureFocus makes that same append safe", () => {
  const screen = makeScreen();
  const box = blessed.box({
    parent: screen, top: 0, left: 0, width: 20, height: 10, scrollable: true,
  } as any);
  emptyFocus(screen);
  ensureFocus(screen, box);
  assert.doesNotThrow(() =>
    blessed.box({ parent: box, top: 0, left: 0, width: 5, height: 2 }),
  );
  screen.destroy();
});

test("a non-scrollable parent was never affected", () => {
  // Which is why this went unnoticed until the palette gained scrolling.
  const screen = makeScreen();
  const box = blessed.box({ parent: screen, top: 0, left: 0, width: 20, height: 10 });
  emptyFocus(screen);
  assert.doesNotThrow(() =>
    blessed.box({ parent: box, top: 0, left: 0, width: 5, height: 2 }),
  );
  screen.destroy();
});

test("ensureFocus leaves an existing focus alone", () => {
  const screen = makeScreen();
  const first = blessed.box({ parent: screen, top: 0, left: 0, width: 5, height: 2 });
  const second = blessed.box({ parent: screen, top: 3, left: 0, width: 5, height: 2 });
  first.focus();
  ensureFocus(screen, second);
  assert.equal((screen as any).focused, first, "focus must not be stolen");
  screen.destroy();
});

test("no fallback, or one that cannot take focus, is not a crash", () => {
  const screen = makeScreen();
  emptyFocus(screen);
  assert.doesNotThrow(() => ensureFocus(screen, undefined));
  assert.doesNotThrow(() =>
    ensureFocus(screen, { focus: () => { throw new Error("nope"); } } as any),
  );
  screen.destroy();
});
