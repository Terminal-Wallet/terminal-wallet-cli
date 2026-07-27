/**
 * The invariants a Morpho vault batch depends on that no type can express.
 *
 * A vault recipe bakes an address into its calldata — the ERC-4626 `receiver`
 * that the shares or assets are paid to. Under 7702 that must be the ephemeral
 * EOA the relay-adapt executes as, and the index it comes from ratchets after
 * every type-4 send. Getting either wrong pays a real vault out to an account
 * this wallet will never use again, and nothing in the type system notices.
 *
 * These read the source because that is what makes them break on a rename or a
 * move, which is the intent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

test("the generic cross-contract estimate realigns the ephemeral index", () => {
  // Every cookbook recipe binds to an executor at build time, so the index has
  // to be reconciled with history before the SDK derives the address to
  // estimate against — the same guard the 0x swap already carries.
  const crossContract = read("railgun/transaction/cross-contract.ts");
  const at = crossContract.indexOf("export const getCrossContractGasEstimate");
  const body = crossContract.slice(
    at,
    crossContract.indexOf("export const", at + 10),
  );
  assert.match(body, /syncEphemeralIndexOnce\(/, "no realignment before the estimate");
});

test("the vault receiver is the ephemeral executor, not the wallet's 0zk address", () => {
  const vault = read("railgun/transaction/morpho/vault.ts");
  assert.match(vault, /getCurrentEphemeralInfo\(/, "does not derive the ephemeral EOA");
  assert.match(vault, /makeEphemeralExecutor\(/, "does not build an executor from it");
  // The 0zk address is where the OUTPUTS are shielded; it is never the on-chain
  // receiver, and the cookbook would reject it as an executor anyway.
  const executorLine = vault
    .split("\n")
    .find((l) => l.includes("makeEphemeralExecutor("));
  assert.ok(
    executorLine && !/railgunAddress/.test(executorLine),
    "the 0zk address is being passed as the executor",
  );
});

test("the batch carries the recipe's own gas floor", () => {
  // NO_CROSS_CONTRACT_GAS_FLOOR means "no floor at all". A vault batch that
  // takes it estimates fine and then runs out of gas mid-execution, after the
  // proof has already been paid for.
  const vault = read("railgun/transaction/morpho/vault.ts");
  assert.match(vault, /minGasLimit: recipeOutput\.minGasLimit/);
  assert.ok(
    !/NO_CROSS_CONTRACT_GAS_FLOOR/.test(vault),
    "a vault batch must not run with the no-floor default",
  );
});

test("the vault flows are refused outside Ethereum before a recipe is built", () => {
  // Every Morpho recipe rejects a non-Ethereum network from inside the cookbook
  // base class, which surfaces as a raw library error at build time.
  const vault = read("railgun/transaction/morpho/vault.ts");
  assert.match(vault, /isMorphoSupportedNetwork\(chainName\)/);
});

test("the vault builder cards are relay-adapt, so the fee gate finds a 7702 broadcaster", () => {
  // Without relayAdapt the fee collector offers broadcasters that do not carry
  // an authorization list, and the send fails after the proof.
  const configs = read("tui/screens/tx-builder-configs.ts");
  for (const id of ["morpho-vault-deposit", "morpho-vault-redeem"]) {
    const at = configs.indexOf(`"${id}": (chainName)`);
    assert.ok(at > 0, `${id} has no builder config`);
    const body = configs.slice(at, at + 900);
    assert.match(body, /relayAdapt: true/, `${id} is not marked relay-adapt`);
  }
});
