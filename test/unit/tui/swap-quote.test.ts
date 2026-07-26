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


/**
 * Quote freshness.
 *
 * A 0x quote is baked calldata for a route that existed when it was fetched and
 * a taker it named. Spending against a stale one reverts the gas estimate, and
 * that surfaces as "RelayAdapt multicall failed at index UNKNOWN." — a message
 * that says nothing about the quote being old. So age is bounded here rather
 * than discovered on chain.
 */

const carried = (over: Partial<{ forKey: string; at: number }> = {}) => ({
  forKey: swapQuoteKey(base()),
  at: 1_000_000,
  ...over,
});

test("a fresh quote for the same trade is usable", () => {
  assert.equal(swapQuoteUsable(carried(), base(), 1_000_000 + 5_000), true);
});

test("a quote past its lifetime is not", () => {
  assert.equal(
    swapQuoteUsable(carried(), base(), 1_000_000 + SWAP_QUOTE_TTL_MS + 1),
    false,
  );
});

test("the boundary is exclusive", () => {
  assert.equal(swapQuoteUsable(carried(), base(), 1_000_000 + SWAP_QUOTE_TTL_MS - 1), true);
  assert.equal(swapQuoteUsable(carried(), base(), 1_000_000 + SWAP_QUOTE_TTL_MS), false);
});

test("a quote stamped in the future is refused", () => {
  // A clock that stepped backwards must not make a quote immortal.
  assert.equal(swapQuoteUsable(carried(), base(), 999_000), false);
});

test("freshness does not rescue a quote for a different trade", () => {
  const changed = { ...base(), amount: "99" };
  assert.equal(swapQuoteUsable(carried(), changed, 1_000_000 + 1), false);
});

test("no carried quote is not usable", () => {
  assert.equal(swapQuoteUsable(undefined, base(), 1_000_000), false);
});
