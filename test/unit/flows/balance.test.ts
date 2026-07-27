import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { NATIVE_SENTINEL } from "../../../src/flows/native-token";
import { FeeMode } from "../../../src/flows/spec";
import { LegsState } from "../../../src/flows/caps";
import {
  allotted,
  feeReserved,
  feeReservationFor,
  expectedBalance,
  wouldOverspend,
  checkAmount,
  maxAmount,
  formatExpected,
  parseAmount,
  overspentTokens,
} from "../../../src/flows/balance";

const USDC = "0x" + "a".repeat(40);
const WETH = "0x" + "b".repeat(40);
const WBTC = "0x" + "c".repeat(40);

const TOK = (sym: string, addr: string, amount: bigint, decimals = 18) => ({
  symbol: sym,
  name: sym,
  tokenAddress: addr,
  decimals,
  amount,
});

// Build a LegsState directly (mirrors builder-legs Leg shape).
const legsOf = (
  ...legs: { id: string; token?: ReturnType<typeof TOK>; amount?: string; recipient?: string }[]
): LegsState => ({ legs, seq: legs.length });

const broadcasterFee = (tokenAddress: string): FeeMode => ({
  kind: "broadcaster",
  broadcaster: {
    railgunAddress: "0zk1qexample",
    tokenAddress,
    tokenFee: {
      feePerUnitGas: "1",
      expiration: 0,
      feesID: "x",
      availableWallets: 1,
      relayAdapt: "0x",
      reliability: 1,
    },
  },
});

test("parseAmount: blank/invalid → 0n; valid → base units", () => {
  assert.equal(parseAmount(undefined, 18), 0n);
  assert.equal(parseAmount("", 18), 0n);
  assert.equal(parseAmount("  ", 18), 0n);
  assert.equal(parseAmount("not-a-number", 18), 0n);
  assert.equal(parseAmount("0", 18), 0n);
  assert.equal(parseAmount("1.5", 6), parseUnits("1.5", 6));
});

test("allotted sums same-token sibling legs and EXCLUDES the editing leg", () => {
  const legs = legsOf(
    { id: "leg-0", token: TOK("USDC", USDC, 0n, 6), amount: "10" },
    { id: "leg-1", token: TOK("USDC", USDC, 0n, 6), amount: "5" },
    { id: "leg-2", token: TOK("WETH", WETH, 0n), amount: "1" },
  );
  // No editing leg: both USDC legs counted.
  assert.equal(allotted(legs, USDC), parseUnits("15", 6));
  // Editing leg-1: only leg-0 counts.
  assert.equal(allotted(legs, USDC, "leg-1"), parseUnits("10", 6));
  // Different token isolated.
  assert.equal(allotted(legs, WETH), parseUnits("1", 18));
});

test("allotted matches token address case-insensitively", () => {
  const legs = legsOf({
    id: "leg-0",
    token: TOK("USDC", USDC.toUpperCase(), 0n, 6),
    amount: "3",
  });
  assert.equal(allotted(legs, USDC), parseUnits("3", 6));
});

test("feeReserved: broadcaster fee in the SAME token reserves; other token → 0", () => {
  const fee = { tokenAddress: USDC, amount: parseUnits("2", 6) };
  assert.equal(feeReserved(fee, USDC), parseUnits("2", 6));
  assert.equal(feeReserved(fee, WETH), 0n);
  assert.equal(feeReserved(undefined, USDC), 0n);
});

test("feeReservationFor: only broadcaster mode reserves; self/external → undefined", () => {
  assert.deepEqual(feeReservationFor(broadcasterFee(USDC), parseUnits("2", 6)), {
    tokenAddress: USDC,
    amount: parseUnits("2", 6),
  });
  // Broadcaster but zero/unknown fee → no reservation.
  assert.equal(feeReservationFor(broadcasterFee(USDC), 0n), undefined);
  assert.equal(feeReservationFor(broadcasterFee(USDC), undefined), undefined);
  const selfSign: FeeMode = { kind: "self-signer", signer: {} as never };
  assert.equal(feeReservationFor(selfSign, parseUnits("2", 6)), undefined);
  const external: FeeMode = { kind: "external-signer", label: "cold" };
  assert.equal(feeReservationFor(external, parseUnits("2", 6)), undefined);
  assert.equal(feeReservationFor(undefined, parseUnits("2", 6)), undefined);
});

test("expectedBalance = walletBalance - alloted(siblings) - sameTokenFee", () => {
  const token = TOK("USDC", USDC, parseUnits("100", 6), 6);
  const legs = legsOf(
    { id: "leg-0", token, amount: "30" }, // editing this one
    { id: "leg-1", token, amount: "20" }, // sibling
  );
  const fee = { tokenAddress: USDC, amount: parseUnits("5", 6) };
  // 100 - 20 (sibling) - 5 (fee) = 75 headroom for leg-0.
  assert.equal(
    expectedBalance(token, legs, { editingLegId: "leg-0", fee }),
    parseUnits("75", 6),
  );
});

test("self-sign fee does NOT reduce the private balance", () => {
  const token = TOK("USDC", USDC, parseUnits("100", 6), 6);
  const legs = legsOf({ id: "leg-0", token, amount: "0" });
  // No fee reservation passed (self-sign) → full balance is headroom.
  assert.equal(
    expectedBalance(token, legs, { editingLegId: "leg-0" }),
    parseUnits("100", 6),
  );
});

test("native ETH and WETH are separate pools (sentinel vs ERC20)", () => {
  const native = TOK("ETH", NATIVE_SENTINEL, parseUnits("2", 18));
  const weth = TOK("WETH", WETH, parseUnits("3", 18));
  const legs = legsOf(
    { id: "leg-0", token: native, amount: "1" },
    { id: "leg-1", token: weth, amount: "1" },
  );
  // Native headroom ignores the WETH leg and vice versa.
  assert.equal(expectedBalance(native, legs, { editingLegId: "leg-0" }), parseUnits("2", 18));
  assert.equal(expectedBalance(weth, legs, { editingLegId: "leg-1" }), parseUnits("3", 18));
});

test("overspend boundary: exact balance ok, +1 base unit over", () => {
  const token = TOK("USDC", USDC, parseUnits("10", 6), 6);
  const legs = legsOf({ id: "leg-0", token });
  const expected = expectedBalance(token, legs, { editingLegId: "leg-0" });
  assert.equal(wouldOverspend(expected, parseUnits("10", 6)), false); // exact
  assert.equal(wouldOverspend(expected, parseUnits("10", 6) + 1n), true); // +1 unit
});

test("checkAmount reports expected, entered and overspendBy", () => {
  const token = TOK("USDC", USDC, parseUnits("10", 6), 6);
  const legs = legsOf({ id: "leg-0", token, amount: "12" });
  const c = checkAmount(token, "12", legs, { editingLegId: "leg-0" });
  assert.equal(c.expected, parseUnits("10", 6));
  assert.equal(c.entered, parseUnits("12", 6));
  assert.equal(c.overspendBy, parseUnits("2", 6));
  assert.equal(c.ok, false);

  const ok = checkAmount(token, "8", legs, { editingLegId: "leg-0" });
  assert.equal(ok.ok, true);
  assert.equal(ok.overspendBy, undefined);
});

test("checkAmount: blank amount against positive headroom is ok", () => {
  const token = TOK("USDC", USDC, parseUnits("10", 6), 6);
  const legs = legsOf({ id: "leg-0", token });
  const c = checkAmount(token, "", legs, { editingLegId: "leg-0" });
  assert.equal(c.ok, true);
  assert.equal(c.entered, 0n);
});

test("maxAmount returns the spendable headroom; clamps negative to 0", () => {
  const token = TOK("USDC", USDC, parseUnits("100", 6), 6);
  const legs = legsOf(
    { id: "leg-0", token }, // editing
    { id: "leg-1", token, amount: "40" }, // sibling
  );
  const fee = { tokenAddress: USDC, amount: parseUnits("10", 6) };
  assert.equal(maxAmount(token, legs, { editingLegId: "leg-0", fee }), "50.0");

  // Siblings + fee exceed balance → headroom clamps to 0.
  const overcommitted = legsOf(
    { id: "leg-0", token },
    { id: "leg-1", token, amount: "200" },
  );
  assert.equal(maxAmount(token, overcommitted, { editingLegId: "leg-0" }), "0.0");
});

test("overspentTokens flags tokens whose total commitment exceeds balance", () => {
  const usdc = TOK("USDC", USDC, parseUnits("100", 6), 6);
  const weth = TOK("WETH", WETH, parseUnits("1", 18));
  const legs = legsOf(
    { id: "leg-0", token: usdc, amount: "60" },
    { id: "leg-1", token: usdc, amount: "60" }, // 120 > 100 → over by 20
    { id: "leg-2", token: weth, amount: "0.5" }, // fine
  );
  const over = overspentTokens(legs);
  assert.equal(over.length, 1);
  assert.equal(over[0].token.symbol, "USDC");
  assert.equal(over[0].overBy, parseUnits("20", 6));
});

test("overspentTokens counts a same-token broadcaster fee", () => {
  const usdc = TOK("USDC", USDC, parseUnits("100", 6), 6);
  const legs = legsOf({ id: "leg-0", token: usdc, amount: "100" }); // exactly balance
  // No fee → ok.
  assert.equal(overspentTokens(legs).length, 0);
  // Fee in the same token pushes it over.
  const fee = { tokenAddress: USDC, amount: parseUnits("1", 6) };
  const over = overspentTokens(legs, fee);
  assert.equal(over.length, 1);
  assert.equal(over[0].overBy, parseUnits("1", 6));
});

test("overspentTokens ignores a fee paid in a non-leg token (advisory only)", () => {
  const weth = TOK("WETH", WETH, parseUnits("1", 18));
  const legs = legsOf({ id: "leg-0", token: weth, amount: "1" }); // exactly balance
  const feeInUsdc = { tokenAddress: USDC, amount: parseUnits("5", 6) };
  assert.equal(overspentTokens(legs, feeInUsdc).length, 0);
});

test("formatExpected renders headroom and over-by suffix", () => {
  const token = TOK("USDC", USDC, parseUnits("10", 6), 6);
  const legs = legsOf({ id: "leg-0", token, amount: "12" });
  const over = checkAmount(token, "12", legs, { editingLegId: "leg-0" });
  assert.equal(formatExpected(over, token), "expected 10.0 USDC · over by 2.0 USDC");
  const ok = checkAmount(token, "5", legs, { editingLegId: "leg-0" });
  assert.equal(formatExpected(ok, token), "expected 10.0 USDC");
});

// --- the fee's own balance ----------------------------------------------

test("a fee in a token no leg carries is still weighed against its balance", () => {
  // The reported failure: 0.00001 WBTC held, a 0.000146 WBTC fee, and nothing
  // said a word until the proof. `overspentTokens` walked the tokens being
  // SENT, so a fee drawing on a balance of its own was never checked at all.
  const legs = legsOf({
    id: "a",
    token: TOK("USDC", USDC, parseUnits("100", 6), 6),
    amount: "10",
    recipient: "0zk1abc",
  });
  const feeToken = TOK("WBTC", WBTC, parseUnits("0.00001", 8), 8);
  const over = overspentTokens(legs, {
    tokenAddress: WBTC,
    amount: parseUnits("0.000146", 8),
    token: feeToken,
  });

  assert.equal(over.length, 1, "a fee larger than its own balance went unnoticed");
  assert.equal(over[0].token.symbol, "WBTC");
  assert.equal(over[0].causedByFee, true);
  assert.equal(over[0].feeShare, parseUnits("0.000146", 8));
  assert.equal(over[0].overBy, parseUnits("0.000136", 8));
});

test("without the fee token's balance nothing is claimed about it", () => {
  // A fee token missing from the flow's list is not evidence of a zero
  // balance, and inventing one would refuse a send that is fine.
  const legs = legsOf({
    id: "a",
    token: TOK("USDC", USDC, parseUnits("100", 6), 6),
    amount: "10",
    recipient: "0zk1abc",
  });
  const over = overspentTokens(legs, {
    tokenAddress: WBTC,
    amount: parseUnits("0.000146", 8),
  });
  assert.deepEqual(over, [], "a fee with no known balance was reported as an overspend");
});

test("the cause is named: the amount, or the fee that took it over", () => {
  // Two different problems with two different answers — send less, or pay the
  // fee in something else — and "over by X" alone says neither.
  const spendable = TOK("USDC", USDC, parseUnits("100", 6), 6);

  // Asked for more than exists, with no fee involved.
  const byChoice = overspentTokens(
    legsOf({ id: "a", token: spendable, amount: "150", recipient: "0zk1abc" }),
    undefined,
  );
  assert.equal(byChoice[0].causedByFee, false);
  assert.equal(byChoice[0].feeShare, 0n);

  // The amount fits on its own; the fee is what does not.
  const byFee = overspentTokens(
    legsOf({ id: "a", token: spendable, amount: "100", recipient: "0zk1abc" }),
    { tokenAddress: USDC, amount: parseUnits("5", 6), token: spendable },
  );
  assert.equal(byFee[0].causedByFee, true);
  assert.equal(byFee[0].overBy, parseUnits("5", 6));
});
