/**
 * Refusing a send whose real broadcaster fee will not fit.
 *
 * While composing, the fee is approximated against a nominal gas figure. The
 * estimate returns the measured one, and for a relay-adapt swap that is several
 * times larger — so a build that looked affordable reaches the SDK and comes
 * back "private balance too low to pay broadcaster fee", after the user has
 * waited for a proof and with no indication of by how much.
 *
 * The measured fee is known before proving. This is the check that uses it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { feeShortfall } from "../../../src/tui/screens/tx-flow-helpers";
import { LegsState } from "../../../src/flows/caps";
import { PrivateGasEstimate } from "../../../src/models/transaction-models";
import { RailgunDisplayBalance } from "../../../src/models/balance-models";

const WETH = {
  symbol: "WETH",
  tokenAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  decimals: 18,
  amount: parseUnits("0.01", 18),
} as RailgunDisplayBalance;

const legs = (amount: string): LegsState => ({
  legs: [{ id: "__single", token: WETH, amount }],
  seq: 1,
});

const estimate = (fee?: bigint): PrivateGasEstimate =>
  ({
    symbol: "WETH",
    estimatedGasDetails: {} as never,
    estimatedCost: 0,
    broadcasterFeeERC20Recipient: fee
      ? { tokenAddress: WETH.tokenAddress, amount: fee, recipientAddress: "0zk" }
      : undefined,
    overallBatchMinGasPrice: 0n,
  }) as PrivateGasEstimate;

test("a fee that fits alongside the amount passes", () => {
  // 0.005 sent + 0.001 fee against a 0.01 balance.
  assert.equal(feeShortfall(legs("0.005"), estimate(parseUnits("0.001", 18))), undefined);
});

test("a fee that pushes past the balance is caught, with the shortfall", () => {
  // 0.009 sent + 0.005 fee against 0.01 — short by 0.004.
  const over = feeShortfall(legs("0.009"), estimate(parseUnits("0.005", 18)));
  assert.ok(over, "the overspend was not detected");
  assert.equal(over.token.symbol, "WETH");
  assert.equal(over.overBy, parseUnits("0.004", 18));
});

test("the whole balance sent leaves nothing for the fee", () => {
  // The case that motivated this: max out, then the real fee arrives.
  const over = feeShortfall(legs("0.01"), estimate(parseUnits("0.0012", 18)));
  assert.ok(over);
  assert.equal(over.overBy, parseUnits("0.0012", 18));
});

test("a self-signed send is not gated", () => {
  // No broadcaster fee — gas is paid publicly and does not touch the private
  // balance, so there is nothing to reserve.
  assert.equal(feeShortfall(legs("0.01"), estimate(undefined)), undefined);
});

test("an under-quoted fee is exactly what this catches", () => {
  // The nominal hint was 350k gas against ~2.5M measured, so the reserved fee
  // was about a seventh of the real one. A build reserving the small figure
  // still fails once the measured fee arrives.
  // Balance 0.01, sending 0.0095. The nominal fee fits; seven times it does not.
  const nominal = parseUnits("0.0002", 18);
  const measured = nominal * 7n;
  assert.equal(
    feeShortfall(legs("0.0095"), estimate(nominal)),
    undefined,
    "the nominal fee should have fit",
  );
  const over = feeShortfall(legs("0.0095"), estimate(measured));
  assert.ok(over, "measured fee not caught");
  assert.equal(over.overBy, parseUnits("0.0009", 18));
});
