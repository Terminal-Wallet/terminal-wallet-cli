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
import { createModal, openModalCount, shifted } from "../../../src/tui/widgets/modal";
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

test("closing a modal hands focus back to what had it", () => {
  // Reported as "Esc took me back, but I couldn't glide through the addresses
  // again" — and as a row action doing nothing, which is the same fault: the
  // list underneath had no focus, so neither arrows nor its shortcuts arrived.
  const rail = blessed.list({
    parent: screen,
    top: 0,
    left: 0,
    width: 20,
    height: 5,
    keys: true,
    items: ["a", "b"],
  });
  rail.focus();
  assert.equal(screen.focused, rail);

  const chrome = modal("balances");
  const body = blessed.list({
    parent: chrome.box,
    top: 0,
    left: 0,
    width: 10,
    height: 3,
    keys: true,
    items: ["x"],
  });
  body.focus();
  assert.equal(screen.focused, body);

  chrome.close();
  assert.equal(screen.focused, rail, "focus was not returned to the list beneath");
});

test("a row shortcut still fires after a popup has been and gone", () => {
  // The concrete consequence: `r` on the ephemeral console did nothing after
  // viewing balances, because the list was no longer focused.
  const rail = blessed.list({
    parent: screen,
    top: 0,
    left: 0,
    width: 20,
    height: 5,
    keys: true,
    items: ["a"],
  });
  let fired = 0;
  rail.key(["r"], () => {
    fired += 1;
  });
  rail.focus();

  const chrome = modal("popup");
  chrome.close();

  screen.program.emit("keypress", "r", { name: "r", full: "r", sequence: "r" });
  assert.equal(fired, 1, "the shortcut did not reach the list after the popup closed");
});

test("nested modals return focus inward, then outward", () => {
  const outer = modal("outer");
  const outerBody = blessed.list({
    parent: outer.box, top: 0, left: 0, width: 10, height: 3, keys: true, items: ["x"],
  });
  outerBody.focus();

  const inner = modal("inner");
  const innerBody = blessed.list({
    parent: inner.box, top: 0, left: 0, width: 8, height: 3, keys: true, items: ["y"],
  });
  innerBody.focus();

  inner.close();
  assert.equal(screen.focused, outerBody, "focus did not return to the outer modal");
  outer.close();
});

test("a shifted letter binds to what blessed actually emits", () => {
  // key.full is (ctrl)(meta)(shift)+lowercased name, so shift+S arrives as
  // "S-s" and a binding on "S" alone can never fire.
  const el = blessed.list({
    parent: screen, top: 0, left: 0, width: 10, height: 3, keys: true, items: ["a"],
  });
  let fired = 0;
  el.key(shifted("S"), () => {
    fired += 1;
  });
  el.focus();
  screen.program.emit("keypress", "S", {
    name: "s",
    shift: true,
    full: "S-s",
    sequence: "S",
  });
  assert.equal(fired, 1, "a capital-letter binding did not fire");
});
