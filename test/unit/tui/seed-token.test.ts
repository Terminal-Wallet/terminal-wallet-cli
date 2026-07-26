/**
 * Seeding the builder from a dashboard balance row.
 *
 * The public balance list reports the NATIVE balance under the WRAPPED token's
 * address — the ETH row carries WETH's address, because that is the address the
 * base-token flows need when they build a shield request. Used as a token
 * IDENTITY it reads as WETH, and that is the wrong answer: clicking ETH and
 * choosing Shield produced a leg the native check did not recognise, so the
 * flow took its ERC20 branch, asked to approve WETH, and then tried to shield
 * WETH the wallet does not hold — reverting the gas estimate with
 * "SafeERC20: low-level call failed".
 *
 * Resolving the seed against the list the flow itself offers is what makes the
 * identity unambiguous.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { resolveSeedToken } from "../../../src/tui/screens/tx-builder-core";
import {
  NATIVE_SENTINEL,
  isNativeChoice,
  makeNativeEntry,
} from "../../../src/flows/native-token";
import { RailgunDisplayBalance } from "../../../src/models/balance-models";

const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

/** The ETH row exactly as getPublicERC20BalancesForChain(chain, true) builds it. */
const ethRowFromDashboard = {
  symbol: "ETH",
  name: "Ether",
  tokenAddress: WETH_ADDRESS, // the native balance, under the wrapped address
  decimals: 18,
  amount: parseUnits("2", 18),
} as RailgunDisplayBalance;

const usdc = {
  symbol: "USDC",
  name: "USD Coin",
  tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  decimals: 6,
  amount: parseUnits("50", 6),
} as RailgunDisplayBalance;

/** What the shield/transfer flows offer: a native entry plus real ERC20s. */
const shieldOptions = [makeNativeEntry("ETH", 18, parseUnits("2", 18)), usdc];

test("an ETH seed becomes the flow's native entry, not WETH", () => {
  const seed = resolveSeedToken(ethRowFromDashboard, shieldOptions);
  assert.ok(seed);
  assert.equal(seed.tokenAddress, NATIVE_SENTINEL);
  assert.ok(isNativeChoice(seed), "the seeded ETH did not route as native");
});

test("the mis-routing this prevents", () => {
  // Without resolution the seed keeps WETH's address, and the native check —
  // which is what sends a leg down the wrap+shield path — says no.
  assert.equal(isNativeChoice(ethRowFromDashboard), false);
});

test("an ERC20 seed resolves to the flow's own entry for that token", () => {
  // Same token, but the flow's copy carries the balance the flow computed.
  const stale = { ...usdc, amount: 0n } as RailgunDisplayBalance;
  const seed = resolveSeedToken(stale, shieldOptions);
  assert.equal(seed, usdc, "the seed should be the flow's entry, not the caller's");
  assert.equal(seed?.amount, parseUnits("50", 6));
});

test("address wins over symbol", () => {
  // A flow that offers the wrapped ERC20 itself must keep it: matching by
  // symbol first would turn a deliberate WETH choice into native ETH.
  const wethEntry = {
    symbol: "ETH",
    name: "Wrapped Ether",
    tokenAddress: WETH_ADDRESS,
    decimals: 18,
    amount: parseUnits("1", 18),
  } as RailgunDisplayBalance;
  const swapOptions = [wethEntry, usdc];
  const seed = resolveSeedToken(ethRowFromDashboard, swapOptions);
  assert.equal(seed?.tokenAddress, WETH_ADDRESS);
});

test("a seed matching nothing is left alone", () => {
  const foreign = {
    symbol: "DAI",
    name: "Dai",
    tokenAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
    decimals: 18,
    amount: 0n,
  } as RailgunDisplayBalance;
  assert.equal(resolveSeedToken(foreign, shieldOptions), foreign);
});

test("no seed stays no seed", () => {
  assert.equal(resolveSeedToken(undefined, shieldOptions), undefined);
});
