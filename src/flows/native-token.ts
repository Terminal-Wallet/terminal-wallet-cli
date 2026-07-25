/**
 * Native-token (ETH) consolidation: a builder leg can pick the native token
 * instead of an ERC20, which routes to the wrap/unwrap base flow (shield =
 * wrap+shield, unshield = unshield+unwrap, send = native transfer). The native
 * choice is marked with a sentinel tokenAddress so it's distinguishable from the
 * wrapped ERC20 (WETH) at submit time. Pure + unit-tested.
 */
import { RailgunDisplayBalance } from "../models/balance-models";

/** Sentinel tokenAddress marking the native (ETH) choice. Not a real 0x address. */
export const NATIVE_SENTINEL = "native";

export type NativeKind = "shield" | "unshield" | "send";

/** True when a chosen token is the native (wrap/unwrap) entry, not an ERC20. */
export const isNativeChoice = (token?: { tokenAddress: string }): boolean =>
  !!token && token.tokenAddress === NATIVE_SENTINEL;

/** Short descriptor for the native picker entry, by flow. */
export const nativeTokenLabel = (kind: NativeKind): string =>
  kind === "shield"
    ? "wraps & shields"
    : kind === "unshield"
      ? "unshields & unwraps"
      : "native send";

/** A display-balance entry representing the native token in a token picker. */
export const makeNativeEntry = (
  symbol: string,
  decimals: number,
  amount: bigint,
): RailgunDisplayBalance => ({
  symbol,
  name: `${symbol} (native)`,
  tokenAddress: NATIVE_SENTINEL,
  decimals,
  amount,
});
