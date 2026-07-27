/**
 * The reserved band for address-bound positions.
 *
 * The whole design rests on the band being unreachable by an ordinary flow. The
 * never-reuse rule exists because a reused account holding residual ETH or WETH
 * can be swept by a later relay-adapt wrap step — so position accounts must be
 * somewhere the ordinary counter cannot arrive at by accident, not somewhere a
 * guard has to remember to skip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_POSITION_SLOTS,
  POSITION_INDEX_BASE,
  PositionSlotsExhausted,
  isPositionIndex,
  nextFreeSlot,
  positionIndexForSlot,
  slotForPositionIndex,
} from "../../../src/railgun/wallet/position-account";

test("the band sits far above anything the ordinary counter reaches", () => {
  // The ordinary index moves one per type-4 send and history reconciliation
  // walks the low indices with a small gap limit. A wallet would need a million
  // relay-adapt transactions to collide.
  assert.ok(POSITION_INDEX_BASE >= 1_000_000);
  for (const ordinary of [0, 1, 42, 99, 1000, 999_999]) {
    assert.equal(isPositionIndex(ordinary), false, `${ordinary} must be ordinary`);
  }
});

test("the band stays inside what BIP-32 can derive", () => {
  // Hardened segments must be below 2^31; an index past it throws in the SDK,
  // which would make a slot's account underivable and the position unreachable.
  assert.ok(POSITION_INDEX_BASE + MAX_POSITION_SLOTS < 2 ** 31);
});

test("slots map to indices, and back", () => {
  for (const slot of [0, 1, 63]) {
    const index = positionIndexForSlot(slot);
    assert.equal(index, POSITION_INDEX_BASE + slot);
    assert.equal(isPositionIndex(index), true);
    assert.equal(slotForPositionIndex(index), slot);
  }
});

test("an index just outside the band is not in it", () => {
  assert.equal(isPositionIndex(POSITION_INDEX_BASE - 1), false);
  assert.equal(isPositionIndex(POSITION_INDEX_BASE + MAX_POSITION_SLOTS), false);
  assert.equal(slotForPositionIndex(POSITION_INDEX_BASE - 1), undefined);
});

test("running out of slots refuses, it does not wrap", () => {
  // Wrapping would hand a new position the account of an open one, and Morpho
  // would treat them as a single position with both sets of collateral and debt.
  assert.throws(() => positionIndexForSlot(MAX_POSITION_SLOTS), PositionSlotsExhausted);
  assert.throws(() => positionIndexForSlot(-1), PositionSlotsExhausted);
  assert.throws(() => positionIndexForSlot(1.5), PositionSlotsExhausted);
  const all = Array.from({ length: MAX_POSITION_SLOTS }, (_, i) => i);
  assert.throws(() => nextFreeSlot(all), PositionSlotsExhausted);
});

test("the next free slot is the lowest gap, so slots are reused after closing", () => {
  assert.equal(nextFreeSlot([]), 0);
  assert.equal(nextFreeSlot([0, 1, 2]), 3);
  assert.equal(nextFreeSlot([0, 2, 3]), 1, "should fill the gap, not append");
});

test("slot derivation is deterministic, so a seed restore finds the same accounts", () => {
  // The registry is a convenience. If it is the only way back, losing it loses
  // the positions.
  assert.equal(positionIndexForSlot(7), positionIndexForSlot(7));
  assert.equal(positionIndexForSlot(7), POSITION_INDEX_BASE + 7);
});
