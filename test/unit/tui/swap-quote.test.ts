/**
 * Which quote a swap actually spends against.
 *
 * The builder fetched a quote to show a rate, and submit fetched another one to
 * build the transaction. Two fetches, seconds apart, and the second one decided
 * whether the send happened at all — so a quote could appear on the review and
 * the send still fail with "no swap quote for that pair".
 *
 * The carried quote is keyed to the inputs it was fetched for, so it is reused
 * only when nothing that defines the trade has moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  swapQuoteKey,
  swapQuoteUsable,
  SWAP_QUOTE_TTL_MS,
  BuilderState,
} from "../../../src/tui/screens/tx-builder-core";
import { RailgunDisplayBalance } from "../../../src/models/balance-models";

const token = (address: string): RailgunDisplayBalance =>
  ({ tokenAddress: address, symbol: address, decimals: 18, amount: 0n }) as RailgunDisplayBalance;

const base = (): BuilderState => ({
  gas: undefined,
  token: token("0xsell"),
  buyToken: token("0xbuy"),
  amount: "1.5",
  address: "0zkdest",
});

test("the same trade produces the same key", () => {
  assert.equal(swapQuoteKey(base()), swapQuoteKey(base()));
});

test("every input that defines the trade changes the key", () => {
  const start = swapQuoteKey(base());
  const variants: [string, Partial<BuilderState>][] = [
    ["sell token", { token: token("0xother") }],
    ["buy token", { buyToken: token("0xother") }],
    ["amount", { amount: "2" }],
    ["destination", { address: "0zkelsewhere" }],
  ];
  for (const [what, patch] of variants) {
    assert.notEqual(
      swapQuoteKey({ ...base(), ...patch }),
      start,
      `changing the ${what} must invalidate the carried quote`,
    );
  }
});

test("an unrelated field does not invalidate the quote", () => {
  // Gas and fee do not change what is being traded, so re-quoting on them would
  // throw away a good quote for nothing.
  const start = swapQuoteKey(base());
  assert.equal(swapQuoteKey({ ...base(), memo: "hello" }), start);
  assert.equal(swapQuoteKey({ ...base(), showSender: true }), start);
});

test("a half-filled build still keys without throwing", () => {
  // The key is computed while the form is being filled in.
  assert.equal(typeof swapQuoteKey({ gas: undefined }), "string");
  assert.notEqual(
    swapQuoteKey({ gas: undefined }),
    swapQuoteKey({ gas: undefined, amount: "1" }),
  );
});

test("a missing field cannot collide with a filled one", () => {
  // Joining on a separator matters: without it, {amount:"1", address:"2"} and
  // {amount:"12"} would produce the same key and reuse the wrong quote.
  const a: BuilderState = { gas: undefined, amount: "1", address: "2" };
  const b: BuilderState = { gas: undefined, amount: "12" };
  assert.notEqual(swapQuoteKey(a), swapQuoteKey(b));
});
