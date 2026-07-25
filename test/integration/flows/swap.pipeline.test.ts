import { test } from "node:test";
import assert from "node:assert/strict";
import { swapToCrossContractInputs } from "../../../src/flows/deps/swap";
import { runTransaction } from "../../../src/flows/run";
import { CrossContractSpec } from "../../../src/flows/deps/cross-contract";
import { Zer0XSwap } from "../../../src/models/0x-models";
import {
  collectEvents,
  makeCrossContractRunDeps,
  crossContractSpec,
  privateGasEstimate,
} from "../../_support";


test("a 0x quote reduces to the generic cross-contract inputs", () => {
  const calls = [{ to: "0xrouter", data: "0xswap" }];
  const swap = {
    relayAdaptUnshieldERC20Amounts: [],
    relayAdaptShieldERC20Addresses: [],
    crossContractCalls: calls,
    minGasLimit: 500_000n,
  } as unknown as Zer0XSwap;

  const inputs = swapToCrossContractInputs(swap);
  assert.deepEqual(inputs.crossContractCalls, calls);
  assert.equal(inputs.minGasLimit, 500_000n);
  assert.deepEqual(inputs.relayAdaptShieldERC20Addresses, []);
});

test("swap pipeline: estimate→prove(progress)→send drives through runTransaction", async () => {
  const spec = crossContractSpec();
  const { emit, phases, byType, result } = collectEvents();

  let estimated: CrossContractSpec | undefined;
  const out = await runTransaction(
    spec,
    makeCrossContractRunDeps({
      estimateGas: async (s) => {
        estimated = s;
        return privateGasEstimate();
      },
    }),
    emit,
  );

  assert.deepEqual(out, {
    ok: true,
    result: { hash: "0xswapHash", url: "https://scan/0xswapHash" },
  });
  // prove: initial pct:0 + onProgress(50) + onProgress(100) = three prove emits.
  assert.deepEqual(phases(), ["estimate", "prove", "prove", "prove", "send"]);
  assert.equal(estimated, spec, "the cross-contract spec reaches estimateGas");

  const prove = byType("tx:progress").filter((e) => e.phase === "prove");
  assert.ok(prove.some((e) => e.message === "proving swap" && e.pct === 50));
  assert.ok(prove.some((e) => e.pct === 100));
  assert.equal(result()?.hash, "0xswapHash");
});
