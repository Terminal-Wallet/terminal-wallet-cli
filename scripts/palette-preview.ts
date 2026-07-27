/**
 * Renders the command palette headlessly and prints what blessed actually drew.
 *
 *   npx tsx scripts/palette-preview.ts            # default pane width
 *   npx tsx scripts/palette-preview.ts 80 private # width, and a seeded token kind
 *
 * The palette's labels are clipped by the card geometry, not by anything in the
 * source, so reading `actions.ts` tells you what a card was MEANT to say and
 * nothing about what it says. This draws it and reads the cells back, which is
 * the only version of the question worth asking.
 */
import { Readable, Writable } from "node:stream";
import blessed from "blessed";
import { buildActions } from "../src/tui/actions";
import { createPalette } from "../src/tui/screens/palette";
import { setState } from "../src/tui/store";
import { DeckContext } from "../src/tui/context";
import { TokenKind, buildPaletteCards } from "../src/tui/screens/palette-grid";

/* eslint-disable @typescript-eslint/no-explicit-any */

const paneWidth = Number(process.argv[2] ?? 64);
const seededKind = process.argv[3] as TokenKind | undefined;

const paneHeight = Number(process.argv[4] ?? 28);
const COLS = paneWidth + 4;
const ROWS = paneHeight + 2;

const output = new Writable({
  write(_chunk, _enc, cb) {
    cb();
  },
}) as any;
output.isTTY = true;
output.columns = COLS;
output.rows = ROWS;

const screen = blessed.screen({
  output,
  input: new Readable({ read() {} }),
  term: "xterm",
  smartCSR: true,
} as any);

setState({ baseSymbol: "ETH" });

const box = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: paneWidth,
  height: paneHeight,
  tags: true,
  border: { type: "line" },
  label: " command palette ",
});

const ctx = {
  screen,
  render: () => screen.render(),
} as unknown as DeckContext;

const palette = createPalette({
  ctx,
  box,
  seeded: () => ({ kind: seededKind }),
  onSelect: () => undefined,
  onClose: () => undefined,
});

palette.open();
screen.render();

/** The screen's cells as plain text — the drawn result, trailing space trimmed. */
const drawn = (): string[] => {
  const lines: string[] = [];
  for (let y = 0; y < ROWS; y++) {
    const row = (screen as any).lines[y];
    if (!row) continue;
    let line = "";
    for (let x = 0; x < COLS; x++) {
      line += row[x]?.[1] ?? " ";
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

const lines = drawn();
console.log(lines.join("\n"));

// A label the geometry cut is the defect this exists to catch, so name them
// rather than leaving it to the eye.
const cardLabels = new Set(
  buildPaletteCards("ETH", seededKind).map((c) => c.label),
);
const clipped = buildActions("ETH")
  .map((a) => a.label)
  .filter((label) => cardLabels.has(label) && !lines.some((l) => l.includes(label)));
if (clipped.length) {
  console.log(`\nCLIPPED (${clipped.length}):`);
  for (const label of clipped) console.log(`  ${label}`);
} else {
  console.log("\nno clipped labels");
}

// A card drawn onto or past the box's bottom border is the other way the grid
// lies: the flow is on screen but unreachable. The bottom border is a clean run
// of one character unless something is sitting on it.
const bottomRow = lines[paneHeight - 1] ?? "";
const intact = /^└─+┘$/.test(bottomRow.trim());
console.log(
  intact
    ? "box intact — nothing drawn past the bottom"
    : `OVERFLOW — the grid draws past the box:\n  ${bottomRow}`,
);

screen.destroy();
