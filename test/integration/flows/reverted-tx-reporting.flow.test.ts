/**
 * A transaction that reverted must never be reported as mined.
 *
 * The watchers cannot answer this and never could. `waitOnTx` catches the
 * rejection ethers throws for a reverted receipt and returns normally, and
 * `waitForTx` / `waitForRelayedTx` catch everything else including the
 * timeout — so "the watcher finished" carried no information about the
 * outcome. Both send paths then chained `.then(() => notifyMined(...))` off it,
 * which is how a reverted public transfer came to report "Transaction mined".
 *
 * The settlement now comes from the receipt's status, so these tests drive the
 * three outcomes a receipt can produce and assert each is reported as itself.
 * Against the previous behaviour every one of them reports mined.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import { sendPrivateTransaction } from "../../../src/flows/send-private";
import { sendPublicTransaction } from "../../../src/flows/send-public";
import { RailgunTransaction } from "../../../src/models/transaction-models";
import {
  makeSendPrivateDeps,
  makeSendPublicDeps,
  provedTransaction,
  selfSignerFee,
} from "../../_support";

/** The watchers fire on a floating promise; let it settle before asserting. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const sendPrivate = (type: RailgunTransaction, over = {}) => {
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

test("a reverted private transfer reports reverted, not mined", async () => {
  const { calls, run } = sendPrivate(RailgunTransaction.Transfer, {
    watchSelf: async () => ({ kind: "reverted" as const }),
  });
  await run();
  await settle();
  assert.equal(calls.mined, undefined, "a reverted transfer reported success");
  assert.ok(calls.reverted, "the revert was never surfaced");
});

test("a reverted relay-adapt batch is not interrogated for a CallError", async () => {
  // A transaction that did not execute has no batch to have failed inside it,
  // and getRelayAdaptFailure returns undefined for a missing log — which would
  // have been read as "the batch completed".
  const { calls, run } = sendPrivate(RailgunTransaction.MorphoVaultDeposit, {
    watchSelf: async () => ({ kind: "reverted" as const }),
  });
  await run();
  await settle();
  assert.equal(calls.failureChecked, undefined);
  assert.equal(calls.mined, undefined);
  assert.ok(calls.reverted);
});

test("an unreadable receipt is reported as unconfirmed, not as either outcome", async () => {
  const { calls, run } = sendPrivate(RailgunTransaction.Transfer, {
    watchSelf: async () => ({
      kind: "unknown" as const,
      reason: "no receipt available",
    }),
  });
  await run();
  await settle();
  assert.equal(calls.mined, undefined, "an unread outcome reported success");
  assert.equal(calls.reverted, undefined, "an unread outcome reported failure");
  assert.equal(calls.unsettled?.reason, "no receipt available");
});

test("a reverted public transfer reports reverted, not mined", async () => {
  const { deps, calls } = makeSendPublicDeps({
    watchSelf: async () => ({ kind: "reverted" as const }),
  });
  await sendPublicTransaction(
    { to: "0x" + "11".repeat(20), data: "0x" },
    NetworkName.Ethereum,
    deps,
  );
  await settle();
  assert.equal(calls.mined, undefined, "a reverted public send reported success");
  assert.ok(calls.reverted, "the revert was never surfaced");
});

test("a clean send still reports mined", async () => {
  const { calls, run } = sendPrivate(RailgunTransaction.Transfer);
  await run();
  await settle();
  assert.ok(calls.mined);
  assert.equal(calls.reverted, undefined);
  assert.equal(calls.unsettled, undefined);
});
