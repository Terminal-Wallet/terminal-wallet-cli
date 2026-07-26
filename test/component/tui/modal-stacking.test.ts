/**
 * Modals that stack, and menu loops that wait for them.
 *
 * The ephemeral console showed its history with a call that returned void, so
 * `await dispatch(...)` resolved immediately, the menu loop came round, and
 * `select()` drew a new menu on top of the popup it had just opened. It looked
 * like the popup had vanished; it was underneath, and had to be closed after
 * the menu, in the opposite order to the one it appeared in.
 *
 * The key grab has the same shape of fault. It was a boolean set on open and
 * cleared on close, so an inner modal closing handed the deck's global keys
 * back while an outer modal was still up — `q` would quit the app from inside
 * a dialog.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import blessed from "blessed";
import { createModal, openModalCount } from "../../../src/tui/widgets/modal";
import { showText } from "../../../src/tui/screens/popout";
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

const modal = (title: string) =>
  createModal(blessed, screen, {
    title,
    widthPct: 50,
    height: 8,
    onDismiss: () => undefined,
  });

beforeEach(() => {
  screen = makeScreen();
  assert.equal(openModalCount(), 0, "a previous test leaked an open modal");
});

afterEach(() => {
  screen.destroy();
});

/** The [x] the chrome puts on every dismissable modal. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const closeButton = (): any => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const find = (node: any): any => {
    for (const child of node.children ?? []) {
      if (
        typeof child.getContent === "function" &&
        String(child.getContent()).includes("[x]")
      ) {
        return child;
      }
      const found = find(child);
      if (found) return found;
    }
    return undefined;
  };
  return find(screen);
};

test("a scroll modal resolves only when it closes", async () => {
  ctx = { screen, render: () => screen.render() } as unknown as DeckContext;
  let resolved = false;
  const shown = showText(ctx, "history", "line one\nline two").then(() => {
    resolved = true;
  });

  // The bug: this was already true here, so the caller's menu loop ran on and
  // drew itself over the popup.
  await Promise.resolve();
  assert.equal(resolved, false, "resolved while the modal was still open");
  assert.equal(openModalCount(), 1);

  const x = closeButton();
  assert.ok(x, "the modal has no close button to drive");
  x.emit("click");

  await shown;
  assert.equal(resolved, true);
  assert.equal(openModalCount(), 0, "the modal did not release its slot");
});

test("the key grab survives an inner modal closing", () => {
  const outer = modal("outer");
  assert.equal(screen.grabKeys, true);

  const inner = modal("inner");
  assert.equal(openModalCount(), 2);

  inner.close();
  assert.equal(
    screen.grabKeys,
    true,
    "the grab was released while a modal was still open",
  );

  outer.close();
  assert.equal(screen.grabKeys, false, "the grab was never released");
  assert.equal(openModalCount(), 0);
});

test("closing twice does not unbalance the count", () => {
  // Both the [x] and Escape can reach the same close path.
  const only = modal("only");
  only.close();
  only.close();
  assert.equal(openModalCount(), 0);

  const next = modal("next");
  assert.equal(screen.grabKeys, true, "a stale decrement released the next grab");
  next.close();
});

test("a later modal is drawn above an earlier one", () => {
  // z-order is insertion order in blessed, which is what makes a popup opened
  // from a menu visible rather than buried.
  const outer = modal("outer");
  const inner = modal("inner");
  const order = screen.children;
  assert.ok(
    order.indexOf(inner.box) > order.indexOf(outer.box),
    "the newer modal is not on top",
  );
  inner.close();
  outer.close();
});

test("Escape closes a modal even after focus moves underneath it", () => {
  // The reported fault: "only the [x] works to close the header modals, Esc no
  // longer does the trick." A click needs no focus; a key bound on the modal's
  // own list needs it, and anything below that takes focus back leaves the
  // dialog with no keyboard way out.
  const rail = blessed.list({
    parent: screen,
    top: 0,
    left: 0,
    width: 20,
    height: 5,
    keys: true,
    items: ["a"],
  });

  let dismissed = false;
  const chrome = createModal(blessed, screen, {
    title: "menu",
    widthPct: 50,
    height: 8,
    onDismiss: () => {
      dismissed = true;
    },
  });

  rail.focus(); // the deck reclaims focus while the modal is up
  screen.program.emit("keypress", "", {
    name: "escape",
    full: "escape",
    sequence: "",
  });

  assert.equal(dismissed, true, "Escape did not reach the modal");
  chrome.close();
});

test("Escape reaches the innermost modal only", () => {
  const outerDismissed: string[] = [];
  const outer = createModal(blessed, screen, {
    title: "outer",
    widthPct: 50,
    height: 8,
    onDismiss: () => outerDismissed.push("outer"),
  });
  const inner = createModal(blessed, screen, {
    title: "inner",
    widthPct: 40,
    height: 6,
    onDismiss: () => outerDismissed.push("inner"),
  });

  screen.program.emit("keypress", "", { name: "escape", full: "escape", sequence: "" });
  assert.deepEqual(outerDismissed, ["inner"], "Escape did not target the top modal");

  inner.close();
  screen.program.emit("keypress", "", { name: "escape", full: "escape", sequence: "" });
  assert.deepEqual(outerDismissed, ["inner", "outer"]);
  outer.close();
});

test("a hardened modal is not dismissed by Escape, and does not fall through", () => {
  // The password prompt. Escape must not cancel a spend confirmation, and must
  // not reach past it to whatever dialog opened it either.
  const reached: string[] = [];
  const under = createModal(blessed, screen, {
    title: "under",
    widthPct: 50,
    height: 8,
    onDismiss: () => reached.push("under"),
  });
  const password = createModal(blessed, screen, {
    title: "password",
    widthPct: 40,
    height: 6,
    hardened: true,
    onDismiss: () => reached.push("password"),
  });

  screen.program.emit("keypress", "", { name: "escape", full: "escape", sequence: "" });
  assert.deepEqual(reached, [], "Escape got through a hardened modal");

  password.close();
  under.close();
});
