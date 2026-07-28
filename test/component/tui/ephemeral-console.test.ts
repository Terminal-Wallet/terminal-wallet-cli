/**
 * The 7702 console, driven on a real screen.
 *
 * The reported fault was interaction, not arithmetic: "recover stranded funds
 * is dead — I select index 35, which is current, and it goes back to the main
 * screen." Two causes met there. The flow asked you to TYPE an index, so the
 * only one you could supply was the current one, which by definition holds
 * nothing; and the "Nothing stranded" notice that answered you was invisible,
 * because notify() had been writing past the status bar's expiry.
 *
 * So what needs asserting is that the accounts are on screen, that the current
 * one is not the only reachable one, and that a row's contents are visible
 * before you commit to anything.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import blessed from "blessed";
import { buildIndexRows, rowLabel } from "../../../src/tui/format/ephemeral-rows";
import { EphemeralHistoryEntry } from "../../../src/railgun/wallet/ephemeral-util";
import { EphemeralAssetScan } from "../../../src/railgun/wallet/ephemeral-recovery";
import { parseUnits } from "ethers";

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
  output.columns = 120;
  output.rows = 40;
  return blessed.screen({
    output,
    input: new Readable({ read() {} }),
    term: "xterm",
    smartCSR: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
};

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const visible = (s: any): string => String(s.screenshot()).replace(SGR, "");

const entries = (...indexes: number[]): EphemeralHistoryEntry[] =>
  indexes.map((index) => ({
    index,
    address: `0x${String(index).padStart(4, "0")}${"ab".repeat(16)}`,
    usedForUnshield: false,
  }));

const holding: EphemeralAssetScan = {
  address: "0x",
  nativeWei: parseUnits("0.0021", 18),
  nfts: [],
  erc20s: [],
  method: "logs",
  unreadable: 0,
};

beforeEach(() => {
  screen = makeScreen();
});

afterEach(() => {
  screen.destroy();
});

/** The list as the console builds it, without booting the engine. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderList = (items: string[]): any => {
  const list = blessed.list({
    parent: screen,
    top: 0,
    left: 0,
    width: 100,
    height: 20,
    tags: true,
    keys: true,
    items,
    style: { selected: { bg: "magenta", fg: "black" } },
  });
  screen.render();
  return list;
};

test("every account is reachable, not just the one you can name", () => {
  // The old flow could only be given the current index. Here the accounts
  // behind it — where a half-finished send actually strands funds — are rows.
  const rows = buildIndexRows(35, entries(32, 33, 34, 35));
  renderList(rows.map(rowLabel));
  const drawn = visible(screen);
  for (const index of [32, 33, 34, 35]) {
    assert.ok(drawn.includes(`#${index}`), `index ${index} is not on screen`);
  }
});

test("the account holding funds is distinguishable before you act", () => {
  const rows = buildIndexRows(
    35,
    entries(34, 35),
    new Map([[34, holding]]),
  );
  const list = renderList(
    rows.map((row) =>
      row.scan && row.scan.nativeWei > 0n
        ? `{yellow-fg}${rowLabel(row)}{/}`
        : rowLabel(row),
    ),
  );
  const drawn = visible(screen);
  assert.match(drawn, /0\.002100 ETH/, "the holding is not shown on the row");
  assert.match(drawn, /#35.*not scanned/, "the current index claims to be empty");
  assert.equal(list.items.length, 2);
});

test("the list opens on the newest account", () => {
  const rows = buildIndexRows(35, entries(30, 31, 32, 33, 34, 35));
  const list = renderList(rows.map(rowLabel));
  assert.equal(list.selected, 0);
  assert.match(String(list.items[0].getContent()), /#35/);
});

test("selection moves to the accounts behind the current one", () => {
  // The whole point: getting to an index you could not have typed.
  const rows = buildIndexRows(35, entries(33, 34, 35));
  const list = renderList(rows.map(rowLabel));
  list.down(1);
  assert.equal(list.selected, 1);
  assert.equal(rows[list.selected].index, 34);
  assert.equal(rows[list.selected].isCurrent, false);
});
