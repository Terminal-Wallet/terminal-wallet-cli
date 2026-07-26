/**
 * The log pane: selectable lines, and a tail that stops fighting you.
 *
 * Two things made it hard to use. Every line was one block of text, so nothing
 * could be picked out or copied — and the pane pinned itself to the bottom on
 * every arriving line, which yanks you away from whatever you had scrolled up
 * to read. A live log that cannot be read is a log that has to be screenshotted
 * and transcribed by hand.
 *
 * Driven on a real screen because selection, re-selection after a refresh, and
 * key bindings are blessed's own wiring rather than ours.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import blessed from "blessed";
import { showLogs } from "../../../src/tui/screens/popout";
import { getState, setState, appendLog } from "../../../src/tui/store";
import { DeckContext } from "../../../src/tui/context";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let screen: any;
let ctx: DeckContext;

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

/** The list the modal built, found by walking the screen. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findList = (): any => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any): any => {
    for (const child of node.children ?? []) {
      if (typeof child.select === "function" && Array.isArray(child.items)) {
        return child;
      }
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk(screen);
};

const seed = (count: number) => {
  let logs: string[] = [];
  for (let i = 0; i < count; i += 1) logs = appendLog(logs, `line ${i}`);
  setState({ logs });
};

beforeEach(() => {
  setState({ logs: [] });
  screen = makeScreen();
  ctx = {
    screen,
    render: () => screen.render(),
    refreshIdentity: async () => undefined,
    refreshBalances: async () => undefined,
    refreshChainStats: async () => undefined,
    refreshHistory: async () => undefined,
  } as unknown as DeckContext;
});

afterEach(() => {
  screen.destroy();
});

test("the log view renders one selectable item per line", () => {
  seed(5);
  showLogs(ctx);
  const list = findList();
  assert.ok(list, "the log view is not a selectable list");
  assert.equal(list.items.length, 5);
});

test("it opens on the newest line", () => {
  seed(5);
  showLogs(ctx);
  const list = findList();
  assert.equal(list.selected, 4, "did not open at the tail");
});

test("a new line while sitting at the tail follows it", () => {
  seed(3);
  showLogs(ctx);
  const list = findList();
  setState({ logs: appendLog(getState().logs, "line 3") });
  assert.equal(list.items.length, 4);
  assert.equal(list.selected, 3, "the tail was not followed");
});

test("a new line does NOT move a cursor that scrolled up", () => {
  // The behaviour being fixed: reading line 0 while the log is live used to
  // drag the view to the bottom on every arrival.
  seed(5);
  showLogs(ctx);
  const list = findList();
  list.select(0);
  setState({ logs: appendLog(getState().logs, "line 5") });
  assert.equal(list.selected, 0, "the cursor was dragged to the tail");
  assert.equal(list.items.length, 6, "the new line was still recorded");
});

test("the selection survives a refresh that shortens the list", () => {
  // The store caps the log, so lines fall off the front and an index can
  // outrun the list.
  seed(10);
  showLogs(ctx);
  const list = findList();
  list.select(9);
  setState({ logs: ["only one left"] });
  assert.equal(list.items.length, 1);
  assert.ok(list.selected < list.items.length, "selection ran past the end");
});

test("c and a are bound for copying", () => {
  seed(3);
  showLogs(ctx);
  const list = findList();
  const bound = Object.keys(list._events ?? {});
  assert.ok(
    bound.some((k) => k.includes("keypress") || k.includes("key c")),
    "no key handlers on the list",
  );
  // The bindings blessed registers for .key() land under "key <name>".
  assert.ok(bound.includes("key c"), "c (copy line) is not bound");
  assert.ok(bound.includes("key a"), "a (copy all) is not bound");
});
