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
import { NetworkName } from "@railgun-community/shared-models";
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

const USDC = {
  symbol: "USDC",
  tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  decimals: 6,
  amount: parseUnits("5", 6),
} as RailgunDisplayBalance;

const CHAIN = NetworkName.Ethereum;

const legs = (amount: string): LegsState => ({
  legs: [{ id: "__single", token: WETH, amount }],
  seq: 1,
});

const estimate = (
  fee?: bigint,
  token: RailgunDisplayBalance = WETH,
): PrivateGasEstimate =>
  ({
    symbol: token.symbol,
    estimatedGasDetails: {} as never,
    estimatedCost: 0,
    broadcasterFeeERC20Recipient: fee
      ? { tokenAddress: token.tokenAddress, amount: fee, recipientAddress: "0zk" }
      : undefined,
    overallBatchMinGasPrice: 0n,
  }) as PrivateGasEstimate;

/** Balances the wallet would report; the check never reaches an engine. */
const holding = (...tokens: RailgunDisplayBalance[]) =>
  async () => tokens;

test("a fee that fits alongside the amount passes", async () => {
  // 0.005 sent + 0.001 fee against a 0.01 balance.
  assert.equal(
    await feeShortfall(legs("0.005"), estimate(parseUnits("0.001", 18)), CHAIN),
    undefined,
  );
});

test("a fee that pushes past the balance is caught, with the shortfall", async () => {
  // 0.009 sent + 0.005 fee against 0.01 — short by 0.004.
  const over = await feeShortfall(
    legs("0.009"),
    estimate(parseUnits("0.005", 18)),
    CHAIN,
  );
  assert.ok(over, "the overspend was not detected");
  assert.equal(over.token.symbol, "WETH");
  assert.equal(over.overBy, parseUnits("0.004", 18));
});

test("the whole balance sent leaves nothing for the fee", async () => {
  // The case that motivated this: max out, then the real fee arrives.
  const over = await feeShortfall(
    legs("0.01"),
    estimate(parseUnits("0.0012", 18)),
    CHAIN,
  );
  assert.ok(over);
  assert.equal(over.overBy, parseUnits("0.0012", 18));
});

test("a self-signed send is not gated", async () => {
  // No broadcaster fee — gas is paid publicly and does not touch the private
  // balance, so there is nothing to reserve.
  assert.equal(await feeShortfall(legs("0.01"), estimate(undefined), CHAIN), undefined);
});

test("an under-quoted fee is exactly what this catches", async () => {
  // The nominal hint was 350k gas against ~2.5M measured, so the reserved fee
  // was about a seventh of the real one. A build reserving the small figure
  // still fails once the measured fee arrives.
  // Balance 0.01, sending 0.0095. The nominal fee fits; seven times it does not.
  const nominal = parseUnits("0.0002", 18);
  const measured = nominal * 7n;
  assert.equal(
    await feeShortfall(legs("0.0095"), estimate(nominal), CHAIN),
    undefined,
    "the nominal fee should have fit",
  );
  const over = await feeShortfall(legs("0.0095"), estimate(measured), CHAIN);
  assert.ok(over, "measured fee not caught");
  assert.equal(over.overBy, parseUnits("0.0009", 18));
});

test("a fee in a token the send is not moving is still checked", async () => {
  // The blind spot: overspentTokens only knows the balances the legs carry, so
  // a USDC fee on a WETH send was invisible to it — and that is the case where
  // the fee has a whole balance to itself.
  const over = await feeShortfall(
    legs("0.005"),
    estimate(parseUnits("8", 6), USDC),
    CHAIN,
    holding(WETH, USDC), // holds 5 USDC, fee wants 8
  );
  assert.ok(over, "a fee in a non-leg token went unchecked");
  assert.equal(over.token.symbol, "USDC");
  assert.equal(over.overBy, parseUnits("3", 6));
});

test("a non-leg fee that fits passes", async () => {
  assert.equal(
    await feeShortfall(
      legs("0.005"),
      estimate(parseUnits("2", 6), USDC),
      CHAIN,
      holding(WETH, USDC),
    ),
    undefined,
  );
});

test("an unreadable balance does not block the send", async () => {
  // This gate exists to give a better message than the SDK's, not to become a
  // second way for a send to die. A lookup that throws yields to the SDK.
  assert.equal(
    await feeShortfall(
      legs("0.005"),
      estimate(parseUnits("8", 6), USDC),
      CHAIN,
      async () => {
        throw new Error("no engine");
      },
    ),
    undefined,
  );
});
