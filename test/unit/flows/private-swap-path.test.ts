/**
 * The private swap uses its own 7702 estimate and proof.
 *
 * It was reduced to CrossContractInputs and run through the generic
 * cross-contract pipeline. Making that pipeline equivalent to the swap's own
 * path meant reproducing every step of it, and each omission was silent: the
 * non-7702 SDK functions, non-type-4 gas details, no min-gas-price pin, no
 * transaction type on the populated tx, and no ephemeral-index realignment
 * before the SDK derives the taker address.
 *
 * getZer0XSwapTransactionGasEstimate and getProvedZer0XSwapTransaction are the
 * path the 7702 work was built and tested against. The swap uses them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

test("the private swap estimates through the swap's own 7702 function", () => {
  const deps = read("flows/deps/swap.ts");
  assert.match(deps, /getZer0XSwapTransactionGasEstimate\(/);
});

test("and proves through the swap's own 7702 function", () => {
  const deps = read("flows/deps/swap.ts");
  assert.match(deps, /getProvedZer0XSwapTransaction\(/);
});

test("it no longer routes through the generic cross-contract runner", () => {
  const deps = read("flows/deps/swap.ts");
  assert.ok(
    !/runCrossContractTransaction\(/.test(deps),
    "back on the generic pipeline, which is not the 7702 path",
  );
});

test("the ephemeral index is realigned before the taker is derived", () => {
  // The SDK derives the taker from the current index. Estimating against an
  // index that has not been reconciled with history quotes for one account and
  // executes from another.
  const swap = read("railgun/transaction/zeroX/0x-swap.ts");
  const at = swap.indexOf("export const getZer0XSwapTransactionGasEstimate");
  const body = swap.slice(at, swap.indexOf("export const", at + 10));
  assert.match(body, /syncEphemeralIndexOnce\(/, "no realignment before the estimate");
});

test("the swap still sends through the private send path", () => {
  const deps = read("flows/deps/swap.ts");
  assert.match(deps, /sendPrivateTransaction\(/);
  assert.match(deps, /RailgunTransaction\.Private0XSwap/);
});
