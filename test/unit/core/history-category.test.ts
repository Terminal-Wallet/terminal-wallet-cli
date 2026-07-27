/**
 * What the activity feed calls a 7702 bundle.
 *
 * A private swap unshields one token and receives a different one back into
 * the same wallet in one transaction. That fits none of the five categories
 * the SDK reports, so it arrives as `Unknown` and the feed showed "Activity" —
 * the least informative label available, on one of the largest things the
 * wallet does.
 *
 * There is no relay-adapt flag on a history item, so the only thing to read is
 * the shape. The trap is change: it comes back in the SAME token it left in,
 * so "unshielded something and received something" is not enough on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TransactionHistoryItemCategory } from "@railgun-community/shared-models";
import { categoryLabel, looksLikeSwap } from "../../../src/core/history-map";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";

const amount = (tokenAddress: string) => ({ tokenAddress, amount: 1n });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const item = (over: Record<string, unknown>): any => ({
  txid: "0xabc",
  version: 2,
  timestamp: 0,
  blockNumber: 1,
  receiveERC20Amounts: [],
  transferERC20Amounts: [],
  changeERC20Amounts: [],
  unshieldERC20Amounts: [],
  receiveNFTAmounts: [],
  transferNFTAmounts: [],
  unshieldNFTAmounts: [],
  category: TransactionHistoryItemCategory.Unknown,
  ...over,
});

test("a swap is one, not 'Activity'", () => {
  const swap = item({
    unshieldERC20Amounts: [amount(WETH)],
    receiveERC20Amounts: [amount(DAI)],
  });
  assert.equal(looksLikeSwap(swap), true);
  assert.equal(categoryLabel(swap), "Swap");
});

test("an unshield that returns change is not a swap", () => {
  // The trap: change comes back in the token it left in, so "unshielded and
  // received" describes an ordinary unshield too.
  const withChange = item({
    unshieldERC20Amounts: [amount(WETH)],
    receiveERC20Amounts: [amount(WETH)],
  });
  assert.equal(looksLikeSwap(withChange), false);
  assert.equal(categoryLabel(withChange), "Activity");
});

test("the categories the SDK does report are left alone", () => {
  for (const [category, label] of [
    [TransactionHistoryItemCategory.ShieldERC20s, "Shield"],
    [TransactionHistoryItemCategory.UnshieldERC20s, "Unshield"],
    [TransactionHistoryItemCategory.TransferSendERC20s, "Send"],
    [TransactionHistoryItemCategory.TransferReceiveERC20s, "Receive"],
  ] as const) {
    // Even when the shape would otherwise read as a swap: a category the SDK
    // is sure of outranks a guess from the amounts.
    const known = item({
      category,
      unshieldERC20Amounts: [amount(WETH)],
      receiveERC20Amounts: [amount(DAI)],
    });
    assert.equal(categoryLabel(known), label);
  }
});

test("an unclassifiable bundle that is not a swap stays 'Activity'", () => {
  assert.equal(categoryLabel(item({})), "Activity");
  assert.equal(categoryLabel(item({ unshieldERC20Amounts: [amount(WETH)] })), "Activity");
});
