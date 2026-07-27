/**
 * A relay-adapt batch can mine and still have failed.
 *
 * The SDK builds the action data with `requireSuccess = false`, so if an inner
 * call reverts the transaction still succeeds: the RAILGUN unshield has already
 * run, and what it produced is left at the ephemeral account instead of being
 * shielded back. The receipt carries a `CallError` log saying so.
 *
 * Until this landed, nothing read that log, and the wallet reported "mined" —
 * so a swap that bought nothing looked exactly like a swap that worked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import { sendPrivateTransaction } from "../../../src/flows/send-private";
import { RailgunTransaction } from "../../../src/models/transaction-models";
import { useRelayAdapt } from "../../../src/flows/spec";
import {
  makeSendPrivateDeps,
  provedTransaction,
  selfSignerFee,
} from "../../_support";

const send = (type: RailgunTransaction, over = {}) => {
  const { deps, calls } = makeSendPrivateDeps(over);
  return {
    calls,
    run: () =>
      sendPrivateTransaction(
        provedTransaction(),
        selfSignerFee(),
        NetworkName.Ethereum,
        type,
        deps,
      ),
  };
};

/** The watchers fire on a floating promise; let it settle before asserting. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a clean relay-adapt batch is reported as mined", async () => {
  const { calls, run } = send(RailgunTransaction.MorphoVaultDeposit);
  await run();
  await settle();
  assert.ok(calls.failureChecked, "the receipt was never interrogated");
  assert.ok(calls.mined, "a clean batch should report mined");
  assert.equal(calls.batchFailed, undefined);
});

test("a batch that mined with a CallError is reported as failed, not mined", async () => {
  const { calls, run } = send(RailgunTransaction.MorphoVaultDeposit, {
    relayAdaptFailure: async () => "ERC20: transfer amount exceeds balance",
  });
  await run();
  await settle();
  assert.equal(calls.mined, undefined, "a failed batch must not report success");
  assert.equal(
    calls.batchFailed?.reason,
    "ERC20: transfer amount exceeds balance",
    "the contract's own reason should reach the user",
  );
});

test("a non-relay-adapt send is not asked for a CallError it cannot have", async () => {
  const { calls, run } = send(RailgunTransaction.Transfer);
  assert.equal(useRelayAdapt(RailgunTransaction.Transfer), false);
  await run();
  await settle();
  assert.equal(calls.failureChecked, undefined, "a plain transfer was interrogated");
  assert.ok(calls.mined);
});

test("every relay-adapt flow is covered, including the ones added for DeFi", async () => {
  const relayAdapt = Object.values(RailgunTransaction).filter(useRelayAdapt);
  assert.ok(
    relayAdapt.includes(RailgunTransaction.MorphoVaultDeposit) &&
      relayAdapt.includes(RailgunTransaction.MorphoVaultRedeem) &&
      relayAdapt.includes(RailgunTransaction.FxMintOpen),
    "a DeFi flow stopped being relay-adapt",
  );
  for (const type of relayAdapt) {
    const { calls, run } = send(type, {
      relayAdaptFailure: async () => "reverted",
    });
    await run();
    await settle();
    assert.ok(calls.batchFailed, `${type} does not check its receipt`);
  }
});
