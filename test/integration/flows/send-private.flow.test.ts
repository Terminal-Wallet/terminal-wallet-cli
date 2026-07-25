import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import { sendPrivateTransaction } from "../../../src/flows/send-private";
import { RailgunTransaction } from "../../../src/models/transaction-models";
import {
  makeSendPrivateDeps,
  broadcasterFee,
  selfSignerFee,
  externalSignerFee,
  provedTransaction,
} from "../../_support";

const proved = provedTransaction();

/** Flush the fire-and-forget watch→notifyMined microtask chain. */
const flush = () => new Promise<void>((r) => setImmediate(r));

test("broadcaster path builds the relay tx with feesID + address and returns hash/url", async () => {
  const { deps, calls } = makeSendPrivateDeps();
  const out = await sendPrivateTransaction(
    proved,
    broadcasterFee(),
    NetworkName.Ethereum,
    RailgunTransaction.Transfer,
    deps,
  );
  assert.deepEqual(out, {
    hash: "0xbroadcastHash",
    url: "https://scan/0xbroadcastHash",
  });
  assert.equal((calls.broadcast?.tx as { feesID?: string }).feesID, "fee-123");
  assert.equal(
    (calls.broadcast?.tx as { selectedBroadcasterAddress?: string })
      .selectedBroadcasterAddress,
    "0zkBroadcaster",
  );
  assert.equal(calls.broadcast?.relayAdapt, false, "Transfer does not use relay-adapt");
  assert.equal(calls.signer, undefined, "self-signer path must not run");
  assert.equal(calls.reset, 1, "balance scan reset after submit (parity)");
  assert.deepEqual(calls.watched, { kind: "relayed", hash: "0xbroadcastHash" });
});

test("UnshieldBase uses relay-adapt on the broadcaster path", async () => {
  const { deps, calls } = makeSendPrivateDeps();
  await sendPrivateTransaction(
    proved,
    broadcasterFee(),
    NetworkName.Ethereum,
    RailgunTransaction.UnshieldBase,
    deps,
  );
  assert.equal(calls.broadcast?.relayAdapt, true);
});

test("self-signer path signs the inner transaction and returns hash/url", async () => {
  const { deps, calls } = makeSendPrivateDeps();
  const out = await sendPrivateTransaction(
    proved,
    selfSignerFee(),
    NetworkName.Ethereum,
    RailgunTransaction.Transfer,
    deps,
  );
  assert.deepEqual(out, { hash: "0xselfHash", url: "https://scan/0xselfHash" });
  assert.deepEqual(calls.sent, proved.transaction);
  assert.equal(calls.broadcast, undefined, "broadcaster path must not run");
  assert.equal(calls.externalSigner, undefined, "external path must not run");
});

test("external-signer path signs with the imported key and returns hash/url", async () => {
  const { deps, calls } = makeSendPrivateDeps();
  const out = await sendPrivateTransaction(
    proved,
    externalSignerFee("my-key"),
    NetworkName.Ethereum,
    RailgunTransaction.Transfer,
    deps,
  );
  assert.deepEqual(out, {
    hash: "0xexternalHash",
    url: "https://scan/0xexternalHash",
  });
  assert.equal(calls.externalSigner?.label, "my-key");
  assert.deepEqual(calls.sent, proved.transaction);
  assert.equal(calls.broadcast, undefined, "broadcaster path must not run");
  assert.equal(calls.signer, undefined, "current-wallet self-sign must not run");
});

test("post-submit watch resolves into a mined notification (broadcaster)", async () => {
  const { deps, calls } = makeSendPrivateDeps();
  await sendPrivateTransaction(
    proved,
    broadcasterFee(),
    NetworkName.Ethereum,
    RailgunTransaction.Transfer,
    deps,
  );
  await flush();
  assert.deepEqual(calls.mined, {
    chain: NetworkName.Ethereum,
    hash: "0xbroadcastHash",
  });
});
