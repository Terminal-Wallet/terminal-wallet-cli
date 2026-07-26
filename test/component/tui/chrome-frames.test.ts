/**
 * Card frames stay intact with the labels the deck actually uses.
 *
 * The width question was previously argued from a table rather than from a
 * rendered frame, and both answers it produced were wrong on some terminal:
 * emoji measured as one cell and drawn as two broke the border, then a widened
 * table on a terminal that draws them narrow ate a column and turned "TWALLET"
 * into "WALLET".
 *
 * blessed's own grid cannot settle what a terminal draws — it is self-
 * consistent either way. What it can settle is that a label of the length we
 * think it is leaves the frame square and the text unclipped, which is the part
 * that regressed. The labels here are the real ones.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import blessed from "blessed";
import unicode from "blessed/lib/unicode";

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
    fullUnicode: true,
    smartCSR: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
};

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const visible = (s: any): string => String(s.screenshot()).replace(SGR, "");

/** The deck's card labels, verbatim. */
const LABELS = [
  " ◆ wallet ",
  " ○ network ",
  " ↻ sync ",
  " ▲ gas ",
  " ▸ utilities ",
];

beforeEach(() => {
  screen = makeScreen();
});

afterEach(() => {
  screen.destroy();
});

test("each card label renders whole, inside a square frame", () => {
  LABELS.forEach((label, i) => {
    blessed.box({
      parent: screen,
      top: i * 5,
      left: 0,
      width: 30,
      height: 5,
      border: { type: "line" },
      label,
      content: "body",
    });
  });
  screen.render();
  const drawn = visible(screen);

  for (const label of LABELS) {
    // The label text, spaces and all. A width disagreement shows up here first:
    // a swallowed column removes the space, which is what "◆wallet" was.
    assert.ok(
      drawn.includes(label.trim()),
      `label "${label.trim()}" is not intact in the render`,
    );
    const [mark] = label.trim();
    const word = label.trim().slice(2);
    assert.ok(
      drawn.includes(`${mark} ${word}`),
      `"${mark} ${word}" lost the space between mark and word`,
    );
  }
});

test("the frame is not displaced by the label", () => {
  const width = 30;
  blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width,
    height: 3,
    border: { type: "line" },
    label: " ◆ wallet ",
  });
  screen.render();
  const rows = visible(screen).split("\n");

  // Top and bottom edges must be the same width; a label measured short pulls
  // the top border in and the box stops being a rectangle.
  const edgeCols = (row: string) => row.replace(/\s+$/, "").length;
  assert.equal(
    edgeCols(rows[2]),
    width,
    "the bottom border is not the width the box was given",
  );
  assert.ok(
    rows[0].includes("◆ wallet"),
    "the label is not on the top border",
  );
  assert.equal(
    edgeCols(rows[0]),
    width,
    "the label displaced the top border",
  );
});

test("every mark in the labels is one cell to blessed", () => {
  // The measurement half of the agreement. The drawing half belongs to the
  // terminal and is why these marks have no emoji presentation to begin with.
  for (const label of LABELS) {
    assert.equal(
      unicode.strWidth(label),
      label.length,
      `"${label}" measures wider than its character count`,
    );
  }
});
