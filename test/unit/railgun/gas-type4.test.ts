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
});

test("CONTROL: a legacy override does not zero the tip", () => {
  // It used to. A type-4 transaction with a 0 tip is one no block will include:
  // the ceiling is the user's chosen price and the miner's share of it is
  // nothing. The tip already on the details — derived from the network, and
  // what the estimate was built around — is carried across instead.
  const out = applyOverrideToDetails(type4(), legacyOverride) as TransactionGasDetails & {
    maxPriorityFeePerGas: bigint;
  };
  assert.notEqual(out.maxPriorityFeePerGas, 0n, "back to an unmineable zero tip");
  assert.equal(out.maxPriorityFeePerGas, 1_000_000_000n, "the existing tip was not kept");
});

test("the carried tip never exceeds the chosen ceiling", () => {
  // A tip above the max fee is rejected outright, so a cheap override must
  // clamp rather than carry a tip larger than the price it sets.
  const cheap = { evmGasType: EVMGasType.Type0 as const, gasPrice: 500_000_000n };
  const out = applyOverrideToDetails(type4(), cheap) as TransactionGasDetails & {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  };
  assert.equal(out.maxFeePerGas, 500_000_000n);
  assert.equal(out.maxPriorityFeePerGas, 500_000_000n, "tip should clamp to the ceiling");
  assert.ok(out.maxPriorityFeePerGas <= out.maxFeePerGas);
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
 * The gas figure quoted to a broadcaster on a 7702 transaction.
 *
 * The broadcaster applies calculateGasLimit's 1.2x itself before submitting,
 * so `type4FeeOverrides.gasLimit` is the figure it PADS, not the figure it
 * submits. shared-models writes the already-padded limit onto the transaction,
 * so forwarding that compounds to 1.44x — while the fee committed inside the
 * proof, `feePerUnitGas x calculateGasLimit(gasEstimate) x maxFeePerGas`, only
 * ever covers 1.2x. The padded figure therefore asks a broadcaster to submit
 * with more gas than it was paid for.
 */

/** What shared-models does: (estimate * 12000n) / 10000n. */
const pad = (estimate: bigint) => (estimate * 12000n) / 10000n;

const PRIVATE_TX = () =>
  readFileSync(
    join(resolve(process.cwd(), "src"), "railgun/transaction/private/private-tx.ts"),
    "utf-8",
  );

test("un-buffering recovers the measured estimate", () => {
  for (const estimate of [2_100_790n, 1_000_000n, 2_520_949n, 7n]) {
    const recovered = unbufferGasLimit(pad(estimate));
    const drift = estimate > recovered ? estimate - recovered : recovered - estimate;
    assert.ok(drift <= 1n, `${estimate}: recovered ${recovered}`);
  }
});

test("it is about five sixths of the padded limit", () => {
  // 1 / 1.2. A regression to a different divisor changes what the broadcaster
  // pads, so the ratio is asserted rather than the divisor.
  assert.equal(unbufferGasLimit(1_200_000n), 1_000_000n);
});

test("zero stays zero", () => {
  assert.equal(unbufferGasLimit(0n), 0n);
});

test("the broadcaster override sends the un-buffered figure", () => {
  assert.match(PRIVATE_TX(), /gasLimit: unbufferGasLimit\(/);
});

test("CONTROL: the padded limit is not forwarded as-is", () => {
  assert.ok(
    !/gasLimit: BigInt\(tx\.transaction\.gasLimit\)/.test(PRIVATE_TX()),
    "back to quoting the broadcaster on already-padded gas",
  );
});

test("CONTROL: forwarding the padded limit compounds past what the fee covers", () => {
  // The broadcaster pads whatever it is given. Handed the padded limit it
  // submits at 1.44x, while the committed fee only ever covers 1.2x.
  const estimate = 2_100_790n;
  const covered = pad(estimate); // what the fee was computed on
  const ifForwarded = pad(pad(estimate)); // what the broadcaster would submit
  assert.ok(ifForwarded > covered, "forwarding the padded limit is free");
  // In basis points, so integer division does not round the answer away:
  // 1.2 x 1.2 = 1.44, and the floors cost a few hundredths of a bp.
  const bps = (ifForwarded * 10_000n) / estimate;
  assert.ok(bps >= 14_390n && bps <= 14_400n, `expected ~1.44x, got ${bps} bps`);
});

test("quoting the estimate lands the submission exactly on the covered figure", () => {
  // Sending the estimate, the broadcaster's own 1.2x reproduces precisely the
  // gas limit the proof-committed fee was priced for.
  const estimate = 2_100_790n;
  const quoted = unbufferGasLimit(pad(estimate));
  const submitted = pad(quoted);
  const covered = pad(estimate);
  const drift = submitted > covered ? submitted - covered : covered - submitted;
  assert.ok(drift <= 2n, `submitted ${submitted} vs covered ${covered}`);
});
