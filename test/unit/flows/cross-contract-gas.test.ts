/**
 * Cross-contract calls carry no gas floor.
 *
 * `minGasLimit` is baked into the relay-adapt action data as an on-chain
 * `require(gasleft() > minGasLimit)`, so a non-zero value forces the
 * transaction to CARRY that much gas into the call. The private swap was
 * passing the cookbook recipe's figure, which comes from non-7702 assumptions
 * and is large enough that the gas estimate reverts on the floor check itself —
 * a revert with no sub-call index, which is why it surfaced as "RelayAdapt
 * multicall failed at index UNKNOWN."
 *
 * 0n lets the estimate reflect real execution, and the populated limit is that
 * estimate x1.2 — the figure handed to the broadcaster and charged on.
 *
 * Asserted by reading the source: the values reach an SDK call this suite
 * cannot make, so what matters is that nothing reintroduces a floor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

test("the private swap passes no gas floor", () => {
  const swap = read("railgun/transaction/zeroX/0x-swap.ts");
  assert.match(swap, /const minGasLimit = 0n;/);
  assert.ok(
    !/minGasLimit\s*\}\s*=\s*swap\.config/.test(swap),
    "back to the recipe's floor, which reverts the estimate",
  );
});

test("recovery passes no gas floor either", () => {
  const recovery = read("railgun/wallet/ephemeral-recovery.ts");
  assert.match(recovery, /const recoveryMinGasLimit = 0n;/);
});

test("the shared input type requires a value, so undefined cannot mean no floor", () => {
  // undefined is the dangerous case: the SDK substitutes its own default
  // rather than omitting the check.
  const contract = read("railgun/transaction/cross-contract.ts");
  assert.match(contract, /minGasLimit: bigint;/);
  assert.ok(
    !/minGasLimit\?: bigint/.test(contract),
    "optional again — undefined would restore the SDK's floor",
  );
});

test("the swap adapter defaults to 0n rather than undefined", () => {
  const deps = read("flows/deps/swap.ts");
  assert.match(deps, /minGasLimit: swap\.minGasLimit \?\? 0n/);
});

test("no cross-contract path reintroduces a non-zero floor", () => {
  for (const file of [
    "railgun/transaction/zeroX/0x-swap.ts",
    "railgun/wallet/ephemeral-recovery.ts",
    "flows/deps/swap.ts",
  ]) {
    const source = read(file);
    const assignments = [...source.matchAll(/minGasLimit\w*\s*=\s*([^;,\n]+)/g)]
      .map((m) => m[1].trim())
      .filter((v) => !v.startsWith("0n") && !v.includes("bigint"));
    assert.deepEqual(assignments, [], `${file} sets a gas floor: ${assignments.join(", ")}`);
  }
});
