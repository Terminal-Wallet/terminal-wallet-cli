/**
 * The ephemeral index list.
 *
 * The console this replaces asked you to TYPE the index to recover from. That
 * only works if you already know which account holds the stranded funds — and
 * the reason you are in this screen is that the wallet ratcheted past it
 * without telling you. The one index you do know is the current one, which is
 * precisely the case guaranteed to hold nothing: it has not been used yet.
 *
 * So the ordering, the markers and the "not scanned" state all exist to answer
 * one question on sight — which account still has something at it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import {
  IndexRow,
  assetSummary,
  buildIndexRows,
  holdsAssets,
  rowLabel,
  rowState,
  scanVerdict,
} from "../../../src/tui/format/ephemeral-rows";
import { EphemeralAssetScan } from "../../../src/railgun/wallet/ephemeral-recovery";
import { EphemeralHistoryEntry } from "../../../src/railgun/wallet/ephemeral-util";

const addr = (n: number) => `0x${String(n).padStart(4, "0")}${"ab".repeat(16)}`;

const entries = (...indexes: number[]): EphemeralHistoryEntry[] =>
  indexes.map((index) => ({
    index,
    address: addr(index),
    usedForUnshield: index % 2 === 1,
  }));

const scan = (
  nativeWei: bigint,
  erc20s: EphemeralAssetScan["erc20s"] = [],
  nfts: EphemeralAssetScan["nfts"] = [],
): EphemeralAssetScan => ({
  address: "0x",
  nativeWei,
  erc20s,
  nfts,
  method: "logs",
  unreadable: 0,
});

const weth = {
  tokenAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  symbol: "WETH",
  decimals: 18,
  balance: parseUnits("1.5", 18),
};

const position = {
  nftAddress: "0xc6dee5c8ea6ee2b0f3f4d5e3f0e7b8a9c0d1e2f3",
  tokenSubID: "0x1092",
  label: "f(x) position #4242",
};

test("newest index first", () => {
  // A half-finished send strands the account just behind the current index; a
  // list opening at 0 buries it under every account you do not care about.
  const rows = buildIndexRows(35, entries(30, 31, 32, 33, 34, 35));
  assert.deepEqual(
    rows.map((r) => r.index),
    [35, 34, 33, 32, 31, 30],
  );
});

test("the current index is marked, and it is the empty one", () => {
  const rows = buildIndexRows(35, entries(34, 35));
  const [current] = rows;
  assert.equal(current.index, 35);
  assert.equal(current.isCurrent, true);
  assert.equal(rowState(current), "current");
  // Nothing has been scanned, so nothing claims to be empty either.
  assert.equal(current.scan, undefined);
});

test("an unscanned row says so rather than looking empty", () => {
  // "0" and "unknown" are different answers and the screen must not conflate
  // them — one means move on, the other means look.
  const [row] = buildIndexRows(35, entries(35));
  assert.match(rowLabel(row), /not scanned/);
  assert.equal(holdsAssets(row), false, "an unscanned row is not 'holding'");
});

test("a scanned but empty row reads empty", () => {
  const scans = new Map([[34, scan(0n)]]);
  const [row] = buildIndexRows(35, entries(34), scans);
  assert.equal(assetSummary(row), "empty");
  assert.equal(holdsAssets(row), false);
});

test("a row holding only a position says so instead of reading empty", () => {
  // The f(x) mint that stranded position #4242 left the NFT and nothing else
  // recoverable by symbol. `holdsAssets` counts it, so a summary that ignores
  // it prints a row highlighted as holding funds and labelled "empty" — the
  // list contradicting itself about the one asset worth rescuing.
  const scans = new Map([[34, scan(0n, [], [position])]]);
  const [row] = buildIndexRows(35, entries(34), scans);
  assert.equal(holdsAssets(row), true);
  assert.notEqual(assetSummary(row), "empty");
  assert.match(assetSummary(row), /f\(x\) position #4242/);
});

test("positions are summarised alongside tokens, not instead of them", () => {
  const scans = new Map([[34, scan(parseUnits("0.01", 18), [weth], [position])]]);
  const [row] = buildIndexRows(35, entries(34), scans);
  const summary = assetSummary(row);
  assert.match(summary, /ETH/);
  assert.match(summary, /WETH/);
  assert.match(summary, /#4242/);
});

test("a row holding native ETH is flagged", () => {
  const scans = new Map([[34, scan(parseUnits("0.0021", 18))]]);
  const [row] = buildIndexRows(35, entries(34), scans);
  assert.equal(holdsAssets(row), true);
  assert.match(assetSummary(row), /0\.002100 ETH/);
});

test("a row holding one token names it; several are counted", () => {
  const one = buildIndexRows(35, entries(34), new Map([[34, scan(0n, [weth])]]));
  assert.match(assetSummary(one[0]), /1\.5000 WETH/);

  const many = buildIndexRows(
    35,
    entries(34),
    new Map([[34, scan(0n, [weth, { ...weth, symbol: "USDC" }])]]),
  );
  assert.match(assetSummary(many[0]), /2 tokens/);
});

test("history's used marker survives into the row", () => {
  // An account seen as an unshield recipient definitely executed something,
  // which makes it a better recovery candidate than one that never appears.
  const rows = buildIndexRows(35, entries(33));
  assert.equal(rows[0].usedForUnshield, true);
  assert.equal(rowState(rows[0]), "used");
});

test("the verdict distinguishes nothing-found from nothing-checked", () => {
  const rows = buildIndexRows(35, entries(34, 35));
  assert.equal(scanVerdict(rows), "not scanned yet");

  const empty = buildIndexRows(
    35,
    entries(34, 35),
    new Map([
      [34, scan(0n)],
      [35, scan(0n)],
    ]),
  );
  assert.match(scanVerdict(empty), /nothing stranded/);

  const holding = buildIndexRows(
    35,
    entries(34, 35),
    new Map([
      [34, scan(parseUnits("1", 18))],
      [35, scan(0n)],
    ]),
  );
  assert.match(scanVerdict(holding), /1 holding funds/);
});

test("labels line up across rows", () => {
  // The screen exists to compare rows to each other, which needs columns.
  const rows: IndexRow[] = buildIndexRows(
    350,
    entries(9, 350),
    new Map([[9, scan(parseUnits("1", 18))]]),
  );
  const [a, b] = rows.map(rowLabel);
  assert.equal(
    a.indexOf("0x"),
    b.indexOf("0x"),
    "addresses do not start in the same column",
  );
});

test("no history is not an error", () => {
  assert.deepEqual(buildIndexRows(0, []), []);
  assert.equal(scanVerdict([]), "not scanned yet");
});
