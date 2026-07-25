import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import { buildTransferSpec } from "../../../src/flows/transfer-flow";
import { runTransaction } from "../../../src/flows/run";
import { TransferSpec } from "../../../src/flows/spec";
import {
  collectEvents,
  makeRunDeps,
  erc20Recipient,
  selfSignerFee,
} from "../../_support";


test("transfer: a built spec drives estimate→prove→send and flows through to the deps", async () => {
  const spec = buildTransferSpec({
    chainName: NetworkName.Ethereum,
    recipients: [erc20Recipient()],
    encryptionKey: "ek",
    fee: selfSignerFee(),
    memo: "gm",
  });

  const { emit, phases, result } = collectEvents();
  let estimated: TransferSpec | undefined;
  let provedSpec: TransferSpec | undefined;
  const out = await runTransaction(
    spec,
    makeRunDeps<TransferSpec>({
      estimateGas: async (s) => {
        estimated = s;
        return { fee: 1 };
      },
      prove: async (s, _g, onProgress) => {
        provedSpec = s;
        onProgress(100);
        return { proof: "0xproof" };
      },
    }),
    emit,
  );

  assert.equal(out.ok, true);
  // prove emits an initial pct:0 then one per onProgress (here a single 100).
  assert.deepEqual(phases(), ["estimate", "prove", "prove", "send"]);
  assert.equal(result()?.ok, true);
  // the exact spec object reaches both estimate and prove (no copy/mutation)
  assert.equal(estimated, spec);
  assert.equal(provedSpec, spec);
  assert.equal(estimated?.memo, "gm");
  assert.equal(estimated?.recipients.length, 1);
});
