import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rankBroadcasters,
  bonusPct,
  favoriteRank,
  preferredFavorite,
  cheapestFee,
  moveInList,
  BroadcasterRow,
} from "../../../src/flows/broadcaster-rank";

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
    { favorites: ["0zkC"], blocked: new Set(["0zkA"]) },
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

/**
 * Favourite precedence.
 *
 * The favourites list is ordered, and that order decides who relays a
 * transaction — ⭐1 is the default for every new send. So these are not display
 * assertions: getting the order wrong sends someone's fee to the wrong party.
 */

test("precedence beats price among favourites", () => {
  // C is ranked above B and costs more. The user said C; C wins.
  const ranked = rankBroadcasters(
    [row("0zkA", 10n), row("0zkB", 20n), row("0zkC", 30n)],
    { favorites: ["0zkC", "0zkB"] },
  );
  assert.deepEqual(ranked.map((r) => r.address), ["0zkC", "0zkB", "0zkA"]);
});

test("non-favourites still sort by fee, below every favourite", () => {
  const ranked = rankBroadcasters(
    [row("0zkA", 30n), row("0zkB", 10n), row("0zkC", 99n)],
    { favorites: ["0zkC"] },
  );
  assert.deepEqual(ranked.map((r) => r.address), ["0zkC", "0zkB", "0zkA"]);
});

test("favoriteRank places unlisted addresses after every favourite", () => {
  assert.equal(favoriteRank(["0zkA", "0zkB"], "0zkA"), 0);
  assert.equal(favoriteRank(["0zkA", "0zkB"], "0zkB"), 1);
  assert.equal(favoriteRank(["0zkA"], "0zkZ"), Number.POSITIVE_INFINITY);
});

test("rank matching ignores case", () => {
  // The editor already treats these as the same broadcaster. A rank that
  // disagreed would show a star with no number beside it.
  assert.equal(favoriteRank(["0zkABC"], "0zkabc"), 0);
});

test("preferredFavorite picks the highest-ranked one that is reachable", () => {
  // Precedence is a preference, not a requirement: an offline favourite is
  // skipped rather than blocking the send.
  assert.equal(preferredFavorite(["0zkA", "0zkB"], ["0zkB", "0zkC"]), "0zkB");
  assert.equal(preferredFavorite(["0zkA", "0zkB"], ["0zkA", "0zkB"]), "0zkA");
  assert.equal(preferredFavorite(["0zkA"], ["0zkC"]), undefined);
  assert.equal(preferredFavorite([], ["0zkC"]), undefined);
});

test("preferredFavorite returns the available spelling", () => {
  // The caller looks the broadcaster back up by this string.
  assert.equal(preferredFavorite(["0zkABC"], ["0zkabc"]), "0zkabc");
});

test("cheapestFee is the minimum, not the first row", () => {
  // rankBroadcasters puts the top favourite first, which is regularly not the
  // cheapest. Using row 0 as the baseline labelled the favourite " best " and
  // made every genuinely cheaper broadcaster read as a negative bonus.
  const ranked = rankBroadcasters(
    [row("0zkA", 10n), row("0zkC", 30n)],
    { favorites: ["0zkC"] },
  );
  assert.equal(ranked[0].address, "0zkC");
  assert.equal(cheapestFee(ranked), 10n);
  assert.equal(bonusPct(ranked[0].feeAmount, cheapestFee(ranked)), 200);
});

test("cheapestFee ignores unknown fees, and is undefined when all are unknown", () => {
  assert.equal(cheapestFee([row("0zkA", undefined), row("0zkB", 5n)]), 5n);
  assert.equal(cheapestFee([row("0zkA", undefined)]), undefined);
  assert.equal(cheapestFee([]), undefined);
});

test("moveInList reorders and clamps at both ends", () => {
  const list = ["a", "b", "c"];
  assert.deepEqual(moveInList(list, "c", -1), ["a", "c", "b"]);
  assert.deepEqual(moveInList(list, "a", 1), ["b", "a", "c"]);
  // Clamped, not wrapped — moving the top entry up must not send it last.
  assert.deepEqual(moveInList(list, "a", -1), ["a", "b", "c"]);
  assert.deepEqual(moveInList(list, "c", 5), ["a", "b", "c"]);
  // "Make default" is a large negative delta.
  assert.deepEqual(moveInList(list, "c", -3), ["c", "a", "b"]);
  // An unknown address changes nothing.
  assert.deepEqual(moveInList(list, "zz", -1), ["a", "b", "c"]);
});
