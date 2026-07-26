/**
 * Reserving gas out of the balance a base-token send is spending.
 *
 * A base-token shield or public send pays gas in the same asset it moves, so
 * the wallet needs value + gas. "Send all" against the whole balance leaves
 * nothing for the second term, and the node rejects it — after the user has
 * approved the transaction and, for a shield, after the SDK has built a 7702
 * bundle. Modelling the gas as a reservation puts it through the same path a
 * broadcaster fee already takes: the amount hint, "max", and the send-time
 * overspend check all see it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import {
  gasReservationFor,
  maxAmount,
  overspentTokens,
} from "../../../src/flows/balance";
import { NATIVE_SENTINEL } from "../../../src/flows/native-token";
import { LegsState } from "../../../src/flows/caps";
import { RailgunDisplayBalance } from "../../../src/models/balance-models";

const GWEI = 1_000_000_000n;

const ETH = {
  symbol: "ETH",
  tokenAddress: NATIVE_SENTINEL,
  decimals: 18,
  amount: parseUnits("1", 18),
} as RailgunDisplayBalance;

const legs = (amount?: string): LegsState => ({
  legs: [{ id: "__single", token: ETH, amount }],
  seq: 1,
});

test("the reservation is gas units times the price", () => {
  const reservation = gasReservationFor(NATIVE_SENTINEL, 450_000n, 20n * GWEI);
  assert.ok(reservation);
  assert.equal(reservation.tokenAddress, NATIVE_SENTINEL);
  assert.equal(reservation.amount, 450_000n * 20n * GWEI); // 0.009 ETH
});

test("no price means no reservation, not a zero one", () => {
  // A fee oracle that cannot answer must leave the amount unrestricted rather
  // than reserve nothing and imply the question was asked.
  assert.equal(gasReservationFor(NATIVE_SENTINEL, 450_000n, undefined), undefined);
  assert.equal(gasReservationFor(NATIVE_SENTINEL, 450_000n, 0n), undefined);
  assert.equal(gasReservationFor(undefined, 450_000n, 20n * GWEI), undefined);
});

test('"max" leaves the gas behind', () => {
  const fee = gasReservationFor(NATIVE_SENTINEL, 450_000n, 20n * GWEI);
  const max = maxAmount(ETH, legs(), { editingLegId: "__single", fee });
  assert.equal(max, "0.991"); // 1 ETH − 0.009 gas
});

test("without a reservation max is the whole balance, which cannot pay gas", () => {
  // The behaviour being fixed, asserted so a regression is visible.
  assert.equal(maxAmount(ETH, legs(), { editingLegId: "__single" }), "1.0");
});

test("committing the whole balance is an overspend once gas is reserved", () => {
  const fee = gasReservationFor(NATIVE_SENTINEL, 450_000n, 20n * GWEI);
  const [over] = overspentTokens(legs("1.0"), fee);
  assert.ok(over, "sending the full balance left nothing for gas and was allowed");
  assert.equal(over.overBy, parseUnits("0.009", 18));
});

test("the reservation only touches the token that pays the gas", () => {
  // A multi-leg shield mixes an ERC20 leg with the native one; only the native
  // balance funds gas, so only it is reduced.
  const usdc = {
    symbol: "USDC",
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    amount: parseUnits("100", 6),
  } as RailgunDisplayBalance;
  const fee = gasReservationFor(NATIVE_SENTINEL, 450_000n, 20n * GWEI);
  const mixed: LegsState = {
    legs: [{ id: "a", token: usdc, amount: "100" }],
    seq: 1,
  };
  assert.deepEqual(overspentTokens(mixed, fee), []);
});
