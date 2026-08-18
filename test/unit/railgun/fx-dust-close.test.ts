/**
 * Sizing the swap that funds a full close.
 *
 * The user chooses which token to sell; this works out how much. Getting it
 * wrong low is the expensive direction — the batch mines, the swap lands short,
 * the close silently becomes partial, and the position is still open after a
 * proof and a broadcaster fee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BPS_DENOM,
  FEE_DENOM,
  inBatchDebtTokenForFullClose,
  netOfUnshieldFee,
  sellAmountForDebtToken,
} from "../../../src/railgun/transaction/fx/full-close";
import { DUST_CLOSE_SELL_BUFFER_BPS } from "../../../src/railgun/transaction/fx/dust-close";

test("the in-batch requirement carries the pool's repay fee only", () => {
  // RAILGUN's unshield fee is already spent by the time funds are in the batch.
  const debt = 1_000_000n;
  assert.equal(inBatchDebtTokenForFullClose(debt, 0n), debt);
  assert.equal(
    inBatchDebtTokenForFullClose(debt, FEE_DENOM / 100n),
    debt + debt / 100n,
  );
  assert.equal(inBatchDebtTokenForFullClose(0n, 5n), 0n);
});

test("the in-batch requirement rounds up", () => {
  // Rounding down leaves the repay a wei short, which is a partial close.
  const out = inBatchDebtTokenForFullClose(3n, 1n);
  assert.ok(out >= 3n);
});

test("netOfUnshieldFee takes the fee off the gross", () => {
  assert.equal(netOfUnshieldFee(10_000n, 0n), 10_000n);
  assert.equal(netOfUnshieldFee(10_000n, 25n), 9_975n);
  assert.equal(netOfUnshieldFee(10_000n, BPS_DENOM), 0n);
});

test("the sell amount is derived from the probe rate", () => {
  // Probe: 1000 in buys 2000 out, so the rate is 2. Raising 500 needs 250,
  // plus the buffer.
  const out = sellAmountForDebtToken({
    needed: 500n,
    probeSell: 1_000n,
    probeGuaranteed: 2_000n,
    bufferBps: 0n,
  });
  assert.equal(out, 250n);
});

test("the buffer is applied on top", () => {
  const bare = sellAmountForDebtToken({
    needed: 1_000_000n,
    probeSell: 1_000_000n,
    probeGuaranteed: 1_000_000n,
    bufferBps: 0n,
  });
  const buffered = sellAmountForDebtToken({
    needed: 1_000_000n,
    probeSell: 1_000_000n,
    probeGuaranteed: 1_000_000n,
    bufferBps: DUST_CLOSE_SELL_BUFFER_BPS,
  });
  assert.ok(buffered > bare);
  assert.equal(buffered, (bare * (BPS_DENOM + DUST_CLOSE_SELL_BUFFER_BPS)) / BPS_DENOM);
});

test("CONTROL: the sell amount always covers what is needed at the probe rate", () => {
  // Rounding must never land under, at any ratio.
  for (const [needed, probeSell, probeGuaranteed] of [
    [7n, 3n, 11n],
    [999_983n, 1_000_003n, 7n],
    [1n, 999_999n, 1_000_001n],
    [123_456_789n, 987_654_321n, 111_111_111n],
  ] as const) {
    const sell = sellAmountForDebtToken({
      needed,
      probeSell,
      probeGuaranteed,
      bufferBps: 0n,
    });
    const raised = (sell * probeGuaranteed) / probeSell;
    assert.ok(raised >= needed, `sell ${sell} raised ${raised}, needed ${needed}`);
  }
});

test("nothing needed means nothing sold", () => {
  assert.equal(
    sellAmountForDebtToken({ needed: 0n, probeSell: 1n, probeGuaranteed: 1n, bufferBps: 200n }),
    0n,
  );
});

test("a probe that returns nothing is refused, not divided by", () => {
  for (const probe of [
    { probeSell: 0n, probeGuaranteed: 1n },
    { probeSell: 1n, probeGuaranteed: 0n },
  ]) {
    assert.throws(() =>
      sellAmountForDebtToken({ needed: 1n, bufferBps: 0n, ...probe }),
    );
  }
});

test("the buffer is a real margin, not a token gesture", () => {
  // It absorbs the rate moving between the probe size and the real size. Too
  // small and it buys nothing; too large and the user overspends every time.
  assert.ok(DUST_CLOSE_SELL_BUFFER_BPS >= 50n, "under half a percent buys nothing");
  assert.ok(DUST_CLOSE_SELL_BUFFER_BPS <= 500n, "over 5% is an overspend, not a buffer");
});
