import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import { ContractTransaction } from "ethers";
import { sendPublicTransaction } from "../../../src/flows/send-public";
import { makeSendPublicDeps } from "../../_support";

const flush = () => new Promise<void>((r) => setImmediate(r));
const populated = { to: "0xto", data: "0xdata" } as unknown as ContractTransaction;

test("signs the populated tx with the current wallet and returns hash/url", async () => {
  const { deps, calls } = makeSendPublicDeps();
  const out = await sendPublicTransaction(populated, NetworkName.Ethereum, deps);

  assert.deepEqual(out, {
    hash: "0xpublicHash",
    url: "https://scan/0xpublicHash",
  });
  assert.deepEqual(calls.sent, populated);
  assert.equal(calls.reset, 1, "balance scan reset after submit (parity)");
  assert.deepEqual(calls.watched, { hash: "0xpublicHash" });
});

test("post-submit watch resolves into a mined notification", async () => {
  const { deps, calls } = makeSendPublicDeps();
  await sendPublicTransaction(populated, NetworkName.Ethereum, deps);
  await flush();
  assert.deepEqual(calls.mined, {
    chain: NetworkName.Ethereum,
    hash: "0xpublicHash",
  });
});
