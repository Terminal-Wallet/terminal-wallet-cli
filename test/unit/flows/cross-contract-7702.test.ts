/**
 * Every cross-contract batch is a 7702 relay-adapt.
 *
 * There is no non-7702 cross-contract path — neither master nor
 * feat/7702-integration-base calls the plain SDK functions at all. This tree
 * had the private swap reduced to CrossContractInputs and running through a
 * generic pipeline that used them, so a transaction submitted as type 4 was
 * estimated and proved as if it were not: legacy-typed gas details, the plain
 * estimate, and a min-gas-price commitment the type-4 price can fall below.
 *
 * Asserted by reading the source. Each pair of SDK functions is same-shaped, so
 * calling the wrong one is not a type error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { executionMode } from "../../../src/flows/spec";
import { RailgunTransaction } from "../../../src/models/transaction-models";

const SRC = resolve(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });

test("nothing calls the non-7702 cross-contract functions", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf-8");
    for (const name of [
      "gasEstimateForUnprovenCrossContractCalls",
      "generateCrossContractCallsProof",
    ]) {
      // The 7702 variants share the prefix, so require a non-"7702" suffix.
      if (new RegExp(`\\b${name}(?!7702)\\b`).test(source)) {
        offenders.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `plain cross-contract calls:\n  ${offenders.join("\n  ")}`);
});

test("the estimate asks for type-4 gas details", () => {
  const contract = read("railgun/transaction/cross-contract.ts");
  const at = contract.indexOf("await getTransactionGasDetails(");
  const call = contract.slice(at, contract.indexOf(");", at));
  assert.match(call, /broadcasterSelection,\s*\n\s*true,/, "not requesting type-4");
});

test("a cross-contract batch commits no min gas price", () => {
  // A non-zero commitment reverts as "Gas price too low" once the effective
  // type-4 price falls below it.
  const contract = read("railgun/transaction/cross-contract.ts");
  assert.match(contract, /const overallBatchMinGasPrice = 0n;/);
});

test("the direct flows are still direct", () => {
  // Regular transfer and unshield are not relay-adapt and must not ask for
  // type-4 — matching master and the 7702 branch.
  for (const rel of [
    "railgun/transaction/private/private-tx.ts",
    "railgun/transaction/private/unshield-tx.ts",
  ]) {
    const source = read(rel);
    const at = source.indexOf("await getTransactionGasDetails(");
    assert.ok(at > 0, `${rel}: no gas-details call`);
    const call = source.slice(at, source.indexOf(");", at));
    assert.ok(!/\btrue\b/.test(call), `${rel} requests type-4 for a direct flow`);
  }
});

test("the model still marks the relay-adapt flows as ephemeral-7702", () => {
  assert.equal(executionMode(RailgunTransaction.Private0XSwap).kind, "ephemeral-7702");
  assert.equal(executionMode(RailgunTransaction.UnshieldBase).kind, "ephemeral-7702");
  assert.equal(executionMode(RailgunTransaction.Transfer).kind, "direct");
  assert.equal(executionMode(RailgunTransaction.Unshield).kind, "direct");
});

test("the populated transaction is marked type 4", () => {
  // ethers and the broadcaster decide how to send from transaction.type. The
  // other two 7702 paths set it; the shared cross-contract path did not, so a
  // relay-adapt batch was populated without its type or authorization list.
  const contract = read("railgun/transaction/cross-contract.ts");
  assert.match(contract, /transaction\.type = EVMGasType\.Type4;/);
  const at = contract.indexOf("await populateProvedCrossContractCalls(");
  const set = contract.indexOf("transaction.type = EVMGasType.Type4;");
  assert.ok(at > 0 && set > at, "the type is set before the transaction is populated");
});

test("the other 7702 paths still mark it too", () => {
  for (const rel of [
    "railgun/wallet/ephemeral-recovery.ts",
    "railgun/transaction/zeroX/0x-swap.ts",
  ]) {
    assert.match(read(rel), /transaction\.type = EVMGasType\.Type4/, `${rel} lost it`);
  }
});
