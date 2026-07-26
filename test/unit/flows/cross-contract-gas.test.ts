/**
 * Cross-contract calls carry no on-chain gas floor.
 *
 * `minGasLimit` is not passed to the contract as given. Every relay-adapt
 * contract computes `minGasLimit - 150000n` and bakes THAT into the action data
 * as `require(gasleft() > ...)`, so the offset is what "no floor" costs.
 *
 * Both ends of the range fail, in opposite ways:
 *
 *  - a literal `0n` yields -150_000n, unencodable as the contract's unsigned
 *    parameter: `value out-of-bounds (argument="minGasLimit", value=-150000)`
 *  - `undefined` makes the SDK substitute its own multi-million default, which
 *    forces the transaction to carry that much gas and reverts the estimate on
 *    the floor check — "multicall failed at index UNKNOWN", no sub-call index
 *
 * With the floor at zero the estimate reflects real execution and the submitted
 * limit is estimate x1.2.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NO_CROSS_CONTRACT_GAS_FLOOR } from "../../../src/railgun/transaction/cross-contract";

const SRC = resolve(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

/** What every relay-adapt contract subtracts before baking the floor in. */
const SDK_CONTRACT_OFFSET = 150_000n;

test("the constant lands the on-chain floor exactly at zero", () => {
  assert.equal(NO_CROSS_CONTRACT_GAS_FLOOR - SDK_CONTRACT_OFFSET, 0n);
});

test("it is not negative after the subtraction", () => {
  // The regression: 0n - 150000n is rejected before it reaches the chain.
  assert.ok(NO_CROSS_CONTRACT_GAS_FLOOR - SDK_CONTRACT_OFFSET >= 0n);
});

test("the offset still matches the SDK on all three contracts", () => {
  // If a dependency bump changes it, the constant is silently wrong and the
  // floor stops being zero — so read it back rather than trusting the number.
  const base = resolve(
    process.cwd(),
    "node_modules/@railgun-community/engine/dist/contracts/relay-adapt",
  );
  for (const rel of [
    "V2/relay-adapt-v2.js",
    "V2/relay-adapt-7702.js",
    "V3/relay-adapt-v3.js",
  ]) {
    const source = readFileSync(join(base, rel), "utf-8");
    const match = source.match(/return minimumGasLimit - (\d+)n;/);
    assert.ok(match, `${rel}: could not read the offset`);
    assert.equal(
      BigInt(match[1]),
      SDK_CONTRACT_OFFSET,
      `${rel} now subtracts ${match[1]}, so the no-floor constant is wrong`,
    );
  }
});

test("the private swap carries the recipe's floor", () => {
  // Its external 0x call is variable and the estimate under-shoots the real
  // relay-adapt execution, so the submitted transaction needs the floor. Only
  // the deterministic ops can go without one.
  const swap = read("railgun/transaction/zeroX/0x-swap.ts");
  assert.match(swap, /const \{ minGasLimit \} = swap\.config;/);
});

test("recovery uses it too", () => {
  const recovery = read("railgun/wallet/ephemeral-recovery.ts");
  assert.match(recovery, /const recoveryMinGasLimit = NO_CROSS_CONTRACT_GAS_FLOOR;/);
});

test("the shared input type requires a value", () => {
  // undefined is the dangerous case: the SDK substitutes its own default.
  const contract = read("railgun/transaction/cross-contract.ts");
  assert.match(contract, /minGasLimit: bigint;/);
  assert.ok(!/minGasLimit\?: bigint/.test(contract), "optional again");
});

test("the swap adapter never falls back to undefined", () => {
  const deps = read("flows/deps/swap.ts");
  assert.match(deps, /minGasLimit: swap\.minGasLimit \?\? NO_CROSS_CONTRACT_GAS_FLOOR/);
});
