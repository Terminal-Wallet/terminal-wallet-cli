import { test } from "node:test";
import assert from "node:assert/strict";
import { getERC20AmountRecipients, useRelayAdapt } from "../../../src/flows/spec";
import { RailgunTransaction } from "../../../src/models/transaction-models";
import { RailgunSelectedAmount } from "../../../src/models/balance-models";

const sel = (
  tokenAddress: string,
  selectedAmount: bigint,
  recipientAddress: string,
): RailgunSelectedAmount =>
  ({ tokenAddress, selectedAmount, recipientAddress }) as RailgunSelectedAmount;

test("getERC20AmountRecipients sums amounts for the same token+recipient", () => {
  const out = getERC20AmountRecipients([
    sel("0xT", 100n, "0xR"),
    sel("0xT", 50n, "0xR"),
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { tokenAddress: "0xT", amount: 150n, recipientAddress: "0xR" });
});

test("different recipients (or tokens) stay separate", () => {
  const out = getERC20AmountRecipients([
    sel("0xT", 100n, "0xR1"),
    sel("0xT", 50n, "0xR2"),
    sel("0xU", 25n, "0xR1"),
  ]);
  assert.equal(out.length, 3);
  const total = out.reduce((n, r) => n + r.amount, 0n);
  assert.equal(total, 175n);
});

test("empty input yields no recipients", () => {
  assert.deepEqual(getERC20AmountRecipients([]), []);
});

test("useRelayAdapt is true only for base-token unshield and private swap", () => {
  assert.equal(useRelayAdapt(RailgunTransaction.UnshieldBase), true);
  assert.equal(useRelayAdapt(RailgunTransaction.Private0XSwap), true);
  assert.equal(useRelayAdapt(RailgunTransaction.Transfer), false);
  assert.equal(useRelayAdapt(RailgunTransaction.Unshield), false);
  assert.equal(useRelayAdapt(RailgunTransaction.Public0XSwap), false);
});
