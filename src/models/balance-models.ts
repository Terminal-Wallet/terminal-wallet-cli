import {
  RailgunERC20Amount,
  RailgunWalletBalanceBucket,
} from "@railgun-community/shared-models";

export type RailgunBalance = {
  tokenAddress: string;
  amount: string;
  decimals: number;
};
export type RailgunDisplayBalance = {
  name: string;
  symbol: string;
  amount: bigint;
  decimals: number;
  tokenAddress: string;
};

/**
 * A shielded NFT, as the rail shows it.
 *
 * `label` is resolved when the collection is one the wallet knows — an f(x)
 * pool is a position, and "wstETH-Long #1981" is what the holder calls it —
 * and falls back to a shortened address otherwise. Without it the rail would
 * show a raw contract address and a hex token id, which names nothing.
 */
export type RailgunDisplayNFT = {
  nftAddress: string;
  tokenSubID: string;
  amount: bigint;
  label: string;
  /** Set when the collection is recognised, so a picker can filter on it. */
  kind?: "fx-position";
};

export type RailgunBalanceCache = {
  timestamp: number;
  balance: RailgunBalance;
};

export type BalanceCacheMap = NumMapType<
  NumMapType<MapType<RailgunBalanceCache>>
>;

// chain.type >> chain.id >> balancebucket >> tokenaddr >> cache
export type BalanceBucketCacheMap = NumMapType<
  NumMapType<MapType<MapType<MapType<RailgunBalanceCache>>>>
>;

export type RailgunReadableAmount = RailgunERC20Amount & {
  symbol: string;
  name: string;
  amountReadable: string;
  decimals: number;
};

export type RailgunSelectedAmount = RailgunReadableAmount & {
  selectedAmount: bigint;
  recipientAddress: string;
};
