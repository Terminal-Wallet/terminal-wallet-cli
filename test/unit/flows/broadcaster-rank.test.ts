import { test } from "node:test";
import assert from "node:assert/strict";
import { rankBroadcasters, bonusPct, BroadcasterRow } from "../../../src/flows/broadcaster-rank";

const row = (address: string, feeAmount: bigint | undefined, reliability = 0.9): BroadcasterRow => ({
  address, feeAmount, feeReadable: feeAmount === undefined ? "?" : feeAmount.toString(), reliability, wallets: 1,
});

test("rankBroadcasters dedupes by address and sorts lowest fee first", () => {
  const ranked = rankBroadcasters([
    row("0zkC", 30n),
    row("0zkA", 10n),
    row("0zkB", 20n),
  ]);
  assert.deepEqual(ranked.map((r) => r.address), ["0zkA", "0zkB", "0zkC"]);
});

test("rankBroadcasters keeps the cheapest entry per duplicated address", () => {
  const ranked = rankBroadcasters([
    row("0zkA", 50n),
    row("0zkA", 12n), // duplicate, cheaper
    row("0zkA", 40n),
  ]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].feeAmount, 12n);
});

test("rankBroadcasters sinks unknown-fee broadcasters to the bottom", () => {
  const ranked = rankBroadcasters([
    row("0zkU", undefined),
    row("0zkA", 10n),
  ]);
  assert.deepEqual(ranked.map((r) => r.address), ["0zkA", "0zkU"]);
});

test("rankBroadcasters drops blocked and floats favorites to the top", () => {
  const ranked = rankBroadcasters(
    [row("0zkA", 10n), row("0zkB", 20n), row("0zkC", 30n)],
    { favorites: new Set(["0zkC"]), blocked: new Set(["0zkA"]) },
  );
  // A blocked → gone; C favorite → first (despite higher fee); then B by fee.
  assert.deepEqual(ranked.map((r) => r.address), ["0zkC", "0zkB"]);
});

test("bonusPct is 0 for the cheapest and positive above it", () => {
  assert.equal(bonusPct(100n, 100n), 0);
  assert.equal(bonusPct(115n, 100n), 15);
  assert.equal(bonusPct(undefined, 100n), 0);
  assert.equal(bonusPct(100n, 0n), 0);
});
