import { RailgunERC20Amount } from "@railgun-community/shared-models";

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

export type RailgunBalanceCache = {
  timestamp: number;
  balance: RailgunBalance;
};

export type BalanceCacheMap = NumMapType<
  NumMapType<MapType<RailgunBalanceCache>>
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
