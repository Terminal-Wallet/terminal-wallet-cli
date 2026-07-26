/**
 * A gas override sets a price, not a transaction type.
 *
 * Overrides are built from the chain's default EVM gas type, which is Type2 on
 * Ethereum, Type0 on BNB, and never Type4. Taking the type from the override
 * therefore downgrades a 7702 relay-adapt transaction — the estimate produces
 * type-4 details, the user's gas choice rewrites them as Type2 (or legacy), and
 * the proof and populate then describe something other than what is submitted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVMGasType, TransactionGasDetails } from "@railgun-community/shared-models";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  unbufferGasLimit,
  applyOverrideToDetails,
  presetsFromEstimate,
  customOverride,
  priceField,
} from "../../../src/railgun/gas/gas-selection";

const type4 = (): TransactionGasDetails =>
  ({
    evmGasType: EVMGasType.Type4,
    gasEstimate: 1_000_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  }) as TransactionGasDetails;

const eip1559Override = {
  evmGasType: EVMGasType.Type2 as const,
  maxFeePerGas: 50_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
};
const legacyOverride = {
  evmGasType: EVMGasType.Type0 as const,
  gasPrice: 40_000_000_000n,
};

test("a 1559 override keeps the details type-4", () => {
  const out = applyOverrideToDetails(type4(), eip1559Override) as TransactionGasDetails & {
    maxFeePerGas: bigint;
  };
  assert.equal(out.evmGasType, EVMGasType.Type4, "downgraded away from type 4");
  assert.equal(out.maxFeePerGas, 50_000_000_000n, "the chosen price was not applied");
});

test("a legacy override keeps type-4 and maps its price onto maxFeePerGas", () => {
  // On a legacy-default chain the override carries gasPrice. A type-4
  // transaction cannot carry one, so it becomes the 1559 ceiling.
  const out = applyOverrideToDetails(type4(), legacyOverride) as TransactionGasDetails & {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  };
  assert.equal(out.evmGasType, EVMGasType.Type4);
  assert.equal(out.maxFeePerGas, 40_000_000_000n);
  assert.equal(out.maxPriorityFeePerGas, 0n);
});

test("the gas estimate is carried over, not the override's", () => {
  const out = applyOverrideToDetails(type4(), eip1559Override);
  assert.equal(out.gasEstimate, 1_000_000n);
});

test("non-7702 details still take the override's type", () => {
  // The override is the only source of truth when the transaction is not
  // pinned to type 4.
  const details = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 5n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  } as TransactionGasDetails;
  const out = applyOverrideToDetails(details, legacyOverride) as TransactionGasDetails & {
    gasPrice: bigint;
  };
  assert.equal(out.evmGasType, EVMGasType.Type0);
  assert.equal(out.gasPrice, 40_000_000_000n);
});

test("type-4 presets are 1559-shaped, not legacy", () => {
  // Offering a gasPrice preset for a transaction submitted as type 4 gives it
  // a field it cannot carry.
  const presets = presetsFromEstimate(EVMGasType.Type4, {
    baseFeePerGas: 10n,
    slow: 1n,
    average: 2n,
    fast: 3n,
    gasPrice: 99n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
  } as never);
  assert.ok(presets.length > 0);
  for (const p of presets) {
    assert.equal(p.override.evmGasType, EVMGasType.Type2, "legacy preset for a type-4 tx");
    assert.ok(priceField(p.override) > 0n);
  }
});

test("a custom type-4 entry collects the 1559 pair", () => {
  const o = customOverride(EVMGasType.Type4, {
    maxFeePerGas: 7n,
    maxPriorityFeePerGas: 1n,
  });
  assert.ok(o, "type-4 custom entry was rejected");
  assert.equal(o.evmGasType, EVMGasType.Type2);
  assert.equal(priceField(o), 7n);
});

/**
 * The gas figure quoted to a broadcaster.
 *
 * shared-models' calculateGasLimit multiplies the estimate by 1.2 and the SDK
 * writes that onto the transaction, so the padded limit is the only place the
 * figure survives — the proved transaction does not carry the estimate. A
 * broadcaster quoted on padded gas overprices its fee.
 */

/** What shared-models does: (estimate * 12000n) / 10000n. */
const pad = (estimate: bigint) => (estimate * 12000n) / 10000n;

test("un-buffering recovers the measured estimate", () => {
  for (const estimate of [2_100_790n, 1_000_000n, 2_520_949n, 7n]) {
    const recovered = unbufferGasLimit(pad(estimate));
    const drift = estimate > recovered ? estimate - recovered : recovered - estimate;
    assert.ok(drift <= 1n, `${estimate}: recovered ${recovered}`);
  }
});

test("it is strictly below the padded limit", () => {
  const padded = pad(2_100_790n);
  assert.ok(unbufferGasLimit(padded) < padded);
});

test("it is about five sixths of the padded limit", () => {
  // 1 / 1.2. A regression to a different divisor changes what a broadcaster
  // charges on, so the ratio is asserted rather than the divisor.
  const padded = 1_200_000n;
  assert.equal(unbufferGasLimit(padded), 1_000_000n);
});

test("zero stays zero", () => {
  assert.equal(unbufferGasLimit(0n), 0n);
});

test("the broadcaster override sends the un-buffered figure", () => {
  const source = readFileSync(
    join(resolve(process.cwd(), "src"), "railgun/transaction/private/private-tx.ts"),
    "utf-8",
  );
  assert.match(source, /gasLimit: unbufferGasLimit\(/);
  assert.ok(
    !/gasLimit: tx\.transaction\.gasLimit/.test(source),
    "back to quoting the broadcaster on padded gas",
  );
});
