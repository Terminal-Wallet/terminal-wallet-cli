/**
 * A gate refusal and a change of mind are not the same event.
 *
 * `runTransaction` turns every falsy `confirm` into one sentinel —
 * `{ ok: false, error: "cancelled" }` — so by the time a caller sees the result
 * there is nothing left to tell them apart. The deck can live with that: both
 * mean "no transaction", and the reason was already written to the status line
 * on the way past. A scripted caller cannot, because one of them is a usage
 * problem worth reporting differently and neither is worth blindly retrying.
 *
 * So the gate says why BEFORE it returns false. These tests pin that, and pin
 * that the sentinel still swallows the distinction downstream — the second half
 * is the reason the first half has to exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { NetworkName } from "@railgun-community/shared-models";
import {
  GateRefusal,
  applyGasDetailsConfirm,
} from "../../../src/flows/confirm";
import { LegsState } from "../../../src/flows/caps";
import { runTransaction } from "../../../src/flows/run";
import { PrivateGasEstimate } from "../../../src/models/transaction-models";
import { setInputProvider } from "../../../src/core/input";
import { createStubInputProvider } from "../../_support/stubs/input-provider";

const CHAIN = NetworkName.Ethereum;
const WETH = {
  tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
  amount: parseUnits("0.01", 18),
};

/** A build that spends nearly the whole balance, so any fee overflows it. */
const legs = (amount: string): LegsState => ({
  legs: [{ id: "l1", token: WETH, amount }],
  seq: 1,
});

const estimate = (feeAmount: bigint): PrivateGasEstimate =>
  ({
    estimatedGasDetails: { evmGasType: 2, gasEstimate: 1_000_000n },
    estimatedCost: 0.01,
    symbol: "ETH",
    broadcasterFeeERC20Recipient: {
      tokenAddress: WETH.tokenAddress,
      amount: feeAmount,
      recipientAddress: "0zk1broadcaster",
    },
  }) as unknown as PrivateGasEstimate;

test("the gate reports its reason before returning false", () => {
  const seen: GateRefusal[] = [];
  const gate = applyGasDetailsConfirm("keep", legs("0.0095"), {
    onRefuse: (r) => seen.push(r),
    notify: false,
  });
  return gate({ chainName: CHAIN }, estimate(parseUnits("0.001", 18))).then(
    (ok) => {
      assert.equal(ok, false);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].kind, "fee-shortfall");
      assert.match(seen[0].message, /WETH short by/);
      assert.equal(seen[0].overspend.token.symbol, "WETH");
    },
  );
});

test("a build the fee fits inside is not refused and reports nothing", async () => {
  const seen: GateRefusal[] = [];
  const gate = applyGasDetailsConfirm("keep", legs("0.005"), {
    onRefuse: (r) => seen.push(r),
    notify: false,
  });
  assert.equal(await gate({ chainName: CHAIN }, estimate(parseUnits("0.001", 18))), true);
  assert.deepEqual(seen, []);
});

test("notify is on by default, so the deck keeps its status line", async () => {
  const notices: string[] = [];
  setInputProvider(createStubInputProvider({ notices, confirmAll: true }));
  const gate = applyGasDetailsConfirm("keep", legs("0.0095"));
  assert.equal(await gate({ chainName: CHAIN }, estimate(parseUnits("0.001", 18))), false);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /short by/);
});

test("notify:false reports once, not twice", async () => {
  const notices: string[] = [];
  setInputProvider(createStubInputProvider({ notices, confirmAll: true }));
  const seen: GateRefusal[] = [];
  const gate = applyGasDetailsConfirm("keep", legs("0.0095"), {
    onRefuse: (r) => seen.push(r),
    notify: false,
  });
  await gate({ chainName: CHAIN }, estimate(parseUnits("0.001", 18)));
  assert.equal(seen.length, 1);
  assert.deepEqual(notices, [], "the refusal was emitted through both channels");
});

test("CONTROL: without onRefuse, the pipeline result cannot tell you why", async () => {
  // This is the defect the seam exists for, demonstrated rather than described.
  // Both runs below produce the identical RunResult, and only one of them is a
  // fee problem.
  setInputProvider(createStubInputProvider({ notices: [], confirmAll: true }));

  const fromGate = await runTransaction(
    { chainName: CHAIN },
    {
      estimateGas: async () => estimate(parseUnits("0.001", 18)),
      confirm: applyGasDetailsConfirm("keep", legs("0.0095")),
      send: async () => ({ hash: "0xdead" }),
    },
    () => undefined,
  );

  const fromDecline = await runTransaction(
    { chainName: CHAIN },
    {
      estimateGas: async () => estimate(parseUnits("0.001", 18)),
      confirm: async () => false,
      send: async () => ({ hash: "0xdead" }),
    },
    () => undefined,
  );

  assert.deepEqual(fromGate, fromDecline);
  assert.deepEqual(fromGate, { ok: false, error: "cancelled" });
});

test("CONTROL: with onRefuse, the two become distinguishable again", async () => {
  setInputProvider(createStubInputProvider({ notices: [], confirmAll: true }));
  let refusal: GateRefusal | undefined;

  const fromGate = await runTransaction(
    { chainName: CHAIN },
    {
      estimateGas: async () => estimate(parseUnits("0.001", 18)),
      confirm: applyGasDetailsConfirm("keep", legs("0.0095"), {
        onRefuse: (r) => {
          refusal = r;
        },
        notify: false,
      }),
      send: async () => ({ hash: "0xdead" }),
    },
    () => undefined,
  );

  // The result is still the sentinel — nothing about runTransaction changed.
  assert.deepEqual(fromGate, { ok: false, error: "cancelled" });
  // But the caller now holds the reason the sentinel dropped.
  assert.equal(refusal?.kind, "fee-shortfall");
});

test("CONTROL: nothing is proved or sent when the gate refuses", async () => {
  // The whole point of refusing here rather than letting the SDK do it: a proof
  // is the expensive part, and it happens after this.
  setInputProvider(createStubInputProvider({ notices: [], confirmAll: true }));
  let proved = 0;
  let sent = 0;

  await runTransaction(
    { chainName: CHAIN },
    {
      estimateGas: async () => estimate(parseUnits("0.001", 18)),
      confirm: applyGasDetailsConfirm("keep", legs("0.0095"), { notify: false }),
      prove: async () => {
        proved += 1;
        return {};
      },
      send: async () => {
        sent += 1;
        return { hash: "0xdead" };
      },
    },
    () => undefined,
  );

  assert.equal(proved, 0, "a proof was generated for a refused send");
  assert.equal(sent, 0, "a refused send was broadcast");
});
